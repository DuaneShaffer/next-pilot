# Code review — M5 work in progress (bosses, hazards, hulls, routes)

Reviewed 2026-07-25 against the uncommitted working tree (M5 integration was actively in
progress during the review, so line numbers may have drifted slightly). Scope: the working
diff on `src/content/enemies.ts`, `items.ts`, `types.ts`, `src/sim/enemies.ts`,
`entities.ts`, `inventory.ts`, `progression.ts`, `projectiles.ts`, plus the new files
`src/content/bosses.ts`, `hazards.ts`, `hulls.ts`, `src/sim/bosses.ts`, `hazards.ts`.

Overall assessment: the architecture is right — boss-as-derived-`EnemyDef`, named RNG
streams (`route`, `hazard`, `boss`), hulls sharing the item stat vocabulary, honesty
discipline in hulls.ts. Two findings need action before more work is built on top of them;
the rest are minor.

---

## 1. BUG (fix first): secondary weapon corrupts the primary's firing state

**Where:** `src/sim/enemies.ts`, `updateEnemyWeapon` (~lines 258–304).

**What happens:** the instance fields `e.fireCooldown / e.telegraphTicks /
e.telegraphTotal` serve two jobs at once. They are the primary barrel's *authoritative*
slot state — read back into `stepWeapon` on the next tick — and they are also the
*display* telegraph. The display overwrite near the end of `updateEnemyWeapon`:

```ts
if (slot.windup > 0 && (e.telegraphTicks === 0 || slot.windup < e.telegraphTicks)) {
  e.telegraphTicks = slot.windup
  e.telegraphTotal = slot.windupTotal
}
```

copies the **secondary's** windup into `e.telegraphTicks`. On the next tick,
`stepWeapon(e.fireCooldown, e.telegraphTicks, ...)` for the **primary** sees `windup > 0`,
treats it as a committed primary telegraph, counts it down, and **fires a primary volley
when it reaches zero** — even though the primary was idle on cooldown and never committed.

**Concrete failure:** any boss phase with a `secondary` (nearly all phases in
`src/content/bosses.ts`). Example — `MANIFEST_OPENING`: primary fan every 120 ticks,
secondary ring with a 50-tick windup. Every time the ring starts winding up while the fan
is on cooldown, the fan fires a spurious extra volley 50 ticks later. The primary's
effective fire rate roughly doubles, paced by the secondary's telegraph, and the visible
warning stops meaning anything. Still deterministic, so no replay test catches it.

**Fix direction:** give the primary its own `WeaponSlotState` (mirroring `e.secondary`)
and make `e.telegraphTicks / e.telegraphTotal` display-only — computed *after* stepping
both slots from their own private state, as `min` of the two live windups. Keep
`stepWeapon` pure and shared, exactly as it is.

**Why now:** no shipped enemy def has a `secondaryWeapon` yet, so fixing this today
invalidates nothing in `tests/replays/`. Every boss tuned against the current behaviour is
being tuned against roughly double the intended primary output.

**Test to add:** a two-barrel cadence test — an enemy with primary interval N / windup a
and secondary interval M / windup b, asserting exact fire ticks of each barrel over several
cycles, and that the primary never fires off its own interval.

---

## 2. CONTRACT MISMATCH: hazard cadence vs. what the player is told

**Where:** `src/sim/hazards.ts` (`HazardField.update`, `intervalOf`) vs
`src/content/hazards.ts` descriptions vs `src/content/types.ts` (`HazardDef.intervalTicks`
documented as "Ticks between hazard events").

**What happens:** `HazardField` uses `intervalTicks` as the **idle span only**. The real
period of a cycle is `interval + HAZARD_WARNING_TICKS (60) + activeSpan (1 or 120)`. So:

| hazard | description says | actual period |
|---|---|---|
| `convoy-wake` (240) | every 4 s | ~5.0 s (240+60+1) |
| `spore-bloom` (150) | every 2.5 s | ~4.0 s (floored to 180, +60+1) |
| `grid-sweep` (300) | every 5 s | 8.0 s (300+60+120) |
| `manifest-blackout` (420) | every 7 s | 10.0 s (420+60+120) |
| `hold-rot` (180) | every 3 s | ~4.0 s |

Additionally `intervalOf` silently floors `spore-bloom`'s authored 150 up to 180
(`HAZARD_WARNING_TICKS + HAZARD_ACTIVE_TICKS`).

hazards.ts's own header calls a description whose numbers don't match "a lie told to the
player at the exact moment they are making a decision" — and the planned
`tests/sectors.test.ts` (asserting the number appears in the *text*) would pass while this
ships, because the text matches `intervalTicks`, just not the behaviour.

**Fix direction (pick one, document the choice):**
- Make `intervalTicks` the full period, per the types.ts doc: on the `active → idle`
  transition set `remaining = max(1, intervalOf(def) − HAZARD_WARNING_TICKS − activeSpan)`.
  This keeps every description true as written. Recommended.
- Or redefine `intervalTicks` as idle-only in types.ts and rewrite the five descriptions.

Also: `intervalOf`'s floor rationale ("would fire before it finished announcing itself")
is not actually true — phases are sequential, so the warning always completes regardless
of interval length. Keep a floor if a minimum period is wanted, but fix the comment.

**Test to add:** simulate a `HazardField` and assert the tick gap between consecutive
`fired` pulses equals `intervalTicks` (under the full-period fix).

---

## 3. Minor items

1. **`buildRoutes` casts** (`src/sim/progression.ts`): `paid[0] as RouteReward` /
   `paid[1] as RouteReward` are reflexive casts of the kind CLAUDE.md bans under
   `noUncheckedIndexedAccess`. Destructure instead:
   `const [firstReward, secondReward] = paid` with a tuple type, or build the two routes
   without the intermediate array.

2. **Duplicated string literal** (`src/sim/progression.ts`): the direct route's
   `rewardText: 'No hazard, no bonus. Arrive as you are.'` duplicates
   `rewardText({ kind: 'none' })`. Call the function so the two can't diverge.

3. **`BOSS_PARK_LINE_Y` hard-codes 0.32** (`src/content/bosses.ts:145`) while its own
   comment celebrates checking against `maxParkedY` "rather than against a copy of the
   number". `FORWARD_PLAY_Y_FRACTION` is exported from `src/content/enemies.ts` (same
   layer) — import it: `export const BOSS_PARK_LINE_Y = FORWARD_PLAY_Y_FRACTION * PLAYFIELD_H`.

4. **`HazardField` stagger uses `defs.indexOf(def)`** (`src/sim/hazards.ts` constructor):
   if the same def object ever appears twice in a stage's `hazardIds`, both get the first
   index → identical offsets → lockstep firing, defeating the stagger. Use the map index:
   `defs.map((def, i) => ...)`.

5. **Referenced tests don't exist yet.** Content files cite `tests/bosses.test.ts` and
   `tests/sectors.test.ts` as enforcing: callout length ≤ `BOSS_CALLOUT_MAX_CHARS`, phase
   spans ≥ `MIN_PHASE_SECONDS`, TTK inside `BOSS_TTK_BAND`, hover phases above the park
   line, weave amplitudes ≤ `MAX_WEAVE_AMPLITUDE`, hazard description numbers, projectile
   speeds ≤ `DODGEABLE_BULLET_SPEED`, certification grants resolving (`manifest-warden`,
   `writ`/`HULLS_AWAITING_MECHANICS`). These invariants were spot-checked by hand during
   review and all hold today — but until the tests land they exist only in comments.
   (`tests/hulls.test.ts` already exists.)

---

## 4. Expected mid-integration state (not findings — just what's left to wire)

`npm run check` failed at typecheck (~30 errors) at review time, all consistent with
in-progress work rather than defects:

- `src/sim/world.ts` calls `this.updateHazards` and `this.checkStageComplete`, which don't
  exist yet; imports `createBoss` / `pickVariant` / `deriveBossDefs` / `buildRoutes` /
  `spawnDebris` / `transitShopCosts` and declares `rngRoute` / `rngHazard` / `rngBoss` /
  `bossSpawned` / `transition` / `nextHazardIds` / `checkExtraction` without using them.
- New `SimEvent` kinds (`boss-*`, `hazard-*`, `stage-cleared`) not yet handled in
  `src/audio/events.ts` (the exhaustive `Record<kind, true>` there is failing by design).
- `PendingChoiceKind 'route'` not yet handled in `src/ui/choiceScreen.ts` (missing
  `route` key in two label records).
- New required `WorldView` fields (`stage`, `hullName`, `boss`, `hazards`) and
  `PendingChoice.routes` not yet propagated to test fixtures (`audio`, `bots`, `feel`,
  `personnel`, `perf`, `replay` tests).
- `tests/perf.test.ts` builds an `AttributedEnemyBullet` without the new `causeKind`.

Reminders already stated in the code that the integrator must honour:

- Hazard damage must be **conditional** (corrosion only while holding position, etc.) —
  the hazards.ts header states this as a constraint on the implementation, and
  `HazardField` deliberately only emits pulses; the conditionality belongs in the unwritten
  `World.updateHazards`.
- `buildRoutes` returns `[]` when a stage has no hazards; the caller must skip the route
  card entirely (comment says "see World.beginTransition").
- On the first green `npm run check`, watch `tests/replays/` closely: the `stepWeapon`
  refactor touches every armed enemy's cadence path. It reads as behaviour-preserving for
  single-weapon enemies, but the replay corpus is the proof, not the reading.

---

## 5. Hand-verified numbers (so the next agent doesn't redo them)

- Boss TTK at `SECTOR_PLAYER_DPS`: 21.3 / 26.0 / 28.3 / 30.0 / 36.3 s — all inside the
  20–40 s band.
- Shortest phase: Repossessor's final phase at exactly 6.0 s (0.28 × 1700 / 80) — on the
  `MIN_PHASE_SECONDS` boundary; the test should use ≥, not >.
- All callouts ≤ 44 chars (longest measured: 43).
- All boss/enemy projectile speeds ≤ 166 < `DODGEABLE_BULLET_SPEED` (168); fastest is the
  arbiter's 166, matching its "fastest projectile in the game" comment.
- Every boss primary/secondary windup < half its own `intervalTicks` (tightest:
  liquidation 20/48 and sweeper 22/48).
- Death-burst counts match their prose ("twelve shards" = 12, etc.) in all five cases.
- `MANIFEST_CLOSING` weave (amplitude 150, radius 54, centred spawn) stays 20 units inside
  the 448-wide playfield, as its comment claims.
