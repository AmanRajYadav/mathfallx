/**
 * Audio.
 *
 * Sound effects are synthesised at runtime rather than loaded — a laser zap is
 * a swept oscillator and an explosion is filtered noise, so shipping them as
 * files would cost bandwidth and a decode for no benefit. It also means every
 * effect can be parameterised: the combo chime literally rises in pitch as the
 * chain grows.
 *
 * Music still comes from the existing mp3s in /public/audio.
 *
 * Everything is lazy. Browsers refuse to start an AudioContext without a user
 * gesture, so the context is created on first interaction and all calls before
 * that are no-ops rather than errors.
 */

export type Sfx =
  | 'zap' | 'explode' | 'boss' | 'armor' | 'reject'
  | 'miss' | 'wave' | 'overdrive' | 'tick' | 'ui'
  | 'shard' | 'shardKill' | 'shipHit';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let musicEl: HTMLAudioElement | null = null;
let musicSrc = '';
let sfxVolume = 0.7;
let musicVolume = 0.35;
let noiseBuffer: AudioBuffer | null = null;

/** Vite rewrites this for the GitHub Pages sub-path. */
const BASE = import.meta.env.BASE_URL ?? '/';

export function initAudio(): void {
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume();
    return;
  }
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
    master = ctx.createGain();
    master.gain.value = sfxVolume;
    master.connect(ctx.destination);

    // One second of white noise, reused by every percussive effect.
    const len = Math.floor(ctx.sampleRate);
    noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  } catch {
    ctx = null;
  }
}

export function setSfxVolume(v: number): void {
  sfxVolume = Math.max(0, Math.min(1, v));
  if (master) master.gain.value = sfxVolume;
}

export function setMusicVolume(v: number): void {
  musicVolume = Math.max(0, Math.min(1, v));
  if (musicEl) musicEl.volume = musicVolume;
}

function tone(
  freq: number,
  toFreq: number,
  duration: number,
  type: OscillatorType,
  gain: number,
  delay = 0,
): void {
  if (!ctx || !master) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (toFreq !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, toFreq), t0 + duration);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0001, gain), t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function noise(duration: number, gain: number, filterFrom: number, filterTo: number, delay = 0): void {
  if (!ctx || !master || !noiseBuffer) return;
  const t0 = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(filterFrom, t0);
  filter.frequency.exponentialRampToValueAtTime(Math.max(40, filterTo), t0 + duration);
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(filter);
  filter.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + duration + 0.02);
}

/**
 * @param intensity For 'zap', the combo count — the chime climbs the scale as
 *                  the chain grows, which is most of why chaining feels good.
 */
export function playSfx(name: Sfx, intensity = 0): void {
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();

  switch (name) {
    case 'zap': {
      // ZType's plasma gun is three samples layered — an artillery blast, a
      // bullet impact, and a retro laser synth. Same idea, synthesised: a hard
      // noise transient for the crack, a fast downward sweep for the body, and
      // a pitched tail that climbs the scale with the combo. The transient is
      // what makes it feel like a gun rather than a beep.
      const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
      const step = scale[Math.min(scale.length - 1, intensity % (scale.length * 2))];
      const base = 520 * Math.pow(2, step / 12);

      noise(0.035, 0.34, 9000, 2600);            // crack
      tone(base * 3.4, base * 0.7, 0.09, 'sawtooth', 0.2);  // body sweep
      tone(base, base * 1.6, 0.12, 'square', 0.13, 0.012);  // pitched tail
      noise(0.13, 0.09, 2200, 320, 0.02);        // low thump
      break;
    }
    case 'shard':
      // Incoming: a rising alarm, deliberately unpleasant.
      tone(300, 900, 0.16, 'sawtooth', 0.11);
      noise(0.12, 0.07, 3000, 1200);
      break;
    case 'shardKill':
      tone(880, 1500, 0.06, 'square', 0.13);
      noise(0.07, 0.14, 6000, 1400);
      break;
    case 'explode':
      noise(0.34, 0.30, 3600, 140);
      tone(180, 42, 0.3, 'sawtooth', 0.14);
      break;
    case 'boss':
      noise(0.6, 0.36, 5000, 90);
      tone(140, 32, 0.55, 'sawtooth', 0.2);
      tone(96, 28, 0.6, 'square', 0.12, 0.04);
      break;
    case 'armor':
      tone(330, 250, 0.09, 'square', 0.12);
      noise(0.1, 0.14, 2400, 600);
      break;
    case 'reject':
      // A wrong input has to feel wrong. A dry, detuned minor second buzzing
      // against itself is dissonant enough to register instantly without being
      // loud — the same job ZType's miss sound does for a broken streak.
      tone(196, 178, 0.13, 'sawtooth', 0.13);
      tone(207, 190, 0.13, 'square', 0.09, 0.005);
      noise(0.06, 0.06, 900, 300);
      break;
    case 'miss':
      tone(300, 60, 0.5, 'sawtooth', 0.2);
      noise(0.45, 0.24, 1500, 80);
      break;
    case 'shipHit':
      // Hull breach: heavier and lower than a missed block.
      tone(160, 40, 0.55, 'square', 0.24);
      noise(0.4, 0.3, 900, 60);
      break;
    case 'wave':
      tone(392, 784, 0.22, 'triangle', 0.14);
      tone(523, 1046, 0.26, 'triangle', 0.11, 0.09);
      break;
    case 'overdrive':
      tone(220, 1760, 0.55, 'sawtooth', 0.16);
      tone(330, 2640, 0.5, 'square', 0.09, 0.05);
      noise(0.5, 0.16, 800, 8000);
      break;
    case 'tick':
      tone(880, 880, 0.035, 'square', 0.06);
      break;
    case 'ui':
      tone(660, 990, 0.07, 'triangle', 0.09);
      break;
  }
}

const TRACKS = {
  menu: 'audio/cinematic-menu.mp3',
  play: 'audio/background-music.mp3',
  deep: 'audio/wave4-music.mp3',
  intense: 'audio/wave7-music.mp3',
  boss: 'audio/boss-music.mp3',
  over: 'audio/gameover-music.mp3',
} as const;

export type Track = keyof typeof TRACKS;

export function playMusic(track: Track, loop = true): void {
  const src = BASE + TRACKS[track];
  if (musicSrc === src && musicEl && !musicEl.paused) return;

  if (!musicEl) {
    musicEl = new Audio();
    musicEl.preload = 'none';
  }
  musicSrc = src;
  musicEl.src = src;
  musicEl.loop = loop;
  musicEl.volume = musicVolume;
  // Autoplay is blocked until a gesture; the rejection is expected and
  // harmless, since the next real interaction retries.
  void musicEl.play().catch(() => undefined);
}

export function stopMusic(): void {
  if (!musicEl) return;
  musicEl.pause();
  musicSrc = '';
}

/** Picks the track that matches the current wave. */
export function musicForWave(wave: number): Track {
  if (wave >= 9) return 'boss';
  if (wave >= 6) return 'intense';
  if (wave >= 3) return 'deep';
  return 'play';
}

export function vibrate(pattern: number | number[]): void {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return;
  try {
    navigator.vibrate(pattern);
  } catch {
    /* unsupported or blocked by user settings */
  }
}
