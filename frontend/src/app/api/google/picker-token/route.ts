import { NextRequest, NextResponse } from 'next/server';
import { DRIVE_SCOPES } from '../../../../lib/google/config';
import { caller, errorResponse, getNarrowAccessToken, NO_STORE, requireGoogle } from '../../../../lib/google/server';

/**
 * POST /api/google/picker-token -- what the Google Picker needs in the browser: the caller's OWN short-lived
 * access token (drive.file + identity scopes only; the refresh token never leaves the server), the Picker API key
 * (a public, referrer-restricted browser key) and the project number. Kept in memory by the client, never stored.
 * RUN 03: the grant at Google may also hold Gmail (enabled now, or earlier and only switched off in ClearSpace), so the
 * browser ALWAYS gets a separately minted token limited to the Drive scopes -- never the stored server-side token.
 */
export async function POST(req: NextRequest) {
  try {
    const cfg = requireGoogle();
    const { db } = await caller(req);
    const t = await getNarrowAccessToken(db, cfg, DRIVE_SCOPES, 'drive');
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
