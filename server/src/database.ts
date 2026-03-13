import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import type { AudioFile, WatchedFolder, TrackRule, TrackSuggestion } from './types.js';
import { DEFAULT_KEYWORDS } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB_PATH = path.resolve(__dirname, '..', 'data', 'library.db');

export class DatabaseService {
  private db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
  }

  // ─── Schema ───

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS folders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        last_scanned TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS audio_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        folder_id INTEGER NOT NULL,
        path TEXT NOT NULL UNIQUE,
        filename TEXT NOT NULL,
        extension TEXT NOT NULL,
        duration_seconds REAL NOT NULL DEFAULT 0,
        sample_rate INTEGER NOT NULL DEFAULT 0,
        channels INTEGER NOT NULL DEFAULT 0,
        file_size INTEGER NOT NULL DEFAULT 0,
        modified_at TEXT NOT NULL,
        keywords TEXT NOT NULL DEFAULT '[]',
        active_start_seconds REAL,
        active_end_seconds REAL,
        scanned_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS track_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        track_name TEXT NOT NULL UNIQUE,
        keywords TEXT NOT NULL DEFAULT '[]',
        regex_pattern TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS generation_history (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL DEFAULT (datetime('now')),
        config TEXT NOT NULL,
        plan TEXT NOT NULL,
        tempo REAL NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audio_files_folder ON audio_files(folder_id);
      CREATE INDEX IF NOT EXISTS idx_audio_files_keywords ON audio_files(keywords);
      CREATE INDEX IF NOT EXISTS idx_audio_files_extension ON audio_files(extension);
      CREATE INDEX IF NOT EXISTS idx_audio_files_path ON audio_files(path);
    `);

    // Migration: add active region columns if they don't exist (for existing databases)
    this.migrateActiveRegionColumns();
    this.migrateDetectedKeyColumn();

    this.seedDefaultTrackRules();
  }

  private migrateActiveRegionColumns(): void {
    // Check if columns already exist by checking table info
    const columns = this.db.pragma('table_info(audio_files)') as { name: string }[];
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has('active_start_seconds')) {
      this.db.exec('ALTER TABLE audio_files ADD COLUMN active_start_seconds REAL');
    }
    if (!columnNames.has('active_end_seconds')) {
      this.db.exec('ALTER TABLE audio_files ADD COLUMN active_end_seconds REAL');
    }
  }

  private migrateDetectedKeyColumn(): void {
    const columns = this.db.pragma('table_info(audio_files)') as { name: string }[];
    const columnNames = new Set(columns.map((c) => c.name));
    if (!columnNames.has('detected_key')) {
      this.db.exec('ALTER TABLE audio_files ADD COLUMN detected_key TEXT');
    }
  }

  private seedDefaultTrackRules(): void {
    const existingCount = this.db.prepare('SELECT COUNT(*) as count FROM track_rules').get() as {
      count: number;
    };
    if (existingCount.count > 0) return;

    const defaultRules: { trackName: string; keywords: string[] }[] = [
      // ── Drum hits ──
      { trackName: 'KICK', keywords: ['KICK', 'KICK2', 'KICKS', 'KD', 'BD1', 'BD2', 'BD3'] },
      {
        trackName: 'HIHAT',
        keywords: ['HIHAT', 'HAT', 'HH', 'HI-HAT', 'CH', 'OH', 'CLOSEDHAT', 'OPENHAT', 'HC'],
      },
      { trackName: 'SNARE', keywords: ['SNARE', 'SNR', 'SD', 'SD1'] },
      { trackName: 'CLAP', keywords: ['CLAP', 'CP'] },
      {
        trackName: 'PERCUSSION',
        keywords: [
          'PERCUSSION',
          'PERC',
          'HT',
          'MT',
          'LT',
          'CYMBAL',
          'RIDE',
          'CC',
          'RS',
          'JOMOXRIM',
          'SHAKER',
          'TAMBOURINE',
        ],
      },
      // ── Drum machines / full kits ──
      { trackName: 'DRUMS', keywords: ['DRUM', 'DRUMS', 'GRV'] },
      { trackName: 'DIGITAKT', keywords: ['DIGITAKT', 'DT', 'ELEKTRON'] },
      { trackName: 'JOMOX', keywords: ['JOMOX', 'MBRANE', 'ALPHABASE'] },
      { trackName: 'TR8S', keywords: ['TR8S', 'TR-6S'] },
      // ── Bass ──
      { trackName: 'BASS', keywords: ['BASS', 'BASSLINE', 'SYNTHBASS', 'SUB'] },
      // ── Synths ──
      {
        trackName: 'SYNTH',
        keywords: [
          'SYNTH',
          'SYNTHS',
          'LEAD',
          'SERUM',
          'SURGE',
          'ACIDSURGE',
          'WAVETABLE',
          'MINILOGUE',
          'ARPREZZOR',
          'VOCREZZOR',
        ],
      },
      { trackName: 'PAD', keywords: ['PAD', 'AMBIENT', 'ATMOSPHERE', 'DRONE', 'HIGHDRONE'] },
      { trackName: 'RAVE', keywords: ['RAVE', 'RAVEGEN', 'TRANCE'] },
      // ── Modular / Experimental ──
      {
        trackName: 'MODULAR',
        keywords: [
          'MODULAR',
          'MODU',
          'MODU2',
          'M-RESO',
          'MRESO',
          'T-RESO',
          'TRESO',
          'T-ROZZER',
          'ROZZER',
        ],
      },
      // ── FX / Noise ──
      {
        trackName: 'FX',
        keywords: [
          'FX',
          'EFFECT',
          'NOISE',
          'NOISEFX',
          'NOISEREC',
          'RISER',
          'RISE',
          'IMPACT',
          'SFX',
        ],
      },
      // ── Vocal ──
      {
        trackName: 'VOCAL',
        keywords: ['VOCAL', 'VOX', 'VOX2', 'VOICE', 'VOXCUT', 'ADLIBSS', 'SINGING'],
      },
      // ── Samplers / Hardware recorders ──
      {
        trackName: 'SAMPLERS',
        keywords: ['SAMPLERS', 'SAMPLERS2', 'AKAI', 'OCTA', 'NS2', 'NS4', 'ABL3REC', 'RC', 'POD'],
      },
      // ── Keys / Organ ──
      {
        trackName: 'KEYS',
        keywords: ['KEYS', 'PIANO', 'ORGAN', 'ORG', 'ORGLOW', 'RHODES', 'ELECTRIC PIANO'],
      },
      { trackName: 'GUITAR', keywords: ['GUITAR', 'GTR', 'ACOUSTIC'] },
      { trackName: 'STRINGS', keywords: ['STRINGS', 'VIOLIN', 'CELLO', 'ORCHESTRAL'] },
      // ── Mix / Master / Sends ──
      { trackName: 'MIX', keywords: ['MIX', 'MASTR'] },
      { trackName: 'SENDS', keywords: ['LEXICON', 'LEXICON1', 'LEXICON2', 'IRONSIDE'] },
      // ── Loops / Misc ──
      { trackName: 'LOOPS', keywords: ['LIFTLOOP', 'LOOP', 'S1', 'S3'] },
    ];

    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO track_rules (track_name, keywords) VALUES (?, ?)',
    );

    const insertMany = this.db.transaction(() => {
      for (const rule of defaultRules) {
        insert.run(rule.trackName, JSON.stringify(rule.keywords));
      }
    });
    insertMany();
  }

  // ─── Folders ───

  addFolder(folderPath: string): WatchedFolder {
    const stmt = this.db.prepare(
      'INSERT INTO folders (path) VALUES (?) ON CONFLICT(path) DO UPDATE SET enabled = 1',
    );
    stmt.run(folderPath);
    return this.getFolderByPath(folderPath)!;
  }

  removeFolder(folderId: number): void {
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
  }

  getFolder(folderId: number): WatchedFolder | null {
    const row = this.db
      .prepare(
        `
      SELECT f.*, COUNT(af.id) as file_count
      FROM folders f
      LEFT JOIN audio_files af ON af.folder_id = f.id
      WHERE f.id = ?
      GROUP BY f.id
    `,
      )
      .get(folderId) as any;
    return row ? this.mapFolder(row) : null;
  }

  getFolderByPath(folderPath: string): WatchedFolder | null {
    const row = this.db
      .prepare(
        `
      SELECT f.*, COUNT(af.id) as file_count
      FROM folders f
      LEFT JOIN audio_files af ON af.folder_id = f.id
      WHERE f.path = ?
      GROUP BY f.id
    `,
      )
      .get(folderPath) as any;
    return row ? this.mapFolder(row) : null;
  }

  getAllFolders(): WatchedFolder[] {
    const rows = this.db
      .prepare(
        `
      SELECT f.*, COUNT(af.id) as file_count
      FROM folders f
      LEFT JOIN audio_files af ON af.folder_id = f.id
      GROUP BY f.id
      ORDER BY f.path
    `,
      )
      .all() as any[];
    return rows.map((r) => this.mapFolder(r));
  }

  updateFolderScanned(folderId: number): void {
    this.db.prepare("UPDATE folders SET last_scanned = datetime('now') WHERE id = ?").run(folderId);
  }

  private mapFolder(row: any): WatchedFolder {
    return {
      id: row.id,
      path: row.path,
      lastScanned: row.last_scanned,
      enabled: row.enabled === 1,
      fileCount: row.file_count || 0,
    };
  }

  // ─── Audio Files ───

  upsertAudioFile(file: {
    folderId: number;
    path: string;
    filename: string;
    extension: string;
    durationSeconds: number;
    sampleRate: number;
    channels: number;
    fileSize: number;
    modifiedAt: string;
    keywords: string[];
    activeStartSeconds?: number | null;
    activeEndSeconds?: number | null;
    detectedKey?: string | null;
  }): void {
    this.db
      .prepare(
        `
      INSERT INTO audio_files (folder_id, path, filename, extension, duration_seconds, sample_rate, channels, file_size, modified_at, keywords, active_start_seconds, active_end_seconds, detected_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        duration_seconds = excluded.duration_seconds,
        sample_rate = excluded.sample_rate,
        channels = excluded.channels,
        file_size = excluded.file_size,
        modified_at = excluded.modified_at,
        keywords = excluded.keywords,
        active_start_seconds = excluded.active_start_seconds,
        active_end_seconds = excluded.active_end_seconds,
        detected_key = excluded.detected_key,
        scanned_at = datetime('now')
    `,
      )
      .run(
        file.folderId,
        file.path,
        file.filename,
        file.extension,
        file.durationSeconds,
        file.sampleRate,
        file.channels,
        file.fileSize,
        file.modifiedAt,
        JSON.stringify(file.keywords),
        file.activeStartSeconds ?? null,
        file.activeEndSeconds ?? null,
        file.detectedKey ?? null,
      );
  }

  upsertAudioFileBatch(files: Parameters<DatabaseService['upsertAudioFile']>[0][]): void {
    const upsertMany = this.db.transaction(() => {
      for (const file of files) {
        this.upsertAudioFile(file);
      }
    });
    upsertMany();
  }

  getFileByPath(filePath: string): AudioFile | null {
    const row = this.db.prepare('SELECT * FROM audio_files WHERE path = ?').get(filePath) as any;
    return row ? this.mapAudioFile(row) : null;
  }

  getFilesByFolder(folderId: number): AudioFile[] {
    const rows = this.db
      .prepare('SELECT * FROM audio_files WHERE folder_id = ?')
      .all(folderId) as any[];
    return rows.map((r) => this.mapAudioFile(r));
  }

  getFilesByKeyword(keyword: string): AudioFile[] {
    // JSON array search: keywords column contains the keyword (case-insensitive)
    const rows = this.db
      .prepare('SELECT * FROM audio_files WHERE keywords LIKE ?')
      .all(`%"${keyword.toUpperCase()}"%`) as any[];
    return rows.map((r) => this.mapAudioFile(r));
  }

  getFilesByKeywords(keywords: string[]): AudioFile[] {
    if (keywords.length === 0) return [];
    const conditions = keywords.map(() => 'keywords LIKE ?').join(' OR ');
    const params = keywords.map((k) => `%"${k.toUpperCase()}"%`);
    const rows = this.db
      .prepare(`SELECT * FROM audio_files WHERE ${conditions}`)
      .all(...params) as any[];
    return rows.map((r) => this.mapAudioFile(r));
  }

  getFileGroups(): Record<string, number> {
    const rules = this.getAllTrackRules();
    const groups: Record<string, number> = {};

    for (const rule of rules) {
      const files = this.getFilesByKeywords(rule.keywords);
      groups[rule.trackName] = files.length;
    }

    // Count unmatched files
    const totalFiles = (this.db.prepare('SELECT COUNT(*) as count FROM audio_files').get() as any)
      .count;
    const matchedPaths = new Set<string>();
    for (const rule of rules) {
      const files = this.getFilesByKeywords(rule.keywords);
      files.forEach((f) => matchedPaths.add(f.path));
    }
    groups['_UNMATCHED'] = totalFiles - matchedPaths.size;

    return groups;
  }

  getTotalFileCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as count FROM audio_files').get() as any).count;
  }

  /**
   * Get files that need silence analysis (WAV/AIFF without active region data).
   */
  getFilesNeedingSilenceAnalysis(): { id: number; path: string; extension: string }[] {
    return this.db
      .prepare(
        `
      SELECT id, path, extension FROM audio_files
      WHERE active_start_seconds IS NULL
        AND extension IN ('.wav', '.aiff', '.aif')
      ORDER BY id
    `,
      )
      .all() as any[];
  }

  /**
   * Update the active region for a single audio file.
   */
  updateActiveRegion(fileId: number, startSeconds: number | null, endSeconds: number | null): void {
    this.db
      .prepare(
        'UPDATE audio_files SET active_start_seconds = ?, active_end_seconds = ? WHERE id = ?',
      )
      .run(startSeconds, endSeconds, fileId);
  }

  /**
   * Get files that need key detection (WAV/AIFF without detected_key).
   */
  getFilesNeedingKeyDetection(): {
    id: number;
    path: string;
    extension: string;
    activeStartSeconds: number | null;
    activeEndSeconds: number | null;
  }[] {
    return this.db
      .prepare(
        `
      SELECT id, path, extension, active_start_seconds AS activeStartSeconds, active_end_seconds AS activeEndSeconds
      FROM audio_files
      WHERE detected_key IS NULL
        AND extension IN ('.wav', '.aiff', '.aif')
        AND (active_start_seconds IS NULL OR active_start_seconds >= 0)
        AND (active_end_seconds IS NULL OR active_end_seconds > 0)
      ORDER BY id
    `,
      )
      .all() as any[];
  }

  /**
   * Update the detected key for a single audio file.
   */
  updateDetectedKey(fileId: number, key: string | null): void {
    this.db.prepare('UPDATE audio_files SET detected_key = ? WHERE id = ?').run(key, fileId);
  }

  getExistingFilePaths(folderId: number): Map<string, string> {
    const rows = this.db
      .prepare('SELECT path, modified_at FROM audio_files WHERE folder_id = ?')
      .all(folderId) as any[];
    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.path, row.modified_at);
    }
    return map;
  }

  removeStaleFiles(folderId: number, validPaths: Set<string>): number {
    const existingPaths = this.db
      .prepare('SELECT path FROM audio_files WHERE folder_id = ?')
      .all(folderId) as any[];

    let removed = 0;
    const deleteStmt = this.db.prepare('DELETE FROM audio_files WHERE path = ?');

    const deleteStale = this.db.transaction(() => {
      for (const row of existingPaths) {
        if (!validPaths.has(row.path)) {
          deleteStmt.run(row.path);
          removed++;
        }
      }
    });
    deleteStale();

    return removed;
  }

  private mapAudioFile(row: any): AudioFile {
    return {
      id: row.id,
      folderId: row.folder_id,
      path: row.path,
      filename: row.filename,
      extension: row.extension,
      durationSeconds: row.duration_seconds,
      sampleRate: row.sample_rate,
      channels: row.channels,
      fileSize: row.file_size,
      modifiedAt: row.modified_at,
      keywords: JSON.parse(row.keywords),
      scannedAt: row.scanned_at,
      activeStartSeconds: row.active_start_seconds ?? null,
      activeEndSeconds: row.active_end_seconds ?? null,
      detectedKey: row.detected_key ?? null,
    };
  }

  // ─── Track Rules ───

  getAllTrackRules(): TrackRule[] {
    const rows = this.db.prepare('SELECT * FROM track_rules ORDER BY track_name').all() as any[];
    return rows.map((r) => this.mapTrackRule(r));
  }

  getTrackRule(trackName: string): TrackRule | null {
    const row = this.db
      .prepare('SELECT * FROM track_rules WHERE track_name = ? COLLATE NOCASE')
      .get(trackName) as any;
    return row ? this.mapTrackRule(row) : null;
  }

  setTrackRule(trackName: string, keywords: string[], regexPattern?: string): TrackRule {
    this.db
      .prepare(
        `
      INSERT INTO track_rules (track_name, keywords, regex_pattern)
      VALUES (?, ?, ?)
      ON CONFLICT(track_name) DO UPDATE SET
        keywords = excluded.keywords,
        regex_pattern = excluded.regex_pattern,
        updated_at = datetime('now')
    `,
      )
      .run(trackName, JSON.stringify(keywords), regexPattern ?? null);
    return this.getTrackRule(trackName)!;
  }

  deleteTrackRule(trackName: string): void {
    this.db.prepare('DELETE FROM track_rules WHERE track_name = ?').run(trackName);
  }

  /**
   * Get track suggestions: all track rules with their matching file counts.
   * Optionally exclude track names that already exist (case-insensitive).
   */
  getTrackSuggestions(excludeNames: string[] = []): TrackSuggestion[] {
    const rules = this.getAllTrackRules();
    const excludeSet = new Set(excludeNames.map((n) => n.toUpperCase()));
    const suggestions: TrackSuggestion[] = [];

    for (const rule of rules) {
      if (excludeSet.has(rule.trackName.toUpperCase())) continue;
      const files = this.getFilesByKeywords(rule.keywords);
      suggestions.push({
        trackName: rule.trackName,
        fileCount: files.length,
        keywords: rule.keywords,
      });
    }

    // Sort by file count descending
    suggestions.sort((a, b) => b.fileCount - a.fileCount);
    return suggestions;
  }

  private mapTrackRule(row: any): TrackRule {
    return {
      id: row.id,
      trackName: row.track_name,
      keywords: JSON.parse(row.keywords),
      regexPattern: row.regex_pattern,
    };
  }

  // ─── Generation History ───

  saveGeneration(id: string, config: object, plan: object, tempo: number): void {
    this.db
      .prepare('INSERT INTO generation_history (id, config, plan, tempo) VALUES (?, ?, ?, ?)')
      .run(id, JSON.stringify(config), JSON.stringify(plan), tempo);
  }

  // ─── Utility ───

  close(): void {
    this.db.close();
  }
}
