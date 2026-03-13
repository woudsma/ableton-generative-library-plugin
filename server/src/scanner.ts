import fs from 'fs/promises';
import path from 'path';
import { DatabaseService } from './database.js';
import { detectActiveRegion } from './silence-detector.js';
import { detectKey } from './key-detector.js';
import { SUPPORTED_EXTENSIONS, DEFAULT_KEYWORDS } from './types.js';
import type { AudioFile } from './types.js';

// music-metadata parseFile — loaded lazily to handle Node.js-specific export
let _parseFile: ((filePath: string, options?: any) => Promise<any>) | undefined;

async function loadParseFile(): Promise<(filePath: string, options?: any) => Promise<any>> {
  if (_parseFile) return _parseFile;
  // Use Function constructor to evade static analysis by tsc which resolves
  // the dynamic import to core.d.ts (which lacks parseFile)
  const mod = (await new Function('specifier', 'return import(specifier)')(
    'music-metadata',
  )) as any;
  _parseFile = mod.parseFile as (filePath: string, options?: any) => Promise<any>;
  return _parseFile;
}

export interface ScanProgress {
  folder: string;
  filesScanned: number;
  totalFiles: number;
  newFiles: number;
  skippedFiles: number;
}

export type ScanProgressCallback = (progress: ScanProgress) => void;

export class FileScanner {
  private db: DatabaseService;
  private scanning = false;

  constructor(db: DatabaseService) {
    this.db = db;
  }

  get isScanning(): boolean {
    return this.scanning;
  }

  /**
   * Scan a single folder for audio files.
   * Performs incremental scanning — skips files that haven't changed since last scan.
   */
  async scanFolder(
    folderId: number,
    onProgress?: ScanProgressCallback,
  ): Promise<{ newFiles: number; updatedFiles: number; removedFiles: number; totalFiles: number }> {
    const folder = this.db.getFolder(folderId);
    if (!folder) {
      throw new Error(`Folder with id ${folderId} not found`);
    }

    // Check if folder is accessible
    try {
      await fs.access(folder.path, fs.constants.R_OK);
    } catch {
      throw new Error(`Folder not accessible: ${folder.path} (is the drive mounted?)`);
    }

    this.scanning = true;

    try {
      // 1. Discover all audio files recursively
      const audioPaths = await this.discoverAudioFiles(folder.path);

      // 2. Get existing files for this folder from the database
      const existingFiles = this.db.getExistingFilePaths(folderId);

      // 3. Determine which files need scanning
      let newFiles = 0;
      let updatedFiles = 0;
      let skippedFiles = 0;
      const validPaths = new Set<string>();
      const batch: Parameters<DatabaseService['upsertAudioFile']>[0][] = [];

      for (let i = 0; i < audioPaths.length; i++) {
        const filePath = audioPaths[i];
        validPaths.add(filePath);

        try {
          const stat = await fs.stat(filePath);
          const modifiedAt = stat.mtime.toISOString();
          const existingModified = existingFiles.get(filePath);

          // Skip if file hasn't changed
          if (existingModified && existingModified === modifiedAt) {
            skippedFiles++;
          } else {
            // Parse audio metadata
            const metadata = await this.parseAudioMetadata(filePath);
            const filename = path.basename(filePath);
            const extension = path.extname(filePath).toLowerCase();
            const keywords = this.extractKeywords(filename);

            // Detect non-silent region (fast PCM analysis for WAV/AIFF)
            const activeRegion = detectActiveRegion(filePath);

            // Detect musical key (skip if file is essentially silent)
            const detectedKey = detectKey(
              filePath,
              activeRegion?.startSeconds,
              activeRegion?.endSeconds,
            );

            batch.push({
              folderId,
              path: filePath,
              filename,
              extension,
              durationSeconds: metadata.duration,
              sampleRate: metadata.sampleRate,
              channels: metadata.channels,
              fileSize: stat.size,
              modifiedAt,
              keywords,
              activeStartSeconds: activeRegion?.startSeconds ?? null,
              activeEndSeconds: activeRegion?.endSeconds ?? null,
              detectedKey,
            });

            if (existingModified) {
              updatedFiles++;
            } else {
              newFiles++;
            }

            // Batch insert every 50 files to avoid huge transactions
            if (batch.length >= 50) {
              this.db.upsertAudioFileBatch(batch);
              batch.length = 0;
            }
          }
        } catch (err) {
          // Skip files that can't be read or parsed
          console.warn(
            `Skipping file (error): ${filePath}`,
            err instanceof Error ? err.message : err,
          );
          skippedFiles++;
        }

        // Report progress
        if (onProgress && (i % 10 === 0 || i === audioPaths.length - 1)) {
          onProgress({
            folder: folder.path,
            filesScanned: i + 1,
            totalFiles: audioPaths.length,
            newFiles,
            skippedFiles,
          });
        }
      }

      // Insert remaining batch
      if (batch.length > 0) {
        this.db.upsertAudioFileBatch(batch);
      }

      // 4. Remove stale files (files in DB that no longer exist on disk)
      const removedFiles = this.db.removeStaleFiles(folderId, validPaths);

      // 5. Update folder scan timestamp
      this.db.updateFolderScanned(folderId);

      return {
        newFiles,
        updatedFiles,
        removedFiles,
        totalFiles: audioPaths.length,
      };
    } finally {
      this.scanning = false;
    }
  }

  /**
   * Scan all enabled folders.
   */
  async scanAllFolders(
    onProgress?: ScanProgressCallback,
  ): Promise<{ totalNew: number; totalUpdated: number; totalRemoved: number }> {
    const folders = this.db.getAllFolders().filter((f) => f.enabled);
    let totalNew = 0;
    let totalUpdated = 0;
    let totalRemoved = 0;

    for (const folder of folders) {
      try {
        const result = await this.scanFolder(folder.id, onProgress);
        totalNew += result.newFiles;
        totalUpdated += result.updatedFiles;
        totalRemoved += result.removedFiles;
      } catch (err) {
        console.error(
          `Error scanning folder ${folder.path}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    return { totalNew, totalUpdated, totalRemoved };
  }

  /**
   * Recursively discover all audio files in a directory.
   * Only scans inside Ableton project folders (directories containing a .als file).
   */
  private async discoverAudioFiles(dirPath: string): Promise<string[]> {
    const results: string[] = [];
    const extensionSet = new Set(SUPPORTED_EXTENSIONS as readonly string[]);

    // First, find all Ableton project directories under the root
    const projectDirs = await this.findAbletonProjects(dirPath);

    if (projectDirs.length === 0) {
      console.warn(`[Scanner] No Ableton projects (.als files) found in ${dirPath}`);
      return results;
    }

    console.log(`[Scanner] Found ${projectDirs.length} Ableton project(s) in ${dirPath}`);

    // Then recursively scan audio files within each project directory
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        // Skip directories we can't read
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip hidden directories and common non-audio directories
        if (entry.name.startsWith('.') || entry.name === 'node_modules') {
          continue;
        }

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extensionSet.has(ext)) {
            results.push(fullPath);
          }
        }
      }
    };

    for (const projectDir of projectDirs) {
      await walk(projectDir);
    }

    return results;
  }

  /**
   * Find directories that are Ableton projects (contain a .als file at their root level).
   * Searches the given directory and its immediate children.
   */
  private async findAbletonProjects(rootPath: string): Promise<string[]> {
    const projects: string[] = [];

    // Check if the root itself is a project
    if (await this.hasAlsFile(rootPath)) {
      projects.push(rootPath);
      return projects;
    }

    // Check subdirectories (one level deep for project folders)
    let entries;
    try {
      entries = await fs.readdir(rootPath, { withFileTypes: true });
    } catch {
      return projects;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

      const subDir = path.join(rootPath, entry.name);
      if (await this.hasAlsFile(subDir)) {
        projects.push(subDir);
      } else {
        // Also check one more level deep (e.g., artist/project-name/*.als)
        let subEntries;
        try {
          subEntries = await fs.readdir(subDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const subEntry of subEntries) {
          if (!subEntry.isDirectory() || subEntry.name.startsWith('.')) continue;
          const subSubDir = path.join(subDir, subEntry.name);
          if (await this.hasAlsFile(subSubDir)) {
            projects.push(subSubDir);
          }
        }
      }
    }

    return projects;
  }

  /**
   * Check if a directory contains at least one .als file at its root level.
   */
  private async hasAlsFile(dirPath: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries.some((e) => e.isFile() && e.name.toLowerCase().endsWith('.als'));
    } catch {
      return false;
    }
  }

  /**
   * Parse audio file metadata (duration, sample rate, channels).
   */
  private async parseAudioMetadata(filePath: string): Promise<{
    duration: number;
    sampleRate: number;
    channels: number;
  }> {
    try {
      const parseFile = await loadParseFile();
      const metadata = await parseFile(filePath, { duration: true, skipCovers: true });
      return {
        duration: metadata.format.duration ?? 0,
        sampleRate: metadata.format.sampleRate ?? 0,
        channels: metadata.format.numberOfChannels ?? 0,
      };
    } catch {
      // If metadata parsing fails, return defaults
      return { duration: 0, sampleRate: 0, channels: 0 };
    }
  }

  /**
   * Extract keywords from a filename for track matching.
   *
   * Example: "KICK_heavy_001.wav" → ["KICK"]
   *          "My Session - SYNTH lead.aif" → ["SYNTH", "LEAD"]
   *          "DIGITAKT_jam_20231015.wav" → ["DIGITAKT"]
   *
   * Strategy:
   * 1. Remove extension
   * 2. Split on common delimiters (_, -, space, .)
   * 3. Match each token against known keywords (case-insensitive)
   * 4. Also check the full path segments for keywords
   */
  extractKeywords(filename: string): string[] {
    const nameWithoutExt = path.parse(filename).name;
    const tokens = nameWithoutExt.split(/[_\-\s.]+/).map((t) => t.toUpperCase());

    const matched = new Set<string>();

    for (const token of tokens) {
      for (const keyword of DEFAULT_KEYWORDS) {
        // Exact match or token contains keyword
        if (token === keyword || token.includes(keyword)) {
          matched.add(keyword);
        }
      }
    }

    return Array.from(matched);
  }

  /**
   * Match a filename against a specific track rule.
   * Returns true if the filename matches the rule's keywords or regex.
   */
  matchesTrackRule(
    filename: string,
    ruleKeywords: string[],
    regexPattern?: string | null,
  ): boolean {
    // Check regex first if provided
    if (regexPattern) {
      try {
        const regex = new RegExp(regexPattern, 'i');
        if (regex.test(filename)) return true;
      } catch {
        // Invalid regex, fall through to keyword matching
      }
    }

    // Keyword matching
    const fileKeywords = this.extractKeywords(filename);
    return ruleKeywords.some((rk) => fileKeywords.some((fk) => fk === rk.toUpperCase()));
  }
}
