'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Repeat, RefreshCw, Trash2, Plus, ExternalLink, Users } from 'lucide-react';
import { driveService, onLinksChanged, serviceActive, DriveError, type GoogleStatus } from '../../services/driveService';
import { calendarService, CALENDAR_PRIVACY_TEXT, eventWhen, type CalendarLink } from '../../services/calendarService';
import { gmailService } from '../../services/gmailService';
import CalendarPickerModal from './CalendarPickerModal';
import { useConfirm } from '../ui/useConfirm';

interface CalendarLinksPanelProps {
  projectId: string;
  /** Task-level panel (task drawer). Without it: project-level events + an overview of task-level ones. */
  cardId?: string;
  canEdit: boolean;
  returnTo: string;
  cardTitle?: (cardId: string) => string | undefined;
}

const DELETED_TEXT = 'Událost už v Google Kalendáři toho, kdo ji připojil, není (zrušena nebo smazána). Zůstávají jen uložené základní údaje.';
const ucastnik = (n: number) => (n === 1 ? 'účastník' : n >= 2 && n <= 4 ? 'účastníci' : 'účastníků');

/** One linked event with the actions the viewer may use (owner: refresh / open; editor: remove). Shared by the panel and the calendar. */
export function CalendarLinkRow({ link: l, me, calendarOn, canEdit, removable, busy, cardTitle, onRefresh, onOpen, onRemove }: {
  link: CalendarLink; me: string | null; calendarOn: boolean; canEdit: boolean; removable: boolean; busy: boolean;
  cardTitle?: string; onRefresh: (l: CalendarLink) => void; onOpen: (l: CalendarLink) => void; onRemove: (l: CalendarLink) => void;
}) {
  const mine = Boolean(me && l.linkedBy === me);
  return (
    <li className="drive-link" data-testid={`calendar-link-${l.id}`} data-state={l.state}>
      {l.recurring ? <Repeat size={16} aria-hidden="true" style={{ color: 'var(--accent)' }} /> : <CalendarDays size={16} aria-hidden="true" style={{ color: 'var(--accent)' }} />}
      <div className="drive-link-main">
        <span className="drive-link-name" title={l.title} data-testid="calendar-link-title">{l.title}</span>
        <span className="drive-link-meta" data-testid="calendar-link-meta">
          {eventWhen(l)}
          {l.recurring && <> · opakovaná</>}
          {l.attendees > 0 && <> · <Users size={10} aria-hidden="true" /> {l.attendees} {ucastnik(l.attendees)}</>}
          {l.organizer && <> · pořádá {l.organizer}</>}
          {' · '}připojil(a) {l.linkedByName}
          {cardTitle && <> · úkol „{cardTitle}“</>}
        </span>
        {l.state === 'deleted' && <span className="drive-link-problem" role="status" data-testid="calendar-link-problem">{DELETED_TEXT}</span>}
      </div>
      <div className="drive-link-actions">
        {mine && calendarOn && (
          <>
            {l.state !== 'deleted' && (
              <button type="button" className="drive-icon-btn" title="Otevřít v Google Kalendáři (jen pro vás)" aria-label={`Otevřít v Google Kalendáři: ${l.title}`} onClick={() => onOpen(l)} disabled={busy} data-testid="calendar-open">
                <ExternalLink size={14} />
              </button>
            )}
            <button type="button" className="drive-icon-btn" title="Obnovit informace" aria-label={`Obnovit informace: ${l.title}`} onClick={() => onRefresh(l)} disabled={busy} data-testid="calendar-refresh">
              <RefreshCw size={14} />
            </button>
          </>
        )}
        {removable && canEdit && (
          <button type="button" className="drive-icon-btn is-danger" title="Odebrat událost" aria-label={`Odebrat událost: ${l.title}`} onClick={() => onRemove(l)} data-testid="calendar-remove">
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </li>
  );
}

/** Actions on linked events (shared by the panel and the project calendar). */
export function useCalendarLinkActions(setMessage: (m: { kind: 'info' | 'error'; text: string } | null) => void, reload: () => Promise<void> | void, where: string) {
  const [ask, confirmDialog] = useConfirm();
  const [busy, setBusy] = useState(false);
  const onRefresh = async (l: CalendarLink) => {
    setBusy(true);
    try {
      const r = await calendarService.refresh(l.id);
      setMessage({ kind: 'info', text: r.state === 'deleted' ? DELETED_TEXT : r.private ? 'Událost je teď soukromá – její nové údaje se se členy projektu nesdílejí.' : 'Informace o události jsou aktuální.' });
      if (r.updated) await reload();
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Informace se nepodařilo obnovit.' });
    } finally { setBusy(false); }
  };
  const onOpen = async (l: CalendarLink) => {
    // open the tab synchronously (popup blockers), navigate it once the server answered with Google's own link
    const w = window.open('about:blank', '_blank');
    try {
      const url = await calendarService.openUrl(l.id);
      if (w) { w.opener = null; w.location.href = url; } else window.location.assign(url);
    } catch (e) {
      w?.close();
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Událost se nepodařilo otevřít.' });
      await reload();
    }
  };
  const onRemove = async (l: CalendarLink) => {
    if (!(await ask({ title: 'Odebrat událost?', message: `Odebrat událost „${l.title}“ z ${where}? Ve vašem Google Kalendáři se nic nezmění.`, confirmLabel: 'Odebrat', danger: true }))) return;
    try { await calendarService.remove(l.id); await reload(); } catch (e) {
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Událost se nepodařilo odebrat.' });
    }
  };
  return { busy, onRefresh, onOpen, onRemove, confirmDialog };
}

export default function CalendarLinksPanel({ projectId, cardId, canEdit, returnTo, cardTitle }: CalendarLinksPanelProps) {
  const [links, setLinks] = useState<CalendarLink[] | null>(null);
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  const load = useCallback(async () => {
    try { setLinks(await calendarService.list(projectId, cardId)); } catch (e) {
      setLinks((prev) => prev ?? []);
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Události se nepodařilo načíst.' });
    }
  }, [projectId, cardId]);
  const actions = useCalendarLinkActions(setMessage, load, cardId ? 'úkolu' : 'projektu');

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async load; state is set after the request
  useEffect(() => { void load(); }, [load]);
  useEffect(() => onLinksChanged(projectId, (cid) => { if (!cardId || cid === cardId || cid === null) void load(); }), [projectId, cardId, load]);
  useEffect(() => {
    let active = true;
    driveService.status().then((s) => { if (active) setStatus(s); }).catch(() => { if (active) setStatus({ configured: false, connection: null }); });
    gmailService.myUserId().then((id) => { if (active) setMe(id); });   // the caller's ClearSpace id (shared helper)
    return () => { active = false; };
  }, []);

  const calendarOn = serviceActive(status, 'calendar');
  const available = Boolean(status?.configured && status.calendarAvailable);
  const own = (links ?? []).filter((l) => (cardId ? l.cardId === cardId : l.cardId === null));
  const taskLinks = cardId ? [] : (links ?? []).filter((l) => l.cardId !== null);

  // Calendar switched off on the server and nothing linked: the section does not exist for this user.
  if (status && !available && links !== null && links.length === 0) return null;

  const connect = async () => {
    setConnecting(true);
    try { await driveService.connect(returnTo, 'calendar'); } catch (e) {
      setConnecting(false);
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Připojení se nepodařilo zahájit.' });
    }
  };
  const row = (l: CalendarLink, removable: boolean) => (
    <CalendarLinkRow key={l.id} link={l} me={me} calendarOn={calendarOn} canEdit={canEdit} removable={removable} busy={actions.busy}
      cardTitle={!cardId && l.cardId ? cardTitle?.(l.cardId) : undefined} onRefresh={actions.onRefresh} onOpen={actions.onOpen} onRemove={actions.onRemove} />
  );

  return (
    <section className="drive-panel" data-testid={cardId ? 'task-calendar-section' : 'project-calendar-section'} aria-label="Události z Google Kalendáře">
      {actions.confirmDialog}
      <div className="drive-panel-head">
        <h3 className="drawer-section-title drive-section-title">
          <CalendarDays size={14} aria-hidden="true" /> {cardId ? 'Události' : 'Události projektu'} ({own.length})
          {status?.simulated && <span className="cs-badge cs-badge--warning" title="Lokální testovací poskytovatel, ne skutečný Google Kalendář">simulace</span>}
        </h3>
        {canEdit && calendarOn && available && (
          <div className="drive-panel-actions">
            <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" onClick={() => { setMessage(null); setPicking(true); }} disabled={actions.busy} data-testid="calendar-attach">
              <Plus size={13} aria-hidden="true" /> Připojit událost
            </button>
          </div>
        )}
      </div>

      {status && !available && <p className="drive-hint" data-testid="calendar-unavailable">Propojení s Google Kalendářem není na serveru zapnuté. Připojené události zůstávají viditelné.</p>}
      {available && !calendarOn && canEdit && (
        <div className="drive-hint drive-hint--row">
          <span>{status?.connection?.status === 'active' ? 'Povolte ClearSpace čtení vašeho Google Kalendáře a připojujte události k projektu.' : 'Připojte svůj účet Google s Kalendářem a připojujte události k projektu.'}</span>
          <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" onClick={connect} disabled={connecting} data-testid="calendar-connect">
            {connecting ? 'Přesměrování…' : 'Připojit Google Kalendář'}
          </button>
        </div>
      )}
      {canEdit && calendarOn && available && <p className="drive-hint" data-testid="calendar-privacy-note">{CALENDAR_PRIVACY_TEXT}</p>}
      {message && (
        <p className={`drive-message${message.kind === 'error' ? ' is-error' : ''}`} role={message.kind === 'error' ? 'alert' : 'status'} data-testid="calendar-message">{message.text}</p>
      )}

      {links === null ? (
        <p className="drive-hint">Načítání událostí…</p>
      ) : own.length === 0 ? (
        <p className="drive-hint" data-testid="calendar-empty">{cardId ? 'K úkolu zatím není připojená žádná událost.' : 'K projektu zatím není připojená žádná událost.'}</p>
      ) : (
        <ul className="drive-list" data-testid="calendar-list">{own.map((l) => row(l, true))}</ul>
      )}
      {taskLinks.length > 0 && (
        <>
          <h4 className="drive-subtitle">U úkolů ({taskLinks.length})</h4>
          <ul className="drive-list" data-testid="calendar-task-list">{taskLinks.map((l) => row(l, false))}</ul>
        </>
      )}

      {picking && (
        <CalendarPickerModal
          projectId={projectId}
          cardId={cardId ?? null}
          simulated={Boolean(status?.simulated)}
          onClose={() => setPicking(false)}
          onAttached={(text, isError) => { setPicking(false); setMessage({ kind: isError ? 'error' : 'info', text }); void load(); }}
        />
      )}
    </section>
  );
}
