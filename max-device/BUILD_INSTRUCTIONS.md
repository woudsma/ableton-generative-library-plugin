# Max for Live Device — Architecture Reference

The `.amxd` device file is **generated automatically** by `scripts/build_amxd.py`. You should never need to build it manually in Max. This document describes the patcher architecture for reference.

```bash
# Rebuild the device after making changes to build_amxd.py:
npm run build:plugin
```

## Overview

The M4L device is a thin UI layer (550×170 px). All heavy logic runs in the Node.js server. Communication flows over UDP with OSC framing:

```
Max UI → [js] → outlet 0 → [udpsend] → OSC /cmd → Node.js server (port 9876)
              ← inlet     ← [prepend response] ← [route /resp] ← [udpreceive 9877] ← OSC /resp
```

## Device Layout

```
┌──────────────────────────────────────────────────────────────┐
│ Connected                         "41318 files / 2 folders"  │  Row 0: Status
│ Folders: [umenu ▼]                   [Add Folder][Remove][Scan] Row 1: Library
│ Tracks:  [umenu ▼]               [Solo] [Refresh]            │  Row 2: Tracks
│ Add:     [umenu ▼]               [Add Track]                 │  Row 3: Add Track
│ [128 beats▼] [Single|Mult] [Sess|Arr] [Silence][Loop][Key]  │  Row 4: Settings
│ [══ Create clips ══]         [══ Row variation ══]           │  Row 5: Actions
└──────────────────────────────────────────────────────────────┘
```

## JS Outlets (7 total)

| Outlet | Target                        | Purpose                            |
| ------ | ----------------------------- | ---------------------------------- |
| 0      | `[udpsend 127.0.0.1 9876]`    | JSON commands to server            |
| 1      | `[prepend set]` → `[message]` | Status text display                |
| 2      | `[umenu tracks]`              | Track list population              |
| 3      | `[prepend set]` → `[message]` | File/folder count display          |
| 4      | `[umenu folders]`             | Folder list population             |
| 5      | `[umenu duration]`            | Duration menu (auto-populated)     |
| 6      | `[umenu tracksuggestions]`    | Track suggestions (auto-populated) |

## UI Element Wiring

All UI elements connect to the **same single** `[js generative-library.js]` object via `[prepend]` or `[message]` objects.

### Buttons (`[textbutton]`, mode=0)

| Button        | Routing                                                       | JS function         |
| ------------- | ------------------------------------------------------------- | ------------------- |
| Add Folder    | → `[opendialog fold]` → `[prepend addFolder]` → js            | `addFolder(path)`   |
| Remove        | → `[i]` (stored folder index) → `[prepend removeFolder]` → js | `removeFolder(idx)` |
| Scan          | → `[message scanFolders]` → js                                | `scanFolders()`     |
| Refresh       | → `[message refreshTracks]` → js                              | `refreshTracks()`   |
| Add Track     | → `[message addTrack]` → js                                   | `addTrack()`        |
| Create clips  | → `[message generate]` → js                                   | `generate()`        |
| Row variation | → `[message rowVariation]` → js                               | `rowVariation()`    |

### Toggles (`[live.text]`)

| Toggle  | Routing                           | JS function            |
| ------- | --------------------------------- | ---------------------- |
| Solo    | → `[prepend soloTrack]` → js      | `soloTrack(0\|1)`      |
| Silence | → `[prepend setSkipSilence]` → js | `setSkipSilence(0\|1)` |
| Loop    | → `[prepend setLoopClips]` → js   | `setLoopClips(0\|1)`   |
| Key     | → `[prepend setSameKey]` → js     | `setSameKey(0\|1)`     |

### Menus

| Menu              | Routing                                  | JS function                  |
| ----------------- | ---------------------------------------- | ---------------------------- |
| Tracks umenu      | → `[prepend toggleTrack]` → js           | `toggleTrack(idx)`           |
| Duration umenu    | → `[prepend setDuration]` → js           | `setDuration(idx)`           |
| Suggestions umenu | → `[prepend setSelectedSuggestion]` → js | `setSelectedSuggestion(idx)` |

### Tabs (`[live.tab]`)

| Tab      | Options              | JS function            |
| -------- | -------------------- | ---------------------- |
| Segments | Single, Multiple     | `setSegmentMode(0\|1)` |
| View     | Session, Arrangement | `setViewMode(0\|1)`    |

## UDP / OSC Protocol

Both `[udpsend]` and `[udpreceive]` use OSC framing. The server wraps JSON in OSC messages with address `/resp` and a string argument. The receive chain strips the OSC address:

```
[udpreceive 9877] → [route /resp] → [prepend response] → [js]
```

The JS sends commands as two atoms (`/cmd <json>`) via outlet 0, which `[udpsend]` formats as OSC.

## UI Design Notes

- Use `[textbutton]` (not `[live.button]`) for action buttons — shows a fixed label instead of "Button On/Off"
- Use `[live.text]` for on/off toggles — supports `text`/`texton` labels and highlights when active
- Use `[live.tab]` for mutually exclusive options

## Development Workflow

- `generative-library.js` has `autowatch = 1` — Max auto-reloads on save
- `npm run dev` uses `tsx watch` for server auto-restart
- `npm run build:plugin` rebuilds the `.amxd` from `build_amxd.py`

## Troubleshooting

- **"Connecting to server..."**: Make sure `npm run dev` is running
- **No tracks**: Ensure AbletonJS Remote Script is installed and selected in Settings → Link/Tempo/MIDI
- **UDP issues**: Verify ports 9876/9877 are free. Check firewall
