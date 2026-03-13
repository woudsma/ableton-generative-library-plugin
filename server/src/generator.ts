import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { DatabaseService } from './database.js';
import { AbletonService } from './ableton.js';
import { getCompatibleKeys } from './key-detector.js';
import type {
  GenerationConfig,
  GenerationPlan,
  ClipPlacement,
  AudioFile,
  TrackRule,
  AbletonTrack,
} from './types.js';
import type { SessionClipInfo } from './ableton.js';

export class GenerativeEngine {
  private db: DatabaseService;
  private ableton: AbletonService;

  constructor(db: DatabaseService, ableton: AbletonService) {
    this.db = db;
    this.ableton = ableton;
  }

  /**
   * Generate a composition plan based on the given config.
   * Does NOT actually create clips — call executePlan() for that.
   */
  async createPlan(config: GenerationConfig): Promise<GenerationPlan> {
    const tempo = await this.ableton.getTempo();
    const totalDurationBeats = this.calculateTotalBeats(config, tempo);
    const tracks = await this.ableton.getTracks();
    const rules = this.db.getAllTrackRules();

    // Determine which volumes are currently mounted so we skip files on disconnected drives
    const mountedVolumes = this.getMountedVolumes();

    const clips: ClipPlacement[] = [];
    const skipSilence = config.skipSilence !== false; // default true
    const loopClips = config.loopClips === true; // default false

    // Determine target key for Same Key filtering
    let compatibleKeys: Set<string> | null = null;
    if (config.sameKey) {
      compatibleKeys = this.findCompatibleKeySet(
        config.enabledTrackIndices,
        tracks,
        rules,
        mountedVolumes,
      );
    }

    // Determine the insertion point:
    // - If arrangement has existing clips, start after the last clip on any enabled track
    // - If arrangement is empty, start at beat 0
    const insertionPoint = await this.ableton.getGlobalArrangementEndTime(
      config.enabledTrackIndices,
    );

    for (const trackIndex of config.enabledTrackIndices) {
      const track = tracks[trackIndex];
      if (!track) continue;

      // Skip non-audio tracks (can't hold audio clips)
      if (track.type !== 'audio') {
        console.log(`[Generator] Skipping "${track.name}" (${track.type} track, not audio)`);
        continue;
      }

      // Find matching rule for this track
      const rule = this.findMatchingRule(track.name, rules);
      if (!rule) {
        console.warn(`[Generator] No matching rule for track "${track.name}", skipping`);
        continue;
      }

      // Find audio files matching this track's keywords (filter out unmounted drives)
      const allMatchingFiles = this.db.getFilesByKeywords(rule.keywords);
      let matchingFiles = allMatchingFiles.filter((f) =>
        this.isFileAccessible(f.path, mountedVolumes),
      );

      // Filter by compatible keys if Same Key mode is enabled
      if (compatibleKeys) {
        const keyFiltered = matchingFiles.filter(
          (f) => f.detectedKey && compatibleKeys!.has(f.detectedKey),
        );
        if (keyFiltered.length > 0) {
          matchingFiles = keyFiltered;
        } else {
          console.log(
            `[Generator] No key-compatible files for track "${track.name}", using all files`,
          );
        }
      }

      if (matchingFiles.length === 0) {
        console.warn(
          `[Generator] No matching files for track "${track.name}" (keywords: ${rule.keywords.join(', ')})`,
        );
        continue;
      }
      console.log(
        `[Generator] Track "${track.name}" matched rule "${rule.trackName}" — ${matchingFiles.length} files available`,
      );

      // Generate clip placements based on segment mode
      const minDurationSeconds = this.beatsToSeconds(totalDurationBeats, tempo);
      if (config.segmentMode === 'single') {
        const placement = this.createSingleSegment(
          track,
          trackIndex,
          matchingFiles,
          insertionPoint,
          totalDurationBeats,
          tempo,
          minDurationSeconds,
          skipSilence,
        );
        if (placement) {
          console.log(
            `[Generator]   Track: ${track.name} -> ${placement.filePath} [start: ${placement.startMarkerBeats.toFixed(1)}, end: ${placement.endMarkerBeats.toFixed(1)}, pos: ${placement.arrangementPosition.toFixed(1)}]`,
          );
          clips.push(placement);
        }
      } else {
        const placements = this.createMultipleSegments(
          track,
          trackIndex,
          matchingFiles,
          insertionPoint,
          totalDurationBeats,
          tempo,
          skipSilence,
        );
        for (const p of placements) {
          console.log(
            `[Generator]   Track: ${track.name} -> ${p.filePath} [start: ${p.startMarkerBeats.toFixed(1)}, end: ${p.endMarkerBeats.toFixed(1)}, pos: ${p.arrangementPosition.toFixed(1)}]`,
          );
        }
        clips.push(...placements);
      }
    }

    const plan: GenerationPlan = {
      id: uuidv4(),
      timestamp: new Date().toISOString(),
      config,
      tempo,
      clips,
      totalDurationBeats,
    };

    return plan;
  }

  /**
   * Execute a generation plan — actually create the clips in Ableton.
   */
  async executePlan(
    plan: GenerationPlan,
    onProgress?: (current: number, total: number, trackName: string) => void,
  ): Promise<number> {
    let clipsCreated = 0;

    // For session view: find the global next scene so all clips land on the same row
    let sessionSceneIndex: number | undefined;
    if (plan.config.viewMode === 'session') {
      const trackIndices = [...new Set(plan.clips.map((c) => c.trackIndex))];
      sessionSceneIndex = await this.ableton.getNextSessionScene(trackIndices);
      console.log(`[Generator] Session mode: placing clips on scene ${sessionSceneIndex}`);
    }

    // Wrap in undo step so user can Cmd+Z the entire generation
    await this.ableton.beginUndoStep();

    try {
      for (let i = 0; i < plan.clips.length; i++) {
        const clip = plan.clips[i];
        try {
          onProgress?.(i + 1, plan.clips.length, clip.trackName);
          if (plan.config.viewMode === 'arrangement') {
            await this.createArrangementClip(clip, plan.config.loopClips === true);
          } else {
            await this.createSessionClip(clip, sessionSceneIndex, plan.config.loopClips === true);
          }
          clipsCreated++;
        } catch (err) {
          console.error(
            `[Generator] Failed to create clip "${clip.filename}" on track ${clip.trackIndex}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } finally {
      await this.ableton.endUndoStep();
    }

    // Save generation to history
    this.db.saveGeneration(plan.id, plan.config, plan, plan.tempo);

    console.log(`[Generator] Created ${clipsCreated}/${plan.clips.length} clips`);
    return clipsCreated;
  }

  /**
   * Convenience: create plan and execute it in one call.
   */
  async generate(
    config: GenerationConfig,
  ): Promise<{ plan: GenerationPlan; clipsCreated: number }> {
    const plan = await this.createPlan(config);
    const clipsCreated = await this.executePlan(plan);
    return { plan, clipsCreated };
  }

  /**
   * Create a variation of a session scene (row).
   * Reads clips from the given scene, then for each clip creates a new clip
   * on the same track with the same source file but a different random start position.
   * The new clips are placed on a new scene.
   *
   * Returns the number of clips created and the index of the new scene.
   */
  async createRowVariation(
    sceneIndex: number,
    options?: {
      skipSilence?: boolean;
      loopClips?: boolean;
      sameKey?: boolean;
    },
    onProgress?: (current: number, total: number, trackName: string) => void,
  ): Promise<{ clipsCreated: number; newSceneIndex: number }> {
    const sourceClips = await this.ableton.getSceneClips(sceneIndex);

    if (sourceClips.length === 0) {
      throw new Error(`No clips found in scene ${sceneIndex + 1}`);
    }

    const tempo = await this.ableton.getTempo();
    const skipSilence = options?.skipSilence !== false; // default true
    const loopClips = options?.loopClips === true; // default false

    // Create a new scene for the variation
    const trackIndices = sourceClips.map((c) => c.trackIndex);
    const newSceneIndex = await this.ableton.getNextSessionScene(trackIndices);

    console.log(
      `[Generator] Row variation: scene ${sceneIndex} → scene ${newSceneIndex}, ${sourceClips.length} clips`,
    );

    // Determine which volumes are currently mounted
    const mountedVolumes = this.getMountedVolumes();

    let clipsCreated = 0;

    await this.ableton.beginUndoStep();

    try {
      for (let i = 0; i < sourceClips.length; i++) {
        const sourceClip = sourceClips[i];
        onProgress?.(i + 1, sourceClips.length, sourceClip.trackName);

        try {
          // Look up the audio file in the database to get duration/metadata
          const audioFile = this.db.getFileByPath(sourceClip.filePath);

          // Calculate new random start position within the file
          const clipDurationBeats = sourceClip.endMarker - sourceClip.startMarker;

          let newStartMarker: number;
          let newEndMarker: number;

          if (audioFile) {
            const fileDurationBeats = this.secondsToBeats(audioFile.durationSeconds, tempo);
            const { rangeStartBeats, rangeEndBeats } = this.getEffectiveRange(
              audioFile,
              fileDurationBeats,
              tempo,
              skipSilence,
            );
            const effectiveDuration = rangeEndBeats - rangeStartBeats;

            // Pick a different random start point, quantized to 8-beat boundaries
            const maxStart = Math.max(0, effectiveDuration - clipDurationBeats);
            if (maxStart > 0) {
              newStartMarker = rangeStartBeats + Math.floor((Math.random() * maxStart) / 8) * 8;
            } else {
              newStartMarker = rangeStartBeats;
            }
            newEndMarker = newStartMarker + clipDurationBeats;
          } else {
            // File not in database — just shift the start marker randomly
            // Use the original markers as reference for the file's usable range
            const originalDuration = clipDurationBeats;
            // Shift by a random multiple of 8 beats (up to 128 beats either direction)
            const shift = (Math.floor(Math.random() * 32) - 16) * 8;
            newStartMarker = Math.max(0, sourceClip.startMarker + shift);
            newEndMarker = newStartMarker + originalDuration;
          }

          // Create the clip in the new scene
          const slotIndex = await this.ableton.createSessionClip(
            sourceClip.trackIndex,
            sourceClip.filePath,
            newSceneIndex,
          );

          // Set markers on the new clip
          await this.ableton.setSessionClipMarkers(
            sourceClip.trackIndex,
            slotIndex,
            newStartMarker,
            newEndMarker,
            {
              looping: loopClips,
              name: `${sourceClip.trackName} [var]`,
            },
          );

          clipsCreated++;
          console.log(
            `[Generator]   ${sourceClip.trackName}: ${sourceClip.filePath} [${newStartMarker.toFixed(1)}-${newEndMarker.toFixed(1)}]`,
          );
        } catch (err) {
          console.error(
            `[Generator] Failed to create variation clip for track ${sourceClip.trackIndex}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    } finally {
      await this.ableton.endUndoStep();
    }

    console.log(`[Generator] Row variation complete: ${clipsCreated}/${sourceClips.length} clips`);
    return { clipsCreated, newSceneIndex };
  }

  // ─── Private: Segment Creation ───

  /**
   * Create a single segment that fills the entire requested duration.
   */
  private createSingleSegment(
    track: AbletonTrack,
    trackIndex: number,
    files: AudioFile[],
    insertionPoint: number,
    totalDurationBeats: number,
    tempo: number,
    minDurationSeconds: number,
    skipSilence: boolean,
  ): ClipPlacement | null {
    // Pick a random file that's long enough for the full duration
    const file = this.pickRandomFile(files, minDurationSeconds);
    if (!file) return null;

    const fileDurationBeats = this.secondsToBeats(file.durationSeconds, tempo);

    // Determine the effective range within the file (active region or full file)
    const { rangeStartBeats, rangeEndBeats } = this.getEffectiveRange(
      file,
      fileDurationBeats,
      tempo,
      skipSilence,
    );
    const effectiveDurationBeats = rangeEndBeats - rangeStartBeats;

    // Determine segment length (can't exceed effective duration)
    const segmentDurationBeats = Math.min(totalDurationBeats, effectiveDurationBeats);

    // Pick a random start point within the effective range, quantized to 8-beat boundaries
    const maxStart = Math.max(0, effectiveDurationBeats - segmentDurationBeats);
    const startMarkerBeats =
      maxStart > 0
        ? rangeStartBeats + Math.floor((Math.random() * maxStart) / 8) * 8
        : rangeStartBeats;
    const endMarkerBeats = startMarkerBeats + segmentDurationBeats;

    return {
      trackIndex,
      trackName: track.name,
      filePath: file.path,
      filename: file.filename,
      startMarkerBeats,
      endMarkerBeats,
      arrangementPosition: insertionPoint,
      durationBeats: segmentDurationBeats,
    };
  }

  /**
   * Create multiple shorter segments that together fill the total duration.
   * Each segment picks a different random file and start point.
   */
  private createMultipleSegments(
    track: AbletonTrack,
    trackIndex: number,
    files: AudioFile[],
    insertionPoint: number,
    totalDurationBeats: number,
    tempo: number,
    skipSilence: boolean,
  ): ClipPlacement[] {
    const placements: ClipPlacement[] = [];
    let remainingBeats = totalDurationBeats;
    let currentPosition = insertionPoint;

    // Generate segments of random lengths (4-32 bars = 16-128 beats at 4/4)
    const minSegmentBeats = 16; // 4 bars
    const maxSegmentBeats = 128; // 32 bars

    while (remainingBeats > 0) {
      // Pick a random segment length
      let segmentBeats: number;
      if (remainingBeats <= minSegmentBeats) {
        segmentBeats = remainingBeats;
      } else {
        // Random length, quantized to 4 beats (1 bar in 4/4)
        const maxLen = Math.min(maxSegmentBeats, remainingBeats);
        const rawLength = minSegmentBeats + Math.random() * (maxLen - minSegmentBeats);
        segmentBeats = Math.round(rawLength / 4) * 4; // quantize to bars
        segmentBeats = Math.max(minSegmentBeats, Math.min(segmentBeats, remainingBeats));
      }

      // Pick a random file that's long enough for this segment
      const minSegSeconds = this.beatsToSeconds(segmentBeats, tempo);
      const file = this.pickRandomFile(files, minSegSeconds);
      if (!file) break;

      const fileDurationBeats = this.secondsToBeats(file.durationSeconds, tempo);

      // Determine the effective range within the file (active region or full file)
      const { rangeStartBeats, rangeEndBeats } = this.getEffectiveRange(
        file,
        fileDurationBeats,
        tempo,
        skipSilence,
      );
      const effectiveDurationBeats = rangeEndBeats - rangeStartBeats;

      // Adjust segment to fit effective range
      const actualSegmentBeats = Math.min(segmentBeats, effectiveDurationBeats);

      // Pick a random start point within the effective range, quantized to 8-beat boundaries
      const maxStart = Math.max(0, effectiveDurationBeats - actualSegmentBeats);
      const startMarkerBeats =
        maxStart > 0
          ? rangeStartBeats + Math.floor((Math.random() * maxStart) / 8) * 8
          : rangeStartBeats;
      const endMarkerBeats = startMarkerBeats + actualSegmentBeats;

      placements.push({
        trackIndex,
        trackName: track.name,
        filePath: file.path,
        filename: file.filename,
        startMarkerBeats,
        endMarkerBeats,
        arrangementPosition: currentPosition,
        durationBeats: actualSegmentBeats,
      });

      currentPosition += actualSegmentBeats;
      remainingBeats -= actualSegmentBeats;
    }

    return placements;
  }

  // ─── Private: Clip Creation in Ableton ───

  private async createArrangementClip(clip: ClipPlacement, loopClips: boolean): Promise<void> {
    // Step 1: Create the clip via Track.create_audio_clip() (Live 12 API)
    const result = await this.ableton.createArrangementClip(
      clip.trackIndex,
      clip.filePath,
      clip.arrangementPosition,
    );

    if (!result) {
      throw new Error(`createArrangementClip returned null for "${clip.filename}"`);
    }

    // Step 2: Set start/end markers to define the segment within the source file
    await this.ableton.setClipMarkers(
      clip.trackIndex,
      clip.arrangementPosition,
      clip.startMarkerBeats,
      clip.endMarkerBeats,
      {
        looping: loopClips,
        name: `${clip.trackName} [gen]`,
      },
    );
  }

  private async createSessionClip(
    clip: ClipPlacement,
    sceneIndex?: number,
    loopClips: boolean = false,
  ): Promise<void> {
    // Step 1: Create the clip in the specified scene (or first available slot)
    const slotIndex = await this.ableton.createSessionClip(
      clip.trackIndex,
      clip.filePath,
      sceneIndex,
    );

    // Step 2: Set start/end markers to define the segment within the source file
    await this.ableton.setSessionClipMarkers(
      clip.trackIndex,
      slotIndex,
      clip.startMarkerBeats,
      clip.endMarkerBeats,
      {
        looping: loopClips,
        name: `${clip.trackName} [gen]`,
      },
    );
  }

  // ─── Private: Helpers ───

  /**
   * Find the set of harmonically compatible keys for Same Key mode.
   * Scans all matched files across all enabled tracks, finds the most common key,
   * and returns a set of compatible keys using the Camelot wheel.
   */
  private findCompatibleKeySet(
    enabledTrackIndices: number[],
    tracks: AbletonTrack[],
    rules: TrackRule[],
    mountedVolumes: Set<string>,
  ): Set<string> | null {
    // Count key occurrences across all matched files for all enabled tracks
    const keyCounts = new Map<string, number>();

    for (const trackIndex of enabledTrackIndices) {
      const track = tracks[trackIndex];
      if (!track || track.type !== 'audio') continue;

      const rule = this.findMatchingRule(track.name, rules);
      if (!rule) continue;

      const allFiles = this.db.getFilesByKeywords(rule.keywords);
      const files = allFiles.filter((f) => this.isFileAccessible(f.path, mountedVolumes));

      for (const file of files) {
        if (file.detectedKey) {
          keyCounts.set(file.detectedKey, (keyCounts.get(file.detectedKey) || 0) + 1);
        }
      }
    }

    if (keyCounts.size === 0) {
      console.log('[Generator] Same Key: no key data available, skipping key filter');
      return null;
    }

    // Find the most common key
    let bestKey = '';
    let bestCount = 0;
    for (const [key, count] of keyCounts) {
      if (count > bestCount) {
        bestKey = key;
        bestCount = count;
      }
    }

    const compatible = getCompatibleKeys(bestKey);
    console.log(
      `[Generator] Same Key: target "${bestKey}" (${bestCount} files), compatible: [${compatible.join(', ')}]`,
    );
    return new Set(compatible);
  }

  private findMatchingRule(trackName: string, rules: TrackRule[]): TrackRule | null {
    const normalized = trackName.toUpperCase().trim();

    // Exact match first
    const exact = rules.find((r) => r.trackName.toUpperCase() === normalized);
    if (exact) return exact;

    // Partial match: track name contains a rule's track name, or vice versa
    const partial = rules.find(
      (r) =>
        normalized.includes(r.trackName.toUpperCase()) ||
        r.trackName.toUpperCase().includes(normalized),
    );
    if (partial) return partial;

    // Keyword match: any of the rule's keywords appear in the track name
    const keywordMatch = rules.find((r) =>
      r.keywords.some((k) => normalized.includes(k.toUpperCase())),
    );
    return keywordMatch ?? null;
  }

  private pickRandomFile(files: AudioFile[], minDurationSeconds?: number): AudioFile | null {
    if (files.length === 0) return null;

    // Filter to files long enough for the requested duration
    let candidates = files;
    if (minDurationSeconds && minDurationSeconds > 0) {
      candidates = files.filter((f) => f.durationSeconds >= minDurationSeconds);
      // If no files are long enough, fall back to the longest available files (top 25%)
      if (candidates.length === 0) {
        const sorted = [...files].sort((a, b) => b.durationSeconds - a.durationSeconds);
        candidates = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.25)));
      }
    }

    // Also filter out very short files (less than 1 second)
    const viable = candidates.filter((f) => f.durationSeconds > 1);
    if (viable.length === 0) return candidates[Math.floor(Math.random() * candidates.length)];

    return viable[Math.floor(Math.random() * viable.length)];
  }

  private calculateTotalBeats(config: GenerationConfig, tempo: number): number {
    if (config.duration.unit === 'beats') {
      return config.duration.value;
    }
    // Convert minutes to beats
    return config.duration.value * tempo;
  }

  private secondsToBeats(seconds: number, tempo: number): number {
    return (seconds / 60) * tempo;
  }

  private beatsToSeconds(beats: number, tempo: number): number {
    return (beats / tempo) * 60;
  }

  /**
   * Get the effective playback range within a file, considering silence detection.
   * If skipSilence is true and the file has active region data, constrains to the non-silent range.
   * Otherwise, returns the full file range (0 to fileDurationBeats).
   */
  private getEffectiveRange(
    file: AudioFile,
    fileDurationBeats: number,
    tempo: number,
    skipSilence: boolean,
  ): { rangeStartBeats: number; rangeEndBeats: number } {
    if (skipSilence && file.activeStartSeconds != null && file.activeEndSeconds != null) {
      const rangeStartBeats = this.secondsToBeats(file.activeStartSeconds, tempo);
      const rangeEndBeats = this.secondsToBeats(file.activeEndSeconds, tempo);
      // Only use active range if it's meaningfully smaller than the full file
      if (rangeEndBeats > rangeStartBeats) {
        return { rangeStartBeats, rangeEndBeats };
      }
    }
    return { rangeStartBeats: 0, rangeEndBeats: fileDurationBeats };
  }

  /**
   * Get the list of currently mounted volumes (macOS: /Volumes/*).
   * Used to skip files on disconnected external drives.
   */
  private getMountedVolumes(): Set<string> {
    const volumes = new Set<string>();
    try {
      const entries = fs.readdirSync('/Volumes');
      for (const entry of entries) {
        volumes.add(path.join('/Volumes', entry));
      }
    } catch {
      // Not macOS or /Volumes not readable — assume all paths are accessible
    }
    return volumes;
  }

  /**
   * Check if a file path is on a currently mounted volume.
   * Files on local paths (not /Volumes/) are always considered accessible.
   */
  private isFileAccessible(filePath: string, mountedVolumes: Set<string>): boolean {
    if (!filePath.startsWith('/Volumes/')) return true;
    // Extract the volume name: /Volumes/MyDrive/... → /Volumes/MyDrive
    const parts = filePath.split('/');
    if (parts.length < 3) return true;
    const volumePath = '/' + parts[1] + '/' + parts[2];
    return mountedVolumes.has(volumePath);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
