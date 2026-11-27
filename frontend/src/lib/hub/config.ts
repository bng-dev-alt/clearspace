import { createHmac } from 'node:crypto';
import { appBaseUrl, isLoopbackHost, isProductionRuntime } from '../email/config';
import { keyFromBase64, type KeyRing } from '../google/crypto';

/**
 * Project Communication Hub (RUN 07). SERVER ONLY. Separate provider apps from the RUN 05 personal notifications (docs/run07/DECISIONS.md D5/D6).
 *
 *   HUB_SLACK_ENABLED, HUB_TELEGRAM_ENABLED      -- feature switches ('1' = on; default off; every hub route checks its switch first)
 *   HUB_INTELLIGENCE_ENABLED                      -- '1' = Project Intelligence may ingest/read hub communication (kill switch; default off)
 *   HUB_PILOT_USER_IDS                            -- optional pilot allowlist of ClearSpace user ids (RUN 08); unset = everyone
 *   HUB_SERVER_SECRET                             -- >= 32 chars; SHA-256 in server_trust('hub'); also authenticates the scheduler's calls
 *   HUB_ROUTING_KEY                               -- >= 32 chars, NEVER rotated: HMAC key of the routing keys (kept apart so a secret rotation cannot break routing)
 *   HUB_TOKEN_ENCRYPTION_KEY (+ _PREVIOUS)        -- base64 32 B; Slack workspace tokens, channel / chat references
 *   HUB_SERVICE_EMAIL, HUB_SERVICE_PASSWORD       -- the dedicated service principal the webhooks act as (no project rights)
 *   SLACK_HUB_CLIENT_ID, SLACK_HUB_CLIENT_SECRET, SLACK_HUB_SIGNING_SECRET
 *   TELEGRAM_HUB_BOT_TOKEN, TELEGRAM_HUB_BOT_USERNAME, TELEGRAM_HUB_WEBHOOK_SECRET
 *   TELEGRAM_HUB_PI_BOT_TOKEN, TELEGRAM_HUB_PI_BOT_USERNAME, TELEGRAM_HUB_PI_WEBHOOK_SECRET  -- OPTIONAL separate Project Intelligence bot (privacy
 *                                                    mode OFF, reads only groups that are confirmed destinations with full ingestion on; never posts)
 *   SLACK_HUB_API_MOCK_BASE, TELEGRAM_HUB_API_MOCK_BASE  -- local tests only (loopback, never production)
 */
export type HubProvider = 'slack' | 'telegram';
export const SLACK_HUB_SCOPES = ['chat:write', 'commands', 'channels:history', 'groups:history'];
export const HUB_EVENT_TYPES = ['task_created', 'task_completed', 'status_changed', 'due_soon'] as const;
export const HUB_INSTALL_COOKIE = 'cs_hub_slack';
export const HUB_INSTALL_RESULT_COOKIE = 'cs_hub_slack_result';
export const HUB_INSTALL_COOKIE_PATH = '/api/hub/slack/install';

const on = (v: string | undefined) => v?.trim() === '1';
export const hubSlackEnabled = (env: NodeJS.ProcessEnv = process.env) => on(env.HUB_SLACK_ENABLED);
export const hubTelegramEnabled = (env: NodeJS.ProcessEnv = process.env) => on(env.HUB_TELEGRAM_ENABLED);
export const hubIntelligenceEnabled = (env: NodeJS.ProcessEnv = process.env) => on(env.HUB_INTELLIGENCE_ENABLED);
export const hubAnyEnabled = (env: NodeJS.ProcessEnv = process.env) => hubSlackEnabled(env) || hubTelegramEnabled(env);
/** RUN 08 pilot: HUB_PILOT_USER_IDS (comma-separated ClearSpace user ids) set -> only those accounts may use the hub; unset -> everyone. */
export const hubPilotAllows = (userId: string, env: NodeJS.ProcessEnv = process.env) => {
  const ids = (env.HUB_PILOT_USER_IDS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return ids.length === 0 || ids.includes(userId.toLowerCase());
};
export const hubProviderEnabled = (p: HubProvider, env: NodeJS.ProcessEnv = process.env) => (p === 'slack' ? hubSlackEnabled(env) : hubTelegramEnabled(env));

export interface HubSlack { clientId: string; clientSecret: string; signingSecret: string; api: string; authorize: string; redirectUri: string; mock: boolean }
export interface HubTelegram { botToken: string; botUsername: string; webhookSecret: string; api: string; mock: boolean; pi: HubTelegramPi | null }
export interface HubTelegramPi { botToken: string; botUsername: string; webhookSecret: string }
export interface HubConfig {
  serverSecret: string;
  routingKey: string;
  keys: KeyRing;
  appBaseUrl: string;
  serviceEmail: string;
  servicePassword: string;
  slack: HubSlack | { error: string };
  telegram: HubTelegram | { error: string };
}

function mockBase(raw: string | undefined, env: NodeJS.ProcessEnv): string | null | 'refused' {
  if (!raw?.trim()) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return 'refused'; }
  if (isProductionRuntime(env) || !isLoopbackHost(u.hostname) || u.protocol !== 'http:') return 'refused';
  return u.origin;
}

function slackCfg(env: NodeJS.ProcessEnv, base: string): HubSlack | { error: string } {
  const clientId = env.SLACK_HUB_CLIENT_ID?.trim(), clientSecret = env.SLACK_HUB_CLIENT_SECRET?.trim(), signingSecret = env.SLACK_HUB_SIGNING_SECRET?.trim();
  if (!clientId || !clientSecret || !signingSecret) return { error: 'Slack pro projekty není na serveru nastavený.' };
  if (!/^[0-9]{3,20}\.[0-9]{3,20}$/.test(clientId) || !/^[A-Za-z0-9_-]{8,100}$/.test(clientSecret) || !/^[A-Za-z0-9_-]{16,100}$/.test(signingSecret)) {
    return { error: 'Konfigurace Slacku pro projekty není platná.' };
  }
  // D6: the project app must be a DIFFERENT Slack app than the personal-notification app (RUN 05)
  if (env.SLACK_CLIENT_ID?.trim() && env.SLACK_CLIENT_ID.trim() === clientId) return { error: 'Slack pro projekty musí být samostatná aplikace (jiné Client ID než osobní oznámení).' };
  const mock = mockBase(env.SLACK_HUB_API_MOCK_BASE, env);
  if (mock === 'refused') return { error: 'SLACK_HUB_API_MOCK_BASE je povolené jen pro lokální testy.' };
  if (mock === null && (clientSecret.startsWith('mock-') || signingSecret.startsWith('mock'))) return { error: 'Zkušební (mock) údaje Slacku bez mock režimu.' };
  return {
    clientId, clientSecret, signingSecret,
    api: mock ? `${mock}/slack/api` : 'https://slack.com/api',
    authorize: mock ? `${mock}/slack/oauth/v2/authorize` : 'https://slack.com/oauth/v2/authorize',
    redirectUri: `${base}/api/hub/slack/install/callback`,
    mock: mock !== null,
  };
}

function telegramCfg(env: NodeJS.ProcessEnv): HubTelegram | { error: string } {
  const botToken = env.TELEGRAM_HUB_BOT_TOKEN?.trim(), botUsername = env.TELEGRAM_HUB_BOT_USERNAME?.trim().replace(/^@/, ''), webhookSecret = env.TELEGRAM_HUB_WEBHOOK_SECRET?.trim();
  if (!botToken || !botUsername || !webhookSecret) return { error: 'Telegram pro projekty není na serveru nastavený.' };
  if (!/^[0-9]{6,12}:[A-Za-z0-9_-]{30,64}$/.test(botToken) || !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(botUsername) || !/^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret)) {
    return { error: 'Konfigurace Telegramu pro projekty není platná.' };
  }
  // D5: getUpdates (personal bot) and a webhook (project bot) are mutually exclusive per bot -> two different bots, enforced here
  if (env.TELEGRAM_BOT_TOKEN?.trim() && env.TELEGRAM_BOT_TOKEN.trim() === botToken) return { error: 'Projektový bot musí být jiný než bot osobních oznámení.' };
  const mock = mockBase(env.TELEGRAM_HUB_API_MOCK_BASE, env);
  if (mock === 'refused') return { error: 'TELEGRAM_HUB_API_MOCK_BASE je povolené jen pro lokální testy.' };
  if (mock === null && /MOCKmock/.test(botToken)) return { error: 'Zkušební (mock) token Telegramu bez mock režimu.' };
  // optional Project Intelligence bot: a THIRD bot (never the project or the personal one), privacy mode off, read-only
  let pi: HubTelegramPi | null = null;
  const piToken = env.TELEGRAM_HUB_PI_BOT_TOKEN?.trim(), piUser = env.TELEGRAM_HUB_PI_BOT_USERNAME?.trim().replace(/^@/, ''), piSecret = env.TELEGRAM_HUB_PI_WEBHOOK_SECRET?.trim();
  if (piToken || piUser || piSecret) {
    if (!piToken || !piUser || !piSecret || !/^[0-9]{6,12}:[A-Za-z0-9_-]{30,64}$/.test(piToken) || !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(piUser) || !/^[A-Za-z0-9_-]{32,256}$/.test(piSecret)) {
      return { error: 'Konfigurace PI bota Telegramu není platná.' };
    }
    if (piToken === botToken || piToken === env.TELEGRAM_BOT_TOKEN?.trim() || piSecret === webhookSecret) return { error: 'PI bot musí být samostatný bot s vlastním tajemstvím.' };
    if (mock === null && /MOCKmock/.test(piToken)) return { error: 'Zkušební (mock) token PI bota bez mock režimu.' };
    pi = { botToken: piToken, botUsername: piUser, webhookSecret: piSecret };
  }
  return { botToken, botUsername, webhookSecret, api: mock ? `${mock}/telegram` : 'https://api.telegram.org', mock: mock !== null, pi };
}

export function hubConfig(env: NodeJS.ProcessEnv = process.env): HubConfig | { error: string } {
  const serverSecret = env.HUB_SERVER_SECRET?.trim();
  if (!serverSecret || serverSecret.length < 32) return { error: 'HUB_SERVER_SECRET chybí nebo je kratší než 32 znaků.' };
  for (const other of [env.EMAIL_SERVER_SECRET, env.GOOGLE_SERVER_SECRET, env.NOTIFY_SERVER_SECRET]) {
    if (other && other.trim() === serverSecret) return { error: 'HUB_SERVER_SECRET se nesmí shodovat s jiným tajemstvím serveru.' };
  }
  const routingKey = env.HUB_ROUTING_KEY?.trim();
  if (!routingKey || routingKey.length < 32 || routingKey === serverSecret) return { error: 'HUB_ROUTING_KEY chybí, je kratší než 32 znaků nebo se shoduje s HUB_SERVER_SECRET.' };
  let keys: KeyRing;
  try {
    keys = { current: keyFromBase64(env.HUB_TOKEN_ENCRYPTION_KEY), previous: env.HUB_TOKEN_ENCRYPTION_KEY_PREVIOUS?.trim() ? keyFromBase64(env.HUB_TOKEN_ENCRYPTION_KEY_PREVIOUS) : undefined };
  } catch {
    return { error: 'HUB_TOKEN_ENCRYPTION_KEY musí být base64 z 32 náhodných bajtů.' };
  }
  for (const other of [env.GOOGLE_TOKEN_ENCRYPTION_KEY, env.NOTIFY_TOKEN_ENCRYPTION_KEY]) {
    if (other && other.trim() === env.HUB_TOKEN_ENCRYPTION_KEY?.trim()) return { error: 'HUB_TOKEN_ENCRYPTION_KEY se nesmí shodovat s jiným klíčem.' };
  }
  const serviceEmail = env.HUB_SERVICE_EMAIL?.trim(), servicePassword = env.HUB_SERVICE_PASSWORD?.trim();
  if (!serviceEmail || !/^[^\s@]+@[^\s@]+$/.test(serviceEmail) || !servicePassword || servicePassword.length < 16) return { error: 'Servisní identita hubu není nastavená.' };
  const base = appBaseUrl(env);
  if (base.error || !base.url) return { error: base.error ?? 'APP_BASE_URL není nastaveno.' };
  return { serverSecret, routingKey, keys, appBaseUrl: base.url, serviceEmail, servicePassword, slack: slackCfg(env, base.url), telegram: telegramCfg(env) };
}

/** Opaque routing keys (never raw workspace / channel / chat / user ids in the database). */
export const hubKey = (secret: string, ...parts: Array<string | number>) => createHmac('sha256', secret).update(`hub:${parts.join(':')}`).digest('hex');
export const hubAad = (purpose: 'destination' | 'installation', id: string) => `clearspace:hub:${purpose}:${id}`;
