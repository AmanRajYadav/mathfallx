/**
 * Speech recognition transport.
 *
 * `SpeechAdapter` is the seam. Today the only implementation wraps the browser's
 * Web Speech API, which costs nothing, needs no API key, and ships everywhere
 * Chrome does. A streaming cloud recognizer (persistent WebSocket, 16-bit PCM
 * frames, keyterm biasing) would implement the same interface and drop in
 * without the game logic noticing — see deepgram.ts for a worked example.
 *
 * The previous implementation in this repo failed for reasons worth recording,
 * since they are easy to reintroduce:
 *
 *   - It gated results on `confidence >= 0.7`. Chrome on Android very often
 *     reports `confidence: 0` on perfectly good final results — the field is
 *     effectively unspecified across implementations. That single check
 *     silently discarded most correct answers, which is why voice input
 *     "didn't work" and got shelved.
 *
 *   - `interimResults: false` meant waiting for end-of-utterance detection,
 *     adding roughly a second of dead air after the player had already spoken.
 *     Interim hypotheses arrive while they are still talking.
 *
 *   - `maxAlternatives: 1` threw away the n-best list. Alternative 3 is
 *     frequently the right answer when alternative 1 is a homophone.
 *
 * So: no confidence gate, interim results on, alternatives on, and a restart
 * loop that treats the recognizer as something that will stop unpredictably.
 */

export type RecognizerState =
  | 'idle'
  | 'starting'
  | 'listening'
  | 'speaking'
  | 'denied'
  | 'unsupported'
  | 'error';

export interface Hypothesis {
  transcript: string;
  alternatives: string[];
  isFinal: boolean;
  /** Stable id for one utterance, so interim and final updates can be linked. */
  utteranceId: string;
  at: number;
}

export interface SpeechAdapter {
  readonly supported: boolean;
  start(): void;
  stop(): void;
  setLanguage(lang: string): void;
  destroy(): void;
  onHypothesis?: (h: Hypothesis) => void;
  onState?: (s: RecognizerState, detail?: string) => void;
}

/*
 * Minimal structural types for the Web Speech API.
 *
 * It is still a draft spec, so TypeScript's DOM lib does not declare it and
 * the vendor-prefixed constructor is the one that actually exists in most
 * browsers. Declaring only the surface used here keeps the call sites checked
 * without pulling in a dependency for an API this file fully encapsulates.
 */
interface SpeechAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechResult {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechAlternative;
}

interface SpeechResultList {
  readonly length: number;
  [index: number]: SpeechResult;
}

interface SpeechResultEvent {
  readonly resultIndex: number;
  readonly results: SpeechResultList;
}

interface SpeechErrorEvent {
  readonly error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  onstart: (() => void) | null;
  onaudiostart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognition(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechSupported(): boolean {
  return getSpeechRecognition() !== null;
}

/**
 * Web Speech API is not offline. Chrome streams audio to Google's servers and
 * Safari to Apple's, so a dropped connection kills voice input. The keypad
 * always remains available as a fallback, and the UI says so rather than
 * leaving the player wondering why nothing happens.
 */
export function speechNeedsNetwork(): boolean {
  return true;
}

export class WebSpeechAdapter implements SpeechAdapter {
  readonly supported: boolean;

  onHypothesis?: (h: Hypothesis) => void;
  onState?: (s: RecognizerState, detail?: string) => void;

  private rec: SpeechRecognitionLike | null = null;
  private lang: string;
  private want = false;
  private running = false;
  private state: RecognizerState = 'idle';
  /** Bumped on every restart; part of the utterance id, since resultIndex resets. */
  private generation = 0;
  private restartTimer: number | null = null;
  private watchdog: number | null = null;
  private lastActivity = 0;
  private recentRestarts: number[] = [];
  private destroyed = false;

  constructor(lang = 'en-US') {
    this.lang = lang;
    const Ctor = getSpeechRecognition();
    this.supported = Ctor !== null;
    if (!this.supported) {
      this.setState('unsupported');
      return;
    }
    this.build(Ctor);
  }

  private build(Ctor: SpeechRecognitionCtor) {
    const rec = new Ctor();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    // The n-best list is the cheapest accuracy win available. Alternatives
    // beyond ~5 are noise, and some engines silently cap lower anyway.
    rec.maxAlternatives = 5;

    rec.onstart = () => {
      this.running = true;
      this.lastActivity = Date.now();
      this.setState('listening');
    };

    rec.onaudiostart = () => { this.lastActivity = Date.now(); };

    // These give voice-activity signalling for free. Opening a second
    // getUserMedia stream just to drive a level meter can fight with the
    // recognizer for the microphone on Android, so the UI animates off these
    // events instead.
    rec.onspeechstart = () => {
      this.lastActivity = Date.now();
      this.setState('speaking');
    };
    rec.onspeechend = () => {
      this.lastActivity = Date.now();
      if (this.state === 'speaking') this.setState('listening');
    };

    rec.onresult = (event: SpeechResultEvent) => {
      this.lastActivity = Date.now();
      if (!this.onHypothesis) return;

      const from = typeof event.resultIndex === 'number' ? event.resultIndex : 0;
      for (let i = from; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;

        const alternatives: string[] = [];
        for (let j = 0; j < result.length; j++) {
          const t = result[j]?.transcript;
          if (typeof t === 'string' && t.trim()) alternatives.push(t.trim());
        }
        if (alternatives.length === 0) continue;

        this.onHypothesis({
          transcript: alternatives[0],
          alternatives,
          isFinal: !!result.isFinal,
          utteranceId: `${this.generation}:${i}`,
          at: Date.now(),
        });
      }
    };

    rec.onerror = (event: SpeechErrorEvent) => {
      const code = String(event?.error ?? 'unknown');

      // Genuinely fatal: the player must grant permission, or there is no mic.
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        this.want = false;
        this.setState('denied', code);
        return;
      }
      if (code === 'audio-capture') {
        this.want = false;
        this.setState('error', code);
        return;
      }
      // 'no-speech' and 'aborted' are routine in a game where the player is
      // often silent for several seconds. They are not errors worth surfacing;
      // onend will fire next and the restart loop handles it.
      if (code !== 'no-speech' && code !== 'aborted') {
        this.setState('error', code);
      }
    };

    rec.onend = () => {
      this.running = false;
      if (this.want && !this.destroyed) this.scheduleRestart();
      else this.setState('idle');
    };

    this.rec = rec;
  }

  private setState(s: RecognizerState, detail?: string) {
    if (this.state === s) return;
    this.state = s;
    this.onState?.(s, detail);
  }

  /**
   * The recognizer stops on its own constantly — after silence, after a final
   * result on iOS, when the tab loses focus. Continuous listening is really a
   * restart loop, with backoff so a hard failure cannot spin the CPU.
   */
  private scheduleRestart() {
    if (this.restartTimer !== null) return;

    const now = Date.now();
    this.recentRestarts = this.recentRestarts.filter((t) => now - t < 10_000);
    this.recentRestarts.push(now);

    // As close to instant as the engine tolerates: every millisecond here is a
    // window where the player is talking and nothing is listening, which is
    // exactly what "sometimes it just doesn't hear me" feels like. Back off
    // only when restarts are clearly thrashing.
    const delay = this.recentRestarts.length > 8 ? 1200
      : this.recentRestarts.length > 4 ? 350
      : 60;

    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      this.actuallyStart();
    }, delay);
  }

  private actuallyStart() {
    if (!this.rec || !this.want || this.destroyed) return;
    if (this.running) return;
    this.generation++;
    try {
      this.rec.start();
      this.setState('starting');
    } catch (err) {
      // start() throws InvalidStateError if the engine considers itself already
      // running. Treat it as running and let onend drive the next cycle.
      const name = (err as { name?: string })?.name;
      if (name === 'InvalidStateError') {
        this.running = true;
      } else {
        this.scheduleRestart();
      }
    }
  }

  private startWatchdog() {
    if (this.watchdog !== null) return;
    this.watchdog = window.setInterval(() => {
      if (!this.want || this.destroyed) return;
      // Some Android builds go silent without ever firing onend: no results,
      // no errors, no end event, just a microphone that has stopped listening.
      // Only a forced cycle recovers it.
      if (Date.now() - this.lastActivity > 15_000) {
        this.lastActivity = Date.now();
        try { this.rec?.stop(); } catch { /* stop can throw if already stopped */ }
        if (!this.running) this.scheduleRestart();
      }
    }, 5000);
  }

  start(): void {
    if (!this.supported || this.destroyed) return;
    this.want = true;
    this.lastActivity = Date.now();
    this.startWatchdog();
    this.actuallyStart();
  }

  stop(): void {
    this.want = false;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    try { this.rec?.stop(); } catch { /* already stopped */ }
    this.setState('idle');
  }

  setLanguage(lang: string): void {
    if (this.lang === lang) return;
    this.lang = lang;
    if (this.rec) this.rec.lang = lang;
    // The language only takes effect on the next session, so cycle if live.
    if (this.want) {
      try { this.rec?.stop(); } catch { /* ignore */ }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    if (this.rec) {
      this.rec.onstart = null;
      this.rec.onresult = null;
      this.rec.onerror = null;
      this.rec.onend = null;
      this.rec.onspeechstart = null;
      this.rec.onspeechend = null;
      this.rec.onaudiostart = null;
    }
    this.rec = null;
  }
}

/** Languages worth offering. Accent match matters more than most people expect. */
export const VOICE_LANGUAGES: Array<{ code: string; label: string; note?: string }> = [
  { code: 'en-IN', label: 'English (India)', note: 'Best for Indian accents' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'en-AU', label: 'English (Australia)' },
  { code: 'hi-IN', label: 'हिन्दी (Hindi)' },
  { code: 'es-ES', label: 'Español' },
  { code: 'fr-FR', label: 'Français' },
  { code: 'de-DE', label: 'Deutsch' },
];
