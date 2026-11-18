-- ROLLBACK of 20261118000800_stt_stabilization_repair (NOT a migration: lives outside supabase/migrations on purpose).
-- The repair re-asserts the definitions of 0500/0600/0700 (it does not add objects of its own), so there is no catalog change to
-- undo: this script only removes its marker so the file can be applied again. The data repairs (attempt rows for legacy meetings,
-- deletion deadlines, ledger certainty) are corrections and are deliberately NOT reverted. To go back further, run the down scripts
-- of 0700, 0600 and 0500 (in that order) afterwards.
DELETE FROM public.clearspace_migrations WHERE version = '20261118000800_stt_stabilization_repair';
