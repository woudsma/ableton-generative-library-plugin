# PLAN.md — Project Plan & Roadmap

## Overview

Build a hybrid Max for Live + Node.js plugin for Ableton Live 12 that generates new compositions from existing audio recordings.

## Current Status: v0.1.0 — Core Implementation ✅

### Completed

- [x] Project scaffolding (TypeScript, npm, directory structure)
- [x] Shared types and message protocol (`types.ts`)
- [x] SQLite database with schema for folders, audio files, track rules, generation history
- [x] Default track matching rules (KICK, HIHAT, SYNTH, BASS, etc.)
- [x] File scanner with recursive discovery, metadata extraction, keyword matching
- [x] Incremental scanning (skips unchanged files)
- [x] External drive support (absolute paths)
- [x] Ableton Live 12 integration via `ableton-js`
  - Track listing, tempo / time signature queries
  - Arrangement clip creation via `Track.create_audio_clip()` (Live 12 native API)
  - Session clip creation via `ClipSlot.create_audio_clip()` (Live 12 native API)
  - Clip marker setting (`start_marker`, `end_marker`) for segment playback
  - Undo step wrapping (`begin_undo_step` / `end_undo_step`)
- [x] Generative composition engine
  - Single segment mode (one long segment per track)
  - Multiple segments mode (random shorter segments, quantized to bars)
  - Random file selection and random start point within files
  - Configurable duration (minutes or beats)
- [x] UDP server with JSON message protocol
  - All CRUD operations for folders, tracks, rules
  - Scan progress reporting
  - Generation plan + execution
  - Large message chunking
- [x] Max for Live JavaScript device code
  - UI outlet mapping (status, tracks, folders, file count)
  - Server auto-launch via `[shell]` object
  - Health check / ping
  - All UI action handlers (add folder, generate, etc.)
  - Duration options, segment mode, view mode
  - Hot reload (`autowatch = 1`)
- [x] CLI utility for manual operations
- [x] Documentation (README, CLAUDE.md, PLAN.md)
- [x] Live 12 migration: removed Live 11 Browser API workarounds, server handles all reads + writes via `ableton-js`

## Architecture Decisions

| Decision                              | Rationale                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Node.js + `ableton-js` (not pure M4L) | Full npm ecosystem, SQLite, async I/O, metadata parsing                                         |
| SQLite (not JSON file)                | Handles 100K+ files, indexed queries, incremental updates                                       |
| UDP JSON protocol                     | Max for Live has native `[udpsend]`/`[udpreceive]` objects                                      |
| Server-side reads AND writes          | Live 12 exposes `Track.create_audio_clip()` via Remote Script — no M4L LiveAPI writes needed    |
| File references (not copies)          | `create_audio_clip` references in-place. Combined with `start_marker`/`end_marker`, no file I/O |
| Clip markers (not physical cutting)   | No transcoding, no temp files, instant generation                                               |
| Auto-start server from M4L            | User doesn't need terminal knowledge                                                            |

## Phase 2 — Enhancements (Next)

### Silence Detection

- [ ] Analyze audio buffers (RMS energy) to detect silent regions
- [ ] Store silence ranges per file in SQLite: `silence_ranges` table with `file_id`, `start_seconds`, `end_seconds`
- [ ] When picking random start points, skip silent regions
- [ ] Configurable silence threshold (e.g., -60dB)
- [ ] Analysis can run during scan or as a separate pass

### Improved Track Matching

- [ ] Path-based matching: use parent folder names for matching (e.g., `/recordings/KICKS/session1.wav`)
- [ ] Configurable regex patterns per track rule (currently supported in schema, needs UI)
- [ ] Fuzzy matching for track names that aren't exact keyword matches
- [ ] Machine learning category detection (future)

### Better Segment Logic

- [ ] Configurable segment length range (currently hardcoded 4–32 bars for multiple mode)
- [ ] Overlap / crossfade between segments
- [ ] Avoid repeating the same source file in consecutive segments
- [ ] BPM-aware segment cutting (align to detected transients)
- [ ] Option to quantize segment starts to bar boundaries within the source file

### UI Improvements (M4L)

- [ ] Track enable/disable with visual checkboxes
- [ ] Waveform preview in a companion web UI
- [ ] Generation history browser (undo to any previous generation)
- [ ] Folder tree view
- [ ] File count per keyword group display

## Phase 3 — Advanced Features

### Smart Analysis

- [ ] BPM detection per audio file (store in metadata)
- [ ] Key detection for harmonic matching
- [ ] Energy/loudness analysis for dynamic composition
- [ ] Group compatible files by BPM + key

### Composition Intelligence

- [ ] Weighted random selection (prefer files with certain attributes)
- [ ] Structure templates (intro → verse → chorus → breakdown → outro)
- [ ] Probability curves (e.g., gradually introduce more tracks)
- [ ] Call & response patterns between tracks

### Session Features

- [ ] Session view scene generation (fill scenes with clips)
- [ ] Follow actions for live performance
- [ ] Scene arrangement / ordering

### Persistence

- [ ] Save/load generation presets (track selections, duration, rules)
- [ ] "Lock" certain generated segments (preserve on re-generate)
- [ ] "Favorites" marking for good segment discoveries
- [ ] Export generation as a standalone project (collect and save)

### Performance

- [ ] Worker threads for scanning large libraries
- [ ] Background metadata analysis (non-blocking)
- [ ] Streaming scan progress via WebSocket (for web UI)

## Phase 4 — Polish

- [ ] Comprehensive error handling with user-friendly messages
- [ ] Windows compatibility testing
- [ ] Pre-built `.amxd` device in the repository
- [ ] Automated tests with mock Ableton connection
- [ ] CI/CD for server code
- [ ] Package as installable plugin with setup wizard
- [ ] Web-based companion UI (React) for advanced configuration
- [ ] Documentation with screenshots and video tutorial

## Technical Notes

### ableton-js API Patterns

```typescript
// Namespace.get returns transformed types when available
const tracks: Track[] = await ableton.song.get('tracks');

// Raw properties via .raw
const name: string = track.raw.name;

// Async property access
const hasAudio: boolean = await track.get('has_audio_input');

// Track functions (Live 12 native API)
await track.createAudioClip(filePath, positionInBeats);

// Clip property setting
await clip.set('start_marker', beatsValue);
await clip.set('end_marker', beatsValue);

// Undo wrapping
await song.beginUndoStep();
// ... create clips ...
await song.endUndoStep();
```

### Max for Live JS Patterns

```javascript
autowatch = 1;  // hot reload on save
outlets = 6;    // number of outlets

// Async work via Task
var task = new Task(function() { /* work */ }, this);
task.schedule(2000);

// UDP communication
outlet(0, JSON.stringify({ type: 'command', ... }));  // to udpsend
function response(jsonStr) { /* from udpreceive */ }

// File system
var f = new Folder("/absolute/path");
while (!f.end) { post(f.filename + "\n"); f.next(); }
```

### SQLite Schema

- `folders`: watched directory paths, scan timestamps
- `audio_files`: path, filename, duration, sample rate, channels, keywords (JSON), file size, modified date
- `track_rules`: track name → keyword list, optional regex
- `generation_history`: saved plans for undo/browsing
