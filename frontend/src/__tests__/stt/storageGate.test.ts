import { describe, it, expect } from 'vitest';
import { allowed } from '../../../e2e/support/storage-gate.mjs';

const ok = '/storage/v1/object/sign/meeting-audio/proj/meeting/audio.mp3?token=abc.def-1_2';
describe('storage gate (the only thing the real-Soniox tunnel exposes)', () => {
  it('allows GET/HEAD of a signed meeting-audio object URL only', () => {
    expect(allowed('GET', ok)).toBe(true);
    expect(allowed('HEAD', ok)).toBe(true);
  });
  it.each(['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'])('refuses %s', (m) => expect(allowed(m, ok)).toBe(false));
  it.each([
    '/auth/v1/health', '/rest/v1/?token=a', '/storage/v1/object/sign/other-bucket/x.mp3?token=a', '/storage/v1/object/meeting-audio/x.mp3?token=a',
    '/storage/v1/object/sign/meeting-audio/x.mp3', '/storage/v1/object/sign/meeting-audio/x.mp3?token=a&download=1', '/storage/v1/object/sign/meeting-audio/x.mp3?token=a b',
  ])('refuses %s', (u) => expect(allowed('GET', u)).toBe(false));
  it.each([
    '/storage/v1/object/sign/meeting-audio/../../../../auth/v1/settings?token=abc', '/storage/v1/object/sign/meeting-audio/./x.mp3?token=abc',
    '/storage/v1/object/sign/meeting-audio//x.mp3?token=abc', '/storage/v1/object/sign/meeting-audio/x/..?token=abc', '/storage/v1/object/sign/meeting-audio/%2e%2e/x?token=abc',
  ])('refuses path tricks: %s', (u) => expect(allowed('GET', u)).toBe(false));
});
