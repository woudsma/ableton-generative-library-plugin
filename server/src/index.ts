import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseService } from './database.js';
import { AbletonService } from './ableton.js';
import { UDPServer } from './udp-server.js';
import { UDP_PORT_SERVER } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Ableton Generative Library Plugin — Server');
  console.log('═══════════════════════════════════════════════');
  console.log();

  // 1. Initialize database
  const dbPath = path.resolve(__dirname, '..', 'data', 'library.db');
  console.log(`[DB] Opening database: ${dbPath}`);
  const db = new DatabaseService(dbPath);

  const folders = db.getAllFolders();
  const fileCount = db.getTotalFileCount();
  console.log(`[DB] ${folders.length} folder(s), ${fileCount} cached file(s)`);

  // 2. Start UDP server first — so M4L pings are answered immediately on restart
  const ableton = new AbletonService();
  const port = parseInt(process.env.UDP_PORT ?? String(UDP_PORT_SERVER), 10);
  const udpServer = new UDPServer(db, ableton, port);
  await udpServer.start();

  console.log(`[Server] Listening for commands on UDP port ${port}`);
  console.log();

  // 3. Connect to Ableton Live (non-blocking — server already responds to pings)
  console.log('[Ableton] Connecting to Ableton Live...');

  try {
    await ableton.connect();
    const tempo = await ableton.getTempo();
    console.log(`[Ableton] Connected! Tempo: ${tempo} BPM`);
  } catch (err) {
    console.warn('[Ableton] Could not connect to Ableton Live (will retry on commands)');
    console.warn(`  ${err instanceof Error ? err.message : err}`);
    console.warn('  Ableton features will be unavailable until connected.');
  }

  console.log();
  console.log(`[Server] Ready!`);
  console.log();

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[Server] Shutting down...');
    udpServer.stop();
    ableton.disconnect().catch(() => {});
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep process alive
  setInterval(() => {}, 60000);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
