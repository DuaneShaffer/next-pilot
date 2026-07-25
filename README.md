# Next Pilot

**The company does not mourn you. It calls the next pilot.**

A seeded, permadeath vertical shooter roguelike that runs in a browser. You are contract labour for
the Salvage Division: fly a company hull down a corridor of wrecked space, recover what's worth
money, and stack upgrades into combinations that break the game. When the hull is destroyed the run
ends permanently, the incident is filed, and someone else is issued your equipment.

▶ **[Play it](https://duaneshaffer.github.io/next-pilot/)**

> **Status: early development (M0).** The pipeline is live — seeded runs, a controllable hull, and
> the instrument panel. There is nothing to shoot at yet. See [docs/ROADMAP.md](docs/ROADMAP.md).

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
| `npm run check`     | Typecheck + tests. The gate before committing. |

Append `?seed=K7F2-9XQM-3RTV` to replay an exact run, or `?screen=sortie` to skip the title screen.
Both exist for the automated test harness and are just as usable by hand.

## How it's built

Vanilla TypeScript, Canvas2D, Vite. **No runtime dependencies**, no binary assets — ships are
code-defined geometry and audio is synthesised at runtime. The production bundle is about 15KB.

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
