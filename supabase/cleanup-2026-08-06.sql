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
-- 4. Named removals, requested by the teacher.
--
--   'P'        — half-typed 'Pariza Khan', never corrected. Two rows, from two
--                different devices (bb8d9502, 04ac4e11), which is why nothing
--                above could prove what the full name should have been.
--   'AmanTest' — a test run, not a student.
--
-- Matched on the exact name, so a student who genuinely chooses a one-letter
-- name in future is unaffected. Short names stay perfectly legal.
-- ---------------------------------------------------------------------------

delete from public.scores
 where name in ('P', 'AmanTest');

-- ---------------------------------------------------------------------------
-- 5. OPTIONAL — the same kind of leftover, for players I could not identify.
--
--   'A'    2,297 arcade  2026-08-04  device 3183df26
--   'A'    3,741 arcade  2026-08-04  device 3183df26
--   'it'     363 arcade  2026-08-05  device 2ecb8e44
--   'it'   5,643 arcade  2026-08-05  device 2ecb8e44  (later used 'utsav')
--
-- Prefer renaming where you recognise the student — it keeps the score they
-- earned:
--
-- update public.scores set name = 'Utsav'
--  where id in ('d3b6a6a8-28a8-42d2-a773-7ef778f7e0ad',
--               '7aa264d4-7f7e-482f-8ed0-075b5c507139');
--
-- Or remove them:
--
-- delete from public.scores
--  where id in ('6d61fec0-7f6c-40f7-aa4d-59903703023d',
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
