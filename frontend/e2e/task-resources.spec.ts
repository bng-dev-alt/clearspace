import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

/**
 * Task attachments (Task Detail -> Resources) end to end against a THROWAWAY local Supabase stack: real GoTrue, PostgREST, RLS and Storage
 * with the real bucket migration (private, 10 MiB, MIME allow-list, membership policies). Synthetic files only, no provider, no keys.
 * Covers upload / signed download / deletion for every advertised type, the distinct refusal messages, and access isolation.
 */
const SB = process.env.E2E_SUPABASE_URL;
const ANON = process.env.E2E_SUPABASE_ANON_KEY ?? '';
test.skip(!SB, 'needs E2E_SUPABASE_URL (isolated local stack)');
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const PASSWORD = 'Test-Password-123';
const PA = `tr-a-${run}`;
const emailA = `tr-a-${run}@example.test`, emailB = `tr-b-${run}@example.test`;
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const FILES: [string, string, Buffer][] = [
  ['synthetic.pdf', 'application/pdf', PDF],
  ['synthetic.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(60, 1)])],
  ['synthetic.png', 'image/png', PNG],
  ['synthetic.jpg', 'image/jpeg', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2), Buffer.from([0xff, 0xd9])])],
  ['synthetic.md', 'text/markdown', Buffer.from('# synthetic\n')],
  ['synthetic.csv', 'text/csv', Buffer.from('a,b\n1,2\n')],
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
async function sb(request: APIRequestContext, path: string, opts: { method?: string; token?: string; data?: unknown; headers?: Record<string, string> } = {}) {
  const res = await request.fetch(`${SB}${path}`, { method: opts.method ?? 'GET', headers: { apikey: ANON, Authorization: `Bearer ${opts.token ?? ANON}`, 'Content-Type': 'application/json', ...opts.headers }, data: opts.data === undefined ? undefined : JSON.stringify(opts.data) });
  const text = await res.text(); let json: J = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status(), json };
}
async function signUp(request: APIRequestContext, email: string) {
  const r = await sb(request, '/auth/v1/signup', { method: 'POST', data: { email, password: PASSWORD } });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return { id: r.json.user.id as string, token: r.json.access_token as string };
}
async function loginUi(page: Page, email: string) {
  await page.goto('/login');
  await page.getByPlaceholder('jmeno@firma.cz').fill(email);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.getByRole('button', { name: 'Přihlásit se' }).click();
  await expect(page).toHaveURL(/\/$/);
}
const putRaw = (request: APIRequestContext, token: string, path: string, type: string, body: Buffer) =>
  request.post(`${SB}/storage/v1/object/task-resources/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': type }, data: body });
const objects = async (request: APIRequestContext, token: string, card: string) =>
  (await request.post(`${SB}/storage/v1/object/list/task-resources`, { headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, data: { prefix: `tasks/${card}` } }).then((r) => r.json())) as { name: string }[];

let A: { id: string; token: string }, B: { id: string; token: string };
const CARD = `card-tr-${run}`;

async function openCard(page: Page, cardId: string) {
  await page.goto(`/projects/${PA}`);
  await page.getByTestId(`card-${cardId}`).click();
  await expect(page.getByTestId('task-resources-section')).toBeVisible();
}

test.beforeAll(async ({ request }) => {
  A = await signUp(request, emailA); B = await signUp(request, emailB);
  expect((await sb(request, '/rest/v1/projects', { method: 'POST', token: A.token, headers: { Prefer: 'return=minimal' }, data: { id: PA, name: 'Soubory' } })).status).toBe(201);
  await sb(request, '/rest/v1/columns', { method: 'POST', token: A.token, data: [{ id: `${PA}-c`, project_id: PA, name: 'K řešení', position: 0 }] });
  expect((await sb(request, '/rest/v1/cards', { method: 'POST', token: A.token, headers: { Prefer: 'return=minimal' }, data: { id: CARD, column_id: `${PA}-c`, title: 'Karta se soubory', position: 0 } })).status).toBe(201);
});

test('every advertised type uploads through the UI, is listed, and downloads back byte for byte through its signed link', async ({ page, request }) => {
  await loginUi(page, emailA);
  await openCard(page, CARD);
  for (const [name, mimeType, buffer] of FILES) {
    await page.getByTestId('resource-file-input').setInputFiles({ name, mimeType, buffer });
    await expect(page.getByTestId('task-resources-section').getByText(name)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('resource-upload-error')).toHaveCount(0);
  }
  const rows = (await sb(request, `/rest/v1/task_resources?task_id=eq.${CARD}&select=id,filename,mime_type,size,storage_path`, { token: A.token })).json as J[];
  expect(rows.map((r) => r.filename).sort()).toEqual(FILES.map((f) => f[0]).sort());
  expect((await objects(request, A.token, CARD)).length).toBe(FILES.length);
  // reload: the list comes back with fresh signed links; the PDF link serves the same bytes
  await openCard(page, CARD);
  const pdfRow = rows.find((r) => r.filename === 'synthetic.pdf');
  const href = await page.getByTestId(`download-resource-${pdfRow.id}`).getAttribute('href');
  const dl = await request.get(href!);
  expect(dl.status()).toBe(200);
  expect(Buffer.compare(await dl.body(), PDF)).toBe(0);
});

test('a file with an EMPTY browser type is accepted by extension (Markdown / CSV on browsers that report no type)', async ({ page, request }) => {
  await loginUi(page, emailA);
  await openCard(page, CARD);
  await page.getByTestId('resource-file-input').setInputFiles({ name: 'no-type.md', mimeType: '', buffer: Buffer.from('# bez typu\n') });
  await expect(page.getByTestId('task-resources-section').getByText('no-type.md')).toBeVisible({ timeout: 15_000 });
  const r = (await sb(request, `/rest/v1/task_resources?task_id=eq.${CARD}&filename=eq.no-type.md&select=mime_type`, { token: A.token })).json;
  expect(r[0].mime_type).toBe('text/markdown');
});

test('refusals are distinguishable: too large, wrong type, empty; nothing is sent or stored; the other files still upload', async ({ page, request }) => {
  await loginUi(page, emailA);
  await openCard(page, CARD);
  const before = (await objects(request, A.token, CARD)).length;
  await page.getByTestId('resource-file-input').setInputFiles([
    { name: 'huge.pdf', mimeType: 'application/pdf', buffer: Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]) },
    { name: 'script.html', mimeType: 'text/html', buffer: Buffer.from('<script>1</script>') },
    { name: 'empty.pdf', mimeType: 'application/pdf', buffer: Buffer.alloc(0) },
    { name: 'fine.pdf', mimeType: 'application/pdf', buffer: PDF },
  ]);
  const err = page.getByTestId('resource-upload-error');
  await expect(err).toContainText('huge.pdf: Soubor je větší než 10 MB.');
  await expect(err).toContainText('script.html: Tento typ souboru není povolený');
  await expect(err).toContainText('empty.pdf: Soubor je prázdný.');
  await expect(err).not.toContainText('fine.pdf');
  await expect(page.getByTestId('task-resources-section').getByText('fine.pdf')).toBeVisible();
  expect((await objects(request, A.token, CARD)).length).toBe(before + 1);
});

test('the SERVER also refuses (a client that skips the checks): oversize, HTML and a non-member', async ({ request }) => {
  const big = await putRaw(request, A.token, `tasks/${CARD}/big-${run}.pdf`, 'application/pdf', Buffer.concat([PDF, Buffer.alloc(10 * 1024 * 1024)]));
  expect(big.status()).toBeGreaterThanOrEqual(400);
  expect((await putRaw(request, A.token, `tasks/${CARD}/x-${run}.html`, 'text/html', Buffer.from('<script>1</script>'))).status()).toBeGreaterThanOrEqual(400);
  const foreign = await putRaw(request, B.token, `tasks/${CARD}/evil-${run}.pdf`, 'application/pdf', PDF);
  expect(foreign.status()).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(await foreign.json())).toMatch(/row-level security|Unauthorized/); // permission, not size/type
  const anon = await request.post(`${SB}/storage/v1/object/task-resources/tasks/${CARD}/anon-${run}.pdf`, { headers: { apikey: ANON, 'Content-Type': 'application/pdf' }, data: PDF });
  expect(anon.status()).toBeGreaterThanOrEqual(400);
});

test('ISOLATION: a stranger cannot list, read, sign, delete or see the metadata of the card\'s files', async ({ request }) => {
  const names = (await objects(request, A.token, CARD)).map((o) => o.name);
  expect(names.length).toBeGreaterThan(0);
  expect((await objects(request, B.token, CARD)).length).toBe(0);
  const path = `tasks/${CARD}/${names[0]}`;
  expect((await request.get(`${SB}/storage/v1/object/authenticated/task-resources/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${B.token}` } })).status()).toBeGreaterThanOrEqual(400);
  expect((await request.post(`${SB}/storage/v1/object/sign/task-resources/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${B.token}`, 'Content-Type': 'application/json' }, data: { expiresIn: 60 } })).status()).toBeGreaterThanOrEqual(400);
  expect((await request.get(`${SB}/storage/v1/object/public/task-resources/${path}`)).status()).toBeGreaterThanOrEqual(400);
  await request.delete(`${SB}/storage/v1/object/task-resources/${path}`, { headers: { apikey: ANON, Authorization: `Bearer ${B.token}` } });
  expect((await objects(request, A.token, CARD)).map((o) => o.name)).toContain(names[0]); // still there
  expect((await sb(request, `/rest/v1/task_resources?task_id=eq.${CARD}&select=id`, { token: B.token })).json).toEqual([]);
});

test('a card that is NOT saved on the server yet gets its own message (not a generic failure, not "no permission")', async ({ page, request }) => {
  await loginUi(page, emailA);
  await page.goto(`/projects/${PA}`);
  await page.route('**/rest/v1/cards*', (route) => (route.request().method() === 'POST' ? route.abort() : route.continue())); // the create call never reaches the DB
  await page.locator('[data-testid^="add-card-btn-"]').first().click();
  const modal = page.getByRole('dialog');
  await modal.locator('#card-title').fill('Neuložená karta');
  await modal.locator('button[type="submit"]').click();
  await page.getByText('Neuložená karta').first().click();
  await page.getByTestId('resource-file-input').setInputFiles({ name: 'a.pdf', mimeType: 'application/pdf', buffer: PDF });
  await expect(page.getByTestId('resource-upload-error')).toContainText('a.pdf: Úkol ještě není uložený na serveru');
  expect((await sb(request, `/rest/v1/task_resources?filename=eq.a.pdf&select=id`, { token: A.token })).json).toEqual([]);
});

test('deletion removes the Storage object AND the metadata row; the other files stay', async ({ page, request }) => {
  await loginUi(page, emailA);
  await openCard(page, CARD);
  const rows = (await sb(request, `/rest/v1/task_resources?task_id=eq.${CARD}&filename=eq.synthetic.csv&select=id,storage_path`, { token: A.token })).json as J[];
  const total = (await objects(request, A.token, CARD)).length;
  page.once('dialog', (d) => d.accept());
  await page.getByTestId(`delete-resource-${rows[0].id}`).click();
  await expect(page.getByTestId(`resource-item-${rows[0].id}`)).toHaveCount(0);
  expect((await sb(request, `/rest/v1/task_resources?id=eq.${rows[0].id}&select=id`, { token: A.token })).json).toEqual([]);
  const left = (await objects(request, A.token, CARD)).map((o) => o.name);
  expect(left.length).toBe(total - 1);
  expect(left).not.toContain(rows[0].storage_path.split('/').pop());
});
