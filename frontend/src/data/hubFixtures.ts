import type { HubMessage, HubProjectStatus } from '../services/hubService';

/**
 * Czech DEMONSTRATION data for the Communication Hub in demo mode (no database). Static, read-only, labelled "simulace": no Slack, no
 * Telegram, no network call. Fictional channels and people.
 */
export const HUB_DEMO_STATUS: HubProjectStatus = {
  canManage: false,
  destinations: [
    { id: 'demo-d1', provider: 'slack', label: '#web-redesign (simulace)', kind: 'slack_channel', status: 'active', notify: true, interactive: true, intelligence: false,
      eventTypes: ['task_created', 'task_completed'], lastErrorCode: null, createdAt: '2026-11-20T09:00:00Z', confirmedAt: '2026-11-20T09:05:00Z', messages: 3, fullIngest: false, linkedBy: 'Slack: Anna (ukázka)' },
    { id: 'demo-d2', provider: 'telegram', label: 'Klient – web (simulace)', kind: 'telegram_supergroup', status: 'active', notify: true, interactive: true, intelligence: false,
      eventTypes: ['task_created', 'task_completed', 'status_changed', 'due_soon'], lastErrorCode: null, createdAt: '2026-11-21T10:00:00Z', confirmedAt: '2026-11-21T10:02:00Z', messages: 2, fullIngest: false, linkedBy: 'Telegram: Karel (ukázka)' },
  ],
  pendingCodes: 0, slackWorkspaces: [], audit: [],
  providers: { slack: true, telegram: true }, simulated: { slack: true, telegram: true }, telegramBot: null, telegramPiBot: null, intelligenceAvailable: false,
};
const m = (id: string, provider: 'slack' | 'telegram', label: string, kind: HubMessage['kind'], author: string, verified: boolean, text: string, at: string, cardId: string | null): HubMessage => ({
  id, project_id: 'demo', destination_id: null, destination_label: label, provider, card_id: cardId, kind, author_label: author, author_user_id: null, verified,
  text, permalink: null, sent_at: at, edited_at: null, deleted_at: null,
});
export const HUB_DEMO_MESSAGES: HubMessage[] = [
  m('demo-m5', 'telegram', 'Klient – web (simulace)', 'thread_reply', 'Telegram: Karel (ukázka)', false, 'Mobilní verze je pro nás priorita, desktop může počkat.', '2026-11-25T15:20:00Z', 'card-1'),
  m('demo-m4', 'telegram', 'Klient – web (simulace)', 'task_source', 'Telegram: Karel (ukázka)', true, 'Pošlete prosím do pátku první návrh hlavní stránky.', '2026-11-25T15:02:00Z', 'card-1'),
  m('demo-m3', 'slack', '#web-redesign (simulace)', 'thread_reply', 'Anna (ukázka)', true, 'Barvy beru z nového manuálu, OAuth řeším zvlášť.', '2026-11-24T11:40:00Z', 'card-2'),
  m('demo-m2', 'slack', '#web-redesign (simulace)', 'thread_reply', 'Člen kanálu (Slack)', false, 'Clerk má lepší ceník pro malé týmy.', '2026-11-24T11:10:00Z', 'card-2'),
  m('demo-m1', 'slack', '#web-redesign (simulace)', 'task_source', 'Anna (ukázka)', true, 'Potřebujeme porovnat Auth0, Clerk a vlastní řešení.', '2026-11-24T10:55:00Z', 'card-2'),
];
