'use client';

import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { Column, Card } from '../../types/kanban';
import { getPriorityColor } from '../../utils/kanban';
import type { CalendarEventChip } from '../calendar/useProjectCalendarLayers';

interface CalendarViewProps {
  columns: Column[];
  /** Libovolné datum zobrazeného měsíce. */
  month: Date;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  onToday: () => void;
  onCardClick: (columnId: string, card: Card) => void;
  /** RUN 04: Google Calendar events (linked to the project; the viewer's own layer). Optional, tasks render as before without them. */
  events?: CalendarEventChip[];
  /** RUN 04: controls of the Calendar layers, shown under the header. */
  toolbar?: React.ReactNode;
}

const EVENT_CLASS: Record<CalendarEventChip['variant'], string> = { linked: 'is-linked', deleted: 'is-linked is-deleted', mine: 'is-mine', private: 'is-mine is-private' };

interface DatedCard {
  card: Card;
  columnId: string;
}

const WEEKDAYS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];
const MAX_CARDS_PER_DAY = 3;
/** Kolik teček se vejde do kompaktní mobilní buňky, než se přepne na "+N". */
const MAX_DOTS_PER_DAY = 3;

/** Lokální YYYY-MM-DD (ne UTC), aby seděl termín karty na správný den. */
function localKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Kalendář úkolů podle termínu (dueDate). Read-only view, klik otevře drawer. */
export default function CalendarView({
  columns,
  month,
  onPrevMonth,
  onNextMonth,
  onToday,
  onCardClick,
  events = [],
  toolbar,
}: CalendarViewProps) {
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalendarEventChip[]>();
    for (const e of events) for (const k of e.days) { if (!map.has(k)) map.set(k, []); map.get(k)!.push(e); }
    return map;
  }, [events]);
  // Mapa den -> karty s termínem na daný den
  const { cardsByDay, undatedCount } = useMemo(() => {
    const map = new Map<string, DatedCard[]>();
    let undated = 0;
    for (const col of columns) {
      for (const card of col.cards) {
        if (!card.dueDate) {
          undated += 1;
          continue;
        }
        const key = card.dueDate.slice(0, 10); // dueDate je 'YYYY-MM-DD'
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push({ card, columnId: col.id });
      }
    }
    return { cardsByDay: map, undatedCount: undated };
  }, [columns]);

  // Mřížka měsíce (týdny od pondělí), doplněná o dny sousedních měsíců
  const weeks = useMemo(() => {
    const year = month.getFullYear();
    const m = month.getMonth();
    const first = new Date(year, m, 1);
    const startOffset = (first.getDay() + 6) % 7; // Po=0 ... Ne=6
    const gridStart = new Date(year, m, 1 - startOffset);

    const daysInMonth = new Date(year, m + 1, 0).getDate();
    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;

    const cells: Date[] = [];
    for (let i = 0; i < totalCells; i++) {
      cells.push(new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
    }
    const rows: Date[][] = [];
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
    return rows;
  }, [month]);

  const todayKey = localKey(new Date());
  const monthLabel = month.toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' });

  // Vybraný den pro mobilní rozbalení. Na desktopu se detail nezobrazuje
  // (CSS) a tlačítko dne tam vůbec není, takže se sem nikdy nedostane.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // Po přelistování měsíce může vybraný den zmizet z mřížky -- neplatný výběr
  // se prostě ignoruje, není potřeba ho čistit efektem.
  const activeKey =
    selectedKey && weeks.some((w) => w.some((d) => localKey(d) === selectedKey)) ? selectedKey : null;
  const activeCards = activeKey ? cardsByDay.get(activeKey) || [] : [];
  const activeEvents = activeKey ? eventsByDay.get(activeKey) || [] : [];
  const activeLabel = activeKey
    ? new Date(`${activeKey}T00:00:00`).toLocaleDateString('cs-CZ', {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      })
    : '';

  return (
    <div className="calendar-panel">
      <div className="calendar-header">
        <div className="calendar-title-group">
          <h2 className="calendar-month-title">{monthLabel}</h2>
          <span className="calendar-subtitle">{events.length ? 'Termíny úkolů a události' : 'Termíny úkolů projektu'}</span>
        </div>
        <div className="calendar-nav">
          <button type="button" className="calendar-today-btn" onClick={onToday} data-testid="calendar-today">
            Dnes
          </button>
          <button type="button" className="calendar-nav-btn" onClick={onPrevMonth} aria-label="Předchozí měsíc" data-testid="calendar-prev">
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="calendar-nav-btn" onClick={onNextMonth} aria-label="Další měsíc" data-testid="calendar-next">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {toolbar}

      <div className="calendar-weekdays">
        {WEEKDAYS.map((d) => (
          <div key={d} className="calendar-weekday">{d}</div>
        ))}
      </div>

      <div className="calendar-grid" data-testid="calendar-grid">
        {weeks.map((week, wi) => (
          <div key={wi} className="calendar-week">
            {week.map((day) => {
              const key = localKey(day);
              const inMonth = day.getMonth() === month.getMonth();
              const isToday = key === todayKey;
              const dayCards = cardsByDay.get(key) || [];
              const dayEvents = eventsByDay.get(key) || [];
              const shown = dayCards.slice(0, MAX_CARDS_PER_DAY);
              const shownEvents = dayEvents.slice(0, Math.max(0, MAX_CARDS_PER_DAY - shown.length));
              const extra = dayCards.length + dayEvents.length - shown.length - shownEvents.length;

              return (
                <div
                  key={key}
                  className={`calendar-day ${inMonth ? '' : 'is-outside'} ${isToday ? 'is-today' : ''} ${
                    activeKey === key ? 'is-selected' : ''
                  }`}
                >
                  {/* Dotyková vrstva přes celou buňku -- na desktopu display: none,
                      takže tam kalendář zůstává čistě read-only jako dosud. */}
                  <button
                    type="button"
                    className="calendar-day-tap"
                    onClick={() => setSelectedKey(activeKey === key ? null : key)}
                    aria-pressed={activeKey === key}
                    aria-label={`${day.getDate()}. ${day.getMonth() + 1}. — ${dayCards.length} úkolů${dayEvents.length ? `, ${dayEvents.length} událostí` : ''}`}
                    data-testid={`calendar-day-tap-${key}`}
                  />
                  <span className="calendar-day-number">{day.getDate()}</span>
                  {/* Kompaktní shrnutí pro mobil: tečky podle priority místo názvů,
                      které se do ~49px buňky stejně nevejdou. */}
                  {dayCards.length > 0 && (
                    <span className="calendar-day-dots" aria-hidden="true">
                      {dayCards.slice(0, MAX_DOTS_PER_DAY).map(({ card }) => (
                        <span
                          key={card.id}
                          className="calendar-chip-dot"
                          style={{ backgroundColor: getPriorityColor(card.priority) }}
                        />
                      ))}
                      {dayCards.length > MAX_DOTS_PER_DAY && (
                        <span className="calendar-dots-more">+{dayCards.length - MAX_DOTS_PER_DAY}</span>
                      )}
                    </span>
                  )}
                  {dayCards.length === 0 && dayEvents.length > 0 && (
                    <span className="calendar-day-dots" aria-hidden="true"><span className="calendar-chip-dot calendar-event-dot" /></span>
                  )}
                  <div className="calendar-day-cards">
                    {shown.map(({ card, columnId }) => (
                      <button
                        key={card.id}
                        type="button"
                        className="calendar-card-chip"
                        onClick={() => onCardClick(columnId, card)}
                        title={card.title}
                        data-testid={`calendar-chip-${card.id}`}
                      >
                        <span
                          className="calendar-chip-dot"
                          style={{ backgroundColor: getPriorityColor(card.priority) }}
                        />
                        <span className="calendar-chip-title">{card.title}</span>
                      </button>
                    ))}
                    {shownEvents.map((ev) => (
                      <button key={ev.key} type="button" className={`calendar-event-chip ${EVENT_CLASS[ev.variant]}`} onClick={ev.onClick}
                        title={ev.label} aria-label={ev.label} data-testid={`calendar-event-${ev.key}`}>
                        <span className="calendar-chip-title">{ev.title}</span>
                      </button>
                    ))}
                    {extra > 0 && (
                      <span className="calendar-more">+{extra} další</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Rozbalený den (jen mobil -- na desktopu je detail v buňkách samotných). */}
      {activeKey && (
        <div className="calendar-day-detail" data-testid="calendar-day-detail">
          <div className="calendar-detail-head">
            <span className="calendar-detail-date">{activeLabel}</span>
            <button
              type="button"
              className="calendar-detail-close"
              onClick={() => setSelectedKey(null)}
              aria-label="Zavřít detail dne"
              data-testid="calendar-detail-close"
            >
              <X size={16} />
            </button>
          </div>
          {activeEvents.map((ev) => (
            <button key={ev.key} type="button" className={`calendar-event-chip calendar-detail-chip ${EVENT_CLASS[ev.variant]}`} onClick={ev.onClick}
              aria-label={ev.label} data-testid={`calendar-detail-event-${ev.key}`}>
              <span className="calendar-chip-title">{ev.title}</span>
            </button>
          ))}
          {activeCards.length === 0 ? (
            activeEvents.length === 0 && <p className="calendar-detail-empty">Na tento den nemá termín žádný úkol.</p>
          ) : (
            activeCards.map(({ card, columnId }) => (
              <button
                key={card.id}
                type="button"
                className="calendar-card-chip calendar-detail-chip"
                onClick={() => onCardClick(columnId, card)}
                data-testid={`calendar-detail-chip-${card.id}`}
              >
                <span
                  className="calendar-chip-dot"
                  style={{ backgroundColor: getPriorityColor(card.priority) }}
                />
                <span className="calendar-chip-title">{card.title}</span>
              </button>
            ))
          )}
        </div>
      )}

      {undatedCount > 0 && (
        <div className="calendar-footer">
          {undatedCount} {undatedCount === 1 ? 'úkol' : undatedCount < 5 ? 'úkoly' : 'úkolů'} bez termínu se v kalendáři nezobrazuje
        </div>
      )}
    </div>
  );
}
