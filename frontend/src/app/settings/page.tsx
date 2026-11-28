'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Navbar from '../../components/layout/Navbar';
import GoogleConnectionCard from '../../components/drive/GoogleConnectionCard';
import NotificationChannelsCard from '../../components/notify/NotificationChannelsCard';
import HubSettingsCard from '../../components/hub/HubSettingsCard';
import ConnectedAccountsOverview, { type SectionId, type SectionSummary } from '../../components/settings/ConnectedAccountsOverview';
import { hasSupabaseConfig } from '../../lib/supabase';

/**
 * Nastavení → Propojené účty (RUN 11, D1): one page, the state of everything at a glance on top, then three sections with the same
 * row pattern – Google · Osobní oznámení (only you) · Slack a Telegram pro projekty (shared team channels). Each section reports its
 * own real state to the overview; nothing is guessed here.
 */
export default function SettingsPage() {
  const [outcome, setOutcome] = useState<string | null | undefined>(undefined);
  const [notifyOutcome, setNotifyOutcome] = useState<string | null | undefined>(undefined);
  const [hubOutcome, setHubOutcome] = useState<string | null | undefined>(undefined);
  const [summaries, setSummaries] = useState<Partial<Record<SectionId, SectionSummary | null>>>({});
  const report = useCallback((id: SectionId) => (s: SectionSummary | null) => setSummaries((prev) => (prev[id] === s ? prev : { ...prev, [id]: s })), []);
  const [onGoogle] = useState(() => report('google'));
  const [onNotify] = useState(() => report('oznameni'));
  const [onHub] = useState(() => report('projekty'));
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('google');
    const n = params.get('notify');   // RUN 05: back from Slack (?notify=slack)
    const h = params.get('hub');      // RUN 07: back from the project Slack app install (?hub=slack)
    // keep the first answer: React dev mode runs this effect twice, the second time after the URL was cleaned
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOutcome((prev) => prev ?? q);
    setNotifyOutcome((prev) => prev ?? n);
    setHubOutcome((prev) => prev ?? h);
    if (q || n || h) window.history.replaceState(null, '', '/settings' + window.location.hash);
  }, []);

  return (
    <div className="app-container" style={{ backgroundColor: 'var(--bg-page)' }}>
      <Navbar />
      <section className="app-hero">
        <div className="hero-content">
          <div className="hero-left">
            <span className="hero-team-label">Nastavení</span>
            <h1 className="hero-title">Propojené účty</h1>
            <p className="hero-desc">Služby, se kterými ClearSpace pracuje vaším jménem. Každé propojení můžete kdykoli odpojit.</p>
          </div>
          <div className="hero-right" />
        </div>
      </section>
      <main id="mg-content" className="settings-page">
        {!hasSupabaseConfig ? (
          <section className="settings-card"><p>Propojení účtů je dostupné po přihlášení do ClearSpace s databází (v ukázkovém režimu není k dispozici).</p></section>
        ) : outcome === undefined ? null : (
          <>
            <ConnectedAccountsOverview summaries={summaries} />
            <GoogleConnectionCard returnOutcome={outcome} onSummary={onGoogle} />
            <NotificationChannelsCard returnOutcome={notifyOutcome} onSummary={onNotify} />
            <HubSettingsCard returnOutcome={hubOutcome} onSummary={onHub} />
          </>
        )}
      </main>
    </div>
  );
}
