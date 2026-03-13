#!/usr/bin/env python3
"""
Build GenerativeLibrary.amxd — Max for Live device patcher.

Generates the complete .amxd binary file with all UI objects, 
infrastructure objects, and patch connections as described in 
BUILD_INSTRUCTIONS.md.

Usage:
    python3 scripts/build_amxd.py
"""

import json
import struct
import os

# ════════════════════════════════════════════════════════════
# Layout Constants
# ════════════════════════════════════════════════════════════

DEVICE_WIDTH = 550.0
DEVICE_HEIGHT = 195.0

# Patching view layout (for editing in Max)
# X regions: left=20, mid=200, right=400
# Y regions: top=20, infrastructure=200-400, routing=400-600

# Presentation layout (what user sees in Ableton)
# Organized in rows

# ════════════════════════════════════════════════════════════
# Helpers
# ════════════════════════════════════════════════════════════

_next_id = 1


def new_id():
    global _next_id
    oid = f"obj-{_next_id}"
    _next_id += 1
    return oid


def box(obj_id, maxclass, numinlets=1, numoutlets=1, outlettype=None,
        patching_rect=None, presentation=False, presentation_rect=None,
        text=None, **kwargs):
    """Create a patcher box definition."""
    b = {
        "id": obj_id,
        "maxclass": maxclass,
        "numinlets": numinlets,
        "numoutlets": numoutlets,
    }
    if outlettype is not None:
        b["outlettype"] = outlettype
    if text is not None:
        b["text"] = text
    if patching_rect:
        b["patching_rect"] = patching_rect
    if presentation:
        b["presentation"] = 1
    if presentation_rect:
        b["presentation_rect"] = presentation_rect
    b.update(kwargs)
    return {"box": b}


def line(src_id, src_outlet, dst_id, dst_inlet):
    """Create a patch line (connection)."""
    return {
        "patchline": {
            "source": [src_id, src_outlet],
            "destination": [dst_id, dst_inlet]
        }
    }


# ════════════════════════════════════════════════════════════
# Object Definitions
# ════════════════════════════════════════════════════════════

boxes = []
lines = []

# ──────────────────────────────────────────────────────────
# MIDI passthrough (standard M4L MIDI effect requirement)
# ──────────────────────────────────────────────────────────

midiin_id = new_id()
boxes.append(box(midiin_id, "newobj",
    text="midiin",
    numinlets=1, numoutlets=1,
    outlettype=["int"],
    patching_rect=[700.0, 34.0, 40.0, 20.0],
    fontname="Arial Bold", fontsize=10.0))

midiout_id = new_id()
boxes.append(box(midiout_id, "newobj",
    text="midiout",
    numinlets=1, numoutlets=0,
    outlettype=[],
    patching_rect=[700.0, 114.0, 47.0, 20.0],
    fontname="Arial Bold", fontsize=10.0))

lines.append(line(midiin_id, 0, midiout_id, 0))

# ──────────────────────────────────────────────────────────
# Core Infrastructure
# ──────────────────────────────────────────────────────────

# JS engine (the brain)
js_id = new_id()
boxes.append(box(js_id, "newobj",
    text="js generative-library.js @autowatch 1",
    numinlets=1, numoutlets=7,
    outlettype=["", "", "", "", "", "", ""],
    patching_rect=[200.0, 300.0, 250.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

# UDP send (commands TO server)
udpsend_id = new_id()
boxes.append(box(udpsend_id, "newobj",
    text="udpsend 127.0.0.1 9876",
    numinlets=1, numoutlets=0,
    outlettype=[],
    patching_rect=[200.0, 380.0, 140.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

# UDP receive (responses FROM server)
udprecv_id = new_id()
boxes.append(box(udprecv_id, "newobj",
    text="udpreceive 9877",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[200.0, 200.0, 110.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

# UDP receive → [route /resp] → [prepend response] chain
# [udpreceive] outputs OSC: /resp <json_string>
# [route /resp] strips address, passes through the string argument
route_resp_id = new_id()
boxes.append(box(route_resp_id, "newobj",
    text="route /resp",
    numinlets=1, numoutlets=2,
    outlettype=["", ""],
    patching_rect=[200.0, 230.0, 70.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

# Prepend "response" to route to js response() function
prepend_resp_id = new_id()
boxes.append(box(prepend_resp_id, "newobj",
    text="prepend response",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[200.0, 260.0, 105.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

# Open dialog (folder chooser)
opendialog_id = new_id()
boxes.append(box(opendialog_id, "newobj",
    text="opendialog fold",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[20.0, 200.0, 90.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

# Infrastructure wiring
lines.append(line(udprecv_id, 0, route_resp_id, 0))       # udpreceive → route /resp
lines.append(line(route_resp_id, 0, prepend_resp_id, 0))   # route /resp → prepend response
lines.append(line(prepend_resp_id, 0, js_id, 0))           # prepend response → js inlet
lines.append(line(js_id, 0, udpsend_id, 0))                # js outlet 0 → udpsend

# ──────────────────────────────────────────────────────────
# Presentation UI — Status & File Count (Row 0, y=2)
# ──────────────────────────────────────────────────────────

status_id = new_id()
boxes.append(box(status_id, "message",
    text="Initializing...",
    numinlets=2, numoutlets=1,
    outlettype=[""],
    patching_rect=[500.0, 300.0, 200.0, 22.0],
    presentation=True,
    presentation_rect=[5.0, 3.0, 300.0, 18.0],
    annotation="Connection status — shows whether the server and Ableton are connected"))

# [prepend set] converts JS text into "set <text>" so the message box updates its display
prepend_set_status_id = new_id()
boxes.append(box(prepend_set_status_id, "newobj",
    text="prepend set",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[500.0, 280.0, 65.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

lines.append(line(js_id, 1, prepend_set_status_id, 0))      # js outlet 1 → prepend set
lines.append(line(prepend_set_status_id, 0, status_id, 0))   # prepend set → status display

# ──────────────────────────────────────────────────────────
# File Count Display (Row 0 right side, y=2)
# ──────────────────────────────────────────────────────────

filecount_id = new_id()
boxes.append(box(filecount_id, "message",
    text="0 files / 0 folders",
    numinlets=2, numoutlets=1,
    outlettype=[""],
    patching_rect=[500.0, 340.0, 200.0, 22.0],
    presentation=True,
    presentation_rect=[310.0, 3.0, 235.0, 18.0],
    annotation="Number of indexed audio files and watched folders"))

# [prepend set] for file count display update
prepend_set_fc_id = new_id()
boxes.append(box(prepend_set_fc_id, "newobj",
    text="prepend set",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[500.0, 320.0, 65.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

lines.append(line(js_id, 3, prepend_set_fc_id, 0))      # js outlet 3 → prepend set
lines.append(line(prepend_set_fc_id, 0, filecount_id, 0))  # prepend set → file count

# ──────────────────────────────────────────────────────────
# Folder Section (Row 1-2, y=22-42)
# ──────────────────────────────────────────────────────────

folder_label_id = new_id()
boxes.append(box(folder_label_id, "comment",
    text="Folders:",
    numinlets=1, numoutlets=0,
    outlettype=[],
    patching_rect=[20.0, 60.0, 50.0, 20.0],
    presentation=True,
    presentation_rect=[5.0, 24.0, 50.0, 18.0],
    fontname="Arial Bold", fontsize=10.0))

folderlist_id = new_id()
boxes.append(box(folderlist_id, "umenu",
    numinlets=1, numoutlets=3,
    outlettype=["int", "", ""],
    patching_rect=[20.0, 80.0, 250.0, 22.0],
    presentation=True,
    presentation_rect=[55.0, 23.0, 260.0, 20.0],
    parameter_enable=0,
    items="<empty>",
    annotation="Watched folders — select a folder to remove it, or add a new one"))

lines.append(line(js_id, 4, folderlist_id, 0))  # js outlet 4 → folder umenu

# Add Folder button
addfolder_id = new_id()
boxes.append(box(addfolder_id, "textbutton",
    text="Add Folder",
    numinlets=1, numoutlets=3,
    outlettype=["", "", "int"],
    patching_rect=[20.0, 110.0, 70.0, 22.0],
    presentation=True,
    presentation_rect=[320.0, 23.0, 65.0, 20.0],
    mode=0,
    rounded=4.0,
    bgcolor=[0.35, 0.35, 0.35, 1.0],
    textcolor=[1.0, 1.0, 1.0, 1.0],
    annotation="Add a folder containing Ableton projects to scan for audio files"))

# Remove Folder button
removefolder_id = new_id()
boxes.append(box(removefolder_id, "textbutton",
    text="Remove",
    numinlets=1, numoutlets=3,
    outlettype=["", "", "int"],
    patching_rect=[100.0, 110.0, 60.0, 22.0],
    presentation=True,
    presentation_rect=[390.0, 23.0, 55.0, 20.0],
    mode=0,
    rounded=4.0,
    bgcolor=[0.35, 0.35, 0.35, 1.0],
    textcolor=[1.0, 1.0, 1.0, 1.0],
    annotation="Remove the currently selected folder from the watch list"))

# Scan button
scan_id = new_id()
boxes.append(box(scan_id, "textbutton",
    text="Scan",
    numinlets=1, numoutlets=3,
    outlettype=["", "", "int"],
    patching_rect=[170.0, 110.0, 50.0, 22.0],
    presentation=True,
    presentation_rect=[450.0, 23.0, 45.0, 20.0],
    mode=0,
    rounded=4.0,
    bgcolor=[0.35, 0.35, 0.35, 1.0],
    textcolor=[1.0, 1.0, 1.0, 1.0],
    annotation="Scan all folders for audio files — only scans inside Ableton project folders (with .als files)"))

# Routing: Add Folder → opendialog → prepend addFolder → js
prepend_add_id = new_id()
boxes.append(box(prepend_add_id, "newobj",
    text="prepend addFolder",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[20.0, 240.0, 110.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

lines.append(line(addfolder_id, 0, opendialog_id, 0))    # Add btn → opendialog
lines.append(line(opendialog_id, 0, prepend_add_id, 0))   # opendialog → prepend addFolder
lines.append(line(prepend_add_id, 0, js_id, 0))           # prepend addFolder → js

# Routing: Remove Folder → int (stored index) → prepend removeFolder → js
folder_int_id = new_id()
boxes.append(box(folder_int_id, "newobj",
    text="i",
    numinlets=2, numoutlets=1,
    outlettype=["int"],
    patching_rect=[100.0, 160.0, 25.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

prepend_remove_id = new_id()
boxes.append(box(prepend_remove_id, "newobj",
    text="prepend removeFolder",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[100.0, 200.0, 125.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

lines.append(line(folderlist_id, 0, folder_int_id, 1))     # umenu int → i right inlet (store)
lines.append(line(removefolder_id, 0, folder_int_id, 0))   # Remove btn → i left inlet (output)
lines.append(line(folder_int_id, 0, prepend_remove_id, 0)) # i → prepend removeFolder
lines.append(line(prepend_remove_id, 0, js_id, 0))         # prepend removeFolder → js

# Routing: Scan → message scanFolders → js
msg_scan_id = new_id()
boxes.append(box(msg_scan_id, "message",
    text="scanFolders",
    numinlets=2, numoutlets=1,
    outlettype=[""],
    patching_rect=[170.0, 160.0, 78.0, 22.0]))

lines.append(line(scan_id, 0, msg_scan_id, 0))   # Scan btn → message scanFolders
lines.append(line(msg_scan_id, 0, js_id, 0))      # message scanFolders → js

# ──────────────────────────────────────────────────────────
# Track Section (Row 3-4, y=48-68)
# ──────────────────────────────────────────────────────────

track_label_id = new_id()
boxes.append(box(track_label_id, "comment",
    text="Tracks:",
    numinlets=1, numoutlets=0,
    outlettype=[],
    patching_rect=[300.0, 60.0, 50.0, 20.0],
    presentation=True,
    presentation_rect=[5.0, 50.0, 50.0, 18.0],
    fontname="Arial Bold", fontsize=10.0))

tracklist_id = new_id()
boxes.append(box(tracklist_id, "umenu",
    numinlets=1, numoutlets=3,
    outlettype=["int", "", ""],
    patching_rect=[300.0, 80.0, 200.0, 22.0],
    presentation=True,
    presentation_rect=[55.0, 49.0, 260.0, 20.0],
    parameter_enable=0,
    items="<empty>",
    annotation="Ableton tracks — click to toggle enable/disable for generation. [x]=enabled, [ ]=disabled"))

lines.append(line(js_id, 2, tracklist_id, 0))  # js outlet 2 → track umenu

# Refresh Tracks button
refresh_id = new_id()
boxes.append(box(refresh_id, "textbutton",
    text="Refresh",
    numinlets=1, numoutlets=3,
    outlettype=["", "", "int"],
    patching_rect=[300.0, 110.0, 60.0, 22.0],
    presentation=True,
    presentation_rect=[320.0, 49.0, 55.0, 20.0],
    mode=0,
    rounded=4.0,
    bgcolor=[0.35, 0.35, 0.35, 1.0],
    textcolor=[1.0, 1.0, 1.0, 1.0],
    annotation="Refresh tracks from Ableton and update track suggestions"))

msg_refresh_id = new_id()
boxes.append(box(msg_refresh_id, "message",
    text="refreshTracks",
    numinlets=2, numoutlets=1,
    outlettype=[""],
    patching_rect=[300.0, 160.0, 88.0, 22.0]))

lines.append(line(refresh_id, 0, msg_refresh_id, 0))  # Refresh btn → message
lines.append(line(msg_refresh_id, 0, js_id, 0))        # message → js

# Track toggle: clicking a track in umenu toggles its enabled state
prepend_toggle_id = new_id()
boxes.append(box(prepend_toggle_id, "newobj",
    text="prepend toggleTrack",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[300.0, 130.0, 110.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

lines.append(line(tracklist_id, 0, prepend_toggle_id, 0))  # umenu selection → prepend
lines.append(line(prepend_toggle_id, 0, js_id, 0))         # prepend → js

# ──────────────────────────────────────────────────────────
# Generation Controls (Row 5, y=75)
# ──────────────────────────────────────────────────────────

# Duration label
dur_label_id = new_id()
boxes.append(box(dur_label_id, "comment",
    text="Duration:",
    numinlets=1, numoutlets=0,
    outlettype=[],
    patching_rect=[20.0, 400.0, 55.0, 20.0],
    presentation=True,
    presentation_rect=[5.0, 77.0, 55.0, 18.0],
    fontname="Arial Bold", fontsize=10.0))

# Duration umenu
dur_menu_id = new_id()
boxes.append(box(dur_menu_id, "umenu",
    numinlets=1, numoutlets=3,
    outlettype=["int", "", ""],
    patching_rect=[20.0, 420.0, 100.0, 22.0],
    presentation=True,
    presentation_rect=[60.0, 76.0, 85.0, 20.0],
    parameter_enable=0,
    items="8 beats, 16 beats, 32 beats, 64 beats, 128 beats, 256 beats, 512 beats, 1024 beats, 1 min, 5 min, 10 min, 30 min",
    annotation="How long the generated composition should be — choose minutes or beats"))

# Routing: Duration umenu → prepend setDuration → js
prepend_dur_id = new_id()
boxes.append(box(prepend_dur_id, "newobj",
    text="prepend setDuration",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[20.0, 460.0, 115.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

lines.append(line(js_id, 5, dur_menu_id, 0))           # js outlet 5 → duration umenu (auto-populate)
lines.append(line(dur_menu_id, 0, prepend_dur_id, 0))   # umenu int → prepend
lines.append(line(prepend_dur_id, 0, js_id, 0))          # prepend → js

# Segment label
seg_label_id = new_id()
boxes.append(box(seg_label_id, "comment",
    text="Segments:",
    numinlets=1, numoutlets=0,
    outlettype=[],
    patching_rect=[140.0, 400.0, 60.0, 20.0],
    presentation=True,
    presentation_rect=[155.0, 77.0, 60.0, 18.0],
    fontname="Arial Bold", fontsize=10.0))

# Segment tab (Single / Multiple)
seg_tab_id = new_id()
boxes.append({
    "box": {
        "id": seg_tab_id,
        "maxclass": "live.tab",
        "numinlets": 1,
        "numoutlets": 3,
        "outlettype": ["", "", "float"],
        "parameter_enable": 1,
        "num_lines_patching": 1,
        "num_lines_presentation": 1,
        "patching_rect": [140.0, 420.0, 120.0, 20.0],
        "presentation": 1,
        "presentation_rect": [215.0, 76.0, 120.0, 20.0],
        "annotation": "Single: one long clip per track. Multiple: several shorter random segments per track",
        "saved_attribute_attributes": {
            "valueof": {
                "parameter_enum": ["Single", "Multiple"],
                "parameter_longname": "Segments",
                "parameter_mmax": 1.0,
                "parameter_modmode": 0,
                "parameter_shortname": "Segments",
                "parameter_type": 2,
                "parameter_unitstyle": 0
            }
        }
    }
})

# Routing: Segment tab → prepend setSegmentMode → js
prepend_seg_id = new_id()
boxes.append(box(prepend_seg_id, "newobj",
    text="prepend setSegmentMode",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[140.0, 460.0, 135.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

lines.append(line(seg_tab_id, 0, prepend_seg_id, 0))  # tab → prepend
lines.append(line(prepend_seg_id, 0, js_id, 0))        # prepend → js

# View label
view_label_id = new_id()
boxes.append(box(view_label_id, "comment",
    text="View:",
    numinlets=1, numoutlets=0,
    outlettype=[],
    patching_rect=[280.0, 400.0, 35.0, 20.0],
    presentation=True,
    presentation_rect=[345.0, 77.0, 35.0, 18.0],
    fontname="Arial Bold", fontsize=10.0))

# View tab (Session / Arrangement)
view_tab_id = new_id()
boxes.append({
    "box": {
        "id": view_tab_id,
        "maxclass": "live.tab",
        "numinlets": 1,
        "numoutlets": 3,
        "outlettype": ["", "", "float"],
        "parameter_enable": 1,
        "num_lines_patching": 1,
        "num_lines_presentation": 1,
        "patching_rect": [280.0, 420.0, 140.0, 20.0],
        "presentation": 1,
        "presentation_rect": [380.0, 76.0, 160.0, 20.0],
        "annotation": "Session: create clips in session view slots. Arrangement: place clips on the timeline",
        "saved_attribute_attributes": {
            "valueof": {
                "parameter_enum": ["Session", "Arrangement"],
                "parameter_longname": "View",
                "parameter_mmax": 1.0,
                "parameter_modmode": 0,
                "parameter_shortname": "View",
                "parameter_type": 2,
                "parameter_unitstyle": 0
            }
        }
    }
})

# Routing: View tab → prepend setViewMode → js
prepend_view_id = new_id()
boxes.append(box(prepend_view_id, "newobj",
    text="prepend setViewMode",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[280.0, 460.0, 120.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

lines.append(line(view_tab_id, 0, prepend_view_id, 0))  # tab → prepend
lines.append(line(prepend_view_id, 0, js_id, 0))         # prepend → js

# ──────────────────────────────────────────────────────────
# Add Track Section (Row 6, y=100)
# ──────────────────────────────────────────────────────────

addtrack_label_id = new_id()
boxes.append(box(addtrack_label_id, "comment",
    text="Add Track:",
    numinlets=1, numoutlets=0,
    outlettype=[],
    patching_rect=[20.0, 480.0, 65.0, 20.0],
    presentation=True,
    presentation_rect=[5.0, 102.0, 65.0, 18.0],
    fontname="Arial Bold", fontsize=10.0))

tracksuggestions_id = new_id()
boxes.append(box(tracksuggestions_id, "umenu",
    numinlets=1, numoutlets=3,
    outlettype=["int", "", ""],
    patching_rect=[20.0, 490.0, 200.0, 22.0],
    presentation=True,
    presentation_rect=[70.0, 101.0, 260.0, 20.0],
    parameter_enable=0,
    items="<no suggestions>",
    annotation="Track suggestions — shows rules with matching audio files not yet in your session. Select one and click Add Track"))

lines.append(line(js_id, 6, tracksuggestions_id, 0))  # js outlet 6 → suggestions umenu

# Routing: suggestions umenu selection → prepend setSelectedSuggestion → js
prepend_setsugg_id = new_id()
boxes.append(box(prepend_setsugg_id, "newobj",
    text="prepend setSelectedSuggestion",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[20.0, 520.0, 170.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

lines.append(line(tracksuggestions_id, 0, prepend_setsugg_id, 0))  # umenu → prepend
lines.append(line(prepend_setsugg_id, 0, js_id, 0))                # prepend → js

# Add Track button
addtrack_btn_id = new_id()
boxes.append(box(addtrack_btn_id, "textbutton",
    text="Add Track",
    numinlets=1, numoutlets=3,
    outlettype=["", "", "int"],
    patching_rect=[230.0, 490.0, 70.0, 22.0],
    presentation=True,
    presentation_rect=[335.0, 101.0, 65.0, 20.0],
    mode=0,
    rounded=4.0,
    bgcolor=[0.35, 0.35, 0.35, 1.0],
    textcolor=[1.0, 1.0, 1.0, 1.0],
    annotation="Create a new audio track in Ableton named after the selected suggestion"))

# Routing: Add Track btn → message addTrack → js
msg_addtrack_id = new_id()
boxes.append(box(msg_addtrack_id, "message",
    text="addTrack",
    numinlets=2, numoutlets=1,
    outlettype=[""],
    patching_rect=[230.0, 520.0, 58.0, 22.0]))

lines.append(line(addtrack_btn_id, 0, msg_addtrack_id, 0))  # btn → message
lines.append(line(msg_addtrack_id, 0, js_id, 0))             # message → js

# Skip Silence toggle button (on Add Track row, right side)
silence_toggle_id = new_id()
boxes.append({
    "box": {
        "id": silence_toggle_id,
        "maxclass": "live.text",
        "numinlets": 1,
        "numoutlets": 2,
        "outlettype": ["", ""],
        "parameter_enable": 1,
        "patching_rect": [320.0, 490.0, 100.0, 20.0],
        "presentation": 1,
        "presentation_rect": [402.0, 101.0, 48.0, 20.0],
        "text": "Silence",
        "texton": "Silence",
        "annotation": "When enabled, clips start from non-silent regions of audio files. Requires a scan first.",
        "saved_attribute_attributes": {
            "valueof": {
                "parameter_longname": "SkipSilence",
                "parameter_mmax": 1.0,
                "parameter_initial_enable": 1,
                "parameter_initial": [1],
                "parameter_shortname": "SkipSilence",
                "parameter_type": 2,
                "parameter_unitstyle": 0,
                "parameter_enum": ["Off", "On"]
            }
        }
    }
})

# Routing: Silence toggle → prepend setSkipSilence → js
prepend_silence_id = new_id()
boxes.append(box(prepend_silence_id, "newobj",
    text="prepend setSkipSilence",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[320.0, 520.0, 135.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

lines.append(line(silence_toggle_id, 0, prepend_silence_id, 0))  # toggle → prepend
lines.append(line(prepend_silence_id, 0, js_id, 0))               # prepend → js

# Loop toggle button (next to Skip Silence)
loop_toggle_id = new_id()
boxes.append({
    "box": {
        "id": loop_toggle_id,
        "maxclass": "live.text",
        "numinlets": 1,
        "numoutlets": 2,
        "outlettype": ["", ""],
        "parameter_enable": 1,
        "patching_rect": [440.0, 490.0, 60.0, 20.0],
        "presentation": 1,
        "presentation_rect": [452.0, 101.0, 42.0, 20.0],
        "text": "Loop",
        "texton": "Loop",
        "annotation": "When enabled, newly created clips will have looping turned on",
        "saved_attribute_attributes": {
            "valueof": {
                "parameter_longname": "LoopClips",
                "parameter_mmax": 1.0,
                "parameter_initial_enable": 1,
                "parameter_initial": [0],
                "parameter_shortname": "LoopClips",
                "parameter_type": 2,
                "parameter_unitstyle": 0,
                "parameter_enum": ["Off", "On"]
            }
        }
    }
})

# Routing: Loop toggle → prepend setLoopClips → js
prepend_loop_id = new_id()
boxes.append(box(prepend_loop_id, "newobj",
    text="prepend setLoopClips",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[440.0, 520.0, 120.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

lines.append(line(loop_toggle_id, 0, prepend_loop_id, 0))  # toggle → prepend
lines.append(line(prepend_loop_id, 0, js_id, 0))             # prepend → js

# Same Key toggle button (next to Loop)
samekey_toggle_id = new_id()
boxes.append({
    "box": {
        "id": samekey_toggle_id,
        "maxclass": "live.text",
        "numinlets": 1,
        "numoutlets": 2,
        "outlettype": ["", ""],
        "parameter_enable": 1,
        "patching_rect": [520.0, 490.0, 60.0, 20.0],
        "presentation": 1,
        "presentation_rect": [496.0, 101.0, 49.0, 20.0],
        "text": "Key",
        "texton": "Key",
        "annotation": "When enabled, files are filtered to harmonically compatible keys using the Camelot wheel. Requires a scan first.",
        "saved_attribute_attributes": {
            "valueof": {
                "parameter_longname": "SameKey",
                "parameter_mmax": 1.0,
                "parameter_initial_enable": 1,
                "parameter_initial": [0],
                "parameter_shortname": "SameKey",
                "parameter_type": 2,
                "parameter_unitstyle": 0,
                "parameter_enum": ["Off", "On"]
            }
        }
    }
})

# Routing: Same Key toggle → prepend setSameKey → js
prepend_samekey_id = new_id()
boxes.append(box(prepend_samekey_id, "newobj",
    text="prepend setSameKey",
    numinlets=1, numoutlets=1,
    outlettype=[""],
    patching_rect=[520.0, 520.0, 110.0, 22.0],
    fontname="Arial Bold", fontsize=10.0))

lines.append(line(samekey_toggle_id, 0, prepend_samekey_id, 0))  # toggle → prepend
lines.append(line(prepend_samekey_id, 0, js_id, 0))               # prepend → js

# ──────────────────────────────────────────────────────────
# Generate Button + Server Controls (Row 7, y=125)
# ──────────────────────────────────────────────────────────

# Create clips button (large, green)
generate_id = new_id()
boxes.append(box(generate_id, "textbutton",
    text="Create clips",
    numinlets=1, numoutlets=3,
    outlettype=["", "", "int"],
    patching_rect=[20.0, 500.0, 200.0, 40.0],
    presentation=True,
    presentation_rect=[5.0, 128.0, 540.0, 30.0],
    mode=0,
    rounded=4.0,
    fontsize=14.0,
    bgcolor=[0.2, 0.553, 0.255, 1.0],
    bgovercolor=[0.259, 0.663, 0.306, 1.0],
    textcolor=[1.0, 1.0, 1.0, 1.0],
    textovercolor=[1.0, 1.0, 1.0, 1.0],
    annotation="Generate a random composition — places audio clips on enabled tracks using your configured duration and segment mode. Cmd+Z to undo"))

# Routing: Generate btn → message generate → js
msg_generate_id = new_id()
boxes.append(box(msg_generate_id, "message",
    text="generate",
    numinlets=2, numoutlets=1,
    outlettype=[""],
    patching_rect=[20.0, 550.0, 58.0, 22.0]))

lines.append(line(generate_id, 0, msg_generate_id, 0))  # btn → message
lines.append(line(msg_generate_id, 0, js_id, 0))         # message → js

# ──────────────────────────────────────────────────────────
# Device Vertical Limit (hidden marker for M4L height)
# ──────────────────────────────────────────────────────────

vlimit_id = new_id()
boxes.append(box(vlimit_id, "comment",
    text="Device vertical limit",
    numinlets=1, numoutlets=0,
    outlettype=[],
    patching_rect=[0.0, 650.0, 133.0, 20.0],
    presentation=True,
    presentation_rect=[0.0, DEVICE_HEIGHT, 133.0, 20.0],
    fontname="Ableton Sans Medium Regular",
    fontsize=11.0,
    hidden=1))

# ════════════════════════════════════════════════════════════
# Assemble Complete Patcher
# ════════════════════════════════════════════════════════════

patcher = {
    "patcher": {
        "fileversion": 1,
        "appversion": {
            "major": 8,
            "minor": 5,
            "revision": 5,
            "architecture": "x64",
            "modernui": 1
        },
        "classnamespace": "box",
        "rect": [100.0, 100.0, 900.0, 700.0],
        "openrect": [0.0, 0.0, DEVICE_WIDTH, DEVICE_HEIGHT],
        "bglocked": 0,
        "openinpresentation": 1,
        "default_fontsize": 10.0,
        "default_fontface": 0,
        "default_fontname": "Arial Bold",
        "gridonopen": 1,
        "gridsize": [8.0, 8.0],
        "gridsnaponopen": 1,
        "objectsnaponopen": 1,
        "statusbarvisible": 2,
        "toolbarvisible": 1,
        "lefttoolbarpinned": 0,
        "toptoolbarpinned": 0,
        "righttoolbarpinned": 0,
        "bottomtoolbarpinned": 0,
        "toolbars_unpinned_last_save": 0,
        "tallnewobj": 0,
        "boxanimatetime": 500,
        "enablehscroll": 1,
        "enablevscroll": 1,
        "devicewidth": DEVICE_WIDTH,
        "description": "Generative Library - creates random compositions from audio recordings",
        "digest": "",
        "tags": "",
        "style": "",
        "subpatcher_template": "",
        "assistshowspatchername": 0,
        "title": "Generative Library",
        "boxes": boxes,
        "lines": lines,
        "dependency_cache": [
            {
                "name": "generative-library.js",
                "bootpath": ".",
                "type": "TEXT",
                "implicit": 1
            }
        ],
        "latency": 0,
        "is_mpe": 0,
        "minimum_live_version": "",
        "minimum_max_version": "",
        "platform_compatibility": 0,
        "project": {
            "version": 1,
            "creationdate": 3590052786,
            "modificationdate": 3590052786,
            "viewrect": [0.0, 0.0, 300.0, 500.0],
            "autoorganize": 1,
            "hideprojectwindow": 1,
            "showdependencies": 1,
            "autolocalize": 0,
            "contents": {
                "patchers": {},
                "code": {
                    "generative-library.js": {
                        "kind": "code",
                        "local": 1
                    }
                }
            },
            "layout": {},
            "searchpath": {},
            "detailsvisible": 0,
            "amxdtype": 1835887981,
            "readonly": 0,
            "devpathtype": 0,
            "devpath": ".",
            "sortmode": 0,
            "viewmode": 0,
            "includepackages": 0
        },
        "autosave": 0,
        "saved_attribute_attributes": {
            "default_plcolor": {
                "expression": ""
            }
        }
    }
}

# ════════════════════════════════════════════════════════════
# Write .amxd Binary File
# ════════════════════════════════════════════════════════════

json_data = json.dumps(patcher, indent="\t").encode("utf-8")

# .amxd binary header (32 bytes):
#   'ampf' (4) + version uint32le (4) + 'mmmm' (4)
#   'meta' (4) + meta_len uint32le (4) + meta_data (4)
#   'ptch' (4) + patcher_len uint32le (4)
header = b'ampf'
header += struct.pack('<I', 4)          # format version
header += b'mmmm'
header += b'meta'
header += struct.pack('<I', 4)          # meta data length
header += b'\x00\x00\x00\x00'          # meta data (empty)
header += b'ptch'
header += struct.pack('<I', len(json_data))  # patcher JSON length

# Output path
script_dir = os.path.dirname(os.path.abspath(__file__))
project_root = os.path.dirname(script_dir)
output = os.path.join(project_root, "max-device", "GenerativeLibrary.amxd")

with open(output, 'wb') as f:
    f.write(header)
    f.write(json_data)

total = len(header) + len(json_data)
print(f"✓ Built {output}")
print(f"  Total: {total} bytes (header: {len(header)}, patcher JSON: {len(json_data)})")
print(f"  Objects: {len(boxes)}, Connections: {len(lines)}")
print()
print("  Layout:")
print(f"    Device size: {int(DEVICE_WIDTH)}×{int(DEVICE_HEIGHT)} px")
print(f"    Presentation objects: {sum(1 for b in boxes if b['box'].get('presentation'))}")
print(f"    Infrastructure objects: {sum(1 for b in boxes if not b['box'].get('presentation'))}")
