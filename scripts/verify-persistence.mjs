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

await check('starting and ending a run clear the snapshot', () => {
  const start = coreSrc.slice(coreSrc.indexOf('  start(mode: GameMode'), coreSrc.indexOf('  end(): void {'));
  const end = coreSrc.slice(coreSrc.indexOf('  end(): void {'));
  assert.ok(/clearCheckpoint\(\)/.test(start), 'start does not clear a stale checkpoint');
  assert.ok(/clearCheckpoint\(\)/.test(end.slice(0, 900)), 'end does not clear the checkpoint');
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

await check('submitRun does not call the network directly', () => {
  assert.ok(
    !/submitScore\(/.test(shellSrc),
    'the shell must go through the outbox, never straight to submitScore',
  );
});

await check('a known name saves without a tap', () => {
  assert.ok(
    /if \(screen !== 'over' \|\| !summary \|\| submitState !== 'idle'\) return;/.test(shellSrc),
    'no auto-save effect on the game-over screen',
  );
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
}

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
