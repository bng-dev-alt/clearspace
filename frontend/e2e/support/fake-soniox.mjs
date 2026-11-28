// Falešný Soniox async STT pro lokální testy (žádná síť ven, žádné kredity, žádný klíč). Spuštění:
//   node e2e/support/fake-soniox.mjs <port>        (nebo import { startFakeSoniox } z testů)
// Chová se podle OVĚŘENÉ dokumentace (docs/intelligence/SONIOX_API_VERIFICATION.md): POST/GET/DELETE /v1/transcriptions,
// GET .../transcript (409 dokud neskončí), DELETE vrací 409 za běhu a 404 když už neexistuje, POST/DELETE /v1/files,
// tokeny jsou části slov s vlastní úvodní mezerou, `speaker` je číselný řetězec, stavy queued|processing|completed|error.
// Řízení z testu: POST /__control {mode, pollsUntilDone, turns, durationMs, fetchAudio}, čtení: GET /__stats.
import http from 'node:http';
import { WebSocketServer } from 'ws';

const KEY = 'fake-soniox-key';

export const DEFAULT_TURNS = [
  { speaker: '1', text: 'Dobrý den, začneme releasem. Rozhodli jsme, že release posuneme na pátek.' },
  { speaker: '2', text: 'Honza připraví migraci databáze do 25. listopadu, to slibuji.' },
  { speaker: '1', text: 'Riziko: dodavatel může zpozdit certifikát.' },
];

/** Tokeny jako v async výstupu: části slov, mezera patří na začátek následujícího tokenu, časy v ms. */
export function tokensFor(turns, startAt = 0, msPerWord = 400) {
  const tokens = [];
  let t = startAt;
  let first = true;
  for (const turn of turns) {
    for (const word of turn.text.split(/\s+/).filter(Boolean)) {
      const parts = word.length >= 9 ? [word.slice(0, 4), word.slice(4)] : [word];
      parts.forEach((p, i) => {
        const dur = Math.floor(msPerWord / parts.length);
        tokens.push({
          text: (i === 0 && !first ? ' ' : '') + p,
          start_ms: t,
          end_ms: t + dur,
          confidence: 0.95,
          speaker: turn.speaker,
          language: 'cs',
        });
        t += dur;
        first = false;
      });
    }
    t += 600; // pauza mezi replikami
  }
  return tokens;
}

export function startFakeSoniox({ port = 0, expectKey = KEY } = {}) {
  const state = {
    mode: 'ok', // ok | create_200_bad_body | create_400 | create_402 | create_429 | create_500 | create_503 | job_error | job_failed_status | empty | status_500 | status_429_once | delete_500
    pollsUntilDone: 1,
    durationMs: 12_000,
    turns: DEFAULT_TURNS,
    fetchAudio: false,
    jobs: new Map(), // id -> { polls, body, deleted }
    files: new Map(),
    calls: [],
    audioFetches: [],
    n: 0,
    flaky: new Set(),
    // RUN 10 real-time: minted single-use keys, opened streams, configs, audio bytes, end-of-audio frames
    tempKeys: new Map(), // key -> { used, maxSessionSec, ref }
    rt: [],
    rtMode: 'ok', // ok | drop_after_first | error_401 | mint_402
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  const err = (res, status, type) => json(res, status, { status_code: status, error_type: type, message: 'provider message that must never reach the app', request_id: 'req-fake' });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const body = (() => { try { return JSON.parse(raw.toString('utf8')); } catch { return null; } })();

    if (url.pathname === '/__control' && req.method === 'POST') {
      // `reset` also restores the default transcript, so a spec that scripted its own turns cannot leak them into the next spec
      if (body?.reset) { state.jobs.clear(); state.files.clear(); state.calls.length = 0; state.audioFetches.length = 0; state.flaky.clear(); state.n = 0; state.turns = DEFAULT_TURNS; }
      for (const k of ['mode', 'pollsUntilDone', 'durationMs', 'turns', 'fetchAudio']) if (body && k in body) state[k] = body[k];
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/__stats') {
      return json(res, 200, {
        calls: state.calls,
        audioFetches: state.audioFetches,
        jobs: [...state.jobs.entries()].map(([id, j]) => ({ id, polls: j.polls, deleted: j.deleted, body: j.body })),
        files: [...state.files.keys()],
      });
    }

    if (url.pathname.startsWith('/__audio/')) {
      // zvuk pro testy podepsaných URL: ok.mp3 = platná hlavička ID3, bad.mp3 = prostý text; podporuje Range
      const full = url.pathname.endsWith('/ok.mp3') ? Buffer.concat([Buffer.from('ID3'), Buffer.alloc(125)]) : Buffer.from('This is not audio. '.repeat(10));
      const range = /bytes=(\d+)-(\d+)?/.exec(req.headers.range ?? '');
      if (range) {
        const a = Number(range[1]); const b = Math.min(full.length - 1, range[2] ? Number(range[2]) : full.length - 1);
        res.writeHead(206, { 'Content-Type': 'audio/mpeg', 'Content-Range': `bytes ${a}-${b}/${full.length}` });
        return res.end(full.subarray(a, b + 1));
      }
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      return res.end(full);
    }
    state.calls.push({ method: req.method, path: url.pathname, auth: req.headers.authorization ? 'present' : 'missing' });
    if (!url.pathname.startsWith('/v1/')) return json(res, 404, { error_type: 'not_found' });
    if (url.pathname === '/v1/auth/temporary-api-key' && req.method === 'POST') {
      if (req.headers.authorization !== `Bearer ${expectKey}`) return err(res, 401, 'unauthenticated');
      if (state.rtMode === 'mint_402') return err(res, 402, 'organization_balance_exhausted');
      if (body?.usage_type !== 'transcribe_websocket' || body?.single_use !== true || !(body?.max_session_duration_seconds >= 1)) return err(res, 400, 'invalid_request');
      const key = `snx_temp_fake${(state.n += 1)}x${Math.random().toString(36).slice(2, 10)}`;
      state.tempKeys.set(key, { used: false, maxSessionSec: body.max_session_duration_seconds, ref: body.client_reference_id ?? null });
      return json(res, 201, { api_key: key, expires_at: new Date(Date.now() + 60_000).toISOString() });
    }
    if (req.headers.authorization !== `Bearer ${expectKey}`) return err(res, 401, 'unauthenticated');

    const path = url.pathname.slice(3); // "/transcriptions..."

    if (path === '/transcriptions' && req.method === 'GET') {
      if (state.mode === 'list_500') return err(res, 500, 'internal_error');
      const limit = Math.min(Number(url.searchParams.get('limit') || 100), 100);
      const start = Number(url.searchParams.get('cursor') || 0);
      const all = [...state.jobs.entries()].filter(([, j]) => !j.deleted).map(([id, j]) => ({ id, status: 'queued', model: j.body.model, client_reference_id: j.body.client_reference_id ?? null }));
      const slice = all.slice(start, start + limit);
      return json(res, 200, { transcriptions: slice, next_page_cursor: start + limit < all.length ? String(start + limit) : null });
    }
    if (path === '/transcriptions' && req.method === 'POST') {
      if (state.mode === 'create_400') return err(res, 400, 'invalid_request');
      if (state.mode === 'create_402') return err(res, 402, 'organization_balance_exhausted');
      if (state.mode === 'create_429') return err(res, 429, 'limit_exceeded');
      if (state.mode === 'create_500') return err(res, 500, 'internal_error');
      if (state.mode === 'create_503') return err(res, 503, 'service_unavailable');
      if (state.mode === 'create_hang') { await new Promise((r) => setTimeout(r, 5000)); return err(res, 504, 'timeout'); } // nothing is created
      if (!body || typeof body.model !== 'string' || (!body.audio_url && !body.file_id) || (body.audio_url && body.file_id)) return err(res, 400, 'invalid_request');
      const id = `tr-${++state.n}`;
      const job = { polls: 0, body, deleted: false, audioStatus: null };
      state.jobs.set(id, job);
      if (state.fetchAudio && body.audio_url) {
        // jako skutečný Soniox: stáhne zvuk z audio_url (podepsaná URL musí fungovat bez dalších hlaviček)
        try {
          const r = await fetch(body.audio_url);
          const buf = Buffer.from(await r.arrayBuffer());
          job.audioStatus = r.status;
          state.audioFetches.push({ status: r.status, bytes: buf.length, head: buf.subarray(0, 4).toString('hex') });
        } catch { job.audioStatus = 0; state.audioFetches.push({ status: 0, bytes: 0, head: '' }); }
      }
      if (state.mode === 'create_lost_response') { req.socket.destroy(); return; } // the job EXISTS, the client never sees the answer
      if (state.mode === 'create_500_created') return err(res, 500, 'internal_error'); // the job EXISTS, the answer is an error
      if (state.mode === 'create_200_bad_body') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"unexpected":"shape"}'); return; } // the job EXISTS, the 2xx answer has no usable id
      return json(res, 201, { id, status: 'queued', model: body.model, created_at: new Date().toISOString(), audio_url: body.audio_url ?? null, file_id: body.file_id ?? null, client_reference_id: body.client_reference_id ?? null, error_type: null, error_message: null });
    }

    let m = /^\/transcriptions\/([^/]+)\/transcript$/.exec(path);
    if (m && req.method === 'GET') {
      const job = state.jobs.get(m[1]);
      if (!job || job.deleted) return err(res, 404, 'transcription_not_found');
      if (job.polls < state.pollsUntilDone || state.mode.startsWith('job_')) return err(res, 409, 'transcription_invalid_state');
      const tokens = state.mode === 'empty' ? [{ text: '<end>', start_ms: 0, end_ms: 0 }] : tokensFor(state.turns);
      return json(res, 200, { id: m[1], text: tokens.map((t) => t.text).join(''), tokens });
    }

    m = /^\/transcriptions\/([^/]+)$/.exec(path);
    if (m && req.method === 'GET') {
      const job = state.jobs.get(m[1]);
      if (!job || job.deleted) return err(res, 404, 'transcription_not_found');
      if (state.mode === 'status_500') return err(res, 500, 'internal_error');
      if (state.mode === 'status_429_once' && !state.flaky.has(m[1])) { state.flaky.add(m[1]); return err(res, 429, 'limit_exceeded'); }
      job.polls += 1;
      const base = { id: m[1], model: job.body.model, created_at: new Date().toISOString(), audio_url: job.body.audio_url ?? null, file_id: null, error_type: null, error_message: null };
      if (state.mode === 'job_error') return json(res, 200, { ...base, status: 'error', error_type: 'invalid_audio_file', error_message: 'unsupported provider text' });
      if (state.mode === 'job_failed_status') return json(res, 200, { ...base, status: 'failed', error_type: null, error_message: null });
      if (job.audioStatus !== null && job.audioStatus !== 200) return json(res, 200, { ...base, status: 'error', error_type: 'invalid_audio_file' });
      if (job.polls <= state.pollsUntilDone) return json(res, 200, { ...base, status: job.polls === 1 ? 'queued' : 'processing' });
      return json(res, 200, { ...base, status: 'completed', audio_duration_ms: state.durationMs });
    }
    if (m && req.method === 'DELETE') {
      const job = state.jobs.get(m[1]);
      if (!job || job.deleted) return err(res, 404, 'transcription_not_found');
      if (state.mode === 'delete_500') return err(res, 500, 'internal_error');
      if (job.polls <= state.pollsUntilDone && !state.mode.startsWith('job_')) return err(res, 409, 'transcription_invalid_state');
      job.deleted = true;
      res.writeHead(204);
      return res.end();
    }

    if (path === '/files' && req.method === 'POST') {
      const id = `file-${++state.n}`;
      state.files.set(id, raw.length);
      return json(res, 201, { id, filename: 'upload', size: raw.length, created_at: new Date().toISOString() });
    }
    m = /^\/files\/([^/]+)$/.exec(path);
    if (m && req.method === 'DELETE') {
      if (!state.files.has(m[1])) return err(res, 404, 'file_not_found');
      state.files.delete(m[1]);
      res.writeHead(204);
      return res.end();
    }
    return err(res, 404, 'not_found');
  });

  // Real-time WebSocket (wss://stt-rt.soniox.com/transcribe-websocket), browser auth via the protocols list.
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('soniox-api-key') ? 'soniox-api-key' : false) });
  server.on('upgrade', (req, socket, head) => {
    if (!(req.url ?? '').startsWith('/transcribe-websocket')) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws, req) => {
    const protos = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((x) => x.trim());
    const key = protos[1];
    const entry = state.tempKeys.get(key);
    const stream = { key: key ? 'present' : 'missing', config: null, bytes: 0, frames: 0, ended: false, closed: false };
    state.rt.push(stream);
    const fail = (code, type) => { ws.send(JSON.stringify({ error_code: code, error_type: type, error_message: 'provider message that must never reach the app' })); ws.close(); };
    if (!entry || entry.used || state.rtMode === 'error_401') return void ws.once('message', () => fail(401, 'unauthenticated'));
    entry.used = true;
    const words = tokensFor(state.turns, 0, 300);
    let i = 0;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString('utf8');
        if (text === '') { // end of audio -> flush everything as final, then finished
          stream.ended = true;
          ws.send(JSON.stringify({ tokens: words.slice(i).map((t) => ({ ...t, is_final: true })), final_audio_proc_ms: 0, total_audio_proc_ms: 0 }));
          i = words.length;
          ws.send(JSON.stringify({ tokens: [], finished: true }));
          return void ws.close();
        }
        try { stream.config = JSON.parse(text); } catch { return fail(400, 'invalid_request'); }
        if (stream.config.api_key) return fail(400, 'invalid_request'); // key belongs in the protocols list, never in the start message
        return;
      }
      stream.bytes += data.length;
      stream.frames += 1;
      if (stream.frames % 4 === 0 && i < words.length) { // every ~1 s: one final + one partial token
        const fin = words[i++];
        const nxt = words[i];
        ws.send(JSON.stringify({ tokens: [{ ...fin, is_final: true }, ...(nxt ? [{ ...nxt, is_final: false }] : [])] }));
      }
      if (state.rtMode === 'drop_after_first' && state.rt.length === 1 && stream.frames === 12) ws.terminate();
    });
    ws.on('close', () => { stream.closed = true; });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const { port: p } = server.address();
      resolve({
        url: `http://127.0.0.1:${p}/v1`,
        wsUrl: `ws://127.0.0.1:${p}/transcribe-websocket`,
        origin: `http://127.0.0.1:${p}`,
        state,
        key: expectKey,
        control: (body) => fetch(`http://127.0.0.1:${p}/__control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        close: () => new Promise((r) => { for (const c of wss.clients) c.terminate(); server.close(() => r()); }),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] || 55591);
  startFakeSoniox({ port }).then((s) => console.log(`fake-soniox on ${s.url} (key ${s.key})`));
}
