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
  diagnostics?: () => Record<string, string | number | boolean>;
  history?: () => string[];
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
  /** Not in every implementation, hence optional. */
  abort?: () => void;
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
  private sessionStart = 0;
  private recentRestarts: number[] = [];
  private destroyed = false;
  private failedStarts = 0;
  private silentCycles = 0;

  /** Diagnostics, surfaced in Settings so field failures are reportable. */
  rebuilds = 0;
  results = 0;
  errors = 0;
  loopStalls = 0;
  lastError = '';
  lastResetReason = '';
  /** Rolling log of what the engine actually returned, newest last. */
  log: string[] = [];

  private note(line: string): void {
    this.log.push(`${new Date().toLocaleTimeString('en-GB', { hour12: false })} ${line}`);
    if (this.log.length > 14) this.log.shift();
  }

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
      this.failedStarts = 0;
      this.silentCycles = 0;
      this.lastActivity = Date.now();
      this.sessionStart = Date.now();
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
      this.results += 1;
      this.silentCycles = 0;
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

        if (result.isFinal) this.note(`heard "${alternatives[0]}"`);

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
      this.errors += 1;
      this.lastError = code;

      // 'network' means the vendor's recognition service dropped the stream.
      // The instance rarely recovers on its own, so replace it outright.
      if (code === 'network') {
        this.running = false;
        this.hardReset('network');
        return;
      }

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
    this.sessionStart = Date.now();
    try {
      this.rec.start();
      this.setState('starting');
    } catch (err) {
      // start() throws InvalidStateError when the engine thinks it is already
      // running.
      //
      // Do NOT simply set running = true here and wait for onend. If the engine
      // is wedged, onend never arrives, running stays true forever, and every
      // subsequent start returns early at the running check — permanently deaf
      // while the UI still reads "listening", because no state change is ever
      // emitted. That deadlock is exactly what killed voice mid-session.
      //
      // Instead, treat a failed start as evidence the instance is unhealthy and
      // escalate to a full rebuild.
      const name = (err as { name?: string })?.name;
      this.running = false;
      this.failedStarts += 1;
      if (name === 'InvalidStateError' && this.failedStarts <= 2) {
        // Give the engine one chance to unwind on its own.
        try { this.rec.abort?.(); } catch { /* ignore */ }
        this.scheduleRestart();
      } else {
        this.hardReset('start-failed');
      }
    }
  }

  /**
   * Destroys the SpeechRecognition instance and builds a fresh one.
   *
   * A wedged instance does not recover: it will keep rejecting start(), keep
   * withholding onend, and keep reporting nothing. Replacing the object is the
   * only reliable way back, and it is cheap. This is the escape hatch that
   * guarantees voice cannot die permanently within a session.
   */
  private hardReset(reason: string): void {
    if (this.destroyed) return;
    this.rebuilds += 1;
    this.lastResetReason = reason;
    this.note(`rebuild (${reason})`);

    const old = this.rec;
    if (old) {
      old.onstart = null;
      old.onresult = null;
      old.onerror = null;
      old.onend = null;
      old.onspeechstart = null;
      old.onspeechend = null;
      old.onaudiostart = null;
      try { old.abort?.(); } catch { /* ignore */ }
      try { old.stop(); } catch { /* ignore */ }
    }

    this.rec = null;
    this.running = false;
    this.failedStarts = 0;
    this.lastActivity = Date.now();

    const Ctor = getSpeechRecognition();
    if (!Ctor) {
      this.setState('unsupported');
      return;
    }
    this.build(Ctor);
    if (this.want) this.scheduleRestart();
  }

  private startWatchdog() {
    if (this.watchdog !== null) return;
    this.watchdog = window.setInterval(() => {
      if (!this.want || this.destroyed) return;
      const now = Date.now();

      // The cheapest and most important check: we want to be listening, nothing
      // is running, and no restart is queued. That combination means the
      // restart loop has fallen out from under us — an onend that never came,
      // a timer that got dropped — and nothing else will ever revive it.
      // Catching it every couple of seconds bounds deafness to a blink rather
      // than to the silence threshold below.
      if (!this.running && this.restartTimer === null) {
        this.loopStalls += 1;
        this.scheduleRestart();
        return;
      }

      // Some Android builds go silent without ever firing onend: no results, no
      // errors, no end event, just a microphone that has stopped listening.
      if (now - this.lastActivity > 12_000) {
        this.lastActivity = now;
        // The watchdog is authoritative about liveness. Clearing `running`
        // unconditionally is what breaks the deadlock above — without it a
        // stuck flag silences the restart path forever.
        this.running = false;
        this.silentCycles += 1;
        if (this.silentCycles >= 2) {
          this.silentCycles = 0;
          this.hardReset('watchdog-silent');
        } else {
          try { this.rec?.abort?.(); } catch { /* ignore */ }
          this.scheduleRestart();
        }
        return;
      }

      // Proactively cycle a long-lived session. Chrome degrades over very long
      // continuous recognitions, and a bounded session also bounds how large a
      // single accumulated transcript can grow.
      if (this.running && now - this.sessionStart > 45_000) {
        this.sessionStart = now;
        try { this.rec?.stop(); } catch { /* onend drives the restart */ }
      }
    }, 2000);
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

  /** Snapshot for the in-game diagnostics panel. */
  diagnostics(): Record<string, string | number | boolean> {
    return {
      state: this.state,
      running: this.running,
      wants: this.want,
      results: this.results,
      errors: this.errors,
      lastError: this.lastError || '—',
      rebuilds: this.rebuilds,
      loopStalls: this.loopStalls,
      lastReset: this.lastResetReason || '—',
      secSinceActivity: Math.round((Date.now() - this.lastActivity) / 1000),
      lang: this.lang,
    };
  }

  /** Newest-last transcript log for the diagnostics panel. */
  history(): string[] {
    return this.log.slice();
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
