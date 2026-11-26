'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Plug } from 'lucide-react';
import { DriveError } from '../../services/driveService';
import { hubService, PROVIDER_NAME, type HubIdentity } from '../../services/hubService';
import { ProviderIcon } from './ProjectIntegrationsModal';

const RETURN_TEXT: Record<string, { kind: 'info' | 'error'; text: string }> = {
  installed: { kind: 'info', text: 'Aplikace ClearSpace Projekty je ve Slacku nainstalovaná. Kanál propojíte v projektu → Integrace.' },
  denied: { kind: 'error', text: 'Instalace byla zrušena – ve Slacku jste ji nepovolili. Nic se nezměnilo.' },
  expired: { kind: 'error', text: 'Požadavek na instalaci vypršel nebo už byl použit. Zkuste to prosím znovu.' },
  unsupported: { kind: 'error', text: 'Tento typ instalace Slacku (Enterprise Grid) není podporovaný.' },
  scope: { kind: 'error', text: 'Slack vrátil jiná oprávnění, než ClearSpace žádal. Z bezpečnostních důvodů se nic neuložilo.' },
  error: { kind: 'error', text: 'Instalace se nepodařila. Zkuste to prosím znovu.' },
  unavailable: { kind: 'error', text: 'Slack neodpověděl včas. Nic se neuložilo – zkuste to prosím znovu.' },
  disabled: { kind: 'error', text: 'Slack pro projekty není na tomto serveru zapnutý.' },
};
/** The install completion consumes a single-use state: once per page load (React dev runs effects twice). */
let completion: Promise<{ outcome: string }> | null = null;

/** Settings → "Slack a Telegram pro projekty": workspace install of the project app + my linked chat accounts. */
export default function HubSettingsCard({ returnOutcome }: { returnOutcome?: string | null }) {
  const [ids, setIds] = useState<HubIdentity[] | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const load = useCallback(async () => {
    try { setIds(await hubService.identities()); } catch (e) { setIds(null); setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Stav se nepodařilo načíst.' }); }
  }, []);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (returnOutcome === 'slack') {
        try { const r = await (completion ??= hubService.completeSlack()); if (!cancelled) setMessage(RETURN_TEXT[r.outcome] ?? RETURN_TEXT.error); }
        catch (e) { if (!cancelled) setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : RETURN_TEXT.error.text }); }
      } else if (returnOutcome && RETURN_TEXT[returnOutcome]) setMessage(RETURN_TEXT[returnOutcome]);
      if (!cancelled) await load();
    })();
    return () => { cancelled = true; };
  }, [returnOutcome, load]);
  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try { await fn(); } catch (e) { setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : fallback }); } finally { setBusy(false); }
  };

  if (ids === undefined || ids === null) return message ? <section className="settings-card" id="hub" data-testid="hub-settings"><p role="alert" className="drive-message is-error">{message.text}</p></section> : null;
  return (
    <section className="settings-card" id="hub" data-testid="hub-settings" aria-labelledby="hub-settings-title">
      <h2 id="hub-settings-title"><Plug size={18} aria-hidden="true" /> Slack a Telegram pro projekty</h2>
      <p>Projekty můžete propojit s vybranými Slack kanály a Telegram skupinami (projekt → Integrace). Tady je instalace Slack aplikace pro projekty a vaše propojené chat účty.</p>
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={`drive-message${message.kind === 'error' ? ' is-error' : ''}`} data-testid="hub-settings-message">{message.text}</p>}
      <ul className="settings-services">
        <li className="settings-service">
          <div>
            <strong><ProviderIcon provider="slack" size={13} /> Aplikace ClearSpace Projekty ve Slacku</strong>
            <p>Samostatná aplikace (jiná než osobní oznámení). Oprávnění: psát do kanálů, kam ji pozvete, příkaz /clearspace, akce u zprávy a čtení zpráv jen v kanálech, kde je členem. Instalovat může vlastník nebo správce projektu.</p>
          </div>
          <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" disabled={busy} data-testid="hub-slack-install"
            onClick={() => run(() => hubService.installSlack(), 'Instalaci se nepodařilo zahájit.')}>Nainstalovat do Slacku</button>
        </li>
      </ul>
      <h3 className="hub-subtitle">Moje propojené chat účty</h3>
      <p>Úkoly z chatu a odpovědi ve vláknech se ukládají pod vaším jménem jen z účtů, které tu máte propojené. Propojení začnete v chatu: ve Slacku <code>/clearspace ucet</code>, v Telegramu soukromou zprávou <code>/start</code> projektovému botovi.</p>
      <ul className="settings-services" data-testid="hub-identities">
        {ids.length === 0 && <li className="hub-muted">Žádný propojený účet.</li>}
        {ids.map((i) => (
          <li key={`${i.provider}:${i.key}`} className="settings-service">
            <div><strong><ProviderIcon provider={i.provider} size={13} /> {i.label}</strong><p>propojeno {new Date(i.createdAt).toLocaleDateString('cs-CZ')}</p></div>
            <button type="button" className="cs-btn cs-btn--danger cs-btn--sm" disabled={busy} data-testid="hub-identity-remove"
              onClick={() => run(async () => { await hubService.removeIdentity(i.provider, i.key); setMessage({ kind: 'info', text: `${PROVIDER_NAME[i.provider]} účet odpojen.` }); await load(); }, 'Účet se nepodařilo odpojit.')}>Odpojit</button>
          </li>
        ))}
      </ul>
      <p>Podrobnosti: <Link href="/privacy#komunikace">Ochrana osobních údajů – komunikace projektu</Link>.</p>
    </section>
  );
}
