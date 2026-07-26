# Architecture

## Stack

Vanilla TypeScript, Canvas2D, Vite. **No runtime dependencies.**

The choice is driven by one requirement: seeded runs and replays need bit-exact determinism, and
a framework that owns the update loop or carries its own internal randomness fights that. Writing
the engine costs more code but buys a simulation that runs headless in Node — which is the entire
basis of how this project verifies itself without a human playtester.

Canvas2D over WebGL for now. It handles low thousands of sprites at 60fps when you avoid its two
real costs: per-object path construction and per-object state changes. So sprites are pre-rendered
once to offscreen canvases and blitted, glow comes from pre-baked soft sprites composited with
`'lighter'`, and `shadowBlur` is never used per-frame. Rendering sits behind a boundary so a WebGL
backend can be added later as a contained visual upgrade rather than a rewrite.

## The determinism contract

The load-bearing constraint. Three rules:

**1. Fixed timestep.** The sim advances in whole ticks of exactly `TICK_MS` (60Hz). Rendering
happens at display rate and interpolates between the last two ticks using `alpha`. No sim value is
ever scaled by a variable delta — that would make outcomes depend on framerate, and no replay or
shared seed would match.

**2. All randomness from named streams.** `Math.random()` is banned in the sim. Every random
decision draws from `Rng.fromSeed(seed, streamName)`. Streams are independent by construction, so
adding a cosmetic particle effect cannot shift which items drop. `tests/rng.test.ts` asserts this
directly — draining a cosmetic stream 10,000 times leaves the loot stream untouched.

**The honest limit on "bit-identical everywhere":** `Rng` itself is exact anywhere, because it uses
only integer operations. But `Math.sin`, `Math.cos`, and `Math.atan2` are *implementation-defined*
in ECMAScript, and the sim uses them for sine movement and spread-fire angles. So replays are
bit-exact on the same JavaScript engine — which is the actual use case, including CI and the
regression corpus — but cross-*engine* exactness is reasoned, not guaranteed. Enemy aiming
normalises with `sqrt` rather than `atan2` partly to reduce the exposure. If literal cross-engine
determinism is ever needed (verified leaderboards across browsers, say), the fix is a fixed-point
trig lookup table, not more testing.

Existing streams, and what each one is for:

| Stream | Draws |
| --- | --- |
| `spawn` | Formation positions and jitter |
| `loot` | Item drops |
| `offers` | Which items a choice screen shows, and shop stock |
| `items` | Item effect rolls (a chance-based repair, say) |
| `route` | Which approaches the world map offers between sectors |
| `hazard` | Where a hazard's debris falls |
| `boss` | Which seeded variant of a boss a run faces |
| `cosmetic:starfield` | Parallax stars |
| `bot:random`, `test:inputs` | Verification harness only; never in a real run |

A new random concern gets a new stream; reusing one for a second purpose shifts every downstream
roll and breaks recorded replays. The rule earns its keep constantly — `route` and `hazard` are
separate for exactly this reason, and sharing them would have made a hazard's debris pattern
depend on how many route cards had been shown.

**3. The sim never touches the outside world.** `src/sim/**` imports nothing from `src/render/**`,
`src/ui/**`, the DOM, or any timing API. It receives an `InputSnapshot` per tick and nothing else.
Shared constants like playfield bounds live in `src/core/space.ts` precisely so the sim doesn't
have to import rendering code to know where the walls are.

The payoff: a run is fully described by a seed plus one byte per tick. Twenty minutes of play is
about 72KB uncompressed, a few KB compressed — small enough for a URL. That gives replays, ghost
runs, verifiable daily scores with no backend, and a regression corpus.

## Module boundaries

```
core/     rng, loop, input, seed, space. Engine primitives, no game content.
sim/      Simulation. Headless. Imports only from core/.
content/  Data definitions: hulls, weapons, items, enemies, sectors. Imported by sim.
render/   Canvas2D. Reads sim state, never writes it.
ui/       Screens, menus, overlays.
meta/     Save, unlocks, replay encoding. Spans runs.
```

Dependency direction is strictly `core ← sim ← render/ui`. Content is data consumed by sim.

## Entity representation

Deliberately not an ECS. At our scale — a handful of ships, dozens of enemies, low thousands of
projectiles — plain objects in arrays with backwards-iterating swap-remove are faster to write,
read, and run than a generic component system. Projectiles may move to typed arrays if profiling
demands it; that's a contained change behind the same interface.

Every renderable entity stores `prevX/prevY` so rendering interpolates rather than snapping.

## Collision

Circles and AABBs. No physics library: nothing here needs a rigid-body solver, and one would add
nondeterminism risk for no benefit. Naive pair checks are fine at this scale (a few hundred
thousand cheap checks per frame is not a bottleneck); a uniform spatial hash is the drop-in if
projectile counts grow.

## Rendering pipeline

1. Playfield background and parallax starfield.
2. Enemy projectiles — drawn *above* enemies so incoming fire is never occluded by the thing that
   fired it.
3. Enemies, player projectiles, then the player hull last, so the player is never hidden.
4. Additive glow pass (`'lighter'`).
5. Vignette.
6. Instrument panel, drawn to its own column.

Draw order is a legibility decision, not an aesthetic one. Under a screen full of bullets, the
player must always be able to find their own ship and the things that can kill it.

## Save format

`localStorage`, key `next-pilot/save/v{n}`, JSON with an explicit `version` field. Loading is
defensive: an unrecognised or malformed save falls back to defaults rather than throwing, and
private-browsing storage failures are caught so the game still runs without persistence.

**Migrations are mandatory.** A save written by version N must load in N+1. Nothing sours a
roguelike faster than an update erasing progress.

## Performance budget

- Sim tick: < 2ms at p99 with 2,000 live projectiles.
- Frame: < 8ms at p99, leaving headroom inside the 16.6ms budget.
- `droppedTicks` must be 0.
- Bundle: **< 110KB transferred** (gzipped). Currently ~78KB. A 400KB uncompressed cap
  exists only as a runaway backstop.

**What 2,000 projectiles actually is:** a headroom target for content that does not exist yet, not a
description of the game. The projectile caps total 1,792, so 2,000 is *unreachable through play*, and
the observed peak across full runs is **54**. The figure is kept deliberately — it is the margin
being defended for M3's items and M5's later sectors — but `tests/perf.test.ts` constructs it by
stuffing the entity arrays directly and pins the discrepancy, because a budget nobody can reach is
worth nothing if the test quietly measures an empty playfield instead.

**`?ff=N` cannot be used to measure either budget.** `main.ts` runs N simulation steps inside a
single `hooks.tick()`, so at `ff=12` every sample is twelve steps' worth of work and dividing its p99
by twelve is not a p99. `tools/perf.mjs` prints timings at `ff≠1` but *refuses the verdicts*; reaching
dense play honestly means `--seconds=180`. This is the same shape of mistake as reading dropped ticks
around a screenshot.

**On the bundle budget**, which has now been changed twice for two entirely different
reasons — worth separating, because one of them is the kind of move that is usually an
excuse:

*At M4, the metric was wrong.* It was `du -sb dist` against 150KB, set at M0 when the
bundle was 15KB, and it failed on 169KB of disk. Disk size was never the constraint —
GitHub Pages serves gzip, and what matters for a game someone clicks a link to is what
they actually download, which was ~50KB. Raising the old number would have been moving
a goalpost; changing the metric fixed a measurement that was wrong from the start.

*At M5, the number was wrong.* 75KB was sized against one sector and 14 items. The
milestone shipped five sectors, 40 items, 28 interactions, five bosses with seeded
variants, five hulls, hazards, a world map, and the rendering for all of it — and came
out at 78KB. Roughly 11KB of transfer for roughly 4x the game, which is what "no binary
assets, all geometry code-defined, all audio synthesised" buys. The budget did not fail;
what it was sized against stopped existing. 110KB is ~40% headroom, enough to carry M6
and M7 without moving again.

The honest risk in writing that paragraph is that it is also exactly what someone dodging
their own budget would write. The guard against it: a budget only ever raised is a
comment, not a budget, so the CI note commits the next move to being a code-split rather
than a bigger number. The uncompressed cap survives unchanged as a backstop for something
that compresses well and still bloats parse time, like an accidentally inlined asset.

One thing genuinely does ship that arguably should not: `src/sim/bots.ts`, the autopilot,
reachable in production via `?autopilot=`. It stays because the screenshot oracle drives
the *built* app through it, and weakening the only instrument that reads the UI to save a
few KB is a bad trade at this size. If the budget ever binds, this is the first thing to
split out — along with a dev-only build for the harness.

**Where each is enforced, and why it matters:**

| Check | Enforced by | Runs on CI |
| --- | --- | --- |
| Bundle size (gzipped transfer) | `ci.yml` | yes |
| `droppedTicks == 0` | `tests/perf.test.ts` | yes |
| Scenario integrity (really 2,000 projectiles) | `tests/perf.test.ts` | yes |
| Absolute tick p50/p99 | `tests/perf.test.ts` | **no — local only** |
| Absolute frame p50/p99 | `npm run perf` (real browser) | no |

Absolute wall-clock timing is deliberately **not** asserted on CI. A shared,
virtualised runner cannot produce a stable absolute figure, and the p99 especially is dominated by a
single descheduling event — the same scenario measured 0.31ms p50 locally and 2.93ms p99 on CI with
no code change between them. A test that fails for reasons unrelated to the change gets deleted or
rubber-stamped, and either way the budget stops being enforced.

So CI keeps the machine-independent checks, which are the ones that would silently void the whole
file if they broke, and the absolute numbers are measured where they mean something: `npm run perf`
against a real browser, reporting sliding-window percentiles. Latest run: **frame p99 0.66ms, tick
p99 0.07ms, 0 dropped** — roughly 12× headroom on the frame budget.

The honest limit: that browser run reached 64s of sector time, so the densest moments (the elite at
134s, the clear-out at 164-174s) are unmeasured, and real play peaks near 54 live projectiles rather
than 2,000 — the 2,000 case is constructed directly in the test because no browser pass can reach it.

## Why not the alternatives

- **Phaser** — owns the update loop; its physics and particle randomness make bit-exact replays
  impractical. ~1MB.
- **PixiJS** — a fine renderer that would preserve the sim design, but ~400KB and a scene graph to
  keep in sync with sim entities. Reconsider if we want bloom and 10,000 bullets.
- **Unity / Godot web export** — multi-megabyte downloads and a loading bar, for a game whose
  whole distribution model is clicking a link.
- **React** — retained-mode reconciliation against a 60fps canvas is pure overhead. Plain DOM for
  out-of-game screens if ever needed.
- **An ECS library** — solves a problem we don't have at this entity count.
