/**
 * Item definitions.
 *
 * Forty items. The first fourteen are the M3 roster and are **not retuned** — they
 * were measured over 2,000 bot runs and sit in a 19.6-39.8% pick-rate band, and
 * adding to the pool changes *which* three options appear, never how many, so growth
 * is safe where retuning is not. The M5 additions start at the marker in each tier
 * section and follow the same rules; see "The M5 expansion" at the end of this
 * header for what changed about the graph.
 *
 * Every item, old and new, is tuned against the same fixed facts `enemies.ts` is
 * tuned against: the hull has **100 integrity plus 40 shield** (140 effective health),
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
 *
 * ## The M5 expansion — 14 to 40
 *
 * The count is not the point; `docs/DESIGN.md` bets on ~40 *well-connected* items
 * over 150 stat sticks. So the twenty-six additions were chosen to fill archetypes
 * the graph could not previously express, and every one of them lands in at least
 * one declared interaction unless it is on the standalone list.
 *
 * **The standalone list grew from four to eight** — the four above plus Barrel
 * Liner, Shield Cell, Ledger Skim, and Hull Braces. All eight are commons, all eight
 * are one or two numbers moving, and the ratio is deliberate: eight of forty means a
 * synergy marker still appears on most screens without appearing on all of them. The
 * exact set is asserted by name in `tests/items.test.ts` so orphaning an item fails
 * with the item's name rather than with an off-by-one.
 *
 * **Maximum interaction degree is 3, and that is enforced.** With forty items the
 * failure mode is not a sparse graph, it is a hub — one item that every synergy runs
 * through, so build variety collapses into "did you find the hub". Five items sit at
 * degree 3 (Gyro Trim, Lance Rounds, Flak Spread, Scrap Magnet, Repair Nanites),
 * fourteen at degree 2, thirteen at degree 1.
 *
 * **What the additions are for**, by archetype:
 *
 * - *Armour, priced in four different currencies.* Bulkhead Seal pays fire rate,
 *   Dispersal Plate pays integrity for shield, Salvage Plating pays scrap, Hull
 *   Braces pays hull speed. Four ways to answer one question, which is more
 *   interesting than four sizes of the same plate.
 * - *Volley shape.* Flak Spread, Twin Mount, Buckshot Manifold and Overpressure
 *   Shells move the volley along two axes — how many rounds and how hard each one
 *   hits — where M3 had only Split Shot.
 * - *Through-fire.* Lance Rounds and Harmonic Lance make `pierce` a route the player
 *   can choose rather than something two interactions happened to grant.
 * - *Economy as a cost.* Salvage Lien and Liquidation Order buy damage with scrap,
 *   which is a currency M3 never charged. Assay Office and Bulk Hauler sell it back.
 * - *Speed against bulk.* Vector Thrusters and Inertial Lattice are deliberate
 *   opposites, and Gyro Trim finally gives `focusFactor` an item — it was the one
 *   stat in the table that nothing could move.
 *
 * ## Two things M5 wanted and could not have
 *
 * Recorded here rather than approximated into something misleading:
 *
 * - **No new `retaliate` item.** `EffectKind` has the hook, but the shipped
 *   behaviour and the shipped *text* disagree about when it fires — see the
 *   RETALIATION note in `interactions.ts`. Authoring a second item against an
 *   ambiguous trigger would put two contradictory descriptions of one mechanic on
 *   the same choice screen.
 * - **No second `repairOnKill` item.** `amount` sums across sources, so a common
 *   healer would stack with Repair Nanites and quietly delete the relic's reason to
 *   be a relic. Healing stays single-source and arrives through interactions.
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

  // ---- M5 commons ---------------------------------------------------------

  /**
   * +120 u/s is +19%, and the number that matters is time in flight rather than the
   * percentage: at 620 a shot crosses the 720-unit playfield in 1.16 s, at 740 in
   * 0.97 s. That 0.19 s is roughly how long a Skiff on its 2.5-second sine takes to
   * clear its own 12-unit radius, so this is the item that stops off-axis shots
   * missing a target the player led correctly.
   *
   * `add` and not `mul`, so it composes with Warheads' x0.85 the way Machined Slugs
   * composes with Warheads' x1.45: the fold sums adds first, so the liner raises the
   * number the penalty then scales (740 x 0.85 = 629) instead of being multiplied
   * away.
   */
  'barrel-liner': {
    id: 'barrel-liner',
    name: 'Barrel Liner',
    tier: 'common',
    tags: ['weapon'],
    mechanism: '+120 projectile speed, from 620 to 740 units per second.',
    flavour: 'Fitted during a scheduled inspection that nobody scheduled.',
    stats: [{ stat: 'projectileSpeed', kind: 'add', value: 120 }],
    weight: 10,
  },

  /**
   * +22 shield is +16% effective health (140 to 162), deliberately a little more per
   * pick than Plating Shim's +13%. Not a mistake: shield does not regenerate AND
   * cannot be restored, while integrity is the pool Repair Nanites refills. A point
   * of integrity is therefore worth more than a point of shield in any build that
   * ever finds the relic, and the sizes are set so the two commons are a real choice
   * rather than one dominating.
   *
   * Raising a maximum grants the difference immediately (see `refreshInventory`), so
   * this reads as +22 shield right now, not as a bigger empty bar.
   */
  'shield-cell': {
    id: 'shield-cell',
    name: 'Shield Cell',
    tier: 'common',
    tags: ['defence'],
    mechanism: '+22 max shield, from 40 to 62 — 162 effective health instead of 140.',
    flavour: 'Charged at the depot. The depot does not guarantee it stayed charged.',
    stats: [{ stat: 'maxShield', kind: 'add', value: 22 }],
    weight: 10,
  },

  /**
   * +18% of a ~800-scrap sector is ~144 scrap, and that number is chosen against the
   * shop rather than against the sector: a common at wave 13 costs 80 x 1 x 1.72 =
   * 138. So this item is worth exactly one extra purchase per sector, which is a
   * legible promise, where +5% would be an invisible one.
   */
  'ledger-skim': {
    id: 'ledger-skim',
    name: 'Ledger Skim',
    tier: 'common',
    tags: ['economy'],
    mechanism: 'All scrap is worth 18% more — about 944 from a sector that pays 800.',
    flavour: 'The discrepancy is within tolerance, and tolerance is set by the ledger.',
    stats: [{ stat: 'scrapMultiplier', kind: 'mul', value: 1.18 }],
    weight: 9,
  },

  /**
   * Plating Shim's louder sibling: +26 integrity instead of +18, paid for with 22
   * hull speed. At 188 u/s the hull is still faster than sector 1's quickest
   * projectile (130 u/s), so the cost is reaction margin rather than escape — the
   * same currency Thrust Trim sells and Heavy Shield buys.
   *
   * +26 is sized against the sector's fairness budget: it is one Hauler collision
   * (22) plus change, so it buys back exactly one specific mistake and not a habit.
   */
  'hull-braces': {
    id: 'hull-braces',
    name: 'Hull Braces',
    tier: 'common',
    tags: ['defence', 'mobility'],
    mechanism:
      '+26 max integrity, from 100 to 126, and -22 hull speed, from 210 to 188 units per second.',
    flavour: 'Braced against loads the manufacturer describes as unlikely.',
    stats: [
      { stat: 'maxIntegrity', kind: 'add', value: 26 },
      { stat: 'hullSpeed', kind: 'add', value: -22 },
    ],
    weight: 9,
  },

  /**
   * `focusFactor` is the one stat in `STATS` that no M3 item could move, so the
   * focus key was a fixed 45% and the table documented a knob nothing turned.
   *
   * 0.45 to 0.25 halves the focused speed, 95 u/s to 53. That is a precision item,
   * not a penalty: focus exists to thread a gap, and a slower focus threads a
   * narrower one. It is written as `0.25x` rather than `25%` because the stat is a
   * multiplier and a bare percent here reads as "25% slower", which is the opposite
   * of what happens.
   *
   * Common rather than uncommon because it adds no power at all — it changes what
   * the player can *do* with the speed they already have.
   */
  'gyro-trim': {
    id: 'gyro-trim',
    name: 'Gyro Trim',
    tier: 'common',
    tags: ['mobility'],
    mechanism:
      'Focus holds the hull at 0.25x speed instead of 0.45x — 53 units per second instead of 95.',
    flavour: 'Trimmed to a tolerance the pilot is not expected to notice or appreciate.',
    stats: [{ stat: 'focusFactor', kind: 'add', value: -0.2 }],
    weight: 8,
  },

  /**
   * The cheap curse, and the roster's first one that charges *health for money*
   * rather than health for damage.
   *
   * -20 integrity is -14% effective health (140 to 120), against +50% on every piece
   * of scrap — roughly +400 a sector, which is three common purchases or one relic
   * at the late shop. The trade is deliberately generous on paper for the same reason
   * Cursed Hull's is: the loss is paid at the worst possible moment and the gain is
   * banked continuously, so a curse priced at parity is a curse nobody takes.
   *
   * -20 and not -40: at 80 integrity the hull still survives three Lancer dives (24
   * each), so sector 1's four-mistake fairness budget becomes three rather than two.
   * This is the entry-level curse; Cursed Hull is the one that takes it to two.
   */
  'hazard-pay-clause': {
    id: 'hazard-pay-clause',
    name: 'Hazard Pay Clause',
    tier: 'common',
    tags: ['economy', 'cursed'],
    mechanism: '+50% scrap from every source, and -20 max integrity, from 100 to 80.',
    flavour: 'Hazard pay is calculated posthumously and paid to the estate, less fees.',
    stats: [
      { stat: 'scrapMultiplier', kind: 'mul', value: 1.5 },
      { stat: 'maxIntegrity', kind: 'add', value: -20 },
    ],
    weight: 8,
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

  // ---- M5 uncommons -------------------------------------------------------

  /**
   * Split Shot's opposite number. Same count, three times the arc.
   *
   * Split Shot's +-11 degrees diverges ~39 units over 200 units of travel, narrower
   * than a Hauler, so its three shots converge on one target at close range. At +-17
   * degrees the fragments are ~61 units apart over the same distance — wider than any
   * enemy in sector 1 — so they cover a *lane* and essentially never all land on one
   * hull. That is the whole item: Split Shot rewards closing, Flak Spread rewards
   * standing back and covering a formation.
   *
   * 34 rather than 40+ because formation spacing in sector 1 runs 56-150 units with a
   * median near 96; a wider arc starts throwing rounds past the outermost enemy
   * instead of into it.
   *
   * `splitShotSpreadDegrees` takes the MAX across sources, so holding this and Split
   * Shot gives five projectiles at 34 degrees, not a mixed fan. Worth knowing before
   * taking both: the narrow item's angle is the one that disappears.
   */
  'flak-spread': {
    id: 'flak-spread',
    name: 'Flak Spread',
    tier: 'uncommon',
    tags: ['weapon'],
    mechanism:
      'Fires 2 extra projectiles per shot across a 34-degree arc, so each volley is 3 shots at ±17 degrees.',
    flavour: 'Accuracy was descoped early and the schedule benefited enormously.',
    effects: [{ kind: 'splitShot', on: 'onFire', count: 2, spreadDegrees: 34 }],
    weight: 7,
  },

  /**
   * `pierce` existed at M3 only as something two interactions granted, so a player
   * who wanted through-fire had to find a specific pair. This makes it a route.
   *
   * One extra pass-through is worth about +40% effective output against sector 1's
   * `column` and `line` formations and exactly nothing against a lone Turret, which
   * is the intended shape — it is a positioning item, not a damage item, and the
   * mechanism line says "passes through" rather than quoting a damage figure because
   * the figure depends entirely on what the player lines up.
   */
  'lance-rounds': {
    id: 'lance-rounds',
    name: 'Lance Rounds',
    tier: 'uncommon',
    tags: ['weapon'],
    mechanism: 'Every projectile passes through 1 extra enemy before it stops.',
    flavour: 'Rated for one hull. Field reports describe a second hull behind it.',
    effects: [{ kind: 'pierce', on: 'onFire', count: 1 }],
    weight: 7,
  },

  /**
   * A short, weak Arc Coupler, and both adjectives are load-bearing.
   *
   * 55 units of reach against the coupler's 90: sector 1's formation spacing runs
   * 56-150, so 55 reaches only the *tightest* spawns (the 56- and 64-unit escort
   * flanks) where 90 reaches the median. 25% of damage against the coupler's 40%.
   *
   * The point is that `chainOnHit` sums `count` but MAXes `radius` and `fraction`.
   * Holding this and the coupler gives two arcs at the coupler's 90 units and 40% —
   * the counts add, the weak numbers vanish. That is a real upgrade path rather than
   * a dead pick, and it is why this item is priced as an enabler: on its own it is
   * a formation-punisher for dense spawns only.
   */
  'ionised-rounds': {
    id: 'ionised-rounds',
    name: 'Ionised Rounds',
    tier: 'uncommon',
    tags: ['weapon', 'electric'],
    mechanism: 'Each hit arcs to 1 more enemy within 55 units for 25% of the damage dealt.',
    flavour: 'Conductive by accident. Retained as conductive by policy.',
    effects: [{ kind: 'chainOnHit', on: 'onProjectileHit', count: 1, radius: 55, fraction: 0.25 }],
    weight: 6,
  },

  /**
   * Armour paid for in fire rate — the first of four items that ask the same question
   * with a different price tag (see the archetype note in the header).
   *
   * +45 integrity is +32% effective health, 140 to 185. The price is one whole tick
   * of cooldown, 20 shots/second to 15, which is -25% output. Whole ticks are the
   * only granularity this stat has (see the header note on `fireIntervalTicks`), so
   * there is no gentler version to author — which is exactly why the integrity number
   * is large. A 25% output cut has to buy something a player can feel.
   *
   * The `add` on `maxIntegrity` matters for Total Loss Cover: adds are summed before
   * muls, so the seal's +45 is inside the number the write-off then multiplies. That
   * composition is the declared interaction `bulkhead-bond`.
   */
  'bulkhead-seal': {
    id: 'bulkhead-seal',
    name: 'Bulkhead Seal',
    tier: 'uncommon',
    tags: ['defence'],
    mechanism:
      '+45 max integrity, from 100 to 145, and -5 shots per second, from 20 to 15.',
    flavour: 'Sealed compartments protect the cargo. The cargo manifest lists you last.',
    stats: [
      { stat: 'maxIntegrity', kind: 'add', value: 45 },
      { stat: 'fireIntervalTicks', kind: 'add', value: 1 },
    ],
    weight: 6,
  },

  /**
   * +26% hull speed for -15% integrity. Thrust Trim's +28 buys reaction margin; +55
   * buys *repositioning* — at 265 u/s the hull crosses the 448-unit playfield in 1.7
   * seconds instead of 2.1, which is inside the 96-tick reload of a Heavy Turret.
   * That is the threshold the number is set at: fast enough to change lanes between
   * volleys rather than merely dodging within one.
   *
   * -15 integrity rather than a shield cost, so the trade lands on the pool that
   * Repair Nanites can put back. A speed build that also heals is a coherent run.
   */
  'slip-thrusters': {
    id: 'slip-thrusters',
    name: 'Slip Thrusters',
    tier: 'uncommon',
    tags: ['mobility'],
    mechanism:
      '+55 hull speed, from 210 to 265 units per second, and -15 max integrity, from 100 to 85.',
    flavour: 'Burns a reserve the maintenance schedule assumes is still there.',
    stats: [
      { stat: 'hullSpeed', kind: 'add', value: 55 },
      { stat: 'maxIntegrity', kind: 'add', value: -15 },
    ],
    weight: 6,
  },

  /**
   * +35% scrap for -12% hull speed. The mirror of Slip Thrusters, and priced against
   * the same fact: 185 u/s is still above sector 1's fastest projectile at 130, so
   * the hull is slower but never outrun.
   *
   * +35% is above Ledger Skim's +18% by more than a tier step should allow on its
   * own, which is what the speed cost is for. A ~800-scrap sector becomes ~1080,
   * enough for a rare at the late shop (80 x 2.4 x 2.38 = 457) that a base run cannot
   * reach without skipping the early one.
   */
  'bulk-hauler': {
    id: 'bulk-hauler',
    name: 'Bulk Hauler Rig',
    tier: 'uncommon',
    tags: ['economy', 'mobility'],
    mechanism:
      '+35% scrap from every source, and -25 hull speed, from 210 to 185 units per second.',
    flavour: 'Capacity was increased. Nothing else about the hull was consulted.',
    stats: [
      { stat: 'scrapMultiplier', kind: 'mul', value: 1.35 },
      { stat: 'hullSpeed', kind: 'add', value: -25 },
    ],
    weight: 6,
  },

  /**
   * Coin-Operated Cannon traded the other way: a smaller bonus that is up nearly all
   * the time, instead of a larger one that flickers.
   *
   * Sector 1 pays ~800 scrap over ~188 s, so during a fight scrap arrives every 2-4
   * seconds. A 6-second window is longer than any realistic gap, which makes +12%
   * effectively permanent while the player is killing things and *nothing at all*
   * while retreating. The Cannon's 3 s window is the opposite: bigger, and genuinely
   * intermittent.
   *
   * `bonus` and `durationTicks` both take the MAX across sources, so holding both
   * gives the Cannon's 18% for the Hopper's 6 s — the two items compose into the
   * best half of each, which is the interaction `hauler-tithe` is priced against.
   */
  'tithe-hopper': {
    id: 'tithe-hopper',
    name: 'Tithe Hopper',
    tier: 'uncommon',
    tags: ['economy', 'weapon'],
    mechanism: '+12% fire rate for 6 s after collecting scrap.',
    flavour: 'A small deduction, taken continuously, is easier to defend than a large one.',
    // 360 ticks at 60 Hz is 6 s. Ticks because the simulation counts ticks; the
    // player is told seconds (UI rule 2).
    effects: [{ kind: 'fireRateWindow', on: 'onScrapCollected', bonus: 0.12, durationTicks: 360 }],
    weight: 6,
  },

  /**
   * The curse that charges *money* for damage, which is an axis M3 never used: every
   * cursed item in the M3 roster took health.
   *
   * +2 damage is +50% output, the uncommon ceiling. -55% scrap takes a ~800-scrap
   * sector to ~360, which is one common purchase instead of three and no shot at a
   * rare. That is a real cost precisely because it is *deferred*: the run feels
   * strictly better for two waves and then the shop is empty.
   *
   * `add` on damage so the multiplicative rares still scale it — (4 + 2) x 1.45 with
   * Warheads is 8.7 — and because a lien that stops mattering by sector 3 is not a
   * curse, it is an early-game tax.
   */
  'salvage-lien': {
    id: 'salvage-lien',
    name: 'Salvage Lien',
    tier: 'uncommon',
    tags: ['weapon', 'economy', 'cursed'],
    mechanism:
      '+2 projectile damage, from 4 to 6, and 55% less scrap from every source.',
    flavour: 'The company advanced you the ordnance and will be recovering the advance.',
    stats: [
      { stat: 'projectileDamage', kind: 'add', value: 2 },
      { stat: 'scrapMultiplier', kind: 'mul', value: 0.45 },
    ],
    weight: 5,
  },

  /**
   * Armour paid for in armour: +45 shield for -18 integrity, net +27 effective health
   * (140 to 167) with the composition changed underneath.
   *
   * Why anyone takes a near-wash: shield absorbs *first* and integrity is what kills
   * you, so moving 18 points from the pool that ends the run into the pool that ends
   * a bad second is worth the 18. The cost is that none of it comes back — Repair
   * Nanites cannot refill a shield — so this is the anti-attrition defensive item,
   * for a build that intends to stop taking hits rather than to out-heal them.
   */
  'dispersal-plate': {
    id: 'dispersal-plate',
    name: 'Dispersal Plate',
    tier: 'uncommon',
    tags: ['defence'],
    mechanism:
      '+45 max shield, from 40 to 85, and -18 max integrity, from 100 to 82 — 167 effective health.',
    flavour: 'Spreads the load across the hull, and then across the next hull along.',
    stats: [
      { stat: 'maxShield', kind: 'add', value: 45 },
      { stat: 'maxIntegrity', kind: 'add', value: -18 },
    ],
    weight: 6,
  },

  /**
   * Armour paid for in scrap. +30 integrity is +21% effective health for -20% income,
   * roughly -160 scrap a sector — a little over one common at the shop.
   *
   * Deliberately the cheapest of the four armour prices, because scrap is the only
   * one of them the player can *recover*: Assay Office, Ledger Skim and the overkill
   * economy all sell it back, and none of them sell back hull speed or fire rate.
   * An armour item with a repayable price should cost more armour-per-point than one
   * with a permanent price, so this pays 30 where Bulkhead Seal pays 45.
   */
  'salvage-plating': {
    id: 'salvage-plating',
    name: 'Salvage Plating',
    tier: 'uncommon',
    tags: ['defence', 'economy'],
    mechanism:
      '+30 max integrity, from 100 to 130, and 20% less scrap from every source.',
    flavour: 'Cut from recoverable stock, which is why it is no longer recoverable stock.',
    stats: [
      { stat: 'maxIntegrity', kind: 'add', value: 30 },
      { stat: 'scrapMultiplier', kind: 'mul', value: 0.8 },
    ],
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

  // ---- M5 rares -----------------------------------------------------------

  /**
   * The roster's only `projectilesPerShot` item, and it is worth understanding why
   * that stat needed a cost attached.
   *
   * `projectilesPerShot` and `splitShot` feed the same fan, but with no split item
   * held the spread is 0 and `volleyAngles` puts an odd leftover on the CENTRE line
   * rather than off to one side. So +1 projectile with nothing else is literally two
   * rounds dead ahead: +100% single-target damage, which is rare-tier on its own and
   * far past the +50% an uncommon may reach.
   *
   * The +1 tick pays for it. 2 rounds at 15 shots/second is 30 rounds/second against
   * a base 20 — +50% output, delivered in heavier, slower volleys. That reshaping is
   * the item: it is worth more than +50% to a build with `pierce` or a chain (both
   * scale per round, not per second) and worth less to one built on the fire-rate
   * window.
   */
  'twin-mount': {
    id: 'twin-mount',
    name: 'Twin Mount',
    tier: 'rare',
    tags: ['weapon'],
    mechanism:
      'Every volley fires 2 rounds instead of 1, and fire rate drops from 20 to 15 shots per second.',
    flavour: 'Two barrels, one trigger, and a requisition for the second barrel pending.',
    stats: [
      { stat: 'projectilesPerShot', kind: 'add', value: 1 },
      { stat: 'fireIntervalTicks', kind: 'add', value: 1 },
    ],
    weight: 3,
  },

  /**
   * A curse that removes a whole resource rather than shrinking one.
   *
   * `mul: 0` on `maxShield` is deliberate and it is not a rounding hazard: the fold
   * sums adds first, so Shield Cell's +22 and Dispersal Plate's +45 are all inside
   * the number that gets multiplied to nothing. The mechanism says "falls to 0" and
   * means it, whatever else is held.
   *
   * Effective health 140 to 100 (-29%) for +35% damage. The play change is bigger
   * than the numbers: with no buffer, EVERY hit is integrity loss, so the run has no
   * free mistakes at all and the 20-tick invulnerability window becomes the only
   * defence. Paired with Repair Nanites (`exposed-nanites`) that inverts into the
   * roster's purest attrition build — nothing is wasted absorbing, everything is
   * healed back.
   *
   * Tagged `cursed` and `weapon`, NOT `defence`, for the same reason Cursed Hull is:
   * it touches `maxShield`, but offer weighting that reads `defence` as "this player
   * wants to survive" must never be handed an item that deletes their shield.
   */
  'exposed-core': {
    id: 'exposed-core',
    name: 'Exposed Core',
    tier: 'rare',
    tags: ['cursed', 'weapon'],
    mechanism:
      'Max shield falls to 0, and +35% projectile damage, from 4 to 5.4 — every hit now lands on integrity.',
    flavour: 'The shielding was recovered for a hull whose pilot had seniority.',
    stats: [
      { stat: 'maxShield', kind: 'mul', value: 0 },
      { stat: 'projectileDamage', kind: 'mul', value: 1.35 },
    ],
    weight: 3,
  },

  /**
   * The per-shot damage rare, sitting opposite Warheads' per-shot *multiplier*.
   *
   * x2 damage and one whole tick of cooldown: 8 damage at 15 shots/second is 120 dps
   * against a base 80 (+50%), the same headline as Feed Relay from the opposite
   * direction. What differs is everything that scales per *hit* rather than per
   * second — `chainOnHit` arcs for a fraction of damage dealt, `scrapOnOverkill`
   * converts damage past a kill, and both roughly double here while a fire-rate item
   * leaves them flat. That is the reason this is not just Warheads again.
   *
   * The overkill interaction it creates is real and intended: 8 damage into a
   * 12-integrity Mine wastes 4 on every second shot.
   */
  'overpressure-shells': {
    id: 'overpressure-shells',
    name: 'Overpressure Shells',
    tier: 'rare',
    tags: ['weapon', 'explosive'],
    mechanism:
      '+100% projectile damage, from 4 to 8, and fire rate drops from 20 to 15 shots per second.',
    flavour: 'Stored separately from the crew for reasons the storage manual declines to give.',
    stats: [
      { stat: 'projectileDamage', kind: 'mul', value: 2 },
      { stat: 'fireIntervalTicks', kind: 'add', value: 1 },
    ],
    weight: 3,
  },

  /**
   * Lance Rounds at rare scale, plus the projectile speed that makes piercing work.
   *
   * The speed is not a rider. A piercing round only pays when the shots line up
   * behind each other, and at 620 u/s a `column` formation drifts enough during the
   * 1.16 s crossing that the second and third hulls have moved off the line. 820 u/s
   * cuts that to 0.88 s, which is inside the drift of every sector-1 formation
   * except a full-speed Lancer dive.
   */
  'harmonic-lance': {
    id: 'harmonic-lance',
    name: 'Harmonic Lance',
    tier: 'rare',
    tags: ['weapon', 'electric'],
    mechanism:
      'Every projectile passes through 2 extra enemies, and projectile speed rises from 620 to 820 units per second.',
    flavour: 'Resonant, in the sense that things behind the target also stop working.',
    stats: [{ stat: 'projectileSpeed', kind: 'add', value: 200 }],
    effects: [{ kind: 'pierce', on: 'onFire', count: 2 }],
    weight: 3,
  },

  /**
   * The economy rare. +60% income and a pickup radius of 84 units, which is a 6.1x
   * collection *area* over the base 34 — radius is felt as a disc, so the area is the
   * number that matters.
   *
   * Both halves rather than a bigger multiplier, because scrap the player never flew
   * to is not multiplied by anything. On a ~800-scrap sector this is ~1280 before the
   * radius recovers anything, which funds a relic at the late shop (80 x 3.2 x 2.38 =
   * 609) in a run that would otherwise have bought two commons.
   *
   * `mul` on the multiplier and `add` on the radius, so it composes with Scrap Magnet
   * (radius 34 + 26 + 50 = 110) rather than replacing it.
   */
  'assay-office': {
    id: 'assay-office',
    name: 'Assay Office Link',
    tier: 'rare',
    tags: ['economy'],
    mechanism: '+60% scrap from every source, and pickup radius 34 to 84 units.',
    flavour: 'Valuation is performed remotely by a party with no interest in your survival.',
    stats: [
      { stat: 'scrapMultiplier', kind: 'mul', value: 1.6 },
      { stat: 'pickupRadius', kind: 'add', value: 50 },
    ],
    weight: 3,
  },

  /**
   * The immovable object, and Vector Thrusters' deliberate opposite — they are
   * authored as a pair so the mobility axis has two ends rather than one direction.
   *
   * +60 integrity is 160, effective health 200 (+43%). -28% hull speed is 151 u/s,
   * which is the first item in the roster that puts the hull BELOW sector 1's fastest
   * projectile (130 u/s is close enough that a Turret fan can no longer be simply
   * outrun). That is the real cost and the real change: this build cannot dodge
   * laterally, so it has to pre-position and absorb, and `bunker-optics` is the
   * interaction that pays it for doing so.
   */
  'inertial-lattice': {
    id: 'inertial-lattice',
    name: 'Inertial Lattice',
    tier: 'rare',
    tags: ['defence', 'mobility'],
    mechanism:
      '+60 max integrity, from 100 to 160, and -28% hull speed, from 210 to 151 units per second.',
    flavour: 'Certified immovable. The certification does not distinguish that from stuck.',
    stats: [
      { stat: 'maxIntegrity', kind: 'add', value: 60 },
      { stat: 'hullSpeed', kind: 'mul', value: 0.72 },
    ],
    weight: 3,
  },

  /**
   * The other end of the mobility axis: 300 u/s is +43%, and it is the fastest the
   * roster goes.
   *
   * At 300 the hull crosses the 448-unit playfield in 1.5 seconds, which is faster
   * than a Heavy Turret can re-aim, so a build holding this dodges by *leaving* the
   * pattern rather than by threading it. The -25% integrity is what stops that being
   * free — 75 integrity survives three Lancer dives, not four.
   *
   * `mul` on integrity and `add` on speed: the mul means the cost stays proportional
   * in a build that has stacked armour adds, so this never becomes a free pick for a
   * tank.
   */
  'vector-thrusters': {
    id: 'vector-thrusters',
    name: 'Vector Thrusters',
    tier: 'rare',
    tags: ['mobility'],
    mechanism:
      '+90 hull speed, from 210 to 300 units per second, and -25% max integrity, from 100 to 75.',
    flavour: 'Recovered from a hull that was, by every account, leaving.',
    stats: [
      { stat: 'hullSpeed', kind: 'add', value: 90 },
      { stat: 'maxIntegrity', kind: 'mul', value: 0.75 },
    ],
    weight: 3,
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

  // ---- M5 relics ----------------------------------------------------------

  /**
   * The hull becomes almost entirely shield: 130 buffer over a 40-integrity core, 170
   * effective health against a base 140.
   *
   * Read as a total it is a +21% health relic, which would be dull. Read as a shape
   * it is the most lopsided defensive item in the roster, because **none of the 130
   * comes back and the 40 that can be repaired is a rounding error**. Repair Nanites
   * is nearly worthless here; what matters instead is that a single Lancer dive (24)
   * costs 18% of the buffer and 0% of the core, so the build can trade hits freely
   * right up until it abruptly cannot.
   *
   * `add` on shield and `mul` on integrity, and that asymmetry is the interaction:
   * adds fold first, so integrity bought BEFORE the write-off survives it at 40 cents
   * on the point (Bulkhead Seal's +45 becomes +18 after the x0.4). `bulkhead-bond`
   * exists because that arithmetic is worth teaching.
   */
  'total-loss-cover': {
    id: 'total-loss-cover',
    name: 'Total Loss Cover',
    tier: 'relic',
    tags: ['cursed', 'defence'],
    mechanism:
      '+90 max shield, from 40 to 130, and -60% max integrity, from 100 to 40 — 170 effective health, almost none of it repairable.',
    flavour: 'The hull is covered. Coverage begins after the hull is confirmed destroyed.',
    stats: [
      { stat: 'maxShield', kind: 'add', value: 90 },
      { stat: 'maxIntegrity', kind: 'mul', value: 0.4 },
    ],
    weight: 2,
  },

  /**
   * +80% damage for -75% income. The most expensive curse in the roster and the only
   * one whose cost is entirely economic.
   *
   * 7.2 damage per shot at the base 20 shots/second is 144 dps. ~800 scrap becomes
   * ~200, which does not buy the cheapest common at either shop — so a run holding
   * this has effectively opted out of the shop system for the rest of the sector.
   * That is a genuinely different run rather than a smaller number, and it is why the
   * cost is stated as a percentage of income rather than buried.
   *
   * The way out is declared: `liquidation-overkill` converts the wasted damage back
   * into scrap at 100%, which is only worth anything *because* the shells overkill
   * almost everything they touch. A relic whose curse has a specific answer is a
   * build; one whose curse has none is a trap.
   */
  'liquidation-order': {
    id: 'liquidation-order',
    name: 'Liquidation Order',
    tier: 'relic',
    tags: ['cursed', 'weapon', 'economy'],
    mechanism:
      '+80% projectile damage, from 4 to 7.2, and 75% less scrap from every source.',
    flavour: 'Assets are to be realised immediately. You are listed among the assets.',
    stats: [
      { stat: 'projectileDamage', kind: 'mul', value: 1.8 },
      { stat: 'scrapMultiplier', kind: 'mul', value: 0.25 },
    ],
    weight: 2,
  },

  /**
   * The volley-shape relic: seven rounds across 70 degrees at 2.4 damage each,
   * every one piercing.
   *
   * 16.8 damage a volley against the base 4 is +320% on paper, and the 70-degree arc
   * is what makes that honest. Over 200 units of travel the outermost rounds sit ~140
   * units either side of the centre line — wider than the widest formation spacing in
   * sector 1 (150 across, so ~75 either side). So a single hull essentially never
   * takes more than one or two rounds, and the item's actual output against a lone
   * Turret is *below* base. It deletes waves and struggles with elites, which is a
   * shape no other item in the roster has.
   *
   * The x0.6 damage is not a nerf bolted on: it is what keeps `chainOnHit` and
   * `scrapOnOverkill` (both proportional to damage dealt) from turning seven weak
   * rounds into seven strong economies. `pierce` is included rather than left to an
   * interaction because a shotgun that stops at the first hull in a lane is not a
   * shotgun.
   */
  'buckshot-manifold': {
    id: 'buckshot-manifold',
    name: 'Buckshot Manifold',
    tier: 'relic',
    tags: ['weapon', 'explosive'],
    mechanism:
      'Fires 6 extra projectiles per shot across a 70-degree arc, each passing through 1 extra enemy, at 40% less damage — 2.4 a round, 7 rounds a volley.',
    flavour: 'Manifolded from parts of several weapons, none of which were this weapon.',
    stats: [{ stat: 'projectileDamage', kind: 'mul', value: 0.6 }],
    effects: [
      { kind: 'splitShot', on: 'onFire', count: 6, spreadDegrees: 70 },
      { kind: 'pierce', on: 'onFire', count: 1 },
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
