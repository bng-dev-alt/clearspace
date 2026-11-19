import type { APIRequestContext } from '@playwright/test';

/**
 * Owner-only mode (AI_OWNER_USER_IDS on the app under test): the owner account must have the FIXED id the server was started with.
 * Deleted if it exists, then created through the local GoTrue admin API with the local service key; returns a normal password login token.
 */
export async function ensureFixedOwner(request: APIRequestContext, o: { sb: string; anon: string; service: string; id: string; email: string; password: string }) {
  const h = { apikey: o.service, Authorization: `Bearer ${o.service}`, 'Content-Type': 'application/json' };
  // Start every spec from a CLEAN owner (the account is fixed, so a previous run's projects, meetings and ledger rows would otherwise leak into the assertions).
  await request.fetch(`${o.sb}/auth/v1/admin/users/${o.id}`, { method: 'DELETE', headers: h });
  const made = await request.fetch(`${o.sb}/auth/v1/admin/users`, { method: 'POST', headers: h, data: JSON.stringify({ id: o.id, email: o.email, password: o.password, email_confirm: true }) });
  if (made.status() !== 200) {
    const upd = await request.fetch(`${o.sb}/auth/v1/admin/users/${o.id}`, { method: 'PUT', headers: h, data: JSON.stringify({ password: o.password, email_confirm: true }) });
    if (upd.status() !== 200) throw new Error(`cannot create/reset the fixed owner: ${made.status()} ${upd.status()}`);
  }
  const login = await request.fetch(`${o.sb}/auth/v1/token?grant_type=password`, { method: 'POST', headers: { apikey: o.anon, 'Content-Type': 'application/json' }, data: JSON.stringify({ email: o.email, password: o.password }) });
  const j = (await login.json()) as { access_token?: string; user?: { id: string } };
  if (!j.access_token || j.user?.id !== o.id) throw new Error('owner login failed or the id differs from the fixed owner id');
  return { id: o.id, token: j.access_token };
}
