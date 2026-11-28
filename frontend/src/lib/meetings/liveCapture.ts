/**
 * RUN 10 – živé snímání porady v prohlížeči (docs/run10/ARCHITECTURE.md §3, AUDIO_CAPTURE.md).
 *
 * Zvuk: mikrofon (getUserMedia) + VOLITELNĚ zvuk sdílené karty s hovorem (getDisplayMedia, jen desktopový Chromium). Obojí se
 * smíchá v AudioContext do jedné mono stopy -> MediaRecorder (webm/opus, 250 ms) -> přímo do Soniox real-time (audio_format auto).
 * Klíč streamu je jednorázový a krátkodobý, vydá ho server až po rezervaci rozpočtu. Finální tokeny se po pár sekundách ukládají
 * na server; neukládá se žádný zvuk.
 *
 * Stav NAHRÁVÁNÍ (zvuk se snímá a posílá) a stav PŘEPISU (poskytovatel vrací text) jsou oddělené: `capture` vs `transcription`.
 * Pauza = stream se ukončí (neplatí se za ticho), pokračování = nový segment s posunem času.
 */

export type CaptureState = 'idle' | 'acquiring' | 'connecting' | 'live' | 'paused' | 'reconnecting' | 'stopping' | 'stopped' | 'error';
export type TranscriptionState = 'off' | 'connecting' | 'receiving' | 'stalled' | 'finalizing' | 'done' | 'empty' | 'cancelled' | 'error';
export type SourceMode = 'mic' | 'mic+tab';

export interface LiveTokenView { text: string; startMs: number; endMs: number; speaker: string | null; final: boolean }

export interface LiveSnapshot {
  capture: CaptureState;
  transcription: TranscriptionState;
  source: SourceMode | null;
  /** Je opravdu zachycen zvuk karty (stopa existuje a neskončila)? Nikdy se netvrdí „celá porada“, když jde jen o mikrofon. */
  tabAudio: boolean;
  segment: number | null;
  /** Délka zachyceného zvuku (ms) za všechny segmenty včetně aktuálního. */
  elapsedMs: number;
  silent: boolean;
  finals: LiveTokenView[];
  partial: LiveTokenView[];
  pendingFlush: number;
  error: { code: string; message: string } | null;
  warning: string | null;
  reconnects: number;
}

/** Čistý přechodový automat – jediné místo, které rozhoduje, co je v kterém stavu dovoleno (testováno bez prohlížeče). */
export type CaptureAction = 'start' | 'pause' | 'resume' | 'stop' | 'cancel';
export function allowed(state: CaptureState, action: CaptureAction): boolean {
  switch (action) {
    case 'start': return state === 'idle' || state === 'error' || state === 'stopped';
    case 'pause': return state === 'live';
    case 'resume': return state === 'paused';
    case 'stop': return state === 'live' || state === 'paused' || state === 'reconnecting' || state === 'connecting' || state === 'error';
    case 'cancel': return state === 'live' || state === 'paused' || state === 'reconnecting' || state === 'connecting' || state === 'error';
  }
}

export const ERROR_TEXT: Record<string, string> = {
  mic_denied: 'Prohlížeč nepovolil mikrofon. Povolte ho v nastavení stránky (ikona zámku vedle adresy) a zkuste to znovu.',
  mic_missing: 'Nenašli jsme žádný mikrofon. Připojte ho a zkuste to znovu.',
  mic_device_missing: 'Vybraný mikrofon není dostupný (odpojený, nebo ho používá jiná aplikace). Vyberte jiný mikrofon a zkuste to znovu.',
  tab_denied: 'Sdílení karty bylo zrušeno. Můžete pokračovat jen s mikrofonem, nebo to zkusit znovu.',
  tab_no_audio: 'Sdílená karta nemá zvuk. Při výběru karty zapněte „Sdílet i zvuk karty“ (Chrome / Edge).',
  tab_unsupported: 'Tento prohlížeč neumí zachytit zvuk jiné karty. Použijte Chrome nebo Edge na počítači, nebo jen mikrofon.',
  recorder_unsupported: 'Tento prohlížeč neumí kódovat zvuk pro živý přepis (WebM/Opus). Použijte aktuální Chrome, Edge nebo Firefox.',
  mic_lost: 'Mikrofon se odpojil (nebo ho převzala jiná aplikace). Stream je ukončený; uložený text zůstává – vyberte mikrofon a spusťte znovu, nebo přepis uložte.',
  provider: 'Služba přepisu spojení ukončila. Uložený text zůstává.',
  network: 'Spojení se službou přepisu se přerušilo a nepodařilo se ho obnovit. Uložený text zůstává.',
};

export interface StartInfo {
  segment: number; offsetMs: number; reservedMs: number; apiKey: string; wsUrl: string; config: Record<string, unknown>;
}

/** Závislosti prohlížeče – v testech se podstrčí falešné. */
export interface CaptureDeps {
  api: (action: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>;
  getDisplayMedia?: (c: DisplayMediaStreamOptions & Record<string, unknown>) => Promise<MediaStream>;
  createAudioContext: () => AudioContext;
  createRecorder: (s: MediaStream, mime: string) => MediaRecorder;
  isTypeSupported: (mime: string) => boolean;
  createSocket: (url: string, protocols: string[]) => WebSocket;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

export const MIME = 'audio/webm;codecs=opus';
const FLUSH_MS = 3000;
const ROLLOVER_LEAD_MS = 30_000;
const MAX_RECONNECTS = 3;
const SILENCE_RMS = 0.004;
const SILENCE_AFTER_MS = 12_000;

export function browserDeps(api: CaptureDeps['api']): CaptureDeps {
  const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
  return {
    api,
    getUserMedia: (c) => {
      if (!md?.getUserMedia) return Promise.reject(Object.assign(new Error('no'), { name: 'NotFoundError' }));
      return md.getUserMedia(c);
    },
    getDisplayMedia: md && 'getDisplayMedia' in md ? (c) => md.getDisplayMedia(c as DisplayMediaStreamOptions) : undefined,
    createAudioContext: () => new AudioContext(),
    createRecorder: (s, mime) => new MediaRecorder(s, { mimeType: mime, audioBitsPerSecond: 32_000 }),
    isTypeSupported: (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m),
    createSocket: (u, p) => new WebSocket(u, p),
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

/** Rozdělí odpověď Soniox na finální / průběžné tokeny; řídicí značky <end>/<fin> zahodí (poučení ze scribe_). */
export function parseSonioxMessage(raw: string): { finals: LiveTokenView[]; partial: LiveTokenView[]; finished: boolean; error: { code: string; message: string } | null } {
  let j: Record<string, unknown>;
  try { j = JSON.parse(raw) as Record<string, unknown>; } catch { return { finals: [], partial: [], finished: false, error: null }; }
  if (j.error_code !== undefined && j.error_code !== null) {
    return { finals: [], partial: [], finished: true, error: { code: String(j.error_code).slice(0, 12), message: String(j.error_type ?? 'provider').slice(0, 60) } };
  }
  const finals: LiveTokenView[] = [];
  const partial: LiveTokenView[] = [];
  for (const t of Array.isArray(j.tokens) ? j.tokens : []) {
    if (typeof t !== 'object' || t === null) continue;
    const o = t as Record<string, unknown>;
    if (typeof o.text !== 'string' || o.text === '' || o.text === '<end>' || o.text === '<fin>') continue;
    const v: LiveTokenView = {
      text: o.text,
      startMs: typeof o.start_ms === 'number' ? o.start_ms : 0,
      endMs: typeof o.end_ms === 'number' ? o.end_ms : 0,
      speaker: typeof o.speaker === 'string' || typeof o.speaker === 'number' ? String(o.speaker) : null,
      final: o.is_final === true,
    };
    (v.final ? finals : partial).push(v);
  }
  return { finals, partial, finished: j.finished === true, error: null };
}

type Listener = (s: LiveSnapshot) => void;

export class LiveCaptureController {
  private s: LiveSnapshot = {
    capture: 'idle', transcription: 'off', source: null, tabAudio: false, segment: null, elapsedMs: 0, silent: false,
    finals: [], partial: [], pendingFlush: 0, error: null, warning: null, reconnects: 0,
  };
  private listeners = new Set<Listener>();
  private mic: MediaStream | null = null;
  private tab: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private mixed: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private tabAnalyser: AnalyserNode | null = null;
  private rec: MediaRecorder | null = null;
  private ws: WebSocket | null = null;
  private seg: StartInfo | null = null;
  private segStartedAt = 0;
  private baseMs = 0;
  private seqOf = new Map<number, number>();
  private lastFlushAt = 0;
  private queue: { segment: number; tokens: Record<string, unknown>[] }[] = [];
  private flushing = false;
  private timers: unknown[] = [];
  private rollTimer: unknown = null;
  private quietSince: number | null = null;
  private segmentDone: (() => void) | null = null;
  private closingIntentionally = false;

  constructor(private readonly deps: CaptureDeps, initial?: { elapsedMs?: number }) {
    this.baseMs = initial?.elapsedMs ?? 0;
    this.s.elapsedMs = this.baseMs;
  }

  snapshot(): LiveSnapshot { return this.s; }
  subscribe(fn: Listener): () => void { this.listeners.add(fn); fn(this.s); return () => this.listeners.delete(fn); }
  private set(p: Partial<LiveSnapshot>) { this.s = { ...this.s, ...p }; for (const l of this.listeners) l(this.s); }
  private fail(code: string, extra?: string) {
    this.set({ capture: 'error', transcription: this.s.transcription === 'off' ? 'off' : 'error', error: { code, message: ERROR_TEXT[code] ?? extra ?? 'Přepis se nezdařil.' } });
  }

  /** Spuštění: zdroje -> mix -> první segment. Dvojí klik nic nezdvojí (automat + DB `already_live`). */
  async start(source: SourceMode, deviceId?: string | null): Promise<void> {
    if (!allowed(this.s.capture, 'start')) return;
    this.set({ capture: 'acquiring', source, error: null, warning: null });
    if (!this.deps.isTypeSupported(MIME)) return this.fail('recorder_unsupported');
    try {
      this.mic = await this.deps.getUserMedia({ audio: micConstraints(deviceId) });
    } catch (e) {
      return this.fail(micErrorCode(e, deviceId));
    }
    if (this.mic.getAudioTracks().length === 0) { this.release(); return this.fail('mic_missing'); }
    if (source === 'mic+tab') {
      if (!this.deps.getDisplayMedia) { this.release(); return this.fail('tab_unsupported'); }
      try {
        this.tab = await this.deps.getDisplayMedia({
          video: true, audio: { suppressLocalAudioPlayback: false } as MediaTrackConstraints, systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
        });
      } catch {
        this.release();
        return this.fail('tab_denied');
      }
      if (this.tab.getAudioTracks().length === 0) { this.release(); return this.fail('tab_no_audio'); }
      for (const v of this.tab.getVideoTracks()) v.stop(); // jen zvuk; video se nezpracovává
    }
    this.buildMix();
    this.watchTracks();
    await this.openSegment();
  }

  private buildMix() {
    const ctx = this.deps.createAudioContext();
    this.ctx = ctx;
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    // každý zdroj má vlastní analyzátor -> samostatná úroveň mikrofonu a zvuku karty (jen pro zobrazení, nic se neposílá)
    const tap = (st: MediaStream | null): AnalyserNode | null => {
      if (!st || st.getAudioTracks().length === 0) return null;
      const src = ctx.createMediaStreamSource(st); // video stopy karty jsou už zastavené
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      src.connect(dest);
      src.connect(a);
      return a;
    };
    this.analyser = tap(this.mic);
    this.tabAnalyser = tap(this.tab);
    this.mixed = dest.stream;
    this.set({ tabAudio: Boolean(this.tab?.getAudioTracks().some((t) => t.readyState === 'live')) });
    this.tick();
  }

  private watchTracks() {
    for (const t of this.mic?.getAudioTracks() ?? []) {
      t.addEventListener('ended', () => {
        if (this.s.capture === 'live' || this.s.capture === 'reconnecting') void this.endSegment('error').then(() => this.fail('mic_lost'));
      });
    }
    for (const t of this.tab?.getAudioTracks() ?? []) {
      t.addEventListener('ended', () => this.set({ tabAudio: false, warning: 'Sdílení zvuku karty skončilo – dál se zachycuje jen váš mikrofon (ostatní účastníci nemusí být slyšet).' }));
    }
  }

  /** Sekundový takt: délka, detekce ticha, plánované odeslání. */
  private tick() {
    const h = this.deps.setTimer(() => {
      if (this.s.capture === 'stopped' || this.s.capture === 'idle') return;
      if (this.s.capture === 'live' && this.seg) this.set({ elapsedMs: this.baseMs + (this.deps.now() - this.segStartedAt) });
      if (this.analyser && this.s.capture === 'live') {
        const rms = Math.max(rmsOf(this.analyser), this.tabAnalyser ? rmsOf(this.tabAnalyser) : 0);
        const now = this.deps.now();
        if (rms < SILENCE_RMS) this.quietSince ??= now; else this.quietSince = null;
        const silent = this.quietSince !== null && now - this.quietSince > SILENCE_AFTER_MS;
        if (silent !== this.s.silent) this.set({ silent });
      }
      void this.flush();
      this.tick();
    }, 1000);
    this.timers.push(h);
  }

  private async openSegment(isReconnect = false): Promise<void> {
    this.set({ capture: isReconnect ? 'reconnecting' : 'connecting', transcription: 'connecting' });
    let info: StartInfo;
    try {
      info = (await this.deps.api('start', {})) as unknown as StartInfo;
    } catch (e) {
      const err = e as { code?: string; message?: string };
      this.release();
      this.set({ capture: 'error', transcription: 'error', error: { code: err.code ?? 'start', message: err.message ?? 'Přepis se nepodařilo spustit.' } });
      return;
    }
    this.seg = info;
    this.baseMs = info.offsetMs;
    this.closingIntentionally = false;
    const ws = this.deps.createSocket(info.wsUrl, ['soniox-api-key', info.apiKey]);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify(info.config));
      const rec = this.deps.createRecorder(this.mixed as MediaStream, MIME);
      this.rec = rec;
      rec.ondataavailable = (ev) => { if (ev.data.size > 0 && ws.readyState === 1) ws.send(ev.data); };
      rec.start(250);
      this.segStartedAt = this.deps.now();
      this.set({ capture: 'live', transcription: 'receiving', segment: info.segment, error: null });
      // před koncem rezervace navázat další segment (poskytovatel stream po rezervaci ukončí)
      this.rollTimer = this.deps.setTimer(() => { void this.rollover(); }, Math.max(60_000, info.reservedMs - ROLLOVER_LEAD_MS));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const m = parseSonioxMessage(ev.data);
      if (m.finals.length) {
        const off = this.baseMs;
        const shifted = m.finals.map((t) => ({ ...t, startMs: t.startMs + off, endMs: t.endMs + off }));
        this.queue.push({ segment: info.segment, tokens: m.finals.map((t) => ({ text: t.text, start_ms: t.startMs, end_ms: t.endMs, ...(t.speaker ? { speaker: t.speaker } : {}) })) });
        this.set({ finals: [...this.s.finals, ...shifted].slice(-4000), pendingFlush: this.queue.length });
      }
      this.set({ partial: m.partial.map((t) => ({ ...t, startMs: t.startMs + this.baseMs, endMs: t.endMs + this.baseMs })) });
      if (m.error) this.set({ warning: `Služba přepisu vrátila chybu (${m.error.code}).` });
      if (m.finished) { this.segmentDone?.(); this.segmentDone = null; }
    };
    ws.onclose = () => {
      this.segmentDone?.();
      this.segmentDone = null;
      if (this.closingIntentionally || this.ws !== ws) return;
      void this.recover();
    };
  }

  /** Neočekávaný pád spojení: uzavřít segment (účtuje se jen skutečná délka), zkusit nový – max. 3×, pak chyba. Mezera se v přepisu vyznačí. */
  private async recover() {
    if (this.s.capture !== 'live') return;
    await this.endSegment('error', false);
    if (this.s.reconnects >= MAX_RECONNECTS) { await this.flush(true); return this.fail('network'); }
    this.set({ reconnects: this.s.reconnects + 1 });
    await new Promise<void>((r) => this.deps.setTimer(r, 1000 * 2 ** (this.s.reconnects - 1)));
    await this.openSegment(true);
  }

  private async rollover() {
    if (this.s.capture !== 'live') return;
    await this.endSegment('paused');
    await this.openSegment(true);
  }

  /** Ukončí aktuální segment: zastaví kodér, pošle prázdný rámec (konec zvuku), počká na `finished`, uloží zbytek, vyúčtuje. */
  private async endSegment(reason: 'paused' | 'stopped' | 'error', graceful = true): Promise<void> {
    const seg = this.seg;
    const ws = this.ws;
    if (this.rollTimer) { this.deps.clearTimer(this.rollTimer); this.rollTimer = null; }
    const segMs = seg ? this.deps.now() - this.segStartedAt : 0;
    if (this.rec && this.rec.state !== 'inactive') this.rec.stop();
    this.rec = null;
    if (ws) {
      this.closingIntentionally = true;
      if (graceful && ws.readyState === 1) {
        await new Promise<void>((resolve) => {
          this.segmentDone = resolve;
          try { ws.send(''); } catch { resolve(); }
          this.deps.setTimer(resolve, 8000);
        });
      }
      try { ws.close(); } catch { /* already closed */ }
    }
    this.ws = null;
    this.set({ partial: [] });
    await this.flush(true);
    if (seg) {
      this.baseMs = seg.offsetMs + segMs;
      this.seg = null;
      await this.deps.api('close', { segment: seg.segment, audioMs: segMs, reason }).catch(() => undefined); // bez hlášení se účtuje celá rezervace
    }
  }

  /** Odeslání finálních tokenů (každé ~3 s nebo hned při ukončení). Neúspěch = zůstanou ve frontě; seq je idempotentní. */
  async flush(force = false): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    if (!force && this.deps.now() - this.lastFlushAt < FLUSH_MS && this.queue.length < 20) return;
    this.flushing = true;
    this.lastFlushAt = this.deps.now();
    try {
      while (this.queue.length) {
        const segment = this.queue[0].segment;
        let n = 0;
        while (n < this.queue.length && n < 20 && this.queue[n].segment === segment) n += 1;
        const batch = this.queue.slice(0, n);
        const seq = (this.seqOf.get(segment) ?? 0) + 1;
        try {
          await this.deps.api('append', { segment, seq, tokens: batch.flatMap((b) => b.tokens).slice(0, 2000) });
        } catch {
          break; // zkusí se znovu při dalším taktu / ukončení
        }
        this.seqOf.set(segment, seq);
        this.queue.splice(0, n);
      }
    } finally {
      this.flushing = false;
      this.set({ pendingFlush: this.queue.length });
    }
  }

  /** Okamžité úrovně vstupů 0..1 pro ukazatel (mikrofon / sdílená karta zvlášť); null = zdroj se nezachycuje. */
  levels(): { mic: number | null; tab: number | null } {
    return { mic: this.analyser ? levelOf(rmsOf(this.analyser)) : null, tab: this.tabAnalyser ? levelOf(rmsOf(this.tabAnalyser)) : null };
  }

  async pause(): Promise<void> {
    if (!allowed(this.s.capture, 'pause')) return;
    await this.endSegment('paused');
    this.set({ capture: 'paused', transcription: 'off', silent: false });
  }

  async resume(): Promise<void> {
    if (!allowed(this.s.capture, 'resume')) return;
    await this.openSegment();
  }

  /** Konec: segment se ukončí, server z uložených částí vytvoří jednu revizi přepisu. Mikrofon i sdílení se uvolní. */
  async stop(): Promise<{ revision: string | null; outcome: string }> {
    if (!allowed(this.s.capture, 'stop')) return { revision: null, outcome: 'noop' };
    this.set({ capture: 'stopping', transcription: 'finalizing' });
    if (this.seg) await this.endSegment('stopped');
    this.release();
    try {
      const r = await this.deps.api('complete', {});
      const outcome = String(r.outcome ?? 'completed');
      // prázdný přepis se neukládá -> nikdy nehlásit „Přepis uložen“
      this.set({ capture: 'stopped', transcription: outcome === 'completed' ? 'done' : 'empty' });
      return { revision: (r.revision as string | null) ?? null, outcome };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      this.set({ capture: 'stopped', transcription: 'error', error: { code: err.code ?? 'complete', message: err.message ?? 'Přepis se nepodařilo uložit. Zkuste „Dokončit přepis“ znovu.' } });
      return { revision: null, outcome: 'error' };
    }
  }

  /**
   * Zrušení přepisu: stream se hned ukončí (bez čekání na zbytek textu), mikrofon i sdílení se uvolní, neuložené i uložené části
   * TOHOTO přepisu se zahodí. Spotřebovaná doba se vyúčtuje (close se skutečnou délkou). Porada, účastníci a událost zůstávají.
   * Opakované volání nic nezdvojí (automat); když selže zahození na serveru, vrátí 'error' a zbytek lze zahodit znovu.
   */
  async cancel(): Promise<'cancelled' | 'error' | 'noop'> {
    if (!allowed(this.s.capture, 'cancel')) return 'noop';
    this.set({ capture: 'stopping', transcription: 'finalizing' });
    this.queue = [];
    if (this.seg) await this.endSegment('stopped', false);
    this.queue = [];
    this.release();
    try {
      await this.deps.api('discard', {});
    } catch (e) {
      const err = e as { code?: string; message?: string };
      this.set({ capture: 'stopped', transcription: 'error', finals: [], partial: [], pendingFlush: 0,
        error: { code: 'cancel', message: err.message ?? 'Zrušení se nepodařilo dokončit. Zkuste „Zahodit uložené části“ znovu.' } });
      return 'error';
    }
    this.set({ capture: 'stopped', transcription: 'cancelled', finals: [], partial: [], pendingFlush: 0, error: null, warning: null });
    return 'cancelled';
  }

  /** Uvolní mikrofon, sdílení karty, AudioContext a časovače (i při zavření stránky). */
  release(): void {
    for (const h of this.timers) this.deps.clearTimer(h);
    this.timers = [];
    if (this.rollTimer) this.deps.clearTimer(this.rollTimer);
    try { if (this.rec && this.rec.state !== 'inactive') this.rec.stop(); } catch { /* ignore */ }
    for (const st of [this.mic, this.tab]) for (const t of st?.getTracks() ?? []) t.stop();
    this.mic = null;
    this.tab = null;
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.analyser = null;
    this.tabAnalyser = null;
    this.set({ tabAudio: false, silent: false });
  }
}

export function micConstraints(deviceId?: string | null): MediaTrackConstraints {
  return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) };
}

function micErrorCode(e: unknown, deviceId?: string | null): string {
  const n = (e as Error)?.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'mic_denied';
  if (deviceId && (n === 'OverconstrainedError' || n === 'NotFoundError' || n === 'NotReadableError')) return 'mic_device_missing';
  return 'mic_missing';
}

function rmsOf(a: AnalyserNode): number {
  const buf = new Float32Array(a.fftSize);
  a.getFloatTimeDomainData(buf);
  let sum = 0;
  for (const v of buf) sum += v * v;
  return Math.sqrt(sum / buf.length);
}

/** RMS -> 0..1 pro ukazatel (odmocnina, aby byla vidět i tichá řeč; ~0,25 RMS = plná stupnice). */
export const levelOf = (rms: number) => Math.min(1, Math.sqrt(Math.max(0, rms)) * 2);

export interface MicOption { deviceId: string; label: string }

/** Mikrofony, které prohlížeč zpřístupní (interní, Bluetooth, USB…). Názvy jsou známé až po povolení mikrofonu. */
export async function listMics(md: Pick<MediaDevices, 'enumerateDevices'> | undefined = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined): Promise<MicOption[]> {
  if (!md?.enumerateDevices) return [];
  const all = await md.enumerateDevices().catch(() => [] as MediaDeviceInfo[]);
  const mics = all.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return mics.map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Mikrofon ${i + 1}` }));
}

export type MicTestResult = 'ok' | 'silent' | 'mic_denied' | 'mic_missing' | 'mic_device_missing';

/**
 * Bezplatný lokální test mikrofonu: jen getUserMedia + analyzátor v prohlížeči. ŽÁDNÉ volání serveru ani poskytovatele přepisu.
 * onLevel dostává úroveň 0..1 (~10× za s); po `ms` se test sám ukončí a vrátí 'silent', když vstup celou dobu mlčel.
 */
export async function testMic(
  deps: Pick<CaptureDeps, 'getUserMedia' | 'createAudioContext' | 'setTimer' | 'clearTimer'>,
  deviceId: string | null,
  onLevel: (level: number) => void,
  ms = 5000,
): Promise<{ result: Promise<MicTestResult>; stop: () => void }> {
  let stream: MediaStream;
  try {
    stream = await deps.getUserMedia({ audio: micConstraints(deviceId) });
  } catch (e) {
    return { result: Promise.resolve(micErrorCode(e, deviceId) as MicTestResult), stop: () => undefined };
  }
  const ctx = deps.createAudioContext();
  const a = ctx.createAnalyser();
  a.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(a);
  let peak = 0;
  let elapsed = 0;
  let timer: unknown = null;
  let done: (r: MicTestResult) => void = () => undefined;
  const result = new Promise<MicTestResult>((r) => { done = r; });
  const stop = () => {
    if (timer) deps.clearTimer(timer);
    timer = null;
    for (const t of stream.getTracks()) t.stop();
    void ctx.close().catch(() => undefined);
    onLevel(0);
    done(peak >= SILENCE_RMS * 2 ? 'ok' : 'silent');
  };
  const step = () => {
    const rms = rmsOf(a);
    peak = Math.max(peak, rms);
    onLevel(levelOf(rms));
    elapsed += 100;
    if (elapsed >= ms) { stop(); return; }
    timer = deps.setTimer(step, 100);
  };
  timer = deps.setTimer(step, 100);
  return { result, stop };
}
