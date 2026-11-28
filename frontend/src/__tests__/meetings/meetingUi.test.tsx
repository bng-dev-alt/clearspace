import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({ svc: {} as Record<string, ReturnType<typeof vi.fn>> }));
vi.mock('../../services/meetingService', async () => {
  const real = await vi.importActual<typeof import('../../services/meetingService')>('../../services/meetingService');
  class MeetingServiceError extends Error { code: string; constructor(code: string, message: string) { super(message); this.code = code; } }
  for (const n of ['listAttendees', 'calendarLink', 'addAttendees', 'removeAttendee', 'updateSchedule', 'calendar', 'livePartial', 'callStt']) h.svc[n] = vi.fn();
  return { MeetingServiceError, meetingService: h.svc, parseAttendees: real.parseAttendees };
});
vi.mock('../../lib/supabase', () => ({ supabase: { rpc: vi.fn(async () => ({ data: null, error: null })) }, hasSupabaseConfig: true }));

import ScheduleCard, { conferenceProvider, inviteText } from '../../components/meetings/ScheduleCard';
import LivePanel, { INVITE_NOTICE } from '../../components/meetings/LivePanel';
import { parseAttendees, type Meeting } from '../../services/meetingService';

const svc = () => h.svc;
const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  id: 'm1', projectId: 'p1', title: 'Kickoff CORVANE', occurredAt: new Date(Date.now() + 86_400_000).toISOString(),
  endsAt: new Date(Date.now() + 90_000_000).toISOString(), sourceKind: 'audio', status: 'draft', currentRevision: null, speakerNames: {},
  languageHint: null, createdAt: '', conferenceUrl: null, createdBy: 'u1', live: { state: 'idle', ms: 0, segments: 0 },
  audio: { consentAt: null, path: null, bytes: null, uploadedAt: null, deleteAfter: null, deletedAt: null, sttState: 'none', attempts: 0, errorType: null, audioMs: null, costUsd: null, model: null, cleanupPending: false },
  ...over,
});

beforeEach(() => {
  for (const f of Object.values(h.svc)) f.mockReset();
  svc().listAttendees.mockResolvedValue([{ email: 'host@klient.example', displayName: null }]);
  svc().calendarLink.mockResolvedValue(null);
});

describe('attendee parsing', () => {
  test('normalises, deduplicates and reports invalid addresses', () => {
    expect(parseAttendees('Jana@Firma.cz, jana@firma.cz; <host@klient.com>\nnope')).toEqual({ valid: ['jana@firma.cz', 'host@klient.com'], invalid: ['nope'] });
  });
});

describe('conference links', () => {
  test('labels the provider by host without claiming native integration', () => {
    expect(conferenceProvider('https://meet.google.com/abc-defg-hij')).toBe('Google Meet');
    expect(conferenceProvider('https://us02web.zoom.us/j/1')).toBe('Zoom (odkaz)');
    expect(conferenceProvider('https://teams.microsoft.com/l/x')).toBe('Microsoft Teams (odkaz)');
    expect(conferenceProvider('https://example.org/x')).toBe('Odkaz na schůzku');
  });
  test('the copyable invitation carries the transcription notice', () => {
    const t = inviteText(meeting({ conferenceUrl: 'https://meet.google.com/abc-defg-hij' }), 'https://app/x');
    expect(t).toContain('https://meet.google.com/abc-defg-hij');
    expect(t).toContain(INVITE_NOTICE);
  });
});

describe('ScheduleCard', () => {
  test('organizer: join link + one-click copy with feedback', async () => {
    const write = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText: write } });
    render(<ScheduleCard meeting={meeting({ conferenceUrl: 'https://meet.google.com/abc-defg-hij' })} projectId="p1" isOrganizer canSchedule={false} onChanged={vi.fn()} />);
    expect(screen.getByTestId('schedule-join')).toHaveAttribute('href', 'https://meet.google.com/abc-defg-hij');
    expect(screen.getByTestId('schedule-join')).toHaveAttribute('rel', 'noopener noreferrer');
    fireEvent.click(screen.getByTestId('schedule-copy-link'));
    await waitFor(() => expect(screen.getByTestId('schedule-copy-link')).toHaveTextContent('Zkopírováno ✓'));
    expect(write).toHaveBeenCalledWith('https://meet.google.com/abc-defg-hij');
    expect(await screen.findByText('host@klient.example')).toBeInTheDocument();
  });
  test('invitations are NOT sent unless the organizer ticks it explicitly', async () => {
    svc().calendar.mockResolvedValue({ meetUrl: 'https://meet.google.com/abc-defg-hij', meetStatus: 'success' });
    const changed = vi.fn();
    render(<ScheduleCard meeting={meeting()} projectId="p1" isOrganizer canSchedule onChanged={changed} />);
    fireEvent.click(screen.getByTestId('schedule-create-event'));
    await waitFor(() => expect(svc().calendar).toHaveBeenCalledWith('POST', expect.objectContaining({ sendInvites: false, withMeet: true })));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(expect.stringMatching(/bez e-mailových pozvánek/)));
  });
  test('a missing Meet link is reported honestly, never faked', async () => {
    svc().calendar.mockResolvedValue({ meetUrl: null, meetStatus: 'failure' });
    render(<ScheduleCard meeting={meeting()} projectId="p1" isOrganizer canSchedule onChanged={vi.fn()} />);
    fireEvent.click(screen.getByTestId('schedule-create-event'));
    expect(await screen.findByTestId('schedule-error')).toHaveTextContent(/odkaz na Meet nevytvořil/);
  });
  test('non-organizers see the meeting but no management controls', async () => {
    render(<ScheduleCard meeting={meeting()} projectId="p1" isOrganizer={false} canSchedule onChanged={vi.fn()} />);
    await screen.findByText('host@klient.example');
    expect(screen.queryByTestId('schedule-create-event')).toBeNull();
    expect(screen.queryByTestId('schedule-add')).toBeNull();
  });
});

describe('LivePanel', () => {
  test('start stays disabled until the organizer confirms participants were informed', () => {
    render(<LivePanel meeting={meeting()} projectId="p1" isOrganizer onChanged={vi.fn()} />);
    expect(screen.getByTestId('live-start')).toBeDisabled();
    fireEvent.click(screen.getByTestId('live-notice'));
    expect(screen.getByTestId('live-start')).not.toBeDisabled();
    expect(screen.getByTestId('live-capture-state')).toHaveTextContent('Nenahrává se');
    expect(screen.getByTestId('live-transcription-state')).toHaveTextContent('Přepis neběží');
  });
  test('the source help states the real limits (headphones, desktop apps, Safari)', () => {
    render(<LivePanel meeting={meeting()} projectId="p1" isOrganizer onChanged={vi.fn()} />);
    expect(screen.getByTestId('live-source-help').textContent).toMatch(/sluchátka|neumí zachytit zvuk jiné karty/);
  });
  test('a member who is not the organizer cannot start', () => {
    render(<LivePanel meeting={meeting()} projectId="p1" isOrganizer={false} onChanged={vi.fn()} />);
    expect(screen.queryByTestId('live-start')).toBeNull();
  });
  test('an unfinished capture (closed tab) offers complete / resume / discard and shows the stored text', async () => {
    svc().livePartial.mockResolvedValue([{ segment: 1, text: 'Rozhodli jsme o termínu.' }]);
    svc().callStt.mockResolvedValue({ outcome: 'completed', revision: 'f'.repeat(64) });
    const changed = vi.fn();
    render(<LivePanel meeting={meeting({ live: { state: 'paused', ms: 61_000, segments: 1 }, audio: { ...meeting().audio, consentAt: '2026-11-28T10:00:00Z' } })} projectId="p1" isOrganizer onChanged={changed} />);
    expect(await screen.findByTestId('live-recovery-text')).toHaveTextContent('Rozhodli jsme o termínu.');
    fireEvent.click(screen.getByTestId('live-recover-complete'));
    await waitFor(() => expect(svc().callStt).toHaveBeenCalledWith('live', expect.objectContaining({ action: 'complete', meetingId: 'm1', projectId: 'p1' })));
    await waitFor(() => expect(changed).toHaveBeenCalled());
  });
});
