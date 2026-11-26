'use client';

import React, { useEffect, useState } from 'react';
import { CalendarDays, HardDrive, Mail, Link2 } from 'lucide-react';
import Link from 'next/link';
import { driveService, serviceActive, DriveError, type GoogleServiceName, type GoogleStatus } from '../../services/driveService';
import { gmailService } from '../../services/gmailService';
import { calendarService } from '../../services/calendarService';
import { ACCESS_TEXT, PILOT_TEXT } from '../../lib/google/labels';

/** Outcome of Google's redirect back to ClearSpace (?google=...). */
export const RETURN_TEXT: Record<string, { kind: 'info' | 'error'; text: string }> = {
  connected: { kind: 'info', text: 'Účet Google je připojený.' },
  denied: { kind: 'error', text: 'Připojení bylo zrušeno – v Google jste přístup nepovolili.' },
  scope_denied: { kind: 'error', text: 'Bez oprávnění k Google Disku nelze soubory připojit. Při připojování prosím ponechte zaškrtnutý přístup k Disku.' },
  expired: { kind: 'error', text: 'Požadavek na připojení vypršel nebo už byl použit. Zkuste to prosím znovu.' },
  conflict: { kind: 'error', text: 'Tento účet Google je už připojený k jinému účtu ClearSpace.' },
  error: { kind: 'error', text: 'Účet Google se nepodařilo připojit. Zkuste to prosím znovu.' },
  unavailable: { kind: 'error', text: 'Google neodpověděl včas, takže se připojení nedokončilo. Nic se neuložilo ani nezměnilo – zkuste to prosím znovu stejným tlačítkem.' },
  not_configured: { kind: 'error', text: 'Propojení s Google Diskem není na serveru nastavené.' },
  // RUN 03
  gmail_connected: { kind: 'info', text: 'Gmail je připojený (jen čtení). E-maily do projektů připojujete vždy sami.' },
  gmail_denied: { kind: 'error', text: 'Přístup ke Gmailu nebyl povolen. Ostatní propojení (Google Disk) zůstávají beze změny.' },
  pilot_account: { kind: 'error', text: 'Tento účet Google není zařazený do pilotního provozu Gmailu a Google Kalendáře. Nic se nezměnilo.' },
  account_mismatch: { kind: 'error', text: 'Gmail nebo Google Kalendář je potřeba připojit ze stejného účtu Google, který už máte připojený. Nic se nezměnilo.' },
  // RUN 04
  calendar_connected: { kind: 'info', text: 'Google Kalendář je připojený (jen čtení). Události do projektů připojujete vždy sami; vaše ostatní události vidíte jen vy.' },
  calendar_denied: { kind: 'error', text: 'Přístup ke Google Kalendáři nebyl povolen. Ostatní propojení (Google Disk, Gmail) zůstávají beze změny.' },
};

/** Integration settings: ONE Google account, per-service state (Drive / Gmail / Calendar). Extends into the RUN 07 Integrations Hub. */
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

  const connect = async (service: GoogleServiceName = 'drive') => {
    setBusy(true);
    try { await driveService.connect('/settings', service); } catch (e) {
      setBusy(false);
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Připojení se nepodařilo zahájit.' });
    }
  };

  const disconnect = async () => {
    if (!confirm('Odpojit účet Google? Google zruší celé oprávnění ClearSpace najednou – Google Disk i Gmail a také Google Kalendář. Soubory připojené k projektům a úkolům v ClearSpace zůstanou; nikdo z týmu tím nezíská ani neztratí přístup k souborům v Google Disku. U připojených e-mailů a událostí zůstanou jen základní údaje.')) return;
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

  const disableGmail = async () => {
    if (!confirm('Vypnout Gmail v ClearSpace? ClearSpace přestane Gmail používat; Google Disk zůstane připojený. Oprávnění u Googlu zůstane, dokud neodpojíte celý účet Google (to ukončí i Disk) nebo ho neodeberete v nastavení účtu Google.')) return;
    const purge = confirm('Odebrat také všechny e-maily, které jste připojili k projektům a úkolům? (OK = odebrat, Zrušit = ponechat základní údaje v projektech)');
    setBusy(true);
    try {
      const r = await gmailService.disable(purge);
      setStatus(await driveService.status(true));
      const p = r.purged;
      setMessage({ kind: 'info', text: `Gmail je v ClearSpace vypnutý.${p ? ` Odebráno připojených e-mailů: ${p.removed}.${p.skipped ? ` U ${p.skipped} jste jen čtenář – požádejte editora projektu o odebrání.` : ''}` : ''}` });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Gmail se nepodařilo vypnout.' });
    } finally {
      setBusy(false);
    }
  };

  const disableCalendar = async () => {
    if (!confirm('Vypnout Google Kalendář v ClearSpace? ClearSpace přestane kalendář číst; Google Disk a Gmail zůstanou připojené. Oprávnění u Googlu zůstane, dokud neodpojíte celý účet Google (to ukončí i Disk a Gmail) nebo ho neodeberete v nastavení účtu Google.')) return;
    const purge = confirm('Odebrat také všechny události, které jste připojili k projektům a úkolům? (OK = odebrat, Zrušit = ponechat základní údaje v projektech)');
    setBusy(true);
    try {
      const r = await calendarService.disable(purge);
      setStatus(await driveService.status(true));
      const p = r.purged;
      setMessage({ kind: 'info', text: `Google Kalendář je v ClearSpace vypnutý.${p ? ` Odebráno připojených událostí: ${p.removed}.${p.skipped ? ` U ${p.skipped} jste jen čtenář – požádejte editora projektu o odebrání.` : ''}` : ''}` });
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Google Kalendář se nepodařilo vypnout.' });
    } finally {
      setBusy(false);
    }
  };

  const c = status?.connection;
  const calendarOn = serviceActive(status, 'calendar');
  const driveOn = serviceActive(status, 'drive');
  const gmailOn = serviceActive(status, 'gmail');
  const active = c?.status === 'active';
  return (
    <section className="settings-card" data-testid="google-connection-card" aria-labelledby="google-card-title">
      <h2 id="google-card-title">
        <Link2 size={18} aria-hidden="true" /> Účet Google
        {status?.simulated && <span className="cs-badge cs-badge--warning" title="Lokální testovací poskytovatel, ne skutečný Google">simulace</span>}
      </h2>
      <p>Připojení účtu Google je oddělené od přihlášení do ClearSpace a vaši identitu v ClearSpace nemění. Jednotlivé služby povolujete zvlášť.</p>
      {status?.configured && status.pilot && <p className="drive-hint" data-testid="google-pilot-note">{PILOT_TEXT}</p>}
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={`drive-message${message.kind === 'error' ? ' is-error' : ''}`} data-testid="google-connection-message">{message.text}</p>}

      {status === null ? <p>Načítání…</p> : !status.configured ? (
        <p data-testid="google-not-configured">{status.message ?? 'Propojení s Google Diskem není na serveru nastavené.'}</p>
      ) : (
        <>
          {c && (
            <div className="settings-row">
              <div>
                <div style={{ fontSize: '0.72rem', color: 'var(--gray-text)' }}>Připojený účet</div>
                <div className="settings-account" data-testid="google-account-email">{c.email}</div>
                <div style={{ fontSize: '0.72rem', color: active ? 'var(--gray-text)' : 'var(--danger)' }} data-testid="google-connection-state">
                  {active ? `Aktivní od ${new Date(c.connectedAt).toLocaleDateString('cs-CZ')}` : ACCESS_TEXT.revoked}
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {!active && <button type="button" className="cs-btn cs-btn--primary cs-btn--sm" onClick={() => connect(c.services?.drive ? 'drive' : c.services?.gmail ? 'gmail' : c.services?.calendar ? 'calendar' : 'drive')} disabled={busy} data-testid="google-reconnect">Znovu připojit účet</button>}
                <button type="button" className="cs-btn cs-btn--danger cs-btn--sm" onClick={disconnect} disabled={busy} data-testid="google-disconnect">Odpojit Google účet</button>
              </div>
            </div>
          )}

          <ul className="settings-services">
            <li className="settings-service" data-testid="drive-service">
              <div>
                <strong><HardDrive size={13} aria-hidden="true" /> Google Disk</strong>
                <p data-testid="drive-service-state">{driveOn ? 'Povoleno.' : 'Nepovoleno.'} Přístup <strong>jen k souborům, které vyberete</strong> v okně Google Disku – ne k celému Disku.</p>
              </div>
              {!driveOn && (!c || active) && (
                <button type="button" className="cs-btn cs-btn--primary cs-btn--sm" onClick={() => connect('drive')} disabled={busy} data-testid={c ? 'drive-connect-settings' : 'google-connect'}>
                  {busy ? 'Přesměrování…' : 'Připojit Google Disk'}
                </button>
              )}
            </li>
            <li className="settings-service" data-testid="gmail-service">
              <div>
                <strong><Mail size={13} aria-hidden="true" /> Gmail</strong>
                <p data-testid="gmail-service-state">
                  {!status.gmailAvailable ? 'Na tomto serveru není zapnutý.' : gmailOn ? 'Povoleno – jen čtení.' : 'Nepovoleno.'}{' '}
                  ClearSpace čte jen e-maily, které sami vyhledáte a připojíte; nic neodesílá, nemaže ani neoznačuje.
                </p>
              </div>
              {status.gmailAvailable && (!c || active) && (gmailOn ? (
                <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={disableGmail} disabled={busy} data-testid="gmail-disable">Vypnout Gmail v ClearSpace</button>
              ) : (
                <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" onClick={() => connect('gmail')} disabled={busy} data-testid="gmail-connect-settings">{busy ? 'Přesměrování…' : 'Připojit Gmail'}</button>
              ))}
            </li>
            <li className="settings-service" data-testid="calendar-service">
              <div>
                <strong><CalendarDays size={13} aria-hidden="true" /> Google Kalendář</strong>
                <p data-testid="calendar-service-state">
                  {!status.calendarAvailable ? 'Na tomto serveru není zapnutý.' : calendarOn ? 'Povoleno – jen čtení vašeho hlavního kalendáře.' : 'Nepovoleno.'}{' '}
                  Své události vidíte v kalendáři projektu jen vy; k projektu se připojí jen ty, které sami vyberete. ClearSpace v kalendáři nic nevytváří ani nemění.
                </p>
              </div>
              {status.calendarAvailable && (!c || active) && (calendarOn ? (
                <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={disableCalendar} disabled={busy} data-testid="calendar-disable">Vypnout Kalendář v ClearSpace</button>
              ) : (
                <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" onClick={() => connect('calendar')} disabled={busy} data-testid="calendar-connect-settings">{busy ? 'Přesměrování…' : 'Připojit Google Kalendář'}</button>
              ))}
            </li>
          </ul>

          <ul data-testid="google-privacy">
            <li>ClearSpace vidí jen soubory, které sami vyberete v okně Google Disku – ne celý váš Disk. Odkazy na ně uvidí členové projektu; otevřít je mohou jen ti, komu je zpřístupníte v Google Disku.</li>
            <li>U e-mailů uvidí členové projektu jen předmět, odesílatele (jméno nebo doménu), datum a počet zpráv. Obsah, adresy a přílohy zůstávají ve vaší schránce; náhled vidíte jen vy.</li>
            <li>Obsah souborů a e-mailů se čte jen na vaši žádost (náhled), neukládá se a nic se automaticky neposílá AI.</li>
            {status.calendarAvailable && <li data-testid="google-privacy-calendar">U událostí z Google Kalendáře uvidí členové projektu jen název, čas, počet účastníků a organizátora (jméno nebo doménu). Popis, místo, adresy účastníků a odkazy na schůzky se neukládají; soukromé a důvěrné události připojit nelze.</li>}
            <li><strong>Vypnout Gmail / Kalendář</strong> = ClearSpace danou službu přestane používat (ostatní zůstanou). <strong>Odpojit Google účet</strong> = Google zruší celé oprávnění ClearSpace (všechny služby najednou); jednotlivé služby Google zvlášť zrušit neumí.</li>
            <li>Podrobnosti: <Link href="/privacy#google">Ochrana osobních údajů – Google</Link>.</li>
          </ul>
        </>
      )}
    </section>
  );
}
