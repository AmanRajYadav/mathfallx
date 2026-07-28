/**
 * Voice input orchestration — where noisy transcripts become game actions.
 *
 * The core trick: **constrain decoding to the answers currently on screen.**
 *
 * A general recognizer has to choose between every number in the language. At
 * any given moment this game has maybe six live blocks, so the real search
 * space is six values. Intersecting the candidate readings with that set turns
 * an open-vocabulary problem into a closed one, and closed-vocabulary
 * recognition is dramatically more accurate.
 *
 * Server-side speech engines expose this as keyterm prompting or hotword
 * biasing, injecting the boost into the acoustic beam search itself. The Web
 * Speech API gives no such hook, so the equivalent is applied one layer later:
 * generate every plausible reading (see numbers.ts), then keep only the ones
 * that could possibly be an answer. A misheard "fifty" that should have been
 * "fifteen" costs nothing when 50 is not on screen and 15 is.
 *
 * This is also why interim results are safe to act on. Normally acting on an
 * interim hypothesis risks firing on a half-formed word; here, an interim that
 * matches a live answer exactly is almost certainly correct, and acting on it
 * shaves several hundred milliseconds off perceived latency — the difference
 * between the game feeling instant and feeling laggy.
 */

import { extractCommand, extractNumbers, type VoiceCommand } from './numbers';
import { matchPowerUpPhrase, type PowerUpType } from '../engine/powerups';
import {
  WebSpeechAdapter,
  isSpeechSupported,
  type Hypothesis,
  type RecognizerState,
  type SpeechAdapter,
} from './recognizer';

export interface VoiceMatch {
  value: number;
  score: number;
  transcript: string;
  isFinal: boolean;
  /** Time from the first hypothesis of this utterance to the match, in ms. */
  latencyMs: number;
}

export interface VoiceInputOptions {
  lang?: string;
  onMatch?: (m: VoiceMatch) => void;
  onHeard?: (text: string, isFinal: boolean) => void;
  onState?: (s: RecognizerState, detail?: string) => void;
  onCommand?: (c: VoiceCommand) => void;
  /** The player shouted a power-up name. */
  onPowerUp?: (p: PowerUpType) => void;
  /**
   * A number was clearly understood but is not on screen. Worth surfacing:
   * silence leaves the player unsure whether the microphone failed or their
   * arithmetic did, and those call for very different reactions.
   */
  onNoMatch?: (heard: number[], transcript: string) => void;
  /** Overrides the adapter, for tests or an alternative STT backend. */
  adapter?: SpeechAdapter;
}

/**
 * Below this, a candidate is treated as too speculative to fire on even when
 * it matches a live answer. Tuned so a clean single-word utterance always
 * passes while a number scraped out of a long sentence does not.
 */
const MIN_SCORE = 0.45;

/**
 * Ignore a repeat of the same value this soon after firing it — but only when
 * it arrives under a *different* utterance id. Within one utterance the
 * already-acted prefix is the guard, and a blanket cooldown there would block
 * a player deliberately repeating an answer.
 */
const VALUE_COOLDOWN_MS = 500;

export class VoiceInput {
  private adapter: SpeechAdapter;
  private targets = new Set<number>();
  private enabled = false;
  private opts: VoiceInputOptions;

  /**
   * The portion of each utterance's transcript that has already been acted on.
   *
   * In continuous mode the recognizer does not emit one result per spoken
   * number — it keeps extending a single result, so repeating "nine" produces
   * "nine", then "nine nine", then "nine nine nine". Re-parsing the whole
   * string every time is wrong twice over: the value looks already-consumed so
   * the repeat is ignored, and a long run of digits concatenates into a junk
   * number. Only the new suffix is ever evaluated.
   */
  private actedPrefix = new Map<string, string>();
  private utteranceStart = new Map<string, number>();
  private lastFired = new Map<number, { at: number; utterance: string }>();

  state: RecognizerState = 'idle';
  lastTranscript = '';
  matchCount = 0;

  constructor(opts: VoiceInputOptions = {}) {
    this.opts = opts;
    this.adapter = opts.adapter ?? new WebSpeechAdapter(opts.lang ?? 'en-US');
    this.adapter.onHypothesis = (h) => this.handle(h);
    this.adapter.onState = (s, detail) => {
      this.state = s;
      this.opts.onState?.(s, detail);
    };
  }

  get supported(): boolean {
    return this.adapter.supported;
  }

  /**
   * The answers currently falling. Called whenever blocks spawn or die — this
   * set *is* the language model constraint.
   */
  setTargets(values: Iterable<number>): void {
    this.targets.clear();
    for (const v of values) this.targets.add(v);
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) this.adapter.start();
    else this.adapter.stop();
  }

  setLanguage(lang: string): void {
    this.adapter.setLanguage(lang);
  }

  /** Manual recovery, exposed in Settings for when everything else has failed. */
  restart(): void {
    this.actedPrefix.clear();
    this.lastFired.clear();
    this.adapter.stop();
    if (this.enabled) window.setTimeout(() => this.adapter.start(), 150);
  }

  diagnostics(): Record<string, string | number | boolean> {
    const base = this.adapter.diagnostics?.() ?? {};
    return {
      ...base,
      enabled: this.enabled,
      liveTargets: this.targets.size,
      matches: this.matchCount,
      lastHeard: this.lastTranscript || '—',
    };
  }

  /** Tells the matcher a value was acted on, suppressing immediate repeats. */
  markConsumed(value: number): void {
    // Refresh the timestamp but keep whichever utterance claimed this value.
    // Overwriting it would make the cross-utterance cooldown apply *within*
    // the current utterance and silently re-break repeated answers.
    const prev = this.lastFired.get(value);
    this.lastFired.set(value, { at: Date.now(), utterance: prev?.utterance ?? '' });
  }

  destroy(): void {
    this.adapter.destroy();
    this.actedPrefix.clear();
    this.utteranceStart.clear();
    this.lastFired.clear();
  }

  /**
   * Feeds a transcript through the full pipeline without a microphone.
   * Used by the in-game voice tester and by automated checks, since a headless
   * browser has no audio input.
   */
  simulate(transcript: string, isFinal = true): void {
    this.handle({
      transcript,
      alternatives: [transcript],
      isFinal,
      utteranceId: `sim:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      at: Date.now(),
    });
  }

  /**
   * Resolves a transcript against a hypothetical answer set without firing any
   * callbacks or disturbing live state. Powers the in-game phrase tester, so
   * players can see how their wording is interpreted before trusting it in a
   * run — and diagnose an accent mismatch without losing a game.
   */
  probe(transcript: string, targets: number[]): { value: number; score: number } | null {
    const savedTargets = this.targets;
    const savedFired = this.lastFired;
    this.targets = new Set(targets);
    // A probe must not be suppressed by the repeat-fire cooldown from live play.
    this.lastFired = new Map();
    const result = this.bestMatch({
      transcript,
      alternatives: [transcript],
      isFinal: true,
      utteranceId: `probe:${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
    });
    this.targets = savedTargets;
    this.lastFired = savedFired;
    return result;
  }

  private handle(h: Hypothesis): void {
    if (!this.enabled) return;

    this.lastTranscript = h.transcript;
    this.opts.onHeard?.(h.transcript, h.isFinal);

    if (!this.utteranceStart.has(h.utteranceId)) {
      this.utteranceStart.set(h.utteranceId, h.at);
      // Bounded: only the newest few utterances can still receive updates.
      if (this.utteranceStart.size > 8) {
        const oldest = this.utteranceStart.keys().next().value as string;
        this.utteranceStart.delete(oldest);
        this.actedPrefix.delete(oldest);
      }
    }

    const best = this.bestMatch(h);

    if (best) {
      // Everything up to and including the text that just matched is spent.
      // The next hypothesis for this utterance is judged only on what follows,
      // which is what lets a player say the same number twice in a row.
      this.actedPrefix.set(h.utteranceId, best.sourceText);
      this.lastFired.set(best.value, { at: Date.now(), utterance: h.utteranceId });
      this.matchCount += 1;

      this.opts.onMatch?.({
        value: best.value,
        score: best.score,
        transcript: h.transcript,
        isFinal: h.isFinal,
        latencyMs: h.at - (this.utteranceStart.get(h.utteranceId) ?? h.at),
      });
      return;
    }

    // Commands only on final results. Acting on an interim "wait" while the
    // player is midway through saying "eight" would be maddening.
    if (!h.isFinal) return;

    // Power-ups are checked before generic commands, and on the freshest words
    // only — the accumulated transcript of a long utterance would otherwise
    // re-trigger a power-up the player already spent. A null suffix means
    // nothing new has been said since the last action, so there is nothing to
    // react to at all.
    const freshest = suffixAfter(h.transcript, this.actedPrefix.get(h.utteranceId) ?? '');
    if (freshest === null) return;

    if (this.opts.onPowerUp) {
      const power = matchPowerUpPhrase(freshest);
      if (power) {
        this.actedPrefix.set(h.utteranceId, h.transcript);
        this.opts.onPowerUp(power);
        return;
      }
    }

    if (this.opts.onCommand) {
      const cmd = extractCommand(freshest);
      if (cmd) {
        this.actedPrefix.set(h.utteranceId, h.transcript);
        this.opts.onCommand(cmd);
        return;
      }
    }

    if (this.opts.onNoMatch && this.targets.size > 0) {
      const heard = extractNumbers(h.transcript, { min: 0, max: 9999 })
        .filter((c) => c.score >= MIN_SCORE)
        .map((c) => c.value);
      if (heard.length > 0) this.opts.onNoMatch(heard.slice(0, 3), h.transcript);
    }
  }

  /**
   * Scores every reading of every alternative, keeps those that match a live
   * answer, and returns the strongest.
   */
  private bestMatch(h: Hypothesis): { value: number; score: number; sourceText: string } | null {
    if (this.targets.size === 0) return null;

    const prior = this.actedPrefix.get(h.utteranceId) ?? '';
    const now = Date.now();

    let bestValue = 0;
    let bestScore = 0;
    let bestSource = '';

    for (let rank = 0; rank < h.alternatives.length; rank++) {
      // Later alternatives are less likely a priori, but only mildly — the
      // n-best list is frequently reordered by a single acoustic frame.
      const rankFactor = 1 - rank * 0.06;
      if (rankFactor <= 0) break;

      const full = h.alternatives[rank];
      const fresh = suffixAfter(full, prior);
      if (fresh === null) continue; // nothing new said since the last match

      for (const cand of extractNumbers(fresh, { min: 0, max: 9999 })) {
        if (!this.targets.has(cand.value)) continue;

        const prev = this.lastFired.get(cand.value);
        if (prev && prev.utterance !== h.utteranceId && now - prev.at < VALUE_COOLDOWN_MS) continue;

        const score = cand.score * rankFactor;
        if (score >= MIN_SCORE && score > bestScore) {
          bestScore = score;
          bestValue = cand.value;
          bestSource = full;
        }
      }
    }

    return bestScore > 0 ? { value: bestValue, score: bestScore, sourceText: bestSource } : null;
  }
}

/**
 * The part of `full` that has not been acted on yet.
 *
 * Returns `null` when nothing new has been said. When the two have diverged
 * (a later hypothesis revised earlier words rather than appending to them) the
 * whole string is returned, and the per-value cooldown is what prevents a
 * duplicate fire.
 */
function suffixAfter(full: string, prior: string): string | null {
  if (!prior) return full;
  const a = full.trim().toLowerCase();
  const b = prior.trim().toLowerCase();
  if (a === b) return null;
  if (a.startsWith(b)) {
    const rest = full.trim().slice(prior.trim().length).trim();
    return rest.length > 0 ? rest : null;
  }
  return full;
}

export { isSpeechSupported };
export type { RecognizerState, VoiceCommand };
