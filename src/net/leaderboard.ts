/**
 * Global leaderboard, backed by Supabase.
 *
 * Talks to PostgREST over plain fetch rather than pulling in the Supabase SDK.
 * Two endpoints — insert a score, read the top of a mode — do not justify
 * ~30KB gzipped in a game whose entire bundle is 128KB.
 *
 * The anon key below is public by design: it identifies the project and
 * nothing else. Row Level Security on the table is what actually grants
 * access, so the policies in supabase/schema.sql are the real security
 * boundary. A service_role key must never appear here — it bypasses RLS
 * entirely.
 *
 * Every call fails soft. The game is offline-first and fully playable with no
 * network, so a leaderboard outage must never interrupt a run or block the
 * game-over screen.
 */

const PROJECT = import.meta.env.VITE_SUPABASE_URL ?? 'https://lhwbnrrxpjlsxuxtnoij.supabase.co';
const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imxod2JucnJ4cGpsc3h1eHRub2lqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODUyNjIzNzYsImV4cCI6MjEwMDgzODM3Nn0.GEaQGV1NZRVVw4rdrN80CuiGBTS3U5USXKWSnAEeLLM';

const REST = `${PROJECT}/rest/v1`;
const TIMEOUT_MS = 7000;

export interface ScoreRow {
  name: string;
  score: number;
  mode: string;
  wave: number;
  solved: number;
  accuracy: number;
  best_combo: number;
  rating: number;
  voice_share: number;
  player_id: string;
  /** Run length, checked server-side against the solve count for plausibility. */
  duration_ms: number;
  created_at?: string;
}

export interface SubmitPayload {
  name: string;
  score: number;
  mode: string;
  wave: number;
  solved: number;
  accuracy: number;
  bestCombo: number;
  rating: number;
  voiceShare: number;
  durationMs: number;
}

export type LeaderboardStatus = 'idle' | 'loading' | 'ok' | 'offline' | 'error';

function headers(): Record<string, string> {
  return {
    apikey: ANON_KEY,
    Authorization: `Bearer ${ANON_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** Aborts rather than leaving the UI spinning on a dead network. */
async function withTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A stable anonymous id for this browser.
 *
 * Enough to keep one row per player on the board without accounts, logins or
 * any personal data. It is not an identity and makes no security claim — a
 * determined player can clear it and appear twice, which costs nothing.
 */
export function playerId(): string {
  const KEY = 'mathfall.playerId';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return '00000000-0000-4000-8000-000000000000';
  }
}

/** Trims a display name to what the table constraint will accept. */
export function sanitizeName(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N} _.\-']/gu, '')
    .trim()
    .slice(0, 16);
}

export interface SubmitResult {
  ok: boolean;
  /** Present when the server rejected the row rather than the request failing. */
  reason?: string;
  /**
   * Whether re-sending this exact row could ever succeed.
   *
   * The outbox keeps retrying anything transient — a dead network, a rate
   * limit, a schema that has not been installed yet — and drops only what is
   * permanently rejected. Without this distinction a retry queue either gives
   * up on recoverable failures or spins forever on unrecoverable ones.
   */
  retry?: boolean;
}

/**
 * Turns a PostgREST error body into something a player can act on.
 *
 * The server rejects rows for real reasons — rate limiting, an implausible
 * pace — and reporting all of those as "couldn't reach the leaderboard" is
 * both wrong and unhelpful.
 */
function explain(status: number, body: string): { reason: string; retry: boolean } {
  const message = (() => {
    try { return String((JSON.parse(body) as { message?: string }).message ?? ''); }
    catch { return body; }
  })().toLowerCase();

  if (message.includes('rate limited')) {
    return { reason: 'Saving — one moment.', retry: true };
  }
  if (message.includes('implausible')) {
    return { reason: 'That run was rejected as implausible.', retry: false };
  }
  if (status === 404 || message.includes('could not find the table')) {
    return { reason: 'Leaderboard not set up yet (run supabase/schema.sql).', retry: true };
  }
  if (status === 401 || status === 403) {
    return { reason: 'Leaderboard rejected the request.', retry: true };
  }
  // A 400 is a constraint violation: the row itself is malformed and will be
  // just as malformed the tenth time.
  if (status === 400 || status === 409 || status === 422) {
    return { reason: 'Submission rejected.', retry: false };
  }
  return { reason: 'Submission failed.', retry: true };
}

export async function submitScore(p: SubmitPayload): Promise<SubmitResult> {
  const name = sanitizeName(p.name);
  if (!name || p.score <= 0) return { ok: false, reason: 'Nothing to submit.', retry: false };

  const row: ScoreRow = {
    name,
    score: Math.round(p.score),
    mode: p.mode,
    wave: Math.round(p.wave),
    solved: Math.round(p.solved),
    accuracy: Math.max(0, Math.min(1, p.accuracy)),
    best_combo: Math.round(p.bestCombo),
    rating: Math.round(p.rating),
    voice_share: Math.max(0, Math.min(1, p.voiceShare)),
    player_id: playerId(),
    duration_ms: Math.round(p.durationMs),
  };

  try {
    const res = await withTimeout(`${REST}/scores`, {
      method: 'POST',
      headers: { ...headers(), Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
    if (res.ok) return { ok: true };
    const body = await res.text().catch(() => '');
    return { ok: false, ...explain(res.status, body) };
  } catch {
    return { ok: false, reason: 'No connection — saved, will send later.', retry: true };
  }
}

export interface LeaderboardResult {
  status: LeaderboardStatus;
  rows: ScoreRow[];
  /** Index of the highlighted row, or -1. */
  selfIndex: number;
}

/** Where a name places in a mode, 1-based. Null when it is not on the board. */
export async function fetchRank(mode: string, name: string): Promise<number | null> {
  const board = await fetchTop(mode, 200, name);
  if (board.status !== 'ok') return null;
  const key = sanitizeName(name).toLowerCase();
  const i = board.rows.findIndex((r) => r.name.toLowerCase() === key);
  return i === -1 ? null : i + 1;
}

/**
 * Top scores for a mode, one row per player.
 *
 * Reads the `leaderboard` view, which already deduplicates to each player's
 * best. Falls back to the raw table if the view is missing, so the feature
 * still works on a project where only the table was created.
 */
export async function fetchTop(
  mode: string,
  limit = 25,
  highlightName?: string,
): Promise<LeaderboardResult> {
  const me = playerId();
  const wanted = highlightName ? sanitizeName(highlightName).toLowerCase() : '';
  const query = `select=*&mode=eq.${encodeURIComponent(mode)}&order=score.desc,created_at.asc&limit=${limit}`;

  for (const source of ['leaderboard', 'scores']) {
    try {
      const res = await withTimeout(`${REST}/${source}?${query}`, { headers: headers() });
      if (!res.ok) continue;
      const rows = (await res.json()) as ScoreRow[];
      const deduped = source === 'scores' ? dedupe(rows) : rows;
      // Highlight by name when one is given: a shared device now carries
      // several players, so "this device" no longer identifies a person.
      const selfIndex = wanted
        ? deduped.findIndex((r) => r.name.toLowerCase() === wanted)
        : deduped.findIndex((r) => r.player_id === me);
      return { status: 'ok', rows: deduped, selfIndex };
    } catch {
      // Network failure rather than a missing view — no point trying the
      // fallback source over the same dead connection.
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return { status: 'offline', rows: [], selfIndex: -1 };
      }
    }
  }

  return { status: 'error', rows: [], selfIndex: -1 };
}

/**
 * Fallback dedupe for when the `leaderboard` view is missing.
 *
 * Keyed on device *and* name, matching the view. Keying on device alone meant
 * a shared phone could only hold one entry, so classmates overwrote each other.
 */
function dedupe(rows: ScoreRow[]): ScoreRow[] {
  const best = new Map<string, ScoreRow>();
  for (const r of rows) {
    const key = `${r.player_id}::${r.name.toLowerCase()}`;
    const prev = best.get(key);
    if (!prev || r.score > prev.score) best.set(key, r);
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

/** True when a leaderboard endpoint is configured at all. */
export function leaderboardEnabled(): boolean {
  return Boolean(PROJECT && ANON_KEY);
}
