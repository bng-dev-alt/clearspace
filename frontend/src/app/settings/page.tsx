'use client';

import React, { useEffect, useState } from 'react';
import Navbar from '../../components/layout/Navbar';
import GoogleConnectionCard from '../../components/drive/GoogleConnectionCard';
import NotificationChannelsCard from '../../components/notify/NotificationChannelsCard';
import { hasSupabaseConfig } from '../../lib/supabase';

export default function SettingsPage() {
  const [outcome, setOutcome] = useState<string | null | undefined>(undefined);
  const [notifyOutcome, setNotifyOutcome] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('google');
    const n = params.get('notify');   // RUN 05: back from Slack (?notify=slack)
    // keep the first answer: React dev mode runs this effect twice, the second time after the URL was cleaned
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOutcome((prev) => prev ?? q);
    setNotifyOutcome((prev) => prev ?? n);
    if (q || n) window.history.replaceState(null, '', '/settings');
  }, []);

  return (
    <div className="app-container" style={{ backgroundColor: 'var(--bg-page)' }}>
      <Navbar />
      <section className="app-hero">
        <div className="hero-content">
          <div className="hero-left">
            <span className="hero-team-label">NASTAVENÍ</span>
            <h1 className="hero-title">Propojené účty</h1>
            <p className="hero-desc">Účty jiných služeb, se kterými ClearSpace pracuje vaším jménem.</p>
          </div>
          <div className="hero-right" />
        </div>
      </section>
      <main id="mg-content" className="settings-page">
        {!hasSupabaseConfig ? (
          <section className="settings-card"><p>Propojení účtů je dostupné po přihlášení do ClearSpace s databází (v ukázkovém režimu není k dispozici).</p></section>
        ) : outcome === undefined ? null : (
          <>
            <GoogleConnectionCard returnOutcome={outcome} />
            <NotificationChannelsCard returnOutcome={notifyOutcome} />
          </>
        )}
      </main>
    </div>
  );
}
