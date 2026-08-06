-- One-time cleanup, 2026-08-06.
--
-- Run in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Re-run supabase/schema.sql first, so the trigger stops new junk arriving.
--
-- Three parts, in order of how confident each one is.

begin;

-- ---------------------------------------------------------------------------
-- 1. The 17,656 arcade run under "Aman Sir".
--
-- Made on an older build whose scoring is not comparable to the current one.
-- Confirmed by the teacher. Targeted by primary key so it cannot match
-- anything else, even if a student later picks the same name.
--
-- Everything else under "Aman Sir" is the teacher's own real play on the
-- current build and stays.
-- ---------------------------------------------------------------------------

delete from public.scores
 where id = '5a6d98fe-edd3-431a-a3cc-8899b4cc70d2';

-- ---------------------------------------------------------------------------
-- 2. Half-typed names left by the auto-save bug.
--
-- Deliberately evidence-based rather than a list of names that "look wrong":
-- a row only goes if the SAME DEVICE submitted the SAME SCORE in the SAME
-- MODE under a DIFFERENT name shortly afterwards. That is the signature of one
-- run being saved twice — once automatically mid-keystroke, once by the player
-- correcting it — and nothing else produces it. Two students cannot score
-- identically on one phone within two minutes.
--
-- The later row (the deliberate name) is what survives.
--
-- This deletes rows like 'A' -> 'APS', 'A' -> 'Anonymous', 'A' -> 'Amogh' and
-- 'it' -> 'utsav', without ever needing to assume a short name is invalid.
-- Students remain free to pick any name they like.
-- ---------------------------------------------------------------------------

delete from public.scores a
 using public.scores b
 where a.player_id  = b.player_id
   and a.mode       = b.mode
   and a.score      = b.score
   and a.name      <> b.name
   and b.created_at > a.created_at
   and b.created_at < a.created_at + interval '2 minutes';

-- ---------------------------------------------------------------------------
-- 3. Exact duplicates of the same run.
--
-- Same device, mode, score AND name, submitted within two minutes: a retry or
-- a double tap, not two runs. Keeps the earliest and drops the rest.
-- ---------------------------------------------------------------------------

delete from public.scores a
 using public.scores b
 where a.player_id  = b.player_id
   and a.mode       = b.mode
   and a.score      = b.score
   and a.name       = b.name
   and b.created_at < a.created_at
   and a.created_at < b.created_at + interval '2 minutes';

commit;

-- ---------------------------------------------------------------------------
-- 4. OPTIONAL — needs your judgement, so it is commented out.
--
-- These seven rows are half-typed names that were never corrected: the player
-- typed one letter, the old build saved it, and they closed the app instead of
-- fixing it. There is no second row proving what the real name was, so nothing
-- above can touch them safely.
--
-- Each is from a device that ONLY ever used the short name, so matching them
-- to a student is something only you can do. 'P' in particular cannot be
-- resolved automatically: four different devices produced 'P' and
-- 'Pariza Khan' rows, all with different player_ids, so there is no evidence
-- linking them.
--
-- Prefer renaming to deleting where you know the student — it keeps the score
-- they earned. Uncomment whichever lines apply.
--
--   'P'  5,929 easy    2026-08-02   device bb8d9502
--   'P'  9,976 easy    2026-08-03   device 04ac4e11
--   'A'  2,297 arcade  2026-08-04   device 3183df26
--   'A'  3,741 arcade  2026-08-04   device 3183df26
--   'it'   363 arcade  2026-08-05   device 2ecb8e44
--   'it' 5,643 arcade  2026-08-05   device 2ecb8e44   (same device later used 'utsav')
-- ---------------------------------------------------------------------------

-- Rename (keeps the score) — edit the names to match your students:
--
-- update public.scores set name = 'Pariza Khan'
--  where id in ('f9cd37f7-17b4-4800-88b7-54756b38e17f',
--               'e4bc3599-af53-478d-8401-22fb8cade0fc');
--
-- update public.scores set name = 'Utsav'
--  where id in ('d3b6a6a8-28a8-42d2-a773-7ef778f7e0ad',
--               '7aa264d4-7f7e-482f-8ed0-075b5c507139');

-- Or delete outright, if you would rather they replay:
--
-- delete from public.scores
--  where id in ('f9cd37f7-17b4-4800-88b7-54756b38e17f',
--               'e4bc3599-af53-478d-8401-22fb8cade0fc',
--               '6d61fec0-7f6c-40f7-aa4d-59903703023d',
--               'cb188061-2b66-4756-abd0-995d3710b833',
--               '46e1a42c-d5b5-4372-96b7-9321d3da9b84',
--               'd3b6a6a8-28a8-42d2-a773-7ef778f7e0ad',
--               '7aa264d4-7f7e-482f-8ed0-075b5c507139');

-- ---------------------------------------------------------------------------
-- Check. Short names left here are either a deliberate choice or one of the
-- seven above — nothing new can be created this way once the trigger is in.
-- ---------------------------------------------------------------------------

select name, count(*) as rows, max(score) as best
  from public.scores
 group by name
 order by char_length(name), name;
