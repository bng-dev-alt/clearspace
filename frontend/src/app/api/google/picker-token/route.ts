import { NextRequest, NextResponse } from 'next/server';
import { DRIVE_SCOPES, GMAIL_READONLY_SCOPE } from '../../../../lib/google/config';
import { caller, errorResponse, getAccessToken, getNarrowAccessToken, NO_STORE, requireGoogle } from '../../../../lib/google/server';

/**
 * POST /api/google/picker-token -- what the Google Picker needs in the browser: the caller's OWN short-lived
 * access token (drive.file + identity scopes only; the refresh token never leaves the server), the Picker API key
 * (a public, referrer-restricted browser key) and the project number. Kept in memory by the client, never stored.
 * RUN 03: when the grant also holds Gmail, the browser gets a separately minted token limited to the Drive scopes.
 */
export async function POST(req: NextRequest) {
  try {
    const cfg = requireGoogle();
    const { db } = await caller(req);
    let t = await getAccessToken(db, cfg, { service: 'drive' });
    const { data } = await db.rpc('google_connection_status');
    const scopes = ((Array.isArray(data) ? data[0] : data) as { scopes?: string[] } | undefined)?.scopes ?? [];
    if (scopes.includes(GMAIL_READONLY_SCOPE)) t = { ...t, ...(await getNarrowAccessToken(db, cfg, DRIVE_SCOPES)) };
    return NextResponse.json({
      accessToken: t.token,
      expiresAt: t.expiresAt,
      developerKey: cfg.pickerApiKey,
      appId: cfg.projectNumber,
      scriptUrl: cfg.endpoints.pickerScript,
      simulated: cfg.mock,
    }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'google-picker-token');
  }
}
