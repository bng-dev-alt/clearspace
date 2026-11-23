import { describe, it, expect } from 'vitest';
import { devLoginRefusal, isLoopbackHost, hostnameOf, type DevLoginEnv } from '../lib/devLogin';

const GOOD_ENV: DevLoginEnv = { nodeEnv: 'development', enabled: '1', email: 'dev@example.test', password: 'x' };
const goodHeaders = (extra: Record<string, string> = {}) =>
  new Headers({ host: '127.0.0.1:3410', 'x-clearspace-dev-login': '1', ...extra });

describe('dev login fails closed', () => {
  it('is allowed only when every condition holds', () => {
    expect(devLoginRefusal(GOOD_ENV, goodHeaders())).toBeNull();
    expect(devLoginRefusal(GOOD_ENV, goodHeaders({ host: 'localhost:3000', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-origin' }))).toBeNull();
    expect(devLoginRefusal(GOOD_ENV, goodHeaders({ host: '[::1]:3000' }))).toBeNull();
    // what `next dev` adds to a direct local request
    expect(devLoginRefusal(GOOD_ENV, goodHeaders({ 'x-forwarded-for': '::1', 'x-forwarded-host': '127.0.0.1:3410', 'x-forwarded-proto': 'http', 'x-forwarded-port': '3410' }))).toBeNull();
  });

  it.each([
    ['production build', { ...GOOD_ENV, nodeEnv: 'production' }],
    ['test build', { ...GOOD_ENV, nodeEnv: 'test' }],
    ['no NODE_ENV', { ...GOOD_ENV, nodeEnv: undefined }],
    ['flag missing', { ...GOOD_ENV, enabled: undefined }],
    ['flag not exactly 1', { ...GOOD_ENV, enabled: 'true' }],
    ['running on Vercel', { ...GOOD_ENV, vercel: '1' }],
    ['no dev account email', { ...GOOD_ENV, email: undefined }],
    ['no dev account password', { ...GOOD_ENV, password: '' }],
  ])('refuses: %s', (_n, env) => {
    expect(devLoginRefusal(env as DevLoginEnv, goodHeaders())).not.toBeNull();
  });

  it.each([
    ['public host', { host: 'clearspace-ai.vercel.app' }],
    ['LAN host', { host: '192.168.1.20:3000' }],
    ['tunnel host', { host: 'clearspace-origin.luffast.com' }],
    ['look-alike host', { host: '127.0.0.1.evil.example' }],
    ['no host', { host: '' }],
    ['x-forwarded-for naming a public client', { 'x-forwarded-for': '203.0.113.9' }],
    ['x-forwarded-for with a public hop', { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' }],
    ['x-real-ip public', { 'x-real-ip': '203.0.113.9' }],
    ['x-forwarded-host (proxy)', { 'x-forwarded-host': 'example.com' }],
    ['forwarded header', { forwarded: 'for=203.0.113.9' }],
    ['cloudflare tunnel header', { 'cf-connecting-ip': '203.0.113.9' }],
    ['vercel header', { 'x-vercel-id': 'fra1::abc' }],
    ['foreign origin', { origin: 'https://evil.example' }],
    ['cross-site fetch', { 'sec-fetch-site': 'cross-site' }],
    ['same-site (not same-origin) fetch', { 'sec-fetch-site': 'same-site' }],
    ['missing marker header', { 'x-clearspace-dev-login': '' }],
  ])('refuses: %s', (_n, extra) => {
    const e = extra as Record<string, string>;
    const h = goodHeaders(e);
    if (e['host'] === '') h.delete('host');
    if (e['x-clearspace-dev-login'] === '') h.delete('x-clearspace-dev-login');
    expect(devLoginRefusal(GOOD_ENV, h)).not.toBeNull();
  });

  it('parses host headers', () => {
    expect(hostnameOf('127.0.0.1:3000')).toBe('127.0.0.1');
    expect(hostnameOf('[::1]:3000')).toBe('[::1]');
    expect(isLoopbackHost('LOCALHOST:3000')).toBe(true);
    expect(isLoopbackHost('127.0.0.1.evil.example')).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
  });
});

describe('dev AUTO-login: extra server guards', () => {
  const AUTO_ENV: DevLoginEnv = { ...GOOD_ENV, autoEnabled: '1', supabaseUrl: 'http://127.0.0.1:55521' };
  const auto = (extra: Record<string, string> = {}) => goodHeaders({ 'x-clearspace-dev-login': 'auto', ...extra });
  it('allowed only against a loopback Supabase with the auto flag', () => {
    expect(devLoginRefusal(AUTO_ENV, auto())).toBeNull();
  });
  it.each([
    ['hosted Supabase', { ...AUTO_ENV, supabaseUrl: 'https://twjlnsxjtuntujarwner.supabase.co' }],
    ['LAN Supabase', { ...AUTO_ENV, supabaseUrl: 'http://192.168.1.20:55521' }],
    ['no Supabase URL', { ...AUTO_ENV, supabaseUrl: undefined }],
    ['auto flag missing', { ...AUTO_ENV, autoEnabled: undefined }],
    ['production build', { ...AUTO_ENV, nodeEnv: 'production' }],
    ['Vercel (staging or production)', { ...AUTO_ENV, vercel: 'preview' }],
    ['dev login disabled', { ...AUTO_ENV, enabled: undefined }],
  ])('refuses: %s', (_n, env) => {
    expect(devLoginRefusal(env as DevLoginEnv, auto())).not.toBeNull();
  });
  it.each([
    ['LAN host', { host: '192.168.1.5:3421' }],
    ['tunnel', { 'cf-ray': 'x' }],
    ['foreign origin', { origin: 'https://evil.example' }],
  ])('refuses non-local requests: %s', (_n, h) => {
    expect(devLoginRefusal(AUTO_ENV, auto(h))).not.toBeNull();
  });
});
