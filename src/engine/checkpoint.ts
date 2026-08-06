/**
 * Mid-run crash recovery.
 *
 * A run only became real when it ended: XP, best score and the leaderboard row
 * were all written in `end()`. Anything that stopped the page before that —
 * Android reclaiming a backgrounded tab, a service worker handover, a browser
 * crash, a dead battery — threw the entire run away. A player who had been
 * going since 10am lost the lot, which is the kind of thing that stops someone
 * playing for good.
 *
 * So the run is snapshotted every few seconds. On the next launch a leftover
 * snapshot is recovered as a finished run: it did end, just not by choice.
 */

import type { GameMode } from './modes';
import type { RunSummary } from './GameCore';

const KEY = 'mathfall.run';

/** Below this a lost run is not worth interrupting anyone about. */
const MIN_WORTH_RECOVERING = 200;

/** A snapshot older than this is stale enough that it is better ignored. */
const MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface RunCheckpoint {
  v: 1;
  at: number;
  mode: GameMode;
  score: number;
  wave: number;
  solved: number;
  missed: number;
  bestCombo: number;
  avgRtMs: number;
  fastestRtMs: number | null;
  voiceShare: number;
  durationMs: number;
  xpBefore: number;
  xpGained: number;
}

export function saveCheckpoint(c: Omit<RunCheckpoint, 'v' | 'at'>): void {
  try {
    if (c.score < MIN_WORTH_RECOVERING) return;
    const payload: RunCheckpoint = { ...c, v: 1, at: Date.now() };
    localStorage.setItem(KEY, JSON.stringify(payload));
  } catch {
    // Storage unavailable. The run just loses its safety net.
  }
}

export function clearCheckpoint(): void {
  try { localStorage.removeItem(KEY); } catch { /* nothing to do */ }
}

export function loadCheckpoint(): RunCheckpoint | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as RunCheckpoint;
    if (c?.v !== 1 || typeof c.score !== 'number') return null;
    if (c.score < MIN_WORTH_RECOVERING) return null;
    if (Date.now() - c.at > MAX_AGE_MS) return null;
    return c;
  } catch {
    return null;
  }
}

/**
 * Presents a recovered snapshot as an ordinary run summary.
 *
 * `isRecord` is deliberately false: the record banner is a live celebration,
 * and firing it for a run the player did not see finish would be strange.
 */
export function summaryFrom(c: RunCheckpoint): RunSummary {
  const attempted = c.solved + c.missed;
  return {
    mode: c.mode,
    score: c.score,
    wave: c.wave,
    bestCombo: c.bestCombo,
    solved: c.solved,
    missed: c.missed,
    accuracy: attempted > 0 ? c.solved / attempted : 0,
    avgRtMs: c.avgRtMs,
    fastestRtMs: c.fastestRtMs,
    xpBefore: c.xpBefore,
    xpAfter: c.xpBefore + c.xpGained,
    xpGained: c.xpGained,
    voiceShare: c.voiceShare,
    durationMs: c.durationMs,
    isRecord: false,
  };
}
