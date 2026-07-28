/**
 * The simulation. Deliberately framework-free.
 *
 * The previous version drove the game loop through React state: every frame
 * called `setGameState({...})`, rebuilt the entire problem array with `.map()`,
 * and regenerated a few hundred starfield objects. That is a full React
 * reconciliation plus several hundred allocations sixty times a second, which
 * a desktop absorbs and a phone does not — it was the main reason the game
 * needed a hardcoded 0.7x speed multiplier on mobile to feel playable.
 *
 * Here, nothing in the hot loop touches React or allocates. Entities are
 * mutated in place, particles come from a fixed pool, and the UI receives a
 * throttled snapshot roughly ten times a second. React renders the HUD; it
 * never renders the game.
 */

import {
  applyAnswer,
  rankFor,
  srtScore,
  targetDifficulty,
  weakestSkill,
  type AdaptiveState,
} from './adaptive';
import { generateDailySet, generateItem, type Item, type Skill } from './generator';
import { POWER_UPS, dropChance, rollPowerUp, type PowerUpType } from './powerups';
import { Rng, dailySeed } from './rng';
import {
  adaptiveStateOf,
  loadProfile,
  pushEvent,
  saveProfile,
  type GameMode,
  type Profile,
} from './profile';

export type BlockKind = 'normal' | 'fast' | 'armored' | 'boss';

export interface Block {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  vy: number;
  text: string;
  answer: number;
  skill: Skill;
  templateId: string;
  rating: number;
  kind: BlockKind;
  hp: number;
  maxHp: number;
  hue: number;
  /** Wall-clock ms when the block became fully readable on screen. */
  readableAt: number;
  /** Ms available between becoming readable and reaching the floor. */
  limitMs: number;
  /** 0-1, drives the spawn-in animation. */
  intro: number;
  hit: number;
  dying: number;
  /** Seconds until this block fires a shard. Bosses only. */
  shootTimer: number;
}

export interface Particle {
  alive: boolean;
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number;
  r: number; g: number; b: number;
}

export interface Beam {
  alive: boolean;
  x1: number; y1: number;
  x2: number; y2: number;
  life: number;
  hue: number;
}

export interface Popup {
  alive: boolean;
  x: number; y: number;
  text: string;
  life: number;
  hue: number;
  big: boolean;
}

/**
 * A single digit fired by a boss, homing on the ship.
 *
 * Lifted from ZType's Oppressor, which periodically sprays loose letters at the
 * player. It is the mechanic that turns the ship from a scoreboard into
 * something you are defending: until now nothing could ever reach it, so the
 * floor was the only threat and the ship was decoration. A shard is answerable
 * in one syllable, which keeps it fair when several are inbound at once.
 */
export interface Shard {
  alive: boolean;
  x: number; y: number;
  vx: number; vy: number;
  digit: number;
  spin: number;
  intro: number;
  dying: number;
}

/** A dropped power-up in flight toward the ship. */
export interface Pickup {
  alive: boolean;
  x: number; y: number;
  vx: number; vy: number;
  type: PowerUpType;
  hue: number;
  /** 0-1 progress of the flight; at 1 it lands in the inventory. */
  t: number;
  spin: number;
}

/** An expanding ring from a destroyed block. */
export interface Shockwave {
  alive: boolean;
  x: number; y: number;
  r: number;
  maxR: number;
  life: number;
  hue: number;
  width: number;
}

export interface ActiveEffect {
  type: PowerUpType;
  remaining: number;
}

export interface HudState {
  score: number;
  combo: number;
  multiplier: number;
  shield: number;
  maxShield: number;
  wave: number;
  overdrive: number;
  overdriveActive: boolean;
  rating: number;
  ratingDelta: number;
  rank: string;
  rankColor: string;
  mode: GameMode;
  /** Seconds left, for timed modes. Null when untimed. */
  timeLeft: number | null;
  solved: number;
  total: number | null;
  accuracy: number;
  status: GameStatus;
  lastRt: number | null;
  /** Held power-ups, oldest first. */
  inventory: PowerUpType[];
  activeEffects: ActiveEffect[];
}

export type GameStatus = 'idle' | 'playing' | 'paused' | 'over';

export type GameEvent =
  | { type: 'hit'; kind: BlockKind; combo: number; fast: boolean; source: InputSource }
  | { type: 'armorHit' }
  | { type: 'reject' }
  | { type: 'miss' }
  | { type: 'wave'; wave: number }
  | { type: 'overdrive' }
  | { type: 'shard' }
  | { type: 'shardKill' }
  | { type: 'shipHit' }
  | { type: 'drop'; power: PowerUpType }
  | { type: 'collect'; power: PowerUpType }
  | { type: 'power'; power: PowerUpType }
  | { type: 'powerFail' }
  | { type: 'gameover'; summary: RunSummary };

export type InputSource = 'voice' | 'touch' | 'key';

export interface RunSummary {
  mode: GameMode;
  score: number;
  bestCombo: number;
  solved: number;
  missed: number;
  accuracy: number;
  avgRtMs: number;
  fastestRtMs: number | null;
  ratingBefore: number;
  ratingAfter: number;
  voiceShare: number;
  durationMs: number;
  isRecord: boolean;
}

export interface ModeConfig {
  mode: GameMode;
  shield: number;
  /** Seconds. Null for untimed modes. */
  duration: number | null;
  /** Fixed problem count. Null for endless. */
  total: number | null;
  skills?: readonly Skill[];
  /** Fall speed scalar. */
  speed: number;
  /** Blocks on screen at once, at wave 1. */
  concurrency: number;
  /** Hard ceiling on any answer. Overrides the rating-based default. */
  maxAnswer?: number;
  /** Caps the difficulty the adaptive engine is allowed to request. */
  ratingCap?: number;
  /** Suppresses the harder block kinds. */
  plainBlocksOnly?: boolean;
}

export const MODES: Record<GameMode, ModeConfig> = {
  // Easy is a genuine floor, not just a slower arcade: answers stay under 20,
  // which keeps every one of them a single spoken word. Compound numbers are
  // where both the arithmetic and the speech recognition get hard, so removing
  // them removes two difficulties at once.
  easy: {
    mode: 'easy', shield: 5, duration: null, total: null, speed: 0.7, concurrency: 3,
    maxAnswer: 20, ratingCap: 900, plainBlocksOnly: true,
  },
  arcade: { mode: 'arcade', shield: 3, duration: null, total: null, speed: 1, concurrency: 3 },
  daily: { mode: 'daily', shield: 3, duration: null, total: 40, speed: 1, concurrency: 3 },
  blitz: { mode: 'blitz', shield: 99, duration: 60, total: null, speed: 1.1, concurrency: 4 },
  zen: { mode: 'zen', shield: 99, duration: null, total: null, speed: 0.78, concurrency: 3 },
};

const MAX_PARTICLES = 420;
const MAX_BEAMS = 12;
const MAX_POPUPS = 20;
const MAX_PICKUPS = 8;
const MAX_SHOCKWAVES = 10;
const MAX_SHARDS = 7;
const MAX_INVENTORY = 3;
const HUD_INTERVAL_MS = 90;

const HUES: Record<BlockKind, number> = {
  normal: 186,   // cyan
  fast: 96,      // green
  armored: 28,   // amber
  boss: 320,     // magenta
};

export interface GameCoreOptions {
  onHud?: (h: HudState) => void;
  onEvent?: (e: GameEvent) => void;
  /** Called whenever the set of live answers changes, to re-bias the recognizer. */
  onTargets?: (answers: number[]) => void;
  profile?: Profile;
}

export class GameCore {
  width = 360;
  height = 640;
  /** Y where blocks are considered to have landed. Set by the layout. */
  playBottom = 560;
  /** Y of the top HUD, below which blocks become readable. */
  playTop = 90;

  status: GameStatus = 'idle';
  blocks: Block[] = [];
  particles: Particle[] = [];
  beams: Beam[] = [];
  popups: Popup[] = [];
  pickups: Pickup[] = [];
  shockwaves: Shockwave[] = [];
  shards: Shard[] = [];

  inventory: PowerUpType[] = [];
  effects: ActiveEffect[] = [];

  /**
   * Where the ship is currently pointing, in radians from straight up.
   * The renderer eases toward this so the hull banks into its target.
   */
  aim = 0;
  /** Ramps to 1 while a shot is being fired, for the muzzle charge glow. */
  charge = 0;
  /**
   * Frames of frozen time remaining after a heavy kill. A few milliseconds of
   * complete stillness on impact reads as weight far more effectively than a
   * bigger explosion does.
   */
  hitStop = 0;
  /** Screen-shake direction, so debris and camera move away from the impact. */
  shakeX = 0;
  shakeY = 0;

  score = 0;
  combo = 0;
  bestCombo = 0;
  shield = 3;
  maxShield = 3;
  wave = 1;
  overdrive = 0;
  overdriveUntil = 0;
  shake = 0;
  flash = 0;
  /** 1 normally, <1 while overdrive slows time. */
  timeScale = 1;

  /**
   * Adaptive time pressure, multiplying fall speed.
   *
   * The rating engine adapts *what* it asks; this adapts *how much time* it
   * allows. They are genuinely separate axes — someone can know that 7x8 is 56
   * and still need four seconds to retrieve it — and conflating them means a
   * player who is answering correctly still drowns. Missing a block eases the
   * pressure immediately; a clean streak winds it back up.
   */
  pressure = 1;

  private profile: Profile;
  private adaptive: AdaptiveState;
  private opts: GameCoreOptions;
  private config: ModeConfig = MODES.arcade;
  private rng = new Rng(Date.now());

  private nextId = 1;
  private acc = 0;
  private lastTime = 0;
  /**
   * The engine's single source of time, advanced by `tick`.
   *
   * Response times are the input to the whole rating model, so the timestamp
   * that starts the clock (a block becoming readable, set during tick) and the
   * one that stops it (an answer arriving) must come from the same source.
   * Mixing tick time with a fresh `performance.now()` in `submit` produced
   * response times that were wrong by however far the two had drifted.
   */
  private clock = 0;
  private spawnCooldown = 0;
  private runStart = 0;
  private elapsed = 0;

  private solved = 0;
  private missed = 0;
  private rtSum = 0;
  private rtCount = 0;
  private fastestRt: number | null = null;
  private voiceHits = 0;
  private ratingBefore = 1000;
  private lastRatingDelta = 0;
  private lastRt: number | null = null;

  /** Pre-generated sequence for Daily; identical on every device. */
  private queue: Item[] = [];
  private queueIndex = 0;

  private hudTimer = 0;
  private hudDirty = true;

  constructor(opts: GameCoreOptions = {}) {
    this.opts = opts;
    this.profile = opts.profile ?? loadProfile();
    this.adaptive = adaptiveStateOf(this.profile);

    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 1, size: 2, r: 255, g: 255, b: 255 });
    }
    for (let i = 0; i < MAX_BEAMS; i++) {
      this.beams.push({ alive: false, x1: 0, y1: 0, x2: 0, y2: 0, life: 0, hue: 186 });
    }
    for (let i = 0; i < MAX_POPUPS; i++) {
      this.popups.push({ alive: false, x: 0, y: 0, text: '', life: 0, hue: 186, big: false });
    }
    for (let i = 0; i < MAX_PICKUPS; i++) {
      this.pickups.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, type: 'freeze', hue: 190, t: 0, spin: 0 });
    }
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      this.shockwaves.push({ alive: false, x: 0, y: 0, r: 0, maxR: 1, life: 0, hue: 186, width: 3 });
    }
    for (let i = 0; i < MAX_SHARDS; i++) {
      this.shards.push({ alive: false, x: 0, y: 0, vx: 0, vy: 0, digit: 0, spin: 0, intro: 0, dying: 0 });
    }
  }

  // ------------------------------------------------------------------ shards

  /**
   * Fires a digit shard from a boss toward the ship.
   *
   * The digit must be unused by anything else on screen. A spoken "seven" has
   * to resolve to exactly one target, and a shard colliding with a block's
   * answer would make the most urgent input in the game ambiguous.
   */
  private spawnShard(from: Block): void {
    const taken = new Set<number>();
    for (const b of this.blocks) if (b.dying <= 0) taken.add(b.answer);
    for (const s of this.shards) if (s.alive && s.dying <= 0) taken.add(s.digit);

    const free: number[] = [];
    for (let d = 0; d <= 9; d++) if (!taken.has(d)) free.push(d);
    if (free.length === 0) return;

    const slot = this.shards.find((s) => !s.alive);
    if (!slot) return;

    const digit = free[Math.floor(this.rng.next() * free.length)];
    const targetX = this.width / 2;
    const targetY = this.playBottom - 20;
    const angle = Math.atan2(targetY - from.y, targetX - from.x) + this.rng.float(-0.45, 0.45);
    const speed = this.height * 0.055 * (this.profile.settings.gentleFall ? 0.75 : 1);

    slot.alive = true;
    slot.x = from.x;
    slot.y = from.y + from.h / 2;
    slot.vx = Math.cos(angle) * speed;
    slot.vy = Math.sin(angle) * speed;
    slot.digit = digit;
    slot.spin = 0;
    slot.intro = 0;
    slot.dying = 0;
    this.opts.onEvent?.({ type: 'shard' });
    this.emitTargets();
  }

  /** Shot down by the player. */
  private killShard(s: Shard, scored: boolean): void {
    s.dying = 1;
    this.burst(s.x, s.y, 14, 320, 0.9);
    this.ring(s.x, s.y, 60, 320, 2);
    if (scored) {
      const gain = Math.round(8 * this.multiplier());
      this.score += gain;
      this.addPopup(s.x, s.y, `+${gain}`, 320, false);
    }
  }

  /** Reached the ship. */
  private shardHitsShip(s: Shard): void {
    s.dying = 1;
    this.combo = 0;
    this.pressure = Math.max(0.6, this.pressure - 0.08);
    if (this.config.mode !== 'zen') this.shield -= 1;
    this.flash = Math.max(this.flash, 0.8);
    this.applyShake(14, 0, -1);
    this.burst(this.width / 2, this.playBottom - 18, 26, 0, 1.4);
    this.ring(this.width / 2, this.playBottom - 18, 120, 0, 4);
    this.hitStop = 70;
    this.opts.onEvent?.({ type: 'shipHit' });
    this.hudDirty = true;
  }

  // --------------------------------------------------------------- power-ups

  /**
   * Spends a held power-up. Returns false when none is held, so the caller can
   * distinguish "said the word but had nothing" from "was not understood" —
   * they warrant different feedback.
   */
  activate(type: PowerUpType): boolean {
    if (this.status !== 'playing') return false;
    const idx = this.inventory.indexOf(type);
    if (idx === -1) {
      this.opts.onEvent?.({ type: 'powerFail' });
      return false;
    }
    this.inventory.splice(idx, 1);

    const def = POWER_UPS[type];
    switch (type) {
      case 'nuke': {
        // Cleared blocks count as neither solved nor missed: the player did not
        // answer them, so folding them into the ability estimate would be a
        // free rating boost for spending an item.
        for (const b of this.blocks) {
          if (b.dying > 0) continue;
          this.score += Math.round(6 * this.multiplier());
          this.burst(b.x, b.y + b.h / 2, 22, b.hue, 1.3);
          this.ring(b.x, b.y + b.h / 2, 120, b.hue);
          b.dying = 1;
        }
        this.applyShake(12, 0, 1);
        this.flash = Math.max(this.flash, 0.7);
        this.hitStop = 90;
        break;
      }
      case 'shield':
        this.shield = Math.min(this.maxShield, this.shield + 1);
        break;
      default:
        this.pushEffect(type, def.duration);
        break;
    }

    this.addPopup(this.width / 2, this.playBottom - 150, def.label, def.hue, true);
    this.opts.onEvent?.({ type: 'power', power: type });
    this.hudDirty = true;
    this.emitTargets();
    return true;
  }

  private pushEffect(type: PowerUpType, duration: number): void {
    const existing = this.effects.find((e) => e.type === type);
    if (existing) existing.remaining = Math.max(existing.remaining, duration);
    else this.effects.push({ type, remaining: duration });
  }

  hasEffect(type: PowerUpType): boolean {
    return this.effects.some((e) => e.type === type);
  }

  private dropFor(block: Block): void {
    if (this.config.mode === 'zen') return;
    if (this.inventory.length >= MAX_INVENTORY) return;
    if (!this.rng.chance(dropChance(block.kind, this.combo))) return;

    const type = rollPowerUp(() => this.rng.next(), {
      shield: this.shield,
      maxShield: this.maxShield,
      liveBlocks: this.blocks.reduce((n, b) => n + (b.dying > 0 ? 0 : 1), 0),
      concurrency: this.targetConcurrency(),
    });

    const p = this.pickups.find((q) => !q.alive);
    if (!p) return;
    p.alive = true;
    p.x = block.x;
    p.y = block.y + block.h / 2;
    p.vx = this.rng.float(-70, 70);
    p.vy = -this.rng.float(40, 110);
    p.type = type;
    p.hue = POWER_UPS[type].hue;
    p.t = 0;
    p.spin = 0;
    this.opts.onEvent?.({ type: 'drop', power: type });
  }

  // ---------------------------------------------------------------- lifecycle

  resize(width: number, height: number, playTop: number, playBottom: number): void {
    const prevW = this.width;
    this.width = width;
    this.height = height;
    this.playTop = playTop;
    this.playBottom = playBottom;

    // Keep blocks proportionally placed through an orientation change.
    if (prevW > 0 && Math.abs(prevW - width) > 1) {
      const k = width / prevW;
      for (const b of this.blocks) b.x = Math.max(b.w / 2 + 8, Math.min(width - b.w / 2 - 8, b.x * k));
    }
  }

  start(mode: GameMode, skills?: readonly Skill[]): void {
    const cfg = { ...MODES[mode] };
    if (skills?.length) cfg.skills = skills;
    this.config = cfg;

    this.status = 'playing';
    this.blocks.length = 0;
    for (const p of this.particles) p.alive = false;
    for (const b of this.beams) b.alive = false;
    for (const p of this.popups) p.alive = false;
    for (const p of this.pickups) p.alive = false;
    for (const s of this.shockwaves) s.alive = false;
    for (const s of this.shards) s.alive = false;
    this.inventory.length = 0;
    this.effects.length = 0;
    this.aim = 0;
    this.charge = 0;
    this.hitStop = 0;
    this.shakeX = 0;
    this.shakeY = 0;

    this.score = 0;
    this.combo = 0;
    this.bestCombo = 0;
    this.shield = cfg.shield;
    this.maxShield = cfg.shield;
    this.wave = 1;
    this.overdrive = 0;
    this.overdriveUntil = 0;
    this.shake = 0;
    this.flash = 0;
    this.timeScale = 1;
    this.pressure = 1;

    this.solved = 0;
    this.missed = 0;
    this.rtSum = 0;
    this.rtCount = 0;
    this.fastestRt = null;
    this.voiceHits = 0;
    this.lastRatingDelta = 0;
    this.lastRt = null;
    this.ratingBefore = this.profile.theta;

    this.elapsed = 0;
    this.spawnCooldown = 0;
    this.acc = 0;
    // Run-relative: milliseconds of active play since this run began.
    this.clock = 0;
    this.lastTime = 0;
    this.runStart = -1;

    // The Daily Challenge is generated from the UTC date alone, so every
    // player in the world gets a byte-identical sequence with no network call.
    if (mode === 'daily') {
      this.queue = generateDailySet(dailySeed(), cfg.total ?? 40);
      this.queueIndex = 0;
      this.rng = new Rng(dailySeed() ^ 0x5f3a);
    } else {
      this.queue = [];
      this.queueIndex = 0;
      this.rng = new Rng((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
    }

    this.profile.modes[mode].plays += 1;
    saveProfile(this.profile);

    // Seed the screen immediately rather than waiting on the spawn timer, so
    // the first thing the player sees is something to answer.
    const initial = Math.min(3, this.targetConcurrency());
    for (let i = 0; i < initial; i++) this.spawn(-i * 96);

    this.emitTargets();
    this.hudDirty = true;
    this.pushHud();
  }

  pause(): void {
    if (this.status === 'playing') {
      this.status = 'paused';
      this.hudDirty = true;
      this.pushHud();
    }
  }

  resume(): void {
    if (this.status === 'paused') {
      this.status = 'playing';
      // Re-anchor on the next tick. Resuming after a long pause must not be
      // charged as one enormous frame, which would drop every block through
      // the floor at once.
      this.lastTime = 0;
      this.acc = 0;
      this.hudDirty = true;
      this.pushHud();
    }
  }

  end(): void {
    if (this.status === 'over') return;
    this.status = 'over';

    const durationMs = this.runStart < 0 ? 0 : Math.max(0, this.clock - this.runStart);
    this.profile.totalPlayMs += durationMs;

    const rec = this.profile.modes[this.config.mode];
    const isRecord = this.score > rec.bestScore;
    if (isRecord) rec.bestScore = this.score;
    if (this.bestCombo > rec.bestStreak) rec.bestStreak = this.bestCombo;

    if (this.config.mode === 'daily') {
      const key = new Date().toISOString().slice(0, 10);
      const prev = this.profile.daily[key];
      if (!prev || this.score > prev.score) {
        this.profile.daily[key] = {
          score: this.score,
          correct: this.solved,
          total: this.config.total ?? 40,
          ms: durationMs,
        };
      }
    }

    saveProfile(this.profile);

    const summary: RunSummary = {
      mode: this.config.mode,
      score: this.score,
      bestCombo: this.bestCombo,
      solved: this.solved,
      missed: this.missed,
      accuracy: this.solved + this.missed > 0 ? this.solved / (this.solved + this.missed) : 0,
      avgRtMs: this.rtCount > 0 ? this.rtSum / this.rtCount : 0,
      fastestRtMs: this.fastestRt,
      ratingBefore: Math.round(this.ratingBefore),
      ratingAfter: Math.round(this.profile.theta),
      voiceShare: this.solved > 0 ? this.voiceHits / this.solved : 0,
      durationMs,
      isRecord,
    };

    this.opts.onEvent?.({ type: 'gameover', summary });
    this.hudDirty = true;
    this.pushHud();
  }

  // -------------------------------------------------------------------- input

  /**
   * Attempts to destroy a block with `value`.
   *
   * When several blocks share an answer the lowest is targeted, because it is
   * the one about to cost a life. Answers are unique among live blocks by
   * construction (see generator.ts), so this is really just a tiebreak.
   */
  submit(value: number, source: InputSource): boolean {
    if (this.status !== 'playing') return false;

    // Shards come first. They are single digits closing on the ship, and if one
    // shares a digit with anything else the player has no way to disambiguate —
    // so answering the imminent threat is always the right reading.
    if (value >= 0 && value <= 9) {
      let shard: Shard | null = null;
      for (const s of this.shards) {
        if (!s.alive || s.dying > 0 || s.digit !== value) continue;
        if (!shard || s.y > shard.y) shard = s;
      }
      if (shard) {
        this.fireBeamAt(shard.x, shard.y, 320);
        this.killShard(shard, true);
        this.combo += 1;
        if (this.combo > this.bestCombo) this.bestCombo = this.combo;
        this.applyShake(4, shard.x - this.width / 2, shard.y - this.playBottom);
        this.opts.onEvent?.({ type: 'shardKill' });
        this.emitTargets();
        this.hudDirty = true;
        return true;
      }
    }

    let target: Block | null = null;
    for (const b of this.blocks) {
      if (b.dying > 0 || b.answer !== value) continue;
      if (!target || b.y > target.y) target = b;
    }

    if (!target) {
      // A wrong keypad entry. Voice can never land here — it only proposes
      // values that are already on screen. No rating change: there is no
      // specific item to score against, and punishing a typo as a maths error
      // would corrupt the ability estimate.
      this.combo = 0;
      this.shake = Math.max(this.shake, 3);
      this.opts.onEvent?.({ type: 'reject' });
      this.hudDirty = true;
      return false;
    }

    const now = this.clock;
    target.hp -= 1;

    if (target.hp > 0) {
      // Armoured blocks take two answers; the second problem is revealed on
      // the first hit.
      target.hit = 1;
      const item = this.nextItem(target.rating + 40);
      target.text = item.text;
      target.answer = item.answer;
      target.templateId = item.templateId;
      target.skill = item.skill;
      this.burst(target.x, target.y + target.h / 2, 14, target.hue, 1.4);
      this.ring(target.x, target.y + target.h / 2, 70, target.hue, 2);
      this.applyShake(6, target.x - this.width / 2, target.y - this.playBottom);
      this.fireBeam(target);
      this.opts.onEvent?.({ type: 'armorHit' });
      this.emitTargets();
      return true;
    }

    this.resolve(target, true, now, source);
    return true;
  }

  /** Clears the screen. Earned by chaining answers, spendable by voice. */
  triggerOverdrive(): boolean {
    if (this.status !== 'playing' || this.overdrive < 1) return false;
    this.overdrive = 0;
    this.overdriveUntil = this.clock + 7000;
    this.flash = 1;
    this.shake = 8;
    this.opts.onEvent?.({ type: 'overdrive' });
    this.hudDirty = true;
    return true;
  }

  // ------------------------------------------------------------------ scoring

  private resolve(block: Block, correct: boolean, now: number, source: InputSource): void {
    const rtMs = Math.max(60, now - block.readableAt);
    const limitMs = Math.max(1200, block.limitMs);
    const srt = srtScore(correct, rtMs, limitMs);

    // Feed the continuous speed/accuracy score into the rating rather than a
    // binary right/wrong, so fluency and mere correctness are distinguished.
    const result = applyAnswer(this.adaptive, {
      templateId: block.templateId,
      skill: block.skill,
      itemRating: block.rating,
      correct,
      rtMs,
      limitMs,
    });
    this.lastRatingDelta += result.thetaDelta;

    this.profile.answers = this.adaptive.answers;
    if (correct) this.profile.correct += 1;
    if (correct && source === 'voice') {
      this.voiceHits += 1;
      this.profile.voiceAnswers += 1;
    }

    pushEvent(this.profile, {
      t: Date.now(),
      tpl: block.templateId,
      sk: block.skill,
      b: Math.round(block.rating),
      ok: correct ? 1 : 0,
      rt: Math.round(rtMs),
      srt: Math.round(srt * 1000) / 1000,
      th: Math.round(this.profile.theta),
      src: source === 'voice' ? 'v' : 'k',
    });
    saveProfile(this.profile);

    if (correct) {
      this.solved += 1;
      this.combo += 1;
      if (this.combo > this.bestCombo) this.bestCombo = this.combo;
      this.rtSum += rtMs;
      this.rtCount += 1;
      this.lastRt = rtMs;
      if (this.fastestRt === null || rtMs < this.fastestRt) this.fastestRt = rtMs;

      // Score rewards difficulty and speed, not just volume: a hard problem
      // answered instantly is worth many times an easy one answered slowly.
      const speedBonus = 1 + Math.max(0, srt) * 1.1;
      const difficultyBonus = 1 + Math.max(0, block.rating - 700) / 900;
      const kindBonus = block.kind === 'boss' ? 3 : block.kind === 'armored' ? 2 : block.kind === 'fast' ? 1.5 : 1;
      const gain = Math.round(10 * speedBonus * difficultyBonus * kindBonus * this.multiplier());
      this.score += gain;

      // Wind the pressure back up only on a sustained clean run, and slowly.
      // Recovering as fast as it drops would just re-drown the player.
      if (this.combo > 0 && this.combo % 4 === 0) {
        this.pressure = Math.min(1.25, this.pressure + 0.04);
      }

      const fast = srt > 0.55;
      this.overdrive = Math.min(1, this.overdrive + (fast ? 0.14 : 0.08));
      void fast;

      const cx = block.x;
      const cy = block.y + block.h / 2;
      const heavy = block.kind === 'boss';

      this.fireBeam(block);
      // Every kill gets a real explosion, not just the rare ones. Destroying a
      // block is the single most repeated action in the game — if it does not
      // land, nothing does.
      this.burst(cx, cy, heavy ? 70 : block.kind === 'armored' ? 52 : 42, block.hue, heavy ? 1.9 : 1.35);
      this.ring(cx, cy, heavy ? 230 : 165, block.hue, heavy ? 7 : 5);
      this.ring(cx, cy, heavy ? 320 : 90, heavy ? 45 : block.hue, heavy ? 3 : 2);
      this.flash = Math.max(this.flash, heavy ? 0.5 : 0.22);

      // Kick the camera away from the impact, and stop time briefly — a few
      // frames of stillness sell weight better than more particles.
      this.applyShake(heavy ? 22 : block.kind === 'armored' ? 14 : 9,
        cx - this.width / 2, cy - this.playBottom);
      this.hitStop = heavy ? 130 : fast ? 45 : 32;

      this.addPopup(cx, block.y, `+${gain}`, block.hue, heavy || fast);
      this.dropFor(block);
      if (this.combo > 0 && this.combo % 5 === 0) {
        this.addPopup(this.width / 2, this.playBottom - 130, `${this.combo} CHAIN`, 320, true);
      }

      this.opts.onEvent?.({ type: 'hit', kind: block.kind, combo: this.combo, fast, source });
    } else {
      this.missed += 1;
      this.combo = 0;
      // Back off hard and at once. A miss means the game outran the player,
      // and the next block is already on its way down.
      this.pressure = Math.max(0.6, this.pressure - 0.14);
      if (this.config.mode !== 'zen') this.shield -= 1;
      this.flash = Math.max(this.flash, 0.85);
      // A breach shakes straight up from the floor, not toward the block.
      this.applyShake(15, 0, -1);
      this.burst(block.x, this.playBottom - 6, 30, 0, 1.6);
      this.ring(block.x, this.playBottom - 6, 150, 0, 4);
      this.hitStop = 70;
      this.opts.onEvent?.({ type: 'miss' });
    }

    block.dying = 1;
    this.hudDirty = true;
  }

  private multiplier(): number {
    const chain = 1 + Math.floor(this.combo / 4);
    const od = this.overdriveActive() ? 2 : 1;
    return Math.min(8, chain) * od;
  }

  overdriveActive(): boolean {
    return this.clock < this.overdriveUntil;
  }

  // ----------------------------------------------------------------- spawning

  private targetConcurrency(): number {
    // Every extra simultaneous block splits attention, which costs far more
    // than raw speed does. Grow it slowly, and cap well below the point where
    // the screen becomes unreadable on a phone.
    const growth = Math.floor((this.wave - 1) / 3);
    return Math.min(6, this.config.concurrency + growth);
  }

  /**
   * Difficulty for the next item.
   *
   * Daily replays a fixed sequence so scores stay comparable worldwide. Every
   * other mode aims at the rating that yields roughly a 78% success rate, with
   * a little jitter for variety, and occasionally targets the player's weakest
   * skill so mastered ground is not endlessly re-covered.
   */
  private nextItem(overrideTarget?: number): Item {
    if (this.config.mode === 'daily' && this.queue.length > 0) {
      const item = this.queue[this.queueIndex % this.queue.length];
      this.queueIndex += 1;
      return item;
    }

    let base = overrideTarget ?? targetDifficulty(this.profile.theta);
    const jitter = this.rng.gaussian(0, 90);
    let waveLift = Math.min(220, (this.wave - 1) * 22);

    // Easy mode ignores a high rating on purpose. Someone who wants small
    // numbers wants small numbers, not the difficulty their history earned.
    if (this.config.ratingCap !== undefined) {
      base = Math.min(base, this.config.ratingCap);
      waveLift = Math.min(waveLift, 80);
    }

    let skills = this.config.skills;
    if (!skills && this.rng.chance(0.3)) {
      const weak = weakestSkill(this.adaptive);
      if (weak) skills = [weak];
    }

    const exclude = new Set<number>();
    for (const b of this.blocks) if (b.dying <= 0) exclude.add(b.answer);

    return generateItem({
      rng: this.rng,
      targetRating: base + jitter + waveLift,
      ratings: this.profile.templateRatings,
      skills,
      exclude,
      // Three-digit answers are a mouthful mid-arcade, so keep them rare and
      // only once the player has earned them.
      maxAnswer: this.config.maxAnswer ?? (this.profile.theta > 1500 ? 999 : 200),
    });
  }

  private pickKind(): BlockKind {
    if (this.config.plainBlocksOnly) return 'normal';
    if (this.wave >= 5 && this.rng.chance(0.06)) return 'boss';
    if (this.wave >= 3 && this.rng.chance(0.12)) return 'armored';
    if (this.wave >= 2 && this.rng.chance(0.16)) return 'fast';
    return 'normal';
  }

  private spawn(yOffset = 0): void {
    if (this.config.total !== null && this.solved + this.missed + this.blocks.length >= this.config.total) return;

    const item = this.nextItem();
    const kind = this.config.mode === 'zen' ? 'normal' : this.pickKind();

    // Width follows the text, with a floor so short answers still give a
    // comfortable touch target.
    const charW = 12.5;
    const w = Math.max(96, Math.min(this.width - 24, item.text.length * charW + 34));
    // Taller than strictly needed for the text: the upper third is the face.
    const h = kind === 'boss' ? 74 : 58;

    const speedScale = this.config.speed
      * (this.profile.settings.gentleFall ? 0.72 : 1)
      * (kind === 'fast' ? 1.4 : kind === 'boss' ? 0.66 : 1);
    // Fall speed rises with wave but is capped: past a point, speed stops
    // testing arithmetic and starts testing reflexes.
    const wavePace = Math.min(1.7, 1 + (this.wave - 1) * 0.045);
    const vy = (this.height * 0.038) * wavePace * speedScale * this.pressure;

    const x = this.pickX(w);

    // Stack vertically when the row is full. On a 375px phone only about three
    // blocks fit side by side, so with a concurrency of four or more, purely
    // horizontal placement guarantees overlapping text sooner or later.
    let y = this.playTop - h - 10 + yOffset;
    for (let guard = 0; guard < 8; guard++) {
      const clash = this.blocks.some((b) =>
        b.dying <= 0 &&
        Math.abs(b.x - x) < (b.w + w) / 2 + 6 &&
        Math.abs(b.y - y) < Math.max(b.h, h) + 14);
      if (!clash) break;
      y -= h + 16;
    }

    this.blocks.push({
      id: this.nextId++,
      x,
      y,
      w, h, vy,
      text: item.text,
      answer: item.answer,
      skill: item.skill,
      templateId: item.templateId,
      rating: item.rating,
      kind,
      hp: kind === 'armored' ? 2 : 1,
      maxHp: kind === 'armored' ? 2 : 1,
      hue: HUES[kind],
      readableAt: 0,
      limitMs: 0,
      intro: 0,
      hit: 0,
      dying: 0,
      shootTimer: kind === 'boss' ? 1.6 : 0,
    });
  }

  /**
   * Eases overlapping blocks apart horizontally.
   *
   * Spawn-time placement is not enough on its own: block kinds fall at
   * different speeds, so a "fast" block inevitably catches up to a slower one
   * and the two equations end up drawn on top of each other. In a game where
   * the whole task is reading the equation, unreadable text is a genuine
   * failure rather than a cosmetic one.
   *
   * The nudge is capped per frame so blocks drift apart smoothly instead of
   * snapping, and it only runs on pairs that actually overlap on both axes.
   * With at most eight live blocks this is a handful of comparisons.
   */
  private separate(): void {
    const blocks = this.blocks;
    for (let i = 0; i < blocks.length; i++) {
      const a = blocks[i];
      if (a.dying > 0) continue;
      for (let j = i + 1; j < blocks.length; j++) {
        const b = blocks[j];
        if (b.dying > 0) continue;

        const dy = Math.abs(b.y - a.y);
        if (dy >= (a.h + b.h) / 2 + 4) continue;

        const dx = b.x - a.x;
        const overlap = (a.w + b.w) / 2 + 8 - Math.abs(dx);
        if (overlap <= 0) continue;

        // Deterministic tiebreak when perfectly aligned, so they never stall.
        const dir = dx === 0 ? (a.id % 2 === 0 ? 1 : -1) : Math.sign(dx);
        const push = Math.min(overlap / 2, 3.5);
        a.x -= dir * push;
        b.x += dir * push;

        const halfA = a.w / 2 + 8;
        const halfB = b.w / 2 + 8;
        a.x = Math.max(halfA, Math.min(this.width - halfA, a.x));
        b.x = Math.max(halfB, Math.min(this.width - halfB, b.x));
      }
    }
  }

  /**
   * Spreads blocks horizontally. Scores candidates by edge-to-edge clearance
   * rather than centre distance — two 110px blocks 80px apart have plenty of
   * centre separation and still overlap.
   */
  private pickX(w: number): number {
    const half = w / 2;
    const min = half + 10;
    const max = Math.max(min, this.width - half - 10);
    if (max <= min) return min;

    let best = this.rng.float(min, max);
    let bestGap = -Infinity;

    for (let i = 0; i < 10; i++) {
      const cand = this.rng.float(min, max);
      let gap = Infinity;
      for (const b of this.blocks) {
        if (b.dying > 0) continue;
        if (b.y > this.playTop + 240) continue; // only the crowded top matters
        gap = Math.min(gap, Math.abs(b.x - cand) - (b.w + w) / 2);
      }
      if (gap === Infinity) return cand;   // nothing nearby, take it
      if (gap > 8) return cand;            // comfortably clear, good enough
      if (gap > bestGap) { bestGap = gap; best = cand; }
    }
    return best;
  }

  // --------------------------------------------------------------------- loop

  /** Advances the simulation. `now` comes from requestAnimationFrame. */
  tick(now: number): void {
    if (this.lastTime === 0) this.lastTime = now;
    let frameMs = now - this.lastTime;
    this.lastTime = now;

    // A backgrounded tab returns a huge delta. Clamp it, or every block
    // teleports through the floor on resume.
    if (frameMs > 250) frameMs = 250;

    // Hit-stop: the world holds still for a few frames after a heavy impact,
    // while effects and the HUD keep animating. It costs nothing and is most
    // of what separates a hit that lands from one that merely happens.
    if (this.hitStop > 0) {
      this.hitStop = Math.max(0, this.hitStop - frameMs);
      this.decay(frameMs / 1000);
      this.hudTimer += frameMs;
      if (this.hudDirty || this.hudTimer >= HUD_INTERVAL_MS) {
        this.hudTimer = 0;
        this.pushHud();
      }
      return;
    }

    if (this.status === 'playing') {
      // The clock accumulates only while playing, so it measures active play
      // rather than wall time. Response times feed the rating directly, and a
      // player who pauses to take a call must not come back to find the
      // problem they were mid-way through scored as an eight-minute answer.
      this.clock += frameMs;
      if (this.runStart < 0) this.runStart = this.clock;

      this.acc += frameMs;
      const step = 1000 / 60;
      let steps = 0;
      while (this.acc >= step && steps < 5) {
        this.update(step / 1000, this.clock);
        this.acc -= step;
        steps++;
      }
      if (steps === 5) this.acc = 0;
    }

    // Decorative state keeps easing even while paused, so the pause overlay
    // does not look frozen mid-explosion.
    this.decay(frameMs / 1000);

    this.hudTimer += frameMs;
    if (this.hudDirty || this.hudTimer >= HUD_INTERVAL_MS) {
      this.hudTimer = 0;
      this.pushHud();
    }
  }

  private decay(dt: number): void {
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 26);
    if (this.flash > 0) this.flash = Math.max(0, this.flash - dt * 2.6);
    if (this.charge > 0) this.charge = Math.max(0, this.charge - dt * 3.4);
    // Ease the hull back to level when it has nothing to aim at.
    this.aim *= 1 - Math.min(1, dt * 2.2);

    for (const s of this.shockwaves) {
      if (!s.alive) continue;
      s.life -= dt * 2.4;
      // Fast at first, then easing out — the profile of a real blast front.
      s.r += (s.maxR - s.r) * Math.min(1, dt * 7);
      if (s.life <= 0) s.alive = false;
    }

    for (const p of this.pickups) {
      if (!p.alive) continue;
      p.spin += dt * 4;
      p.t = Math.min(1, p.t + dt * 0.75);

      // Tossed out, then reeled in to the ship on an ease-in curve.
      const tx = this.width / 2;
      const ty = this.playBottom - 26;
      const pull = p.t * p.t;
      p.vy += 210 * dt * (1 - pull);
      p.x += p.vx * dt * (1 - pull);
      p.y += p.vy * dt * (1 - pull);
      p.x += (tx - p.x) * pull * Math.min(1, dt * 6);
      p.y += (ty - p.y) * pull * Math.min(1, dt * 6);

      if (p.t >= 1 || (Math.abs(p.x - tx) < 14 && Math.abs(p.y - ty) < 14)) {
        p.alive = false;
        this.opts.onEvent?.({ type: 'collect', power: p.type });

        // Defensive power-ups fire on contact. Holding a freeze while blocks
        // are landing helps nobody: by the time you have decided to spend it,
        // the shield is already gone.
        if (POWER_UPS[p.type].auto) {
          this.inventory.push(p.type);
          this.activate(p.type);
        } else if (this.inventory.length < MAX_INVENTORY) {
          this.inventory.push(p.type);
          this.addPopup(tx, ty - 40, POWER_UPS[p.type].label, p.hue, false);
          this.hudDirty = true;
        }
      }
    }

    for (const p of this.particles) {
      if (!p.alive) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 320 * dt;
      p.vx *= 1 - 1.1 * dt;
      p.life -= dt;
      if (p.life <= 0) p.alive = false;
    }
    for (const b of this.beams) {
      if (!b.alive) continue;
      // Slower fade: the old beam was gone in under 200ms, which on a desktop
      // frame budget meant it could be missed entirely.
      b.life -= dt * 3.4;
      if (b.life <= 0) b.alive = false;
    }
    for (const p of this.popups) {
      if (!p.alive) continue;
      p.y -= 42 * dt;
      p.life -= dt * 1.15;
      if (p.life <= 0) p.alive = false;
    }
  }

  private update(dt: number, now: number): void {
    this.elapsed += dt;

    for (let i = this.effects.length - 1; i >= 0; i--) {
      this.effects[i].remaining -= dt;
      if (this.effects[i].remaining <= 0) {
        this.effects.splice(i, 1);
        this.hudDirty = true;
      }
    }

    // Time scale, slowest effect wins.
    let scale = 1;
    if (this.overdriveActive()) scale = Math.min(scale, 0.45);
    if (this.hasEffect('slow')) scale = Math.min(scale, 0.4);
    if (this.hasEffect('freeze')) scale = 0;

    // Near-miss slow motion. When something is seconds from breaching and the
    // player has no help left, time stretches — it turns the worst moment in a
    // run into the most dramatic one, and buys a beat to actually answer.
    if (scale === 1) {
      let closest = Infinity;
      for (const b of this.blocks) {
        if (b.dying > 0 || b.readableAt === 0) continue;
        closest = Math.min(closest, this.playBottom - (b.y + b.h));
      }
      if (closest < 70) scale = 0.55 + (closest / 70) * 0.45;
    }
    this.timeScale = scale;

    if (this.config.duration !== null && this.elapsed >= this.config.duration) {
      this.end();
      return;
    }

    let changed = false;

    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i];

      if (b.dying > 0) {
        b.dying -= dt * 5;
        if (b.dying <= 0) {
          this.blocks.splice(i, 1);
          changed = true;
        }
        continue;
      }

      if (b.intro < 1) b.intro = Math.min(1, b.intro + dt * 4.5);
      if (b.hit > 0) b.hit = Math.max(0, b.hit - dt * 3.5);

      // Bosses lay down covering fire once they are on screen.
      if (b.kind === 'boss' && b.readableAt > 0) {
        b.shootTimer -= dt * this.timeScale;
        if (b.shootTimer <= 0) {
          b.shootTimer = this.rng.float(1.9, 3.4);
          this.spawnShard(b);
        }
      }

      b.y += b.vy * dt * this.timeScale;

      // The clock starts when the block is fully visible, not when it spawns
      // above the viewport — otherwise response time would include seconds
      // during which the problem could not be read. The time limit used by the
      // HSHS rule is exactly the time left before it lands, so the scoring
      // pressure and the visible pressure are the same thing.
      if (b.readableAt === 0 && b.y >= this.playTop) {
        b.readableAt = now;
        const distance = Math.max(1, this.playBottom - b.h - b.y);
        b.limitMs = (distance / Math.max(1, b.vy)) * 1000;
      }

      if (b.y + b.h >= this.playBottom) {
        if (b.readableAt === 0) b.readableAt = now - 1500;
        this.resolve(b, false, now, 'touch');
        changed = true;
      }
    }

    this.separate();

    // Shards close on the ship and detonate against it.
    const shipX = this.width / 2;
    const shipY = this.playBottom - 18;
    for (const s of this.shards) {
      if (!s.alive) continue;
      if (s.dying > 0) {
        s.dying -= dt * 5;
        if (s.dying <= 0) { s.alive = false; changed = true; }
        continue;
      }
      if (s.intro < 1) s.intro = Math.min(1, s.intro + dt * 5);
      s.spin += dt * 3;

      // Gentle homing, so a shard cannot simply be outlasted.
      const ang = Math.atan2(shipY - s.y, shipX - s.x);
      s.vx += Math.cos(ang) * 60 * dt;
      s.vy += Math.sin(ang) * 60 * dt;
      s.x += s.vx * dt * this.timeScale;
      s.y += s.vy * dt * this.timeScale;

      if (Math.hypot(s.x - shipX, s.y - shipY) < 22) {
        this.shardHitsShip(s);
        changed = true;
      } else if (s.y > this.height + 40 || s.x < -40 || s.x > this.width + 40) {
        s.alive = false;
        changed = true;
      }
    }

    if (this.shield <= 0 && this.config.mode !== 'zen') {
      this.end();
      return;
    }

    if (this.config.total !== null && this.solved + this.missed >= this.config.total) {
      this.end();
      return;
    }

    // Waves are paced by problems solved, not a timer, so a slow player is not
    // punished with an accelerating screen they never asked for. Eight solved
    // for wave 2 keeps the first promotion within reach of a single run.
    const nextWaveAt = this.wave * 8;
    if (this.solved >= nextWaveAt) {
      this.wave += 1;
      this.opts.onEvent?.({ type: 'wave', wave: this.wave });
      this.addPopup(this.width / 2, this.playBottom - 190, `WAVE ${this.wave}`, 280, true);
      this.hudDirty = true;
    }

    this.spawnCooldown -= dt;
    const live = this.blocks.reduce((n, b) => n + (b.dying > 0 ? 0 : 1), 0);
    if (live < this.targetConcurrency() && this.spawnCooldown <= 0) {
      this.spawn();
      // Tighter spacing as waves climb, floored so blocks never stack. Scaled
      // by pressure too, so easing off after a miss also buys breathing room
      // between spawns rather than only slowing what is already falling.
      this.spawnCooldown = Math.max(0.7, (2.0 - this.wave * 0.06) / this.pressure);
      changed = true;
    }

    if (changed) this.emitTargets();
  }

  // ------------------------------------------------------------------ effects

  private fireBeam(block: Block): void {
    this.fireBeamAt(block.x, block.y + block.h / 2, block.hue);
  }

  private fireBeamAt(x: number, y: number, hue: number): void {
    const beam = this.beams.find((b) => !b.alive);
    const originY = this.playBottom - 22;
    if (beam) {
      beam.alive = true;
      beam.x1 = this.width / 2;
      beam.y1 = originY;
      beam.x2 = x;
      beam.y2 = y;
      beam.life = 1;
      beam.hue = hue;
    }
    // Point the hull at whatever it just shot, and charge the muzzle.
    this.aim = Math.atan2(x - this.width / 2, originY - y);
    this.charge = 1;
  }

  /**
   * Directional screen shake.
   *
   * Shaking on a random axis reads as noise. Kicking the camera *away* from
   * the impact reads as force, because it is what a real recoil would do.
   */
  private applyShake(power: number, dx: number, dy: number): void {
    const len = Math.hypot(dx, dy) || 1;
    this.shake = Math.max(this.shake, power);
    this.shakeX = dx / len;
    this.shakeY = dy / len;
  }

  /** Expanding ring — the readable part of an explosion at a glance. */
  private ring(x: number, y: number, maxR: number, hue: number, width = 3): void {
    const s = this.shockwaves.find((q) => !q.alive);
    if (!s) return;
    s.alive = true;
    s.x = x; s.y = y;
    s.r = 6;
    s.maxR = maxR;
    s.life = 1;
    s.hue = hue;
    s.width = width;
  }

  /**
   * Particle burst.
   *
   * Three populations rather than one, because a single uniform spray looks
   * like a spray. A white-hot core sells the initial flash, mid debris carries
   * the block's own colour outward, and slow embers linger after the rest has
   * gone so the space does not snap back to empty.
   */
  private burst(x: number, y: number, count: number, hue: number, power: number): void {
    const [r, g, b] = hslToRgb(hue / 360, 0.85, 0.62);
    let spawned = 0;

    for (let i = 0; i < this.particles.length && spawned < count; i++) {
      const p = this.particles[i];
      if (p.alive) continue;

      const tier = spawned / count;
      const angle = this.rng.float(0, Math.PI * 2);
      let speed: number;

      if (tier < 0.22) {
        // Core: fast, white-hot, short-lived.
        speed = this.rng.float(220, 420) * power;
        p.maxLife = this.rng.float(0.14, 0.28);
        p.size = this.rng.float(2.4, 5);
        p.r = 255; p.g = 255; p.b = 245;
      } else if (tier < 0.8) {
        // Debris: the block's colour, thrown outward.
        speed = this.rng.float(70, 260) * power;
        p.maxLife = this.rng.float(0.35, 0.8);
        p.size = this.rng.float(1.6, 4);
        p.r = r; p.g = g; p.b = b;
      } else {
        // Embers: slow, dim, long.
        speed = this.rng.float(18, 80) * power;
        p.maxLife = this.rng.float(0.9, 1.6);
        p.size = this.rng.float(1, 2.4);
        p.r = Math.min(255, r + 40); p.g = Math.round(g * 0.7); p.b = Math.round(b * 0.6);
      }

      p.alive = true;
      p.x = x + this.rng.float(-4, 4);
      p.y = y + this.rng.float(-4, 4);
      p.vx = Math.cos(angle) * speed;
      p.vy = Math.sin(angle) * speed - 50;
      p.life = p.maxLife;
      spawned++;
    }
  }

  private addPopup(x: number, y: number, text: string, hue: number, big: boolean): void {
    const p = this.popups.find((q) => !q.alive);
    if (!p) return;
    p.alive = true;
    p.x = x;
    p.y = y;
    p.text = text;
    p.life = 1;
    p.hue = hue;
    p.big = big;
  }

  // --------------------------------------------------------------------- wire

  private emitTargets(): void {
    if (!this.opts.onTargets) return;
    this.opts.onTargets(this.liveAnswers());
  }

  private pushHud(): void {
    this.hudDirty = false;
    if (!this.opts.onHud) return;
    const rank = rankFor(this.profile.theta);
    this.opts.onHud({
      score: this.score,
      combo: this.combo,
      multiplier: this.multiplier(),
      shield: Math.max(0, this.shield),
      maxShield: this.maxShield,
      wave: this.wave,
      overdrive: this.overdrive,
      overdriveActive: this.overdriveActive(),
      rating: Math.round(this.profile.theta),
      ratingDelta: Math.round(this.lastRatingDelta),
      rank: rank.name,
      rankColor: rank.color,
      mode: this.config.mode,
      timeLeft: this.config.duration !== null ? Math.max(0, this.config.duration - this.elapsed) : null,
      solved: this.solved,
      total: this.config.total,
      accuracy: this.solved + this.missed > 0 ? this.solved / (this.solved + this.missed) : 1,
      status: this.status,
      lastRt: this.lastRt,
      inventory: this.inventory.slice(),
      activeEffects: this.effects.map((e) => ({ type: e.type, remaining: e.remaining })),
    });
  }

  /**
   * Screen positions of the docked power-ups, alternating left and right of
   * the ship. The renderer draws them here and the shell hit-tests taps
   * against the same list, so the two can never drift apart.
   */
  powerSlots(): Array<{ type: PowerUpType; x: number; y: number; r: number }> {
    const cx = this.width / 2;
    const cy = this.playBottom - 20;
    const gap = 34;
    return this.inventory.map((type, i) => {
      const rank = Math.floor(i / 2) + 1;
      const side = i % 2 === 0 ? -1 : 1;
      return { type, x: cx + side * (gap + (rank - 1) * 30), y: cy, r: 17 };
    });
  }

  /** Activates whichever docked power-up was tapped, if any. */
  activateAt(x: number, y: number): boolean {
    for (const slot of this.powerSlots()) {
      // Generous radius: these are small targets next to a thumb.
      if (Math.hypot(x - slot.x, y - slot.y) <= slot.r + 12) {
        return this.activate(slot.type);
      }
    }
    return false;
  }

  /** Live answers, for anything that needs to bias itself toward them. */
  liveAnswers(): number[] {
    const out: number[] = [];
    for (const b of this.blocks) if (b.dying <= 0) out.push(b.answer);
    for (const s of this.shards) if (s.alive && s.dying <= 0) out.push(s.digit);
    return out;
  }
}

/** h, s, l in 0-1; returns 0-255 components. */
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(f(h + 1 / 3) * 255),
    Math.round(f(h) * 255),
    Math.round(f(h - 1 / 3) * 255),
  ];
}
