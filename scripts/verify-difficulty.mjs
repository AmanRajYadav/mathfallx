/**
 * Checks that generated problems actually track the requested difficulty.
 *
 *   node scripts/verify-difficulty.mjs
 *
 * The arcade ramp is only meaningful if a low target reliably produces easy
 * problems. A flat weight floor in the template picker used to leak two-digit
 * multiplication into a target of 760, which is exactly what made wave one
 * feel wrong.
 */

import { build } from 'esbuild';

async function load(entry) {
  const r = await build({
    entryPoints: [entry], bundle: true, format: 'esm',
    platform: 'neutral', write: false, logLevel: 'silent',
  });
  return import('data:text/javascript;base64,' + Buffer.from(r.outputFiles[0].text).toString('base64'));
}

const { generateItem } = await load('src/engine/generator.ts');
const { Rng } = await load('src/engine/rng.ts');

let pass = 0, fail = 0;
const failures = [];
const check = (label, ok, detail) => {
  if (ok) pass++;
  else { fail++; failures.push(`${label}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * Samples n problems at a target rating and reports the answer spread.
 *
 * `spread` mirrors what GameCore passes: narrow at the start of a run,
 * widening as the ramp progresses.
 */
function sample(target, n = 4000, spread = 190) {
  const rng = new Rng(12345);
  const answers = [];
  const templates = new Set();
  for (let i = 0; i < n; i++) {
    const item = generateItem({ rng, targetRating: target, maxAnswer: 999, spread });
    answers.push(item.answer);
    templates.add(item.templateId);
  }
  answers.sort((a, b) => a - b);
  return {
    median: answers[Math.floor(n / 2)],
    p99: answers[Math.floor(n * 0.99)],
    max: answers[n - 1],
    over40: answers.filter((v) => v > 40).length / n,
    templates,
  };
}

// RUN_FLOOR — where every arcade run opens, at wave-1's narrow spread.
const floor = sample(760, 4000, 110);
console.log('\ntarget 760 (arcade wave 1)');
console.log(`  median ${floor.median}, p99 ${floor.p99}, max ${floor.max}, ${(floor.over40 * 100).toFixed(1)}% over 40`);
console.log(`  templates: ${[...floor.templates].join(', ')}`);

check('wave-1 median is single digit or low teens', floor.median <= 20, `median ${floor.median}`);
check('wave-1 answers stay small', floor.p99 <= 40, `p99 ${floor.p99}`);
// The decisive one: hard templates must not appear at all at the floor.
for (const hard of ['mul_2x2', 'paren_mul', 'sq_teen', 'mul_2x1', 'div_2d', 'mul_add']) {
  check(`no ${hard} at the run floor`, !floor.templates.has(hard));
}

// Mid ramp.
const mid = sample(1300);
console.log('\ntarget 1300 (mid ramp)');
console.log(`  median ${mid.median}, p99 ${mid.p99}, max ${mid.max}`);
check('mid ramp is harder than the floor', mid.median > floor.median, `${mid.median} vs ${floor.median}`);
check('mid ramp is not yet extreme', mid.p99 <= 300, `p99 ${mid.p99}`);

// Top of the range.
const high = sample(2000);
console.log('\ntarget 2000 (late waves / strong player)');
console.log(`  median ${high.median}, p99 ${high.p99}, max ${high.max}`);
check('high target is harder than mid', high.median > mid.median, `${high.median} vs ${mid.median}`);
check('high target reaches genuinely hard problems', high.templates.has('mul_2x2') || high.templates.has('sq_teen'));

// Monotonic across the whole ramp.
console.log('\nramp monotonicity');
const targets = [760, 900, 1050, 1200, 1350, 1500, 1650, 1800, 1950];
const medians = targets.map((t) => sample(t, 1500).median);
console.log('  ' + targets.map((t, i) => `${t}:${medians[i]}`).join('  '));
let monotonic = true;
for (let i = 1; i < medians.length; i++) if (medians[i] < medians[i - 1] * 0.7) monotonic = false;
check('difficulty rises with the target', monotonic, medians.join(','));

// Easy mode's ceiling.
const easy = sample(900);
const capped = (() => {
  const rng = new Rng(999);
  let worst = 0;
  for (let i = 0; i < 3000; i++) {
    worst = Math.max(worst, generateItem({ rng, targetRating: 900, maxAnswer: 20 }).answer);
  }
  return worst;
})();
console.log('\neasy mode');
console.log(`  uncapped median ${easy.median}; with maxAnswer 20 the largest answer seen is ${capped}`);
check('maxAnswer is respected absolutely', capped <= 20, `saw ${capped}`);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  x ' + f);
  process.exit(1);
}
