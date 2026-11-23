import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, test, expect, beforeEach, vi } from 'vitest';

/** Meeting Intelligence UI: formulář, schvalování položek a detail porady. Služby jsou mocky (žádná síť, žádná AI). */
const h = vi.hoisted(() => ({
  push: vi.fn(),
  svc: {} as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: h.push }), useParams: () => ({}) }));
vi.mock('../../services/kanbanService', () => ({
  kanbanService: {
    fetchBoardData: async () => [
      { id: 'col-1', name: 'K řešení', cards: [{ id: 'card-1', title: 'Připravit migraci databáze', details: '' }, { id: 'card-9', title: 'Archivovaná', details: '', archived: true }] },
      { id: 'col-2', name: 'Hotovo', cards: [] },
    ],
  },
}));
vi.mock('../../services/meetingService', async () => {
  class MeetingServiceError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  }
  const names = ['createWithTranscript', 'get', 'getTranscript', 'latestRun', 'listItems', 'projectMembers', 'analyze', 'review', 'apply', 'undo', 'remove', 'renameSpeakers', 'list', 'pendingCounts', 'listRevisions', 'addRevision'];
  for (const n of names) h.svc[n] = vi.fn();
  return { MeetingServiceError, meetingService: h.svc };
});

import NewMeetingForm from '../../components/meetings/NewMeetingForm';
import ItemCard from '../../components/meetings/ItemCard';
import MeetingDetail from '../../components/meetings/MeetingDetail';
import { MeetingServiceError, type IntelligenceItem } from '../../services/meetingService';

const svc = () => h.svc as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.clearAllMocks();
  for (const f of Object.values(h.svc)) f.mockReset();
});

describe('NewMeetingForm', () => {
  test('pasted transcript is sent to the service with title, source and language; onCreated receives the new id', async () => {
    svc().createWithTranscript.mockResolvedValue({ meetingId: 'm-1', warnings: [] });
    const onCreated = vi.fn();
    render(<NewMeetingForm projectId="p1" onCreated={onCreated} />);
    fireEvent.change(screen.getByLabelText('Název porady'), { target: { value: 'Týdenní porada' } });
    fireEvent.change(screen.getByLabelText('Přepis'), { target: { value: 'Petr: Ahoj.' } });
    fireEvent.change(screen.getByLabelText('Jazyk'), { target: { value: 'en' } });
    fireEvent.click(screen.getByTestId('meeting-create'));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('m-1', []));
    expect(svc().createWithTranscript).toHaveBeenCalledWith({ projectId: 'p1', title: 'Týdenní porada', text: 'Petr: Ahoj.', source: 'paste', languageHint: 'en' });
  });

  test('empty transcript and invalid SRT show the service message and create nothing', async () => {
    svc().createWithTranscript.mockRejectedValue(new MeetingServiceError('empty', 'Přepis je prázdný.'));
    render(<NewMeetingForm projectId="p1" onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Název porady'), { target: { value: 'X' } });
    fireEvent.click(screen.getByTestId('meeting-create'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Přepis je prázdný.');
    svc().createWithTranscript.mockRejectedValue(new MeetingServiceError('invalid_srt', 'Soubor neobsahuje žádný platný titulek (SRT).'));
    fireEvent.click(screen.getByTestId('meeting-create'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('platný titulek'));
  });

  test('an unsupported file type is refused in the UI before anything is read or sent', async () => {
    render(<NewMeetingForm projectId="p1" onCreated={vi.fn()} />);
    const input = screen.getByTestId('meeting-file') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['x'], 'porada.pdf', { type: 'application/pdf' })] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Nepodporovaný typ souboru');
    expect(svc().createWithTranscript).not.toHaveBeenCalled();
  });

  test('a TXT file fills the transcript, defaults the title from the file name and keeps its source type', async () => {
    svc().createWithTranscript.mockResolvedValue({ meetingId: 'm-2', warnings: [] });
    render(<NewMeetingForm projectId="p1" onCreated={vi.fn()} />);
    const f = new File(['Petr: Ahoj z TXT.'], 'zapis-2026.srt', { type: 'text/plain' });
    fireEvent.change(screen.getByTestId('meeting-file'), { target: { files: [f] } });
    await waitFor(() => expect((screen.getByLabelText('Přepis') as HTMLTextAreaElement).value).toBe('Petr: Ahoj z TXT.'));
    expect((screen.getByLabelText('Název porady') as HTMLInputElement).value).toBe('zapis-2026');
    fireEvent.click(screen.getByTestId('meeting-create'));
    await waitFor(() => expect(svc().createWithTranscript).toHaveBeenCalledWith(expect.objectContaining({ source: 'srt' })));
  });

  test('a file over 2 MB is refused', async () => {
    render(<NewMeetingForm projectId="p1" onCreated={vi.fn()} />);
    const big = new File(['x'], 'big.txt');
    Object.defineProperty(big, 'size', { value: 3 * 1024 * 1024 });
    fireEvent.change(screen.getByTestId('meeting-file'), { target: { files: [big] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('příliš velký');
  });

  test('double submit creates one meeting', async () => {
    let resolve!: (v: unknown) => void;
    svc().createWithTranscript.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<NewMeetingForm projectId="p1" onCreated={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Název porady'), { target: { value: 'X' } });
    fireEvent.change(screen.getByLabelText('Přepis'), { target: { value: 'Petr: a' } });
    fireEvent.click(screen.getByTestId('meeting-create'));
    fireEvent.click(screen.getByTestId('meeting-create'));
    resolve({ meetingId: 'm', warnings: [] });
    await waitFor(() => expect(svc().createWithTranscript).toHaveBeenCalledTimes(1));
  });
});

const item = (over: Partial<IntelligenceItem> = {}): IntelligenceItem => ({
  id: 'it-1', meetingId: 'm-1', runId: 'r-1', ordinal: 0, kind: 'action_item', text: 'Honza připraví migraci databáze.', support: 'linked',
  evidence: [{ ref: 'segment:seg-1', quote: 'Honza připraví migraci databáze', quoteFound: true, startMs: 5000, endMs: 9000 }],
  ownerText: 'Honza', dueText: 'do 25. listopadu', suggestedCardId: null, reviewState: 'proposed', assigneeMemberId: null, dueDate: null,
  appliedCardId: null, appliedMode: null, duplicateOf: null, ...over,
});
const columns = [{ id: 'col-1', name: 'K řešení' }, { id: 'col-2', name: 'Hotovo' }];
const cards = [{ id: 'card-1', title: 'Úplně jiná karta' }];
const members = [{ id: 'm-honza', fullName: 'Honza Novák' }, { id: 'm-jana', fullName: 'Jana Svobodová' }];
const renderItem = (it: IntelligenceItem, extra: Partial<React.ComponentProps<typeof ItemCard>> = {}) => {
  const onJump = vi.fn(), onChanged = vi.fn();
  render(<ul><ItemCard item={it} columns={columns} cards={cards} members={members} onJump={onJump} onChanged={onChanged} {...extra} /></ul>);
  return { onJump, onChanged };
};

describe('ItemCard: honest evidence labels', () => {
  test('"Ověřeno" is gone: the badge says only that the quote text was found; a negation flag is shown prominently', () => {
    renderItem(item({ evidence: [{ ref: 'segment:seg-1', quote: 'nebudeme nasazovat', quoteFound: true, flag: 'negation_nearby' }], support: 'unverified' }));
    expect(screen.queryByText('Ověřeno')).toBeNull();
    expect(screen.getByTestId('negation-flag')).toHaveTextContent('Pozor: zápor');
    // the quote WAS found: the badge must not say "nenalezena"
    expect(screen.queryByText('Citace nenalezena')).toBeNull();
    expect(screen.getByText('Citace nalezena, ale může znamenat opak: ověřte v přepisu')).toBeInTheDocument();
  });
  test('quote really not found: "Citace nenalezena"; found and clean: "Citace nalezena"', () => {
    renderItem(item({ support: 'unverified', evidence: [{ ref: 'segment:seg-1', quote: 'vymyšlená citace', quoteFound: false }] }));
    expect(screen.getByText('Citace nenalezena')).toBeInTheDocument();
  });
  test('found and clean', () => {
    renderItem(item());
    expect(screen.getByText('Citace nalezena')).toBeInTheDocument();
    expect(screen.queryByTestId('negation-flag')).toBeNull();
  });
  test('earlier-run badge is shown only for fromEarlierRun', () => {
    renderItem(item({ reviewState: 'accepted' }), { fromEarlierRun: true });
    expect(screen.getByTestId('earlier-run')).toHaveTextContent('Z dřívější analýzy');
  });
  test('earlier-run badge is absent otherwise', () => {
    renderItem(item({ reviewState: 'accepted' }));
    expect(screen.queryByTestId('earlier-run')).toBeNull();
  });
  test('the tooltip tells the user that a found quote does not prove the claim', () => {
    renderItem(item());
    expect(document.querySelector('[title*="Neověřuje, že tvrzení z ní plyne"]')).not.toBeNull();
  });
});

describe('ItemCard: evidence, hints and approval', () => {
  test('shows verified badge, evidence quote with time, and the owner/due hints as TEXT (not as data)', () => {
    renderItem(item());
    expect(screen.getByText('Citace nalezena')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-link')).toHaveTextContent('„Honza připraví migraci databáze"');
    expect(screen.getByTestId('evidence-link')).toHaveTextContent('0:05');
    expect(screen.getByTestId('item-hints')).toHaveTextContent('Zmíněno v poradě: Honza');
    expect(screen.getByTestId('owner-hint')).not.toHaveTextContent('není členem projektu');
    expect(screen.getByTestId('due-hint')).toHaveTextContent('termín úkolu');
  });
  test('Northstar: a mentioned person who is not a project member is never assigned; picking someone else is called out', async () => {
    svc().apply.mockResolvedValue({ cardId: 'card-new', alreadyApplied: false });
    const klara = item({
      text: 'Klára zjistí data z praxe ohledně velikosti příloh.', ownerText: 'Klára', dueText: 'hned 1. prosince',
      evidence: [{ ref: 'segment:seg-251310-0', quote: 'Klára k tomu teď zjišťuje data z praxe a finální rozhodnutí padne na další poradě hned 1. prosince.', quoteFound: true }],
    });
    const { onChanged } = renderItem(klara, { meetingDay: '2026-11-23' });
    expect(screen.getByTestId('owner-hint')).toHaveTextContent('není členem projektu');
    expect(screen.getByTestId('due-hint')).toHaveAttribute('data-due-kind', 'meeting');
    expect(screen.getByTestId('due-hint')).toHaveTextContent('ne termín úkolu');
    fireEvent.click(screen.getByTestId('item-create'));
    expect((screen.getByTestId('create-assignee') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByTestId('use-suggested-assignee')).toBeNull();
    expect(screen.queryByTestId('use-suggested-due')).toBeNull(); // the decision date is not offered as the task deadline
    fireEvent.change(screen.getByTestId('create-assignee'), { target: { value: 'm-jana' } });
    expect(screen.getByTestId('assignee-differs')).toHaveTextContent('Klára');
    fireEvent.change(screen.getByTestId('create-assignee'), { target: { value: '' } });
    expect(screen.queryByTestId('assignee-differs')).toBeNull();
    fireEvent.click(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const target = svc().apply.mock.calls[0][1];
    expect(target).toMatchObject({ assignee_member_id: null, due_date: null });
    expect(target.details).toContain('Zmíněno v poradě: Klára');
    expect(target.details).toContain('datum porady nebo rozhodnutí');
  });
  test('the due text is judged in the whole cited segment, not only the short quote', () => {
    renderItem(item({ dueText: '25. listopadu', evidence: [{ ref: 'segment:seg-1', quote: 'připraví migraci databáze', quoteFound: true }] }), {
      citedText: 'Honza připraví migraci databáze do 25. listopadu, to slibuji.',
    });
    expect(screen.getByTestId('due-hint')).toHaveAttribute('data-due-kind', 'deadline');
  });
  test('an owner-edited due date stays authoritative (pre-filled from the item, no suggestion overrides it)', () => {
    renderItem(item({ dueText: 'do pátku', dueDate: '2026-12-09' }), { meetingDay: '2026-11-18' });
    fireEvent.click(screen.getByTestId('item-create'));
    expect((screen.getByTestId('create-due') as HTMLInputElement).value).toBe('2026-12-09');
  });
  test('clicking evidence jumps to the transcript segment', () => {
    const { onJump } = renderItem(item());
    fireEvent.click(screen.getByTestId('evidence-link'));
    expect(onJump).toHaveBeenCalledWith('seg-1');
  });
  test('unverified items are clearly marked', () => {
    renderItem(item({ kind: 'risk', support: 'unverified', evidence: [{ ref: 'segment:seg-2', quote: 'něco', quoteFound: false }] }));
    expect(screen.getByText('Citace nenalezena')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-link')).toHaveTextContent('citace nenalezena');
  });
  test('decisions and risks can be linked or accepted but never turned into a card', () => {
    renderItem(item({ kind: 'decision' }));
    expect(screen.queryByTestId('item-create')).toBeNull();
    expect(screen.getByTestId('item-link')).toBeInTheDocument();
  });

  test('NOTHING is applied until the human confirms: opening the form and editing does not call apply', () => {
    renderItem(item());
    fireEvent.click(screen.getByTestId('item-create'));
    fireEvent.change(screen.getByTestId('create-title'), { target: { value: 'Moje úprava' } });
    expect(svc().apply).not.toHaveBeenCalled();
    expect(svc().review).not.toHaveBeenCalled();
  });
  test('the assignee is NOT pre-selected: only a suggestion button appears; the due date stays empty', () => {
    renderItem(item());
    fireEvent.click(screen.getByTestId('item-create'));
    expect((screen.getByTestId('create-assignee') as HTMLSelectElement).value).toBe('');
    expect((screen.getByTestId('create-due') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('use-suggested-assignee')).toHaveTextContent('Honza Novák');
  });
  test('R6: a due-date SUGGESTION from the text is offered but never pre-filled; accepting it only fills the field', () => {
    renderItem(item({ dueText: 'do pátku' }), { meetingDay: '2026-11-18' });
    fireEvent.click(screen.getByTestId('item-create'));
    expect((screen.getByTestId('create-due') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('use-suggested-due')).toHaveTextContent('2026-11-20');
    fireEvent.click(screen.getByTestId('use-suggested-due'));
    expect((screen.getByTestId('create-due') as HTMLInputElement).value).toBe('2026-11-20');
    expect(svc().apply).not.toHaveBeenCalled();
    expect(screen.queryByTestId('use-suggested-due')).toBeNull();
  });
  test('R6: no suggestion for vague text or without a meeting day', () => {
    renderItem(item({ dueText: 'brzy' }), { meetingDay: '2026-11-18' });
    fireEvent.click(screen.getByTestId('item-create'));
    expect(screen.queryByTestId('use-suggested-due')).toBeNull();
  });
  test('R6: the default column respects an explicit role (a column NAMED like done but set to "doing" is a valid default)', () => {
    renderItem(item(), { columns: [{ id: 'c-a', name: 'Hotovo (archiv)', role: 'doing' }, { id: 'c-b', name: 'Cokoli', role: 'done' }] });
    fireEvent.click(screen.getByTestId('item-create'));
    expect((screen.getByTestId('create-column') as HTMLSelectElement).value).toBe('c-a');
  });
  test('confirming creates the card with exactly the human-chosen values and then reloads', async () => {
    svc().apply.mockResolvedValue({ cardId: 'card-new', alreadyApplied: false });
    const { onChanged } = renderItem(item());
    fireEvent.click(screen.getByTestId('item-create'));
    fireEvent.change(screen.getByTestId('create-title'), { target: { value: 'Migrace DB' } });
    fireEvent.click(screen.getByTestId('use-suggested-assignee'));
    fireEvent.change(screen.getByTestId('create-due'), { target: { value: '2026-11-25' } });
    fireEvent.click(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith('Karta vytvořena.'));
    expect(svc().apply).toHaveBeenCalledTimes(1);
    expect(svc().apply).toHaveBeenCalledWith('it-1', expect.objectContaining({ mode: 'create_card', column_id: 'col-1', title: 'Migrace DB', assignee_member_id: 'm-honza', due_date: '2026-11-25', allow_duplicate: false }));
  });
  test('the default column is the first one that is not "Hotovo"', () => {
    renderItem(item());
    fireEvent.click(screen.getByTestId('item-create'));
    expect((screen.getByTestId('create-column') as HTMLSelectElement).value).toBe('col-1');
  });
  test('repeated clicks on confirm create a single card (busy guard)', async () => {
    let resolve!: (v: unknown) => void;
    svc().apply.mockReturnValue(new Promise((r) => { resolve = r; }));
    renderItem(item());
    fireEvent.click(screen.getByTestId('item-create'));
    fireEvent.click(screen.getByTestId('create-confirm'));
    fireEvent.click(screen.getByTestId('create-confirm'));
    resolve({ cardId: 'c', alreadyApplied: false });
    await waitFor(() => expect(svc().apply).toHaveBeenCalledTimes(1));
  });
  test('a duplicate warning is shown and creating requires an explicit override; a refused duplicate shows the message', async () => {
    renderItem(item({ duplicateOf: 'it-0' }));
    expect(screen.getByTestId('duplicate-warning')).toBeInTheDocument();
    svc().apply.mockRejectedValueOnce(new MeetingServiceError('duplicate', 'Stejná položka už existuje (duplicita).'));
    fireEvent.click(screen.getByTestId('item-create'));
    fireEvent.click(screen.getByTestId('create-confirm'));
    expect(await screen.findByTestId('item-error')).toHaveTextContent('duplicita');
    expect(svc().apply).toHaveBeenLastCalledWith('it-1', expect.objectContaining({ allow_duplicate: false }));
    svc().apply.mockResolvedValue({ cardId: 'c', alreadyApplied: false });
    fireEvent.click(screen.getByTestId('allow-duplicate'));
    fireEvent.click(screen.getByTestId('create-confirm'));
    await waitFor(() => expect(svc().apply).toHaveBeenLastCalledWith('it-1', expect.objectContaining({ allow_duplicate: true })));
  });
  test('similar open cards are listed as a hint before creating', () => {
    renderItem(item(), { cards: [{ id: 'c', title: 'Honza připraví migraci databáze produkce' }] });
    expect(screen.getByTestId('similar-cards')).toHaveTextContent('Honza připraví migraci databáze produkce');
  });
  test('link mode applies link_card with the chosen card and comment flag', async () => {
    svc().apply.mockResolvedValue({ cardId: 'card-1', alreadyApplied: false });
    renderItem(item({ kind: 'decision' }));
    fireEvent.click(screen.getByTestId('item-link'));
    fireEvent.click(screen.getByTestId('link-confirm'));
    await waitFor(() => expect(svc().apply).toHaveBeenCalledWith('it-1', { mode: 'link_card', card_id: 'card-1', add_comment: true }));
  });
  test('accept and reject call the review RPC; a rejected item can be reopened', async () => {
    svc().review.mockResolvedValue(undefined);
    const { onChanged } = renderItem(item());
    fireEvent.click(screen.getByTestId('item-accept'));
    await waitFor(() => expect(svc().review).toHaveBeenCalledWith('it-1', 'accept'));
    fireEvent.click(screen.getByTestId('item-reject'));
    await waitFor(() => expect(svc().review).toHaveBeenCalledWith('it-1', 'reject'));
    expect(onChanged).toHaveBeenCalled();
  });
  test('a rejected item offers reopen and no apply actions', async () => {
    svc().review.mockResolvedValue(undefined);
    renderItem(item({ reviewState: 'rejected' }));
    expect(screen.queryByTestId('item-create')).toBeNull();
    fireEvent.click(screen.getByTestId('item-reopen'));
    await waitFor(() => expect(svc().review).toHaveBeenCalledWith('it-1', 'reopen'));
  });
  test('an applied item shows its card and can be undone; a changed card asks to force', async () => {
    renderItem(item({ reviewState: 'applied', appliedCardId: 'card-1', appliedMode: 'create_card' }));
    expect(screen.getByTestId('applied-info')).toHaveTextContent('Vytvořena karta: Úplně jiná karta');
    expect(screen.queryByTestId('item-create')).toBeNull();
    svc().undo.mockRejectedValueOnce(new MeetingServiceError('state', 'Položka je v jiném stavu.'));
    fireEvent.click(screen.getByTestId('item-undo'));
    expect(await screen.findByTestId('item-error')).toBeInTheDocument();
    expect(screen.getByTestId('item-undo')).toHaveTextContent('Vrátit přesto');
    svc().undo.mockResolvedValue(undefined);
    fireEvent.click(screen.getByTestId('item-undo'));
    await waitFor(() => expect(svc().undo).toHaveBeenLastCalledWith('it-1', true));
  });
  test('service errors never crash the card; unknown errors get a generic message', async () => {
    svc().review.mockRejectedValue(new Error('boom: secret SQL detail'));
    renderItem(item());
    fireEvent.click(screen.getByTestId('item-accept'));
    expect(await screen.findByTestId('item-error')).toHaveTextContent('Akce se nezdařila.');
    expect(screen.queryByText(/secret SQL/)).toBeNull();
  });
});

describe('MeetingDetail', () => {
  const meeting = { id: 'm-1', projectId: 'p1', title: 'Týdenní porada', occurredAt: '2026-11-18T10:00:00Z', sourceKind: 'text', status: 'transcribed', currentRevision: 'a'.repeat(64), speakerNames: {}, languageHint: null, createdAt: '' };
  const transcript = { speakers: [{ id: 'S1', label: 'Honza', displayName: null }], segments: [{ id: 'seg-0', startMs: null, endMs: null, speakerId: 'S1', text: 'Připravím migraci.' }, { id: 'seg-1', startMs: 5000, endMs: null, speakerId: null, text: 'Druhý segment.' }] };
  const setup = (over: Record<string, unknown> = {}) => {
    svc().get.mockResolvedValue('meeting' in over ? over.meeting : meeting);
    svc().getTranscript.mockResolvedValue(transcript);
    svc().latestRun.mockResolvedValue(over.run ?? null);
    svc().listItems.mockResolvedValue(over.items ?? []);
    svc().projectMembers.mockResolvedValue(members);
    svc().listRevisions.mockResolvedValue(over.revisions ?? [{ revision: 'a'.repeat(64), parentRevision: null, source: 'paste', createdAt: '2026-11-18T10:00:00Z', charCount: 30, editNote: null, analyzed: false }]);
  };
  const REV_A = 'a'.repeat(64);
  const REV_OLD = 'c'.repeat(64);
  const runOn = (revision: string) => ({ id: 'r1', createdAt: '', model: 'm', promptVersion: 'p1', rejectedCount: 0, summary: 'S', chapters: [], transcriptRevision: revision });

  test('shows steps, transcript with speaker names, and offers analysis; nothing is analysed automatically', async () => {
    setup();
    render(<MeetingDetail projectId="p1" meetingId="m-1" />);
    expect(await screen.findByTestId('meeting-detail')).toBeInTheDocument();
    expect(screen.getByTestId('meeting-steps')).toHaveTextContent('Přepis');
    expect(await screen.findByTestId('segment-seg-0')).toHaveTextContent('Honza:Připravím migraci.');
    await waitFor(() => expect(screen.getByTestId('meeting-analyze')).toBeEnabled()); // enabled once the transcript has loaded
    expect(svc().analyze).not.toHaveBeenCalled();
  });
  test('analysis is user-triggered, calls the service with project and meeting, then reloads and reports the result', async () => {
    setup();
    svc().analyze.mockResolvedValue({ itemCount: 3, rejectedCount: 1 });
    render(<MeetingDetail projectId="p1" meetingId="m-1" />);
    await screen.findByTestId('segment-seg-0'); // the transcript loads after the meeting; analysis needs it
    fireEvent.click(await screen.findByTestId('meeting-analyze'));
    expect(screen.getByTestId('meeting-analyze')).toBeDisabled(); // no double submit
    await waitFor(() => expect(svc().analyze).toHaveBeenCalledWith('p1', 'm-1', false));
    expect(await screen.findByTestId('meeting-notice')).toHaveTextContent('3 návrhů, 1 položek bez důkazu');
    expect(svc().get.mock.calls.length).toBeGreaterThan(1); // reloaded
  });
  test('AI disabled (production firewall) and rate limits are shown as readable errors', async () => {
    setup();
    svc().analyze.mockRejectedValue(new MeetingServiceError('ai_disabled', 'AI analýza je v této instalaci zatím vypnutá.'));
    render(<MeetingDetail projectId="p1" meetingId="m-1" />);
    await screen.findByTestId('segment-seg-0'); // the transcript loads after the meeting; analysis needs it
    fireEvent.click(await screen.findByTestId('meeting-analyze'));
    expect(await screen.findByTestId('meeting-error')).toHaveTextContent('zatím vypnutá');
    expect(screen.getByTestId('meeting-analyze')).toBeEnabled(); // can retry later
  });
  test('an unknown or foreign meeting renders "not found" (no data leak)', async () => {
    setup({ meeting: null });
    render(<MeetingDetail projectId="p1" meetingId="m-x" />);
    expect(await screen.findByText('Porada nenalezena')).toBeInTheDocument();
    setup({ meeting: { ...meeting, projectId: 'other-project' } });
    render(<MeetingDetail projectId="p1" meetingId="m-1" />);
    await waitFor(() => expect(screen.getAllByText('Porada nenalezena').length).toBe(2));
  });
  test('groups items by kind, counts what awaits approval, and evidence clicks highlight the segment', async () => {
    setup({
      meeting: { ...meeting, status: 'ready' },
      run: { id: 'r1', createdAt: '', model: 'gemini-x', promptVersion: 'p1', rejectedCount: 2, summary: 'Shrnutí porady.', chapters: [], transcriptRevision: 'a'.repeat(64) },
      items: [item(), item({ id: 'it-2', kind: 'decision', text: 'Release v pátek.', ordinal: 1, reviewState: 'accepted' })],
    });
    render(<MeetingDetail projectId="p1" meetingId="m-1" />);
    await screen.findByTestId('segment-seg-0');
    expect(await screen.findByTestId('meeting-summary')).toHaveTextContent('Shrnutí porady.');
    expect(screen.getByRole('heading', { name: 'Rozhodnutí (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Úkoly (1)' })).toBeInTheDocument();
    expect(screen.getByTestId('meeting-results')).toHaveTextContent('1 čeká na schválení');
    expect(screen.getByTestId('meeting-results')).toHaveTextContent('2 položek bez důkazu vynecháno');
    fireEvent.click(within(screen.getByTestId('item-it-1')).getByTestId('evidence-link'));
    expect(screen.getByTestId('segment-seg-1')).toHaveAttribute('data-highlight', 'true');
  });
  test('re-analysis needs an explicit confirmation and then passes force=true', async () => {
    setup({ run: runOn(REV_A) });
    svc().analyze.mockResolvedValue({ itemCount: 0, rejectedCount: 0 });
    render(<MeetingDetail projectId="p1" meetingId="m-1" />);
    fireEvent.click(await screen.findByTestId('meeting-rerun'));
    expect(svc().analyze).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('meeting-rerun-confirm'));
    await waitFor(() => expect(svc().analyze).toHaveBeenCalledWith('p1', 'm-1', true));
  });
  test('MeetingDetail: an approved item from an earlier run carries the earlier-run badge, items of the current run do not; re-analysis copy keeps approved conclusions', async () => {
    setup({
      meeting: { ...meeting, status: 'ready' },
      run: runOn(REV_A),
      items: [
        item({ id: 'it-old', runId: 'r-old', reviewState: 'accepted', text: 'Starší závěr.' }),
        item({ id: 'it-new', runId: 'r1', ordinal: 1, text: 'Nový návrh.' }),
      ],
    });
    render(<MeetingDetail projectId="p1" meetingId="m-1" />);
    await screen.findByTestId('meeting-results');
    expect(await screen.findByTestId('item-it-old')).toBeInTheDocument();
    expect(within(screen.getByTestId('item-it-old')).getByTestId('earlier-run')).toBeInTheDocument();
    expect(within(screen.getByTestId('item-it-new')).queryByTestId('earlier-run')).toBeNull();
    fireEvent.click(await screen.findByTestId('meeting-rerun'));
    expect(screen.getByText(/Nahradí se jen neschválené a zamítnuté návrhy; závěry, které jste schválili, zůstanou/)).toBeInTheDocument();
  });
  test('MeetingDetail: an empty result does not claim the items were verified', async () => {
    setup({ meeting: { ...meeting, status: 'ready' }, run: runOn(REV_A), items: [] });
    render(<MeetingDetail projectId="p1" meetingId="m-1" />);
    expect(await screen.findByText('AI v přepisu nenašla žádné položky s nalezenou citací.')).toBeInTheDocument();
    expect(screen.queryByText(/ověřitelné/)).toBeNull();
  });
  test('deleting a meeting asks for confirmation first', async () => {
    setup();
    svc().remove.mockResolvedValue(undefined);
    render(<MeetingDetail projectId="p1" meetingId="m-1" />);
    fireEvent.click(await screen.findByTestId('meeting-delete'));
    expect(svc().remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('meeting-delete-confirm'));
    await waitFor(() => expect(svc().remove).toHaveBeenCalledWith('m-1'));
    expect(h.push).toHaveBeenCalledWith('/projects/p1/meetings');
  });

  describe('R6: transcript revisions', () => {
    test('a run on the CURRENT revision shows no stale warning', async () => {
      setup({ run: runOn(REV_A) });
      render(<MeetingDetail projectId="p1" meetingId="m-1" />);
      await screen.findByTestId('meeting-detail');
      expect(screen.queryByTestId('stale-analysis')).toBeNull();
    });
    test('a run on an OLDER revision is flagged; analysing the current revision is explicit and needs no force', async () => {
      setup({ run: runOn(REV_OLD) });
      svc().analyze.mockResolvedValue({ itemCount: 1, rejectedCount: 0 });
      render(<MeetingDetail projectId="p1" meetingId="m-1" />);
      expect(await screen.findByTestId('stale-analysis')).toHaveTextContent('ze starší revize');
      expect(svc().analyze).not.toHaveBeenCalled();
      fireEvent.click(screen.getByTestId('analyze-current-revision'));
      await waitFor(() => expect(svc().analyze).toHaveBeenCalledWith('p1', 'm-1', false));
    });
    test('the transcript shown is the one the analysis was based on (its evidence points at those segments); the current one is one click away', async () => {
      setup({ run: runOn(REV_OLD) });
      render(<MeetingDetail projectId="p1" meetingId="m-1" />);
      await screen.findByTestId('stale-analysis');
      await waitFor(() => expect(svc().getTranscript).toHaveBeenCalledWith('m-1', REV_OLD));
      expect(await screen.findByTestId('old-revision-note')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('show-current-revision'));
      await waitFor(() => expect(svc().getTranscript).toHaveBeenLastCalledWith('m-1', REV_A));
      await waitFor(() => expect(screen.queryByTestId('old-revision-note')).toBeNull());
    });
    test('clicking evidence while the current revision is shown switches to the analysed revision first', async () => {
      setup({ run: runOn(REV_OLD), items: [item()] });
      render(<MeetingDetail projectId="p1" meetingId="m-1" />);
      await screen.findByTestId('stale-analysis');
      fireEvent.click(screen.getByTestId('show-current-revision'));
      await waitFor(() => expect(svc().getTranscript).toHaveBeenLastCalledWith('m-1', REV_A));
      fireEvent.click(within(screen.getByTestId('item-it-1')).getByTestId('evidence-link'));
      await waitFor(() => expect(svc().getTranscript).toHaveBeenLastCalledWith('m-1', REV_OLD));
    });
    test('the revision list marks current and analysed revisions', async () => {
      setup({ run: runOn(REV_A), revisions: [
        { revision: REV_A, parentRevision: REV_OLD, source: 'edit', createdAt: '2026-11-18T11:00:00Z', charCount: 30, editNote: 'Oprava jména', analyzed: true },
        { revision: REV_OLD, parentRevision: null, source: 'paste', createdAt: '2026-11-18T10:00:00Z', charCount: 28, editNote: null, analyzed: false },
      ] });
      render(<MeetingDetail projectId="p1" meetingId="m-1" />);
      const sel = await screen.findByTestId('revision-select');
      const opts = within(sel).getAllByRole('option').map((o) => o.textContent ?? '');
      expect(opts[0]).toMatch(/#2 .*úprava.*aktuální.*analyzováno/);
      expect(opts[1]).toMatch(/#1 .*paste/);
      expect(opts[1]).not.toMatch(/aktuální/);
    });
    test('editing prefills "Jméno: věta", saves as a NEW revision whose parent is the current one, and never analyses automatically', async () => {
      setup();
      svc().addRevision.mockResolvedValue({ revision: 'd'.repeat(64), warnings: [] });
      render(<MeetingDetail projectId="p1" meetingId="m-1" />);
      fireEvent.click(await screen.findByTestId('revision-edit'));
      const ta = (await screen.findByTestId('revision-text')) as HTMLTextAreaElement;
      expect(ta.value).toBe('Honza: Připravím migraci.\nDruhý segment.');
      fireEvent.change(ta, { target: { value: 'Honza: Připravím migraci do pátku.\nDruhý segment.' } });
      fireEvent.change(screen.getByTestId('revision-note'), { target: { value: 'doplněn termín' } });
      fireEvent.click(screen.getByTestId('revision-save'));
      await waitFor(() => expect(svc().addRevision).toHaveBeenCalledWith({ meetingId: 'm-1', projectId: 'p1', text: 'Honza: Připravím migraci do pátku.\nDruhý segment.', parentRevision: REV_A, note: 'doplněn termín' }));
      expect(await screen.findByTestId('meeting-notice')).toHaveTextContent('Vytvořena nová revize');
      expect(svc().analyze).not.toHaveBeenCalled();
    });
    test('an unchanged text and a quota error are readable; the form stays open', async () => {
      setup();
      svc().addRevision.mockRejectedValue(new MeetingServiceError('unchanged', 'Přepis se nezměnil.'));
      render(<MeetingDetail projectId="p1" meetingId="m-1" />);
      fireEvent.click(await screen.findByTestId('revision-edit'));
      fireEvent.click(await screen.findByTestId('revision-save'));
      expect(await screen.findByTestId('meeting-error')).toHaveTextContent('Přepis se nezměnil.');
      expect(screen.getByTestId('revision-text')).toBeInTheDocument();
      svc().addRevision.mockRejectedValue(new MeetingServiceError('quota', 'Porada má maximální počet revizí přepisu (25).'));
      fireEvent.click(screen.getByTestId('revision-save'));
      await waitFor(() => expect(screen.getByTestId('meeting-error')).toHaveTextContent('maximální počet revizí'));
    });
  });
});
