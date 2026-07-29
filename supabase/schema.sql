-- MathFall leaderboard schema.
--
-- Run once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: every statement is idempotent.
--
-- The game is a static site with no backend, so the browser talks to PostgREST
-- directly using the anon key. That key is public by design; Row Level Security
-- is what actually protects the table, so the policies below are the real
-- boundary.
--
-- The service_role key must never appear in client code. It bypasses all of
-- this.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

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
  -- Run length, checked against the solve count for plausibility.
  duration_ms integer     not null default 0,
  -- Stable per-device id so one player occupies one row without needing auth.
  player_id   uuid        not null,
  created_at  timestamptz not null default now(),

  -- Constraints double as validation, since anyone holding the anon key can
  -- POST here.
  constraint scores_name_len   check (char_length(name) between 1 and 16),
  constraint scores_score_rng  check (score >= 0 and score <= 5000000),
  constraint scores_mode_valid check (mode in ('easy', 'arcade', 'daily', 'blitz', 'zen')),
  constraint scores_acc_rng    check (accuracy >= 0 and accuracy <= 1),
  constraint scores_rating_rng check (rating between 0 and 4000)
);

-- Present for tables created before duration_ms existed.
alter table public.scores add column if not exists duration_ms integer not null default 0;

-- The leaderboard only ever reads "top N for a mode".
create index if not exists scores_mode_score_idx
  on public.scores (mode, score desc, created_at asc);

-- Supports both the per-player dedupe and the rate-limit lookup below.
create index if not exists scores_player_recent_idx
  on public.scores (player_id, created_at desc);

-- Removes an earlier attempt at rate limiting via a unique index on
-- date_trunc('minute', created_at). That expression is STABLE rather than
-- IMMUTABLE — its result depends on the session TimeZone — so Postgres
-- rejects it in an index (42P17). The rate limit now lives in the trigger.
drop index if exists public.scores_rate_limit_idx;

-- ---------------------------------------------------------------------------
-- Plausibility validation
--
-- CHECK constraints only stop absurd values, not a plausible fabrication, and
-- a board that is trivially forged is one nobody believes. This trigger
-- rejects runs that are not physically possible.
--
-- Bounds come from documented human limits: simple visual choice-reaction does
-- not go below ~150ms even for elite performers, and arithmetic adds retrieval
-- on top of that. A client cannot be trusted to enforce this; the database can.
--
-- None of it makes cheating impossible — a patient faker can pace a script
-- realistically. It defeats the trivial attack, which is the point.
-- ---------------------------------------------------------------------------

create or replace function public.validate_score()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  seconds    numeric;
  per_answer numeric;
  recent     integer;
begin
  seconds := greatest(new.duration_ms, 0) / 1000.0;

  if new.solved > 0 then
    if seconds < 1 then
      raise exception 'implausible: % solved in %s', new.solved, seconds;
    end if;

    per_answer := seconds / new.solved;
    -- 0.35s per answer sustained across a whole run is already superhuman.
    if per_answer < 0.35 then
      raise exception 'implausible pace: %s per answer', round(per_answer, 3);
    end if;
  end if;

  -- Score must be reachable from the problems actually solved. The in-game
  -- ceiling is roughly 10 x speed(2.1) x difficulty(2.4) x kind(3) x
  -- multiplier(8); 700 apiece leaves generous headroom over that.
  if new.score > greatest(new.solved, 1) * 700 then
    raise exception 'implausible: score % from % solved', new.score, new.solved;
  end if;

  if new.best_combo > new.solved then
    raise exception 'implausible: combo % exceeds solved %', new.best_combo, new.solved;
  end if;

  -- Rate limit.
  --
  -- Deliberately a trigger rather than a unique index on a truncated
  -- timestamp: date_trunc over timestamptz is STABLE, not IMMUTABLE, because
  -- it depends on the session TimeZone, and Postgres rejects it in an index
  -- expression (42P17). Doing it here also allows a readable error.
  --
  -- Ten seconds is short enough that it can never block a real player — even a
  -- fast arcade death takes longer to replay — while still stopping a script
  -- from flooding the table.
  select count(*) into recent
  from public.scores
  where player_id = new.player_id
    and created_at > now() - interval '10 seconds';

  if recent > 0 then
    raise exception 'rate limited: wait a moment before submitting again';
  end if;

  return new;
end;
$$;

drop trigger if exists scores_validate on public.scores;
create trigger scores_validate
  before insert on public.scores
  for each row execute function public.validate_score();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.scores enable row level security;

drop policy if exists "scores are public" on public.scores;
create policy "scores are public"
  on public.scores for select
  to anon, authenticated
  using (true);

drop policy if exists "anyone can submit" on public.scores;
create policy "anyone can submit"
  on public.scores for insert
  to anon, authenticated
  with check (true);

-- Deliberately no update or delete policy. Without one, RLS denies both, so a
-- submitted score is immutable and nobody can clear the board. Keeping only a
-- player's best run is handled by inserting and reading the maximum, rather
-- than by granting update rights that would also let anyone rewrite anyone
-- else's row.

-- ---------------------------------------------------------------------------
-- Ranked view: one best row per player per mode
-- ---------------------------------------------------------------------------

drop view if exists public.leaderboard;
create view public.leaderboard
with (security_invoker = true)   -- honour the caller's RLS, not the owner's
as
select distinct on (mode, player_id)
  mode, player_id, name, score, wave, solved, accuracy, best_combo,
  rating, voice_share, duration_ms, created_at
from public.scores
order by mode, player_id, score desc, created_at asc;

grant select on public.leaderboard to anon, authenticated;
