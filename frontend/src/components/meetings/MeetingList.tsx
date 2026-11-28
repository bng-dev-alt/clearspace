'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarClock } from 'lucide-react';
import { Badge, Button, EmptyState } from '../ui';
import { meetingService, MeetingServiceError, type Meeting } from '../../services/meetingService';
import { STATUS_LABEL } from './labels';
import NewMeetingForm from './NewMeetingForm';
import { conferenceProvider } from './ScheduleCard';
import './meetings.css';

export default function MeetingList({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [meetings, setMeetings] = useState<Meeting[] | null>(null);
  const [pending, setPending] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, p] = await Promise.all([meetingService.list(projectId), meetingService.pendingCounts(projectId)]);
      setMeetings(m);
      setPending(p);
      setError(null);
    } catch (e) {
      setMeetings([]);
      setError(e instanceof MeetingServiceError ? e.message : 'Porady se nepodařilo načíst.');
    }
  }, [projectId]);

  useEffect(() => {
    // Načtení dat z externího systému (Supabase); setState proběhne až po await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    // Úklid zvuku po termínu, osiřelých a nepřipojených souborů (aplikace nemá plánovač). Nezávisí na příznacích přepisu:
    // zvuk, který už je nahraný, se maže i při vypnutém přepisu. Best-effort, jedna selhaná položka nezastaví ostatní.
    void meetingService.sweepAudio(projectId);
  }, [load, projectId]);

  const now = Date.now();
  const isUpcoming = (m: Meeting) => !m.currentRevision && m.live.state !== 'live' && Date.parse(m.endsAt ?? m.occurredAt) > now;
  const upcoming = (meetings ?? []).filter(isUpcoming).sort((x, y) => Date.parse(x.occurredAt) - Date.parse(y.occurredAt));
  const past = (meetings ?? []).filter((m) => !isUpcoming(m));

  return (
    <section className="mi-page" aria-labelledby="mi-heading" data-testid="meetings-page">
      <div className="mi-row" style={{ justifyContent: 'space-between' }}>
        <h1 id="mi-heading">Porady</h1>
        <div className="mi-row">
          <Link href={`/projects/${projectId}`}>← Zpět na projekt</Link>
          <Button variant="primary" onClick={() => setShowForm((v) => !v)} data-testid="meeting-new" aria-expanded={showForm}>
            Nová porada
          </Button>
        </div>
      </div>

      {showForm && (
        <NewMeetingForm
          projectId={projectId}
          onCreated={(id) => router.push(`/projects/${projectId}/meetings/${id}`)}
        />
      )}

      {error && (
        <p role="alert" className="mi-error" data-testid="meetings-error">
          {error}
        </p>
      )}

      {meetings === null ? (
        <p className="mi-muted" role="status">Načítám porady…</p>
      ) : meetings.length === 0 && !error ? (
        <EmptyState
          icon={<CalendarClock size={28} />}
          title="Zatím žádné porady"
          description="Naplánujte poradu nebo vložte přepis. ClearSpace z něj navrhne rozhodnutí, úkoly a rizika; do projektu se nic nezapíše bez vašeho schválení."
        />
      ) : (
        <>
          {[['Nadcházející', upcoming, 'meeting-list-upcoming'], ['Proběhlé', past, 'meeting-list']].map(([label, list, tid]) =>
            (list as Meeting[]).length === 0 ? null : (
              <div key={tid as string} className="mi-field">
                <h2 style={{ fontSize: '1rem' }}>{label as string}</h2>
                <ul className="mi-list" data-testid={tid as string}>
                  {(list as Meeting[]).map((m) => (
                    <li key={m.id} className="mi-card">
                      <div className="mi-row" style={{ justifyContent: 'space-between' }}>
                        <Link href={`/projects/${projectId}/meetings/${m.id}`} data-testid={`meeting-link-${m.id}`}>
                          <strong>{m.title}</strong>
                        </Link>
                        <div className="mi-row">
                          {m.live.state === 'live' && <Badge variant="danger">● Přepis běží</Badge>}
                          {(m.live.state === 'paused' || m.live.state === 'stopped') && <Badge variant="warning">Přepis nedokončen</Badge>}
                          {(m.currentRevision || m.status !== 'draft') && <Badge variant={m.status === 'ready' ? 'accent' : 'default'}>{STATUS_LABEL[m.status]}</Badge>}
                          {m.status === 'draft' && !m.currentRevision && m.live.state === 'idle' && <Badge>Bez přepisu</Badge>}
                          {pending[m.id] ? <Badge variant="warning">{pending[m.id]} čeká na schválení</Badge> : null}
                        </div>
                      </div>
                      <span className="mi-muted">
                        {new Date(m.occurredAt).toLocaleString('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' })}
                        {m.endsAt ? ` · ${Math.round((Date.parse(m.endsAt) - Date.parse(m.occurredAt)) / 60000)} min` : m.live.ms ? ` · ${Math.round(m.live.ms / 60000)} min přepisu` : ''}
                        {' · '}{m.sourceKind === 'text' ? 'vložený přepis' : m.live.segments ? 'živý přepis' : m.audio.path ? 'nahraný záznam' : 'zvuk'}
                        {m.conferenceUrl ? ` · ${conferenceProvider(m.conferenceUrl)}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
        </>
      )}
    </section>
  );
}
