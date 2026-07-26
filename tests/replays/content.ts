/**
 * FROZEN content for the item-bearing replay fixture.
 *
 * ## The gap this exists to close
 *
 * Every fixture in this corpus was recorded with `new World(seed)`, whose item pool
 * is empty. So the corpus — this project's cheapest and highest-value instrument —
 * had never exercised a single item, a single interaction, or a single `EffectKind`.
 * It was regression-testing a version of the game nobody plays.
 *
 * That is not hypothetical. Two bugs found in one day sat squarely in the blind spot,
 * and the corpus was green through both:
 *
 *   - `retaliate()` fired on shield-absorbed hits, contradicting its own item card
 *     and the anti-synergy argument in `docs/DESIGN.md` built on top of it.
 *   - `Bullet.pierceRemaining` and `.hitUids` were absent from the regression digest,
 *     so any divergence in the piercing path hashed identically (review finding R3).
 *
 * ## WHY THIS IS A FABRICATED TABLE AND NOT `src/content/items.ts`
 *
 * The decision that matters most here, so the argument is written down rather than
 * implied. Both options are defensible and they are answering different questions.
 *
 * **A live-`ITEMS` fixture tests balance.** It would fail whenever an item is
 * retuned — which is a legitimate signal, because a balance change genuinely does
 * invalidate every replay recorded before it. But that signal already has an owner:
 * `tests/simVersion.test.ts` runs its canonical probe against the REAL tables for
 * exactly this reason, and its docstring says so. Its failure mode is one hash and a
 * documented bump procedure.
 *
 * **A fabricated fixture tests the effect bus**, which is what a regression corpus is
 * for. Its failure means one thing only: the simulation now does something different
 * with the same inputs. That unambiguous reading is the whole value of the
 * instrument, and it is what `src/sim/world.ts` and `tests/run.test.ts` already
 * codify as the house rule — content is fabricated in sim tests so that *a balance
 * change cannot break a simulation test*. A corpus fixture that went red every time
 * an item's damage moved would be re-recorded on sight, and
 * `docs/VERIFICATION.md` names that outcome directly: a fixture that gets
 * rubber-stamped has stopped being evidence.
 *
 * Decisive, given content is being actively rebalanced: the two bugs above are both
 * in `src/sim/**`, and a fabricated table exercising `retaliate` and `pierce` would
 * have caught both. The live table was never what was needed — coverage of the bus
 * was.
 *
 * **What this loses, stated plainly:** nothing here can catch a retune of a shipped
 * item that changes what a real run does. That is the canonical probe's job, and it
 * does run against the live tables.
 *
 * ## Rules this content follows
 *
 *   - **Frozen.** Never retune these numbers. They are not balance; they are a test
 *     vector chosen so each effect's contribution is large enough to be unmistakable
 *     in a hash. Changing one costs a re-record for no gain.
 *   - **`probe-` prefixed ids**, so a fabricated id can never collide with a shipped
 *     one, and so a grep for a real item id never lands here.
 *   - **The hull has no stat modifiers.** It exists only to seed the inventory. The
 *     baseline fixtures fly the stat table's bases, so keeping this one on the same
 *     numbers means a divergence in the item fixture but not the baselines localises
 *     to the effect bus rather than to "it was flying a different ship".
 */

import type { EffectKind, HullDef, InteractionDef, ItemDef } from '../../src/content/types'

/**
 * One item per `EffectKind`, plus the hull that carries them.
 *
 * Every `EffectKind` in `src/sim/itemEffects.ts` appears exactly once, so
 * `EFFECT_ITEM_IDS` below can be walked to prove each one demonstrably influences
 * the recorded run. A kind added to that union without an entry here is a kind the
 * corpus cannot see.
 */
export const PROBE_ITEMS: Readonly<Record<string, ItemDef>> = {
  'probe-split': {
    id: 'probe-split',
    name: 'Probe Split',
    tier: 'common',
    tags: ['weapon'],
    mechanism: '+2 projectiles per volley, fanned across 20 degrees.',
    effects: [{ kind: 'splitShot', on: 'onFire', count: 2, spreadDegrees: 20 }],
    weight: 10,
  },
  'probe-pierce': {
    id: 'probe-pierce',
    name: 'Probe Pierce',
    tier: 'common',
    tags: ['weapon'],
    mechanism: 'Rounds pass through 2 further targets.',
    effects: [{ kind: 'pierce', on: 'onProjectileHit', count: 2 }],
    weight: 10,
  },
  'probe-chain': {
    id: 'probe-chain',
    name: 'Probe Chain',
    tier: 'uncommon',
    tags: ['electric'],
    // Fraction 0.5 against the base 4 damage gives a 2-damage arc, a value no direct
    // hit produces — which is what lets the coverage check identify a chain by its
    // `enemy-hit` damage alone.
    mechanism: 'A hit arcs to 1 further target within 90 units for half damage.',
    effects: [{ kind: 'chainOnHit', on: 'onProjectileHit', count: 1, radius: 90, fraction: 0.5 }],
    weight: 10,
  },
  'probe-overkill': {
    id: 'probe-overkill',
    name: 'Probe Overkill',
    tier: 'uncommon',
    tags: ['economy'],
    mechanism: 'Damage beyond a kill converts to scrap in full.',
    effects: [{ kind: 'scrapOnOverkill', on: 'onProjectileHit', fraction: 1 }],
    weight: 10,
  },
  'probe-window': {
    id: 'probe-window',
    name: 'Probe Window',
    tier: 'uncommon',
    tags: ['economy'],
    mechanism: '+50% fire rate for 3 s after collecting scrap.',
    effects: [{ kind: 'fireRateWindow', on: 'onScrapCollected', bonus: 0.5, durationTicks: 180 }],
    weight: 10,
  },
  'probe-coil': {
    id: 'probe-coil',
    name: 'Probe Coil',
    tier: 'rare',
    tags: ['defence'],
    // 6 rounds, so a single trigger is unmistakable in the projectile count. The
    // shield absorbs first, so this only fires once integrity starts taking hits —
    // the behaviour `retaliate()` was getting wrong until recently.
    mechanism: 'Releases 6 rounds in a ring when integrity is lost.',
    effects: [{ kind: 'retaliate', on: 'onHullDamaged', count: 6 }],
    weight: 10,
  },
  'probe-nanites': {
    id: 'probe-nanites',
    name: 'Probe Nanites',
    tier: 'rare',
    tags: ['defence'],
    // `chance: 1` deliberately. A chance below 1 draws from the `items` Rng stream,
    // which is fine for balance but makes this fixture's coverage depend on a roll —
    // and a coverage claim that is true 80% of the time is not a coverage claim.
    mechanism: 'Restores 2 integrity on every kill.',
    effects: [{ kind: 'repairOnKill', on: 'onEnemyKilled', amount: 2, chance: 1 }],
    weight: 10,
  },
}

/**
 * The only source of each `EffectKind`, keyed by the kind.
 *
 * A `Record<EffectKind, ...>` on purpose, and it is the mechanism rather than the
 * documentation: adding a kind to the union in `src/content/types.ts` without adding
 * an item here STOPS COMPILING. The alternative — a list plus a comment asking the
 * next person to remember — is how the corpus ended up with no item coverage at all
 * for five milestones.
 *
 * One kind per item, so a differential failure names the effect and not a bundle.
 */
export const EFFECT_ITEM_BY_KIND: Readonly<Record<EffectKind, string>> = {
  splitShot: 'probe-split',
  pierce: 'probe-pierce',
  chainOnHit: 'probe-chain',
  scrapOnOverkill: 'probe-overkill',
  fireRateWindow: 'probe-window',
  retaliate: 'probe-coil',
  repairOnKill: 'probe-nanites',
}

/** `[itemId, effectKind]` pairs, in a stable order for the coverage walk. */
export const EFFECT_ITEM_IDS: ReadonlyArray<readonly [string, EffectKind]> = Object.entries(
  EFFECT_ITEM_BY_KIND,
).map(([kind, id]) => [id, kind as EffectKind])

/**
 * One declared interaction, so the corpus covers the interaction path too.
 *
 * Interactions contribute their own `effects` to the same fold, and until now nothing
 * recorded had ever had one live. Grants a third pierce on top of `probe-pierce`'s
 * two, which is a contribution the differential coverage check can see.
 */
export const PROBE_INTERACTIONS: readonly InteractionDef[] = [
  {
    id: 'probe-through-and-through',
    requires: ['probe-split', 'probe-pierce'],
    text: 'Split rounds pierce one target further.',
    effects: [{ kind: 'pierce', on: 'onProjectileHit', count: 1 }],
  },
]

/**
 * The hull, whose only job is to seed the inventory.
 *
 * NO STAT MODIFIERS, deliberately — see the header. Starting items rather than
 * relying on reward cards, for two reasons: a run only meets item cards at waves 7
 * and 20, so an offer-fed build spends most of the run with an empty inventory and
 * exercises the bus barely at all; and what an offer hands over depends on the
 * `offers` Rng, which would make this fixture's coverage a function of a draw.
 */
export const PROBE_HULL: HullDef = {
  id: 'probe-hull',
  // Display name is the id in disguise, which is the convention `playback`'s hull
  // check depends on — see `hullKey`. Asserted against the real roster in
  // tests/replay.test.ts, because it is currently a convention and not a type.
  name: 'Probe Hull',
  mechanism: 'Company baseline, issued with the full systems suite for instrumentation.',
  stats: [],
  startingItems: Object.keys(PROBE_ITEMS),
}

/** Every id the hull issues. Handy for asserting the recorded build. */
export const PROBE_STARTING_ITEMS: readonly string[] = Object.keys(PROBE_ITEMS)
