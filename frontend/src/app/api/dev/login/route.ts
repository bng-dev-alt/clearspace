import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { devLoginRefusal } from '../../../../lib/devLogin';

export const dynamic = 'force-dynamic';

/** Development-only: see lib/devLogin.ts. Any failed precondition -> 404, indistinguishable from "no such route". */
export async function POST(req: NextRequest) {
  const refusal = devLoginRefusal(
    {
      nodeEnv: process.env.NODE_ENV,
      enabled: process.env.CLEARSPACE_DEV_LOGIN,
      vercel: process.env.VERCEL || process.env.VERCEL_ENV,
      email: process.env.DEV_LOGIN_EMAIL,
      password: process.env.DEV_LOGIN_PASSWORD,
      autoEnabled: process.env.CLEARSPACE_DEV_AUTO_LOGIN,
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    },
    req.headers,
  );
  if (refusal) {
    // Reason goes to the SERVER log only; the response stays an indistinguishable 404.
    if (process.env.NODE_ENV === 'development') console.warn(`[dev-login] refused: ${refusal}`);
    return new NextResponse(null, { status: 404 });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) return new NextResponse(null, { status: 404 });

  const client = createClient(url, anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({
    email: process.env.DEV_LOGIN_EMAIL as string,
    password: process.env.DEV_LOGIN_PASSWORD as string,
  });
  if (error || !data.session) return NextResponse.json({ error: 'dev login failed' }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
  return NextResponse.json(
    { access_token: data.session.access_token, refresh_token: data.session.refresh_token },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
