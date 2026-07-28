# 🎙️ MathFall — Voice Math Arcade

Say the answer out loud. The block explodes.

A synthwave arcade drill where maths problems fall toward your city and you destroy
them by **speaking the answer** — no typing, no aiming, no buttons. Built mobile-first,
installable as an app, and playable offline.

**Play:** https://amanrajyadav.github.io/mathfallx/

---

## The idea

Typing an answer breaks the loop. You solve `7 × 8`, then spend a second hunting for
`5` and `6` on a keypad — and the thing being trained stops being arithmetic and starts
being thumb speed. Saying "fifty six" costs nothing. The gap between knowing and
answering collapses, and the game finally measures the thing it is supposed to measure.

So voice is the primary input here, not a novelty toggle. The keypad still exists, and
is always one tap away.

---

## How the voice input actually works

Speech engines are trained on conversation. This game feeds them the opposite: bare,
context-free numbers with no sentence around them to disambiguate against. The language
model falls back on ordinary-English priors, where "two" is much rarer than "to", and
where three identical digits in a row look like a stutter worth collapsing.

The fix is **constrained decoding against the answers currently on screen.**

A general recognizer chooses between every number in the language. At any moment this
game has maybe five live blocks — so the real search space is five values. Every
plausible reading of the transcript is generated, then intersected with that set.

That single idea does most of the work:

| You say | Recognizer often returns | On screen | Resolves to |
|---|---|---|---|
| "fifteen" | `fifty` | `15` | **15** ✓ |
| "two" | `to` / `too` | `2` | **2** ✓ |
| "four" | `for` | `4` | **4** ✓ |
| "eight" | `ate` | `8` | **8** ✓ |
| "forty two" | `40 2` (split) | `42` | **42** ✓ |
| "forty two" | `four two` | `42` | **42** ✓ |
| "seventy" | `seventy` | *neither 70 nor 17* | rejected ✓ |

Because a wrong reading that matches nothing costs nothing, the parser can afford to be
generous — which is exactly what makes it accurate.

The rest of the pipeline:

- **No confidence gate.** Chrome on Android routinely reports `confidence: 0` on
  perfectly good results. The old build gated on `>= 0.7` and silently discarded most
  correct answers — that is why voice was shelved as "not working".
- **Interim results are acted on.** An interim hypothesis that exactly matches a live
  answer is almost certainly right, and firing on it saves a few hundred milliseconds.
- **The full n-best list is used.** Alternative 3 is often right when alternative 1 is a
  homophone.
- **Restart loop.** The recognizer stops constantly — after silence, after each
  utterance on iOS, when the tab blurs. Continuous listening is really a restart loop
  with backoff and a watchdog for the Android builds that go silent without firing
  `onend`.
- **Accent matters.** `en-IN` materially outperforms `en-US` on Indian-accented English.
  Switchable in Settings.

Verify the parser without a microphone:

```bash
node scripts/verify-voice.mjs
```

Settings also has a **phrase tester** — type what you would say and see how it resolves,
using the exact same pipeline the mic feeds.

---

## Adaptive difficulty

Two independent knobs, because they are genuinely different problems.

**What it asks — Elo.** Classical Item Response Theory needs every item pre-calibrated
against a large response dataset; this game generates items procedurally and infinitely,
so pre-calibration is impossible. Elo estimates player ability and item difficulty
jointly, on the fly, in a few floating-point operations — cheap enough to run on every
answer on a mid-range phone, with no server.

Scoring uses the **High Speed High Stakes** rule rather than binary right/wrong:

```
S = (2x − 1)(d − t)        x = 1 correct, 0 incorrect
                           d = time before the block lands
                           t = your response time
```

Knowing `7 × 8` in 1.2s and deriving it in 9s are not the same skill state. A fast
correct answer scores near `+d`; a fast *wrong* answer — careless mashing — is punished
near `−d`; slow answers of either kind land near zero, which is right, because they say
little about mastery. The engine targets roughly a 78% success rate, which is where flow
lives.

**How much time it allows — pressure.** Someone can know the answer and still need four
seconds to retrieve it. Missing a block eases fall speed and spawn rate immediately; a
clean streak winds them back up. Difficulty and time pressure adapt separately.

---

## Problems are generated, not stored

Problems are built as **abstract syntax trees** — operators at the interior nodes,
operands at the leaves — instantiated from templates under constraint satisfaction.
Difficulty is priced from the features that actually drive cognitive load: column carries
and borrows matter far more than raw operand size.

Speech adds constraints a typing game never needed:

- **Integers only.** The old generator produced answers like `0.43`. Nobody says that
  mid-arcade.
- **Non-negative**, unless explicitly unlocked.
- **Small enough to say in one breath.**
- **Unique among live blocks** — otherwise one spoken number is ambiguous between two
  targets, and constrained decoding stops working.

### Daily Challenge

40 problems, identical for every player on the planet, generated locally from the UTC
date as a PRNG seed. No network call, no payload, works on a plane.

---

## Power-ups you shout

Power-ups drop from destroyed blocks and fly to your ship on their own. You spend them
by **saying their name**.

| Power-up | Effect | Key | Trigger |
|---|---|---|---|
| ❄ **FREEZE** | Everything stops for 4s | `F` | automatic on pickup |
| ◷ **SLOW** | Half speed for 7s | `S` | automatic on pickup |
| ◈ **SHIELD** | Restores one shield | `H` | automatic on pickup |
| ☢ **NUKE** | Clears the screen | `N` | say it, tap it, or **shake the phone** |
| ✦ **DOUBLE** | Double score for 10s | `D` | say it or tap it |

The defensive three fire the instant you collect them. When the screen is already
getting away from you, a decision is the last thing that helps — by the time you've made
it, the block has landed. The tactical two stay in your hands, because spending those at
the right moment is the whole point of holding them.

The design constraint is the interesting part. In a game whose only input is speech, a
power-up you collect by *steering* forces a second, competing control scheme — which is
what the old build did, with an arrow-key rocket chasing tokens. That works on a
keyboard and is unusable while you are busy saying "fifty six" on a phone.

So collection is automatic and the skill is in *timing*: you shout FREEZE the moment the
screen gets away from you. Voice stays the single input, and the power-up becomes a
second vocabulary rather than a distraction from the first. (They're tappable too.)

Matching is deliberately strict — only a bare keyword fires, so an answer is never
misread as burning an item.

## Feel

- **Blocks have faces.** Eyes track your ship, blink out of sync, and shift from calm to
  panicked as they near the floor. Fast blocks scowl; bosses wear a crown.
- **Three-part explosions** — a white-hot core, debris in the block's own colour, then
  slow embers so the space doesn't snap back to empty.
- **Directional screen shake.** The camera kicks *away* from the impact rather than
  jittering randomly, because that's what recoil actually does.
- **Hit-stop.** A heavy kill freezes the world for ~110ms. A few frames of stillness sell
  weight better than any amount of extra particles.
- **Near-miss slow motion.** When a block is seconds from breaching, time stretches —
  turning the worst moment in a run into the most dramatic one, and buying you a beat to
  actually answer.
- **The ship banks into its target** and its engines burn brighter as your chain grows,
  so a long combo is something you can see building.
- **The gun sounds like a gun.** Following ZType, whose plasma shot is three layered
  samples, each shot is a hard noise transient for the crack, a downward sweep for the
  body, and a pitched tail that climbs the scale with your combo. A wrong input answers
  with a dry detuned minor second — dissonant enough to register instantly.

## Defend the ship

Bosses don't just fall. Following ZType's Oppressor, they periodically spray **single
digit shards** that home in on your ship. Say the digit to shoot one down; let it through
and it costs a shield.

This is what turns the ship from a scoreboard into something you're defending — before
it, nothing could ever reach you and the floor was the only threat. Shard digits are
always distinct from every answer on screen, so a shouted "seven" is never ambiguous
between the thing about to hit you and a block drifting down elsewhere.

## Modes

| Mode | Shape |
|---|---|
| **Arcade** | Endless waves, adaptive, 3 shields |
| **Daily** | 40 fixed problems, same for everyone today |
| **Blitz** | 60 seconds, no shields, maximum chaos |
| **Practice** | No fail state — drills your weakest skill |

---

## Controls

**Voice** — say the answer. Say a power-up's name to spend it, **"pause"** to stop.

**Touch** — tap the keypad. Tap the entry box to clear it.

**Keyboard** — digits to enter, `Enter` to fire, `Space` to clear, `B` for Overdrive,
`Esc` to pause.

---

## Built for a phone

- Portrait-first layout on `100dvh` with `env(safe-area-inset-*)` and
  `viewport-fit=cover`, so nothing hides behind a notch or the home indicator
- Touch targets ≥ 48px (the old numpad used 40px keys, below both Apple's and Material's
  minimums)
- `touch-action: none` — swiping at a block never scrolls or pull-to-refreshes the page
- DPR-aware canvas capped at 2×, with static layers pre-rendered offscreen and a quality
  tier that drops itself if frame times sag
- Screen Wake Lock during a run
- Installable PWA, playable offline

**Nothing in the frame loop touches React.** The previous version called
`setGameState({...})` every frame and rebuilt the entire starfield array — a full
reconciliation plus hundreds of allocations 60 times a second, which is why it needed a
hardcoded 0.7× speed multiplier on mobile to feel playable. Entities are now mutated in
place, particles come from a fixed pool, and React receives a throttled HUD snapshot
about ten times a second.

---

## Privacy & offline

The game itself is fully offline — problems are generated on device, progress lives in
`localStorage`, and a service worker caches the shell.

**Voice is the exception.** The Web Speech API streams audio to the browser vendor
(Google for Chrome, Apple for Safari). It is not on-device, and it needs a network. The
keypad is the offline path, and the UI says so rather than leaving a dead mic button.

Progress is stored as an event-sourced log — an immutable, UTC-timestamped record per
answer — rather than a mutable score blob. Nothing is transmitted; the shape just means
a backend could replay and reconcile two devices later without guessing.

---

## Development

```bash
npm install
npm run dev          # http://localhost:8080
```

```bash
npm run build        # production build
npm run lint         # eslint
npx tsc --noEmit -p tsconfig.app.json
node scripts/verify-voice.mjs
```

In dev, `window.__mathfall` exposes `{ game, renderer, voice, profile, step(frames) }`.
`step()` advances the simulation by hand, which is how the engine is tested without a
browser painting frames.

### Layout

```
src/
  engine/      rng · generator (AST + constraints) · adaptive (Elo + HSHS)
               profile (offline-first storage) · GameCore (the simulation)
  voice/       numbers (inverse text normalization) · recognizer (Web Speech
               adapter) · VoiceInput (constrained matching)
  render/      Renderer (canvas, synthwave)
  audio/       procedural SFX + music
  components/game/   thin React shell — HUD, controls, overlays
```

`SpeechAdapter` is a seam. A streaming cloud recognizer with real keyterm biasing would
implement the same interface without the game logic noticing.

---

## Credits

Created by **Aman Raj Yadav** · Powered by **Fluence** · MIT licensed
