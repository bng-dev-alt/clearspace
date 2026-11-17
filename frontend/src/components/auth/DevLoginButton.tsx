'use client';

import { useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';
import { supabase, hasSupabaseConfig } from '../../lib/supabase';
import { isLoopbackHost } from '../../lib/devLogin';

/**
 * Development-only one-click login (see lib/devLogin.ts and the route /api/dev/login).
 * The login page only loads this module when `process.env.NODE_ENV === 'development'`, so a production build
 * contains neither this component nor the endpoint's URL or marker header (verified by scanning .next/static).
 */
export default function DevLoginButton({ onError }: { onError: (message: string | null) => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  // Server snapshot is always false (nothing in the HTML); the client decides from the flag and window.location.
  const visible = useSyncExternalStore(
    () => () => {},
    () => process.env.NEXT_PUBLIC_DEV_LOGIN === '1' && hasSupabaseConfig && isLoopbackHost(window.location.host),
    () => false,
  );
  if (!visible) return null;

  const run = async () => {
    onError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/dev/login', { method: 'POST', headers: { 'x-clearspace-dev-login': '1' } });
      if (!res.ok) throw new Error('Dev přihlášení není dostupné (zkontrolujte .env.local).');
      const { access_token, refresh_token } = await res.json();
      const { error } = await supabase.auth.setSession({ access_token, refresh_token });
      if (error) throw error;
      router.push('/');
    } catch (err: unknown) {
      onError(err instanceof Error ? err.message : 'Dev přihlášení selhalo.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      data-testid="dev-login-btn"
      onClick={run}
      disabled={busy}
      style={{ marginTop: '0.75rem', width: '100%', padding: '0.6rem', fontSize: '0.8rem', fontWeight: 600, border: '1px dashed var(--border-color)', borderRadius: '8px', background: 'transparent', color: 'var(--gray-text)', cursor: 'pointer' }}
    >
      Dev přihlášení (jen lokálně)
    </button>
  );
}
