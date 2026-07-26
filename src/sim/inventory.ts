/**
 * The item inventory: what is held, what it resolves to, and which interactions
 * are live.
 *
 * This is the whole reason items can compose. Nothing here knows about any
 * specific item — it folds modifiers, collects effects, and matches interaction
 * declarations against the held set. Adding an item is a data change.
 *
 * DETERMINISM: acquisition order is preserved and is play-affecting, because
 * effects run in that order. It is therefore part of the state hash.
 */

import type {
  EffectDef,
  InteractionDef,
  ItemDef,
  StatKey,
  StatModifier,
} from '../content/types'
import type { ActiveInteraction, HeldItem } from './entities'
import { resolveAllStats } from './stats'

/** An effect with its provenance, so a report can say where a behaviour came from. */
export interface BoundEffect {
  effect: EffectDef
  /** Item id, or interaction id when the effect comes from a combination. */
  sourceId: string
  fromInteraction: boolean
}

/**
 * The hull's contribution to a build.
 *
 * Structurally a subset of `HullDef`, declared narrowly so this module cannot start
 * depending on a hull's name or flavour text. A hull modifies exactly the same
 * `StatKey` space and effect vocabulary an item does — that is what lets the two
 * compose without either knowing the other exists.
 */
export interface HullSource {
  id: string
  stats?: readonly StatModifier[]
  effects?: readonly EffectDef[]
}

export interface InventoryResolution {
  stats: Readonly<Record<StatKey, number>>
  effects: readonly BoundEffect[]
  active: readonly ActiveInteraction[]
}

/**
 * Fold the held items into stats, effects, and live interactions.
 *
 * Called when the inventory changes, not every tick.
 */
export function resolveInventory(
  held: readonly HeldItem[],
  itemsById: Readonly<Record<string, ItemDef>>,
  interactions: readonly InteractionDef[],
  hull?: HullSource,
): InventoryResolution {
  const modifiers: StatModifier[] = []
  const effects: BoundEffect[] = []

  // The hull first, because it is the thing the items are bolted to.
  //
  // Order is not cosmetic here even though the *stat* fold is order-independent by
  // construction (all adds, then all muls — see stats.ts): effect dispatch follows
  // this array, so a hull's innate behaviour must be established before anything the
  // pilot picked up modifies the situation.
  if (hull) {
    if (hull.stats) modifiers.push(...hull.stats)
    if (hull.effects) {
      for (const effect of hull.effects) {
        effects.push({ effect, sourceId: hull.id, fromInteraction: false })
      }
    }
  }

  // Items next, in acquisition order.
  for (const entry of held) {
    const def = itemsById[entry.defId]
    if (!def) continue
    // A stacked item applies its modifiers once per stack, which is what makes
    // "take it again" a meaningful choice rather than a wasted pick.
    for (let stack = 0; stack < entry.count; stack++) {
      if (def.stats) modifiers.push(...def.stats)
      if (def.effects) {
        for (const effect of def.effects) {
          effects.push({ effect, sourceId: def.id, fromInteraction: false })
        }
      }
    }
  }

  // Then interactions, which apply once regardless of stacking: a synergy is a
  // relationship between two items, not a quantity of them.
  const heldIds = new Set(held.map((entry) => entry.defId))
  const active: ActiveInteraction[] = []
  for (const interaction of interactions) {
    const [a, b] = interaction.requires
    if (!heldIds.has(a) || !heldIds.has(b)) continue
    active.push({ defId: interaction.id, text: interaction.text })
    if (interaction.stats) modifiers.push(...interaction.stats)
    if (interaction.effects) {
      for (const effect of interaction.effects) {
        effects.push({ effect, sourceId: interaction.id, fromInteraction: true })
      }
    }
  }

  return { stats: resolveAllStats(modifiers), effects, active }
}

/** Add an item, stacking if already held. Returns a new array; never mutates. */
export function addItem(
  held: readonly HeldItem[],
  defId: string,
  tick: number,
): readonly HeldItem[] {
  const existing = held.findIndex((entry) => entry.defId === defId)
  if (existing >= 0) {
    // Stacking deliberately keeps the ORIGINAL acquisition tick. Effect order is
    // play-affecting, so re-taking an item must not silently reorder the build's
    // behaviour and desynchronise a replay.
    return held.map((entry, index) =>
      index === existing ? { ...entry, count: entry.count + 1 } : entry,
    )
  }
  return [...held, { defId, acquiredAtTick: tick, count: 1 }]
}

/**
 * Interactions that taking `defId` would newly activate, given the current build.
 *
 * This is the mechanism behind UI rule 5: the choice screen asks this question
 * rather than working out for itself whether two items combine, so it cannot fail
 * to mention one. Already-active interactions are excluded — the screen is telling
 * the player what this choice *changes*.
 */
export function interactionsUnlockedBy(
  defId: string,
  held: readonly HeldItem[],
  interactions: readonly InteractionDef[],
): readonly string[] {
  const heldIds = new Set(held.map((entry) => entry.defId))
  if (heldIds.has(defId)) return []

  const out: string[] = []
  for (const interaction of interactions) {
    const [a, b] = interaction.requires
    const other = a === defId ? b : b === defId ? a : null
    if (other === null) continue
    if (heldIds.has(other)) out.push(interaction.text)
  }
  return out
}

/** Effects bound to a given hook, in dispatch order. */
export function effectsFor(
  effects: readonly BoundEffect[],
  hook: EffectDef['on'],
): readonly BoundEffect[] {
  return effects.filter((bound) => bound.effect.on === hook)
}
