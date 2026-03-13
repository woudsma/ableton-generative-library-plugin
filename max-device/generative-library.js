/*
 * Generative Library — Max for Live JavaScript
 *
 * This script runs inside the Max js object. It communicates with the Node.js
 * server over UDP (via Max [udpsend]/[udpreceive] objects) and exposes functions
 * that Max UI elements (buttons, menus, etc.) call.
 *
 * The Node.js server handles all heavy logic including clip creation via
 * ableton-js using Live 12's Track.create_audio_clip() API.
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 * PATCHER WIRING GUIDE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * JS OUTLETS → Max objects:
 *   outlet 0 → [udpsend 127.0.0.1 9876]        — commands to Node.js server
 *   outlet 1 → [set $1] → [live.text status]    — status text display
 *   outlet 2 → [umenu tracks]                   — track list population
 *   outlet 3 → [set $1] → [live.text filecount] — file count display
 *   outlet 4 → [umenu folders]                  — folder list population
 *   outlet 5 → [umenu duration]                 — duration menu population
 *   outlet 6 → [umenu tracksuggestions]          — track suggestions population
 *
 * UDP RECEIVE → JS inlet:
 *   [udpreceive 9877]
 *     → [zl group 65536]      (group bytes into one list)
 *     → [itoa]                (convert byte ints to ASCII string)
 *     → [fromsymbol]          (ensure it's a symbol)
 *     → [prepend response]    (prefix with function name)
 *     → [js generative-library.js]
 *
 *   NOTE: If [itoa]/[fromsymbol] are missing, the JS will also handle
 *   raw integer byte lists — but the above chain is recommended.
 *
 * BUTTONS → JS functions (use [textbutton], NOT [live.button]):
 *   "Add Folder" [textbutton]  → [t b] → [opendialog fold] → [prepend addFolder] → [js]
 *   "Remove"     [textbutton]  → [t b] → [umenu folders] gets selected idx
 *                                       → [prepend removeFolder] → [js]
 *   "Scan"       [textbutton]  → [prepend scanFolders] → [js]
 *   "Refresh"    [textbutton]  → [prepend refreshTracks] → [js]
 *   "Create clips" [textbutton] → [prepend generate] → [js]
 *   "Add Track"  [textbutton]  → [prepend addTrack] → [js]
 *
 *   IMPORTANT: Use [textbutton] (not [live.button]) for action buttons,
 *   so they show a fixed label instead of "Button On/Off".
 *
 * MENUS → JS functions:
 *   [umenu duration]   → [prepend setDuration] → [js]
 *   [live.tab segments] → [prepend setSegmentMode] → [js]
 *   [live.tab view]     → [prepend setViewMode] → [js]
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// Enable hot reloading during development
autowatch = 1;

// The number of outlets from this js object
outlets = 7;

// ─── State ───

var serverConnected = false;
var abletonConnected = false;
var scanning = false;
var folders = [];
var tracks = [];
var trackEnabled = {}; // trackIndex -> boolean
var lastSelectedTrackIndex = 0; // last track index clicked in umenu
var soloActive = false; // whether solo mode is currently engaged
var preSoloEnabled = {}; // saved trackEnabled state before solo
var fileGroups = {};
var fileCount = 0;
var folderCount = 0;
var trackSuggestions = [];
var selectedSuggestionIndex = 0;

// Configuration
var SERVER_PORT = 9876;
var CLIENT_PORT = 9877;
var PING_INTERVAL = 5000;
var PING_TIMEOUT = 2; // mark disconnected after this many missed pings
var pingTask = null;
var missedPings = 0;

// Duration options
var DURATION_OPTIONS = [
  { value: 8, unit: 'beats', label: '8 beats' },
  { value: 16, unit: 'beats', label: '16 beats' },
  { value: 32, unit: 'beats', label: '32 beats' },
  { value: 64, unit: 'beats', label: '64 beats' },
  { value: 128, unit: 'beats', label: '128 beats' },
  { value: 256, unit: 'beats', label: '256 beats' },
  { value: 512, unit: 'beats', label: '512 beats' },
  { value: 1024, unit: 'beats', label: '1024 beats' },
  { value: 1, unit: 'minutes', label: '1 min' },
  { value: 5, unit: 'minutes', label: '5 min' },
  { value: 10, unit: 'minutes', label: '10 min' },
  { value: 30, unit: 'minutes', label: '30 min' }
];

var selectedDurationIndex = 4; // default: 128 beats
var segmentMode = 'multiple'; // 'single' or 'multiple'
var viewMode = 'session'; // 'session' or 'arrangement'
var skipSilence = true; // skip silent regions in audio files
var loopClips = false; // enable looping on created clips
var sameKey = false; // filter files to harmonically compatible keys

// Chunked message reassembly
var chunkedMessages = {};

// ─── Initialization ───

function loadbang() {
  post('Generative Library: initializing...\n');

  // Small delay to let Max finish loading, then populate menus and start pinging
  var initTask = new Task(function () {
    populateDurationMenu();
    updateStatus('Connecting to server...');
    updateFileCount(0, 0);
    startPing();
  }, this);
  initTask.schedule(1000);
}

/**
 * Called when the JS file is reloaded via autowatch.
 * Re-initialize menus and restart pinging (loadbang doesn't fire on reload).
 */
function bang() {
  post('Generative Library: JS reloaded (autowatch), re-initializing...\n');
  populateDurationMenu();
  startPing();
}

/**
 * Populate the duration umenu (outlet 6) with individual items.
 */
function populateDurationMenu() {
  outlet(5, 'clear');
  for (var i = 0; i < DURATION_OPTIONS.length; i++) {
    outlet(5, 'append', DURATION_OPTIONS[i].label);
  }
  // Select the default
  outlet(5, 'set', selectedDurationIndex);
}

// ─── Ping / Health Check ───

function startPing() {
  if (pingTask) {
    pingTask.cancel();
  }
  pingTask = new Task(doPing, this);
  pingTask.interval = PING_INTERVAL;
  pingTask.repeat();
}

function doPing() {
  try {
    missedPings++;
    if (missedPings > PING_TIMEOUT && serverConnected) {
      serverConnected = false;
      abletonConnected = false;
      updateStatus('Server disconnected');
    }
    sendCommand({ type: 'ping' });
  } catch (e) {
    post('Generative Library: Ping error: ' + e + '\n');
  }
}

function stopPing() {
  if (pingTask) {
    pingTask.cancel();
    pingTask = null;
  }
}

// ─── UDP Communication ───

/**
 * Send a JSON command to the Node.js server via outlet 0.
 * Outlet 0 connects to [udpsend 127.0.0.1 9876].
 *
 * [udpsend] is an OSC object — sending two atoms makes it create
 * an OSC message with address '/cmd' and string argument (the JSON).
 */
function sendCommand(cmd) {
  var json = JSON.stringify(cmd);
  outlet(0, '/cmd', json);
}

/**
 * Receive a JSON response from the Node.js server.
 *
 * The server sends OSC messages with address /resp and a string argument.
 * [udpreceive] outputs: /resp <json_string>
 * [route /resp] strips the address, leaving: <json_string>
 * [prepend response] adds: response <json_string>
 * Then JS receives: response("<json_string>")
 */
function response() {
  var args = arrayfromargs(arguments);
  var jsonStr;

  if (args.length === 0) return;

  if (args.length === 1 && typeof args[0] === 'string') {
    // Case 1: Already a string (went through [itoa] → [fromsymbol])
    jsonStr = args[0];
  } else if (typeof args[0] === 'number') {
    // Case 2: Raw bytes from [udpreceive] (integer list)
    jsonStr = '';
    for (var i = 0; i < args.length; i++) {
      jsonStr += String.fromCharCode(args[i]);
    }
  } else if (typeof args[0] === 'string' && args.length > 1) {
    // Case 3: String was split on spaces by Max — rejoin
    jsonStr = args.join(' ');
  } else {
    post('Generative Library: Unexpected response format\n');
    return;
  }

  parseAndHandle(jsonStr);
}

/**
 * Also handle messages that come in without "response" prefix.
 * When [udpreceive] → [zl group] → [js] inlet directly (no [prepend]).
 */
function list() {
  var args = arrayfromargs(arguments);
  if (args.length === 0) return;

  // Convert byte list to string
  var jsonStr = '';
  for (var i = 0; i < args.length; i++) {
    jsonStr += String.fromCharCode(args[i]);
  }

  parseAndHandle(jsonStr);
}

/**
 * Parse JSON string and route to handler.
 */
function parseAndHandle(jsonStr) {
  var data;
  try {
    data = JSON.parse(jsonStr);
  } catch (e) {
    // Only log if it looks like it was supposed to be JSON
    if (jsonStr.indexOf('{') >= 0) {
      post('Generative Library: Invalid JSON: ' + jsonStr.substr(0, 120) + '\n');
    }
    return;
  }

  if (data._chunked) {
    handleChunkedMessage(data);
    return;
  }

  handleResponse(data);
}

function handleChunkedMessage(chunk) {
  var msgId = chunk._messageId;
  if (!chunkedMessages[msgId]) {
    chunkedMessages[msgId] = {
      chunks: [],
      total: chunk._totalChunks,
    };
  }
  chunkedMessages[msgId].chunks[chunk._chunkIndex] = chunk._data;

  // Check if all chunks received
  var msg = chunkedMessages[msgId];
  var received = 0;
  for (var i = 0; i < msg.total; i++) {
    if (msg.chunks[i] !== undefined) received++;
  }

  if (received === msg.total) {
    var fullJson = msg.chunks.join('');
    delete chunkedMessages[msgId];
    parseAndHandle(fullJson);
  }
}

function handleResponse(data) {
  switch (data.type) {
    case 'pong':
      missedPings = 0;
      if (!serverConnected) {
        serverConnected = true;
        post('Generative Library: Server connected!\n');
        // On first connect, request full config
        sendCommand({ type: 'get_status' });
        sendCommand({ type: 'get_config' });
        sendCommand({ type: 'get_track_suggestions' });
      }
      updateStatus(abletonConnected ? 'Connected' : 'Server OK (Ableton not connected)');
      break;

    case 'status':
      serverConnected = true;
      abletonConnected = data.connected;
      scanning = data.scanning;
      folderCount = data.folderCount;
      fileCount = data.fileCount;
      updateStatus(
        abletonConnected ? 'Connected (' + fileCount + ' files)' : 'Ableton not connected'
      );
      updateFileCount(fileCount, folderCount);
      break;

    case 'config':
      folders = data.folders || [];
      tracks = data.tracks || [];
      updateFolderList();
      updateTrackList();
      updateFileCount(fileCount, folders.length);
      break;

    case 'folders':
      folders = data.folders || [];
      updateFolderList();
      updateFileCount(fileCount, folders.length);
      break;

    case 'tracks':
      tracks = data.tracks || [];
      updateTrackList();
      break;

    case 'file_groups':
      fileGroups = data.groups || {};
      updateFileGroups();
      break;

    case 'track_rules':
      break;

    case 'track_suggestions':
      trackSuggestions = data.suggestions || [];
      updateTrackSuggestions();
      break;

    case 'scan_progress':
      scanning = true;
      updateStatus('Scanning: ' + data.filesScanned + '/' + data.totalFiles);
      break;

    case 'scan_complete':
      scanning = false;
      updateStatus('Scan complete: ' + data.newFiles + ' new files');
      sendCommand({ type: 'get_status' });
      sendCommand({ type: 'get_file_groups' });
      break;

    case 'generation_plan':
      // Plan created but not yet executed — informational only
      updateStatus('Plan: ' + data.plan.clips.length + ' clips');
      break;

    case 'generation_progress':
      updateStatus('Creating clip ' + data.current + '/' + data.total + '...');
      break;

    case 'generation_complete':
      updateStatus('Done! Created ' + data.clipsCreated + ' clips');
      break;

    case 'variation_complete':
      updateStatus('Variation done! ' + data.clipsCreated + ' clips in scene ' + (data.newSceneIndex + 1));
      break;

    case 'error':
      post('Generative Library ERROR: ' + data.message + '\n');
      updateStatus('Error: ' + data.message);
      break;

    case 'ok':
      if (data.message) {
        updateStatus(data.message);
      }
      break;

    default:
      post('Generative Library: Unknown response type: ' + data.type + '\n');
  }
}

// ─── UI Actions (called from Max UI elements) ───

/**
 * Add a folder. Called when user selects a folder via:
 *   [textbutton "Add Folder"] → [t b] → [opendialog fold] → [prepend addFolder] → [js]
 */
function addFolder() {
  var rawPath = arrayfromargs(arguments).join(' ');
  if (!rawPath || rawPath.length === 0) return;

  // Max's [opendialog] returns colon-separated paths (e.g. "Macintosh HD:/Users/foo"
  // or "Vault 733 2:/Projects"). Convert to POSIX paths for Node.js.
  var fullPath = maxPathToPosix(rawPath);

  post('Generative Library: Adding folder: ' + fullPath + '\n');
  sendCommand({ type: 'add_folder', path: fullPath });
}

/**
 * Convert Max's colon-separated path to a POSIX path.
 *
 * Max path format:
 *   "Macintosh HD:/Users/user/Music"  → "/Users/user/Music"
 *   "Vault 733 2:/Projects"            → "/Volumes/Vault 733 2/Projects"
 *   "Vault 733 2:/"                    → "/Volumes/Vault 733 2/"
 *
 * The boot volume ("Macintosh HD") maps to "/" while external
 * volumes map to "/Volumes/<name>/".
 */
function maxPathToPosix(maxPath) {
  // If it's already a POSIX path (starts with /), return as-is
  if (maxPath.charAt(0) === '/') return maxPath;

  var colonIdx = maxPath.indexOf(':');
  if (colonIdx < 0) return maxPath; // no colon found, return as-is

  var volumeName = maxPath.substring(0, colonIdx);
  var rest = maxPath.substring(colonIdx + 1);

  // Ensure rest starts with /
  if (rest.charAt(0) !== '/') {
    rest = '/' + rest;
  }

  // Boot volume: "Macintosh HD" → root "/"
  if (volumeName === 'Macintosh HD') {
    return rest;
  }

  // External volume: "VolumeName" → "/Volumes/VolumeName"
  return '/Volumes/' + volumeName + rest;
}

/**
 * Remove the currently selected folder in the folder umenu.
 */
function removeFolder(index) {
  if (index === undefined) index = 0;
  if (index < 0 || index >= folders.length) {
    updateStatus('Select a folder to remove');
    return;
  }
  var folder = folders[index];
  sendCommand({ type: 'remove_folder', folderId: folder.id });
}

/**
 * Trigger a scan of all folders.
 */
function scanFolders() {
  if (!serverConnected) {
    updateStatus('Server not connected');
    return;
  }
  sendCommand({ type: 'scan_folders' });
  updateStatus('Starting scan...');
}

/**
 * Refresh tracks from Ableton.
 */
function refreshTracks() {
  if (!serverConnected) {
    updateStatus('Server not connected');
    return;
  }
  sendCommand({ type: 'get_tracks' });
  sendCommand({ type: 'get_track_suggestions' });
  updateStatus('Refreshing tracks...');
}

/**
 * Set a track's enabled state. Called from track checkboxes.
 */
function setTrackEnabled(trackIndex, enabled) {
  trackEnabled[trackIndex] = enabled === 1;
}

/**
 * Toggle a track's enabled state when clicked in the umenu.
 * When solo is active, only update the selection — don't toggle state.
 * Wire: [umenu tracks] → [prepend toggleTrack] → [js]
 */
function toggleTrack(index) {
  if (index < 0 || index >= tracks.length) return;
  lastSelectedTrackIndex = index;
  if (soloActive) {
    // In solo mode, don't modify trackEnabled — just update the selection display
    return;
  }
  trackEnabled[index] = !trackEnabled[index];
  updateTrackList();
}

/**
 * Solo/unsolo toggle for the currently selected track.
 * When engaged: saves current state, disables all tracks except the selected one.
 * When disengaged: restores the previous state.
 * Wire: [live.text "Solo"] → [prepend soloTrack] → [js]
 */
function soloTrack(state) {
  if (state === 1) {
    // Engaging solo
    if (lastSelectedTrackIndex < 0 || lastSelectedTrackIndex >= tracks.length) {
      updateStatus('Select a track first');
      return;
    }

    var soloedTrack = tracks[lastSelectedTrackIndex];
    if (soloedTrack.type !== 'audio') {
      updateStatus('Cannot solo non-audio track');
      return;
    }

    // Save current enabled state
    preSoloEnabled = {};
    for (var i = 0; i < tracks.length; i++) {
      preSoloEnabled[i] = trackEnabled[i] !== false;
    }

    // Disable all tracks, then enable only the selected one
    for (var i = 0; i < tracks.length; i++) {
      trackEnabled[i] = false;
    }
    trackEnabled[lastSelectedTrackIndex] = true;
    soloActive = true;
    updateTrackList();
    updateStatus('Solo: ' + soloedTrack.name);
  } else {
    // Disengaging solo — restore previous state
    if (soloActive) {
      for (var i = 0; i < tracks.length; i++) {
        if (preSoloEnabled[i] !== undefined) {
          trackEnabled[i] = preSoloEnabled[i];
        }
      }
      soloActive = false;
      preSoloEnabled = {};
      updateTrackList();
      updateStatus('Solo off');
    }
  }
}

/**
 * Set the duration option. Called from duration umenu.
 */
function setDuration(menuIndex) {
  selectedDurationIndex = menuIndex;
}

/**
 * Set segment mode. 0 = Single, 1 = Multiple
 */
function setSegmentMode(mode) {
  segmentMode = mode === 0 ? 'single' : 'multiple';
}

/**
 * Set view mode. 0 = Session, 1 = Arrangement
 */
function setViewMode(mode) {
  viewMode = mode === 0 ? 'session' : 'arrangement';
}

/**
 * Set skip silence mode. 1 = On (skip silence), 0 = Off (use full file)
 */
function setSkipSilence(mode) {
  skipSilence = mode === 1;
}

/**
 * Set loop clips mode. 1 = On (loop clips), 0 = Off
 */
function setLoopClips(mode) {
  loopClips = mode === 1;
}

/**
 * Set same key mode. 1 = On (filter by compatible keys), 0 = Off
 */
function setSameKey(mode) {
  sameKey = mode === 1;
}

/**
 * Set the selected suggestion index from the track suggestions umenu.
 */
function setSelectedSuggestion(menuIndex) {
  selectedSuggestionIndex = menuIndex;
}

/**
 * Request track suggestions from the server.
 */
function requestTrackSuggestions() {
  if (!serverConnected) {
    updateStatus('Server not connected');
    return;
  }
  sendCommand({ type: 'get_track_suggestions' });
}

/**
 * Add a new audio track in Ableton with the selected suggestion name.
 * Called from: [textbutton "Add Track"] → [prepend addTrack] → [js]
 */
function addTrack() {
  if (trackSuggestions.length === 0) {
    updateStatus('No track suggestions available');
    return;
  }
  if (selectedSuggestionIndex < 0 || selectedSuggestionIndex >= trackSuggestions.length) {
    updateStatus('Select a track to add');
    return;
  }

  var suggestion = trackSuggestions[selectedSuggestionIndex];
  var trackName = suggestion.trackName;

  post('Generative Library: Adding track "' + trackName + '"...\n');
  updateStatus('Adding track "' + trackName + '"...');

  // Use a Task so LiveAPI calls happen in the main thread
  var addTrackTask = new Task(function () {
    // Save current track focus (best-effort, won't block track creation if it fails)
    var currentTrackIdNum = 0;
    try {
      var viewApi = new LiveAPI('live_set view');
      if (viewApi && viewApi.id != 0) {
        var ref = viewApi.get('selected_track');
        var refStr = String(ref);
        var match = refStr.match(/(\d+)/);
        if (match) {
          currentTrackIdNum = parseInt(match[match.length - 1], 10);
        }
      }
    } catch (e1) {
      post('WARNING: Could not save track focus: ' + e1.message + '\n');
    }

    try {
      var songApi = new LiveAPI('live_set');
      if (!songApi || songApi.id == 0) {
        post('ERROR: Could not get LiveAPI handle to live_set\n');
        updateStatus('Error: Cannot access Live');
        return;
      }

      // Create a new audio track at the end (index = current track count)
      var trackCount = songApi.getcount('tracks');
      songApi.call('create_audio_track', trackCount);

      // Set the name of the newly created track
      var newTrackApi = new LiveAPI('live_set tracks ' + trackCount);
      if (newTrackApi && newTrackApi.id != 0) {
        newTrackApi.set('name', trackName);
        post('Generative Library: Created track "' + trackName + '" at index ' + trackCount + '\n');
        updateStatus('Created track "' + trackName + '"');
      }

      // Restore focus to the original track after a short delay
      if (currentTrackIdNum > 0) {
        var savedId = currentTrackIdNum;
        var restoreTask = new Task(function () {
          try {
            var view = new LiveAPI('live_set view');
            view.set('selected_track', 'id', savedId);
          } catch (e2) {
            post('WARNING: Could not restore track focus: ' + e2.message + '\n');
          }
        });
        restoreTask.schedule(150);
      }

      // Refresh tracks and suggestions
      sendCommand({ type: 'get_tracks' });
      sendCommand({ type: 'get_track_suggestions' });
    } catch (e) {
      post('ERROR adding track: ' + e.message + '\n');
      updateStatus('Error: ' + e.message);
    }
  }, this);
  addTrackTask.schedule(50);
}

/**
 * GENERATE! The main button.
 */
function generate() {
  if (!serverConnected) {
    updateStatus('Error: Server not connected');
    return;
  }

  // Build list of enabled track indices (skip non-audio / UTIL tracks)
  var enabledIndices = [];
  for (var i = 0; i < tracks.length; i++) {
    if (trackEnabled[i] !== false && tracks[i].type === 'audio') {
      enabledIndices.push(i);
    }
  }

  if (enabledIndices.length === 0) {
    updateStatus('Error: No audio tracks enabled');
    return;
  }

  var duration = DURATION_OPTIONS[selectedDurationIndex];
  if (!duration) {
    duration = DURATION_OPTIONS[4];
  }

  var config = {
    duration: duration,
    segmentMode: segmentMode,
    viewMode: viewMode,
    enabledTrackIndices: enabledIndices,
    skipSilence: skipSilence,
    loopClips: loopClips,
    sameKey: sameKey
  };

  post('Generative Library: Generating with config: ' + JSON.stringify(config) + '\n');
  updateStatus('Generating...');
  sendCommand({ type: 'generate', config: config });
}

/**
 * ROW VARIATION — create a variation of the selected scene.
 * Reads clips from the currently selected scene, then creates new clips
 * on a new scene with different random starting positions.
 */
function rowVariation() {
  if (!serverConnected) {
    updateStatus('Error: Server not connected');
    return;
  }

  // Get currently selected scene index from Ableton
  var sceneTask = new Task(function () {
    try {
      var songApi = new LiveAPI('live_set');
      if (!songApi || songApi.id == 0) {
        updateStatus('Error: Cannot access Live');
        return;
      }

      // Get the selected scene via the Song's view
      var viewApi = new LiveAPI('live_set view');
      var selectedScene = viewApi.get('selected_scene');

      // selectedScene returns "id <number>" — resolve it to get the scene index
      var sceneApi = new LiveAPI('id ' + selectedScene[1]);
      var scenePath = sceneApi.unquotedpath;

      // Parse scene index from path: "live_set scenes N"
      var parts = scenePath.split(' ');
      var sceneIndex = parseInt(parts[parts.length - 1], 10);

      if (isNaN(sceneIndex) || sceneIndex < 0) {
        updateStatus('Error: Could not determine selected scene');
        return;
      }

      post('Generative Library: Creating row variation from scene ' + (sceneIndex + 1) + '\n');
      updateStatus('Creating variation of scene ' + (sceneIndex + 1) + '...');
      sendCommand({
        type: 'row_variation',
        sceneIndex: sceneIndex,
        skipSilence: skipSilence,
        loopClips: loopClips,
        sameKey: sameKey
      });
    } catch (e) {
      post('ERROR in rowVariation: ' + e.message + '\n');
      updateStatus('Error: ' + e.message);
    }
  }, this);
  sceneTask.schedule(50);
}

// ─── UI Updates (send data to Max UI elements via outlets) ───

function updateStatus(text) {
  outlet(1, text);
}

function updateTrackList() {
  outlet(2, 'clear');
  for (var i = 0; i < tracks.length; i++) {
    var t = tracks[i];
    // Auto-disable non-audio tracks
    if (t.type !== 'audio' && trackEnabled[i] === undefined) {
      trackEnabled[i] = false;
    }
    if (trackEnabled[i] === undefined) {
      trackEnabled[i] = true;
    }
    var enabled = trackEnabled[i] !== false ? '[x]' : '[ ]';
    var typeTag = t.type === 'group' ? ' (group)' : t.type !== 'audio' ? ' (midi)' : '';
    outlet(2, 'append', enabled + ' ' + t.name + typeTag);
  }
}

function updateFileCount(count, folderCt) {
  outlet(3, count + ' files / ' + folderCt + ' folders');
}

function updateFolderList() {
  outlet(4, 'clear');
  for (var i = 0; i < folders.length; i++) {
    var f = folders[i];
    var status = f.fileCount + ' files';
    if (f.lastScanned) {
      status += ' (scanned)';
    }
    outlet(4, 'append', f.path + ' [' + status + ']');
  }
}

function updateFileGroups() {
  var text = '';
  for (var key in fileGroups) {
    if (fileGroups[key] > 0 && key !== '_UNMATCHED') {
      text += key + ': ' + fileGroups[key] + '  ';
    }
  }
  if (text.length > 0) {
    post('Generative Library: File groups — ' + text + '\n');
  }
}

function updateTrackSuggestions() {
  outlet(6, 'clear');
  for (var i = 0; i < trackSuggestions.length; i++) {
    var s = trackSuggestions[i];
    outlet(6, 'append', s.trackName + ' (' + s.fileCount + ' samples)');
  }
  if (trackSuggestions.length > 0) {
    outlet(6, 'set', 0);
    selectedSuggestionIndex = 0;
  }
}

// ─── Cleanup ───

function showLogs() {
  // Open the Max console window
  messnamed('max', 'showconsole');
}

function notifydeleted() {
  post('Generative Library: Device removed, cleaning up...\n');
  stopPing();
}
