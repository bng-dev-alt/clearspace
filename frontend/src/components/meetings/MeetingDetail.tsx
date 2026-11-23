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
  type TranscriptRevision,
} from '../../services/meetingService';
import { kanbanService } from '../../services/kanbanService';
import type { Transcript } from '../../lib/intelligence/types';
import type { ColumnRole } from '../../types/kanban';
import { todayInTz } from '../../lib/intelligence/facts';
import { transcriptToText } from '../../lib/intelligence/transcript';
import { KIND_LABEL, KIND_ORDER, STATUS_LABEL, STEPS, stepIndex } from './labels';
import ItemCard from './ItemCard';
import TranscriptView from './TranscriptView';
import AudioPanel from './AudioPanel';
import './meetings.css';

export default function MeetingDetail({ projectId, meetingId }: { projectId: string; meetingId: string }) {
  const router = useRouter();
  const [meeting, setMeeting] = useState<Meeting | null | undefined>(undefined);
  const [transcript, setTranscript] = useState<Transcript | null>(null);
  const [run, setRun] = useState<MeetingRun | null>(null);
  const [items, setItems] = useState<IntelligenceItem[]>([]);
  const [columns, setColumns] = useState<{ id: string; name: string; role?: ColumnRole | null }[]>([]);
  const [cards, setCards] = useState<{ id: string; title: string }[]>([]);
  const [members, setMembers] = useState<{ id: string; fullName: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const meetingDay = useMemo(() => (meeting ? todayInTz(new Date(meeting.occurredAt)) : undefined), [meeting]);
  const [notice, setNotice] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [confirmRerun, setConfirmRerun] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<TranscriptRevision[]>([]);
  const [selectedRev, setSelectedRev] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editNote, setEditNote] = useState('');
  const [savingRev, setSavingRev] = useState(false);

  const load = useCallback(async () => {
    try {
      const m = await meetingService.get(meetingId);
      if (!m || m.projectId !== projectId) {
        setMeeting(null);
        return;
      }
      setMeeting(m);
      const [r, it, board, mem, revs] = await Promise.all([
        meetingService.latestRun(meetingId),
        meetingService.listItems(meetingId),
        kanbanService.fetchBoardData(projectId),
        meetingService.projectMembers(projectId),
        meetingService.listRevisions(meetingId),
      ]);
      setRevisions(revs);
      setRun(r);
      setItems(it);
      setColumns(board.map((c) => ({ id: c.id, name: c.name, role: c.role ?? null })));
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

  // Zobrazená revize: výslovně vybraná > ta, ze které vznikla analýza (důkazy odkazují na její segmenty) > aktuální.
  const currentRev = meeting?.currentRevision ?? null;
  const viewRev = selectedRev ?? run?.transcriptRevision ?? currentRev;
  const staleRun = !!run && !!currentRev && run.transcriptRevision !== currentRev;

  useEffect(() => {
    if (!viewRev) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTranscript(null);
      return;
    }
    let active = true;
    meetingService
      .getTranscript(meetingId, viewRev)
      .then((t) => active && setTranscript(t))
      .catch(() => active && setTranscript(null));
    return () => {
      active = false;
    };
  }, [meetingId, viewRev]);

  /** Důkaz odkazuje na segment revize, ze které analýza vznikla: přepne se na ni, ať se zvýrazní správný text. */
  const jumpTo = (segmentId: string) => {
    if (run && viewRev !== run.transcriptRevision) setSelectedRev(run.transcriptRevision);
    setHighlight(segmentId);
  };

  async function startEdit() {
    if (!meeting?.currentRevision) return;
    try {
      const t = await meetingService.getTranscript(meetingId, meeting.currentRevision);
      if (!t) throw new MeetingServiceError('unknown', 'Přepis se nepodařilo načíst.');
      setEditText(transcriptToText(t, meeting.speakerNames));
      setEditNote('');
      setEditing(true);
    } catch (e) {
      setError(e instanceof MeetingServiceError ? e.message : 'Přepis se nepodařilo načíst.');
    }
  }

  async function saveRevision() {
    if (!meeting?.currentRevision || savingRev) return;
    setSavingRev(true);
    setError(null);
    try {
      const r = await meetingService.addRevision({ meetingId, projectId, text: editText, parentRevision: meeting.currentRevision, note: editNote });
      setEditing(false);
      setSelectedRev(null);
      setNotice(
        run
          ? 'Vytvořena nová revize přepisu. Dosavadní analýza je ze starší revize; analyzujte novou, až budete chtít.'
          : 'Vytvořena nová revize přepisu.'
      );
      if (r.warnings.length > 0) setNotice((n) => `${n ?? ''} ${r.warnings.join(' ')}`.trim());
      await load();
    } catch (e) {
      setError(e instanceof MeetingServiceError ? e.message : 'Úprava přepisu se nezdařila.');
    } finally {
      setSavingRev(false);
    }
  }

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

      {staleRun && (
        <div className="mi-card" role="status" data-testid="stale-analysis">
          <strong>Analýza je ze starší revize přepisu.</strong>{' '}
          <span className="mi-muted">Přepis byl od analýzy upraven. Návrhy níže odkazují na starší text.</span>
          <div className="mi-row">
            <Button size="sm" variant="primary" onClick={() => analyze(false)} disabled={analyzing} data-testid="analyze-current-revision">
              Analyzovat aktuální revizi
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelectedRev(currentRev)} data-testid="show-current-revision">Zobrazit aktuální přepis</Button>
          </div>
        </div>
      )}

      <div className="mi-row">
        {!run ? (
          <Button variant="primary" onClick={() => analyze(false)} disabled={analyzing || !transcript} data-testid="meeting-analyze">
            {analyzing ? 'Analyzuji… (může trvat desítky sekund)' : 'Analyzovat'}
          </Button>
        ) : confirmRerun ? (
          <>
            <span>Znovu analyzovat? Nahradí se jen neschválené a zamítnuté návrhy; závěry, které jste schválili, zůstanou (jsou-li zastaralé, stáhnete je ručně). Spotřebuje se AI kvóta.</span>
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

      {meeting.sourceKind === 'audio' && <AudioPanel meeting={meeting} projectId={projectId} onChanged={(msg) => { if (msg) setNotice(msg); return load(); }} />}
      {transcript && revisions.find((r) => r.revision === viewRev)?.source === 'soniox' && (
        <p className="mi-muted" role="note" data-testid="machine-transcript-note">
          Strojový přepis (Soniox): může obsahovat chyby v jménech a číslech. Zkontrolujte ho a doplňte jména mluvčích před analýzou.
        </p>
      )}

      <div className="mi-grid">
        {transcript && (
          <section className="mi-card" aria-label="Revize přepisu" data-testid="revisions">
            <div className="mi-row" style={{ justifyContent: 'space-between' }}>
              <label htmlFor="rev-select">Revize přepisu</label>
              <select id="rev-select" value={viewRev ?? ''} onChange={(e) => setSelectedRev(e.target.value)} data-testid="revision-select">
                {revisions.map((r, i) => (
                  <option key={r.revision} value={r.revision}>
                    {`#${revisions.length - i} · ${new Date(r.createdAt).toLocaleString('cs-CZ')} · ${r.source === 'edit' ? 'úprava' : r.source}${r.revision === currentRev ? ' · aktuální' : ''}${r.analyzed ? ' · analyzováno' : ''}`}
                  </option>
                ))}
              </select>
              {!editing && currentRev && (
                <Button size="sm" onClick={startEdit} data-testid="revision-edit">Upravit přepis</Button>
              )}
            </div>
            {viewRev !== currentRev && (
              <p className="mi-muted" data-testid="old-revision-note">Zobrazená revize je starší než aktuální (jen ke čtení).</p>
            )}
            {editing && (
              <form
                aria-label="Úprava přepisu"
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveRevision();
                }}
              >
                <p className="mi-muted">Úprava vytvoří novou revizi (původní zůstane). Časové značky se v textové úpravě nezachovají. Nic se neanalyzuje automaticky.</p>
                <textarea aria-label="Text přepisu" value={editText} onChange={(e) => setEditText(e.target.value)} rows={10} style={{ width: '100%' }} data-testid="revision-text" />
                <input aria-label="Poznámka k úpravě" placeholder="Poznámka k úpravě (volitelné)" value={editNote} onChange={(e) => setEditNote(e.target.value)} maxLength={500} data-testid="revision-note" />
                <div className="mi-row">
                  <Button size="sm" variant="primary" type="submit" disabled={savingRev} data-testid="revision-save">Uložit jako novou revizi</Button>
                  <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>Zrušit</Button>
                </div>
              </form>
            )}
          </section>
        )}
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
              {items.length === 0 && <p className="mi-muted">AI v přepisu nenašla žádné položky s nalezenou citací.</p>}
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
                        meetingDay={meetingDay}
                        citedText={it.evidence.map((e) => transcript?.segments.find((s) => `segment:${s.id}` === e.ref)?.text ?? e.quote ?? '').join(' ')}
                        fromEarlierRun={!!run && it.runId !== run.id}
                        onJump={jumpTo}
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
