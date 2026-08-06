-- One-time cleanup, 2026-08-06.
--
-- Run in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
--
-- Removes "Aman Sir" rows: the teacher's own testing account, not a student.
-- Confirmed by the teacher for the oldest one (17,656, arcade, 2026-07-31);
-- the newer four (2026-08-05, all within a 25-minute window across every
-- mode, several hundred solves apiece at ~1 answer/second sustained) are
-- clearly the same kind of test data and are removed alongside it. If any of
-- these were in fact a real student's run, they are recoverable from the
-- `id` list below before this is run.
--
--   5a6d98fe-edd3-431a-a3cc-8899b4cc70d2  arcade  17,656
--   c1dc34a6-d2e0-4d55-81ae-d020f2459113  arcade  16,351
--   db334b84-6cf5-4065-92c8-de254a75c2c2  daily    4,252
--   91d76a3d-bc0a-43b6-b7ea-fca39b57910d  easy   155,205
--   080ea662-9535-4749-94eb-d1bb83bed44e  blitz    4,999
--
-- NOT included: the student "Aman" 127,511 easy-mode row. That one looked
-- suspicious for an unrelated reason — it recorded wave 1, impossible for
-- 952 solved — but investigation traced this to a genuine client bug
-- (wave was read from stale UI state instead of the finished run; fixed
-- separately) rather than tampering. Every other figure on that row (score,
-- solved, duration, accuracy) is consistent with a real ~26-minute session,
-- so it stays.

begin;

delete from public.scores
 where id in (
   '5a6d98fe-edd3-431a-a3cc-8899b4cc70d2',
   'c1dc34a6-d2e0-4d55-81ae-d020f2459113',
   'db334b84-6cf5-4065-92c8-de254a75c2c2',
   '91d76a3d-bc0a-43b6-b7ea-fca39b57910d',
   '080ea662-9535-4749-94eb-d1bb83bed44e'
 );

commit;

-- Should come back empty:
select id, name, score, mode, created_at from public.scores where name = 'Aman Sir';
