/**
 * Verifies the voice pipeline without a browser or a microphone.
 *
 *   node scripts/verify-voice.mjs
 *
 * Uses the esbuild that ships with Vite, so it needs no extra dependencies.
 * Covers the transcripts that actually break in the field: homophones, the
 * teen/ten collision, compound number words, and digit sequences.
 */

import { build } from 'esbuild';

async function load(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  const url = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');
  return import(url);
}

const { extractNumbers, extractCommand } = await load('src/voice/numbers.ts');
const { VoiceInput } = await load('src/voice/VoiceInput.ts');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, ok, detail) {
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** The transcript must yield `value`, and it must be the top-scoring reading. */
function top(transcript, value) {
  const got = extractNumbers(transcript);
  check(`top("${transcript}") === ${value}`, got[0]?.value === value,
    `got ${got.length ? got.map((c) => `${c.value}@${c.score.toFixed(2)}`).join(', ') : '<none>'}`);
}

/** The transcript must yield `value` somewhere in its candidate list. */
function has(transcript, value) {
  const got = extractNumbers(transcript);
  check(`has("${transcript}", ${value})`, got.some((c) => c.value === value),
    `got ${got.length ? got.map((c) => c.value).join(', ') : '<none>'}`);
}

function none(transcript) {
  const got = extractNumbers(transcript);
  check(`none("${transcript}")`, got.length === 0, `got ${got.map((c) => c.value).join(', ')}`);
}

console.log('\n— inverse text normalization —');

// Plain cardinals.
top('forty two', 42);
top('seven', 7);
top('one hundred five', 105);
top('a hundred and twenty three', 123);
top('nine hundred ninety nine', 999);
top('eighty one', 81);

// The case the previous implementation got wrong: "twenty two" was rewritten
// to the string "20 2", matched two numbers, and returned null.
top('twenty two', 22);
top('thirty five', 35);
top('sixty seven', 67);

// Literal digits — Chrome often returns these directly.
top('42', 42);
top('the answer is 56', 56);

// Homophones. These are correct transcriptions of identical audio; only the
// on-screen answer set can disambiguate them.
top('to', 2);
top('too', 2);
top('for', 4);
top('ate', 8);
top('won', 1);
top('tree', 3);
top('oh', 0);
top('sex', 6);
top('niner', 9);

// Teen/ten collision — both readings must always be offered.
has('fifteen', 15);
has('fifteen', 50);
has('fifty', 50);
has('fifty', 15);
has('seventy', 70);
has('seventy', 17);
has('thirty', 13);
has('nineteen', 90);

// Digit sequences concatenate rather than sum.
has('four two', 42);
has('four two', 4);
has('one oh five', 105);
has('two two two', 222);          // the classic "collapsed as a stutter" case
has('double two', 22);
has('triple seven', 777);

// Split compounds. Recognizers hand back "40 2" for a clearly spoken
// "forty two"; neither half is the answer, so the pair must be recombined.
has('40 2', 42);
has('forty 2', 42);
has('60 7', 67);
has('90 9', 99);
has('100 5', 105);
has('300 21', 321);
// Must NOT fire when the pair is not a valid tens+units split.
check('"40 12" does not merge to 52', !extractNumbers('40 12').some((c) => c.value === 52));
check('"7 3" does not merge to 10', !extractNumbers('7 3').some((c) => c.value === 10));

// Negatives.
has('minus five', -5);
has('negative twelve', -12);

// Non-numeric speech yields nothing.
none('hello world');
none('what is going on');
none('');

console.log('— power-up phrases —');

const { matchPowerUpPhrase } = await load('src/engine/powerups.ts');

check('"freeze" -> freeze', matchPowerUpPhrase('freeze') === 'freeze');
check('"nuke" -> nuke', matchPowerUpPhrase('nuke') === 'nuke');
check('"newk" (mishear) -> nuke', matchPowerUpPhrase('newk') === 'nuke');
check('"shield" -> shield', matchPowerUpPhrase('shield') === 'shield');
check('"slow motion" -> slow', matchPowerUpPhrase('slow motion') === 'slow');
check('"double" -> double', matchPowerUpPhrase('double') === 'double');
// Must never fire mid-sentence, or an answer gets misread as spending an item.
check('"I need a shield now" -> null', matchPowerUpPhrase('I need a shield now') === null);
check('"seventy" -> null', matchPowerUpPhrase('seventy') === null);
check('"" -> null', matchPowerUpPhrase('') === null);

// A power-up name must reach onPowerUp, not be swallowed as a number.
{
  let fired = null;
  const vi = new VoiceInput({ adapter: stubAdapter(), onPowerUp: (p) => { fired = p; } });
  vi.setEnabled(true);
  vi.setTargets([42, 8]);
  vi.simulate('freeze', true);
  check('"freeze" routes to onPowerUp', fired === 'freeze', `got ${fired}`);
}

// ...and must not re-fire from the accumulated transcript of one utterance.
{
  const fired = [];
  const vi = new VoiceInput({ adapter: stubAdapter(), onPowerUp: (p) => fired.push(p) });
  vi.setEnabled(true);
  vi.setTargets([42]);
  vi.handle({ transcript: 'freeze', alternatives: ['freeze'], isFinal: true, utteranceId: 'p1', at: Date.now() });
  vi.handle({ transcript: 'freeze', alternatives: ['freeze'], isFinal: true, utteranceId: 'p1', at: Date.now() });
  check('power-up does not re-fire on the same utterance', fired.length === 1, `fired ${fired.length}x`);
}

console.log('— commands —');
check('command("pause")', extractCommand('pause') === 'pause');
check('command("restart")', extractCommand('restart') === 'restart');
check('command("bomb")', extractCommand('bomb') === 'bomb');
// Must not fire on a number that merely rhymes with a command word.
check('command("eight") is null', extractCommand('eight') === null);
check('command("eighty eight") is null', extractCommand('eighty eight') === null);

console.log('— constrained matching against on-screen answers —');

function stubAdapter() {
  return {
    supported: true,
    start() {}, stop() {}, setLanguage() {}, destroy() {},
    onHypothesis: null, onState: null,
  };
}

/** Feeds a transcript with `targets` on screen and returns the matched value. */
function match(transcript, targets) {
  let got = null;
  const vi = new VoiceInput({ adapter: stubAdapter(), onMatch: (m) => { got = m.value; } });
  vi.setEnabled(true);
  vi.setTargets(targets);
  vi.simulate(transcript);
  return got;
}

// The whole point: an ambiguous utterance resolves to whichever reading is
// actually on screen.
check('"fifty" with 15 on screen -> 15', match('fifty', [15, 8, 23]) === 15);
check('"fifty" with 50 on screen -> 50', match('fifty', [50, 8, 23]) === 50);
check('"for" with 4 on screen -> 4', match('for', [4, 19, 62]) === 4);
check('"to" with 2 on screen -> 2', match('to', [2, 41]) === 2);
check('"ate" with 8 on screen -> 8', match('ate', [8, 33]) === 8);
check('"seventy" with 17 on screen -> 17', match('seventy', [17, 5]) === 17);
check('"four two" with 42 on screen -> 42', match('four two', [42, 9]) === 42);

// A number nobody is asking for must not fire.
check('"fifty" with neither 15 nor 50 -> null', match('fifty', [7, 23]) === null);
check('conversation with no live answer -> null', match('hello there', [7, 23]) === null);

// Same utterance must not fire twice (interim then final).
{
  const hits = [];
  const vi = new VoiceInput({ adapter: stubAdapter(), onMatch: (m) => hits.push(m.value) });
  vi.setEnabled(true);
  vi.setTargets([42]);
  vi.simulate('forty two', false);
  vi.simulate('forty two', true);
  // Distinct utterance ids, so the value-level cooldown is what must stop the
  // second hit — which is exactly the guard that protects against a respawned
  // block with the same answer being destroyed by one spoken word.
  check('no double-fire on interim + final', hits.length === 1, `fired ${hits.length}x`);
}

console.log('— repeated answers in one continuous utterance —');

/**
 * The regression that matters most in practice.
 *
 * In continuous mode Chrome extends a single result rather than emitting one
 * per utterance, so saying "nine" three times arrives as "nine", "nine nine",
 * "nine nine nine" under one id. Every repeat must fire, and the accumulated
 * digits must never weld into a bogus number.
 */
{
  const hits = [];
  const vi = new VoiceInput({ adapter: stubAdapter(), onMatch: (m) => hits.push(m.value) });
  vi.setEnabled(true);
  vi.setTargets([9]);

  const feed = (text) => vi.handle({
    transcript: text, alternatives: [text], isFinal: false,
    utteranceId: 'u1', at: Date.now(),
  });

  feed('nine');
  feed('nine nine');
  feed('nine nine nine');
  check('repeating "nine" fires every time', hits.length === 3 && hits.every((v) => v === 9),
    `fired ${JSON.stringify(hits)}`);
}

// Same again, but calling markConsumed on every hit exactly as the game does.
// Without this the cooldown bookkeeping can look correct in isolation and
// still block repeats in a real run.
{
  const hits = [];
  const vi = new VoiceInput({ adapter: stubAdapter() });
  vi.opts = vi.opts || {};
  const onMatch = (m) => { hits.push(m.value); vi.markConsumed(m.value); };
  vi.opts.onMatch = onMatch;
  vi.setEnabled(true);
  vi.setTargets([9]);
  for (const t of ['nine', 'nine nine', 'nine nine nine']) {
    vi.handle({ transcript: t, alternatives: [t], isFinal: false, utteranceId: 'u2', at: Date.now() });
  }
  check('repeats survive the game calling markConsumed',
    hits.length === 3, `fired ${JSON.stringify(hits)}`);
}

// A growing run of identical digits must not concatenate into a junk number —
// this is what surfaced in play as "heard 102 — not on screen".
check('"nine nine nine nine" yields no 4-digit weld',
  !extractNumbers('nine nine nine nine').some((c) => c.value > 999),
  `got ${extractNumbers('nine nine nine nine').map((c) => c.value).join(', ')}`);
check('"nine nine nine nine" still offers 9',
  extractNumbers('nine nine nine nine').some((c) => c.value === 9));
// Two and three digits must still concatenate.
has('four two', 42);
has('one oh five', 105);

console.log('— a rejected utterance must not poison the ones after it —');

/**
 * Reported from play: with 7 x 10 on screen, saying "seventeen" by mistake and
 * then "seventy" repeatedly did nothing.
 *
 * Chrome extends one continuous result, so the transcript becomes "seventeen
 * seventy". If the rejected "seventeen" is never marked consumed it is
 * re-parsed on every later hypothesis, and the display stays frozen on the old
 * number — indistinguishable from a dead microphone.
 */
{
  const seen = [];
  const misses = [];
  const vi = new VoiceInput({
    adapter: stubAdapter(),
    onMatch: (m) => seen.push(m.value),
    onNoMatch: (h) => misses.push(h[0]),
  });
  vi.setEnabled(true);
  vi.setTargets([70, 6, 20]);   // 7x10, 2x3, 79-59

  const feed = (t) => vi.handle({
    transcript: t, alternatives: [t], isFinal: true, utteranceId: 'u3', at: Date.now(),
  });

  feed('17');                   // engine wrote digits for a spoken "seventy"
  feed('17 70');                // the correction, appended by the recogniser
  feed('17 70 70');

  void misses;
  // 17 alone must already rescue to 70: the pair is ambiguous by sound, and 70
  // is the only reading that is actually on screen.
  check('a digit-form "17" rescues to 70 when 70 is on screen',
    seen[0] === 70, `fired=${JSON.stringify(seen)}`);
  check('every later "70" fires too',
    seen.length === 3 && seen.every((v) => v === 70), `fired=${JSON.stringify(seen)}`);
}

// The numeric rescue must stay symmetric and must not invent readings.
has('17', 70);
has('70', 17);
has('15', 50);
has('50', 15);
check('"12" has no teen/ten twin', !extractNumbers('12').some((c) => c.value === 20));
check('"17" still prefers 17', extractNumbers('17')[0].value === 17);

console.log('— recognizer cannot deadlock —');

/**
 * The failure that killed voice mid-session: start() throws InvalidStateError,
 * the old code set running = true and waited for an onend that never came, and
 * every subsequent start returned early forever — deaf, while still reporting
 * "listening". The adapter must escalate to rebuilding the instance instead.
 */
{
  let constructed = 0;
  class WedgedRecognition {
    constructor() { constructed++; }
    lang = ''; continuous = false; interimResults = false; maxAlternatives = 1;
    start() { const e = new Error('already started'); e.name = 'InvalidStateError'; throw e; }
    stop() {}
    abort() {}
    onstart = null; onaudiostart = null; onspeechstart = null;
    onspeechend = null; onresult = null; onerror = null; onend = null;
  }

  const timers = [];
  globalThis.window = {
    SpeechRecognition: WedgedRecognition,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  };

  const { WebSpeechAdapter } = await load('src/voice/recognizer.ts');
  const a = new WebSpeechAdapter('en-US');
  a.start();
  // Drain the scheduled restarts; each start() throws again.
  for (let i = 0; i < 12 && timers.length; i++) timers.shift()();

  const d = a.diagnostics();
  check('a wedged recognizer gets rebuilt rather than deadlocking',
    a.rebuilds > 0, `rebuilds=${a.rebuilds} constructed=${constructed}`);
  check('running is never left stuck true', d.running === false, `running=${d.running}`);
  check('diagnostics expose the reset reason', typeof d.lastReset === 'string' && d.lastReset !== '—',
    `lastReset=${d.lastReset}`);

  delete globalThis.window;
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
