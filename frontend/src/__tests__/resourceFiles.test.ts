import { describe, it, expect } from 'vitest';
import { validateResourceFile, safeExtension, MAX_RESOURCE_BYTES, ALLOWED_RESOURCE_MIME } from '../services/resourceService';

describe('task attachment validation', () => {
  it('accepts allowed types up to the size limit', () => {
    expect(validateResourceFile({ size: 1024, type: 'image/png' })).toBeNull();
    expect(validateResourceFile({ size: MAX_RESOURCE_BYTES, type: 'application/pdf' })).toBeNull();
  });
  it('refuses oversized files', () => {
    expect(validateResourceFile({ size: MAX_RESOURCE_BYTES + 1, type: 'image/png' })).toMatch(/10 MB/);
  });
  it('refuses script-capable and unknown types', () => {
    for (const type of ['image/svg+xml', 'text/html', 'application/javascript', 'application/x-msdownload', '']) {
      expect(validateResourceFile({ size: 10, type }), type).not.toBeNull();
    }
  });
  it('allow-list matches the bucket migration (no svg/html/script)', () => {
    expect(ALLOWED_RESOURCE_MIME.some((m) => /svg|html|javascript|xml$/.test(m))).toBe(false);
  });
  it('extension cannot shape the storage path', () => {
    expect(safeExtension('report.PDF')).toBe('pdf');
    expect(safeExtension('a.b/../../evil')).toBe('evil');
    expect(safeExtension('noext')).toBe('bin');
    expect(safeExtension('x.' + 'a'.repeat(30))).toBe('a'.repeat(8));
    expect(safeExtension('weird.p-n_g')).toBe('png');
  });
});

import { checkResourceFile, classifyUploadError, effectiveMime, resourceErrorMessage, validateResourceFile as validate } from '../services/resourceService';

describe('upload refusals are distinguishable (and never leak server text)', () => {
  it('validation kinds', () => {
    expect(checkResourceFile({ name: 'a.pdf', size: 0, type: 'application/pdf' })).toBe('empty');
    expect(checkResourceFile({ name: 'a.pdf', size: MAX_RESOURCE_BYTES + 1, type: 'application/pdf' })).toBe('too_large');
    expect(checkResourceFile({ name: 'a.exe', size: 5, type: 'application/x-msdownload' })).toBe('type_not_allowed');
    expect(checkResourceFile({ name: 'a.pdf', size: 5, type: 'application/pdf' })).toBeNull();
  });
  it('an EMPTY browser type falls back to the extension, but only inside the allow-list', () => {
    expect(effectiveMime({ name: 'notes.md', type: '' })).toBe('text/markdown');
    expect(effectiveMime({ name: 'REPORT.PDF', type: '' })).toBe('application/pdf');
    expect(validate({ name: 'notes.md', size: 5, type: '' })).toBeNull();
    expect(validate({ name: 'x.svg', size: 5, type: '' })).not.toBeNull();
    expect(validate({ name: 'x.html', size: 5, type: '' })).not.toBeNull();
    expect(validate({ name: 'noext', size: 5, type: '' })).not.toBeNull();
    expect(effectiveMime({ name: 'a.pdf', type: 'application/octet-stream' })).toBe('application/octet-stream'); // a declared type is never overridden
  });
  it('Storage errors map by the body status code, not only the HTTP status', () => {
    // What the hosted Storage really answered for a non-member / unsaved card: HTTP 400, body statusCode "403"
    expect(classifyUploadError({ status: 400, statusCode: '403', message: 'new row violates row-level security policy' })).toBe('permission');
    expect(classifyUploadError({ statusCode: '413', message: 'The object exceeded the maximum allowed size' })).toBe('too_large');
    expect(classifyUploadError({ statusCode: '415', message: 'mime type text/html is not supported' })).toBe('type_not_allowed');
    expect(classifyUploadError({ statusCode: '404', message: 'Bucket not found' })).toBe('unavailable');
    expect(classifyUploadError({ status: 502, message: 'bad gateway' })).toBe('unavailable');
    expect(classifyUploadError({ message: 'jwt expired', status: 400 })).toBe('auth');
    expect(classifyUploadError({ message: 'Failed to fetch' })).toBe('network');
    expect(classifyUploadError({ code: '42501', message: 'permission denied' })).toBe('permission');
    expect(classifyUploadError({ message: 'something odd' })).toBe('unknown');
    expect(classifyUploadError(null)).toBe('unknown');
  });
  it('every kind has its own safe Czech text (no paths, keys or raw server messages)', () => {
    const kinds = ['too_large', 'type_not_allowed', 'empty', 'not_saved', 'permission', 'auth', 'unavailable', 'network', 'metadata', 'unknown'] as const;
    const texts = kinds.map((k) => resourceErrorMessage(k));
    expect(new Set(texts).size).toBe(kinds.length);
    for (const t of texts) expect(t).not.toMatch(/row-level|policy|storage\/v1|task-resources|tasks\/|eyJ/i);
  });
});
