/**
 * Power-ups, activated by voice.
 *
 * The interesting design constraint: in a game whose only input is speech,
 * a power-up you collect by *steering* into it would force a second, competing
 * control scheme. The old build did exactly that — an arrow-key-driven rocket
 * chasing falling tokens — which works on a keyboard and is unusable while
 * you are busy saying "fifty six" on a phone.
 *
 * So pickups fly to the ship automatically, and the skill is in *when you
 * spend them*: you shout "FREEZE" the moment the screen gets away from you.
 * That keeps voice as the single input and turns the power-up into a second
 * vocabulary the player learns, rather than a distraction from the first.
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
    spoken: ['freeze', 'frees', 'freezing', 'ice', 'stop', 'frieze'],
  },
  slow: {
    type: 'slow',
    label: 'SLOW',
    icon: '◷',
    hue: 265,
    duration: 7,
    blurb: 'Half speed for 7s',
    spoken: ['slow', 'slower', 'slow motion', 'slowmo', 'slow', 'low'],
  },
  nuke: {
    type: 'nuke',
    label: 'NUKE',
    icon: '☢',
    hue: 12,
    duration: 0,
    blurb: 'Clears the screen',
    spoken: ['nuke', 'nuk', 'newk', 'bomb', 'blast', 'boom', 'nook'],
  },
  shield: {
    type: 'shield',
    label: 'SHIELD',
    icon: '◈',
    hue: 150,
    duration: 0,
    blurb: 'Restores one shield',
    spoken: ['shield', 'shields', 'sheild', 'guard', 'armor', 'armour', 'shed'],
  },
  double: {
    type: 'double',
    label: 'DOUBLE',
    icon: '✦',
    hue: 45,
    duration: 10,
    blurb: 'Double score for 10s',
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
