import { NextRequest, NextResponse } from 'next/server';
import { googleConfig } from '../../../../lib/google/config';
import { open, tokenAad } from '../../../../lib/google/crypto';
import { revokeToken } from '../../../../lib/google/oauth';
import { caller, dbError, errorResponse, MSG, NO_STORE, requireGoogle } from '../../../../lib/google/server';

/** GET /api/google/connection -- is the integration configured, and the caller's connection (never a token). */
export async function GET(req: NextRequest) {
  try {
    const { db } = await caller(req);
    const cfg = googleConfig();
    const { data, error } = await db.rpc('google_connection_status');
    if (error) throw dbError(error);
    const row = (Array.isArray(data) ? data[0] : data) as { google_email: string; scopes: string[]; status: string; connected_at: string; last_error_code: string | null } | undefined;
    return NextResponse.json({
      configured: cfg.enabled,
      message: cfg.enabled ? undefined : MSG.not_configured,
      simulated: cfg.enabled && cfg.mock,           // local test provider, never presented as real Google
      connection: row ? { email: row.google_email, scopes: row.scopes, status: row.status, connectedAt: row.connected_at } : null,
    }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'google-connection');
  }
}

/**
 * DELETE /api/google/connection -- disconnect: revoke the grant at Google (best effort), then delete the stored
 * credentials. Linked files stay in the projects; nobody gains or loses access to them in Google Drive.
 */
export async function DELETE(req: NextRequest) {
  try {
    const cfg = requireGoogle();
    const { db } = await caller(req);
    const { data, error } = await db.rpc('google_credentials_get', { p_server_secret: cfg.serverSecret, p_cost: 0 });
    if (error) throw dbError(error);
    const row = (Array.isArray(data) ? data[0] : data) as { user_id: string; refresh_token_enc: string } | undefined;
    let revoked = false;
    if (row) {
      try { revoked = await revokeToken(cfg, open(cfg.keys, row.refresh_token_enc, tokenAad(row.user_id, 'refresh'))); } catch { revoked = false; }
    }
    const { data: removed, error: delErr } = await db.rpc('google_disconnect', { p_server_secret: cfg.serverSecret });
    if (delErr) throw dbError(delErr);
    return NextResponse.json({ disconnected: Boolean(removed), revokedAtGoogle: revoked }, { headers: NO_STORE });
  } catch (err) {
    return errorResponse(err, 'google-disconnect');
  }
}
