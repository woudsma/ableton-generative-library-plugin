# Ableton Generative Library Plugin

A generative composition tool for **Ableton Live 12** that creates random compositions from your existing audio recordings. Point it at folders of jam recordings, and it automatically groups files by track type (KICK, HIHAT, SYNTH, etc.) and generates clip arrangements in session or arrangement view.

<video src="https://github.com/user-attachments/assets/a688aa08-630d-4d17-b4d7-5c632bde9559" controls width="100%"></video>

### Audio Examples

Some random compositions, no effects: [[1]](https://github.com/woudsma/ableton-generative-library-plugin/raw/refs/heads/main/assets/179-generative-library-plugin-0.mp3), [[2]](https://github.com/woudsma/ableton-generative-library-plugin/raw/refs/heads/main/assets/179-generative-library-plugin-1.mp3), [[3]](https://github.com/woudsma/ableton-generative-library-plugin/raw/refs/heads/main/assets/179-generative-library-plugin-2.mp3)

## How It Works

A **Max for Live device** provides the UI inside Ableton. A **Node.js server** handles file scanning, database, and generative logic. Communication is over UDP (OSC/JSON). Clip creation uses `ableton-js` and Live 12's `Track.create_audio_clip()` API.

1. **Add folders** containing your Ableton projects / jam recordings
2. **Scan** to index audio files (WAV, AIFF, FLAC, MP3, OGG) — metadata is cached in SQLite
3. Files are **matched to tracks by keywords** extracted from filenames (e.g., `KICK_heavy_001.wav` → KICK)
4. **Enable/disable tracks**, or **Solo** a single track for focused generation
5. Pick **duration**, **segment mode** (single/multiple), and **view** (session/arrangement)
6. **Create clips** — random segments from your library are placed as clips. **Cmd+Z to undo**
7. Use **Row variation** to create a new scene with the same files but different starting positions

Clips reference original files in place — no copying or transcoding. Only `start_marker` / `end_marker` define the playback region.

<details>
<summary>Architecture diagram</summary>

```
┌─────────────────────────────────────────┐
│       Max for Live Device (UI)          │
└──────────────────┬──────────────────────┘
                   │ UDP (JSON/OSC)
┌──────────────────▼──────────────────────┐
│  Node.js Server                         │
│  Scanner · Generator · SQLite · ableton-js
└──────────────────┬──────────────────────┘
                   │ UDP
┌──────────────────▼──────────────────────┐
│  Ableton Live 12 + AbletonJS Remote Script
└─────────────────────────────────────────┘
```

</details>

---

## Installation

**Requirements:** macOS, Ableton Live 12 (with Max for Live), Node.js 18+

```bash
# Install Node.js if needed
brew install node

# Unzip and install
cd ~/Downloads/GenerativeLibrary-v0.1.2
./install.sh
```

The installer handles npm dependencies, the AbletonJS MIDI Remote Script, and building the `.amxd` device.

Then in **Ableton Live 12**: Settings → Link/Tempo/MIDI → Control Surface → select **AbletonJS** (leave Input/Output as None).

### Running

1. Start the server: `npm run dev`
2. Drag `max-device/GenerativeLibrary.amxd` onto any track in Ableton
3. Status should say **Connected**

> Keep the terminal open — the server must be running for the device to work.

---

## Usage

1. **Add Folder** → select a folder with Ableton projects / recordings → **Scan**
2. **Tracks** appear from your Ableton session — click to toggle, or **Solo** one
3. **Add Track** suggests new tracks based on your library (e.g., "PERCUSSION — 4101 samples")
4. Configure: **duration** (8–1024 beats or 1–30 min), **segments** (single/multiple), **view** (session/arrangement)
5. Toggle **Silence** (skip silent regions), **Loop** (loop clips), **Key** (filter by compatible keys)
6. **Create clips** — or select a scene and click **Row variation** to create a variant

### Track Matching

Filenames are matched to tracks using keyword rules. 80+ default keywords cover common track names:

<details>
<summary>Default rules</summary>

| Track      | Keywords (examples)                |
| ---------- | ---------------------------------- |
| KICK       | KICK, KD, BD1, BD2                 |
| HIHAT      | HIHAT, HAT, CH, OH, HC             |
| SNARE      | SNARE, CLAP, SD, RS                |
| PERCUSSION | PERC, HT, MT, CYMBAL, RIDE         |
| SYNTH      | SYNTH, LEAD, PAD, MINILOGUE, SERUM |
| BASS       | BASS, BASSLINE, SUB                |
| FX         | FX, NOISE, AMBIENT, RISE           |
| MODULAR    | MODULAR, MODU, M-RESO, T-RESO      |
| VOCAL      | VOCAL, VOX, VOICE                  |
| DRUMS      | DRUM, DIGITAKT, JOMOX, TR8S        |
| GUITAR     | GUITAR, KEYS, PIANO, ORGAN         |
| SAMPLERS   | AKAI, OCTA, NS2, NS4               |

Rules are customizable via the CLI or SQLite database.

</details>

---

## Troubleshooting

| Problem               | Solution                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------- |
| Server not connected  | Run `npm run dev` in a terminal. Ports 9876/9877 must be free.                               |
| Ableton not connected | Enable AbletonJS in Settings → Link/Tempo/MIDI. Restart Ableton if needed.                   |
| No matching files     | Filenames need keywords (KICK, SYNTH, etc.). Run `npx tsx server/src/cli.ts rules` to check. |
| Clips offline         | Reconnect external drive — files are referenced by absolute path.                            |

---

## Development

```
server/src/          — TypeScript server (scanner, generator, database, ableton-js, UDP)
max-device/          — Max for Live JS (ES5) + generated .amxd device
scripts/             — build_amxd.py (generates .amxd), package.sh (creates ZIP)
```

```bash
npm run dev          # Server with hot-reload
npm test             # Run tests (vitest)
npm run build:plugin # Rebuild .amxd from build_amxd.py
npm run package      # Create distributable ZIP
```

---

## License

MIT
