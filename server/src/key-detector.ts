import fs from 'fs';
// @ts-expect-error — fft.js has no type definitions
import FFT from 'fft.js';

/**
 * Musical key detection for audio files.
 *
 * Reads PCM audio data (WAV/AIFF only), computes a chromagram via FFT,
 * and matches against Krumhansl-Schmuckler key profiles to determine
 * the most likely musical key.
 *
 * Returns keys in standard notation: "C", "C#", "D", ... "B" for major,
 * "Cm", "C#m", "Dm", ... "Bm" for minor.
 *
 * Also provides Camelot wheel compatibility for harmonic mixing.
 */

// ─── Constants ───

/** Max seconds of audio to analyze. */
const ANALYSIS_SECONDS = 30;

/** FFT window size (must be power of 2). */
const FFT_SIZE = 4096;

/** Hop size between FFT windows (50% overlap). */
const HOP_SIZE = 2048;

/** Minimum frequency to consider (Hz) — below this is mostly rumble. */
const MIN_FREQ = 60;

/** Maximum frequency to consider (Hz) — above this pitch classes blur. */
const MAX_FREQ = 5000;

/** The 12 pitch class names. Index 0 = C. */
const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Krumhansl-Schmuckler major key profile.
 * Correlation weights for each pitch class relative to the tonic.
 */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];

/**
 * Krumhansl-Schmuckler minor key profile.
 */
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

// ─── Camelot Wheel ───

/**
 * Camelot wheel mapping: key name → Camelot code.
 * A = minor keys, B = major keys.
 */
const KEY_TO_CAMELOT: Record<string, string> = {
  'G#m': '1A',
  B: '1B',
  'D#m': '2A',
  'F#': '2B',
  'A#m': '3A',
  'C#': '3B',
  Fm: '4A',
  'G#': '4B',
  Cm: '5A',
  'D#': '5B',
  Gm: '6A',
  'A#': '6B',
  Dm: '7A',
  F: '7B',
  Am: '8A',
  C: '8B',
  Em: '9A',
  G: '9B',
  Bm: '10A',
  D: '10B',
  'F#m': '11A',
  A: '11B',
  'C#m': '12A',
  E: '12B',
};

const CAMELOT_TO_KEY: Record<string, string> = {};
for (const [key, camelot] of Object.entries(KEY_TO_CAMELOT)) {
  CAMELOT_TO_KEY[camelot] = key;
}

/**
 * Get harmonically compatible keys using the Camelot wheel.
 * Compatible means: same position, ±1 on the wheel, or inner/outer ring (relative major/minor).
 * Returns the input key plus all compatible keys.
 */
export function getCompatibleKeys(key: string): string[] {
  const camelot = KEY_TO_CAMELOT[key];
  if (!camelot) return [key];

  const num = parseInt(camelot.slice(0, -1), 10);
  const letter = camelot.slice(-1); // 'A' or 'B'

  const compatible = new Set<string>();
  compatible.add(key); // always include self

  // Same position (inner/outer ring — relative major/minor)
  compatible.add(CAMELOT_TO_KEY[`${num}A`]);
  compatible.add(CAMELOT_TO_KEY[`${num}B`]);

  // +1 on the wheel
  const next = num === 12 ? 1 : num + 1;
  compatible.add(CAMELOT_TO_KEY[`${next}${letter}`]);

  // -1 on the wheel
  const prev = num === 1 ? 12 : num - 1;
  compatible.add(CAMELOT_TO_KEY[`${prev}${letter}`]);

  return [...compatible];
}

// ─── Entry Point ───

/**
 * Detect the musical key of an audio file.
 * Reads ~30s of PCM from the middle of the active region.
 * Returns null for unsupported formats or on error.
 */
export function detectKey(
  filePath: string,
  activeStartSeconds?: number | null,
  activeEndSeconds?: number | null,
): string | null {
  // Skip files with no meaningful active region (silent or failed analysis)
  if (activeStartSeconds != null && activeEndSeconds != null) {
    if (activeStartSeconds < 0 || activeEndSeconds <= 0) return null;
    if (activeEndSeconds - activeStartSeconds < 1) return null; // less than 1s of audio
  }

  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();

  if (ext === '.wav') {
    return analyzeWavKey(filePath, activeStartSeconds, activeEndSeconds);
  } else if (ext === '.aiff' || ext === '.aif') {
    return analyzeAiffKey(filePath, activeStartSeconds, activeEndSeconds);
  }

  return null;
}

// ─── WAV ───

interface AudioInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

function parseWavHeader(fd: number): AudioInfo | null {
  const header = Buffer.alloc(44);
  const bytesRead = fs.readSync(fd, header, 0, 44, 0);
  if (bytesRead < 44) return null;

  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
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

    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset++;
  }

  if (sampleRate === 0 || dataOffset === 0) return null;
  return { sampleRate, channels, bitsPerSample, dataOffset, dataSize };
}

function analyzeWavKey(
  filePath: string,
  activeStart?: number | null,
  activeEnd?: number | null,
): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }

  try {
    const info = parseWavHeader(fd);
    if (!info) return null;
    return analyzeKeyFromPcm(fd, info, false, activeStart, activeEnd);
  } finally {
    fs.closeSync(fd);
  }
}

// ─── AIFF ───

function parseAiffHeader(fd: number): AudioInfo | null {
  const header = Buffer.alloc(12);
  const bytesRead = fs.readSync(fd, header, 0, 12, 0);
  if (bytesRead < 12) return null;

  const formId = header.toString('ascii', 0, 4);
  const aiffId = header.toString('ascii', 8, 12);
  if (formId !== 'FORM' || (aiffId !== 'AIFF' && aiffId !== 'AIFC')) return null;

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
      sampleRate = parseIeee80(comm, 8);
    } else if (chunkId === 'SSND') {
      const ssndHeader = Buffer.alloc(8);
      fs.readSync(fd, ssndHeader, 0, 8, offset + 8);
      const ssndOffset = ssndHeader.readUInt32BE(0);
      dataOffset = offset + 8 + 8 + ssndOffset;
      dataSize = chunkSize - 8 - ssndOffset;
      break;
    }

    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset++;
  }

  if (sampleRate === 0 || dataOffset === 0) return null;
  return { sampleRate, channels, bitsPerSample, dataOffset, dataSize };
}

function parseIeee80(buf: Buffer, offset: number): number {
  const exponent = ((buf[offset] & 0x7f) << 8) | buf[offset + 1];
  const sign = buf[offset] & 0x80 ? -1 : 1;
  let mantissa = 0;
  for (let i = 0; i < 8; i++) {
    mantissa = mantissa * 256 + buf[offset + 2 + i];
  }
  if (exponent === 0 && mantissa === 0) return 0;
  return Math.round(sign * Math.pow(2, exponent - 16383) * (mantissa / Math.pow(2, 63)));
}

function analyzeAiffKey(
  filePath: string,
  activeStart?: number | null,
  activeEnd?: number | null,
): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return null;
  }

  try {
    const info = parseAiffHeader(fd);
    if (!info) return null;
    return analyzeKeyFromPcm(fd, info, true, activeStart, activeEnd);
  } finally {
    fs.closeSync(fd);
  }
}

// ─── Sample Reader ───

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
  if (bitsPerSample === 8) {
    return (_buf, off) => (_buf[off] - 128) / 128;
  }
  return null;
}

// ─── Core Analysis ───

/**
 * Read PCM samples, compute chromagram, match key profiles.
 */
function analyzeKeyFromPcm(
  fd: number,
  info: AudioInfo,
  bigEndian: boolean,
  activeStart?: number | null,
  activeEnd?: number | null,
): string | null {
  const { sampleRate, channels, bitsPerSample, dataOffset, dataSize } = info;
  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  const bytesPerFrame = bytesPerSample * channels;
  if (bytesPerFrame === 0 || sampleRate === 0) return null;

  const totalFrames = Math.floor(dataSize / bytesPerFrame);
  if (totalFrames === 0) return null;

  const totalDuration = totalFrames / sampleRate;
  const readSample = getSampleReader(bitsPerSample, bigEndian);
  if (!readSample) return null;

  // Determine the analysis region (centered in the active/non-silent area)
  const regionStart = activeStart != null && activeStart >= 0 ? activeStart : 0;
  const regionEnd = activeEnd != null && activeEnd > 0 ? activeEnd : totalDuration;
  const regionDuration = regionEnd - regionStart;

  // Take up to ANALYSIS_SECONDS from the center of the active region
  const analysisDuration = Math.min(ANALYSIS_SECONDS, regionDuration);
  const analysisStart = regionStart + (regionDuration - analysisDuration) / 2;

  const startFrame = Math.floor(analysisStart * sampleRate);
  const framesToRead = Math.floor(analysisDuration * sampleRate);
  if (framesToRead < FFT_SIZE) return null; // not enough audio

  // Read all required PCM into a mono float array
  const monoSamples = readMonoSamples(
    fd,
    dataOffset,
    bytesPerFrame,
    bytesPerSample,
    channels,
    startFrame,
    framesToRead,
    readSample,
  );
  if (monoSamples.length < FFT_SIZE) return null;

  // Build chromagram via FFT
  const chromagram = buildChromagram(monoSamples, sampleRate);

  // Match against key profiles
  return matchKeyProfile(chromagram);
}

/**
 * Read PCM frames and mix to mono.
 */
function readMonoSamples(
  fd: number,
  dataOffset: number,
  bytesPerFrame: number,
  bytesPerSample: number,
  channels: number,
  startFrame: number,
  frameCount: number,
  readSample: SampleReader,
): Float64Array {
  const mono = new Float64Array(frameCount);
  const blockFrames = 65536; // read in ~0.5MB chunks
  const blockBytes = blockFrames * bytesPerFrame;
  const buf = Buffer.alloc(blockBytes);

  let written = 0;
  let remaining = frameCount;

  while (remaining > 0) {
    const toReadFrames = Math.min(blockFrames, remaining);
    const toReadBytes = toReadFrames * bytesPerFrame;
    const fileOffset = dataOffset + (startFrame + written) * bytesPerFrame;

    const bytesRead = fs.readSync(fd, buf, 0, toReadBytes, fileOffset);
    const framesRead = Math.floor(bytesRead / bytesPerFrame);
    if (framesRead === 0) break;

    for (let f = 0; f < framesRead; f++) {
      let sum = 0;
      const frameOffset = f * bytesPerFrame;
      for (let ch = 0; ch < channels; ch++) {
        sum += readSample(buf, frameOffset + ch * bytesPerSample);
      }
      mono[written + f] = sum / channels;
    }

    written += framesRead;
    remaining -= framesRead;
  }

  return written === frameCount ? mono : mono.subarray(0, written);
}

/**
 * Build a 12-bin chromagram from mono audio using FFT.
 */
function buildChromagram(samples: Float64Array, sampleRate: number): Float64Array {
  const chromagram = new Float64Array(12);
  const fft = new FFT(FFT_SIZE);
  const output = fft.createComplexArray();
  const windowedBlock = new Array(FFT_SIZE);

  // Precompute Hann window
  const hannWindow = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) {
    hannWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)));
  }

  // Frequency resolution
  const freqPerBin = sampleRate / FFT_SIZE;
  const minBin = Math.ceil(MIN_FREQ / freqPerBin);
  const maxBin = Math.floor(MAX_FREQ / freqPerBin);

  // Precompute bin → pitch class mapping
  const binToPitchClass = new Int8Array(maxBin + 1);
  for (let bin = minBin; bin <= maxBin; bin++) {
    const freq = bin * freqPerBin;
    // MIDI note number: 69 = A4 = 440Hz
    const midi = 12 * Math.log2(freq / 440) + 69;
    const pitchClass = ((Math.round(midi) % 12) + 12) % 12;
    binToPitchClass[bin] = pitchClass;
  }

  let windowCount = 0;
  const totalWindows = Math.floor((samples.length - FFT_SIZE) / HOP_SIZE) + 1;

  for (let start = 0; start + FFT_SIZE <= samples.length; start += HOP_SIZE) {
    // Apply Hann window
    for (let i = 0; i < FFT_SIZE; i++) {
      windowedBlock[i] = samples[start + i] * hannWindow[i];
    }

    // Run FFT (real input → complex output)
    fft.realTransform(output, windowedBlock);
    fft.completeSpectrum(output);

    // Accumulate energy per pitch class
    for (let bin = minBin; bin <= maxBin; bin++) {
      const re = output[bin * 2];
      const im = output[bin * 2 + 1];
      const magnitude = Math.sqrt(re * re + im * im);
      chromagram[binToPitchClass[bin]] += magnitude;
    }

    windowCount++;
  }

  // Normalize
  if (windowCount > 0) {
    for (let i = 0; i < 12; i++) {
      chromagram[i] /= windowCount;
    }
  }

  return chromagram;
}

/**
 * Match a chromagram against all 24 major/minor key profiles.
 * Uses Pearson correlation with Krumhansl-Schmuckler profiles.
 */
function matchKeyProfile(chromagram: Float64Array): string {
  let bestKey = 'C';
  let bestCorrelation = -Infinity;

  for (let root = 0; root < 12; root++) {
    // Rotate chromagram so that `root` is at index 0
    const rotated = new Float64Array(12);
    for (let i = 0; i < 12; i++) {
      rotated[i] = chromagram[(i + root) % 12];
    }

    // Correlate with major profile
    const majorCorr = pearsonCorrelation(rotated, MAJOR_PROFILE);
    if (majorCorr > bestCorrelation) {
      bestCorrelation = majorCorr;
      bestKey = PITCH_CLASSES[root];
    }

    // Correlate with minor profile
    const minorCorr = pearsonCorrelation(rotated, MINOR_PROFILE);
    if (minorCorr > bestCorrelation) {
      bestCorrelation = minorCorr;
      bestKey = PITCH_CLASSES[root] + 'm';
    }
  }

  return bestKey;
}

/**
 * Pearson correlation coefficient between two arrays.
 */
function pearsonCorrelation(x: Float64Array, y: number[]): number {
  const n = x.length;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0,
    sumY2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
    sumXY += x[i] * y[i];
    sumX2 += x[i] * x[i];
    sumY2 += y[i] * y[i];
  }

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

  return denominator === 0 ? 0 : numerator / denominator;
}
