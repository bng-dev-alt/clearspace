'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarDays, ExternalLink, Link2, Lock, Plus } from 'lucide-react';
import ModalShell from '../ui/ModalShell';
import { driveService, onLinksChanged, serviceActive, DriveError, type GoogleStatus } from '../../services/driveService';
import { gmailService } from '../../services/gmailService';
import { calendarService, eventDayKeys, eventWhen, MY_LAYER_TEXT, type CalendarLink, type OwnEvent } from '../../services/calendarService';
import { CalendarLinkRow, useCalendarLinkActions } from './CalendarLinksPanel';
import CalendarPickerModal from './CalendarPickerModal';
import CalendarView from '../board/CalendarView';

/** One event chip in the project calendar grid (RUN 04). */
export interface CalendarEventChip {
  key: string;
  title: string;
  days: string[];
  variant: 'linked' | 'deleted' | 'mine' | 'private';
  label: string;
  onClick: () => void;
}

const LAYER_KEY = 'cs_calendar_my_layer';

/**
 * RUN 04: the two Google Calendar layers of the project calendar --
 *   * linked events (shared metadata, every project member),
 *   * "Můj Google kalendář" (the viewer's OWN primary calendar, read on demand for the visible grid, never stored, never shown to others).
 * Returns the chips for the grid, a toolbar and the dialogs. Nothing here exists when Calendar is off and nothing is linked.
 */
export function useProjectCalendarLayers({ projectId, month, canEdit, returnTo }: { projectId: string; month: Date; canEdit: boolean; returnTo: string }) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [linked, setLinked] = useState<CalendarLink[]>([]);
  const [mine, setMine] = useState<{ items: OwnEvent[]; truncated: boolean } | null>(null);
  const [showMine, setShowMine] = useState(() => typeof window !== 'undefined' && window.localStorage.getItem(LAYER_KEY) === '1');
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [selected, setSelected] = useState<{ link?: CalendarLink; own?: OwnEvent } | null>(null);
  const [picking, setPicking] = useState<{ initial?: OwnEvent } | null>(null);
  const [connecting, setConnecting] = useState(false);

  const available = Boolean(status?.configured && status.calendarAvailable);
  const calendarOn = serviceActive(status, 'calendar');
  // the visible grid: Monday before the 1st, 6 weeks = exactly the server's 42-day maximum
  const range = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - ((first.getDay() + 6) % 7));
    const end = new Date(start); end.setDate(end.getDate() + 42);
    return { from: start.toISOString(), to: end.toISOString() };
  }, [month]);

  const loadLinked = useCallback(async () => {
    try { setLinked(await calendarService.list(projectId)); } catch { /* the grid still shows tasks */ }
  }, [projectId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- async load; state is set after the request
  useEffect(() => { void loadLinked(); }, [loadLinked]);
  useEffect(() => onLinksChanged(projectId, () => { void loadLinked(); }), [projectId, loadLinked]);
  useEffect(() => {
    let active = true;
    driveService.status().then((s) => { if (active) setStatus(s); }).catch(() => { if (active) setStatus({ configured: false, connection: null }); });
    gmailService.myUserId().then((id) => { if (active) setMe(id); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!showMine || !calendarOn || !available) return;
    let active = true;
    calendarService.events({ ...range, pageSize: 250 })
      .then((p) => { if (active) { setMine({ items: p.items, truncated: Boolean(p.nextPageToken) }); setMessage(null); } })
      .catch((e) => { if (active) { setMine(null); setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Váš kalendář se nepodařilo načíst.' }); } });
    return () => { active = false; };
  }, [showMine, calendarOn, available, range]);

  const actions = useCalendarLinkActions(setMessage, async () => { await loadLinked(); setSelected(null); }, 'projektu');

  const toggleMine = (on: boolean) => {
    setShowMine(on);
    if (!on) setMine(null);
    try { window.localStorage.setItem(LAYER_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  };
  const connect = async () => {
    setConnecting(true);
    try { await driveService.connect(returnTo, 'calendar'); } catch (e) {
      setConnecting(false);
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Připojení se nepodařilo zahájit.' });
    }
  };

  const chips: CalendarEventChip[] = useMemo(() => {
    const out: CalendarEventChip[] = linked.map((l) => ({
      key: `l-${l.id}`, title: l.title, days: eventDayKeys(l), variant: l.state === 'deleted' ? 'deleted' : 'linked',
      label: `Událost projektu: ${l.title}, ${eventWhen(l)}`, onClick: () => setSelected({ link: l }),
    }));
    if (showMine && calendarOn && mine) {
      for (const e of mine.items) {
        out.push({ key: `m-${e.id}`, title: e.title, days: eventDayKeys(e), variant: e.private ? 'private' : 'mine',
          label: `Můj kalendář: ${e.title}, ${eventWhen(e)}`, onClick: () => setSelected({ own: e }) });
      }
    }
    return out;
  }, [linked, mine, showMine, calendarOn]);

  const visible = available || linked.length > 0;
  const toolbar = !visible ? null : (
    <div className="calendar-layers" data-testid="calendar-layers">
      {available && (calendarOn ? (
        <label className="calendar-layer-toggle" title={MY_LAYER_TEXT}>
          <input type="checkbox" checked={showMine} onChange={(e) => toggleMine(e.target.checked)} data-testid="calendar-my-layer" />
          <span>Můj Google kalendář <span className="calendar-layer-note">(vidíte jen vy)</span></span>
        </label>
      ) : (
        <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={connect} disabled={connecting} data-testid="calendar-layer-connect">
          <Link2 size={13} aria-hidden="true" /> {connecting ? 'Přesměrování…' : 'Připojit Google Kalendář'}
        </button>
      ))}
      {available && calendarOn && canEdit && (
        <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" onClick={() => { setMessage(null); setPicking({}); }} data-testid="calendar-layer-attach">
          <Plus size={13} aria-hidden="true" /> Připojit událost
        </button>
      )}
      {status?.simulated && <span className="cs-badge cs-badge--warning" title="Lokální testovací poskytovatel, ne skutečný Google Kalendář">simulace</span>}
      <span className="calendar-legend" aria-hidden="true">
        <span className="calendar-event-chip is-linked">událost projektu</span>
        {showMine && calendarOn && <span className="calendar-event-chip is-mine">můj kalendář</span>}
      </span>
      {mine?.truncated && <span className="drive-hint">Zobrazeno prvních 250 vašich událostí.</span>}
      {message && <span className={`drive-message${message.kind === 'error' ? ' is-error' : ''}`} role={message.kind === 'error' ? 'alert' : 'status'} data-testid="calendar-layer-message">{message.text}</span>}
    </div>
  );

  const dialogs = (
    <>
      {actions.confirmDialog}
      {selected?.link && (
        <ModalShell isOpen onClose={() => setSelected(null)} title={selected.link.title} icon={<CalendarDays size={16} />} maxWidth={620} testId="calendar-event-modal">
          <p className="drive-hint">Událost připojená k projektu. Členové projektu vidí jen tyto základní údaje.</p>
          <ul className="drive-list">
            <CalendarLinkRow link={selected.link} me={me} calendarOn={calendarOn} canEdit={canEdit} removable busy={actions.busy}
              onRefresh={actions.onRefresh} onOpen={actions.onOpen} onRemove={actions.onRemove} />
          </ul>
        </ModalShell>
      )}
      {selected?.own && (
        <ModalShell isOpen onClose={() => setSelected(null)} title={selected.own.title} icon={selected.own.private ? <Lock size={16} /> : <CalendarDays size={16} />} maxWidth={620} testId="calendar-own-modal">
          <p className="drive-hint">{MY_LAYER_TEXT}</p>
          <p className="drive-link-meta" data-testid="calendar-own-when">
            {eventWhen(selected.own)}{selected.own.recurring && ' · opakovaná'}{selected.own.modified && ' · upravený výskyt'}
            {selected.own.attendees > 0 && ` · ${selected.own.attendees} účast.`} · pořádá {selected.own.organizer}
          </p>
          {selected.own.private && <p className="drive-hint" data-testid="calendar-own-private">Soukromou ani důvěrnou událost nelze připojit k projektu.</p>}
          <div className="drive-panel-actions" style={{ marginTop: '0.75rem' }}>
            {selected.own.htmlLink && (
              <a href={selected.own.htmlLink} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="cs-btn cs-btn--ghost cs-btn--sm" data-testid="calendar-own-open">
                <ExternalLink size={13} aria-hidden="true" /> Otevřít v Google Kalendáři
              </a>
            )}
            {canEdit && !selected.own.private && (
              <button type="button" className="cs-btn cs-btn--primary cs-btn--sm" onClick={() => { setPicking({ initial: selected.own }); setSelected(null); }} data-testid="calendar-own-attach">
                <Plus size={13} aria-hidden="true" /> Připojit k projektu
              </button>
            )}
          </div>
        </ModalShell>
      )}
      {picking && (
        <CalendarPickerModal projectId={projectId} cardId={null} simulated={Boolean(status?.simulated)} initial={picking.initial}
          onClose={() => setPicking(null)}
          onAttached={(text, isError) => { setPicking(null); setMessage({ kind: isError ? 'error' : 'info', text }); void loadLinked(); }} />
      )}
    </>
  );

  return { chips, toolbar, dialogs };
}

/** The project calendar (tasks by due date) with the Google Calendar layers. Same props as CalendarView + project context. */
export function ProjectCalendarView(props: Omit<React.ComponentProps<typeof CalendarView>, 'events' | 'toolbar'> & { projectId: string; canEdit: boolean; returnTo: string }) {
  const { projectId, canEdit, returnTo, ...view } = props;
  const layers = useProjectCalendarLayers({ projectId, month: view.month, canEdit, returnTo });
  return (
    <>
      <CalendarView {...view} events={layers.chips} toolbar={layers.toolbar} />
      {layers.dialogs}
    </>
  );
}
