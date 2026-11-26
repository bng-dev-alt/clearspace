import { supabase } from '../lib/supabase';
import { api, DriveError } from './driveService';

/**
 * Notifications outside the app (RUN 05), client side. The browser never sees a provider credential: connecting, confirming, sending and
 * disconnecting run on the server. The in-app bell (RUN 01) does not depend on any of this.
 */
export type NotifyProvider = 'slack' | 'telegram';
export type ChannelStatus = 'linking' | 'confirm' | 'active' | 'reconnect' | 'blocked';
export interface NotifyChannel {
  provider: NotifyProvider;
  status: ChannelStatus;
  enabled: boolean;
  label: string | null;
  lastErrorCode: string | null;
  lastSentAt: string | null;
  linkPending: boolean;
  failed7d: number;
}
export interface NotifyPreferences { eventTypes: string[]; projectIds: string[] | null; hideTitles: boolean }
export interface NotifyStatus {
  slack: { available: boolean; simulated: boolean };
  telegram: { available: boolean; simulated: boolean };
  channels: NotifyChannel[];
  preferences: NotifyPreferences | null;
}

export const EVENT_TYPES: Array<{ id: string; label: string }> = [
  { id: 'assignment', label: 'Přiřazení úkolu' },
  { id: 'due_soon', label: 'Blížící se termín (den předem v 9:00)' },
  { id: 'mention', label: 'Zmínka v komentáři' },
  { id: 'comment', label: 'Komentář u mého úkolu' },
  { id: 'task_completed', label: 'Můj úkol byl dokončen' },
  { id: 'task_due_changed', label: 'Změna termínu mého úkolu' },
  { id: 'project_membership', label: 'Členství v projektech' },
];
export const DEFAULT_PREFERENCES: NotifyPreferences = { eventTypes: EVENT_TYPES.map((e) => e.id), projectIds: null, hideTitles: false };

export const notifyService = {
  /** null = the feature is off on this server (the settings card is not shown). */
  async status(): Promise<NotifyStatus | null> {
    try {
      return await api<NotifyStatus>('/api/notify/status');
    } catch (e) {
      if (e instanceof DriveError && e.status === 503 && e.code === 'notify_disabled') return null;
      throw e;
    }
  },
  async connectSlack(): Promise<void> {
    const { url } = await api<{ url: string }>('/api/notify/slack/start', { method: 'POST', body: {} });
    window.location.assign(url);
  },
  completeSlack(): Promise<{ outcome: string }> {
    return api<{ outcome: string }>('/api/notify/slack/complete', { method: 'POST', body: {} });
  },
  telegramLink(): Promise<{ url: string; expiresInSeconds: number }> {
    return api('/api/notify/telegram/link', { method: 'POST', body: {} });
  },
  telegramCheck(): Promise<{ channel: NotifyChannel | null }> {
    return api('/api/notify/telegram/check', { method: 'POST', body: {} });
  },
  telegramConfirm(accept: boolean): Promise<{ status: string }> {
    return api('/api/notify/telegram/confirm', { method: 'POST', body: { accept } });
  },
  setEnabled(provider: NotifyProvider, enabled: boolean): Promise<{ changed: boolean }> {
    return api('/api/notify/channel', { method: 'POST', body: { provider, enabled } });
  },
  disconnect(provider: NotifyProvider): Promise<{ removed: boolean; revoked: boolean | null; shared: boolean }> {
    return api(`/api/notify/channel?provider=${provider}`, { method: 'DELETE' });
  },
  test(provider: NotifyProvider): Promise<{ outcome: string; message: string }> {
    return api('/api/notify/test', { method: 'POST', body: { provider } });
  },
  savePreferences(p: NotifyPreferences): Promise<{ saved: boolean }> {
    return api('/api/notify/preferences', { method: 'PUT', body: p });
  },
  /** Projects the user can see (RLS) -- for the project filter. */
  async projects(): Promise<Array<{ id: string; name: string }>> {
    const { data, error } = await supabase.from('projects').select('id, name').order('name');
    if (error) return [];
    return (data ?? []) as Array<{ id: string; name: string }>;
  },
};
