'use client';

import React, { useEffect, useState } from 'react';
import { HardDrive } from 'lucide-react';
import { driveService, DriveError, type GoogleStatus } from '../../services/driveService';
import { ACCESS_TEXT } from '../../lib/google/labels';

/** Outcome of Google's redirect back to ClearSpace (?google=...). */
export const RETURN_TEXT: Record<string, { kind: 'info' | 'error'; text: string }> = {
  connected: { kind: 'info', text: 'Účet Google je připojený.' },
  denied: { kind: 'error', text: 'Připojení bylo zrušeno – v Google jste přístup nepovolili.' },
  scope_denied: { kind: 'error', text: 'Bez oprávnění k Google Disku nelze soubory připojit. Při připojování prosím ponechte zaškrtnutý přístup k Disku.' },
  expired: { kind: 'error', text: 'Požadavek na připojení vypršel nebo už byl použit. Zkuste to prosím znovu.' },
  conflict: { kind: 'error', text: 'Tento účet Google je už připojený k jinému účtu ClearSpace.' },
  error: { kind: 'error', text: 'Účet Google se nepodařilo připojit. Zkuste to prosím znovu.' },
  not_configured: { kind: 'error', text: 'Propojení s Google Diskem není na serveru nastavené.' },
};

/** Minimal integration settings (extends into the RUN 07 Integrations Hub). */
export default function GoogleConnectionCard({ returnOutcome }: { returnOutcome?: string | null }) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(returnOutcome ? RETURN_TEXT[returnOutcome] ?? null : null);

  useEffect(() => {
    driveService.status(true).then(setStatus).catch((e) => {
      setStatus({ configured: false, connection: null });
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Stav propojení se nepodařilo načíst.' });
    });
  }, []);

  const connect = async () => {
    setBusy(true);
    try { await driveService.connect('/settings'); } catch (e) {
      setBusy(false);
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Připojení se nepodařilo zahájit.' });
    }
  };

  const disconnect = async () => {
    if (!confirm('Odpojit účet Google? Soubory připojené k projektům a úkolům v ClearSpace zůstanou; nikdo z týmu tím nezíská ani neztratí přístup k souborům v Google Disku.')) return;
    setBusy(true);
    try {
      const r = await driveService.disconnect();
      setStatus(await driveService.status(true));
      setMessage(r.revokedAtGoogle || !r.disconnected
        ? { kind: 'info', text: 'Účet Google byl odpojen a oprávnění ClearSpace v Google zrušeno.' }
        : { kind: 'info', text: 'Účet Google byl odpojen. Oprávnění se u Google nepodařilo zrušit automaticky – můžete ho odebrat v nastavení účtu Google (Zabezpečení → Aplikace třetích stran).' });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Účet se nepodařilo odpojit.' });
    } finally {
      setBusy(false);
    }
  };

  const c = status?.connection;
  return (
    <section className="settings-card" data-testid="google-connection-card" aria-labelledby="google-card-title">
      <h2 id="google-card-title">
        <HardDrive size={18} aria-hidden="true" /> Google Disk
        {status?.simulated && <span className="cs-badge cs-badge--warning" title="Lokální testovací poskytovatel, ne skutečný Google">simulace</span>}
      </h2>
      <p>Připojení účtu Google je oddělené od přihlášení do ClearSpace a vaši identitu v ClearSpace nemění.</p>
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={`drive-message${message.kind === 'error' ? ' is-error' : ''}`} data-testid="google-connection-message">{message.text}</p>}

      {status === null ? <p>Načítání…</p> : !status.configured ? (
        <p data-testid="google-not-configured">{status.message ?? 'Propojení s Google Diskem není na serveru nastavené.'}</p>
      ) : c ? (
        <>
          <div className="settings-row">
            <div>
              <div style={{ fontSize: '0.72rem', color: 'var(--gray-text)' }}>Připojený účet</div>
              <div className="settings-account" data-testid="google-account-email">{c.email}</div>
              <div style={{ fontSize: '0.72rem', color: c.status === 'active' ? 'var(--gray-text)' : 'var(--danger)' }} data-testid="google-connection-state">
                {c.status === 'active' ? `Aktivní od ${new Date(c.connectedAt).toLocaleDateString('cs-CZ')}` : ACCESS_TEXT.revoked}
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {c.status !== 'active' && <button type="button" className="cs-btn cs-btn--primary cs-btn--sm" onClick={connect} disabled={busy} data-testid="google-reconnect">Znovu připojit účet</button>}
              <button type="button" className="cs-btn cs-btn--danger cs-btn--sm" onClick={disconnect} disabled={busy} data-testid="google-disconnect">Odpojit Google účet</button>
            </div>
          </div>
          <ul>
            <li>ClearSpace vidí jen soubory, které sami vyberete v okně Google Disku – ne celý váš Disk.</li>
            <li>Odkazy na vybrané soubory uvidí členové projektu; otevřít je mohou jen ti, komu je zpřístupníte v Google Disku.</li>
            <li>Obsah souboru se čte jen na vaši žádost (náhled textu) a neukládá se. Nic se automaticky neposílá AI.</li>
          </ul>
        </>
      ) : (
        <>
          <ul>
            <li>Požadovaná oprávnění: vaše e-mailová adresa Google a přístup <strong>jen k souborům, které vyberete</strong> (Google Disk – „soubory použité s touto aplikací“).</li>
            <li>ClearSpace neprochází celý Disk, nemění sdílení souborů a nic nemaže.</li>
            <li>Připojení můžete kdykoli zrušit zde nebo v nastavení účtu Google.</li>
          </ul>
          <div><button type="button" className="cs-btn cs-btn--primary" onClick={connect} disabled={busy} data-testid="google-connect">{busy ? 'Přesměrování…' : 'Připojit Google Disk'}</button></div>
        </>
      )}
    </section>
  );
}
