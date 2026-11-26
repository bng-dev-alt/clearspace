'use client';

import React, { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { MessageSquare, Send, Plug } from 'lucide-react';
import { ModalShell, Badge } from '../ui';
import { DriveError } from '../../services/driveService';
import {
  EVENT_LABEL, hubService, PROVIDER_NAME, STATUS_LABEL, type HubDestination, type HubEventType, type HubProjectStatus, type HubProvider,
} from '../../services/hubService';

export const ProviderIcon = ({ provider, size = 14 }: { provider: HubProvider; size?: number }) =>
  provider === 'slack' ? <MessageSquare size={size} aria-label="Slack" /> : <Send size={size} aria-label="Telegram" />;

const AUDIT_LABEL: Record<string, string> = {
  link_code_issued: 'vytvořen kód pro propojení', destination_linked: 'kanál / skupina zadala kód', destination_confirmed: 'propojení potvrzeno',
  destination_rejected: 'propojení odmítnuto', destination_configured: 'změna nastavení', destination_removed: 'odpojeno',
  destination_state: 'změna stavu od poskytovatele', task_created_from_chat: 'úkol vytvořen z chatu',
};
const PI_SCOPE: Record<HubProvider, string> = {
  slack: 'Project Intelligence uvidí NOVÉ zprávy z tohoto kanálu od chvíle zapnutí (ne historii) – jen kanál, kde je aplikace ClearSpace Projekty, nic jiného z workspace.',
  telegram: 'Project Intelligence uvidí jen zprávy, které projektový bot dostane: příkazy pro něj a odpovědi na jeho zprávy (režim soukromí Telegramu je zapnutý, bot ostatní zprávy skupiny nevidí).',
};

interface Props { projectId: string; onClose: () => void }

/** Project → Integrace: Slack channels and Telegram groups bound to this project, their capabilities and the audit trail. */
export default function ProjectIntegrationsModal({ projectId, onClose }: Props) {
  const [status, setStatus] = useState<HubProjectStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [code, setCode] = useState<{ provider: HubProvider; code: string; instruction: string; until: number } | null>(null);
  const [piAsk, setPiAsk] = useState<HubDestination | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await hubService.project(projectId)); } catch (e) {
      setStatus(null);
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Integrace se nepodařilo načíst.' });
    }
  }, [projectId]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try { await fn(); } catch (e) { setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : fallback }); } finally { setBusy(false); }
  };
  const issue = (provider: HubProvider) => run(async () => {
    const r = await hubService.linkCode(projectId, provider);
    setCode({ provider, code: r.code, instruction: r.instruction, until: Date.now() + r.expiresInSeconds * 1000 });
    setMessage(null);
    await load();
  }, 'Kód se nepodařilo vytvořit.');
  const decide = (d: HubDestination, decision: 'confirm' | 'reject') => run(async () => {
    await hubService.decide(d.id, decision);
    setMessage({ kind: 'info', text: decision === 'confirm' ? `${d.label} je propojený s projektem.` : `${d.label}: propojení odmítnuto.` });
    if (decision === 'confirm') setCode(null);
    await load();
  }, 'Rozhodnutí se nepodařilo uložit.');
  const save = (d: HubDestination, patch: Partial<Pick<HubDestination, 'notify' | 'interactive' | 'intelligence' | 'eventTypes'>>, ack = false) => run(async () => {
    const next = { ...d, ...patch };
    await hubService.configure(d.id, { notify: next.notify, interactive: next.interactive, intelligence: next.intelligence, intelligenceAck: ack, eventTypes: next.eventTypes });
    await load();
  }, 'Nastavení se nepodařilo uložit.');
  const test = (d: HubDestination) => run(async () => {
    const r = await hubService.test(d.id);
    setMessage({ kind: r.outcome === 'sent' ? 'info' : 'error', text: r.message });
    await load();
  }, 'Zkušební zprávu se nepodařilo odeslat.');
  const remove = (d: HubDestination) => {
    if (!confirm(`Odpojit ${d.label}? ClearSpace sem přestane posílat oznámení, přestane přijímat zprávy a zprávy načtené pro Project Intelligence smaže.`)) return;
    const purge = confirm('Smazat i záznamy zpráv, ze kterých vznikly úkoly, a synchronizované odpovědi? (OK = smazat, Zrušit = ponechat jako historii u úkolů. Úkoly samotné zůstávají vždy.)');
    void run(async () => {
      const r = await hubService.remove(d.id, purge);
      setMessage({ kind: 'info', text: `${d.label} je odpojený${r.purgedMessages ? ` (smazáno záznamů: ${r.purgedMessages})` : ''}.` });
      await load();
    }, 'Odpojení se nepodařilo.');
  };

  const title = <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>Integrace projektu
    {status && (status.simulated.slack || status.simulated.telegram) && <Badge variant="warning">simulace</Badge>}</span>;

  return (
    <ModalShell isOpen onClose={onClose} title={title} icon={<Plug size={18} />} maxWidth={760} testId="hub-integrations-modal">
      <div className="hub-modal" data-testid="hub-integrations">
        <p className="hub-intro">Propojte projekt s konkrétními kanály ve Slacku a skupinami v Telegramu. ClearSpace pracuje jen s těmi, které výslovně propojíte a potvrdíte – nikdy s celým workspace, kontakty ani soukromými konverzacemi.</p>
        {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={`drive-message${message.kind === 'error' ? ' is-error' : ''}`} data-testid="hub-message">{message.text}</p>}
        {status === undefined && <p className="hub-muted">Načítám…</p>}
        {status && !status.providers.slack && !status.providers.telegram && <p className="hub-muted">Na tomto serveru nejsou integrace zapnuté.</p>}

        {status && status.canManage && (
          <div className="hub-actions" data-testid="hub-connect">
            {status.providers.slack && <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" disabled={busy} onClick={() => issue('slack')} data-testid="hub-connect-slack"><MessageSquare size={14} /> Připojit Slack kanál</button>}
            {status.providers.telegram && <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" disabled={busy} onClick={() => issue('telegram')} data-testid="hub-connect-telegram"><Send size={14} /> Připojit Telegram skupinu</button>}
          </div>
        )}
        {status?.canManage && status.providers.slack && !status.slackWorkspaces.some((w) => w.status === 'active') && (
          <p className="hub-muted" data-testid="hub-slack-install-hint">Slack: nejdřív nainstalujte aplikaci <strong>ClearSpace Projekty</strong> do svého workspace v <Link href="/settings#hub">Nastavení → Slack a Telegram pro projekty</Link>.</p>
        )}
        {code && (
          <div className="hub-code" data-testid="hub-code-box">
            <p><strong>{PROVIDER_NAME[code.provider]}:</strong> {code.instruction}</p>
            <p className="hub-code-value" data-testid="hub-code">{code.code}</p>
            <p className="hub-muted">Kód platí 10 minut a jde použít jen jednou. Pak se tady objeví ke schválení – <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={() => void load()} disabled={busy} data-testid="hub-refresh">obnovit</button></p>
          </div>
        )}

        {status && (
          <ul className="hub-destinations" data-testid="hub-destinations">
            {status.destinations.length === 0 && <li className="hub-muted">Zatím žádný propojený kanál ani skupina.</li>}
            {status.destinations.map((d) => (
              <li key={d.id} className={`hub-destination is-${d.status}`} data-testid={`hub-destination-${d.provider}`}>
                <div className="hub-destination-head">
                  <strong><ProviderIcon provider={d.provider} /> {d.label}</strong>
                  <Badge variant={d.status === 'active' ? 'success' : d.status === 'pending' ? 'warning' : 'danger'}>{STATUS_LABEL[d.status]}</Badge>
                  <span className="hub-muted">{d.kind === 'slack_channel' ? 'Slack kanál' : d.kind === 'telegram_supergroup' ? 'Telegram superskupina' : 'Telegram skupina'} · zpráv: {d.messages}</span>
                </div>
                {d.status === 'pending' && status.canManage && (
                  <div className="hub-actions">
                    <span>Někdo v {d.provider === 'slack' ? 'kanálu' : 'skupině'} zadal kód tohoto projektu. Propojit?</span>
                    <button type="button" className="cs-btn cs-btn--primary cs-btn--sm" disabled={busy} onClick={() => decide(d, 'confirm')} data-testid="hub-confirm">Potvrdit propojení</button>
                    <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" disabled={busy} onClick={() => decide(d, 'reject')} data-testid="hub-reject">Odmítnout</button>
                  </div>
                )}
                {d.status !== 'pending' && (
                  <fieldset className="hub-caps" disabled={busy || !status.canManage} aria-label={`Možnosti ${d.label}`} data-testid="hub-capabilities">
                    <label className="notify-check"><input type="checkbox" checked={d.notify} onChange={(e) => save(d, { notify: e.target.checked })} data-testid="hub-cap-notify" />
                      <span><strong>Oznámení</strong> – stručné zprávy o změnách v projektu (název, projekt, odkaz)</span></label>
                    {d.notify && (
                      <div className="hub-events">
                        {(Object.keys(EVENT_LABEL) as HubEventType[]).map((t) => (
                          <label key={t} className="notify-check"><input type="checkbox" checked={d.eventTypes.includes(t)}
                            onChange={(e) => save(d, { eventTypes: e.target.checked ? [...d.eventTypes, t] : d.eventTypes.filter((x) => x !== t) })} data-testid={`hub-event-${t}`} /> {EVENT_LABEL[t]}</label>
                        ))}
                      </div>
                    )}
                    <label className="notify-check"><input type="checkbox" checked={d.interactive} onChange={(e) => save(d, { interactive: e.target.checked })} data-testid="hub-cap-interactive" />
                      <span><strong>Interaktivní</strong> – úkol ze zprávy ({d.provider === 'slack' ? 'akce u zprávy „Vytvořit úkol v ClearSpace“' : 'odpověď na zprávu příkazem /task'}), odpovědi ve vlákně úkolu ↔ komentáře. Jen pro lidi s propojeným účtem a právem upravovat.</span></label>
                    <label className="notify-check"><input type="checkbox" checked={d.intelligence} disabled={!status.intelligenceAvailable && !d.intelligence}
                      onChange={(e) => (e.target.checked ? setPiAsk(d) : save(d, { intelligence: false }))} data-testid="hub-cap-intelligence" />
                      <span><strong>Project Intelligence</strong> – AI smí číst vybranou komunikaci tohoto {d.provider === 'slack' ? 'kanálu' : 'skupiny'}. Výchozí stav vypnuto.{!status.intelligenceAvailable && ' (Na serveru vypnuto.)'}</span></label>
                  </fieldset>
                )}
                {d.lastErrorCode && d.status !== 'active' && <p className="drive-message is-error">Poslední chyba: {d.lastErrorCode}. {d.status === 'removed_bot' ? `Přidejte ${d.provider === 'slack' ? 'aplikaci do kanálu' : 'bota do skupiny'} a propojte znovu.` : d.status === 'revoked' ? 'Nainstalujte Slack aplikaci znovu.' : ''}</p>}
                {status.canManage && (
                  <div className="hub-actions">
                    {d.status === 'active' && <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" disabled={busy} onClick={() => test(d)} data-testid="hub-test">Zkušební zpráva</button>}
                    {d.status !== 'pending' && <button type="button" className="cs-btn cs-btn--danger cs-btn--sm" disabled={busy} onClick={() => remove(d)} data-testid="hub-remove">Odpojit</button>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {piAsk && (
          <div className="hub-confirm" role="alertdialog" aria-labelledby="hub-pi-title" data-testid="hub-pi-confirm">
            <p id="hub-pi-title"><strong>Zapnout Project Intelligence pro {piAsk.label}?</strong></p>
            <ul>
              <li>{PI_SCOPE[piAsk.provider]}</li>
              <li>Zprávy se ukládají v ClearSpace nejvýš 90 dní; úpravy a smazání ve {PROVIDER_NAME[piAsk.provider]}u se propisují. Vypnutím nebo odpojením je AI okamžitě přestane vidět (odpojení je i smaže).</li>
              <li>AI s nimi zachází jako s nedůvěryhodným textem a nikdy podle nich sama nemění úkoly. Odpovědi cituje se zdrojem.</li>
              <li>Ostatní členové kanálu by měli vědět, že komunikaci čte i ClearSpace.</li>
            </ul>
            <div className="hub-actions">
              <button type="button" className="cs-btn cs-btn--primary cs-btn--sm" disabled={busy} data-testid="hub-pi-accept"
                onClick={() => { const d = piAsk; setPiAsk(null); void save(d, { intelligence: true }, true); }}>Rozumím, zapnout</button>
              <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={() => setPiAsk(null)} data-testid="hub-pi-cancel">Zrušit</button>
            </div>
          </div>
        )}

        {status?.canManage && status.audit.length > 0 && (
          <details className="hub-audit" data-testid="hub-audit">
            <summary>Historie změn ({status.audit.length})</summary>
            <ul>{status.audit.map((a, i) => (
              <li key={i}>{new Date(a.at).toLocaleString('cs-CZ')} · {a.actor ?? (a.actorKind === 'service' ? 'ClearSpace' : 'uživatel')} · {AUDIT_LABEL[a.action] ?? a.action}</li>
            ))}</ul>
          </details>
        )}
        {status && !status.canManage && <p className="hub-muted">Propojení spravují vlastník a správci projektu.</p>}
        <p className="hub-muted">Podrobnosti: <Link href="/privacy#komunikace">Ochrana osobních údajů – komunikace projektu</Link>.</p>
      </div>
    </ModalShell>
  );
}
