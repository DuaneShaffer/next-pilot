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

## M1 — Combat core

The point at which it becomes a game: things shoot back and you can lose.

- Enemy entities with data-driven definitions in `src/content/enemies.ts`
- Wave spawner drawing from the `spawn` stream, deterministic per seed
- Collision (circle/AABB), damage, shields, integrity, invulnerability frames
- Enemy projectile patterns: aimed, spread, ring, and a slow tracker
- Death, run-end, and an incident report screen
- Sector 1 (Debris Shelf) fully populated, ~3 minutes of escalating waves

**Exit:** a bot can play a complete run and die; a recorded replay of that run reproduces
bit-exactly; damage and death have tests; the first replay fixtures land in `tests/replays/`.

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

---

## Not scheduled

Mobile/touch controls, multiplayer, accounts, Steam packaging. See the non-goals in
`docs/DESIGN.md`.
