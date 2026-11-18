'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CalendarClock } from 'lucide-react';
import { Badge, Button, EmptyState } from '../ui';
import { meetingService, MeetingServiceError, type Meeting } from '../../services/meetingService';
import { STATUS_LABEL } from './labels';
import NewMeetingForm from './NewMeetingForm';
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
          description="Vložte přepis porady a ClearSpace z něj navrhne rozhodnutí, úkoly a rizika. Do projektu se nic nezapíše bez vašeho schválení."
        />
      ) : (
        <ul className="mi-list" data-testid="meeting-list">
          {meetings.map((m) => (
            <li key={m.id} className="mi-card">
              <div className="mi-row" style={{ justifyContent: 'space-between' }}>
                <Link href={`/projects/${projectId}/meetings/${m.id}`} data-testid={`meeting-link-${m.id}`}>
                  <strong>{m.title}</strong>
                </Link>
                <div className="mi-row">
                  <Badge variant={m.status === 'ready' ? 'accent' : 'default'}>{STATUS_LABEL[m.status]}</Badge>
                  {pending[m.id] ? <Badge variant="warning">{pending[m.id]} čeká na schválení</Badge> : null}
                </div>
              </div>
              <span className="mi-muted">
                {new Date(m.occurredAt).toLocaleDateString('cs-CZ')} · {m.sourceKind === 'text' ? 'text' : 'audio'}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
