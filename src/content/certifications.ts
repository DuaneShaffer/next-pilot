/**
 * Certification definitions — the permanent unlocks.
 *
 * ## The design constraint, and why it is expressed in the *type* rather than a comment
 *
 * `docs/DESIGN.md`: certifications "expand *variety*, not raw power — a roguelike
 * that gets easier with playtime stops being interesting", and it explicitly
 * excludes "currency-purchased permanent stat upgrades" because "they convert a
 * skill problem into a grinding problem".
 *
 * The obvious implementation — +5% damage forever, one extra heart — is precisely
 * what that rules out. So a certification cannot express a number that applies to
 * the pilot. The only thing a `PoolGrant` can say is **"put this id into that
 * pool"**: two fields, `slice` and `id`, and no field anywhere to put a
 * multiplier, a stat key, or an amount in. A future certification physically
 * cannot smuggle power in without changing this type, and
 * `tests/certifications.test.ts` asserts the shape of every grant so that change
 * cannot pass unnoticed.
 *
 * ## Why a bigger pool is not a bigger player
 *
 * The argument that makes item grants legitimate rather than a loophole: **the
 * pool grows, the number of offers per run does not.** A run sees two item rewards
 * and two shops (`ITEM_CHOICE_WAVES`, `SHOP_WAVES`), each a weighted draw of three
 * from the pool. Adding items to the pool changes *which* three, never *how many*.
 * A fully certified player faces a more varied run at the same power budget, and a
 * more varied one at the same difficulty is the whole point.
 *
 * Enemy, hazard, and boss-variant grants push in the opposite direction outright —
 * they add threats. Hull grants are lateral by construction, because every hull in
 * `docs/DESIGN.md` is "defined by a drawback that shapes play", and a hull that is
 * strictly better is a hull nobody ever un-picks.
 *
 * ## Conditions encourage different play, not more play
 *
 * Every condition is a fact about a *single* sortie, so none of them can be
 * satisfied by attrition. There is deliberately no "play N runs" condition and no
 * lifetime counter anywhere in this file — that is the grinding problem the design
 * rejects, wearing an unlock as a hat. Read the ladder as a set of mutually
 * exclusive economies: `unlisted-clearance` wants 400 scrap hoarded,
 * `full-manifest-rating` wants it spent, and `austerity-endorsement` wants nothing
 * fitted at all. One sortie cannot serve two of those, which is what makes them
 * reasons to fly differently.
 *
 * ## Most of these grant content that has not shipped yet, and say so
 *
 * `docs/DESIGN.md` lists what certifications add — hulls, item families, enemy
 * types, boss variants, work-order types. Eight of the ten below carry a non-null
 * `awaiting` naming exactly what they are waiting on, the hangar prints it, and a
 * test enforces that a grant is either live *or* declares itself pending. This is
 * the same call `src/ui/choiceScreen.ts` made with `WORK_ORDER_NOTICE`: a control
 * that silently does nothing is worse than a missing one, so it is labelled instead
 * of implied.
 *
 * The two live ones are real today: `WORK_ORDERS` already defines `vault` and
 * `unlisted` with authored copy, and `World` draws its work-order kinds from
 * `RunContent.workOrders`, which the app fills from `poolFor(...)`.
 *
 * ## "PENDING" NOW MEANS TWO DIFFERENT THINGS, AND THE COPY HAS TO SAY WHICH
 *
 * M5 shipped most of the content these grants name — five hulls, five bosses with
 * variants, five hazards — so a grant can now be pending for a second reason: the
 * content exists and *the run does not draw that slice from the pool*.
 *
 *   - `workOrders` is drawn from the pool. A grant there takes effect.
 *   - `hulls` reaches `poolFor(...).hulls`, but the app issues `pool.hulls[0]`,
 *     which is always the Lien because the base pool is always first. There is no
 *     hull selection screen yet, so a granted hull enters the pool and is never
 *     issued. Every hull grant below says so.
 *   - `bossVariants` and `hazards` are not consulted at all: `pickVariant` reads
 *     `BossDef.variants` directly and hazards are armed from the stage definition.
 *   - `items` and `enemies` are handed to the sim as whole tables, not as pools.
 *
 * Naming the real blocker matters more than it looks. "Content pending: the hull
 * roster" was true in M4 and is now false — the roster shipped — and a hangar that
 * keeps saying it is a hangar that has started lying about a reward that has
 * arrived but cannot be flown.
 */

import { ENEMIES } from './enemies'
import { ITEMS } from './items'

/**
 * The pools a certification may add to.
 *
 * A CLOSED LIST, and `tests/certifications.test.ts` asserts its exact contents.
 * Every entry names a *table of content the run draws from*. None of them names
 * the pilot's own numbers, and that is the invariant the test is protecting: a
 * `'playerStats'` slice would be the design constraint failing, and it would look
 * like a one-word addition here.
 */
export const POOL_SLICES = [
  'items',
  'enemies',
  'workOrders',
  'hulls',
  'bossVariants',
  'hazards',
] as const

export type PoolSlice = (typeof POOL_SLICES)[number]

/**
 * One id entering one pool. The entire vocabulary of a certification's effect.
 *
 * Two fields on purpose. There is nowhere to write a magnitude, so "+5% damage
 * forever" is not a certification anybody has to be talked out of authoring — it
 * is unrepresentable.
 */
export interface PoolGrant {
  readonly slice: PoolSlice
  readonly id: string
}

/**
 * What a run has to do to file a certification.
 *
 * A closed union of data, interpreted by `src/meta/certifications.ts`, for the
 * same reason `MovementKind` and `EffectKind` are closed unions: the condition has
 * to be evaluable, renderable as English, and reportable as progress, and all
 * three have to agree. Authoring a condition as prose plus a predicate is how the
 * card ends up promising something the evaluator does not check.
 *
 * Every field is measured against facts a completed run already records — see
 * `RunSummary`. Nothing here needs a new simulation counter, which is deliberate:
 * a condition the sim cannot answer is a condition the hangar would have to lie
 * about.
 */
export type UnlockCondition =
  /** `waveIndex >= waves`. Depth, the plainest possible first rung. */
  | { readonly kind: 'wavesReached'; readonly waves: number }
  /** `kills >= kills`. Rewards clearing rather than surviving. */
  | { readonly kind: 'killsInRun'; readonly kills: number }
  /** `scrapHeld >= scrap`, at the end of the sortie. Rewards hoarding. */
  | { readonly kind: 'scrapHeld'; readonly scrap: number }
  /** `hits / shotsFired >= percent`, over at least `minShots`. Rewards trigger discipline. */
  | { readonly kind: 'accuracy'; readonly percent: number; readonly minShots: number }
  /** `waveIndex >= waves` with nothing fitted. Rewards declining every reward. */
  | { readonly kind: 'bareHull'; readonly waves: number }
  /** `combinationsLive >= combinations` at the end. Rewards building, not collecting. */
  | { readonly kind: 'combinationsLive'; readonly combinations: number }
  /** `systemsFitted >= systems` at the end. Rewards spending scrap. */
  | { readonly kind: 'systemsFitted'; readonly systems: number }
  /** The run was lost and `causeEnemyId` matches. The company learns from a corpse. */
  | { readonly kind: 'lostTo'; readonly enemyId: string }
  /** The run ended in extraction. */
  | { readonly kind: 'extracted' }
  /** Extraction with `damageTaken <= damage`. The skill capstone. */
  | { readonly kind: 'cleanExtraction'; readonly damage: number }

export interface CertificationDef {
  readonly id: string
  /** Shown in the hangar and in the incident report's "certifications granted". */
  readonly name: string
  readonly condition: UnlockCondition
  /**
   * What enters which pool. Never empty — a certification that grants nothing is
   * a congratulation, and this game does not hand those out.
   */
  readonly grants: readonly PoolGrant[]
  /**
   * What the grant *is*, in one or two sentences with real numbers where numbers
   * apply. `docs/UI.md` rule 4's format, applied to a certification: mechanism
   * first, no flavour, and never a number the game does not honour.
   */
  readonly effect: string
  /**
   * Content this certification is waiting on, or null when everything it adds is
   * live. Printed verbatim in the hangar.
   *
   * Exists so the screen can be honest rather than encouraging. Eight of ten
   * grants below point at M5 content; a hangar that showed them as finished would
   * be advertising a reward that does not arrive.
   */
  readonly awaiting: string | null
}

/**
 * The roster. Ten certifications, one per `UnlockCondition` kind.
 *
 * That one-to-one mapping is asserted by a test, and it is load-bearing rather
 * than tidy: an unused condition kind is code in the evaluator that nothing
 * exercises, and it is exactly where a bug hides until the day someone authors the
 * eleventh certification.
 *
 * Thresholds are chosen against sector 1's measured facts, not by feel — 30 waves,
 * 139 enemies, ~188 s for a full clear, ~800 scrap paid out, 140 effective health,
 * 20 shots/second, a competent bot policy clearing 39% with no items at all. Every
 * number below cites which of those it is derived from.
 */
export const CERTIFICATIONS: readonly CertificationDef[] = [
  /**
   * The first rung, and the only one that asks for nothing but depth.
   *
   * Wave 15 is half the sector. `random` — a bot pressing buttons at random —
   * reaches wave 16, so this is reachable on a first serious attempt and is meant
   * to be: a progression system whose first entry is unreachable reads as an empty
   * list, and an empty hangar teaches a new player that the screen is decoration.
   */
  {
    id: 'vault-clearance',
    name: 'Vault Clearance',
    condition: { kind: 'wavesReached', waves: 15 },
    grants: [{ slice: 'workOrders', id: 'vault' }],
    effect:
      'Adds Vault Approach to the work-order pool: a sealed cache under guard.',
    awaiting: null,
  },

  /**
   * Hoarding. 400 scrap held at the end of the sortie.
   *
   * Measured against the scrap curve in `src/sim/progression.ts`: median holdings
   * are 67 by wave 8 and 370 by wave 23, and a full clear pays about 800. So 400
   * needs real depth *and* at least one shop declined — the condition and
   * `full-manifest-rating` below cannot both be filed by the same sortie, which is
   * the point of putting them in the same roster.
   */
  {
    id: 'unlisted-clearance',
    name: 'Unlisted Clearance',
    condition: { kind: 'scrapHeld', scrap: 400 },
    grants: [{ slice: 'workOrders', id: 'unlisted' }],
    effect:
      'Adds Unlisted Assignment to the work-order pool: opposition undescribed.',
    awaiting: null,
  },

  /**
   * Spending. Three distinct systems fitted at once.
   *
   * A run has exactly four chances to fit something — item rewards at waves 7 and
   * 20, shops at 13 and 24 — so three distinct systems means taking both rewards
   * and buying at least once. Three rather than four because offers can repeat an
   * item already held, so a four-slot run does not reliably produce four distinct
   * ids and a condition that needs a lucky draw is a condition satisfied by
   * repetition. That would be the grinding problem again, in a costume.
   */
  {
    id: 'full-manifest-rating',
    name: 'Full Manifest Rating',
    condition: { kind: 'systemsFitted', systems: 3 },
    grants: [
      { slice: 'enemies', id: 'tally-turret' },
      { slice: 'enemies', id: 'tally-escort' },
    ],
    effect:
      'Adds 2 Tally convoy enemies that escort a lane instead of parking in it.',
    awaiting: 'the Tally convoy enemies',
  },

  /**
   * Building. Two combinations live at the end of the sortie.
   *
   * Two rather than one because one is nearly incidental — ten of the fourteen
   * items participate in at least one declared interaction. Two needs the pair-ups
   * to be *chosen*: `warheads` + `split-shot` + `overkill-accounting` files it in
   * three picks, as does `cursed-hull` + `retaliation-coil` + `repair-nanites`.
   * Reachable inside one run's four slots, and only if the player is reading the
   * synergy markers rather than taking the biggest number.
   */
  {
    id: 'combination-endorsement',
    name: 'Combination Endorsement',
    condition: { kind: 'combinationsLive', combinations: 2 },
    grants: [
      { slice: 'items', id: 'drone-uplink' },
      { slice: 'items', id: 'mirror-mount' },
    ],
    effect:
      'Adds 2 drone items: drones fire a weaker copy of your main weapon.',
    // Kept to one line in the hangar. `docs/DESIGN.md` records the longer version of
    // this: the `drone` tag exists and nothing spawns one.
    awaiting: 'drone entities',
  },

  /**
   * Declining. Wave 16 of 30 with nothing fitted at all.
   *
   * Cheap to reach and completely different to play, which is the combination this
   * roster wants most. The M1/M2 sweeps measured a competent policy clearing 39% of
   * the sector with *no items in the game at all*, so a bare hull reaching wave 16
   * is not a stunt — it is what sector 1 was tuned against before items existed.
   * What it asks is that the player look at a free reward and decline it, which is
   * a decision the game otherwise never poses.
   *
   * THE EFFECT LINE USED TO SAY "draws more elites", WHICH THE HULL DOES NOT DO.
   * `docs/DESIGN.md` gives Arrears that drawback and `src/content/hulls.ts` records
   * that it could not be expressed — the elite rate lives in the spawner's wave
   * scripts and `HullDef` has nowhere to bias it. The hull card is honest about
   * that; this card was not, and a certification promising a drawback the hull does
   * not have is the same lie in a different place. Quoting the hull's own numbers is
   * what keeps the two from drifting again.
   */
  {
    id: 'austerity-endorsement',
    name: 'Austerity Endorsement',
    condition: { kind: 'bareHull', waves: 16 },
    grants: [{ slice: 'hulls', id: 'arrears' }],
    effect:
      'Adds the Arrears hull: +42 speed, 150 scrap, 45 less effective health.',
    awaiting: 'a hull selection screen',
  },

  /**
   * Aim. 25% of at least 500 rounds on target.
   *
   * Derived, not guessed. Sector 1 spawns 5,622 HP in total; at the base 4 damage
   * that is 1,406 hits for a complete clear, against 3,760 shots for a ~188 s run
   * with the trigger held. So the ceiling for held-trigger play is about 37%, and
   * 25% is demanding without being the ceiling. Note the direction a damage build
   * pushes this: more damage per hit means *fewer* hits for the same kills, so
   * Warheads makes this condition harder rather than easier, and the only real
   * lever is not firing at empty space.
   *
   * THE ONE THRESHOLD HERE THAT WANTS A BOT SWEEP. Every other number is derived
   * from a measurement that already exists; this one is derived from arithmetic
   * about a measurement nobody has taken, because no policy in `src/sim/bots.ts`
   * reports accuracy. 500 shots is 25 seconds of held fire, so the sample gate is
   * safe; the 25% is the part to check.
   */
  {
    id: 'marksman-rating',
    name: 'Marksman Rating',
    condition: { kind: 'accuracy', percent: 25, minShots: 500 },
    grants: [
      { slice: 'items', id: 'ranging-computer' },
      { slice: 'items', id: 'precision-sights' },
    ],
    effect:
      'Adds 2 sighting items that trade volume of fire for placement.',
    awaiting: 'the sighting items',
  },

  /**
   * Clearing. 110 confirmed kills in one sortie.
   *
   * Sector 1 spawns 139 enemies, so 110 is about four fifths of them — reachable
   * only by engaging, not by dodging to the end of the script. It is the mirror of
   * `austerity-endorsement`: that one rewards refusing power, this one rewards
   * using it, and the two are the reason the hangar is not a single difficulty
   * ladder.
   *
   * COLLATERAL IS HERE because the hull and the condition ask for the same thing.
   * Collateral trades its shield generator for 30 shots per second — 120 dps against
   * the baseline's 80 — so it is the roster's engagement hull, and 110 kills is the
   * roster's engagement condition. A pilot who has just cleared four fifths of a
   * sector by shooting it is being handed the ship for doing that, which is the
   * lateral trade `docs/DESIGN.md` wants a hull grant to be rather than a reward for
   * having already won.
   */
  {
    id: 'clearance-commendation',
    name: 'Clearance Commendation',
    condition: { kind: 'killsInRun', kills: 110 },
    grants: [
      { slice: 'hazards', id: 'debris-cascade' },
      { slice: 'hulls', id: 'collateral' },
    ],
    effect:
      'Adds the debris cascade hazard, and the Collateral hull: 120 dps, no shield.',
    awaiting: 'the debris cascade hazard, and a hull selection screen',
  },

  /**
   * Dying, specifically. Lost to a Heavy Turret.
   *
   * The one condition that rewards failure, and it belongs in this game more than
   * anywhere: `docs/DESIGN.md` says meta-progression is "the accumulated data your
   * predecessors died collecting". The elite arrives at 134 s — wave 22 or so — so
   * a pilot cannot file this without reaching the sector's hardest positional
   * problem and losing to it. It is not a participation award; it is an autopsy.
   *
   * PROBATE IS HERE for the obvious reason and it is the right one: the hull is a
   * dead pilot's estate, and this is the certification you file by dying. "The
   * accumulated data your predecessors died collecting" is `docs/DESIGN.md`'s line
   * about meta-progression, and a hull inherited from a corpse is that sentence made
   * into a ship. It was unreachable content before this — authored, tested, and in
   * no pool.
   */
  {
    id: 'posthumous-data-annex',
    name: 'Posthumous Data Annex',
    condition: { kind: 'lostTo', enemyId: 'turret-heavy' },
    grants: [
      { slice: 'enemies', id: 'turret-siege' },
      { slice: 'hulls', id: 'probate' },
    ],
    effect:
      'Adds the Siege Turret elite, and the Probate hull: 132 effective health.',
    awaiting: 'the Siege Turret elite, and a hull selection screen',
  },

  /**
   * Coming home. Any extraction.
   *
   * A competent policy clears 39% of runs, so this is the roster's honest midpoint
   * rather than its summit — and it is the certification that should exist for its
   * own sake, because a first clear is the run a player remembers.
   */
  {
    id: 'extraction-certificate',
    name: 'Extraction Certificate',
    condition: { kind: 'extracted' },
    grants: [{ slice: 'bossVariants', id: 'manifest-warden' }],
    effect:
      'Adds a second Deep Manifest boss: the Warden seals the lane in sections.',
    // The variant SHIPPED — `src/content/bosses.ts` defines `manifest-warden` and
    // `tests/bosses.test.ts` checks this grant resolves to it. What has not shipped
    // is the gating: `pickVariant` draws from `BossDef.variants` directly and never
    // sees `poolFor(...).bossVariants`, so the Warden is already reachable by anyone
    // and this certification currently changes nothing. Saying "the sector-five
    // boss" would now be false in both directions.
    awaiting: 'boss variants drawn from your certifications',
  },

  /**
   * The capstone. Extract having taken at most 40 damage in total.
   *
   * 40 is the base shield's full capacity, so the condition reads as "come home
   * with your integrity untouched" — a real skill statement with a real number
   * behind it rather than a round figure.
   *
   * ZERO WAS THE FIRST DRAFT AND IT IS WRONG, for a reason worth recording:
   * `stats.damageTaken` counts shield absorption, so a zero-damage condition
   * forbids even a graze across a 188-second clear of 139 enemies. That is not the
   * hardest certification, it is the unreachable one, and an unreachable entry in a
   * list of unlock conditions is the hangar lying politely. The threshold is data,
   * so tightening it later is a one-number change if a sweep says 40 is soft.
   *
   * ## THIS GRANTED `writ`, WHICH IS NOT A HULL AND IS NOT GOING TO BE ONE SOON
   *
   * `src/content/hulls.ts` ships five hulls and records three more in
   * `HULLS_AWAITING_MECHANICS`. Writ is one of them, and what it waits on is not
   * content but *simulation*: a player-triggered phase state needs an input action,
   * and `InputSnapshot` is the whole contract between the player and the sim — five
   * fields, packed into one byte, and every recorded replay in existence is built on
   * that byte. Adding a sixth is a format change, not an afternoon.
   *
   * So the grant pointed at an id that resolves to nothing. `getHull('writ')` throws,
   * `poolFor` would have handed the app a hull it cannot look up, and the only reason
   * nothing crashed is that the app never reads past `pool.hulls[0]`. A dangling
   * reference that survives a typecheck and is masked by a second defect is exactly
   * the kind of thing that surfaces the day the second defect is fixed.
   *
   * Repointed at Surety, which ships and which fits the condition better than Writ
   * did: 210 effective health against the baseline's 140, bought with speed. This
   * certification asks the player to come home untouched, and it hands them the hull
   * built to be come home in. Writ stays in `HULLS_AWAITING_MECHANICS` with its
   * reason; when the phase state exists it needs a certification of its own, not
   * this one back.
   */
  {
    id: 'flawless-conduct-citation',
    name: 'Flawless Conduct Citation',
    condition: { kind: 'cleanExtraction', damage: 40 },
    grants: [{ slice: 'hulls', id: 'surety' }],
    effect:
      'Adds the Surety hull: 210 effective health, +1 damage, and 155 speed.',
    awaiting: 'a hull selection screen',
  },
]

/**
 * What a run draws from with no certifications filed — a purist run, and the
 * baseline every grant is measured against.
 *
 * Items and enemies are derived from the shipped tables rather than listed, which
 * is the important structural choice here: **certifications never gate content that
 * already ships.** Listing them would mean a new item in `items.ts` silently
 * dropping out of the base pool and quietly re-balancing a tuned sector, and it
 * would make purist mode strictly worse than the game it is meant to be a fair
 * comparison against.
 *
 * `workOrders` mirrors the literal in `World.maybeOpenChoice`
 * (`['supply', 'hazard', 'repair']`). That coupling is real and unchecked: nothing
 * can assert it from here, because the sim builds the list inline rather than
 * reading a pool. It stops being a duplicate the moment `World` is handed
 * `poolFor(...).workOrders`, which is the change that makes the two live
 * certifications above take effect.
 *
 * `hulls` is `['lien']` because `docs/DESIGN.md` says so outright: three hulls are
 * offered per run "drawn from what's been certified", and "`Lien` is always
 * available". THE OTHER FOUR SHIPPED HULLS ARE EACH BEHIND A CERTIFICATION —
 * `arrears`, `probate`, `collateral`, `surety` — and `tests/certifications.test.ts`
 * asserts that every hull in `HULLS` is either here or granted, so a hull can never
 * again be authored, tuned, tested, and reachable by nobody.
 */
export const BASE_POOL: Readonly<Record<PoolSlice, readonly string[]>> = {
  items: Object.keys(ITEMS),
  enemies: Object.keys(ENEMIES),
  workOrders: ['supply', 'hazard', 'repair'],
  hulls: ['lien'],
  // Empty, and for a reason that is NOT "the content does not exist" any more —
  // bosses, variants and hazards all shipped with M5. Nothing consults these two
  // slices: `pickVariant` reads `BossDef.variants` and hazards are armed from the
  // stage definition, so both pools are inert. They are stated rather than omitted
  // so the shape of the record is total — a missing slice would read as zero at one
  // call site and as undefined at another.
  bossVariants: [],
  hazards: [],
}

/**
 * Look up a certification, throwing on an unknown id.
 *
 * Throws for the same reason `getItem` and `getEnemy` do: every caller is either
 * content or a persisted id that has been validated already, so an unknown id is
 * an authoring bug that must fail where it happens rather than becoming a silently
 * missing unlock. Persisted saves are the one place unknown ids are *expected*,
 * and they go through `coerceUnlockedIds` instead, which drops them.
 *
 * Guards with a lookup over the roster rather than an index into an object, so
 * there is no prototype to accidentally resolve `constructor` against — the bug
 * `getEnemy` shipped once.
 */
export function getCertification(id: string): CertificationDef {
  const found = CERTIFICATIONS.find((def) => def.id === id)
  if (!found) throw new Error(`Unknown certification id: ${id}`)
  return found
}
