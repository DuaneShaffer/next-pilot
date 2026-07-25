# Verification

## The problem this solves

There is no human playtester in this project's loop. Duane sets a goal and steps away; the game's
quality has to be assessed by whoever is building it. That makes "I think this feels good" not a
verification step, and it makes any quality signal that isn't automated effectively nonexistent.

So the harness is a first-class part of the product. Six instruments, each answering a question that
intuition can't — and one honest blind spot.

---

## 1. Determinism and replay regression

**Question: did this change alter game behaviour?**

Because a run is a seed plus an input log, a recorded run is an executable specification. The
corpus lives in `tests/replays/` — each entry is a seed, a packed input sequence, and the expected
final state hash.

Any change that alters a recorded run's outcome fails CI immediately. Most of the time that's a
caught bug. Sometimes it's an intended balance change, in which case the fixture is re-recorded
and the diff in the commit shows exactly what moved.

This is the cheapest and highest-value instrument here, and it only exists because of the
determinism contract in `docs/ARCHITECTURE.md`.

## 2. Bot playtests

**Question: is the game balanced, and is it beatable?**

Since the sim runs headless with no renderer, thousands of full runs can be simulated in seconds.
Bots aren't trying to be human — they're instrumented probes with defined policies:

- **Dodger** — prioritises survival, minimal aggression.
- **Aggressor** — maximises damage output, accepts risk.

  **Do not read these as a floor and a ceiling.** That was the original framing and the first real
  sweep disproved it: dodger survived 141s while aggressor survived 183s and was the only policy
  that ever cleared the sector. Evasion without killing anything just delays being swarmed, so
  dodger's number is bounded by its inability to clear, not by its dodging. Aggressor is closer to
  a survivability *ceiling* than dodger is to a floor.
- **Greedy** — always takes the scrap and the risky route. Stress-tests the economy.
- **Random** — a control. If Random clears sector 3, the difficulty curve is broken.
- **Build-focused** — forces a specific item combination, to measure a synergy's real strength.

Each sweep reports: win rate per hull, median and p10/p90 run length, death location heatmap,
item pick rates, damage contribution per item, and scrap curves.

**Balance changes are justified with these numbers, not intuition.** "Arrears felt weak" is not a
reason; "Arrears clears sector 2 at 31% vs Lien's 58% across 2,000 runs" is.

The honest limitation: bots measure difficulty and balance, not *fun*. A bot can't tell us a
pattern is boring. Which is what the next instrument is for.

## 3. Screenshots

**Question: does it actually look right?**

Playwright drives the real build, forces exact states via `?seed=` and `?screen=`, and captures
PNGs. Those images get *looked at* — a rendering bug, an overlap, unreadable text, or a HUD that
breaks at a different window size is obvious in a screenshot and invisible in a passing test.

Captured states: title, sortie at low/medium/high projectile density, item choice, death, hangar,
and each at a small window size to catch layout breakage.

Given that interface clarity is priority one, this is the only instrument that checks the thing
the project is actually competing on. Any change to what the game looks like requires a
screenshot the author has genuinely reviewed.

Where a screen should be pixel-stable, screenshots also serve as visual regression baselines —
but the primary use is human-equivalent review, not diffing.

## 4. Budgets

**Question: is it still fast, and still small?**

Asserted as tests so regressions fail the build rather than accumulating quietly:

- Sim tick < 2ms p99 with 2,000 live projectiles.
- Frame < 8ms p99.
- `droppedTicks` == 0.
- Live projectile count stays within the renderer's spec.
- Bundle < 150KB uncompressed.

`tests/world.test.ts` already asserts projectile-count budgets; the frame-time assertions land
with the renderer work in M2.

## 5. Audio — a known blind spot

**Question: does it sound right? Currently unanswerable.**

Audio is the one part of this project with no instrument. Screenshots work because a rendered frame
can be looked at; there is no equivalent for sound in a headless environment, and no audio device
here at all.

What *is* tested (32 tests, all headless): the event→sound mapping is total, verified by exhaustive
`never` check rather than a hand-written list that can drift; voice limiting holds under 500 events
in one tick; the mix *ordering* is locked so changing the hierarchy requires deliberately changing a
test; mute genuinely starts no voices; unlock is idempotent.

What is **not** verified, and should be read as engineering judgement rather than fact:

- Whether any recipe sounds like the thing it is named after.
- Whether the weapon click is tolerable across a 180-second sector at 20 shots/second. This is the
  highest-risk item. Five mitigations are in place (the weapon is the quietest category at 0.26 vs
  1.0 for alarms, 25ms mostly-broadband so it can't stack into a drone, round-robin pitch and
  amplitude rotation rather than random draw, a 3-voice cap with a 28ms retrigger gap, and lowest
  priority so it always loses a contested slot) — all principled, none heard.
- Whether the absolute mix gaps are right. Ordering is tested; whether 0.26 makes the weapon vanish
  is not.
- Whether the telegraph reads as a windup, and whether stretching one recipe from 0.35s to 1s still
  reads as the same cue.
- Any real-device behaviour: iOS unlock, Safari's `webkitAudioContext`, limiter pumping under 16
  voices, CPU cost of ~16 voices on a mid-range phone.

**The fix, when it's worth building:** sounds are declarative `Layer` recipes interpreted by a
backend, so the real backend can be driven inside headless Chromium against an `OfflineAudioContext`
to render each cue to a buffer. That yields objective measurements (peak, RMS, duration, spectral
centroid — enough to catch a "quiet" category that is actually loud because its envelope is long)
*and* WAV files a human can listen to on their next check-in. Tracked, not done.

Until then: audio claims in any report must be labelled as unheard.

## 6. Contract enforcement

**Question: are the three contracts still actually true?**

`npm run contracts` (`tools/check-contracts.mjs`) statically checks what `CLAUDE.md` only
described in prose:

- No `Math.random()` anywhere the simulation can reach. `src/core/seed.ts` is the sole exemption,
  because choosing *which* run to play is not simulating it.
- Nothing in `src/sim/**` or `src/content/**` imports rendering or UI, or touches the DOM, or
  reads a clock. That is what lets the sim run headless.
- `tick()` takes an `InputSnapshot` and nothing else.

**Why this is worth a dedicated instrument:** each contract is breakable in one line, each break
invalidates the entire verification story, and *none of them fail a typecheck or a test*. A stray
`Math.random()` in spawn logic would make every recorded replay meaningless while the suite stayed
green. Honour-system rules that nothing checks are rules that erode — especially on a project
where work happens unattended.

It runs first in CI, because it's the cheapest check that can invalidate everything downstream.

---

## What "done" means

No change is complete until:

1. `npm run check` passes.
2. New behaviour has a test.
3. Balance claims cite bot-playtest numbers.
4. Visual changes have a reviewed screenshot.
5. The save schema still loads the previous version's saves.

## Reporting

When reporting progress, state what was measured and what wasn't. If a system is untested, say
so. If a balance change is a guess pending a sweep, say that. The value of this harness collapses
the moment its output gets reported optimistically.
