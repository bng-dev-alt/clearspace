import { NextRequest, NextResponse } from 'next/server';
import { caller, errorResponse, getAccessToken, NO_STORE, requireGoogle } from '../../../../lib/google/server';

/**
 * POST /api/google/picker-token -- what the Google Picker needs in the browser: the caller's OWN short-lived
 * access token (drive.file + identity scopes only; the refresh token never leaves the server), the Picker API key
 * (a public, referrer-restricted browser key) and the project number. Kept in memory by the client, never stored.
 */
export async function POST(req: NextRequest) {
  try {
    const cfg = requireGoogle();
    const { db } = await caller(req);
    const t = await getAccessToken(db, cfg);
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
