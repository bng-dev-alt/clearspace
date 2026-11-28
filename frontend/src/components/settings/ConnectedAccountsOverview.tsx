'use client';

import React from 'react';

/** What one settings section reports about itself (RUN 11, D1). `null` = the section is not available on this server. */
export interface SectionSummary {
  state: 'connected' | 'partial' | 'attention' | 'disconnected';
  /** One short line: who/what is connected, in plain words. */
  detail: string;
}

const STATE_TEXT: Record<SectionSummary['state'], string> = {
  connected: 'Připojeno', partial: 'Částečně', attention: 'Vyžaduje akci', disconnected: 'Nepřipojeno',
};

export const SECTIONS = [
  { id: 'google', title: 'Google', purpose: 'Soubory, e-maily a události, které sami připojíte k projektům.' },
  { id: 'oznameni', title: 'Osobní oznámení', purpose: 'Jen vám: upozornění z ClearSpace do vašeho Slacku nebo Telegramu.' },
  { id: 'projekty', title: 'Slack a Telegram pro projekty', purpose: 'Sdílené kanály a skupiny týmu: oznámení projektu, úkoly z chatu.' },
] as const;
export type SectionId = typeof SECTIONS[number]['id'];

/**
 * The "at a glance" block on top of Propojené účty: one row per section with its real state (reported by the section itself, never
 * guessed here) and a jump link. Personal vs. project connections are separate rows on purpose.
 */
export default function ConnectedAccountsOverview({ summaries }: { summaries: Partial<Record<SectionId, SectionSummary | null>> }) {
  const rows = SECTIONS.filter((s) => summaries[s.id] !== null);
  if (rows.length === 0) return null;
  return (
    <section className="settings-overview" aria-labelledby="settings-overview-title" data-testid="settings-overview">
      <h2 id="settings-overview-title" className="settings-overview-title">Přehled</h2>
      <ul>
        {rows.map((s) => {
          const sum = summaries[s.id];
          return (
            <li key={s.id} className="settings-overview-row" data-testid={`overview-${s.id}`}>
              <div className="settings-overview-main">
                <strong>{s.title}</strong>
                <span className="settings-overview-purpose">{s.purpose}</span>
              </div>
              <div className="settings-overview-state">
                {sum === undefined ? <span className="mi-muted">Načítání…</span> : sum && (
                  <>
                    <span className={`settings-chip is-${sum.state}`} data-testid={`overview-${s.id}-state`}>{STATE_TEXT[sum.state]}</span>
                    <span className="settings-overview-detail">{sum.detail}</span>
                  </>
                )}
              </div>
              <a href={`#${s.id}`} className="cs-btn cs-btn--ghost cs-btn--sm" aria-label={`Spravovat: ${s.title}`}>Spravovat</a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
