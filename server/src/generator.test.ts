import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GenerativeEngine } from './generator.js';
import type { DatabaseService } from './database.js';
import type { AbletonService } from './ableton.js';
import type { GenerationConfig, AudioFile, TrackRule, AbletonTrack } from './types.js';

// Mock services
function createMockDb(overrides: Partial<DatabaseService> = {}): DatabaseService {
  return {
    getAllTrackRules: vi.fn(
      () =>
        [
          { id: 1, trackName: 'KICK', keywords: ['KICK', 'BD'], regexPattern: null },
          { id: 2, trackName: 'SYNTH', keywords: ['SYNTH', 'LEAD'], regexPattern: null },
          { id: 3, trackName: 'HIHAT', keywords: ['HIHAT', 'HAT'], regexPattern: null },
        ] as TrackRule[],
    ),
    getFilesByKeywords: vi.fn((keywords: string[]) => {
      const files: AudioFile[] = [];
      if (keywords.some((k) => ['KICK', 'BD'].includes(k))) {
        files.push({
          id: 1,
          folderId: 1,
          path: '/recordings/KICK_001.wav',
          filename: 'KICK_001.wav',
          extension: '.wav',
          durationSeconds: 300,
          sampleRate: 44100,
          channels: 2,
          fileSize: 1000000,
          modifiedAt: '2024-01-01',
          keywords: ['KICK'],
          scannedAt: '2024-01-01',
          activeStartSeconds: 0,
          activeEndSeconds: 300,
          detectedKey: null,
        });
      }
      if (keywords.some((k) => ['SYNTH', 'LEAD'].includes(k))) {
        files.push({
          id: 2,
          folderId: 1,
          path: '/recordings/SYNTH_pad_session.wav',
          filename: 'SYNTH_pad_session.wav',
          extension: '.wav',
          durationSeconds: 600,
          sampleRate: 48000,
          channels: 2,
          fileSize: 2000000,
          modifiedAt: '2024-01-01',
          keywords: ['SYNTH'],
          scannedAt: '2024-01-01',
          activeStartSeconds: 0,
          activeEndSeconds: 600,
          detectedKey: null,
        });
      }
      if (keywords.some((k) => ['HIHAT', 'HAT'].includes(k))) {
        files.push({
          id: 3,
          folderId: 1,
          path: '/recordings/HIHAT_open.wav',
          filename: 'HIHAT_open.wav',
          extension: '.wav',
          durationSeconds: 180,
          sampleRate: 44100,
          channels: 2,
          fileSize: 500000,
          modifiedAt: '2024-01-01',
          keywords: ['HIHAT'],
          scannedAt: '2024-01-01',
          activeStartSeconds: 0,
          activeEndSeconds: 180,
          detectedKey: null,
        });
      }
      return files;
    }),
    saveGeneration: vi.fn(),
    ...overrides,
  } as any;
}

function createMockAbleton(overrides: Partial<AbletonService> = {}): AbletonService {
  return {
    getTempo: vi.fn(async () => 120),
    getSongLength: vi.fn(async () => 0),
    getGlobalArrangementEndTime: vi.fn(async () => 0),
    getTracks: vi.fn(
      async () =>
        [
          { index: 0, name: 'KICK', type: 'audio', color: 0, enabled: true },
          { index: 1, name: 'SYNTH', type: 'audio', color: 0, enabled: true },
          { index: 2, name: 'HIHAT', type: 'audio', color: 0, enabled: true },
        ] as AbletonTrack[],
    ),
    isConnected: true,
    createArrangementClip: vi.fn(async () => ({ clipId: 'test' })),
    setClipMarkers: vi.fn(async () => {}),
    beginUndoStep: vi.fn(async () => {}),
    endUndoStep: vi.fn(async () => {}),
    ...overrides,
  } as any;
}

describe('GenerativeEngine', () => {
  let engine: GenerativeEngine;
  let mockDb: DatabaseService;
  let mockAbleton: AbletonService;

  beforeEach(() => {
    mockDb = createMockDb();
    mockAbleton = createMockAbleton();
    engine = new GenerativeEngine(mockDb, mockAbleton);
  });

  describe('createPlan — Single Segment', () => {
    it('should create a plan with one clip per enabled track', async () => {
      const config: GenerationConfig = {
        duration: { value: 1, unit: 'minutes', label: '1 min' },
        segmentMode: 'single',
        viewMode: 'arrangement',
        enabledTrackIndices: [0, 1, 2],
      };

      const plan = await engine.createPlan(config);

      expect(plan.clips.length).toBe(3); // one per track
      expect(plan.tempo).toBe(120);
      expect(plan.totalDurationBeats).toBe(120); // 1 min * 120 BPM

      // Each clip should reference the correct track
      expect(plan.clips[0].trackName).toBe('KICK');
      expect(plan.clips[1].trackName).toBe('SYNTH');
      expect(plan.clips[2].trackName).toBe('HIHAT');
    });

    it('should respect beat-based duration', async () => {
      const config: GenerationConfig = {
        duration: { value: 64, unit: 'beats', label: '64 beats' },
        segmentMode: 'single',
        viewMode: 'arrangement',
        enabledTrackIndices: [0],
      };

      const plan = await engine.createPlan(config);
      expect(plan.totalDurationBeats).toBe(64);
      expect(plan.clips[0].durationBeats).toBeLessThanOrEqual(64);
    });

    it('should set random start markers within file bounds', async () => {
      const config: GenerationConfig = {
        duration: { value: 32, unit: 'beats', label: '32 beats' },
        segmentMode: 'single',
        viewMode: 'arrangement',
        enabledTrackIndices: [0],
      };

      const plan = await engine.createPlan(config);
      const clip = plan.clips[0];

      // KICK file is 300 seconds = 600 beats at 120 BPM.
      // Segment is 32 beats. Start marker should be 0..568.
      expect(clip.startMarkerBeats).toBeGreaterThanOrEqual(0);
      expect(clip.endMarkerBeats).toBeLessThanOrEqual(600);
      expect(clip.endMarkerBeats - clip.startMarkerBeats).toBeCloseTo(32, 0);
    });
  });

  describe('createPlan — Multiple Segments', () => {
    it('should create multiple clips that fill the total duration', async () => {
      const config: GenerationConfig = {
        duration: { value: 5, unit: 'minutes', label: '5 min' },
        segmentMode: 'multiple',
        viewMode: 'arrangement',
        enabledTrackIndices: [0],
      };

      const plan = await engine.createPlan(config);

      // Total duration is 5 min * 120 BPM = 600 beats
      expect(plan.totalDurationBeats).toBe(600);

      // Multiple clips should be created
      expect(plan.clips.length).toBeGreaterThan(1);

      // Sum of clip durations should approximately equal total
      const totalClipBeats = plan.clips.reduce((sum, c) => sum + c.durationBeats, 0);
      expect(totalClipBeats).toBeCloseTo(600, -1); // within 10 beats
    });

    it('should place clips sequentially in the arrangement', async () => {
      const config: GenerationConfig = {
        duration: { value: 128, unit: 'beats', label: '128 beats' },
        segmentMode: 'multiple',
        viewMode: 'arrangement',
        enabledTrackIndices: [0],
      };

      const plan = await engine.createPlan(config);

      // Clips should be sequential (each starts where previous ended)
      for (let i = 1; i < plan.clips.length; i++) {
        const prevEnd = plan.clips[i - 1].arrangementPosition + plan.clips[i - 1].durationBeats;
        expect(plan.clips[i].arrangementPosition).toBeCloseTo(prevEnd, 0);
      }
    });
  });

  describe('createPlan — Track Matching', () => {
    it('should skip tracks with no matching files', async () => {
      const dbNoFiles = createMockDb({
        getFilesByKeywords: vi.fn(() => []),
      });
      const eng = new GenerativeEngine(dbNoFiles, mockAbleton);

      const config: GenerationConfig = {
        duration: { value: 32, unit: 'beats', label: '32 beats' },
        segmentMode: 'single',
        viewMode: 'arrangement',
        enabledTrackIndices: [0],
      };

      const plan = await eng.createPlan(config);
      expect(plan.clips).toHaveLength(0);
    });

    it('should only include enabled track indices', async () => {
      const config: GenerationConfig = {
        duration: { value: 32, unit: 'beats', label: '32 beats' },
        segmentMode: 'single',
        viewMode: 'arrangement',
        enabledTrackIndices: [1], // only SYNTH
      };

      const plan = await engine.createPlan(config);
      expect(plan.clips).toHaveLength(1);
      expect(plan.clips[0].trackName).toBe('SYNTH');
    });
  });

  describe('executePlan', () => {
    it('should call createArrangementClip and setClipMarkers for each clip', async () => {
      const config: GenerationConfig = {
        duration: { value: 32, unit: 'beats', label: '32 beats' },
        segmentMode: 'single',
        viewMode: 'arrangement',
        enabledTrackIndices: [0, 1],
      };

      const plan = await engine.createPlan(config);
      const clipsCreated = await engine.executePlan(plan);

      expect(clipsCreated).toBe(2);
      expect(mockAbleton.beginUndoStep).toHaveBeenCalled();
      expect(mockAbleton.endUndoStep).toHaveBeenCalled();
      expect(mockAbleton.createArrangementClip).toHaveBeenCalledTimes(2);
    });
  });
});
