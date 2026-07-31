/**
 * Mid-run praise.
 *
 * Score and combo counters are precise and completely mute. A number going up
 * tells you that you were correct; it does not tell you that you were *good*.
 * A short shouted word at the right moment does, and it costs one draw call.
 *
 * Rules the wording follows, since this is aimed at students:
 *   - Praise the play, never judge the player. "Unstoppable", not "finally".
 *   - No sarcasm that could land as a put-down when someone is struggling.
 *   - Short enough to read in peripheral vision mid-run — one or two words.
 *   - Nothing that reads oddly to a child, or that a teacher would wince at
 *     on a projector.
 */

export type PraiseTier = 'good' | 'great' | 'amazing' | 'legendary';

/** Straightforward encouragement, used most often. */
const GOOD = [
  'NICE', 'GOOD ONE', 'CLEAN', 'SHARP', 'YES', 'SMOOTH', 'TIDY', 'SOLID',
];

const GREAT = [
  'BRAVO', 'BRILLIANT', 'SUPERB', 'EXCELLENT', 'ON FIRE', 'RED HOT',
  'MASTERFUL', 'IN THE ZONE',
];

const AMAZING = [
  'INCREDIBLE', 'UNSTOPPABLE', 'PHENOMENAL', 'ASTONISHING', 'MAGNIFICENT',
  'ABSOLUTE UNIT', 'GENIUS MODE',
];

const LEGENDARY = [
  'LEGENDARY', 'UNREAL', 'GOD TIER', 'BEYOND WORDS', 'HISTORY MADE',
];

/**
 * Lighter lines, mixed in occasionally so the praise does not become
 * wallpaper. Aimed at the maths, never at the player.
 */
const WITTY = [
  'CALCULATOR WHO?',
  'THE NUMBERS ARE SCARED',
  'MATHS HAS FEELINGS TOO',
  'SHOW-OFF',
  'SAVE SOME FOR THE REST',
  'YOUR TEACHER SAW THAT',
  'ARITHMETIC: DEFEATED',
  'THAT WAS RUDE',
  'ZERO HESITATION',
  'BRAIN GO BRRR',
  'CERTIFIED SMART',
  'THE SUM FEARS YOU',
];

/** Fired for an answer that was very fast rather than part of a long chain. */
const FAST = ['LIGHTNING', 'INSTANT', 'BLINK', 'NO THOUGHT NEEDED', 'REFLEX'];

function pick(list: readonly string[], rand: () => number): string {
  return list[Math.floor(rand() * list.length)];
}

export function tierFor(combo: number): PraiseTier {
  if (combo >= 40) return 'legendary';
  if (combo >= 25) return 'amazing';
  if (combo >= 12) return 'great';
  return 'good';
}

export interface PraiseLine {
  text: string;
  tier: PraiseTier;
  hue: number;
}

const TIER_HUE: Record<PraiseTier, number> = {
  good: 150,       // green
  great: 190,      // cyan
  amazing: 285,    // violet
  legendary: 45,   // gold
};

/**
 * A line for a combo milestone, or null when this combo is not a milestone.
 *
 * Milestones widen as the chain grows: every 5 early on, then every 10. Praise
 * on every single hit stops being praise, and a long run should feel like it
 * is building toward something rather than pinging constantly.
 */
export function praiseForCombo(combo: number, rand: () => number): PraiseLine | null {
  const milestone = combo >= 30 ? combo % 10 === 0 : combo % 5 === 0;
  if (!milestone || combo < 5) return null;

  const tier = tierFor(combo);
  // Roughly one in four is a lighter line, so the tone stays varied without
  // the jokes crowding out plain encouragement.
  const list = rand() < 0.25
    ? WITTY
    : tier === 'legendary' ? LEGENDARY
      : tier === 'amazing' ? AMAZING
        : tier === 'great' ? GREAT
          : GOOD;

  return { text: pick(list, rand), tier, hue: TIER_HUE[tier] };
}

/** A line for a single unusually fast answer, outside the combo ladder. */
export function praiseForSpeed(rand: () => number): PraiseLine {
  return { text: pick(FAST, rand), tier: 'great', hue: 190 };
}
