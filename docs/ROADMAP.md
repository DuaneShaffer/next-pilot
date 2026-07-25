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

- Hitstop on impact, scaled by damage
- Screen shake with a hard cap and a settings toggle (UI rule 10)
- Impact flashes, hit sparks, and layered explosions
- Muzzle flash, shell ejection, tracer variation
- WebAudio synthesis: weapon, impact, explosion, shield break, pickup, UI
- Damage numbers and pickup labels near the ship (UI rule 9)
- Enemy telegraphs — every attack readable before it lands

**Exit:** a feel checklist reviewed against captured screenshots and frame-by-frame captures;
frame time under 8ms p99 with 2,000 projectiles; no strobing above 1Hz anywhere.

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
