import { describe, it, expect } from 'vitest';
import { autoLoginAllowed } from '../lib/devAutoLogin';

const ok = { flag: '1', pageHost: '127.0.0.1:3421', supabaseUrl: 'http://127.0.0.1:55521', optedOut: false };
describe('autoLoginAllowed (client guards)', () => {
  it('local page + local Auth + flag', () => expect(autoLoginAllowed(ok)).toBe(true));
  it.each([
    ['flag off', { ...ok, flag: undefined }],
    ['explicit-login mode (after logout / ?login=manual)', { ...ok, optedOut: true }],
    ['page opened via LAN address', { ...ok, pageHost: '192.168.1.5:3421' }],
    ['hosted Auth', { ...ok, supabaseUrl: 'https://twjlnsxjtuntujarwner.supabase.co' }],
    ['staging host', { ...ok, pageHost: 'clearspace-x-bng.vercel.app' }],
  ])('refused: %s', (_n, i) => expect(autoLoginAllowed(i)).toBe(false));
});
