import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

/** Project Brief + chat citations through the gateway: Supabase and Gemini are MOCKS (no network, no credits). */
const h = vi.hoisted(() => ({
  gemini: [] as Array<{ model: string; config: Record<string, unknown>; contents: unknown }>,
  modelText: '{}',
  rpc: [] as Array<{ name: string; args: Record<string, unknown> }>,
  persist: { data: 'brief-run-1' as unknown, error: null as null | { code: string } },
  visibleProjects: ['pA'] as string[],
  existingRuns: [] as unknown[],
  queries: [] as Array<{ table: string; filters: Record<string, unknown> }>,
  cards: [] as Array<Record<string, unknown>>,
  items: [] as Array<Record<string, unknown>>,
  order: [] as string[],
}));

vi.mock('@google/genai', () => {
  class MockGoogleGenAI {
    models = {
      generateContent: async (req: { model: string; config: Record<string, unknown>; contents: unknown }) => {
        h.order.push('gemini');
        h.gemini.push(req);
        return { text: h.modelText, usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 200, totalTokenCount: 700 } };
      },
    };
  }
  return { GoogleGenAI: MockGoogleGenAI };
});

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => {
    const from = (table: string) => {
      const q = { table, filters: {} as Record<string, unknown> };
      h.queries.push(q);
      const result = () => {
        switch (table) {
          case 'projects': return { data: h.visibleProjects.includes(String(q.filters.id)) ? { id: q.filters.id, name: 'Projekt A' } : null, error: null };
          case 'columns': return { data: [{ id: 'col-1', name: 'K řešení', position: 0 }], error: null };
          case 'cards': return { data: h.cards.map((c) => ({ details: '', tag: null, priority: null, assignee_name: null, assignee_initials: null, assignee_color: null, assignees: null, due_date: null, position: 0, created_at: '', updated_at: '2026-11-17T10:00:00Z', task_checklists: [], task_comments: [], task_activities: [], card_assignees: [], archived: false, column_id: 'col-1', ...c })), error: null };
          case 'activity_logs': return { data: [], error: null };
          case 'intelligence_items': return { data: h.items, error: null };
          case 'intelligence_runs': return { data: h.existingRuns, error: null };
          default: return { data: null, error: null };
        }
      };
      const b: Record<string, unknown> = {};
      for (const m of ['select', 'order', 'in', 'is']) b[m] = () => b;
      b.eq = (c: string, v: unknown) => { q.filters[c] = v; return b; };
      b.limit = () => Promise.resolve(result());
      b.maybeSingle = () => Promise.resolve(result());
      return b;
    };
    return {
      auth: { getUser: async () => ({ data: { user: { id: 'u1' } }, error: null }) },
      rpc: async (name: string, args: Record<string, unknown>) => {
        h.order.push(name);
        h.rpc.push({ name, args });
        if (name === 'ai_reserve') return { data: [{ allowed: true, request_id: 'req-9', reason: null }], error: null };
        if (name === 'persist_project_brief') return h.persist;
        return { data: null, error: null };
      },
      from,
    };
  },
}));

import { runAi } from '../../lib/ai/gateway';
import { aiFeatures } from '../../lib/ai/features';
import { projectBrief } from '../../lib/ai/projectBrief';
import { projectBriefSchema } from '../../services/ai/schemas';
import { computeProjectIntelligence } from '../../lib/projectIntelligence';

const TOKEN = 't'.repeat(40);
const post = (feature: Parameters<typeof runAi>[1], body: unknown) =>
  runAi(new NextRequest('http://localhost/api/ai/x', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) }), feature);
const brief = (body: unknown = { projectId: 'pA' }) => post(projectBrief as never, body);
const persisted = () => h.rpc.find((c) => c.name === 'persist_project_brief');
const promptText = () => JSON.stringify(h.gemini[0].contents) + String((h.gemini[0].config as { systemInstruction?: string }).systemInstruction);

const goodOutput = {
  summary: 'Projekt je ohrožen blokovanou migrací.',
  health_narrative: 'Skóre odpovídá jednomu blokátoru a jednomu úkolu po termínu.',
  risks: [{ text: 'Dodavatel může zpozdit certifikát.', severity: 'high', refs: ['comment:cm-1'], quote: 'dodavatel potvrdil zpoždění' }],
  blockers: [{ text: 'Migrace čeká na dodavatele.', refs: ['card:card-1'] }],
  next_actions: [{ text: 'Odblokovat migraci.', kind: 'unblock', refs: ['card:card-1'], target_card_id: 'card-1' }],
  open_questions: [{ text: 'Kdy dodavatel dodá?', refs: ['card:card-1', 'item:it-1'] }],
  notes_on_data: [],
};

describe('project brief (gateway feature)', () => {
  const env = { ...process.env };
  beforeEach(() => {
    h.gemini.length = 0; h.rpc.length = 0; h.order.length = 0; h.queries.length = 0;
    h.modelText = JSON.stringify(goodOutput);
    h.persist = { data: 'brief-run-1', error: null };
    h.visibleProjects = ['pA'];
    h.existingRuns = [];
    h.cards = [{ id: 'card-1', title: 'Migrace databáze', tag: 'Blokováno', details: 'Čeká na dodavatele', due_date: '2026-11-10', task_comments: [{ id: 'cm-1', card_id: 'card-1', author_name: 'Jana', content: 'Dodavatel potvrdil zpoždění o týden', created_at: '2026-11-10T00:00:00Z' }] }, { id: 'card-2', title: 'Bez problému' }];
    h.items = [
      { id: 'it-1', meeting_id: 'm-1', kind: 'decision', text: 'Release se posouvá na pátek.', review_state: 'accepted', decided_at: '2026-11-15T10:00:00Z', created_at: '2026-11-14T10:00:00Z', applied_card_id: null },
      { id: 'it-2', meeting_id: 'm-1', kind: 'risk', text: 'NEPŘIJATÝ NÁVRH AI', review_state: 'proposed', decided_at: null, created_at: '2026-11-14T10:00:00Z', applied_card_id: null },
    ];
    process.env = { ...env, NEXT_PUBLIC_SUPABASE_URL: 'http://sb.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon', GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-test' };
    delete process.env.NEXT_PUBLIC_FORCE_DEMO;
  });
  afterEach(() => { process.env = env; });

  test('happy path: a validated brief is stored in ONE rpc call; the response carries only the result, not the raw model output', async () => {
    const r = await brief();
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ runId: 'brief-run-1', rejectedCount: 0, model: 'gemini-test' });
    expect(body.content).toBeUndefined();
    expect(body.parsed).toBeUndefined();
    const run = persisted()!.args.p_run as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(persisted()!.args.p_project_id).toBe('pA');
    expect(run).toMatchObject({ status: 'succeeded', prompt_version: 'project-brief-p1', validator_version: 'cs-evidence-v1', contract_version: 'cs.project-brief@1.0', ai_request_id: 'req-9', model: 'gemini-test' });
    expect(run.input_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(run.output.brief.summary).toBe('Projekt je ohrožen blokovanou migrací.');
    expect(run.output.signature).toEqual(expect.any(String));
  });

  test('every claim is evidence-backed: each stored ref exists in the context, quotes are verified, used sources get labels', async () => {
    await brief();
    const out = (persisted()!.args.p_run as any).output; // eslint-disable-line @typescript-eslint/no-explicit-any
    const refs = [...out.brief.risks, ...out.brief.blockers, ...out.brief.nextActions, ...out.brief.openQuestions].flatMap((c: any) => c.evidence.map((e: any) => e.ref)); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(new Set(refs)).toEqual(new Set(['comment:cm-1', 'card:card-1', 'item:it-1']));
    expect(out.brief.risks[0]).toMatchObject({ support: 'linked', severity: 'high' });
    expect(out.brief.risks[0].evidence[0]).toMatchObject({ ref: 'comment:cm-1', quoteFound: true });
    expect(out.sources.find((s: any) => s.ref === 'item:it-1')).toMatchObject({ kind: 'item', meetingId: 'm-1' }); // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.sources.find((s: any) => s.ref === 'comment:cm-1')).toMatchObject({ kind: 'comment', cardId: 'card-1' }); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  test('DETERMINISTIC facts are stored from code: the model cannot change the score, level or counts', async () => {
    h.modelText = JSON.stringify({ ...goodOutput, health_score: 5, health_level: 'healthy', facts: { counts: { overdue: 999 } } });
    await brief();
    const out = (persisted()!.args.p_run as any).output; // eslint-disable-line @typescript-eslint/no-explicit-any
    const expected = computeProjectIntelligence([{ id: 'col-1', name: 'K řešení', cards: [{ id: 'card-1', title: 'x', details: '', tag: 'Blokováno', dueDate: '2026-11-10' }, { id: 'card-2', title: 'y', details: '' }] }], new Date(), out.facts.today).health;
    expect(out.facts.score).toBe(expected.score);
    expect(out.facts.level).toBe(expected.level);
    expect(out.facts.counts.blocked).toBe(1);
    expect(out.facts.counts.overdue).not.toBe(999);
    expect(JSON.stringify(out.brief)).not.toMatch(/health_score|health_level/);
  });

  test('claims citing refs that were never in the context are dropped and counted; unknown target cards are nulled', async () => {
    h.modelText = JSON.stringify({ ...goodOutput,
      risks: [{ text: 'Vymyšlené riziko.', refs: ['card:neexistuje', 'comment:fake'] }],
      next_actions: [{ text: 'Něco udělat.', kind: 'update', refs: ['card:card-1'], target_card_id: 'card-foreign' }] });
    const r = await brief();
    expect((await r.json()).rejectedCount).toBe(1);
    const out = (persisted()!.args.p_run as any).output; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(out.brief.risks).toEqual([]);
    expect(out.brief.nextActions[0].targetCardId).toBeNull();
  });

  test('no owners or deadlines can be invented: the output has no such fields and a date not in the sources makes a claim unverified', async () => {
    h.modelText = JSON.stringify({ ...goodOutput, blockers: [{ text: 'Termín je 2026-12-24 a vlastník je Karel.', refs: ['card:card-1'], owner: 'Karel', due: '2026-12-24' }] });
    await brief();
    const b = (persisted()!.args.p_run as any).output.brief.blockers[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(b.support).toBe('unverified');
    expect(Object.keys(b).sort()).toEqual(['evidence', 'severity', 'support', 'text']);
    expect(Object.keys(projectBriefSchema.properties)).not.toContain('owner');
  });

  test('meeting-derived intelligence is in the context only when a human accepted it; unreviewed AI proposals are never shown to the model', async () => {
    await brief();
    const p = promptText();
    expect(p).toContain('[item:it-1] decision: Release se posouvá na pátek.');
    expect(p).toContain('Přijaté závěry z porad (schváleno člověkem)');
    expect(p).not.toContain('NEPŘIJATÝ NÁVRH AI');
    expect(p).toContain('pendingProposals\\":1'); // but the COUNT of pending proposals is a deterministic fact
  });

  test('prompt: facts are declared binding, DATA is framed, the schema has a source list on every claim', async () => {
    await brief();
    const p = promptText();
    expect(p).toMatch(/závazná/);
    expect(p).toContain('<<<DATA:PROJECT>>>');
    expect(p).toMatch(/Nevymýšlejte osoby, termíny/);
    expect((h.gemini[0].config as { responseSchema?: unknown }).responseSchema).toBe(projectBriefSchema);
  });

  test('freshness: an identical input answers 409 BEFORE quota or model; the lookup is keyed by the input fingerprint', async () => {
    h.existingRuns = [{ id: 'old' }];
    const r = await brief();
    expect(r.status).toBe(409);
    expect(h.rpc.filter((c) => c.name === 'ai_reserve')).toHaveLength(0);
    expect(h.gemini).toHaveLength(0);
    const q = h.queries.find((x) => x.table === 'intelligence_runs')!;
    expect(q.filters).toMatchObject({ project_id: 'pA', kind: 'project_brief', status: 'succeeded' });
    expect(String(q.filters.input_fingerprint)).toMatch(/^[0-9a-f]{64}$/);
  });

  test('force regenerates even when the input is unchanged', async () => {
    h.existingRuns = [{ id: 'old' }];
    expect((await brief({ projectId: 'pA', force: true })).status).toBe(200);
    expect(persisted()).toBeDefined();
  });

  test('the fingerprint changes when a conclusion is accepted (so a stale brief can be regenerated)', async () => {
    await brief();
    const fp1 = (persisted()!.args.p_run as any).input_fingerprint; // eslint-disable-line @typescript-eslint/no-explicit-any
    h.rpc.length = 0;
    h.items = [...h.items, { id: 'it-3', meeting_id: 'm-1', kind: 'open_question', text: 'Nová otázka', review_state: 'accepted', decided_at: '2026-11-16T10:00:00Z', created_at: '2026-11-16T10:00:00Z', applied_card_id: null }];
    await brief({ projectId: 'pA', force: true });
    expect((persisted()!.args.p_run as any).input_fingerprint).not.toBe(fp1); // eslint-disable-line @typescript-eslint/no-explicit-any
  });

  test('unparseable output or an empty summary -> 502, nothing stored', async () => {
    h.modelText = 'ne JSON';
    expect((await brief()).status).toBe(502);
    h.modelText = JSON.stringify({ ...goodOutput, summary: ' ' });
    expect((await brief()).status).toBe(502);
    expect(persisted()).toBeUndefined();
  });

  test('persist failures are mapped without leaking details', async () => {
    h.persist = { data: null, error: { code: '42501' } };
    expect((await brief()).status).toBe(403);
    h.persist = { data: null, error: { code: 'XX000' } };
    const r = await brief();
    expect(r.status).toBe(502);
    expect(JSON.stringify(await r.json())).not.toMatch(/XX000|rpc|persist/i);
  });

  test('authorization: a project the caller cannot see (RLS) is 403; nothing is queried further, nothing reaches the model', async () => {
    h.visibleProjects = [];
    expect((await brief()).status).toBe(403);
    expect(h.gemini).toHaveLength(0);
    expect(h.queries.map((q) => q.table)).toEqual(['projects']);
  });

  test('the usage is booked before the brief is stored', async () => {
    await brief();
    expect(h.order.indexOf('ai_complete')).toBeGreaterThan(h.order.indexOf('gemini'));
    expect(h.order.indexOf('ai_complete')).toBeLessThan(h.order.indexOf('persist_project_brief'));
    expect(h.rpc.find((c) => c.name === 'ai_complete')!.args).toMatchObject({ p_status: 'succeeded', p_prompt_tokens: 500, p_completion_tokens: 200 });
  });
});

describe('project chat with citations', () => {
  const env = { ...process.env };
  const chat = (text: string) => { h.modelText = text; return post(aiFeatures.chat, { projectId: 'pA', messages: [{ role: 'user', content: 'Co blokuje projekt?' }] }); };
  beforeEach(() => {
    h.gemini.length = 0; h.rpc.length = 0; h.order.length = 0; h.queries.length = 0;
    h.visibleProjects = ['pA'];
    h.cards = [{ id: 'card-1', title: 'Migrace databáze', tag: 'Blokováno' }];
    h.items = [{ id: 'it-1', meta: 1, meeting_id: 'm-1', kind: 'decision', text: 'Release v pátek.', review_state: 'accepted', decided_at: '2026-11-15T10:00:00Z', created_at: '2026-11-14T10:00:00Z', applied_card_id: null }];
    process.env = { ...env, NEXT_PUBLIC_SUPABASE_URL: 'http://sb.test', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon', GEMINI_API_KEY: 'k', GEMINI_MODEL: 'gemini-test' };
    delete process.env.NEXT_PUBLIC_FORCE_DEMO;
  });
  afterEach(() => { process.env = env; });

  test('valid [ref]s become numbered citations; fake refs vanish; the response shape stays {content, model, usage}', async () => {
    const r = await chat('Blokuje to [card:card-1]. Release je v pátek [item:it-1]. Vymyšlené [card:ghost].');
    const body = await r.json();
    expect(r.status).toBe(200);
    expect(body.content).toBe('Blokuje to [1]. Release je v pátek [2]. Vymyšlené.');
    expect(body.citations).toEqual([
      { n: 1, ref: 'card:card-1', kind: 'card', label: 'Migrace databáze', cardId: 'card-1', meetingId: null },
      { n: 2, ref: 'item:it-1', kind: 'item', label: 'Release v pátek.', cardId: null, meetingId: 'm-1' },
    ]);
    expect(body.model).toBe('gemini-test');
    expect(body.usage).toBeDefined();
    expect(body.parsed).toBeUndefined();
  });

  test('chat sees meeting conclusions with refs and is told to cite only refs that exist', async () => {
    await chat('ok');
    const p = promptText();
    expect(p).toContain('[item:it-1] decision: Release v pátek.');
    expect(p).toMatch(/nic si nevymýšlejte/);
  });

  test('a project the caller cannot access gets no chat and no citations', async () => {
    h.visibleProjects = [];
    expect((await chat('x')).status).toBe(403);
    expect(h.gemini).toHaveLength(0);
  });
});
