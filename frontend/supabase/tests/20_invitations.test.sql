-- Invitation lifecycle against isolated test accounts (no real e-mail is sent).
DO $$
DECLARE
  a uuid := test.mkuser('owner@example.test');
  e uuid := test.mkuser('invitee@example.test');          -- the invited person (confirmed)
  x uuid := test.mkuser('stranger@example.test');         -- someone else
  u uuid := test.mkuser('unverified@example.test', false); -- registered the invited address, NOT verified
  inv record;
  tok text;
  tok2 text;
  prev record;
  n int;
  tokens text[] := '{}';
BEGIN
  PERFORM test.act_as(a, 'owner@example.test');

  -- create: server-side token, only the hash is stored
  SELECT * INTO inv FROM public.create_workspace_invitation('Invitee@Example.Test', 'member');
  tok := inv.token;
  PERFORM test.ok(tok ~ '^[0-9a-f]{64}$', 'token is 256-bit hex');
  PERFORM test.reset();
  PERFORM test.ok((select token_hash from public.invitations where id = inv.id) = encode(extensions.digest(tok, 'sha256'), 'hex'), 'stored value is sha256(token)');
  PERFORM test.ok((select token from public.invitations where id = inv.id) IS NULL, 'plaintext token column is NULL');
  PERFORM test.ok((select count(*) from public.invitations where token_hash = tok or token = tok) = 0, 'plaintext token is nowhere in the table');
  PERFORM test.ok((select email from public.invitations where id = inv.id) = 'invitee@example.test', 'e-mail normalised to lowercase');
  PERFORM test.ok((select expires_at - created_at from public.invitations where id = inv.id) = interval '7 days', 'expiry is server-controlled (7 days)');

  -- clients cannot read token material or insert directly
  PERFORM test.act_as(a, 'owner@example.test');
  PERFORM test.throws('select * from public.invitations', '42501', 'owner cannot SELECT * (token_hash is column-protected)');
  PERFORM test.throws('select token_hash from public.invitations', '42501', 'owner cannot read token_hash');
  PERFORM test.ok((select count(*) from (select id, email, status, expires_at from public.invitations) s) = 1, 'owner can read invitation metadata');
  PERFORM test.throws(format($q$insert into public.invitations (id, workspace_id, email, token_hash, expires_at) values ('inv-x', %L, 'q@example.test', repeat('a',64), now()+interval '1 day')$q$, a),
    '42501', 'owner cannot INSERT invitations directly (RPC only)');
  PERFORM test.throws($q$update public.invitations set email = 'z@example.test'$q$, '42501', 'owner cannot rewrite invitation e-mail');
  PERFORM test.throws($q$select public.create_workspace_invitation('bad-address')$q$, '22023', 'bad e-mail rejected');
  PERFORM test.throws($q$select public.create_workspace_invitation('o@example.test', 'owner')$q$, '22023', 'owner role cannot be invited');

  -- other users cannot see or revoke it
  PERFORM test.act_as(x, 'stranger@example.test');
  PERFORM test.ok((select count(*) from (select id from public.invitations) s) = 0, 'stranger sees no invitations');
  UPDATE public.invitations SET status = 'rejected';
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 0, 'stranger cannot revoke owner invitation');

  -- anonymous preview: minimal info only
  PERFORM test.act_as_anon();
  PERFORM test.ok((select state from public.invitation_preview(tok)) = 'valid', 'anon preview: valid');
  PERFORM test.ok((select masked_email from public.invitation_preview(tok)) = 'i***@example.test', 'anon preview shows masked e-mail only');
  PERFORM test.ok((select state from public.invitation_preview(repeat('0', 64))) = 'invalid', 'anon preview: unknown token is invalid');
  PERFORM test.ok((select state from public.invitation_preview('short')) = 'invalid', 'anon preview: malformed token is invalid');
  PERFORM test.throws(format($q$select public.accept_workspace_invitation(%L, 'x')$q$, tok), '42501', 'anon cannot call accept');
  PERFORM test.throws(format($q$select public.create_workspace_invitation('a@b.cd')$q$), '42501', 'anon cannot create invitations');

  -- wrong / unverified accounts cannot accept
  PERFORM test.act_as(x, 'stranger@example.test');
  PERFORM test.throws(format($q$select public.accept_workspace_invitation(%L, 'Stranger')$q$, tok), NULL, 'stranger (other e-mail) cannot accept', 'jiný e-mail');
  PERFORM test.act_as(u, 'unverified@example.test');
  PERFORM test.throws(format($q$select public.accept_workspace_invitation(%L, 'Unverified')$q$, tok), NULL, 'unverified account cannot accept', 'není ověřen');
  PERFORM test.act_as(a, 'owner@example.test');
  PERFORM test.throws(format($q$select public.accept_workspace_invitation(%L, 'Owner')$q$, tok), NULL, 'owner cannot accept into own workspace');

  -- placeholder the owner created for the invitee gets claimed (no duplicate)
  INSERT INTO public.workspace_members (id, owner_id, full_name, initials, email) VALUES ('m-ph', a, 'Placeholder Invitee', 'PI', 'invitee@example.test');

  -- the real invitee accepts
  PERFORM test.act_as(e, 'invitee@example.test');
  PERFORM test.ok(public.accept_workspace_invitation(tok, 'Invitee Person') = a, 'invitee accepts, gets the workspace id');
  PERFORM test.reset();
  PERFORM test.ok((select status from public.invitations where id = inv.id) = 'accepted', 'invitation marked accepted');
  PERFORM test.ok((select count(*) from public.workspace_members where owner_id = a and profile_id = e) = 1, 'exactly one member row links the invitee');
  PERFORM test.ok((select profile_id from public.workspace_members where id = 'm-ph') = e, 'placeholder member was claimed');
  PERFORM test.ok((select workspace_role from public.workspace_members where owner_id = a and profile_id = e) = 'member', 'invitee gets role member (no escalation)');

  -- single use
  PERFORM test.act_as(e, 'invitee@example.test');
  PERFORM test.throws(format($q$select public.accept_workspace_invitation(%L, 'Again')$q$, tok), NULL, 'token cannot be reused', 'použita');
  PERFORM test.act_as_anon();
  PERFORM test.ok((select state from public.invitation_preview(tok)) = 'used', 'preview after use: used (no details)');
  PERFORM test.ok((select masked_email from public.invitation_preview(tok)) IS NULL, 'preview after use reveals nothing');

  -- invitee sees the workspace contact list only via collaboration rules (can_view_workspace needs a shared project)
  PERFORM test.act_as(e, 'invitee@example.test');
  PERFORM test.ok((select count(*) from public.workspace_members where owner_id = a and profile_id is distinct from auth.uid()) = 0, 'invitee sees no owner contacts until added to a project (only their own identity row)');

  -- expiry
  PERFORM test.act_as(a, 'owner@example.test');
  SELECT * INTO inv FROM public.create_workspace_invitation('late@example.test');
  tok2 := inv.token;
  PERFORM test.reset();
  UPDATE public.invitations SET expires_at = now() - interval '1 minute' WHERE id = inv.id;
  PERFORM test.act_as_anon();
  PERFORM test.ok((select state from public.invitation_preview(tok2)) = 'expired', 'expired invitation previews as expired');
  PERFORM test.reset();
  PERFORM test.mkuser('late@example.test');
  PERFORM test.act_as((select id from auth.users where email='late@example.test'), 'late@example.test');
  PERFORM test.throws(format($q$select public.accept_workspace_invitation(%L, 'Late')$q$, tok2), NULL, 'expired invitation cannot be accepted', 'vypršela');

  -- revocation by the owner (only pending -> rejected)
  PERFORM test.act_as(a, 'owner@example.test');
  SELECT * INTO inv FROM public.create_workspace_invitation('revoked@example.test');
  tok2 := inv.token;
  UPDATE public.invitations SET status = 'rejected' WHERE id = inv.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 1, 'owner revokes a pending invitation');
  UPDATE public.invitations SET status = 'pending' WHERE id = inv.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM test.ok(n = 0, 'owner cannot resurrect a revoked invitation (0 rows)');
  PERFORM test.reset();
  PERFORM test.mkuser('revoked@example.test');
  PERFORM test.act_as((select id from auth.users where email='revoked@example.test'), 'revoked@example.test');
  PERFORM test.throws(format($q$select public.accept_workspace_invitation(%L, 'R')$q$, tok2), NULL, 'revoked invitation cannot be accepted', 'použita nebo zrušena');

  -- re-inviting the same address revokes the older pending invitation
  PERFORM test.act_as(a, 'owner@example.test');
  SELECT * INTO prev FROM public.create_workspace_invitation('twice@example.test');
  SELECT * INTO inv  FROM public.create_workspace_invitation('twice@example.test');
  PERFORM test.ok((select status from public.invitations where id = prev.id) = 'rejected', 'older pending invitation to the same address is revoked');
  PERFORM test.ok((select count(*) from public.invitations where lower(email)='twice@example.test' and status='pending') = 1, 'only one pending invitation per address');

  -- token quality: no collisions across 40 tokens
  FOR i IN 1..40 LOOP
    SELECT token INTO tok2 FROM public.create_workspace_invitation('bulk' || i || '@example.test');
    tokens := tokens || tok2;
  END LOOP;
  PERFORM test.ok((select count(distinct t) from unnest(tokens) t) = 40, '40 generated tokens are all distinct');
  WHILE (SELECT count(*) FROM (SELECT status FROM public.invitations WHERE status = 'pending') s) < 50 LOOP
    PERFORM public.create_workspace_invitation('fill' || (random()*1e9)::int || '@example.test');
  END LOOP;
  PERFORM test.throws($q$select public.create_workspace_invitation('overflow@example.test')$q$, '54000', 'pending invitations are capped (50)');
EXCEPTION WHEN OTHERS THEN
  PERFORM test.reset();
  RAISE;
END $$;
