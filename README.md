# Next Pilot

**The company does not mourn you. It calls the next pilot.**

A seeded, permadeath vertical shooter roguelike that runs in a browser. You are contract labour for
the Salvage Division: fly a company hull down a corridor of wrecked space, recover what's worth
money, and stack upgrades into combinations that break the game. When the hull is destroyed the run
ends permanently, the incident is filed, and someone else is issued your equipment.

▶ **[Play it](https://duaneshaffer.github.io/next-pilot/)**

> **Status: early development (M1).** Playable: seeded runs, seven enemy types, five movement and
> five weapon patterns, shields, permadeath, and a filed incident report when you die. Sector 1 is
> ~3 minutes of escalating waves. No items or meta-progression yet — see
> [docs/ROADMAP.md](docs/ROADMAP.md).

## Controls

| Action | Keys                    |
| ------ | ----------------------- |
| Move   | `WASD` or arrow keys    |
| Fire   | `Space`, `Z`, or `J`    |
| Focus  | `Ctrl` or `C` (slower, precise movement) |
| Special| `X`, `K`, or `Shift`    |
| Confirm| `Enter`                 |

## Running it locally

```bash
npm install
npm run dev        # http://localhost:5173
```

| Script              | Does                                          |
| ------------------- | --------------------------------------------- |
| `npm run dev`       | Dev server with hot reload                    |
| `npm run build`     | Typecheck, then production build to `dist/`   |
| `npm run preview`   | Serve the production build                    |
| `npm run typecheck` | TypeScript, no emit                           |
| `npm test`          | Vitest run                                    |
| `npm run check`     | Contracts + typecheck + tests. The gate before committing. |
| `npm run contracts` | Statically enforces the three architectural contracts |
| `npm run playtest`  | Headless bot sweep — the balance oracle |
| `npm run screenshot`| Build, then capture every screen for visual review |

Append `?seed=K7F2-9XQM-3RTV` to replay an exact run, or `?screen=sortie` to skip the title screen.
`?autopilot=dodger|aggressor|greedy|random` lets a bot fly it, and `?ff=N` fast-forwards the
simulation. All four exist for the verification harness and are just as usable by hand.

## How it's built

Vanilla TypeScript, Canvas2D, Vite. **No runtime dependencies**, no binary assets — ships are
code-defined geometry and audio is synthesised at runtime. The production bundle is about 49KB (17KB gzipped).

The design is built around one constraint: **the simulation is deterministic.** Same seed plus
same inputs always produces the same run. It advances in fixed 60Hz ticks, draws all randomness
from independent named streams, and never touches the DOM — so it runs headless in Node. That
gives shareable seeds, daily contracts, and replays that are a seed plus one byte per tick.

It also gives the project its quality oracle: thousands of full runs can be simulated in seconds
to balance the game with measurements instead of guesses. See
[docs/VERIFICATION.md](docs/VERIFICATION.md).

## Documentation

| Doc                                              | Contents                                        |
| ------------------------------------------------ | ----------------------------------------------- |
| [DESIGN.md](docs/DESIGN.md)                      | Premise, hulls, sectors, items, progression     |
| [UI.md](docs/UI.md)                              | Interface rules — the project's differentiator  |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md)          | Stack, determinism contract, module boundaries  |
| [VERIFICATION.md](docs/VERIFICATION.md)          | How quality is measured without a playtester    |
| [ROADMAP.md](docs/ROADMAP.md)                    | Milestones and their exit criteria              |
| [CLAUDE.md](CLAUDE.md)                           | Working agreement and contracts                 |

## License

MIT — see [LICENSE](LICENSE).
