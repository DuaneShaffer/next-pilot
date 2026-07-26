/**
 * Hull definitions.
 *
 * `docs/DESIGN.md` names eight hulls and states, for each, **a drawback that shapes
 * play**. That is the specification this file implements. The rule underneath it is
 * the one that decides whether the roster is content or decoration:
 *
 *   A strictly-worse hull is one nobody picks. A strictly-better hull makes every
 *   other hull decoration.
 *
 * So every hull except `lien` moves at least one stat in the player's favour and at
 * least one against, and `tests/hulls.test.ts` enforces that **structurally** — by
 * resolving each hull's modifiers through `src/sim/stats.ts` and signing them with
 * the stat table's own `lowerIsBetter` flag — rather than by a reviewer eyeballing a
 * diff.
 *
 * ## Hulls speak the same vocabulary items do
 *
 * A hull is a `StatModifier[]` plus, where a number cannot say it, an `EffectDef[]`.
 * That is the whole reason a hull and an item compose without either knowing about
 * the other: both fold into the same stat table in the same fixed order (adds
 * summed, then muls, then the stat's own bounds), so "Plating Shim on a Probate" has
 * exactly one answer and it does not depend on which arrived first.
 *
 * ## `mechanism` STATES NO FIGURES, AND THAT IS THE POINT
 *
 * Every hull's prose used to restate the numbers the selection card already computes:
 * "+42 hull speed, 210 to 252" in a sentence, directly above a table row reading
 * `Hull speed 210 → 252 u/s (+42)`. One fact in two places, one of them hand-written.
 * That is not a tidiness complaint — it is the exact failure `docs/ROADMAP.md` records
 * as R12 (three certification cards selling hulls that had been rebalanced underneath
 * them) and as five stale HP comments in `content/bosses.ts`. A balance change edits
 * `stats`, the table follows because it is derived from `resolveStat`, and the sentence
 * keeps advertising the hull that used to exist.
 *
 * So the division is fixed: **the card's table owns every figure, and `mechanism` owns
 * what a table cannot say** — what the hull is for, how it wants to be flown, and which
 * mechanics its stat line interacts with (`Collateral` taking every hit on integrity,
 * `Surety`'s armour all sitting in the layer that absorbs first, `Probate`'s relic
 * refilling the pool the write-down shrank). `tests/hulls.test.ts` enforces the first
 * half by failing on any number-like token in a hull's prose, with an allowlist that
 * cannot be used to launder a stat value back in; `tests/hullSelect.test.ts` enforces
 * the second half by requiring the card to print every figure the prose gave up, so
 * nothing was dropped rather than moved.
 *
 * ## Three of the eight are NOT here, and that is deliberate
 *
 * `Escrow`, `Indemnity`, and `Writ` are defined by mechanics the simulation does not
 * have. Each could be shipped as a plausible-looking stat spread wearing the right
 * name — and that would be the worst outcome available, because the player would
 * read a drawback on the selection screen that never happens. `docs/DESIGN.md`
 * already records this failure mode for items ("a synergy list written before the
 * effect system exists will contain combinations the system cannot express") and the
 * lesson transfers exactly. They are listed in `HULLS_AWAITING_MECHANICS` with the
 * specific mechanic each one needs, so the gap is data rather than folklore.
 *
 * `Surety` and `Collateral` ship in **reduced form**, which is a different thing from
 * faking one: in both cases the drawback the design names is real and present, and
 * only part of the upside is missing. The comments on each say exactly what is
 * absent. Nothing on a hull card describes a behaviour that does not occur.
 *
 * ## What every number below is measured against
 *
 * The same five facts `items.ts` and `enemies.ts` are tuned against: **100 integrity
 * plus 40 shield** (140 effective health, and the shield does not regenerate — see
 * `applyHullDamage`), **210 units/second**, and **20 shots/second at 4 damage, so 80
 * damage per second**. Every modifier here is quoted as a percentage of one of those
 * in its comment.
 *
 * ## Nothing has been swept yet
 *
 * `docs/ROADMAP.md` M5 exits on "every hull within 15 percentage points of the mean"
 * clear rate, which is a bot-sweep measurement and cannot be done from a content
 * file. The numbers below are reasoned, not measured. Where a hull is most likely to
 * come back over- or under-tuned, the comment names the single dial to turn.
 */

import type { HullDef } from './types'

/**
 * The baseline hull's id, exported because more than one caller needs to special-case
 * it: it is always offered (`docs/DESIGN.md`), it is the only entry in
 * `BASE_POOL.hulls`, and it is the one hull exempt from the both-directions rule.
 */
export const LIEN_ID = 'lien'

/**
 * Hulls `docs/DESIGN.md` specifies that this milestone cannot honestly express, with
 * the mechanic each is waiting on.
 *
 * Written as data for the same reason `docs/DESIGN.md` keeps its rejected synergies
 * rather than deleting them — the reasoning is the useful part — and because
 * `src/content/certifications.ts` already grants `writ`. A certification that unlocks
 * a hull which does not exist is exactly the kind of dangling reference that survives
 * a typecheck, so `tests/hulls.test.ts` requires every certification hull grant to be
 * either a real hull or a named entry in this list.
 */
export const HULLS_AWAITING_MECHANICS: readonly { id: string; name: string; needs: string }[] = [
  {
    id: 'escrow',
    name: 'Escrow',
    needs:
      'Drone entities: a persistent friendly entity with its own weapon, inheriting the ' +
      'player weapon stats, destructible and not respawned. Nothing in the sim spawns a ' +
      'friendly. The `drone` item tag exists and nothing reads it.',
  },
  {
    id: 'indemnity',
    name: 'Indemnity',
    needs:
      'A deferred damage queue in src/sim/damage.ts: damage enqueued with a due tick and ' +
      'applied later, visible on the HUD while pending, and cancellable or reducible in ' +
      'between. applyHullDamage subtracts immediately and there is no EffectKind that holds ' +
      'state across ticks.',
  },
  {
    id: 'writ',
    name: 'Writ',
    needs:
      'A phase state on the hull: a player-triggered invulnerability period with its own ' +
      'input action, a charge that firing consumes faster, and a HUD readout. There is no ' +
      'input for it (InputSnapshot is the whole contract), no EffectKind for it, and the ' +
      'existing HULL_INVULN_TICKS is damage-triggered rather than player-triggered.',
  },
]

/**
 * Hulls that exist here but that no pool currently offers.
 *
 * `BASE_POOL.hulls` is `['lien']` and the certification roster grants `arrears` and
 * `writ`. Nothing grants these three, so they are authored content the player cannot
 * reach — the same class of defect as an item with `weight: 0` nobody meant to set.
 * Fixing it means editing `src/content/certifications.ts`, which this milestone's
 * hull work does not own, so the gap is recorded rather than silently left.
 *
 * The test that reads this only requires that an unreachable hull be *named* here; a
 * hull listed here that later becomes reachable still passes, so adding the grants
 * does not mean editing this list at the same moment.
 */
export const HULLS_PENDING_POOL_PLACEMENT: readonly string[] = ['surety', 'probate', 'collateral']

export const HULLS: Record<string, HullDef> = {
  /**
   * THE BASELINE. No modifiers, no starting items, no scrap.
   *
   * `docs/DESIGN.md` gives Lien the drawback "None. The baseline everything else is
   * measured against", and that is load-bearing rather than a shrug: every other
   * hull's mechanism line quotes a before-and-after, and the "before" has to be a
   * hull somebody can actually fly. If Lien carried even a small modifier, the stat
   * table's bases would stop describing any real ship and every number in
   * `items.ts` and `enemies.ts` — all tuned against 140 effective health and 80 dps
   * — would be tuned against nothing.
   *
   * `tests/hulls.test.ts` asserts the emptiness directly *and* asserts that this
   * mechanism line quotes the live values out of `STATS`, so a change to the stat
   * table that leaves this sentence behind is a test failure rather than a hull card
   * quietly lying about what the player is flying.
   */
  lien: {
    id: LIEN_ID,
    name: 'Lien',
    mechanism:
      'Company baseline. Nothing has been forfeited on it and nothing is owed against it, which is the whole of its character.',
    flavour: 'Issued by default. Recovered by default.',
    stats: [],
  },

  /**
   * FAST, FRAGILE, FUNDED.
   *
   * Speed is bought with effective health and paid for at launch. +42 hull speed is
   * +20%, chosen against the sector-1 projectile ceiling rather than against the
   * base: the fastest enemy shot travels at 130 u/s, so Lien already out-runs
   * everything and the extra 42 buys *reaction margin*, which is the currency Thrust
   * Trim sells one third of.
   *
   * -20 integrity and -10 shield is 140 effective health down to 110, a 21% cut.
   *
   * ## It was -32% (95 effective health), and that made it the worst hull by far
   *
   * Over 300 aggressor runs on each of two base seeds, Arrears cleared at 18.7% and
   * 22.0% against hull means of 43.9% and 47.7% — **-25.3 pp and -25.7 pp**, against
   * a 15 pp M5 budget. It was also weakest in sector one *alone*, so this was never a
   * late-scaling problem.
   *
   * The comparison that sized the fix: Collateral takes a 29% cut to effective health
   * and lands within 2 pp of the mean, because it is paid in +50% output. Surety
   * takes a 50% increase and landed +14 pp. Arrears was taking Collateral's price and
   * being paid in speed and scrap, and the measurement says those are worth a
   * fraction of what damage is worth — at 210 u/s the hull already out-runs the
   * fastest sector-1 projectile (130 u/s) by 1.62x, so +42 buys reaction margin the
   * pilot largely already had.
   *
   * So the cut comes down to 21% and the funding goes up. Arrears is still the second
   * most fragile hull in the roster, which is its identity; it is no longer paying
   * Collateral's price for a third of Collateral's return.
   *
   * 320 starting scrap is ~40% of a full sector-1 yield (~800), and against a
   * measured median cheapest shop option of 190 it is the difference between
   * "something is affordable" and "the thing you want is". That is the half of the
   * fantasy that can be paid out in a number, so it is where the compensation goes
   * rather than into more speed, which measurably buys little.
   *
   * ## THE PART THAT IS MISSING, AND IT IS THE DESIGNED DRAWBACK
   *
   * `docs/DESIGN.md` gives Arrears "elite enemies spawn more often" as its defining
   * drawback. There is nowhere to write it: `HullDef` carries stats, effects,
   * starting items and starting scrap, and the elite rate lives in the spawner's
   * wave scripts. Expressing it needs a hull-supplied spawn-table bias — an
   * `eliteWeightMultiplier`-shaped field on `HullDef` that `src/sim/spawner.ts`
   * reads when it selects a formation.
   *
   * So the mechanism line does **not** mention elites. Fragility stands in for the
   * risk half of the fantasy, which is honest but weaker: it is a flat cost rather
   * than a cost that arrives as harder fights. When the spawner gains that hook,
   * some of the -30 integrity should be handed back and the elite bias should carry
   * the risk instead.
   */
  arrears: {
    id: 'arrears',
    name: 'Arrears',
    mechanism:
      'Fast and funded, and thin enough to feel it: flies out of trouble rather than tanking it, and shops before it has earned.',
    flavour: 'The advance against your recovery has already been drawn. By someone else.',
    stats: [
      { stat: 'hullSpeed', kind: 'add', value: 42 },
      { stat: 'maxIntegrity', kind: 'add', value: -20 },
      { stat: 'maxShield', kind: 'add', value: -10 },
    ],
    startingScrap: 320,
  },

  /**
   * HEAVY, SHIELD-FORWARD, SLOW.
   *
   * +70 shield takes effective health from 140 to 210, a 50% increase, and all of it
   * lands in the resource that absorbs first. -55 hull speed is the price and it is
   * a much bigger one than it looks: at 155 u/s the hull is only 1.19x the speed of
   * the fastest sector-1 projectile, where Lien is 1.62x. Surety cannot out-run a
   * pattern; it has to already be in the right place. That is the drawback, it is
   * real, and it is what the extra shield is for.
   *
   * -10 pickup radius (34 to 24) halves the collection *area* — radius is felt as a
   * disc, not a distance. Pairing it with the speed cut is the second-order cost of
   * being heavy: a slow hull that also has to fly over each piece of scrap collects
   * meaningfully less of it, so the economy tightens without a `scrapMultiplier`
   * penalty that would read as arbitrary punishment.
   *
   * ## THE +1 PROJECTILE DAMAGE IS GONE, on this file's own instructions
   *
   * The tuning note at the bottom of this comment said: "if a sweep says Surety
   * over-clears, the number to turn is the damage, not the shield". The sweep said so
   * — 58.0% and 63.3% against hull means of 43.9% and 47.7%, **+14.1 pp and
   * +15.7 pp**, the second largest departure in the roster and outside the 15 pp
   * budget on one of the two seeds.
   *
   * So the flat +1 is removed and Surety fires the base 4 damage at 80 dps. What is
   * left is exactly the hull the design describes: 210 effective health, all of it in
   * the resource that absorbs first, bought with 155 u/s and half the pickup area.
   * Nothing on the card ever claimed the +1 was the shield conversion, so nothing on
   * the card has to be walked back.
   *
   * The reserve dial below is unchanged and still unused.
   *
   * ## THE MISSING HALF: shield damage does not become weapon charge
   *
   * `docs/DESIGN.md` wants Surety to convert absorbed shield damage into weapon
   * charge, so it *wants* to be grazed. That needs the `onShieldAbsorbed` hook the
   * design document already records as missing (see the Retaliation Coil note there)
   * **plus** a charge resource that accumulates and spends — no `EffectKind` holds
   * state across triggers, which is the same wall `Cursed Hull + Repair Nanites` hit.
   *
   * The two effects that look close are both traps. `retaliate` fires on
   * `onHullDamaged`, which is *after* shields absorb, so a 110-point shield means
   * strictly fewer triggers — the exact anti-synergy DESIGN.md says not to ship.
   * `fireRateWindow` is opened by the simulation on scrap collection regardless of
   * what an `EffectDef` declares in its `on` field, so hanging one off a shield hit
   * would typecheck, read correctly, and never fire.
   *
   * So the payout the conversion would have produced is paid **up front and
   * unconditionally** as +1 damage. Same fantasy — the shield is part of the weapon
   * system — without the feedback loop, and nothing on the card claims the loop
   * exists. When `onShieldAbsorbed` lands, this +1 should become the conversion and
   * the flat bonus should go.
   *
   * TUNING DIAL: if a sweep says Surety over-clears, the number to turn is the
   * damage, not the shield. Dropping the +1 costs 20% output; the shield is the
   * hull's whole identity. The alternative, held in reserve, is `fireIntervalTicks`
   * +1 — 15 shots/second at 5 damage is 75 dps, below baseline, which turns Surety
   * into a genuinely patient hull.
   */
  surety: {
    id: 'surety',
    name: 'Surety',
    mechanism:
      'Heavy, and its armour is all shield, the layer that absorbs first. Too slow to dodge a pattern, so it pre-positions instead.',
    flavour: 'The bond is posted against the hull. The hull is expected to come back.',
    stats: [
      { stat: 'maxShield', kind: 'add', value: 70 },
      { stat: 'hullSpeed', kind: 'add', value: -55 },
      { stat: 'pickupRadius', kind: 'add', value: -10 },
    ],
  },

  /**
   * INHERITS A DEAD PILOT'S RELIC, ON A WRITTEN-DOWN HULL.
   *
   * ## The write-down is -36%, up from -28%, and the relic is what it pays for
   *
   * Probate is the roster's strongest hull — +22.3 pp and +13.3 pp above Lien over
   * 200 aggressor runs on each of two seeds — and nothing in its stat line accounts
   * for it: effective health 124 against Lien's 140, identical incoming damage rate.
   * The cause is Repair Nanites, the roster's only integrity recovery, compounding
   * over fifteen minutes. Confirmed rather than inferred: handing the baseline Lien
   * the same starting item and changing nothing else took it from 26.7% / 34.0% to
   * 68.7% / 63.7%. The relic was cut on the strength of that (see `items.ts`), and
   * this hull additionally pays more for holding it.
   *
   * ## THE EXPLANATION THIS BLOCK USED TO GIVE WAS AN ARTEFACT
   *
   * It said Probate "arrived at each sector near full health
   * (100/93/100/96/100% against Lien's 100/58/63/67/83%)". Those numbers came from
   * `medianEntryHealthPct`, which divided by the CURRENT shield instead of the
   * maximum — so the shield cancelled out of the fraction, and a hull with a *larger*
   * max shield read as healthier than it was. Corrected, the two hulls arrive at
   * essentially the same fraction:
   *
   *   Probate  100/43/48/53/72   and  100/39/47/44/61
   *   Lien     100/41/44/45/51   and  100/39/42/42/53
   *
   * And in absolute effective HP Probate is WORSE in sector two — 0.43 x 124 = 53
   * against Lien's 0.41 x 140 = 57 — and better only by sector five. So the advantage
   * is real and the mechanism is real, but "it arrives healthy" was the metric's bug
   * rather than the hull's behaviour. Recorded because a plausible explanation attached
   * to a correct conclusion is the hardest kind of wrong thing to notice later.
   *
   * -36% max integrity as a `mul` rather than an `add`, deliberately. The fold order
   * sums adds before applying muls, so a Plating Shim on a Probate is
   * (100 + 18) x 0.64 = 76 rather than 82: the write-down stays proportional to
   * whatever the build becomes instead of being outgrown by the third integrity item.
   * `cursed-hull` uses `mul` for the same reason and the two compose predictably.
   *
   * +20 max shield is the estate's other half. Effective health lands at 124 against
   * Lien's 140 — close but under — and the *composition* is different in a way that
   * shapes play: the shrunken half is integrity, which is the half that ends runs and
   * the half Repair Nanites refills. A Probate holding the relic tops out sooner, so
   * the trickle is worth less late in a fight and worth more between waves. That is
   * the drawback doing work rather than a number being smaller.
   *
   * ## THE PART THAT IS MISSING: the relic is not random
   *
   * `docs/DESIGN.md` says "starts with a random relic". `startingItems` is a fixed
   * list of ids, and drawing one would need a `startingItemPool`-shaped field plus a
   * roll off a named Rng stream at hull selection — new randomness gets its own
   * stream (CLAUDE.md contract 1) precisely so it does not shift every downstream
   * roll and invalidate the replay corpus.
   *
   * So Probate starts with a *named* relic and the card says which. That loses the
   * run-to-run variety the design wanted and keeps the mechanism honest, which is the
   * right way round: a card promising a random relic that always hands over the same
   * one is a lie the player detects on their second run.
   *
   * Repair Nanites is the choice because it is the roster's only integrity recovery
   * and it interacts with the write-down in both directions — more valuable on a
   * smaller pool, and capped by it.
   */
  probate: {
    id: 'probate',
    name: 'Probate',
    mechanism:
      "Inherits a dead pilot's Repair Nanites on a written-down hull: the write-down comes out of the pool the relic refills.",
    flavour: "The estate was settled. The hull was the only asset anybody wanted.",
    stats: [
      { stat: 'maxIntegrity', kind: 'mul', value: 0.64 },
      { stat: 'maxShield', kind: 'add', value: 20 },
    ],
    startingItems: ['repair-nanites'],
  },

  /**
   * SHIPS WITH A SYSTEM ALREADY FORFEITED.
   *
   * The shield generator is gone — max shield 40 to 0 — and the feed runs open in its
   * place: 3 ticks between shots becomes 2, which is 30 shots/second and 120 dps, a
   * 50% output increase for a 29% cut in effective health (140 to 100).
   *
   * `fireIntervalTicks` moves by a whole-tick `add` because the cooldown is counted in
   * whole ticks and a `mul` would round straight back — `0.85 x 3 = 2.55` fires on
   * exactly the same tick as 3. That trap is documented in `items.ts` and asserted
   * against for hulls too.
   *
   * Losing the shield entirely is worth more than the 40 points suggest, in both
   * directions, and both are the point:
   *
   * - The shield does not regenerate (`applyHullDamage`), so on every other hull it
   *   is a one-off buffer that is gone by mid-run anyway. Collateral simply starts
   *   the run in the state everyone else reaches.
   * - Every hit lands on integrity from the first one, which means `onHullDamaged`
   *   fires every single time. Retaliation Coil on a Collateral triggers on contact
   *   the way it was drawn up, where a shielded hull swallows the first several hits
   *   before the coil ever sees one.
   *
   * ## THE PART THAT IS MISSING: the sacrifice is not a choice
   *
   * `docs/DESIGN.md` gives Collateral "can permanently disable its own systems
   * mid-run for large power spikes". The *choosing* is the mechanic, and it needs a
   * player-initiated action mid-sortie (an input the `InputSnapshot` contract does
   * not carry), a way to mutate resolved stats at runtime outside the inventory fold,
   * and a UI for picking which system goes. All three are simulation changes.
   *
   * What ships is one sacrifice, made at the hangar, permanent, and stated in full on
   * the card: no shield, faster gun. The drawback is real and it happens. The agency
   * is what is absent, and the mechanism line does not imply otherwise.
   */
  collateral: {
    id: 'collateral',
    name: 'Collateral',
    mechanism:
      'The shield generator is forfeited before departure and the feed runs open in its place. Every hit lands on integrity, which is what makes contact-triggered systems fire.',
    flavour: 'Pledged against the sortie. Forfeited before departure, to save time.',
    stats: [
      { stat: 'fireIntervalTicks', kind: 'add', value: -1 },
      { stat: 'maxShield', kind: 'add', value: -40 },
    ],
  },
}

/**
 * Presentation order for the hangar and the selection screen.
 *
 * Lien first because it is always offered and is the reference every other card's
 * before-and-after quotes; the rest by how far they depart from it, so a first-time
 * reader meets the roster in order of how much explaining a card has to do.
 */
export const HULL_ORDER: readonly string[] = ['lien', 'arrears', 'surety', 'probate', 'collateral']

/**
 * Look up a hull definition, throwing on an unknown id.
 *
 * Throws rather than returning undefined for the same reason `getItem` and `getEnemy`
 * do: every caller is either content, a certification grant, or a hull id read back
 * out of a save, and all three are authoring or migration bugs that must fail where
 * they happen rather than becoming a silently missing hull that changes a seeded run.
 *
 * Guards with `Object.hasOwn`. A plain index lookup resolves `constructor` and
 * `toString` to inherited members of `Object.prototype` and would hand back a function
 * typed as a `HullDef`; the enemy lookup shipped that bug once.
 */
export function getHull(id: string): HullDef {
  if (!Object.hasOwn(HULLS, id)) throw new Error(`Unknown hull id: ${id}`)
  return HULLS[id] as HullDef
}
