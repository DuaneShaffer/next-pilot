/**
 * Item interactions.
 *
 * Twenty-eight declared combinations over the forty items in `items.ts`: the seven
 * from M3, unchanged, followed by twenty-one added with the M5 roster. These are the
 * point of M3: `docs/DESIGN.md` bets that depth comes from combinations rather than
 * roster size, and `docs/UI.md` rule 5 requires that a combination the game cannot
 * *explain* does not ship — so every one of them is data with a sentence attached,
 * and the choice screen reads that sentence verbatim.
 *
 * ## THE AUTHORING RULE: which params to write as increments and which as totals
 *
 * `resolveInventory` pushes each held item's effects and then each live
 * interaction's effects into one list, and `src/sim/itemEffects.ts` reduces that
 * list **field by field, with two different rules**:
 *
 *   `count`, `amount`                                        SUM
 *   `spreadDegrees`, `radius`, `fraction`, `bonus`,
 *   `durationTicks`, `chance`                                MAX
 *
 * So an interaction authors an **increment** for a summed field and the **final
 * value** for a maxed one. Getting that backwards is a silent no-op: an interaction
 * declaring `fraction: 0.5` alongside an item's own `fraction: 0.4` does not reach
 * 0.9, it reaches 0.5, and the sentence on the choice screen promising 90% is a lie
 * the game tells with a straight face. Every `fraction`, `chance`, `radius`, `bonus`
 * and `durationTicks` below is therefore written as the number the player will
 * actually observe, and `tests/items.test.ts` runs each interaction through
 * `summariseEffects` to confirm it changes the totals its own two items already
 * produce.
 *
 * Every `text` states the **total** either way — "arcs to 2 enemies instead of 1",
 * not "adds one arc" — because the player is reading it to decide what their gun
 * will do, not to audit the data model. The comment above each interaction shows the
 * arithmetic.
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
 *
 * ## THE GRAPH SHAPE, AND WHY IT IS CAPPED
 *
 * Twenty-eight edges over forty items. Eight items are deliberately standalone (see
 * `STANDALONE_ITEM_IDS` at the bottom), so thirty-two participate, and the degree
 * distribution is:
 *
 *   degree 3  x5   gyro-trim, lance-rounds, flak-spread, scrap-magnet, repair-nanites
 *   degree 2  x14
 *   degree 1  x13
 *
 * **The cap is the point, not the count.** At forty items the failure mode is not a
 * sparse graph but a hub: one item that every synergy runs through turns forty items
 * into one build plus thirty-nine ways of noticing you did not find it. Three edges
 * is the ceiling, `tests/items.test.ts` asserts it, and raising it should be an
 * argued decision rather than the by-product of adding a nice-sounding pair.
 *
 * The five degree-3 items are also spread across four different roles — precision,
 * through-fire, volley width, economy, and recovery — so no *archetype* is a hub
 * either.
 *
 * ## RETALIATION: A CONTRACT BUG FOUND WHILE AUTHORING M5, NOT FIXED HERE
 *
 * `retaliation-coil`'s mechanism says "Shields absorb first, so it fires only on
 * integrity loss", and the note above builds the whole Cursed-Hull-not-Heavy-Shield
 * argument on that reading. **The shipped simulation does not do this.**
 * `applyHullDamage` returns true for any hit it applies, including one absorbed
 * entirely by shield, and `World.onHullHit` then calls `retaliate()` unconditionally
 * with a comment saying it fires "on any hull hit". So the coil currently triggers on
 * shield hits too.
 *
 * That is a one-line disagreement between content text and sim behaviour, and it is
 * in `src/sim/**`, which this file does not own. It is recorded rather than papered
 * over, and it is the reason **M5 adds no new `retaliate` item**: a second item
 * describing the same hook would have to pick one of the two readings, and whichever
 * it picked, one of the two items on the choice screen would be lying. Resolve the
 * trigger first, then the retaliation archetype can have a second member.
 *
 * ## Two more combinations M5 wanted and could not express
 *
 * - **"Damage bonus while focused"** (the obvious partner for `gyro-trim`) needs an
 *   effect that reads input state. Every `EffectKind` is a static numeric
 *   aggregation, by design — see the header of `src/sim/itemEffects.ts` — so a
 *   conditional modifier would need a per-tick evaluation path and its own
 *   determinism argument. `bunker-optics` delivers the flat version instead.
 * - **"Overkill scrap raises fire rate"** (Liquidation Order into Coin-Operated
 *   Cannon) needs one effect to observe another effect's output. That is precisely
 *   the sequential dispatch `itemEffects.ts` says not to introduce quietly, because
 *   it makes the result depend on pickup order. Not shipped.
 */

import type { InteractionDef } from './types'

export const INTERACTIONS: readonly InteractionDef[] = [
  /**
   * The volley item and the chain item. Arc Coupler already arcs from every
   * projectile that hits, including split fragments, so the interaction has to give
   * something the two items do not already give each other: a **second** arc.
   *
   * `count: 1` is an increment (counts sum, so 1 + 1 = 2 arcs). `radius: 130` is a
   * total (radii take the max, so 130 replaces the coupler's 90 for *both* arcs, not
   * just the new one) — which is the intended reading: a wider coupler is a better
   * coupler. `fraction: 0.4` is deliberately equal to the coupler's own rather than
   * lower: authoring 0.35 here would look like a decaying chain and resolve to 0.4
   * anyway under the max rule, so the file would document behaviour that does not
   * happen.
   *
   * Arithmetic behind "9 hits": 3 projectiles x (1 direct + 2 arcs). Damage on a
   * full volley at base 4 is 3 x (4 + 1.6 + 1.6) = 21.6 against 12, spread across up
   * to nine separate enemies. The spread is the actual change — this stops being a
   * damage build and becomes a formation-deleting build.
   */
  {
    id: 'split-arc',
    requires: ['split-shot', 'arc-coupler'],
    text: 'Every hit arcs to 2 enemies instead of 1 and arc reach grows from 90 to 130 units, each arc for 40% of the damage — so one 3-projectile volley can land up to 9 hits.',
    effects: [{ kind: 'chainOnHit', on: 'onProjectileHit', count: 1, radius: 130, fraction: 0.4 }],
  },

  /**
   * The economy engine. Overkill Accounting is deliberately weak at 4 damage; this
   * is the pairing it was priced for.
   *
   * `fraction: 0.9` is a **total**, not an increment — overkill fractions take the
   * max, so this replaces the item's 0.4 outright. Writing 0.5 here in the hope of
   * summing to 0.9 would resolve to 0.5 and quietly halve the payout the text
   * promises.
   *
   * Worked example in the text: a 5.8-damage shell into an enemy with 2 integrity
   * left wastes 3.8, and 3.8 x 0.9 = 3.42 becomes scrap. That is the example because
   * it is the *common* case with Warheads — 5.8 per shot against 12-40 HP sector-1
   * enemies overkills almost every time.
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
    effects: [{ kind: 'scrapOnOverkill', on: 'onEnemyKilled', fraction: 0.9 }],
  },

  /**
   * The greed engine, and the closest thing in the roster to a self-sustaining loop.
   *
   * Coin-Operated Cannon's window is 3 s and sector 1 pays ~800 scrap over ~188 s,
   * so scrap arrives every 2-4 seconds during a fight and the window is *usually*
   * up. This interaction closes that gap from both ends: radius 34 + 26 + 30 = 90
   * units collects scrap the player never flew to, and a 7 s window is longer than
   * any realistic gap between pickups during a fight, so the bonus stops flickering
   * and becomes something the player can plan a pass around.
   *
   * `bonus` and `durationTicks` are **totals**, not increments — both take the max,
   * so these replace the Cannon's 0.18/180 rather than adding to them. There is no
   * "+40% while both windows overlap": the windows do not stack, and the text says
   * "instead of" for exactly that reason.
   *
   * +35% for 7 s is therefore priced as the *whole* payoff of committing two picks
   * to a mechanic that pays nothing while retreating. The build has to fly into the
   * wreckage to keep the meter fed, which is the risk the number is set against.
   */
  {
    id: 'magnet-coin-op',
    requires: ['scrap-magnet', 'coin-op-cannon'],
    text: 'Pickup radius rises to 90 units, and each scrap collected opens a +35% fire-rate window for 7 s instead of +18% for 3 s — at 90 units the next pickup usually arrives before the window closes.',
    stats: [{ stat: 'pickupRadius', kind: 'add', value: 30 }],
    // 420 ticks at 60 Hz is 7 s.
    effects: [{ kind: 'fireRateWindow', on: 'onScrapCollected', bonus: 0.35, durationTicks: 420 }],
  },

  /**
   * Retaliation Coil's declared partner, and the reason it is Cursed Hull rather
   * than Heavy Shield: see the header note. `onHullDamaged` fires only on integrity
   * loss, so what the coil actually wants is a hull that gets hit — and 55 integrity
   * with the base 40 shield means shields break early and hits reach the hull often.
   * The two items point the same way.
   *
   * 6 + 8 = 14 projectiles per hit — `count` is a summed field, so this one really is
   * an increment. Sized against the trade: a cursed hull has two survivable mistakes
   * instead of four, so retaliation has to be worth roughly a volley and a half of
   * the player's own fire (14 against the 3-shot Split Shot volley) to make "take the
   * hit" a decision rather than always wrong.
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
   * Recovery: `amount` sums (2 + 3 = 5) and `chance` takes the max (0.35 beats the
   * item's 0.10), so 0.35 x 5 = about 1.75 integrity per kill against the item's 0.2.
   * Against a 55-integrity hull that is a fundamentally different resource: 31 kills
   * is a full heal, and sector 1 has ~70 kills in it.
   *
   * SCALED WITH THE RELIC rather than independently. Repair Nanites measured +42 pp
   * of clear rate on its own and was cut 60%; leaving this pair at 3.6 per kill would
   * have turned the item's nerf into a buff for the build that was already strongest. The curse stops being a life
   * total and becomes a throughput problem — the hull is fine as long as things keep
   * dying, which is exactly the play pattern the +2 damage is there to support.
   *
   * The damage is `add`, so the curse's x1.5 multiplies it: (4 + 2) x 1.5 = 9 per
   * shot, 180 dps at the base fire rate. That ordering is a property of the fixed
   * fold (adds, then muls) rather than of this interaction, and it is why the bonus
   * is +2 and not +4 — an `add` behind a x1.5 is worth 50% more than it looks.
   */
  {
    id: 'curse-nanites',
    requires: ['cursed-hull', 'repair-nanites'],
    text: 'Kills restore 5 integrity instead of 2, at a 35% chance instead of 10% — about 1.75 integrity per kill against 0.2 — and projectiles gain +2 damage, 9 per shot once the curse multiplies it.',
    stats: [{ stat: 'projectileDamage', kind: 'add', value: 2 }],
    effects: [{ kind: 'repairOnKill', on: 'onEnemyKilled', amount: 3, chance: 0.35 }],
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
   * `pierce` on all three projectiles is the build change. One extra pass-through
   * means each 5.8-damage shell hits 2 enemies, so a volley reaches 3 x 2 = 6 bodies
   * on a `column` or `line` formation — which turns the sector's densest spawns from
   * the hardest thing in it into the most profitable.
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
   * 40 + 35 + 20 = 95 shield, and recovery of 0.28 x (2 + 2) = 1.12 integrity per
   * kill — `amount` sums, `chance` takes the max. Effective health 195, refilling at
   * roughly 1.1 a kill against sector 1's chip damage (Skiff 6, Escort 7, Turret 7
   * per pellet) — so a pilot who keeps
   * killing blunts incoming fire and mostly dies to the big avoidable hits, the
   * 22-24 damage collisions. That is the intended failure mode: this build makes
   * bullets survivable and mistakes fatal, which is the inverse of the cursed route.
   *
   * The `add` on `maxShield` composes with Heavy Shield's own `add` (95, not 75 x
   * something) precisely because both are adds and the fold sums them first.
   */
  {
    id: 'shield-nanites',
    requires: ['heavy-shield', 'repair-nanites'],
    text: 'Max shield rises to 95, and kills restore 4 integrity instead of 2 at a 28% chance instead of 10% — about 1.1 integrity recovered per kill behind a 95-point buffer.',
    stats: [{ stat: 'maxShield', kind: 'add', value: 20 }],
    effects: [{ kind: 'repairOnKill', on: 'onEnemyKilled', amount: 2, chance: 0.28 }],
  },

  // ==========================================================================
  // M5 additions. The seven above are unchanged.
  // ==========================================================================

  /**
   * The precision build's opening pair, and the one that makes `focusFactor` matter.
   *
   * A piercing round only pays when hulls are lined up behind each other, which means
   * holding a lane rather than dodging across it — and holding a lane at 53 u/s of
   * focused speed is a thing a player can actually do, where holding it at 210 is
   * not. So the two items are already pointing the same way; the interaction pays for
   * committing to it.
   *
   * `count: 1` is an increment (pierce counts SUM, so 1 + 1 = 2). The +140 speed is a
   * stat and folds normally: 620 + 140 = 760, cutting the crossing time from 1.16 s to
   * 0.95 s so the second and third hulls in a column have drifted less when the round
   * arrives. The speed is what makes the second pierce land, not a sweetener.
   */
  {
    id: 'lance-focus',
    requires: ['gyro-trim', 'lance-rounds'],
    text: 'Projectiles pass through 2 extra enemies instead of 1 and travel at 760 units per second instead of 620 — one focused pass down a column hits every hull in it.',
    stats: [{ stat: 'projectileSpeed', kind: 'add', value: 140 }],
    effects: [{ kind: 'pierce', on: 'onFire', count: 1 }],
  },

  /**
   * The money run, and the largest economic swing in the roster.
   *
   * 1 x 1.5 (hazard pay) x 1.6 (assay) x 1.25 (this) = 3.0x, and pickup radius
   * 34 + 50 + 40 = 124 units, which is a 13x collection *area* over the base disc.
   * A ~800-scrap sector pays ~2400.
   *
   * Not a stat nudge: at 3x income the shop stops being a place where the player buys
   * the cheapest thing and becomes a place where they buy the *right* thing, twice.
   * That changes which of the other thirty-eight items a run can reach, which is a
   * bigger consequence than any single effect in this file. It is priced against an
   * 80-integrity hull — hazard pay's curse is still being paid the whole time.
   */
  {
    id: 'hazard-assay',
    requires: ['hazard-pay-clause', 'assay-office'],
    text: 'Scrap resolves to 3x base and pickup radius reaches 124 units, so an 80-integrity hull clears a shop’s whole stock at every stop.',
    stats: [
      { stat: 'scrapMultiplier', kind: 'mul', value: 1.25 },
      { stat: 'pickupRadius', kind: 'add', value: 40 },
    ],
  },

  /**
   * Width times depth. Flak Spread covers a lane, Lance Rounds goes through what it
   * finds there, and the pairing is the only build in the roster that can hit an
   * entire `scatter` formation from one position.
   *
   * Both params are increments on SUMMED fields: splitShot 2 + 1 = 3 extras (a
   * 4-projectile volley) and pierce 1 + 1 = 2. `spreadDegrees: 34` is repeated rather
   * than raised because spread takes the MAX — authoring 40 here would silently widen
   * Flak Spread itself, and 34 is already at the limit where the outer rounds start
   * missing the outermost enemy in a median-spaced formation.
   *
   * "Up to 12" is 4 projectiles x 3 hulls each, which is the ceiling rather than the
   * expectation — it needs four occupied lanes three deep.
   */
  {
    id: 'flak-curtain',
    requires: ['flak-spread', 'lance-rounds'],
    text: 'Each volley is 4 projectiles across 34 degrees and every one passes through 2 extra enemies instead of 1 — up to 12 hulls hit from one trigger pull.',
    effects: [
      { kind: 'splitShot', on: 'onFire', count: 1, spreadDegrees: 34 },
      { kind: 'pierce', on: 'onFire', count: 1 },
    ],
  },

  /**
   * Ionised Rounds is priced as an enabler and this is what it enables.
   *
   * `chainOnHit` arcs for a FRACTION OF DAMAGE DEALT, so the chain scales with per-shot
   * damage and not with fire rate. An 8-damage shell is therefore the best possible
   * carrier for it: 0.5 x 8 = 4 per arc, where the base 4-damage round managed
   * 0.25 x 4 = 1. Fire-rate items do nothing for a chain; this is the item that does.
   *
   * `count: 1` increments (1 + 1 = 2 arcs). `radius: 85` and `fraction: 0.5` are
   * TOTALS — both fields take the max, so they replace Ionised Rounds' 55 and 0.25
   * outright rather than adding to them. 85 rather than 90 keeps Arc Coupler strictly
   * the longer-reaching chain item, which is the difference between the two rares.
   */
  {
    id: 'ion-overpressure',
    requires: ['ionised-rounds', 'overpressure-shells'],
    text: 'Each 8-damage shell arcs to 2 enemies instead of 1, within 85 units instead of 55, for 50% of the damage dealt — 4 damage an arc where a base round manages 1.',
    effects: [{ kind: 'chainOnHit', on: 'onProjectileHit', count: 1, radius: 85, fraction: 0.5 }],
  },

  /**
   * The fold order, made playable.
   *
   * Total Loss Cover multiplies integrity by 0.4, and `StatKey`'s fixed fold sums every
   * `add` BEFORE applying any `mul`. So integrity bought before the write-off survives
   * it at 40 cents on the point: Bulkhead Seal's +45 is worth +18 after the multiply,
   * and this interaction's +40 is worth another +16. (100 + 45 + 40) x 0.4 = 74,
   * against 58 for the two items alone and 40 for the relic by itself.
   *
   * Why it is worth an interaction rather than being left as arithmetic: the resulting
   * hull is 74 integrity behind a 170-point shield, 244 effective health, and it is
   * the only build in the roster that can take a Heavy Turret volley on purpose to
   * hold a firing position. It pays for that with Bulkhead Seal's 15 shots/second,
   * which this interaction pointedly does NOT refund — see `sealed-dispersal` for the
   * pairing that does, and note that a player can hold both and get a full-rate 244.
   */
  {
    id: 'bulkhead-bond',
    requires: ['bulkhead-seal', 'total-loss-cover'],
    text: 'Armour fitted before the write-off survives it: max integrity resolves to 74 instead of 58, behind a 170-point shield — 244 effective health at 15 shots per second.',
    stats: [
      { stat: 'maxIntegrity', kind: 'add', value: 40 },
      { stat: 'maxShield', kind: 'add', value: 40 },
    ],
  },

  /**
   * Two speed items stack to 355 u/s, and at 355 the hull has a new problem: it
   * outruns its own scrap and it cannot stop. This fixes both, which is what turns a
   * pile of speed into a playstyle.
   *
   * `focusFactor` 0.45 - 0.25 = 0.20, so focused speed is 355 x 0.2 = 71 u/s — *slower*
   * than the base hull's focused 95 despite being the fastest build in the game. That
   * is the interaction: two gears instead of one, a sprint and a thread, where every
   * other build has a single speed and a mild brake. Pickup radius 34 + 40 = 74 stops
   * the sprint from being economically self-defeating.
   */
  {
    id: 'slip-stream',
    requires: ['slip-thrusters', 'vector-thrusters'],
    text: 'Hull speed reaches 355 units per second, and focus now holds you at 0.20x — 71 units per second — while pickup radius rises to 74 units so the scrap is not left behind.',
    stats: [
      { stat: 'focusFactor', kind: 'add', value: -0.25 },
      { stat: 'pickupRadius', kind: 'add', value: 40 },
    ],
  },

  /**
   * A hull that cannot dodge, firing rounds that do not stop.
   *
   * Inertial Lattice's 151 u/s is below sector 1's fastest projectile, so this build
   * cannot leave a pattern — it has to pick a lane and be right. Four pass-throughs
   * and 1000 u/s is what makes being right sufficient: a round crosses the playfield
   * in 0.72 s, which is short enough that a `column` formation has not meaningfully
   * drifted, so all five hulls in it are still on the line when the round arrives.
   *
   * `count: 2` is an increment (2 + 2 = 4 pass-throughs). Speed 620 + 200 + 180 = 1000,
   * well inside the stat's 2400 ceiling.
   */
  {
    id: 'lattice-lance',
    requires: ['inertial-lattice', 'harmonic-lance'],
    text: 'Rounds pass through 4 extra enemies instead of 2 and travel at 1000 units per second — a 160-integrity hull that holds one lane and empties it.',
    stats: [{ stat: 'projectileSpeed', kind: 'add', value: 180 }],
    effects: [{ kind: 'pierce', on: 'onFire', count: 2 }],
  },

  /**
   * The lien bought out.
   *
   * Salvage Lien takes 55% of income for +2 damage; Assay Office pays 60% more. Held
   * together and without this interaction they resolve to 0.45 x 1.6 = 0.72x — *worse
   * than base*, which is exactly the sort of accidental anti-synergy `docs/DESIGN.md`
   * warns about. The x2.2 here takes it to 1.58x, comfortably above base.
   *
   * So the mechanical consequence is a reversal of sign, not a nudge: two items that
   * cancel each other out become the roster's second-best economy while keeping the
   * lien's +2 damage. That is worth marking on the choice screen precisely because a
   * player looking at 0.45 and 1.6 would reasonably assume the opposite.
   */
  {
    id: 'quota-lien',
    requires: ['salvage-lien', 'assay-office'],
    text: 'The lien is bought out at assay: scrap resolves to 1.58x base instead of 0.72x, and the +2 projectile damage stays.',
    stats: [{ stat: 'scrapMultiplier', kind: 'mul', value: 2.2 }],
  },

  /**
   * Tithe Hopper's version of `magnet-coin-op`, and deliberately the longer, calmer
   * one: 10 seconds at +25% against that pairing's 7 seconds at +35%.
   *
   * `bonus` and `durationTicks` are TOTALS — both take the max, so 0.25 and 600
   * replace the Hopper's 0.12 and 360 rather than adding to them. Pickup radius is an
   * `add` and composes: 34 + 26 + 36 = 96.
   *
   * At 96 units the hull sweeps roughly a fifth of the playfield width, so during a
   * fight the next pickup essentially always arrives before a 10-second window
   * closes. The build change is that the fire-rate bonus stops being a thing the
   * player chases and becomes a baseline they can lose — which is a different, and
   * more interesting, kind of pressure than the Cannon's.
   */
  {
    id: 'tithe-magnet',
    requires: ['tithe-hopper', 'scrap-magnet'],
    text: 'Pickup radius rises to 96 units, and each scrap opens a +25% fire-rate window for 10 s instead of +12% for 6 s — at that radius the window rarely closes mid-fight.',
    stats: [{ stat: 'pickupRadius', kind: 'add', value: 36 }],
    // 600 ticks at 60 Hz is 10 s.
    effects: [{ kind: 'fireRateWindow', on: 'onScrapCollected', bonus: 0.25, durationTicks: 600 }],
  },

  /**
   * The slow hull that fires fast. Bulk Hauler costs 25 hull speed and pays 35% more
   * scrap; more scrap means more window triggers, and the window is fire rate.
   *
   * 1.35 x 1.3 = 1.755x income, and an 8-second window at +22% against the Hopper's
   * 6 s at +12%. Both effect params are TOTALS (max), the scrap multiplier is a `mul`
   * and composes.
   *
   * The reason this is a build and not a rider: a hull at 185 u/s cannot disengage, so
   * it has to kill what is in front of it, and killing what is in front of it is what
   * keeps the window open. The economy loop and the survival loop are the same loop,
   * which is the only self-sustaining structure in the roster besides `magnet-coin-op`.
   */
  {
    id: 'hauler-tithe',
    requires: ['bulk-hauler', 'tithe-hopper'],
    text: 'Scrap resolves to 1.76x base, and each piece opens a +22% fire-rate window for 8 s instead of +12% for 6 s — the slower the hull, the faster the gun.',
    stats: [{ stat: 'scrapMultiplier', kind: 'mul', value: 1.3 }],
    // 480 ticks at 60 Hz is 8 s.
    effects: [{ kind: 'fireRateWindow', on: 'onScrapCollected', bonus: 0.22, durationTicks: 480 }],
  },

  /**
   * Three rounds a volley, each through three hulls.
   *
   * `projectilesPerShot` is a stat and sums with Twin Mount's own `add`: 1 + 1 + 1 = 3.
   * Pierce is an effect and sums too: 1 + 1 = 2 extra pass-throughs. Twin Mount's +1
   * tick stands, so this fires 3 rounds at 15 shots/second — 45 rounds a second
   * against the base 20, in heavy volleys rather than a stream.
   *
   * With no split item held the fan is `[0, -6, +6]` at the default 12-degree spread
   * (see `volleyAngles`), which is tight enough that all three rounds hit a Hauler
   * at close range and spread by ~21 units over 200 units of travel at range. So this
   * is a *column* build, not a crowd build: 9 hulls means three lanes three deep.
   */
  {
    id: 'twin-lance',
    requires: ['twin-mount', 'lance-rounds'],
    text: 'Each volley is 3 rounds instead of 2 and every round passes through 2 extra enemies instead of 1 — up to 9 hulls from one trigger pull at 15 shots per second.',
    stats: [{ stat: 'projectilesPerShot', kind: 'add', value: 1 }],
    effects: [{ kind: 'pierce', on: 'onFire', count: 1 }],
  },

  /**
   * The purest attrition build in the roster, and the one place where deleting your
   * own shield is correct.
   *
   * A shield absorbs damage and then keeps it: nothing in the game refills it. Repair
   * Nanites refills integrity. So a build that intends to out-heal the sector is
   * paying 40 points of its health bar to a pool its own relic cannot touch — and
   * Exposed Core removes exactly that 40 in exchange for +35% damage.
   *
   * `amount: 2` increments (2 + 2 = 4 per kill) and `chance: 0.3` is a TOTAL (max,
   * replacing 0.10). 0.3 x 4 = 1.2 integrity per kill against the relic's 0.2, on a
   * 100-integrity hull with no buffer: 84 kills is a full heal and sector 1 has ~70 in
   * it. The hull is fine exactly as long as things keep dying, which is the same
   * throughput bargain `curse-nanites` makes and a much sharper version of it.
   */
  {
    id: 'exposed-nanites',
    requires: ['exposed-core', 'repair-nanites'],
    text: 'With no shield to absorb, every hit lands on integrity — so kills now restore 4 integrity instead of 2, at a 30% chance instead of 10%, about 1.2 per kill.',
    effects: [{ kind: 'repairOnKill', on: 'onEnemyKilled', amount: 2, chance: 0.3 }],
  },

  /**
   * The answer to the roster's most expensive curse.
   *
   * Liquidation Order pays 25% of normal income, which locks the player out of both
   * shops. Overkill Accounting converts damage past a kill into scrap, and 7.2-damage
   * shells overkill nearly everything sector 1 spawns — a 12-integrity Mine dies to
   * two shells and wastes 2.4, a 24-integrity Skiff dies to four and wastes 4.8, and
   * at 20 shots a second that is scrap arriving continuously rather than in lumps.
   *
   * `fraction: 1` is a TOTAL (max, replacing 0.4) and is the stat's own ceiling:
   * `summariseEffects` clamps overkill to 1, so 100% is the strongest this can ever
   * be and there is no value above it to reach for later. The x3.4 takes income from
   * 0.25x to 0.85x — still below base, deliberately. The curse is answered, not
   * cancelled; buying it out completely would make the relic free.
   */
  {
    id: 'liquidation-overkill',
    requires: ['liquidation-order', 'overkill-accounting'],
    text: 'Overkill converts at 100% instead of 40%, and the write-off is partly bought back: scrap resolves to 0.85x base instead of 0.25x, so the wasted damage funds the shop the order closed.',
    stats: [{ stat: 'scrapMultiplier', kind: 'mul', value: 3.4 }],
    effects: [{ kind: 'scrapOnOverkill', on: 'onEnemyKilled', fraction: 1 }],
  },

  /**
   * Two armour items whose prices cancel.
   *
   * Bulkhead Seal pays a whole tick of cooldown; this refunds it, `add: -1` against
   * the seal's `add: +1`, resolving to the base 3 ticks and 20 shots/second. Integer
   * adds only — `mul` on `fireIntervalTicks` is banned and asserted against, because a
   * whole-tick cooldown rounds a fractional interval straight back.
   *
   * The result is 127 integrity behind a 110-point shield, 237 effective health, at
   * full rate of fire. That is the defensive capstone that does not cost output, and
   * it is two uncommons rather than a relic — which is the intended shape: the cheap
   * route to durability should exist, and should cost two picks and a specific pair
   * rather than a lucky relic.
   */
  {
    id: 'sealed-dispersal',
    requires: ['bulkhead-seal', 'dispersal-plate'],
    text: 'The seal’s fire-rate penalty is cancelled — back to 20 shots per second from 15 — and max shield reaches 110, for 237 effective health behind a full-rate gun.',
    stats: [
      { stat: 'fireIntervalTicks', kind: 'add', value: -1 },
      { stat: 'maxShield', kind: 'add', value: 25 },
    ],
  },

  /**
   * Salvage Plating's price is scrap; Bulk Hauler's product is scrap. Held together
   * they already net 1.35 x 0.8 = 1.08x, and this pushes them to 1.62x while adding
   * 35 more integrity — 165 total.
   *
   * The consequence worth marking is that the armour becomes *free*: a build that was
   * paying 20% of its income for 30 integrity ends up above base income and 65 points
   * heavier. That reverses the item's whole proposition, which is why it is a declared
   * interaction rather than left for a player to work out from two multipliers.
   *
   * Both prices are still real at 185 u/s — the hull is slow, and nothing here fixes
   * that.
   */
  {
    id: 'hauler-plating',
    requires: ['bulk-hauler', 'salvage-plating'],
    text: 'Max integrity reaches 165 and scrap resolves to 1.62x base — the armour cut from unsold salvage stops costing anything at all.',
    stats: [
      { stat: 'maxIntegrity', kind: 'add', value: 35 },
      { stat: 'scrapMultiplier', kind: 'mul', value: 1.5 },
    ],
  },

  /**
   * The widest volley the roster can produce: 10 projectiles across 70 degrees.
   *
   * splitShot counts SUM (6 + 2 + 1 = 9 extras) and `spreadDegrees` takes the MAX, so
   * Flak Spread's 34 disappears into the Manifold's 70 — which is the honest outcome
   * and the reason the text quotes 70 rather than something in between.
   *
   * The x1.6 damage is the interaction's real work. Buckshot Manifold cuts damage to
   * 2.4 a round to stop seven rounds becoming seven economies; at ten rounds that cut
   * has done its job and the build needs the rounds to actually kill things, so damage
   * recovers to 4 x 0.6 x 1.6 = 3.84. 38 damage a volley, spread wide enough that no
   * single hull takes more than two rounds — a wave-deleter that is still bad against
   * an elite, which is the shape the Manifold is for.
   */
  {
    id: 'manifold-curtain',
    requires: ['buckshot-manifold', 'flak-spread'],
    text: 'Each volley is 10 projectiles across 70 degrees at 3.8 damage each — 38 damage a trigger pull, spread across everything in front of the hull.',
    stats: [{ stat: 'projectileDamage', kind: 'mul', value: 1.6 }],
    effects: [{ kind: 'splitShot', on: 'onFire', count: 1, spreadDegrees: 70 }],
  },

  /**
   * The gun emplacement. A hull at 151 u/s that focuses to 23 u/s is, for practical
   * purposes, parked.
   *
   * `focusFactor` 0.45 - 0.20 - 0.10 = 0.15, and 151 x 0.15 = 23 units per second —
   * the slowest the roster goes and slow enough to hold a firing line inside a Heavy
   * Turret's fan rather than crossing it. The +2 damage is `add`, so every
   * multiplicative rare still scales it: with Warheads this build fires (4 + 2) x 1.45
   * = 8.7 from a 160-integrity hull that never moves.
   *
   * The flat bonus is the compromise recorded in the header: "more damage *while*
   * focused" is what this pair wants and is not expressible, because effects are
   * static aggregations and cannot read input state.
   */
  {
    id: 'bunker-optics',
    requires: ['gyro-trim', 'inertial-lattice'],
    text: 'Focus holds the 160-integrity hull at 0.15x speed — 23 units per second — and rounds gain +2 damage, 6 a shot, for a build that parks and empties a lane.',
    stats: [
      { stat: 'focusFactor', kind: 'add', value: -0.1 },
      { stat: 'projectileDamage', kind: 'add', value: 2 },
    ],
  },

  /**
   * Two rares that both pay a tick, stacked: 3 + 1 + 1 = 5 ticks, 12 shots/second.
   * Two rounds of 8 damage each is 16 a volley, 192 dps — and every one of those
   * volleys is now a lance.
   *
   * The pierce is what stops this being a worse Feed Relay. At 12 shots/second the
   * build has *fewer* trigger events than anything else in the roster, so its value
   * has to come from what a single event does: 16 damage across two hulls, at 820
   * u/s so the two hulls are still lined up when it arrives. 620 would not do — over
   * the 1.16 s crossing a `line` formation drifts out of alignment and the pierce
   * hits nothing.
   *
   * Deliberately grants no further fire rate. Refunding a tick here would put the
   * build at 15 shots/second with 3 rounds, and the two rares would stop being a
   * trade at all.
   */
  {
    id: 'heavy-broadside',
    requires: ['twin-mount', 'overpressure-shells'],
    text: 'Both rounds in a volley pass through 1 extra enemy and travel at 820 units per second instead of 620 — 12 volleys a second, 16 damage each, across two hulls.',
    stats: [{ stat: 'projectileSpeed', kind: 'add', value: 200 }],
    effects: [{ kind: 'pierce', on: 'onFire', count: 1 }],
  },

  /**
   * A 300 u/s hull leaves its own scrap behind — it crosses the playfield in 1.5
   * seconds and the drops do not follow. Scrap Magnet's 60-unit radius is sized for a
   * 210 u/s hull and is simply too small at this speed.
   *
   * 34 + 26 + 50 = 110 units, a 10.5x collection area over the base disc, and 1.1 x 1.3
   * = 1.43x income. The consequence is that the speed build stops having to choose
   * between the safe line and the paying line: at 110 units they are the same line,
   * which is the entire reason to fly this way.
   */
  {
    id: 'vector-magnet',
    requires: ['vector-thrusters', 'scrap-magnet'],
    text: 'Pickup radius reaches 110 units and scrap resolves to 1.43x base — at 300 units per second the hull sweeps a lane clean instead of outrunning it.',
    stats: [
      { stat: 'pickupRadius', kind: 'add', value: 50 },
      { stat: 'scrapMultiplier', kind: 'mul', value: 1.3 },
    ],
  },

  /**
   * A five-projectile fan is only useful if it can be held on a target, and a
   * 34-degree fan at 210 u/s sweeps off a formation the moment the player dodges.
   * Focused at 53 u/s it stays put.
   *
   * `count: 2` increments (2 + 2 = 4 extras, a 5-projectile volley) and
   * `spreadDegrees: 34` is repeated rather than raised, for the same reason as
   * `flak-curtain`: spread takes the max and 34 is already at the width where the
   * outer rounds start missing a median-spaced formation. The +100 speed shortens the
   * time the fan spends diverging, which is what keeps five rounds on one wave rather
   * than three on the wave and two past it.
   */
  {
    id: 'curtain-focus',
    requires: ['gyro-trim', 'flak-spread'],
    text: 'Each volley is 5 projectiles across 34 degrees at 720 units per second instead of 620 — a focused hull can hold that fan on one formation for a full pass.',
    stats: [{ stat: 'projectileSpeed', kind: 'add', value: 100 }],
    effects: [{ kind: 'splitShot', on: 'onFire', count: 2, spreadDegrees: 34 }],
  },

  /**
   * Both curses at once: no shield, and the scrap signed away. What is left is damage
   * and the ability to not be where the bullet is.
   *
   * Damage folds adds first: (4 + 2 + 2) x 1.35 = 10.8, which is the highest per-shot
   * figure two non-relic items can produce. Hull speed 210 + 40 = 250.
   *
   * The +40 speed is the mechanical point, not a rider. Exposed Core removes the
   * buffer that makes a mistake survivable, so the build's only remaining defence is
   * position — and a build whose only defence is position needs to be able to reach
   * it. Without the speed this pair is two curses and no answer, which is a trap
   * rather than a synergy.
   */
  {
    id: 'exposed-lien',
    requires: ['exposed-core', 'salvage-lien'],
    text: 'Rounds reach 10.8 damage and hull speed rises to 250 units per second — with the shield gone and the scrap signed away, position is the only defence left.',
    stats: [
      { stat: 'projectileDamage', kind: 'add', value: 2 },
      { stat: 'hullSpeed', kind: 'add', value: 40 },
    ],
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
 *
 * **Eight of forty at M5, up from four of fourteen.** The ratio fell on purpose. A
 * synergy marker is information only if it is sometimes absent, so the standalone set
 * has to keep pace with the roster — but it should grow more slowly than the roster
 * does, because the whole design position is that connectivity beats count. Four in
 * fourteen (29%) to eight in forty (20%) is that trade made explicit.
 *
 * Every entry is still the plainest possible item at its tier. Nothing with a
 * trade-off, a curse, or an effect is on this list: if an item is interesting enough
 * to have two clauses, it is interesting enough to combine with something.
 */
export const STANDALONE_ITEM_IDS: readonly string[] = [
  'machined-slugs',
  'thrust-trim',
  'plating-shim',
  'feed-relay',
  // M5 additions. All commons, all one number moving.
  'barrel-liner',
  'shield-cell',
  'ledger-skim',
  'hull-braces',
]
