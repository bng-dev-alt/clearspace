import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { isLoopbackHost } from './devLogin';

/**
 * LOCAL DEVELOPMENT AUTO-LOGIN (docs/LOCAL_DEV.md). Loaded ONLY from a development build: AuthContext imports this module behind
 * `process.env.NODE_ENV === 'development'`, a build-time constant, so a production bundle contains neither this code nor the route URL
 * (scripts/check-production-bundle.sh fails on 'api/dev/login' / 'clearspace-dev-autologin').
 * It never bypasses authentication: the server signs the synthetic dev identity in against the ISOLATED local GoTrue with a normal
 * password grant (route /api/dev/login, marker 'auto', guards in lib/devLogin.ts) and the browser receives an ordinary JWT session,
 * so RLS, memberships and the owner gate behave exactly as for any user.
 */
export const AUTO_OFF_KEY = 'clearspace-dev-autologin-off';

export interface AutoLoginInput {
  flag: string | undefined; // NEXT_PUBLIC_DEV_AUTO_LOGIN
  pageHost: string; // window.location.host
  supabaseUrl: string | undefined; // NEXT_PUBLIC_SUPABASE_URL
  optedOut: boolean; // explicit-login mode for this tab (after a logout, or ?login=manual)
}

/** Client-side guards (the server repeats its own, stricter ones). */
export function autoLoginAllowed(i: AutoLoginInput): boolean {
  if (i.flag !== '1' || i.optedOut || !isLoopbackHost(i.pageHost)) return false;
  try {
    return isLoopbackHost(new URL(i.supabaseUrl ?? '').host);
  } catch {
    return false;
  }
}

function optedOut(): boolean {
  const q = new URLSearchParams(window.location.search);
  if (q.get('login') === 'manual') sessionStorage.setItem(AUTO_OFF_KEY, '1');
  if (q.get('login') === 'auto') sessionStorage.removeItem(AUTO_OFF_KEY);
  return sessionStorage.getItem(AUTO_OFF_KEY) === '1';
}

/** Explicit-login mode for this tab: called on logout so logout / login / registration stay testable. */
export function disableAutoLoginForTab(): void {
  sessionStorage.setItem(AUTO_OFF_KEY, '1');
}

/**
 * Returns a valid session: the stored one if the local Auth still accepts it, otherwise a fresh one for the dev identity.
 * Returns the input unchanged when auto-login is not allowed here, or null when the server refuses (then the normal login page shows).
 */
export async function ensureDevSession(supabase: SupabaseClient, current: Session | null): Promise<Session | null> {
  if (!autoLoginAllowed({ flag: process.env.NEXT_PUBLIC_DEV_AUTO_LOGIN, pageHost: window.location.host, supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL, optedOut: optedOut() })) {
    return current;
  }
  if (current) {
    const { error } = await supabase.auth.getUser(); // a reset local stack leaves a dead token behind: replace it
    if (!error) return current;
    await supabase.auth.signOut({ scope: 'local' });
  }
  const res = await fetch('/api/dev/login', { method: 'POST', headers: { 'x-clearspace-dev-login': 'auto' } }).catch(() => null);
  if (!res || !res.ok) {
    console.warn('[dev-auto-login] refused by the server (see the dev server log: "[dev-login] refused: ..."); showing the login page');
    return null;
  }
  const { access_token, refresh_token } = await res.json();
  const { data, error } = await supabase.auth.setSession({ access_token, refresh_token });
  return error ? null : data.session;
}
