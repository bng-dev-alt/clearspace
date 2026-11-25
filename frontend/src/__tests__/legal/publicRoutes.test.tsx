import { describe, it, expect } from 'vitest';
import * as route from '../../app/api/dev/login/route';

describe('RUN 02C: /api/dev/login is indistinguishable from a missing route', () => {
  it.each(['GET', 'PUT', 'PATCH', 'DELETE'] as const)('%s -> 404 (no 405 that would reveal the helper)', async (m) => {
    const handler = (route as unknown as Record<string, () => Response>)[m];
    expect(typeof handler).toBe('function');
    expect(handler().status).toBe(404);
  });
});
