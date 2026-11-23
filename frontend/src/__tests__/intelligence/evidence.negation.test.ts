import { describe, test, expect } from 'vitest';
import {
  hasNegation,
  isCzech,
  negationAfterQuote,
  negationBeforeQuote,
  negationRisk,
  quoteSupported,
  validateMeetingBrief,
} from '../../lib/intelligence/evidence';

/** Negation / question guard of the lexical validator. A found quote is a text match, never a verification. */

describe('hasNegation: Czech and English negations', () => {
  test.each([
    'není', 'Nejde to', 'nejsme připraveni', 'nejsou data', 'nejsem si jistý', 'nejste tu', 'nemá smysl', 'nemám čas', 'nedá se to',
    'nedodáme to', 'nedokážeme to', 'nedostaneme schválení', 'nestihneme release', 'nikde to není', 'nikdo to neudělá', 'nic se nestalo',
    'nikdy', 'nikoli v pátek', 'nikoliv', 'žádný termín', 'žádnou změnu', 'žádné riziko', 'žádná odpověď', 'bez schválení', 'zrušit release',
    'zrušíme to', 'je to zrušeno', 'zrušili schůzku', 'odložit nasazení', 'odkládáme release', 'Ne, díky', 'ne.', 'nebudeme nasazovat',
    'we will not ship', 'there is no plan', 'never again', "we don't ship", "it doesn't work", "he didn't come", "we won't ship", "it isn't ready",
    "they aren't here", "it wasn't me", "they weren't ready", "we can't ship", "I couldn't", "we shouldn't", "it wouldn't", "we haven't", "it hasn't",
    "we hadn't", "ain't", "you mustn't", "you needn't", 'dont ship it', 'we cannot', 'release cancelled', 'release canceled', 'cancel the release',
    'postpone it', 'postponed to May', 'ship without tests', 'nobody knows', 'nothing happened', 'none of them', 'neither one', 'nor this',
  ])('negation: %s', (t) => expect(hasNegation(t), t).toBe(true));

  test.each([
    'kafe nebo čaj', 'v neděli', 'nejlepší varianta', 'udělejme to nejlépe', 'nejdřív testy', 'nejpozději v pátek', 'nejméně dva lidé', 'nejspíš to půjde',
    'nedávno jsme to měli', 'jdu do nemocnice', 'neustále se to mění', 'nesmírně důležité', 'někdo to zařídí', 'něco se stalo', 'několik lidí',
    'nasadíme release', 'we will ship', 'next week', 'we need a new network', 'je to nezbytné', 'Honza zítra nasadí release v pátek',
  ])('no negation: %s', (t) => expect(hasNegation(t), t).toBe(false));
});

describe('quoteSupported: ellipsis', () => {
  test.each([
    ['nasadíme release … v pátek ráno', 'Nasadíme release, ale ne v pátek ráno', false, 'negation in the elided gap'],
    ['nasadíme release … v pátek ráno', 'Nasadíme release určitě v pátek ráno', true, 'clean gap'],
    ['jsme … jsme', 'Dnes jsme rozhodli, že jsme hotovi', false, 'one-word parts are not evidence'],
    ['jsme hotovi … jsme hotovi', 'Dnes jsme hotovi a víme že jsme hotovi', false, 'identical parts'],
    ['nasadíme release … v pátek ráno', 'Nasadíme release a pak jedna dva tři čtyři pět šest sedm osm devět deset jedenáct dvanáct třináct v pátek ráno', false, 'gap longer than 12 words'],
    ['nasadíme release … v pátek ráno', 'Nasadíme release a pak jedna dva tři čtyři pět šest sedm osm devět deset v pátek ráno', true, 'gap within 12 words'],
    ['v pátek ráno … nasadíme release', 'Nasadíme release v pátek ráno', false, 'parts out of order'],
    ['5. května', 'Konference je 15. května', false, 'number 5 is not 15'],
    ['15. května', 'Konference je 5. května', false, 'number 15 is not 5'],
  ])('%s vs %s -> %s (%s)', (q, src, expected) => expect(quoteSupported(q, src)).toBe(expected));
});

describe('negationRisk: clause-aware window, questions, answers', () => {
  const claim = 'Release se nasazuje v pátek.';
  test('negation more than 3 words before the quote, in the same sentence', () => {
    expect(negationRisk(claim, 'nasadíme release v pátek', 'Honza říkal, že to nejde a že dnes ráno nasadíme release v pátek')).toBe(true);
  });
  test('negation AFTER the quote, also across a sentence boundary when it opens with a short answer', () => {
    expect(negationRisk('Release se posouvá na pátek.', 'release posuneme na pátek', 'Petr: release posuneme na pátek. Ne, to jsem nemyslel.')).toBe(true);
    expect(negationAfterQuote('release posuneme na pátek', 'Petr: release posuneme na pátek. Ne, to jsem nemyslel.')).toBe(true);
    expect(negationAfterQuote('release posuneme na pátek', 'Petr: release posuneme na pátek. Ano, dohodnuto.')).toBe(false);
  });
  test('negation in a previous, unrelated sentence does not flag (not a short answer)', () => {
    expect(negationRisk(claim, 'nasadíme release v pátek', 'Včera to nešlo. Nasadíme release v pátek.')).toBe(false);
    expect(negationBeforeQuote('nasadíme release v pátek', 'Ne. Nasadíme release v pátek.')).toBe(true);
  });
  test('repeated quote: first occurrence clean, second negated -> flagged', () => {
    const src = 'Release posuneme na pátek, řekl Petr. Honza: ne, release posuneme na pátek.';
    expect(negationRisk('Release se posouvá na pátek.', 'release posuneme na pátek', src)).toBe(true);
  });
  test('repeated quote: the cited segment holds the clean occurrence, the neighbour the negated one -> stays clean', () => {
    const a = 'Release posuneme na pátek.';
    const b = 'Honza: ne, release posuneme na pátek.';
    const src = `${a} ${b}`;
    expect(negationRisk('Release se posouvá na pátek.', 'release posuneme na pátek', src)).toBe(true); // no segment hint: conservative
    // a is clean on its own but its next clause is not a short answer: "Honza: ne, ..." opens with a speaker label, not an answer
    expect(negationRisk('Release se posouvá na pátek.', 'release posuneme na pátek', src, { citedRange: [0, a.length] })).toBe(false);
    expect(negationRisk('Release se posouvá na pátek.', 'release posuneme na pátek', src, { citedRange: [a.length + 1, src.length] })).toBe(true);
  });
  test('a question is not a statement (decision/action), unless the caller allows questions', () => {
    expect(negationRisk(claim, 'nasadíme release v pátek', 'Nasadíme release v pátek?')).toBe(true);
    expect(negationRisk(claim, 'nasadíme release v pátek', 'Nasadíme release v pátek?', { question: false })).toBe(false);
    expect(negationRisk(claim, 'nasadíme release v pátek', 'Petr: Nasadíme release v pátek.')).toBe(false);
  });
  test('"není to možné" vs claim "Je to možné."', () => {
    expect(negationRisk('Je to možné.', 'není to možné', 'Honza: není to možné.')).toBe(true);
  });
  test('English: "We can\'t ship on Friday" vs "ship on Friday"', () => {
    expect(negationRisk('We ship on Friday.', 'ship on Friday', "Pete: We can't ship on Friday.")).toBe(true);
    expect(negationRisk('We ship on Friday.', 'ship on Friday', 'Pete: We will ship on Friday.')).toBe(false);
  });
  test('ellipsis gap with a negation is flagged by the risk check too', () => {
    expect(negationRisk(claim, 'nasadíme … v pátek', 'Nasadíme, ale ne v pátek.')).toBe(true);
  });
  test('answer clauses: a negative answer always counts, an affirmative one only when the whole clause is short', () => {
    const c = 'Release se posouvá na pátek.';
    const q = 'release posuneme na pátek';
    expect(negationRisk(c, q, 'Release posuneme na pátek. Ne, to v pátek určitě nestihneme nasadit.')).toBe(true); // long, negative
    expect(negationRisk(c, q, 'Release posuneme na pátek. Jo, to nepůjde.')).toBe(true); // short, affirmative + negation
    expect(negationRisk(c, q, 'Release posuneme na pátek. Ano, ale ne v pátek.')).toBe(true);
    expect(negationRisk(c, q, 'Release posuneme na pátek. Ano, zákazník A nesmí za žádných okolností tušit, co řeší zákazník B.')).toBe(false);
    expect(negationRisk(c, q, 'Ano, zákazník A nesmí za žádných okolností tušit, co řeší zákazník B. Release posuneme na pátek.')).toBe(false);
  });
  test('Czech "No," is a filler, English "No," a negation; Czech "No, nebudeme." still flags', () => {
    expect(negationRisk('We ship on Friday.', 'ship on Friday', 'We ship on Friday. No, we will wait.')).toBe(true);
    expect(negationRisk('Release se posouvá na pátek.', 'release posuneme na pátek', 'Release posuneme na pátek. No, jedou vyloženě takzvaný minimum viable product.', { cs: true })).toBe(false);
    expect(negationRisk('Release se posouvá na pátek.', 'release posuneme na pátek', 'Release posuneme na pátek. No, nebudeme.', { cs: true })).toBe(true);
    expect(isCzech('Představme si stavbu letadla.')).toBe(true);
    expect(isCzech('We ship on Friday, no doubt.')).toBe(false);
    expect(isCzech('We ship on Friday.', 'cs')).toBe(true);
  });
  test('false-positive guards: nebo / neděle / nejlepší stay clean', () => {
    expect(negationRisk(claim, 'nasadíme release v pátek nebo v neděli', 'Nasadíme release v pátek nebo v neděli, nejlepší varianta.')).toBe(false);
  });
});

describe('validateMeetingBrief: the guard is wired in', () => {
  const T = (texts: string[]) => ({ speakers: [], segments: texts.map((text, i) => ({ id: `s${i}`, startMs: null, endMs: null, speakerId: null, text })) }) as never;
  const run = (texts: string[], raw: Record<string, unknown>) => {
    const r = validateMeetingBrief({ summary: 's', ...raw }, T(texts));
    if (!r.ok) throw new Error(r.message);
    return r.value;
  };
  const dec = (text: string, seg: string, quote: string) => ({ decisions: [{ text, evidence: [{ segment_id: seg, quote }] }] });

  test('Q/A across segments: quote from the question, answer "Ne, nebudeme." in the next segment -> decision dropped', () => {
    const v = run(['Nasadíme release v pátek?', 'Ne, nebudeme.'], dec('Release nasadíme v pátek.', 's0', 'Nasadíme release v pátek'));
    expect(v.items).toHaveLength(0);
    expect(v.rejectedCount).toBe(1);
  });
  test('the same question as evidence of a RISK stays reported, unverified or linked is not downgraded by "?" alone', () => {
    const v = run(['Nasadíme release v pátek?'], { open_questions: [{ text: 'Nasadí se release v pátek?', evidence: [{ segment_id: 's0', quote: 'Nasadíme release v pátek' }] }] });
    expect(v.items[0]).toMatchObject({ kind: 'open_question', support: 'linked' });
  });
  test('negation after the quote in the same segment: decision dropped, risk flagged', () => {
    const v = run(['Release posuneme na pátek. Ne, to jsem nemyslel.'], { risks: [{ text: 'Release se posouvá.', evidence: [{ segment_id: 's0', quote: 'release posuneme na pátek' }] }], ...dec('Release se posouvá na pátek.', 's0', 'release posuneme na pátek') });
    expect(v.items.find((i) => i.kind === 'decision')).toBeUndefined();
    expect(v.items.find((i) => i.kind === 'risk')!.evidence[0]).toMatchObject({ quoteFound: true, flag: 'negation_nearby' });
  });
  test('ellipsis "nasadíme … v pátek" does not support "Nasadíme, ale ne v pátek"', () => {
    const v = run(['Nasadíme, ale ne v pátek.'], { risks: [{ text: 'Nasazení v pátek.', evidence: [{ segment_id: 's0', quote: 'nasadíme … v pátek' }] }] });
    expect(v.items[0]).toMatchObject({ support: 'unverified' });
    expect(v.items[0].evidence[0].quoteFound).toBe(false);
  });
  test('the original probe: "budeme nasazovat v pátek" is not found in "nebudeme nasazovat v pátek"', () => {
    const v = run(['Petr: nebudeme nasazovat v pátek.'], { risks: [{ text: 'Nasazování v pátek.', evidence: [{ segment_id: 's0', quote: 'budeme nasazovat v pátek' }] }] });
    expect(v.items[0]).toMatchObject({ support: 'unverified' });
    expect(v.items[0].evidence[0].quoteFound).toBe(false);
  });
  test('a plain clean quote with nebo / neděle / nejlepší stays linked and unflagged', () => {
    const v = run(['Petr: Nasadíme release v pátek nebo v neděli, nejlepší varianta.'], dec('Release nasadíme v pátek nebo v neděli.', 's0', 'nasadíme release v pátek nebo v neděli'));
    expect(v.items[0]).toMatchObject({ kind: 'decision', support: 'linked' });
    expect(v.items[0].evidence[0].flag).toBeUndefined();
  });
  test('cited segment holds a clean occurrence while the neighbour segment repeats it negated: stays linked', () => {
    const v = run(['Nasadíme release v pátek.', 'Honza: ne, nasadíme release v pátek.'], dec('Release nasadíme v pátek.', 's0', 'nasadíme release v pátek'));
    expect(v.items).toHaveLength(1);
  });
});
