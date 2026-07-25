/**
 * Reduces the held items' effects to the numbers the simulation acts on.
 *
 * AN IMPORTANT PROPERTY: every effect M3 defines is a numeric aggregation —
 * counts sum, fractions and durations take the strongest value. None of them
 * mutates shared state as it runs, so **dispatch order cannot affect the
 * outcome**, and the ordering hazard that acquisition-order dispatch would
 * otherwise create simply does not exist.
 *
 * That is worth preserving. If a future effect genuinely needs to observe what an
 * earlier effect did, it needs sequential dispatch, and that should be introduced
 * deliberately with its own determinism argument — not by quietly adding a
 * stateful effect to this reducer and discovering later that builds replay
 * differently depending on pickup order.
 *
 * Totals are recomputed when the inventory changes, not per tick.
 */

import type { EffectKind } from '../content/types'
import type { BoundEffect } from './inventory'

export interface EffectTotals {
  /** Extra projectiles per volley, and the arc they fan across. */
  splitShotCount: number
  splitShotSpreadDegrees: number
  /** Additional enemies a projectile passes through. */
  pierceCount: number
  /** A hit arcs to this many further targets within radius, for this damage fraction. */
  chainCount: number
  chainRadius: number
  chainFraction: number
  /** Fraction of damage beyond a kill that converts to scrap. */
  overkillFraction: number
  /** Fire-rate bonus and how long it lasts after collecting scrap. */
  fireRateWindowBonus: number
  fireRateWindowTicks: number
  /** Projectiles released when the hull takes damage. */
  retaliateCount: number
  /** Integrity restored per kill, and the chance of it happening. */
  repairAmount: number
  repairChance: number
}

export const NO_EFFECTS: EffectTotals = {
  splitShotCount: 0,
  splitShotSpreadDegrees: 0,
  pierceCount: 0,
  chainCount: 0,
  chainRadius: 0,
  chainFraction: 0,
  overkillFraction: 0,
  fireRateWindowBonus: 0,
  fireRateWindowTicks: 0,
  retaliateCount: 0,
  repairAmount: 0,
  repairChance: 0,
}

/** Sum a numeric param across every effect of one kind. Counts stack. */
function sumOf(effects: readonly BoundEffect[], kind: EffectKind, field: 'count' | 'amount'): number {
  let total = 0
  for (const bound of effects) {
    if (bound.effect.kind !== kind) continue
    total += bound.effect[field] ?? 0
  }
  return total
}

/**
 * Take the strongest value of a param across effects of one kind.
 *
 * Fractions, radii, and durations take the max rather than summing: two sources of
 * a 50% conversion should not silently become 100%, and two 3-second windows are
 * still a 3-second window. Summing them is how a two-item build accidentally
 * becomes infinite.
 */
function maxOf(
  effects: readonly BoundEffect[],
  kind: EffectKind,
  field: 'spreadDegrees' | 'radius' | 'fraction' | 'bonus' | 'durationTicks' | 'chance',
): number {
  let best = 0
  for (const bound of effects) {
    if (bound.effect.kind !== kind) continue
    const value = bound.effect[field] ?? 0
    if (value > best) best = value
  }
  return best
}

export function summariseEffects(effects: readonly BoundEffect[]): EffectTotals {
  if (effects.length === 0) return { ...NO_EFFECTS }
  return {
    splitShotCount: sumOf(effects, 'splitShot', 'count'),
    splitShotSpreadDegrees: maxOf(effects, 'splitShot', 'spreadDegrees'),
    pierceCount: sumOf(effects, 'pierce', 'count'),
    chainCount: sumOf(effects, 'chainOnHit', 'count'),
    chainRadius: maxOf(effects, 'chainOnHit', 'radius'),
    chainFraction: Math.min(1, maxOf(effects, 'chainOnHit', 'fraction')),
    overkillFraction: Math.min(1, maxOf(effects, 'scrapOnOverkill', 'fraction')),
    fireRateWindowBonus: maxOf(effects, 'fireRateWindow', 'bonus'),
    fireRateWindowTicks: maxOf(effects, 'fireRateWindow', 'durationTicks'),
    retaliateCount: sumOf(effects, 'retaliate', 'count'),
    repairAmount: sumOf(effects, 'repairOnKill', 'amount'),
    repairChance: Math.min(1, maxOf(effects, 'repairOnKill', 'chance')),
  }
}

/**
 * Fan angles for a volley, in radians from straight up.
 *
 * The centre shot is always kept and always dead ahead, so taking a split item
 * never *removes* the shot the player was already aiming — it adds to it. An even
 * fan with no centre would make the weapon feel worse at the moment of upgrade.
 */
export function volleyAngles(extraShots: number, spreadDegrees: number): readonly number[] {
  if (extraShots <= 0) return [0]
  const total = extraShots + 1
  const spread = (spreadDegrees > 0 ? spreadDegrees : 12) * (Math.PI / 180)
  const step = spread / extraShots
  const angles: number[] = [0]
  // Alternate outward from centre so the fan stays symmetrical at every count,
  // including even ones where a naive loop would lean to one side.
  for (let i = 1; i < total; i++) {
    const magnitude = Math.ceil(i / 2) * step
    angles.push(i % 2 === 1 ? -magnitude : magnitude)
  }
  return angles
}
