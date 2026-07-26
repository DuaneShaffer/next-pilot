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
  /**
   * Shield points per second of not being hit. 4/s refills the base 40 pool in ten
   * seconds of calm — but only while the sector's reserve lasts, which is what makes a
   * rate this visible safe to ship. See `shieldReservePerSector`.
   *
   * Floored at 0 so a curse can switch recovery off entirely — that is a real
   * drawback rather than a softlock, because the shield still absorbs. The cap is about
   * legibility rather than safety: the reserve bounds the TOTAL, so a higher rate only
   * changes how quickly a fixed budget arrives.
   */
  shieldRegenPerSecond: { base: 4, min: 0, max: 40 },
  /**
   * Ticks of quiet required before recovery starts. 150 ticks is 2.5 seconds.
   *
   * Floored at 60 (one second) rather than 0, and that floor is load-bearing: the
   * invulnerability window is 45 ticks, so a delay below it would tick recovery
   * between two hits of a sustained stream and convert the shield into flat damage
   * reduction. The floor keeps the delay strictly longer than the window however
   * many items stack on it.
   */
  shieldRegenDelayTicks: { base: 150, min: 60, max: 900, lowerIsBetter: true },
  /**
   * Shield points recovery may draw per sector. 15 is a bit over a third of the pool.
   *
   * MEASURED, not chosen. Every figure below is the `aggressor` policy's clear rate over
   * 60 five-sector runs, against a 15% baseline with recovery switched off and the M5
   * exit band of 20-40%:
   *
   *   no reserve, 4/s, 2.5s delay     76%      unbounded — the naive implementation
   *   no reserve, 4/s, 15s delay      60%      the delay is not the lever
   *   no reserve, 1/s                 75%
   *   no reserve, 0.25/s              48%
   *   no reserve, 0.1/s               30%      in band, but invisible: 6.5 min per pool
   *   reserve 30/sector               43%
   *   reserve 20/sector               42%
   *   reserve 15/sector               35%      <- shipped
   *   reserve 10/sector               28%
   *
   * The two rows worth understanding together are `0.1/s` and `reserve 20`: both allow
   * ~100 points across a run, and the reserve version is 12pp stronger. That is the
   * mechanic working — the same total is worth more when it arrives where the player
   * chooses rather than smeared across the clock — and it is why the reserve can be
   * spent at a visible 4/s instead of a rate nobody would notice.
   *
   * Floored at 0: a curse may take the reserve away entirely, which switches recovery
   * off without touching the pool that absorbs.
   */
  shieldReservePerSector: { base: 15, min: 0, max: 400 },
  scrapMultiplier: { base: 1, min: 0, max: 20 },
  pickupRadius: { base: 34, min: 8, max: 260 },
  /** Focus speed multiplier. Above 1 would make focusing *faster*, so it is capped. */
  /**
   * `lowerIsBetter`, and it was missing.
   *
   * Focus multiplies hull speed while held, so a *smaller* factor is a *tighter*
   * hold — which is the entire point of the key. Without the flag, any screen that
   * signs a delta from this table would tell the player that a hull raising their
   * focus factor had improved it. Nothing moves this stat today, so nothing is wrong
   * on screen right now; the first item or hull that touches it would have shipped a
   * green plus sign on a drawback. Found by the hull-selection screen, which is the
   * first consumer to sign deltas from this table at all.
   */
  focusFactor: { base: 0.45, min: 0.1, max: 1, lowerIsBetter: true },
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
