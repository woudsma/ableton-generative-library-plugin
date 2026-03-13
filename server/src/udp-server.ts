import dgram from 'dgram';
import { DatabaseService } from './database.js';
import { AbletonService } from './ableton.js';
import { FileScanner } from './scanner.js';
import { GenerativeEngine } from './generator.js';
import { UDP_PORT_SERVER, UDP_PORT_MAX, DURATION_OPTIONS } from './types.js';
import type { ServerCommand, ServerResponse, GenerationConfig } from './types.js';

export class UDPServer {
  private server: dgram.Socket;
  private db: DatabaseService;
  private ableton: AbletonService;
  private scanner: FileScanner;
  private engine: GenerativeEngine;
  private maxAddress: string = '127.0.0.1';
  private maxPort: number = UDP_PORT_MAX;
  private port: number;

  constructor(db: DatabaseService, ableton: AbletonService, port: number = UDP_PORT_SERVER) {
    this.db = db;
    this.ableton = ableton;
    this.scanner = new FileScanner(db);
    this.engine = new GenerativeEngine(db, ableton);
    this.port = port;

    this.server = dgram.createSocket('udp4');
    this.server.on('message', (msg, rinfo) => this.handleMessage(msg, rinfo));
    this.server.on('error', (err) => {
      console.error('[UDP] Server error:', err);
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.bind(this.port, '127.0.0.1', () => {
        console.log(`[UDP] Server listening on 127.0.0.1:${this.port}`);
        resolve();
      });
      this.server.once('error', reject);
    });
  }

  stop(): void {
    this.server.close();
    console.log('[UDP] Server stopped');
  }

  // ─── Message Handling ───

  private async handleMessage(msg: Buffer, rinfo: dgram.RemoteInfo): Promise<void> {
    // Remember the Max client address but always respond on the fixed Max port
    // (udpreceive in Max listens on a fixed port, but udpsend sends FROM an ephemeral port)
    this.maxAddress = rinfo.address;

    let command: ServerCommand;
    try {
      // [udpsend] in Max formats as OSC — extract JSON from the OSC string argument.
      // OSC format: address (/cmd) + type tag (,s) + string arg (the JSON)
      const jsonStr = this.parseOSCStringArg(msg);
      command = JSON.parse(jsonStr);
    } catch {
      console.warn('[UDP] Could not parse incoming OSC/JSON, raw bytes:', msg.length);
      this.sendResponse({ type: 'error', message: 'Invalid JSON message' });
      return;
    }

    try {
      await this.routeCommand(command);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[UDP] Error handling command "${command.type}":`, message);
      this.sendResponse({ type: 'error', message, command: command.type });
    }
  }

  private async routeCommand(command: ServerCommand): Promise<void> {
    switch (command.type) {
      case 'ping':
        this.sendResponse({ type: 'pong' });
        break;

      case 'get_status':
        await this.handleGetStatus();
        break;

      case 'add_folder':
        await this.handleAddFolder(command.path);
        break;

      case 'remove_folder':
        await this.handleRemoveFolder(command.folderId);
        break;

      case 'scan_folders':
        await this.handleScanFolders(command.folderIds);
        break;

      case 'get_folders':
        this.handleGetFolders();
        break;

      case 'get_file_groups':
        this.handleGetFileGroups();
        break;

      case 'get_tracks':
        await this.handleGetTracks();
        break;

      case 'set_track_enabled':
        // This is handled client-side (M4L keeps track of enabled state)
        this.sendResponse({ type: 'ok' });
        break;

      case 'get_track_rules':
        this.handleGetTrackRules();
        break;

      case 'set_track_rule':
        this.handleSetTrackRule(command.trackName, command.keywords, command.regexPattern);
        break;

      case 'generate':
        await this.handleGenerate(command.config);
        break;

      case 'row_variation':
        await this.handleRowVariation(command.sceneIndex, {
          skipSilence: command.skipSilence,
          loopClips: command.loopClips,
          sameKey: command.sameKey,
        });
        break;

      case 'get_duration_options':
        this.sendResponse({ type: 'duration_options', options: DURATION_OPTIONS });
        break;

      case 'get_config':
        await this.handleGetConfig();
        break;

      case 'get_track_suggestions':
        await this.handleGetTrackSuggestions();
        break;

      default:
        this.sendResponse({
          type: 'error',
          message: `Unknown command: ${(command as any).type}`,
        });
    }
  }

  // ─── Command Handlers ───

  private async handleGetStatus(): Promise<void> {
    const folders = this.db.getAllFolders();
    const fileCount = this.db.getTotalFileCount();
    this.sendResponse({
      type: 'status',
      connected: this.ableton.isConnected,
      folderCount: folders.length,
      fileCount,
      scanning: this.scanner.isScanning,
    });
  }

  private async handleAddFolder(folderPath: string): Promise<void> {
    const folder = this.db.addFolder(folderPath);
    console.log(`[Server] Added folder: ${folderPath}`);
    this.sendResponse({
      type: 'folders',
      folders: this.db.getAllFolders(),
    });
  }

  private async handleRemoveFolder(folderId: number): Promise<void> {
    this.db.removeFolder(folderId);
    console.log(`[Server] Removed folder: ${folderId}`);
    this.sendResponse({
      type: 'folders',
      folders: this.db.getAllFolders(),
    });
  }

  private async handleScanFolders(folderIds?: number[]): Promise<void> {
    if (this.scanner.isScanning) {
      this.sendResponse({ type: 'error', message: 'Scan already in progress' });
      return;
    }

    // Run scan asynchronously — send back progress updates
    const onProgress = (progress: { folder: string; filesScanned: number; totalFiles: number }) => {
      this.sendResponse({
        type: 'scan_progress',
        folder: progress.folder,
        filesScanned: progress.filesScanned,
        totalFiles: progress.totalFiles,
      });
    };

    this.sendResponse({ type: 'ok', message: 'Scan started' });

    try {
      if (folderIds && folderIds.length > 0) {
        for (const folderId of folderIds) {
          const result = await this.scanner.scanFolder(folderId, onProgress);
          const folder = this.db.getFolder(folderId);
          this.sendResponse({
            type: 'scan_complete',
            folder: folder?.path ?? String(folderId),
            newFiles: result.newFiles,
            totalFiles: result.totalFiles,
          });
        }
      } else {
        await this.scanner.scanAllFolders(onProgress);
      }

      // Send final status update
      await this.handleGetStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendResponse({ type: 'error', message: `Scan failed: ${message}` });
    }
  }

  private handleGetFolders(): void {
    this.sendResponse({
      type: 'folders',
      folders: this.db.getAllFolders(),
    });
  }

  private handleGetFileGroups(): void {
    this.sendResponse({
      type: 'file_groups',
      groups: this.db.getFileGroups(),
    });
  }

  private async handleGetTracks(): Promise<void> {
    try {
      await this.ableton.ensureConnectedOrReconnect();
    } catch {
      this.sendResponse({ type: 'error', message: 'Not connected to Ableton Live' });
      return;
    }
    const tracks = await this.ableton.getTracks();
    this.sendResponse({ type: 'tracks', tracks });
  }

  private handleGetTrackRules(): void {
    this.sendResponse({
      type: 'track_rules',
      rules: this.db.getAllTrackRules(),
    });
  }

  private handleSetTrackRule(trackName: string, keywords: string[], regexPattern?: string): void {
    this.db.setTrackRule(trackName, keywords, regexPattern);
    this.sendResponse({
      type: 'track_rules',
      rules: this.db.getAllTrackRules(),
    });
  }

  private async handleGenerate(config: GenerationConfig): Promise<void> {
    try {
      await this.ableton.ensureConnectedOrReconnect();
    } catch {
      this.sendResponse({ type: 'error', message: 'Not connected to Ableton Live' });
      return;
    }

    console.log(
      `[Server] Generating composition: ${config.duration.label}, ` +
        `mode=${config.segmentMode}, view=${config.viewMode}, ` +
        `tracks=[${config.enabledTrackIndices.join(',')}]`,
    );

    const plan = await this.engine.createPlan(config);

    if (plan.clips.length === 0) {
      this.sendResponse({
        type: 'error',
        message: 'No clips to create (no matching files for any track)',
      });
      return;
    }

    // Execute plan server-side via ableton-js using Track.create_audio_clip() (Live 12 API)
    console.log(`[Server] Executing plan with ${plan.clips.length} clips via ableton-js...`);

    try {
      const clipsCreated = await this.engine.executePlan(plan, (current, total, trackName) => {
        this.sendResponse({ type: 'generation_progress', current, total, trackName });
      });
      console.log(
        `[Server] Generation complete: ${clipsCreated}/${plan.clips.length} clips created`,
      );
      this.sendResponse({ type: 'generation_complete', clipsCreated });
    } catch (err) {
      console.error(
        '[Server] Generation execution failed:',
        err instanceof Error ? err.message : err,
      );
      this.sendResponse({
        type: 'error',
        message: `Generation failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  }

  private async handleGetConfig(): Promise<void> {
    const folders = this.db.getAllFolders();
    const rules = this.db.getAllTrackRules();
    let tracks: any[] = [];
    if (this.ableton.isConnected) {
      tracks = await this.ableton.getTracks();
    }
    this.sendResponse({ type: 'config', folders, rules, tracks });
  }

  private async handleGetTrackSuggestions(): Promise<void> {
    // Get existing Ableton track names to exclude from suggestions
    let existingNames: string[] = [];
    if (this.ableton.isConnected) {
      const abletonTracks = await this.ableton.getTracks();
      existingNames = abletonTracks.map((t) => t.name);
    }
    const suggestions = this.db.getTrackSuggestions(existingNames);
    this.sendResponse({ type: 'track_suggestions', suggestions });
  }

  private async handleRowVariation(
    sceneIndex: number,
    options?: { skipSilence?: boolean; loopClips?: boolean; sameKey?: boolean },
  ): Promise<void> {
    try {
      await this.ableton.ensureConnectedOrReconnect();
    } catch {
      this.sendResponse({ type: 'error', message: 'Not connected to Ableton Live' });
      return;
    }

    console.log(`[Server] Creating row variation from scene ${sceneIndex}`);

    try {
      const result = await this.engine.createRowVariation(
        sceneIndex,
        options,
        (current, total, trackName) => {
          this.sendResponse({ type: 'generation_progress', current, total, trackName });
        },
      );

      if (result.clipsCreated === 0) {
        this.sendResponse({
          type: 'error',
          message: 'No clips created (scene may be empty)',
        });
        return;
      }

      console.log(
        `[Server] Row variation complete: ${result.clipsCreated} clips in scene ${result.newSceneIndex}`,
      );
      this.sendResponse({
        type: 'variation_complete',
        clipsCreated: result.clipsCreated,
        newSceneIndex: result.newSceneIndex,
      });
    } catch (err) {
      console.error('[Server] Row variation failed:', err instanceof Error ? err.message : err);
      this.sendResponse({
        type: 'error',
        message: `Row variation failed: ${err instanceof Error ? err.message : err}`,
      });
    }
  }

  // ─── OSC Protocol Helpers ───

  /**
   * Create a null-terminated, 4-byte-aligned OSC string.
   */
  private oscString(str: string): Buffer {
    const raw = Buffer.from(str, 'utf-8');
    const paddedLen = Math.ceil((raw.length + 1) / 4) * 4;
    const buf = Buffer.alloc(paddedLen, 0);
    raw.copy(buf);
    return buf;
  }

  /**
   * Create a valid OSC message: address + type tag + string argument.
   * Max's [udpreceive] outputs: <address> <string_arg>
   */
  private createOSCMessage(address: string, str: string): Buffer {
    const addrBuf = this.oscString(address);
    const typeBuf = this.oscString(',s');
    const argBuf = this.oscString(str);
    return Buffer.concat([addrBuf, typeBuf, argBuf]);
  }

  /**
   * Parse an incoming OSC message from [udpsend].
   * Max sends: /cmd ,s <json_string>
   * We extract and return the string argument (the JSON).
   */
  private parseOSCStringArg(buf: Buffer): string {
    // Find end of address string (null terminated)
    let i = 0;
    while (i < buf.length && buf[i] !== 0) i++;
    // Skip to 4-byte boundary (past address padding)
    i = Math.ceil((i + 1) / 4) * 4;

    // Check for type tag string starting with ','
    if (i < buf.length && buf[i] === 0x2c) {
      // ','
      // Read type tag: we expect ',s'
      const typeStart = i;
      while (i < buf.length && buf[i] !== 0) i++;
      i = Math.ceil((i + 1) / 4) * 4;

      // Now at the string argument
      let strEnd = i;
      while (strEnd < buf.length && buf[strEnd] !== 0) strEnd++;
      return buf.toString('utf-8', i, strEnd);
    }

    // Fallback: no type tag — the address IS the content (old format / plain text)
    const nullIdx = buf.indexOf(0);
    return nullIdx >= 0 ? buf.toString('utf-8', 0, nullIdx) : buf.toString('utf-8');
  }

  // ─── Response Sending ───

  private sendResponse(response: ServerResponse): void {
    const json = JSON.stringify(response);

    // UDP datagram size limit check (practical limit ~8KB for reliability)
    if (json.length > 7000) {
      this.sendChunked(json);
      return;
    }

    const buffer = this.createOSCMessage('/resp', json);
    this.server.send(buffer, this.maxPort, this.maxAddress, (err) => {
      if (err) {
        console.error('[UDP] Send error:', err);
      }
    });
  }

  private sendChunked(json: string): void {
    const chunkSize = 6000;
    const totalChunks = Math.ceil(json.length / chunkSize);
    const messageId = Date.now().toString(36);

    for (let i = 0; i < totalChunks; i++) {
      const chunk = json.slice(i * chunkSize, (i + 1) * chunkSize);
      const envelope = JSON.stringify({
        _chunked: true,
        _messageId: messageId,
        _chunkIndex: i,
        _totalChunks: totalChunks,
        _data: chunk,
      });

      const buffer = this.createOSCMessage('/resp', envelope);
      this.server.send(buffer, this.maxPort, this.maxAddress);
    }
  }
}
