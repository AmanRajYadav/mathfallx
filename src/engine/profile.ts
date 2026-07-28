/**
 * Offline-first persistence.
 *
 * Everything lives in localStorage and the game is fully playable with the
 * network unplugged. Alongside the aggregate profile we append an immutable,
 * timestamped event per answer to a bounded `syncQueue` — an event-sourced log
 * rather than a mutable score blob.
 *
 * That shape matters if this ever grows a backend: replaying a log in UTC
 * timestamp order reconstructs the correct final rating even when two devices
 * played offline and diverged, which a last-write-wins overwrite of a single
 * "rating" field cannot do. Nothing is transmitted today; the log just makes
 * the door easy to open later.
 */

import { emptySkillState, START_RATING, type AdaptiveState, type SkillState } from './adaptive';
import type { Skill } from './generator';

const KEY = 'mathfall.profile.v2';
const LEGACY_KEY = 'mathfall-statistics';
const MAX_QUEUE = 400;

export type GameMode = 'arcade' | 'daily' | 'blitz' | 'zen';

export interface Settings {
  voiceEnabled: boolean;
  /** BCP-47 tag. en-IN materially outperforms en-US on Indian-accented English. */
  voiceLang: string;
  showKeypad: boolean;
  sfx: number;
  music: number;
  haptics: boolean;
  quality: 'auto' | 'low' | 'high';
  reduceMotion: boolean;
  /** Slows the fall speed without touching problem difficulty. */
  gentleFall: boolean;
}

export interface SyncEvent {
  /** UTC epoch ms — the ordering key for any future conflict resolution. */
  t: number;
  tpl: string;
  sk: Skill;
  b: number;
  ok: 0 | 1;
  rt: number;
  /** Signed residual time, rounded to 3dp. */
  srt: number;
  th: number;
  /** Input source: 'v' voice, 'k' keypad/keyboard. */
  src: 'v' | 'k';
}

export interface ModeRecord {
  bestScore: number;
  bestStreak: number;
  plays: number;
}

export interface Profile {
  v: 2;
  theta: number;
  peakTheta: number;
  answers: number;
  correct: number;
  residuals: number[];
  templateRatings: Record<string, number>;
  skills: Record<string, SkillState>;
  modes: Record<GameMode, ModeRecord>;
  /** Keyed by UTC date, e.g. "2026-07-28". */
  daily: Record<string, { score: number; correct: number; total: number; ms: number }>;
  totalPlayMs: number;
  voiceAnswers: number;
  settings: Settings;
  syncQueue: SyncEvent[];
  createdAt: number;
  updatedAt: number;
}

export function defaultSettings(): Settings {
  return {
    voiceEnabled: true,
    voiceLang: 'en-US',
    showKeypad: true,
    sfx: 0.7,
    music: 0.35,
    haptics: true,
    quality: 'auto',
    reduceMotion: false,
    gentleFall: false,
  };
}

function emptyModeRecord(): ModeRecord {
  return { bestScore: 0, bestStreak: 0, plays: 0 };
}

export function defaultProfile(): Profile {
  const now = Date.now();
  return {
    v: 2,
    theta: START_RATING,
    peakTheta: START_RATING,
    answers: 0,
    correct: 0,
    residuals: [],
    templateRatings: {},
    skills: {},
    modes: { arcade: emptyModeRecord(), daily: emptyModeRecord(), blitz: emptyModeRecord(), zen: emptyModeRecord() },
    daily: {},
    totalPlayMs: 0,
    voiceAnswers: 0,
    settings: defaultSettings(),
    syncQueue: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** Fills in anything a newer build added to an older stored profile. */
function reconcile(raw: Partial<Profile> | null): Profile {
  const base = defaultProfile();
  if (!raw || typeof raw !== 'object') return base;

  const p: Profile = {
    ...base,
    ...raw,
    settings: { ...base.settings, ...(raw.settings ?? {}) },
    modes: { ...base.modes, ...(raw.modes ?? {}) },
    skills: { ...(raw.skills ?? {}) },
    templateRatings: { ...(raw.templateRatings ?? {}) },
    daily: { ...(raw.daily ?? {}) },
    residuals: Array.isArray(raw.residuals) ? raw.residuals.slice(-12) : [],
    syncQueue: Array.isArray(raw.syncQueue) ? raw.syncQueue.slice(-MAX_QUEUE) : [],
    v: 2,
  };

  if (!Number.isFinite(p.theta)) p.theta = START_RATING;
  if (!Number.isFinite(p.peakTheta)) p.peakTheta = p.theta;
  for (const m of Object.keys(p.modes) as GameMode[]) {
    p.modes[m] = { ...emptyModeRecord(), ...p.modes[m] };
  }
  return p;
}

/**
 * Carries over the v1 stats blob so returning players keep their high score.
 * The old format had no rating, so ability starts from scratch — but a long
 * history of correct answers is decent evidence the player is not a beginner,
 * so seed the rating slightly above default.
 */
function migrateLegacy(p: Profile): Profile {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return p;
    const old = JSON.parse(raw) as {
      bestStreak?: number; totalQuestionsAnswered?: number; correctAnswers?: number;
      highScore?: number; timePlayedSeconds?: number;
    };

    p.modes.arcade.bestScore = Math.max(p.modes.arcade.bestScore, old.highScore ?? 0);
    p.modes.arcade.bestStreak = Math.max(p.modes.arcade.bestStreak, old.bestStreak ?? 0);
    p.totalPlayMs = Math.max(p.totalPlayMs, (old.timePlayedSeconds ?? 0) * 1000);

    const answered = old.totalQuestionsAnswered ?? 0;
    const correct = old.correctAnswers ?? 0;
    if (answered > 20 && p.answers === 0) {
      const acc = correct / answered;
      p.theta = START_RATING + Math.round(Math.max(-100, Math.min(260, (acc - 0.6) * 600)));
      p.peakTheta = p.theta;
    }
    localStorage.setItem(`${LEGACY_KEY}.migrated`, raw);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* a corrupt legacy blob must never block startup */
  }
  return p;
}

let cache: Profile | null = null;
let saveTimer: number | null = null;

export function loadProfile(): Profile {
  if (cache) return cache;
  let parsed: Partial<Profile> | null = null;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  let p = reconcile(parsed);
  if (!parsed) p = migrateLegacy(p);
  cache = p;
  return p;
}

/** Debounced — the game calls this after every answer. */
export function saveProfile(p: Profile = loadProfile()): void {
  cache = p;
  p.updatedAt = Date.now();
  if (saveTimer !== null) return;
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
      // Quota exceeded. The event log is the only unbounded part, so shed it
      // and retry — losing telemetry is always preferable to losing progress.
      try {
        if (cache) cache.syncQueue = [];
        localStorage.setItem(KEY, JSON.stringify(cache));
      } catch { /* give up silently; the session still plays fine */ }
    }
  }, 400);
}

/** Forces a synchronous write. Used on pagehide, where timers may not fire. */
export function flushProfile(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    if (cache) localStorage.setItem(KEY, JSON.stringify(cache));
  } catch { /* ignore */ }
}

export function resetProfile(): Profile {
  cache = defaultProfile();
  flushProfile();
  return cache;
}

/** A live view of the profile's adaptive fields, shared by reference. */
export function adaptiveStateOf(p: Profile): AdaptiveState {
  return {
    get theta() { return p.theta; },
    set theta(v: number) { p.theta = v; if (v > p.peakTheta) p.peakTheta = v; },
    get answers() { return p.answers; },
    set answers(v: number) { p.answers = v; },
    residuals: p.residuals,
    templateRatings: p.templateRatings,
    skills: p.skills,
  } as AdaptiveState;
}

export function pushEvent(p: Profile, e: SyncEvent): void {
  p.syncQueue.push(e);
  if (p.syncQueue.length > MAX_QUEUE) p.syncQueue.splice(0, p.syncQueue.length - MAX_QUEUE);
}

export function ensureSkill(p: Profile, skill: Skill): SkillState {
  return (p.skills[skill] ??= emptySkillState());
}

export function accuracy(p: Profile): number {
  return p.answers > 0 ? p.correct / p.answers : 0;
}
