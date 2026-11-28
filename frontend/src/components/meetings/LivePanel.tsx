'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import LiveTranscriptView from './LiveTranscriptView';
import { Badge, Button } from '../ui';
import { meetingService, MeetingServiceError, type Meeting } from '../../services/meetingService';
import { browserDeps, listMics, LiveCaptureController, testMic, type CaptureState, type LiveSnapshot, type MicOption, type MicTestResult, type SourceMode, type TranscriptionState } from '../../lib/meetings/liveCapture';
import { supabase } from '../../lib/supabase';
import './meetings.css';

/**
 * RUN 10 – živá porada. Organizátor vybere zdroj zvuku, potvrdí, že účastníky informoval, a spustí přepis. Stav NAHRÁVÁNÍ a stav
 * PŘEPISU se zobrazují zvlášť; nic se nespustí samo a nikdo se do hovoru nepřipojuje. Zvuk se neukládá, ukládá se jen text.
 */
export const LIVE_NOTICE_TEXT =
  'Jako organizátor potvrzuji, že jsem účastníky informoval(a), že se porada přepisuje (zvuk přepíše služba Soniox, text pak může analyzovat Google Gemini), že mám k tomu oprávnění a že přepis zastavím, pokud někdo nesouhlasí. Je to moje prohlášení; samo o sobě nezaručuje splnění právních povinností.';

export const INVITE_NOTICE = 'Upozornění: porada může být přepisována pomocí ClearSpace (Soniox) a analyzována AI. Pokud nesouhlasíte, dejte prosím vědět organizátorovi.';

const CAPTURE_LABEL: Record<CaptureState, string> = {
  idle: 'Nenahrává se', acquiring: 'Získávám přístup ke zvuku…', connecting: 'Připojuji…', live: 'Nahrává se', paused: 'Pozastaveno – zvuk se neodesílá',
  reconnecting: 'Obnovuji spojení…', stopping: 'Ukončuji…', stopped: 'Nahrávání ukončeno', error: 'Chyba',
};
const TRANSCRIPTION_LABEL: Record<TranscriptionState, string> = {
  off: 'Přepis neběží', connecting: 'Přepis se připojuje', receiving: 'Přepis běží', stalled: 'Přepis čeká', finalizing: 'Ukládám přepis…', done: 'Přepis uložen', empty: 'Žádná řeč – nic se neuložilo', cancelled: 'Přepis zrušen', error: 'Přepis selhal',
};

const fmt = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};
const canTabAudio = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices
  && !/iPad|iPhone|Android/i.test(navigator.userAgent);

const MIC_KEY = 'cs.live.mic';
const TEST_TEXT: Record<MicTestResult, string> = {
  ok: 'Mikrofon funguje – zvuk je slyšet.',
  silent: 'Za 5 s jsme neslyšeli žádný zvuk. Zkontrolujte, že je vybraný správný mikrofon, není ztlumený a že do něj mluvíte.',
  mic_denied: 'Prohlížeč nepovolil mikrofon. Povolte ho v nastavení stránky (ikona zámku vedle adresy).',
  mic_missing: 'Nenašli jsme žádný mikrofon. Připojte ho a zkuste to znovu.',
  mic_device_missing: 'Vybraný mikrofon není dostupný. Vyberte jiný.',
};

function Level({ label, value, testId }: { label: string; value: number | null; testId: string }) {
  if (value === null) return null;
  return (
    <label className="mi-row" style={{ gap: 6 }} data-testid={testId}>
      <span className="mi-muted">{label}</span>
      <meter min={0} max={1} low={0.15} optimum={0.5} value={value} aria-label={`Úroveň: ${label}`} style={{ width: 120 }} />
    </label>
  );
}

interface Props { meeting: Meeting; projectId: string; isOrganizer: boolean; onChanged: (message?: string) => void | Promise<void> }

export default function LivePanel({ meeting, projectId, isOrganizer, onChanged }: Props) {
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [source, setSource] = useState<SourceMode>('mic');
  const [notice, setNotice] = useState(meeting.audio.consentAt !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState<string | null>(null);
  const [mics, setMics] = useState<MicOption[]>([]);
  const [micId, setMicId] = useState<string>(() => (typeof window !== 'undefined' ? window.localStorage.getItem(MIC_KEY) ?? '' : ''));
  const [testLevel, setTestLevel] = useState<number | null>(null);
  const [testResult, setTestResult] = useState<MicTestResult | null>(null);
  const [levels, setLevels] = useState<{ mic: number | null; tab: number | null }>({ mic: null, tab: null });
  const [confirmCancel, setConfirmCancel] = useState(false);
  const testStop = useRef<(() => void) | null>(null);
  const ctl = useRef<LiveCaptureController | null>(null);
  const tabOk = useMemo(() => canTabAudio(), []);
  // „stopped“ bez uložených částí (např. po zrušení) není nedokončený přepis – nabídne se nové spuštění
  const candidate = !snap && (meeting.live.state === 'live' || meeting.live.state === 'paused' || meeting.live.state === 'stopped');
  const unfinished = candidate && (meeting.live.state !== 'stopped' || !!partial);

  // seznam mikrofonů (interní, Bluetooth, USB…); obnoví se při připojení / odpojení zařízení
  useEffect(() => {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    const refresh = () => { void listMics().then(setMics); };
    refresh();
    md?.addEventListener?.('devicechange', refresh);
    return () => { md?.removeEventListener?.('devicechange', refresh); testStop.current?.(); };
  }, []);
  const micMissing = micId !== '' && mics.length > 0 && !mics.some((m) => m.deviceId === micId);

  // živé úrovně vstupu během nahrávání (jen čtení analyzátoru v prohlížeči)
  const capturing = snap?.capture === 'live' || snap?.capture === 'reconnecting';
  useEffect(() => {
    if (!capturing) return;
    const h = setInterval(() => { if (ctl.current) setLevels(ctl.current.levels()); }, 150);
    return () => { clearInterval(h); setLevels({ mic: null, tab: null }); };
  }, [capturing]);

  function chooseMic(id: string) {
    setMicId(id);
    setTestResult(null);
    try { if (id) window.localStorage.setItem(MIC_KEY, id); else window.localStorage.removeItem(MIC_KEY); } catch { /* private mode */ }
  }

  async function runTest() {
    if (testStop.current) { testStop.current(); return; }
    setTestResult(null);
    setTestLevel(0);
    const t = await testMic(browserDeps(async () => ({})), micId || null, setTestLevel);
    testStop.current = t.stop;
    const r = await t.result;
    testStop.current = null;
    setTestLevel(null);
    setTestResult(r);
    void listMics().then(setMics); // po povolení prohlížeč zpřístupní názvy zařízení
  }

  useEffect(() => {
    if (!candidate) return;
    let alive = true;
    void meetingService.livePartial(meeting.id).then((p) => { if (alive) setPartial(p.map((x) => x.text).join(' ').trim() || ''); }).catch(() => undefined);
    return () => { alive = false; };
  }, [candidate, meeting.id]);

  // zavření stránky během nahrávání: varování; při odchodu se mikrofon i sdílení vždy uvolní
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      const c = ctl.current?.snapshot().capture;
      if (c === 'live' || c === 'paused' || c === 'reconnecting') { e.preventDefault(); e.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => { window.removeEventListener('beforeunload', warn); ctl.current?.release(); };
  }, []);

  const api = (action: string, body: Record<string, unknown>) => meetingService.callStt('live', { ...body, action, projectId, meetingId: meeting.id });

  async function start(resume = false) {
    setError(null);
    if (!notice) { setError('Nejdřív potvrďte, že účastníci byli o přepisu informováni.'); return; }
    setBusy(true);
    try {
      if (meeting.audio.consentAt === null) {
        const { error: cErr } = await supabase.rpc('record_audio_consent', { p_meeting: meeting.id });
        if (cErr) throw new MeetingServiceError('consent', 'Prohlášení se nepodařilo uložit.');
      }
      if (resume && meeting.live.segments > 0) {
        // obnova po zavřené kartě: otevřený segment z minula se uzavře (účtuje se nejvýš skutečná doba)
        await api('close', { segment: meeting.live.segments, reason: 'error', audioMs: 18_000_000 }).catch(() => undefined);
      }
      const c = new LiveCaptureController(browserDeps(async (action, body) => {
        try { return await api(action, body); } catch (e) { throw { code: (e as MeetingServiceError).code, message: (e as Error).message }; }
      }), { elapsedMs: meeting.live.ms });
      ctl.current = c;
      c.subscribe(setSnap);
      testStop.current?.();
      await c.start(source, micMissing ? null : micId || null);
      void listMics().then(setMics);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Přepis se nepodařilo spustit.');
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    const c = ctl.current;
    if (!c) return;
    setBusy(true);
    const r = await c.stop();
    setBusy(false);
    if (r.outcome === 'completed') await onChanged('Přepis porady je uložený. Můžete spustit analýzu.');
    else if (r.outcome === 'empty') await onChanged('Nebyla zachycena žádná řeč, přepis se neuložil.');
  }

  async function cancel() {
    const c = ctl.current;
    setConfirmCancel(false);
    if (!c) return;
    setBusy(true);
    const r = await c.cancel();
    setBusy(false);
    if (r === 'cancelled') await onChanged('Přepis byl zrušen a neuložený text zahozen. Porada, pozvaní i událost zůstávají; spotřebovaná doba se započítala.');
  }

  async function finishStored(discard = false) {
    setBusy(true);
    setError(null);
    try {
      const r = await api(discard ? 'discard' : 'complete', {});
      await onChanged(discard ? 'Uložené části přepisu byly zahozeny.' : r.outcome === 'empty' ? 'Uložené části neobsahovaly žádnou řeč.' : 'Přepis porady je uložený.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Operace se nezdařila.');
    } finally {
      setBusy(false);
    }
  }

  const s = snap;
  const live = s && (s.capture === 'live' || s.capture === 'reconnecting');
  const speakerLabel = (sp: string | null) => (sp ? `Mluvčí ${sp}` : '');

  if (!isOrganizer && !s) {
    return (
      <section className="mi-card" aria-label="Živý přepis" data-testid="live-panel">
        <h2>Živý přepis</h2>
        <p className="mi-muted">Přepis porady spouští její organizátor (autor porady nebo vlastník projektu).{meeting.live.state === 'live' ? ' Přepis právě běží.' : ''}</p>
      </section>
    );
  }

  return (
    <section className="mi-card" aria-label="Živý přepis" data-testid="live-panel">
      <div className="mi-row" style={{ justifyContent: 'space-between' }}>
        <h2>Živý přepis</h2>
        <div className="mi-row" aria-live="polite">
          <Badge variant={live ? 'danger' : s?.capture === 'paused' ? 'warning' : 'default'}>
            <span data-testid="live-capture-state">{live ? '● ' : ''}{CAPTURE_LABEL[s?.capture ?? 'idle']}</span>
          </Badge>
          <Badge variant={s?.transcription === 'receiving' ? 'accent' : s?.transcription === 'error' ? 'danger' : 'default'}>
            <span data-testid="live-transcription-state">{TRANSCRIPTION_LABEL[s?.transcription ?? 'off']}</span>
          </Badge>
          {/* RUN 11 (#21): outside a running capture the number is the BILLED total (cancelled captures included), so it says so */}
          {live || s?.capture === 'paused' || s?.capture === 'connecting'
            ? <span className="mi-time" data-testid="live-duration" aria-label="Délka přepisu">{fmt(s?.elapsedMs ?? meeting.live.ms)}</span>
            : (s?.elapsedMs ?? meeting.live.ms) > 0 && <span className="mi-muted" data-testid="live-duration" title="Započítává se do denního limitu přepisu, včetně zrušených přepisů">účtováno celkem {fmt(s?.elapsedMs ?? meeting.live.ms)}</span>}
        </div>
      </div>

      {unfinished && (
        <div className="mi-card" role="status" data-testid="live-recovery">
          <strong>Živý přepis nebyl dokončen</strong>
          <p className="mi-muted">Uložený text zůstává na serveru ({meeting.live.segments} {meeting.live.segments === 1 ? 'část' : 'části'}, {fmt(meeting.live.ms)}). Dokončete přepis, pokračujte v nahrávání, nebo uložené části zahoďte.</p>
          {partial ? <p data-testid="live-recovery-text" style={{ whiteSpace: 'pre-wrap', maxHeight: 160, overflow: 'auto' }}>{partial}</p> : null}
          <div className="mi-row">
            <Button variant="primary" onClick={() => void finishStored(false)} disabled={busy} data-testid="live-recover-complete">Dokončit přepis</Button>
            <Button onClick={() => void start(true)} disabled={busy || !notice} data-testid="live-recover-resume">Pokračovat v nahrávání</Button>
            <Button variant="ghost" onClick={() => void finishStored(true)} disabled={busy} data-testid="live-recover-discard">Zahodit uložené části</Button>
          </div>
        </div>
      )}

      {s?.capture === 'error' && (s.segment !== null || meeting.live.segments > 0) && (
        <div className="mi-row" data-testid="live-error-actions">
          <Button onClick={() => void stop()} disabled={busy} data-testid="live-error-save">Uložit dosavadní přepis</Button>
          <Button variant="ghost" onClick={() => setConfirmCancel(true)} disabled={busy} data-testid="live-error-cancel">Zrušit přepis</Button>
        </div>
      )}

      {(!s || s.capture === 'idle' || s.capture === 'error' || s.capture === 'stopped') && !unfinished && (
        <>
          {/* RUN 11 (O5): officially supported = desktop Chrome / Edge; elsewhere say what to expect before anything starts */}
          {!tabOk && (
            <p className="cs-status cs-status--warning" role="note" data-testid="live-device-note">
              Živý přepis je ověřený v Chrome a Edge na počítači. Na tomto zařízení (telefon, tablet, Safari) může fungovat jen s mikrofonem a bez záruky – pro důležitou poradu použijte počítač. Přehled porad, přepisy a analýzy tu fungují normálně.
            </p>
          )}
          <div className="mi-field" data-testid="live-mic">
            <label htmlFor="live-mic-select" style={{ fontWeight: 600 }}>Mikrofon</label>
            <div className="mi-row">
              <select id="live-mic-select" value={micMissing ? '' : micId} onChange={(e) => chooseMic(e.target.value)} disabled={busy} data-testid="live-mic-select">
                <option value="">Výchozí mikrofon systému</option>
                {mics.map((m) => <option key={m.deviceId} value={m.deviceId}>{m.label}</option>)}
              </select>
              <Button size="sm" onClick={() => void runTest()} disabled={busy} data-testid="live-mic-test">{testLevel !== null ? 'Ukončit test' : 'Otestovat mikrofon'}</Button>
              {testLevel !== null && <Level label="Mikrofon" value={testLevel} testId="live-mic-test-level" />}
            </div>
            <span className="mi-muted">Test je zdarma a probíhá jen v prohlížeči – nic se neodesílá ani neúčtuje.{mics.length === 0 ? ' Názvy mikrofonů prohlížeč ukáže až po povolení (např. testem).' : ''}</span>
            {micMissing && <span role="alert" className="mi-error" data-testid="live-mic-missing">Dříve vybraný mikrofon teď není připojený – použije se výchozí. Vyberte jiný, nebo ho připojte.</span>}
            {testResult && <span role="status" className={testResult === 'ok' ? 'mi-muted' : 'mi-error'} data-testid="live-mic-test-result">{TEST_TEXT[testResult]}</span>}
          </div>
          <fieldset className="mi-field" data-testid="live-source">
            <legend style={{ fontWeight: 600 }}>Zdroj zvuku</legend>
            <label><input type="radio" name="live-src" checked={source === 'mic'} onChange={() => setSource('mic')} data-testid="live-source-mic" /> Jen mikrofon – porada v místnosti, nebo hovor z reproduktoru vedle vás</label>
            <label style={{ opacity: tabOk ? 1 : 0.6 }}>
              <input type="radio" name="live-src" checked={source === 'mic+tab'} onChange={() => setSource('mic+tab')} disabled={!tabOk} data-testid="live-source-tab" /> Mikrofon + zvuk karty s hovorem (Google Meet, Zoom či Teams v prohlížeči)
            </label>
            <span className="mi-muted" data-testid="live-source-help">
              {tabOk
                ? 'U „zvuku karty“ vyberte v dialogu kartu s hovorem a zapněte „Sdílet i zvuk karty“. Použijte sluchátka – jinak se hlas ostatních nahraje dvakrát (z reproduktoru do mikrofonu). Zvuk desktopové aplikace Zoom/Teams prohlížeč nezachytí.'
                : 'Tento prohlížeč neumí zachytit zvuk jiné karty (Safari, iPad, telefon). Zachytí se jen váš mikrofon – ostatní účastníci hovoru jen tehdy, když je mikrofon slyší z reproduktoru.'}
            </span>
          </fieldset>
          {meeting.audio.consentAt === null && (
            <label className="mi-field" style={{ fontWeight: 400 }}>
              <span><input type="checkbox" checked={notice} onChange={(e) => setNotice(e.target.checked)} data-testid="live-notice" /> {LIVE_NOTICE_TEXT}</span>
            </label>
          )}
          <div className="mi-row">
            <Button variant="primary" onClick={() => void start()} disabled={busy || !notice} data-testid="live-start">Spustit přepis</Button>
            <span className="mi-muted">Zvuk se neukládá; ukládá se jen text přepisu. Účtuje se jen doba, kdy přepis běží (pauza = stream se ukončí).</span>
          </div>
        </>
      )}

      {s && (s.capture === 'live' || s.capture === 'paused' || s.capture === 'reconnecting' || s.capture === 'connecting') && (
        <div className="mi-row" data-testid="live-controls">
          {s.capture === 'paused'
            ? <Button variant="primary" onClick={() => void ctl.current?.resume()} disabled={busy} data-testid="live-resume">Pokračovat</Button>
            : <Button onClick={() => void ctl.current?.pause()} disabled={busy || s.capture !== 'live'} data-testid="live-pause">Pozastavit</Button>}
          <Button variant="danger" onClick={() => void stop()} disabled={busy} data-testid="live-stop">Ukončit a uložit přepis</Button>
          <Button variant="ghost" onClick={() => setConfirmCancel(true)} disabled={busy} data-testid="live-cancel">Zrušit přepis</Button>
          <Level label="Mikrofon" value={levels.mic} testId="live-level-mic" />
          {s.source === 'mic+tab' && <Level label="Zvuk karty" value={s.tabAudio ? levels.tab : null} testId="live-level-tab" />}
          <span className="mi-muted" data-testid="live-source-state">
            {s.source === 'mic+tab' ? (s.tabAudio ? 'Zachycuje se mikrofon + zvuk karty' : 'Zachycuje se jen mikrofon') : 'Zachycuje se jen mikrofon'}
            {s.pendingFlush ? ` · čeká na uložení: ${s.pendingFlush}` : ''}
            {s.reconnects ? ` · obnoveno spojení: ${s.reconnects}×` : ''}
          </span>
        </div>
      )}

      {confirmCancel && (
        <div className="mi-card" role="alertdialog" aria-label="Zrušit přepis?" data-testid="live-cancel-confirm">
          <strong>Zrušit přepis?</strong>
          <p className="mi-muted">Stream se hned ukončí a text tohoto přepisu (i dosud uložené části) se zahodí. Porada, pozvaní a událost v kalendáři zůstanou. Spotřebovaná doba přepisu se započítá do limitu.</p>
          <div className="mi-row">
            <Button variant="danger" onClick={() => void cancel()} disabled={busy} data-testid="live-cancel-yes">Ano, zrušit přepis</Button>
            <Button variant="ghost" onClick={() => setConfirmCancel(false)} disabled={busy} data-testid="live-cancel-no">Pokračovat v přepisu</Button>
          </div>
        </div>
      )}

      {s?.silent && <p role="status" className="mi-error" data-testid="live-silent">Už přes 12 s neslyšíme žádný zvuk. Je mikrofon zapnutý, neztlumený a vybraný správný? (Ukazatel úrovně by se měl při řeči hýbat.)</p>}
      {s?.warning && <p role="status" data-testid="live-warning">{s.warning}</p>}
      {(error || s?.error) && <p role="alert" className="mi-error" data-testid="live-error">{error ?? s?.error?.message}</p>}

      {s && (s.finals.length > 0 || s.partial.length > 0) && (
        <LiveTranscriptView groups={groupBySpeaker(s.finals)} partial={s.partial.map((t) => t.text).join('')} speakerLabel={speakerLabel} fmt={fmt}
          status={<>{live ? '● ' : ''}{CAPTURE_LABEL[s.capture ?? 'idle']} · {fmt(s.elapsedMs ?? 0)}</>} />
      )}
    </section>
  );
}

function groupBySpeaker(tokens: { text: string; startMs: number; speaker: string | null }[]) {
  const out: { speaker: string | null; startMs: number; text: string }[] = [];
  for (const t of tokens) {
    const last = out[out.length - 1];
    if (last && last.speaker === t.speaker && t.startMs - last.startMs < 30_000) last.text += t.text;
    else out.push({ speaker: t.speaker, startMs: t.startMs, text: t.text.trimStart() });
  }
  return out;
}
