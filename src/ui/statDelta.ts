/**
 * What an offered item does to *this* ship.
 *
 * ## The defect this file exists to close
 *
 * An item card used to state only its own authored sentence — "+22 max shield",
 * "+45% projectile damage" — which is a fact about the *item*, not about the run the
 * player is in. Two ways that misinforms, both reachable with shipped content:
 *
 * - **Shield Cell on a hull holding Exposed Core.** The curse sets `maxShield` to
 *   `mul 0`; the fold applies every `add` first and every `mul` after, so the cell's
 *   +22 is multiplied to nothing. The card promised +22 max shield and the pick was
 *   worth exactly zero, and nothing on screen could say so.
 * - **Any `mul`.** "+45% projectile damage" is +1.8 damage on a base gun and +14 on a
 *   build already stacking Machined Slugs. The percentage is the same sentence for
 *   both, and the number the player actually cares about is not on the card.
 *
 * So every offer whose def carries `StatModifier`s also gets its resolved
 * before → after for the current build, folded through the same `src/sim/stats.ts`
 * table the simulation reads.
 *
 * ## WHY THE DELTA CANNOT BE APPLIED TO THE RESOLVED VALUE
 *
 * The obvious implementation — take `WorldView.resolvedStats`, add the item's `add`
 * or scale by its `mul` — is wrong for every `mul` item and every clamped stat,
 * because the fold order is fixed at *all adds, then all muls* (see `resolveStat`).
 * With Machined Slugs held, damage resolves as `(4 + 1) = 5`; Warheads then gives
 * `5 × 1.45 = 7.25`, not `5 + 45% of the item's own 1.8`. And a stat at its bound —
 * `fireIntervalTicks` floors at 1 — moves less than its modifier claims, or not at
 * all. The only correct answer is to **re-resolve from the whole modifier list**,
 * which is what `statDeltaRows` does.
 *
 * ## The cross-check, and why "before" is gated on it
 *
 * `collectBuildModifiers` mirrors `resolveInventory` read-only rather than being
 * handed the sim's list, so it can silently disagree with the run — an unknown hull
 * id, a content table the `World` was not built with. A card quoting a "before" the
 * instrument panel contradicts is worse than a card quoting nothing, so
 * `statDeltaRows` takes the simulation's own `resolvedStats` and **drops any row
 * whose reconstructed before does not match it**. This screen has no business being
 * the second place in the codebase that decides what a stat is worth.
 *
 * ## Presentation is copied from `src/ui/hullSelect.ts`, deliberately
 *
 * Same labels, same units, same `numeral` rounding, same `signed` sign, same
 * derivation of better/worse from `STATS[stat].lowerIsBetter` rather than from the
 * sign of the printed delta — because those two disagree for `fireIntervalTicks`,
 * where a *lower* raw value is a *higher* shots/second. Two screens that both show
 * a stat delta must show it the same way round or the player learns neither.
 *
 * It is copied and not imported because that module is being edited concurrently and
 * its table is private to it. Collapsing the two into this file is the follow-up, and
 * `tests/statDelta.test.ts` pins the vocabulary so the copies cannot drift apart
 * without a test saying so.
 */

import { HULLS } from '../content/hulls'
import { INTERACTIONS } from '../content/interactions'
import type { HullDef, InteractionDef, ItemDef, StatKey, StatModifier } from '../content/types'
import { TICK_HZ } from '../core/loop'
import type { ActiveInteraction, HeldItem, ResolvedStats } from '../sim/entities'
import { STATS, STAT_KEYS, resolveStat, shotsPerSecond } from '../sim/stats'

interface StatPresentation {
  /** Short enough to share a card row with two numbers and a delta. */
  label: string
  /** Rule 2. Never empty. */
  unit: string
  /**
   * Raw stat value to the number a player thinks in.
   *
   * `fireIntervalTicks` is the reason this exists: ticks are a simulation unit, and
   * "3 → 2 ticks" asks the player to reason about the engine. Shown as shots/second
   * the same change reads as "20 → 30 shots/s", and the direction flips — which is
   * why `direction` below is derived from the raw value and never from this one.
   */
  present?: (value: number) => number
  /**
   * Stats which, at zero, make this one do nothing whatever its own value.
   *
   * Declared as data because it is a fact about the *simulation's* wiring, not about
   * presentation: shield recovery draws from a per-sector reserve into the shield pool,
   * so a build with no shield or no reserve recovers nothing however fast the rate says
   * it recovers. Reachable with shipped content — Exposed Core sets `maxShield` to
   * `mul 0` — and it is the same defect as a `maxShield` item on a hull with no shield:
   * a card printing "4 → 6 hp/s" there is advertising a number that cannot happen.
   *
   * The row is still shown, still with both numbers. Only the parenthetical changes, to
   * name the stat that is holding it at nothing.
   */
  inertWhen?: readonly StatKey[]
}

/**
 * How each stat reads on a card.
 *
 * Total over `StatKey` on purpose: adding a stat to `src/sim/stats.ts` without
 * deciding how it is written is a compile error here rather than a bare number on
 * screen.
 */
const STAT_DISPLAY: Readonly<Record<StatKey, StatPresentation>> = {
  fireIntervalTicks: { label: 'Fire rate', unit: 'shots/s', present: shotsPerSecond },
  projectileDamage: { label: 'Shot damage', unit: 'dmg' },
  projectileSpeed: { label: 'Shot speed', unit: 'u/s' },
  projectilesPerShot: { label: 'Rounds per shot', unit: 'rounds' },
  hullSpeed: { label: 'Hull speed', unit: 'u/s' },
  maxIntegrity: { label: 'Max integrity', unit: 'hp' },
  maxShield: { label: 'Max shield', unit: 'hp' },
  scrapMultiplier: { label: 'Scrap yield', unit: '%', present: (v) => v * 100 },
  pickupRadius: { label: 'Pickup radius', unit: 'u' },
  focusFactor: { label: 'Focus speed', unit: '%', present: (v) => v * 100 },
  // The three recovery stats compose as "how fast", "how long after a hit", and "how
  // much per sector", and all three are inert without a shield to put it in.
  shieldRegenPerSecond: {
    label: 'Shield regen',
    unit: 'hp/s',
    inertWhen: ['maxShield', 'shieldReservePerSector'],
  },
  // The unit is per *sector*, and saying so is the whole information: "20 hp" next to a
  // regen rate would read as a pool rather than as a per-sector budget. Labelled exactly
  // as `hullSelect.ts` labels it, so the two screens name the same stat the same way.
  shieldReservePerSector: { label: 'Regen reserve', unit: 'hp/sector', inertWhen: ['maxShield'] },
  // Ticks are an engine unit, exactly like `fireIntervalTicks`. Seconds is the number
  // a player can hold against the 2.5 s of quiet they are trying to buy.
  shieldRegenDelayTicks: {
    label: 'Regen delay',
    unit: 's',
    present: (v) => v / TICK_HZ,
    inertWhen: ['maxShield', 'shieldReservePerSector'],
  },
}

/**
 * The card's numeric precision: one decimal.
 *
 * Applied to the two values BEFORE the delta is taken, so the row's own arithmetic
 * checks out. Subtracting the unresolved values instead printed `8.1 → 9.5 (+1.3)`,
 * which invites the reader to conclude one of the three numbers is wrong.
 */
function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** At most one decimal, and no trailing `.0`. Tabular figures stay scannable. */
export function numeral(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const rounded = round1(value)
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** `+10`, `-30`. The sign is always shown — rule 2's second half. */
export function signed(value: number): string {
  return value > 0 ? `+${numeral(value)}` : numeral(value)
}

/** Column separator inside a row. Two spaces read as a column in monospace. */
const GAP = '  '

/** Said in words, so a pick worth nothing is never left to a colour to convey. */
export const NO_CHANGE_TEXT = '(no change)'

export interface StatDeltaRow {
  stat: StatKey
  label: string
  unit: string
  /** Presented value with the current build, at the precision the card prints. */
  before: number
  /** Presented value if this item is taken, at the precision the card prints. */
  after: number
  /** `after - before`, in presented units. Consistent with the two printed numbers. */
  delta: number
  /**
   * Derived from the RAW values and `STATS[stat].lowerIsBetter`, never from the sign
   * of `delta` — those disagree for `fireIntervalTicks`, and agreeing with the wrong
   * one would paint a faster gun as a drawback.
   *
   * `none` when the item moves this stat by less than the card can print: a bound was
   * already reached, or a `mul` was multiplied away by something already held. That is
   * the case the authored sentence cannot express and the whole reason for this file.
   *
   * `inert` when the number does move but cannot matter, because a stat it depends on is
   * at zero — see `inertWhen`. Distinguished from `none` rather than folded into it so a
   * reader of this row can tell "the number did not change" from "the number changed and
   * the change cannot do anything".
   */
  direction: 'better' | 'worse' | 'none' | 'inert'
  /** `Max shield  40 → 62 hp` */
  text: string
  /** `(+22)`, or `(no change)`. Signed, in the unit the row already names. */
  deltaText: string
}

export interface BuildModifierSources {
  /** `WorldView.hullId`. Unknown ids contribute nothing rather than throwing. */
  hullId?: string
  held: readonly HeldItem[]
  items: Readonly<Record<string, ItemDef>>
  /** Interactions the SIM says are live. This module never decides that question. */
  activeInteractions: readonly ActiveInteraction[]
  hulls?: Readonly<Record<string, HullDef>>
  interactions?: readonly InteractionDef[]
}

/**
 * Every modifier currently in play, mirroring `resolveInventory` read-only.
 *
 * Order is irrelevant to the result by construction (all adds, then all muls) but it
 * follows the simulation's anyway — hull, then items in acquisition order, then live
 * interactions — so the two can be read side by side.
 *
 * Interaction *stats* are looked up from the content table by the ids the sim already
 * marked active. That is not this screen deciding whether two items combine — rule 5
 * keeps that in the sim — it is reading the numbers of a combination the sim declared.
 * Omitting them would put every deep build's `before` out of step with the panel, and
 * the guard in `statDeltaRows` would then drop the rows exactly when they matter most.
 */
export function collectBuildModifiers(sources: BuildModifierSources): readonly StatModifier[] {
  const hulls = sources.hulls ?? HULLS
  const interactions = sources.interactions ?? INTERACTIONS
  const modifiers: StatModifier[] = []

  const hull = sources.hullId === undefined ? undefined : hulls[sources.hullId]
  if (hull) modifiers.push(...hull.stats)

  for (const entry of sources.held) {
    const def = sources.items[entry.defId]
    if (!def?.stats) continue
    // Once per stack, matching `resolveInventory`: taking an item twice applies it
    // twice, and a card that ignored the stack would quote a before the panel does not.
    const count = Number.isFinite(entry.count) ? Math.max(0, Math.trunc(entry.count)) : 0
    for (let stack = 0; stack < count; stack++) modifiers.push(...def.stats)
  }

  const live = new Set(sources.activeInteractions.map((entry) => entry.defId))
  for (const interaction of interactions) {
    // Once regardless of stacking: a synergy is a relationship, not a quantity.
    if (live.has(interaction.id) && interaction.stats) modifiers.push(...interaction.stats)
  }

  return modifiers
}

export interface StatDeltaInput {
  /** Modifiers already in play. From `collectBuildModifiers`. */
  current: readonly StatModifier[]
  /** The offered item's own modifiers. */
  added: readonly StatModifier[]
  /**
   * `WorldView.resolvedStats`, when there is a run.
   *
   * A row is dropped when the reconstruction disagrees with it, so the card can never
   * quote a "before" the instrument panel contradicts.
   */
  resolved?: ResolvedStats
}

/** Tolerance for the cross-check. Two identical folds differ only by float noise. */
const MATCH_EPSILON = 1e-9

/**
 * The resolved before → after rows for one offer.
 *
 * Only stats the item actually names, in `STAT_KEYS` order so two offers touching the
 * same pair of stats list them the same way round. A stat the item moves by nothing
 * still gets a row: "max shield 0 → 0 hp (no change)" is the single most useful thing
 * this screen can tell a player holding Exposed Core, and it is unsayable in prose
 * written before the run began.
 */
export function statDeltaRows(input: StatDeltaInput): readonly StatDeltaRow[] {
  const named = new Set(input.added.map((modifier) => modifier.stat))
  if (named.size === 0) return []

  const after = [...input.current, ...input.added]
  const rows: StatDeltaRow[] = []

  for (const stat of STAT_KEYS) {
    if (!named.has(stat)) continue
    const spec = STATS[stat]
    const display = STAT_DISPLAY[stat]
    const rawBefore = resolveStat(stat, input.current)
    const rawAfter = resolveStat(stat, after)

    const sim = input.resolved?.[stat]
    // The gate. A mismatch means this module's reconstruction of the build is not the
    // build the run is flying, and the honest response is to say nothing about it.
    if (sim !== undefined && Math.abs(sim - rawBefore) > MATCH_EPSILON) continue

    const present = display.present ?? ((value: number) => value)
    const before = round1(present(rawBefore))
    const value = round1(present(rawAfter))
    // Compared as PRINTED, not as raw: a change too small to appear in the numbers on
    // the card must not be announced as an improvement the player cannot see.
    const moved = before !== value
    const improved = spec.lowerIsBetter === true ? rawAfter < rawBefore : rawAfter > rawBefore
    const delta = round1(value - before)

    // Read AFTER the item is fitted, because that is the state the player is deciding
    // about: an item that raises the gate stat off zero itself is not inert.
    const inert = (display.inertWhen ?? []).find((gate) => resolveStat(gate, after) === 0)
    const direction = inert !== undefined ? 'inert' : !moved ? 'none' : improved ? 'better' : 'worse'
    const deltaText =
      inert !== undefined
        ? // Names the stat holding it at nothing, built from that stat's own label so the
          // two rows on the card use one vocabulary.
          `(no effect: ${STAT_DISPLAY[inert].label.toLowerCase()} 0)`
        : moved
          ? `(${signed(delta)})`
          : NO_CHANGE_TEXT

    rows.push({
      stat,
      label: display.label,
      unit: display.unit,
      before,
      after: value,
      delta,
      direction,
      text: `${display.label}${GAP}${numeral(before)} → ${numeral(value)} ${display.unit}`,
      deltaText,
    })
  }

  return rows
}
