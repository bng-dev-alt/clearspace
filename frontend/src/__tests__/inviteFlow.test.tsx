import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, test, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  select: vi.fn(),
  signUp: vi.fn(),
  getSession: vi.fn(),
  user: null as null | { id: string; email: string },
}));

vi.mock('../lib/supabase', () => ({
  hasSupabaseConfig: true,
  supabase: {
    rpc: h.rpc,
    auth: { signUp: h.signUp, getSession: h.getSession },
    from: () => ({
      select: (cols: string) => {
        h.select(cols);
        return { eq: () => ({ order: () => Promise.resolve({ data: [{ id: 'i1', workspace_id: 'w', email: 'a@b.cz', role: 'member', status: 'pending', invited_by: 'w', expires_at: 'x', created_at: 'y' }], error: null }) }) };
      },
    }),
  },
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('token=' + 'f'.repeat(64)),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/accept-invite',
}));

vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: h.user, isLoading: false }),
}));

import { collaborationService } from '../services/collaborationService';
import AcceptInvitePage from '../app/accept-invite/page';
import ProtectedRoute from '../components/auth/ProtectedRoute';

const TOKEN = 'f'.repeat(64);

describe('invitation client flow (Supabase mode, mocked)', () => {
  beforeEach(() => {
    h.rpc.mockReset();
    h.select.mockReset();
    h.signUp.mockReset();
    h.getSession.mockReset();
    h.user = null;
    h.getSession.mockResolvedValue({ data: { session: null } });
  });

  test('creating an invitation goes through the RPC (server token, member role only)', async () => {
    h.rpc.mockResolvedValue({ data: [{ id: 'inv-1', token: TOKEN, expires_at: '2030-01-01T00:00:00Z' }], error: null });
    const inv = await collaborationService.createWorkspaceInvitation('ws', ' Pozvany@Example.com ', 'owner', 'ws');
    expect(h.rpc).toHaveBeenCalledWith('create_workspace_invitation', { p_email: 'pozvany@example.com', p_role: 'member' });
    expect(inv.token).toBe(TOKEN);
    expect(inv.role).toBe('member');
  });

  test('listing invitations selects explicit columns and never exposes a token', async () => {
    const rows = await collaborationService.fetchWorkspaceInvitations('ws');
    expect(h.select.mock.calls[0][0]).not.toContain('*');
    expect(h.select.mock.calls[0][0]).not.toContain('token');
    expect(rows[0].token).toBe('');
  });

  test('preview maps the anonymous RPC result', async () => {
    h.rpc.mockResolvedValue({ data: [{ state: 'valid', masked_email: 'j***@example.com', inviter_name: 'Owner' }], error: null });
    expect(await collaborationService.previewInvitation(TOKEN)).toEqual({ state: 'valid', maskedEmail: 'j***@example.com', inviterName: 'Owner' });
    h.rpc.mockResolvedValue({ data: null, error: { message: 'x' } });
    expect((await collaborationService.previewInvitation(TOKEN)).state).toBe('invalid');
  });

  test('new invitee: signUp with the typed e-mail, then RPC accept when a session exists', async () => {
    h.signUp.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    h.rpc.mockResolvedValue({ data: 'ws-id', error: null });
    const res = await collaborationService.acceptInvitationToken(TOKEN, 'Me@Example.com', 'Me', 'secret1');
    expect(h.signUp.mock.calls[0][0]).toMatchObject({ email: 'me@example.com', password: 'secret1' });
    expect(h.rpc).toHaveBeenCalledWith('accept_workspace_invitation', { p_token: TOKEN, p_display_name: 'Me' });
    expect(res.success).toBe(true);
  });

  test('e-mail confirmation required: no RPC call, user is told to confirm first', async () => {
    h.signUp.mockResolvedValue({ data: { session: null }, error: null });
    const res = await collaborationService.acceptInvitationToken(TOKEN, 'me@example.com', 'Me', 'secret1');
    expect(res).toEqual({ success: false, needsEmailConfirmation: true });
    expect(h.rpc).not.toHaveBeenCalled();
  });

  test('DB rejection (wrong e-mail, used, expired) surfaces as an error, not a fake success', async () => {
    h.getSession.mockResolvedValue({ data: { session: { access_token: 't' } } });
    h.rpc.mockResolvedValue({ data: null, error: { message: 'Pozvánka byla vystavena na jiný e-mail.' } });
    await expect(collaborationService.acceptInvitationToken(TOKEN, 'x@y.cz', 'Me', 'secret1')).rejects.toThrow('jiný e-mail');
  });

  test('/accept-invite is reachable without login (renders its content, not a redirect)', async () => {
    h.rpc.mockResolvedValue({ data: [{ state: 'valid', masked_email: 'j***@example.com', inviter_name: 'Owner' }], error: null });
    render(<ProtectedRoute><AcceptInvitePage /></ProtectedRoute>);
    await waitFor(() => expect(screen.getByTestId('accept-invite-preview')).toBeInTheDocument());
    expect(screen.getByTestId('accept-invite-email-input')).toBeInTheDocument();
    expect(screen.getByTestId('accept-invite-password-input')).toBeInTheDocument();
  });

  test('used / expired / unknown invitations show a clear message and no form', async () => {
    for (const state of ['used', 'expired', 'invalid']) {
      h.rpc.mockResolvedValue({ data: [{ state, masked_email: null, inviter_name: null }], error: null });
      const { unmount } = render(<AcceptInvitePage />);
      await waitFor(() => expect(screen.getByTestId('accept-invite-unavailable')).toBeInTheDocument());
      expect(screen.queryByTestId('accept-invite-submit-btn')).not.toBeInTheDocument();
      unmount();
    }
  });
});
