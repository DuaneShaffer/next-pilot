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
 * Scrap paid by a supply route, per stage.
 *
 * Scaled against the measured curve: median holdings are 67 by wave 8 and 370 by
 * wave 23 of a single sector, so a flat bonus would be transformative on the first
 * leg and rounding error on the last.
 */
const ROUTE_SCRAP_BASE = 70
const ROUTE_SCRAP_PER_STAGE = 55

/** Repair route: a fraction of maximum integrity, stated in points when offered. */
const ROUTE_REPAIR_FRACTION = 0.35

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
  // two options are actually different when the sector has more than one hazard;
  // with only one hazard both routes carry it and the choice is purely the reward.
  const pool = [...hazards]
  const first = rng.weighted(pool, () => 1)
  pool.splice(pool.indexOf(first), 1)
  const second = pool.length > 0 ? rng.weighted(pool, () => 1) : first

  // Which reward pairs with which hazard is rolled, so learning "the left one is
  // always the item" is not a substitute for reading the card.
  const scrap = ROUTE_SCRAP_BASE + ROUTE_SCRAP_PER_STAGE * stageIndex
  const repair = Math.round(maxIntegrity * ROUTE_REPAIR_FRACTION)
  const item: RouteReward = { kind: 'item' }
  const other: RouteReward = rng.chance(0.5)
    ? { kind: 'scrap', amount: scrap }
    : { kind: 'repair', amount: repair }
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
    case 'repair':
      return `+${reward.amount} hp on arrival.`
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
  /** Ticks this choice has been open, for the dwell and the deadlock guard. */
  openTicks: number
  /**
   * True while the trigger has been held for every tick since the card opened.
   *
   * Surfaced so the screen can say "release to choose" instead of appearing frozen.
   */
  awaitingRelease: boolean
  /**
   * Previous frame's button states, for edge detection.
   *
   * Load-bearing. The player is almost certainly holding fire when a choice opens,
   * and a held button would instantly confirm the first option — the reward screen
   * would flash past before it could be read. Requiring a *rising* edge means the
   * button must be released and pressed again.
   */
  prevFire: boolean
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
    awaitingRelease: true,
    prevFire: true,
    prevLeft: true,
    prevRight: true,
    prevSpecial: true,
  }
}

/**
 * How long a choice may stay open before it resolves itself.
 *
 * A SAFETY NET, not the intended path. Confirming needs a *rising* fire edge so a
 * player already holding the trigger cannot skip the reward screen before reading
 * it — but that means anyone who never releases fire waits forever, and the run
 * simply stops. A bot policy that holds fire constantly deadlocked its run exactly
 * this way, and a player who walks away mid-choice would too.
 *
 * 20 seconds: far longer than any real decision, short enough that a stuck run
 * eventually ends rather than hanging.
 *
 * THE NUMBER IS RIGHT AND FIVE PLACES SAID OTHERWISE. This comment said 60 seconds,
 * `sim/bots.ts` said 3,600 ticks, `tests/bots.test.ts` called it "a 60-second
 * backstop", `docs/MOBILE.md` said 60, and `tools/playtest.ts` printed "the sim's
 * fallback timeout is 3600 and no policy may reach it". That last one was not merely
 * wrong prose: its stall guard compared against 3600, so a real 1201-tick stall in
 * the bot choice resolver sat under the threshold and was never reported. A constant
 * whose documentation drifts is survivable; a *guard* derived from the drifted
 * documentation is how a bug hides in plain sight for a milestone.
 */
export const CHOICE_TIMEOUT_TICKS = 20 * 60

/**
 * Ticks a card must be open before a *held* trigger may confirm it.
 *
 * This is the fix for a soft freeze a tester hit. Confirming requires a rising fire
 * edge so a card cannot flash past someone already holding the trigger — but in a
 * shmup the trigger is *always* held, so anyone who did not happen to release it sat
 * looking at an unresponsive game until the timeout. The button they were pressing
 * did nothing and nothing explained why.
 *
 * A dwell resolves both: a held trigger cannot confirm instantly (the card is
 * readable), and it cannot fail to confirm either (the game never stops responding).
 * Releasing and pressing still confirms immediately, so a deliberate player is never
 * made to wait.
 *
 * The rescue applies ONLY to a player who has touched nothing — releasing the trigger
 * or moving the cursor cancels it. Someone navigating is not stuck, and confirming
 * under them would steal the choice they were making.
 */
export const HELD_CONFIRM_DWELL_TICKS = 48

export type ChoiceAction =
  | { kind: 'none' }
  | {
      kind: 'confirm'
      index: number
      /**
       * True when this confirm came from the held-trigger DWELL rather than from a
       * deliberate press.
       *
       * The caller needs to tell them apart, and the reason is a second soft freeze
       * hiding behind the fix for the first. If the dwell confirms an option the
       * player cannot afford, the world refuses it, the card stays open, and the next
       * tick tries again — forever, until the 20-second timeout. That is precisely the
       * unresponsive card `HELD_CONFIRM_DWELL_TICKS` exists to prevent, reappearing
       * one layer down.
       *
       * A deliberate press on an unaffordable option must still do nothing (the option
       * is greyed out and the player can navigate to another). A *rescue* that cannot
       * complete has to become a decline instead of a loop.
       */
      fromDwell: boolean
    }
  | { kind: 'skip' }

/**
 * Advance the cursor and report what the player did this tick.
 *
 * Horizontal movement moves the selection; a rising fire edge confirms; a rising
 * special edge skips (a shop must be declinable, and an item choice must be too
 * when every option costs more than the player has).
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
    // Any deliberate navigation cancels the held-trigger rescue below: someone
    // moving the cursor is plainly not stuck, and auto-confirming under them would
    // steal the choice they were in the middle of making. This also stops the dwell
    // from pre-empting a bot's navigation and skewing measured pick rates.
    cursor.awaitingRelease = false
  }
  if (right && !cursor.prevRight) {
    cursor.index = step(cursor.index, 1)
    cursor.awaitingRelease = false
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
  // Once the trigger has been seen released, this card is in normal edge-triggered
  // mode and the dwell no longer applies.
  if (!input.fire) cursor.awaitingRelease = false

  const risingEdge = input.fire && !cursor.prevFire
  // A trigger held since the card opened confirms after the dwell, so the game never
  // stops responding to the button the player is actually pressing.
  const heldPastDwell =
    cursor.awaitingRelease && input.fire && cursor.openTicks >= HELD_CONFIRM_DWELL_TICKS
  const confirmed = risingEdge || heldPastDwell
  const skipped =
    (input.special && !cursor.prevSpecial) || cursor.openTicks >= CHOICE_TIMEOUT_TICKS

  cursor.prevLeft = left
  cursor.prevRight = right
  cursor.prevFire = input.fire
  cursor.prevSpecial = input.special

  if (confirmed && optionCount > 0) {
    return { kind: 'confirm', index: cursor.index, fromDwell: heldPastDwell && !risingEdge }
  }
  if (skipped) return { kind: 'skip' }
  return { kind: 'none' }
}
