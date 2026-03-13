import { Ableton } from 'ableton-js';
import type { AbletonTrack, ViewMode } from './types.js';

export class AbletonService {
  private ableton: Ableton;
  private connected = false;

  constructor() {
    this.ableton = new Ableton({ heartbeatInterval: 2000, commandTimeoutMs: 5000 });
  }

  // ─── Connection ───

  async connect(): Promise<void> {
    if (this.connected) return;

    try {
      await this.ableton.start(10000);
      this.connected = true;
      console.log('[Ableton] Connected to Live');

      this.ableton.on('disconnect', () => {
        this.connected = false;
        console.log('[Ableton] Disconnected from Live');
      });

      this.ableton.on('connect', () => {
        this.connected = true;
        console.log('[Ableton] Reconnected to Live');
      });
    } catch (err) {
      this.connected = false;
      throw new Error(
        `Could not connect to Ableton Live 12. Make sure:\n` +
          `1. Ableton Live 12 is running\n` +
          `2. The ableton-js MIDI Remote Script is installed in ~/Music/Ableton/User Library/Remote Scripts/AbletonJS/\n` +
          `3. It is selected as a Control Surface in Settings > Link/Tempo/MIDI\n` +
          `Error: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.ableton.close();
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  // ─── Song Queries ───

  async getTempo(): Promise<number> {
    this.ensureConnected();
    return this.ableton.song.get('tempo');
  }

  async getTimeSignature(): Promise<{ numerator: number; denominator: number }> {
    this.ensureConnected();
    const [numerator, denominator] = await Promise.all([
      this.ableton.song.get('signature_numerator'),
      this.ableton.song.get('signature_denominator'),
    ]);
    return { numerator, denominator };
  }

  async getSongLength(): Promise<number> {
    this.ensureConnected();
    return this.ableton.song.get('song_length');
  }

  async getCurrentTime(): Promise<number> {
    this.ensureConnected();
    return this.ableton.song.get('current_song_time');
  }

  // ─── Track Queries ───

  async getTracks(): Promise<AbletonTrack[]> {
    this.ensureConnected();
    // song.get('tracks') returns Track[] (transformed) thanks to Namespace generics
    const tracks = await this.ableton.song.get('tracks');
    const result: AbletonTrack[] = [];

    for (let i = 0; i < tracks.length; i++) {
      const track = tracks[i];
      const hasAudioInput = await track.get('has_audio_input');
      const isFoldable = track.raw.is_foldable;

      // Group tracks (is_foldable) have audio input but can't hold clips — treat as 'group'
      let type: AbletonTrack['type'];
      if (isFoldable) {
        type = 'group';
      } else if (hasAudioInput) {
        type = 'audio';
      } else {
        type = 'midi';
      }

      result.push({
        index: i,
        name: track.raw.name,
        type,
        color: track.raw.color,
        enabled: true,
      });
    }

    return result;
  }

  /**
   * Get only audio tracks (which can hold audio clips).
   */
  async getAudioTracks(): Promise<AbletonTrack[]> {
    const allTracks = await this.getTracks();
    return allTracks.filter((t) => t.type === 'audio');
  }

  // ─── Clip Creation ───

  /**
   * Get the arrangement end time for a track (position of the last clip's end).
   * Returns 0 if the arrangement is empty.
   */
  async getArrangementEndTime(trackIndex: number): Promise<number> {
    this.ensureConnected();
    const tracks = await this.ableton.song.get('tracks');
    const track = tracks[trackIndex];
    if (!track) return 0;

    const clips = await track.get('arrangement_clips');
    if (!clips || clips.length === 0) return 0;

    let maxEnd = 0;
    for (const clip of clips) {
      const endTime = clip.raw?.end_time ?? 0;
      if (endTime > maxEnd) maxEnd = endTime;
    }
    return maxEnd;
  }

  /**
   * Get the arrangement end time across ALL enabled tracks.
   * Returns 0 if the arrangement is completely empty.
   */
  async getGlobalArrangementEndTime(trackIndices: number[]): Promise<number> {
    let maxEnd = 0;
    for (const idx of trackIndices) {
      const end = await this.getArrangementEndTime(idx);
      if (end > maxEnd) maxEnd = end;
    }
    return maxEnd;
  }

  /**
   * Create an audio clip in the arrangement view.
   *
   * Live 12 provides Track.create_audio_clip(file_path, position) directly,
   * which creates an arrangement clip referencing the audio file at the
   * specified beat position. No Browser API workaround needed.
   */
  async createArrangementClip(
    trackIndex: number,
    filePath: string,
    positionBeats: number,
  ): Promise<{ clipId: string } | null> {
    this.ensureConnected();

    const tracks = await this.ableton.song.get('tracks');
    const track = tracks[trackIndex];
    if (!track) {
      throw new Error(`Track at index ${trackIndex} not found`);
    }

    try {
      const clip = await track.createAudioClip(filePath, positionBeats);
      console.log(
        `[Ableton] Created arrangement clip on track ${trackIndex} at beat ${positionBeats}`,
      );
      return clip ? { clipId: (clip as any).raw?.id ?? '' } : null;
    } catch (err) {
      console.error(
        `[Ableton] Failed to create arrangement clip on track ${trackIndex}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Set the start and end markers of an arrangement clip to define
   * which portion of the source file is played.
   */
  async setClipMarkers(
    trackIndex: number,
    clipStartTime: number,
    startMarker: number,
    endMarker: number,
    options?: {
      warping?: boolean;
      looping?: boolean;
      name?: string;
    },
  ): Promise<void> {
    this.ensureConnected();

    const tracks = await this.ableton.song.get('tracks');
    const track = tracks[trackIndex];
    if (!track) return;

    // Find the clip at the specified position
    const arrangementClips = await track.get('arrangement_clips');
    const clip = arrangementClips.find(
      (c: any) => Math.abs((c.raw?.start_time ?? c.start_time) - clipStartTime) < 0.5,
    );

    if (!clip) {
      console.warn(
        `[Ableton] Could not find clip at position ${clipStartTime} on track ${trackIndex}`,
      );
      return;
    }

    // Set markers
    await clip.set('start_marker', startMarker);
    await clip.set('end_marker', endMarker);

    if (options?.looping) {
      await clip.set('looping', true);
      await clip.set('loop_start', startMarker);
      await clip.set('loop_end', endMarker);
    } else if (options?.looping === false) {
      await clip.set('looping', false);
    }
    if (options?.warping !== undefined) {
      await clip.set('warping', options.warping);
    }
    if (options?.name) {
      await clip.set('name', options.name);
    }
  }

  /**
   * Find the first scene index where ALL the given tracks have empty clip slots.
   * This ensures clips from a single generation land on the same row.
   * Creates a new scene if no suitable one exists.
   */
  async getNextSessionScene(trackIndices: number[]): Promise<number> {
    this.ensureConnected();

    const tracks = await this.ableton.song.get('tracks');

    // Get clip slot arrays for each enabled track
    const slotArrays: { has_clip: boolean }[][] = [];
    let maxSlots = 0;
    for (const idx of trackIndices) {
      const track = tracks[idx];
      if (!track) continue;
      const clipSlots = await track.get('clip_slots');
      const slotStatus: { has_clip: boolean }[] = [];
      for (let i = 0; i < clipSlots.length; i++) {
        const hasClip = await clipSlots[i].get('has_clip');
        slotStatus.push({ has_clip: hasClip });
      }
      slotArrays.push(slotStatus);
      maxSlots = Math.max(maxSlots, clipSlots.length);
    }

    // Find the first scene where ALL tracks have an empty slot
    // Start from the end to place clips after existing content
    // Strategy: find the highest occupied scene across all tracks, then use the next one
    let highestOccupied = -1;
    for (const slots of slotArrays) {
      for (let i = slots.length - 1; i >= 0; i--) {
        if (slots[i].has_clip) {
          highestOccupied = Math.max(highestOccupied, i);
          break;
        }
      }
    }

    const targetScene = highestOccupied + 1;

    // Create a new scene if needed
    if (targetScene >= maxSlots) {
      await this.ableton.song.createScene();
      console.log(`[Ableton] Created new scene at index ${targetScene}`);
    }

    return targetScene;
  }

  /**
   * Create a clip in the session view at the first empty slot for the track.
   * Uses ClipSlot.create_audio_clip(path) available in Live 12's LOM.
   */
  async createSessionClip(
    trackIndex: number,
    filePath: string,
    sceneIndex?: number,
  ): Promise<number> {
    this.ensureConnected();

    const tracks = await this.ableton.song.get('tracks');
    const track = tracks[trackIndex];
    if (!track) {
      throw new Error(`Track at index ${trackIndex} not found`);
    }

    const clipSlots = await track.get('clip_slots');

    let targetSlotIndex = sceneIndex;

    if (targetSlotIndex === undefined) {
      // Find first empty clip slot
      for (let i = 0; i < clipSlots.length; i++) {
        const hasClip = await clipSlots[i].get('has_clip');
        if (!hasClip) {
          targetSlotIndex = i;
          break;
        }
      }
    }

    if (targetSlotIndex === undefined) {
      // All slots full — create a new scene
      await this.ableton.song.createScene();
      targetSlotIndex = clipSlots.length;
    }

    // Create audio clip directly in the clip slot
    const refreshedSlots = await track.get('clip_slots');
    const slot = refreshedSlots[targetSlotIndex];
    if (!slot) throw new Error(`Clip slot ${targetSlotIndex} on track ${trackIndex} not found`);

    // ableton-js hasn't wrapped ClipSlot.create_audio_clip yet, so call via sendCommand
    await slot.sendCommand('create_audio_clip', [filePath]);
    console.log(`[Ableton] Created session clip on track ${trackIndex}, slot ${targetSlotIndex}`);
    return targetSlotIndex;
  }

  /**
   * Set start/end markers on a session clip (in a clip slot).
   */
  async setSessionClipMarkers(
    trackIndex: number,
    slotIndex: number,
    startMarker: number,
    endMarker: number,
    options?: {
      warping?: boolean;
      looping?: boolean;
      name?: string;
    },
  ): Promise<void> {
    this.ensureConnected();

    const tracks = await this.ableton.song.get('tracks');
    const track = tracks[trackIndex];
    if (!track) return;

    const clipSlots = await track.get('clip_slots');
    const slot = clipSlots[slotIndex];
    if (!slot) {
      console.warn(`[Ableton] Clip slot ${slotIndex} not found on track ${trackIndex}`);
      return;
    }

    const clip = await slot.get('clip');
    if (!clip) {
      console.warn(`[Ableton] No clip in slot ${slotIndex} on track ${trackIndex}`);
      return;
    }

    await clip.set('start_marker', startMarker);
    await clip.set('end_marker', endMarker);

    if (options?.looping) {
      await clip.set('looping', true);
      await clip.set('loop_start', startMarker);
      await clip.set('loop_end', endMarker);
    } else if (options?.looping === false) {
      await clip.set('looping', false);
    }
    if (options?.warping !== undefined) {
      await clip.set('warping', options.warping);
    }
    if (options?.name) {
      await clip.set('name', options.name);
    }
  }

  // ─── Undo Support ───

  async beginUndoStep(): Promise<void> {
    this.ensureConnected();
    await this.ableton.song.beginUndoStep();
  }

  async endUndoStep(): Promise<void> {
    this.ensureConnected();
    await this.ableton.song.endUndoStep();
  }

  // ─── Utility ───

  /**
   * Convert seconds to beats at the current tempo.
   */
  async secondsToBeats(seconds: number): Promise<number> {
    const tempo = await this.getTempo();
    return (seconds / 60) * tempo;
  }

  /**
   * Convert beats to seconds at the current tempo.
   */
  async beatsToSeconds(beats: number): Promise<number> {
    const tempo = await this.getTempo();
    return (beats / tempo) * 60;
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('Not connected to Ableton Live. Attempting to reconnect...');
    }
  }

  /**
   * Try to reconnect to Ableton Live if not connected.
   * Called lazily when a command needs Ableton.
   */
  async ensureConnectedOrReconnect(): Promise<void> {
    if (this.connected) return;
    console.log('[Ableton] Not connected, attempting to reconnect...');
    try {
      await this.connect();
      console.log('[Ableton] Reconnected!');
    } catch (err) {
      throw new Error('Not connected to Ableton Live');
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
