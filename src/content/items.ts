/**
 * Item definitions.
 *
 * Fourteen items, tuned against the same fixed facts `enemies.ts` is tuned
 * against: the hull has **100 integrity plus 40 shield** (140 effective health),
 * moves at **210 units/second**, and fires **20 shots/second at 4 damage — 80
 * damage per second**. A full sector-1 clear runs ~188 seconds and pays ~800
 * scrap, and a competent bot policy currently clears 39% of runs. Every number
 * below is a percentage of one of those five figures, and the comments say which.
 *
 * ## The output ceiling for a common
 *
 * **No single common may double the player's output.** The strongest common here
 * is Machined Slugs at +25% damage per second. That ceiling exists because commons
 * are what the player sees most: if the first offer can double dps, every later
 * choice is measured against a coin flip that already happened, and the tiers stop
 * meaning anything. Uncommons are allowed to reach +50%, rares to change the shape
 * of the volley, and relics to be lopsided enough to build around.
 *
 * ## Stats, not effects, wherever possible
 *
 * `StatModifier`s fold in a fixed order (see `StatKey`'s docs in `types.ts`), so
 * two players on one seed get identical numbers regardless of pickup order.
 * `EffectDef`s do not have that guarantee — they dispatch in acquisition order.
 * So anything expressible as a number is a number, and effects are reserved for
 * behaviour a number cannot describe: extra projectiles, chaining, conversion,
 * timed windows. Eight of the fourteen items here are pure stat modifiers.
 *
 * ## fireIntervalTicks is integer-quantised, and that constrains fire-rate items
 *
 * The weapon cooldown is counted in whole ticks, so the base of 3 has exactly two
 * useful neighbours: 2 ticks (30 shots/s) and 1 tick (60 shots/s). A `mul` on this
 * stat is therefore **banned in content and asserted against in
 * `tests/items.test.ts`** — `mul: 0.85` resolves to 2.55 ticks, which a whole-tick
 * cooldown rounds straight back to 3, producing an item that costs a pick and does
 * nothing. Permanent fire rate comes from an integer `add` (Feed Relay); fractional
 * fire rate comes from the `fireRateWindow` effect, which the simulation applies as
 * a real fraction.
 *
 * ## Connectivity over count
 *
 * `docs/DESIGN.md`: ~40 well-connected items beats 150 stat sticks. At fourteen the
 * graph matters more than the roster, so ten of these participate in at least one
 * declared interaction (`interactions.ts`). The four that do not are **deliberately
 * standalone**, and the exact count is asserted by a test so an item cannot be
 * orphaned silently:
 *
 *   Machined Slugs, Thrust Trim, Plating Shim, Feed Relay
 *
 * All four are the plainest possible version of one number going up. That is the
 * job commons do — they are the baseline a build is measured against, and giving
 * every one of them a synergy would mean the choice screen is never quiet, so a
 * synergy marker would stop being information. The graph lives in the uncommon,
 * rare, and relic tiers where a pick is rare enough to be worth planning around.
 */

import type { ItemDef } from './types'

/**
 * The strongest damage-per-second increase a single `common` item may grant, as a
 * multiple of the base 80 dps.
 *
 * 1.25 rather than 2.0 — see the output-ceiling note above. This is documentation
 * of intent rather than an enforced bound: dps depends on which stats an item
 * touches and on how the sim resolves an effect, so a test cannot compute it, but
 * a reviewer adding a common can check their number against it in one step.
 */
export const COMMON_DPS_CEILING = 1.25

export const ITEMS: Record<string, ItemDef> = {
  // -------------------------------------------------------------------------
  // common — the baseline. One number, up. Deliberately unconnected.
  // -------------------------------------------------------------------------

  /**
   * +1 damage is the smallest step this stat has and it is worth +25% dps, which
   * is how coarse a 4-damage base is. That coarseness is why the roster has one
   * flat-damage common and not three: a second +1 item would take a two-common
   * build to 150% output, and the ceiling above says no.
   *
   * `add` rather than `mul` on purpose. It is the item every other damage
   * multiplier scales, so it stays useful in the last sector instead of becoming
   * rounding error — the fixed fold order sums adds first, then multiplies.
   */
  'machined-slugs': {
    id: 'machined-slugs',
    name: 'Machined Slugs',
    tier: 'common',
    tags: ['weapon'],
    mechanism: '+1 projectile damage, from 4 to 5 — 100 damage per second instead of 80.',
    flavour: 'Requisition has a field for "slugs, machined" and nobody currently living knows why.',
    stats: [{ stat: 'projectileDamage', kind: 'add', value: 1 }],
    weight: 12,
  },

  /**
   * +28 units/second is +13%, chosen against enemy fire rather than against the
   * base speed: the fastest projectile in sector 1 travels at 130 u/s, so the hull
   * already out-runs everything and more speed buys reaction *margin*, not escape.
   * A larger number starts overshooting gaps in a turret fan, which is why this is
   * +13% and not +30%.
   */
  'thrust-trim': {
    id: 'thrust-trim',
    name: 'Thrust Trim',
    tier: 'common',
    tags: ['mobility'],
    mechanism: '+28 hull speed, from 210 to 238 units per second.',
    flavour: 'Filed as a maintenance correction. Upgrades require approval; corrections do not.',
    stats: [{ stat: 'hullSpeed', kind: 'add', value: 28 }],
    weight: 10,
  },

  /**
   * 34 to 60 units is a 3.1x collection *area*, which is the number that matters —
   * pickup radius is felt as a disc, not a distance.
   *
   * The +10% scrap rider exists so the item is not a pure enabler. On its own,
   * radius only converts scrap the player would have missed, worth maybe 5-8% of a
   * ~800-scrap sector; the roadmap's exit criterion wants no item under a 10% pick
   * rate, and an item whose entire value is one specific pair-up would fail that.
   */
  'scrap-magnet': {
    id: 'scrap-magnet',
    name: 'Scrap Magnet',
    tier: 'common',
    tags: ['economy'],
    mechanism: 'Pickup radius 34 to 60 units, and all scrap is worth 10% more.',
    flavour: 'Recovery is a company asset. Recovering it is your problem.',
    stats: [
      { stat: 'pickupRadius', kind: 'add', value: 26 },
      { stat: 'scrapMultiplier', kind: 'mul', value: 1.1 },
    ],
    weight: 8,
  },

  /**
   * +18 integrity is +13% effective health (140 to 158) — deliberately less than a
   * single Lancer dive plus a Hauler collision (24 + 22 = 46). A defensive common
   * should buy a mistake back, not a habit.
   *
   * `add` on `maxIntegrity` and not `mul`, so it composes correctly with Cursed
   * Hull: adds are summed first, so the shim raises the number the curse then
   * halves (118 x 0.55 = 64) rather than being multiplied away.
   */
  'plating-shim': {
    id: 'plating-shim',
    name: 'Plating Shim',
    tier: 'common',
    tags: ['defence'],
    mechanism: '+18 max integrity, from 100 to 118.',
    flavour: 'Cut from a hull that stopped needing it.',
    stats: [{ stat: 'maxIntegrity', kind: 'add', value: 18 }],
    weight: 10,
  },

  // -------------------------------------------------------------------------
  // uncommon — the first picks that change how a run is played.
  // -------------------------------------------------------------------------

  /**
   * 3 ticks to 2 is +50% dps and it is the *smallest possible* permanent fire-rate
   * change, because the cooldown is whole ticks (see the header note). There is no
   * gentler version of this item to author, which is why it sits at uncommon rather
   * than common: +50% is above the common ceiling, and rounding it down is not an
   * option the stat offers.
   *
   * KNOWN SHARP EDGE: two stacks reach 1 tick — 60 shots/second, +200% output.
   * `projectilesPerShot` is capped at 12 and `fireIntervalTicks` is floored at 1, so
   * this is bounded rather than unbounded, but a double Feed Relay is the single
   * biggest jump available in the roster and it should be watched in the first bot
   * sweep that offers items.
   */
  'feed-relay': {
    id: 'feed-relay',
    name: 'Feed Relay',
    tier: 'uncommon',
    tags: ['weapon'],
    mechanism: '+10 shots per second, from 20 to 30.',
    flavour: 'The relay is rated for this. The pilot is not consulted.',
    stats: [{ stat: 'fireIntervalTicks', kind: 'add', value: -1 }],
    weight: 6,
  },

  /**
   * +35 shield takes effective health from 140 to 175 (+25%), and the -14 hull
   * speed is what stops it being a free +25%: at 196 u/s the hull is still faster
   * than every projectile in sector 1, so the cost is reaction margin rather than
   * safety — the same currency Thrust Trim sells.
   *
   * NOT tagged `cursed`. The distinction the tag draws is between an item with a
   * price and an item with a *curse*: this is a heavy plate, and a player who wants
   * to be slow and hard is getting exactly what the text describes.
   */
  'heavy-shield': {
    id: 'heavy-shield',
    name: 'Heavy Shield',
    tier: 'uncommon',
    tags: ['defence'],
    mechanism:
      '+35 max shield, from 40 to 75, and -14 hull speed, from 210 to 196 units per second.',
    flavour: 'Rated for salvage recovery. Not rated for the pilot inside it.',
    stats: [
      { stat: 'maxShield', kind: 'add', value: 35 },
      { stat: 'hullSpeed', kind: 'add', value: -14 },
    ],
    weight: 8,
  },

  /**
   * An effect and not `projectilesPerShot`, because the spread angle is the item:
   * `projectilesPerShot` adds projectiles with no way to say where they go, and
   * "3 shots stacked on one line" and "3 shots across 22 degrees" are different
   * items. `splitShot` carries `spreadDegrees`, so it can.
   *
   * +-11 degrees is the whole tuning decision. At the 620 u/s base projectile speed
   * an 11-degree offset has diverged about 39 units after 200 units of travel —
   * wider than a Turret (radius 15) but narrower than a Hauler (radius 22). So a
   * single small target takes one hit at range and up to three point-blank, while a
   * wave takes three. That is the intended shape: this is a crowd item that rewards
   * closing distance, not a flat 3x damage item.
   */
  'split-shot': {
    id: 'split-shot',
    name: 'Split Shot',
    tier: 'uncommon',
    tags: ['weapon'],
    mechanism: 'Fires 2 extra projectiles per shot at ±11 degrees, so each volley is 3 shots.',
    flavour: 'Ammunition accounting was informed and has objected.',
    effects: [{ kind: 'splitShot', on: 'onFire', count: 2, spreadDegrees: 11 }],
    weight: 8,
  },

  /**
   * The numbers are `docs/UI.md` rule 4's worked example verbatim, and they stay
   * that way: the rule quotes this item's mechanism line as the format everything
   * else copies, so changing 18% or 3 s here silently makes the documentation wrong.
   *
   * +18% for 3 s is small on purpose. Sector 1 pays ~800 scrap over ~188 seconds,
   * so scrap arrives roughly every 2-4 seconds while the player is actually killing
   * things — the window is meant to be *usually* up during a fight and reliably
   * down between waves, which makes it a reward for pressing forward rather than a
   * permanent +18%. Pairing it with Scrap Magnet is what closes that gap, and that
   * is a declared interaction rather than an accident.
   */
  'coin-op-cannon': {
    id: 'coin-op-cannon',
    name: 'Coin-Operated Cannon',
    tier: 'uncommon',
    tags: ['economy', 'weapon'],
    mechanism: '+18% fire rate for 3 s after collecting scrap.',
    flavour: 'Requisition insists this is a feature.',
    // 180 ticks at 60 Hz is 3 s. Written as ticks because the simulation counts
    // ticks and a seconds value would need converting at the point it is trusted.
    effects: [{ kind: 'fireRateWindow', on: 'onScrapCollected', bonus: 0.18, durationTicks: 180 }],
    weight: 7,
  },

  /**
   * 40% conversion, chosen so the item is nearly dead at base damage and comes
   * alive with a damage build — which is the point of putting it in the graph.
   *
   * At 4 damage per shot, overkill on a 12 HP Mine averages under 2 wasted damage,
   * so this pays a few scrap a wave. At Warheads' 5.8 it starts paying properly,
   * and the declared interaction pushes conversion to 90%. An economy item that is
   * good on its own has nothing to combine with.
   */
  'overkill-accounting': {
    id: 'overkill-accounting',
    name: 'Overkill Accounting',
    tier: 'uncommon',
    tags: ['economy'],
    mechanism: '40% of the damage dealt beyond a kill is converted to scrap.',
    flavour: 'Waste is recoverable. This has always been the company position.',
    effects: [{ kind: 'scrapOnOverkill', on: 'onEnemyKilled', fraction: 0.4 }],
    weight: 7,
  },

  /**
   * 6 projectiles per hull hit. The trigger is `onHullDamaged`, which fires *after*
   * shields are applied, so the coil only pays out on integrity loss — and the
   * mechanism line says so, because a player who reads "whenever the hull takes
   * damage" and watches nothing happen while their shield eats a pellet has been
   * misled by omission.
   *
   * That post-shield trigger is also why this item's declared partner is Cursed
   * Hull and not Heavy Shield: more shield means *fewer* triggers. See the note in
   * `interactions.ts`.
   *
   * 6 rather than a larger burst because a retaliation is compensation, not a
   * strategy. Sector-1 hits land 6-24 integrity at a time; a burst big enough to
   * clear the screen would make taking damage correct.
   */
  'retaliation-coil': {
    id: 'retaliation-coil',
    name: 'Retaliation Coil',
    tier: 'uncommon',
    tags: ['defence', 'electric'],
    mechanism:
      'Releases 6 projectiles whenever the hull takes damage. Shields absorb first, so it fires only on integrity loss.',
    flavour: 'The coil discharges on impact. Impact is defined as your problem.',
    effects: [{ kind: 'retaliate', on: 'onHullDamaged', count: 6 }],
    weight: 6,
  },

  // -------------------------------------------------------------------------
  // rare — items that change the shape of the volley.
  // -------------------------------------------------------------------------

  /**
   * 90 units of arc range is a little over four Turret radii and about a fifth of
   * the 448-unit playfield width, so it reaches the *neighbour* in a formation and
   * not across the screen. That is what keeps it a formation-punishing item rather
   * than a screen-clear.
   *
   * 40% of damage dealt, not a flat number, so it scales with the damage build
   * instead of being strongest at 4 damage. 1 target rather than 2 because at 20
   * shots/second one extra arc is already +40% effective dps against any pair, and
   * the declared Split Shot pairing takes it to nine hits a volley.
   */
  'arc-coupler': {
    id: 'arc-coupler',
    name: 'Arc Coupler',
    tier: 'rare',
    tags: ['weapon', 'electric'],
    mechanism: 'Each hit arcs to 1 more enemy within 90 units for 40% of the damage dealt.',
    flavour: 'Grounding was declared out of scope during the requisition review.',
    effects: [{ kind: 'chainOnHit', on: 'onProjectileHit', count: 1, radius: 90, fraction: 0.4 }],
    weight: 5,
  },

  /**
   * `mul` and not `add`, deliberately: this is the multiplicative slot in a damage
   * build, so it rewards having taken the flat adds first. 4 x 1.45 = 5.8 alone;
   * with Machined Slugs it is 5 x 1.45 = 7.25.
   *
   * -15% projectile speed (620 to 527 u/s) is the price, and it is a real one in a
   * vertical shooter: a slower shot spends longer in flight, so a Skiff oscillating
   * on a 2.5-second sine can drift out of a lane the player led correctly. It is
   * not a curse, though — 527 u/s still crosses the playfield in 1.4 seconds — so
   * this is tagged `weapon`/`explosive` and not `cursed`.
   */
  warheads: {
    id: 'warheads',
    name: 'Warheads',
    tier: 'rare',
    tags: ['weapon', 'explosive'],
    mechanism:
      '+45% projectile damage, 4 to 5.8, and -15% projectile speed, 620 to 527 units per second.',
    flavour: 'Handling instructions were attached to the pilot who signed for them.',
    stats: [
      { stat: 'projectileDamage', kind: 'mul', value: 1.45 },
      { stat: 'projectileSpeed', kind: 'mul', value: 0.85 },
    ],
    weight: 5,
  },

  // -------------------------------------------------------------------------
  // relic — lopsided enough to build a run around.
  // -------------------------------------------------------------------------

  /**
   * 25% of 3 integrity is 0.75 per kill on average. Sector 1 is roughly 70 kills,
   * so this is about 52 integrity across ~188 seconds — half a hull, paid out in
   * crumbs. Both halves of that shape are the tuning:
   *
   * - The *rate* is low enough that it never outheals a mistake. A Lancer dive is
   *   24 integrity, which is 32 kills of recovery.
   * - The *chance* is 25% rather than a guaranteed 0.75, because a visible heal that
   *   sometimes happens reads as a mechanic, and a continuous trickle of +0.75 reads
   *   as a slower health bar. UI rule 9 wants state changes announced where the
   *   player is looking, and there is nothing to announce every kill.
   *
   * Relic rather than rare because it is the roster's only integrity recovery, and
   * both of its declared interactions turn it into the engine of a whole build.
   */
  'repair-nanites': {
    id: 'repair-nanites',
    name: 'Repair Nanites',
    tier: 'relic',
    tags: ['defence'],
    mechanism:
      'Each kill has a 25% chance to restore 3 integrity — about 0.75 integrity per kill.',
    flavour: 'Rated for hull repair. Certified for nothing that is currently breathing.',
    effects: [{ kind: 'repairOnKill', on: 'onEnemyKilled', amount: 3, chance: 0.25 }],
    weight: 3,
  },

  /**
   * THE CURSED ITEM. Effective health 140 to 95 (-32%), damage 4 to 6 (+50%).
   *
   * A trade, not a downgrade, and the asymmetry is on purpose. It gives more than it
   * takes on paper — +50% output for -32% health — because a health loss is paid at
   * the worst possible moment and a damage gain is banked continuously. A curse
   * priced at parity is a curse nobody takes.
   *
   * 55 integrity is chosen against the sector's actual hits: it survives two Lancer
   * dives (24 each) but not three, and one Hauler collision plus one Lancer dive
   * (46) leaves 9. So the curse's real cost is that sector 1's fairness budget — four
   * survivable mistakes, see `SECTOR_ONE_MAX_CONTACT_DAMAGE` — drops to two.
   *
   * `mul` on both stats so it stays a percentage of whatever the build already is,
   * and so it composes predictably with the `add`-based Plating Shim: adds are summed
   * first, so a shimmed cursed hull is 118 x 0.55 = 64 integrity rather than 73.
   *
   * Tags are `cursed` and `weapon` only — NOT `defence`. It touches `maxIntegrity`,
   * but tags describe what an item is *for*, and offer weighting that reads
   * `defence` as "the player wants to survive" must not be handed this.
   */
  'cursed-hull': {
    id: 'cursed-hull',
    name: 'Cursed Hull',
    tier: 'relic',
    tags: ['cursed', 'weapon'],
    mechanism:
      '-45% max integrity, 100 to 55, and +50% projectile damage, 4 to 6. Shields are unaffected, so effective health falls from 140 to 95.',
    flavour: "The previous pilot's personal effects were removed. The previous pilot was not.",
    stats: [
      { stat: 'maxIntegrity', kind: 'mul', value: 0.55 },
      { stat: 'projectileDamage', kind: 'mul', value: 1.5 },
    ],
    weight: 2,
  },
}

/**
 * Look up an item definition, throwing on an unknown id.
 *
 * Throws rather than returning undefined for the same reason `getEnemy` does: every
 * caller is either content (a typo in an interaction's `requires`) or the sim
 * (a `defId` in a saved inventory that no longer exists). Both are authoring bugs
 * that must fail where they happen rather than becoming an item that silently does
 * nothing to a seeded run.
 *
 * Guards with `Object.hasOwn` rather than an undefined check. A plain index lookup
 * resolves `constructor`, `toString`, and `__proto__` to inherited members of
 * `Object.prototype`, so `getItem('constructor')` would hand back a function typed
 * as an `ItemDef` and fail somewhere far away from the mistake. The equivalent enemy
 * lookup shipped that bug once; `tests/items.test.ts` asserts against it by name.
 */
export function getItem(id: string): ItemDef {
  if (!Object.hasOwn(ITEMS, id)) throw new Error(`Unknown item id: ${id}`)
  return ITEMS[id] as ItemDef
}
