/**
 * Durable queue for leaderboard submissions.
 *
 * Reported by a player after a three-hour session: a 143,979 run never reached
 * the board. The score existed for exactly one instant — the moment the
 * game-over screen was on screen — and reaching the server depended on a tap
 * landing, the network being up, and the page surviving in between. Miss any
 * of the three and hours of play were gone with nothing to retry.
 *
 * So a finished run is written to localStorage *first* and sent *second*.
 * Everything after that point is a retry against durable state: the network can
 * fail, the tab can die, the phone can be killed by the OS, and the run is
 * still queued on the next launch.
 */

import { submitScore, type SubmitPayload } from './leaderboard';

const KEY = 'mathfall.outbox';

/**
 * Cap on queued runs.
 *
 * Only reached if a player somehow finishes 30 runs entirely offline. Dropping
 * the lowest score rather than the oldest means the run worth keeping is the
 * one that survives.
 */
const MAX_QUEUED = 30;

/** Beyond this a row is almost certainly unsendable; stop burning requests. */
const MAX_TRIES = 25;

/** The server rate limit is 10s per player, so pace the queue past it. */
const SPACING_MS = 11_000;

export interface QueuedRun extends SubmitPayload {
  id: string;
  queuedAt: number;
  tries: number;
  lastError?: string;
}

function read(): QueuedRun[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as QueuedRun[]).filter((r) => r && typeof r.score === 'number') : [];
  } catch {
    return [];
  }
}

function write(rows: QueuedRun[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rows));
  } catch {
    // Storage full or blocked (private mode). Nothing useful to do — the live
    // submit still runs, it just loses its safety net.
  }
}

export function pendingCount(): number {
  return read().length;
}

// ------------------------------------------------------------- sent registry
//
// The server has no idempotency key, so the client must remember what it has
// already delivered. Without this, pressing Save right after an auto-save
// re-queued a run that had already left the queue and the board got the same
// run twice — observed in production as identical rows eleven seconds apart.

const SENT_KEY = 'mathfall.outbox.sent';
const SENT_MAX = 50;

function readSent(): Array<{ id: string; name: string }> {
  try {
    const raw = localStorage.getItem(SENT_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Array<{ id: string; name: string }>) : [];
  } catch {
    return [];
  }
}

function recordSent(id: string, name: string): void {
  try {
    const rows = readSent().filter((r) => r.id !== id);
    rows.push({ id, name: name.toLowerCase() });
    localStorage.setItem(SENT_KEY, JSON.stringify(rows.slice(-SENT_MAX)));
  } catch { /* losing the registry only risks a duplicate, never a run */ }
}

/** Whether this run already reached the server under this name. */
function wasSent(id: string, name: string): boolean {
  const key = name.toLowerCase();
  return readSent().some((r) => r.id === id && r.name === key);
}

/**
 * Records a finished run. Returns its queue id.
 *
 * Idempotent per run: re-queueing a run already in the queue — which is what
 * tapping Save after an auto-submit does — updates it in place instead of
 * inserting a second row.
 */
export function enqueue(p: SubmitPayload, id?: string): string {
  const rows = read();
  const runId = id ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  // Already delivered under this exact name: queueing it again would put the
  // same run on the board twice. A *different* name is allowed through — that
  // is a deliberate correction, not a duplicate.
  if (id && wasSent(id, p.name)) return id;

  const existing = rows.findIndex((r) => r.id === runId);
  const entry: QueuedRun = { ...p, id: runId, queuedAt: Date.now(), tries: 0 };
  if (existing >= 0) rows[existing] = { ...rows[existing], ...p };
  else rows.push(entry);

  if (rows.length > MAX_QUEUED) {
    rows.sort((a, b) => b.score - a.score);
    rows.length = MAX_QUEUED;
  }
  write(rows);
  return runId;
}

export function remove(id: string): void {
  write(read().filter((r) => r.id !== id));
}

export function has(id: string): boolean {
  return read().some((r) => r.id === id);
}

let flushing = false;
let flushTimer = 0;

/**
 * Sends everything queued, newest-highest first.
 *
 * Stops at the first retryable failure rather than marching through the rest:
 * if the network is down or the rate limit is active, the next row is going to
 * fail for the same reason, and hammering it helps nobody.
 */
export async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    let rows = read().sort((a, b) => b.score - a.score);
    for (const row of rows) {
      // Re-read each time: a run can be queued while this loop is awaiting.
      if (!has(row.id)) continue;

      const res = await submitScore(row);

      if (res.ok) {
        recordSent(row.id, row.name);
        remove(row.id);
      } else if (res.retry === false) {
        // Permanently rejected. Keeping it would mean retrying forever.
        remove(row.id);
      } else {
        const current = read();
        const i = current.findIndex((r) => r.id === row.id);
        if (i >= 0) {
          current[i] = { ...current[i], tries: current[i].tries + 1, lastError: res.reason };
          if (current[i].tries >= MAX_TRIES) current.splice(i, 1);
          write(current);
        }
        // Transient. Come back to the whole queue later.
        scheduleFlush(SPACING_MS);
        return;
      }

      // Space out successive inserts so the server's 10s per-player rate limit
      // does not reject the rest of a backlog.
      rows = read();
      if (rows.length > 0) {
        scheduleFlush(SPACING_MS);
        return;
      }
    }
  } finally {
    flushing = false;
  }
}

function scheduleFlush(delay: number): void {
  if (flushTimer) return;
  flushTimer = window.setTimeout(() => {
    flushTimer = 0;
    void flush();
  }, delay);
}

/**
 * Starts the background drain.
 *
 * Retries on the events that actually mean "the network might work now":
 * coming back online, and the tab being brought to the foreground.
 */
let started = false;

export function startOutbox(): void {
  if (typeof window === 'undefined' || started) return;
  started = true;
  const kick = () => { if (navigator.onLine !== false) void flush(); };
  window.addEventListener('online', kick);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  kick();
}
