'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, Button, EmptyState } from '../ui';
import { Sparkles } from 'lucide-react';
import {
  meetingService,
  MeetingServiceError,
  type IntelligenceItem,
  type Meeting,
  type MeetingRun,
} from '../../services/meetingService';
import { kanbanService } from '../../services/kanbanService';
import type { Transcript } from '../../lib/intelligence/types';
import { KIND_LABEL, KIND_ORDER, STATUS_LABEL, STEPS, stepIndex } from './labels';
import ItemCard from './ItemCard';
import TranscriptView from './TranscriptView';
import './meetings.css';

export default function MeetingDetail({ projectId, meetingId }: { projectId: string; meetingId: string }) {
  const router = useRouter();
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [run, setRun] = useState<MeetingRun | null>(null);
  const [items, setItems] = useState<IntelligenceItem[]>([]);
  const [columns, setColumns] = useState<{ id: string; name: string }[]>([]);
  const [cards, setCards] = useState<{ id: string; title: string }[]>([]);
  const [members, setMembers] = useState<{ id: string; fullName: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [confirmRerun, setConfirmRerun] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const m = await meetingService.get(meetingId);
      if (!m || m.projectId !== projectId) {
        setMeeting(null);
        return;
      }
      setMeeting(m);
      const [t, r, it, board, mem] = await Promise.all([
        m.currentRevision ? meetingService.getTranscript(meetingId, m.currentRevision) : Promise.resolve(null),
        meetingService.latestRun(meetingId),
        meetingService.listItems(meetingId),
        kanbanService.fetchBoardData(projectId),
        meetingService.projectMembers(projectId),
      ]);
      setTranscript(t);
      setRun(r);
      setItems(it);
      setColumns(board.map((c) => ({ id: c.id, name: c.name })));
      setCards(board.flatMap((c) => c.cards.filter((k) => !k.archived).map((k) => ({ id: k.id, title: k.title }))));
      setMembers(mem);
      setError(null);
    } catch (e) {
      setMeeting((prev) => prev ?? null);
      setError(e instanceof MeetingServiceError ? e.message : 'Poradu se nepodařilo načíst.');
    }
  }, [meetingId, projectId]);

  useEffect(() => {
    // Načtení dat z externího systému (Supabase); setState proběhne až po await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const pending = useMemo(() => items.filter((i) => i.reviewState === 'proposed').length, [items]);
  const grouped = useMemo(
    () => KIND_ORDER.map((k) => ({ kind: k, list: items.filter((i) => i.kind === k) })).filter((g) => g.list.length > 0),
    [items]
  );

  async function analyze(force: boolean) {
    if (analyzing) return;
    setAnalyzing(true);
    setError(null);
    setNotice(null);
    setConfirmRerun(false);
    try {
      const r = await meetingService.analyze(projectId, meetingId, force);
      setNotice(
        r.rejectedCount > 0
          ? `Analýza hotová: ${r.itemCount} návrhů, ${r.rejectedCount} položek bez důkazu bylo vynecháno.`
          : `Analýza hotová: ${r.itemCount} návrhů.`
      );
      await load();
    } catch (e) {
      setError(e instanceof MeetingServiceError ? e.message : 'Analýza se nezdařila.');
    } finally {
      setAnalyzing(false);
    }
  }

  if (meeting === undefined) {
    return <p className="mi-muted" role="status" style={{ padding: 16 }}>Načítám poradu…</p>;
  }
  if (meeting === null) {
    return (
      <section className="mi-page">
        <EmptyState icon={<Sparkles size={28} />} title="Porada nenalezena" description={error ?? 'Porada neexistuje nebo k ní nemáte přístup.'} />
        <Link href={`/projects/${projectId}/meetings`}>← Zpět na porady</Link>
      </section>
    );
  }

  const step = stepIndex(meeting.status, pending, items.length);

  return (
    <section className="mi-page" aria-labelledby="mi-title" data-testid="meeting-detail">
      <div className="mi-row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1 id="mi-title">{meeting.title}</h1>
          <span className="mi-muted">{new Date(meeting.occurredAt).toLocaleDateString('cs-CZ')}</span>
        </div>
        <div className="mi-row">
          <Link href={`/projects/${projectId}/meetings`}>← Porady</Link>
          <Badge>{STATUS_LABEL[meeting.status]}</Badge>
        </div>
      </div>

      <ol className="mi-steps" aria-label="Postup zpracování" data-testid="meeting-steps">
        {STEPS.map((s, i) => (
          <li key={s} className="mi-step" aria-current={i === step ? 'step' : undefined}>{s}</li>
        ))}
      </ol>

      {error && <p role="alert" className="mi-error" data-testid="meeting-error">{error}</p>}
      {notice && <p role="status" data-testid="meeting-notice">{notice}</p>}

      <div className="mi-row">
        {!run ? (
          <Button variant="primary" onClick={() => analyze(false)} disabled={analyzing || !transcript} data-testid="meeting-analyze">
            {analyzing ? 'Analyzuji… (může trvat desítky sekund)' : 'Analyzovat'}
          </Button>
        ) : confirmRerun ? (
          <>
            <span>Znovu analyzovat? Neschválené návrhy budou nahrazeny a spotřebuje se AI kvóta.</span>
            <Button variant="primary" onClick={() => analyze(true)} disabled={analyzing} data-testid="meeting-rerun-confirm">Ano, analyzovat znovu</Button>
            <Button variant="ghost" onClick={() => setConfirmRerun(false)}>Zrušit</Button>
          </>
        ) : (
          <Button onClick={() => setConfirmRerun(true)} disabled={analyzing} data-testid="meeting-rerun">Znovu analyzovat</Button>
        )}
        {confirmDelete ? (
          <>
            <span>Smazat poradu včetně přepisu a návrhů? Vytvořené karty zůstanou.</span>
            <Button variant="danger" onClick={async () => {
              try {
                await meetingService.remove(meetingId);
                router.push(`/projects/${projectId}/meetings`);
              } catch (e) {
                setError(e instanceof MeetingServiceError ? e.message : 'Smazání se nezdařilo.');
              }
            }} data-testid="meeting-delete-confirm">Smazat</Button>
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>Zrušit</Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmDelete(true)} data-testid="meeting-delete">Smazat poradu</Button>
        )}
      </div>

      <div className="mi-grid">
        {transcript ? (
          <TranscriptView
            transcript={transcript}
            speakerNames={meeting.speakerNames}
            highlightId={highlight}
            onSaveSpeakers={async (names) => {
              try {
                await meetingService.renameSpeakers(meetingId, names);
                setNotice('Jména mluvčích uložena. Platí pro další analýzu.');
                await load();
              } catch (e) {
                setError(e instanceof MeetingServiceError ? e.message : 'Uložení se nezdařilo.');
              }
            }}
          />
        ) : (
          <section className="mi-card"><p className="mi-muted">Porada zatím nemá přepis.</p></section>
        )}

        <section className="mi-card" aria-label="Výsledky" data-testid="meeting-results">
          <h2>Výsledky</h2>
          {!run ? (
            <p className="mi-muted">Zatím neanalyzováno. AI navrhne rozhodnutí, úkoly a rizika s důkazem z přepisu; do projektu se nic nezapíše bez vašeho schválení.</p>
          ) : (
            <>
              <p data-testid="meeting-summary">{run.summary}</p>
              <p className="mi-muted">
                Model {run.model ?? '?'} · {pending} čeká na schválení
                {run.rejectedCount > 0 ? ` · ${run.rejectedCount} položek bez důkazu vynecháno` : ''}
              </p>
              {run.chapters.length > 0 && (
                <ul className="mi-list" aria-label="Kapitoly">
                  {run.chapters.map((c) => (
                    <li key={c.firstSegment}>
                      <button type="button" className="mi-quote" onClick={() => setHighlight(c.firstSegment)}>{c.title}</button>
                    </li>
                  ))}
                </ul>
              )}
              {items.length === 0 && <p className="mi-muted">AI v přepisu nenašla žádné ověřitelné položky.</p>}
              {grouped.map((g) => (
                <div key={g.kind}>
                  <h3>{KIND_LABEL[g.kind]} ({g.list.length})</h3>
                  <ul className="mi-list">
                    {g.list.map((it) => (
                      <ItemCard
                        key={it.id}
                        item={it}
                        columns={columns}
                        cards={cards}
                        members={members}
                        onJump={setHighlight}
                        onChanged={(msg) => {
                          if (msg) setNotice(msg);
                          void load();
                        }}
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </section>
      </div>
    </section>
  );
}
