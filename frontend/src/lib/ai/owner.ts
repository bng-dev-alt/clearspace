/**
 * Owner-only přístup k AI a přepisu (server). Rozhoduje se na serveru po ověření JWT, podle `user.id` (neměnné UUID, ne e-mail).
 *   AI_OWNER_USER_IDS=<uuid>[,<uuid>...]   jediní uživatelé, kterým AI/STT cesty odpoví; ostatní dostanou 403 `ai_owner_only`
 *                                          ještě před jakýmkoli čtením dat, rezervací kvóty nebo voláním poskytovatele.
 * Nenastaveno = AI zavřená pro všechny (fail closed). Výjimka jen pro lokální vývoj a testy: AI_ALLOW_ALL_AUTHENTICATED=1
 * (každý přihlášený); na produkčním nasazení Vercelu (VERCEL_ENV=production) se ignoruje, takže ho nelze otevřít omylem.
 * Klientské příznaky (NEXT_PUBLIC_*) jsou jen UX, nikdy oprávnění.
 */
type Env = Record<string, string | undefined>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function aiOwnerIds(env: Env = process.env): Set<string> {
  return new Set((env.AI_OWNER_USER_IDS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)));
}

export function aiAccessAllowed(userId: string, env: Env = process.env): boolean {
  const owners = aiOwnerIds(env);
  if (owners.size > 0) return owners.has(userId.toLowerCase());
  return env.AI_ALLOW_ALL_AUTHENTICATED === '1' && env.VERCEL_ENV !== 'production';
}
