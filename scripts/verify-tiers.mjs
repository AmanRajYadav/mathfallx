/**
 * Checks the late-run difficulty ladder in Easy mode.
 *
 * Reported from real play: wave 113, 148,000 points, still answering `3 x 5`
 * and `6 + 2`. Easy pins difficulty at ratingCap 900 forever, so a strong
 * player never runs out of runway and the run cannot end. Tiers lift the
 * ceiling at wave 120 (medium) and 150 (hard).
 *
 * Drives the real generator through the real mode config — no browser.
 */

import { strict as assert } from 'node:assert';
import { build } from 'esbuild';

async function load(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
    logLevel: 'silent',
    define: {
      'import.meta.env.VITE_SUPABASE_URL': '"https://example.invalid"',
      'import.meta.env.VITE_SUPABASE_ANON_KEY': '"test"',
      'import.meta.env.DEV': 'false',
    },
  });
  const url = 'data:text/javascript;base64,'
    + Buffer.from(result.outputFiles[0].text).toString('base64');
  return import(url);
}

globalThis.localStorage = {
  map: new Map(),
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; },
  setItem(k, v) { this.map.set(k, String(v)); },
  removeItem(k) { this.map.delete(k); },
};
globalThis.window = { setTimeout: () => 0, clearTimeout: () => {}, addEventListener: () => {} };
globalThis.document = { addEventListener: () => {}, hidden: false };

const { MODES } = await load('src/engine/GameCore.ts');
const { generateItem } = await load('src/engine/generator.ts');
const { Rng } = await load('src/engine/rng.ts');

let passed = 0;
let failed = 0;

function check(name, fn) {
  try { fn(); passed++; }
  catch (err) { failed++; console.error(`  FAIL ${name}\n        ${err.message}`); }
}

const easy = MODES.easy;
const TIER_BLEND = 10;
const RUN_FLOOR = 760;

/** Re-implements the engine's tier resolution, so the config is what is tested. */
function tierAt(wave) {
  let active = null;
  for (const t of easy.tiers ?? []) if (wave >= t.atWave) active = t;
  return active;
}

function capAt(wave) {
  const tier = tierAt(wave);
  if (!tier) return easy.ratingCap;
  const tiers = easy.tiers;
  const i = tiers.indexOf(tier);
  const prev = i > 0 ? tiers[i - 1].ratingCap : easy.ratingCap;
  const t = Math.min(1, (wave - tier.atWave) / TIER_BLEND);
  return prev + (tier.ratingCap - prev) * (t * t * (3 - 2 * t));
}

function maxAnswerAt(wave) {
  return tierAt(wave)?.maxAnswer ?? easy.maxAnswer;
}

/** The difficulty the engine would request at this wave, capped. */
function targetAt(wave, ceiling = 1300) {
  const ramp = easy.rampWaves ?? 8;
  const floor = Math.min(RUN_FLOOR, ceiling);
  const t = Math.min(1, (wave - 1) / ramp);
  let base = floor + (ceiling - floor) * (t * t * (3 - 2 * t));
  base += Math.max(0, wave - ramp) * 24;
  return Math.min(base, capAt(wave));
}

console.log('\n— Easy stays easy for the first hundred waves —');

check('wave 1 opens at the floor', () => {
  assert.ok(targetAt(1) <= RUN_FLOOR + 1, `wave 1 target ${targetAt(1)}`);
});

check('waves 10-119 stay pinned at the easy cap', () => {
  for (const w of [10, 40, 80, 113, 119]) {
    assert.equal(Math.round(targetAt(w)), 900, `wave ${w} should sit at the easy cap`);
    assert.equal(maxAnswerAt(w), 20, `wave ${w} must keep answers under 20`);
    assert.equal(tierAt(w), null, `wave ${w} must be below the first tier`);
  }
});

check('the reported wave-113 run really was capped', () => {
  // This is the bug as observed: nothing about wave 113 differed from wave 10.
  assert.equal(targetAt(113), targetAt(10));
  assert.equal(maxAnswerAt(113), maxAnswerAt(10));
});

console.log('\n— medium arrives at wave 120 —');

check('wave 120 crosses into the medium tier', () => {
  assert.equal(tierAt(119), null);
  assert.equal(tierAt(120)?.label, 'MEDIUM');
});

check('the cap eases in rather than jumping', () => {
  // At the boundary itself the cap is still the old one, so the step is felt
  // over the following waves instead of as a wall.
  assert.equal(Math.round(capAt(120)), 900, 'no cliff at the boundary');
  assert.ok(capAt(125) > 900 && capAt(125) < 1150, `mid-blend cap ${capAt(125)}`);
  assert.equal(Math.round(capAt(130)), 1150, 'fully eased in after the blend');
});

check('the cap only ever rises', () => {
  let prev = -Infinity;
  for (let w = 1; w <= 200; w++) {
    const c = capAt(w);
    assert.ok(c >= prev - 1e-9, `cap dropped at wave ${w}: ${prev} -> ${c}`);
    prev = c;
  }
});

check('medium allows two-digit answers and harder blocks', () => {
  assert.equal(maxAnswerAt(120), 99);
  assert.equal(tierAt(120).plainBlocksOnly, false);
});

console.log('\n— hard arrives at wave 150 —');

check('wave 150 crosses into the hard tier', () => {
  assert.equal(tierAt(149)?.label, 'MEDIUM');
  assert.equal(tierAt(150)?.label, 'HARD');
  assert.equal(maxAnswerAt(150), 999);
});

check('hard blends up from medium, not from the easy cap', () => {
  assert.equal(Math.round(capAt(150)), 1150, 'must continue from the medium cap');
  assert.equal(Math.round(capAt(160)), 1500);
});

console.log('\n— the generator actually produces harder problems —');

check('difficulty is strictly ordered across the three tiers', () => {
  const sample = (wave) => {
    const rng = new Rng(12345);
    let sum = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const item = generateItem({
        rng,
        targetRating: targetAt(wave),
        maxAnswer: maxAnswerAt(wave),
      });
      sum += item.answer;
    }
    return sum / n;
  };

  const easyAvg = sample(100);
  const medAvg = sample(135);
  const hardAvg = sample(165);

  assert.ok(easyAvg < 20, `easy answers should stay tiny, got ${easyAvg.toFixed(1)}`);
  assert.ok(medAvg > easyAvg, `medium must be harder: ${medAvg.toFixed(1)} vs ${easyAvg.toFixed(1)}`);
  assert.ok(hardAvg > medAvg, `hard must be harder: ${hardAvg.toFixed(1)} vs ${medAvg.toFixed(1)}`);
  console.log(`    mean answer — easy ${easyAvg.toFixed(1)} · medium ${medAvg.toFixed(1)} · hard ${hardAvg.toFixed(1)}`);
});

check('answers never exceed the tier ceiling', () => {
  for (const wave of [50, 125, 160]) {
    const rng = new Rng(999);
    const limit = maxAnswerAt(wave);
    for (let i = 0; i < 500; i++) {
      const item = generateItem({ rng, targetRating: targetAt(wave), maxAnswer: limit });
      assert.ok(item.answer <= limit, `wave ${wave}: answer ${item.answer} over ${limit}`);
      assert.ok(item.answer >= 0, `wave ${wave}: negative answer ${item.answer}`);
    }
  }
});

console.log('\n— other modes are untouched —');

check('only Easy has tiers', () => {
  for (const m of ['arcade', 'daily', 'blitz', 'zen']) {
    assert.equal(MODES[m].tiers, undefined, `${m} must not have gained a tier ladder`);
  }
});

check('Easy still has no shortcut past its own cap early on', () => {
  assert.equal(easy.ratingCap, 900);
  assert.equal(easy.maxAnswer, 20);
  assert.equal(easy.plainBlocksOnly, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
