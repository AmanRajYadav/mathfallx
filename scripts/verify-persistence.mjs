/**
 * Checks that a finished run cannot be lost.
 *
 * Written after a player lost a 143,979-point run: it existed only on the
 * game-over screen, and reaching the server depended on a tap landing, the
 * network being up, and the page surviving in between. These are the rules
 * that replaced that.
 *
 * Runs the real modules against a fake localStorage — no browser, no network.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** Same trick the other verify scripts use: bundle the TS, import the result. */
async function load(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
    // Vite injects these; outside it `import.meta.env` does not exist at all.
    define: {
      'import.meta.env.VITE_SUPABASE_URL': '"https://example.invalid"',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"test-anon-key"',
    },
  });
  const url = 'data:text/javascript;base64,'
    + Buffer.from(result.outputFiles[0].text).toString('base64');
  return import(url);
}

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n        ${err.message}`);
  }
}

function section(title) {
  console.log(`\n— ${title} —`);
}

// --------------------------------------------------------------- fake storage

class FakeStorage {
  constructor() { this.map = new Map(); this.failWrites = false; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.map.set(k, String(v));
  }
  removeItem(k) { this.map.delete(k); }
}

const storage = new FakeStorage();
globalThis.localStorage = storage;
globalThis.window = { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {} };
globalThis.document = { addEventListener: () => {}, hidden: false };
// Node 22 defines navigator as a getter-only global, so it has to be replaced
// rather than assigned.
Object.defineProperty(globalThis, 'navigator', {
  value: { onLine: true },
  configurable: true,
});

// The outbox imports leaderboard.ts for submitScore; stub fetch so nothing
// leaves the machine. Each test installs its own behaviour.
let fetchImpl = async () => { throw new Error('offline'); };
globalThis.fetch = (...args) => fetchImpl(...args);
globalThis.AbortController = class { constructor() { this.signal = null; } abort() {} };

const outbox = await load('src/net/outbox.ts');

// -------------------------------------------------------------- source checks
//
// The rules below are structural: they are about *where* code runs, which a
// unit test cannot observe. Asserting on the source is blunt but it is what
// actually catches a regression here.

const mainSrc = readFileSync(join(root, 'src/main.tsx'), 'utf8');
const coreSrc = readFileSync(join(root, 'src/engine/GameCore.ts'), 'utf8');
const shellSrc = readFileSync(join(root, 'src/components/game/MathFallGame.tsx'), 'utf8');

section('the app never reloads out from under a run');

await check('controllerchange does not reload unconditionally', () => {
  const handler = mainSrc.slice(mainSrc.indexOf("addEventListener('controllerchange'"));
  const body = handler.slice(0, handler.indexOf('});'));
  assert.ok(
    !/location\.reload\(\)/.test(body),
    'controllerchange still reloads directly; it must defer to applyUpdate',
  );
  assert.ok(/updatePending\s*=\s*true/.test(body), 'controllerchange must record a pending update');
});

await check('the only reload is guarded by the busy check', () => {
  const reloads = [...mainSrc.matchAll(/location\.reload\(\)/g)];
  assert.equal(reloads.length, 1, `expected exactly one reload call, found ${reloads.length}`);
  const before = mainSrc.slice(0, reloads[0].index);
  const guard = before.slice(before.lastIndexOf('const applyUpdate'));
  assert.ok(/busy\(\)/.test(guard), 'the reload is not guarded by busy()');
});

await check('a missing busy probe counts as busy', () => {
  assert.ok(
    /typeof probe !== 'function'\) return true/.test(mainSrc),
    'before the shell boots, the app must be treated as busy',
  );
});

await check('the shell publishes the busy probe', () => {
  assert.ok(/__mathfallBusy\s*=\s*\(\)\s*=>/.test(shellSrc), 'shell does not publish __mathfallBusy');
  assert.ok(
    /isBusyScreen\s*=\s*\(s: Screen\)\s*=>[^;]*'playing'[^;]*'paused'[^;]*'over'/.test(shellSrc),
    'busy must cover playing, paused and the unsaved game-over screen',
  );
});

await check('returning to a safe screen releases a deferred update', () => {
  assert.ok(/dispatchEvent\(new Event\('mathfall:idle'\)\)/.test(shellSrc), 'shell never signals idle');
  assert.ok(/addEventListener\('mathfall:idle', applyUpdate\)/.test(mainSrc), 'idle does not apply the update');
});

section('a run survives being interrupted');

await check('the engine checkpoints on a timer while playing', () => {
  assert.ok(/CHECKPOINT_INTERVAL_MS/.test(coreSrc), 'no checkpoint interval');
  assert.ok(/this\.checkpointTimer >= CHECKPOINT_INTERVAL_MS/.test(coreSrc), 'checkpoint is not driven by the tick');
});

await check('the engine checkpoints on pause', () => {
  const pause = coreSrc.slice(coreSrc.indexOf('  pause(): void {'));
  assert.ok(/this\.checkpoint\(\)/.test(pause.slice(0, 800)), 'pause does not checkpoint');
  assert.ok(/flushProfile\(\)/.test(pause.slice(0, 800)), 'pause does not force the profile write through');
});

await check('the snapshot lives until the score is queued', () => {
  const start = coreSrc.slice(coreSrc.indexOf('  start(mode: GameMode'), coreSrc.indexOf('  end(): void {'));
  const end = coreSrc.slice(coreSrc.indexOf('  end(): void {'), coreSrc.indexOf('const summary: RunSummary'));
  assert.ok(/clearCheckpoint\(\)/.test(start), 'start does not clear a stale checkpoint');
  // end() must NOT clear: a phone killed on the game-over screen before the
  // save fires still needs the run. It rewrites the final numbers instead.
  assert.ok(!/clearCheckpoint\(\)/.test(end), 'end() must not clear the checkpoint — the save owns that');
  assert.ok(/this\.checkpoint\(\);/.test(end), 'end() must write the final snapshot');
  // The clear happens in the shell, only after the run is safely in the outbox.
  const submit = shellSrc.slice(shellSrc.indexOf('const submitRun = useCallback'));
  const submitBody = submit.slice(0, submit.indexOf('}, [summary, boardName'));
  const queueAt = submitBody.indexOf('queueRun(');
  const clearAt = submitBody.indexOf('clearCheckpoint()');
  assert.ok(clearAt > queueAt && queueAt > -1, 'submitRun must clear the checkpoint only after queueing');
  // And recovery must not clear on load — a phone that dies twice in a row
  // would lose the run after all.
  const recover = shellSrc.slice(shellSrc.indexOf('const c = loadCheckpoint()'));
  assert.ok(
    !/clearCheckpoint\(\)/.test(recover.slice(0, recover.indexOf('}, [setScreenBoth]'))),
    'recovery must keep the snapshot until the run is queued',
  );
});

await check('the record banner survives mid-run best-score writes', () => {
  // checkpoint() writes the running score into profile.bestScore, so comparing
  // against the stored best at end() would always be false.
  assert.ok(/bestAtStart/.test(coreSrc), 'no bestAtStart baseline');
  assert.ok(
    /const isRecord = this\.score > this\.bestAtStart/.test(coreSrc),
    'isRecord must compare against the best as it stood at the start',
  );
  assert.ok(
    /const best = this\.bestAtStart/.test(coreSrc),
    'the live record banner must use the same baseline',
  );
});

await check('the shell recovers a leftover snapshot', () => {
  assert.ok(/loadCheckpoint\(\)/.test(shellSrc), 'shell never loads a checkpoint');
  assert.ok(/setRecovered\(true\)/.test(shellSrc), 'a recovered run is not flagged as such');
});

section('a finished run is stored before it is sent');

await check('the shell queues before flushing', () => {
  const fn = shellSrc.slice(shellSrc.indexOf('const submitRun = useCallback'));
  const body = fn.slice(0, fn.indexOf('}, [summary, boardName'));
  const queueAt = body.indexOf('queueRun(');
  const flushAt = body.indexOf('flushOutbox(');
  assert.ok(queueAt > -1 && flushAt > -1, 'submitRun must queue and flush');
  assert.ok(queueAt < flushAt, 'the run must be written to the outbox before the network is touched');
});

await check('wave is captured on the durable summary, not read from live HUD', () => {
  // A real 119-wave run was recorded on the leaderboard as wave 1 — the
  // default value of a fresh HudState — because the old code sent
  // `wave: hud.wave` (React state) instead of a value tied to the run that
  // actually happened. score and solved never had this problem because they
  // were always read off the summary; wave must be too.
  assert.ok(!/wave: hud\.wave/.test(shellSrc), 'submitRun must not read wave off live hud state');
  assert.ok(/wave: s\.wave/.test(shellSrc), 'submitRun must send the summary\'s own wave');
  assert.ok(/^\s*wave: number;/m.test(coreSrc), 'RunSummary must carry its own wave field');
  assert.ok(/wave: this\.wave,/.test(coreSrc), 'end() must capture wave into the summary at the moment the run ends');

  const checkpointSrc = readFileSync(join(root, 'src/engine/checkpoint.ts'), 'utf8');
  assert.ok(/wave: number;/.test(checkpointSrc), 'RunCheckpoint must carry wave too, or a recovered run loses it the same way');
});

await check('the server rejects a wave that could not have happened', () => {
  const schemaSrc = readFileSync(join(root, 'supabase/schema.sql'), 'utf8');
  assert.ok(
    /new\.wave - \(1 \+ floor\(new\.solved \/ 8\.0\)\)/.test(schemaSrc),
    'the validate_score trigger must tie wave to solved — the anon key is public, so a forged row bypassing the client entirely is one fetch() away in devtools',
  );
});

await check('a late network reply never hijacks the leaderboard tab', () => {
  // The queued->done poller runs for up to a minute after a run ends. It used
  // to call setBoardMode(summary.mode) on success, so a player who finished an
  // Easy run and then opened the Daily board watched the tab jump back to Easy
  // on its own — indistinguishable from the app glitching.
  const poll = shellSrc.slice(shellSrc.indexOf("if (submitState !== 'queued'"));
  const body = poll.slice(0, poll.indexOf('}, [submitState'));
  assert.ok(!/setBoardMode\(/.test(body), 'the delayed poller must not change the visible board');

  // The immediate path may set it, but only while the summary is still up.
  const submit = shellSrc.slice(shellSrc.indexOf('const submitRun = useCallback'));
  const submitBody = submit.slice(0, submit.indexOf('}, [summary, boardName'));
  assert.ok(
    /if \(screenRef\.current === 'over'\) setBoardMode/.test(submitBody),
    'setBoardMode must be guarded on the player still being on the summary screen',
  );
});

await check('submitRun does not call the network directly', () => {
  assert.ok(
    !/submitScore\(/.test(shellSrc),
    'the shell must go through the outbox, never straight to submitScore',
  );
});

await check('a known name saves without a tap — but never mid-keystroke', () => {
  // The original auto-save fired whenever the name field was non-empty, which
  // meant it fired on the FIRST LETTER a new player typed. The production
  // board filled with runs saved as "A", "1" and "s". The effect must arm
  // once per run and must not depend on the live text of the field.
  const at = shellSrc.indexOf('if (screen !== \'over\' || !summary || autoArmedRef.current) return;');
  assert.ok(at > -1, 'auto-save must be gated on a once-per-run flag, not on submitState');
  const effect = shellSrc.slice(at);
  const deps = effect.slice(0, 1400).match(/\}, \[([^\]]*)\]\);/);
  assert.ok(deps, 'auto-save effect has no dependency list');
  assert.ok(
    !deps[1].includes('boardName'),
    'auto-save must not re-run on name keystrokes — that is the "saved as A" bug',
  );
  assert.ok(/AUTOSAVE_GRACE_MS/.test(shellSrc), 'auto-save must wait through a visible grace window');
  assert.ok(
    /profileRef\.current\.name\.trim\(\)/.test(effect.slice(0, 400)),
    'auto-save must use the previously *saved* name, never the live field',
  );
});

await check('names are free-form: anything non-empty, capped at 16', async () => {
  // The teacher's rule: students type whatever they like, up to 16
  // characters — including one-letter names and non-Latin scripts. The cap
  // and the character filter live in sanitizeName.
  const lb = await load('src/net/leaderboard.ts');
  assert.equal(lb.sanitizeName('Aman Raj Yadav 10th A'), 'Aman Raj Yadav 1', '16-char cap');
  assert.equal(lb.sanitizeName('आरुषि'), 'आरुषि', 'Devanagari names must survive sanitising');
  assert.equal(lb.sanitizeName('A'), 'A', 'a single letter is a valid name');
  assert.equal(lb.sanitizeName('  <b>Om</b>  '), 'bOmb', 'markup is stripped, text kept');
});

await check('gameplay has no Menu button — only Pause', () => {
  const controlsSrc = readFileSync(join(root, 'src/components/game/Controls.tsx'), 'utf8');
  assert.ok(!/onMenu/.test(controlsSrc), 'a stray tap on Menu mid-run throws the run away');
  assert.ok(/onPause/.test(controlsSrc), 'Pause must remain');
  // Menu stays reachable, one deliberate step away, behind Pause.
  const overlaysSrc = readFileSync(join(root, 'src/components/game/Overlays.tsx'), 'utf8');
  const pauseScreen = overlaysSrc.slice(overlaysSrc.indexOf('export const PauseScreen'));
  assert.ok(/Main menu/.test(pauseScreen.slice(0, 900)), 'the pause screen must offer Main menu');
});

await check('the day flips at midnight IST, not 5:30am', () => {
  const rngSrc = readFileSync(join(root, 'src/engine/rng.ts'), 'utf8');
  assert.ok(/DAY_OFFSET_MS = 5\.5 \* 60 \* 60 \* 1000/.test(rngSrc), 'no IST day offset');
  // GameCore must key the daily record through dailyKey(), not raw UTC —
  // the two disagree between midnight and 5:30am IST.
  assert.ok(!/toISOString\(\)\.slice\(0, 10\)/.test(coreSrc), 'GameCore must not build day keys from raw UTC');
});

if (outbox) {
  section('the outbox retries what is worth retrying');

  const run = (over) => ({
    name: 'Aman', score: 143979, mode: 'easy', wave: 9, solved: 1310,
    accuracy: 0.94, bestCombo: 402, rating: 1180, voiceShare: 0.6,
    durationMs: 3_600_000, ...over,
  });

  await check('a queued run survives a failed send', async () => {
    storage.map.clear();
    const id = outbox.enqueue(run());
    assert.equal(outbox.pendingCount(), 1);
    assert.ok(outbox.has(id));
  });

  await check('re-queueing the same run does not duplicate it', () => {
    storage.map.clear();
    const id = outbox.enqueue(run());
    outbox.enqueue(run({ score: 143979 }), id);
    assert.equal(outbox.pendingCount(), 1, 'pressing Save after an auto-submit must not insert a second row');
  });

  await check('a successful send clears the run', async () => {
    storage.map.clear();
    const id = outbox.enqueue(run());
    fetchImpl = async () => ({ ok: true, status: 201, text: async () => '' });
    await outbox.flush();
    assert.equal(outbox.has(id), false, 'a sent run must leave the queue');
  });

  await check('a network failure keeps the run queued', async () => {
    storage.map.clear();
    const id = outbox.enqueue(run());
    fetchImpl = async () => { throw new Error('offline'); };
    await outbox.flush();
    assert.ok(outbox.has(id), 'an offline send must not discard the run');
  });

  await check('a rate limit keeps the run queued', async () => {
    storage.map.clear();
    const id = outbox.enqueue(run());
    fetchImpl = async () => ({
      ok: false, status: 500,
      text: async () => JSON.stringify({ message: 'rate limited: wait a moment before submitting again' }),
    });
    await outbox.flush();
    assert.ok(outbox.has(id), 'a rate-limited run must be retried, not dropped');
  });

  await check('a permanent rejection drops the run', async () => {
    storage.map.clear();
    const id = outbox.enqueue(run());
    fetchImpl = async () => ({
      ok: false, status: 500,
      text: async () => JSON.stringify({ message: 'implausible: score 999999 from 3 solved' }),
    });
    await outbox.flush();
    assert.equal(outbox.has(id), false, 'a permanently rejected run must not retry forever');
  });

  await check('a full queue keeps the best runs', () => {
    storage.map.clear();
    for (let i = 0; i < 40; i++) outbox.enqueue(run({ score: 1000 + i }));
    const count = outbox.pendingCount();
    assert.ok(count <= 30, `queue grew to ${count}`);
    const kept = JSON.parse(storage.getItem('mathfall.outbox'));
    assert.ok(
      kept.some((r) => r.score === 1039),
      'the highest score must survive the cap',
    );
  });

  await check('unwritable storage does not throw', () => {
    storage.map.clear();
    storage.failWrites = true;
    assert.doesNotThrow(() => outbox.enqueue(run()), 'a blocked localStorage must not break saving');
    storage.failWrites = false;
  });

  await check('a delivered run cannot be delivered twice', async () => {
    // Observed in production: identical rows eleven seconds apart, from
    // pressing Save right after the auto-save had already sent the run.
    storage.map.clear();
    const id = outbox.enqueue(run());
    fetchImpl = async () => ({ ok: true, status: 201, text: async () => '' });
    await outbox.flush();
    assert.equal(outbox.has(id), false, 'first send should drain the queue');

    outbox.enqueue(run(), id);          // the Save button, pressed again
    assert.equal(outbox.has(id), false, 'a re-queue of a sent run must be refused');
  });

  await check('correcting the name after sending is allowed through', async () => {
    storage.map.clear();
    const id = outbox.enqueue(run({ name: 'Aarushi' }));
    fetchImpl = async () => ({ ok: true, status: 201, text: async () => '' });
    await outbox.flush();

    // Wrong player's name went out on a shared phone; the correction is a
    // deliberate new submission, not a duplicate.
    outbox.enqueue(run({ name: 'Utsav' }), id);
    assert.equal(outbox.has(id), true, 'a rename must be queued');
  });
}

section('the daily challenge changes at midnight IST');

{
  const rng = await load('src/engine/rng.ts');

  await check('11:59pm and 12:01am IST are different days', () => {
    // 18:29 UTC = 23:59 IST; 18:31 UTC = 00:01 IST next day.
    const before = new Date('2026-08-04T18:29:00Z');
    const after = new Date('2026-08-04T18:31:00Z');
    assert.notEqual(rng.dailySeed(before), rng.dailySeed(after), 'seed must change at IST midnight');
    assert.equal(rng.dailySeed(before), 20260804);
    assert.equal(rng.dailySeed(after), 20260805);
    assert.equal(rng.dailyKey(after), '2026-08-05');
  });

  await check('late-night play gets today, not yesterday', () => {
    // 20:00 UTC = 1:30am IST — under the old UTC boundary this was still the
    // *previous* day's questions, which players reported as "the daily never
    // refreshes".
    const lateNight = new Date('2026-08-04T20:00:00Z');
    assert.equal(rng.dailySeed(lateNight), 20260805);
  });

  await check('the countdown targets IST midnight', () => {
    const now = new Date('2026-08-04T18:00:00Z'); // 23:30 IST
    assert.equal(rng.msUntilNextDay(now), 30 * 60 * 1000, 'half an hour to IST midnight');
  });
}

section('the rank you are shown is your own');

await check('rank is resolved by device AND name, never name alone', () => {
  const lbSrc = readFileSync(join(root, 'src/net/leaderboard.ts'), 'utf8');
  const fn = lbSrc.slice(lbSrc.indexOf('export async function fetchRank'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.ok(
    /r\.player_id === me && r\.name\.toLowerCase\(\) === key/.test(body),
    'fetchRank must match the player\'s own row, not the first row carrying that name',
  );
});

await check('two players sharing a name get different ranks', () => {
  // The exact shape of the live board when this was reported: two devices
  // both called "Anonymous", at #3 and #6.
  const board = [
    { name: 'Ayush',     score: 20000, player_id: 'other1' },
    { name: 'Aarushi',   score: 15000, player_id: 'other2' },
    { name: 'Anonymous', score: 10426, player_id: 'deviceA' },
    { name: 'Shourya',   score: 9000,  player_id: 'other3' },
    { name: 'Aditi',     score: 8000,  player_id: 'other4' },
    { name: 'Anonymous', score: 7744,  player_id: 'deviceB' },
  ];
  const rankFor = (me) =>
    board.findIndex((r) => r.player_id === me && r.name.toLowerCase() === 'anonymous') + 1;

  assert.equal(rankFor('deviceA'), 3, 'the higher Anonymous is 3rd');
  assert.equal(rankFor('deviceB'), 6, 'the lower Anonymous is 6th, not 3rd');

  // What the old code did, for contrast: both devices were told "#3".
  const nameOnly = board.findIndex((r) => r.name.toLowerCase() === 'anonymous') + 1;
  assert.equal(nameOnly, 3);
  assert.notEqual(nameOnly, rankFor('deviceB'), 'name-only lookup is what reported the wrong rank');
});

section('desktop shortcuts');

await check('the ship holds five power-ups, laid out without overlap', () => {
  const m = coreSrc.match(/const MAX_INVENTORY = (\d+)/);
  assert.ok(m, 'no MAX_INVENTORY');
  assert.equal(Number(m[1]), 5, 'the ship should hold five');

  // Slots alternate left/right from the centre. With five, the outermost sits
  // two steps out; the step must clear the token diameter or they smear.
  const slots = coreSrc.slice(coreSrc.indexOf('powerSlots():'));
  const gap = Number(slots.match(/const gap = (\d+)/)[1]);
  const step = Number(slots.match(/const step = (\d+)/)[1]);
  const r = Number(slots.match(/r: (\d+)/)[1]);
  assert.ok(step >= r * 2, `step ${step} must clear the token diameter ${r * 2}`);

  // Widest reach on a 360px phone must stay on screen.
  const outermost = gap + 2 * step + r;
  assert.ok(outermost < 180, `outermost edge ${outermost}px would run off a 360px screen`);
});

await check('every power-up has a distinct, memorable key', () => {
  const src = readFileSync(join(root, 'src/engine/powerups.ts'), 'utf8');
  const want = { nuke: 'n', freeze: 'f', double: 'd', shield: 'l', slow: 's' };
  for (const [type, key] of Object.entries(want)) {
    const block = src.slice(src.indexOf(`  ${type}: {`));
    const found = block.slice(0, block.indexOf('},')).match(/key: '(\w)'/);
    assert.ok(found, `${type} has no key binding`);
    assert.equal(found[1], key, `${type} should be '${key}', got '${found[1]}'`);
  }
  // Distinct, or one key would silently shadow another.
  const keys = Object.values(want);
  assert.equal(new Set(keys).size, keys.length, 'two power-ups share a key');
});

await check('space clears the entry even with a control focused', () => {
  // Buttons keep focus after a mouse click, and Space re-activates a focused
  // button — so a bare preventDefault leaves the clear working only when
  // nothing has been clicked, which is exactly the "sometimes it does not
  // work" report.
  const handler = shellSrc.slice(shellSrc.indexOf('const onKeyDown = (e: KeyboardEvent)'));
  const body = handler.slice(0, handler.indexOf('window.addEventListener'));
  const spaceBranch = body.slice(body.indexOf("e.key === ' '"), body.indexOf("e.key === 'b'"));
  assert.ok(/stopPropagation\(\)/.test(spaceBranch), 'space must stop propagation, not just preventDefault');
  assert.ok(/handleKey\('clear'\)/.test(spaceBranch), 'space must clear the entry');
  assert.ok(
    /addEventListener\('keydown', onKeyDown, true\)/.test(shellSrc),
    'gameplay keys must be read in the capture phase, ahead of any focused control',
  );
});

section('the keypad does not reject digits it cannot judge');

await check('an empty board holds the entry instead of rejecting it', () => {
  assert.ok(
    /if \(live\.length === 0\) \{\s*setBoth\(next\);/.test(shellSrc),
    'with nothing live, a digit must be held rather than refused',
  );
});

await check('an empty target list does not wipe a half-typed entry', () => {
  assert.ok(
    /prev && answers\.length > 0 && !answers\.some/.test(shellSrc),
    'onTargets must not clear the field when the board is momentarily empty',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
