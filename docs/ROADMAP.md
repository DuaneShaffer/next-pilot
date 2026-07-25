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
- [x] Muzzle flash and tracer variation. **Shell ejection deliberately not done** — skipped to
      protect the frame budget; see the note below rather than assuming it shipped.
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

**Balance fixes, measured over 200 runs per policy:**

| policy | M1 median | M2 median | change |
| --- | --- | --- | --- |
| greedy | 123.7s (p10 123.0 — a wall) | 156.7s (p10 143.6, p90 171.7) | **wall replaced by a 28s spread** |
| random | 103.5s, wave 18/30 | 95.7s, wave 16/30 | less deep on noise |
| aggressor | 41.2% clear | 56.5% clear | overshot the 35-50% target |
| dodger | 141.2s | 120.2s | worse |

The two stated defects are fixed: greedy no longer dies at a deterministic wall, and the upper
playfield is usable again. But the fix overshot — aggressor now clears 56.5% against a 35-50%
target, and dodger lost 21 seconds. **Tightening that is the first balance job of M6**, and it needs
its own before/after sweep rather than being folded into a feel change.

**Carried forward, honestly:**

- **Shell ejection** is not implemented. The 12× frame headroom means it is clearly affordable, so
  this is now a scope decision rather than a performance one: implement it, or delete this line.
  It should not keep sitting here looking done.
- **`Settings.reduceFlashes` exists in the save schema but is not offered in the pause menu**,
  because the renderer does not consume it. A control that silently does nothing is worse than a
  missing one: it tells a photosensitive player they are protected when they are not. Add the row
  in the same change that makes the renderer honour it.
- **Nobody has heard the audio.** See the blind spot in `docs/VERIFICATION.md`. The fix is an
  `OfflineAudioContext` render in headless Chromium producing both measurements and WAVs; it needs
  a context shim because the backend constructs its own.

## M3 — The roguelike loop

- Item system with an effect bus, so items compose instead of special-casing each other
- ~12 items with at least 4 genuine interactions, all with explicit tags
- Item-choice screen: three options, full mechanical text, synergy markers, current build visible
- Scrap economy and a shop
- Work-order route choice between sectors
- Death → next sortie in two inputs (UI rule 6)

**Exit:** bot sweeps show no single item above a 70% pick rate and none below 10%; a
Playwright test confirms death-to-next-sortie in ≤2 keypresses; every item's mechanical text names
its numbers.

## M4 — Progression, seeds, replays

- Versioned save with migrations and a migration test from a v1 fixture
- Certifications that expand the pool; hangar screen listing unlock conditions explicitly
- Personnel files: browsable history of dead pilots
- Daily contract, seed entry, shareable seed URLs
- Replay recording, playback, and URL encoding
- Purist mode

**Exit:** a v1 save loads in the current build; a replay URL round-trips and reproduces a run
exactly; the daily seed is identical across two machines' clocks.

**← The vertical slice ends here. Everything above should be genuinely good before M5 begins.**

## M5 — Content

- All 5 sectors with distinct enemy grammars
- Boss per sector with seeded variants
- All 8 hulls
- ~40 items with a documented interaction graph
- Elites, hazards, vaults, curses

**Exit:** bot sweeps show a 20–40% clear rate for a competent policy and every hull within 15
percentage points of the mean; no sector is a difficulty cliff (death distribution has no single
spike above 35%).

## M6 — Polish and balance

- Balance passes driven by bot sweeps
- Accessibility: shake/flash reduction, colourblind-safe verification, remappable keys, pause
- Settings screen
- Performance pass; WebGL renderer backend decision point
- Onboarding for the first-time player without a tutorial wall

**Exit:** accessibility checklist complete; all budgets green; a first-run screenshot sequence
that explains itself.

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

---

## Not scheduled

Multiplayer, accounts, Steam packaging. See the non-goals in `docs/DESIGN.md`.
