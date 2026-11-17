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
