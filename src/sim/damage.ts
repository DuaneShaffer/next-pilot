/**
 * Damage application and run-loss.
 *
 * Everything that can reduce the hull goes through `applyHullDamage`, so the
 * invulnerability window, the shield rule, and death attribution exist in exactly
 * one place. A second code path that subtracted from `integrity` directly would
 * quietly bypass all three.
 */

import { TICK_SECONDS } from '../core/loop'
import type {
  DeathCauseKind,
  EnemyInstance,
  Hull,
  Incident,
  RunState,
  RunStats,
} from './entities'

/**
 * The hull's collision radius, in virtual units.
 *
 * DO NOT "fix" this to match the drawn ship. The silhouette is ~22 units wide and
 * ~28 tall; the hitbox is a circle of radius 5.5 at its centre — the cockpit, a
 * quarter of the ship's width. That mismatch is intentional and standard for the
 * genre, and it is what makes dodging feel fair instead of
 * arbitrary: the player reads their position from the centre of mass of their
 * ship, not from its wingtips, so a hitbox that covered the wings would register
 * hits the player is certain they avoided. Enemy bullets keep their generous
 * visual radius, so incoming fire stays honest in the other direction.
 */
export const HULL_COLLISION_RADIUS = 5.5

/**
 * Invulnerability after a hit: 0.75 seconds.
 *
 * Long enough to escape the pattern that hit you, which matters because a hit
 * usually means you are already inside something bad. Without it, one bad frame
 * inside a spread costs three hits and the death reads as random.
 */
export const HULL_INVULN_TICKS = 45

/** Enemy hit flash duration. Render-only, but the sim owns the countdown. */
export const ENEMY_HIT_FLASH_TICKS = 5

/**
 * The mutable slice of a run that damage may write to.
 *
 * Declared as an interface rather than taking the World so this module stays
 * testable in isolation and cannot reach for anything else on the world.
 */
export interface DamageContext {
  hull: Hull
  stats: RunStats
  runState: RunState
  incident: Incident | null
}

/** Count down the invulnerability window. Call once per tick, before collisions. */
export function tickHullInvulnerability(hull: Hull): void {
  if (hull.invulnTicks > 0) hull.invulnTicks--
}

/**
 * Apply damage to the hull. Returns true if the hit actually landed.
 *
 * Returning false for an ignored hit (invulnerable, or the run is already over)
 * lets callers skip the impact effects, so the player never sees a flash for a
 * hit that did nothing.
 */
export function applyHullDamage(
  ctx: DamageContext,
  amount: number,
  causeKind: DeathCauseKind,
  causeEnemyId: string | null,
): boolean {
  if (ctx.runState !== 'active') return false
  if (ctx.hull.invulnTicks > 0) return false
  if (amount <= 0) return false

  const hull = ctx.hull

  // Shield absorbs first and does not regenerate in M1, so it reads as a one-off
  // buffer rather than as a slowly refilling second health bar.
  let remaining = amount
  if (hull.shield > 0) {
    const absorbed = remaining < hull.shield ? remaining : hull.shield
    hull.shield -= absorbed
    remaining -= absorbed
  }
  if (remaining > 0) hull.integrity -= remaining

  ctx.stats.damageTaken += amount
  hull.invulnTicks = HULL_INVULN_TICKS

  if (hull.integrity <= 0) {
    hull.integrity = 0
    ctx.runState = 'lost'
    // Filed exactly once. The runState guard above already makes a second call
    // impossible, but the report is the only record of the run and a duplicated
    // or overwritten cause would misattribute a death.
    if (ctx.incident === null) {
      ctx.incident = {
        causeKind,
        causeEnemyId,
        tick: ctx.stats.tick,
        secondsSurvived: ctx.stats.tick * TICK_SECONDS,
        waveIndex: ctx.stats.waveIndex,
        scrap: ctx.stats.scrap,
        kills: ctx.stats.kills,
      }
    }
  }

  return true
}

/** Apply damage to an enemy. Returns true if this hit destroyed it. */
export function applyEnemyDamage(e: EnemyInstance, amount: number): boolean {
  if (!e.alive) return false
  e.hp -= amount
  e.hitFlashTicks = ENEMY_HIT_FLASH_TICKS
  if (e.hp > 0) return false
  e.hp = 0
  e.alive = false
  return true
}
