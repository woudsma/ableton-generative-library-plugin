/**
 * CLI utility for managing the generative library.
 * Usage:
 *   tsx server/src/cli.ts init-db         — Initialize the database
 *   tsx server/src/cli.ts scan [path]     — Scan a folder (or all folders)
 *   tsx server/src/cli.ts add-folder <path> — Add a folder to watch
 *   tsx server/src/cli.ts folders         — List all watched folders
 *   tsx server/src/cli.ts stats           — Show database statistics
 *   tsx server/src/cli.ts rules           — List all track rules
 *   tsx server/src/cli.ts detect-silence  — Analyze WAV/AIFF files for silent regions
 *   tsx server/src/cli.ts detect-keys     — Detect musical keys for WAV/AIFF files
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseService } from './database.js';
import { FileScanner } from './scanner.js';
import { detectActiveRegion } from './silence-detector.js';
import { detectKey } from './key-detector.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.resolve(__dirname, '..', 'data', 'library.db');

async function main() {
  const [, , command, ...args] = process.argv;

  const db = new DatabaseService(dbPath);

  try {
    switch (command) {
      case 'init-db':
        console.log(`Database initialized at: ${dbPath}`);
        break;

      case 'add-folder': {
        const folderPath = args[0];
        if (!folderPath) {
          console.error('Usage: tsx server/src/cli.ts add-folder <path>');
          process.exit(1);
        }
        const resolvedPath = path.resolve(folderPath);
        const folder = db.addFolder(resolvedPath);
        console.log(`Added folder: ${folder.path} (id: ${folder.id})`);
        break;
      }

      case 'folders': {
        const folders = db.getAllFolders();
        if (folders.length === 0) {
          console.log('No folders configured.');
        } else {
          console.log('Watched folders:');
          for (const f of folders) {
            console.log(`  [${f.id}] ${f.path}`);
            console.log(
              `       Files: ${f.fileCount} | Last scan: ${f.lastScanned ?? 'never'} | Enabled: ${f.enabled}`,
            );
          }
        }
        break;
      }

      case 'scan': {
        const scanner = new FileScanner(db);
        const folderPath = args[0];

        if (folderPath) {
          const resolvedPath = path.resolve(folderPath);
          let folder = db.getFolderByPath(resolvedPath);
          if (!folder) {
            folder = db.addFolder(resolvedPath);
            console.log(`Added new folder: ${resolvedPath}`);
          }
          console.log(`Scanning: ${folder.path}...`);
          const result = await scanner.scanFolder(folder.id, (progress) => {
            process.stdout.write(
              `\r  Scanned ${progress.filesScanned}/${progress.totalFiles} files...`,
            );
          });
          console.log(
            `\n  Done! New: ${result.newFiles}, Updated: ${result.updatedFiles}, Removed: ${result.removedFiles}, Total: ${result.totalFiles}`,
          );
        } else {
          console.log('Scanning all folders...');
          const result = await scanner.scanAllFolders((progress) => {
            process.stdout.write(
              `\r  [${progress.folder}] ${progress.filesScanned}/${progress.totalFiles}...`,
            );
          });
          console.log(
            `\n  Done! New: ${result.totalNew}, Updated: ${result.totalUpdated}, Removed: ${result.totalRemoved}`,
          );
        }
        break;
      }

      case 'stats': {
        const folders = db.getAllFolders();
        const fileCount = db.getTotalFileCount();
        const groups = db.getFileGroups();

        console.log('Database Statistics:');
        console.log(`  Folders: ${folders.length}`);
        console.log(`  Total files: ${fileCount}`);
        console.log();
        console.log('File groups:');
        for (const [name, count] of Object.entries(groups)) {
          if (count > 0) {
            console.log(`  ${name}: ${count} files`);
          }
        }
        break;
      }

      case 'rules': {
        const rules = db.getAllTrackRules();
        console.log('Track matching rules:');
        for (const rule of rules) {
          console.log(
            `  ${rule.trackName}: [${rule.keywords.join(', ')}]${rule.regexPattern ? ` regex: ${rule.regexPattern}` : ''}`,
          );
        }
        break;
      }

      case 'detect-silence': {
        const files = db.getFilesNeedingSilenceAnalysis();
        if (files.length === 0) {
          console.log('All WAV/AIFF files already have silence data. Nothing to do.');
          break;
        }

        console.log(`Analyzing ${files.length} WAV/AIFF files for silence...\n`);

        let analyzed = 0;
        let skipped = 0;
        const startTime = Date.now();

        // Handle Ctrl+C gracefully
        let cancelled = false;
        const onSigint = () => {
          cancelled = true;
          process.stdout.write('\n\nCancelled! ');
        };
        process.on('SIGINT', onSigint);

        for (let i = 0; i < files.length; i++) {
          if (cancelled) break;

          const file = files[i];
          const region = detectActiveRegion(file.path);

          if (region) {
            db.updateActiveRegion(file.id, region.startSeconds, region.endSeconds);
            // Mark files where active region == full file as "no significant silence"
            analyzed++;
          } else {
            // Not a supported format or unreadable — mark with -1 so we don't retry
            db.updateActiveRegion(file.id, -1, -1);
            skipped++;
          }

          // Progress bar
          const done = i + 1;
          const pct = Math.round((done / files.length) * 100);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
          const rate = (done / ((Date.now() - startTime) / 1000)).toFixed(0);
          const barWidth = 30;
          const filled = Math.round((done / files.length) * barWidth);
          const bar = '█'.repeat(filled) + '░'.repeat(barWidth - filled);

          process.stdout.write(
            `\r  ${bar} ${pct}% (${done}/${files.length}) ${rate} files/s — ${elapsed}s`,
          );
        }

        process.removeListener('SIGINT', onSigint);

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(
          `\n\n  Done in ${totalTime}s — analyzed: ${analyzed}, skipped: ${skipped}` +
            (cancelled ? ` (cancelled, ${files.length - analyzed - skipped} remaining)` : ''),
        );
        break;
      }

      case 'detect-keys': {
        const files = db.getFilesNeedingKeyDetection();
        if (files.length === 0) {
          console.log('All WAV/AIFF files already have key data. Nothing to do.');
          break;
        }

        console.log(`Detecting keys for ${files.length} WAV/AIFF files...\n`);

        let detected = 0;
        let skippedKeys = 0;
        const startTimeKeys = Date.now();

        // Handle Ctrl+C gracefully
        let cancelledKeys = false;
        const onSigintKeys = () => {
          cancelledKeys = true;
          process.stdout.write('\n\nCancelled! ');
        };
        process.on('SIGINT', onSigintKeys);

        for (let i = 0; i < files.length; i++) {
          if (cancelledKeys) break;

          const file = files[i];
          const key = detectKey(file.path, file.activeStartSeconds, file.activeEndSeconds);

          if (key) {
            db.updateDetectedKey(file.id, key);
            detected++;
          } else {
            // Mark with empty string so we don't retry
            db.updateDetectedKey(file.id, '');
            skippedKeys++;
          }

          // Progress bar
          const done = i + 1;
          const pct = Math.round((done / files.length) * 100);
          const elapsed = ((Date.now() - startTimeKeys) / 1000).toFixed(1);
          const rate = (done / ((Date.now() - startTimeKeys) / 1000)).toFixed(0);
          const barWidth = 30;
          const filled = Math.round((done / files.length) * barWidth);
          const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(barWidth - filled);

          process.stdout.write(
            `\r  ${bar} ${pct}% (${done}/${files.length}) ${rate} files/s — ${elapsed}s`,
          );
        }

        process.removeListener('SIGINT', onSigintKeys);

        const totalTimeKeys = ((Date.now() - startTimeKeys) / 1000).toFixed(1);
        console.log(
          `\n\n  Done in ${totalTimeKeys}s — detected: ${detected}, skipped: ${skippedKeys}` +
            (cancelledKeys
              ? ` (cancelled, ${files.length - detected - skippedKeys} remaining)`
              : ''),
        );
        break;
      }

      default:
        console.log('Ableton Generative Library — CLI');
        console.log();
        console.log('Commands:');
        console.log('  init-db              Initialize the database');
        console.log('  add-folder <path>    Add a folder to watch');
        console.log('  folders              List all watched folders');
        console.log('  scan [path]          Scan a folder or all folders');
        console.log('  detect-silence       Analyze WAV/AIFF files for silent regions');
        console.log('  detect-keys          Detect musical keys for WAV/AIFF files');
        console.log('  stats                Show database statistics');
        console.log('  rules                List track matching rules');
        break;
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
