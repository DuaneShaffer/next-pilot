# Roadmap

Milestones are ordered by dependency, and each has **exit criteria that can be checked** rather
than judged. A milestone isn't done because it feels done.

The playable vertical slice is **M0 through M4**: a complete loop with real content, narrow rather
than shallow. Content breadth comes after the loop is good, never before.

---

## M0 — Foundation and deploy ✅

Prove the whole pipeline end to end before building anything on it.

- [x] Vite + TypeScript strict, zero runtime dependencies
- [x] Seeded RNG with independent named streams
- [x] Fixed-timestep loop with interpolated rendering, tested against a synthetic clock
- [x] `InputSnapshot` indirection and one-byte packing for replays
- [x] Virtual coordinate space; playfield and instrument panel columns
- [x] Palette, type scale, and text helpers enforcing the UI rules
- [x] Controllable hull, projectiles, parallax starfield, instrument panel
- [x] 51 tests covering determinism, distributions, loop timing, seeds, input packing
- [x] CI (typecheck + test + build) and auto-deploy to GitHub Pages

**Exit:** the deployed page loads and is interactive; `npm run check` passes; bundle under 150KB.

## M1 — Combat core ✅

The point at which it becomes a game: things shoot back and you can lose.

- [x] Enemy entities with data-driven definitions in `src/content/enemies.ts` (7 defs)
- [x] Wave spawner drawing from the `spawn` stream, deterministic per seed
- [x] Collision (circle + swept segment), damage, shields, integrity, invulnerability frames
- [x] Enemy projectile patterns: aimed, spread, ring, tracker
- [x] Death, run-end, and an incident report screen
- [x] Sector 1 (Debris Shelf) populated — 30 waves, 139 enemies, 180s
- [x] Bot playtest harness with four policies, and a contract checker enforcing the three rules

**Exit criteria, all met:** bots play complete runs and die; three recorded replays reproduce
bit-exactly in a separate process from the one that recorded them; damage and death have tests
(51 in `tests/combat.test.ts`); fixtures live in `tests/replays/`. 193 tests total.

**Known follow-ups carried into M2**, from real measurements rather than guesses:

- `greedy` dies at 123.7s ± 0.7s across 500 seeds — a deterministic wall, not a distribution.
  43% `collision:lancer` about 2s after the 121s wave. The playfield's upper half is effectively
  unusable from wave 21 on.
- `random` reaches wave 18 of 30 on pure noise, 57% through the sector. Not the alarm outright,
  but close enough to check. 62% of its deaths come from one def (`turret`).
- `waveIndex` is currently redundant with survival time — all 30 waves release on a fixed clock,
  so "wave reached" is survival time re-expressed. It only becomes an independent signal once
  clearing gates progression.
- The instrument panel has a ~140-unit void reserved for held items (M3), which currently reads
  as unfinished.
- Impacts read complete but weightless. That is precisely what M2 is for.

## M2 — Game feel

Priority two, and the milestone most easily skipped by mistake. Deliberately its own milestone so
it can't be.

- [x] Hitstop on impact, scaled by damage — **simulation state**, not a render trick. Capped at 8
      ticks; a single 4-damage bullet buys zero freeze, because at 20 shots/second one tick per hit
      would freeze the game a third of the time.
- [x] Screen shake, capped at 6 virtual units at ~10.5Hz, clipped to the playfield so the panel
      provably cannot move, and fully disableable from the pause menu (UI rule 10)
- [x] Impact flashes, hit sparks, layered explosions
- [x] Muzzle flash and tracer variation, and **shell ejection**, which this line recorded as
      deliberately skipped for the frame budget until 2026-07-26. It shipped; the 12× headroom
      measured below is why the scope decision went the other way. See the carried-forward note.
- [x] WebAudio synthesis, 14 cues, zero binary assets
- [x] Damage numbers near the ship (UI rule 9), aggregated so 20 hits/second on one target is one
      climbing number rather than twenty
- [x] Enemy telegraphs — `windupTicks` of real reaction time before every volley
- [x] Pause menu, which is also the settings screen, plus auto-pause on focus loss (an unfocused
      window previously kept simulating and quietly killed runs)
- [x] Save schema v2 with migration and a hand-written v1 fixture test

**Exit: met.** Measured in a real browser via `npm run perf`:

| Budget | Limit | Measured |
| --- | --- | --- |
| Frame p99 | 8ms | **0.66ms** |
| Sim tick p99 | 2ms | **0.07ms** |
| Dropped ticks | 0 | **0** |

Twelve times the frame headroom. Note what that run did *not* cover: it reached 64s of sector time,
so the heaviest moments — the elite at 134s and the clear-out beats at 164-174s — are unmeasured in
the browser. `tests/perf.test.ts` constructs the 2,000-projectile case directly, because real play
peaks near 54 live projectiles and no browser pass can reach 2,000 at all.

**Balance fixes, measured over 300 runs per policy across two base seeds:**

| policy | M1 | M2 |
| --- | --- | --- |
| aggressor clear | 44.0% | **39.3%** (42.0% on seed B) |
| greedy median | 123.3s | **153.6s** |
| greedy IQR | **3.0s** | **12.6s** (4.2× wider) |
| greedy `collision:lancer` | 47%, none during the dive | 35%, **all telegraphed** |
| random median | 104.8s, wave 18/30 | **95.6s**, wave 16/30 |
| dodger median | 126.0s | 122.0s |

**The diagnosis mattered more than the fix, and both prior suspicions were wrong.** The lancer parked
at y=216; a forward-flying pilot sits at y=230; lancer radius 13 plus hull hitbox 7 is 20. **It
arrived already inside contact range of the pilot it was supposed to be warning.** Of 121
`collision:lancer` deaths over 300 seeds, 64 happened while it descended, 57 while it sat parked and
motionless, and **zero during the dive** — the telegraph was being delivered after impact. Moving its
parking height to y=144 put 134 of 134 lancer collisions back in the dive phase.

Lengthening the tell (the intuitive fix) measured *worse*: a parked lancer sitting on you longer is
more contact, not more warning.

**Two changes were tried and reverted on evidence.** Turret HP 220→176 did nothing for `random`
(104.8s either way — 7 dps cannot kill a 176 HP turret either, and it leaves on its own timer
regardless) while handing `aggressor` 33 points of clear rate. An escort windup tweak was worth 1.5pp,
inside sample noise, and changing a number for an unmeasurable reason is how a tuned sector drifts.

**The death histogram was the wrong instrument for `random`.** Ablation — zeroing one damage source
and re-measuring — showed skiff fire worth +13.2s and turret fire worth +13.2s, identical, despite
turret being 62% of the histogram. A histogram over-attributes to whatever fires *last*.

**Not one wave was edited.** All the difficulty moved through behaviour, so the HP buckets are
unchanged and still monotone — a useful demonstration that spawned HP is only a proxy for difficulty.

**Trade-off, stated:** `dodger` loses ~4s and its deaths collapsed to two causes (turret 56%, escort
44%). Worth watching in M6, not worth chasing now.

**Carried forward, honestly:**

- ~~**Shell ejection** is not implemented.~~ **Shipped** (`drawFeelShells`, `src/render/feel.ts:764`,
  called from `src/render/scene.ts:740`). Verified 2026-07-26; this entry had gone stale in the
  opposite direction from the one it warned about — it sat here looking *undone*. It also carried a
  real defect while it sat here: shell positions were run through the 20–30 unit *label* inset from
  `clampX`/`clampY`, which pinned brass up to 19 units off the ship at the playfield edges. Fixed,
  with its own block in `tests/feel.test.ts` asserting the shell lands where the gun is.
- ~~**`Settings.reduceFlashes` exists in the save schema but is not offered in the pause menu**,
  because the renderer does not consume it.~~ **Both halves shipped.** Verified 2026-07-26: the
  renderer consumes it (`flashScale` / `hitFlashStrength` and the shockwave path,
  `src/render/effects.ts:207-259`, with the note at `:312` on why it is honoured in one place rather
  than at each drawing site), it reaches the render layer from `src/main.ts:1070`/`:1112`/`:1132`,
  and the pause menu offers the row (`src/ui/pauseMenu.ts:73`, whose comment records that it is
  offered "now because the renderer genuinely honours it"). The playfield hazard warning added the
  same day respects it too. The history is worth keeping and is recorded at `src/main.ts:1128`: the
  setting shipped in save schema v3 with nothing consuming it, which is exactly the "a control that
  silently does nothing" failure this entry was written about.
- **Nobody has heard the audio.** See the blind spot in `docs/VERIFICATION.md`. The fix is an
  `OfflineAudioContext` render in headless Chromium producing both measurements and WAVs; it needs
  a context shim because the backend constructs its own.

## M3 — The roguelike loop ✅

- [x] Item effect bus: stat modifiers with a fixed fold order, plus parameterised
      `EffectDef` behaviours the sim interprets — adding an item is a data change
- [x] 14 items and 7 interactions, with interactions as **first-class data** so the
      choice screen can state them (UI rule 5) rather than leaving them undiscoverable
- [x] Item-choice screen: three options, full mechanical text, synergy markers, current
      build visible, time paused
- [x] Scrap economy and a shop, priced against the measured scrap curve
- [x] Work-order assignment points (within a sector — see WorkOrderKind for why)
- [x] Death → next sortie in one input (landed in M2)

**Exit criteria, measured over 2 seeds × 1,000 runs (~15,600 offer slots each):**

| criterion | result |
| --- | --- |
| No item above 70% pick rate | **pass** — highest 39.8% |
| No item below 10% pick rate | **pass** — lowest 19.6% |
| Every item reachable | **pass** — none never offered; offer shares track weights |
| Every interaction reachable | **pass** — all 7 went live |

Offer rate and pick rate are reported separately, deliberately: an item offered rarely
and always taken is not the same as one offered constantly and usually declined, and
conflating them would have hidden both.

**Balance work this milestone, all measured:**

- **The first shop was dead in 999 of 999 screens** — median scrap at that wave was 67
  against a cheapest option of 120, so every visit was a forced decline. A shop the
  player can never buy from is worse than no shop: it teaches them that stopping is
  pointless. Moved later, base price cut, and prices now scale with progress so one
  number can serve both shops.
- **Items took a competent policy from a 39% clear to 99.3%.** The items are not
  individually overtuned; there were simply four rewards inside a three-minute sector,
  which is an entire five-sector run's worth of upgrades handed out during the
  *easiest* sector. Two per sector now — the pace a five-sector run wants — bringing it
  to 92%, with `greedy` 72% → 36.7% and `dodger`/`random` still at 0%.

**Carried into M6:** a 92% sector-1 clear for a developed build is defensible for the
*first* sector, but the real target is a full five-sector run and that cannot be
measured until M5.

**Two bugs from a human playing it**, neither of which any test caught:

- A reward card ignored a held trigger, so anyone still holding fire — nearly everyone
  in a shmup — got an apparently frozen game until a 60-second timeout. Fixed with a
  dwell that yields to deliberate input, plus an on-screen explanation.
- The pause menu's longest hint ran off the card, because it was drawn as one
  unmeasured line. `tests/textFits.test.ts` now walks **every authored string in the
  project** and measures it against its real container.

## M4 — Progression, seeds, replays ✅

- [x] Versioned save with migrations — v3, tested through the whole v1→v2→v3 chain from a
      hand-written v1 payload
- [x] Certifications that expand the pool; hangar listing unlock conditions explicitly
- [x] Personnel files: browsable history of dead pilots
- [x] Daily contract, seed entry, shareable seed URLs
- [x] Replay recording, playback, and URL encoding
- [x] Purist mode

**Exit criteria, all met:** a v1 save loads in the current build; a replay URL round-trips
and reproduces a run exactly; the daily seed is identical across two machines' clocks
(derived from the UTC date, no server). 896 tests.

**The decision that mattered most was made before the feature shipped.** Replay URLs
change what breaking the corpus costs. Until M4 it was free — hitstop changed timing,
items changed every run, and three fixtures were re-recorded each time — because nobody
outside the repository held a replay. So `SIM_VERSION` now travels with every replay and
playback refuses a mismatch in both directions. The dangerous case is not a rejected
replay but an accepted one: a run recorded before a balance change decodes *perfectly*
and then diverges silently, and the viewer watches a plausible run that is not the one
that was shared.

`tests/simVersion.test.ts` is the process guard. A canonical scripted run is hashed
against the real content tables, and if that hash moves without `SIM_VERSION` moving the
test fails with the exact steps. "Remember to bump the version" is not a process.

**Certifications make the design constraint unrepresentable.** A `PoolGrant` is
`{ slice, id }` — two fields, nowhere to write a magnitude — so "+5% damage forever"
cannot be typed rather than merely being discouraged. Eight of ten grant M5 content and
say so on screen.

**Measured, not assumed:** a twitchy run encodes to **7,626 characters** against a
2,000-char budget derived from the smallest cap a shared link actually meets (IE's
address bar, IIS's request line, QR capacity, mail-client linkification). Human play is
closer to that worst case than to a bot's, so the share card measures the finished URL
and offers the seed link instead rather than emitting something that dies silently in a
chat client.

**Honest limits on purist mode**, from the module that implements it: a modified client
can write any record it likes, and nothing here proves a *human* flew the run. It
certifies which pool a run drew from and must not be described as an anti-TAS measure.

**Bugs found in existing code while wiring this:**

- `normalizeSeed('not a seed at all')` returned a **valid seed**. The folding written for
  voice and OCR ambiguity was aggressive enough to manufacture a run out of prose, and
  pasting a share *link* mined twelve characters of hostname into a valid-looking seed
  for the wrong run. `looksLikeSeed` now gates repair.
- `World` held the work-order list as a literal, so two certifications with authored copy
  and passing tests could never have any effect.
- The pilot number incremented at **launch**, so a new player's first sortie was pilot
  002 and #001 never existed. Found by looking at the personnel screen.
- Two agents independently invented different vocabularies for "the pool" — a gap in the
  contract I failed to define before fanning out. Unified rather than adapted.

**← The vertical slice ends here. Everything above should be genuinely good before M5 begins.**

## M5 — Content

- All 5 sectors with distinct enemy grammars
- Boss per sector with seeded variants
- All 8 hulls
- ~40 items with a documented interaction graph
- Elites, hazards, vaults, curses
- World map + between-sector shops (folded in from "Proposed, unscheduled")

**Exit:** bot sweeps show a 20–40% clear rate for a competent policy and every hull within 15
percentage points of the mean; no sector is a difficulty cliff (death distribution has no single
spike above 35%).

### Measured, n=300 × 2 seeds — two of three met

> **These are the RE-MEASURED numbers**, taken after findings R1 and R11 were fixed. The first
> set was produced by two broken instruments — the bots resolved every chained between-sector
> card by confirming option 0 rather than by running the policy, and the entry-health metric
> divided by the current shield rather than the maximum, so it flattered exactly the
> integrity-recovery builds it was being used to judge. Both are fixed; every figure below is
> from the fixed instruments, 200 runs on each of two base seeds.

| Criterion | Broken instrument | Re-measured | |
| --- | --- | --- | --- |
| Clear rate, 20–40% | 20.0% / 24.3% | **26.5% / 36.5%** | met |
| Hull spread vs mean, ≤15pp | 13.6pp / 12.9pp | **12.5pp / 13.3pp** | met |
| Worst sector death share, ≤35% | 39.2% / 36.1% | **35.4% / 36.2%** | **not met, marginally** |

> **Superseded 2026-07-26** — see "Re-measurement pass" below. The clear rate moved (the shield
> recharges now) and the death-share row was two numbers all along: 35.4% / 36.2% is the competent
> policy, and the same sweeps' JSON reported 0.762 / 0.814 from the pooled probe set. Neither
> number changed; the criterion has always had two readings and the harness printed one and
> serialised the other. The base seeds are recorded here so a re-run is possible: A
> `K7F29XQM3RTV`, C `WWQ4B8HT2NZP`.

Median clearing run 16.8 minutes, inside the 15–20 target.

Seed A read **20.0%** on the broken instrument — sitting exactly on the criterion's lower
boundary — because the pilot was declining its own transit shops. That is the clearest available
argument for fixing an instrument before reading anything off it.

**And the death-share criterion is partly a fact about the criterion.** At 35.4% and 36.2% it
misses by about a point on ~140 deaths, which is inside noise — and **the spiking sector differs
by seed**: sector 2 on one, sector 1 on the other. A threshold that a single seed's noise can move
across is not measuring what it was written to measure. Worth revisiting the criterion, not only
the content.

**The world map is still a trap, and the rebalance's claim that it was not is withdrawn.**
Measured for the first time with route selection actually running: every detour style costs the
benchmark policy **5.5–9.5pp** of clear rate. Under the `random` style — where the roll is
independent of the pilot's state, so it is the cleanest comparison — a sector entered with a
hazard clears **66.0% against 79.4%**. Even `item-only`, which accepts a hazard *only* for a free
item, is net negative. Two visible causes are recorded separately: both priced routes carry the
same hazard when a sector has only one, and the scrap reward pays 125 cr against a median shop
holding of ~1,130.

**Sector 2 stays out of band and the reason is worth understanding before anyone "fixes" it.**
Its absolute deaths fell by 8pp, but sectors 4–5 take only 13–15% of deaths, so The Tally's
*share* stays high however much it is softened. Balancing the distribution means making the late
run harder, which costs clear rate — and criterion 1 has roughly zero headroom on one of the two
seeds. The three criteria are not independent, and this is where they pull against each other.

### Two structural findings that outrank the criteria

**Integrity recovery is the game's dominant variable, and nothing was designed around it.** Give
the Lien one item — Repair Nanites, nothing else changed — and its clear rate goes from 15.3% to
58.0%. Probate looked like the strongest hull by +24.8pp only because it starts holding the sole
source of recovery in the roster. Any future item, hull or route that restores integrity has to be
priced against that number, not against its own stat line.

**Boss bullet density is inert.** `applyHullDamage` grants 45 ticks of invulnerability, capping
intake at 1.33 hits/second, and every boss pattern is denser than that. Cutting the Repossessor's
fire rate by 42% moved the run one percentage point. Only per-shot damage and fight *length*
matter, at a measured 0.28pp of clear rate per second of boss time — which is why boss fights
cannot be lengthened into their originally authored 20–40s band without breaking the clear rate.
`BOSS_TTK_BAND.min` was lowered to 16.5 with the conflict recorded rather than quietly missed.

### What shipped

| Item | Status |
| --- | --- |
| 5 sectors, distinct grammars | **Done.** Structurally enforced: `tests/sectors.test.ts` asserts no two sectors draw from the same enemy set and each has an exclusive type, because a sector built by copying the previous one and editing counts looks fine in a diff. |
| Boss per sector, seeded variants | **Done.** 5 bosses, 4 variants across the last three. A boss is an enemy with phases, so no simulation code exists per boss. |
| All 8 hulls | **5 of 8.** Escrow, Indemnity and Writ are omitted rather than faked; each is recorded in `HULLS_AWAITING_MECHANICS` with the mechanic it needs. Three more shipped with part of their upside missing, stated in code and never on the player's card. See `docs/DESIGN.md`. |
| ~40 items | **Done.** 40 items, 28 interactions, max node degree 3 — a hub item every synergy runs through would collapse build variety into "did you find the hub". |
| Hazards | **Done.** 5, four kinds. Every one warns a full second before it acts. |
| Elites | **Done**, expanded through sectors 2–5. |
| Vaults, curses | **Curses done** (6 cursed items across three cost currencies). **Vaults not done** — a vault is a relic with a curse attached, and it needs curses that attach to a *pickup*, not curses that are pickups. |
| World map + shops | **Done.** Route choice between sectors, then a between-sector shop on its own price curve. |

### Bugs this milestone found in shipped code

Worth recording, because every one of these had been passing tests and none was visible
from a diff:

- **Enemy fire was 3.5 LU quieter than the player's own gun**, and three other cues were
  effectively inaudible on a laptop (up to 99% of their energy below 150 Hz). That is a
  legibility failure, not a mix preference — the sound telling you that you are being shot
  at was losing to the sound of you shooting. Found the first time anyone measured the
  audio, which had never been heard by anybody. See `docs/VERIFICATION.md` §5.
- **A second soft freeze, hiding inside the fix for the first.** `HELD_CONFIRM_DWELL_TICKS`
  confirms option 0 for a player holding the trigger, so a card can never go unresponsive.
  But a between-sector shop can price option 0 above what the pilot is carrying: the world
  refuses, the card stays open, and the next tick tries the same thing — for the full
  20-second timeout. A rescue that cannot complete now declines instead of looping.
  Found by reading the transition machine, not by a test.

- **`retaliation-coil` lied.** The card said "fires only on integrity loss" and `docs/DESIGN.md`
  reasoned a whole anti-synergy from that, but the sim fired it on shield-absorbed hits too.
  Found by a content author trying to write a *second* retaliation item and realising one of the
  two would have to be wrong on screen.
- **`grid-swep`.** A hazard id typo in the run's stage list, caught the first time
  `src/content/runs.ts` — which pairs sectors with bosses where both tables are in scope —
  was loaded.
- **A test that stopped measuring.** The build-focused bot probe expects to assemble two named
  items; at 14 items it did so often, at 40 it never does. The probe was silently no longer an
  instrument. (It was worse than a pool-size problem: the probe drove `SINGLE_SECTOR_RUN`, which
  was the whole game when it was written and is now one fifth of it. 12 offer slots per run
  against 36.)
- **The world map never happened in a single bot run.** The bots' `ChoiceResolver` read a card's
  option count from `offers.length`; a route card carries its options in `routes` with `offers`
  empty. So every policy saw a zero-option screen and skipped — and the simulation resolves a
  skipped route as "take the direct approach". Nothing crashed, nothing stalled, and every sweep
  measured a game with no hazards in it.
- **A field can exist and still be decoration.** `Replay` gained `hullId`, but `playback` took a
  `(seed) => World` factory, so a caller that ignored it flew the wrong ship and diverged exactly
  as badly as before — and `main.ts` *was* that caller. Fixed by verification rather than
  convention: the factory takes the hull and `playback` throws if the world reports a different
  one. `choiceSelection` had the same shape — it existed on `World`, was play-affecting (the dwell
  confirms whatever is highlighted), and was invisible to the state hash because it was not on
  `WorldView`.

## Full-project review, 2026-07-26 — open

A read of the whole tree at the M5 exit point. `npm run check` was green throughout (41 files,
1697 tests) and **none of these is caught by the existing suite** — that is the common thread
worth more than any single entry. Where a guard exists but does not fire, it is named, because a
test that cannot fail is worse than a missing one: it reads as coverage.

Numbered R1–R15 so commits and the M5 caveat above can cite them.

**Status lives in `git log`, not in this list.** Fixes cite their R-number in the commit subject,
so `git log --oneline --grep='R7'` is authoritative and a status column here would be stale within
the hour — this section is the *finding*, not its state. Several were fixed the same day they were
recorded, and the fixing turned up further defects in the same code paths; those are in the commit
messages rather than here, because a finding list that grows as it is worked stops being a record
of what a cold read of the tree found.

### Blocks trusting the measurements

- **R1 — the bots resolve every between-sector card by mashing option 0.** `sim/bots.ts:558`.
  `ChoiceResolver` resets `open`/`queue` only when `pendingChoice` becomes `null`, but
  `advanceTransition` opens the next card in the *same tick* the previous one confirms, so after
  the first card there is never a null gap to reset on. Verified on a 2-stage run: `route → item`
  at tick 176 with no gap, the item card resolved in 2 ticks by the retry branch rather than the
  6-tick navigation script, then a shop card stuck **1201 ticks** because option 0 was
  unaffordable — the world refuses, the branch re-confirms, until the timeout. So `chooseOffer`
  is bypassed at every seam and ~1200 dead ticks are added per seam. (**Correction of fact, not
  status**: `chooseRoute` is *not* bypassed. A route card is always the FIRST card of a seam and
  the sector was playing on the previous tick, so it always has its null gap — measured at 0 route
  cards chained across 500 runs. The finding named one function too many.) This is
  the exact corruption `MAX_CHOICE_RESOLUTION_TICKS`'s own docstring warns about, and it is the
  second time the `ChoiceResolver` has silently made a sweep measure a different game than the
  one shipped (see "the world map never happened", M5 above). Why the guards miss it: the timeout
  tests use single-sector `LIVE_CONTENT`, so they never chain two cards; and
  `tests/bots.test.ts:555` asserts `pendingChoice === null || ticks < FIVE_SECTOR_TICKS`, whose
  second clause is the loop condition — the assertion cannot fail.
- **R11 — `medianEntryHealthPct` divides by the wrong shield.** `tools/playtest.ts:1368` never
  captures `entryMaxShield`, so the current shield appears in both numerator and denominator and
  cancels: 100 integrity with a spent shield (100 effective HP) reports 100%, while 90 integrity
  with a full 40 shield (130 effective HP) reports 93%. It systematically flatters
  integrity-recovery builds — and it is the number cited as measured evidence for Repair Nanites
  ("62% → 89%", `items.ts`) and for Probate's per-sector entry figures (`hulls.ts`). Both of
  those readings are the ones the metric is most wrong about.

### Correctness

- **R2 — a `?seed=`, `?daily=1` or `?replay=` URL is never flown.** `main.ts:629`.
  `resolveRunMode` resolves the mode correctly and the title screen *displays* the seed, but the
  title's confirm handler calls `beginSortie()` with no argument, `beginSortie` does
  `seed = withSeed ?? generateSeed()`, and `launchSortie` then unconditionally sets
  `runMode = { kind: 'free', seed, purist: false }`. Share links carry only `seed`/`r` and never
  `screen=sortie` (`meta/seedModes.ts:704`, `:780`), so every shared seed, daily contract and
  replay lands on the title and is discarded on the first keypress. M4's headline feature does
  not work from a link. Related and probably the same omission: `describeRunMode` is documented
  as "what the HUD says about this run" and `render/panel.ts` never calls it — only the share
  card does.
- **R3 — the regression digest is blind to pierce state.** `meta/snapshot.ts:245`.
  `hashPlayerBullets` omits `pierceRemaining` and `hitUids`, both of which the *next* tick reads
  (`sim/world.ts:1124`, `:1156-1160`). Two worlds whose in-flight rounds have different remaining
  pierces, or have already hit different enemies, hash identically and diverge immediately after —
  so a regression anywhere in the piercing path goes green across the entire replay corpus. This
  is the `choiceSelection` failure from M5 again: play-affecting state that the hash cannot see.
  Fixing it is a widening, so it needs `DIGEST_GENERATION` 4 → 5 and a re-base per
  `tests/simVersion.test.ts:44`.
- **R5 — an abandoned daily contract is re-rollable.** `main.ts:517`, `meta/seedModes.ts:210`.
  `save.daily` is written only in `fileCompletedRun()`, which is reached only when
  `runState !== 'active'`; `abandonSortie()` returns to the title having filed nothing. So
  pause → abandon → restart lets a player re-roll the daily until wave 1 looks survivable, which
  is precisely what the `outcome: 'abandoned'` variant was added to prevent. That variant is
  never written anywhere in `src/`, which also dead-codes the "`active` is treated as `lost`"
  branch at `meta/personnel.ts:190-193`.
- **R6 — key autorepeat escapes `preventDefault`.** `core/input.ts:215` returns on `e.repeat`
  *before* calling `preventDefault()`, so only the first keydown of a hold is swallowed and every
  autorepeat event reaches the browser. Hold ArrowDown, ArrowUp or Space during a sortie and the
  page scrolls out from under the canvas — the exact thing `swallowedCodes` exists to stop.

### Interface — priority 1, so these are not cosmetic

- **R4 — the integrity meter prints an unrounded float.** `render/panel.ts:106` rounds `value`
  and passes `maxIntegrity` straight from `resolveStat`. Probate has `maxIntegrity mul 0.64`
  (`hulls.ts:339`); add any `add` item, e.g. `+18` (`items.ts:210`), and max is
  `(100 + 18) * 0.64 = 75.52`, so at full health the meter reads **`76 / 75.52 hp`**. The
  most-read number on screen, and a UI rule 2 violation. `ui/hullSelect.ts` already avoids this
  by going through `numeral()`.
- **R7 — Volume is adjustable while Muted, with no feedback.** `ui/settings.ts:130`.
  `adjustSettingValue` writes `masterVolume` unconditionally while `formatSettingDisplay` returns
  `'Muted'` whenever `settings.muted`, so with mute on every left/right press changes the value,
  sets `dirty` and writes to localStorage while the row never moves. Shared with the pause menu
  via `ui/pauseMenu.ts:119`, so it is wrong in both places.
- **R8 — the build strip's `+N more` undercounts.** `ui/choiceScreen.ts:571` computes
  `remaining = chips.length - placed` *before* the `while` at `:577` trims whole chips off the
  last line to fit the tail, and dropped chips are never added back. Produces 5 names and
  `+1 more` against a summary line reading `7 systems fitted` — the opposite of the intent stated
  in the comment directly above it. `tests/choiceScreen.test.ts:261` only matches
  `/\+\d+ more/`, so the count is unasserted.
- **R9 — only half the adjust affordance is drawn.** `ui/pauseMenu.ts:273` draws a single `'<'`
  at `contentX + 150`; there is no `'>'` anywhere in the file (the `'>'` at `:223` is the
  selection caret, at a different x). The row reads `Volume  <  75 %` — an arrow pointing away
  from the value it modifies, implying LEFT is the only key that does anything.

### Verification harness — the gaps that let the rest through

- **R10 — the contract-2 checker does not cover `src/audio`.** `tools/check-contracts.mjs:50`'s
  `FORBIDDEN_SIM_IMPORTS` matches only `render|ui`, yet `src/audio/index.ts:6-8` explicitly tells
  the reader that `npm run contracts` statically forbids a sim → audio import. Adding
  `import … from '../audio'` to `src/sim/world.ts` passes contracts *and* typecheck while making
  the sim unrunnable headless. Two narrower holes in the same file: the DOM and clock patterns
  are never applied to `src/core/**`, which the sim imports; and a dynamic
  `await import('../render/x')` is not matched by the `from`-anchored pattern.
- **R13 — the screenshot capture-intent net is dead and also wrong.** `tools/screenshot.mjs:466`.
  No entry in `SHOTS` sets `expect`, so neither branch has ever run; and the branch that would
  reads `state?.enemies`, while the bridge exposes `enemyCount` (`main.ts:1065`). Switching it on
  today would report "expected enemies on screen, found none" on every capture, including ones
  with eight enemies plainly visible. A safety net that fails closed on every input would have
  been abandoned within a day of being trusted.
- **R15 — the choice timeout is 20 seconds and five docs say 60.** `sim/progression.ts:382` sets
  `CHOICE_TIMEOUT_TICKS = 20 * 60` = 1200 ticks. **The constant is right** — 20 s is the value
  the M5 notes above describe, at "the full 20-second timeout" — and the docs are stale: its own
  comment at `:379` says "60 seconds", `bots.ts:283` says "3,600 ticks",
  `tests/bots.test.ts:13` says "a 60-second backstop", and `tools/playtest.ts:1876` prints "the
  sim's fallback timeout is 3600 and no policy may reach it". The last one is not just wrong
  prose: because the playtest guard compares against 3600, R1's 1201-tick stalls sit under the
  threshold and are never flagged. Fix by correcting the four docs and the guard, not the value.

### Content copy that disagrees with the code

- **R12 — three certification cards promise numbers the hulls do not have.**
  `content/certifications.ts:459`, `:301`, `:390`. Surety's card says `+1 damage`, but
  `hulls.ts:228-240` records removing exactly that on measured evidence and `HULLS.surety.stats`
  now holds only shield, speed and pickup. Arrears' says "150 scrap, 45 less effective health";
  the hull has `startingScrap: 320` and 140 → 110, so 30 less. Probate's says "132 effective
  health" where `hulls.ts:300` states it "lands at 124… rather than 132", and `64 + 60 = 124`.
  Each is a balance change that updated the hull and left the card selling the old one.
  `tests/certifications.test.ts:216` only asserts the string is non-empty.

### Recorded and rejected

- **R14 — `core/touch.ts` and `core/viewport.ts` are unwired.** True (grep-confirmed: only
  comment mentions, no importer) but **not a bug** — it is the deliberate M7 groundwork recorded
  under "Groundwork done early" below, and the review re-derived an intentional decision. The one
  part worth keeping: `render/layout.ts:60` computes its own landscape-only fit rather than
  calling `fitViewport`, so wiring M7 means reconciling two fit implementations, not adopting one.

### Below the cut — real, small, unscheduled

**Re-checked against the tree 2026-07-26 — most of this list has been closed since it was
written**, so it is marked rather than left to read as outstanding. What was here:

- ~~`main.ts:968` duplicated unreachable `if (choosing)` block~~ — gone.
- ~~`render/feel.ts:754` draws shells through `clampX`'s 30-unit *label* inset, pinning brass 19
  units off the ship at the playfield edges~~ — fixed, with a test block in `tests/feel.test.ts`.
- `render/scene.ts` draws the tracer head ahead of the bullet, contradicting the invariant above
  it — **not re-verified**; the line has moved and this needs a reader, not a grep.
- ~~`meta/save.ts:177` `{ ...DEFAULT_SAVE }` shallow-aliases the module defaults~~ — fixed;
  `defaultSave()` now returns a fresh save on every call and says why in its header.
- ~~`meta/save.ts:290` discards `sanitizePersonnelHistory`'s `skipped`/`dropped`~~ — fixed
  (`save.ts:305` records the history, and a partial load now reports itself).
- ~~`meta/seedModes.ts:441` collects rejections in parse order~~ — fixed; the published order is
  exported at `seedModes.ts:419` so a test can pin it.
- ~~`meta/keybinds.ts:107` `ownerOf` returns one owner where its own repair paths can create two~~
  — fixed; `ownersOf` (`keybinds.ts:104`) returns all of them and `ownerOf` is the convenience.
- ~~`content/bosses.ts:736+` five stale per-boss HP comments~~ — fixed; every comment now quotes
  the `hp` beside it (1700 / 3060 / 5760 / 7400 / 12210).

## Post-M5 pass, 2026-07-26 — what shipped

R1-R15 are all closed; `git log --oneline --grep='R7'` remains the authoritative status. On top of
them, in the same day:

- **Confirm left the fire key**, on the user's instruction, and took three mitigations with it: the
  48-tick held-trigger dwell, the 20-second `CHOICE_TIMEOUT_TICKS` backstop, and the "release fire
  to choose" footer line were all patches for one root cause nobody had removed. `InputSnapshot`
  gained a seventh bit — **the packed byte is now full**, so an eighth action needs a wider
  encoding. Cards no longer resolve themselves at all.
- **The shield recharges**, bounded by a per-sector reserve rather than by the clock. The
  measurement rewrote the design and is worth reading before touching the constants: there is no
  continuous rate that is both visible and balanced. See `docs/DESIGN.md` and the table in
  `src/sim/stats.ts`.
- **No route pays scrap** (median 3,940 unspent at death made a currency reward unpriceable), and
  the repair route pays 60% of maximum.
- Item offer cards state resolved before/after **for this ship**, and the authored sentence is
  dropped where the rows already say it — the same cut the hull cards took, arrived at from the
  opposite direction.
- The hazard warning now exists in the playfield, not only the panel.
- A save that loads partially now says so instead of presenting itself as a fresh game.

`SIM_VERSION` 3, `DIGEST_GENERATION` 6, `REPLAY_FORMAT_VERSION` 4, corpus re-recorded.

**What this pass produced, and where it went.** D1-D6 plus three more. **All nine are closed** —
D1-D6, the shield's suppression of integrity-triggered effects (re-measured; Repair Nanites is
x1.97, down from x2.59, and still the dominant variable by three times the shield's own ablation),
and the HUD's silence about the recovery reserve (now a row on the shield meter's own axis).

~~The ninth was a worst-sector death share reading 0.81 against a 0.35 criterion.~~ **That one was
not a finding at all.** Nothing had moved: 0.81 and 0.35 are two numbers the same criterion has
always produced simultaneously — one pooled over every probe policy, one from the competent policy
alone — and they were compared to each other across a doc and a JSON field without checking they
measured the same thing. The JSON now reports the competent policy so the two cannot disagree
again. Recorded as an error rather than deleted, because comparing two statistics that share a name
is a mistake worth being able to recognise a second time.

**Six findings replaced them**, none of them yet fixed: the reserve is spent in the first lull of a
sector and the HUD reads `SPENT` for the rest of it; `items` and `enemies` certification grants can
never be live while the base pool is derived from the whole table; the hull screen changes *how
many* decisions a run contains, which the cross-run persistence decision forbids; the packed input
byte is full, blocking a `cancel` action and the Writ hull; UI.md rule 6 cited a Playwright test
that does not exist; and the run has a real difficulty cliff at sector 3 that no criterion has ever
named.

## Re-measurement pass, 2026-07-26 (after the shield shipped)

Three figures were re-taken because the recharging shield landed underneath them. Every number
below is the `aggressor` policy, **n = 300 runs per cell on each of three base seeds** — A
`K7F29XQM3RTV`, B `Q3ZM8PXW5NRT`, C `WWQ4B8HT2NZP` (A and C are the pair the M5 exit numbers were
taken on; B is new, added because two seeds cannot show which of two disagreeing numbers is the
outlier). Pooled figures are over all 900 runs per arm. The shield ablation is the new
`--no-recovery` flag; the item ablation is `--give`.

### 1. Repair Nanites is weaker than recorded, and the shield is why

| Arm | seed A | seed B | seed C | pooled (n=900/arm) |
| --- | --- | --- | --- | --- |
| baseline | 35.7% | 27.3% | 32.0% | **31.7%** |
| `--give=repair-nanites` | 63.7% | 61.0% | 62.3% | **62.3%** |
| multiplier | ×1.79 | ×2.23 | ×1.95 | **×1.97** |
| baseline, `--no-recovery` | 22.3% | 19.0% | 22.7% | **21.3%** |
| nanites, `--no-recovery` | 58.0% | 52.3% | 55.3% | **55.2%** |
| multiplier, recovery off | ×2.60 | ×2.75 | ×2.44 | **×2.59** |

**The recorded 1.9–2.6× is stale, and the reason is exactly the predicted one.** Against the shipped
recharging shield the item multiplies the clear rate **1.8–2.2× (×1.97 pooled, +30.6pp)**. Switch
recovery off and the *same* ablation on the *same* seeds gives **×2.59** — the old figure's top end,
reproduced. The recharge did not weaken the item's numbers by accident; it removed roughly a quarter
of them, by giving `repairOnKill` fewer triggers.

Where the item shows up, unchanged in character: median entry health at sector 3 goes 44.8–46.5% →
60.7–63.3%, and at sector 5 55.7–59.1% → 73.1–80.0%.

**`retaliation-coil` is inert, with or without the shield.** ×1.04 / ×1.12 / ×1.05 by seed with
recovery on (pooled 31.7% → 33.8%, **+2.1pp against a 2.2pp standard error** — not distinguishable
from zero at 900 runs per arm), and ×1.04 / ×1.00 / ×1.00 with recovery off. Note what this does *not*
support: `docs/DESIGN.md`'s "as built" section says the recharge makes the coil "strictly worse". The
trigger count certainly falls — the corpus's effect-coverage check measured that directly — but the
coil's contribution to the clear rate was already inside noise before the shield, so **no clear-rate
measurement can show the coil getting worse, because there was nothing to lose.** The honest
statement is that the coil is worth nothing measurable either way.

**Verdict: integrity recovery is still the dominant variable, and it is not close.** Shield recovery
itself, ablated the same way, is worth **+13.3 / +8.3 / +9.3pp by seed (×1.60 / ×1.44 / ×1.41;
21.3% → 31.7% pooled, ×1.49)** against the item's **+30.6pp**. The shield is the second-largest
single lever measured and about a third of one relic. One item is still worth more than the recovery
mechanic handed free to every hull.

**Stale figures this produced**, for whoever owns those files (this pass owns `tools/playtest.ts`
and this document only):

- `src/content/items.ts:1138` — "it still multiplies the clear rate by 1.9-2.6x". Should read
  1.8–2.2× (×1.97 pooled over 900 runs per arm, three seeds, 2026-07-26), with the note that the
  2.4–2.8× band is what the item measures with shield recovery switched off.
- `src/content/items.ts:1117-1121` — the ablation block's figures (26.7% / 34.0% → 68.7% / 63.7%,
  entry health, sector-2 death share) all predate the shield. Replacements are in the table above.
- `docs/DESIGN.md:223-224` — "One recovery relic multiplies the clear rate by 1.9–2.6×", used as the
  benchmark the shield had to be tuned against.
- `docs/DESIGN.md`, "as built" — "measured at 1.9-2.6x ... It has not been re-measured and should be
  before the next balance pass." It has been now; and the "strictly worse" claim about the coil is
  not measurable in the clear rate, as above.

### 2. The worst-sector death share: nothing moved, the criterion has two readings

**The 0.79–0.81 is not a regression and never was.** `m5ExitCriteria.worstDeathShare` in the JSON was
computed over **every policy pooled**, while the printed verdict — and the 35.4% / 36.2% recorded in
the M5 table above — is read off the **competent policy alone**. Both numbers came out of the same
sweeps at the same time. Checked against the archived M5 sweep JSON that produced the recorded
figures:

| Sweep | aggressor worst share | pooled worst share |
| --- | --- | --- |
| M5 exit, seed A, n=200×5 policies | 0.354 | 0.762 |
| M5 exit, seed C, n=200×5 policies | 0.362 | 0.814 |
| Today, seed A, n=200×5 policies | 0.331 | 0.803 |
| Today, seed B, n=200×5 policies | 0.333 | 0.795 |
| Today, seed A, `--no-recovery` | 0.310 | 0.785 |

The pooled figure is dominated by the three probes that are *supposed* to die in sector one: on
today's seed-A sweep `random` died in sector 1 in 200 of 200 runs, `dodger` in 193, `greedy` in 155.
That is 548 of the 576 pooled sector-1 deaths. It is a fact about the instruments.

**Fixed in the harness**: `worstDeathShare` now reads off the competent policy, so the JSON and the
printed report can no longer disagree about the same criterion; the pooled figure is kept beside it
as `worstDeathSharePooled`, because it is still the right thing to look at when asking whether a
probe is behaving. **The criterion itself has not moved**: the competent-policy reading is
**33.1% / 30.3% / 30.4%** by seed today, so it is now *met* — but see below before treating that as
good news.

**And the criterion is measuring the clear rate twice.** A share has every sector in every other
sector's denominator, so it moves whenever the clear rate moves and says nothing about difficulty
shape. Compare the ablations, all read off aggressor at n=300: the baseline reads 0.337 and
`--no-recovery` reads 0.335, which is a criterion declaring two games of very different difficulty
(35.7% vs 22.3% clear) identically shaped; while `--give=repair-nanites` reads 0.266 purely because
the pilot lives long enough to spread its deaths over five sectors. **The criterion passes by getting
easier and fails by getting harder, in both cases without the distribution changing.**

**Proposed replacement — the cliff ratio**, implemented and reported by the harness under
`m5ExitCriteria.cliff`, deliberately *not* wired to a pass/fail verdict because swapping a criterion
is a balance decision and this was a measurement pass:

> **Conditional death rate on arrival** — `died / (died + cleared)` for each sector, censoring
> unfinished runs rather than counting them as survivals. Its denominator is per-sector, so it does
> not move when the clear rate moves. A **cliff** is then the worst sector's rate divided by the
> median of the others; sectors below 20 arrivals are excluded and named, because the late run is
> where the sample thins and that is the survivorship hole the old criterion's own COVERAGE note
> admits to. **Proposed threshold: ≤ 2.0×.**

Measured today, aggressor, n=300 per seed: **2.50× / 1.89× / 2.04×** (A / B / C), worst sector 3
Bloomfield on all three, which kills 28.4% / 30.8% / 32.0% of the pilots who resolve it against a
11.3% / 16.3% / 15.7% median elsewhere.

**Recomputed from the archived M5 exit sweeps, the same metric reads 2.30× (seed A) and 2.01× (seed
C) — worst sector 3 both times.** So the cliff has been in the same place, at the same size, across
the whole shield change, while the death-share criterion pointed at sector 2 on one seed and sector 1
on the other and called the difference noise. **The proposed metric is stable where the recorded one
was not, and it names a sector the recorded one has never named.** That is the argument for the swap,
and it is worth more than the threshold number.

The ablations behave the way a difficulty metric should, which the share does not: recovery off reads
1.89× / 1.64× / 1.88× (the same shape, harder throughout) and nanites reads 1.72× / 1.71× / 1.59×
(genuinely flatter).

### 3. What the harness measures by default: the base pool, now said out loud

`tools/playtest.ts` omitted `workOrders` while its own comment claimed to mirror `src/main.ts`
exactly (D5). The omission is now **deliberate, documented, and the default**: `docs/DESIGN.md`'s
cross-run-persistence decision makes `poolFor(new Set())` the definition of the comparable game, so
the base pool is the right reference band and every recorded M5 number is a base-pool number. The
comment now says so instead of claiming a mirror it does not do, every sweep prints its band, and
`--pool=certified` sweeps the other one.

**Both bands measured, and they are the same game — bit-for-bit.** Aggressor, n=300 per seed:
35.7% / 27.3% / 32.0% base against 35.7% / 27.3% / 32.0% certified, identical to the run, and a
25-run `--detail` comparison finds **25 of 25 identical state digests and identical tick counts**.

That is not a coincidence and it is not reassurance about the decision's safety argument. Only the
`workOrders` slice reaches the simulation at all, the sim applies no work-order outcome, and the card
carries no offers — so the widest possible certification pool changes the number of options on one
card per run and nothing else. **The certified band is unmeasurable rather than measured-equal**, and
it will stay that way until D6 lands (the `items` and `enemies` slices are not pool-gated, so six of
ten certifications grant nothing the sim can see). The flag is in place for the day that changes.

## M6 — Polish and balance

- Fix the 2026-07-26 review findings above, and the vacuous guards that hid them. R1 and R11
  come first: every balance pass below is measured with the instruments they break.
- ~~**Re-measure Repair Nanites and the worst-sector death share before any other balance work.**~~
  **Done 2026-07-26** — see "Re-measurement pass" above. Repair Nanites is ×1.97 pooled (was
  recorded as 1.9–2.6×) and is still the dominant variable, worth about three times the shield's
  own contribution. The death share did not move at all; the criterion had two readings. What is
  left over from that pass and belongs to a balance milestone: **sector 3 Bloomfield is a real
  difficulty cliff at 2.0–2.5× the surrounding conditional death rate**, and the death-share
  criterion cannot see it — adopt the cliff ratio before tuning against the old number.
- **Show the shield recovery reserve on the HUD.** It is simulation state that decides whether
  disengaging will work, and no screen draws it — so the mechanic's central decision is invisible.
- Land **D1–D6** from "Proposed, unscheduled" below — the code the cross-run persistence decision
  (`docs/DESIGN.md`, 2026-07-26) found already breaking it. D1–D3 before the balance passes: the
  certified pool is an unrecorded simulation input, so the daily contract and every `purist` label
  are currently wrong.
- Balance passes driven by bot sweeps
- Accessibility: shake/flash reduction, colourblind-safe verification, remappable keys, pause
- Settings screen
- Performance pass; WebGL renderer backend decision point
- Onboarding for the first-time player without a tutorial wall

**Exit:** accessibility checklist complete; all budgets green; a first-run screenshot sequence
that explains itself.

## Proposed, unscheduled

See **Proposals not yet decided** in `docs/DESIGN.md` for the reasoning. Summary:

- ~~**World map + between-sector shops**~~ — **built in M5**, as folded in. See above.
- **Experience / levels** — a real addition, but only if its rhythm is distinct from
  items (high frequency, low deliberation). Otherwise it is a second power curve doing
  the same job. **Constrained by the decision below**: a level may not outlive the run,
  and an unlockable level cap is a number and therefore banned.
- ~~**Cross-run persistence of items and levels**~~ — **DECIDED 2026-07-26.** See
  "Cross-run persistence changes the deck, never the numbers" in `docs/DESIGN.md`.
  Cross-run persistence may change **which content ids a run can draw from** and
  nothing else; no persisted value may change what a resolved number evaluates to.
  Certifications remain the entire mechanism. The roguelite reading is refused
  permanently, which costs the 26–36% clear rate its standard cure.

  **The decision is not free, because the code already breaks it in six places.** Found
  by grep at the M5 exit point, none caught by the suite, numbered D1–D6 so commits can
  cite them. Line numbers are from 2026-07-26 and the tree is moving; the symbols are
  the durable part. **These are M6 items and D1–D3 come before the balance passes**, for
  the same reason R1 and R11 did: they are correctness, and two of them are load-bearing
  for features that already shipped as headline claims.

  - **D1 — the certified pool reaches the sim and is not in the replay.** `main.ts:614`
    passes `workOrders: runPool.workOrders` into `new World(...)`;
    `sim/world.ts:885` reads it; `meta/snapshot.ts:468-469` hashes its length and every
    kind string. So a replay recorded by a pilot holding `vault-clearance` is played back
    against the *viewer's* pool — `beginSortie` honours `claimed.replay.hullId`
    (`main.ts:584`) but `launchSortie` always passes `runPool.workOrders`. Format version
    and `SIM_VERSION` both match, so it decodes perfectly and diverges silently, which is
    the exact failure the version byte exists to prevent, arriving through a field the
    format does not have. Fix: record the granting id set (a bitmask over
    `CERTIFICATION_IDS` is one byte today) in the replay header, bump
    `REPLAY_FORMAT_VERSION` 3 → 4 — **not** `SIM_VERSION` — and make `playback` throw on
    a pool-fingerprint mismatch, the guard `hullId` got after M5. The corpus needs no
    re-base: every fixture was recorded with `workOrders` omitted, so it is already a
    base-pool run.
  - **D2 — a daily contract is not flown purist.** `meta/seedModes.ts:611` sets
    `purist: true` and its comment states the reason correctly, and nothing narrows the
    pool: `runPool = poolFor(unlockedSet(save.certifications.unlocked))` unconditionally
    at `main.ts:452` and `:567`, and `purist` appears nowhere in the launch path. So two
    players on the same contract today can get different hull offers (`main.ts:571`), a
    different work-order card, and a different state digest. The one feature the daily
    exists for does not work.
  - **D3 — a `?purist=1` shared run is not purist either.** Same cause; the share card
    labels it `SHARED · PURIST` (`meta/seedModes.ts:621`). The filed fingerprint is honest
    (`main.ts:526`), so `verifyPurist` will correctly read `expanded` — the record is right
    and the label is wrong, which is the better failure direction but still a UI rule 4
    violation, and therefore priority 1.
  - **D4 — `POOL_SLICES_HONOURED` is stale, so four certification cards understate
    themselves.** `tests/certifications.test.ts:309` lists only `workOrders` and its
    docstring says no hull selection screen exists. It does: `offerHulls`
    (`main.ts:571`), `shouldShowHullSelect`, `screen = 'hull-select'` (`:593`), and a
    launch on the selected hull. So `hulls` is an honoured slice, and the four
    hull-granting cards still say `awaiting: 'a hull selection screen'`
    (`content/certifications.ts:304`, `:364`, `:393`, `:462`) — the hangar telling a pilot
    an earned hull cannot be flown when it can. Same family as R12. One change: move
    `hulls` into the honoured list, rewrite the four `awaiting` strings, fix the
    docstring.
  - ~~**D5 — the certified game has never been measured.**~~ **Closed 2026-07-26**, with the
    caveat that the answer is smaller than the question. The harness no longer claims a
    mirror it does not do: the base pool is the documented default, every sweep prints its
    band, and `--pool=certified` sweeps the other. Measured at n=300 × 3 seeds the two bands
    are identical to the run and bit-identical in the state digest — because `workOrders` is
    the only slice that reaches the sim and the card has no outcome. So the decision's safety
    argument is **still** an argument: the certified band is currently unmeasurable, not
    measured-equal, and becomes measurable when D6 gates the `items` and `enemies` slices.
  - **D6 — six of ten certifications still grant nothing.** `items`, `enemies`,
    `bossVariants` and `hazards` are never drawn from the pool: the app hands the sim the
    whole `ITEMS`/`SECTORS`/`BOSSES`/`HAZARDS` tables, and `pickVariant` reads
    `BossDef.variants` (`sim/world.ts:1404`). Seven granted ids resolve to nothing in any
    table (`drone-uplink`, `mirror-mount`, `ranging-computer`, `precision-sights`,
    `tally-turret`, `tally-escort`, `turret-siege`). Not a violation of the rule — the
    rule under-applied — and the cards say so honestly, so this is scheduling rather than
    a lie. Note that gating any of these slices moves every existing player's pool
    fingerprint, so it is a versioned change and not a content change.

## M7 — Mobile

Deliberately after the desktop feel is settled, so touch follows the game rather than shaping it.
The design decisions are already made in `docs/DESIGN.md` — read that section before starting, in
particular the frozen playfield-aspect constraint.

- Relative-drag touch controls (ship moves by drag delta so a thumb never covers it)
- Auto-fire always on; focus as a second thumb zone
- Responsive panel placement: right column in landscape, bottom bar in portrait. The playfield's
  448×720 aspect and virtual units DO NOT change — that is what keeps seeds, daily contracts, and
  replays comparable across devices.
- Decouple `src/render/panel.ts` from `PLAYFIELD_W`
- Replace keyboard-assuming UI text
- `overscroll-behavior: none`, safe-area insets, WebAudio unlock on first gesture (iOS will not
  play audio initialised at load)
- Performance pass: additive glow at 3× DPR on a mid-range phone is the risk

**Exit:** a real run completes on a phone in portrait at 60fps within the frame-time budget; a
replay recorded on mobile reproduces bit-exactly on desktop; the frozen-aspect constraint is
asserted by a test.

### Groundwork done early (during M5)

`src/core/touch.ts`, `src/core/viewport.ts` and `docs/MOBILE.md` exist, tested and **deliberately
not wired in**. Read MOBILE.md before starting M7; three findings change the plan above:

- **"Auto-fire always on" is wrong as written, and would have shipped a bug.** A trigger that
  never releases interacts with `HELD_CONFIRM_DWELL_TICKS` — the keyboard soft-freeze rescue — in
  two ways, both bad: an untouched card auto-confirms option 0 after 0.8s *every time*, making
  mobile pick rates a constant; and a card the player *does* touch can never be confirmed at all,
  because a rising fire edge requires a fall that never comes. Auto-fire must be **contextual**:
  on in the sortie, off on a card. Solved in the touch layer with no change to the simulation.
- **`index.html` needs `touch-action: none`**, not `manipulation`. The current value permits
  pinch, so Safari eats the two-finger focus gesture.
- **The portrait bar has 39% of the landscape column's area.** Decoupling `panel.ts` from
  `PLAYFIELD_W` is necessary but nowhere near sufficient — portrait needs a different
  *composition*, and UI rule 7's 11px floor rules out shrinking text to fit. This is the largest
  remaining piece.

---

## Not scheduled

Multiplayer, accounts, Steam packaging. See the non-goals in `docs/DESIGN.md`.
