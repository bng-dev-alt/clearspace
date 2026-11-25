'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, FileText, FileSpreadsheet, Presentation, Folder, Image as ImageIcon, File, RefreshCw, Trash2, Eye, Plus, HardDrive } from 'lucide-react';
import { driveService, onLinksChanged, DriveError, type DriveLink, type GoogleStatus, type ResourceContent } from '../../services/driveService';
import { pickDriveFiles } from '../../lib/google/picker';
import { ACCESS_TEXT, fileIconKind, fileKind, safeDriveUrl, type AccessState } from '../../lib/google/labels';
import ModalShell from '../ui/ModalShell';

interface DriveLinksPanelProps {
  projectId: string;
  /** Task-level panel (task drawer). Without it: project-level links + an overview of task links. */
  cardId?: string;
  canEdit: boolean;
  /** Where Google sends the user back after connecting (validated again on the server). */
  returnTo: string;
  /** Task titles for the project overview of task-level links. */
  cardTitle?: (cardId: string) => string | undefined;
  /** Outcome of a just-finished connect (?google=...). */
  notice?: string | null;
}

const STALE_MS = 60 * 60 * 1000;
const CONTENT_TYPES = /^(application\/vnd\.google-apps\.(document|spreadsheet|presentation)|text\/(plain|markdown|csv)|application\/json)$/;

function Icon({ mime }: { mime: string }) {
  const k = fileIconKind(mime);
  const p = { size: 16, 'aria-hidden': true } as const;
  if (k === 'doc') return <FileText {...p} style={{ color: 'var(--blue-primary)' }} />;
  if (k === 'sheet') return <FileSpreadsheet {...p} style={{ color: '#107c41' }} />;
  if (k === 'slides') return <Presentation {...p} style={{ color: '#c7811a' }} />;
  if (k === 'folder') return <Folder {...p} style={{ color: 'var(--gray-text)' }} />;
  if (k === 'image') return <ImageIcon {...p} style={{ color: 'var(--blue-primary)' }} />;
  if (k === 'pdf') return <FileText {...p} style={{ color: 'var(--danger)' }} />;
  return <File {...p} style={{ color: 'var(--gray-text)' }} />;
}

const dateCs = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric' }) : '');

export default function DriveLinksPanel({ projectId, cardId, canEdit, returnTo, cardTitle, notice }: DriveLinksPanelProps) {
  const [links, setLinks] = useState<DriveLink[] | null>(null);
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [access, setAccess] = useState<Record<string, AccessState>>({});
  const [busy, setBusy] = useState<null | 'attach' | 'refresh' | 'connect'>(null);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(notice ? { kind: 'info', text: notice } : null);
  const [preview, setPreview] = useState<{ link: DriveLink; content?: ResourceContent; error?: string } | null>(null);
  const autoRefreshed = useRef(false);

  const load = useCallback(async () => {
    try {
      setLinks(await driveService.list(projectId, cardId));
    } catch (e) {
      setLinks((prev) => prev ?? []);
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Soubory se nepodařilo načíst.' });
    }
  }, [projectId, cardId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async load; state is set after the request
  useEffect(() => { void load(); }, [load]);
  useEffect(() => onLinksChanged(projectId, (cid) => { if (!cardId || cid === cardId || cid === null) void load(); }), [projectId, cardId, load]);
  useEffect(() => {
    let active = true;
    driveService.status().then((s) => { if (active) setStatus(s); }).catch(() => { if (active) setStatus({ configured: false, connection: null }); });
    return () => { active = false; };
  }, []);

  const connected = status?.connection?.status === 'active';
  const revoked = status?.connection != null && status.connection.status !== 'active';

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setBusy('refresh');
    try {
      const r = await driveService.refresh(projectId, cardId ?? null);
      setAccess((prev) => ({ ...prev, ...r.statuses }));
      if (Object.values(r.statuses).includes('revoked')) setStatus(await driveService.status(true));
      if (r.updated > 0) await load();
      if (!quiet) setMessage({ kind: 'info', text: 'Informace o souborech jsou aktuální.' });
    } catch (e) {
      if (!quiet) setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : ACCESS_TEXT.unavailable });
    } finally {
      if (!quiet) setBusy(null);
    }
  }, [projectId, cardId, load]);

  // Opening the view refreshes stale metadata once (bounded on the server; no polling).
  useEffect(() => {
    if (autoRefreshed.current || !connected || !links?.length) return;
    if (!links.some((l) => Date.now() - Date.parse(l.metadataCheckedAt) > STALE_MS)) return;
    autoRefreshed.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one bounded refresh when the view opens
    void refresh(true);
  }, [connected, links, refresh]);

  const connect = async () => {
    setBusy('connect');
    try { await driveService.connect(returnTo); } catch (e) {
      setBusy(null);
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Připojení se nepodařilo zahájit.' });
    }
  };

  const attach = async () => {
    setBusy('attach');
    setMessage(null);
    try {
      const grant = await driveService.pickerGrant();
      const ids = await pickDriveFiles(grant);
      if (!ids?.length) return;
      const r = await driveService.attach(projectId, cardId ?? null, ids);
      const added = r.links.filter((l) => !l.duplicate).length;
      const dup = r.links.length - added;
      const parts = [
        added ? `Přidáno souborů: ${added}.` : '',
        dup ? `${dup === 1 ? 'Soubor už je' : 'Některé soubory už jsou'} připojený${dup === 1 ? '' : 'é'}.` : '',
        ...r.failed.map((f) => f.message),
      ].filter(Boolean);
      setMessage({ kind: r.failed.length ? 'error' : 'info', text: parts.join(' ') });
      await load();
    } catch (e) {
      if (e instanceof DriveError && e.code === 'revoked') setStatus(await driveService.status(true).catch(() => status));
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Výběr souborů z Google Disku se nepodařilo otevřít.' });
    } finally {
      setBusy(null);
    }
  };

  /** A teammate's file: open the Picker on just that file; picking it gives THIS user's own access (if Google allows). */
  const verifyAccess = async (link: DriveLink) => {
    setBusy('attach');
    try {
      const ids = await pickDriveFiles(await driveService.pickerGrant(), [link.externalId]);
      if (ids?.length) await refresh(true);
      else setMessage({ kind: 'error', text: 'Soubor se ve vašem Google Disku nezobrazil – požádejte autora o sdílení (tlačítko Otevřít na Disku nabídne žádost o přístup).' });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : ACCESS_TEXT.unavailable });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (link: DriveLink) => {
    if (!confirm(`Odebrat přílohu „${link.name}“? Soubor v Google Disku zůstane beze změny.`)) return;
    try {
      await driveService.remove(link.id);
      setLinks((prev) => prev?.filter((l) => l.id !== link.id) ?? prev);
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Přílohu se nepodařilo odebrat.' });
    }
  };

  const openPreview = async (link: DriveLink) => {
    setPreview({ link });
    try { setPreview({ link, content: await driveService.content(link.id) }); } catch (e) {
      setPreview({ link, error: e instanceof DriveError ? e.message : ACCESS_TEXT.unavailable });
    }
  };

  const own = (links ?? []).filter((l) => (cardId ? l.cardId === cardId : l.cardId === null));
  const taskLinks = cardId ? [] : (links ?? []).filter((l) => l.cardId !== null);

  const row = (l: DriveLink, removable: boolean) => {
    const url = safeDriveUrl(l.webUrl);
    const state: AccessState | undefined = l.providerState === 'trashed' ? 'trashed' : access[l.id];
    const problem = state && state !== 'ok' ? ACCESS_TEXT[state] : null;
    return (
      <li key={l.id} className="drive-link" data-testid={`drive-link-${l.externalId}`}>
        <Icon mime={l.mimeType} />
        <div className="drive-link-main">
          <span className="drive-link-name" title={l.name}>{l.name}</span>
          <span className="drive-link-meta">
            {fileKind(l.mimeType)}
            {l.modifiedAt && <> · upraveno {dateCs(l.modifiedAt)}</>}
            {' · '}přidal(a) {l.linkedByName}
            {!cardId && l.cardId && cardTitle?.(l.cardId) && <> · úkol „{cardTitle(l.cardId)}“</>}
          </span>
          {problem && <span className="drive-link-problem" role="status" data-testid="drive-link-problem">{problem}</span>}
          {state === 'no_access' && connected && (
            <button type="button" className="drive-inline-btn" onClick={() => verifyAccess(l)} disabled={busy !== null} data-testid="drive-verify-access">Ověřit přístup na Disku</button>
          )}
        </div>
        <div className="drive-link-actions">
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="drive-icon-btn" title="Otevřít na Disku" aria-label={`Otevřít na Disku: ${l.name}`} data-testid="drive-open">
              <ExternalLink size={14} />
            </a>
          )}
          {connected && CONTENT_TYPES.test(l.mimeType) && (
            <button type="button" className="drive-icon-btn" title="Náhled textu" aria-label={`Náhled textu: ${l.name}`} onClick={() => openPreview(l)} data-testid="drive-preview">
              <Eye size={14} />
            </button>
          )}
          {removable && canEdit && (
            <button type="button" className="drive-icon-btn is-danger" title="Odebrat přílohu" aria-label={`Odebrat přílohu: ${l.name}`} onClick={() => remove(l)} data-testid="drive-remove">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </li>
    );
  };

  return (
    <section className="drive-panel" data-testid={cardId ? 'task-drive-section' : 'project-drive-section'} aria-label="Soubory z Google Disku">
      <div className="drive-panel-head">
        <h3 className="drawer-section-title drive-section-title">
          <HardDrive size={14} aria-hidden="true" /> {cardId ? 'Google Disk' : 'Soubory projektu'} ({own.length})
          {status?.simulated && <span className="cs-badge cs-badge--warning" title="Lokální testovací poskytovatel, ne skutečný Google">simulace</span>}
        </h3>
        <div className="drive-panel-actions">
          {connected && (links?.length ?? 0) > 0 && (
            <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={() => refresh()} disabled={busy !== null} data-testid="drive-refresh">
              <RefreshCw size={13} aria-hidden="true" /> Obnovit informace
            </button>
          )}
          {canEdit && connected && (
            <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" onClick={attach} disabled={busy !== null} data-testid="drive-attach">
              <Plus size={13} aria-hidden="true" /> {busy === 'attach' ? 'Otevírám Disk…' : 'Přidat soubor z Disku'}
            </button>
          )}
        </div>
      </div>

      {status && !status.configured && <p className="drive-hint">{status.message ?? 'Propojení s Google Diskem není na serveru nastavené.'}</p>}
      {status?.configured && !status.connection && (
        <div className="drive-hint drive-hint--row">
          <span>{canEdit ? 'Připojte svůj účet Google a přidávejte soubory z Disku.' : 'Připojte svůj účet Google a ověřte si přístup k souborům.'}</span>
          <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" onClick={connect} disabled={busy !== null} data-testid="drive-connect">
            {busy === 'connect' ? 'Přesměrování…' : 'Připojit Google Disk'}
          </button>
        </div>
      )}
      {status?.configured && revoked && (
        <div className="drive-hint drive-hint--row drive-hint--warning" role="alert">
          <span>{ACCESS_TEXT.revoked}</span>
          <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" onClick={connect} disabled={busy !== null} data-testid="drive-reconnect">Znovu připojit účet</button>
        </div>
      )}
      {canEdit && connected && (
        <p className="drive-hint" data-testid="drive-privacy-note">
          Název a odkaz přidaného souboru uvidí všichni členové projektu. K obsahu se dostanou jen ti, komu soubor zpřístupníte v Google Disku – ClearSpace sdílení nemění.
        </p>
      )}
      {message && (
        <p className={`drive-message${message.kind === 'error' ? ' is-error' : ''}`} role={message.kind === 'error' ? 'alert' : 'status'} data-testid="drive-message">
          {message.text}
        </p>
      )}

      {links === null ? (
        <p className="drive-hint">Načítání souborů…</p>
      ) : own.length === 0 ? (
        <p className="drive-hint" data-testid="drive-empty">{cardId ? 'K úkolu zatím není připojený žádný soubor z Disku.' : 'K projektu zatím není připojený žádný soubor z Disku.'}</p>
      ) : (
        <ul className="drive-list" data-testid="drive-list">{own.map((l) => row(l, true))}</ul>
      )}

      {taskLinks.length > 0 && (
        <>
          <h4 className="drive-subtitle">U úkolů ({taskLinks.length})</h4>
          <ul className="drive-list" data-testid="drive-task-list">{taskLinks.map((l) => row(l, false))}</ul>
        </>
      )}

      {preview && (
        <ModalShell isOpen onClose={() => setPreview(null)} title={preview.link.name} icon={<Icon mime={preview.link.mimeType} />} maxWidth={760} testId="drive-preview-modal">
          <p className="drive-hint">Obsah načtený z Google Disku pod vaším účtem. Zobrazuje se jen vám a neukládá se.</p>
          {preview.error ? (
            <p className="drive-message is-error" role="alert">{preview.error}</p>
          ) : !preview.content ? (
            <p className="drive-hint">Načítání…</p>
          ) : (
            <>
              <pre className="drive-preview-text" data-testid="drive-preview-text">{preview.content.text || '(prázdný soubor)'}</pre>
              {preview.content.truncated && <p className="drive-hint">Zobrazen je jen začátek souboru. Celý soubor otevřete na Disku.</p>}
            </>
          )}
        </ModalShell>
      )}
    </section>
  );
}
