import { hasSupabaseConfig, supabase } from '../lib/supabase';
import { HUB_DEMO_MESSAGES, HUB_DEMO_STATUS } from '../data/hubFixtures';
import { api, DriveError } from './driveService';

/**
 * Project Communication Hub (RUN 07), client side. The browser never sees a provider credential or a raw Slack / Telegram id: linking,
 * sending and disconnecting run on the server; chat records are read under RLS (project members only, routing keys not exposed).
 */
export type HubProvider = 'slack' | 'telegram';
export type DestinationStatus = 'pending' | 'active' | 'removed_bot' | 'revoked' | 'archived' | 'error';
export type HubEventType = 'task_created' | 'task_completed' | 'status_changed' | 'due_soon';
export interface HubDestination {
  id: string; provider: HubProvider; label: string; kind: 'slack_channel' | 'telegram_group' | 'telegram_supergroup'; status: DestinationStatus;
  notify: boolean; interactive: boolean; intelligence: boolean; eventTypes: HubEventType[]; lastErrorCode: string | null;
  createdAt: string; confirmedAt: string | null; messages: number; fullIngest: boolean; linkedBy: string | null;
}
export interface HubProjectStatus {
  canManage: boolean;
  destinations: HubDestination[];
  pendingCodes: number;
  slackWorkspaces: Array<{ label: string; status: 'active' | 'revoked' }>;
  audit: Array<{ action: string; detail: string | null; actorKind: string; actor: string | null; at: string }>;
  providers: { slack: boolean; telegram: boolean };
  simulated: { slack: boolean; telegram: boolean };
  telegramBot: string | null;
  telegramPiBot: string | null;
  intelligenceAvailable: boolean;
}
export interface HubMessage {
  id: string; project_id: string; destination_id: string | null; destination_label: string; provider: HubProvider; card_id: string | null;
  kind: 'task_source' | 'thread_reply' | 'ingested'; author_label: string; author_user_id: string | null; verified: boolean; text: string;
  permalink: string | null; sent_at: string; edited_at: string | null; deleted_at: string | null;
}
export interface HubIdentity { provider: HubProvider; key: string; label: string; createdAt: string }

export const EVENT_LABEL: Record<HubEventType, string> = {
  task_created: 'Nový úkol',
  task_completed: 'Dokončený úkol',
  status_changed: 'Změna stavu (přesun do sloupce)',
  due_soon: 'Blížící se termín (den předem v 9:00)',
};
export const STATUS_LABEL: Record<DestinationStatus, string> = {
  pending: 'čeká na potvrzení', active: 'aktivní', removed_bot: 'bot není v kanálu / skupině', revoked: 'přístup zrušen', archived: 'archivováno', error: 'chyba',
};
export const PROVIDER_NAME: Record<HubProvider, string> = { slack: 'Slack', telegram: 'Telegram' };
const MESSAGE_COLUMNS = 'id, project_id, destination_id, destination_label, provider, card_id, kind, author_label, author_user_id, verified, text, permalink, sent_at, edited_at, deleted_at';

export const hubService = {
  /** null = the hub is off on this server (no button, no tab). */
  async project(projectId: string): Promise<HubProjectStatus | null> {
    if (!hasSupabaseConfig) return HUB_DEMO_STATUS;     // demo: static simulation, no network
    try {
      return await api<HubProjectStatus>(`/api/hub/projects/${encodeURIComponent(projectId)}`);
    } catch (e) {
      if (e instanceof DriveError && e.status === 503 && /^hub_/.test(e.code)) return null;
      throw e;
    }
  },
  linkCode(projectId: string, provider: HubProvider): Promise<{ code: string; expiresInSeconds: number; instruction: string }> {
    return api(`/api/hub/projects/${encodeURIComponent(projectId)}`, { method: 'POST', body: { provider } });
  },
  decide(id: string, decision: 'confirm' | 'reject'): Promise<{ status: string }> {
    return api(`/api/hub/destinations/${id}`, { method: 'PATCH', body: { decision } });
  },
  configure(id: string, c: { notify: boolean; interactive: boolean; intelligence: boolean; intelligenceAck?: boolean; eventTypes: HubEventType[]; fullIngest?: boolean }): Promise<{ ok: boolean }> {
    return api(`/api/hub/destinations/${id}`, { method: 'PATCH', body: c });
  },
  test(id: string): Promise<{ outcome: string; message: string }> {
    return api(`/api/hub/destinations/${id}`, { method: 'POST', body: {} });
  },
  remove(id: string, purge: boolean): Promise<{ removed: boolean; purgedMessages: number }> {
    return api(`/api/hub/destinations/${id}${purge ? '?purge=1' : ''}`, { method: 'DELETE' });
  },
  async installSlack(): Promise<void> {
    const { url } = await api<{ url: string }>('/api/hub/slack/install/start', { method: 'POST', body: {} });
    window.location.assign(url);
  },
  completeSlack(): Promise<{ outcome: string }> {
    return api('/api/hub/slack/install/complete', { method: 'POST', body: {} });
  },
  /** null = hub off on this server. */
  async identities(): Promise<HubIdentity[] | null> {
    try {
      return (await api<{ identities: HubIdentity[] }>('/api/hub/identity')).identities;
    } catch (e) {
      if (e instanceof DriveError && e.status === 503 && /^hub_/.test(e.code)) return null;
      throw e;
    }
  },
  /** A single-use code (10 min) the user sends FROM the chat account (Telegram: deep link to the bot). */
  startIdentity(provider: HubProvider): Promise<{ code: string; expiresInSeconds: number; instruction: string; url?: string }> {
    return api('/api/hub/identity', { method: 'POST', body: { provider } });
  },
  /** Comments of a task that came from / went to a chat thread, with the original message link; plus the linked chats. */
  async commentSources(cardId: string): Promise<{ sources: Map<string, { provider: HubProvider; direction: 'inbound' | 'outbound'; permalink: string | null }>; linked: HubProvider[] }> {
    const empty = { sources: new Map(), linked: [] as HubProvider[] };
    if (!hasSupabaseConfig) return empty;
    const { data: comments } = await supabase.from('task_comments').select('id').eq('card_id', cardId).limit(500);
    const ids = ((comments ?? []) as Array<{ id: string }>).map((c) => c.id);
    const [{ data: links }, { data: conv }] = await Promise.all([
      ids.length ? supabase.from('hub_comment_links').select('comment_id, direction, provider, message:hub_messages(permalink)').in('comment_id', ids) : Promise.resolve({ data: [] }),
      supabase.from('hub_messages').select('provider').eq('card_id', cardId).not('conversation_id', 'is', null).limit(10),
    ]);
    type Link = { comment_id: string; direction: 'inbound' | 'outbound'; provider: HubProvider; message?: { permalink: string | null } | Array<{ permalink: string | null }> | null };
    const sources = new Map(((links ?? []) as unknown as Link[]).map((l) => {
      const m = Array.isArray(l.message) ? l.message[0] : l.message;
      return [l.comment_id, { provider: l.provider, direction: l.direction, permalink: m?.permalink ?? null }] as const;
    }));
    return { sources, linked: [...new Set(((conv ?? []) as Array<{ provider: HubProvider }>).map((r) => r.provider))] };
  },
  removeIdentity(provider: HubProvider, key: string): Promise<{ removed: boolean }> {
    return api('/api/hub/identity', { method: 'DELETE', body: { provider, key } });
  },
  /** Recorded chat communication of a project (task sources, linked thread replies, PI imports), newest first. */
  async messages(projectId: string, limit = 200): Promise<HubMessage[]> {
    if (!hasSupabaseConfig) return HUB_DEMO_MESSAGES;
    const { data, error } = await supabase.from('hub_messages').select(MESSAGE_COLUMNS).eq('project_id', projectId).order('sent_at', { ascending: false }).limit(limit);
    if (error) throw new DriveError('db', 'Komunikaci se nepodařilo načíst.');
    return (data ?? []) as HubMessage[];
  },
  /** Display names of verified authors (profiles visible to the caller under RLS). */
  async names(ids: string[]): Promise<Map<string, string>> {
    const want = [...new Set(ids)].filter(Boolean);
    if (!hasSupabaseConfig || want.length === 0) return new Map();
    const { data } = await supabase.from('profiles').select('id, display_name').in('id', want);
    return new Map(((data ?? []) as Array<{ id: string; display_name: string | null }>).filter((r) => r.display_name).map((r) => [r.id, r.display_name!]));
  },
  /** The chat conversation of one task (source message + synced thread replies), oldest first. */
  async taskConversation(cardId: string): Promise<HubMessage[]> {
    if (!hasSupabaseConfig) return HUB_DEMO_MESSAGES.filter((m) => m.card_id === cardId).reverse();
    const { data, error } = await supabase.from('hub_messages').select(MESSAGE_COLUMNS).eq('card_id', cardId).order('sent_at', { ascending: true }).limit(200);
    if (error) return [];
    return (data ?? []) as HubMessage[];
  },
};
