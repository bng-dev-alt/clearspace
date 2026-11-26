'use client';

import React from 'react';
import Link from 'next/link';
import type { Evidence } from '../../lib/intelligence/types';
import type { BriefSourceLabel } from '../../services/intelligenceService';

const KIND_LABEL: Record<string, string> = {
  card: 'karta',
  comment: 'komentář',
  check: 'checklist',
  activity: 'aktivita',
  item: 'porada',
  meeting: 'porada',
  comm: 'chat',
};

/** Odkazy na zdroje tvrzení: karta se otevře, závěr z porady vede na detail porady. Vše ostatní je jen popisek. */
export default function SourceChips({
  evidence,
  sources,
  projectId,
  onOpenCard,
}: {
  evidence: Evidence[];
  sources: BriefSourceLabel[];
  projectId: string;
  onOpenCard?: (cardId: string) => void;
}) {
  return (
    <span className="mi-row" data-testid="source-chips">
      {evidence.map((e) => {
        const s = sources.find((x) => x.ref === e.ref);
        const kind = e.ref.slice(0, e.ref.indexOf(':'));
        const text = `${KIND_LABEL[kind] ?? kind}: ${s?.label ?? e.ref}`;
        if (s?.meetingId) {
          return (
            <Link key={e.ref} href={`/projects/${projectId}/meetings/${s.meetingId}`} className="cs-badge" data-testid="source-chip">
              {text}
            </Link>
          );
        }
        if (s?.cardId && onOpenCard) {
          return (
            <button key={e.ref} type="button" className="cs-badge" onClick={() => onOpenCard(s.cardId!)} data-testid="source-chip">
              {text}
            </button>
          );
        }
        return (
          <span key={e.ref} className="cs-badge" data-testid="source-chip">
            {text}
          </span>
        );
      })}
    </span>
  );
}
