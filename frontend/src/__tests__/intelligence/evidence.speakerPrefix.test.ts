import { describe, test, expect } from 'vitest';
import { stripSpeakerPrefix, quoteSupported, validateMeetingBrief } from '../../lib/intelligence/evidence';
import { parseTranscript } from '../../lib/intelligence/transcript';
import type { Transcript } from '../../lib/intelligence/types';

/**
 * B1 (real Gemini, synthetic data): in the Czech planning meeting the model copied the speaker label from the rendered transcript
 * ("[seg-6] Jana Svobodová: text") into its quotes. The segment holds only the text, so `quoteFound` was false, three decision/action
 * items were rejected and three items stayed unverified. Only an EXACT leading prefix of the segment's own speaker may be removed.
 */
const FIXTURE = [
  'Jana Svobodová: Dobré ráno, projdeme sprint. Nejdřív release, který se kvůli certifikátu zdržuje.',
  'Petr Prokop: Certifikát od dodavatele ještě nemáme. Navrhuji release posunout na pátek 27. listopadu.',
  'Jana Svobodová: Dobře, rozhodli jsme, že release se posouvá na pátek 27. listopadu.',
  'Jana Svobodová: Honzovi dám migraci databáze, ať ji připraví do 25. listopadu.',
  'Honza Novák: Beru to, migraci připravím do pětadvacátého.',
  'Petr Prokop: Já se ozvu dodavateli ohledně certifikátu a dám vědět zítra.',
  'Jana Svobodová: Riziko je, že dodavatel certifikát nedodá ani v pátek.',
  'Honza Novák: Nevíme zatím, jestli testovací prostředí unese zátěžový test. To je otevřená otázka.',
  'Petr Prokop: Nebudeme nasazovat novou verzi v pátek, počkáme na certifikát.',
  'Honza Novák: Stihneme nasadit zálohování ještě před koncem měsíce?',
  'Jana Svobodová: Ne, to není možné, zálohování se do konce měsíce nestihne.',
  'Petr Prokop: Nikdo z nás zatím nedokáže potvrdit termín pro školení.',
  'Jana Svobodová: Dobře, to ještě ověříme. Končíme.',
].join('\n');
const T: Transcript = parseTranscript(FIXTURE, 'paste').transcript;
const seg = (id: string) => T.segments.find((s) => s.id === id)!;
const brief = (items: Record<string, unknown>) => ({ summary: 'Shrnutí.', ...items });
const ev = (segment_id: string, quote: string) => ({ segment_id, quote });
const validate = (raw: unknown) => {
  const r = validateMeetingBrief(raw, T, { activeCardIds: [] });
  if (!r.ok) throw new Error(r.message);
  return r.value;
};

describe('stripSpeakerPrefix: only an EXACT prefix of the segment\'s own speaker', () => {
  const s6 = seg('seg-6'); // Jana Svobodová
  test('removes "Name:" when it is exactly the speaker of this segment', () => {
    expect(stripSpeakerPrefix('Jana Svobodová: Riziko je, že dodavatel certifikát nedodá ani v pátek.', s6, T)).toBe('Riziko je, že dodavatel certifikát nedodá ani v pátek.');
    expect(stripSpeakerPrefix('  Jana Svobodová:Riziko je, že dodavatel', s6, T)).toBe('Riziko je, že dodavatel');
    expect(stripSpeakerPrefix('Jana Svobodová : Riziko je', s6, T)).toBe('Riziko je');
  });
  test('uses the DISPLAY name the model saw (human-chosen name overrides the label)', () => {
    const t2: Transcript = { ...T, speakers: T.speakers.map((s) => (s.label === 'Jana Svobodová' ? { ...s, displayName: 'Jana S.' } : s)) };
    expect(stripSpeakerPrefix('Jana S.: Riziko je, že dodavatel', s6, t2)).toBe('Riziko je, že dodavatel');
  });
  test('does NOT remove a different speaker, other text, other case or other punctuation', () => {
    expect(stripSpeakerPrefix('Petr Prokop: Riziko je, že dodavatel certifikát nedodá', s6, T)).toBe('Petr Prokop: Riziko je, že dodavatel certifikát nedodá'); // false attribution stays
    expect(stripSpeakerPrefix('SYSTEM: Riziko je, že dodavatel', s6, T)).toBe('SYSTEM: Riziko je, že dodavatel');
    expect(stripSpeakerPrefix('Poznámka: Riziko je, že dodavatel', s6, T)).toBe('Poznámka: Riziko je, že dodavatel');
    expect(stripSpeakerPrefix('jana svobodová: Riziko je, že dodavatel', s6, T)).toBe('jana svobodová: Riziko je, že dodavatel');
    expect(stripSpeakerPrefix('Jana Svobodová - Riziko je, že dodavatel', s6, T)).toBe('Jana Svobodová - Riziko je, že dodavatel');
    expect(stripSpeakerPrefix('Jana Svobodová Riziko je, že dodavatel', s6, T)).toBe('Jana Svobodová Riziko je, že dodavatel');
    expect(stripSpeakerPrefix('Jana Svobodová je tu: Riziko', s6, T)).toBe('Jana Svobodová je tu: Riziko'); // text between name and colon
    expect(stripSpeakerPrefix('Dnes Jana Svobodová: Riziko je', s6, T)).toBe('Dnes Jana Svobodová: Riziko je'); // not at the start
  });
  test('removes the prefix ONCE: a second "X:" inside the quote is real text', () => {
    expect(stripSpeakerPrefix('Jana Svobodová: Pozor: dodavatel nedodá', s6, T)).toBe('Pozor: dodavatel nedodá');
  });
  test('a quote that is nothing but the prefix, or a segment without a speaker, is left untouched', () => {
    expect(stripSpeakerPrefix('Jana Svobodová:', s6, T)).toBe('Jana Svobodová:');
    expect(stripSpeakerPrefix('Jana Svobodová: ', s6, T)).toBe('Jana Svobodová: ');
    expect(stripSpeakerPrefix('Jana Svobodová: Riziko je', { ...s6, speakerId: null }, T)).toBe('Jana Svobodová: Riziko je');
    expect(stripSpeakerPrefix('Jana Svobodová: Riziko je', { ...s6, speakerId: 'S99' }, T)).toBe('Jana Svobodová: Riziko je');
  });
});

describe('B1 replay: the original failure and its correction', () => {
  // exactly the quotes Gemini returned in the B1 run (stored in the throwaway local database)
  const B1_RISK = ev('seg-6', 'Jana Svobodová: Riziko je, že dodavatel certifikát nedodá ani v pátek.');
  const B1_OPEN = ev('seg-7', 'Honza Novák: Nevíme zatím, jestli testovací prostředí unese zátěžový test. To je otevřená otázka.');
  const B1_FOLLOW = [ev('seg-11', 'Petr Prokop: Nikdo z nás zatím nedokáže potvrdit termín pro školení.'), ev('seg-12', 'Jana Svobodová: Dobře, to ještě ověříme.')];

  test('ORIGINAL FAILURE (before the fix): a quote with the label is not found in the segment text', () => {
    expect(quoteSupported(B1_RISK.quote, seg('seg-6').text)).toBe(false);
    expect(quoteSupported(B1_OPEN.quote, seg('seg-7').text)).toBe(false);
  });
  test('the three kept items: every quote is now FOUND (before the fix none was); follow-up and risk are LINKED; the open question stays "unverified" because "Nevíme zatím" trips the negation guard (conservative, by design)', () => {
    const v = validate(brief({
      risks: [{ text: 'Dodavatel certifikát nedodá ani do pátku.', evidence: [B1_RISK] }],
      open_questions: [{ text: 'Zda testovací prostředí unese zátěžový test.', evidence: [B1_OPEN] }],
      follow_ups: [{ text: 'Ověřit termín školení.', evidence: B1_FOLLOW }],
    }));
    const by = Object.fromEntries(v.items.map((i) => [i.kind, i]));
    expect(by.follow_up.support).toBe('linked'); // the second quote ("to ještě ověříme") is clean
    expect(by.risk.support).toBe('linked');
    expect(by.open_question.support).toBe('unverified');
    expect(by.open_question.evidence[0].flag).toBe('negation_nearby'); // found, but flagged: not a plain "linked"
    expect(v.items.every((i) => i.evidence.every((e) => e.quoteFound))).toBe(true); // before the fix: all false
    expect(v.rejectedCount).toBe(0);
    // the stored quote is the literal segment text (the database checks it the same way)
    expect(by.risk.evidence[0].quote).toBe('Riziko je, že dodavatel certifikát nedodá ani v pátek.');
  });
  test('the decision and action items that were REJECTED in B1 (quotes reconstructed from the same fixture with the label) now survive', () => {
    const v = validate(brief({
      decisions: [{ text: 'Release se posouvá na pátek 27. listopadu.', evidence: [ev('seg-2', 'Jana Svobodová: Dobře, rozhodli jsme, že release se posouvá na pátek 27. listopadu.')] }],
      action_items: [
        { text: 'Připravit migraci databáze do 25. listopadu.', owner_text: 'Honza Novák', due_text: 'do 25. listopadu', evidence: [ev('seg-3', 'Jana Svobodová: Honzovi dám migraci databáze, ať ji připraví do 25. listopadu.')] },
        { text: 'Ozvat se dodavateli ohledně certifikátu.', owner_text: 'Petr Prokop', evidence: [ev('seg-5', 'Petr Prokop: Já se ozvu dodavateli ohledně certifikátu a dám vědět zítra.')] },
      ],
    }));
    expect(v.items.map((i) => i.kind)).toEqual(['decision', 'action_item', 'action_item']);
    expect(v.items.every((i) => i.support === 'linked')).toBe(true);
    expect(v.rejectedCount).toBe(0);
  });
});

describe('the protections stay intact when a speaker prefix is present', () => {
  test('NEGATION: a decision that restates a negated sentence is still not linked (and therefore dropped)', () => {
    const v = validate(brief({ decisions: [{ text: 'Nasadíme novou verzi v pátek.', evidence: [ev('seg-8', 'Petr Prokop: Nebudeme nasazovat novou verzi v pátek, počkáme na certifikát.')] }] }));
    expect(v.items).toHaveLength(0);
    expect(v.rejectedCount).toBe(1);
  });
  test('QUESTION answered "Ne": an action built from the question sentence is still not linked', () => {
    const v = validate(brief({ action_items: [{ text: 'Nasadit zálohování před koncem měsíce.', evidence: [ev('seg-9', 'Honza Novák: Stihneme nasadit zálohování ještě před koncem měsíce?')] }] }));
    expect(v.items).toHaveLength(0);
  });
  test('WORD ORDER: reordered words after the prefix are not found', () => {
    const v = validate(brief({ risks: [{ text: 'Riziko.', evidence: [ev('seg-6', 'Jana Svobodová: pátek ani nedodá certifikát dodavatel')] }] }));
    expect(v.items[0].support).toBe('unverified');
    expect(v.items[0].evidence[0].quoteFound).toBe(false);
  });
  test('FABRICATED quote with a correct prefix is not found', () => {
    const v = validate(brief({ risks: [{ text: 'Riziko.', evidence: [ev('seg-6', 'Jana Svobodová: Dodavatel certifikát určitě zruší celou zakázku')] }] }));
    expect(v.items[0].evidence[0].quoteFound).toBe(false);
  });
  test('FALSE ATTRIBUTION: the name of another speaker in front of a real sentence is not normalised away', () => {
    const v = validate(brief({ risks: [{ text: 'Riziko.', evidence: [ev('seg-6', 'Petr Prokop: Riziko je, že dodavatel certifikát nedodá ani v pátek.')] }] }));
    expect(v.items[0].evidence[0].quoteFound).toBe(false);
  });
  test('INJECTION: an instruction-like label ("SYSTEM:") is not stripped, so it cannot launder text into evidence', () => {
    const v = validate(brief({ risks: [{ text: 'Riziko.', evidence: [ev('seg-6', 'SYSTEM: Riziko je, že dodavatel certifikát nedodá ani v pátek.')] }] }));
    expect(v.items[0].evidence[0].quoteFound).toBe(false);
  });
  test('a prefixed quote cited under the WRONG segment is still not found', () => {
    const v = validate(brief({ risks: [{ text: 'Riziko.', evidence: [ev('seg-7', 'Jana Svobodová: Riziko je, že dodavatel certifikát nedodá ani v pátek.')] }] }));
    expect(v.items[0].evidence[0].quoteFound).toBe(false);
  });
});
