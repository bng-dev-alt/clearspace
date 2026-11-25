import { supabase, hasSupabaseConfig } from '../lib/supabase';
import { api, DriveError } from './driveService';

/**
 * Gmail resources, client side (RUN 03). The browser never receives a Google token for Gmail: search, attach, preview and
 * refresh all run on the server with the caller's own token. Link rows (shared metadata only) are read under RLS.
 */
export type GmailKind = 'message' | 'thread';
/** What linking shares and what stays private -- shown before every attach and in the panel. */
export const GMAIL_PRIVACY_TEXT = 'Členové projektu uvidí jen předmět, odesílatele (jméno, případně jen doménu), datum, počet zpráv a příloh a kdo e-mail připojil. Obsah zpráv, adresy, přílohy a ostatní e-maily zůstávají jen ve vaší schránce – náhled obsahu vidíte jen vy.';
export interface GmailLink {
  id: string;
  projectId: string;
  cardId: string | null;
  kind: GmailKind;
  subject: string;
  from: string | null;
  date: string | null;
  count: number | null;
  attachments: number | null;
  state: 'ok' | 'trashed' | 'deleted';
  linkedBy: string | null;
  linkedByName: string;
  createdAt: string;
  checkedAt: string;
}
export interface GmailItem {
  kind: GmailKind;
  id: string;
  threadId: string;
  subject: string;
  from: { name: string; address: string; domain: string };
  date: string | null;
  messageCount: number;
  snippet: string;
  state: 'ok' | 'trashed';
}
export interface SearchParams { kind: GmailKind; text?: string; from?: string; subject?: string; after?: string; before?: string; pageToken?: string | null }
export interface SearchPage { items: GmailItem[]; nextPageToken: string | null; estimate: number | null }
export interface PreviewMessage {
  from: { name: string; address: string };
  date: string | null;
  subject: string;
  text: string;
  fromHtml: boolean;
  truncated: boolean;
  missing: boolean;
  attachments: { name: string; mimeType: string; size: number | null }[];
}
export interface GmailPreview {
  content: { subject: string; messages: PreviewMessage[]; omittedMessages: number; state: 'ok' | 'trashed'; retrievedAt: string };
  webUrl: string | null;
}
export interface GmailAttachResult {
  links: { id: string; kind: GmailKind; itemId: string; duplicate: boolean }[];
  failed: { kind: GmailKind; itemId: string; reason: string; message: string }[];
}

interface Row {
  id: string; project_id: string; card_id: string | null; provider: string; name: string; email_from: string | null; modified_at: string | null;
  email_count: number | null; email_attachments: number | null; provider_state: GmailLink['state']; linked_by: string | null; linked_by_name: string;
  created_at: string; metadata_checked_at: string;
}
export const mapGmailLink = (r: Row): GmailLink => ({
  id: r.id, projectId: r.project_id, cardId: r.card_id, kind: r.provider === 'gmail_thread' ? 'thread' : 'message', subject: r.name,
  from: r.email_from, date: r.modified_at, count: r.email_count, attachments: r.email_attachments, state: r.provider_state,
  linkedBy: r.linked_by, linkedByName: r.linked_by_name, createdAt: r.created_at, checkedAt: r.metadata_checked_at,
});

export const gmailService = {
  available: hasSupabaseConfig,

  async list(projectId: string, cardId?: string): Promise<GmailLink[]> {
    if (!hasSupabaseConfig) return [];
    let q = supabase.from('external_resource_links')
      .select('id, project_id, card_id, provider, name, email_from, modified_at, email_count, email_attachments, provider_state, linked_by, linked_by_name, created_at, metadata_checked_at')
      .eq('project_id', projectId).in('provider', ['gmail_message', 'gmail_thread']).order('created_at', { ascending: false }).limit(200);
    if (cardId) q = q.eq('card_id', cardId);
    const { data, error } = await q;
    if (error) throw new DriveError('db', 'E-maily se nepodařilo načíst.');
    return (data as Row[]).map(mapGmailLink);
  },

  async myUserId(): Promise<string | null> {
    if (!hasSupabaseConfig) return null;
    const { data } = await supabase.auth.getSession();
    return data.session?.user.id ?? null;
  },

  search(p: SearchParams): Promise<SearchPage> {
    const q = new URLSearchParams({ kind: p.kind });
    for (const k of ['text', 'from', 'subject', 'after', 'before', 'pageToken'] as const) { const v = p[k]; if (v) q.set(k, v); }
    return api<SearchPage>(`/api/gmail/search?${q.toString()}`);
  },

  attach(projectId: string, cardId: string | null, items: { kind: GmailKind; id: string }[]): Promise<GmailAttachResult> {
    return api<GmailAttachResult>('/api/gmail/links', { method: 'POST', body: { projectId, cardId, items } });
  },

  preview(linkId: string): Promise<GmailPreview> {
    return api<GmailPreview>(`/api/gmail/links/${encodeURIComponent(linkId)}/preview`);
  },

  refresh(linkId: string): Promise<{ state: GmailLink['state']; updated: boolean }> {
    return api(`/api/gmail/links/${encodeURIComponent(linkId)}/refresh`, { method: 'POST', body: {} });
  },

  /** Removes the association only; nothing in Gmail changes. */
  async remove(linkId: string): Promise<void> {
    const { data, error } = await supabase.from('external_resource_links').delete().eq('id', linkId).select('id');
    if (error) throw new DriveError(error.code ?? 'db', error.code === '42501' ? 'K odebrání e-mailu nemáte oprávnění.' : 'E-mail se nepodařilo odebrat.');
    if (!data?.length) throw new DriveError('forbidden', 'E-mail se nepodařilo odebrat (možná už byl odebrán, nebo k tomu nemáte oprávnění).');
  },

  /** Turn Gmail off in ClearSpace (Drive untouched); `purge` also removes every e-mail link this user created. */
  disable(purge: boolean): Promise<{ gmailRemoved: boolean; purged: { removed: number; skipped: number } | null }> {
    return api(`/api/gmail/connection${purge ? '?purge=1' : ''}`, { method: 'DELETE' });
  },
};
