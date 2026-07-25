/**
 * Item interactions.
 *
 * Seven declared combinations over the fourteen items in `items.ts`. These are the
 * point of M3: `docs/DESIGN.md` bets that depth comes from combinations rather than
 * roster size, and `docs/UI.md` rule 5 requires that a combination the game cannot
 * *explain* does not ship — so every one of them is data with a sentence attached,
 * and the choice screen reads that sentence verbatim.
 *
 * ## How to read the numbers in `text`
 *
 * **Interaction effects are additive on top of the items' own effects, not
 * replacements.** `resolveInventory` pushes each held item's effects and then each
 * live interaction's effects into the same list, so a build holding Arc Coupler and
 * this file's `split-arc` runs *two* `chainOnHit` effects, not one upgraded one.
 *
 * Every `text` below therefore states the **total** the player will observe —
 * "arcs twice instead of once", not "adds one arc" — because the player is reading
 * it to decide what their gun will do, not to audit the data model. Where a total is
 * quoted, the comment above the interaction shows the arithmetic.
 *
 * ## What a synergy has to be
 *
 * Each of these changes how the build is *played*, not just what it totals. A
 * combination whose only consequence is a small stat nudge is two items, not a
 * synergy, and it would train players to ignore the synergy marker — which is the
 * one interface affordance this milestone is built around.
 *
 * ## Candidate combinations from DESIGN.md that this contract cannot express
 *
 * Recorded here rather than in a commit message, because the next person to read
 * `docs/DESIGN.md`'s table will otherwise re-derive all four:
 *
 * - **Retaliation Coil + Heavy Shield** ("absorbed shield damage charges a piercing
 *   beam") is not expressible, and worse, it is *backwards*. The only damage hook is
 *   `onHullDamaged`, which fires after shields are applied, so a bigger shield means
 *   strictly **fewer** retaliation triggers. Shipping it as written would put an
 *   anti-synergy behind a synergy marker. Expressing it needs a shield-absorption
 *   hook (`onShieldAbsorbed`) that does not exist. The coil is paired with Cursed
 *   Hull instead, which pushes the trigger in the correct direction.
 * - **Heat Sink + Overclocked Beam** needs a beam weapon and an overheat resource.
 *   Neither exists: the player's weapon is projectiles, and there is no `EffectKind`
 *   with state that accumulates and vents.
 * - **Graze Reactor + Phase Window** needs a near-miss event and a chargeable
 *   special. There is no graze hook among the six `HookName`s and no special-meter
 *   concept anywhere in the sim.
 * - **Drone Uplink + Mirror Mount** needs drone entities. The `drone` `ItemTag`
 *   exists, but no `EffectKind` spawns or arms one, so no item in `items.ts` carries
 *   that tag — a tag with no items is honest; an item that claims a drone and gets
 *   none is not.
 *
 * One more partial: **Cursed Hull + Repair Nanites** in DESIGN.md is "every repair
 * also grants damage", i.e. a stacking buff that accumulates over a run. Nothing in
 * `EffectKind` holds state across triggers, so `curse-nanites` below delivers the
 * same *build* — a hull that heals fast and hits hard — as a flat damage bonus plus
 * a much larger repair. The ramp is the part that is missing.
 */

import type { InteractionDef } from './types'

export const INTERACTIONS: readonly InteractionDef[] = [
  /**
   * The volley item and the chain item. Arc Coupler already arcs from every
   * projectile that hits, including split fragments, so the interaction has to give
   * something the two items do not already give each other: a **second** arc.
   *
   * Arithmetic behind "9 hits": 3 projectiles x (1 direct + 1 coupler arc + 1
   * interaction arc). Damage on a full volley at base 4 is
   * 3 x (4 + 1.6 + 1.4) = 21 rather than 12, and it lands on up to nine separate
   * enemies, which is the actual change — this stops being a damage build and starts
   * being a formation-deleting build.
   *
   * 130 units of reach against the coupler's 90 so the second arc hops *outward*
   * rather than doubling back into the same pair, and 35% rather than 40% so the
   * chain decays instead of paying more the further it travels.
   */
  {
    id: 'split-arc',
    requires: ['split-shot', 'arc-coupler'],
    text: 'Every hit arcs twice instead of once — the second arc reaches 130 units for 35% of the damage — so one 3-projectile volley can land up to 9 hits.',
    effects: [{ kind: 'chainOnHit', on: 'onProjectileHit', count: 1, radius: 130, fraction: 0.35 }],
  },

  /**
   * The economy engine. Overkill Accounting is deliberately weak at 4 damage; this
   * is the pairing it was priced for.
   *
   * Conversion 0.4 + 0.5 = 0.9. Worked example in the text: a 5.8-damage shell into
   * an enemy with 2 integrity left wastes 3.8, and 3.8 x 0.9 = 3.42 becomes scrap.
   * That is chosen as the example because it is the *common* case with Warheads —
   * 5.8 per shot against 12-40 HP sector-1 enemies overkills almost every time.
   *
   * The +20% `scrapMultiplier` is what makes this route-defining rather than
   * incremental: a ~800-scrap sector becomes ~960 before overkill, and the overkill
   * income on a Warheads build is worth roughly as much again. That funds a shop
   * visit the player could not otherwise afford, which is a different run, not a
   * bigger number.
   */
  {
    id: 'overkill-warheads',
    requires: ['overkill-accounting', 'warheads'],
    text: 'Overkill converts at 90% instead of 40%, and all scrap is worth 20% more: a 5.8-damage shell finishing an enemy with 2 integrity left banks 3.4 scrap from the 3.8 wasted.',
    stats: [{ stat: 'scrapMultiplier', kind: 'mul', value: 1.2 }],
    effects: [{ kind: 'scrapOnOverkill', on: 'onEnemyKilled', fraction: 0.5 }],
  },

  /**
   * The greed engine, and the closest thing in the roster to a self-sustaining loop.
   *
   * Coin-Operated Cannon's window is 3 s and sector 1 pays ~800 scrap over ~188 s,
   * so scrap arrives every 2-4 seconds during a fight and the window is *usually*
   * up. The two halves of this interaction close that gap from both ends: radius
   * 34 + 26 + 30 = 90 units collects scrap the player never flew to, and a second
   * window of 5 s means one pickup covers more than the gap to the next.
   *
   * Up to +40% fire rate (18 + 22) while both windows overlap. That is a large
   * standing bonus, and it is the intended payoff of committing two picks to a
   * mechanic that pays nothing while retreating — the build has to fly *into* the
   * wreckage to keep the meter fed, which is the risk the reward is priced against.
   */
  {
    id: 'magnet-coin-op',
    requires: ['scrap-magnet', 'coin-op-cannon'],
    text: 'Pickup radius rises to 90 units, and each scrap collected also opens a +22% fire-rate window for 5 s on top of the Cannon’s +18% for 3 s — up to +40% fire rate, and scrap arrives often enough that it rarely lapses.',
    stats: [{ stat: 'pickupRadius', kind: 'add', value: 30 }],
    // 300 ticks at 60 Hz is 5 s — longer than the 3 s window it stacks with, so one
    // pickup reliably bridges the gap to the next rather than only overlapping it.
    effects: [{ kind: 'fireRateWindow', on: 'onScrapCollected', bonus: 0.22, durationTicks: 300 }],
  },

  /**
   * Retaliation Coil's declared partner, and the reason it is Cursed Hull rather
   * than Heavy Shield: see the header note. `onHullDamaged` fires only on integrity
   * loss, so what the coil actually wants is a hull that gets hit — and 55 integrity
   * with the base 40 shield means shields break early and hits reach the hull often.
   * The two items point the same way.
   *
   * 6 + 8 = 14 projectiles per hit. Sized against the trade: a cursed hull has two
   * survivable mistakes instead of four, so retaliation has to be worth roughly a
   * volley and a half of the player's own fire (14 vs the 3-shot Split Shot volley)
   * to make "take the hit" a decision rather than always wrong.
   *
   * `pierce` is the piece that changes the build. It is the roster's only source of
   * piercing other than `warhead-fragments`, and one extra pass-through against
   * sector 1's column and line formations is worth more than the retaliation is: a
   * risk build that is *also* an efficiency build is a reason to keep flying a hull
   * that can die to two Lancers.
   */
  {
    id: 'coil-curse',
    requires: ['retaliation-coil', 'cursed-hull'],
    text: 'The 55-integrity hull loses integrity often, and each hit now releases 14 projectiles instead of 6, while every projectile you fire passes through 1 extra enemy.',
    effects: [
      { kind: 'retaliate', on: 'onHullDamaged', count: 8 },
      { kind: 'pierce', on: 'onFire', count: 1 },
    ],
  },

  /**
   * DESIGN.md's "Cursed Hull + Repair Nanites", minus the ramp it cannot express
   * (see the header note).
   *
   * Recovery: 0.25 x 3 = 0.75 from the item, plus 0.45 x 6 = 2.7 from the
   * interaction, so about 3.4 integrity per kill. Against a 55-integrity hull that
   * is a fundamentally different resource: 16 kills is a full heal, and sector 1 has
   * ~70 kills in it. The curse stops being a life total and becomes a throughput
   * problem — the hull is fine as long as things keep dying, which is exactly the
   * play pattern the +2 damage is there to support.
   *
   * The damage is `add`, so the curse's x1.5 multiplies it: (4 + 2) x 1.5 = 9 per
   * shot, 180 dps at the base fire rate. That ordering is a property of the fixed
   * fold (adds, then muls) rather than of this interaction, and it is why the bonus
   * is +2 and not +4 — an `add` behind a x1.5 is worth 50% more than it looks.
   */
  {
    id: 'curse-nanites',
    requires: ['cursed-hull', 'repair-nanites'],
    text: 'Kills also have a 45% chance to restore 6 integrity, taking recovery from about 0.75 to about 3.4 integrity per kill, and projectiles gain +2 damage — 9 per shot with the curse applied.',
    stats: [{ stat: 'projectileDamage', kind: 'add', value: 2 }],
    effects: [{ kind: 'repairOnKill', on: 'onEnemyKilled', amount: 6, chance: 0.45 }],
  },

  /**
   * Warheads' -15% projectile speed is its price, and Split Shot is the item that
   * price hurts most: a slower shot at ±11 degrees spends longer diverging, so the
   * off-axis fragments miss a moving Skiff that the centre shot leads correctly.
   * Restoring the speed is therefore a real fix to a real interaction between the
   * two items, not a nudge.
   *
   * 620 x 0.85 = 527, then x 1.25 = 659. Deliberately *above* the 620 base: the
   * combination has to be better than not having taken Warheads, or the interaction
   * is an apology.
   *
   * `pierce` on all three projectiles is the build change. 5.8-damage shells passing
   * through 2 enemies each is 3 x 2 = 6 bodies per volley on a `column` or `line`
   * formation, which turns the sector's densest spawns from the hardest thing in it
   * into the most profitable.
   */
  {
    id: 'warhead-fragments',
    requires: ['warheads', 'split-shot'],
    text: 'All 3 projectiles pass through 1 extra enemy, and shell speed recovers from 527 to 659 units per second — faster than the 620 it started at.',
    stats: [{ stat: 'projectileSpeed', kind: 'mul', value: 1.25 }],
    effects: [{ kind: 'pierce', on: 'onFire', count: 1 }],
  },

  /**
   * The attrition build, and Heavy Shield's one honest pairing.
   *
   * The direction is right where the DESIGN.md shield combination's was wrong:
   * shields regenerate nothing and integrity does not come back on its own, so a
   * large shield is a buffer that only pays off if something behind it refills.
   * Repair Nanites is that something.
   *
   * 40 + 35 + 20 = 95 shield, and recovery of 0.75 + (0.35 x 4) = 2.15 integrity per
   * kill. Effective health 195, refilling at roughly 2.2 a kill against sector 1's
   * chip damage (Skiff 6, Escort 7, Turret 7 per pellet) — so a pilot who keeps
   * killing outruns incoming fire and only dies to the big avoidable hits, the
   * 22-24 damage collisions. That is the intended failure mode: this build makes
   * bullets survivable and mistakes fatal, which is the inverse of the cursed route.
   *
   * The `add` on `maxShield` composes with Heavy Shield's own `add` (95, not 75 x
   * something) precisely because both are adds and the fold sums them first.
   */
  {
    id: 'shield-nanites',
    requires: ['heavy-shield', 'repair-nanites'],
    text: 'Max shield rises to 95, and kills also have a 35% chance to restore 4 integrity — about 2.2 integrity recovered per kill behind a 95-point buffer.',
    stats: [{ stat: 'maxShield', kind: 'add', value: 20 }],
    effects: [{ kind: 'repairOnKill', on: 'onEnemyKilled', amount: 4, chance: 0.35 }],
  },
]

/**
 * Items with no declared interaction, asserted by `tests/items.test.ts`.
 *
 * Named rather than counted so that orphaning an item fails with the item's name
 * instead of an off-by-one on a number nobody can interpret. Every entry here is a
 * common or the one single-stat uncommon — the plainest items in the roster, whose
 * job is to be the baseline a build is measured against. See the connectivity note
 * in `items.ts`.
 */
export const STANDALONE_ITEM_IDS: readonly string[] = [
  'machined-slugs',
  'thrust-trim',
  'plating-shim',
  'feed-relay',
]
