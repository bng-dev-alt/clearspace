/**
 * Transactional e-mail configuration (RUN 01B). Server-only: nothing here may reach the client bundle
 * (no NEXT_PUBLIC_*). Unconfigured = e-mail is OFF and the app falls back to copy-the-link.
 *
 *   EMAIL_TRANSPORT=smtp | disabled (default disabled)
 *   SMTP_HOST, SMTP_PORT (587), SMTP_SECURITY=starttls | tls | none, SMTP_USER, SMTP_PASSWORD
 *   EMAIL_FROM="ClearSpace <pozvanky@vase-domena.cz>", EMAIL_REPLY_TO (optional)
 *   APP_BASE_URL=https://clearspace-ai.vercel.app  -- invitation links are built ONLY from this, never from
 *                                                     the request's Host header (no host-header injection)
 *   EMAIL_SERVER_SECRET                            -- >= 32 chars; its SHA-256 is registered in server_trust('email')
 *   EMAIL_ALLOW_RESERVED_DOMAINS=1                 -- honoured ONLY with a loopback SMTP host (local capture)
 */
export interface EmailConfig {
  enabled: boolean;
  reason?: string;
  smtp?: {
    host: string;
    port: number;
    security: 'starttls' | 'tls' | 'none';
    user?: string;
    password?: string;
  };
  from?: string;
  replyTo?: string;
  appBaseUrl?: string;
  serverSecret?: string;
  allowReserved: boolean;
}

const LOOPBACK = /^(127\.0\.0\.1|localhost|::1|\[::1\])$/i;

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.test(host.trim());
}

export function isProductionRuntime(env: NodeJS.ProcessEnv): boolean {
  return env.VERCEL_ENV === 'production' || (env.NODE_ENV === 'production' && Boolean(env.VERCEL));
}

/** Validated base URL for links: https in production, never a loopback/private host there. */
export function appBaseUrl(env: NodeJS.ProcessEnv = process.env): { url?: string; error?: string } {
  const raw = env.APP_BASE_URL?.trim();
  if (!raw) return { error: 'APP_BASE_URL není nastaveno.' };
  let u: URL;
  try { u = new URL(raw); } catch { return { error: 'APP_BASE_URL není platná adresa.' }; }
  if (u.username || u.password || u.search || u.hash) return { error: 'APP_BASE_URL nesmí obsahovat přihlašovací údaje, dotaz ani kotvu.' };
  const loopback = isLoopbackHost(u.hostname);
  if (isProductionRuntime(env)) {
    if (u.protocol !== 'https:' || loopback) return { error: 'V produkci musí být APP_BASE_URL veřejná adresa https.' };
  } else if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) {
    return { error: 'APP_BASE_URL musí být https (http jen pro 127.0.0.1/localhost).' };
  }
  return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

export function emailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const allowReservedRequested = env.EMAIL_ALLOW_RESERVED_DOMAINS === '1';
  if ((env.EMAIL_TRANSPORT ?? 'disabled') !== 'smtp') {
    return { enabled: false, reason: 'Odesílání e-mailů není nastavené.', allowReserved: false };
  }
  const host = env.SMTP_HOST?.trim();
  const port = Number(env.SMTP_PORT || 587);
  const security = (env.SMTP_SECURITY || 'starttls') as 'starttls' | 'tls' | 'none';
  const from = env.EMAIL_FROM?.trim();
  const base = appBaseUrl(env);
  const secret = env.EMAIL_SERVER_SECRET?.trim();
  const fail = (reason: string): EmailConfig => ({ enabled: false, reason, allowReserved: false });
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return fail('SMTP_HOST/SMTP_PORT nejsou nastavené správně.');
  if (!['starttls', 'tls', 'none'].includes(security)) return fail('SMTP_SECURITY musí být starttls, tls nebo none.');
  // Unencrypted SMTP only to a local capture server (Mailpit); never credentials in clear text over a network.
  if (security === 'none' && !isLoopbackHost(host)) return fail('Nešifrované SMTP je povolené jen pro lokální zachytávání (127.0.0.1).');
  if (!from || !/<[^@\s<>]+@[^@\s<>]+>$|^[^@\s<>]+@[^@\s<>]+$/.test(from)) return fail('EMAIL_FROM není platná adresa odesílatele.');
  if (base.error) return fail(base.error);
  if (!secret || secret.length < 32) return fail('EMAIL_SERVER_SECRET chybí nebo je kratší než 32 znaků.');
  return {
    enabled: true,
    smtp: { host, port, security, user: env.SMTP_USER || undefined, password: env.SMTP_PASSWORD || undefined },
    from,
    replyTo: env.EMAIL_REPLY_TO?.trim() || undefined,
    appBaseUrl: base.url,
    serverSecret: secret,
    // reserved/fictional domains may be delivered ONLY into a local capture server
    allowReserved: allowReservedRequested && isLoopbackHost(host) && !isProductionRuntime(env),
  };
}

/**
 * Reserved / fictional destinations (RFC 2606, RFC 6761, the RUN 00 demo dataset's example.* addresses):
 * never sent to a real mail server.
 */
export function isReservedRecipient(email: string): boolean {
  const domain = email.trim().toLowerCase().split('@')[1] ?? '';
  if (!domain) return true;
  return /^(example\.(com|net|org)|.*\.example\.(com|net|org))$/.test(domain)
    || /(^|\.)(example|test|invalid|localhost|local)$/.test(domain);
}
