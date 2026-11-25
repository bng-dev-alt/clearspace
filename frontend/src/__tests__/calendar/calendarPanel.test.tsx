import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { GoogleStatus } from '../../services/driveService';
import type { CalendarLink, OwnEvent } from '../../services/calendarService';

const h = vi.hoisted(() => ({ status: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), me: vi.fn(), list: vi.fn(), events: vi.fn(), attach: vi.fn(), refresh: vi.fn(), openUrl: vi.fn(), remove: vi.fn(), disable: vi.fn() }));
vi.mock('../../services/driveService', async () => {
  const real = await vi.importActual<typeof import('../../services/driveService')>('../../services/driveService');
  return { ...real, driveService: { status: h.status, connect: h.connect, disconnect: h.disconnect } };
});
vi.mock('../../services/gmailService', async () => {
  const real = await vi.importActual<typeof import('../../services/gmailService')>('../../services/gmailService');
  return { ...real, gmailService: { ...real.gmailService, myUserId: h.me } };
});
vi.mock('../../services/calendarService', async () => {
  const real = await vi.importActual<typeof import('../../services/calendarService')>('../../services/calendarService');
  return { ...real, calendarService: { list: h.list, events: h.events, attach: h.attach, refresh: h.refresh, openUrl: h.openUrl, remove: h.remove, disable: h.disable } };
});
import CalendarLinksPanel from '../../components/calendar/CalendarLinksPanel';
import CalendarPickerModal from '../../components/calendar/CalendarPickerModal';
import GoogleConnectionCard from '../../components/drive/GoogleConnectionCard';
import { ProjectCalendarView } from '../../components/calendar/useProjectCalendarLayers';

const ME = 'u-alice';
const st = (services: { drive: boolean; gmail: boolean; calendar: boolean } | null, calendarAvailable = true): GoogleStatus => ({
  configured: true, gmailAvailable: true, calendarAvailable, simulated: true,
  connection: services ? { email: 'anna.mock@example.test', scopes: [], status: 'active', connectedAt: '2026-11-20T00:00:00Z', services } : null,
});
const link = (over: Partial<CalendarLink> = {}): CalendarLink => ({
  id: '11111111-1111-4111-8111-111111111111', projectId: 'p1', cardId: null, title: 'Kickoff Corvane', start: '2026-12-01T08:00:00.000Z', end: '2026-12-01T09:30:00.000Z',
  allDay: false, timeZone: 'Europe/Prague', recurring: false, attendees: 4, organizer: 'Jana Dvořáková (simulace)', state: 'ok', linkedBy: ME, linkedByName: 'Alice',
  createdAt: '2026-11-20T00:00:00Z', checkedAt: '2026-11-20T00:00:00Z', ...over,
});
const theirs = link({ id: '22222222-2222-4222-8222-222222222222', title: '<img src=x onerror=alert(1)> Bobova schůzka', linkedBy: 'u-bob', linkedByName: 'Bob', recurring: true, attendees: 1 });
const own = (over: Partial<OwnEvent> = {}): OwnEvent => ({
  id: 'kickoffcorvane0001', recurringEventId: null, title: 'Kickoff Corvane', start: '2026-12-01T08:00:00.000Z', end: '2026-12-01T09:30:00.000Z', allDay: false, timeZone: 'Europe/Prague',
  recurring: false, modified: false, attendees: 4, organizer: 'Jana', private: false, state: 'ok', htmlLink: 'https://www.google.com/calendar/event?eid=abc', ...over,
});

beforeEach(() => {
  Object.values(h).forEach((f) => f.mockReset());
  h.list.mockResolvedValue([link(), theirs, link({ id: '33333333-3333-4333-8333-333333333333', cardId: 'c1', title: 'Workshop Brno', allDay: true, start: '2026-11-30T00:00:00.000Z', end: '2026-12-03T00:00:00.000Z' })]);
  h.status.mockResolvedValue(st({ drive: true, gmail: true, calendar: true }));
  h.me.mockResolvedValue(ME);
  h.events.mockResolvedValue({ items: [own(), own({ id: 'lekarsoukrome00001', title: 'Lékař', private: true, start: '2026-12-04T07:00:00.000Z', end: '2026-12-04T08:00:00.000Z' })], nextPageToken: null });
});

describe('CalendarLinksPanel', () => {
  it('shared metadata only; titles are text, never markup; privacy notice; task overview; simulated badge', async () => {
    render(<CalendarLinksPanel projectId="p1" canEdit returnTo="/projects/p1" cardTitle={() => 'Kickoff s klientem'} />);
    expect(await screen.findByText('Kickoff Corvane')).toBeTruthy();
    expect(screen.getByText('<img src=x onerror=alert(1)> Bobova schůzka')).toBeTruthy();
    expect(document.querySelector('[data-testid="project-calendar-section"] img')).toBeNull();
    const meta = screen.getAllByTestId('calendar-link-meta')[0].textContent ?? '';
    expect(meta).toMatch(/4 účastníci · pořádá Jana Dvořáková \(simulace\) · připojil\(a\) Alice/);
    expect(meta).not.toMatch(/@/);
    expect((await screen.findByTestId('calendar-privacy-note')).textContent).toMatch(/Popis, místo, adresy účastníků a odkazy na schůzky zůstávají jen ve vašem kalendáři/);
    expect(screen.getByTestId('calendar-task-list').textContent).toMatch(/Workshop Brno.*30\. 11\. 2026 – 2\. 12\. 2026 \(celý den\).*úkol „Kickoff s klientem“/);
    expect(screen.getByText('simulace')).toBeTruthy();
  });

  it('open + refresh only on MY links; remove for editors on all; owner of the project cannot open others\' events', async () => {
    render(<CalendarLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    await screen.findByText('Kickoff Corvane');
    await waitFor(() => expect(screen.getAllByTestId('calendar-open')).toHaveLength(2));
    const bob = screen.getByTestId(`calendar-link-${theirs.id}`);
    expect(within(bob).queryByTestId('calendar-open')).toBeNull();
    expect(within(bob).queryByTestId('calendar-refresh')).toBeNull();
    expect(within(bob).getByTestId('calendar-remove')).toBeTruthy();
  });

  it.each([
    ['editor + Calendar', true, { drive: true, gmail: true, calendar: true }, true, true, false],
    ['editor, Drive + Gmail only', true, { drive: true, gmail: true, calendar: false }, false, true, true],
    ['editor, no Google', true, null, false, true, true],
    ['viewer + Calendar', false, { drive: false, gmail: false, calendar: true }, false, false, false],
  ] as const)('role matrix: %s', async (_l, canEdit, services, canAdd, canRemove, offersConnect) => {
    h.status.mockResolvedValue(st(services));
    render(<CalendarLinksPanel projectId="p1" canEdit={canEdit} returnTo="/projects/p1" />);
    await screen.findByText('Kickoff Corvane');
    await waitFor(() => expect(h.status).toHaveBeenCalled());
    await waitFor(() => expect(Boolean(screen.queryByTestId('calendar-attach'))).toBe(canAdd));
    expect(screen.queryAllByTestId('calendar-remove').length > 0).toBe(canRemove);
    expect(Boolean(screen.queryByTestId('calendar-connect'))).toBe(offersConnect);
    if (!services?.calendar) expect(screen.queryAllByTestId('calendar-open')).toHaveLength(0);
  });

  it('switch off on the server: no section when nothing is linked; existing links stay readable', async () => {
    h.status.mockResolvedValue(st({ drive: true, gmail: true, calendar: true }, false));
    h.list.mockResolvedValue([]);
    const { container } = render(<CalendarLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    await waitFor(() => expect(h.list).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[data-testid="project-calendar-section"]')).toBeNull());
    h.list.mockResolvedValue([link()]);
    render(<CalendarLinksPanel projectId="p2" canEdit returnTo="/projects/p2" />);
    expect(await screen.findByTestId('calendar-unavailable')).toBeTruthy();
    expect(screen.queryByTestId('calendar-attach')).toBeNull();
  });

  it('deleted event: state shown, no "open", refresh still offered to its owner', async () => {
    h.list.mockResolvedValue([link({ state: 'deleted' })]);
    render(<CalendarLinksPanel projectId="p1" canEdit returnTo="/projects/p1" />);
    expect((await screen.findByTestId('calendar-link-problem')).textContent).toMatch(/zrušena nebo smazána/);
    await waitFor(() => expect(screen.getByTestId('calendar-refresh')).toBeTruthy());
    expect(screen.queryByTestId('calendar-open')).toBeNull();
  });
});

describe('CalendarPickerModal', () => {
  it('own events; private ones cannot be selected; nothing attached without confirmation; result message', async () => {
    h.attach.mockResolvedValue({ links: [{ id: 'l1', eventId: 'kickoffcorvane0001', duplicate: false }], failed: [] });
    const onAttached = vi.fn();
    render(<CalendarPickerModal projectId="p1" cardId={null} simulated onClose={() => {}} onAttached={onAttached} />);
    expect(await screen.findByText(/Lékař/)).toBeTruthy();
    expect((screen.getByTestId('calendar-pick-lekarsoukrome00001') as HTMLInputElement).disabled).toBe(true);
    expect(h.attach).not.toHaveBeenCalled();
    expect((screen.getByTestId('calendar-attach-selected') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('calendar-pick-kickoffcorvane0001'));
    fireEvent.click(screen.getByTestId('calendar-attach-selected'));
    await waitFor(() => expect(onAttached).toHaveBeenCalledWith('Připojeno událostí: 1.', false));
    expect(h.attach).toHaveBeenCalledWith('p1', null, ['kickoffcorvane0001']);
    const q = h.events.mock.calls[0][0];
    expect(Date.parse(q.to) - Date.parse(q.from)).toBeLessThanOrEqual(42 * 86_400_000);
  });
  it('a range over 42 days is refused in the dialog (no request)', async () => {
    render(<CalendarPickerModal projectId="p1" cardId={null} simulated={false} onClose={() => {}} onAttached={() => {}} />);
    await screen.findByText(/Kickoff Corvane/);
    h.events.mockClear();
    fireEvent.change(screen.getByTestId('calendar-filter-from'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByTestId('calendar-filter-to'), { target: { value: '2027-02-01' } });
    fireEvent.click(screen.getByTestId('calendar-search-submit'));
    expect((await screen.findByTestId('calendar-picker-error')).textContent).toMatch(/nejvýš 42 dní/);
    expect(h.events).not.toHaveBeenCalled();
  });
});

describe('project calendar layers', () => {
  it('linked events for everyone; "my calendar" only after the viewer turns it on; private own event cannot be attached', async () => {
    window.localStorage.removeItem('cs_calendar_my_layer');
    render(<ProjectCalendarView projectId="p1" canEdit returnTo="/projects/p1" columns={[]} month={new Date(2026, 11, 1)} onPrevMonth={() => {}} onNextMonth={() => {}} onToday={() => {}} onCardClick={() => {}} />);
    expect(await screen.findByTestId(`calendar-event-l-${link().id}`)).toBeTruthy();
    expect(screen.getAllByTestId('calendar-event-l-33333333-3333-4333-8333-333333333333')).toHaveLength(3);   // E3: a 3-day all-day event appears on each of its days (30. 11., 1. 12., 2. 12.)
    expect(h.events).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('calendar-my-layer'));
    await waitFor(() => expect(h.events).toHaveBeenCalled());
    const q = h.events.mock.calls[0][0];
    expect(Date.parse(q.to) - Date.parse(q.from)).toBe(42 * 86_400_000);
    fireEvent.click(await screen.findByTestId('calendar-event-m-lekarsoukrome00001'));
    expect(await screen.findByTestId('calendar-own-private')).toBeTruthy();
    expect(screen.queryByTestId('calendar-own-attach')).toBeNull();
  });
});

describe('Google settings card: Calendar row', () => {
  it('connect / disable Calendar independently of Drive and Gmail', async () => {
    h.status.mockResolvedValue(st({ drive: true, gmail: true, calendar: false }));
    render(<GoogleConnectionCard />);
    fireEvent.click(await screen.findByTestId('calendar-connect-settings'));
    await waitFor(() => expect(h.connect).toHaveBeenCalledWith('/settings', 'calendar'));
  });
  it('server switch off: says so, no button', async () => {
    h.status.mockResolvedValue(st({ drive: true, gmail: false, calendar: false }, false));
    render(<GoogleConnectionCard />);
    expect((await screen.findByTestId('calendar-service-state')).textContent).toMatch(/Na tomto serveru není zapnutý/);
    expect(screen.queryByTestId('calendar-connect-settings')).toBeNull();
    expect(screen.queryByTestId('google-privacy-calendar')).toBeNull();
  });
  it('disable asks twice (turn off; purge?) and reports', async () => {
    h.disable.mockResolvedValue({ calendarRemoved: true, purged: { removed: 3, skipped: 0 } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<GoogleConnectionCard />);
    fireEvent.click(await screen.findByTestId('calendar-disable'));
    await waitFor(() => expect(h.disable).toHaveBeenCalledWith(true));
    expect(confirm.mock.calls[0][0]).toMatch(/Google Disk a Gmail zůstanou připojené/);
    expect((await screen.findByTestId('google-connection-message')).textContent).toMatch(/Odebráno připojených událostí: 3/);
    confirm.mockRestore();
  });
});
