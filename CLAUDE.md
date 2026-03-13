# CLAUDE.md — AI Development Guide

This file provides context for AI assistants working on this codebase.

## Project Overview

**Ableton Generative Library Plugin** — a hybrid Max for Live device + Node.js server that generates random compositions in Ableton Live 12 from existing audio recordings.

## Architecture

- **Hybrid M4L + Node.js**: A thin Max for Live device provides the in-Ableton UI. A Node.js server handles all heavy logic (file scanning, database, generative algorithms, clip creation).
- **Communication**: UDP JSON messages between M4L and Node.js (ports 9876/9877), wrapped in OSC framing.
- **Ableton operations**: All Ableton reads AND writes go through the `ableton-js` npm package + MIDI Remote Script (track listing, tempo, arrangement queries, clip creation via `Track.create_audio_clip()`).
- **Clip creation**: Server-side via `ableton-js` calling `Track.create_audio_clip(file_path, position)` — available natively in Live 12's LOM. No Browser API workarounds needed.
- **Database**: SQLite via `better-sqlite3` for caching scanned audio file metadata.

## Project Structure

```
server/src/
  index.ts        — Entry point, starts DB + Ableton connection + UDP server
  types.ts        — All TypeScript types, interfaces, constants, message protocol
  database.ts     — DatabaseService class: SQLite schema, CRUD for folders/files/rules
  scanner.ts      — FileScanner class: recursive directory scanning, metadata extraction, keyword extraction
  ableton.ts      — AbletonService class: Live API wrapper via ableton-js (reads + writes)
  generator.ts    — GenerativeEngine class: creates composition plans and executes them via ableton-js
  udp-server.ts   — UDPServer class: JSON message routing between M4L and server logic
  cli.ts          — CLI utility for manual database/scanning operations

max-device/
  generative-library.js — Max for Live JavaScript (ES5, runs inside Max's JS engine)
  BUILD_INSTRUCTIONS.md — How to build the .amxd patcher in Max

scripts/
  build_amxd.py         — Generates GenerativeLibrary.amxd binary from Python
  package.sh            — Creates distributable ZIP for sharing

install.sh              — One-command installer (npm install + Remote Script + build)
```

## Key Technical Decisions

1. **File references, not copies**: Clips reference original files in place. `Clip.start_marker`/`end_marker` define the playback segment. No file copying or transcoding.
2. **Server-side clip creation**: Both reads and writes go through `ableton-js`. Live 12 exposes `Track.create_audio_clip(file_path, position)` directly, so the server can create arrangement clips without any workarounds. The M4L JS is a thin UI layer only.
3. **SQLite over JSON**: Handles 100K+ audio files efficiently. Indexed queries. Incremental updates.
4. **UDP over HTTP**: Max for Live has native `[udpsend]`/`[udpreceive]` objects (OSC protocol). Lowest friction.
5. **`ableton-js` Namespace API**: `song.get('tracks')` returns `Track[]` (transformed). Access raw data via `track.raw.name`. Supports both reads and writes.
6. **Max JS is ES5**: The `generative-library.js` file runs in Max's limited JS engine — no npm, no async/await, no modern JS. Use `var`, `function`, `Task` for async scheduling.
7. **UDP is OSC**: `[udpsend]`/`[udpreceive]` always use OSC framing. Server wraps JSON in OSC messages (address `/resp`, type `,s`, string arg). M4L sends via OSC address `/cmd`. Server parses incoming OSC to extract JSON. Patcher chain: `[udpreceive] → [route /resp] → [prepend response] → [js]`.
8. **7 JS outlets**: outlet 0=udpsend, 1=status, 2=tracks umenu, 3=file count, 4=folders umenu, 5=duration umenu, 6=track suggestions umenu. Duration menu and track suggestions are auto-populated by JS.
9. **Use `[textbutton]` not `[live.button]`**: `[live.button]` is a toggle showing "Button On/Off". `[textbutton]` with `mode=0` shows a fixed label and fires on click. For server start/stop, use `[live.text]` (supports text/texton toggle labels).
10. **Track toggle via umenu**: Clicking a track in the umenu toggles its enabled state. `[umenu] → [prepend toggleTrack] → [js]`. The track list shows `[x]`/`[ ]` prefixes and `(midi)` suffixes for non-audio tracks.
11. **Add Track via suggestions**: The `get_track_suggestions` command queries all track rules, counts matching audio files per rule, excludes tracks already in the Ableton session (case-insensitive), and returns suggestions sorted by file count. The M4L JS creates new audio tracks via `LiveAPI.call('create_audio_track')` and sets their name.

## Development Commands

```bash
npm run dev          # Start server with hot-reload (tsx watch)
npm run build        # Compile TypeScript to dist/
npm run build:plugin # Rebuild .amxd device (runs build_amxd.py)
npm start            # Run compiled server
npm test             # Run tests (vitest)
npm run package      # Create distributable ZIP in dist/
npx tsx server/src/cli.ts [command]  # CLI utility
```

## Packaging & Distribution

- `install.sh` — run by end users after unzipping. Installs npm deps, copies AbletonJS Remote Script, builds .amxd. Idempotent (safe to re-run).
- `npm run package` → runs `scripts/package.sh` → produces `dist/GenerativeLibrary-v{version}.zip`
- The ZIP contains all source + scripts needed. Users unzip, run `./install.sh`, and are ready.
- Node.js 18+ is a prerequisite; the install script checks for it.

## Ableton 12 Setup

All of this is handled by `./install.sh`, but for reference:

```bash
# 1. Install dependencies
npm install

# 2. Copy the MIDI Remote Script to Ableton 12's User Library
mkdir -p "$HOME/Music/Ableton/User Library/Remote Scripts/AbletonJS"
cp -r node_modules/ableton-js/midi-script/* "$HOME/Music/Ableton/User Library/Remote Scripts/AbletonJS/"

# 3. In Ableton Live 12: Settings → Link/Tempo/MIDI → Control Surface → select "AbletonJS"
#    Leave Input/Output as "None"
```

## Code Conventions

- TypeScript strict mode
- ES modules (`import`/`export`)
- Async/await throughout the server code
- Classes for services (DatabaseService, AbletonService, FileScanner, etc.)
- Types defined in `types.ts` — shared across all modules
- Console logging with `[Module]` prefix: `[Ableton]`, `[Scanner]`, `[Server]`, `[Generator]`, `[DB]`, `[UDP]`

## Message Protocol

Commands (M4L → Server): JSON objects with a `type` field.
Responses (Server → M4L): JSON objects with a `type` field.
See `ServerCommand` and `ServerResponse` types in `types.ts`.

Large responses are chunked into 7KB UDP datagrams with `_chunked`, `_messageId`, `_chunkIndex`, `_totalChunks`, `_data` envelope fields.

## Generation Flow

1. M4L JS sends `generate` command with `enabledTrackIndices` (audio-only, user-toggled)
2. Server's `GenerativeEngine.createPlan()` builds a `GenerationPlan` (file selection, positioning, timing)
3. Server's `GenerativeEngine.executePlan()` iterates clips, calling `AbletonService.createArrangementClip()` for each
4. `createArrangementClip()` calls `Track.create_audio_clip(filePath, position)` via `ableton-js` (Live 12 API)
5. `setClipMarkers()` finds the newly created clip and sets `start_marker`, `end_marker`, `name`, `looping` to define the playback segment
6. Entire operation is wrapped in `begin_undo_step` / `end_undo_step` for single Cmd+Z revert
7. Server sends `generation_complete` response back to M4L JS

## Testing

- Unit tests for scanner keyword extraction, generator segment logic, database CRUD
- Integration tests require a running Ableton Live 12 instance with AbletonJS Remote Script
- Test with: `npm test`

## Common Tasks

### Adding a new command

1. Add the command type to `ServerCommand` union in `types.ts`
2. Add the response type to `ServerResponse` union in `types.ts`
3. Add a case in `UDPServer.routeCommand()` in `udp-server.ts`
4. Implement the handler method
5. Add the M4L-side handler in `generative-library.js` `handleResponse()`
6. If the command adds UI elements, update `scripts/build_amxd.py` and rebuild with `npm run build:plugin`

### Adding a new track rule

Insert into `track_rules` table or use `db.setTrackRule(name, keywords)`

### Changing default audio support

Edit `SUPPORTED_EXTENSIONS` in `types.ts`
