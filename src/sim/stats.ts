/**
 * Stat resolution.
 *
 * Every number an item can change lives here with its base value and its bounds,
 * and every consumer reads the resolved value rather than the base. That is what
 * lets twelve items compose without any of them knowing about the others.
 *
 * THE FOLD ORDER IS FIXED (see StatKey's docs in content/types.ts): all `add`
 * modifiers are summed onto the base, then all `mul` modifiers are applied to that
 * subtotal, then the stat's own bounds clamp the result. Never interleaved by
 * acquisition order — otherwise the same two items produce different numbers
 * depending on which was found first, and a build stops being reproducible from
 * its seed.
 */

import type { StatKey, StatModifier } from '../content/types'
import { TICK_HZ } from '../core/loop'

interface StatSpec {
  base: number
  /**
   * Hard floor. Bounds live with the stat rather than the modifier because they
   * are a property of the thing being measured: a fire interval must never reach
   * zero however many items stack, and that is true regardless of which item
   * pushed it there.
   */
  min: number
  max: number
  /** True when a *lower* value is better, so the HUD can sign deltas correctly. */
  lowerIsBetter?: boolean
}

/**
 * The stat table.
 *
 * Bases mirror the constants the simulation used before items existed, so a run
 * with an empty inventory behaves exactly as it did in M2. Any change here is a
 * balance change to every run, not just to item builds.
 */
export const STATS: Readonly<Record<StatKey, StatSpec>> = {
  /**
   * Ticks between shots. 3 ticks is 20 shots/second.
   *
   * Floored at 1 rather than 0: a zero interval is an infinite fire rate, which is
   * both a divide-by-zero waiting to happen and instantly past every projectile
   * cap. Capped at 30 so a cursed item cannot make the weapon useless.
   */
  fireIntervalTicks: { base: 3, min: 1, max: 30, lowerIsBetter: true },
  projectileDamage: { base: 4, min: 1, max: 400 },
  projectileSpeed: { base: 620, min: 120, max: 2400 },
  /** Floored at 1 — a build that fires nothing is a softlock, not a trade-off. */
  projectilesPerShot: { base: 1, min: 1, max: 12 },
  hullSpeed: { base: 210, min: 60, max: 620 },
  maxIntegrity: { base: 100, min: 1, max: 999 },
  maxShield: { base: 40, min: 0, max: 999 },
  scrapMultiplier: { base: 1, min: 0, max: 20 },
  pickupRadius: { base: 34, min: 8, max: 260 },
  /** Focus speed multiplier. Above 1 would make focusing *faster*, so it is capped. */
  focusFactor: { base: 0.45, min: 0.1, max: 1 },
}

export const STAT_KEYS = Object.keys(STATS) as readonly StatKey[]

/** Resolve one stat from its base and the modifiers currently in play. */
export function resolveStat(stat: StatKey, modifiers: readonly StatModifier[]): number {
  const spec = STATS[stat]

  // Pass 1: additions. Summed first so the multiplicative pass sees a complete
  // subtotal, which is what makes the result independent of pickup order.
  let value = spec.base
  for (const modifier of modifiers) {
    if (modifier.stat === stat && modifier.kind === 'add') value += modifier.value
  }

  // Pass 2: multiplications, applied to the subtotal.
  for (const modifier of modifiers) {
    if (modifier.stat === stat && modifier.kind === 'mul') value *= modifier.value
  }

  if (!Number.isFinite(value)) return spec.base
  return Math.min(spec.max, Math.max(spec.min, value))
}

/**
 * Resolve every stat at once.
 *
 * Recomputed when the inventory changes rather than per tick — the fold is cheap
 * but it is not free, and a stat cannot change without an item changing.
 */
export function resolveAllStats(
  modifiers: readonly StatModifier[],
): Readonly<Record<StatKey, number>> {
  const out = {} as Record<StatKey, number>
  for (const key of STAT_KEYS) out[key] = resolveStat(key, modifiers)
  return out
}

/**
 * Shots per second, derived from the resolved interval.
 *
 * The HUD must display this rather than computing its own: a panel that advertised
 * 10 shots/s while the weapon fired 20 has already shipped once in this project,
 * and items are about to make that number move constantly.
 */
export function shotsPerSecond(fireIntervalTicks: number): number {
  return TICK_HZ / Math.max(1, fireIntervalTicks)
}
