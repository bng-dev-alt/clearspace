'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { BellRing, MessageSquare, Send } from 'lucide-react';
import { DriveError } from '../../services/driveService';
import { DEFAULT_PREFERENCES, EVENT_TYPES, notifyService, type NotifyChannel, type NotifyPreferences, type NotifyProvider, type NotifyStatus } from '../../services/notifyService';

/** Outcome of the Slack OAuth round trip (?notify=slack -> complete). */
export const NOTIFY_RETURN_TEXT: Record<string, { kind: 'info' | 'error'; text: string }> = {
  connected: { kind: 'info', text: 'Slack je připojený. Oznámení vám budou chodit do přímých zpráv od aplikace ClearSpace.' },
  denied: { kind: 'error', text: 'Připojení bylo zrušeno – ve Slacku jste přístup nepovolili. Nic se nezměnilo.' },
  expired: { kind: 'error', text: 'Požadavek na připojení vypršel nebo už byl použit. Zkuste to prosím znovu.' },
  unsupported: { kind: 'error', text: 'Tento typ instalace Slacku (Enterprise Grid) není podporovaný.' },
  scope: { kind: 'error', text: 'Slack vrátil jiná oprávnění, než ClearSpace žádal. Z bezpečnostních důvodů se nic neuložilo.' },
  error: { kind: 'error', text: 'Slack se nepodařilo připojit. Zkuste to prosím znovu.' },
  unavailable: { kind: 'error', text: 'Slack neodpověděl včas. Nic se neuložilo – zkuste to prosím znovu.' },
  disabled: { kind: 'error', text: 'Oznámení mimo aplikaci nejsou na tomto serveru zapnutá.' },
};

const PROVIDER_NAME: Record<NotifyProvider, string> = { slack: 'Slack', telegram: 'Telegram' };
/** The Slack completion consumes a single-use state: run it once per page load even when React runs effects twice (dev). */
let slackCompletion: Promise<{ outcome: string }> | null = null;

function stateText(c: NotifyChannel | undefined, provider: NotifyProvider): { text: string; error?: boolean } {
  if (!c || (c.status === 'linking' && !c.linkPending)) return { text: 'Nepřipojeno.' };
  if (c.status === 'linking') return { text: provider === 'telegram' ? 'Čeká na stisk „Start“ v Telegramu.' : 'Připojování probíhá…' };
  if (c.status === 'confirm') return { text: `Nalezen účet: ${c.label ?? 'Telegram'} – potvrďte, že je váš.` };
  if (c.status === 'reconnect') return { text: 'Přístup vypršel nebo byl zrušen. Připojte prosím znovu.', error: true };
  if (c.status === 'blocked') return { text: 'Bot je v Telegramu zablokovaný. Odblokujte ho a připojte znovu.', error: true };
  const where = provider === 'slack' ? `Slack: ${c.label ?? 'workspace'} – přímé zprávy od aplikace ClearSpace` : `Telegram: ${c.label ?? 'chat'}`;
  return { text: `${c.enabled ? 'Aktivní' : 'Pozastaveno'} · ${where}${c.failed7d ? ` · nedoručeno za 7 dní: ${c.failed7d}` : ''}` };
}

/** Settings card "Notifications outside the app": Slack + Telegram channels and what is sent. Same structure as GoogleConnectionCard. */
export default function NotificationChannelsCard({ returnOutcome }: { returnOutcome?: string | null }) {
  const [status, setStatus] = useState<NotifyStatus | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const [tgLink, setTgLink] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<NotifyPreferences>(DEFAULT_PREFERENCES);
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [prefsDirty, setPrefsDirty] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await notifyService.status();
      setStatus(s);
      if (s) setPrefs(s.preferences ?? DEFAULT_PREFERENCES);
      return s;
    } catch (e) {
      setStatus(null);
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Stav oznámení se nepodařilo načíst.' });
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (returnOutcome === 'slack') {
        try {
          const r = await (slackCompletion ??= notifyService.completeSlack());
          if (!cancelled) setMessage(NOTIFY_RETURN_TEXT[r.outcome] ?? NOTIFY_RETURN_TEXT.error);
        } catch (e) {
          if (!cancelled) setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : NOTIFY_RETURN_TEXT.error.text });
        }
      } else if (returnOutcome && NOTIFY_RETURN_TEXT[returnOutcome]) {
        setMessage(NOTIFY_RETURN_TEXT[returnOutcome]);
      }
      if (cancelled) return;
      const s = await load();
      if (s && !cancelled) setProjects(await notifyService.projects());
    })();
    return () => { cancelled = true; if (poll.current) clearInterval(poll.current); };
  }, [returnOutcome, load]);

  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try { await fn(); } catch (e) {
      setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : fallback });
    } finally {
      setBusy(false);
    }
  };

  const stopPolling = () => { if (poll.current) { clearInterval(poll.current); poll.current = null; } };
  const checkTelegram = async (quiet = false) => {
    try {
      const r = await notifyService.telegramCheck();
      if (r.channel?.status === 'confirm' || r.channel?.status === 'active') { stopPolling(); setTgLink(null); await load(); }
      else if (!quiet) setMessage({ kind: 'info', text: 'Zatím nic. Otevřete odkaz v Telegramu, stiskněte „Start“ a zkuste to znovu.' });
    } catch (e) {
      stopPolling();
      if (!quiet) setMessage({ kind: 'error', text: e instanceof DriveError ? e.message : 'Telegram se nepodařilo zkontrolovat.' });
    }
  };
  const linkTelegram = () => run(async () => {
    const r = await notifyService.telegramLink();
    setTgLink(r.url);
    setMessage(null);
    stopPolling();
    let n = 0;
    poll.current = setInterval(() => { n += 1; if (n > 30) stopPolling(); else void checkTelegram(true); }, 4000);
  }, 'Odkaz pro Telegram se nepodařilo vytvořit.');
  const confirmTelegram = (accept: boolean) => run(async () => {
    const r = await notifyService.telegramConfirm(accept);
    setMessage(accept && r.status === 'active'
      ? { kind: 'info', text: 'Telegram je připojený. Do chatu s botem přišla potvrzovací zpráva.' }
      : { kind: 'info', text: 'Propojení bylo zrušeno. Nic se do toho chatu posílat nebude.' });
    await load();
  }, 'Potvrzení se nepodařilo uložit.');
  const test = (p: NotifyProvider) => run(async () => {
    const r = await notifyService.test(p);
    setMessage({ kind: r.outcome === 'sent' ? 'info' : 'error', text: r.message });
    await load();
  }, 'Zkušební zprávu se nepodařilo odeslat.');
  const toggle = (p: NotifyProvider, enabled: boolean) => run(async () => {
    await notifyService.setEnabled(p, enabled);
    setMessage({ kind: 'info', text: enabled ? `${PROVIDER_NAME[p]}: oznámení znovu zapnutá.` : `${PROVIDER_NAME[p]}: oznámení pozastavena (čekající zprávy se zahodily).` });
    await load();
  }, 'Změnu se nepodařilo uložit.');
  const disconnect = (p: NotifyProvider) => {
    if (!confirm(`Odpojit ${PROVIDER_NAME[p]}? ClearSpace do něj přestane posílat oznámení a smaže uložené přístupové údaje. Oznámení v aplikaci (zvonek) zůstávají.`)) return;
    void run(async () => {
      const r = await notifyService.disconnect(p);
      setTgLink(null);
      setMessage({ kind: 'info', text: p === 'slack' && r.shared
        ? 'Slack je odpojený. Aplikace ClearSpace ve vašem workspace zůstává nainstalovaná, protože ji používají další lidé z týmu.'
        : `${PROVIDER_NAME[p]} je odpojený a přístupové údaje jsou smazané.` });
      await load();
    }, 'Kanál se nepodařilo odpojit.');
  };
  const savePrefs = () => run(async () => {
    await notifyService.savePreferences(prefs);
    setPrefsDirty(false);
    setMessage({ kind: 'info', text: 'Nastavení oznámení je uložené (platí i pro zprávy, které ještě čekají na odeslání).' });
  }, 'Nastavení se nepodařilo uložit.');

  if (status === undefined || status === null) {
    // feature off on this server (or not loaded yet): no card at all; a load error still shows its message
    return message ? <section className="settings-card" data-testid="notify-card"><p role="alert" className="drive-message is-error">{message.text}</p></section> : null;
  }
  const ch = (p: NotifyProvider) => status.channels.find((c) => c.provider === p);
  const slack = ch('slack');
  const telegram = ch('telegram');
  const hasChannel = status.channels.some((c) => c.status === 'active');
  const setType = (id: string, on: boolean) => { setPrefs((p) => ({ ...p, eventTypes: on ? [...new Set([...p.eventTypes, id])] : p.eventTypes.filter((t) => t !== id) })); setPrefsDirty(true); };
  const setProject = (id: string, on: boolean) => { setPrefs((p) => ({ ...p, projectIds: on ? [...new Set([...(p.projectIds ?? []), id])] : (p.projectIds ?? []).filter((x) => x !== id) })); setPrefsDirty(true); };

  const actions = (p: NotifyProvider, c: NotifyChannel | undefined) => {
    const active = c?.status === 'active';
    const broken = c?.status === 'reconnect' || c?.status === 'blocked';
    return (
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
        {(!c || c.status === 'linking' || broken) && (
          <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" disabled={busy} data-testid={`${p}-connect`}
            onClick={() => (p === 'slack' ? run(() => notifyService.connectSlack(), 'Připojení se nepodařilo zahájit.') : linkTelegram())}>
            {broken ? 'Připojit znovu' : `Připojit ${PROVIDER_NAME[p]}`}
          </button>
        )}
        {p === 'telegram' && c?.status === 'confirm' && (<>
          <button type="button" className="cs-btn cs-btn--primary cs-btn--sm" disabled={busy} onClick={() => confirmTelegram(true)} data-testid="telegram-confirm">Ano, je to můj účet</button>
          <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" disabled={busy} onClick={() => confirmTelegram(false)} data-testid="telegram-reject">Ne, zrušit</button>
        </>)}
        {active && (<>
          <button type="button" className="cs-btn cs-btn--secondary cs-btn--sm" disabled={busy || !c.enabled} onClick={() => test(p)} data-testid={`${p}-test`}>Zkušební zpráva</button>
          <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" disabled={busy} onClick={() => toggle(p, !c.enabled)} data-testid={`${p}-toggle`}>{c.enabled ? 'Pozastavit' : 'Obnovit'}</button>
        </>)}
        {c && c.status !== 'linking' && (
          <button type="button" className="cs-btn cs-btn--danger cs-btn--sm" disabled={busy} onClick={() => disconnect(p)} data-testid={`${p}-disconnect`}>Odpojit</button>
        )}
      </div>
    );
  };

  return (
    <section className="settings-card" data-testid="notify-card" aria-labelledby="notify-card-title">
      <h2 id="notify-card-title">
        <BellRing size={18} aria-hidden="true" /> Oznámení mimo aplikaci
        {(status.slack.simulated || status.telegram.simulated) && <span className="cs-badge cs-badge--warning" title="Lokální testovací poskytovatel, ne skutečný Slack / Telegram">simulace</span>}
      </h2>
      <p>Vybraná oznámení vám ClearSpace může posílat i do Slacku nebo Telegramu – vždy jen vám osobně, nikdy do kanálů ani skupin. Oznámení v aplikaci (zvonek) fungují dál beze změny.</p>
      {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={`drive-message${message.kind === 'error' ? ' is-error' : ''}`} data-testid="notify-message">{message.text}</p>}

      <ul className="settings-services">
        {(['slack', 'telegram'] as NotifyProvider[]).map((p) => {
          const c = p === 'slack' ? slack : telegram;
          const st = stateText(c, p);
          const available = p === 'slack' ? status.slack.available : status.telegram.available;
          return (
            <li key={p} className="settings-service" data-testid={`${p}-service`}>
              <div>
                <strong>{p === 'slack' ? <MessageSquare size={13} aria-hidden="true" /> : <Send size={13} aria-hidden="true" />} {PROVIDER_NAME[p]}</strong>
                <p data-testid={`${p}-service-state`} style={st.error ? { color: 'var(--danger)' } : undefined}>
                  {available ? st.text : 'Na tomto serveru není zapnutý.'}
                </p>
                {p === 'telegram' && tgLink && available && (
                  <p data-testid="telegram-link-box">
                    1. Otevřete <a href={tgLink} target="_blank" rel="noopener noreferrer" data-testid="telegram-link">odkaz na bota ClearSpace v Telegramu</a> (platí 10 minut) a stiskněte „Start“.{' '}
                    2. Vraťte se sem – stav se zkontroluje sám, případně{' '}
                    <button type="button" className="cs-btn cs-btn--ghost cs-btn--sm" disabled={busy} onClick={() => void checkTelegram()} data-testid="telegram-check">Zkontrolovat</button>
                  </p>
                )}
              </div>
              {available && actions(p, c)}
            </li>
          );
        })}
      </ul>

      <fieldset className="notify-prefs" data-testid="notify-prefs" disabled={busy}>
        <legend>Co posílat</legend>
        {EVENT_TYPES.map((e) => (
          <label key={e.id} className="notify-check">
            <input type="checkbox" checked={prefs.eventTypes.includes(e.id)} onChange={(ev) => setType(e.id, ev.target.checked)} data-testid={`notify-type-${e.id}`} /> {e.label}
          </label>
        ))}
        <div className="notify-projects" role="radiogroup" aria-label="Projekty">
          <label className="notify-check"><input type="radio" name="notify-projects" checked={prefs.projectIds === null} onChange={() => { setPrefs((p) => ({ ...p, projectIds: null })); setPrefsDirty(true); }} data-testid="notify-projects-all" /> Všechny moje projekty</label>
          <label className="notify-check"><input type="radio" name="notify-projects" checked={prefs.projectIds !== null} onChange={() => { setPrefs((p) => ({ ...p, projectIds: p.projectIds ?? [] })); setPrefsDirty(true); }} data-testid="notify-projects-selected" /> Jen vybrané projekty</label>
          {prefs.projectIds !== null && (
            <div className="notify-project-list" data-testid="notify-project-list">
              {projects.length === 0 ? <p>Žádné projekty.</p> : projects.map((pr) => (
                <label key={pr.id} className="notify-check"><input type="checkbox" checked={prefs.projectIds?.includes(pr.id) ?? false} onChange={(ev) => setProject(pr.id, ev.target.checked)} /> {pr.name}</label>
              ))}
            </div>
          )}
        </div>
        <label className="notify-check"><input type="checkbox" checked={prefs.hideTitles} onChange={(ev) => { setPrefs((p) => ({ ...p, hideTitles: ev.target.checked })); setPrefsDirty(true); }} data-testid="notify-hide-titles" /> Neposílat názvy úkolů a projektů (jen typ oznámení a odkaz)</label>
        <div><button type="button" className="cs-btn cs-btn--primary cs-btn--sm" onClick={savePrefs} disabled={busy || !prefsDirty} data-testid="notify-save">Uložit nastavení</button></div>
        {!hasChannel && <p>Nastavení se použije, jakmile připojíte Slack nebo Telegram.</p>}
      </fieldset>

      <ul data-testid="notify-privacy">
        <li>Zpráva obsahuje jen typ události, kdo ji udělal, název úkolu a projektu, termín a odkaz do ClearSpace. Nikdy text komentářů, popisy, přílohy ani obsah z Google Disku, Gmailu či Kalendáře.</li>
        <li>Před každým odesláním se znovu ověří, že k projektu stále máte přístup; jinak se zpráva nepošle. Připomenutí termínu chodí den předem v 9:00 (čas v Praze).</li>
        <li>Slack a Telegram zprávy ukládají u sebe podle svých pravidel. Přístupové údaje ukládá ClearSpace šifrovaně a po odpojení je smaže.</li>
        <li>Podrobnosti: <Link href="/privacy#notifikace">Ochrana osobních údajů – oznámení mimo aplikaci</Link>.</li>
      </ul>
    </section>
  );
}
