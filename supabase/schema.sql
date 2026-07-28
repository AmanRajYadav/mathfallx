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

-- ---------------------------------------------------------------------------
-- Plausibility validation
--
-- Anyone holding the anon key can POST a row, so CHECK constraints alone only
-- stop absurd values, not a fabricated 50,000. This trigger rejects runs that
-- are not physically possible.
--
-- The bounds come from documented human limits: simple visual choice-reaction
-- does not go below ~150ms even for elite performers, and answering arithmetic
-- requires retrieval on top of that. A client cannot be trusted to enforce
-- this; the database can.
--
-- None of this makes cheating impossible — a determined player can pace a
-- fake client realistically. It makes the board resistant to the trivial
-- attack, which is the difference between a leaderboard people believe and one
-- they ignore.
-- ---------------------------------------------------------------------------

alter table public.scores
  add column if not exists duration_ms integer not null default 0;

create or replace function public.validate_score()
returns trigger
language plpgsql
as $$
declare
  seconds numeric;
  per_answer numeric;
begin
  seconds := greatest(new.duration_ms, 0) / 1000.0;

  -- A run with solves must have lasted long enough to contain them.
  if new.solved > 0 then
    if seconds < 1 then
      raise exception 'implausible: % solved in %s', new.solved, seconds;
    end if;

    per_answer := seconds / new.solved;
    -- 0.35s per answer sustained is already superhuman across a whole run.
    if per_answer < 0.35 then
      raise exception 'implausible pace: %s per answer', round(per_answer, 3);
    end if;
  end if;

  -- Score has to be reachable from the number of problems actually solved.
  -- The in-game ceiling is roughly 10 x speed(2.1) x difficulty(2.4) x kind(3)
  -- x multiplier(8); 700 a piece leaves generous headroom over that.
  if new.score > greatest(new.solved, 1) * 700 then
    raise exception 'implausible: score % from % solved', new.score, new.solved;
  end if;

  -- A combo cannot exceed the problems solved.
  if new.best_combo > new.solved then
    raise exception 'implausible: combo % exceeds solved %', new.best_combo, new.solved;
  end if;

  return new;
end;
$$;

drop trigger if exists scores_validate on public.scores;
create trigger scores_validate
  before insert on public.scores
  for each row execute function public.validate_score();

-- Rate limit: one submission per player per mode per minute. Blocks a script
-- from flooding the table even with individually plausible rows.
create unique index if not exists scores_rate_limit_idx
  on public.scores (player_id, mode, date_trunc('minute', created_at));

-- Convenience view: one best row per player per mode, already ranked.
create or replace view public.leaderboard as
select distinct on (mode, player_id)
  mode, player_id, name, score, wave, solved, accuracy, best_combo,
  rating, voice_share, created_at
from public.scores
order by mode, player_id, score desc, created_at asc;

grant select on public.leaderboard to anon, authenticated;
