'use client';

import React, { useCallback, useEffect, useState } from 'react';
import type { SectionSummary } from '../settings/ConnectedAccountsOverview';
import ChatModesExplainer from '../settings/ChatModesExplainer';
import { notifyService } from '../../services/notifyService';
import Link from 'next/link';
import { Plug } from 'lucide-react';
import { DriveError } from '../../services/driveService';
import { hubService, PROVIDER_NAME, type HubIdentity, type HubProvider } from '../../services/hubService';
import { ProviderIcon } from './ProjectIntegrationsModal';
import PairingBox from './PairingBox';

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
export default function HubSettingsCard({ returnOutcome, onSummary }: { returnOutcome?: string | null; onSummary?: (s: SectionSummary | null) => void }) {
  const [ids, setIds] = useState<HubIdentity[] | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  // RUN 11 (#7): the real install state of the project Slack app, from the server's own records (installed by me / used by a project I manage)
  const [slackWs, setSlackWs] = useState<Array<{ label: string; status: 'active' | 'revoked' }> | null | undefined>(undefined);
  const [pending, setPending] = useState<{ provider: HubProvider; code: string; command: string; url?: string; openLabel: string; steps: string[]; until: number; known: number } | null>(null);
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
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const projects = await notifyService.projects().catch(() => []);
      for (const pr of projects.slice(0, 5)) {
        const st = await hubService.project(pr.id).catch(() => null);
        if (st?.canManage) { if (!cancelled) setSlackWs(st.slackWorkspaces); return; }
      }
      if (!cancelled) setSlackWs(null); // no project I manage: the server does not tell (and I could not install anyway)
    })();
    return () => { cancelled = true; };
  }, [returnOutcome]);
  useEffect(() => {
    if (!onSummary || ids === undefined) return;
    if (ids === null) { onSummary(null); return; }
    const active = (slackWs ?? []).filter((w) => w.status === 'active');
    const parts = [active.length ? `Slack aplikace: ${active.map((w) => w.label).join(', ')}` : null, ids.length ? `chat účty: ${ids.length}` : null].filter(Boolean);
    const revoked = (slackWs ?? []).some((w) => w.status === 'revoked') && active.length === 0;
    onSummary({ state: revoked ? 'attention' : active.length && ids.length ? 'connected' : active.length || ids.length ? 'partial' : 'disconnected',
      detail: parts.length ? parts.join(' · ') : 'Nic nepropojeno' });
  }, [ids, slackWs, onSummary]);
  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try { await fn(); } catch (e) { setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : fallback }); } finally { setBusy(false); }
  };

  const start = (provider: HubProvider) => run(async () => {
    const r = await hubService.startIdentity(provider);
    setPending({ provider, code: r.code, command: r.command, url: r.url, openLabel: r.openLabel, steps: r.steps, until: Date.now() + r.expiresInSeconds * 1000,
      known: (ids ?? []).filter((i) => i.provider === provider).length });
    setMessage(null);
  }, 'Kód se nepodařilo vytvořit.');
  // RUN 08 UX: the list refreshes itself while a code is open; the new link is confirmed automatically
  const watch = useCallback(async () => {
    if (!pending) return;
    const list = await hubService.identities().catch(() => null);
    if (!list) return;
    setIds(list);
    const mine = list.filter((i) => i.provider === pending.provider);
    if (mine.length > pending.known) {
      setPending(null);
      setMessage({ kind: 'info', text: `Propojeno: ${mine[mine.length - 1].label}. Úkoly a odpovědi z tohoto účtu se teď ukládají pod vaším jménem.` });
    }
  }, [pending]);

  if (ids === undefined || ids === null) return message ? <section className="settings-card" id="projekty" data-testid="hub-settings"><p role="alert" className="drive-message is-error">{message.text}</p></section> : null;
  return (
    <section className="settings-card" id="projekty" data-testid="hub-settings" aria-labelledby="hub-settings-title">
      <span id="hub" aria-hidden="true" />
      <h2 id="hub-settings-title"><Plug size={18} aria-hidden="true" /> Slack a Telegram pro projekty</h2>
      <p className="settings-lead">Sdílené kanály a skupiny týmu: oznámení projektu a úkoly z chatu. Kanál nebo skupinu propojíte v projektu → Integrace; tady je instalace Slack aplikace a vaše chat účty.</p>
      <ChatModesExplainer />
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={`drive-message${message.kind === 'error' ? ' is-error' : ''}`} data-testid="hub-settings-message">{message.text}</p>}
      <ul className="settings-services">
        <li className="settings-service">
          <div>
            <strong><ProviderIcon provider="slack" size={13} /> Aplikace ClearSpace Projekty ve Slacku</strong>
            <p data-testid="hub-slack-install-state">
              {slackWs === undefined ? 'Zjišťuji stav instalace…'
                : slackWs === null ? 'Stav instalace vidí vlastník nebo správce projektu (instalovat může také jen on).'
                : slackWs.some((w) => w.status === 'active') ? <><span className="settings-chip is-connected">Nainstalováno</span> do {slackWs.filter((w) => w.status === 'active').map((w) => `„${w.label}“`).join(', ')}</>
                : slackWs.length ? <><span className="settings-chip is-attention">Instalace zrušena</span> v {slackWs.map((w) => `„${w.label}“`).join(', ')} – nainstalujte znovu</>
                : <><span className="settings-chip is-disconnected">Nenainstalováno</span></>}
            </p>
            <p className="settings-hint">Samostatná aplikace (jiná než osobní oznámení). Smí psát do kanálů, kam ji pozvete, příkaz /clearspace, akce u zprávy a čtení zpráv jen v kanálech, kde je členem.</p>
          </div>
          {(() => {
            const installed = !!slackWs?.some((w) => w.status === 'active');
            return <button type="button" className={`cs-btn cs-btn--sm ${installed ? 'cs-btn--secondary' : 'cs-btn--primary'}`} disabled={busy} data-testid="hub-slack-install"
              onClick={() => run(() => hubService.installSlack(), 'Instalaci se nepodařilo zahájit.')}>{installed ? 'Přeinstalovat' : 'Nainstalovat do Slacku'}</button>;
          })()}
        </li>
      </ul>
      <h3 className="hub-subtitle">Moje propojené chat účty</h3>
      <p>Úkoly z chatu a odpovědi ve vláknech se ukládají pod vaším jménem jen z účtů, které tu máte propojené. Propojení začíná tady: vytvořte kód a pošlete ho ze svého chat účtu (prokážete tím obě strany).</p>
      <div className="hub-actions">
        <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" disabled={busy} data-testid="hub-identity-slack" onClick={() => start('slack')}>Propojit Slack účet</button>
        <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" disabled={busy} data-testid="hub-identity-telegram" onClick={() => start('telegram')}>Propojit Telegram účet</button>
      </div>
      {pending && (
        <PairingBox testId="hub-identity-code-box" onTick={watch} onRenew={() => void start(pending.provider)} onClose={() => setPending(null)}
          info={{ title: pending.provider === 'slack' ? 'Propojení Slack účtu' : 'Propojení Telegram účtu', steps: pending.steps, command: pending.command,
            openUrl: pending.url, openLabel: pending.openLabel, until: pending.until, waitingText: 'Čekám na potvrzení z chatu' }} />
      )}
      <ul className="settings-services" data-testid="hub-identities">
        {ids.length === 0 && <li className="hub-muted">Žádný propojený účet.</li>}
        {ids.map((i) => (
          <li key={`${i.provider}:${i.key}`} className="settings-service">
            <div><strong><ProviderIcon provider={i.provider} size={13} /> {i.label}</strong><p>propojeno {new Date(i.createdAt).toLocaleDateString('cs-CZ')}</p></div>
            <button type="button" className="cs-btn cs-btn--danger-outline cs-btn--sm" disabled={busy} data-testid="hub-identity-remove"
              onClick={() => run(async () => { await hubService.removeIdentity(i.provider, i.key); setMessage({ kind: 'info', text: `${PROVIDER_NAME[i.provider]} účet odpojen.` }); await load(); }, 'Účet se nepodařilo odpojit.')}>Odpojit</button>
          </li>
        ))}
      </ul>
      <p>Podrobnosti: <Link href="/privacy#komunikace">Ochrana osobních údajů – komunikace projektu</Link>.</p>
    </section>
  );
}
