/**
 * Run progression: when the run stops to offer a choice, and how a choice is
 * resolved from player input.
 *
 * Kept out of world.ts because it is a policy question ("the run pauses for a
 * reward after wave 6") rather than a simulation mechanic, and because the input
 * edge-detection below is fiddly enough to deserve its own tests.
 */

import type { HazardDef, InteractionDef, ItemDef } from '../content/types'
import type { InputSnapshot } from '../core/input'
import { Rng } from '../core/rng'
import type {
  HeldItem,
  ItemOffer,
  PendingChoice,
  PendingChoiceKind,
  RouteOption,
  RouteReward,
} from './entities'
import { interactionsUnlockedBy } from './inventory'

/** How many options a choice presents. Three is the genre default and it fits the card. */
export const OFFER_COUNT = 3

/**
 * Wave indices after which the run pauses for a reward.
 *
 * TWO item choices, not four, and the reason is structural rather than a nerf.
 *
 * Four rewards in a three-minute sector is an entire five-sector run's worth of
 * upgrades handed out during the *easiest* sector. Measured: it took a competent
 * policy from a 39% clear rate to **99.3%**, and a build-focused one to 100% —
 * sector 1 stopped being a game. The items are not individually overtuned (pick
 * rates sit in a healthy 20-40% band); there are simply far too many of them per
 * unit of difficulty.
 *
 * Two per sector is the rate a five-sector run wants: roughly ten items across
 * 15-20 minutes, which is normal for the genre. When sectors 2-5 land (M5), the
 * per-sector count stays and the per-run count grows on its own.
 *
 * Positioned after the opening teaches aiming, and again once the pressure phase is
 * established — so a build exists before it is tested, and is tested before the
 * escalation.
 */
export const ITEM_CHOICE_WAVES: readonly number[] = [7, 20]
/**
 * Shop waves.
 *
 * Was `[8, 23]`, and wave 8 was a decoration: measured across 999 shop screens and
 * five policies, it sold NOTHING, ever. Median scrap at wave 8 is 67 and the
 * cheapest option cost 120, so every single visit was a forced decline — the run
 * stopped, showed a card, and the only available action was to leave. A shop the
 * player can never buy from is worse than no shop, because it teaches them that
 * stopping is pointless.
 *
 * Moved to 13, and prices now scale with progress (see shopCosts) instead of being
 * flat, so an early shop is cheap enough to matter and a late one is not free.
 */
export const SHOP_WAVES: readonly number[] = [13, 24]
export const WORK_ORDER_WAVES: readonly number[] = [17]

/**
 * Base scrap price for a shop option, before tier and progress scaling.
 *
 * Lowered from 120 against the measured scrap curve rather than by feel: median
 * holdings are 67 by wave 8 and 370 by wave 23.
 */
const SHOP_BASE_COST = 80

/**
 * Build the three offers for a choice.
 *
 * Draws from the `offers` stream — its own named stream, never `loot`, because a
 * cosmetic or unrelated roll must never be able to shift which items a player is
 * shown. Excludes items with zero weight.
 *
 * NOTE: an earlier version of this comment claimed it also excluded items already
 * held at max stack. There is no max-stack concept in `ItemDef` and no such
 * exclusion here — the claim was aspirational. Re-offering a held item is currently
 * intended (stacking is a real choice), except for items whose effects take a max
 * rather than summing, where a second copy does nothing. The choice screen should
 * eventually say so.
 */
export function buildOffers(
  rng: Rng,
  itemsById: Readonly<Record<string, ItemDef>>,
  interactions: readonly InteractionDef[],
  held: readonly HeldItem[],
): readonly ItemOffer[] {
  const pool = Object.values(itemsById).filter((def) => (def.weight ?? 1) > 0)
  if (pool.length === 0) return []

  const picked: ItemDef[] = []
  const remaining = [...pool]
  // Weighted draw without replacement: three *distinct* options, because two
  // identical offers is a choice of two, presented as a choice of three.
  while (picked.length < OFFER_COUNT && remaining.length > 0) {
    const chosen = rng.weighted(remaining, (def) => def.weight ?? 1)
    picked.push(chosen)
    remaining.splice(remaining.indexOf(chosen), 1)
  }

  return picked.map((def) => ({
    defId: def.id,
    tier: def.tier,
    // Resolved here rather than in the UI: the screen must not have to work out
    // whether two items combine, or it can fail to mention one (UI rule 5).
    interactionText: interactionsUnlockedBy(def.id, held, interactions),
  }))
}

const TIER_COST_MULTIPLIER: Record<ItemDef['tier'], number> = {
  common: 1,
  uncommon: 1.6,
  rare: 2.4,
  relic: 3.2,
}

/**
 * Price a shop's stock.
 *
 * Scales with `waveIndex` as well as tier. A flat price cannot serve both shops: set
 * low enough for the first it is free by the second, set for the second it makes the
 * first unbuyable — which is exactly what happened. Progress scaling lets one
 * number serve both.
 */
/**
 * Price a between-sector shop.
 *
 * A SEPARATE curve from `shopCosts`, deliberately. That one scales +6% per wave,
 * which was measured and tuned against a single 30-wave sector; running the same
 * rate across a five-sector run compounds to nearly 10x and prices the last shop
 * out of existence. Stage-based scaling reaches about 3.4x over a full run, against
 * a scrap curve that grows faster than that.
 */
export function transitShopCosts(
  offers: readonly ItemOffer[],
  itemsById: Readonly<Record<string, ItemDef>>,
  stageIndex: number,
): readonly number[] {
  const progress = 1 + Math.max(0, stageIndex) * 0.6
  return offers.map((offer) => {
    const tier = itemsById[offer.defId]?.tier ?? 'common'
    return Math.round(SHOP_BASE_COST * TIER_COST_MULTIPLIER[tier] * progress)
  })
}

export function shopCosts(
  offers: readonly ItemOffer[],
  itemsById: Readonly<Record<string, ItemDef>>,
  waveIndex = 1,
): readonly number[] {
  // +6% per wave. Across sector 1 that roughly doubles prices from the first shop
  // to the last, against a scrap curve that grows about fivefold — so later stock
  // is affordable without early stock being trivial.
  const progress = 1 + Math.max(0, waveIndex - 1) * 0.06
  return offers.map((offer) => {
    const tier = itemsById[offer.defId]?.tier ?? 'common'
    return Math.round(SHOP_BASE_COST * TIER_COST_MULTIPLIER[tier] * progress)
  })
}

export function makeChoice(
  kind: PendingChoiceKind,
  offers: readonly ItemOffer[],
  costs: readonly number[],
  workOrders: readonly string[] = [],
  routes: readonly RouteOption[] = [],
): PendingChoice {
  return { kind, offers, costs, workOrders, routes }
}

// ---------------------------------------------------------------------------
// routing between sectors — the world map
// ---------------------------------------------------------------------------

/**
 * NO ROUTE PAYS SCRAP. Decided 2026-07-26 — see docs/DESIGN.md, "Route rewards are
 * priced off the panel".
 *
 * A route used to pay 70 + 55·stage scrap, and the number was scaled against a
 * measured curve. It was still worth nothing, because the curve it was scaled against
 * was a single sector's and the run is five. Measured over 300 five-sector runs
 * (5 policies × 60 seeds), the scrap a pilot is *holding* when a route card opens:
 *
 *   leg 2   560       leg 3  2,030       leg 4  3,463       leg 5  5,474
 *
 * against payouts of 125 / 180 / 235 / 290. The last seam's reward is 5% of what the
 * pilot already has, and there is nothing to spend it on: the dearest thing in any
 * depot is 272, every shop from leg 2 on is bought at 97-100%, and **100% of runs end
 * with scrap unspent** (median 3,940). A bigger number would not fix that — an inert
 * currency is inert at any face value.
 *
 * It is also not fixable from this file. Making scrap scarce means pricing the sinks
 * against holdings that span 43x across a run (257 at the first shop, 8,726 at the
 * last), and the dominant sink is `shopCosts`, which is handed a per-sector
 * `waveIndex` and cannot see absolute run progress. One curve cannot bite at both
 * ends: the leg-1 shop is already declined 29% of the time.
 *
 * So the reward moved to an axis the pilot can price, rather than staying a number
 * nobody can. `RouteReward` still has a `scrap` variant and `World.payRouteReward`
 * still honours it — the variant is the right shape for the day scrap has a sink,
 * and deleting it would cost the union a case for no gain.
 */

/**
 * Repair route: a fraction of maximum integrity, stated in points when offered.
 *
 * 0.6, up from 0.35, and the number comes from what an item is worth rather than from
 * feel. `bots.ts` scores one free item at 2.5 route-points and a repair at the
 * integrity it would *actually* restore over 20 — the only honest reading, because a
 * heal on a full hull is worth nothing. So a repair is worth an item at 50 points of
 * damage taken, and 0.35 of a ~110-point hull tops out at 38: **under the shipped
 * fraction a repair could not outscore an item at any damage level, on any hull.**
 * It was a third option that could never be correct.
 *
 * At 0.6 the crossover lands where the design wants it — a pilot who has lost more
 * than half a hull takes the dock, one who is nearly full takes the cache — and how
 * often that happens is a property of how the pilot is flying, not of this constant.
 * Measured share of route cards opened below half integrity: 48% for the evasive
 * policy, 27% for the greedy one, 7% for the clear-speed benchmark.
 */
const ROUTE_REPAIR_FRACTION = 0.6

/**
 * Build the approach options into `stageIndex`.
 *
 * THE SHAPE OF THE CHOICE: the sector order is authored and never varies, so a route
 * cannot let a player skip the difficulty curve. What varies is the price of
 * arriving well-equipped — each non-direct route attaches a hazard that will be live
 * for the whole sector, and pays for it once on arrival.
 *
 * The direct route is always first and always costs nothing. A risk/reward screen
 * with no safe option is not a choice, it is a tax.
 *
 * Returns an EMPTY array when the stage has no hazards to trade against. A card
 * offering three rewards and no downside is a free lunch dressed as a decision, and
 * the caller skips straight to the shop instead — see World.beginTransition.
 *
 * BOTH PRICED REWARDS ARE PRICED OFF THE PANEL. One pays a build slot, the other pays
 * integrity, and which is better is a fact about the pilot's own meters rather than a
 * fact about the card — so neither is the standing right answer. Nothing here pays
 * scrap; see the note above `ROUTE_REPAIR_FRACTION` for the measurement that killed
 * it.
 */
export function buildRoutes(
  rng: Rng,
  stageIndex: number,
  sectorName: string,
  bossName: string | null,
  hazards: readonly HazardDef[],
  maxIntegrity: number,
): readonly RouteOption[] {
  const direct: RouteOption = {
    stageIndex,
    name: 'DIRECT APPROACH',
    sectorName,
    bossName,
    hazards: [],
    hazardIds: [],
    reward: { kind: 'none' },
    // Through `rewardText`, not a copy of the same sentence. Two literals for one
    // reward is two places to edit and one to forget, and the screen renders this
    // string verbatim — so a drift between them would show up as the map contradicting
    // itself about the option the player is most likely to take.
    rewardText: rewardText({ kind: 'none' }),
  }
  if (hazards.length === 0) return []

  // Two priced routes, each carrying one hazard. Drawn without replacement so the
  // two options are actually different when the sector has more than one hazard.
  //
  // WITH ONE HAZARD BOTH ROUTES CARRY IT, and the card must then say so ONCE rather
  // than printing the same price twice. That is `sharedHazardNames` in
  // `src/ui/worldMap.ts`: three of the four seams in the shipped run are this case
  // (only The Deep Manifest has two hazards), so it is the common presentation and not
  // an edge case. Leaving it to the screen is deliberate — the choice really is purely
  // the reward here, and collapsing to two options would delete a real decision to
  // work around a layout that was mis-stating one price as two.
  const pool = [...hazards]
  const first = rng.weighted(pool, () => 1)
  pool.splice(pool.indexOf(first), 1)
  const second = pool.length > 0 ? rng.weighted(pool, () => 1) : first

  // Which reward pairs with which hazard is rolled, so learning "the left one is
  // always the item" is not a substitute for reading the card.
  const item: RouteReward = { kind: 'item' }
  const other: RouteReward = {
    kind: 'repair',
    amount: Math.round(maxIntegrity * ROUTE_REPAIR_FRACTION),
  }
  // A TUPLE, so indexing is checked rather than cast. The previous version built an
  // array and read `paid[0] as RouteReward` — reflexive casts of exactly the kind
  // `noUncheckedIndexedAccess` exists to make impossible, silencing the compiler on
  // the one question it was asking.
  const [firstReward, secondReward]: readonly [RouteReward, RouteReward] = rng.chance(0.5)
    ? [other, item]
    : [item, other]

  return [
    direct,
    routeFor(stageIndex, sectorName, bossName, first, firstReward),
    routeFor(stageIndex, sectorName, bossName, second, secondReward),
  ]
}

function routeFor(
  stageIndex: number,
  sectorName: string,
  bossName: string | null,
  hazard: HazardDef,
  reward: RouteReward,
): RouteOption {
  return {
    stageIndex,
    name: routeName(reward),
    sectorName,
    bossName,
    hazards: [{ name: hazard.name, description: hazard.description }],
    hazardIds: [hazard.id],
    reward,
    rewardText: rewardText(reward),
  }
}

/**
 * The name of a route, from what it pays.
 *
 * Institutional rather than heroic, per the tone in docs/DESIGN.md: these are work
 * orders, and the company does not think of them as adventures.
 *
 * SALVAGE DETOUR is on the bench, not retired: `buildRoutes` no longer pays scrap, so
 * nothing reachable in the shipped run produces that name. The branch stays because
 * the `scrap` variant stays, and the name is the one that will be needed first if a
 * scrap sink ever makes the payout mean something.
 */
function routeName(reward: RouteReward): string {
  switch (reward.kind) {
    case 'none':
      return 'DIRECT APPROACH'
    case 'item':
      return 'CACHE RECOVERY'
    case 'scrap':
      return 'SALVAGE DETOUR'
    case 'repair':
      return 'REPAIR DOCK'
  }
}

/**
 * The reward in one sentence with real numbers (UI.md rules 2 and 4).
 *
 * Written here rather than on the screen so every surface that mentions a route —
 * the map, the panel, a future run summary — says the same thing. A screen that
 * composes its own description is a screen that can describe a reward the
 * simulation will not pay.
 */
export function rewardText(reward: RouteReward): string {
  switch (reward.kind) {
    case 'none':
      return 'No hazard, no bonus. Arrive as you are.'
    case 'item':
      return 'One item, chosen from three on arrival.'
    // UNITS MATCH THE PANEL: `cr` and `hp`, not "scrap" and "integrity".
    //
    // The route card shows the amount twice — once as a chip and once in this
    // sentence — and the chip uses the panel's units because that is what the player
    // has been reading for fifteen minutes. Two spellings of one number on one screen
    // is a small clarity tax for no gain, and the cheaper side to change is this one.
    case 'scrap':
      return `+${reward.amount} cr on arrival.`
    // "up to hull maximum" because `World.payRouteReward` clamps, and a pilot at 95 of
    // 100 who reads "+66 hp" and gains 5 has been lied to by the card. It is also the
    // sentence that makes this reward comparable with the item beside it: what the
    // repair is worth is the gap the player can already see in their own meter, so the
    // two options are weighed against a readout rather than against each other.
    case 'repair':
      return `+${reward.amount} hp on arrival, up to hull maximum.`
  }
}

/**
 * Selection state while a choice is open.
 *
 * Lives in the simulation because it is resolved from `InputSnapshot` and must
 * replay identically — a recorded run has to make the same picks.
 */
export interface ChoiceCursor {
  index: number
  /**
   * Ticks this choice has been open.
   *
   * Not read by any resolution rule — nothing about a card depends on how long it has
   * been up. It is on `WorldView.choiceResolve.openTicks` because an observer needs it
   * to tell one card from the NEXT: a seam opens three cards in three ticks with no
   * null gap between them, and this counter resetting is the only signal that says the
   * card was swapped. `tools/playtest.ts` bounds a stalled sweep with it.
   */
  openTicks: number
  /**
   * Previous tick's button states, for edge detection.
   *
   * Load-bearing at a SEAM. A seam opens the next card in the same tick the previous
   * one was confirmed, so the confirm key is still down when the new cursor is built —
   * and a level-triggered read would take option 0 of two more cards before the player
   * could lift a finger. Requiring a *rising* edge, from a cursor that starts by
   * assuming every button is already held, is what makes each card need its own press.
   */
  prevConfirm: boolean
  prevLeft: boolean
  prevRight: boolean
  prevSpecial: boolean
}

export function newCursor(): ChoiceCursor {
  // Starts with every button considered already-held, so a button held at the
  // moment the choice opens cannot count as a press.
  return {
    index: 0,
    openTicks: 0,
    prevConfirm: true,
    prevLeft: true,
    prevRight: true,
    prevSpecial: true,
  }
}

/*
 * A CARD IS RESOLVED BY THE PLAYER AND BY NOTHING ELSE. Two rules were deleted here,
 * both of them attempts to work around the same mistake, and the mistake was reading
 * the fire key.
 *
 * 1. `CHOICE_TIMEOUT_TICKS = 20 * 60` auto-resolved any open card as a SKIP after
 *    twenty seconds. A deadlock guard: confirming needed a rising *fire* edge, so a
 *    player already holding the trigger had no edge to confirm with and the run
 *    stopped. What it actually reached was a player holding nothing — somebody reading
 *    the card — so it threw their reward away and put a countdown on a permadeath
 *    decision. "The shops shouldn't close automatically, that's annoying."
 *
 * 2. `HELD_CONFIRM_DWELL_TICKS = 48` confirmed the highlighted option *for* a player
 *    whose trigger had been held since the card opened. A better fix for the same
 *    deadlock, and still the interface deciding on the player's behalf: on touch,
 *    where auto-fire is permanent, it meant option 0 on every card 0.8 seconds in.
 *
 * Both are gone because `InputSnapshot.confirm` is now its own action, one that is
 * never held during a sortie ("the selection screens must not use the fire key to
 * accept responses"). A card that opens under a held trigger is not a deadlock, it is a
 * card waiting for its own key — which the player can always press, and can always
 * press again for the next card at a seam, because the edge is what counts.
 *
 * Do not re-add either rule. If a card ever appears stuck, the bug is in whatever is
 * producing snapshots, not here: `tools/playtest.ts` abandons a sweep whose policy
 * stops resolving cards (`MAX_CHOICE_RESOLUTION_TICKS`) instead of letting a hidden
 * rescue paper over it, which is how R1's 1,201-tick stalls hid for a milestone.
 *
 * ONE HAZARD IS LEFT, and it is `special`. Declining still reads a rising `special`
 * edge, and `special` IS a bindable sortie action (X / K / Shift). Nothing in the sim
 * reads it during play today, so there is no live defect — but the day a special weapon
 * lands, a player mashing it as a wave dies will decline the reward the same way a held
 * trigger used to confirm it. The fix is a `cancel` action beside `confirm`, and it
 * needs a ninth bit in `packInput` — the byte is now full — so it is a replay format
 * change and deliberately not smuggled in here. See `docs/MOBILE.md`.
 */

export type ChoiceAction =
  | { kind: 'none' }
  | { kind: 'confirm'; index: number }
  | { kind: 'skip' }

/**
 * Advance the cursor and report what the player did this tick.
 *
 * Horizontal movement moves the selection; a rising CONFIRM edge accepts; a rising
 * special edge skips (a shop must be declinable, and an item choice must be too
 * when every option costs more than the player has).
 *
 * `input.fire` is deliberately not read. See the note above.
 */
export function updateCursor(
  cursor: ChoiceCursor,
  input: InputSnapshot,
  optionCount: number,
  selectable?: readonly boolean[],
): ChoiceAction {
  const left = input.moveX < 0
  const right = input.moveX > 0

  const step = (from: number, delta: number): number => {
    if (optionCount <= 0) return 0
    const wrap = (i: number): number => ((i % optionCount) + optionCount) % optionCount
    let next = wrap(from + delta)
    // Skip past anything that cannot be chosen, at most one lap. Bounded by the lap
    // rather than by trust: if EVERY option is unselectable the cursor stays put
    // instead of spinning, and the player declines with the skip key.
    for (let i = 0; i < optionCount && selectable && selectable[next] === false; i++) {
      next = wrap(next + delta)
    }
    return next
  }

  if (left && !cursor.prevLeft) {
    cursor.index = step(cursor.index, -1)
  }
  if (right && !cursor.prevRight) {
    cursor.index = step(cursor.index, 1)
  }
  if (optionCount > 0) {
    cursor.index = ((cursor.index % optionCount) + optionCount) % optionCount
    /*
     * AN UNAFFORDABLE OPTION IS NOT SELECTABLE.
     *
     * It used to be: the cursor landed on it, the card drew it greyed out, and
     * confirming did nothing at all — a button that visibly does nothing, which is the
     * failure this project has now hit three times (the unbuyable wave-8 shop, the
     * inert work-order card, the `reduceFlashes` row). Reported from play.
     *
     * Handled here rather than in the shop screen because the CURSOR is what the
     * simulation owns and replays; a screen that refused to draw a selection the sim
     * still held would disagree with it, which is the exact split `choiceSelection`
     * exists to prevent.
     *
     * Nudged forward if the card opened on one — the first option is not guaranteed
     * affordable, and opening with the cursor parked on something inert is the same
     * defect one tick earlier.
     */
    if (selectable && selectable[cursor.index] === false) {
      cursor.index = step(cursor.index, 1)
    }
  } else {
    cursor.index = 0
  }

  cursor.openTicks++

  // Rising edges only, on both actions, and `openTicks` appears in neither: a card is
  // resolved when the player resolves it, however long that takes.
  const confirmed = input.confirm && !cursor.prevConfirm
  const skipped = input.special && !cursor.prevSpecial

  cursor.prevLeft = left
  cursor.prevRight = right
  cursor.prevConfirm = input.confirm
  cursor.prevSpecial = input.special

  if (confirmed && optionCount > 0) return { kind: 'confirm', index: cursor.index }
  if (skipped) return { kind: 'skip' }
  return { kind: 'none' }
}
