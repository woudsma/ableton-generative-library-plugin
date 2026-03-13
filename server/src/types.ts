// ─── Audio File Types ───

export interface AudioFile {
  id: number;
  folderId: number;
  path: string;
  filename: string;
  extension: string;
  durationSeconds: number;
  sampleRate: number;
  channels: number;
  fileSize: number;
  modifiedAt: string;
  keywords: string[]; // extracted track-type keywords
  scannedAt: string;
  activeStartSeconds: number | null; // start of non-silent region (null = not analyzed)
  activeEndSeconds: number | null; // end of non-silent region (null = not analyzed)
  detectedKey: string | null; // detected musical key (null = not analyzed)
}

export interface WatchedFolder {
  id: number;
  path: string;
  lastScanned: string | null;
  enabled: boolean;
  fileCount: number;
}

// ─── Track Types ───

export interface AbletonTrack {
  index: number;
  name: string;
  type: 'audio' | 'midi' | 'group' | 'return' | 'master';
  color: number;
  enabled: boolean; // whether this track is enabled for generation
}

export interface TrackRule {
  id: number;
  trackName: string;
  keywords: string[]; // keywords to match against audio file keywords
  regexPattern: string | null; // optional custom regex
}

// ─── Generation Types ───

export type DurationUnit = 'minutes' | 'beats';

export interface DurationOption {
  value: number;
  unit: DurationUnit;
  label: string;
}

export const DURATION_OPTIONS: DurationOption[] = [
  { value: 1, unit: 'minutes', label: '1 min' },
  { value: 5, unit: 'minutes', label: '5 min' },
  { value: 10, unit: 'minutes', label: '10 min' },
  { value: 30, unit: 'minutes', label: '30 min' },
  { value: 8, unit: 'beats', label: '8 beats' },
  { value: 16, unit: 'beats', label: '16 beats' },
  { value: 32, unit: 'beats', label: '32 beats' },
  { value: 64, unit: 'beats', label: '64 beats' },
  { value: 128, unit: 'beats', label: '128 beats' },
  { value: 256, unit: 'beats', label: '256 beats' },
  { value: 512, unit: 'beats', label: '512 beats' },
  { value: 1024, unit: 'beats', label: '1024 beats' },
];

export type SegmentMode = 'single' | 'multiple';
export type ViewMode = 'arrangement' | 'session';

export interface GenerationConfig {
  duration: DurationOption;
  segmentMode: SegmentMode;
  viewMode: ViewMode;
  enabledTrackIndices: number[];
  skipSilence?: boolean; // constrain start markers to non-silent regions (default: true)
  loopClips?: boolean; // enable looping on created clips (default: false)
  sameKey?: boolean; // filter files to harmonically compatible keys (default: false)
}

export interface ClipPlacement {
  trackIndex: number;
  trackName: string;
  filePath: string;
  filename: string;
  startMarkerBeats: number; // start position within the source file (beats)
  endMarkerBeats: number; // end position within the source file (beats)
  arrangementPosition: number; // position in the arrangement (beats)
  durationBeats: number; // length of this segment (beats)
}

export interface GenerationPlan {
  id: string;
  timestamp: string;
  config: GenerationConfig;
  tempo: number;
  clips: ClipPlacement[];
  totalDurationBeats: number;
}

// ─── UDP Message Protocol ───

export type ServerCommand =
  | { type: 'ping' }
  | { type: 'get_status' }
  | { type: 'add_folder'; path: string }
  | { type: 'remove_folder'; folderId: number }
  | { type: 'scan_folders'; folderIds?: number[] }
  | { type: 'get_folders' }
  | { type: 'get_file_groups' }
  | { type: 'get_tracks' }
  | { type: 'set_track_enabled'; trackIndex: number; enabled: boolean }
  | { type: 'get_track_rules' }
  | { type: 'set_track_rule'; trackName: string; keywords: string[]; regexPattern?: string }
  | { type: 'generate'; config: GenerationConfig }
  | { type: 'get_duration_options' }
  | { type: 'get_config' }
  | { type: 'get_track_suggestions' };

export type ServerResponse =
  | { type: 'pong' }
  | {
      type: 'status';
      connected: boolean;
      folderCount: number;
      fileCount: number;
      scanning: boolean;
    }
  | { type: 'folders'; folders: WatchedFolder[] }
  | { type: 'file_groups'; groups: Record<string, number> }
  | { type: 'tracks'; tracks: AbletonTrack[] }
  | { type: 'track_rules'; rules: TrackRule[] }
  | { type: 'duration_options'; options: DurationOption[] }
  | { type: 'config'; folders: WatchedFolder[]; rules: TrackRule[]; tracks: AbletonTrack[] }
  | { type: 'scan_progress'; folder: string; filesScanned: number; totalFiles: number }
  | { type: 'scan_complete'; folder: string; newFiles: number; totalFiles: number }
  | { type: 'generation_plan'; plan: GenerationPlan }
  | { type: 'generation_progress'; current: number; total: number; trackName: string }
  | { type: 'generation_complete'; clipsCreated: number }
  | { type: 'track_suggestions'; suggestions: TrackSuggestion[] }
  | { type: 'error'; message: string; command?: string }
  | { type: 'ok'; message?: string };

export interface TrackSuggestion {
  trackName: string;
  fileCount: number;
  keywords: string[];
}

// ─── Constants ───

export const DEFAULT_KEYWORDS = [
  // Kicks
  'KICK',
  'KICK2',
  'KICKS',
  'KD',
  'BD1',
  'BD2',
  'BD3',
  // Hats
  'HIHAT',
  'HAT',
  'CH',
  'OH',
  'CLOSEDHAT',
  'OPENHAT',
  'HC',
  // Snare / Clap / Rim
  'SNARE',
  'CLAP',
  'SD',
  'SD1',
  'RS',
  'JOMOXRIM',
  // Percussion / Toms
  'PERCUSSION',
  'PERC',
  'HT',
  'MT',
  'LT',
  'CYMBAL',
  'RIDE',
  'CC',
  // Drums / Machines
  'DRUM',
  'DRUMS',
  'DIGITAKT',
  'JOMOX',
  'TR8S',
  'TR-6S',
  'ALPHABASE',
  'MBRANE',
  // Synth
  'SYNTH',
  'SYNTHS',
  'LEAD',
  'PAD',
  'MINILOGUE',
  'SERUM',
  'SURGE',
  'ACIDSURGE',
  'WAVETABLE',
  'ARPREZZOR',
  'VOCREZZOR',
  'RAVEGEN',
  'RAVE',
  'TRANCE',
  // Bass
  'BASS',
  'BASSLINE',
  'SYNTHBASS',
  'SUB',
  // Modular / Experimental
  'MODULAR',
  'MODU',
  'MODU2',
  'M-RESO',
  'MRESO',
  'T-RESO',
  'TRESO',
  'T-ROZZER',
  'ROZZER',
  // FX / Noise
  'FX',
  'EFFECT',
  'NOISE',
  'NOISEFX',
  'NOISEREC',
  'AMBIENT',
  'RISE',
  'HIGHDRONE',
  // Vocal
  'VOCAL',
  'VOX',
  'VOX2',
  'VOICE',
  'VOXCUT',
  'ADLIBSS',
  // Samplers / Recorders
  'AKAI',
  'OCTA',
  'NS2',
  'NS4',
  'SAMPLERS',
  'SAMPLERS2',
  'ABL3REC',
  'RC',
  // Organ / Keys
  'GUITAR',
  'KEYS',
  'PIANO',
  'ORGAN',
  'ORG',
  'ORGLOW',
  'STRINGS',
  // Mix / Master / Sends
  'MIX',
  'MASTR',
  'IRONSIDE',
  'LEXICON',
  'LEXICON1',
  'LEXICON2',
  'LIFTLOOP',
  'POD',
  // Grooves / Loops
  'GRV',
  'SAMPLE',
  'LOOP',
  'ONE_SHOT',
  // Misc identifiers
  'S1',
  'S3',
] as const;

export const SUPPORTED_EXTENSIONS = ['.wav', '.aiff', '.aif', '.flac', '.mp3', '.ogg'] as const;

export const UDP_PORT_SERVER = 9876; // Node.js listens on this
export const UDP_PORT_MAX = 9877; // Max for Live listens on this
