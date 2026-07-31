/**
 * The adaptive difficulty engine.
 *
 * Two ideas, borrowed from how adaptive assessment platforms actually work:
 *
 * 1. **Elo, not Item Response Theory.** Classical IRT needs every item
 *    pre-calibrated against a large response dataset. This game generates
 *    items procedurally and effectively infinitely, so pre-calibration is
 *    impossible. Elo estimates player ability and item difficulty jointly, on
 *    the fly, in a few floating point operations — cheap enough to run every
 *    single answer on a mid-range phone with no server involved.
 *
 * 2. **High Speed High Stakes scoring.** Binary right/wrong throws away the
 *    most informative signal in an arithmetic drill: *how long it took*.
 *    Answering 7x8 correctly in 1.2s and answering it correctly in 9s are not
 *    the same skill state — the first is fluency, the second is derivation.
 *    The HSHS / Signed Residual Time rule scores on a continuum:
 *
 *        S = (2x - 1)(d - t)      x = 1 correct, 0 incorrect
 *
 *    A fast correct answer earns near +d. A fast *wrong* answer — careless
 *    button-mashing — is punished near -d. A slow answer of either kind lands
 *    near zero, which is exactly right: it carries little information about
 *    mastery either way.
 *
 * The normalized HSHS score replaces the binary outcome in the Elo update, so
 * the rating tracks fluency rather than mere correctness.
 */

import type { Skill } from './generator';

/** Probability that a player rated `theta` answers an item rated `b`. */
export function expectedScore(theta: number, b: number): number {
  return 1 / (1 + Math.pow(10, (b - theta) / 400));
}

/**
 * Signed Residual Time, normalized to [-1, 1].
 *
 * @param correct whether the answer was right
 * @param rtMs    response time in milliseconds
 * @param limitMs the time limit for the item
 */
export function srtScore(correct: boolean, rtMs: number, limitMs: number): number {
  const d = Math.max(1, limitMs);
  const t = Math.max(0, Math.min(d, rtMs));
  return (correct ? 1 : -1) * ((d - t) / d);
}

/** Maps SRT's [-1, 1] onto the [0, 1] outcome that Elo expects. */
export function srtToOutcome(srt: number): number {
  return (srt + 1) / 2;
}

export interface AnswerRecord {
  templateId: string;
  skill: Skill;
  /** Item difficulty on the Elo scale. */
  itemRating: number;
  correct: boolean;
  rtMs: number;
  limitMs: number;
}

export interface AdaptiveState {
  theta: number;
  answers: number;
  /** Recent (outcome - expected) residuals, for volatility detection. */
  residuals: number[];
  templateRatings: Record<string, number>;
  skills: Record<string, SkillState>;
}

export interface SkillState {
  /** P(mastered), Bayesian-Knowledge-Tracing style. */
  mastery: number;
  seen: number;
  correct: number;
  /** Exponential moving average of response time, ms. */
  avgRtMs: number;
}

export interface UpdateResult {
  srt: number;
  outcome: number;
  expected: number;
  thetaDelta: number;
  theta: number;
  k: number;
}

export const START_RATING = 1000;

export function emptySkillState(): SkillState {
  return { mastery: 0.25, seen: 0, correct: 0, avgRtMs: 0 };
}

/**
 * Dynamic K-factor.
 *
 * K controls how violently the rating reacts. New players need it high so the
 * estimate converges within a session or two; settled players need it low so a
 * single unlucky miss does not undo twenty good answers. On top of that, a
 * sustained run of surprises (residuals consistently signed the same way)
 * means the current estimate is simply wrong — the player is improving fast,
 * or tired — so K is boosted to catch up.
 */
export function kFactor(state: AdaptiveState): number {
  const convergence = 20 + 46 * Math.exp(-state.answers / 45);

  const r = state.residuals;
  if (r.length < 6) return convergence;
  let sum = 0;
  for (const v of r) sum += v;
  const bias = Math.abs(sum / r.length);
  // bias ~0 means the model predicts well; ~0.35+ means it is badly off.
  const volatility = 1 + Math.min(1, bias / 0.3) * 0.8;

  return convergence * volatility;
}

/**
 * Applies one answer to the adaptive state, mutating it in place.
 * Returns the derived scores so the UI can show the rating delta.
 */
export function applyAnswer(state: AdaptiveState, rec: AnswerRecord): UpdateResult {
  const b = rec.itemRating;
  const expected = expectedScore(state.theta, b);
  const srt = srtScore(rec.correct, rec.rtMs, rec.limitMs);
  const outcome = srtToOutcome(srt);

  const k = kFactor(state);
  const residual = outcome - expected;
  const thetaDelta = k * residual;

  state.theta = Math.max(400, Math.min(2600, state.theta + thetaDelta));
  state.answers += 1;

  state.residuals.push(residual);
  if (state.residuals.length > 12) state.residuals.shift();

  // The item moves the other way, at a fraction of the speed. Any one player
  // is weak evidence about an item's true difficulty, so item ratings drift
  // slowly and only on templates that player actually saw.
  const prev = state.templateRatings[rec.templateId] ?? b;
  state.templateRatings[rec.templateId] = Math.max(500, Math.min(2600, prev - k * 0.12 * residual));

  // Per-skill mastery, BKT-lite. Fast correct answers advance mastery more
  // than slow ones, because automaticity is the thing being measured.
  const s = (state.skills[rec.skill] ??= emptySkillState());
  s.seen += 1;
  if (rec.correct) s.correct += 1;
  s.avgRtMs = s.avgRtMs === 0 ? rec.rtMs : s.avgRtMs * 0.8 + rec.rtMs * 0.2;

  if (rec.correct) {
    const speedBonus = Math.max(0, srt); // 0 at the buzzer, 1 when instant
    const learn = 0.08 + 0.14 * speedBonus;
    s.mastery += (1 - s.mastery) * learn;
  } else {
    const slip = 0.16 + 0.14 * Math.max(0, -srt); // careless misses hurt more
    s.mastery *= 1 - slip;
  }
  s.mastery = Math.max(0.01, Math.min(0.99, s.mastery));

  return { srt, outcome, expected, thetaDelta, theta: state.theta, k };
}

/**
 * The difficulty to aim the next item at.
 *
 * Solving the logistic for a target success probability p gives
 *   b = theta - 400 * log10(p / (1 - p))
 * At p = 0.78 that is theta - 219: consistently winnable, never trivial. That
 * band is where flow lives — high enough to demand attention, low enough that
 * the player keeps clearing blocks.
 */
export function targetDifficulty(theta: number, successTarget = 0.78): number {
  const p = Math.max(0.5, Math.min(0.95, successTarget));
  return theta - 400 * Math.log10(p / (1 - p));
}

/**
 * The skill most worth drilling: lowest mastery among skills with enough
 * evidence to trust. Returns null when nothing stands out, in which case the
 * generator should stay unbiased.
 */
export function weakestSkill(state: AdaptiveState, minSeen = 6): Skill | null {
  let worst: Skill | null = null;
  let worstVal = 0.62; // only intervene when mastery is actually low
  for (const [skill, s] of Object.entries(state.skills)) {
    if (s.seen < minSeen) continue;
    if (s.mastery < worstVal) {
      worstVal = s.mastery;
      worst = skill as Skill;
    }
  }
  return worst;
}

export interface Rank {
  /** 1-based position on the ladder. */
  tier: number;
  name: string;
  /** Rating at which this rank is reached. */
  at: number;
  color: string;
  /** What arithmetic a player at this level is actually handling. */
  blurb: string;
}

/**
 * The rank ladder: twenty tiers from a first correct answer to mastery.
 *
 * Twenty rather than eight because a rank you hold for months stops being
 * progress and becomes furniture. The gaps widen as they climb — 85 points
 * early, 120 near the top — so early promotions come quickly enough to feel
 * like momentum, while the last few have to be earned.
 *
 * Each carries a plain description of the maths involved. "Prism" means
 * nothing on its own; "two-digit sums with carries, times tables to 12" tells
 * a student exactly what they have got good at, which is the part worth
 * knowing.
 */
export const RANKS: Rank[] = [
  { tier: 1,  name: 'SPARK',        at: 0,    color: '#8b93b0', blurb: 'First signal. Everyone starts here.' },
  { tier: 2,  name: 'EMBER',        at: 700,  color: '#ff9f6e', blurb: 'Single-digit sums, taken steadily.' },
  { tier: 3,  name: 'CIRCUIT',      at: 785,  color: '#ffb03a', blurb: 'Small sums answered without counting.' },
  { tier: 4,  name: 'RELAY',        at: 870,  color: '#ffd34d', blurb: 'Adding with carries. Small times tables.' },
  { tier: 5,  name: 'VECTOR',       at: 955,  color: '#d8f04a', blurb: 'Two-digit addition, comfortably.' },
  { tier: 6,  name: 'LATTICE',      at: 1040, color: '#7fe86b', blurb: 'Subtraction with borrows. Squares.' },
  { tier: 7,  name: 'PRISM',        at: 1130, color: '#39ff88', blurb: 'Times tables to 12, recalled not derived.' },
  { tier: 8,  name: 'CASCADE',      at: 1220, color: '#2ce8b4', blurb: 'Division facts. Roots of perfect squares.' },
  { tier: 9,  name: 'NEON',         at: 1310, color: '#00f0ff', blurb: 'Three-term sums held in your head.' },
  { tier: 10, name: 'PULSAR',       at: 1400, color: '#4cc4ff', blurb: 'Two-digit by one-digit multiplication.' },
  { tier: 11, name: 'CIPHER',       at: 1495, color: '#6ea8ff', blurb: 'Longer division, cleanly.' },
  { tier: 12, name: 'NEBULA',       at: 1590, color: '#8f8cff', blurb: 'Mixed operations in the right order.' },
  { tier: 13, name: 'QUANTUM',      at: 1685, color: '#a97bff', blurb: 'Multi-step arithmetic at speed.' },
  { tier: 14, name: 'ZENITH',       at: 1785, color: '#c17bff', blurb: 'Bracketed expressions, no hesitation.' },
  { tier: 15, name: 'ECLIPSE',      at: 1885, color: '#dd6fe8', blurb: 'Squares past the teens.' },
  { tier: 16, name: 'NOVA',         at: 1990, color: '#ff5ec4', blurb: 'Two-digit by two-digit multiplication.' },
  { tier: 17, name: 'HORIZON',      at: 2095, color: '#ff2d95', blurb: 'Hard problems answered on reflex.' },
  { tier: 18, name: 'SINGULARITY',  at: 2205, color: '#ff6b6b', blurb: 'Faster than most people can read.' },
  { tier: 19, name: 'ASCENDANT',    at: 2320, color: '#ffd34d', blurb: 'The generator is running out of ideas.' },
  { tier: 20, name: 'TRANSCENDENT', at: 2440, color: '#ffffff', blurb: 'Nothing left to prove.' },
];

export interface RankState extends Rank {
  /** Rating needed for the next rank, or null at the top. */
  next: number | null;
  /** 0-1 progress toward the next rank. */
  progress: number;
}

/** The rank a rating currently sits in, with progress toward the next. */
export function rankFor(theta: number): RankState {
  let idx = 0;
  for (let i = 0; i < RANKS.length; i++) if (theta >= RANKS[i].at) idx = i;
  const current = RANKS[idx];
  const next = idx + 1 < RANKS.length ? RANKS[idx + 1] : null;
  const progress = next
    ? Math.max(0, Math.min(1, (theta - current.at) / (next.at - current.at)))
    : 1;
  return { ...current, next: next ? next.at : null, progress };
}
