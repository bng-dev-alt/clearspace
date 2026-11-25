import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { GoogleStatus } from '../../services/driveService';
import type { GmailLink } from '../../services/gmailService';

const h = vi.hoisted(() => ({ status: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), list: vi.fn(), me: vi.fn(), search: vi.fn(), attach: vi.fn(), preview: vi.fn(), refresh: vi.fn(), remove: vi.fn(), disable: vi.fn() }));
vi.mock('../../services/driveService', async () => {
  const real = await vi.importActual<typeof import('../../services/driveService')>('../../services/driveService');
  return { ...real, driveService: { status: h.status, connect: h.connect, disconnect: h.disconnect } };
});
vi.mock('../../services/gmailService', async () => {
  const real = await vi.importActual<typeof import('../../services/gmailService')>('../../services/gmailService');
  return { ...real, gmailService: { list: h.list, myUserId: h.me, search: h.search, attach: h.attach, preview: h.preview, refresh: h.refresh, remove: h.remove, disable: h.disable } };
});
import GmailLinksPanel from '../../components/gmail/GmailLinksPanel';
import GoogleConnectionCard from '../../components/drive/GoogleConnectionCard';

const ME = 'u-alice';
const st = (services: { drive: boolean; gmail: boolean } | null, gmailAvailable = true): GoogleStatus => ({
  configured: true, gmailAvailable, simulated: true,
  connection: services ? { email: 'anna.mock@example.test', scopes: [], status: 'active', connectedAt: '2026-11-20T00:00:00Z', services } : null,
});
const link = (over: Partial<GmailLink> = {}): GmailLink => ({
  id: '11111111-1111-4111-8111-111111111111', projectId: 'p1', cardId: null, kind: 'thread', subject: 'Nabídka na redesign portálu – Corvane',
  from: 'Jana Dvořáková (simulace)', date: '2026-11-12T09:15:00Z', count: 3, attachments: 2, state: 'ok', linkedBy: ME, linkedByName: 'Alice',
  createdAt: '2026-11-20T00:00:00Z', checkedAt: '2026-11-20T00:00:00Z', ...over,
});
const theirs = link({ id: '22222222-2222-4222-8222-222222222222', kind: 'message', subject: '<img src=x onerror=alert(1)> Bobův e-mail', linkedBy: 'u-bob', linkedByName: 'Bob', count: 1, attachments: 0 });

describe('GmailLinksPanel', () => {
  beforeEach(() => {
    Object.values(h).forEach((f) => f.mockReset());
    h.list.mockResolvedValue([link(), theirs, link({ id: '33333333-3333-4333-8333-333333333333', cardId: 'c1', subject: 'Faktura 2026-118', kind: 'message' })]);
    h.status.mockResolvedValue(st({ drive: true, gmail: true }));
    h.me.mockResolvedValue(ME);
  });

  it('shows shared metadata only; subjects are text, never markup; visibility notice for editors', async () => {
    render(<GmailLinksPanel projectId="p1" canEdit returnTo="/projects/p1" cardTitle={() => 'Smlouva'} />);
    expect(await screen.findByText('Nabídka na redesign portálu – Corvane')).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=alert(1)> Bobův e-mail')).toBeTruthy();
    expect(document.querySelector('[data-testid="project-gmail-section"] img')).toBeNull();
    const meta = screen.getAllByTestId('gmail-link-meta')[0].textContent ?? '';
    expect(meta).toMatch(/Konverzace · 3 zprávy · od Jana Dvořáková \(simulace\)/);
    expect(meta).toMatch(/2 přílohy/);
    expect(meta).not.toMatch(/@/);
    expect((await screen.findByTestId('gmail-privacy-note')).textContent).toMatch(/Obsah zpráv, adresy, přílohy .* zůstávají jen ve vaší schránce/);
    expect(screen.getByTestId('gmail-task-list').textContent).toContain('Faktura 2026-118');
    expect(screen.getByText('simulace')).toBeTruthy();
  });

  it('preview + refresh only on MY links (the owner\'s own mailbox); remove for editors on all', async () => {
    render(<GmailLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    await screen.findByText('Nabídka na redesign portálu – Corvane');
    await waitFor(() => expect(screen.getAllByTestId('gmail-preview')).toHaveLength(2));   // my project-level + my task-level link
    const bobRow = screen.getByTestId(`gmail-link-${theirs.id}`);
    expect(within(bobRow).queryByTestId('gmail-preview')).toBeNull();
    expect(within(bobRow).queryByTestId('gmail-refresh')).toBeNull();
    expect(within(bobRow).getByTestId('gmail-remove')).toBeTruthy();
  });

  it.each([
    ['editor + Gmail', true, { drive: true, gmail: true }, true, true, false],
    ['editor, Drive only (no Gmail scope)', true, { drive: true, gmail: false }, false, true, true],
    ['editor, no Google', true, null, false, true, true],
    ['viewer + Gmail', false, { drive: true, gmail: true }, false, false, false],
    ['viewer, no Google', false, null, false, false, false],
  ] as const)('role matrix: %s', async (_l, canEdit, services, canAdd, canRemove, offersConnect) => {
    h.status.mockResolvedValue(st(services));
    render(<GmailLinksPanel projectId="p1" canEdit={canEdit} returnTo="/projects/p1" />);
    await screen.findByText('Nabídka na redesign portálu – Corvane');
    await waitFor(() => expect(h.status).toHaveBeenCalled());
    await waitFor(() => expect(Boolean(screen.queryByTestId('gmail-attach'))).toBe(canAdd));
    expect(screen.queryAllByTestId('gmail-remove').length > 0).toBe(canRemove);
    expect(Boolean(screen.queryByTestId('gmail-connect'))).toBe(offersConnect);
    if (!services?.gmail) expect(screen.queryAllByTestId('gmail-preview')).toHaveLength(0);
  });

  it('feature switched off on the server: no section when nothing is linked; existing links stay readable', async () => {
    h.status.mockResolvedValue(st({ drive: true, gmail: true }, false));
    h.list.mockResolvedValue([]);
    const { container } = render(<GmailLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-testid="project-gmail-section"]')).toBeNull());
    h.list.mockResolvedValue([link()]);
    render(<GmailLinksPanel projectId="p2" canEdit returnTo="/projects/p2" />);
    expect(await screen.findByTestId('gmail-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('gmail-attach')).toBeNull();
  });

  it('connect asks for the Gmail service (incremental), returning to the project', async () => {
    h.status.mockResolvedValue(st({ drive: true, gmail: false }));
    render(<GmailLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    fireEvent.click(await screen.findByTestId('gmail-connect'));
    await waitFor(() => expect(h.connect).toHaveBeenCalledWith('/projects/p1', 'gmail'));
  });

  it('preview renders untrusted content as TEXT (no HTML, no images); attachments are names only; open-in-Gmail is noreferrer', async () => {
    h.preview.mockResolvedValue({ webUrl: 'https://mail.google.com/mail/u/0/#all/18c3a5e000000000', content: { subject: 'S', omittedMessages: 0, state: 'ok', retrievedAt: '', messages: [
      { from: { name: 'Jana', address: 'jana@corvane.example' }, date: '2026-11-12T09:15:00Z', subject: 'S', text: '<script>alert(1)</script><img src="https://t.example/p.gif">', fromHtml: false, truncated: true, missing: false, attachments: [{ name: 'faktura.pdf', mimeType: 'application/pdf', size: 48213 }] },
    ] } });
    render(<GmailLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    fireEvent.click((await screen.findAllByTestId('gmail-preview'))[0]);
    const modal = await screen.findByTestId('gmail-preview-modal');
    await within(modal).findByTestId('gmail-preview-text');
    expect(within(modal).getByTestId('gmail-preview-text').textContent).toBe('<script>alert(1)</script><img src="https://t.example/p.gif">');
    expect(modal.querySelector('img, script, iframe')).toBeNull();
    expect(within(modal).getByTestId('gmail-preview-attachments').textContent).toMatch(/faktura\.pdf \(47 kB\).*nestahuje/);
    const open = within(modal).getByTestId('gmail-open') as HTMLAnchorElement;
    expect(open.rel).toBe('noopener noreferrer');
    expect(open.href.startsWith('https://mail.google.com/')).toBe(true);
    expect(modal.textContent).toMatch(/Zobrazuje se jen vám/);
  });

  it('remove asks first and says Gmail stays untouched', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    h.remove.mockResolvedValue(undefined);
    render(<GmailLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    fireEvent.click((await screen.findAllByTestId('gmail-remove'))[0]);
    expect(confirm.mock.calls[0][0]).toMatch(/Ve vaší schránce Gmail se nic nezmění/);
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith(link().id));
    confirm.mockRestore();
  });

  it('picker: explains privacy, searches with filters, pages, attaches ONLY the explicit selection (max 10)', async () => {
    const item = (i: number) => ({ kind: 'thread', id: `18c3a5e0000000${String(i).padStart(2, '0')}`, threadId: `18c3a5e0000000${String(i).padStart(2, '0')}`, subject: `Týdenní report #${i}`, from: { name: 'Reporting', address: 'report@corvane.example', domain: 'corvane.example' }, date: null, messageCount: 1, snippet: 'vše v pořádku', state: 'ok' });
    h.search.mockResolvedValueOnce({ items: Array.from({ length: 12 }, (_, i) => item(i)), nextPageToken: '12', estimate: 30 })
      .mockResolvedValueOnce({ items: [item(1)], nextPageToken: null, estimate: 1 })
      .mockResolvedValueOnce({ items: [item(20)], nextPageToken: null, estimate: 30 });
    h.attach.mockResolvedValue({ links: [{ id: 'l1', kind: 'thread', itemId: item(1).id, duplicate: false }, { id: 'l2', kind: 'thread', itemId: item(2).id, duplicate: true }], failed: [] });
    render(<GmailLinksPanel projectId="p1" cardId="c1" canEdit returnTo="/projects/p1" />);
    fireEvent.click(await screen.findByTestId('gmail-attach'));
    const picker = await screen.findByTestId('gmail-picker');
    expect(within(picker).getByTestId('gmail-picker-privacy').textContent).toMatch(/nic nemění a neposílá/);
    await within(picker).findByText('Týdenní report #0');
    expect(h.search).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'thread', pageToken: null }));
    for (let i = 0; i < 12; i++) fireEvent.click(within(picker).getByTestId(`gmail-pick-${item(i).id}`));
    expect(within(picker).getByTestId('gmail-attach-selected').textContent).toBe('Připojit vybrané (10)');
    fireEvent.change(within(picker).getByTestId('gmail-filter-from'), { target: { value: 'Reporting' } });
    fireEvent.click(within(picker).getByTestId('gmail-search-submit'));
    await waitFor(() => expect(h.search).toHaveBeenLastCalledWith(expect.objectContaining({ from: 'Reporting', pageToken: null })));
    await within(picker).findByText('Týdenní report #1');
    expect(within(picker).getByTestId('gmail-page-next')).toHaveProperty('disabled', true);
    fireEvent.click(within(picker).getByTestId('gmail-attach-selected'));
    await waitFor(() => expect(h.attach).toHaveBeenCalled());
    const [pid, cid, items] = h.attach.mock.calls[0];
    expect([pid, cid]).toEqual(['p1', 'c1']);
    expect(items).toHaveLength(10);
    expect(items[0]).toEqual({ kind: 'thread', id: item(0).id });
    expect((await screen.findByTestId('gmail-message')).textContent).toMatch(/Připojeno e-mailů: 1\. Jeden e-mail už byl připojený\./);
  });

  it('picker: Gmail errors are shown in Czech, empty results are not an error', async () => {
    const { DriveError } = await import('../../services/driveService');
    h.search.mockRejectedValueOnce(new DriveError('rate_limited', 'Příliš mnoho požadavků na Gmail. Zkuste to prosím za několik minut.', 429))
      .mockResolvedValueOnce({ items: [], nextPageToken: null, estimate: 0 });
    render(<GmailLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    fireEvent.click(await screen.findByTestId('gmail-attach'));
    expect((await screen.findByTestId('gmail-picker-error')).textContent).toMatch(/Příliš mnoho požadavků/);
    fireEvent.click(screen.getByTestId('gmail-search-submit'));
    expect(await screen.findByTestId('gmail-picker-empty')).toBeTruthy();
  });
});

describe('GoogleConnectionCard (Propojené účty)', () => {
  beforeEach(() => Object.values(h).forEach((f) => f.mockReset()));

  it('one account, per-service state; Gmail can be turned off without touching Drive; honest about grant-level revocation', async () => {
    h.status.mockResolvedValue(st({ drive: true, gmail: true }));
    h.disable.mockResolvedValue({ gmailRemoved: true, purged: { removed: 3, skipped: 1 } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true).mockReturnValueOnce(true);
    render(<GoogleConnectionCard />);
    expect((await screen.findByTestId('google-account-email')).textContent).toBe('anna.mock@example.test');
    expect(screen.getByTestId('drive-service-state').textContent).toMatch(/^Povoleno/);
    expect(screen.getByTestId('gmail-service-state').textContent).toMatch(/^Povoleno – jen čtení/);
    expect(screen.getByTestId('google-privacy').textContent).toMatch(/jednotlivé služby Google zvlášť zrušit neumí/);
    fireEvent.click(screen.getByTestId('gmail-disable'));
    expect(confirm.mock.calls[0][0]).toMatch(/Google Disk zůstane připojený.*Oprávnění u Googlu zůstane/);
    await waitFor(() => expect(h.disable).toHaveBeenCalledWith(true));
    expect((await screen.findByTestId('google-connection-message')).textContent).toMatch(/Odebráno připojených e-mailů: 3\. U 1 jste jen čtenář/);
    confirm.mockRestore();
  });

  it('not connected: Drive button keeps the RUN 02 contract; Gmail offered separately; full disconnect says it ends Drive AND Gmail', async () => {
    h.status.mockResolvedValue(st(null));
    render(<GoogleConnectionCard />);
    expect((await screen.findByTestId('google-connect')).textContent).toBe('Připojit Google Disk');
    expect(screen.getByTestId('google-connection-card').textContent).toContain('jen k souborům, které vyberete');
    fireEvent.click(screen.getByTestId('gmail-connect-settings'));
    await waitFor(() => expect(h.connect).toHaveBeenCalledWith('/settings', 'gmail'));
  });

  it('full disconnect confirmation names both services; Gmail switched off on the server is shown as such', async () => {
    h.status.mockResolvedValue(st({ drive: true, gmail: false }, false));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<GoogleConnectionCard />);
    expect((await screen.findByTestId('gmail-service-state')).textContent).toMatch(/Na tomto serveru není zapnutý/);
    expect(screen.queryByTestId('gmail-connect-settings')).toBeNull();
    fireEvent.click(screen.getByTestId('google-disconnect'));
    expect(confirm.mock.calls[0][0]).toMatch(/Google Disk i Gmail.*Soubory připojené k projektům/);
    expect(h.disconnect).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('return outcomes of the incremental Gmail consent are explained in Czech', async () => {
    h.status.mockResolvedValue(st({ drive: true, gmail: false }));
    render(<GoogleConnectionCard returnOutcome="gmail_denied" />);
    expect((await screen.findByTestId('google-connection-message')).textContent).toMatch(/Ostatní propojení \(Google Disk\) zůstávají beze změny/);
  });

  it('RUN 03C: a permanently deleted e-mail offers no preview (only refresh + the stored metadata)', async () => {
    const gone = link({ id: '44444444-4444-4444-8444-444444444444', subject: 'Smazaná konverzace', state: 'deleted' });
    h.list.mockResolvedValue([gone]);
    h.status.mockResolvedValue(st({ drive: true, gmail: true }));
    h.me.mockResolvedValue(ME);
    render(<GmailLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    const row = await screen.findByTestId(`gmail-link-${gone.id}`);
    await waitFor(() => expect(within(row).getByTestId('gmail-refresh')).toBeTruthy());
    expect(within(row).queryByTestId('gmail-preview')).toBeNull();
    expect(within(row).getByTestId('gmail-link-problem').textContent).toMatch(/už ve schránce .* není/);
  });

  it('RUN 03C: a Google timeout during connect says nothing changed and to try again (manual retry, no replay)', async () => {
    h.status.mockResolvedValue(st({ drive: true, gmail: false }));
    render(<GoogleConnectionCard returnOutcome="unavailable" />);
    expect((await screen.findByTestId('google-connection-message')).textContent).toMatch(/neodpověděl včas.*Nic se neuložilo.*zkuste to prosím znovu/);
    expect(await screen.findByTestId('gmail-connect-settings')).toBeTruthy();
  });
});
