/**
 * Run progression: when the run stops to offer a choice, and how a choice is
 * resolved from player input.
 *
 * Kept out of world.ts because it is a policy question ("the run pauses for a
 * reward after wave 6") rather than a simulation mechanic, and because the input
 * edge-detection below is fiddly enough to deserve its own tests.
 */

import type { InteractionDef, ItemDef } from '../content/types'
import type { InputSnapshot } from '../core/input'
import { Rng } from '../core/rng'
import type { HeldItem, ItemOffer, PendingChoice, PendingChoiceKind } from './entities'
import { interactionsUnlockedBy } from './inventory'

/** How many options a choice presents. Three is the genre default and it fits the card. */
export const OFFER_COUNT = 3

/**
 * Wave indices after which the run pauses for a reward.
 *
 * Chosen against sector 1's phases (see content/sectors.ts): after the opening
 * teaches aiming, after projectiles are introduced, mid-pressure, and before the
 * escalation. Four item choices per clear, which is enough for a build to develop
 * inside one sector without the run becoming a menu.
 *
 * A shop lands between them so scrap has somewhere to go before the run ends —
 * scrap that can only be spent after extraction is not an economy, it is a score.
 */
export const ITEM_CHOICE_WAVES: readonly number[] = [4, 11, 19, 26]
export const SHOP_WAVES: readonly number[] = [8, 23]
export const WORK_ORDER_WAVES: readonly number[] = [15]

/** Base scrap price for a shop option, before tier scaling. */
const SHOP_BASE_COST = 120

/**
 * Build the three offers for a choice.
 *
 * Draws from the `offers` stream — its own named stream, never `loot`, because a
 * cosmetic or unrelated roll must never be able to shift which items a player is
 * shown. Excludes items already held at max stack and items with zero weight.
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

export function shopCosts(
  offers: readonly ItemOffer[],
  itemsById: Readonly<Record<string, ItemDef>>,
): readonly number[] {
  return offers.map((offer) => {
    const tier = itemsById[offer.defId]?.tier ?? 'common'
    return Math.round(SHOP_BASE_COST * TIER_COST_MULTIPLIER[tier])
  })
}

export function makeChoice(
  kind: PendingChoiceKind,
  offers: readonly ItemOffer[],
  costs: readonly number[],
  workOrders: readonly string[] = [],
): PendingChoice {
  return { kind, offers, costs, workOrders }
}

/**
 * Selection state while a choice is open.
 *
 * Lives in the simulation because it is resolved from `InputSnapshot` and must
 * replay identically — a recorded run has to make the same picks.
 */
export interface ChoiceCursor {
  index: number
  /** Ticks this choice has been open, for the deadlock guard. */
  openTicks: number
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
 * 60 seconds: far longer than any real decision, short enough that a stuck run
 * eventually ends rather than hanging.
 */
export const CHOICE_TIMEOUT_TICKS = 60 * 60

export type ChoiceAction = { kind: 'none' } | { kind: 'confirm'; index: number } | { kind: 'skip' }

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
): ChoiceAction {
  const left = input.moveX < 0
  const right = input.moveX > 0

  if (left && !cursor.prevLeft) cursor.index -= 1
  if (right && !cursor.prevRight) cursor.index += 1
  if (optionCount > 0) {
    cursor.index = ((cursor.index % optionCount) + optionCount) % optionCount
  } else {
    cursor.index = 0
  }

  cursor.openTicks++
  const confirmed = input.fire && !cursor.prevFire
  const skipped =
    (input.special && !cursor.prevSpecial) || cursor.openTicks >= CHOICE_TIMEOUT_TICKS

  cursor.prevLeft = left
  cursor.prevRight = right
  cursor.prevFire = input.fire
  cursor.prevSpecial = input.special

  if (confirmed && optionCount > 0) return { kind: 'confirm', index: cursor.index }
  if (skipped) return { kind: 'skip' }
  return { kind: 'none' }
}
