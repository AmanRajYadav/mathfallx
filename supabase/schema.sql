-- MathFall leaderboard schema.
--
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
--
-- The game is a static site with no backend, so the browser talks to PostgREST
-- directly using the anon key. That key is public by design; Row Level Security
-- is what actually protects the table, so every policy below matters.
--
-- The service_role key must never appear in client code. It bypasses all of
-- this.

create table if not exists public.scores (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,
  score       integer     not null,
  mode        text        not null,
  wave        integer     not null default 1,
  solved      integer     not null default 0,
  accuracy    real        not null default 0,
  best_combo  integer     not null default 0,
  rating      integer     not null default 1000,
  voice_share real        not null default 0,
  -- Stable per-device id so a player can update their own entry without auth.
  player_id   uuid        not null,
  created_at  timestamptz not null default now(),

  -- Constraints double as anti-nonsense validation, since anyone holding the
  -- anon key can POST here. They are cheap and they are the only thing
  -- standing between the table and an obviously fabricated row.
  constraint scores_name_len   check (char_length(name) between 1 and 16),
  constraint scores_score_rng  check (score >= 0 and score <= 5000000),
  constraint scores_mode_valid check (mode in ('easy', 'arcade', 'daily', 'blitz', 'zen')),
  constraint scores_acc_rng    check (accuracy >= 0 and accuracy <= 1),
  constraint scores_rating_rng check (rating between 0 and 4000)
);

-- The leaderboard only ever reads "top N for a mode", so this is the index
-- that matters.
create index if not exists scores_mode_score_idx
  on public.scores (mode, score desc, created_at asc);

create index if not exists scores_player_idx
  on public.scores (player_id);

alter table public.scores enable row level security;

-- Anyone may read the leaderboard.
drop policy if exists "scores are public" on public.scores;
create policy "scores are public"
  on public.scores for select
  to anon, authenticated
  using (true);

-- Anyone may submit a score.
drop policy if exists "anyone can submit" on public.scores;
create policy "anyone can submit"
  on public.scores for insert
  to anon, authenticated
  with check (true);

-- Deliberately no update or delete policy. Without one, RLS denies both, so a
-- submitted score is immutable and nobody can clear the board. Keeping only
-- a player's best run is handled by inserting and reading the max, rather than
-- by granting update rights that would also let anyone rewrite anyone else's.

-- Convenience view: one best row per player per mode, already ranked.
create or replace view public.leaderboard as
select distinct on (mode, player_id)
  mode, player_id, name, score, wave, solved, accuracy, best_combo,
  rating, voice_share, created_at
from public.scores
order by mode, player_id, score desc, created_at asc;

grant select on public.leaderboard to anon, authenticated;
