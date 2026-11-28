'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useConfirm } from '../ui/useConfirm';
import CopyButton from '../ui/CopyButton';
import Link from 'next/link';
import { MessageSquare, Send, Plug } from 'lucide-react';
import { ModalShell, Badge } from '../ui';
import PairingBox from './PairingBox';
import { DriveError } from '../../services/driveService';
import { hasSupabaseConfig } from '../../lib/supabase';
import {
  EVENT_LABEL, hubService, STATUS_LABEL, type HubDestination, type HubEventType, type HubProjectStatus, type HubProvider,
} from '../../services/hubService';

export const ProviderIcon = ({ provider, size = 14 }: { provider: HubProvider; size?: number }) =>
  provider === 'slack' ? <MessageSquare size={size} aria-label="Slack" /> : <Send size={size} aria-label="Telegram" />;

const AUDIT_LABEL: Record<string, string> = {
  link_code_issued: 'vytvořen kód pro propojení', destination_linked: 'kanál / skupina zadala kód', destination_confirmed: 'propojení potvrzeno',
  destination_rejected: 'propojení odmítnuto', destination_configured: 'změna nastavení', destination_removed: 'odpojeno',
  destination_state: 'změna stavu od poskytovatele', task_created_from_chat: 'úkol vytvořen z chatu', destination_reactivated: 'znovu ověřeno a aktivní',
};
/** What Project Intelligence actually sees (RUN 07B: never claim more than the bot receives). */
export const piScope = (d: Pick<HubDestination, 'provider' | 'fullIngest'>) =>
  d.provider === 'slack' ? 'všechny NOVÉ zprávy tohoto kanálu od zapnutí (ne historie, nic jiného z workspace)'
    : d.fullIngest ? 'celá komunikace skupiny od zapnutí – čte ji samostatný PI bot (jen čte, nic nepíše)'
    : 'jen vybrané zprávy: příkazy pro projektového bota a odpovědi na jeho zprávy (ostatní zprávy skupiny bot nevidí)';

interface Props { projectId: string; onClose: () => void }

/** Project → Integrace: Slack channels and Telegram groups bound to this project, their capabilities and the audit trail. */
export default function ProjectIntegrationsModal({ projectId, onClose }: Props) {
  const [ask, confirmDialog] = useConfirm();
  const [status, setStatus] = useState<HubProjectStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [code, setCode] = useState<{ provider: HubProvider; code: string; command: string; openUrl: string; openLabel: string; steps: string[]; until: number; known: string[] } | null>(null);
  const [cooldown, setCooldown] = useState<Record<string, number>>({});        // test message: 1 per 30 s per destination (server rule, now visible)
  const [, setClock] = useState(0);
  useEffect(() => { const t = setInterval(() => setClock((c) => c + 1), 1000); return () => clearInterval(t); }, []);
  const [piAsk, setPiAsk] = useState<{ d: HubDestination; full: boolean } | null>(null);
  // RUN 11 (#2, #8, #9): the destination just confirmed gets a clear success state with its next steps
  const [justLinked, setJustLinked] = useState<string | null>(null);

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
    setCode({ provider, code: r.code, command: r.command, openUrl: r.openUrl, openLabel: r.openLabel, steps: r.steps, until: Date.now() + r.expiresInSeconds * 1000,
      known: (status?.destinations ?? []).map((d) => d.id) });
    setMessage(null);
    await load();
  }, 'Kód se nepodařilo vytvořit.');
  // RUN 08 UX: while a code is open the status refreshes itself; a newly linked channel / group is announced and highlighted for confirmation
  const watch = useCallback(async () => {
    const s = await hubService.project(projectId).catch(() => null);
    if (!s || !code) return;
    setStatus(s);
    const fresh = s.destinations.find((d) => !code.known.includes(d.id) && d.provider === code.provider);
    if (fresh) {
      setCode(null);
      setMessage({ kind: 'info', text: `${fresh.label}: ${fresh.provider === 'slack' ? 'kanál' : 'skupina'} zadal${fresh.provider === 'slack' ? '' : 'a'} kód. Zkontrolujte, kdo ho zadal, a potvrďte propojení níže.` });
    }
  }, [projectId, code]);
  const decide = (d: HubDestination, decision: 'confirm' | 'reject') => run(async () => {
    await hubService.decide(d.id, decision);
    setMessage(decision === 'confirm' ? null : { kind: 'info', text: `${d.label}: propojení odmítnuto.` });
    if (decision === 'confirm') { setCode(null); setJustLinked(d.id); }
    await load();
  }, 'Rozhodnutí se nepodařilo uložit.');
  const save = (d: HubDestination, patch: Partial<Pick<HubDestination, 'notify' | 'interactive' | 'intelligence' | 'eventTypes' | 'fullIngest'>>, ack = false) => run(async () => {
    const next = { ...d, ...patch };
    await hubService.configure(d.id, { notify: next.notify, interactive: next.interactive, intelligence: next.intelligence, intelligenceAck: ack, eventTypes: next.eventTypes,
      fullIngest: next.intelligence && next.fullIngest });
    await load();
  }, 'Nastavení se nepodařilo uložit.');
  const test = (d: HubDestination) => run(async () => {
    setCooldown((c) => ({ ...c, [d.id]: Date.now() + 30_000 }));
    const r = await hubService.test(d.id);
    // RUN 11 (#6): a test message is not a notification – say what was sent and how real notifications behave
    setMessage({ kind: r.outcome === 'sent' ? 'info' : 'error', text: r.outcome === 'sent'
      ? `${r.message} (${new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} – ${d.label}). Jde jen o zkušební zprávu; skutečná oznámení chodí souhrnně nejvýš jednou za minutu podle zapnutých událostí.` : r.message });   // a successful re-check re-activates the destination
    await load();
  }, 'Zkušební zprávu se nepodařilo odeslat.');
  const remove = async (d: HubDestination) => {
    const r0 = await ask({ title: `Odpojit ${d.label}?`, confirmLabel: 'Odpojit', danger: true,
      message: <>ClearSpace sem přestane posílat oznámení, přestane přijímat zprávy a zprávy načtené pro Project Intelligence smaže. Úkoly samotné zůstávají vždy.{d.provider === 'telegram' ? ' Bot ClearSpace pak skupinu sám opustí – pro nové propojení ho bude potřeba znovu přidat.' : ' Aplikace zůstane v kanálu, dokud ji ve Slacku neodeberete.'}</>,
      option: 'Smazat i záznamy zpráv, ze kterých vznikly úkoly, a synchronizované odpovědi (jinak zůstanou jako historie u úkolů)' });
    if (!r0) return;
    const purge = r0.option;
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
      {confirmDialog}
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
          <p className="hub-muted" data-testid="hub-slack-install-hint">Slack: nejdřív nainstalujte aplikaci <strong>ClearSpace Projekty</strong> do svého workspace v <Link href="/settings#projekty">Nastavení → Slack a Telegram pro projekty</Link>.</p>
        )}
        {code && (
          <PairingBox testId="hub-code-box" onTick={watch} onRenew={() => void issue(code.provider)} onClose={() => setCode(null)}
            info={{ title: code.provider === 'slack' ? 'Propojení Slack kanálu' : 'Propojení Telegram skupiny', steps: code.steps, command: code.command,
              openUrl: code.openUrl, openLabel: code.openLabel, until: code.until, waitingText: `Čekám na kód z ${code.provider === 'slack' ? 'kanálu' : 'skupiny'}` }} />
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
                {justLinked === d.id && d.status !== 'pending' && (
                  <div className="hub-linked-ok" role="status" data-testid="hub-linked-ok">
                    <strong>Propojeno ✓ {d.label}</strong>
                    <span>{d.provider === 'slack'
                      ? 'Aby sem ClearSpace mohl psát, musí být aplikace ClearSpace Projekty členem kanálu (v kanálu: /invite @ClearSpace Projekty). Ověříte to zkušební zprávou.'
                      : 'Bot je ve skupině. Zkušební zprávou ověříte, že mu Telegram dovolí psát.'}</span>
                    <div className="hub-actions">
                      <button type="button" className="cs-btn cs-btn--primary cs-btn--sm" disabled={busy} onClick={() => test(d)} data-testid="hub-linked-test">Odeslat zkušební zprávu</button>
                      {!d.interactive && <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" disabled={busy} onClick={() => save(d, { interactive: true })} data-testid="hub-linked-interactive">Zapnout i úkoly z chatu</button>}
                      <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" onClick={() => setJustLinked(null)}>Hotovo</button>
                    </div>
                  </div>
                )}
                {d.status === 'pending' && status.canManage && (
                  <div className="hub-actions">
                    <span data-testid="hub-linked-by">{d.linkedBy ?? 'Někdo'} zadal v {d.provider === 'slack' ? 'kanálu' : 'skupině'} „{d.label}“ kód tohoto projektu. Je to ten správný {d.provider === 'slack' ? 'kanál' : 'chat'}? Propojit?</span>
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
                      <span><strong>Úkoly z chatu (Interaktivní)</strong> – úkol ze zprávy ({d.provider === 'slack' ? 'akce u zprávy „Vytvořit úkol“' : 'příkaz /task s názvem úkolu za ním, volitelně jako odpověď na zprávu'}), odpovědi ve vlákně úkolu ↔ komentáře. Jen pro lidi s propojeným účtem a právem upravovat. Nový kanál ji má vypnutou, dokud ji nezapnete.</span></label>
                    {d.provider === 'telegram' && d.interactive && status.telegramBot && (
                      <div className="hub-command" data-testid="hub-task-command">
                        <code>{`/task@${status.telegramBot} Název úkolu`}</code>
                        <CopyButton text={`/task@${status.telegramBot} `} label="Kopírovat příkaz" ariaLabel="Kopírovat příkaz pro vytvoření úkolu" testId="hub-task-command-copy" />
                      </div>
                    )}
                    {status.intelligenceAvailable ? (
                      <label className="notify-check"><input type="checkbox" checked={d.intelligence}
                        onChange={(e) => (e.target.checked ? setPiAsk({ d, full: false }) : save(d, { intelligence: false, fullIngest: false }))} data-testid="hub-cap-intelligence" />
                        <span><strong>Project Intelligence</strong> – AI smí číst komunikaci {d.provider === 'slack' ? 'tohoto kanálu' : 'této skupiny'}. Výchozí stav vypnuto.
                          {d.intelligence && <><br /><em data-testid="hub-pi-scope">Rozsah: {piScope(d)}.</em></>}</span></label>
                    ) : (
                      // RUN 11 (D10): never a ticked box for something the server does not do
                      <div className="notify-check is-unavailable" data-testid="hub-cap-intelligence-off">
                        <span><strong>Project Intelligence</strong> – na tomto serveru vypnuto: AI komunikaci {d.provider === 'slack' ? 'tohoto kanálu' : 'této skupiny'} nečte.
                          {d.intelligence && <> Pro tento cíl je uložená volba „zapnuto“; začne platit až po zapnutí na serveru. <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" disabled={busy || !status.canManage} onClick={() => save(d, { intelligence: false, fullIngest: false })} data-testid="hub-cap-intelligence-clear">Zrušit uloženou volbu</button></>}</span>
                      </div>
                    )}
                    {d.provider === 'telegram' && d.intelligence && status.telegramPiBot && (
                      <label className="notify-check" style={{ paddingLeft: "1.4rem" }}><input type="checkbox" checked={d.fullIngest}
                        onChange={(e) => (e.target.checked ? setPiAsk({ d, full: true }) : save(d, { fullIngest: false }))} data-testid="hub-cap-full-ingest" />
                        <span><strong>Celá komunikace skupiny</strong> – přidejte do skupiny také PI bota @{status.telegramPiBot} (jen čte, nikdy nepíše).</span></label>
                    )}
                  </fieldset>
                )}
                {d.lastErrorCode && d.status !== 'active' && <p className="drive-message is-error">Poslední chyba: {d.lastErrorCode}. {d.status === 'removed_bot' ? `Přidejte ${d.provider === 'slack' ? 'aplikaci do kanálu' : 'bota do skupiny'} a klikněte na „Ověřit znovu“.` : d.status === 'revoked' ? 'Nainstalujte Slack aplikaci znovu (Nastavení) a klikněte na „Ověřit znovu“.' : ''}</p>}
                {status.canManage && (
                  <div className="hub-actions">
                    {d.status === 'active' && (() => {
                      const wait = Math.max(0, Math.ceil(((cooldown[d.id] ?? 0) - Date.now()) / 1000));
                      return <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" disabled={busy || wait > 0} onClick={() => test(d)} data-testid="hub-test">
                        {wait > 0 ? `Odesláno · znovu za ${wait} s` : 'Zkušební zpráva'}</button>;
                    })()}
                    {['removed_bot', 'archived', 'error', 'revoked'].includes(d.status) && <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" disabled={busy} onClick={() => test(d)} data-testid="hub-recheck">Ověřit znovu</button>}
                    {d.status !== 'pending' && <button type="button" className="cs-btn cs-btn--danger-outline cs-btn--sm" disabled={busy} onClick={() => remove(d)} data-testid="hub-remove">Odpojit</button>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {piAsk && (
          <div className="hub-confirm" role="alertdialog" aria-labelledby="hub-pi-title" data-testid="hub-pi-confirm">
            <p id="hub-pi-title"><strong>{piAsk.full ? 'Zapnout čtení celé komunikace skupiny' : 'Zapnout Project Intelligence'} pro {piAsk.d.label}?</strong></p>
            <ul>
              <li>AI uvidí: {piScope({ provider: piAsk.d.provider, fullIngest: piAsk.full || piAsk.d.fullIngest })}.</li>
              <li>Zprávy se ukládají v ClearSpace nejvýš 90 dní; úpravy se propisují{piAsk.d.provider === 'slack' ? ' i smazání' : ' (Telegram botům mazání neoznamuje)'}. Vypnutím nebo odpojením se načtené zprávy okamžitě smažou.</li>
              <li>AI s nimi zachází jako s nedůvěryhodným textem a nikdy podle nich sama nemění úkoly. Odpovědi cituje se zdrojem.</li>
              <li>Ostatní členové kanálu by měli vědět, že komunikaci čte i ClearSpace.</li>
            </ul>
            <div className="hub-actions">
              <button type="button" className="cs-btn cs-btn--primary cs-btn--sm" disabled={busy} data-testid="hub-pi-accept"
                onClick={() => { const a = piAsk; setPiAsk(null); void save(a.d, a.full ? { intelligence: true, fullIngest: true } : { intelligence: true }, true); }}>Rozumím, zapnout</button>
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
        {!hasSupabaseConfig && <p className="hub-muted" data-testid="hub-demo-note">Ukázka: simulovaná data. Žádné spojení se Slackem ani Telegramem, nic se neodesílá.</p>}
        {hasSupabaseConfig && status && !status.canManage && <p className="hub-muted">Propojení spravují vlastník a správci projektu.</p>}
        <p className="hub-muted">Podrobnosti: <Link href="/privacy#komunikace">Ochrana osobních údajů – komunikace projektu</Link>.</p>
      </div>
    </ModalShell>
  );
}
