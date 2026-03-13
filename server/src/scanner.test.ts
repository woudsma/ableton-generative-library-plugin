import { describe, it, expect } from 'vitest';
import { FileScanner } from './scanner.js';

// We test keyword extraction without needing a real database
// by instantiating the scanner with a mock/null db
describe('FileScanner — Keyword Extraction', () => {
  // Create a scanner with a mock db (we only test extractKeywords which doesn't use db)
  const scanner = new FileScanner(null as any);

  it('should extract KICK from "KICK_heavy_001.wav"', () => {
    const keywords = scanner.extractKeywords('KICK_heavy_001.wav');
    expect(keywords).toContain('KICK');
  });

  it('should extract HIHAT from "HIHAT_open_jam.aiff"', () => {
    const keywords = scanner.extractKeywords('HIHAT_open_jam.aiff');
    expect(keywords).toContain('HIHAT');
  });

  it('should extract SYNTH from "SYNTH_lead_session5.wav"', () => {
    const keywords = scanner.extractKeywords('SYNTH_lead_session5.wav');
    expect(keywords).toContain('SYNTH');
    expect(keywords).toContain('LEAD');
  });

  it('should extract DIGITAKT from "DIGITAKT_jam_20231015.wav"', () => {
    const keywords = scanner.extractKeywords('DIGITAKT_jam_20231015.wav');
    expect(keywords).toContain('DIGITAKT');
  });

  it('should extract PERCUSSION with hyphen separator', () => {
    const keywords = scanner.extractKeywords('PERCUSSION-session-003.wav');
    expect(keywords).toContain('PERCUSSION');
  });

  it('should extract FX from "FX_riser_long.flac"', () => {
    const keywords = scanner.extractKeywords('FX_riser_long.flac');
    expect(keywords).toContain('FX');
  });

  it('should extract BASS and SUB from "BASS_deep_sub.wav"', () => {
    const keywords = scanner.extractKeywords('BASS_deep_sub.wav');
    expect(keywords).toContain('BASS');
    expect(keywords).toContain('SUB');
  });

  it('should extract PAD and AMBIENT from "PAD ambient drone.wav"', () => {
    const keywords = scanner.extractKeywords('PAD ambient drone.wav');
    expect(keywords).toContain('PAD');
    expect(keywords).toContain('AMBIENT');
    // "drone" doesn't match DRUM — correct, tokens are split and matched exactly
    expect(keywords).not.toContain('DRUM');
  });

  it('should extract VOCAL from "VOCAL_harmony.mp3"', () => {
    const keywords = scanner.extractKeywords('VOCAL_harmony.mp3');
    expect(keywords).toContain('VOCAL');
  });

  it('should handle mixed case', () => {
    const keywords = scanner.extractKeywords('kick_Heavy_Session.wav');
    expect(keywords).toContain('KICK');
  });

  it('should handle filenames with dots', () => {
    const keywords = scanner.extractKeywords('HIHAT.open.bright.wav');
    expect(keywords).toContain('HIHAT');
  });

  it('should return empty for unrecognized filenames', () => {
    const keywords = scanner.extractKeywords('random_file_123.wav');
    expect(keywords).toHaveLength(0);
  });

  it('should extract DRUM from "DRUMS_full_kit.wav"', () => {
    const keywords = scanner.extractKeywords('DRUMS_full_kit.wav');
    expect(keywords).toContain('DRUM');
  });

  it('should extract multiple keywords from complex names', () => {
    const keywords = scanner.extractKeywords('KICK_SNARE_combo.wav');
    expect(keywords).toContain('KICK');
    expect(keywords).toContain('SNARE');
  });

  // New hardware / synth identifiers
  it('should extract JOMOX from "JOMOX_mbrane_jam.wav"', () => {
    const keywords = scanner.extractKeywords('JOMOX_mbrane_jam.wav');
    expect(keywords).toContain('JOMOX');
    expect(keywords).toContain('MBRANE');
  });

  it('should extract TR8S from "TR8S_kit_01.wav"', () => {
    const keywords = scanner.extractKeywords('TR8S_kit_01.wav');
    expect(keywords).toContain('TR8S');
  });

  it('should extract MODULAR from "MODULAR_patch_002.wav"', () => {
    const keywords = scanner.extractKeywords('MODULAR_patch_002.wav');
    expect(keywords).toContain('MODULAR');
  });

  it('should extract MINILOGUE from "MINILOGUE_arp.wav"', () => {
    const keywords = scanner.extractKeywords('MINILOGUE_arp.wav');
    expect(keywords).toContain('MINILOGUE');
  });

  it('should extract SERUM from "SERUM_lead_dirty.wav"', () => {
    const keywords = scanner.extractKeywords('SERUM_lead_dirty.wav');
    expect(keywords).toContain('SERUM');
    expect(keywords).toContain('LEAD');
  });

  it('should extract OCTA from "OCTA_slice_loop.wav"', () => {
    const keywords = scanner.extractKeywords('OCTA_slice_loop.wav');
    expect(keywords).toContain('OCTA');
  });

  it('should extract ABL3REC from "ABL3REC_session5.wav"', () => {
    const keywords = scanner.extractKeywords('ABL3REC_session5.wav');
    expect(keywords).toContain('ABL3REC');
  });

  it('should extract BD1 from "BD1_hard.wav"', () => {
    const keywords = scanner.extractKeywords('BD1_hard.wav');
    expect(keywords).toContain('BD1');
  });

  it('should extract CLOSEDHAT from "CLOSEDHAT_tight.wav"', () => {
    const keywords = scanner.extractKeywords('CLOSEDHAT_tight.wav');
    expect(keywords).toContain('CLOSEDHAT');
  });

  it('should extract LEXICON from "LEXICON2_reverb.wav"', () => {
    const keywords = scanner.extractKeywords('LEXICON2_reverb.wav');
    expect(keywords).toContain('LEXICON2');
  });

  it('should extract RAVE keywords from "RAVEGEN_stab.wav"', () => {
    const keywords = scanner.extractKeywords('RAVEGEN_stab.wav');
    expect(keywords).toContain('RAVEGEN');
  });
});

describe('FileScanner — Track Rule Matching', () => {
  const scanner = new FileScanner(null as any);

  it('should match keyword rule', () => {
    expect(scanner.matchesTrackRule('KICK_001.wav', ['KICK', 'BD'])).toBe(true);
  });

  it('should not match unrelated file', () => {
    expect(scanner.matchesTrackRule('SYNTH_pad.wav', ['KICK', 'BD'])).toBe(false);
  });

  it('should match regex rule', () => {
    expect(scanner.matchesTrackRule('custom_kick_01.wav', [], '^custom_kick')).toBe(true);
  });

  it('should fallback to keywords when regex fails', () => {
    expect(scanner.matchesTrackRule('KICK_x.wav', ['KICK'], '[invalid')).toBe(true);
  });
});
