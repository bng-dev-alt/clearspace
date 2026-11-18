import { describe, it, expect } from 'vitest';
import { publicSignedUrl } from '../../lib/stt/pipeline';

const SIGNED = 'http://127.0.0.1:55521/storage/v1/object/sign/meeting-audio/p/m/a.mp3?token=abc.def.ghi';

describe('publicSignedUrl (test seam for the real local Soniox run)', () => {
  it('returns the URL unchanged when the seam is not configured', () => {
    expect(publicSignedUrl(SIGNED, {})).toBe(SIGNED);
  });
  it('swaps only the origin; path and signature stay', () => {
    expect(publicSignedUrl(SIGNED, { STT_TEST_PUBLIC_STORAGE_ORIGIN: 'https://abc-def.trycloudflare.com' }))
      .toBe('https://abc-def.trycloudflare.com/storage/v1/object/sign/meeting-audio/p/m/a.mp3?token=abc.def.ghi');
  });
  it('is IGNORED in production: a signed URL never leaves the project Storage', () => {
    expect(publicSignedUrl(SIGNED, { NODE_ENV: 'production', STT_TEST_PUBLIC_STORAGE_ORIGIN: 'https://evil.example.com' })).toBe(SIGNED);
  });
  it('accepts only a bare https origin (no http, no path, no credentials, no query)', () => {
    for (const bad of ['http://x.example.com', 'https://x.example.com/path', 'https://user:pw@x.example.com', 'https://x.example.com?a=1', 'ftp://x', 'x.example.com'])
      expect(publicSignedUrl(SIGNED, { STT_TEST_PUBLIC_STORAGE_ORIGIN: bad }), bad).toBe(SIGNED);
  });
});
