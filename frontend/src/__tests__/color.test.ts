import { describe, expect, test } from 'vitest';
import { readableOn } from '../lib/color';

describe('RUN 11 readableOn: avatar text keeps AA contrast', () => {
  test('light member colours get dark text, dark ones stay white', () => {
    expect(readableOn('#209dd7')).toBe('#14171f'); // white on it = 3.2:1 (failed axe)
    expect(readableOn('#ecad0a')).toBe('#14171f');
    expect(readableOn('#753991')).toBe('#ffffff');
    expect(readableOn('#0b7d57')).toBe('#ffffff');
  });
  test('unknown values keep the old white', () => {
    expect(readableOn('var(--purple-secondary)')).toBe('#ffffff');
    expect(readableOn(undefined)).toBe('#ffffff');
  });
});
