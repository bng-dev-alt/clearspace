import { createHmac } from 'node:crypto';
import { appBaseUrl, isLoopbackHost, isProductionRuntime } from '../email/config';
import { keyFromBase64, type KeyRing } from '../google/crypto';

/**
 * Notifications outside the app -- Slack & Telegram (RUN 05). SERVER ONLY: nothing here may reach the client bundle.
 * Each provider is OFF unless its switch is '1' AND it is configured (fail closed).
 *
 *   SLACK_INTEGRATION_ENABLED, TELEGRAM_INTEGRATION_ENABLED  -- feature switches ('1' = on; default off)
 *   NOTIFY_SERVER_SECRET            -- >= 32 chars; SHA-256 registered in server_trust('notify'); also authenticates the scheduler's calls
 *   NOTIFY_TOKEN_ENCRYPTION_KEY     -- base64 of 32 random bytes (AES-256-GCM, provider credentials at rest); _PREVIOUS during a rotation
 *   SLACK_CLIENT_ID, SLACK_CLIENT_SECRET               -- the Slack app (OAuth v2, bot scope chat:write only)
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_USERNAME          -- the Telegram bot (BotFather)
 *   APP_BASE_URL                    -- links in messages and the Slack redirect URI are built only from it
 *   SLACK_API_MOCK_BASE, TELEGRAM_API_MOCK_BASE        -- local tests only: honoured only outside production AND on loopback
 */
export type NotifyProvider = 'slack' | 'telegram';
export const PROVIDERS: NotifyProvider[] = ['slack', 'telegram'];
export const SLACK_BOT_SCOPES = ['chat:write'];
/** HttpOnly browser-binding nonce of a Slack OAuth transaction and Slack's parked answer (path-scoped to the Slack routes). */
export const SLACK_NONCE_COOKIE = 'cs_notify_slack';
export const SLACK_RESULT_COOKIE = 'cs_notify_slack_result';
export const SLACK_COOKIE_PATH = '/api/notify/slack';

export const slackFeatureEnabled = (env: NodeJS.ProcessEnv = process.env) => env.SLACK_INTEGRATION_ENABLED?.trim() === '1';
export const telegramFeatureEnabled = (env: NodeJS.ProcessEnv = process.env) => env.TELEGRAM_INTEGRATION_ENABLED?.trim() === '1';
export const providerEnabled = (p: NotifyProvider, env: NodeJS.ProcessEnv = process.env) => (p === 'slack' ? slackFeatureEnabled(env) : telegramFeatureEnabled(env));
export const anyNotifyEnabled = (env: NodeJS.ProcessEnv = process.env) => slackFeatureEnabled(env) || telegramFeatureEnabled(env);

export interface SlackConfig { clientId: string; clientSecret: string; api: string; authorize: string; redirectUri: string; mock: boolean }
export interface TelegramConfig { botToken: string; botUsername: string; api: string; mock: boolean }
export interface NotifyConfig {
  serverSecret: string;
  keys: KeyRing;
  appBaseUrl: string;
  slack: SlackConfig | { error: string };
  telegram: TelegramConfig | { error: string };
}
export type NotifyConfigResult = NotifyConfig | { error: string };

/** A mock base is honoured only in local tests: not production, http on a loopback host. */
function mockBase(raw: string | undefined, env: NodeJS.ProcessEnv): string | null | 'refused' {
  if (!raw?.trim()) return null;
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return 'refused'; }
  if (isProductionRuntime(env) || !isLoopbackHost(u.hostname) || u.protocol !== 'http:') return 'refused';
  return u.origin;
}

function slackConfig(env: NodeJS.ProcessEnv, base: string): SlackConfig | { error: string } {
  const clientId = env.SLACK_CLIENT_ID?.trim();
  const clientSecret = env.SLACK_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return { error: 'Propojení se Slackem není na serveru nastavené.' };
  if (!/^[0-9]{3,20}\.[0-9]{3,20}$/.test(clientId)) return { error: 'SLACK_CLIENT_ID není platné.' };
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(clientSecret)) return { error: 'SLACK_CLIENT_SECRET není platné.' };
  const mock = mockBase(env.SLACK_API_MOCK_BASE, env);
  if (mock === 'refused') return { error: 'SLACK_API_MOCK_BASE je povolené jen pro lokální testy (http://127.0.0.1).' };
  // a mock-format secret is only valid together with the mock provider (RUN 02B lesson: never send a mock secret to the real service)
  if (mock === null && clientSecret.startsWith('mock-')) return { error: 'SLACK_CLIENT_SECRET je zkušební (mock) hodnota, ale Slack není v mock režimu.' };
  return {
    clientId, clientSecret,
    api: mock ? `${mock}/slack/api` : 'https://slack.com/api',
    authorize: mock ? `${mock}/slack/oauth/v2/authorize` : 'https://slack.com/oauth/v2/authorize',
    redirectUri: `${base}/api/notify/slack/callback`,
    mock: mock !== null,
  };
}

function telegramConfig(env: NodeJS.ProcessEnv): TelegramConfig | { error: string } {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const botUsername = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '');
  if (!botToken || !botUsername) return { error: 'Propojení s Telegramem není na serveru nastavené.' };
  if (!/^[0-9]{6,12}:[A-Za-z0-9_-]{30,64}$/.test(botToken)) return { error: 'TELEGRAM_BOT_TOKEN není platný.' };
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(botUsername)) return { error: 'TELEGRAM_BOT_USERNAME není platné.' };
  const mock = mockBase(env.TELEGRAM_API_MOCK_BASE, env);
  if (mock === 'refused') return { error: 'TELEGRAM_API_MOCK_BASE je povolené jen pro lokální testy (http://127.0.0.1).' };
  if (mock === null && /MOCKmock/.test(botToken)) return { error: 'TELEGRAM_BOT_TOKEN je zkušební (mock) hodnota, ale Telegram není v mock režimu.' };
  return { botToken, botUsername, api: mock ? `${mock}/telegram` : 'https://api.telegram.org', mock: mock !== null };
}

export function notifyConfig(env: NodeJS.ProcessEnv = process.env): NotifyConfigResult {
  const serverSecret = env.NOTIFY_SERVER_SECRET?.trim();
  if (!serverSecret || serverSecret.length < 32) return { error: 'NOTIFY_SERVER_SECRET chybí nebo je kratší než 32 znaků.' };
  // separate secrets per purpose
  for (const other of [env.EMAIL_SERVER_SECRET, env.GOOGLE_SERVER_SECRET]) {
    if (other && other.trim() === serverSecret) return { error: 'NOTIFY_SERVER_SECRET se nesmí shodovat s jiným tajemstvím serveru.' };
  }
  let keys: KeyRing;
  try {
    const current = keyFromBase64(env.NOTIFY_TOKEN_ENCRYPTION_KEY);
    const previous = env.NOTIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS?.trim() ? keyFromBase64(env.NOTIFY_TOKEN_ENCRYPTION_KEY_PREVIOUS) : undefined;
    keys = { current, previous };
  } catch {
    return { error: 'NOTIFY_TOKEN_ENCRYPTION_KEY musí být base64 z 32 náhodných bajtů.' };
  }
  if (env.GOOGLE_TOKEN_ENCRYPTION_KEY && env.GOOGLE_TOKEN_ENCRYPTION_KEY.trim() === env.NOTIFY_TOKEN_ENCRYPTION_KEY?.trim()) {
    return { error: 'NOTIFY_TOKEN_ENCRYPTION_KEY se nesmí shodovat s klíčem Google integrace.' };
  }
  const base = appBaseUrl(env);
  if (base.error || !base.url) return { error: base.error ?? 'APP_BASE_URL není nastaveno.' };
  return { serverSecret, keys, appBaseUrl: base.url, slack: slackConfig(env, base.url), telegram: telegramConfig(env) };
}

/** AAD of a channel credential envelope: bound to provider + channel (an envelope cannot be moved to another channel). */
export const channelAad = (provider: NotifyProvider, channelId: string) => `clearspace:notify:${provider}:${channelId}`;

/** Opaque, comparable id of a Slack workspace (never the team id itself in the database). */
export const teamHmac = (serverSecret: string, teamId: string) => createHmac('sha256', serverSecret).update(`slack-team:${teamId}`).digest('hex');
