import { describe, test, expect } from 'vitest';
import { classifyDue, suggestDueDate } from '../../lib/intelligence/dates';
import { nameVariants, sameGivenName } from '../../lib/intelligence/names';

const REF = '2026-11-18'; // středa
const d = (t: string, ref = REF) => suggestDueDate(t, ref)?.date ?? null;

describe('suggestDueDate: explicit dates', () => {
  test('Czech day + month name in any case', () => {
    expect(d('do 25. listopadu')).toBe('2026-11-25');
    expect(d('25. LISTOPADU')).toBe('2026-11-25');
    expect(d('3. prosince')).toBe('2026-12-03');
    expect(d('1. června')).toBe('2027-06-01'); // already passed this year -> next occurrence
    expect(d('15. července', '2026-03-01')).toBe('2026-07-15'); // červenec, not červen
    expect(d('15. června', '2026-03-01')).toBe('2026-06-15');
  });
  test('numeric d.m. and d. m. yyyy', () => {
    expect(d('do 25.11.')).toBe('2026-11-25');
    expect(d('25. 11. 2026')).toBe('2026-11-25');
    expect(d('2027-01-31')).toBe('2027-01-31');
  });
  test('next year when the date has already passed at the meeting', () => {
    expect(d('5. ledna', '2026-12-20')).toBe('2027-01-05');
    expect(d('18. listopadu')).toBe('2026-11-18'); // same day counts
  });
  test('impossible dates are refused, never rolled over', () => {
    expect(d('30. února')).toBeNull();
    expect(d('31.11.')).toBeNull();
    expect(d('2026-02-30')).toBeNull();
  });
  test('English month forms', () => {
    expect(d('November 25th')).toBe('2026-11-25');
    expect(d('25 Nov')).toBe('2026-11-25');
    expect(d('by Dec 3')).toBe('2026-12-03');
  });
});

describe('suggestDueDate: relative expressions (meeting day = Wednesday 2026-11-18)', () => {
  test('today, tomorrow, the day after', () => {
    expect(d('dnes')).toBe('2026-11-18');
    expect(d('zítra')).toBe('2026-11-19');
    expect(d('pozítří')).toBe('2026-11-20');
    expect(d('tomorrow')).toBe('2026-11-19');
  });
  test('in N days / weeks', () => {
    expect(d('za 3 dny')).toBe('2026-11-21');
    expect(d('za týden')).toBe('2026-11-25');
    expect(d('za 2 týdny')).toBe('2026-12-02');
    expect(d('in 2 weeks')).toBe('2026-12-02');
  });
  test('weekday = the nearest one STRICTLY after the meeting day', () => {
    expect(d('do pátku')).toBe('2026-11-20');
    expect(d('v pondělí')).toBe('2026-11-23');
    expect(d('ve středu')).toBe('2026-11-25'); // same weekday = next week, not today
    expect(d('by Friday')).toBe('2026-11-20');
    expect(d('next Monday')).toBe('2026-11-23');
  });
  test('"příští pátek" never lands in the same calendar week as the meeting', () => {
    expect(d('příští pátek')).toBe('2026-11-27');
    expect(d('next Friday')).toBe('2026-11-27');
  });
  test('end of week / next week / end of month', () => {
    expect(d('do konce týdne')).toBe('2026-11-20');
    expect(d('do konce týdne', '2026-11-21')).toBe('2026-11-27'); // meeting on Saturday
    expect(d('příští týden')).toBe('2026-11-27');
    expect(d('konec měsíce')).toBe('2026-11-30');
    expect(d('end of month', '2026-02-10')).toBe('2026-02-28');
  });
  test('kind says whether the date was in the text or computed', () => {
    expect(suggestDueDate('25. 11. 2026', REF)?.kind).toBe('exact');
    expect(suggestDueDate('zítra', REF)?.kind).toBe('relative');
  });
});

describe('suggestDueDate: no guessing', () => {
  test.each(['', '   ', 'brzy', 'někdy', 'ASAP', 'po dohodě'])('%j gives no suggestion', (t) => expect(d(t)).toBeNull());
  test('invalid reference day or null input', () => {
    expect(suggestDueDate(null, REF)).toBeNull();
    expect(suggestDueDate('zítra', 'nonsense')).toBeNull();
  });
});

describe('given-name aliases', () => {
  test('known groups', () => {
    expect(nameVariants('Honza')).toContain('jan');
    expect(sameGivenName('Kuba', 'Jakub')).toBe(true);
    expect(sameGivenName('Honza', 'Jakub')).toBe(false);
  });
  test('unknown names map to themselves (diacritics folded)', () => {
    expect(nameVariants('Šárka')).toEqual(['sarka']);
  });
});

describe('classifyDue: task deadline vs meeting/decision date vs milestone (Northstar)', () => {
  test.each([
    ['do 27. listopadu', 'Zvlášť když David také do 27. listopadu garantuje klíčový test bezpečnosti', 'deadline'],
    ['30. listopadu', 'Klára pak na to navazuje a do 30. listopadu musí vybrat ty konkrétní zákazníky', 'deadline'],
    ['hned 1. prosince', 'Klára k tomu teď zjišťuje data z praxe a finální rozhodnutí padne na další poradě hned 1. prosince.', 'meeting'],
    ['14. prosince', 'Ten pilotní provoz má totiž začít už 14. prosince.', 'milestone'],
    ['4. prosinec', 'Kritické datum pro to zpoždění je totiž 4. prosinec.', 'unknown'],
    ['by Friday', 'Pete will send it by Friday', 'deadline'],
    [null, 'x', 'unknown'],
  ])('%s -> %s', (due, cited, kind) => expect(classifyDue(due, cited)).toBe(kind));
});
