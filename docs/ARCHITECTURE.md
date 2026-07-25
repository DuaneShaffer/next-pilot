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

Existing streams: `spawn`, `loot`, `cosmetic:starfield`. A new random concern gets a new stream;
reusing one for a second purpose shifts every downstream roll and breaks recorded replays.

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

Asserted in tests, not hoped for:

- Sim tick: < 2ms at p99 with 2,000 live projectiles.
- Frame: < 8ms at p99, leaving headroom inside the 16.6ms budget.
- `droppedTicks` must be 0 in any perf test.
- Bundle: < 150KB uncompressed. Currently ~15KB.

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
