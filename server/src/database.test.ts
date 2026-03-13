import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { DatabaseService } from './database.js';

describe('DatabaseService', () => {
  let db: DatabaseService;
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `test-library-${Date.now()}.db`);
    db = new DatabaseService(dbPath);
  });

  afterEach(() => {
    db.close();
    try {
      fs.unlinkSync(dbPath);
    } catch {}
    try {
      fs.unlinkSync(dbPath + '-journal');
    } catch {}
    try {
      fs.unlinkSync(dbPath + '-wal');
    } catch {}
  });

  describe('Folders', () => {
    it('should add a folder', () => {
      const folder = db.addFolder('/test/path');
      expect(folder.id).toBeGreaterThan(0);
      expect(folder.path).toBe('/test/path');
      expect(folder.enabled).toBe(true);
      expect(folder.fileCount).toBe(0);
    });

    it('should re-enable a disabled folder on re-add', () => {
      const folder = db.addFolder('/test/path');
      db.removeFolder(folder.id);
      const readded = db.addFolder('/test/path');
      expect(readded.enabled).toBe(true);
    });

    it('should list all folders', () => {
      db.addFolder('/test/a');
      db.addFolder('/test/b');
      const folders = db.getAllFolders();
      expect(folders).toHaveLength(2);
    });

    it('should remove a folder and cascade delete files', () => {
      const folder = db.addFolder('/test/path');
      db.upsertAudioFile({
        folderId: folder.id,
        path: '/test/path/file.wav',
        filename: 'file.wav',
        extension: '.wav',
        durationSeconds: 10,
        sampleRate: 44100,
        channels: 2,
        fileSize: 1000,
        modifiedAt: '2024-01-01T00:00:00.000Z',
        keywords: ['KICK'],
      });
      expect(db.getTotalFileCount()).toBe(1);
      db.removeFolder(folder.id);
      expect(db.getTotalFileCount()).toBe(0);
    });
  });

  describe('Audio Files', () => {
    let folderId: number;

    beforeEach(() => {
      folderId = db.addFolder('/test').id;
    });

    it('should upsert an audio file', () => {
      db.upsertAudioFile({
        folderId,
        path: '/test/kick_heavy.wav',
        filename: 'kick_heavy.wav',
        extension: '.wav',
        durationSeconds: 120,
        sampleRate: 44100,
        channels: 2,
        fileSize: 500000,
        modifiedAt: '2024-01-01T00:00:00.000Z',
        keywords: ['KICK'],
      });
      const file = db.getFileByPath('/test/kick_heavy.wav');
      expect(file).not.toBeNull();
      expect(file!.filename).toBe('kick_heavy.wav');
      expect(file!.durationSeconds).toBe(120);
      expect(file!.keywords).toEqual(['KICK']);
    });

    it('should update on conflict', () => {
      db.upsertAudioFile({
        folderId,
        path: '/test/kick.wav',
        filename: 'kick.wav',
        extension: '.wav',
        durationSeconds: 60,
        sampleRate: 44100,
        channels: 2,
        fileSize: 1000,
        modifiedAt: '2024-01-01T00:00:00.000Z',
        keywords: ['KICK'],
      });
      db.upsertAudioFile({
        folderId,
        path: '/test/kick.wav',
        filename: 'kick.wav',
        extension: '.wav',
        durationSeconds: 120,
        sampleRate: 48000,
        channels: 2,
        fileSize: 2000,
        modifiedAt: '2024-06-01T00:00:00.000Z',
        keywords: ['KICK'],
      });
      const file = db.getFileByPath('/test/kick.wav');
      expect(file!.durationSeconds).toBe(120);
      expect(file!.sampleRate).toBe(48000);
    });

    it('should find files by keyword', () => {
      db.upsertAudioFile({
        folderId,
        path: '/test/kick.wav',
        filename: 'kick.wav',
        extension: '.wav',
        durationSeconds: 60,
        sampleRate: 44100,
        channels: 2,
        fileSize: 1000,
        modifiedAt: '2024-01-01',
        keywords: ['KICK'],
      });
      db.upsertAudioFile({
        folderId,
        path: '/test/synth.wav',
        filename: 'synth.wav',
        extension: '.wav',
        durationSeconds: 60,
        sampleRate: 44100,
        channels: 2,
        fileSize: 1000,
        modifiedAt: '2024-01-01',
        keywords: ['SYNTH'],
      });
      const kicks = db.getFilesByKeyword('KICK');
      expect(kicks).toHaveLength(1);
      expect(kicks[0].filename).toBe('kick.wav');
    });

    it('should find files by multiple keywords', () => {
      db.upsertAudioFile({
        folderId,
        path: '/test/hihat.wav',
        filename: 'hihat.wav',
        extension: '.wav',
        durationSeconds: 60,
        sampleRate: 44100,
        channels: 2,
        fileSize: 1000,
        modifiedAt: '2024-01-01',
        keywords: ['HAT', 'HIHAT'],
      });
      const results = db.getFilesByKeywords(['HAT', 'KICK']);
      expect(results).toHaveLength(1);
    });

    it('should batch upsert files', () => {
      const files = Array.from({ length: 10 }, (_, i) => ({
        folderId,
        path: `/test/file_${i}.wav`,
        filename: `file_${i}.wav`,
        extension: '.wav',
        durationSeconds: 60,
        sampleRate: 44100,
        channels: 2,
        fileSize: 1000,
        modifiedAt: '2024-01-01',
        keywords: ['KICK'],
      }));
      db.upsertAudioFileBatch(files);
      expect(db.getTotalFileCount()).toBe(10);
    });

    it('should remove stale files', () => {
      db.upsertAudioFileBatch([
        {
          folderId,
          path: '/test/a.wav',
          filename: 'a.wav',
          extension: '.wav',
          durationSeconds: 10,
          sampleRate: 44100,
          channels: 2,
          fileSize: 100,
          modifiedAt: '2024-01-01',
          keywords: [],
        },
        {
          folderId,
          path: '/test/b.wav',
          filename: 'b.wav',
          extension: '.wav',
          durationSeconds: 10,
          sampleRate: 44100,
          channels: 2,
          fileSize: 100,
          modifiedAt: '2024-01-01',
          keywords: [],
        },
        {
          folderId,
          path: '/test/c.wav',
          filename: 'c.wav',
          extension: '.wav',
          durationSeconds: 10,
          sampleRate: 44100,
          channels: 2,
          fileSize: 100,
          modifiedAt: '2024-01-01',
          keywords: [],
        },
      ]);
      const removed = db.removeStaleFiles(folderId, new Set(['/test/a.wav', '/test/c.wav']));
      expect(removed).toBe(1); // b.wav removed
      expect(db.getTotalFileCount()).toBe(2);
    });
  });

  describe('Track Rules', () => {
    it('should seed default rules', () => {
      const rules = db.getAllTrackRules();
      expect(rules.length).toBeGreaterThan(5);
      const kickRule = rules.find((r) => r.trackName === 'KICK');
      expect(kickRule).toBeDefined();
      expect(kickRule!.keywords).toContain('KICK');
    });

    it('should set and get a custom rule', () => {
      const rule = db.setTrackRule('CUSTOM', ['FOO', 'BAR'], '^custom_.*');
      expect(rule.trackName).toBe('CUSTOM');
      expect(rule.keywords).toEqual(['FOO', 'BAR']);
      expect(rule.regexPattern).toBe('^custom_.*');
    });

    it('should update an existing rule', () => {
      db.setTrackRule('KICK', ['KICK', 'BD', 'BASSDRUM']);
      const rule = db.getTrackRule('KICK');
      expect(rule!.keywords).toContain('BASSDRUM');
    });

    it('should delete a rule', () => {
      db.setTrackRule('TEMP', ['TEMP']);
      db.deleteTrackRule('TEMP');
      expect(db.getTrackRule('TEMP')).toBeNull();
    });
  });

  describe('File Groups', () => {
    it('should return counts per track group', () => {
      const folderId = db.addFolder('/test').id;
      db.upsertAudioFileBatch([
        {
          folderId,
          path: '/a/kick1.wav',
          filename: 'kick1.wav',
          extension: '.wav',
          durationSeconds: 10,
          sampleRate: 44100,
          channels: 2,
          fileSize: 100,
          modifiedAt: '2024-01-01',
          keywords: ['KICK'],
        },
        {
          folderId,
          path: '/a/kick2.wav',
          filename: 'kick2.wav',
          extension: '.wav',
          durationSeconds: 10,
          sampleRate: 44100,
          channels: 2,
          fileSize: 100,
          modifiedAt: '2024-01-01',
          keywords: ['KICK'],
        },
        {
          folderId,
          path: '/a/synth1.wav',
          filename: 'synth1.wav',
          extension: '.wav',
          durationSeconds: 10,
          sampleRate: 44100,
          channels: 2,
          fileSize: 100,
          modifiedAt: '2024-01-01',
          keywords: ['SYNTH'],
        },
      ]);
      const groups = db.getFileGroups();
      expect(groups['KICK']).toBe(2);
      expect(groups['SYNTH']).toBe(1);
    });
  });
});
