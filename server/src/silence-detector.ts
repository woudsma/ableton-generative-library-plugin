import fs from 'fs';

/**
 * Silence detection for audio files.
 *
 * Finds the non-silent active region within an audio file by reading raw PCM data.
 * Supports WAV and AIFF natively (reads headers + PCM directly).
 * Returns null for unsupported formats — caller should fall back to full file duration.
 *
 * Optimized for speed on multi-GB files:
 *  - Only scans the first/last MAX_SCAN_SECONDS of the file (default 60s each)
 *  - Uses ~1MB read blocks with a large stride (checks ~64 samples per block)
 *  - Bidirectional: forward from start, backward from end
 *  - Early exit on first non-silent sample
 *
 * Typical: 4GB WAV with 2s silence head/tail → reads ~1MB, completes in <5ms
 * Worst case (60s+ silence): reads ~60MB from each end, still under 1s
 */

export interface ActiveRegion {
  /** Start of non-silent audio in seconds */
  startSeconds: number;
  /** End of non-silent audio in seconds */
  endSeconds: number;
}

/** Peak amplitude threshold below which audio is considered silent. */
const SILENCE_THRESHOLD = 0.005; // ~-46 dBFS

/** Max seconds to scan from each end before giving up. */
const MAX_SCAN_SECONDS = 60;

/** Frames per analysis block. 262144 frames × 6 B/frame (24-bit stereo) ≈ 1.5 MB per read. */
const BLOCK_SIZE = 262144;

/** Only check every Nth frame within a block. 1024 → ~256 samples checked per 262K-frame block. */
const STRIDE = 1024;

/**
 * Detect the active (non-silent) region of an audio file.
 * Returns the start/end time in seconds of the first/last non-silent block.
 * Returns null if the format isn't supported for direct PCM reading.
 */
export function detectActiveRegion(filePath: string): ActiveRegion | null {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();

  if (ext === '.wav') {
    return analyzeWav(filePath);
  } else if (ext === '.aiff' || ext === '.aif') {
    return analyzeAiff(filePath);
  }

  // MP3, FLAC, OGG — can't read raw PCM without a decoder
  return null;
}

// ─── WAV Analysis ───

interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

function parseWavHeader(fd: number): WavInfo | null {
  const header = Buffer.alloc(44);
  const bytesRead = fs.readSync(fd, header, 0, 44, 0);
  if (bytesRead < 44) return null;

  // Verify RIFF + WAVE
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    return null;
  }

  // Find the 'fmt ' and 'data' chunks by scanning
  const fileSize = fs.fstatSync(fd).size;
  let offset = 12; // past RIFF header
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataSize = 0;

  const chunkHeader = Buffer.alloc(8);

  while (offset < fileSize - 8) {
    fs.readSync(fd, chunkHeader, 0, 8, offset);
    const chunkId = chunkHeader.toString('ascii', 0, 4);
    const chunkSize = chunkHeader.readUInt32LE(4);

    if (chunkId === 'fmt ') {
      const fmt = Buffer.alloc(Math.min(chunkSize, 40));
      fs.readSync(fd, fmt, 0, fmt.length, offset + 8);
      channels = fmt.readUInt16LE(2);
      sampleRate = fmt.readUInt32LE(4);
      bitsPerSample = fmt.readUInt16LE(14);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }

    // Advance to next chunk (chunks are 2-byte aligned)
    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset++;
  }

  if (sampleRate === 0 || dataOffset === 0) return null;

  return { sampleRate, channels, bitsPerSample, dataOffset, dataSize };
}

function analyzeWav(filePath: string): ActiveRegion | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }

  try {
    const info = parseWavHeader(fd);
    if (!info) return null;

    return analyzePcmData(
      fd,
      info.dataOffset,
      info.dataSize,
      info.sampleRate,
      info.channels,
      info.bitsPerSample,
      false,
    );
  } finally {
    fs.closeSync(fd);
  }
}

// ─── AIFF Analysis ───

interface AiffInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

function parseAiffHeader(fd: number): AiffInfo | null {
  const header = Buffer.alloc(12);
  const bytesRead = fs.readSync(fd, header, 0, 12, 0);
  if (bytesRead < 12) return null;

  const formId = header.toString('ascii', 0, 4);
  const aiffId = header.toString('ascii', 8, 12);
  if (formId !== 'FORM' || (aiffId !== 'AIFF' && aiffId !== 'AIFC')) {
    return null;
  }

  const fileSize = fs.fstatSync(fd).size;
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataSize = 0;

  const chunkHeader = Buffer.alloc(8);

  while (offset < fileSize - 8) {
    fs.readSync(fd, chunkHeader, 0, 8, offset);
    const chunkId = chunkHeader.toString('ascii', 0, 4);
    const chunkSize = chunkHeader.readUInt32BE(4);

    if (chunkId === 'COMM') {
      const comm = Buffer.alloc(Math.min(chunkSize, 26));
      fs.readSync(fd, comm, 0, comm.length, offset + 8);
      channels = comm.readInt16BE(0);
      bitsPerSample = comm.readInt16BE(6);
      // Sample rate is an 80-bit IEEE 754 extended float at offset 8
      sampleRate = parseIeee80(comm, 8);
    } else if (chunkId === 'SSND') {
      // SSND chunk has 8 bytes of offset+blockSize before data
      const ssndHeader = Buffer.alloc(8);
      fs.readSync(fd, ssndHeader, 0, 8, offset + 8);
      const ssndOffset = ssndHeader.readUInt32BE(0);
      dataOffset = offset + 8 + 8 + ssndOffset;
      dataSize = chunkSize - 8 - ssndOffset;
      break;
    }

    // Advance to next chunk (chunks are 2-byte aligned in AIFF)
    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset++;
  }

  if (sampleRate === 0 || dataOffset === 0) return null;

  return { sampleRate, channels, bitsPerSample, dataOffset, dataSize };
}

/**
 * Parse an IEEE 754 80-bit extended precision float (used for AIFF sample rate).
 */
function parseIeee80(buf: Buffer, offset: number): number {
  const exponent = ((buf[offset] & 0x7f) << 8) | buf[offset + 1];
  const sign = buf[offset] & 0x80 ? -1 : 1;

  // Read mantissa as a 64-bit unsigned integer
  let mantissa = 0;
  for (let i = 0; i < 8; i++) {
    mantissa = mantissa * 256 + buf[offset + 2 + i];
  }

  if (exponent === 0 && mantissa === 0) return 0;

  // Bias is 16383 for 80-bit extended
  const f = sign * Math.pow(2, exponent - 16383) * (mantissa / Math.pow(2, 63));
  return Math.round(f);
}

function analyzeAiff(filePath: string): ActiveRegion | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }

  try {
    const info = parseAiffHeader(fd);
    if (!info) return null;

    return analyzePcmData(
      fd,
      info.dataOffset,
      info.dataSize,
      info.sampleRate,
      info.channels,
      info.bitsPerSample,
      true,
    );
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Shared PCM Analysis ───

/**
 * Analyze raw PCM data to find the active (non-silent) region.
 *
 * Bidirectional scan capped to MAX_SCAN_SECONDS from each end:
 *   1. Forward: scan up to 60s from the start → find first non-silent block
 *   2. Backward: scan up to 60s from the end → find last non-silent block
 * If silence extends beyond 60s, we report the cap as the boundary.
 */
function analyzePcmData(
  fd: number,
  dataOffset: number,
  dataSize: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number,
  bigEndian: boolean,
): ActiveRegion | null {
  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  const bytesPerFrame = bytesPerSample * channels;
  if (bytesPerFrame === 0 || sampleRate === 0) return null;

  const totalFrames = Math.floor(dataSize / bytesPerFrame);
  if (totalFrames === 0) return null;

  const totalDuration = totalFrames / sampleRate;
  const blockBytes = BLOCK_SIZE * bytesPerFrame;
  const readBuf = Buffer.alloc(blockBytes);

  const readSample = getSampleReader(bitsPerSample, bigEndian);
  if (!readSample) return null;

  // Max blocks to scan from each end
  const maxScanFrames = Math.min(totalFrames, Math.ceil(MAX_SCAN_SECONDS * sampleRate));
  const maxScanBlocks = Math.ceil(maxScanFrames / BLOCK_SIZE);
  const totalBlocks = Math.ceil(totalFrames / BLOCK_SIZE);

  // ── Forward scan: find the first non-silent block (up to 60s) ──
  let firstNonSilentBlock = -1;
  const forwardLimit = Math.min(maxScanBlocks, totalBlocks);
  for (let block = 0; block < forwardLimit; block++) {
    const blockOffset = dataOffset + block * blockBytes;
    const remaining = dataOffset + dataSize - blockOffset;
    const toRead = Math.min(blockBytes, remaining);
    if (toRead <= 0) break;

    const bytesRead = fs.readSync(fd, readBuf, 0, toRead, blockOffset);
    if (bytesRead === 0) break;

    const framesInBlock = Math.floor(bytesRead / bytesPerFrame);
    if (isBlockNonSilent(readBuf, framesInBlock, bytesPerFrame, bytesPerSample, readSample)) {
      firstNonSilentBlock = block;
      break;
    }
  }

  // If no audio found in first 60s, assume start is at 0 (the silence
  // is extremely long — just use the start rather than scanning the whole file)
  const startSeconds =
    firstNonSilentBlock >= 0 ? (firstNonSilentBlock * BLOCK_SIZE) / sampleRate : 0;

  // ── Backward scan: find the last non-silent block (up to 60s from end) ──
  let lastNonSilentBlock = -1;
  const backwardStart = totalBlocks - 1;
  const backwardLimit = Math.max(0, totalBlocks - maxScanBlocks);
  for (let block = backwardStart; block >= backwardLimit; block--) {
    const blockOffset = dataOffset + block * blockBytes;
    const remaining = dataOffset + dataSize - blockOffset;
    const toRead = Math.min(blockBytes, remaining);
    if (toRead <= 0) continue;

    const bytesRead = fs.readSync(fd, readBuf, 0, toRead, blockOffset);
    if (bytesRead === 0) continue;

    const framesInBlock = Math.floor(bytesRead / bytesPerFrame);
    if (isBlockNonSilent(readBuf, framesInBlock, bytesPerFrame, bytesPerSample, readSample)) {
      lastNonSilentBlock = block;
      break;
    }
  }

  // If no audio found in last 60s, assume end is the full duration
  const endSeconds =
    lastNonSilentBlock >= 0
      ? Math.min(((lastNonSilentBlock + 1) * BLOCK_SIZE) / sampleRate, totalDuration)
      : totalDuration;

  return { startSeconds, endSeconds };
}

type SampleReader = (buf: Buffer, offset: number) => number;

function getSampleReader(bitsPerSample: number, bigEndian: boolean): SampleReader | null {
  if (bitsPerSample === 16) {
    return bigEndian
      ? (buf, off) => buf.readInt16BE(off) / 32768
      : (buf, off) => buf.readInt16LE(off) / 32768;
  }
  if (bitsPerSample === 24) {
    return bigEndian
      ? (buf, off) => {
          const val = (buf[off] << 16) | (buf[off + 1] << 8) | buf[off + 2];
          return (val > 0x7fffff ? val - 0x1000000 : val) / 8388608;
        }
      : (buf, off) => {
          const val = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
          return (val > 0x7fffff ? val - 0x1000000 : val) / 8388608;
        };
  }
  if (bitsPerSample === 32) {
    return bigEndian
      ? (buf, off) => buf.readInt32BE(off) / 2147483648
      : (buf, off) => buf.readInt32LE(off) / 2147483648;
  }
  // 8-bit unsigned
  if (bitsPerSample === 8) {
    return (_buf, off) => (_buf[off] - 128) / 128;
  }
  return null;
}

/**
 * Check if a block contains any non-silent audio.
 * Peak detection with early exit — returns true on the first loud sample.
 * Checks only channel 0 at every STRIDE-th frame (~256 checks per 262K-frame block).
 */
function isBlockNonSilent(
  buf: Buffer,
  frames: number,
  bytesPerFrame: number,
  bytesPerSample: number,
  readSample: SampleReader,
): boolean {
  if (frames === 0) return false;

  for (let f = 0; f < frames; f += STRIDE) {
    const sampleOffset = f * bytesPerFrame;
    if (sampleOffset + bytesPerSample > buf.length) break;
    const sample = readSample(buf, sampleOffset);
    if (sample > SILENCE_THRESHOLD || sample < -SILENCE_THRESHOLD) {
      return true;
    }
  }

  return false;
}
