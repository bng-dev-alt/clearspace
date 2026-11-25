import { supabase, hasSupabaseConfig } from '../lib/supabase';
import type { AccessState } from '../lib/google/labels';

/**
 * Google account + Drive links, client side (RUN 02). The browser never holds a refresh token; the only Google
 * credential it ever sees is the short-lived access token the Google Picker needs (in memory, see picker.ts).
 * Link rows are read under the caller's RLS; adding goes through the server (metadata from Drive, never from here).
 */
export interface GoogleConnection {
  email: string;
  scopes: string[];
  status: 'active' | 'revoked' | 'error';
  connectedAt: string;
  /** RUN 03: services ClearSpace uses from this one Google grant (absent from an older server = Drive only). */
  services?: { drive: boolean; gmail: boolean };
}
export interface GoogleStatus {
  configured: boolean;
  message?: string;
  simulated?: boolean;
  /** RUN 03: Gmail feature switch on the server. */
  gmailAvailable?: boolean;
  /** Google consent screen in Testing mode: only approved test users can connect */
  pilot?: boolean;
  connection: GoogleConnection | null;
}
export type GoogleServiceName = 'drive' | 'gmail';
/** Whether the caller's connection is active AND has this service. */
export function serviceActive(s: GoogleStatus | null | undefined, service: GoogleServiceName): boolean {
  const c = s?.connection;
  if (!c || c.status !== 'active') return false;
  return c.services ? c.services[service] : service === 'drive';
}
export interface DriveLink {
  id: string;
  projectId: string;
  cardId: string | null;
  externalId: string;
  name: string;
  mimeType: string;
  webUrl: string;
  sizeBytes: number | null;
  modifiedAt: string | null;
  providerState: 'ok' | 'trashed';
  metadataCheckedAt: string;
  linkedByName: string;
  createdAt: string;
}
export interface AttachResult {
  links: { id: string; fileId: string; duplicate: boolean }[];
  failed: { fileId: string; reason: string; message: string }[];
}
export interface PickerGrant {
  accessToken: string;
  expiresAt: number;
  developerKey: string;
  appId: string;
  scriptUrl: string;
  simulated: boolean;
}
export interface ResourceContent {
  name: string;
  mimeType: string;
  modifiedAt: string | null;
  retrievedAt: string;
  text: string;
  truncated: boolean;
}

export class DriveError extends Error {
  constructor(public code: string, message: string, public status = 0) { super(message); this.name = 'DriveError'; }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new DriveError('unauthenticated', 'Přihlaste se prosím.', 401);
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
    });
  } catch {
    throw new DriveError('network', 'Nepodařilo se spojit se serverem. Zkontrolujte připojení a zkuste to znovu.');
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new DriveError(json.error ?? 'error', json.message ?? 'Něco se nepovedlo. Zkuste to prosím znovu.', res.status);
  return json as T;
}

interface LinkRow {
  id: string; project_id: string; card_id: string | null; external_id: string; name: string; mime_type: string; web_url: string;
  size_bytes: number | null; modified_at: string | null; provider_state: 'ok' | 'trashed'; metadata_checked_at: string;
  linked_by_name: string; created_at: string;
}
export const mapLink = (r: LinkRow): DriveLink => ({
  id: r.id, projectId: r.project_id, cardId: r.card_id, externalId: r.external_id, name: r.name, mimeType: r.mime_type,
  webUrl: r.web_url, sizeBytes: r.size_bytes, modifiedAt: r.modified_at, providerState: r.provider_state,
  metadataCheckedAt: r.metadata_checked_at, linkedByName: r.linked_by_name, createdAt: r.created_at,
});

let statusCache: Promise<GoogleStatus> | null = null;

export const driveService = {
  available: hasSupabaseConfig,

  status(force = false): Promise<GoogleStatus> {
    if (!hasSupabaseConfig) return Promise.resolve({ configured: false, connection: null });
    if (force || !statusCache) statusCache = api<GoogleStatus>('/api/google/connection').catch((e) => { statusCache = null; throw e; });
    return statusCache;
  },

  /** Leaves the page for Google's consent screen; comes back to `returnTo` (validated on the server). */
  async connect(returnTo: string, service: GoogleServiceName = 'drive'): Promise<void> {
    const { url } = await api<{ url: string }>('/api/google/oauth/start', { method: 'POST', body: { returnTo, service } });
    window.location.assign(url);
  },

  async disconnect(): Promise<{ disconnected: boolean; revokedAtGoogle: boolean }> {
    const r = await api<{ disconnected: boolean; revokedAtGoogle: boolean }>('/api/google/connection', { method: 'DELETE' });
    statusCache = null;
    return r;
  },

  pickerGrant(): Promise<PickerGrant> {
    return api<PickerGrant>('/api/google/picker-token', { method: 'POST', body: {} });
  },

  attach(projectId: string, cardId: string | null, fileIds: string[]): Promise<AttachResult> {
    return api<AttachResult>('/api/drive/links', { method: 'POST', body: { projectId, cardId, fileIds } });
  },

  refresh(projectId: string, cardId: string | null): Promise<{ statuses: Record<string, AccessState>; updated: number }> {
    return api('/api/drive/links/refresh', { method: 'POST', body: { projectId, cardId } });
  },

  async content(linkId: string): Promise<ResourceContent> {
    return (await api<{ content: ResourceContent }>(`/api/drive/links/${encodeURIComponent(linkId)}/content`)).content;
  },

  async list(projectId: string, cardId?: string): Promise<DriveLink[]> {
    if (!hasSupabaseConfig) return [];
    let q = supabase.from('external_resource_links')
      .select('id, project_id, card_id, external_id, name, mime_type, web_url, size_bytes, modified_at, provider_state, metadata_checked_at, linked_by_name, created_at')
      .eq('project_id', projectId).eq('provider', 'google_drive').order('created_at', { ascending: false }).limit(200);
    if (cardId) q = q.eq('card_id', cardId);
    const { data, error } = await q;
    if (error) throw new DriveError('db', 'Soubory se nepodařilo načíst.');
    return (data as LinkRow[]).map(mapLink);
  },

  /** Removes the association only; the file in Google Drive is not touched. */
  async remove(linkId: string): Promise<void> {
    const { data, error } = await supabase.from('external_resource_links').delete().eq('id', linkId).select('id');
    if (error) throw new DriveError(error.code ?? 'db', error.code === '42501' ? 'K odebrání přílohy nemáte oprávnění.' : 'Přílohu se nepodařilo odebrat.');
    if (!data?.length) throw new DriveError('forbidden', 'Přílohu se nepodařilo odebrat (možná už byla odebrána, nebo k tomu nemáte oprávnění).');
  },
};

// Realtime fan-out: the project channel delivers { t: 'links', card } signals (ids only); views re-read under RLS.
const linksTarget = typeof window !== 'undefined' ? new EventTarget() : null;
export function emitLinksChanged(projectId: string, cardId: string | null): void {
  linksTarget?.dispatchEvent(new CustomEvent('links', { detail: { projectId, cardId } }));
}
export function onLinksChanged(projectId: string, cb: (cardId: string | null) => void): () => void {
  if (!linksTarget) return () => {};
  const h = (e: Event) => { const d = (e as CustomEvent<{ projectId: string; cardId: string | null }>).detail; if (d.projectId === projectId) cb(d.cardId); };
  linksTarget.addEventListener('links', h);
  return () => linksTarget.removeEventListener('links', h);
}
