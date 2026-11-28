import { describe, expect, it } from 'vitest';
import { allowed, LiveCaptureController, parseSonioxMessage, type CaptureDeps } from '../../lib/meetings/liveCapture';

/** Falešný prohlížeč: média, kodér, WebSocket a ručně řízené časovače. Žádné skutečné zařízení ani síť. */
function fakeBrowser(opts: { micError?: string; tabAudio?: boolean; noDisplay?: boolean; startError?: { code: string; message: string }; longRun?: boolean } = {}) {
  let closedMs = 0;
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  const sockets: FakeWs[] = [];
  const timers: { fn: () => void; at: number }[] = [];
  let now = 1_000_000;
  const stopped: string[] = [];
  const track = (kind: string, label: string) => {
    const t = { kind, readyState: 'live', listeners: {} as Record<string, () => void>, stop() { this.readyState = 'ended'; stopped.push(label); },
      addEventListener(ev: string, fn: () => void) { this.listeners[ev] = fn; } };
    return t;
  };
  const micTrack = track('audio', 'mic');
  const tabAudioTrack = track('audio', 'tab-audio');
  const tabVideoTrack = track('video', 'tab-video');
  const stream = (tracks: ReturnType<typeof track>[]) => ({
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getTracks: () => tracks,
  }) as unknown as MediaStream;
  class FakeWs {
    readyState = 0;
    sent: unknown[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    constructor(public url: string, public protocols: string[]) { sockets.push(this); }
    send(d: unknown) { this.sent.push(d); if (d === '') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ tokens: [], finished: true }) })); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    drop() { this.readyState = 3; this.onclose?.(); }
    say(tokens: unknown[]) { this.onmessage?.({ data: JSON.stringify({ tokens }) }); }
  }
  let seg = 0;
  const deps: CaptureDeps = {
    api: async (action, body) => {
      calls.push({ action, body });
      if (action === 'start') {
        if (opts.startError) throw opts.startError;
        seg += 1;
        return { segment: seg, offsetMs: opts.longRun ? closedMs : seg === 1 ? 0 : 5000, reservedMs: 600_000, apiKey: `snx_temp_key${seg}`, wsUrl: 'wss://stt-rt.soniox.com/transcribe-websocket', config: { model: 'stt-rt-v6', audio_format: 'auto' } };
      }
      if (action === 'close') closedMs += Number(body.audioMs ?? 0);
      if (action === 'complete') return { outcome: 'completed', revision: 'a'.repeat(64) };
      return { ok: true };
    },
    getUserMedia: async () => { if (opts.micError) throw Object.assign(new Error('x'), { name: opts.micError }); return stream([micTrack]); },
    getDisplayMedia: opts.noDisplay ? undefined : async () => stream(opts.tabAudio === false ? [tabVideoTrack] : [tabAudioTrack, tabVideoTrack]),
    createAudioContext: () => ({
      createMediaStreamDestination: () => ({ channelCount: 2, stream: stream([]) }),
      createAnalyser: () => ({ fftSize: 32, getFloatTimeDomainData: (b: Float32Array) => b.fill(0.2) }),
      createMediaStreamSource: () => ({ connect: () => undefined }),
      close: async () => { stopped.push('ctx'); },
    }) as unknown as AudioContext,
    createRecorder: () => { const r = { state: 'inactive', ondataavailable: null, start() { r.state = 'recording'; }, stop() { r.state = 'inactive'; } }; return r as unknown as MediaRecorder; },
    isTypeSupported: () => true,
    createSocket: (u, p) => new FakeWs(u, p) as unknown as WebSocket,
    now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; },
    clearTimer: (h) => { const i = timers.indexOf(h as { fn: () => void; at: number }); if (i >= 0) timers.splice(i, 1); },
  };
  const advance = async (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.at <= now)) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    await new Promise((r) => setTimeout(r, 0));
  };
  return { deps, calls, sockets, stopped, advance, micTrack, tabAudioTrack, now: () => now };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('capture state machine', () => {
  it('allows only meaningful transitions (double start, pause while paused, resume while live are no-ops)', () => {
    expect(allowed('idle', 'start')).toBe(true);
    expect(allowed('live', 'start')).toBe(false);
    expect(allowed('connecting', 'start')).toBe(false);
    expect(allowed('paused', 'pause')).toBe(false);
    expect(allowed('live', 'resume')).toBe(false);
    expect(allowed('paused', 'resume')).toBe(true);
    expect(allowed('idle', 'stop')).toBe(false);
  });
});

describe('Soniox message parsing (rules from scribe_)', () => {
  it('splits finals from partials and drops <end>/<fin>', () => {
    const m = parseSonioxMessage(JSON.stringify({ tokens: [
      { text: 'Dobrý', is_final: true, start_ms: 0, end_ms: 300, speaker: '1' }, { text: '<end>', is_final: true },
      { text: ' den', is_final: false, start_ms: 300, end_ms: 500, speaker: 1 }] }));
    expect(m.finals.map((t) => t.text)).toEqual(['Dobrý']);
    expect(m.partial).toEqual([{ text: ' den', startMs: 300, endMs: 500, speaker: '1', final: false }]);
  });
  it('reports provider errors without echoing the message text', () => {
    const m = parseSonioxMessage(JSON.stringify({ error_code: 401, error_type: 'unauthenticated', error_message: 'secret detail' }));
    expect(m.error).toEqual({ code: '401', message: 'unauthenticated' });
    expect(JSON.stringify(m)).not.toContain('secret detail');
  });
  it('ignores garbage', () => expect(parseSonioxMessage('not json').finals).toEqual([]));
});

describe('LiveCaptureController', () => {
  it('mic denied -> clear error, nothing booked, no socket', async () => {
    const b = fakeBrowser({ micError: 'NotAllowedError' });
    const c = new LiveCaptureController(b.deps);
    await c.start('mic');
    expect(c.snapshot().capture).toBe('error');
    expect(c.snapshot().error?.code).toBe('mic_denied');
    expect(b.calls).toEqual([]);
    expect(b.sockets).toHaveLength(0);
  });

  it('tab shared WITHOUT audio is refused instead of pretending to capture the remote side', async () => {
    const b = fakeBrowser({ tabAudio: false });
    const c = new LiveCaptureController(b.deps);
    await c.start('mic+tab');
    expect(c.snapshot().error?.code).toBe('tab_no_audio');
    expect(b.stopped).toContain('mic'); // resources released
    expect(b.calls).toEqual([]);
  });

  it('browser without getDisplayMedia (Safari iPad) -> tab mode unsupported, mic mode still possible', async () => {
    const b = fakeBrowser({ noDisplay: true });
    const c = new LiveCaptureController(b.deps);
    await c.start('mic+tab');
    expect(c.snapshot().error?.code).toBe('tab_unsupported');
  });

  it('full flow: key only after booking, config first frame, progressive flush, pause ends the stream, resume = new segment, stop completes', async () => {
    const b = fakeBrowser();
    const c = new LiveCaptureController(b.deps);
    const p = c.start('mic+tab');
    await settle();
    await p;
    expect(b.calls[0].action).toBe('start');
    const ws = b.sockets[0];
    expect(ws.protocols).toEqual(['soniox-api-key', 'snx_temp_key1']);
    ws.open();
    expect(JSON.parse(ws.sent[0] as string).model).toBe('stt-rt-v6');
    expect(c.snapshot().capture).toBe('live');
    expect(c.snapshot().tabAudio).toBe(true);
    expect(b.stopped).toContain('tab-video'); // video of the shared tab is never processed
    // double start is a no-op
    await c.start('mic');
    expect(b.calls.filter((x) => x.action === 'start')).toHaveLength(1);

    ws.say([{ text: 'Ahoj', is_final: true, start_ms: 0, end_ms: 400, speaker: '1' }, { text: ' vš', is_final: false, start_ms: 400, end_ms: 600 }]);
    expect(c.snapshot().finals.map((t) => t.text)).toEqual(['Ahoj']);
    expect(c.snapshot().partial).toHaveLength(1);
    await b.advance(3100);
    const append = b.calls.find((x) => x.action === 'append');
    expect(append?.body).toMatchObject({ segment: 1, seq: 1, tokens: [{ text: 'Ahoj', start_ms: 0, end_ms: 400, speaker: '1' }] });

    await c.pause();
    expect(c.snapshot().capture).toBe('paused');
    expect(ws.sent).toContain(''); // end-of-audio frame -> provider stops billing
    expect(b.calls.find((x) => x.action === 'close')?.body).toMatchObject({ segment: 1, reason: 'paused' });

    const r = c.resume();
    await settle();
    await r;
    const ws2 = b.sockets[1];
    expect(ws2.protocols[1]).toBe('snx_temp_key2');
    ws2.open();
    ws2.say([{ text: 'Znovu', is_final: true, start_ms: 0, end_ms: 300 }]);
    expect(c.snapshot().finals.at(-1)?.startMs).toBe(5000); // shifted by the segment offset

    const done = await c.stop();
    expect(done.outcome).toBe('completed');
    expect(b.calls.filter((x) => x.action === 'append').at(-1)?.body).toMatchObject({ segment: 2, seq: 1 });
    expect(b.calls.at(-1)?.action).toBe('complete');
    expect(b.stopped).toEqual(expect.arrayContaining(['mic', 'tab-audio', 'ctx'])); // everything released
    expect(c.snapshot().capture).toBe('stopped');
  });

  it('unexpected drop -> segment closed, reconnect books a NEW segment (text so far kept); after 3 failures -> error', async () => {
    const b = fakeBrowser();
    const c = new LiveCaptureController(b.deps);
    await c.start('mic');
    b.sockets[0].open();
    b.sockets[0].say([{ text: 'Před', is_final: true, start_ms: 0, end_ms: 200 }]);
    b.sockets[0].drop();
    await settle();
    expect(b.calls.find((x) => x.action === 'close')?.body).toMatchObject({ segment: 1, reason: 'error' });
    expect(b.calls.find((x) => x.action === 'append')?.body).toMatchObject({ segment: 1 }); // flushed before closing
    await b.advance(1000);
    await settle();
    expect(b.sockets).toHaveLength(2);
    b.sockets[1].open();
    expect(c.snapshot().capture).toBe('live');
    expect(c.snapshot().reconnects).toBe(1);
    for (let i = 1; i <= 3; i += 1) {
      b.sockets[i].drop();
      await settle();
      await b.advance(10_000);
      await settle();
      if (b.sockets[i + 1]) b.sockets[i + 1].open();
    }
    expect(c.snapshot().capture).toBe('error');
    expect(c.snapshot().error?.code).toBe('network');
    expect(c.snapshot().finals[0].text).toBe('Před');
  });

  it('a refused start (budget / pilot / not organizer) shows the server message and releases the mic', async () => {
    const b = fakeBrowser({ startError: { code: 'budget_exceeded', message: 'Denní limit minut přepisu je vyčerpaný.' } });
    const c = new LiveCaptureController(b.deps);
    await c.start('mic');
    expect(c.snapshot().error).toEqual({ code: 'budget_exceeded', message: 'Denní limit minut přepisu je vyčerpaný.' });
    expect(b.stopped).toContain('mic');
    expect(b.sockets).toHaveLength(0);
  });

  it('a disconnected microphone stops the stream and says so', async () => {
    const b = fakeBrowser();
    const c = new LiveCaptureController(b.deps);
    await c.start('mic');
    b.sockets[0].open();
    b.micTrack.listeners.ended();
    await settle(); await settle();
    await b.advance(9000);
    await settle();
    expect(c.snapshot().error?.code).toBe('mic_lost');
    expect(b.calls.find((x) => x.action === 'close')?.body).toMatchObject({ reason: 'error' });
  });

  it('when the shared tab stops, it warns that only the microphone is captured', async () => {
    const b = fakeBrowser();
    const c = new LiveCaptureController(b.deps);
    await c.start('mic+tab');
    b.sockets[0].open();
    b.tabAudioTrack.listeners.ended();
    expect(c.snapshot().tabAudio).toBe(false);
    expect(c.snapshot().warning).toMatch(/jen váš mikrofon/);
  });
});

describe('long meeting (deterministic 60 minutes, RUN 10 live acceptance substitute)', () => {
  it('60 min of speech: segments roll over before each 10-min reservation ends, no final token is lost or misplaced, memory stays bounded', async () => {
    const b = fakeBrowser({ longRun: true });
    const c = new LiveCaptureController(b.deps);
    await c.start('mic');
    b.sockets[0].open();
    let word = 0;
    const HOUR = 3_600_000;
    let segStart = b.now();
    let opened = 1;
    while (b.now() - 1_000_000 < HOUR) {
      const ws = b.sockets[b.sockets.length - 1];
      if (ws.readyState === 1) {
        ws.say([{ text: ` w${word}`, is_final: true, start_ms: b.now() - segStart, end_ms: b.now() - segStart + 400, speaker: String(1 + (word % 2)) }]);
        word += 1;
      }
      await b.advance(1000);
      if (b.sockets.length > opened) { // rollover opened a new stream
        await new Promise((r) => setTimeout(r, 0));
        b.sockets[b.sockets.length - 1].open();
        opened = b.sockets.length;
        segStart = b.now();
      }
    }
    const done = await c.stop();
    expect(done.outcome).toBe('completed');
    const starts = b.calls.filter((x) => x.action === 'start').length;
    expect(starts).toBeGreaterThanOrEqual(6);         // 60 min / (10 min - 30 s lead) = 7 streams
    expect(starts).toBeLessThanOrEqual(8);
    const closes = b.calls.filter((x) => x.action === 'close');
    expect(closes).toHaveLength(starts);              // every stream was closed and settled
    expect(closes.every((x) => Number(x.body.audioMs) <= 600_000)).toBe(true); // never beyond its reservation
    const sent = b.calls.filter((x) => x.action === 'append').flatMap((x) => (x.body.tokens as { text: string }[]).map((t) => t.text));
    expect(sent).toHaveLength(word);                  // every final token reached the server exactly once
    expect(sent).toEqual(Array.from({ length: word }, (_, i) => ` w${i}`)); // in order
    const seqs = new Map<number, number[]>();
    for (const x of b.calls.filter((y) => y.action === 'append')) seqs.set(x.body.segment as number, [...(seqs.get(x.body.segment as number) ?? []), x.body.seq as number]);
    for (const list of seqs.values()) expect(list).toEqual(list.map((_, i) => i + 1)); // idempotent seq per stream, no gaps
    expect(c.snapshot().finals.length).toBeLessThanOrEqual(4000); // display buffer bounded
    expect(c.snapshot().pendingFlush).toBe(0);
    expect(c.snapshot().elapsedMs).toBeGreaterThan(HOUR - 120_000);
  }, 60_000);
});
