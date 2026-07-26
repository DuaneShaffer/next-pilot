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
 * Two properties, both required, and they conflict unless handled deliberately:
 *
 * 1. **The centre shot is always kept, dead ahead.** Taking a split item must never
 *    *remove* the shot the player was already aiming with; it adds to it. A
 *    centreless even fan makes the weapon feel worse at the moment of upgrade.
 * 2. **The fan is symmetrical.** An earlier version alternated outward from centre,
 *    which for an ODD number of extras left the last one unpaired — a "+1
 *    projectile" item sent its entire extra shot 24° to the LEFT with nothing
 *    balancing it. Aim drifting sideways when you buy an upgrade is indefensible.
 *
 * Resolved by pairing: extras are placed in mirrored ±pairs, and an odd leftover
 * reinforces the CENTRE rather than picking a side. Two rounds dead ahead is a
 * coherent outcome — more punch on the aim line — where a lone off-axis round is
 * not.
 */
export function volleyAngles(extraShots: number, spreadDegrees: number): readonly number[] {
  if (extraShots <= 0) return [0]
  const spread = (spreadDegrees > 0 ? spreadDegrees : 12) * (Math.PI / 180)
  const pairs = Math.floor(extraShots / 2)
  const angles: number[] = [0]

  // `spreadDegrees` is the TOTAL arc width, so the outermost pair sits at ±half of
  // it and the span is the requested width for ANY extra count. The previous
  // divisor (spread / extraShots) held that only for two extras: at four the arc
  // silently opened to double the width content asked for.
  const half = spread / 2
  const step = pairs > 0 ? half / pairs : half
  for (let pair = 1; pair <= pairs; pair++) {
    angles.push(-pair * step, pair * step)
  }
  // Odd leftover: a second centre round, not an unpaired flanker.
  if (extraShots % 2 === 1) angles.push(0)
  return angles
}
