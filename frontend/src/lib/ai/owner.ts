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

export function aiDemoIds(env: Env = process.env): Set<string> {
  return new Set((env.AI_DEMO_USER_IDS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => UUID.test(s)));
}

/**
 * Úroveň (tier) ověřeného uživatele, rozhodnutá JEN na serveru podle neměnného `user.id` ze serverem ověřeného JWT:
 *   owner = AI_OWNER_USER_IDS; demo = AI_DEMO_USER_IDS (výslovný seznam); null = AI zavřená (fail closed).
 * Id na obou seznamech je chyba konfigurace a dostane NEJPŘÍSNĚJŠÍ úroveň (demo). 'dev' = jen lokální AI_ALLOW_ALL_AUTHENTICATED (na produkci ignorováno).
 * Žádný e-mail, claim, hlavička ani parametr požadavku úroveň nemění.
 */
export type AiTier = 'owner' | 'demo' | 'dev';
export function aiTier(userId: string, env: Env = process.env): AiTier | null {
  const id = userId.toLowerCase();
  if (aiDemoIds(env).has(id)) return 'demo';
  const owners = aiOwnerIds(env);
  if (owners.has(id)) return 'owner';
  if (owners.size === 0 && aiDemoIds(env).size === 0 && env.AI_ALLOW_ALL_AUTHENTICATED === '1' && env.VERCEL_ENV !== 'production') return 'dev';
  return null;
}

export function aiAccessAllowed(userId: string, env: Env = process.env): boolean {
  return aiTier(userId, env) !== null;
}
