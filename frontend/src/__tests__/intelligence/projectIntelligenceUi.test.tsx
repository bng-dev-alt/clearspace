import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';

/** Project Intelligence 2.0 UI: Brief (čerstvost, zdroje, ověřená fakta vs. interpretace), Znalosti, záložky a citace v chatu. */
const h = vi.hoisted(() => ({ svc: {} as Record<string, ReturnType<typeof vi.fn>>, fetchAi: vi.fn() }));

vi.mock('../../services/intelligenceService', () => {
  class IntelligenceServiceError extends Error {
    code: string;
    constructor(code: string, message: string) { super(message); this.code = code; }
  }
  for (const n of ['latestBrief', 'currentSignature', 'currentStamp', 'generateBrief', 'listKnowledge']) h.svc[n] = vi.fn();
  return { IntelligenceServiceError, intelligenceService: h.svc };
});
vi.mock('../../services/ai/aiClient', () => ({ aiClient: { setActiveProject: () => {}, fetchAi: (...a: unknown[]) => h.fetchAi(...a) } }));

import ProjectBriefPanel from '../../components/intelligence/ProjectBriefPanel';
import KnowledgePanel from '../../components/intelligence/KnowledgePanel';
import ProjectIntelligenceDrawer from '../../components/board/ProjectIntelligenceDrawer';
import { IntelligenceServiceError, type BriefRecord } from '../../services/intelligenceService';
import type { Column } from '../../types/kanban';

const svc = () => h.svc as Record<string, ReturnType<typeof vi.fn>>;
const columns = (n = 1): Column[] => [{ id: 'c1', name: 'K řešení', cards: Array.from({ length: n }, (_, i) => ({ id: `card-${i + 1}`, title: `Karta ${i + 1}`, details: '' })) }];

const claim = (text: string, ref: string, support: 'linked' | 'unverified' = 'linked') => ({ text, severity: null, support, evidence: [{ ref, quote: null, quoteFound: false }] });
const record = (over: Partial<BriefRecord> = {}): BriefRecord => ({
  runId: 'r1', createdAt: '2026-11-18T10:00:00Z', model: 'gemini-x', rejectedCount: 2,
  summary: 'Projekt je ohrožen.', healthNarrative: 'Skóre odpovídá blokátoru.',
  risks: [claim('Zpoždění dodavatele.', 'comment:cm-1')],
  blockers: [claim('Migrace čeká.', 'card:card-1', 'unverified')],
  nextActions: [{ text: 'Odblokovat migraci.', kind: 'unblock', targetCardId: 'card-1', support: 'linked', evidence: [{ ref: 'card:card-1', quote: null, quoteFound: false }] }],
  openQuestions: [claim('Kdy dodá?', 'item:it-1')], notesOnData: [],
  facts: { today: '2026-11-18', score: 76, level: 'attention', counts: { overdue: 1, blocked: 1, unassigned: 2, dueThisWeek: 3 }, meetingDerived: { pendingProposals: 4 } },
  signature: 'SIG-A', stamp: null,
  sources: [
    { ref: 'card:card-1', kind: 'card', label: 'Migrace databáze', cardId: 'card-1', meetingId: null },
    { ref: 'comment:cm-1', kind: 'comment', label: 'Jana', cardId: 'card-1', meetingId: null },
    { ref: 'item:it-1', kind: 'item', label: 'Release v pátek', cardId: null, meetingId: 'm-7' },
  ],
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  for (const f of Object.values(h.svc)) f.mockReset();
  svc().currentSignature.mockResolvedValue('SIG-A');
  svc().currentStamp.mockResolvedValue(null); // older database / no stamp: falls back to the signature
});

describe('ProjectBriefPanel', () => {
  test('no brief yet: says so and generates only on the explicit button', async () => {
    svc().latestBrief.mockResolvedValue(null);
    svc().generateBrief.mockResolvedValue({ runId: 'r' });
    render(<ProjectBriefPanel projectId="p1" columns={columns()} />);
    expect(await screen.findByText('Zatím nevygenerováno')).toBeInTheDocument();
    expect(svc().generateBrief).not.toHaveBeenCalled(); // nothing automatic
    svc().latestBrief.mockResolvedValue(record());
    fireEvent.click(screen.getByTestId('brief-generate'));
    await waitFor(() => expect(svc().generateBrief).toHaveBeenCalledWith('p1', false));
    expect(await screen.findByTestId('brief-notice')).toHaveTextContent('Brief byl aktualizován.');
    expect(await screen.findByTestId('brief-summary')).toHaveTextContent('Projekt je ohrožen.');
  });

  test('freshness: same signature = "Aktuální"; a different signature = "Zastaralé"; it re-evaluates when the board changes', async () => {
    svc().latestBrief.mockResolvedValue(record());
    const { rerender } = render(<ProjectBriefPanel projectId="p1" columns={columns(1)} />);
    await waitFor(() => expect(screen.getByTestId('brief-freshness')).toHaveTextContent('Aktuální'));
    svc().currentSignature.mockResolvedValue('SIG-B'); // a card was added -> different signature
    rerender(<ProjectBriefPanel projectId="p1" columns={columns(2)} />);
    await waitFor(() => expect(screen.getByTestId('brief-freshness')).toHaveTextContent('Zastaralé'));
    expect(svc().currentSignature).toHaveBeenCalledTimes(2);
  });

  test('R6: the database STAMP wins when both sides have it (a comment-only change makes the brief stale even if the facts signature is equal)', async () => {
    svc().latestBrief.mockResolvedValue(record({ stamp: 'STAMP-1' }));
    svc().currentStamp.mockResolvedValue('STAMP-1');
    render(<ProjectBriefPanel projectId="p1" columns={columns()} />);
    expect(await screen.findByText('Aktuální')).toBeInTheDocument();
    svc().currentStamp.mockResolvedValue('STAMP-2'); // someone commented
    render(<ProjectBriefPanel projectId="p1" columns={columns(1)} />);
    await waitFor(() => expect(screen.getAllByTestId('brief-freshness').some((e) => /Zastaralé/.test(e.textContent ?? ''))).toBe(true));
  });
  test('R6: without a stamp on either side the older signature decides', async () => {
    svc().latestBrief.mockResolvedValue(record({ stamp: 'STAMP-1' }));
    svc().currentStamp.mockResolvedValue(null);
    render(<ProjectBriefPanel projectId="p1" columns={columns()} />);
    expect(await screen.findByText('Aktuální')).toBeInTheDocument(); // SIG-A === SIG-A
  });
  test('a brief without a signature is shown with an honest "unknown" freshness (never claimed fresh)', async () => {
    svc().latestBrief.mockResolvedValue(record({ signature: null }));
    render(<ProjectBriefPanel projectId="p1" columns={columns()} />);
    await waitFor(() => expect(screen.getByTestId('brief-freshness')).toHaveTextContent('neznámý'));
  });

  test('verified facts and AI interpretation are visibly separate; hidden claims and rejected counts are disclosed', async () => {
    svc().latestBrief.mockResolvedValue(record());
    render(<ProjectBriefPanel projectId="p1" columns={columns()} />);
    const facts = await screen.findByTestId('brief-facts');
    expect(facts).toHaveTextContent('Ověřená fakta');
    expect(facts).toHaveTextContent('spočítala aplikace');
    expect(facts).toHaveTextContent('Zdraví 76/100');
    expect(facts).toHaveTextContent('Po termínu: 1');
    expect(facts).toHaveTextContent('Návrhy z porad k rozhodnutí: 4');
    expect(screen.getByLabelText('Interpretace AI')).toHaveTextContent('model gemini-x');
    expect(screen.getByTestId('brief-narrative')).toHaveTextContent('Skóre odpovídá blokátoru.');
    expect(screen.getByTestId('brief-rejected')).toHaveTextContent('2 tvrzení bez ověřitelného zdroje bylo vynecháno');
  });

  test('every claim shows its sources; unverified claims are flagged; the AI score is never shown as a number of its own', async () => {
    svc().latestBrief.mockResolvedValue(record());
    render(<ProjectBriefPanel projectId="p1" columns={columns()} />);
    await screen.findByTestId('brief-summary');
    const claims = screen.getAllByTestId('brief-claim');
    expect(claims.length).toBe(4);
    expect(claims.find((c) => c.textContent?.includes('Migrace čeká.'))).toHaveAttribute('data-support', 'unverified');
    expect(screen.getByText('Neověřeno')).toBeInTheDocument();
    expect(screen.getAllByTestId("source-chip").length).toBe(4);
    expect(screen.queryByText(/skóre ai/i)).toBeNull();
  });

  test('source navigation: a card chip opens the card, a meeting conclusion links to its meeting, "Otevřít kartu" only opens', async () => {
    svc().latestBrief.mockResolvedValue(record());
    const onOpenCard = vi.fn();
    render(<ProjectBriefPanel projectId="p1" columns={columns()} onOpenCard={onOpenCard} />);
    await screen.findByTestId('brief-summary');
    const chips = screen.getAllByTestId('source-chip');
    const meetingChip = chips.find((c) => c.textContent?.includes('Release v pátek'))!;
    expect(meetingChip.closest('a')).toHaveAttribute('href', '/projects/p1/meetings/m-7');
    fireEvent.click(chips.find((c) => c.textContent === 'karta: Migrace databáze')!);
    expect(onOpenCard).toHaveBeenCalledWith('card-1');
    fireEvent.click(screen.getByTestId('brief-open-target'));
    expect(onOpenCard).toHaveBeenCalledTimes(2);
    expect(svc().generateBrief).not.toHaveBeenCalled();
    expect(screen.getByTestId('project-brief')).toHaveTextContent('nic se neprovádí automaticky');
  });

  test('"brief is up to date" (409) is explained and an explicit override is offered', async () => {
    svc().latestBrief.mockResolvedValue(record());
    svc().generateBrief.mockRejectedValueOnce(new IntelligenceServiceError('conflict', 'Brief je aktuální: data projektu se od posledního briefu nezměnila.'));
    render(<ProjectBriefPanel projectId="p1" columns={columns()} />);
    fireEvent.click(await screen.findByTestId('brief-generate'));
    expect(await screen.findByTestId('brief-notice')).toHaveTextContent('Brief je aktuální');
    svc().generateBrief.mockResolvedValue({ runId: 'r2' });
    fireEvent.click(screen.getByTestId('brief-force'));
    await waitFor(() => expect(svc().generateBrief).toHaveBeenLastCalledWith('p1', true));
  });

  test('errors (AI disabled by the production firewall, rate limit) are readable and generation can be retried', async () => {
    svc().latestBrief.mockResolvedValue(null);
    svc().generateBrief.mockRejectedValue(new IntelligenceServiceError('ai_disabled', 'AI funkce jsou v této instalaci zatím vypnuté.'));
    render(<ProjectBriefPanel projectId="p1" columns={columns()} />);
    fireEvent.click(await screen.findByTestId('brief-generate'));
    expect(await screen.findByTestId('brief-error')).toHaveTextContent('zatím vypnuté');
    expect(screen.getByTestId('brief-generate')).toBeEnabled();
  });

  test('demo mode / load failure: friendly message, no crash', async () => {
    svc().latestBrief.mockRejectedValue(new IntelligenceServiceError('demo', 'Project Brief vyžaduje přihlášení přes Supabase.'));
    render(<ProjectBriefPanel projectId="p1" columns={columns()} />);
    expect(await screen.findByTestId('brief-error')).toHaveTextContent('přihlášení přes Supabase');
  });

  test('double click generates once while a request is running', async () => {
    svc().latestBrief.mockResolvedValue(null);
    let resolve!: (v: unknown) => void;
    svc().generateBrief.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<ProjectBriefPanel projectId="p1" columns={columns()} />);
    const btn = await screen.findByTestId('brief-generate');
    fireEvent.click(btn);
    fireEvent.click(btn);
    resolve({ runId: 'r' });
    await waitFor(() => expect(svc().generateBrief).toHaveBeenCalledTimes(1));
  });
});

describe('KnowledgePanel', () => {
  const items = [
    { id: 'a', meetingId: 'm-1', kind: 'decision', text: 'Release v pátek.', reviewState: 'accepted', decidedAt: null, appliedCardId: null },
    { id: 'b', meetingId: 'm-2', kind: 'risk', text: 'Zpoždění certifikátu.', reviewState: 'applied', decidedAt: null, appliedCardId: 'card-1' },
  ];
  test('lists approved conclusions with their source meeting, filters by kind, and opens the applied card', async () => {
    svc().listKnowledge.mockResolvedValue(items);
    const onOpenCard = vi.fn();
    render(<KnowledgePanel projectId="p1" onOpenCard={onOpenCard} />);
    expect(await screen.findAllByTestId('knowledge-item')).toHaveLength(2);
    expect(screen.getAllByTestId('knowledge-source')[0]).toHaveAttribute('href', '/projects/p1/meetings/m-1');
    fireEvent.change(screen.getByTestId('knowledge-filter'), { target: { value: 'risk' } });
    expect(screen.getAllByTestId('knowledge-item')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('knowledge-card'));
    expect(onOpenCard).toHaveBeenCalledWith('card-1');
  });
  test('empty state explains where conclusions come from', async () => {
    svc().listKnowledge.mockResolvedValue([]);
    render(<KnowledgePanel projectId="p1" />);
    expect(await screen.findByTestId('knowledge-empty')).toHaveTextContent('Po schválení návrhu z porady');
  });
  test('load errors are shown, not thrown', async () => {
    svc().listKnowledge.mockRejectedValue(new IntelligenceServiceError('demo', 'Znalosti z porad vyžadují přihlášení přes Supabase.'));
    render(<KnowledgePanel projectId="p1" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('přihlášení přes Supabase');
  });
});

describe('ProjectIntelligenceDrawer', () => {
  const props = { isOpen: true, onClose: vi.fn(), columns: columns(), projectName: 'Alfa', onGenerateTasks: vi.fn(), onSprintPlanning: vi.fn(), onRiskAnalysis: vi.fn() };

  test('without a project id it behaves exactly as before: no tabs, health and chat visible', () => {
    render(<ProjectIntelligenceDrawer {...props} />);
    expect(screen.queryByTestId('pi-tabs')).toBeNull();
    expect(screen.getByTestId('pi-health')).toBeInTheDocument();
    expect(screen.getByTestId('pi-ask-input')).toBeInTheDocument();
  });

  test('with a project id: Přehled (deterministic health + chat) / Brief / Znalosti tabs', async () => {
    svc().latestBrief.mockResolvedValue(record());
    svc().listKnowledge.mockResolvedValue([]);
    render(<ProjectIntelligenceDrawer {...props} projectId="p1" />);
    expect(screen.getByTestId('pi-tab-overview')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('pi-health')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pi-tab-brief'));
    expect(await screen.findByTestId('project-brief')).toBeInTheDocument();
    expect(screen.queryByTestId('pi-health')).toBeNull();
    fireEvent.click(screen.getByTestId('pi-tab-knowledge'));
    expect(await screen.findByTestId('project-knowledge')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pi-tab-overview'));
    expect(screen.getByTestId('pi-ask-input')).toBeInTheDocument();
  });

  test('chat shows numbered citations as buttons; clicking a card citation opens that card after the panel closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.fetchAi.mockResolvedValue({ content: 'Blokuje to migrace [1].', citations: [{ n: 1, ref: 'card:card-1', label: 'Migrace databáze', cardId: 'card-1', meetingId: null }] });
    const onClose = vi.fn(), onOpenCard = vi.fn();
    render(<ProjectIntelligenceDrawer {...props} onClose={onClose} projectId="p1" onOpenCard={onOpenCard} />);
    fireEvent.change(screen.getByTestId('pi-ask-input'), { target: { value: 'Co blokuje?' } });
    fireEvent.click(screen.getByTestId('pi-ask-send'));
    const cite = await screen.findByTestId('pi-chat-citation');
    expect(cite).toHaveAttribute('title', 'Migrace databáze');
    expect(screen.getByTestId('pi-chat-log')).toHaveTextContent('Blokuje to migrace 1.');
    fireEvent.click(cite);
    act(() => { vi.advanceTimersByTime(300); });
    expect(onClose).toHaveBeenCalled();
    expect(onOpenCard).toHaveBeenCalledWith('card-1');
    vi.useRealTimers();
  });

  test('an answer without citations is shown as plain text', async () => {
    h.fetchAi.mockResolvedValue({ content: 'Žádné zdroje.' });
    render(<ProjectIntelligenceDrawer {...props} projectId="p1" />);
    fireEvent.change(screen.getByTestId('pi-ask-input'), { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('pi-ask-send'));
    expect(await screen.findByText('Žádné zdroje.')).toBeInTheDocument();
    expect(screen.queryByTestId('pi-chat-citation')).toBeNull();
  });
});

afterEach(() => { vi.useRealTimers(); });
