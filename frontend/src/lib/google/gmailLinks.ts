import type { SupabaseClient } from '@supabase/supabase-js';
import type { GoogleConfig } from './config';
import { GMAIL_TEXT, type GmailKind } from './gmail';
import { dbError, HttpError } from './server';

/** RUN 03: shared route plumbing for one Gmail link (server only). */
export const LINK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The private source of a link -- only for the person who linked it, only while they are a project member, only while
 * the SAME Google account (with Gmail) is connected. Everyone else gets a refusal without any Gmail identifier.
 */
export async function ownSource(db: SupabaseClient, cfg: GoogleConfig, linkId: string): Promise<{ kind: GmailKind; gmailId: string; threadId: string }> {
  if (!LINK_ID_RE.test(linkId)) throw new HttpError(404, 'E-mail nebyl nalezen.', 'not_found');
  const { data, error } = await db.rpc('gmail_link_source', { p_server_secret: cfg.serverSecret, p_link_id: linkId });
  if (error) {
    if (error.code === '42501') throw new HttpError(403, GMAIL_TEXT.not_owner, 'not_owner');
    throw dbError(error);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { kind: GmailKind; gmail_id: string; thread_id: string; same_account: boolean } | undefined;
  if (!row) throw new HttpError(403, GMAIL_TEXT.not_owner, 'not_owner');
  if (!row.same_account) throw new HttpError(409, GMAIL_TEXT.other_account, 'other_account');
  return { kind: row.kind, gmailId: row.gmail_id, threadId: row.thread_id };
}

/** Store refreshed SHARED metadata (owner only; a refusal, e.g. the owner is now a read-only Čtenář, is not an error). */
export async function storeShared(db: SupabaseClient, cfg: GoogleConfig, linkId: string, m: { subject?: string; from?: string; date?: string | null; count?: number; attachments?: number; state: 'ok' | 'trashed' | 'deleted' }): Promise<boolean> {
  const { data, error } = await db.rpc('gmail_link_refresh', {
    p_server_secret: cfg.serverSecret, p_link_id: linkId, p_subject: m.subject ?? null, p_from: m.from ?? null, p_date: m.date ?? null,
    p_count: m.count ?? null, p_attachments: m.attachments ?? null, p_state: m.state,
  });
  return !error && Boolean(data);
}
