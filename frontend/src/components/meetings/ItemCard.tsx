'use client';

import React, { useMemo, useState } from 'react';
import { Badge, Button } from '../ui';
import { meetingService, MeetingServiceError, type IntelligenceItem } from '../../services/meetingService';
import { candidateDuplicateCards, suggestAssignee } from '../../lib/intelligence/duplicates';
import { DUE_BASIS_LABEL, suggestDueDate } from '../../lib/intelligence/dates';
import { isDoneColumn } from '../../lib/projectIntelligence';
import type { ColumnRole } from '../../types/kanban';
import { fmtMs, STATE_LABEL } from './labels';
import './meetings.css';

export interface ItemCardProps {
  item: IntelligenceItem;
  columns: { id: string; name: string; role?: ColumnRole | null }[];
  cards: { id: string; title: string }[];
  members: { id: string; fullName: string }[];
  /** Den porady (YYYY-MM-DD, časová zóna projektu): základ pro relativní termíny typu "do pátku". */
  meetingDay?: string;
  onJump: (segmentId: string) => void;
  onChanged: (message?: string) => void;
}

/**
 * Jedna navržená položka s důkazy a rozhodnutím člověka. Nic se do projektu nezapíše, dokud uživatel
 * nepotvrdí konkrétní akci (vytvořit kartu / propojit / zamítnout). Opakované potvrzení je bezpečné (idempotentní RPC).
 */
export default function ItemCard({ item, columns, cards, members, meetingDay, onJump, onChanged }: ItemCardProps) {
  const [mode, setMode] = useState<null | 'create' | 'link'>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forceUndo, setForceUndo] = useState(false);

  const [colId, setColId] = useState(columns.find((c) => !isDoneColumn(c))?.id ?? columns[0]?.id ?? '');
  const [title, setTitle] = useState(item.text.slice(0, 300));
  const [assignee, setAssignee] = useState(item.assigneeMemberId ?? '');
  const [due, setDue] = useState(item.dueDate ?? '');
  const [allowDup, setAllowDup] = useState(false);
  const [linkCard, setLinkCard] = useState(item.suggestedCardId ?? cards[0]?.id ?? '');
  const [addComment, setAddComment] = useState(true);

  const suggestedMember = useMemo(() => suggestAssignee(item.ownerText, members), [item.ownerText, members]);
  const dueSuggestion = useMemo(() => (meetingDay ? suggestDueDate(item.dueText, meetingDay) : null), [item.dueText, meetingDay]);
  const similar = useMemo(() => candidateDuplicateCards(item.text, cards), [item.text, cards]);
  const appliedCard = cards.find((c) => c.id === item.appliedCardId);
  const canCreateCard = item.kind === 'action_item' || item.kind === 'follow_up';
  const open = item.reviewState === 'proposed' || item.reviewState === 'accepted';

  async function run(fn: () => Promise<void>, doneMessage?: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      setMode(null);
      onChanged(doneMessage);
    } catch (e) {
      setError(e instanceof MeetingServiceError ? e.message : 'Akce se nezdařila.');
      if (e instanceof MeetingServiceError && e.code === 'state' && item.reviewState === 'applied') setForceUndo(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="mi-card" data-testid={`item-${item.id}`} data-state={item.reviewState} data-kind={item.kind}>
      <div className="mi-row" style={{ justifyContent: 'space-between' }}>
        <strong>{item.text}</strong>
        <div className="mi-row">
          <span title="Text citace byl nalezen v přepisu. Neověřuje, že tvrzení z ní plyne: ověřte smysl v přepisu.">
            <Badge variant={item.support === 'linked' ? 'success' : 'warning'}>{item.support === 'linked' ? 'Citace nalezena' : 'Citace nenalezena'}</Badge>
          </span>
          {item.evidence.some((e) => e.flag === 'negation_nearby') && (
            <span data-testid="negation-flag" title="V citaci nebo těsně před ní je zápor, který tvrzení nemá.">
              <Badge variant="danger">Pozor: zápor</Badge>
            </span>
          )}
          <Badge variant={item.reviewState === 'applied' ? 'accent' : item.reviewState === 'rejected' ? 'danger' : 'default'}>
            {STATE_LABEL[item.reviewState]}
          </Badge>
        </div>
      </div>

      {item.evidence.map((e, i) => {
        const seg = e.ref.replace(/^segment:/, '');
        return (
          <button key={`${e.ref}-${i}`} type="button" className="mi-quote" onClick={() => onJump(seg)} data-testid="evidence-link" title="Zobrazit v přepisu">
            {e.quote ? `„${e.quote}"` : `Segment ${seg}`}
            {fmtMs(e.startMs) ? <span className="mi-time"> · {fmtMs(e.startMs)}</span> : null}
            {!e.quoteFound ? <span className="mi-muted"> · citace nenalezena</span> : null}
          </button>
        );
      })}

      {item.kind === 'action_item' && (item.ownerText || item.dueText) && (
        <div className="mi-muted" data-testid="item-hints">
          {item.ownerText ? <>Vlastník z textu: <strong>{item.ownerText}</strong>. </> : null}
          {item.dueText ? <>Termín z textu: <strong>&bdquo;{item.dueText}&ldquo;</strong> (datum zadejte ručně).</> : null}
        </div>
      )}

      {item.duplicateOf && item.reviewState !== 'applied' && (
        <p role="note" className="mi-muted" data-testid="duplicate-warning">
          Možná duplicita: stejná položka už existuje v jiné poradě.
        </p>
      )}
      {open && similar.length > 0 && (
        <p role="note" className="mi-muted" data-testid="similar-cards">
          Podobné karty: {similar.map((c) => c.title).join(', ')}
        </p>
      )}

      {item.reviewState === 'applied' && (
        <div className="mi-row" data-testid="applied-info">
          <span>
            {item.appliedMode === 'create_card' ? 'Vytvořena karta' : 'Propojeno s kartou'}: <strong>{appliedCard?.title ?? item.appliedCardId ?? '(karta už neexistuje)'}</strong>
          </span>
          <Button size="sm" onClick={() => run(() => meetingService.undo(item.id, forceUndo), 'Akce vrácena.')} disabled={busy} data-testid="item-undo">
            {forceUndo ? 'Vrátit přesto' : 'Vrátit'}
          </Button>
        </div>
      )}

      {open && mode === null && (
        <div className="mi-row">
          {canCreateCard && (
            <Button size="sm" variant="primary" onClick={() => setMode('create')} data-testid="item-create">
              Vytvořit kartu…
            </Button>
          )}
          <Button size="sm" onClick={() => setMode('link')} disabled={cards.length === 0} data-testid="item-link">
            Propojit s kartou…
          </Button>
          {item.reviewState === 'proposed' && (
            <Button size="sm" onClick={() => run(() => meetingService.review(item.id, 'accept'), 'Přijato.')} disabled={busy} data-testid="item-accept">
              Přijmout
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => run(() => meetingService.review(item.id, 'reject'), 'Zamítnuto.')} disabled={busy} data-testid="item-reject">
            Zamítnout
          </Button>
        </div>
      )}

      {item.reviewState === 'rejected' && (
        <Button size="sm" onClick={() => run(() => meetingService.review(item.id, 'reopen'), 'Znovu otevřeno.')} disabled={busy} data-testid="item-reopen">
          Znovu otevřít
        </Button>
      )}

      {open && mode === 'create' && (
        <form
          className="mi-card"
          aria-label="Vytvořit kartu"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              async () => {
                await meetingService.apply(item.id, {
                  mode: 'create_card',
                  column_id: colId,
                  title: title.trim() || undefined,
                  details: item.evidence.find((x) => x.quote)?.quote ? `Z porady: „${item.evidence.find((x) => x.quote)!.quote}"` : '',
                  due_date: due || null,
                  assignee_member_id: assignee || null,
                  allow_duplicate: allowDup,
                });
              },
              'Karta vytvořena.'
            );
          }}
        >
          <div className="mi-field">
            <label htmlFor={`t-${item.id}`}>Název karty</label>
            <input id={`t-${item.id}`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} data-testid="create-title" />
          </div>
          <div className="mi-row">
            <label htmlFor={`c-${item.id}`}>Sloupec</label>
            <select id={`c-${item.id}`} value={colId} onChange={(e) => setColId(e.target.value)} data-testid="create-column">
              {columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <label htmlFor={`a-${item.id}`}>Řešitel</label>
            <select id={`a-${item.id}`} value={assignee} onChange={(e) => setAssignee(e.target.value)} data-testid="create-assignee">
              <option value="">Nepřiřazeno</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.fullName}</option>)}
            </select>
            {suggestedMember && assignee !== suggestedMember && (
              <Button size="sm" type="button" onClick={() => setAssignee(suggestedMember)} data-testid="use-suggested-assignee">
                Použít návrh: {members.find((m) => m.id === suggestedMember)?.fullName}
              </Button>
            )}
            <label htmlFor={`d-${item.id}`}>Termín</label>
            <input id={`d-${item.id}`} type="date" value={due} onChange={(e) => setDue(e.target.value)} data-testid="create-due" />
            {dueSuggestion && due !== dueSuggestion.date && (
              <Button size="sm" type="button" onClick={() => setDue(dueSuggestion.date)} data-testid="use-suggested-due">
                Použít návrh termínu: {dueSuggestion.date} ({DUE_BASIS_LABEL[dueSuggestion.basis]})
              </Button>
            )}
          </div>
          {item.duplicateOf && (
            <label>
              <input type="checkbox" checked={allowDup} onChange={(e) => setAllowDup(e.target.checked)} data-testid="allow-duplicate" /> Vytvořit přesto (duplicita)
            </label>
          )}
          <div className="mi-row">
            <Button size="sm" variant="primary" type="submit" disabled={busy || !colId} data-testid="create-confirm">
              Potvrdit a vytvořit
            </Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setMode(null)}>Zrušit</Button>
          </div>
        </form>
      )}

      {open && mode === 'link' && (
        <form
          className="mi-card"
          aria-label="Propojit s kartou"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await meetingService.apply(item.id, { mode: 'link_card', card_id: linkCard, add_comment: addComment });
            }, 'Propojeno.');
          }}
        >
          <div className="mi-row">
            <label htmlFor={`l-${item.id}`}>Karta</label>
            <select id={`l-${item.id}`} value={linkCard} onChange={(e) => setLinkCard(e.target.value)} data-testid="link-card">
              {cards.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
            <label>
              <input type="checkbox" checked={addComment} onChange={(e) => setAddComment(e.target.checked)} /> Přidat komentář s důkazem
            </label>
          </div>
          <div className="mi-row">
            <Button size="sm" variant="primary" type="submit" disabled={busy || !linkCard} data-testid="link-confirm">Potvrdit</Button>
            <Button size="sm" variant="ghost" type="button" onClick={() => setMode(null)}>Zrušit</Button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="mi-error" data-testid="item-error">
          {error}
        </p>
      )}
    </li>
  );
}
