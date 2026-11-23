import { describe, test, expect } from 'vitest';
import { validateMeetingBrief } from '../../lib/intelligence/evidence';
import type { Transcript } from '../../lib/intelligence/types';
import fixture from './northstar.transcript.json';

/**
 * Regression from the owner's first real staging run (Northstar, 2026-11-23): Gemini returned 6 action items, the validator kept 4
 * (rejected_count = 2). The two dropped ones were real tasks whose cited sentence sits next to "Ano, zákazník A nesmí …": the
 * negation guard treated that long affirmative statement as a short answer negating the quote. Czech filler "No," at the start of
 * the next segment likewise flagged the MVP decision. Quotes below are the shapes Gemini cites (verbatim sentences of the segment).
 */
const transcript = { speakers: fixture.speakers, segments: fixture.segments } as Transcript;
const item = (segment_id: string, quote: string, text: string, owner_text?: string, due_text?: string) => ({ text, owner_text, due_text, evidence: [{ segment_id, quote }] });

const run = (raw: Record<string, unknown>) => {
  const r = validateMeetingBrief({ summary: 's', ...raw }, transcript);
  if (!r.ok) throw new Error(r.message);
  return r.value;
};

describe('Northstar: the two dropped action items are kept, with grounded owner and due text', () => {
  const v = run({
    action_items: [
      item('seg-152850-0', 'Technický vedoucí David teď musí do 2. prosince urgentně vymyslet zamykání těch datových záznamů.', 'David navrhne zamykání datových záznamů v API.', 'David', 'do 2. prosince'),
      item('seg-219090-0', 'David také do 27. listopadu garantuje klíčový test bezpečnosti, což je striktní izolace dat mezi zákazníky.', 'David otestuje izolaci dat mezi zákazníky.', 'David', 'do 27. listopadu'),
      item('seg-229470-0', 'Klára pak na to navazuje a do 30. listopadu musí vybrat ty konkrétní zákazníky a ověřit jejich souhlasy.', 'Klára vybere 8 pilotních zákazníků a ověří jejich souhlasy.', 'Klára', 'do 30. listopadu'),
    ],
  });
  test('all three kept as linked, nothing rejected', () => {
    expect(v.rejectedCount).toBe(0);
    expect(v.items.map((i) => [i.support, i.ownerText, i.dueText])).toEqual([
      ['linked', 'David', 'do 2. prosince'],
      ['linked', 'David', 'do 27. listopadu'],
      ['linked', 'Klára', 'do 30. listopadu'],
    ]);
    expect(v.items.every((i) => i.evidence.every((e) => e.quoteFound && !e.flag))).toBe(true);
  });
});

describe('Northstar: the MVP decision is not flagged by the Czech filler "No," of the next segment', () => {
  test('decision linked and unflagged', () => {
    const v = run({
      decisions: [item('seg-40410-0', 'vedení schválilo pro prvních 8 zákazníků opravdu jen naprostou kostru. Prostě přihlášení, založení požadavku, sledování stavu a nějaké e-mailové notifikace.', 'Pro pilot byl schválen jen minimální rozsah: přihlášení, požadavky, stav a e-mailové notifikace.')],
    });
    expect(v.items[0]).toMatchObject({ kind: 'decision', support: 'linked' });
    expect(v.items[0].evidence[0].flag).toBeUndefined();
  });
});

describe('Northstar: the guard still bites where the sense really flips', () => {
  test('a quote whose own clause carries a negation the claim lacks stays flagged', () => {
    const v = run({ risks: [item('seg-138090-0', 'Když to API pracuje požadavky paralelně a ne v tom přesném pořadí', 'API zpracovává požadavky v přesném pořadí.')] });
    expect(v.items[0].evidence[0].flag).toBe('negation_nearby');
  });
  test('a decision citing the "sandbox" sentence whose next clause says it must not go live is still flagged', () => {
    // seg-206310-0 "Rozumím, ale proč to nejde naostro?" is a question -> a decision citing it is never linked
    const v = run({ decisions: [item('seg-206310-0', 'proč to nejde naostro', 'Sandbox půjde naostro.')] });
    expect(v.items).toHaveLength(0);
  });
});
