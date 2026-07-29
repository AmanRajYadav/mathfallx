/**
 * Inverse Text Normalization: spoken words -> integers.
 *
 * Speech engines are trained on conversational prose. A math game feeds them
 * the opposite: bare, context-free digit strings. The language model has no
 * surrounding sentence to disambiguate against, so it guesses using priors
 * built from ordinary English — where "two" is far rarer than "to", and where
 * three identical digits in a row look like a stutter to be collapsed.
 *
 * The fix used here is aggressive vocabulary constriction. Rather than trying
 * to make the recognizer smarter, we accept that its raw transcript is noisy
 * and generate *every plausible numeric reading* of it, each with a confidence
 * score. The caller then intersects those candidates with the small set of
 * answers actually on screen. A wrong reading that matches nothing is
 * discarded for free, so we can afford to be generous here.
 *
 * Three failure modes get explicit handling:
 *
 *   1. Homophones. "to/too/two", "for/four", "ate/eight", "won/one". These are
 *      not recognizer bugs — they are correct transcriptions of identical
 *      audio. Only the answer set can disambiguate them.
 *
 *   2. The teen/ten collision. "fifteen" vs "fifty" differ by one unstressed
 *      syllable and are the single most common mis-transcription in spoken
 *      arithmetic. Both readings are always emitted.
 *
 *   3. Digit sequences. "four two" means 42, not 6. The standard cardinal
 *      parser sums, which is wrong for this domain, so concatenation is
 *      emitted alongside.
 */

export interface NumberCandidate {
  value: number;
  /** 0-1 confidence in this reading. */
  score: number;
  /** How it was derived, for debugging the voice overlay. */
  via: string;
}

/** Canonical spelling -> value, for words that carry a number. */
const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};

const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/**
 * Mis-hearings and accent variants mapped onto canonical number words.
 *
 * Mapping common English words like "to" and "for" onto digits looks reckless
 * out of context. It is safe here precisely because a candidate only ever
 * fires if it matches a live on-screen answer — and it is necessary, because
 * "to" is what Chrome returns for a clearly spoken "two" a good fraction of
 * the time.
 */
const HOMOPHONES: Record<string, string> = {
  // 0
  oh: 'zero', o: 'zero', ohh: 'zero', nought: 'zero', naught: 'zero',
  sero: 'zero', ziro: 'zero', zed: 'zero',
  // 1
  won: 'one', wan: 'one', juan: 'one', wun: 'one',
  // 2
  to: 'two', too: 'two', tu: 'two', tue: 'two', tow: 'two',
  // 3
  tree: 'three', free: 'three', thri: 'three', thre: 'three', tri: 'three',
  // 4
  for: 'four', fore: 'four', faur: 'four', ford: 'four',
  // 5
  fife: 'five', phive: 'five', hive: 'five',
  // 6
  sex: 'six', sics: 'six', sicks: 'six', sik: 'six',
  // 7
  sevan: 'seven', sevin: 'seven', savan: 'seven',
  // 8
  ate: 'eight', ait: 'eight', ayt: 'eight', ete: 'eight', eat: 'eight',
  // 9
  nain: 'nine', niner: 'nine', nyne: 'nine', nain9: 'nine',
  // teens / tens
  tin: 'ten', tan: 'ten',
  elevan: 'eleven', twelf: 'twelve', twelth: 'twelve',
  thirtin: 'thirteen', fourtin: 'fourteen', fiftin: 'fifteen',
  sixtin: 'sixteen', seventin: 'seventeen', eightin: 'eighteen', nintin: 'nineteen',
  fourty: 'forty', ninty: 'ninety', twenti: 'twenty',
  hundread: 'hundred', hundered: 'hundred',
};

/**
 * The teen/ten confusion pairs. Both readings are always produced, and the
 * answer set decides which one was meant.
 */
const CONFUSABLE: Record<string, string> = {
  thirteen: 'thirty', thirty: 'thirteen',
  fourteen: 'forty', forty: 'fourteen',
  fifteen: 'fifty', fifty: 'fifteen',
  sixteen: 'sixty', sixty: 'sixteen',
  seventeen: 'seventy', seventy: 'seventeen',
  eighteen: 'eighty', eighty: 'eighteen',
  nineteen: 'ninety', ninety: 'nineteen',
};

/** The same teen/ten pairs as CONFUSABLE, for transcripts already normalized to digits. */
const NUMERIC_CONFUSABLE: Record<number, number> = {
  13: 30, 30: 13,
  14: 40, 40: 14,
  15: 50, 50: 15,
  16: 60, 60: 16,
  17: 70, 70: 17,
  18: 80, 80: 18,
  19: 90, 90: 19,
};

type Atom =
  | { t: 'd'; v: number }
  | { t: 'teen'; v: number }
  | { t: 'ten'; v: number }
  | { t: 'hundred' }
  | { t: 'thousand' }
  | { t: 'and' }
  | { t: 'neg' }
  | { t: 'dup'; times: number }
  | { t: 'lit'; v: number };

function atomFor(word: string): Atom | null {
  if (/^\d+$/.test(word)) return { t: 'lit', v: parseInt(word, 10) };
  if (word in UNITS) return { t: 'd', v: UNITS[word] };
  if (word in TEENS) return { t: 'teen', v: TEENS[word] };
  if (word in TENS) return { t: 'ten', v: TENS[word] };
  if (word === 'hundred' || word === 'hundreds') return { t: 'hundred' };
  if (word === 'thousand' || word === 'thousands') return { t: 'thousand' };
  if (word === 'and') return { t: 'and' };
  if (word === 'minus' || word === 'negative') return { t: 'neg' };
  if (word === 'double') return { t: 'dup', times: 2 };
  if (word === 'triple') return { t: 'dup', times: 3 };
  return null;
}

/** Canonicalizes one raw token, returning null if it carries no number. */
function canonical(word: string): { word: string; homophone: boolean } | null {
  if (/^\d+$/.test(word)) return { word, homophone: false };
  if (word in UNITS || word in TEENS || word in TENS) return { word, homophone: false };
  if (word === 'hundred' || word === 'thousand' || word === 'and' ||
      word === 'minus' || word === 'negative' || word === 'double' || word === 'triple') {
    return { word, homophone: false };
  }
  if (word in HOMOPHONES) return { word: HOMOPHONES[word], homophone: true };
  return null;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[-–—]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Parses 1-99 starting at `i`. Returns null if nothing matches. */
function parseSmall(atoms: Atom[], i: number): { value: number; next: number } | null {
  const a = atoms[i];
  if (!a) return null;
  if (a.t === 'ten') {
    const b = atoms[i + 1];
    if (b && b.t === 'd' && b.v >= 1) return { value: a.v + b.v, next: i + 2 };
    return { value: a.v, next: i + 1 };
  }
  if (a.t === 'teen') return { value: a.v, next: i + 1 };
  if (a.t === 'd') return { value: a.v, next: i + 1 };
  return null;
}

/**
 * Segments the atom stream into distinct numbers using grammar rules rather
 * than blind summation — so "twenty two" is 22 while "two two" stays two
 * separate digits (and gets a concatenation candidate added later).
 */
function segment(atoms: Atom[]): number[] {
  const out: number[] = [];
  let i = 0;
  let negate = false;

  while (i < atoms.length) {
    const a = atoms[i];

    if (a.t === 'neg') { negate = true; i++; continue; }
    if (a.t === 'and') { i++; continue; }

    if (a.t === 'lit') {
      out.push(negate ? -a.v : a.v);
      negate = false;
      i++;
      continue;
    }

    if (a.t === 'dup') {
      // "double two" -> 22, "triple seven" -> 777
      const nxt = atoms[i + 1];
      if (nxt && nxt.t === 'd') {
        out.push(parseInt(String(nxt.v).repeat(a.times), 10));
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (a.t === 'hundred') {
      // Bare "hundred" / "a hundred".
      let value = 100;
      i++;
      if (atoms[i]?.t === 'and') i++;
      const rest = parseSmall(atoms, i);
      if (rest) { value += rest.value; i = rest.next; }
      out.push(negate ? -value : value);
      negate = false;
      continue;
    }

    const small = parseSmall(atoms, i);
    if (!small) { i++; continue; }

    let value = small.value;
    i = small.next;

    if (atoms[i]?.t === 'hundred') {
      value *= 100;
      i++;
      if (atoms[i]?.t === 'and') i++;
      const rest = parseSmall(atoms, i);
      if (rest) { value += rest.value; i = rest.next; }
    }

    if (atoms[i]?.t === 'thousand') {
      value *= 1000;
      i++;
      if (atoms[i]?.t === 'and') i++;
      const rest = parseSmall(atoms, i);
      if (rest) {
        let tail = rest.value;
        i = rest.next;
        if (atoms[i]?.t === 'hundred') {
          tail *= 100;
          i++;
          if (atoms[i]?.t === 'and') i++;
          const tail2 = parseSmall(atoms, i);
          if (tail2) { tail += tail2.value; i = tail2.next; }
        }
        value += tail;
      }
    }

    out.push(negate ? -value : value);
    negate = false;
  }

  return out;
}

interface Reading {
  atoms: Atom[];
  /** Penalty multiplier for this reading. */
  weight: number;
  via: string;
  /** Fraction of tokens that carried a number. */
  density: number;
  /** True when every numeric token was a bare 0-9 digit word. */
  allSingleDigits: boolean;
}

function buildReadings(tokens: string[]): Reading[] {
  const canon: Array<{ word: string; homophone: boolean } | null> = tokens.map(canonical);
  const numericCount = canon.filter(Boolean).length;
  if (numericCount === 0) return [];

  const density = numericCount / tokens.length;
  const anyHomophone = canon.some((c) => c?.homophone);

  const primaryWords = canon.filter(Boolean).map((c) => c!.word);
  const primaryAtoms = primaryWords.map(atomFor).filter(Boolean) as Atom[];
  const allSingleDigits = primaryAtoms.length > 0 &&
    primaryAtoms.every((a) => a.t === 'd' || (a.t === 'lit' && a.v <= 9));

  const readings: Reading[] = [{
    atoms: primaryAtoms,
    weight: anyHomophone ? 0.74 : 1,
    via: anyHomophone ? 'homophone' : 'words',
    density,
    allSingleDigits,
  }];

  // One confusable swap at a time. Realistically at most one teen/ten in an
  // utterance is misheard, and single-swap variants stay linear rather than
  // exploding combinatorially.
  for (let i = 0; i < primaryWords.length; i++) {
    const alt = CONFUSABLE[primaryWords[i]];
    if (!alt) continue;
    const swapped = primaryWords.slice();
    swapped[i] = alt;
    const atoms = swapped.map(atomFor).filter(Boolean) as Atom[];
    readings.push({
      atoms,
      weight: 0.6,
      via: 'teen/ten',
      density,
      allSingleDigits: false,
    });
  }

  return readings;
}

export interface ExtractOptions {
  /** Ignore candidates outside this range. */
  min?: number;
  max?: number;
}

/**
 * Every plausible numeric reading of a transcript, best first.
 * Deduplicated by value, keeping the highest score for each.
 */
export function extractNumbers(transcript: string, opts: ExtractOptions = {}): NumberCandidate[] {
  const min = opts.min ?? -9999;
  const max = opts.max ?? 9999;
  const tokens = tokenize(transcript);
  if (tokens.length === 0) return [];

  const best = new Map<number, NumberCandidate>();
  const offer = (value: number, score: number, via: string) => {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return;
    if (value < min || value > max) return;
    const prev = best.get(value);
    if (!prev || score > prev.score) best.set(value, { value, score, via });
  };

  for (const reading of buildReadings(tokens)) {
    const numbers = segment(reading.atoms);
    if (numbers.length === 0) continue;

    // A dense, number-only utterance is more trustworthy than one number
    // buried in a sentence — that is usually the recognizer picking up a stray
    // word rather than the player answering.
    //
    // The penalty is gentler than it was (floor 0.55 -> 0.72). Quiet or fast
    // speech routinely picks up a filler token alongside the digit, which
    // halved the density and pushed a perfectly good answer under the firing
    // threshold. Ranking still prefers the clean utterance; it just no longer
    // rejects the messy one outright.
    const densityFactor = 0.72 + 0.28 * reading.density;

    for (const v of numbers) {
      offer(v, reading.weight * densityFactor, reading.via);
    }

    // "four two" -> 42. Only when every token was a single digit, otherwise
    // "twenty two" would spuriously produce 202.
    //
    // Capped at three digits because answers never exceed 999, and because a
    // player repeating themselves ("nine, nine, nine") must not have their
    // digits welded into a nonsense number.
    if (reading.allSingleDigits && numbers.length >= 2 && numbers.length <= 3 &&
        numbers.every((v) => v >= 0 && v <= 9)) {
      const joined = parseInt(numbers.join(''), 10);
      // Concatenation is the *more* likely reading of a digit sequence in this
      // domain, so it outscores the individual digits it was built from.
      offer(joined, Math.min(0.99, reading.weight * densityFactor + 0.12), 'digits');
    }

    // Recognizers routinely split a compound number across two tokens, handing
    // back "40 2" for a clearly spoken "forty two" — neither 40 nor 2 is the
    // answer, so without this the utterance matches nothing and the player
    // just sees their block keep falling. Recombining adjacent
    // tens-then-units and hundreds-then-remainder pairs recovers it.
    for (let i = 0; i + 1 < numbers.length; i++) {
      const a = numbers[i];
      const b = numbers[i + 1];
      if (a >= 20 && a <= 90 && a % 10 === 0 && b >= 1 && b <= 9) {
        offer(a + b, reading.weight * densityFactor * 0.92, 'split');
      } else if (a >= 100 && a % 100 === 0 && b >= 1 && b <= 99) {
        offer(a + b, reading.weight * densityFactor * 0.92, 'split');
      }
    }
  }

  // Literal digits straight from the transcript. Chrome frequently returns
  // "42" rather than "forty two", and that is the strongest signal available.
  for (const m of transcript.matchAll(/\d+/g)) {
    const v = parseInt(m[0], 10);
    offer(v, 1, 'literal');

    // The teen/ten collision survives inverse text normalization. When the
    // engine writes "17" it has already committed to one reading of an
    // ambiguous sound, and the word-level confusable expansion never sees it —
    // so the numeric form needs the same treatment. Reported from play: with
    // 7 x 10 on screen, a spoken "seventy" transcribed as "17" matched nothing.
    const twin = NUMERIC_CONFUSABLE[v];
    if (twin !== undefined) offer(twin, 0.66, 'teen/ten');
  }

  return [...best.values()].sort((a, b) => b.score - a.score);
}

export type VoiceCommand = 'pause' | 'resume' | 'restart' | 'bomb' | 'menu';

const COMMAND_WORDS: Array<[VoiceCommand, string[]]> = [
  ['pause', ['pause', 'paused', 'stop', 'wait', 'hold on']],
  ['resume', ['resume', 'continue', 'go', 'unpause']],
  ['restart', ['restart', 'again', 'retry', 'replay', 'play again']],
  ['bomb', ['bomb', 'nuke', 'clear', 'overdrive', 'boom']],
  ['menu', ['menu', 'quit', 'exit', 'home']],
];

/**
 * Recognizes a spoken command. Deliberately strict — it only fires on a short
 * utterance that is essentially just the command, so saying "eight" during a
 * frantic round can never be mistaken for "wait".
 */
export function extractCommand(transcript: string): VoiceCommand | null {
  const text = tokenize(transcript).join(' ');
  if (!text || text.length > 24) return null;
  for (const [cmd, words] of COMMAND_WORDS) {
    for (const w of words) {
      if (text === w) return cmd;
    }
  }
  return null;
}
