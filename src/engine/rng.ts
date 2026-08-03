/**
 * Deterministic pseudo-random number generation.
 *
 * The Daily Challenge needs every device on the planet to produce the exact
 * same 40 problems without downloading anything. That works because the
 * generator is fully deterministic: seed it with the UTC date and every client
 * walks the identical sequence locally. No network payload, no server compute,
 * and it still works on a plane.
 */

/** FNV-1a. Turns an arbitrary string into a 32-bit seed. */
export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * mulberry32 — small, fast, and statistically decent for game content.
 * Crucially it is exactly reproducible across engines, which a naive
 * `Math.random()` is not.
 */
export class Rng {
  private s: number;

  constructor(seed: number | string) {
    this.s = (typeof seed === 'string' ? hashString(seed) : seed >>> 0) || 1;
  }

  /** Float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = Math.imul(this.s ^ (this.s >>> 15), 1 | this.s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Fisher-Yates, in place. */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Roughly normal via Box-Muller, clamped to +/- 3 sigma. */
  gaussian(mean = 0, sd = 1): number {
    const u = Math.max(this.next(), 1e-9);
    const v = this.next();
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return mean + sd * Math.max(-3, Math.min(3, z));
  }
}

/**
 * The "day" for everything daily rolls over at midnight IST, not midnight UTC.
 *
 * Every player is in an Indian classroom, and with a UTC boundary the new
 * Daily Challenge appeared at 5:30 in the morning — anyone playing late at
 * night was still being served "yesterday's" questions, which read as the
 * daily never refreshing. A fixed offset rather than the device timezone, so
 * the set stays identical for everyone and a mis-set phone clock cannot fork
 * it.
 */
const DAY_OFFSET_MS = 5.5 * 60 * 60 * 1000; // IST = UTC+5:30

/** The current date shifted so its UTC fields read as IST wall-clock time. */
function localDay(d: Date): Date {
  return new Date(d.getTime() + DAY_OFFSET_MS);
}

/** `20260728` — the IST calendar date as an integer. */
export function dailySeed(d: Date = new Date()): number {
  const s = localDay(d);
  return s.getUTCFullYear() * 10000 + (s.getUTCMonth() + 1) * 100 + s.getUTCDate();
}

/** `2026-07-28` — stable key for storing per-day results. */
export function dailyKey(d: Date = new Date()): string {
  const s = localDay(d);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${s.getUTCFullYear()}-${p(s.getUTCMonth() + 1)}-${p(s.getUTCDate())}`;
}

/** Milliseconds until the next IST midnight, for the daily-reset countdown. */
export function msUntilNextDay(now: Date = new Date()): number {
  const s = localDay(now);
  const next = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() + 1) - DAY_OFFSET_MS;
  return next - now.getTime();
}
