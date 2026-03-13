# Ableton Generative Library Plugin

A generative composition tool for **Ableton Live 12** that creates new arrangements from your existing audio recording library. Select folders of jam recordings, and the plugin automatically groups them by track type (KICK, HIHAT, SYNTH, etc.) and generates random compositions by placing segments from your recordings into Ableton's arrangement or session view.

<video src="assets/ableton-generative-library-plugin.mp4" controls width="100%"></video>

## How It Works

```
┌─────────────────────────────────────────┐
│         Max for Live Device (UI)        │
│   Folders │ Tracks │ Generate │ Config  │
└──────────────────┬──────────────────────┘
                   │ UDP (JSON)
┌──────────────────▼──────────────────────┐
│          Node.js Server                 │
│  ┌──────────┐  ┌─────────────────────┐  │
│  │ Scanner  │  │ Generative Engine   │  │
│  │ (files + │  │ (random segments,   │  │
│  │ metadata)│  │  track matching)    │  │
│  └────┬─────┘  └──────────┬──────────┘  │
│  ┌────▼───────────────────▼──────────┐  │
│  │       SQLite Cache Database       │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │   ableton-js (Live API client)   │  │
│  └──────────────┬────────────────────┘  │
└─────────────────┼───────────────────────┘
                  │ UDP
┌─────────────────▼───────────────────────┐
│  Ableton Live 12                        │
│  MIDI Remote Script (AbletonJS)         │
│                                         │
│  Track.create_audio_clip(path, position)│
│  Clip.start_marker / end_marker         │
└─────────────────────────────────────────┘
```

1. **Add folders** containing your Ableton projects / jam recordings
2. **Scan** to index all audio files (WAV, AIFF, FLAC, MP3, OGG) — metadata is cached in SQLite for fast subsequent loads
3. Files are **grouped by keywords** extracted from filenames (e.g., `KICK_heavy_001.wav` → KICK)
4. Your **Ableton tracks** are listed — enable/disable which ones to fill
5. Choose **duration** (1–30 min, or 8–256 beats) and **segment mode** (single long segment or multiple shorter segments)
6. Click **Generate** — random segments from your recordings are placed as clips in the arrangement (or session view)
7. **Clips reference original files in place** — no copying or transcoding. Only `start_marker`/`end_marker` are set to define the playback region
8. **Cmd+Z to undo** — each generation is wrapped in an undo step

---

## Installation (Quick Start)

You need **macOS**, **Ableton Live 12** (with Max for Live), and **Node.js 18+**.

### Step 1: Install Node.js (if you don't have it)

Check if you already have it:

```bash
node -v
# Should print v18.x.x or higher
```

If not, install via [Homebrew](https://brew.sh) (easiest) or [nodejs.org](https://nodejs.org):

```bash
brew install node
```

### Step 2: Run the installer

Unzip the plugin, open Terminal, and run:

```bash
cd ~/Downloads/GenerativeLibrary-v0.1.0   # wherever you unzipped it
./install.sh
```

This automatically:

- Installs all npm dependencies (Node.js server, SQLite, etc.)
- Copies the **AbletonJS MIDI Remote Script** to Ableton's User Library
- Builds the Max for Live device

### Step 3: Enable AbletonJS in Ableton

1. Open **Ableton Live 12**
2. Go to **Settings → Link/Tempo/MIDI**
3. Under **Control Surface**, click the dropdown and select **AbletonJS**
4. Leave Input and Output as **None**
5. Close Settings

> **Note:** If AbletonJS doesn't appear in the dropdown, restart Ableton after running `install.sh`.

### Step 4: Start the server & load the device

1. In a terminal, start the server:
   ```bash
   cd ~/Downloads/GenerativeLibrary-v0.1.0   # your plugin folder
   npm run dev
   ```
2. In Ableton, drag `max-device/GenerativeLibrary.amxd` onto any track
3. The device status should say **Connected** — you're ready to go!

> **Tip:** Keep the terminal open while using the plugin. The server must be running for the device to work.

---

## Usage

1. **Add a folder** containing your jam recordings (click "Add Folder")
2. **Click Scan** to index all audio files — metadata is cached for fast subsequent loads
3. Your **Ableton tracks** appear in the track list — click to toggle enable/disable
4. Choose **duration** (e.g., "128 beats" or "5 min") and **segment mode** (single or multiple)
5. Click **Generate** — random audio segments fill your arrangement!
6. Don't like it? **Cmd+Z** to undo and generate again

### Add Track Suggestions

The plugin can suggest track names based on your file library. Click **Add Track** to create a new audio track in Ableton pre-matched to your recordings.

### Session vs Arrangement

Use the **View** toggle to switch between creating clips in **Session View** (clip slots) or **Arrangement View** (timeline).

---

## Key Features

- **No file copying** — clips reference original files via `start_marker`/`end_marker`. Your project stays small.
- **External drive support** — audio files on external drives are referenced by absolute path
- **SQLite cache** — file metadata is cached so subsequent loads are instant
- **Incremental scanning** — only new/modified files are processed on rescan
- **Keyword matching** — filenames like `KICK_foo.wav`, `SYNTH_jam.wav` are automatically matched to tracks
- **Configurable rules** — 23 default rules with 80+ keywords, fully customizable
- **Single or multiple segments** — fill tracks with one long segment or multiple shorter random ones
- **Undo support** — each generation is wrapped in an undo step (Cmd+Z to revert)

### Track Matching Rules

Default rules map filenames to track types using keywords:

| Track Name | Keywords (examples)                           |
| ---------- | --------------------------------------------- |
| KICK       | KICK, KD, BD1, BD2                            |
| HIHAT      | HIHAT, HAT, CH, OH, HC                        |
| SNARE      | SNARE, CLAP, SD, RS                           |
| PERCUSSION | PERC, HT, MT, CYMBAL, RIDE                    |
| SYNTH      | SYNTH, LEAD, PAD, MINILOGUE, SERUM, SURGE     |
| BASS       | BASS, BASSLINE, SYNTHBASS, SUB                |
| FX         | FX, NOISE, NOISEFX, AMBIENT, RISE             |
| MODULAR    | MODULAR, MODU, M-RESO, T-RESO                 |
| VOCAL      | VOCAL, VOX, VOICE, VOXCUT                     |
| DRUMS      | DRUM, DRUMS, DIGITAKT, JOMOX, TR8S, ALPHABASE |
| GUITAR     | GUITAR, KEYS, PIANO, ORGAN                    |
| SAMPLERS   | AKAI, OCTA, NS2, NS4                          |

Rules are customizable via the CLI or by editing the SQLite database.

### Supported Audio Formats

WAV, AIFF/AIF, FLAC, MP3, OGG Vorbis

---

## Troubleshooting

| Problem                       | Solution                                                                                                                      |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **"Run install.sh first!"**   | Open Terminal, `cd` into the plugin folder, and run `./install.sh`                                                            |
| **Server won't start**        | Make sure Node.js 18+ is installed (`node -v`). Run `npm run dev` in a terminal from the plugin folder.                       |
| **"Server not connected"**    | Make sure the server is running (`npm run dev`). Ports 9876/9877 must be free.                                                |
| **"Ableton not connected"**   | Enable AbletonJS in Settings → Link/Tempo/MIDI. Restart Ableton if needed.                                                    |
| **AbletonJS not in dropdown** | Restart Ableton after running `install.sh`. The Remote Script needs a fresh start.                                            |
| **Files not found**           | Check that external drives are mounted. Files are referenced by absolute path.                                                |
| **No matching files**         | Make sure your filenames contain keywords like KICK, SYNTH, etc. Run `npx tsx server/src/cli.ts rules` to see matching rules. |
| **Clips show as offline**     | External drive was disconnected. Reconnect and Ableton will find the files.                                                   |
| **MIDI tracks in list**       | MIDI tracks show `(midi)` suffix and are auto-disabled. Only audio tracks receive clips.                                      |
| **`[shell]` object error**    | The `[shell]` external is no longer required. Update to the latest version of the plugin.                                     |

---

## Updating

When you receive a new version ZIP:

1. Unzip it to the same location (or a new folder)
2. Run `./install.sh` again — it's safe to re-run
3. Reload the `.amxd` device in Ableton

---

## Development

### Project Structure

```
├── install.sh                   # One-command installer for users
├── package.json                 # Node.js project config
├── server/
│   ├── tsconfig.json            # TypeScript config
│   ├── data/                    # SQLite database (gitignored)
│   ├── logs/                    # Server logs (gitignored)
│   └── src/
│       ├── index.ts             # Server entry point
│       ├── types.ts             # Shared TypeScript types & constants
│       ├── database.ts          # SQLite database service
│       ├── scanner.ts           # Audio file scanner with metadata extraction
│       ├── ableton.ts           # Ableton Live integration via ableton-js
│       ├── generator.ts         # Generative composition engine
│       ├── udp-server.ts        # UDP server for M4L communication
│       └── cli.ts               # CLI utility
├── max-device/
│   ├── generative-library.js    # Max for Live JavaScript (ES5, runs inside Max)
│   ├── BUILD_INSTRUCTIONS.md    # How to build the .amxd patcher
│   └── GenerativeLibrary.amxd   # Max for Live device (built by build_amxd.py)
├── scripts/
│   ├── build_amxd.py            # Generates .amxd binary from Python
│   └── package.sh               # Creates distributable ZIP
└── README.md                    # This file
```

### Dev Commands

```bash
npm run dev          # Start server with hot-reload (tsx watch)
npm run build        # Compile TypeScript to dist/
npm start            # Run compiled server
npm test             # Run tests (vitest)
npm run build:plugin # Rebuild .amxd device
npm run package      # Create distributable ZIP in dist/
```

### CLI Tools

```bash
npx tsx server/src/cli.ts add-folder /path/to/recordings
npx tsx server/src/cli.ts scan
npx tsx server/src/cli.ts stats
npx tsx server/src/cli.ts rules
```

### Creating a Release

```bash
# 1. Update version in package.json
# 2. Build the distributable ZIP
npm run package
# 3. Share dist/GenerativeLibrary-v{version}.zip
```

---

## License

MIT
