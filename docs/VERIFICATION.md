# Verification

## The problem this solves

There is no human playtester in this project's loop. Duane sets a goal and steps away; the game's
quality has to be assessed by whoever is building it. That makes "I think this feels good" not a
verification step, and it makes any quality signal that isn't automated effectively nonexistent.

So the harness is a first-class part of the product. Six instruments, each answering a question that
intuition can't. Audio used to be the seventh entry and the honest blind spot; it is now an
instrument too, with a much smaller blind spot inside it.

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

Captured states: title, sortie at low/medium/high projectile density, item choice, shop, death,
extraction, hangar, personnel, seed entry, share card, pause; plus the M5 screens — world map,
sector two, hazard warning, hazard active, boss fight, and a later boss phase. Each at a small
window size too, to catch layout breakage.

**Every capture waits on real run state, never on elapsed time.** `waitFor` polls the harness
probe (`window.__nextPilot`) and *fails loudly* if the predicate never becomes true, because a
capture that quietly photographs the wrong moment is worse than no capture. This rule was learned
the hard way: a time-driven death capture once stopped six seconds before the bot died and filed a
picture of a perfectly healthy ship. It matters much more now — a sector is three minutes and a
full run is fifteen, so a duration guess for "the boss fight" is not merely fragile, it is
guaranteed to be wrong.

**Known limit, and it is a real one.** With a target clear rate of 20–40%, most bot runs die in
sector one or two, so the captures that need sector four or five will frequently fail to reach
their state. That is the harness working as designed — a loud failure, not a wrong picture — but
it makes those captures unreliable rather than merely occasionally red. The fix is a per-capture
seed known to reach the stage, or a capture-only policy tuned for survival. It is explicitly
**not** a god-mode URL flag: shared seeds and daily contracts depend on a run being honest, and an
instrument that changes the thing it measures is not an instrument.

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

## 5. Audio

**Question: does it sound right? Now partly answerable, and the part that is answerable was
wrong.**

Audio was this project's one instrument-free system: a rendered frame can be looked at, and there
was no equivalent for sound in a headless environment. `npm run audio` (`tools/audio.ts`) is that
equivalent.

### How it works

Playwright drives real Chromium against an `OfflineAudioContext`, faster than real time, running
the **shipped** audio path end to end:

```
SimEvent → cueForEvent → Mixer (category gains, retrigger gaps, priority stealing)
        → synth.buildVoice → biquads, oscillators, envelopes → master compressor → PCM
```

Nothing is reimplemented. `OfflineBackend` is an `AudioBackend` like the live one and differs only
in where its clock comes from — real time in the browser, a cursor the harness moves offline — so
voice limiting, which is entirely a question of what overlaps in time, is exercised exactly as it
is in a run. `src/audio/synth.ts` was extracted from the live backend specifically so both call it.

**Why a browser and not Node**, which would have been cheaper: what the game plays is decided by
Chromium's WebAudio — its biquad coefficients, its exponential ramp semantics, its
`DynamicsCompressor`. A Node reimplementation would measure a *model* of that graph, and the first
time the two disagreed the harness would confidently certify a mix nobody had produced.

Source is served to the page by an in-process `node:http` server that type-strips `src/**` on
demand, so there is no bundle step and the page imports the same files the app does. Everything
runs under a hard watchdog. Both of those follow `tools/screenshot.mjs` for the reasons its header
records.

### What it measures

Per cue, and per realistic mix, with the DSP hand-written in `src/audio/analysis.ts` (no
dependencies, per CLAUDE.md):

| measurement | why a listener cares |
| --- | --- |
| peak and **true peak** (4× oversampled, BS.1770) | clipping. A signal can sit at 0.99 every sample and still overshoot between them, which is what a DAC reproduces. |
| **LUFS** (BS.1770 K-weighting, ungated) | perceived loudness, so the mix hierarchy can be checked against what is heard rather than against its own constants. |
| **small-speaker LUFS** (everything below 150 Hz removed) | most players are on a laptop or a phone. A cue carried by a 78 Hz sine does not exist for them. |
| effective duration | how long a cue occupies the ear. An exponential release never reaches zero; the audible tail is shorter than the arithmetic one. |
| spectral centroid, third-octave profile, envelope shape | distinguishability — see below. |
| DC offset | inaudible alone, a headroom thief in a mix. |

### What it asserts

Every one of these fails the build with the measured number and the threshold it missed:

- **No cue clips.** True peak ≤ −1 dBTP solo, ≤ −0.3 dBTP for any mix.
- **No cue is silent** or longer than 1.5s, and DC stays under 0.003.
- **No cue loses more than 9 LU on a laptop speaker.**
- **The mix hierarchy holds in measured loudness**, not in constants: category means ordered, the
  weapon strictly the quietest thing in the game, and named pairs separated by a stated number of
  LU (`alarm.hullHit` ≥ 6 LU over `pickup.scrap`, and so on). The same ordering is re-checked on
  the small-speaker render, because a mix that is only legible with a subwoofer is not legible.
- **The pile-up does not run away.** The worst legitimate tick — 256 events, the cap
  `src/sim/world.ts` enforces — must not be louder over 400ms than the single loudest cue in the
  library. If it ever is, the mixer is summing rather than prioritising, and the reward for a
  screen-clearing hit is that you can no longer hear what is about to kill you. Uncontrolled
  summation is the classic failure of event-driven synthesis and nothing tested it before.
- **Cues that mean different things are separable.** Scored on four axes a listener actually uses
  — brightness in octaves, length in doublings, third-octave profile distance, envelope-shape
  distance — each divided by the amount that would suffice *on its own*, and combined with a
  **maximum**, not a sum: two sounds are told apart by their most obvious difference, and averaging
  would dilute it. 1.0 is "just separable".
- **Cues that mean OPPOSITE things are held to more, and are measured in combat.** A flat floor
  treats `ui.confirm`/`ui.cancel` (cost of confusion: a menu press) the same as
  `alarm.shieldAbsorb`/`alarm.shieldBroken` — "you are fine, keep flying" against "your buffer is
  gone and the next hit is permanent", delivered in the same moment, heard while dodging. Cost of
  confusing those: the run. So `src/audio/meaning.ts` classifies every cue by *what it tells the
  player to do* in a `Record` keyed by `SoundId` — a new cue nobody classified is a compile error —
  and **derives** the demanding pairs: any `stand-down` against any `evade`. Those must clear 2.0
  rather than 1.0, and must additionally clear an in-combat measurement, because separability in
  silence is not the question. `discriminationMargin` takes the per-band difference between the two
  cues and measures *that* against a rendered bed of ordinary combat; the best discriminating band
  must stand ≥ 10 dB clear, in a band a real speaker reproduces, and the difference must not be
  buried on average. Currently 13.7–28.8 dB across the seven opposed pairs.
- **The hazard warning cannot be masked.** Measured per-band against a rendered bed of ordinary
  combat: it must stand ≥ 9 dB above it averaged over its own bands and ≥ 6 dB in each of its three
  loudest, must lift the mix by ≥ 3 LU when it arrives, and must survive a 256-event tick without
  the voice limiter stealing it. It currently measures **+29 dB** and **+14.7 LU**, and holds the
  same margin during a screen clear.

It also writes 31 WAV files to `audio/` (gitignored; 32-bit float, so overs survive intact and the
file cannot disagree with the number printed beside it).

### What it found

The instrument justified itself on the first run. All of these were shipped, all typechecked, all
had passing tests, and none were visible to any test that read the constants rather than the sound:

- **Incoming enemy fire was 3 dB quieter than the player's own gun** (−46.6 vs −43.3 LUFS). The
  category numbers said 0.95 against 0.26 and every test agreed. A Q of 6 on the recipe's bandpass
  was throwing away 12 dB — the recipe gave back four times what the mix granted it. This is a P0
  by this project's own rules and it is now +9.0 LU the right way round.
- **`VOICE_PEAK_CEILING` was a clamp**, which pinned ten of twenty sounds to the identical gain
  0.700. A shield absorbing a hit, an enemy taking a shot at you, and losing the run all left the
  mixer at the same level. It is a scale factor now, and a test asserts that no distinct level the
  hierarchy asks for is collapsed.
- **The scrap pickup was the quietest sound in the game** at −46.2 LUFS, below the weapon it is
  meant to sit above. **The shield-absorb alarm** was 12 dB below the other alarms and 39ms long.
- **Four cues effectively did not exist on a laptop**: `ui.waveRelease` had 99% of its energy below
  150 Hz, `ui.stageCleared` 96%, `ui.cancel` 94%, `ui.confirm` 87%.
- **A third of the output range was unused.** The worst mix the simulation can produce measured
  −6.3 dBTP, so the game was quiet enough that a player would raise their system volume — which is
  precisely how a hazard warning becomes painful. The master level moved 0.55 → 0.7 on that
  evidence, with the headroom re-asserted.
- **"Shield held" and "shield gone" were not distinguishable while being shot at.** They scored
  1.46 in silence, which cleared the original flat floor — and the information separating them
  stood **0.6 dB** above ordinary combat. Adding the opposed tier immediately caught four more
  pairs that no hand-written list contained, all of them `alarm.shieldAbsorb` against something
  meaning the opposite, because it is the game's only "you are fine" cue. The root cause was that
  it lived at 3–4 kHz — crowded, and the band reserved for the hazard warning. It moved up to a
  narrow glass ring at 5.8–7.6 kHz; `alarm.shieldBroken` moved *down* into the low mids, since it
  had been **brighter** than the cue meaning you were safe, inverting the library's grammar that
  damage taken is dark and deflections are bright. That pair now measures 3.85 and **22.0 dB**.

The pile-up case came out clean and stayed clean: 256 simultaneous events render at −19.5 LUFS over
400ms against a −7.4 LUFS ceiling, because the limiter collapses them to seven voices. That is the
one place the existing design was already right, and now there is a number saying so.

### The instrument needs its own tests

`tests/audioAnalysis.test.ts` checks every measurement against a closed-form answer: a sine's RMS is
A/√2, an FFT agrees with a naive DFT, a tone's spectral centroid is its own frequency to within 0.02
octaves, K-weighting discounts bass and lifts presence. This is not ceremony — three bugs in the
instrument were found this way, and none of them would have thrown:

- `powerSpectrum` zero-filled its final frame, which is a step discontinuity, which is broadband. It
  read a pure 500 Hz tone as 564 Hz and made two cues that genuinely collide look comfortably
  distinct.
- `discriminationMargin` first sliced one arbitrary 165ms window out of the combat bed. Combat is
  bursty, so the verdict swung several decibels depending on whether the cut landed on a volley. It
  now averages the bed's density over its whole length and scales.
- The same function then reported that two cues were told apart at **50 Hz** — true of the samples
  and false of every laptop and phone. Bands below 150 Hz are no longer eligible to carry a
  distinction, the same rule the loudness measurement already applied.

A wrong measurement does not throw. It quietly certifies.

### What is still not verified — read this as the limit, not a formality

- **Whether any of it is pleasant, or appropriate, or good.** The harness can say a cue is present,
  unclipped, correctly ranked in the mix, audible on a laptop, and distinguishable from the cues it
  must not be confused with. It cannot say whether the kill sounds like decompression, whether the
  telegraph reads as a windup, or whether the whole thing is characterful or cheap. Those are
  listening judgements and the WAVs in `audio/` exist for exactly that.
- **Whether the weapon click is tolerable over 180 seconds at 20 shots/second.** Still the
  highest-risk unheard item. `audio/weapon-sustained.wav` is four seconds of it; fatigue is a
  minutes-long phenomenon and no measurement here models it.
- **The masking measurement is a per-band signal-to-masker ratio, not a psychoacoustic model.** No
  spreading function, no temporal masking. That is the conservative half of the story — real
  spreading only ever makes masking worse — so a comfortable margin is necessary, not sufficient.
- **The small-speaker model is a 24 dB/octave high-pass**, with no cabinet resonance and no
  distortion. It answers "is anything left when the bass goes", not "how does this sound on a
  MacBook".
- **Chromium only.** Safari's WebAudio, `webkitAudioContext`, iOS unlock behaviour, and limiter
  pumping on a real device are all still unmeasured, as is CPU cost at 16 voices on a mid-range
  phone.
- **Absolute level is a judgement.** Combat now integrates at −23.6 LUFS against a −18 to −23
  target typical for games. That number is measured; whether it is right depends on the player's
  system volume, and the pause menu has a master slider for a reason.

Audio claims in any report must now say which of these they rest on. "Measured at +29 dB above
combat" is a fact; "sounds urgent" is still unheard.

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

### What a full review found in the instruments — 2026-07-26, all closed

The 2026-07-26 review in `docs/ROADMAP.md` found four places where this harness read as coverage
it did not have. All four are fixed; they are kept here because the *shape* of them is the most
useful thing this document contains, and because a list of instruments with no history of failing
invites more trust than it has earned.

- **`check-contracts.mjs` did not forbid a sim → audio import**, though `src/audio/index.ts` told
  its reader that it did. Adding one printed `Contracts OK` and typechecked, while making the sim
  unrunnable headless — breaking the contract every other instrument here depends on. It also
  never applied the DOM and clock patterns to `src/core/**`, which the sim imports, and could not
  see a dynamic `await import()`. It now resolves specifiers to paths and walks the sim's
  transitive closure (29 of 77 files), **and it has 32 tests of its own**, including a clean
  fixture that deliberately carries `window.addEventListener` so the no-false-positive property is
  asserted rather than hoped for.
- **The bots' `ChoiceResolver` stopped running the policy after the first chained card**, so
  every between-sector pick rate in every multi-sector sweep was an artefact — the second time
  this class of bug made a sweep measure a different game than the one shipped. Worse, a *second*
  cause hid it: this file's own sweep recorded a seam's three cards as one, and dropped it for
  having no offers, so 1,201-tick stalls were charged to a record the report threw away.
- **The screenshot capture-intent check had never executed**, and read a field the probe does not
  expose, so switching it on would have failed every capture. Switched on, it immediately found
  that `combat-early` was photographing an empty playfield — a capture that had been reviewed by
  eye more than once.
- **A guard can be vacuous rather than absent.** `tests/bots.test.ts` asserted
  `pendingChoice === null || ticks < FIVE_SECTOR_TICKS`, whose second clause *is* the loop
  condition. `tests/choiceScreen.test.ts` matched `/\+\d+ more/` without checking the number, and
  so matched the off-by-one it should have caught. `tests/certifications.test.ts` asserted a card's
  text was non-empty, which is how three cards drifted away from their hulls' actual stats across
  three rebalances.

**The general lesson, and the reason this section is kept after being closed: every one of these
was written as a check and then stopped being one** — by a refactor, by a field rename, by content
outgrowing it. None was ever wrong when written. So the question to ask of any instrument here is
not "is it correct" but "what would tell me if it stopped being correct", and the answer has to be
something that fails.

Two gaps found the same day are worth stating separately, because they were *limits* rather than
bugs, and both are now closed:

- **The corpus had never exercised a single item.** Every fixture recorded with `new World(seed)`,
  so the item pool was empty and no `EffectKind` was ever replayed — which is the hole
  `retaliate()` firing on shield-absorbed hits, and missing pierce state in the digest, both hid
  in. `sector1-effects` now covers 7/7 effect kinds against a fabricated frozen table, and it also
  closes a second gap nobody had noticed: all three baselines end `lost`, so no fixture had ever
  replayed an extraction.
- **A screenshot's assertion was not atomic with its shutter.** `page.screenshot()` takes tens of
  milliseconds; a hazard warning is 60 ticks, i.e. 50ms of wall clock at `ff=20`. So a capture
  asserted the state it wanted and then filed an image of the state after it — the "does not show
  what it claims" failure arriving through the one gap the harness could not see. The sim is now
  frozen inside the `waitFor` predicate, in the same evaluation that observed the state.

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
