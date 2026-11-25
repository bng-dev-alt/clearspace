'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CalendarDays, Lock, Repeat, Search } from 'lucide-react';
import ModalShell from '../ui/ModalShell';
import { DriveError } from '../../services/driveService';
import { calendarService, CALENDAR_PRIVACY_TEXT, eventWhen, type EventPage, type OwnEvent } from '../../services/calendarService';

/**
 * Selection of events from the user's OWN primary Google Calendar (ClearSpace's own dialog; the listing runs on the server with
 * the user's token). Private / confidential events are shown to their owner but cannot be selected. Nothing is attached until
 * the user explicitly confirms.
 */
interface Props {
  projectId: string;
  cardId: string | null;
  simulated: boolean;
  onClose: () => void;
  onAttached: (message: string, isError: boolean) => void;
  /** Pre-selected event (from the personal calendar layer). */
  initial?: OwnEvent;
}

const MAX_SELECT = 10;
const MAX_DAYS = 42;
const dayInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** [from 00:00 local, to 24:00 local) as ISO instants, or a Czech error. */
function range(from: string, to: string): { from: string; to: string } | string {
  const a = new Date(`${from}T00:00:00`); const b = new Date(`${to}T00:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 'Zadejte platné datum Od a Do.';
  b.setDate(b.getDate() + 1);
  if (b <= a) return 'Datum Do musí být stejné nebo pozdější než Od.';
  if (b.getTime() - a.getTime() > MAX_DAYS * 86_400_000) return `Období může mít nejvýš ${MAX_DAYS} dní.`;
  return { from: a.toISOString(), to: b.toISOString() };
}

export default function CalendarPickerModal({ projectId, cardId, simulated, onClose, onAttached, initial }: Props) {
  const today = new Date();
  const [form, setForm] = useState(() => {
    const start = initial ? new Date(initial.allDay ? `${initial.start.slice(0, 10)}T00:00:00` : initial.start) : today;
    const end = new Date(start); end.setDate(end.getDate() + 27);
    return { q: '', from: dayInput(start), to: dayInput(end) };
  });
  const [applied, setApplied] = useState(form);
  const [page, setPage] = useState<EventPage | null>(null);
  const [tokens, setTokens] = useState<(string | null)[]>([null]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<string, OwnEvent>>(() => new Map(initial && !initial.private ? [[initial.id, initial]] : []));
  const [attaching, setAttaching] = useState(false);

  const run = useCallback(async (f: typeof form, token: string | null) => {
    const r = range(f.from, f.to);
    if (typeof r === 'string') { setError(r); setPage(null); return; }
    setLoading(true);
    setError(null);
    try { setPage(await calendarService.events({ ...r, q: f.q.trim() || undefined, pageToken: token, pageSize: 20 })); } catch (e) {
      setPage(null);
      setError(e instanceof DriveError ? e.message : 'Události se nepodařilo načíst.');
    } finally { setLoading(false); }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- first page when the dialog opens
  useEffect(() => { void run(form, null); }, [run]);   // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e: React.FormEvent) => { e.preventDefault(); setApplied(form); setTokens([null]); void run(form, null); };
  const next = () => { if (!page?.nextPageToken) return; setTokens((t) => [...t, page.nextPageToken]); void run(applied, page.nextPageToken); };
  const prev = () => { if (tokens.length < 2) return; const t = tokens.slice(0, -1); setTokens(t); void run(applied, t[t.length - 1]); };
  const toggle = (ev: OwnEvent) => setSelected((m) => {
    const n = new Map(m);
    if (n.has(ev.id)) n.delete(ev.id); else if (n.size < MAX_SELECT && !ev.private) n.set(ev.id, ev);
    return n;
  });

  const attach = async () => {
    setAttaching(true);
    try {
      const r = await calendarService.attach(projectId, cardId, [...selected.keys()]);
      const added = r.links.filter((l) => !l.duplicate).length;
      const dup = r.links.length - added;
      const parts = [added ? `Připojeno událostí: ${added}.` : '', dup ? `${dup === 1 ? 'Jedna událost už byla' : `${dup} události už byly`} připojená.` : '', ...[...new Set(r.failed.map((f) => f.message))]].filter(Boolean);
      onAttached(parts.join(' ') || 'Nic nebylo připojeno.', r.failed.length > 0 && added === 0);
    } catch (e) {
      setError(e instanceof DriveError ? e.message : 'Události se nepodařilo připojit.');
      setAttaching(false);
    }
  };

  return (
    <ModalShell isOpen onClose={onClose} title={<>Připojit událost z Google Kalendáře{simulated && <span className="cs-badge cs-badge--warning" style={{ marginLeft: 8 }}>simulace</span>}</>} icon={<CalendarDays size={16} />} maxWidth={760} testId="calendar-picker">
      <div className="gmail-picker">
        <p className="drive-hint" data-testid="calendar-picker-privacy">{CALENDAR_PRIVACY_TEXT} ClearSpace v Google Kalendáři nic nevytváří ani nemění.</p>
        <form className="gmail-search" onSubmit={submit} role="search">
          <label className="gmail-field"><span>Hledat</span>
            <input type="search" className="form-input" value={form.q} maxLength={200} placeholder="např. kickoff" onChange={(e) => setForm((f) => ({ ...f, q: e.target.value }))} data-testid="calendar-filter-q" />
          </label>
          <label className="gmail-field"><span>Od</span>
            <input type="date" className="form-input" value={form.from} onChange={(e) => setForm((f) => ({ ...f, from: e.target.value }))} data-testid="calendar-filter-from" />
          </label>
          <label className="gmail-field"><span>Do</span>
            <input type="date" className="form-input" value={form.to} onChange={(e) => setForm((f) => ({ ...f, to: e.target.value }))} data-testid="calendar-filter-to" />
          </label>
          <button type="submit" className="cs-btn cs-btn--secondary cs-btn--sm" disabled={loading} data-testid="calendar-search-submit"><Search size={13} aria-hidden="true" /> Hledat</button>
        </form>
        <p className="drive-hint">Zobrazují se události z vašeho hlavního Google Kalendáře, nejvýš {MAX_DAYS} dní najednou.</p>

        {error && <p className="drive-message is-error" role="alert" data-testid="calendar-picker-error">{error}</p>}
        {loading ? <p className="drive-hint">Načítám váš kalendář…</p> : page && page.items.length === 0 ? (
          <p className="drive-hint" data-testid="calendar-picker-empty">V tomto období nic není. Zkuste jiný výraz nebo období.</p>
        ) : page && (
          <ul className="drive-list gmail-results" data-testid="calendar-results">
            {page.items.map((ev) => (
              <li key={ev.id} className={`drive-link gmail-result${selected.has(ev.id) ? ' is-selected' : ''}`}>
                <label className="gmail-result-label">
                  <input type="checkbox" checked={selected.has(ev.id)} onChange={() => toggle(ev)}
                    disabled={ev.private || (!selected.has(ev.id) && selected.size >= MAX_SELECT)} data-testid={`calendar-pick-${ev.id}`}
                    aria-label={ev.private ? `Soukromá událost, nelze připojit: ${ev.title}` : `Vybrat: ${ev.title}`} />
                  <span className="drive-link-main">
                    <span className="drive-link-name" title={ev.title}>
                      {ev.private && <Lock size={11} aria-hidden="true" />} {ev.recurring && <Repeat size={11} aria-hidden="true" />} {ev.title}
                    </span>
                    <span className="drive-link-meta">
                      {eventWhen(ev)}{ev.modified && <> · upravený výskyt</>}{ev.attendees > 0 && <> · {ev.attendees} účast.</>}
                      {ev.private && <> · soukromá – nelze připojit</>}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <div className="gmail-picker-foot">
          <div className="drive-panel-actions">
            <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={prev} disabled={loading || tokens.length < 2} data-testid="calendar-page-prev">Předchozí</button>
            <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={next} disabled={loading || !page?.nextPageToken} data-testid="calendar-page-next">Další</button>
          </div>
          <div className="drive-panel-actions">
            <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={onClose}>Zrušit</button>
            <button type="button" className="cs-btn cs-btn--primary cs-btn--sm" onClick={attach} disabled={attaching || selected.size === 0} data-testid="calendar-attach-selected">
              {attaching ? 'Připojuji…' : `Připojit vybrané (${selected.size})`}
            </button>
          </div>
        </div>
      </div>
    </ModalShell>
  );
}
