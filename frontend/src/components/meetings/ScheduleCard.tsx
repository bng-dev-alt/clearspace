'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button } from '../ui';
import { meetingService, MeetingServiceError, parseAttendees, type Meeting, type MeetingAttendee } from '../../services/meetingService';
import { INVITE_NOTICE } from './LivePanel';
import './meetings.css';

/** Poskytovatel podle adresy odkazu – jen popisek; ClearSpace s Zoomem ani Teams nativně nepracuje (obecný odkaz). */
export function conferenceProvider(url: string | null): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname;
    if (h === 'meet.google.com') return 'Google Meet';
    if (h === 'zoom.us' || h.endsWith('.zoom.us')) return 'Zoom (odkaz)';
    if (h === 'teams.microsoft.com' || h === 'teams.live.com') return 'Microsoft Teams (odkaz)';
    return 'Odkaz na schůzku';
  } catch {
    return null;
  }
}

function CopyButton({ text, label, testId }: { text: string; label: string; testId: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button size="sm" variant="ghost" data-testid={testId} aria-live="polite"
      onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 2000); }); }}>
      {done ? 'Zkopírováno ✓' : label}
    </Button>
  );
}

const when = (m: Meeting) => {
  const a = new Date(m.occurredAt);
  const d = a.toLocaleString('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' });
  return m.endsAt ? `${d} – ${new Date(m.endsAt).toLocaleTimeString('cs-CZ', { timeStyle: 'short' })}` : d;
};

export function inviteText(m: Meeting, projectUrl: string): string {
  return [`Porada: ${m.title}`, `Kdy: ${when(m)}`, m.conferenceUrl ? `Připojení: ${m.conferenceUrl}` : null, `Podklady v ClearSpace: ${projectUrl}`, INVITE_NOTICE]
    .filter(Boolean).join('\n');
}

interface Props { meeting: Meeting; projectId: string; isOrganizer: boolean; canSchedule: boolean; onChanged: (message?: string) => void | Promise<void> }

export default function ScheduleCard({ meeting, projectId, isOrganizer, canSchedule, onChanged }: Props) {
  const [attendees, setAttendees] = useState<MeetingAttendee[]>([]);
  const [link, setLink] = useState<Awaited<ReturnType<typeof meetingService.calendarLink>>>(null);
  const [adding, setAdding] = useState('');
  const [sendInvites, setSendInvites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linkUrl, setLinkUrl] = useState(meeting.conferenceUrl ?? '');

  const load = useCallback(async () => {
    try {
      const [a, l] = await Promise.all([meetingService.listAttendees(meeting.id), meetingService.calendarLink(meeting.id)]);
      setAttendees(a);
      setLink(l);
    } catch (e) {
      setError(e instanceof MeetingServiceError ? e.message : 'Údaje porady se nepodařilo načíst.');
    }
  }, [meeting.id]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const tz = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'Europe/Prague';
  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      await onChanged(ok);
    } catch (e) {
      setError(e instanceof MeetingServiceError ? e.message : 'Operace se nezdařila.');
    } finally {
      setBusy(false);
    }
  }

  const provider = conferenceProvider(meeting.conferenceUrl);
  const upcoming = Date.parse(meeting.endsAt ?? meeting.occurredAt) > Date.now();
  const projectUrl = typeof window !== 'undefined' ? `${window.location.origin}/projects/${projectId}/meetings/${meeting.id}` : '';
  const linked = link && link.state !== 'deleted';
  const { valid, invalid } = parseAttendees(adding);

  return (
    <section className="mi-card" aria-label="Termín a účastníci" data-testid="schedule-card">
      <div className="mi-row" style={{ justifyContent: 'space-between' }}>
        <h2>Termín a připojení</h2>
        <div className="mi-row">
          <Badge variant={upcoming ? 'accent' : 'default'}>{upcoming ? 'Nadcházející' : 'Proběhlá'}</Badge>
          {linked && <Badge variant="success"><span data-testid="schedule-calendar-linked">V Google Kalendáři</span></Badge>}
          {link?.state === 'deleted' && <Badge variant="warning">Událost zrušena</Badge>}
        </div>
      </div>
      <p data-testid="schedule-when">{when(meeting)}</p>

      {meeting.conferenceUrl ? (
        <div className="mi-row" data-testid="schedule-conference">
          <a className="cs-btn cs-btn--primary cs-btn--sm" href={meeting.conferenceUrl} target="_blank" rel="noopener noreferrer" data-testid="schedule-join">Připojit se ({provider})</a>
          <CopyButton text={meeting.conferenceUrl} label="Kopírovat odkaz" testId="schedule-copy-link" />
          <CopyButton text={inviteText(meeting, projectUrl)} label="Kopírovat pozvánku (Slack / Telegram / e-mail)" testId="schedule-copy-invite" />
        </div>
      ) : (
        <p className="mi-muted">Porada zatím nemá odkaz na připojení.{isOrganizer ? ' Vytvořte událost s Google Meet, nebo vložte odkaz Zoom / Teams / jiný.' : ''}</p>
      )}

      {isOrganizer && !linked && (
        <div className="mi-row">
          <input aria-label="Odkaz na schůzku (https://…)" placeholder="https://zoom.us/j/… nebo https://teams.microsoft.com/…" value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)} style={{ minWidth: 280 }} data-testid="schedule-link-input" />
          <Button size="sm" disabled={busy || linkUrl === (meeting.conferenceUrl ?? '')} data-testid="schedule-link-save"
            onClick={() => void run(() => meetingService.updateSchedule(meeting.id, { conferenceUrl: linkUrl.trim() || null }), 'Odkaz uložen.')}>Uložit odkaz</Button>
        </div>
      )}

      <div className="mi-field" data-testid="schedule-attendees">
        <strong>Pozvaní ({attendees.length})</strong>
        {attendees.length === 0 ? <span className="mi-muted">Zatím nikdo. Hosté nepotřebují účet v ClearSpace.</span> : (
          <ul className="mi-list">
            {attendees.map((a) => (
              <li key={a.email} className="mi-row">
                <span>{a.displayName ? `${a.displayName} · ` : ''}{a.email}</span>
                {isOrganizer && <Button size="sm" variant="ghost" aria-label={`Odebrat ${a.email}`} disabled={busy}
                  onClick={() => void run(() => meetingService.removeAttendee(meeting.id, a.email), 'Pozvaný odebrán. Do Kalendáře se změna promítne tlačítkem „Synchronizovat“.')}>Odebrat</Button>}
              </li>
            ))}
          </ul>
        )}
        {isOrganizer && (
          <div className="mi-row">
            <input aria-label="Přidat e-maily pozvaných" placeholder="jana@firma.cz, host@klient.com" value={adding} onChange={(e) => setAdding(e.target.value)} data-testid="schedule-add-input" style={{ minWidth: 280 }} />
            <Button size="sm" disabled={busy || valid.length === 0 || invalid.length > 0} data-testid="schedule-add"
              onClick={() => void run(async () => { await meetingService.addAttendees(projectId, meeting.id, valid); setAdding(''); }, 'Pozvaní přidáni.')}>Přidat</Button>
            {invalid.length > 0 && <span className="mi-error">Neplatné adresy: {invalid.join(', ')}</span>}
          </div>
        )}
      </div>

      {isOrganizer && canSchedule && (
        <div className="mi-card" data-testid="schedule-google">
          <strong>Google Kalendář</strong>
          <label><input type="checkbox" checked={sendInvites} onChange={(e) => setSendInvites(e.target.checked)} data-testid="schedule-send-invites" /> Odeslat pozvánky e-mailem (pošle je Google všem pozvaným; bez zaškrtnutí vznikne událost jen ve vašem kalendáři)</label>
          <div className="mi-row">
            {!linked ? (
              <Button variant="primary" size="sm" disabled={busy} data-testid="schedule-create-event"
                onClick={() => void run(async () => {
                  const r = await meetingService.calendar('POST', { projectId, meetingId: meeting.id, withMeet: true, sendInvites, timeZone: tz });
                  if (!r.meetUrl) throw new MeetingServiceError('meet', r.meetStatus === 'pending' ? 'Událost vznikla, Google zatím odkaz na Meet nevytvořil. Zkuste stránku obnovit za chvíli.' : 'Událost vznikla, ale Google k ní odkaz na Meet nevytvořil (u některých účtů není Meet dostupný). Můžete vložit jiný odkaz.');
                }, sendInvites ? 'Událost s Google Meet vytvořena a pozvánky odeslány.' : 'Událost s Google Meet vytvořena (bez e-mailových pozvánek).')}>
                Vytvořit událost s Google Meet
              </Button>
            ) : (
              <>
                <Button size="sm" disabled={busy} data-testid="schedule-sync-event"
                  onClick={() => void run(() => meetingService.calendar('PATCH', { projectId, meetingId: meeting.id, sendInvites, timeZone: tz }), 'Událost v Kalendáři aktualizována.')}>Synchronizovat změny do Kalendáře</Button>
                <Button size="sm" variant="danger" disabled={busy} data-testid="schedule-cancel-event"
                  onClick={() => { if (confirm(sendInvites ? 'Zrušit událost a poslat pozvaným zrušení?' : 'Zrušit událost jen ve vašem kalendáři (bez e-mailu pozvaným)?')) void run(() => meetingService.calendar('DELETE', { projectId, meetingId: meeting.id, sendInvites }), 'Událost v Kalendáři zrušena. Porada a její přepis zůstávají.'); }}>Zrušit událost</Button>
              </>
            )}
          </div>
        </div>
      )}
      {error && <p role="alert" className="mi-error" data-testid="schedule-error">{error}</p>}
    </section>
  );
}
