-- Remove the "Anonymous" test entries from every mode's leaderboard.
--
-- Run in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
--
-- "Anonymous" is the teacher's own test name, not a student. It currently sits
-- at #3 and #6 on the arcade board (two rows, from two different devices), so
-- it is displacing real students.
--
-- Case-insensitive and whitespace-tolerant, so 'anonymous', 'ANONYMOUS' and a
-- stray trailing space all go too — the name was typed by hand more than once.
--
-- Safe to re-run: a second run matches nothing.
--
-- Note this is one of the two names that exposed the rank bug — the same name
-- on two devices made the game report someone else's position as yours. That
-- is fixed in the app, but removing these rows is still worth doing.

begin;

delete from public.scores
 where lower(btrim(name)) = 'anonymous';

commit;

-- Should come back empty.
select id, name, score, mode, created_at
  from public.scores
 where lower(btrim(name)) like 'anon%'
 order by created_at;
