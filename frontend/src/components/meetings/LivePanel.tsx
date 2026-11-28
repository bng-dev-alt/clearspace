'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button } from '../ui';
import { meetingService, MeetingServiceError, type Meeting } from '../../services/meetingService';
import { browserDeps, LiveCaptureController, type CaptureState, type LiveSnapshot, type SourceMode, type TranscriptionState } from '../../lib/meetings/liveCapture';
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
  off: 'Přepis neběží', connecting: 'Přepis se připojuje', receiving: 'Přepis běží', stalled: 'Přepis čeká', finalizing: 'Ukládám přepis…', done: 'Přepis uložen', error: 'Přepis selhal',
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

interface Props { meeting: Meeting; projectId: string; isOrganizer: boolean; onChanged: (message?: string) => void | Promise<void> }

export default function LivePanel({ meeting, projectId, isOrganizer, onChanged }: Props) {
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [source, setSource] = useState<SourceMode>('mic');
  const [notice, setNotice] = useState(meeting.audio.consentAt !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState<string | null>(null);
  const ctl = useRef<LiveCaptureController | null>(null);
  const tabOk = useMemo(() => canTabAudio(), []);
  const unfinished = !snap && (meeting.live.state === 'live' || meeting.live.state === 'paused' || meeting.live.state === 'stopped');

  useEffect(() => {
    if (!unfinished) return;
    let alive = true;
    void meetingService.livePartial(meeting.id).then((p) => { if (alive) setPartial(p.map((x) => x.text).join(' ').trim() || ''); }).catch(() => undefined);
    return () => { alive = false; };
  }, [unfinished, meeting.id]);

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
      await c.start(source);
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
          <span className="mi-time" data-testid="live-duration" aria-label="Délka">{fmt(s?.elapsedMs ?? meeting.live.ms)}</span>
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

      {(!s || s.capture === 'idle' || s.capture === 'error') && !unfinished && (
        <>
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
          <span className="mi-muted" data-testid="live-source-state">
            {s.source === 'mic+tab' ? (s.tabAudio ? 'Zachycuje se mikrofon + zvuk karty' : 'Zachycuje se jen mikrofon') : 'Zachycuje se jen mikrofon'}
            {s.pendingFlush ? ` · čeká na uložení: ${s.pendingFlush}` : ''}
            {s.reconnects ? ` · obnoveno spojení: ${s.reconnects}×` : ''}
          </span>
        </div>
      )}

      {s?.silent && <p role="status" className="mi-muted" data-testid="live-silent">Už několik sekund neslyšíme žádný zvuk. Je mikrofon zapnutý a ve správném zařízení?</p>}
      {s?.warning && <p role="status" data-testid="live-warning">{s.warning}</p>}
      {(error || s?.error) && <p role="alert" className="mi-error" data-testid="live-error">{error ?? s?.error?.message}</p>}

      {s && (s.finals.length > 0 || s.partial.length > 0) && (
        <div className="mi-card" aria-label="Průběžný přepis" data-testid="live-transcript" style={{ maxHeight: 360, overflow: 'auto' }}>
          {groupBySpeaker(s.finals).map((g, i) => (
            <p key={i} className="mi-seg"><span className="mi-time">{fmt(g.startMs)}</span>{g.speaker && <span className="mi-speaker">{speakerLabel(g.speaker)}</span>}{g.text}</p>
          ))}
          {s.partial.length > 0 && <p className="mi-muted" data-testid="live-partial">{s.partial.map((t) => t.text).join('')}</p>}
        </div>
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
