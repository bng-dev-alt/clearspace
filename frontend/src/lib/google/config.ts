import { appBaseUrl, isLoopbackHost, isProductionRuntime } from '../email/config';
import { keyFromBase64, type KeyRing } from './crypto';

/**
 * Google integration configuration (RUN 02). SERVER ONLY: nothing here may reach the client bundle.
 * Unconfigured = the integration is OFF and the UI says so (fail closed).
 *
 *   GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET   -- Web application OAuth client
 *   GOOGLE_SERVER_SECRET                                 -- >= 32 chars; SHA-256 registered in server_trust('google')
 *   GOOGLE_TOKEN_ENCRYPTION_KEY                          -- base64 of 32 random bytes (AES-256-GCM, tokens at rest)
 *   GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS                 -- optional, during a key rotation (decrypt only)
 *   GOOGLE_PICKER_API_KEY                                -- browser API key, restricted to the Picker API + app origins
 *   GOOGLE_CLOUD_PROJECT_NUMBER                          -- numeric project number (Picker setAppId, drive.file grants)
 *   APP_BASE_URL                                         -- shared with e-mail; the redirect URI is built only from it
 *   GOOGLE_API_MOCK_BASE                                 -- local tests only: honoured only outside production AND on loopback
 *   GMAIL_INTEGRATION_ENABLED                            -- RUN 03 feature switch, '1' = Gmail on (independent of Drive; default OFF)
 *   CALENDAR_INTEGRATION_ENABLED                         -- RUN 04 feature switch, '1' = Google Calendar on (independent; default OFF)
 *                                                           RUN 06: both switches also take 'pilot' = on ONLY for the users below
 *   GOOGLE_PILOT_USER_IDS                                -- pilot: comma-separated ClearSpace user ids (never a shared public-demo identity)
 *   GOOGLE_PILOT_ACCOUNTS                                -- pilot: comma-separated Google account e-mails allowed to grant Gmail/Calendar
 *   GOOGLE_OAUTH_PUBLISHING                              -- 'production' only once the consent screen is published (In production);
 *                                                           anything else = Testing: the UI says only approved test users can connect
 */

/** Drive integration = least privilege: per-file access to files the user picks (non-sensitive scope). */
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const IDENTITY_SCOPES = ['openid', 'email'];
export const DRIVE_SCOPES = [...IDENTITY_SCOPES, DRIVE_FILE_SCOPE];
/** HttpOnly browser-binding nonce of an OAuth transaction (path-scoped to the OAuth routes). */
export const OAUTH_COOKIE = 'cs_google_oauth';
/** Google's answer (state + code or error), parked by the callback until the signed-in page completes the flow. */
export const OAUTH_RESULT_COOKIE = 'cs_google_oauth_result';
export const OAUTH_COOKIE_PATH = '/api/google/oauth';
/**
 * RUN 03 Gmail: gmail.readonly is a RESTRICTED scope (docs/run03/ARCHITECTURE_DECISION.md). It is the narrowest scope that
 * allows searching (q) and reading a selected message: gmail.metadata is restricted too and forbids both. Requested only when
 * the user enables Gmail (incremental authorization, include_granted_scopes keeps Drive). Never modify/send/compose.
 */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_SCOPES = [...IDENTITY_SCOPES, GMAIL_READONLY_SCOPE];
/**
 * RUN 04 Calendar: the narrowest read scope that can list and read events of the user's OWN primary calendar
 * ("See the events on Google calendars you own"); classified SENSITIVE in the Google Cloud console (docs/run04/ARCHITECTURE_DECISION.md).
 * Requested only when the user enables Calendar. No write scope exists in this code.
 */
export const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.events.owned.readonly';
export const CALENDAR_SCOPES = [...IDENTITY_SCOPES, CALENDAR_READONLY_SCOPE];
export type GoogleService = 'drive' | 'gmail' | 'calendar';
export const SERVICE_SCOPE: Record<GoogleService, string> = { drive: DRIVE_FILE_SCOPE, gmail: GMAIL_READONLY_SCOPE, calendar: CALENDAR_READONLY_SCOPE };
export const SERVICE_SCOPES: Record<GoogleService, string[]> = { drive: DRIVE_SCOPES, gmail: GMAIL_SCOPES, calendar: CALENDAR_SCOPES };
/** Gmail feature switch, independent of Drive and of the Google grant (turning it off stops every Gmail call). */
export const gmailFeatureEnabled = (env: NodeJS.ProcessEnv = process.env) => env.GMAIL_INTEGRATION_ENABLED?.trim() === '1';
/** Calendar feature switch (RUN 04), independent of Drive, Gmail and the Google grant. Default OFF. */
export const calendarFeatureEnabled = (env: NodeJS.ProcessEnv = process.env) => env.CALENDAR_INTEGRATION_ENABLED?.trim() === '1';

/**
 * RUN 06 pilot mode for the server-side services: '1' = on for everyone, 'pilot' = on only for a listed ClearSpace user whose
 * connected Google account is listed too, anything else = off. Fail closed: 'pilot' with an empty list is off for everyone.
 */
export type ServiceMode = 'on' | 'pilot' | 'off';
export function serviceMode(service: 'gmail' | 'calendar', env: NodeJS.ProcessEnv = process.env): ServiceMode {
  const v = (service === 'gmail' ? env.GMAIL_INTEGRATION_ENABLED : env.CALENDAR_INTEGRATION_ENABLED)?.trim();
  return v === '1' ? 'on' : v === 'pilot' ? 'pilot' : 'off';
}
const csv = (raw: string | undefined) => (raw ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
/** May this ClearSpace user use the service (before the Google account is known)? Drive is not gated here. */
export function serviceAllowedFor(service: GoogleService, userId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (service === 'drive') return true;
  const mode = serviceMode(service, env);
  return mode === 'on' || (mode === 'pilot' && csv(env.GOOGLE_PILOT_USER_IDS).includes(userId.toLowerCase()) && csv(env.GOOGLE_PILOT_ACCOUNTS).length > 0);
}
/** ... and with this Google account (the account check of the pilot). */
export function serviceAllowedForAccount(service: GoogleService, userId: string, email: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!serviceAllowedFor(service, userId, env)) return false;
  return service === 'drive' || serviceMode(service as 'gmail' | 'calendar', env) === 'on' || (!!email && csv(env.GOOGLE_PILOT_ACCOUNTS).includes(email.trim().toLowerCase()));
}

export interface GoogleEndpoints {
  auth: string;
  token: string;
  revoke: string;
  drive: string;
  gmail: string;
  calendar: string;
  pickerScript: string;
}

const REAL: GoogleEndpoints = {
  auth: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  drive: 'https://www.googleapis.com/drive/v3',
  gmail: 'https://gmail.googleapis.com/gmail/v1',
  calendar: 'https://www.googleapis.com/calendar/v3',
  pickerScript: 'https://apis.google.com/js/api.js',
};

export interface GoogleConfig {
  enabled: true;
  clientId: string;
  clientSecret: string;
  serverSecret: string;
  keys: KeyRing;
  appBaseUrl: string;
  redirectUri: string;
  pickerApiKey: string;
  projectNumber: string;
  endpoints: GoogleEndpoints;
  mock: boolean;
  /** consent screen still in Testing: only test users added in Google Cloud can connect (limited pilot) */
  pilot: boolean;
}

/** Format CLASS of a secret for diagnostics (never the value): Google's client secrets start with GOCSPX-. */
export function secretFormat(secret: string): 'gocspx' | 'mock' | 'other' {
  return secret.startsWith('GOCSPX-') ? 'gocspx' : secret.startsWith('mock-') ? 'mock' : 'other';
}

export type GoogleConfigResult = GoogleConfig | { enabled: false; reason: string };

function mockEndpoints(env: NodeJS.ProcessEnv): GoogleEndpoints | null | 'refused' {
  const raw = env.GOOGLE_API_MOCK_BASE?.trim();
  if (!raw) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return 'refused'; }
  if (isProductionRuntime(env) || !isLoopbackHost(u.hostname) || u.protocol !== 'http:') return 'refused';
  const b = u.origin;
  return { auth: `${b}/o/oauth2/v2/auth`, token: `${b}/token`, revoke: `${b}/revoke`, drive: `${b}/drive/v3`, gmail: `${b}/gmail/v1`, calendar: `${b}/calendar/v3`, pickerScript: `${b}/picker/api.js` };
}

export function googleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfigResult {
  const off = (reason: string) => ({ enabled: false as const, reason });
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return off('Propojení s Google není na serveru nastavené.');
  if (!/^[A-Za-z0-9._-]{10,200}$/.test(clientId)) return off('GOOGLE_OAUTH_CLIENT_ID není platné.');
  const serverSecret = env.GOOGLE_SERVER_SECRET?.trim();
  if (!serverSecret || serverSecret.length < 32) return off('GOOGLE_SERVER_SECRET chybí nebo je kratší než 32 znaků.');
  // separate secrets per purpose: the e-mail secret must not double as the Google one
  if (env.EMAIL_SERVER_SECRET && serverSecret === env.EMAIL_SERVER_SECRET.trim()) return off('GOOGLE_SERVER_SECRET se nesmí shodovat s EMAIL_SERVER_SECRET.');
  let keys: KeyRing;
  try {
    const current = keyFromBase64(env.GOOGLE_TOKEN_ENCRYPTION_KEY);
    const previous = env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS?.trim() ? keyFromBase64(env.GOOGLE_TOKEN_ENCRYPTION_KEY_PREVIOUS) : undefined;
    keys = { current, previous };
  } catch {
    return off('GOOGLE_TOKEN_ENCRYPTION_KEY musí být base64 z 32 náhodných bajtů.');
  }
  const pickerApiKey = env.GOOGLE_PICKER_API_KEY?.trim();
  const projectNumber = env.GOOGLE_CLOUD_PROJECT_NUMBER?.trim();
  if (!pickerApiKey || !/^[A-Za-z0-9_-]{10,100}$/.test(pickerApiKey)) return off('GOOGLE_PICKER_API_KEY chybí nebo není platný.');
  if (!projectNumber || !/^[0-9]{4,20}$/.test(projectNumber)) return off('GOOGLE_CLOUD_PROJECT_NUMBER musí být číslo projektu.');
  const base = appBaseUrl(env);
  if (base.error || !base.url) return off(base.error ?? 'APP_BASE_URL není nastaveno.');
  const mock = mockEndpoints(env);
  if (mock === 'refused') return off('GOOGLE_API_MOCK_BASE je povolené jen pro lokální testy (http://127.0.0.1).');
  // RUN 02B regression: a launcher once re-sourced the stack's accounts file over the real secret, so the app sent the MOCK secret to
  // real Google (invalid_client at the token exchange). A mock-format secret is only valid together with the mock provider.
  if (mock === null && secretFormat(clientSecret) === 'mock') return off('GOOGLE_OAUTH_CLIENT_SECRET je zkušební (mock) hodnota, ale Google není v mock režimu.');
  return {
    enabled: true,
    clientId,
    clientSecret,
    serverSecret,
    keys,
    appBaseUrl: base.url,
    redirectUri: `${base.url}/api/google/oauth/callback`,
    pickerApiKey,
    projectNumber,
    endpoints: mock ?? REAL,
    mock: mock !== null,
    pilot: env.GOOGLE_OAUTH_PUBLISHING?.trim() !== 'production',
  };
}
