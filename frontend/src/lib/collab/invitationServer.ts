import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { emailConfig, appBaseUrl } from '../email/config';
import { sendEmail, type SendOutcome } from '../email/send';
import { invitationHtml, invitationSubject, invitationText } from '../email/invitationTemplate';

/** Server side of invitation e-mails (RUN 01B). Runs ONLY in route handlers; never imported by client code. */

export class HttpError extends Error {
  constructor(public readonly status: number, message: string, public readonly code = 'error') { super(message); }
}

/** Signed-in caller from the Bearer token; the returned client acts under that user's RLS. */
export async function authenticateCaller(authorization: string | null): Promise<{ db: SupabaseClient; userId: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (process.env.NEXT_PUBLIC_FORCE_DEMO === '1' || !url || !anon) throw new HttpError(503, 'Pozvánky vyžadují připojenou databázi.', 'unavailable');
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,4096})$/.exec(authorization ?? '');
  if (!m) throw new HttpError(401, 'Přihlaste se prosím.', 'unauthenticated');
  const db = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${m[1]}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await db.auth.getUser(m[1]);
  if (error || !data.user) throw new HttpError(401, 'Přihlášení vypršelo. Přihlaste se prosím znovu.', 'unauthenticated');
  return { db, userId: data.user.id };
}

export function acceptUrl(base: string, token: string): string {
  return `${base}/accept-invite?token=${encodeURIComponent(token)}`;
}

/** Postgres error -> HTTP status (RLS / rate limit / validation) with the database's Czech message. */
export function fromDbError(error: { code?: string; message?: string }): HttpError {
  const status = error.code === '42501' ? 403 : (error.code === 'PT429' || error.code === '54000') ? 429 : error.code === '22023' ? 400 : error.code === '28000' ? 401 : 500;
  return new HttpError(status, status === 500 ? 'Pozvánku se nepodařilo zpracovat.' : (error.message ?? 'Chyba.'), error.code ?? 'db');
}

export interface DeliveryReport {
  status: SendOutcome['status'] | 'not_configured';
  detail?: string;
  errorCode?: string;
}

/**
 * Records the attempt (server-secret RPC), sends, records the outcome. The token is used only to build the
 * link inside the e-mail; it is neither stored nor logged.
 */
export async function deliverInvitation(db: SupabaseClient, invitationId: string, token: string, kind: 'invite' | 'resend'): Promise<DeliveryReport> {
  const cfg = emailConfig();
  if (!cfg.enabled) return { status: 'not_configured', detail: cfg.reason };
  const { data, error } = await db.rpc('email_delivery_start', { p_server_secret: cfg.serverSecret, p_invitation_id: invitationId, p_kind: kind });
  if (error) {
    // e.g. the server secret is not registered in server_trust -> fail closed, link copy still works
    console.warn('[invitations] delivery bookkeeping refused:', error.code);
    return { status: 'failed', detail: 'Odeslání e-mailu není na serveru správně nastavené.' };
  }
  const row = Array.isArray(data) ? data[0] : data;
  const outcome = await sendEmail({
    to: row.recipient,
    subject: invitationSubject({ inviterName: row.inviter_name, projectName: row.project_name, role: row.project_role, acceptUrl: '', expiresAt: row.expires_at }),
    text: invitationText({ inviterName: row.inviter_name, projectName: row.project_name, role: row.project_role, acceptUrl: acceptUrl(cfg.appBaseUrl!, token), expiresAt: row.expires_at }),
    html: invitationHtml({ inviterName: row.inviter_name, projectName: row.project_name, role: row.project_role, acceptUrl: acceptUrl(cfg.appBaseUrl!, token), expiresAt: row.expires_at }),
  }, cfg);
  await db.rpc('email_delivery_finish', {
    p_server_secret: cfg.serverSecret,
    p_delivery_id: row.delivery_id,
    p_status: outcome.status,
    p_transport: outcome.transport,
    p_provider_message_id: outcome.status === 'accepted' ? outcome.messageId : null,
    p_error_code: outcome.status === 'accepted' ? null : outcome.errorCode,
    p_error_detail: outcome.status === 'accepted' ? null : outcome.errorDetail,
  });
  if (outcome.status !== 'accepted') console.warn('[invitations] e-mail not sent:', outcome.errorCode);
  return { status: outcome.status, detail: outcome.status === 'accepted' ? undefined : outcome.errorDetail, errorCode: outcome.status === 'accepted' ? undefined : outcome.errorCode };
}

/** Link for the optional copy fallback: only from APP_BASE_URL (falls back to the caller's own origin in the client). */
export function linkBase(): string | null {
  return appBaseUrl().url ?? null;
}
