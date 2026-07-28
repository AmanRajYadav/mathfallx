/**
 * Power-ups. They fly to the ship and fire on contact — no input at all.
 *
 * This went through two earlier designs, both worse.
 *
 * The original had you *steer* a rocket into falling tokens with arrow keys.
 * In a game whose only input is speech that is a second, competing control
 * scheme: fine on a keyboard, unusable while you are mid-"fifty six" on a
 * phone.
 *
 * The replacement made you *spend* them by shouting their name. That reads
 * well on paper and fails in practice, because it puts non-numeric words into
 * a recogniser that is otherwise only ever hearing numbers. "Slow" and "low",
 * "stop" and "freeze", "double" and "bubble" all become live tripwires, and
 * every false positive burns an item you were saving. It also asks the player
 * to make a tactical decision precisely when the screen is getting away from
 * them — and by the time they have decided, the block has landed.
 *
 * So: collection and activation are both automatic. The reward for playing
 * well is simply that good things happen faster, and voice goes back to
 * hearing nothing but numbers.
 */

export type PowerUpType = 'freeze' | 'slow' | 'nuke' | 'shield' | 'double';

export interface PowerUpDef {
  type: PowerUpType;
  label: string;
  icon: string;
  /** Hue for the token, aura and HUD chip. */
  hue: number;
  /** Seconds the effect lasts. 0 means instantaneous. */
  duration: number;
  blurb: string;
  /** Desktop shortcut. */
  key: string;
  /**
   * Fires the instant it is collected, with no player action.
   *
   * Reserved for the purely defensive ones. When the screen is already getting
   * away from you, the last thing that helps is a decision to make — and by
   * the time you have decided, the block has landed. The tactical power-ups
   * (nuke, double) stay manual, because spending those at the right moment is
   * the whole point of holding them.
   */
  auto: boolean;
  /**
   * Everything a player might plausibly say to trigger it, including the
   * homophones speech engines reliably produce for each word.
   */
  spoken: string[];
}

export const POWER_UPS: Record<PowerUpType, PowerUpDef> = {
  freeze: {
    type: 'freeze',
    label: 'FREEZE',
    icon: '❄',
    hue: 190,
    duration: 4,
    blurb: 'Everything stops for 4s',
    key: 'f',
    auto: true,
    spoken: ['freeze', 'frees', 'freezing', 'ice', 'stop', 'frieze'],
  },
  slow: {
    type: 'slow',
    label: 'SLOW',
    icon: '◷',
    hue: 265,
    duration: 7,
    blurb: 'Half speed for 7s',
    key: 's',
    auto: true,
    spoken: ['slow', 'slower', 'slow motion', 'slowmo', 'slow', 'low'],
  },
  nuke: {
    type: 'nuke',
    label: 'NUKE',
    icon: '☢',
    hue: 12,
    duration: 0,
    blurb: 'Clears the screen',
    key: 'n',
    auto: true,
    spoken: ['nuke', 'nuk', 'newk', 'bomb', 'blast', 'boom', 'nook'],
  },
  shield: {
    type: 'shield',
    label: 'SHIELD',
    icon: '◈',
    hue: 150,
    duration: 0,
    blurb: 'Restores one shield',
    key: 'h',
    auto: true,
    spoken: ['shield', 'shields', 'sheild', 'guard', 'armor', 'armour', 'shed'],
  },
  double: {
    type: 'double',
    label: 'DOUBLE',
    icon: '✦',
    hue: 45,
    duration: 10,
    blurb: 'Double score for 10s',
    key: 'd',
    auto: true,
    spoken: ['double', 'dubble', 'doubles', 'twice', 'bubble'],
  },
};

export const POWER_UP_LIST: PowerUpDef[] = Object.values(POWER_UPS);

/** Longest spoken phrase, so the command matcher can bail on long transcripts. */
const MAX_PHRASE_WORDS = 2;

/**
 * Resolves a transcript to a power-up.
 *
 * Deliberately strict: it only fires when the utterance is essentially just
 * the keyword. During play the player is constantly saying numbers, and a
 * loose match would burn a power-up on a misheard answer — which is far more
 * annoying than an occasional missed activation.
 */
export function matchPowerUpPhrase(transcript: string): PowerUpType | null {
  const text = transcript
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');

  if (!text) return null;
  if (text.split(' ').length > MAX_PHRASE_WORDS) return null;

  for (const def of POWER_UP_LIST) {
    for (const phrase of def.spoken) {
      if (text === phrase) return def.type;
    }
  }
  return null;
}

/**
 * Drop chance for a destroyed block.
 *
 * Tuned low enough that a power-up feels like an event rather than a resource,
 * and weighted toward the block types that were hard to kill in the first
 * place. Long combos also raise it, so the reward for playing well is more
 * ways to keep playing well.
 */
export function dropChance(kind: string, combo: number): number {
  const base = kind === 'boss' ? 0.85 : kind === 'armored' ? 0.35 : kind === 'fast' ? 0.16 : 0.07;
  const comboBonus = Math.min(0.1, combo * 0.004);
  return base + comboBonus;
}

/** Picks a drop, biased toward what the player most needs right now. */
export function rollPowerUp(
  rand: () => number,
  ctx: { shield: number; maxShield: number; liveBlocks: number; concurrency: number },
): PowerUpType {
  const weights: Array<[PowerUpType, number]> = [
    ['freeze', 1],
    ['slow', 1],
    ['nuke', 0.6],
    ['shield', ctx.shield < ctx.maxShield ? 1.6 : 0.15],
    ['double', 0.9],
  ];

  // A crowded screen is exactly when clearing tools should show up.
  if (ctx.liveBlocks >= ctx.concurrency) {
    weights[0][1] += 0.8; // freeze
    weights[2][1] += 0.7; // nuke
  }

  let total = 0;
  for (const [, w] of weights) total += w;
  let roll = rand() * total;
  for (const [type, w] of weights) {
    roll -= w;
    if (roll <= 0) return type;
  }
  return 'freeze';
}
