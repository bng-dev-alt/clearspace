'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Mail, MessagesSquare, Eye, RefreshCw, Trash2, Plus, ExternalLink, Paperclip } from 'lucide-react';
import { driveService, onLinksChanged, serviceActive, DriveError, type GoogleStatus } from '../../services/driveService';
import { gmailService, GMAIL_PRIVACY_TEXT, type GmailLink, type GmailPreview } from '../../services/gmailService';
import ModalShell from '../ui/ModalShell';
import { useConfirm } from '../ui/useConfirm';
import GmailPickerModal from './GmailPickerModal';

interface GmailLinksPanelProps {
  projectId: string;
  /** Task-level panel (task drawer). Without it: project-level e-mails + an overview of task-level ones. */
  cardId?: string;
  canEdit: boolean;
  returnTo: string;
  cardTitle?: (cardId: string) => string | undefined;
}

const dateCs = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' }) : '');
const zprav = (n: number) => (n === 1 ? 'zpráva' : n >= 2 && n <= 4 ? 'zprávy' : 'zpráv');
const priloh = (n: number) => (n === 1 ? 'příloha' : n >= 2 && n <= 4 ? 'přílohy' : 'příloh');
const STATE_TEXT: Record<string, string> = {
  trashed: 'E-mail je v koši Gmailu toho, kdo ho připojil.',
  deleted: 'E-mail už ve schránce toho, kdo ho připojil, není. Zůstávají jen uložené základní údaje.',
};
const kb = (n: number | null) => (n === null ? '' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} kB` : `${(n / 1024 / 1024).toFixed(1)} MB`);


export default function GmailLinksPanel({ projectId, cardId, canEdit, returnTo, cardTitle }: GmailLinksPanelProps) {
  const [ask, confirmDialog] = useConfirm();
  const [links, setLinks] = useState<GmailLink[] | null>(null);
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [preview, setPreview] = useState<{ link: GmailLink; data?: GmailPreview; error?: string } | null>(null);

  const load = useCallback(async () => {
    try { setLinks(await gmailService.list(projectId, cardId)); } catch (e) {
      setLinks((prev) => prev ?? []);
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'E-maily se nepodařilo načíst.' });
    }
  }, [projectId, cardId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async load; state is set after the request
  useEffect(() => { void load(); }, [load]);
  useEffect(() => onLinksChanged(projectId, (cid) => { if (!cardId || cid === cardId || cid === null) void load(); }), [projectId, cardId, load]);
  useEffect(() => {
    let active = true;
    driveService.status().then((s) => { if (active) setStatus(s); }).catch(() => { if (active) setStatus({ configured: false, connection: null }); });
    gmailService.myUserId().then((id) => { if (active) setMe(id); });
    return () => { active = false; };
  }, []);

  const gmailOn = serviceActive(status, 'gmail');
  const available = Boolean(status?.configured && status.gmailAvailable);
  const own = (links ?? []).filter((l) => (cardId ? l.cardId === cardId : l.cardId === null));
  const taskLinks = cardId ? [] : (links ?? []).filter((l) => l.cardId !== null);

  // Gmail switched off on the server and nothing linked: the section does not exist for this user.
  if (status && !available && links !== null && links.length === 0) return null;

  const connect = async () => {
    setBusy('connect');
    try { await driveService.connect(returnTo, 'gmail'); } catch (e) {
      setBusy(null);
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Připojení se nepodařilo zahájit.' });
    }
  };

  const remove = async (l: GmailLink) => {
    if (!(await ask({ title: 'Odebrat e-mail?', message: `Odebrat e-mail „${l.subject}“ z ${cardId ? 'úkolu' : 'projektu'}? Ve vaší schránce Gmail se nic nezmění.`, confirmLabel: 'Odebrat', danger: true }))) return;
    try {
      await gmailService.remove(l.id);
      setLinks((prev) => prev?.filter((x) => x.id !== l.id) ?? prev);
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'E-mail se nepodařilo odebrat.' });
    }
  };

  const refresh = async (l: GmailLink) => {
    setBusy(l.id);
    try {
      const r = await gmailService.refresh(l.id);
      setMessage({ kind: 'info', text: r.state === 'deleted' ? STATE_TEXT.deleted : 'Informace o e-mailu jsou aktuální.' });
      if (r.updated) await load();
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Informace se nepodařilo obnovit.' });
    } finally { setBusy(null); }
  };

  const openPreview = async (l: GmailLink) => {
    setPreview({ link: l });
    try { setPreview({ link: l, data: await gmailService.preview(l.id) }); } catch (e) {
      setPreview({ link: l, error: e instanceof DriveError ? e.message : 'Náhled se nepodařilo načíst.' });
    }
  };

  const row = (l: GmailLink, removable: boolean) => {
    const mine = Boolean(me && l.linkedBy === me);
    const Icon = l.kind === 'thread' ? MessagesSquare : Mail;
    return (
      <li key={l.id} className="drive-link" data-testid={`gmail-link-${l.id}`} data-kind={l.kind}>
        <Icon size={16} aria-hidden="true" style={{ color: 'var(--accent)' }} />
        <div className="drive-link-main">
          <span className="drive-link-name" title={l.subject} data-testid="gmail-link-subject">{l.subject}</span>
          <span className="drive-link-meta" data-testid="gmail-link-meta">
            {l.kind === 'thread' ? `Konverzace${l.count ? ` · ${l.count} ${zprav(l.count)}` : ''}` : 'E-mail'}
            {l.from && <> · od {l.from}</>}
            {l.date && <> · {dateCs(l.date)}</>}
            {l.attachments ? <> · <Paperclip size={10} aria-hidden="true" /> {l.attachments} {priloh(l.attachments)}</> : null}
            {' · '}připojil(a) {l.linkedByName}
            {!cardId && l.cardId && cardTitle?.(l.cardId) && <> · úkol „{cardTitle(l.cardId)}“</>}
          </span>
          {l.state !== 'ok' && <span className="drive-link-problem" role="status" data-testid="gmail-link-problem">{STATE_TEXT[l.state]}</span>}
        </div>
        <div className="drive-link-actions">
          {mine && gmailOn && (
            <>
              {l.state !== 'deleted' && (   // permanently deleted at Gmail: nothing to preview, only the stored metadata remain
                <button type="button" className="drive-icon-btn" title="Náhled (jen pro vás)" aria-label={`Náhled e-mailu: ${l.subject}`} onClick={() => openPreview(l)} data-testid="gmail-preview">
                  <Eye size={14} />
                </button>
              )}
              <button type="button" className="drive-icon-btn" title="Obnovit informace" aria-label={`Obnovit informace: ${l.subject}`} onClick={() => refresh(l)} disabled={busy !== null} data-testid="gmail-refresh">
                <RefreshCw size={14} />
              </button>
            </>
          )}
          {removable && canEdit && (
            <button type="button" className="drive-icon-btn is-danger" title="Odebrat e-mail" aria-label={`Odebrat e-mail: ${l.subject}`} onClick={() => remove(l)} data-testid="gmail-remove">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="drive-panel" data-testid={cardId ? 'task-gmail-section' : 'project-gmail-section'} aria-label="E-maily z Gmailu">
      {confirmDialog}
      <div className="drive-panel-head">
        <h3 className="drawer-section-title drive-section-title">
          <Mail size={14} aria-hidden="true" /> {cardId ? 'E-maily' : 'E-maily projektu'} ({own.length})
          {status?.simulated && <span className="cs-badge cs-badge--warning" title="Lokální testovací poskytovatel, ne skutečný Gmail">simulace</span>}
        </h3>
        {canEdit && gmailOn && available && (
          <div className="drive-panel-actions">
            <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" onClick={() => { setMessage(null); setPicking(true); }} disabled={busy !== null} data-testid="gmail-attach">
              <Plus size={13} aria-hidden="true" /> Připojit e-mail
            </button>
          </div>
        )}
      </div>

      {status && !available && <p className="drive-hint" data-testid="gmail-unavailable">Propojení s Gmailem není na serveru zapnuté. Připojené e-maily zůstávají viditelné.</p>}
      {available && !gmailOn && canEdit && (
        <div className="drive-hint drive-hint--row">
          <span>{status?.connection?.status === 'active' ? 'Povolte ClearSpace přístup ke Gmailu (jen čtení) a připojujte e-maily k projektu.' : 'Připojte svůj účet Google s Gmailem a připojujte e-maily k projektu.'}</span>
          <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" onClick={connect} disabled={busy !== null} data-testid="gmail-connect">
            {busy === 'connect' ? 'Přesměrování…' : 'Připojit Gmail'}
          </button>
        </div>
      )}
      {canEdit && gmailOn && available && <p className="drive-hint" data-testid="gmail-privacy-note">{GMAIL_PRIVACY_TEXT}</p>}
      {message && (
        <p className={`drive-message${message.kind === 'error' ? ' is-error' : ''}`} role={message.kind === 'error' ? 'alert' : 'status'} data-testid="gmail-message">{message.text}</p>
      )}

      {links === null ? (
        <p className="drive-hint">Načítání e-mailů…</p>
      ) : own.length === 0 ? (
        <p className="drive-hint" data-testid="gmail-empty">{cardId ? 'K úkolu zatím není připojený žádný e-mail.' : 'K projektu zatím není připojený žádný e-mail.'}</p>
      ) : (
        <ul className="drive-list" data-testid="gmail-list">{own.map((l) => row(l, true))}</ul>
      )}
      {taskLinks.length > 0 && (
        <>
          <h4 className="drive-subtitle">U úkolů ({taskLinks.length})</h4>
          <ul className="drive-list" data-testid="gmail-task-list">{taskLinks.map((l) => row(l, false))}</ul>
        </>
      )}

      {picking && (
        <GmailPickerModal
          projectId={projectId}
          cardId={cardId ?? null}
          simulated={Boolean(status?.simulated)}
          onClose={() => setPicking(false)}
          onAttached={(text, isError) => { setPicking(false); setMessage({ kind: isError ? 'error' : 'info', text }); void load(); }}
        />
      )}

      {preview && (
        <ModalShell isOpen onClose={() => setPreview(null)} title={preview.link.subject} icon={preview.link.kind === 'thread' ? <MessagesSquare size={16} /> : <Mail size={16} />} maxWidth={760} testId="gmail-preview-modal">
          <p className="drive-hint">Obsah načtený z vaší schránky Gmail. Zobrazuje se jen vám, neukládá se a nikam se neposílá. Obrázky a odkazy z e-mailu se nenačítají.</p>
          {preview.error ? (
            <p className="drive-message is-error" role="alert" data-testid="gmail-preview-error">{preview.error}</p>
          ) : !preview.data ? (
            <p className="drive-hint">Načítání…</p>
          ) : (
            <div className="gmail-preview" data-testid="gmail-preview-body">
              {preview.data.webUrl && (
                <a href={preview.data.webUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="cs-btn cs-btn--ghost cs-btn--sm gmail-open" data-testid="gmail-open">
                  <ExternalLink size={13} aria-hidden="true" /> Otevřít v Gmailu
                </a>
              )}
              {preview.data.content.omittedMessages > 0 && <p className="drive-hint">Starších zpráv nezobrazeno: {preview.data.content.omittedMessages}.</p>}
              {preview.data.content.messages.map((m, i) => (
                <article key={i} className="gmail-message" data-testid="gmail-preview-message">
                  <header className="drive-link-meta">
                    <strong>{m.from.name || m.from.address}</strong>{m.from.name && m.from.address ? ` <${m.from.address}>` : ''}{m.date ? ` · ${new Date(m.date).toLocaleString('cs-CZ')}` : ''}
                  </header>
                  {m.missing
                    ? <p className="drive-hint">Zpráva nemá textový obsah, který by šlo zobrazit.</p>
                    : <pre className="drive-preview-text" data-testid="gmail-preview-text">{m.text || '(prázdná zpráva)'}</pre>}
                  {m.fromHtml && <p className="drive-hint">Zobrazeno jako prostý text (z HTML).</p>}
                  {m.truncated && <p className="drive-hint">Zobrazen je jen začátek zprávy. Celou zprávu otevřete v Gmailu.</p>}
                  {m.attachments.length > 0 && (
                    <ul className="gmail-attachments" data-testid="gmail-preview-attachments">
                      {m.attachments.map((a, j) => <li key={j}><Paperclip size={11} aria-hidden="true" /> {a.name}{a.size !== null ? ` (${kb(a.size)})` : ''}</li>)}
                      <li className="drive-hint">Přílohy ClearSpace nestahuje; otevřete je v Gmailu.</li>
                    </ul>
                  )}
                </article>
              ))}
            </div>
          )}
        </ModalShell>
      )}
    </section>
  );
}
