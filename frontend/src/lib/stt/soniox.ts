/**
 * Server-side klient Soniox async STT (R5). Podle ověřené dokumentace (docs/intelligence/SONIOX_API_VERIFICATION.md):
 *   POST /v1/transcriptions · GET /v1/transcriptions/{id} · GET /v1/transcriptions/{id}/transcript
 *   DELETE /v1/transcriptions/{id} · POST /v1/files (záloha) · DELETE /v1/files/{id}
 * Hlavička `Authorization: Bearer <klíč>`. KLÍČ ZŮSTÁVÁ NA SERVERU: tento modul se nikdy neimportuje z klientského kódu
 * (kontroluje to skript check-production-bundle.sh) a chybové zprávy ani logy ho nikdy neobsahují.
 *
 * Bezpečnost nákladů: vytvoření přepisu (POST) se NIKDY samo neopakuje, každé odeslání stojí peníze. Opakují se jen
 * čtení (GET) a mazání (DELETE) po přechodných chybách. Z chyby poskytovatele se uchová jen její TYP, ne text.
 */

export type SonioxErrorKind = 'config' | 'network' | 'retryable' | 'terminal' | 'budget' | 'not_found' | 'wait';

export class SonioxError extends Error {
  readonly kind: SonioxErrorKind;
  readonly status: number;
  /** Strojově čitelný typ (např. `invalid_audio_file`), slug [a-z0-9_]. Zpráva poskytovatele se neuchovává. */
  readonly errorType: string;
  constructor(kind: SonioxErrorKind, status: number, errorType: string) {
    super(`soniox:${kind}:${status}:${errorType}`);
    this.name = 'SonioxError';
    this.kind = kind;
    this.status = status;
    this.errorType = errorType;
  }
}

export type SonioxStatus = 'queued' | 'processing' | 'completed' | 'error';

export interface SonioxTranscription {
  id: string;
  status: SonioxStatus;
  model: string | null;
  audioDurationMs: number | null;
  errorType: string | null;
}

export interface SonioxConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** Pauza před jediným opakováním čtení/mazání (ms); v testech 0. */
  retryDelayMs: number;
  fetchImpl?: typeof fetch;
}

const HOSTS: Record<string, string> = {
  us: 'https://api.soniox.com/v1',
  eu: 'https://api.eu.soniox.com/v1',
  jp: 'https://api.jp.soniox.com/v1',
  in: 'https://api.in.soniox.com/v1',
};

/** Aktuální async model (2026-11-18). Dřívější `stt-async-v5` je zastaralý (odstranění 2026-12-15), proto není výchozí. */
export const DEFAULT_SONIOX_MODEL = 'stt-async-v6';

/**
 * Konfigurace z prostředí serveru. `SONIOX_BASE_URL` je TESTOVACÍ ŠEV pro lokální falešný server a v produkci se
 * IGNORUJE, takže klíč nikdy neodejde jinam než na hostitele Soniox dané oblasti (`SONIOX_REGION` us|eu|jp|in).
 */
export function sonioxConfigFromEnv(env: Record<string, string | undefined> = process.env): SonioxConfig {
  const apiKey = env.SONIOX_API_KEY?.trim();
  if (!apiKey) throw new SonioxError('config', 0, 'missing_api_key');
  const region = (env.SONIOX_REGION ?? 'us').trim().toLowerCase();
  const override = env.NODE_ENV !== 'production' ? env.SONIOX_BASE_URL?.trim() : undefined;
  const baseUrl = (override || HOSTS[region]) ?? HOSTS.us;
  const model = (env.SONIOX_MODEL ?? DEFAULT_SONIOX_MODEL).trim();
  const timeout = Number.parseInt(env.SONIOX_TIMEOUT_MS ?? '', 10);
  return {
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model: /^[a-z0-9._-]{1,32}$/i.test(model) ? model : DEFAULT_SONIOX_MODEL,
    timeoutMs: Number.isFinite(timeout) && timeout >= 1000 && timeout <= 60_000 ? timeout : 20_000,
    retryDelayMs: 750,
  };
}

/** Zařazení HTTP chyby podle ověřené tabulky (errors.mdx). Větvíme podle `error_type`, ne podle textu. */
export function classifyHttp(status: number, errorType: string): SonioxError {
  const t = /^[a-z0-9_]{1,64}$/.test(errorType) ? errorType : 'unknown';
  if (status === 402) return new SonioxError('budget', status, t === 'unknown' ? 'balance_exhausted' : t);
  if (status === 404) return new SonioxError('not_found', status, t === 'unknown' ? 'not_found' : t);
  if (status === 409) return new SonioxError('wait', status, t === 'unknown' ? 'invalid_state' : t);
  if (status === 408 || status === 429 || status === 500 || status === 503 || status === 502 || status === 504) {
    return new SonioxError('retryable', status, t === 'unknown' ? (status === 429 ? 'limit_exceeded' : 'unavailable') : t);
  }
  return new SonioxError('terminal', status, t); // 400, 401, 403, ostatní
}

export interface CreateTranscriptionInput {
  audioUrl: string;
  languageHints?: string[];
  context?: { general?: { key: string; value: string }[]; terms?: string[] };
  clientReferenceId?: string;
}

const clipStr = (v: string, n: number) => (v.length > n ? v.slice(0, n) : v);

export class SonioxClient {
  constructor(private readonly cfg: SonioxConfig) {}

  get model(): string {
    return this.cfg.model;
  }

  private async raw(method: string, path: string, init: { json?: unknown; form?: FormData } = {}): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.cfg.apiKey}`, Accept: 'application/json' };
      let body: BodyInit | undefined;
      if (init.json !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(init.json);
      } else if (init.form) {
        body = init.form;
      }
      return await (this.cfg.fetchImpl ?? fetch)(`${this.cfg.baseUrl}${path}`, { method, headers, body, signal: ctl.signal });
    } catch {
      throw new SonioxError('network', 0, 'network_error'); // text původní chyby se zahodí (mohl by obsahovat URL)
    } finally {
      clearTimeout(timer);
    }
  }

  private async fail(res: Response): Promise<never> {
    let errorType = 'unknown';
    try {
      const j = (await res.json()) as { error_type?: unknown };
      if (typeof j?.error_type === 'string') errorType = j.error_type;
    } catch {
      /* tělo chyby se nepodařilo přečíst: zůstává "unknown" */
    }
    throw classifyHttp(res.status, errorType);
  }

  /** Jedno opakování po přechodné chybě; jen pro idempotentní operace. */
  private async withRetry<T>(op: () => Promise<T>): Promise<T> {
    try {
      return await op();
    } catch (e) {
      if (e instanceof SonioxError && (e.kind === 'retryable' || e.kind === 'network')) {
        if (this.cfg.retryDelayMs > 0) await new Promise((r) => setTimeout(r, this.cfg.retryDelayMs));
        return op();
      }
      throw e;
    }
  }

  /** Odešle přepis. NEOPAKUJE se (stojí peníze); chybu zpracuje volající. */
  async createTranscription(input: CreateTranscriptionInput): Promise<SonioxTranscription> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      audio_url: input.audioUrl,
      language_hints: input.languageHints?.length ? input.languageHints : ['cs', 'en'],
      enable_speaker_diarization: true,
      enable_language_identification: true,
    };
    if (input.context && ((input.context.general?.length ?? 0) > 0 || (input.context.terms?.length ?? 0) > 0)) {
      body.context = {
        ...(input.context.general?.length ? { general: input.context.general.slice(0, 8).map((g) => ({ key: clipStr(g.key, 60), value: clipStr(g.value, 120) })) } : {}),
        ...(input.context.terms?.length ? { terms: input.context.terms.slice(0, 100).map((t) => clipStr(t, 60)) } : {}),
      };
    }
    if (input.clientReferenceId) body.client_reference_id = clipStr(input.clientReferenceId, 256);
    const res = await this.raw('POST', '/transcriptions', { json: body });
    if (!res.ok) return this.fail(res);
    return parseTranscription(await res.json().catch(() => null));
  }

  async getTranscription(id: string): Promise<SonioxTranscription> {
    return this.withRetry(async () => {
      const res = await this.raw('GET', `/transcriptions/${encodeURIComponent(id)}`);
      if (!res.ok) return this.fail(res);
      return parseTranscription(await res.json().catch(() => null));
    });
  }

  async getTranscript(id: string): Promise<{ tokens: unknown[] }> {
    return this.withRetry(async () => {
      const res = await this.raw('GET', `/transcriptions/${encodeURIComponent(id)}/transcript`);
      if (!res.ok) return this.fail(res);
      const j = (await res.json().catch(() => null)) as { tokens?: unknown } | null;
      return { tokens: Array.isArray(j?.tokens) ? (j?.tokens as unknown[]) : [] };
    });
  }

  /**
   * Výpis úloh (nejnovější i starší, pořadí dokumentace neslibuje): jediná cesta, jak po nejistém POST najít úlohu podle
   * `client_reference_id`. Stránkuje se kurzorem; `nextCursor` null = konec výpisu.
   */
  async listTranscriptions(limit: number, cursor: string | null): Promise<{ items: { id: string; clientReferenceId: string | null; model: string | null; status: SonioxStatus }[]; nextCursor: string | null }> {
    return this.withRetry(async () => {
      const qs = new URLSearchParams({ limit: String(Math.min(Math.max(limit, 1), 100)) });
      if (cursor) qs.set('cursor', cursor);
      const res = await this.raw('GET', `/transcriptions?${qs.toString()}`);
      if (!res.ok) return this.fail(res);
      const j = (await res.json().catch(() => null)) as { transcriptions?: unknown; next_page_cursor?: unknown } | null;
      const items = (Array.isArray(j?.transcriptions) ? (j?.transcriptions as unknown[]) : []).flatMap((t) => {
        if (typeof t !== 'object' || t === null || typeof (t as { id?: unknown }).id !== 'string') return [];
        const o = t as { id: string; client_reference_id?: unknown; model?: unknown; status?: unknown };
        const st = o.status;
        return [{
          id: o.id,
          clientReferenceId: typeof o.client_reference_id === 'string' ? o.client_reference_id : null,
          model: typeof o.model === 'string' ? o.model.slice(0, 64) : null,
          status: (st === 'queued' || st === 'processing' || st === 'completed' ? st : 'error') as SonioxStatus,
        }];
      });
      return { items, nextCursor: typeof j?.next_page_cursor === 'string' && j.next_page_cursor ? j.next_page_cursor : null };
    });
  }

  /** 404 = už smazáno = úspěch. 409 (ještě běží) se vrací jako SonioxError('wait'). */
  async deleteTranscription(id: string): Promise<void> {
    await this.withRetry(async () => {
      const res = await this.raw('DELETE', `/transcriptions/${encodeURIComponent(id)}`);
      if (res.status === 404) return;
      if (!res.ok) return this.fail(res);
    });
  }

  /**
   * RUN 10: krátkodobý klíč pro PŘÍMÝ stream prohlížeče do Soniox real-time (docs/run10/ARCHITECTURE.md §3). Jednorázový
   * (`single_use`), platný 60 s pro otevření streamu a s `max_session_duration_seconds` = rezervace v DB, takže náklady segmentu
   * ohraničuje sám poskytovatel. Dlouhodobý klíč nikdy neopustí server. Vytvoření klíče nic nestojí, přesto se neopakuje.
   */
  async createTemporaryKey(input: { maxSessionSec: number; clientReferenceId: string }): Promise<{ apiKey: string; expiresAt: string }> {
    const res = await this.raw('POST', '/auth/temporary-api-key', {
      json: {
        usage_type: 'transcribe_websocket',
        expires_in_seconds: 60,
        single_use: true,
        max_session_duration_seconds: Math.min(Math.max(Math.floor(input.maxSessionSec), 1), 18_000),
        client_reference_id: clipStr(input.clientReferenceId, 256),
      },
    });
    if (!res.ok) return this.fail(res);
    const j = (await res.json().catch(() => null)) as { api_key?: unknown; expires_at?: unknown } | null;
    if (typeof j?.api_key !== 'string' || !/^snx_temp_[A-Za-z0-9._-]{10,2000}$/.test(j.api_key)) {
      throw new SonioxError('terminal', res.status, 'bad_response');
    }
    return { apiKey: j.api_key, expiresAt: typeof j.expires_at === 'string' ? j.expires_at.slice(0, 40) : '' };
  }

  /** Záložní cesta (audio_url nefunguje): nahrání souboru. Po dokončení je nutné smazat i soubor. */
  async uploadFile(bytes: Uint8Array, filename: string, mime: string, clientReferenceId?: string): Promise<{ id: string }> {
    const form = new FormData();
    form.append('file', new Blob([bytes as BlobPart], { type: mime }), filename);
    if (clientReferenceId) form.append('client_reference_id', clipStr(clientReferenceId, 256));
    const res = await this.raw('POST', '/files', { form });
    if (!res.ok) return this.fail(res);
    const j = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (typeof j?.id !== 'string') throw new SonioxError('terminal', res.status, 'bad_response');
    return { id: j.id };
  }

  async deleteFile(id: string): Promise<void> {
    await this.withRetry(async () => {
      const res = await this.raw('DELETE', `/files/${encodeURIComponent(id)}`);
      if (res.status === 404) return;
      if (!res.ok) return this.fail(res);
    });
  }
}

/** Dokumentace si v názvu chybového stavu protiřečí (`error` vs `failed`): cokoli mimo známé průběžné stavy je selhání. */
export function parseTranscription(j: unknown): SonioxTranscription {
  if (typeof j !== 'object' || j === null || typeof (j as { id?: unknown }).id !== 'string') {
    throw new SonioxError('terminal', 200, 'bad_response');
  }
  const o = j as { id: string; status?: unknown; model?: unknown; audio_duration_ms?: unknown; error_type?: unknown };
  const s = o.status;
  const status: SonioxStatus = s === 'queued' || s === 'processing' || s === 'completed' ? s : 'error';
  const errType = typeof o.error_type === 'string' && /^[a-z0-9_]{1,64}$/.test(o.error_type) ? o.error_type : null;
  return {
    id: o.id,
    status,
    model: typeof o.model === 'string' ? o.model.slice(0, 64) : null,
    audioDurationMs: typeof o.audio_duration_ms === 'number' && Number.isFinite(o.audio_duration_ms) ? Math.max(0, Math.floor(o.audio_duration_ms)) : null,
    errorType: status === 'error' ? (errType ?? (typeof s === 'string' && s !== 'error' ? 'unknown_status' : 'transcription_failed')) : null,
  };
}
