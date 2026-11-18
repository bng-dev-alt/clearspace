import { NextRequest, NextResponse } from 'next/server';
import { createClient, SupabaseClient, User } from '@supabase/supabase-js';
import { AiResponse } from '../../services/ai/types';
import { Column } from '../../types/kanban';
import { loadBoard } from './board';
import { buildProjectContext, type ContextPurpose, type ProjectContext } from '../intelligence/context';
import { AiGatewayError, AiProviderError } from './errors';

/**
 * AI gateway -- jediná cesta k Gemini.
 *
 * Každé volání /api/ai/* prochází stejnou řadou kroků:
 *   1. Content-Type + limit velikosti těla
 *   2. ověření identity (Supabase JWT z hlavičky Authorization)
 *   3. validace vstupu (feature.parse)
 *   4. ai_reserve(): oprávnění k projektu + rate limit + denní rozpočet,
 *      ATOMICKY a PŘED voláním providera (viz migrace, sekce 7)
 *   5. kontext projektu se načte NA SERVERU pod identitou volajícího (RLS) --
 *      boardu poslanému klientem se nevěří
 *   6. volání Gemini s modelem a limity určenými serverem
 *   7. ai_complete(): doúčtování skutečné spotřeby / chyby
 *
 * Co to NENÍ: tvrdý strop výdajů. Je to omezení frekvence a odhadovaného
 * rozpočtu tokenů na uživatele plus globální frekvence; skutečný strop musí
 * nastavit kvóta/billing u Google.
 */

export interface AiRunContext<I> {
  input: I;
  /** Board načtený serverem (prázdný, pokud feature projekt nepotřebuje). */
  board: Column[];
  project: { id: string; name: string } | null;
  /** Plný kontext z Project Context Engine (jen u featur s `contextPurpose`, jinak null). */
  context: ProjectContext | null;
}

export interface AiFeature<I> {
  /** Název v ledgeru (ai_requests.feature). */
  name: string;
  /** Feature pracuje s projektem: vyžaduje projectId a členství. */
  needsProject: boolean;
  maxBodyBytes?: number;
  /** Strop výstupních tokenů dané featury (jen pro odhad rezervace). */
  maxOutputTokens: number;
  /** true = odpověď je JSON (parsed), false = čistý text (chat). */
  structured: boolean;
  /** Je-li nastaveno, server sestaví kontext přes Project Context Engine (fakta, zdroje, rámovaný text). */
  contextPurpose?: ContextPurpose;
  parse(body: Record<string, unknown>): I;
  run(ctx: AiRunContext<I>): Promise<AiResponse>;
}

// --- konfigurace (z env, s bezpečnými defaulty) ---

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export function aiLimits() {
  return {
    perMinute: envInt('AI_RATE_PER_USER_PER_MINUTE', 10, 1, 1000),
    globalPerMinute: envInt('AI_RATE_GLOBAL_PER_MINUTE', 60, 1, 100000),
    dailyTokenBudget: envInt('AI_DAILY_TOKEN_BUDGET_PER_USER', 200_000, 1_000, 100_000_000),
  };
}

const DEFAULT_MAX_BODY = 256 * 1024;

// --- kroky ---

async function readJsonBody(req: NextRequest, maxBytes: number): Promise<Record<string, unknown>> {
  const ct = req.headers.get('content-type') || '';
  if (!/^application\/json\b/i.test(ct)) {
    throw new AiGatewayError('unsupported_media_type', 'Požadavek musí mít Content-Type application/json.');
  }
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > maxBytes) {
    throw new AiGatewayError('payload_too_large', 'Požadavek je příliš velký.');
  }
  const text = await req.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new AiGatewayError('payload_too_large', 'Požadavek je příliš velký.');
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AiGatewayError('bad_request', 'Tělo požadavku není platný JSON.');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AiGatewayError('bad_request', 'Tělo požadavku musí být JSON objekt.');
  }
  return body as Record<string, unknown>;
}

interface Authenticated {
  user: User;
  /** Klient s identitou volajícího -- všechny dotazy procházejí RLS. */
  db: SupabaseClient;
}

async function authenticate(req: NextRequest): Promise<Authenticated> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (process.env.NEXT_PUBLIC_FORCE_DEMO === '1' || !url || !anon) {
    throw new AiGatewayError(
      'ai_demo_disabled',
      'AI funkce vyžadují přihlášení přes Supabase a v demo režimu nejsou dostupné.'
    );
  }

  const header = req.headers.get('authorization') || '';
  const match = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,4096})$/.exec(header);
  if (!match) {
    throw new AiGatewayError('unauthenticated', 'Pro použití AI se musíte přihlásit.');
  }
  const token = match[1];

  const db = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) {
    throw new AiGatewayError('unauthenticated', 'Přihlášení vypršelo nebo je neplatné. Přihlaste se prosím znovu.');
  }
  return { user: data.user, db };
}

async function reserve(
  db: SupabaseClient,
  feature: string,
  projectId: string | null,
  reservedTokens: number
): Promise<string> {
  const limits = aiLimits();
  const { data, error } = await db.rpc('ai_reserve', {
    p_feature: feature,
    p_project_id: projectId,
    p_reserved_tokens: reservedTokens,
    p_limit_per_minute: limits.perMinute,
    p_global_limit_per_minute: limits.globalPerMinute,
    p_daily_token_budget: limits.dailyTokenBudget,
  });
  // Fail closed: chybí-li migrace nebo DB neodpovídá, AI se nespustí.
  if (error || !Array.isArray(data) || data.length !== 1) {
    console.error('[ai-gateway] ai_reserve failed', error?.code);
    throw new AiGatewayError('ai_unavailable', 'AI služba je dočasně nedostupná.');
  }
  const row = data[0] as { allowed: boolean; request_id: string | null; reason: string | null };
  if (row.allowed && row.request_id) return row.request_id;

  switch (row.reason) {
    case 'forbidden':
      throw new AiGatewayError('forbidden', 'K tomuto projektu nemáte přístup.');
    case 'budget_exceeded':
      throw new AiGatewayError('budget_exceeded', 'Byl vyčerpán denní rozpočet AI. Zkuste to prosím zítra.');
    case 'global_rate_limited':
      throw new AiGatewayError('ai_unavailable', 'AI služba je teď vytížená. Zkuste to prosím za chvíli.');
    default:
      throw new AiGatewayError('rate_limited', 'Příliš mnoho AI požadavků. Zkuste to prosím za minutu.');
  }
}

async function complete(
  db: SupabaseClient,
  requestId: string,
  status: 'succeeded' | 'failed',
  info: { model?: string; usage?: AiResponse['usage']; errorCode?: string; startedAt: number }
): Promise<void> {
  const { error } = await db.rpc('ai_complete', {
    p_request_id: requestId,
    p_status: status,
    p_model: info.model ?? null,
    p_prompt_tokens: info.usage?.promptTokens ?? 0,
    p_completion_tokens: info.usage?.completionTokens ?? 0,
    p_error_code: info.errorCode ?? null,
    p_duration_ms: Date.now() - info.startedAt,
  });
  // Doúčtování nesmí shodit odpověď; rezervace dál platí jako horní odhad.
  if (error) console.error('[ai-gateway] ai_complete failed', error.code);
}

/** Hrubý odhad znaků, které board přidá do promptu (tituly, popisy, komentáře, checklisty + režie na kartu). */
export function estimateBoardChars(columns: Column[]): number {
  let n = 0;
  for (const col of columns)
    for (const c of col.cards) {
      if (c.archived) continue;
      n += 100 + c.title.length + (c.details?.length ?? 0);
      for (const m of c.comments ?? []) n += m.content.length;
      for (const i of c.checklist ?? []) n += i.text.length;
    }
  return n;
}

function requireProjectId(body: Record<string, unknown>): string {
  const id = body.projectId;
  if (typeof id !== 'string' || id.length === 0 || id.length > 200) {
    throw new AiGatewayError('bad_request', 'Chybí identifikátor projektu.');
  }
  return id;
}

/** Odpověď modelu -> JSON (strukturované featury). Jediná kopie parseru. */
export function parseModelJson(content: string): unknown {
  let text = content.trim();
  const think = text.lastIndexOf('</think>');
  if (think !== -1) text = text.slice(think + 8).trim();
  text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) text = text.slice(first, last + 1);
  try {
    return JSON.parse(text);
  } catch {
    throw new AiGatewayError('bad_model_output', 'AI vrátila neplatný formát dat. Zkuste to prosím znovu.');
  }
}

function errorResponse(err: AiGatewayError): NextResponse {
  const headers: Record<string, string> = { 'Cache-Control': 'no-store' };
  if (err.code === 'rate_limited' || err.code === 'budget_exceeded') headers['Retry-After'] = '60';
  return NextResponse.json({ error: err.message, code: err.code }, { status: err.status, headers });
}

export async function runAi<I>(req: NextRequest, feature: AiFeature<I>): Promise<NextResponse> {
  const startedAt = Date.now();
  let requestId: string | null = null;
  let auth: Authenticated | null = null;

  try {
    const body = await readJsonBody(req, feature.maxBodyBytes ?? DEFAULT_MAX_BODY);
    auth = await authenticate(req);

    const input = feature.parse(body);
    const projectId = feature.needsProject ? requireProjectId(body) : null;

    // Kontext se načte NEJDŘÍV pod identitou volajícího (RLS): nečlen projekt nevidí -> 403 `forbidden`
    // dřív, než se cokoli rezervuje nebo volá provider. Teprve pak se rezervuje kvóta podle SKUTEČNÉ
    // velikosti promptu (tělo + server-načtený kontext), ne jen podle těla požadavku.
    let board: Column[] = [];
    let project: { id: string; name: string } | null = null;
    let context: ProjectContext | null = null;
    let contextChars = 0;
    if (projectId) {
      if (feature.contextPurpose) {
        context = await buildProjectContext(auth.db, projectId, { purpose: feature.contextPurpose });
        board = context.columns;
        project = context.project;
        contextChars = context.rendered.length;
      } else {
        const loaded = await loadBoard(auth.db, projectId);
        board = loaded.columns;
        project = loaded.project;
        contextChars = estimateBoardChars(board);
      }
    }

    // Odhad: ~3 znaky na token vstupu + strop výstupu dané featury.
    const reserved = Math.min(
      1_000_000,
      Math.ceil((JSON.stringify(body).length + contextChars) / 3) + feature.maxOutputTokens
    );
    requestId = await reserve(auth.db, feature.name, projectId, reserved);

    let response: AiResponse;
    try {
      response = await feature.run({ input, board, project, context });
    } catch (err) {
      if (err instanceof AiGatewayError) throw err; // např. prázdný board -> 400
      if (err instanceof AiProviderError) {
        throw new AiGatewayError(err.code, err.message);
      }
      console.error('[ai-gateway] provider call failed', (err as Error)?.name);
      throw new AiGatewayError('ai_failed', 'Služba AI selhala. Zkuste to prosím znovu.');
    }

    const parsed = feature.structured ? parseModelJson(response.content) : undefined;

    await complete(auth.db, requestId, 'succeeded', {
      model: response.model,
      usage: response.usage,
      startedAt,
    });
    requestId = null;

    return NextResponse.json(
      feature.structured ? { ...response, parsed } : { ...response },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    const gw =
      err instanceof AiGatewayError
        ? err
        : new AiGatewayError('ai_failed', 'Služba AI selhala. Zkuste to prosím znovu.');
    if (!(err instanceof AiGatewayError)) console.error('[ai-gateway] unexpected', (err as Error)?.name);
    if (auth && requestId) {
      await complete(auth.db, requestId, 'failed', { errorCode: gw.code, startedAt });
    }
    return errorResponse(gw);
  }
}
