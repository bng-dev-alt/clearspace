import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { channelAad, notifyConfig, notifyPilotAllows, slackFeatureEnabled, telegramFeatureEnabled, teamHmac, type NotifyConfig } from '../../lib/notify/config';
import { clean, czechDate, pragueDate, renderMessage, slackEscape, type DeliveryItem } from '../../lib/notify/message';
import { classifySlack, classifyTelegram, slackAuthorizeUrl, slackExchange, telegramStarts } from '../../lib/notify/providers';
import { parseItem, schedulerAuthorized, sendBatch } from '../../lib/notify/server';
import { open, seal, keyFromBase64 } from '../../lib/google/crypto';

const KEY = Buffer.alloc(32, 7).toString('base64');
const ENV = {
  NOTIFY_SERVER_SECRET: 'n'.repeat(40), NOTIFY_TOKEN_ENCRYPTION_KEY: KEY, APP_BASE_URL: 'http://127.0.0.1:3471',
  SLACK_CLIENT_ID: '1234.5678', SLACK_CLIENT_SECRET: 'abcdef0123456789', TELEGRAM_BOT_TOKEN: '123456789:AAEabcdefghijklmnopqrstuvwxyz012345', TELEGRAM_BOT_USERNAME: 'clearspace_bot',
} as unknown as NodeJS.ProcessEnv;
const cfgOf = (extra: Record<string, string> = {}) => notifyConfig({ ...ENV, ...extra } as unknown as NodeJS.ProcessEnv) as NotifyConfig;
const item = (o: Partial<DeliveryItem> = {}): DeliveryItem => ({
  id: '00000000-0000-4000-8000-000000000001', provider: 'telegram', channelId: '00000000-0000-4000-8000-0000000000c1', secret: 'x', kind: 'assignment', attempt: 1,
  actor: 'Anna Nováková', title: 'Objednat nábytek', projectName: 'Rekonstrukce kanceláře', projectId: 'p1', cardId: 'k1', dueDate: null, newDue: null, hideTitles: false, ...o,
});

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('config: switches default OFF, fail closed, mocks only on loopback outside production', () => {
  it('switches', () => {
    expect(slackFeatureEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    expect(telegramFeatureEnabled({ TELEGRAM_INTEGRATION_ENABLED: 'true' } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(slackFeatureEnabled({ SLACK_INTEGRATION_ENABLED: ' 1 ' } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });
  it('real endpoints by default; secrets and keys validated', () => {
    const c = cfgOf();
    expect('error' in c).toBe(false);
    expect(c.slack).toMatchObject({ api: 'https://slack.com/api', authorize: 'https://slack.com/oauth/v2/authorize', redirectUri: 'http://127.0.0.1:3471/api/notify/slack/callback', mock: false });
    expect(c.telegram).toMatchObject({ api: 'https://api.telegram.org', botUsername: 'clearspace_bot', mock: false });
    expect(notifyConfig({ ...ENV, NOTIFY_SERVER_SECRET: 'short' } as unknown as NodeJS.ProcessEnv)).toHaveProperty('error');
    expect(notifyConfig({ ...ENV, GOOGLE_SERVER_SECRET: 'n'.repeat(40) } as unknown as NodeJS.ProcessEnv)).toHaveProperty('error');
    expect(notifyConfig({ ...ENV, GOOGLE_TOKEN_ENCRYPTION_KEY: KEY } as unknown as NodeJS.ProcessEnv)).toHaveProperty('error');
    expect(notifyConfig({ ...ENV, NOTIFY_TOKEN_ENCRYPTION_KEY: 'nope' } as unknown as NodeJS.ProcessEnv)).toHaveProperty('error');
    expect(cfgOf({ TELEGRAM_BOT_TOKEN: 'not-a-token' }).telegram).toHaveProperty('error');
    expect(cfgOf({ SLACK_CLIENT_ID: 'x' }).slack).toHaveProperty('error');
  });
  it('mock seams: loopback http only, never in production, mock secrets only with the mock', () => {
    expect(cfgOf({ SLACK_API_MOCK_BASE: 'http://127.0.0.1:55622' }).slack).toMatchObject({ api: 'http://127.0.0.1:55622/slack/api', mock: true });
    expect(cfgOf({ SLACK_API_MOCK_BASE: 'http://evil.example:1' }).slack).toHaveProperty('error');
    expect(cfgOf({ TELEGRAM_API_MOCK_BASE: 'http://127.0.0.1:55622', VERCEL: '1', VERCEL_ENV: 'production', NODE_ENV: 'production', APP_BASE_URL: 'https://clearspace.example' }).telegram).toHaveProperty('error');
    expect(cfgOf({ SLACK_CLIENT_SECRET: 'mock-0123456789abcdef' }).slack).toHaveProperty('error');
    expect(cfgOf({ TELEGRAM_BOT_TOKEN: '100000001:MOCKmockMOCKmockMOCKmockMOCKmock_ab' }).telegram).toHaveProperty('error');
  });
  it('credential envelopes are bound to provider + channel (AAD); team id never stored, only an HMAC', () => {
    const keys = { current: keyFromBase64(KEY) };
    const env = seal(keys, JSON.stringify({ chatId: 7001 }), channelAad('telegram', 'c1'));
    expect(JSON.parse(open(keys, env, channelAad('telegram', 'c1'))).chatId).toBe(7001);
    expect(() => open(keys, env, channelAad('telegram', 'c2'))).toThrow();
    expect(() => open(keys, env, channelAad('slack', 'c1'))).toThrow();
    const h = teamHmac('n'.repeat(40), 'T0MOCK01');
    expect(h).toMatch(/^[0-9a-f]{64}$/); expect(h).not.toContain('T0MOCK01');
  });
});

describe('message: content minimisation, Czech texts, links, injection', () => {
  const now = new Date('2026-12-09T08:00:00Z');
  it('assignment: in-app wording + project + deep link, nothing else', () => {
    expect(renderMessage(item(), 'https://app.example', now)).toBe('Rekonstrukce kanceláře: Anna Nováková vám přiřadil(a) úkol „Objednat nábytek".\nOtevřít: https://app.example/projects/p1?task=k1');
  });
  it('hide titles: type + link only', () => {
    expect(renderMessage(item({ hideTitles: true }), 'https://app.example', now)).toBe('Byl vám přiřazen úkol.\nOtevřít: https://app.example/projects/p1?task=k1');
  });
  it('project removed: no link; membership texts without a project line', () => {
    const t = renderMessage(item({ kind: 'project_removed', title: 'Rekonstrukce kanceláře', cardId: null }), 'https://app.example', now);
    expect(t).toBe('Anna Nováková vás odebral(a) z projektu „Rekonstrukce kanceláře".');
  });
  it('due soon: Zítra / Dnes by the Prague calendar day (also right after midnight and across DST)', () => {
    expect(renderMessage(item({ kind: 'due_soon', dueDate: '2026-12-10' }), 'https://a.b', now)).toContain('Zítra (10. 12. 2026) je termín úkolu „Objednat nábytek".');
    expect(renderMessage(item({ kind: 'due_soon', dueDate: '2026-12-10' }), 'https://a.b', new Date('2026-12-09T23:30:00Z'))).toContain('Dnes (10. 12. 2026)');
    expect(pragueDate(new Date('2027-03-27T23:30:00Z'))).toBe('2027-03-28');
    expect(pragueDate(new Date('2027-10-30T22:30:00Z'))).toBe('2027-10-31');
    expect(czechDate('2027-03-29')).toBe('29. 3. 2027');
  });
  it('task changes', () => {
    expect(renderMessage(item({ kind: 'task_due_changed', newDue: '2026-12-22' }), 'https://a.b', now)).toContain('Anna Nováková změnil(a) termín vašeho úkolu „Objednat nábytek" na 22. 12. 2026.');
    expect(renderMessage(item({ kind: 'task_due_changed', newDue: null }), 'https://a.b', now)).toContain('odebral(a) termín');
    expect(renderMessage(item({ kind: 'task_completed' }), 'https://a.b', now)).toContain('označil(a) váš úkol „Objednat nábytek" jako hotový.');
  });
  it('untrusted text: no control / bidi / zero-width characters, bounded, Slack markup escaped', () => {
    expect(clean('a\u0007b‮c​d\n\te')).toBe('a b c d e');
    expect(clean('x'.repeat(300)).length).toBe(200);
    expect(slackEscape('<!channel> & <@U1> <https://e.x|k>')).toBe('&lt;!channel&gt; &amp; &lt;@U1&gt; &lt;https://e.x|k&gt;');
  });
});

describe('provider error classification', () => {
  it('Slack', () => {
    expect(classifySlack(200, { ok: true }, null)).toEqual({ outcome: 'sent' });
    expect(classifySlack(429, null, '17')).toEqual({ outcome: 'retry', code: 'slack_rate_limited', retryAfter: 17 });
    expect(classifySlack(503, null, null).outcome).toBe('retry');
    for (const e of ['invalid_auth', 'account_inactive', 'token_revoked', 'channel_not_found', 'missing_scope']) expect(classifySlack(200, { ok: false, error: e }, null).outcome).toBe('reconnect');
    expect(classifySlack(200, { ok: false, error: 'msg_too_long' }, null)).toEqual({ outcome: 'failed', code: 'slack_msg_too_long' });
    expect(classifySlack(200, { ok: false, error: 'Bearer xoxb-123 <script>' }, null).outcome).toBe('failed');
    expect((classifySlack(200, { ok: false, error: 'Bearer xoxb-123 <script>' }, null) as { code: string }).code).toMatch(/^[a-z0-9_]+$/);
  });
  it('Telegram', () => {
    expect(classifyTelegram(200, { ok: true })).toEqual({ outcome: 'sent' });
    expect(classifyTelegram(429, { ok: false, parameters: { retry_after: 9 } })).toEqual({ outcome: 'retry', code: 'telegram_rate_limited', retryAfter: 9 });
    expect(classifyTelegram(403, { ok: false, description: 'Forbidden: bot was blocked by the user' })).toEqual({ outcome: 'blocked', code: 'telegram_blocked' });
    expect(classifyTelegram(400, { ok: false, description: 'Bad Request: chat not found' }).outcome).toBe('reconnect');
    expect(classifyTelegram(401, { ok: false }).outcome).toBe('retry');            // bot token = server config, never the user's channel
    expect(classifyTelegram(502, null).outcome).toBe('retry');
    expect(classifyTelegram(400, { ok: false, description: 'message is too long' }).outcome).toBe('failed');
  });
});

describe('Slack OAuth: least privilege, refuses anything else', () => {
  const slack = (cfgOf().slack as Exclude<NotifyConfig['slack'], { error: string }>);
  const good = { ok: true, token_type: 'bot', access_token: 'xoxb-1234-5678-abcdefghij', scope: 'chat:write', team: { id: 'T0ABC', name: 'Tým' }, authed_user: { id: 'U0ABC' } };
  const answer = (b: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(b), { status: 200 })));
  it('authorize URL asks for chat:write only, no user scope', () => {
    const u = new URL(slackAuthorizeUrl(slack, 's'.repeat(43)));
    expect(u.searchParams.get('scope')).toBe('chat:write'); expect(u.searchParams.has('user_scope')).toBe(false);
  });
  it('accepts a plain bot grant', async () => {
    answer(good);
    expect(await slackExchange(slack, 'c')).toMatchObject({ ok: true, grant: { userId: 'U0ABC', teamId: 'T0ABC' } });
  });
  it.each([
    ['extra scope', { ...good, scope: 'chat:write,channels:read' }, 'scope'],
    ['user token', { ...good, authed_user: { id: 'U0ABC', access_token: 'xoxp-1' } }, 'error'],
    ['not a bot token', { ...good, token_type: 'user' }, 'error'],
    ['enterprise install', { ...good, is_enterprise_install: true, team: null }, 'unsupported'],
    ['used code', { ok: false, error: 'invalid_code' }, 'expired'],
  ])('refuses %s', async (_n, body, reason) => {
    answer(body);
    expect(await slackExchange(slack, 'c')).toEqual({ ok: false, reason });
  });
});

describe('Telegram /start parsing (getUpdates, no webhook)', () => {
  it('private chats only, token format enforced, confirms the offset', async () => {
    const calls: Array<{ url: string; body: { offset?: number } }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ ok: true, result: calls.length > 1 ? [] : [
        { update_id: 5, message: { text: `/start ${'a'.repeat(43)}`, chat: { id: 7001, type: 'private' }, from: { first_name: 'Eva', username: 'eva' } } },
        { update_id: 6, message: { text: `/start ${'a'.repeat(43)}`, chat: { id: -100, type: 'group' }, from: { first_name: 'G' } } },
        { update_id: 7, message: { text: '/start ../../etc', chat: { id: 7002, type: 'private' }, from: { first_name: 'X' } } },
        { update_id: 8, message: { text: 'ahoj', chat: { id: 7003, type: 'private' }, from: { first_name: 'Y' } } },
        { update_id: 9, message: { text: `/start ${'b'.repeat(43)}`, chat: { id: 7004, type: 'private' }, from: { first_name: 'Bot', is_bot: true } } },
      ] }), { status: 200 });
    }));
    const r = await telegramStarts({ api: 'https://api.telegram.org', botToken: '1:x' });
    expect(r).toEqual({ ok: true, starts: [
      { updateId: 5, chatId: 7001, token: 'a'.repeat(43), label: 'Eva (@eva)' },
      { updateId: 7, chatId: 7002, token: null, label: 'X' },
    ] });
    expect(calls[1].body.offset).toBe(10);
  });
});

describe('dispatcher batch: validation, provider switch, spacing, rate limit, dead channel, budget', () => {
  it('scheduler secret compared in constant time over SHA-256', () => {
    expect(schedulerAuthorized('n'.repeat(40), { serverSecret: 'n'.repeat(40) })).toBe(true);
    expect(schedulerAuthorized('n'.repeat(39), { serverSecret: 'n'.repeat(40) })).toBe(false);
    expect(schedulerAuthorized(null, { serverSecret: 'n'.repeat(40) })).toBe(false);
  });
  it('parseItem accepts only well-formed items', () => {
    expect(parseItem({ ...item(), secret: 'v1.x' })).not.toBeNull();
    expect(parseItem({ ...item(), id: 'nope' })).toBeNull();
    expect(parseItem({ ...item(), kind: 'chat' })).toBeNull();
    expect(parseItem({ ...item(), provider: 'email' })).toBeNull();
    expect(parseItem({ ...item(), dueDate: 'zítra' })?.dueDate).toBeNull();
  });
  it('sends sequentially, >= 1.1 s apart per channel; 429 releases the rest of that channel; blocked cancels it; switch off cancels', async () => {
    vi.stubEnv('TELEGRAM_INTEGRATION_ENABLED', '1'); vi.stubEnv('SLACK_INTEGRATION_ENABLED', '');
    const c = cfgOf();
    const sealFor = (ch: string, chatId: number) => seal(c.keys, JSON.stringify({ chatId }), channelAad('telegram', ch));
    const A = '00000000-0000-4000-8000-0000000000aa', B = '00000000-0000-4000-8000-0000000000bb', C = '00000000-0000-4000-8000-0000000000cc';
    const its = [
      item({ id: '00000000-0000-4000-8000-000000000001', channelId: A, secret: sealFor(A, 1) }),
      item({ id: '00000000-0000-4000-8000-000000000002', channelId: A, secret: sealFor(A, 1) }),
      item({ id: '00000000-0000-4000-8000-000000000003', channelId: B, secret: sealFor(B, 2) }),
      item({ id: '00000000-0000-4000-8000-000000000004', channelId: B, secret: sealFor(B, 2) }),
      item({ id: '00000000-0000-4000-8000-000000000005', channelId: C, secret: sealFor(C, 3) }),
      item({ id: '00000000-0000-4000-8000-000000000006', channelId: C, secret: sealFor(C, 3) }),
      item({ id: '00000000-0000-4000-8000-000000000007', provider: 'slack', channelId: A, secret: 'x' }),
      item({ id: '00000000-0000-4000-8000-000000000008', channelId: A, secret: sealFor(B, 1) }),   // envelope of another channel
    ];
    let clock = 0;
    const sleeps: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
      const chat = JSON.parse(String(init.body)).chat_id;
      clock += 100;
      if (chat === 2) return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 30 } }), { status: 429 });
      if (chat === 3) return new Response(JSON.stringify({ ok: false, description: 'Forbidden: bot was blocked by the user' }), { status: 403 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    const res = await sendBatch(c, its, new Date(), { clock: () => clock, sleep: async (ms) => { sleeps.push(ms); clock += ms; } });
    expect(res.map((r) => `${r.outcome}:${r.code ?? ''}`)).toEqual([
      'sent:', 'sent:', 'retry:telegram_rate_limited', 'release:rate_limited', 'blocked:telegram_blocked', 'cancelled:channel_inactive',
      'cancelled:provider_disabled', 'reconnect:undecryptable']);
    expect(sleeps[0]).toBe(1100);   // the 2nd message to channel A waited the full gap; other channels never waited for A
    expect(sleeps.every((ms) => ms > 0 && ms <= 1100)).toBe(true);
    expect(res[3].retryAfter).toBe(30);
  });
  it('time budget: the rest is released, not dropped', async () => {
    vi.stubEnv('TELEGRAM_INTEGRATION_ENABLED', '1');
    const c = cfgOf();
    let clock = 0;
    vi.stubGlobal('fetch', vi.fn(async () => { clock += 46_000; return new Response(JSON.stringify({ ok: true }), { status: 200 }); }));
    const ch = '00000000-0000-4000-8000-0000000000dd';
    const env = seal(c.keys, JSON.stringify({ chatId: 9 }), channelAad('telegram', ch));
    const res = await sendBatch(c, [item({ channelId: ch, secret: env }), item({ id: '00000000-0000-4000-8000-000000000002', channelId: ch, secret: env })], new Date(), { clock: () => clock, sleep: async () => {} });
    expect(res.map((r) => r.outcome)).toEqual(['sent', 'release']);
  });
});

describe('no notify secret, token or provider host can reach the client bundle', () => {
  it('client code never imports the server modules', () => {
    for (const f of ['src/components/notify/NotificationChannelsCard.tsx', 'src/services/notifyService.ts']) {
      const s = readFileSync(f, 'utf8');
      expect(s).not.toMatch(/lib\/notify\/(server|providers|config)|lib\/google\/crypto|api\.telegram\.org|slack\.com\/api|NOTIFY_SERVER|NOTIFY_TOKEN|SLACK_CLIENT|TELEGRAM_BOT/);
    }
  });
});

describe('RUN 09 pilot allowlist (NOTIFY_PILOT_USER_IDS)', () => {
  it('unset -> everyone; set -> only listed accounts (case-insensitive, spaces ignored)', () => {
    const env = { NOTIFY_PILOT_USER_IDS: ' AAAA-1 , bbbb-2 ' } as unknown as NodeJS.ProcessEnv;
    expect(notifyPilotAllows('x', {} as NodeJS.ProcessEnv)).toBe(true);
    expect(notifyPilotAllows('aaaa-1', env)).toBe(true);
    expect(notifyPilotAllows('BBBB-2', env)).toBe(true);
    expect(notifyPilotAllows('cccc-3', env)).toBe(false);
  });
  it('every signed-in notify route authenticates through the pilot gate', () => {
    const root = join(__dirname, '../../app/api/notify');
    const routes = (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('route.ts')).map((f) => readFileSync(join(root, f), 'utf8'));
    const signedIn = routes.filter((src) => src.includes("headers.get('authorization')"));
    expect(signedIn.length).toBe(9);
    for (const src of signedIn) { expect(src).toContain('notifyCaller('); expect(src).not.toContain('authenticateCaller('); }
  });
});
