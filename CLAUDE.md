# Next Pilot — working agreement

A seeded, permadeath vertical shooter roguelike that runs in a browser and deploys to GitHub
Pages. Read this before touching code. It is short on purpose.

## What this project is optimising for, in order

1. **Interface clarity.** This is the differentiator, not a nicety. See `docs/UI.md`.
2. **Game feel.** Tight controls, legible patterns, satisfying impact.
3. Everything else — content volume, feature count, visual richness.

When two of these conflict, the lower number wins. A confusing HUD is a P0 bug, the same
severity as a crash.

## The three contracts you must not break

These exist because there is no human playtester in the loop. They are what make the game
verifiable at all — see `docs/VERIFICATION.md`.

1. **Determinism.** The same seed plus the same inputs must always produce the same run.
   - `Math.random()` is banned in `src/sim/**` and anything it imports. Use `Rng` from a named
     stream off the run seed.
   - The sim advances in whole fixed ticks. No `deltaTime`-scaled movement, ever.
   - New randomness gets its own named stream. Reusing an existing stream for a new purpose
     shifts every downstream roll and invalidates recorded replays.
2. **Sim/render separation.** `src/sim/**` must not import from `src/render/**`, `src/ui/**`,
   the DOM, or any timing API. The sim runs headless in Node. If the sim needs a constant that
   rendering also needs, it belongs in `src/core/space.ts`.
3. **The sim only sees `InputSnapshot`.** It never reads the keyboard. This is what makes a
   replay a seed plus a byte per tick.

## Definition of done for any change

Never report work as complete without these:

- `npm run check` passes (typecheck + tests).
- New behaviour has a test. Balance changes are justified with numbers from a bot playtest run,
  not intuition.
- Anything that changes what the game looks like has a screenshot you have actually looked at.
  "It should render fine" is not verification.
- The save schema still loads saves written by the previous version. Adding a field means a new
  numbered interface, a migration step, and a hand-written fixture test — never mutating a shipped
  type. See `src/meta/save.ts`.

## Layout

```
src/core/    Engine primitives. rng, loop, input, seed, space. No game content.
src/sim/     Simulation. Headless, deterministic, no rendering imports.
             entities.ts is the CONTRACT: entity shapes plus WorldView, the
             read-only view that render and bots consume. Change it deliberately.
src/content/ Data-driven definitions: hulls, weapons, items, enemies, sectors.
             types.ts documents what each movement/weapon kind means; the sim
             interprets them so adding content never means editing the sim.
src/render/  Canvas2D drawing. Consumes WorldView, never the World class.
src/ui/      Screens and menus.
src/audio/   WebAudio synthesis, driven by SimEvents from the app layer. Never
             imported by sim (contract 2). No audio files — everything synthesised.
src/meta/    Save, settings, unlocks, replays, state hashing. Crosses runs.
             save.ts owns schema migration; read its header before adding a field.
tests/       Vitest. Sim tests run headless; determinism tests are load-bearing.
             tests/replays/ is the regression corpus — recorded runs that must
             reproduce bit-exactly forever.
tools/       Verification harness: bot playtests (tsx), screenshot capture.
docs/        Specs. DESIGN, UI, ARCHITECTURE, VERIFICATION, ROADMAP.
```

**The dependency arrow is one-way:** `core ← sim ← render/ui`. Content is data consumed by sim.
Anything that observes a run reads `WorldView`; nothing outside `src/sim/**` may hold a `World`.

## Conventions

- TypeScript strict, including `noUncheckedIndexedAccess`. Index access returns `T | undefined`;
  handle it rather than casting reflexively.
- No runtime dependencies. Dev dependencies only. If something seems to need a library, ask
  whether it needs 40 lines instead.
- No binary assets. Art is code-defined geometry, audio is synthesised at runtime. A `.png` in
  this repo is a design failure unless explicitly agreed.
- Comments explain *why*, and are reserved for decisions a reader would otherwise have to
  reverse-engineer. Don't narrate what the code says.
- Content lives in `src/content/**` as data. Adding an enemy should not mean editing the sim.

## Deploy

`main` auto-deploys to https://duaneshaffer.github.io/next-pilot/ via
`.github/workflows/pages.yml`. `vite.config.ts` sets `base` to `/next-pilot/` only under
GitHub Actions, so local dev stays at `/`. Renaming the repo means updating that base path.

## Working style

Duane sets a goal and steps away for long stretches, checking in occasionally. Work in small
verified commits to `main`. When a decision needs making and either choice is defensible, pick
the one that serves priority 1, write down why in the relevant doc, and keep moving — don't
block waiting for an answer. Flag genuine ambiguity in the commit message and carry on.
