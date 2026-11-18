'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Badge } from '../ui';
import { intelligenceService, IntelligenceServiceError, type KnowledgeItem } from '../../services/intelligenceService';
import { KIND_LABEL, KIND_ORDER } from '../meetings/labels';
import '../meetings/meetings.css';

/** Znalosti projektu: závěry z porad, které člověk přijal nebo použil. Každý vede zpět na poradu (zdroj). */
export default function KnowledgePanel({ projectId, onOpenCard }: { projectId: string; onOpenCard?: (cardId: string) => void }) {
  const [items, setItems] = useState<KnowledgeItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'all' | KnowledgeItem['kind']>('all');

  useEffect(() => {
    let active = true;
    intelligenceService
      .listKnowledge(projectId)
      .then((r) => active && setItems(r))
      .catch((e) => {
        if (!active) return;
        setItems([]);
        setError(e instanceof IntelligenceServiceError ? e.message : 'Znalosti se nepodařilo načíst.');
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const shown = useMemo(() => (items ?? []).filter((i) => kind === 'all' || i.kind === kind), [items, kind]);
  if (items === null) return <p className="mi-muted" role="status">Načítám znalosti…</p>;

  return (
    <section aria-label="Znalosti z porad" data-testid="project-knowledge" className="mi-grid" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }}>
      {error && <p role="alert" className="mi-error">{error}</p>}
      <div className="mi-row">
        <label htmlFor="kn-kind">Druh</label>
        <select id="kn-kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} data-testid="knowledge-filter">
          <option value="all">Vše</option>
          {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </div>
      {shown.length === 0 && !error ? (
        <p className="mi-muted" data-testid="knowledge-empty">
          Zatím žádné schválené závěry z porad. Po schválení návrhu z porady se objeví tady.
        </p>
      ) : (
        <ul className="mi-list">
          {shown.map((i) => (
            <li key={i.id} className="mi-card" data-testid="knowledge-item" data-kind={i.kind}>
              <div className="mi-row" style={{ justifyContent: 'space-between' }}>
                <span>{i.text}</span>
                <span className="mi-row">
                  <Badge>{KIND_LABEL[i.kind]}</Badge>
                  <Badge variant={i.reviewState === 'applied' ? 'accent' : 'default'}>{i.reviewState === 'applied' ? 'Použito' : 'Přijato'}</Badge>
                </span>
              </div>
              <div className="mi-row">
                {i.meetingId && <Link href={`/projects/${projectId}/meetings/${i.meetingId}`} data-testid="knowledge-source">Zdroj: porada</Link>}
                {i.appliedCardId && onOpenCard && (
                  <button type="button" className="cs-badge" onClick={() => onOpenCard(i.appliedCardId!)} data-testid="knowledge-card">Karta</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
