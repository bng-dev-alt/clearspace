import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Token encryption at rest (RUN 02): AES-256-GCM (authenticated), random 96-bit IV per value, the AAD binds a
 * ciphertext to its owner and purpose (a refresh token copied into another user's row does not decrypt).
 * Envelope: v1.<key id>.<iv>.<ciphertext>.<tag>, base64url. The key id lets a rotation decrypt old values with
 * the previous key while new values use the current one. Node's built-in crypto only -- nothing hand-rolled.
 */
export interface Key { id: string; key: Buffer }
export interface KeyRing { current: Key; previous?: Key }

const b64u = (b: Buffer) => b.toString('base64url');

export function keyFromBase64(raw: string | undefined): Key {
  const key = Buffer.from((raw ?? '').trim(), 'base64');
  if (key.length !== 32) throw new Error('encryption key must be 32 bytes');
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 8), key };
}

export function seal(ring: KeyRing, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', ring.current.key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `v1.${ring.current.id}.${b64u(iv)}.${b64u(ct)}.${b64u(c.getAuthTag())}`;
}

export function open(ring: KeyRing, envelope: string, aad: string): string {
  const m = /^v1\.([0-9a-f]{8})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(envelope);
  if (!m) throw new Error('malformed envelope');
  const k = [ring.current, ring.previous].find((x) => x && x.id === m[1]);
  if (!k) throw new Error('unknown key id');
  const d = createDecipheriv('aes-256-gcm', k.key, Buffer.from(m[2], 'base64url'));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(Buffer.from(m[4], 'base64url'));
  return Buffer.concat([d.update(Buffer.from(m[3], 'base64url')), d.final()]).toString('utf8');
}

/** Sealed with a key that is no longer current (re-seal on the next write). */
export function isStale(ring: KeyRing, envelope: string): boolean {
  return !envelope.startsWith(`v1.${ring.current.id}.`);
}

export const tokenAad = (userId: string, purpose: 'refresh' | 'access' | 'pkce') => `clearspace:google:${purpose}:${userId}`;

export function randomToken(bytes = 32): string {
  return b64u(randomBytes(bytes));
}

export function sha256hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** PKCE (RFC 7636, S256). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  return { verifier, challenge: b64u(createHash('sha256').update(verifier, 'ascii').digest()) };
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
