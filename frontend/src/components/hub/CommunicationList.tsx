'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { ExternalLink, ShieldCheck } from 'lucide-react';
import { hasSupabaseConfig } from '../../lib/supabase';
import { hubService, PROVIDER_NAME, type HubMessage, type HubProvider } from '../../services/hubService';
import { formatRelativeTime } from '../../lib/collab/activityText';
import { ProviderIcon } from './ProjectIntegrationsModal';

const KIND_LABEL: Record<HubMessage['kind'], string> = { task_source: 'zdroj úkolu', thread_reply: 'odpověď ve vlákně úkolu', ingested: 'pro Project Intelligence' };

/** One chat record: source icon, author (verified ClearSpace user or the chat's label), channel, time, task + original link. */
export function MessageRow({ m, names, onOpenCard }: { m: HubMessage; names?: Map<string, string>; onOpenCard?: (cardId: string) => void }) {
  const author = m.verified && m.author_user_id ? names?.get(m.author_user_id) ?? 'člen projektu' : m.author_label;
  return (
    <li className="hub-msg" data-testid={`hub-msg-${m.kind}`}>
      <span className="hub-msg-icon" aria-hidden="true"><ProviderIcon provider={m.provider} /></span>
      <div className="hub-msg-body">
        <span className="hub-msg-meta">
          <strong>{author}</strong>
          {m.verified ? <span title="Ověřený účet ClearSpace" className="hub-verified"><ShieldCheck size={12} aria-label="ověřeno" /></span> : <span className="hub-muted">(neověřený autor)</span>}
          <span className="hub-muted">· {PROVIDER_NAME[m.provider]} {m.destination_label} · {KIND_LABEL[m.kind]}</span>
        </span>
        {m.deleted_at ? <em className="hub-muted">Zpráva byla smazána.</em> : <span className="hub-msg-text">{m.text || '—'}</span>}
        <span className="hub-msg-meta hub-muted">
          <time dateTime={m.sent_at} title={new Date(m.sent_at).toLocaleString('cs-CZ')}>{formatRelativeTime(m.sent_at)}</time>
          {m.edited_at && !m.deleted_at && <span>· upraveno</span>}
          {m.card_id && onOpenCard && <button type="button" className="cs-link-button hub-link" onClick={() => onOpenCard(m.card_id!)} data-testid="hub-msg-open-card">Otevřít úkol</button>}
          {m.permalink && <a href={m.permalink} target="_blank" rel="noopener noreferrer" className="hub-link">Původní zpráva <ExternalLink size={11} aria-hidden="true" /></a>}
        </span>
      </div>
    </li>
  );
}

/** Activity → Komunikace: what ClearSpace recorded from this project's linked channels / groups. Honest about the scope. */
export default function CommunicationList({ projectId, onOpenCard, names }: { projectId: string; onOpenCard?: (cardId: string) => void; names?: Map<string, string> }) {
  const [rows, setRows] = useState<HubMessage[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [q, setQ] = useState('');
  const [source, setSource] = useState<'all' | HubProvider>('all');
  const [extra, setExtra] = useState<Map<string, string>>(new Map());
  const allNames = useMemo(() => new Map([...(names ?? new Map()), ...extra]), [names, extra]);
  useEffect(() => {
    let active = true;
    hubService.messages(projectId)
      .then(async (r) => { const n = await hubService.names(r.filter((m) => m.verified && m.author_user_id).map((m) => m.author_user_id!)); if (active) { setExtra(n); setRows(r); } })
      .catch(() => { if (active) { setRows([]); setFailed(true); } });
    return () => { active = false; };
  }, [projectId]);
  const shown = useMemo(() => {
    const needle = q.trim().toLocaleLowerCase('cs');
    return (rows ?? []).filter((m) => (source === 'all' || m.provider === source)
      && (!needle || `${m.text} ${m.author_label} ${m.destination_label}`.toLocaleLowerCase('cs').includes(needle)));
  }, [rows, q, source]);

  return (
    <div className="hub-comm" data-testid="hub-communication">
      {!hasSupabaseConfig && <p className="hub-scope" data-testid="hub-demo-note"><strong>Simulace</strong> – ukázková data, ne skutečný Slack ani Telegram.</p>}
      <p className="hub-scope" data-testid="hub-scope">Jen komunikace z kanálů a skupin propojených s tímto projektem: zprávy, ze kterých vznikly úkoly, odpovědi ve vláknech úkolů a – kde to správce výslovně zapnul – zprávy pro Project Intelligence. Nikdy celý workspace ani soukromé konverzace.</p>
      <div className="hub-filter">
        <input type="search" className="cs-input" placeholder="Hledat v komunikaci…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Hledat v komunikaci" data-testid="hub-search" />
        <select className="cs-input" value={source} onChange={(e) => setSource(e.target.value as 'all' | HubProvider)} aria-label="Zdroj" data-testid="hub-source">
          <option value="all">Všechny zdroje</option><option value="slack">Slack</option><option value="telegram">Telegram</option>
        </select>
      </div>
      {rows === null ? <p className="hub-muted">Načítání…</p>
        : failed ? <p role="alert" className="drive-message is-error">Komunikaci se nepodařilo načíst.</p>
        : shown.length === 0 ? <p className="hub-muted">{rows.length === 0 ? 'Zatím žádná zaznamenaná komunikace.' : 'Nic neodpovídá filtru.'}</p>
        : <ol className="hub-msgs" data-testid="hub-msg-list">{shown.map((m) => <MessageRow key={m.id} m={m} names={allNames} onOpenCard={onOpenCard} />)}</ol>}
    </div>
  );
}

/** Task detail → Konverzace: the chat thread linked to this task (nothing when there is none). */
export function TaskConversation({ cardId, names }: { cardId: string; names?: Map<string, string> }) {
  const [rows, setRows] = useState<HubMessage[]>([]);
  const [extra, setExtra] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    let active = true;
    hubService.taskConversation(cardId)
      .then(async (r) => { const n = await hubService.names(r.filter((m) => m.verified && m.author_user_id).map((m) => m.author_user_id!)); if (active) { setExtra(n); setRows(r); } })
      .catch(() => undefined);
    return () => { active = false; };
  }, [cardId]);
  const allNames = useMemo(() => new Map([...(names ?? new Map()), ...extra]), [names, extra]);
  if (rows.length === 0) return null;
  return (
    <section className="hub-task-conv" aria-label="Konverzace v chatu" data-testid="hub-task-conversation">
      <h4 className="drawer-section-title">Konverzace v chatu</h4>
      <p className="hub-muted">Odpovědi ve vlákně se propisují do komentářů a komentáře zpět do vlákna.</p>
      <ol className="hub-msgs">{rows.map((m) => <MessageRow key={m.id} m={m} names={allNames} />)}</ol>
    </section>
  );
}
