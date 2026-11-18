'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button } from '../ui';
import type { Column } from '../../types/kanban';
import { intelligenceService, IntelligenceServiceError, type BriefRecord } from '../../services/intelligenceService';
import type { BriefSupport, Evidence } from '../../lib/intelligence/types';
import SourceChips from './SourceChips';
import '../meetings/meetings.css';

interface Props {
  projectId: string;
  columns: Column[];
  onOpenCard?: (cardId: string) => void;
}

type Freshness = 'none' | 'fresh' | 'stale' | 'unknown';

function Claim({ text, support, evidence, record, projectId, onOpenCard, extra }: {
  text: string; support: BriefSupport; evidence: Evidence[]; record: BriefRecord; projectId: string; onOpenCard?: (id: string) => void; extra?: React.ReactNode;
}) {
  return (
    <li className="mi-card" data-testid="brief-claim" data-support={support}>
      <div className="mi-row" style={{ justifyContent: 'space-between' }}>
        <span>{text}</span>
        <span className="mi-row">
          {extra}
          {support === 'linked' ? <span title="Text citace byl nalezen ve zdroji. Neověřuje, že tvrzení z ní plyne."><Badge variant="success">Citace nalezena</Badge></span> : null}
          {support === 'sourced' ? <span title="Tvrzení odkazuje na existující zdroj, ale AI k němu neuvedla citaci: nic nebylo porovnáno."><Badge>Zdroj uveden, bez citace</Badge></span> : null}
          {support === 'unverified' ? <Badge variant="warning">Neověřeno</Badge> : null}
          {evidence.some((e) => e.flag === 'negation_nearby') ? <span data-testid="negation-flag" title="V citaci nebo těsně před ní je zápor, který tvrzení nemá."><Badge variant="danger">Pozor: zápor</Badge></span> : null}
        </span>
      </div>
      <SourceChips evidence={evidence} sources={record.sources} projectId={projectId} onOpenCard={onOpenCard} />
    </li>
  );
}

/**
 * Project Brief: nahoře OVĚŘENÁ FAKTA (spočítala aplikace), pod nimi INTERPRETACE AI se zdroji u každého tvrzení.
 * Brief je uložený; zastaralost se pozná porovnáním podpisu faktů. Generuje se jen na výslovné tlačítko.
 */
export default function ProjectBriefPanel({ projectId, columns, onOpenCard }: Props) {
  const [record, setRecord] = useState<BriefRecord | null | undefined>(undefined);
  const [signature, setSignature] = useState<string | null>(null);
  const [stamp, setStamp] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [offerForce, setOfferForce] = useState(false);

  const loadBrief = useCallback(async () => {
    try {
      setRecord(await intelligenceService.latestBrief(projectId));
      setError(null);
    } catch (e) {
      setRecord(null);
      setError(e instanceof IntelligenceServiceError ? e.message : 'Brief se nepodařilo načíst.');
    }
  }, [projectId]);

  useEffect(() => {
    // Načtení z externího systému (Supabase); setState proběhne až po await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadBrief();
  }, [loadBrief]);

  // Podpis aktuálního stavu se přepočítá při každé změně boardu (zastaralost briefu je vidět hned).
  useEffect(() => {
    let active = true;
    intelligenceService
      .currentSignature(projectId, columns)
      .then((s) => active && setSignature(s))
      .catch(() => active && setSignature(null));
    intelligenceService.currentStamp(projectId).then((s) => active && setStamp(s)).catch(() => active && setStamp(null));
    return () => {
      active = false;
    };
  }, [projectId, columns]);

  // Razítko z DB (vidí i komentáře a checklisty) má přednost; starší briefy bez něj se porovnají podle podpisu faktů.
  const freshness: Freshness =
    record === undefined
      ? 'unknown'
      : record === null
        ? 'none'
        : record.stamp && stamp
          ? record.stamp === stamp ? 'fresh' : 'stale'
          : !record.signature || !signature ? 'unknown' : record.signature === signature ? 'fresh' : 'stale';

  async function generate(force: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setOfferForce(false);
    try {
      await intelligenceService.generateBrief(projectId, force);
      setNotice('Brief byl aktualizován.');
      await loadBrief();
    } catch (e) {
      if (e instanceof IntelligenceServiceError && e.code === 'conflict') {
        setNotice(e.message);
        setOfferForce(true);
      } else {
        setError(e instanceof IntelligenceServiceError ? e.message : 'Brief se nepodařilo vytvořit.');
      }
    } finally {
      setBusy(false);
    }
  }

  if (record === undefined) return <p className="mi-muted" role="status">Načítám brief…</p>;

  return (
    <section className="mi-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }} aria-label="Project Brief" data-testid="project-brief">
      <div className="mi-row" style={{ justifyContent: 'space-between' }}>
        <div className="mi-row">
          <strong>Project Brief</strong>
          <span data-testid="brief-freshness">
            {freshness === 'fresh' && <Badge variant="success">Aktuální</Badge>}
            {freshness === 'stale' && <Badge variant="warning">Zastaralé: data projektu se změnila</Badge>}
            {freshness === 'none' && <Badge>Zatím nevygenerováno</Badge>}
            {freshness === 'unknown' && record && <Badge>Stav aktuálnosti neznámý</Badge>}
          </span>
        </div>
        <Button variant="primary" size="sm" onClick={() => generate(false)} disabled={busy} data-testid="brief-generate">
          {busy ? 'Generuji… (může trvat desítky sekund)' : record ? 'Aktualizovat brief' : 'Vygenerovat brief'}
        </Button>
      </div>

      {error && <p role="alert" className="mi-error" data-testid="brief-error">{error}</p>}
      {notice && (
        <p role="status" data-testid="brief-notice">
          {notice}{' '}
          {offerForce && (
            <Button size="sm" onClick={() => generate(true)} disabled={busy} data-testid="brief-force">
              Přegenerovat přesto
            </Button>
          )}
        </p>
      )}

      {!record ? (
        <p className="mi-muted">
          Brief shrne stav projektu, rizika, blokátory a doporučené kroky; u každého tvrzení uvede zdroj. Nic v projektu nemění.
        </p>
      ) : (
        <>
          {record.facts && (
            <div className="mi-card" data-testid="brief-facts" aria-label="Ověřená fakta">
              <strong>Ověřená fakta</strong> <span className="mi-muted">(spočítala aplikace k {record.facts.today}, ne AI)</span>
              <div className="mi-row">
                <Badge variant={record.facts.level === 'healthy' ? 'success' : record.facts.level === 'risk' ? 'danger' : 'warning'}>
                  Zdraví {record.facts.score}/100
                </Badge>
                <Badge>Po termínu: {record.facts.counts.overdue ?? 0}</Badge>
                <Badge>Blokováno: {record.facts.counts.blocked ?? 0}</Badge>
                <Badge>Nepřiřazeno: {record.facts.counts.unassigned ?? 0}</Badge>
                <Badge>Do týdne: {record.facts.counts.dueThisWeek ?? 0}</Badge>
                <Badge>Návrhy z porad k rozhodnutí: {record.facts.meetingDerived.pendingProposals ?? 0}</Badge>
              </div>
            </div>
          )}

          <div className="mi-card" aria-label="Interpretace AI">
            <strong>Interpretace AI</strong> <span className="mi-muted">(model {record.model ?? '?'}; tvrzení mají zdroje, neověřená jsou označena)</span>
            <p data-testid="brief-summary">{record.summary}</p>
            {record.healthNarrative && <p className="mi-muted" data-testid="brief-narrative">{record.healthNarrative}</p>}
            {record.rejectedCount > 0 && (
              <p className="mi-muted" data-testid="brief-rejected">{record.rejectedCount} tvrzení bez ověřitelného zdroje bylo vynecháno.</p>
            )}
          </div>

          {([
            ['Rizika', record.risks],
            ['Blokátory', record.blockers],
            ['Otevřené otázky', record.openQuestions],
          ] as const).map(([title, list]) =>
            list.length === 0 ? null : (
              <div key={title}>
                <h3>{title} ({list.length})</h3>
                <ul className="mi-list">
                  {list.map((c, i) => (
                    <Claim key={i} text={c.text} support={c.support} evidence={c.evidence} record={record} projectId={projectId} onOpenCard={onOpenCard}
                      extra={c.severity ? <Badge variant={c.severity === 'high' ? 'danger' : 'default'}>{c.severity}</Badge> : null} />
                  ))}
                </ul>
              </div>
            )
          )}

          {record.nextActions.length > 0 && (
            <div>
              <h3>Doporučené kroky ({record.nextActions.length})</h3>
              <ul className="mi-list" data-testid="brief-actions">
                {record.nextActions.map((a, i) => (
                  <Claim key={i} text={a.text} support={a.support} evidence={a.evidence} record={record} projectId={projectId} onOpenCard={onOpenCard}
                    extra={
                      <>
                        <Badge>{a.kind}</Badge>
                        {a.targetCardId && onOpenCard ? (
                          <Button size="sm" onClick={() => onOpenCard(a.targetCardId!)} data-testid="brief-open-target">Otevřít kartu</Button>
                        ) : null}
                      </>
                    } />
                ))}
              </ul>
              <p className="mi-muted">Jsou to doporučení pro člověka; nic se neprovádí automaticky.</p>
            </div>
          )}

          {record.notesOnData.length > 0 && (
            <ul className="mi-list" aria-label="Poznámky k datům">
              {record.notesOnData.map((n, i) => <li key={i} className="mi-muted">{n}</li>)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
