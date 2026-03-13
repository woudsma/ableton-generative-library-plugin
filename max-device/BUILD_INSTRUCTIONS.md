# Max for Live Device — Build Instructions

This document describes how to create the Max for Live device patcher (`.amxd` file) that provides the in-Ableton UI for the Generative Library plugin.

## Overview

The M4L device is a thin UI layer. All heavy logic runs in the Node.js server.
Communication flows:

```
Max UI → [js generative-library.js] → outlet 0 → [udpsend] → OSC /cmd → Node.js server (port 9876)
                                     ← inlet    ← [prepend response] ← [route /resp] ← [udpreceive 9877] ← OSC /resp
```

## Steps to Create the Device

### 1. Open Ableton Live → Create a MIDI Track → Add "Max Audio Effect" (or "Max MIDI Effect")

### 2. Open the Max for Live Editor (click the wrench icon)

### 3. Build the following patcher layout:

```
┌─────────────────────────────────────────────────────────────────────┐
│  [message: status]                    [message: file_count]         │
│                                                                     │
│  Folders: [umenu: folder_list]                                      │
│  [textbutton: Add Folder]  [textbutton: Remove]  [textbutton: Scan] │
│                                                                     │
│  Tracks: [umenu: track_list]  [textbutton: Refresh Tracks]          │
│  (click tracks to toggle enable/disable)                            │
│                                                                     │
│  Duration: [umenu: duration_menu]  (auto-populated by JS outlet 5)  │
│  Segments: [live.tab: Single | Multiple]                            │
│  View:     [live.tab: Session | Arrangement]                        │
│                                                                     │
│  Add Track: [umenu: track_suggestions]  [textbutton: Add Track]     │
│  (shows rule names + sample counts; creates audio track in Live)    │
│                                                                     │
│  ████████████████████████████████████████████████                    │
│  ██   [textbutton: GENERATE]                                 ██                │
│  ████████████████████████████████████████████████                    │
└─────────────────────────────────────────────────────────────────────┘
```

**IMPORTANT**: Use `[textbutton]` for all action buttons, NOT `[live.button]`.
`[live.button]` is a toggle that shows "Button On"/"Button Off", which is not
what we want. `[textbutton]` shows a fixed label and sends a bang on click.

### 4. Core Max Objects

#### JavaScript Engine

```
[js generative-library.js @autowatch 1]
```

- Inlets: 1 (receives response messages and UI commands)
- Outlets: **7** (see outlet mapping below)

#### UDP Communication

```
[udpsend 127.0.0.1 9876]    ← connected to js outlet 0

[udpreceive 9877]
  │
  ↓
[route /resp]                (strip OSC address, pass through the JSON string arg)
  │
  ↓
[prepend response]           (prefix with "response" so JS routes to the right function)
  │
  ↓
[js generative-library.js]
```

**Why this chain?** Both `[udpsend]` and `[udpreceive]` are OSC objects. The Node.js
server wraps all JSON responses in OSC messages with address `/resp` and a string
argument. `[udpreceive]` outputs `/resp {"type":"pong"}` and `[route /resp]` strips
the address, leaving just the JSON string. Similarly, the JS sends commands as
`/cmd <json>` which `[udpsend]` formats as a proper OSC packet.

#### Shell (for launching Node.js server)

> **Removed.** The server is now started manually from the terminal with `npm run dev`.

#### Folder Dialog

```
[opendialog fold]            → sends selected folder path to js "addFolder" method
```

### 5. Complete Outlet Wiring

The JS object has **7 outlets** (outlet indices 0–6):

```
js outlet 0 → [udpsend 127.0.0.1 9876]                    — JSON commands to server
js outlet 1 → [set $1] → [live.text @parameter_enable 0]  — status text
js outlet 2 → [umenu]                                      — track list
js outlet 3 → [set $1] → [live.text @parameter_enable 0]  — file/folder count
js outlet 4 → [umenu]                                      — folder list
js outlet 5 → [umenu]                                      — duration menu (auto-populated)
js outlet 6 → [umenu]                                      — track suggestions (auto-populated)
```

### 6. Button / Menu Wiring

#### Add Folder Button

```
[textbutton @text "Add Folder"]
  │ (click → bang)
  ↓
[t b]
  │
  ↓
[opendialog fold]
  │ (outputs selected folder path)
  ↓
[prepend addFolder]
  │
  ↓
[js generative-library.js]  (inlet 0)
```

#### Remove Folder Button

```
[umenu folders]  (outlet 4 populates this)
  │ (get current selection index: $1)
  ↓
[i]  (stores the selected index)

[textbutton @text "Remove"]
  │ (click → bang)
  ↓
[i]  (outputs stored index)
  │
  ↓
[prepend removeFolder]
  │
  ↓
[js generative-library.js]
```

#### Scan Button

```
[textbutton @text "Scan"]
  │
  ↓
[prepend scanFolders]
  │
  ↓
[js generative-library.js]
```

#### Refresh Tracks Button

```
[textbutton @text "Refresh"]
  │
  ↓
[prepend refreshTracks]
  │
  ↓
[js generative-library.js]
```

#### Track Toggle

```
[umenu tracks]  (outlet 2 populates this)
  │ (selection index)
  ↓
[prepend toggleTrack]
  │
  ↓
[js generative-library.js]
```

#### Duration Menu

```
[umenu duration]  (outlet 5 populates this automatically on load)
  │ (selection index)
  ↓
[prepend setDuration]
  │
  ↓
[js generative-library.js]
```

The JS auto-populates this menu on startup via outlet 5, so you don't need to
manually add items to the `[umenu]`.

#### Segment Mode

```
[live.tab @num_buttons 2 @_parameter_shortname "Segments"]
  (labels: "Single", "Multiple")
  │
  ↓
[prepend setSegmentMode]
  │
  ↓
[js generative-library.js]
```

#### View Mode

```
[live.tab @num_buttons 2 @_parameter_shortname "View"]
  (labels: "Session", "Arrangement")
  │
  ↓
[prepend setViewMode]
  │
  ↓
[js generative-library.js]
```

#### Track Suggestions Menu

```
[umenu track_suggestions]  (outlet 6 populates this automatically)
  │ (selection index)
  ↓
[prepend setSelectedSuggestion]
  │
  ↓
[js generative-library.js]
```

The JS auto-populates this menu with track rule names and their matching sample
counts. Tracks that already exist in the Ableton session are excluded.

#### Add Track Button

```
[textbutton @text "Add Track"]
  │
  ↓
[message addTrack]
  │
  ↓
[js generative-library.js]
```

Creates a new audio track in Ableton named after the selected suggestion.
Uses `LiveAPI.call('create_audio_track')` then sets the track name.

#### GENERATE Button

```
[textbutton @text "GENERATE" @fontsize 16 @bgcolor 0.2 0.8 0.3 1.0]
  │
  ↓
[prepend generate]
  │
  ↓
[js generative-library.js]
```

All the `[js generative-library.js]` references above point to the **same single js object**
in the patcher. Connect all those `[prepend ...]` objects to its inlet.

### 7. Save as .amxd

1. In the Max editor: File → Save As...
2. Save as `GenerativeLibrary.amxd` in the `max-device/` folder
3. Make sure `generative-library.js` is in the same folder (Max will find it via the M4L search path)

### 8. Using the Device

1. Start the Node.js server in a terminal: `npm run dev`
2. Load `GenerativeLibrary.amxd` onto any track in Ableton
3. Wait for "Connected" status in the device
4. Add folders containing your recordings
5. Click Scan to index audio files
6. Click Refresh to see your Ableton tracks
7. Select duration, segment mode, and view mode
8. Click GENERATE!

## Development Workflow

The `generative-library.js` file has `autowatch = 1` enabled. When you edit and save
the JS file, Max will automatically reload it. No need to close/reopen the device.

For the Node.js server, `npm run dev` uses `tsx watch` for auto-restart on code changes.

## Troubleshooting

- **Status stuck on "Connecting to server..."**: Make sure the Node.js server is running (`npm run dev`). Check that the UDP wiring chain is correct: `[udpreceive 9877] → [route /resp] → [prepend response] → [js]`
- **"Button On" showing on buttons**: Replace `[live.button]` with `[textbutton]`. Set the button text via `@text "Label"`.
- **Duration dropdown shows one long item**: Make sure outlet 5 of the JS is connected to the duration `[umenu]`. The JS populates it automatically. Don't manually set items.
- **Server not connecting**: Make sure the server is running in a terminal: `npm run dev`
- **UDP not working**: Verify ports 9876/9877 are not in use. Check firewall settings.
- **No tracks showing**: Make sure Ableton Live 12 has the AbletonJS MIDI Remote Script installed and active.
  - Copy: `cp -r node_modules/ableton-js/midi-script/* "$HOME/Music/Ableton/User Library/Remote Scripts/AbletonJS/"`
  - In Ableton: Settings → Link/Tempo/MIDI → Control Surface → select "AbletonJS"
