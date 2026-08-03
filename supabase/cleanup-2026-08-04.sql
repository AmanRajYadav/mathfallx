-- One-time cleanup, 2026-08-04.
--
-- Run in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
--
-- Removes the junk rows created by the auto-save bug (fixed in the app the
-- same day): the game-over screen was saving the moment a student typed the
-- FIRST LETTER of their name, so the board filled with entries called "A",
-- "1", "s", "i" and "it". These sat above real scores and distorted every
-- placement — a genuine 2nd-place run was reported as #4.
--
-- Every name below was verified against the live table before writing this:
-- each is a fragment created by that bug, matched by exact name. (Short names
-- remain allowed in the app — these rows are removed because of *when and how*
-- they were created, not their length.)

begin;

delete from public.scores
 where name in ('A', 'a', '1', 's', 'S', 'i', 'it');

-- "Amana" and "Armane" are one-off typos from the same devices as "Aman" and
-- "Arman" (verified by player_id). Folding them in returns those runs to
-- their owners instead of deleting them.
update public.scores set name = 'Aman'  where name = 'Amana';
update public.scores set name = 'Arman' where name = 'Armane';

commit;

-- Should come back empty:
select id, name, score, mode, created_at
  from public.scores
 where char_length(name) < 2 or name in ('it', 'Amana', 'Armane');
