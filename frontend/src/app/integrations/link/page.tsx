'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import Navbar from '../../../components/layout/Navbar';
import { DriveError } from '../../../services/driveService';
import { hubService, PROVIDER_NAME } from '../../../services/hubService';
import { hasSupabaseConfig } from '../../../lib/supabase';

/**
 * /integrations/link#code=... -- confirm that a Slack / Telegram account is mine. The single-use code lives in the URL FRAGMENT (never sent to
 * any server log or Referer) and is removed from the address bar at once; nothing happens until the signed-in user presses the button.
 */
export default function LinkIdentityPage() {
  const [code, setCode] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  useEffect(() => {
    const m = /code=([A-Za-z0-9_-]{32,64})/.exec(window.location.hash);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCode((prev) => prev ?? m?.[1] ?? null);
    if (window.location.hash) window.history.replaceState(null, '', '/integrations/link');
  }, []);
  const confirm = async () => {
    if (!code) return;
    setBusy(true);
    try {
      const r = await hubService.confirmIdentity(code);
      setResult({ kind: 'info', text: `Hotovo: ${PROVIDER_NAME[r.provider]} účet „${r.label}“ je propojený s vaším účtem ClearSpace.` });
      setCode(null);
    } catch (e) {
      setResult({ kind: 'error', text: e instanceof DriveError ? e.message : 'Propojení se nepodařilo.' });
    } finally { setBusy(false); }
  };
  return (
    <div className="app-container" style={{ backgroundColor: 'var(--bg-page)' }}>
      <Navbar />
      <main id="mg-content" className="settings-page">
        <section className="settings-card" data-testid="hub-link-page">
          <h2>Propojit chat účet s ClearSpace</h2>
          {!hasSupabaseConfig ? <p>V ukázkovém režimu není k dispozici.</p> : code === undefined ? null : code ? (<>
            <p>Potvrzením se váš Slack / Telegram účet, ze kterého jste o odkaz požádali, propojí s účtem ClearSpace, pod kterým jste teď přihlášeni. Úkoly a odpovědi z propojených kanálů se pak budou ukládat vaším jménem a s vašimi oprávněními.</p>
            <p>Pokud jste o propojení nežádali, stránku zavřete.</p>
            <div><button type="button" className="cs-btn cs-btn--primary cs-btn--sm" disabled={busy} onClick={() => void confirm()} data-testid="hub-link-confirm">Ano, je to můj účet</button></div>
          </>) : !result ? <p>Odkaz je neplatný. Vyžádejte si v chatu nový.</p> : null}
          {result && <p role={result.kind === 'error' ? 'alert' : 'status'} className={`drive-message${result.kind === 'error' ? ' is-error' : ''}`} data-testid="hub-link-result">{result.text}</p>}
          <p><Link href="/settings#hub">Nastavení → Slack a Telegram pro projekty</Link></p>
        </section>
      </main>
    </div>
  );
}
