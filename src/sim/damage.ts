/**
 * Damage application and run-loss.
 *
 * Everything that can reduce the hull goes through `applyHullDamage`, so the
 * invulnerability window, the shield rule, and death attribution exist in exactly
 * one place. A second code path that subtracted from `integrity` directly would
 * quietly bypass all three.
 *
 * This module also owns the *impact budget*: how much hitstop and screen shake a
 * given hit buys. Those are pure functions of the damage, they live next to the
 * damage rules for the same reason the shield rule does — so there is one place to
 * read and one place to tune — and being pure makes them testable without a World.
 * Applying the budget is `world.ts`'s job; deciding its size is this file's.
 */

import { TICK_HZ, TICK_SECONDS } from '../core/loop'
import { STATS } from './stats'
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

// --- the impact budget ------------------------------------------------------

/**
 * The hard ceiling on a single freeze: 8 ticks, 133ms.
 *
 * A long freeze does not read as weight, it reads as a dropped frame or a hang.
 * This is the number that keeps hitstop a feel feature instead of a bug report.
 * Every function below clamps to it, and `extendFreeze` clamps again where the
 * world applies it, so no caller can exceed it however the budget is later retuned.
 */
export const FREEZE_MAX_TICKS = 8

/**
 * Ticks of enforced motion after a freeze, per tick of freeze served.
 *
 * THE CEILING ABOVE BOUNDS ONE FREEZE. IT DOES NOT BOUND HOW OFTEN ONE HAPPENS, and
 * for a long time nothing did. `world.ts` carried an invariant reading "that plus the
 * ceiling in `extendFreeze` bounds every freeze at FREEZE_MAX_TICKS, full stop" — true,
 * about the wrong quantity. Nothing stopped a new freeze beginning on the very first
 * tick after the last one ended, so the reachable duty cycle was 8 frozen to 1 running:
 * 89% of the time stopped.
 *
 * Measured before this constant existed, worst single second of each sector, aggressor
 * over a full run (frozen ticks out of 60):
 *
 *   bare hull      22% / 47% / 65% / 75% / 72%
 *   +8 damage      38% / 70% / 82% / 83% / 87%
 *
 * 87% is eight ticks of simulation in a second. Reported from play as "the game seems
 * to be lagging", which is exactly what it is — the sim stops and the renderer keeps
 * drawing the same frame.
 *
 * A ratio rather than a flat cooldown, so the bound is uniform: serving N ticks costs
 * 3N ticks of enforced motion, which caps the enemy-hit duty cycle at 1/(1+3) = 25%
 * whatever the freeze budget is later retuned to. A flat cooldown would leave short
 * freezes chaining and long ones over-punished.
 *
 * HULL HITS ARE EXEMPT — see `World.addImpact`. They are the more important event, and
 * they are already rate-limited to one per `HULL_INVULN_TICKS`, so they cannot chain.
 */
export const FREEZE_LOCKOUT_RATIO = 3

/**
 * Damage per tick of freeze.
 *
 * 8 is chosen against the player's weapon, not in the abstract: a bullet does 4
 * damage every 3 ticks, so a plain hit buys *zero* ticks. That is deliberate. At
 * 20 shots/second, one tick per hit would leave the game frozen a third of the
 * time and the weapon would feel like it was firing through mud. Hitstop has to be
 * reserved for events that matter, or it stops meaning anything.
 */
const FREEZE_DAMAGE_PER_TICK = 8

/**
 * A kill freezes for this much on top of the damage that caused it, which is what
 * makes a kill land differently from a glancing hit.
 */
const FREEZE_KILL_TICKS = 3

/** Taking a hit freezes harder than dealing one: it is the more important event. */
const FREEZE_HULL_HIT_TICKS = 4

/**
 * Shake impulses, 0..1. These are *impulses*, not offsets — the renderer converts
 * them to pixels (and is free to scale them down or ignore them entirely under a
 * reduced-motion setting), so nothing here is measured in pixels on purpose.
 */
const SHAKE_HIT_BASE = 0.045
const SHAKE_PER_DAMAGE = 0.004
const SHAKE_KILL = 0.16
const SHAKE_HULL_HIT = 0.45
/** Losing the shield is a state change the player must not miss. */
export const SHAKE_SHIELD_BROKEN = 0.2

function clampFreeze(ticks: number): number {
  if (!Number.isFinite(ticks) || ticks < 0) return 0
  return ticks < FREEZE_MAX_TICKS ? Math.floor(ticks) : FREEZE_MAX_TICKS
}

function clampShake(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) return 0
  return amount < 1 ? amount : 1
}

function scaledByDamage(damage: number): number {
  if (!Number.isFinite(damage) || damage <= 0) return 0
  return Math.floor(damage / FREEZE_DAMAGE_PER_TICK)
}

/** Ticks of hitstop earned by damaging an enemy. `lethal` means it destroyed it. */
export function freezeForEnemyHit(damage: number, lethal: boolean): number {
  return clampFreeze(scaledByDamage(damage) + (lethal ? FREEZE_KILL_TICKS : 0))
}

export function shakeForEnemyHit(damage: number, lethal: boolean): number {
  const scaled = Number.isFinite(damage) && damage > 0 ? damage * SHAKE_PER_DAMAGE : 0
  return clampShake(SHAKE_HIT_BASE + scaled + (lethal ? SHAKE_KILL : 0))
}

/**
 * Ticks of hitstop earned by a hit on the hull. `fatal` means the run just ended,
 * which gets the whole budget — there is no next hit to save it for.
 */
export function freezeForHullHit(damage: number, fatal: boolean): number {
  if (fatal) return FREEZE_MAX_TICKS
  return clampFreeze(FREEZE_HULL_HIT_TICKS + scaledByDamage(damage))
}

export function shakeForHullHit(damage: number, fatal: boolean): number {
  if (fatal) return 1
  const scaled = Number.isFinite(damage) && damage > 0 ? damage * SHAKE_PER_DAMAGE : 0
  return clampShake(SHAKE_HULL_HIT + scaled)
}

/**
 * Combine an existing freeze with a newly granted one: the LONGER, never the sum.
 *
 * Four enemies dying to the same death burst is one impact, not four. Summing
 * would let a single lucky tick stop the game dead, and it is the failure mode that
 * turns hitstop from a feel feature into a bug report.
 *
 * A pure function rather than two lines inside `World` because the rule is the
 * whole safety property and it must be assertable directly. Driving it through the
 * sim cannot do that: the player's weapon lands at most one hit per tick, so a
 * summing bug would sit there unobserved until an M3 item fired a piercing shot or
 * a bomb and every multi-kill locked the screen.
 */
export function extendFreeze(current: number, granted: number): number {
  const longest = clampFreeze(granted) > current ? clampFreeze(granted) : current
  return longest < FREEZE_MAX_TICKS ? longest : FREEZE_MAX_TICKS
}

/**
 * Accumulate shake, clamped into 0..1.
 *
 * Additive where freeze is not, because shake is energy rather than time: two
 * simultaneous kills legitimately shake harder than one, and a shake that is
 * already at full strength simply stays there.
 */
export function addShake(current: number, impulse: number): number {
  return clampShake(current + clampShake(impulse))
}

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
  /**
   * Resolved `shieldRegenDelayTicks`, passed in rather than read off the world.
   *
   * Damage is the only thing that knows a hit landed, so it has to be what starts
   * the suppression clock; but this module deliberately cannot reach the stat table,
   * so the caller supplies the resolved value. Optional so the fallback is the
   * stat's own base — a caller that forgets still suppresses recovery, which fails
   * safe. Silently *not* suppressing would be the dangerous default.
   */
  shieldRegenDelayTicks?: number
}

/** Count down the invulnerability window. Call once per tick, before collisions. */
export function tickHullInvulnerability(hull: Hull): void {
  if (hull.invulnTicks > 0) hull.invulnTicks--
}

/**
 * Advance shield recovery by one tick. Call once per tick, alongside the invuln
 * countdown.
 *
 * Whole ticks and whole points: the per-tick share of the rate is banked in
 * `shieldRegenProgress` and only moves `shield` when a full point is due. There is
 * no `deltaTime` here and there must never be — a recovery that scaled with frame
 * time would make the same seed produce a different run on a slower machine.
 *
 * The suppression clock counts down first and gates recovery in the same tick, so a
 * hit taken on tick N cannot be followed by a point of shield on tick N + delay - 1.
 *
 * Every point recovered spends one from `hull.shieldReserve`, which is refilled per
 * sector. That bound is not a detail — it is the only reason a rate fast enough to be
 * noticed does not break the difficulty curve. See `shieldReservePerSector`.
 */
export function tickShieldRegen(hull: Hull, perSecond: number): void {
  if (hull.shieldRegenBlockedTicks > 0) {
    hull.shieldRegenBlockedTicks--
    // Progress is discarded rather than held, so an interrupted recovery restarts
    // from zero. Banking it across hits would let a player under continuous fire
    // accumulate a point during the gaps, which is the exact leak the delay exists
    // to close.
    hull.shieldRegenProgress = 0
    return
  }
  if (hull.shield >= hull.maxShield) {
    hull.shieldRegenProgress = 0
    return
  }
  // An exhausted reserve is a hard stop, not a slowdown. Banked progress is cleared with
  // it so a reserve refilled at the next sector does not immediately pay out a point
  // that was earned against the previous sector's budget.
  if (hull.shieldReserve <= 0) {
    hull.shieldRegenProgress = 0
    return
  }
  if (perSecond <= 0) return

  // Banked in per-second units and spent a whole TICK_HZ at a time, rather than adding
  // `perSecond / TICK_HZ` and spending 1. The two are algebraically identical and
  // numerically are not: dividing first means an integer rate accumulates a repeating
  // binary fraction, so at 4/second fifteen ticks summed to 0.9999999999999999 and the
  // point landed on the sixteenth. That is deterministic but it is also WRONG — it made
  // a full pool take 10.25 seconds against the 10 the item cards promise, and the error
  // grew with the rate. Adding the rate itself keeps every authored figure exact.
  hull.shieldRegenProgress += perSecond
  while (
    hull.shieldRegenProgress >= TICK_HZ &&
    hull.shield < hull.maxShield &&
    hull.shieldReserve > 0
  ) {
    hull.shieldRegenProgress -= TICK_HZ
    hull.shield++
    hull.shieldReserve--
  }
  if (hull.shield >= hull.maxShield || hull.shieldReserve <= 0) hull.shieldRegenProgress = 0
}

/**
 * Apply damage to the hull. Returns true if the hit actually landed.
 *
 * Returning false for an ignored hit (invulnerable, or the run is already over)
 * lets callers skip the impact effects, so the player never sees a flash for a
 * hit that did nothing.
 */
export interface DamageOptions {
  /**
   * Ignore the shield and go straight to integrity.
   *
   * Corrosion uses this, and it is the hazard's entire identity: a shield stops
   * things that arrive, and rot does not arrive. Use it sparingly — a second source
   * that bypasses shields makes the shield stat unpredictable, and an item that
   * raises it stops being worth taking.
   */
  bypassShield?: boolean
}

export function applyHullDamage(
  ctx: DamageContext,
  amount: number,
  causeKind: DeathCauseKind,
  causeEnemyId: string | null,
  options?: DamageOptions,
): boolean {
  if (ctx.runState !== 'active') return false
  if (ctx.hull.invulnTicks > 0) return false
  if (amount <= 0) return false

  const hull = ctx.hull

  // Shield absorbs first, then recovers once the pilot has been left alone (see
  // `tickShieldRegen`). Suppression is reset by ANY hit, including one that bypassed
  // the shield entirely — rot still counts as being under fire, and a corrosion
  // hazard that left recovery running would be a way to top the shield up while
  // taking damage.
  let remaining = amount
  if (hull.shield > 0 && options?.bypassShield !== true) {
    const absorbed = remaining < hull.shield ? remaining : hull.shield
    hull.shield -= absorbed
    remaining -= absorbed
  }
  if (remaining > 0) hull.integrity -= remaining

  hull.shieldRegenBlockedTicks = ctx.shieldRegenDelayTicks ?? STATS.shieldRegenDelayTicks.base
  hull.shieldRegenProgress = 0

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
