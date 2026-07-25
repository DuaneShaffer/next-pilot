# Verification

## The problem this solves

There is no human playtester in this project's loop. Duane sets a goal and steps away; the game's
quality has to be assessed by whoever is building it. That makes "I think this feels good" not a
verification step, and it makes any quality signal that isn't automated effectively nonexistent.

So the harness is a first-class part of the product. Four instruments, each answering a question
that intuition can't.

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

- **Dodger** — prioritises survival, minimal aggression. Establishes a survivability floor.
- **Aggressor** — maximises damage output, accepts risk. Establishes a clear-speed ceiling.
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
