'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '../../../lib/supabase';

/**
 * Landing page after Google's consent screen. Completes the connection under the user's ClearSpace session
 * (the code never appears in this page's URL) and returns to where the user started.
 */
export default function GoogleOAuthReturnPage() {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data.session?.access_token;
        if (!token) { setFailed(true); return; }
        const res = await fetch('/api/google/oauth/complete', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
        const body = (await res.json().catch(() => ({}))) as { outcome?: string; returnTo?: string };
        const path = typeof body.returnTo === 'string' && /^\/(settings|projects\/[A-Za-z0-9_-]{1,100})$/.test(body.returnTo) ? body.returnTo : '/settings';
        router.replace(`${path}?google=${encodeURIComponent(body.outcome ?? 'error')}`);
      } catch {
        setFailed(true);
      }
    })();
  }, [router]);

  return (
    <main style={{ maxWidth: 480, margin: '4rem auto', padding: '0 1rem', fontFamily: 'var(--font-sans)', color: 'var(--dark-navy)' }} data-testid="google-oauth-return">
      {failed ? (
        <p>Připojení účtu Google se nepodařilo dokončit. Přihlaste se prosím do ClearSpace a zkuste to znovu v <a href="/settings">Propojených účtech</a>.</p>
      ) : (
        <p>Dokončuji připojení účtu Google…</p>
      )}
    </main>
  );
}
