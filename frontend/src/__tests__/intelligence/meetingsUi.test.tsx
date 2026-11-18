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
  const names = ['createWithTranscript', 'get', 'getTranscript', 'latestRun', 'listItems', 'projectMembers', 'analyze', 'review', 'apply', 'undo', 'remove', 'renameSpeakers', 'list', 'pendingCounts'];
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

describe('ItemCard: evidence, hints and approval', () => {
  test('shows verified badge, evidence quote with time, and the owner/due hints as TEXT (not as data)', () => {
    renderItem(item());
    expect(screen.getByText('Ověřeno')).toBeInTheDocument();
    expect(screen.getByTestId('evidence-link')).toHaveTextContent('„Honza připraví migraci databáze"');
    expect(screen.getByTestId('evidence-link')).toHaveTextContent('0:05');
    expect(screen.getByTestId('item-hints')).toHaveTextContent('Vlastník z textu: Honza');
    expect(screen.getByTestId('item-hints')).toHaveTextContent('datum zadejte ručně');
  });
  test('clicking evidence jumps to the transcript segment', () => {
    const { onJump } = renderItem(item());
    fireEvent.click(screen.getByTestId('evidence-link'));
    expect(onJump).toHaveBeenCalledWith('seg-1');
  });
  test('unverified items are clearly marked', () => {
    renderItem(item({ kind: 'risk', support: 'unverified', evidence: [{ ref: 'segment:seg-2', quote: 'něco', quoteFound: false }] }));
    expect(screen.getByText('Neověřeno')).toBeInTheDocument();
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
  };

  test('shows steps, transcript with speaker names, and offers analysis; nothing is analysed automatically', async () => {
    setup();
    render(<MeetingDetail projectId="p1" meetingId="m-1" />);
    expect(await screen.findByTestId('meeting-detail')).toBeInTheDocument();
    expect(screen.getByTestId('meeting-steps')).toHaveTextContent('Přepis');
    expect(screen.getByTestId('segment-seg-0')).toHaveTextContent('Honza:Připravím migraci.');
    expect(screen.getByTestId('meeting-analyze')).toBeEnabled();
    expect(svc().analyze).not.toHaveBeenCalled();
  });
  test('analysis is user-triggered, calls the service with project and meeting, then reloads and reports the result', async () => {
    setup();
    svc().analyze.mockResolvedValue({ itemCount: 3, rejectedCount: 1 });
    render(<MeetingDetail projectId="p1" meetingId="m-1" />);
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
      run: { id: 'r1', createdAt: '', model: 'gemini-x', promptVersion: 'p1', rejectedCount: 2, summary: 'Shrnutí porady.', chapters: [] },
      items: [item(), item({ id: 'it-2', kind: 'decision', text: 'Release v pátek.', ordinal: 1, reviewState: 'accepted' })],
    });
    render(<MeetingDetail projectId="p1" meetingId="m-1" />);
    expect(await screen.findByTestId('meeting-summary')).toHaveTextContent('Shrnutí porady.');
    expect(screen.getByRole('heading', { name: 'Rozhodnutí (1)' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Úkoly (1)' })).toBeInTheDocument();
    expect(screen.getByTestId('meeting-results')).toHaveTextContent('1 čeká na schválení');
    expect(screen.getByTestId('meeting-results')).toHaveTextContent('2 položek bez důkazu vynecháno');
    fireEvent.click(within(screen.getByTestId('item-it-1')).getByTestId('evidence-link'));
    expect(screen.getByTestId('segment-seg-1')).toHaveAttribute('data-highlight', 'true');
  });
  test('re-analysis needs an explicit confirmation and then passes force=true', async () => {
    setup({ run: { id: 'r1', createdAt: '', model: 'm', promptVersion: 'p1', rejectedCount: 0, summary: 'S', chapters: [] } });
    svc().analyze.mockResolvedValue({ itemCount: 0, rejectedCount: 0 });
    render(<MeetingDetail projectId="p1" meetingId="m-1" />);
    fireEvent.click(await screen.findByTestId('meeting-rerun'));
    expect(svc().analyze).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('meeting-rerun-confirm'));
    await waitFor(() => expect(svc().analyze).toHaveBeenCalledWith('p1', 'm-1', true));
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
});
