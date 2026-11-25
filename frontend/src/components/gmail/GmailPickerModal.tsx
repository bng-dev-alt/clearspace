'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Mail, Search } from 'lucide-react';
import ModalShell from '../ui/ModalShell';
import { DriveError } from '../../services/driveService';
import { gmailService, GMAIL_PRIVACY_TEXT, type GmailItem, type GmailKind, type SearchPage } from '../../services/gmailService';

/**
 * Selection of e-mails from the user's OWN mailbox (Google offers no Gmail picker, so this is ClearSpace's own dialog;
 * the search runs on the server with the user's token). Nothing is attached until the user explicitly confirms.
 */
interface Props {
  projectId: string;
  cardId: string | null;
  simulated: boolean;
  onClose: () => void;
  onAttached: (message: string, isError: boolean) => void;
}

const MAX_SELECT = 10;
const dateCs = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' }) : '');

export default function GmailPickerModal({ projectId, cardId, simulated, onClose, onAttached }: Props) {
  const [kind, setKind] = useState<GmailKind>('thread');
  const [form, setForm] = useState({ text: '', from: '', subject: '', after: '', before: '' });
  const [applied, setApplied] = useState(form);
  const [page, setPage] = useState<SearchPage | null>(null);
  const [tokens, setTokens] = useState<(string | null)[]>([null]);   // page-token stack (back / next)
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, GmailItem>>(new Map());
  const [attaching, setAttaching] = useState(false);

  const run = useCallback(async (k: GmailKind, f: typeof form, token: string | null) => {
    setLoading(true);
    setError(null);
    try { setPage(await gmailService.search({ kind: k, ...f, pageToken: token })); } catch (e) {
      setPage(null);
      setError(e instanceof DriveError ? e.message : 'Vyhledávání v Gmailu se nepodařilo.');
    } finally { setLoading(false); }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- first page (most recent) when the dialog opens
  useEffect(() => { void run('thread', { text: '', from: '', subject: '', after: '', before: '' }, null); }, [run]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setApplied(form);
    setTokens([null]);
    void run(kind, form, null);
  };
  const switchKind = (k: GmailKind) => {
    if (k === kind) return;
    setKind(k);
    setSelected(new Map());
    setTokens([null]);
    void run(k, applied, null);
  };
  const next = () => { if (!page?.nextPageToken) return; setTokens((t) => [...t, page.nextPageToken]); void run(kind, applied, page.nextPageToken); };
  const prev = () => { if (tokens.length < 2) return; const t = tokens.slice(0, -1); setTokens(t); void run(kind, applied, t[t.length - 1]); };

  const toggle = (it: GmailItem) => setSelected((m) => {
    const n = new Map(m);
    if (n.has(it.id)) n.delete(it.id); else if (n.size < MAX_SELECT) n.set(it.id, it);
    return n;
  });

  const attach = async () => {
    setAttaching(true);
    try {
      const r = await gmailService.attach(projectId, cardId, [...selected.values()].map((i) => ({ kind: i.kind, id: i.id })));
      const added = r.links.filter((l) => !l.duplicate).length;
      const dup = r.links.length - added;
      const parts = [added ? `Připojeno e-mailů: ${added}.` : '', dup ? `${dup === 1 ? 'Jeden e-mail už byl' : `${dup} e-maily už byly`} připojený.` : '', ...r.failed.map((f) => f.message)].filter(Boolean);
      onAttached(parts.join(' ') || 'Nic nebylo připojeno.', r.failed.length > 0 && added === 0);
    } catch (e) {
      setError(e instanceof DriveError ? e.message : 'E-maily se nepodařilo připojit.');
      setAttaching(false);
    }
  };

  const field = (k: keyof typeof form, label: string, type = 'text', placeholder = '') => (
    <label className="gmail-field">
      <span>{label}</span>
      <input type={type} className="form-input" value={form[k]} placeholder={placeholder} maxLength={200}
        onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} data-testid={`gmail-filter-${k}`} />
    </label>
  );

  return (
    <ModalShell isOpen onClose={onClose} title={<>Připojit e-mail z Gmailu{simulated && <span className="cs-badge cs-badge--warning" style={{ marginLeft: 8 }}>simulace</span>}</>} icon={<Mail size={16} />} maxWidth={760} testId="gmail-picker">
      <div className="gmail-picker">
        <p className="drive-hint" data-testid="gmail-picker-privacy">{GMAIL_PRIVACY_TEXT} ClearSpace v Gmailu nic nemění a neposílá.</p>
        <div className="gmail-kind" role="radiogroup" aria-label="Co připojit">
          {(['thread', 'message'] as const).map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={`cs-btn cs-btn--sm ${kind === k ? 'cs-btn--secondary' : 'cs-btn--ghost'}`} onClick={() => switchKind(k)} data-testid={`gmail-kind-${k}`}>
              {k === 'thread' ? 'Konverzace' : 'Jednotlivé zprávy'}
            </button>
          ))}
        </div>
        <form className="gmail-search" onSubmit={submit} role="search">
          {field('text', 'Hledat', 'search', 'např. nabídka Corvane')}
          {field('from', 'Odesílatel')}
          {field('subject', 'Předmět')}
          {field('after', 'Od data', 'date')}
          {field('before', 'Do data', 'date')}
          <button type="submit" className="cs-btn cs-btn--secondary cs-btn--sm" disabled={loading} data-testid="gmail-search-submit"><Search size={13} aria-hidden="true" /> Hledat</button>
        </form>

        {error && <p className="drive-message is-error" role="alert" data-testid="gmail-picker-error">{error}</p>}
        {loading ? <p className="drive-hint">Hledám ve vaší schránce…</p> : page && page.items.length === 0 ? (
          <p className="drive-hint" data-testid="gmail-picker-empty">Nic nenalezeno. Zkuste jiný výraz nebo rozsah dat.</p>
        ) : page && (
          <ul className="drive-list gmail-results" data-testid="gmail-results">
            {page.items.map((it) => (
              <li key={it.id} className={`drive-link gmail-result${selected.has(it.id) ? ' is-selected' : ''}`}>
                <label className="gmail-result-label">
                  <input type="checkbox" checked={selected.has(it.id)} onChange={() => toggle(it)} disabled={!selected.has(it.id) && selected.size >= MAX_SELECT} data-testid={`gmail-pick-${it.id}`} aria-label={`Vybrat: ${it.subject}`} />
                  <span className="drive-link-main">
                    <span className="drive-link-name" title={it.subject}>{it.subject}</span>
                    <span className="drive-link-meta">
                      {it.from.name || it.from.address}{it.from.name && it.from.address ? ` <${it.from.address}>` : ''}
                      {it.date && <> · {dateCs(it.date)}</>}
                      {it.kind === 'thread' && it.messageCount > 1 && <> · {it.messageCount} zpráv{it.messageCount < 5 ? 'y' : ''}</>}
                      {it.state === 'trashed' && <> · v koši</>}
                    </span>
                    {it.snippet && <span className="drive-link-meta gmail-snippet">{it.snippet}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <div className="gmail-picker-foot">
          <div className="drive-panel-actions">
            <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={prev} disabled={loading || tokens.length < 2} data-testid="gmail-page-prev">Předchozí</button>
            <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={next} disabled={loading || !page?.nextPageToken} data-testid="gmail-page-next">Další</button>
          </div>
          <div className="drive-panel-actions">
            <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={onClose}>Zrušit</button>
            <button type="button" className="cs-btn cs-btn--primary cs-btn--sm" onClick={attach} disabled={attaching || selected.size === 0} data-testid="gmail-attach-selected">
              {attaching ? 'Připojuji…' : `Připojit vybrané (${selected.size})`}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
