/**
 * Enemy behaviour: movement scripts and weapons.
 *
 * The sim interprets `MovementKind` and `EnemyWeaponKind`; content only selects
 * one and supplies numbers. That is the rule from CLAUDE.md — adding an enemy
 * must never mean editing the sim. If a new idea can't be expressed with these
 * kinds, the fix is a new kind here, not a special case for one def.
 *
 * Nothing in this file draws from an Rng. Enemy behaviour is a pure function of
 * the instance, its def, and the hull's position, which makes a formation's
 * behaviour reproducible from the spawn decision alone.
 */

import { TICK_SECONDS } from '../core/loop'
import { CULL_MARGIN, PLAYFIELD_H, PLAYFIELD_W, Playfield } from '../core/space'
import type { EnemyDef, EnemyWeaponDef } from '../content/types'
import type { EnemyBulletKind, EnemyInstance } from './entities'
import { spawnEnemyBullet, type AttributedEnemyBullet } from './projectiles'

const TAU = Math.PI * 2

/** Collision radius per projectile class, so content doesn't have to state it. */
const BULLET_RADIUS: Record<EnemyBulletKind, number> = {
  pellet: 3,
  shard: 2.5,
  // Fat and slow. A tracker has to be readable from across the playfield,
  // because the whole point of it is that you see it coming and move.
  tracker: 4.5,
}

/** Defaults for movement params a given kind needs but content left unset. */
const DEFAULT_HOLD_Y_FRACTION = 0.28
const DEFAULT_SINE_AMPLITUDE = 28
const DEFAULT_SINE_FREQUENCY = 0.5
const DEFAULT_DIVE_MULTIPLIER = 2.4

/**
 * Build a live enemy from its def at a spawn position.
 *
 * The spawner decides *where*; this decides everything else, so every instance of
 * a def starts in exactly the same state regardless of which formation released
 * it.
 */
export function createEnemy(def: EnemyDef, x: number, y: number): EnemyInstance {
  const holdFraction = def.movementParams.holdYFraction ?? DEFAULT_HOLD_Y_FRACTION
  return {
    defId: def.id,
    hp: def.hp,
    maxHp: def.hp,
    radius: def.radius,
    shape: def.shape,
    movement: def.movement,
    elite: def.elite ?? false,
    x,
    y,
    prevX: x,
    prevY: y,
    vx: 0,
    vy: 0,
    age: 0,
    phase: 'entering',
    fireCooldown: def.weapon.firstDelayTicks,
    contactDamage: def.contactDamage,
    scrap: def.scrap,
    alive: true,
    hitFlashTicks: 0,
    telegraphTicks: 0,
    telegraphTotal: 0,
    originX: x,
    holdY: holdFraction * PLAYFIELD_H,
  }
}

/**
 * Enemies enter from above the top edge, so being off the top is never a reason
 * to cull — that would delete a wave before it arrived. They leave by falling out
 * of the bottom, or sideways once a strafe run finishes.
 */
export function isEnemyOutOfPlay(e: EnemyInstance): boolean {
  return (
    e.y > PLAYFIELD_H + CULL_MARGIN ||
    e.x < -CULL_MARGIN - e.radius ||
    e.x > PLAYFIELD_W + CULL_MARGIN + e.radius
  )
}

function stepBy(e: EnemyInstance, vxPerSecond: number, vyPerSecond: number): void {
  e.vx = vxPerSecond
  e.vy = vyPerSecond
  e.x += vxPerSecond * TICK_SECONDS
  e.y += vyPerSecond * TICK_SECONDS
}

/**
 * Advance one movement script by exactly one tick.
 *
 * `age` is the script clock. It counts ticks since spawn, with one documented
 * exception: `swoop` and `hover` restart it when they begin holding, because they
 * need a phase timer and `EnemyInstance` (a fixed contract) has no spare field
 * for one. Firing cadence lives in `fireCooldown`, so nothing else depends on
 * `age` being monotonic.
 */
export function updateEnemyMovement(e: EnemyInstance, def: EnemyDef): void {
  e.prevX = e.x
  e.prevY = e.y

  const p = def.movementParams
  const speed = p.speed

  switch (e.movement) {
    case 'drift': {
      stepBy(e, 0, speed)
      break
    }

    case 'sine': {
      const amplitude = p.amplitude ?? DEFAULT_SINE_AMPLITUDE
      const frequency = p.frequency ?? DEFAULT_SINE_FREQUENCY
      // x is derived from the phase angle rather than integrated from a velocity.
      // Integrating a cosine would accumulate float error over a long descent and
      // let the enemy wander off its spawn column; deriving it cannot drift.
      const nextX = e.originX + Math.sin(TAU * frequency * e.age * TICK_SECONDS) * amplitude
      e.vx = (nextX - e.x) / TICK_SECONDS
      e.vy = speed
      e.x = nextX
      e.y += speed * TICK_SECONDS
      break
    }

    case 'swoop': {
      if (e.phase === 'entering') {
        stepBy(e, 0, speed)
        if (e.y >= e.holdY) {
          // Snap so the dive always starts from exactly holdY, otherwise the
          // pause height depends on how much the last step overshot.
          e.y = e.holdY
          const holdTicks = p.holdTicks ?? 0
          e.phase = holdTicks > 0 ? 'holding' : 'committed'
          e.age = 0
        }
      } else if (e.phase === 'holding') {
        stepBy(e, 0, 0)
        if (e.age >= (p.holdTicks ?? 0)) e.phase = 'committed'
      } else {
        stepBy(e, 0, speed * (p.diveMultiplier ?? DEFAULT_DIVE_MULTIPLIER))
      }
      break
    }

    case 'hover': {
      if (e.phase === 'entering') {
        stepBy(e, 0, speed)
        if (e.y >= e.holdY) {
          e.y = e.holdY
          e.phase = 'holding'
          e.age = 0
        }
      } else if (e.phase === 'holding') {
        stepBy(e, 0, 0)
        // holdTicks unset means it stays until killed. That is a legitimate
        // content choice for a turret, so it is not defaulted to anything.
        const holdTicks = p.holdTicks
        if (holdTicks !== undefined && e.age >= holdTicks) e.phase = 'leaving'
      } else {
        stepBy(e, 0, speed)
      }
      break
    }

    case 'strafe': {
      if (e.phase === 'entering') {
        stepBy(e, 0, speed)
        if (e.y >= e.holdY) {
          e.y = e.holdY
          e.phase = 'committed'
        }
      } else {
        // Cross away from the nearer edge, so a strafe run always traverses the
        // playfield instead of leaving immediately. Derived from the spawn column
        // rather than rolled, which keeps this a pure function of the instance.
        const direction = e.originX < Playfield.centerX ? 1 : -1
        stepBy(e, speed * direction, 0)
      }
      break
    }
  }

  // drift and sine have no scripted phases; 'entering' just means "not fully on
  // screen yet", which renderers can use to fade a wave in.
  if (e.phase === 'entering' && (e.movement === 'drift' || e.movement === 'sine') && e.y >= 0) {
    e.phase = 'committed'
  }

  e.age++
}

/**
 * Age an enemy's render-only countdowns by one tick.
 *
 * Separate from `updateEnemyMovement` because it must keep running during
 * hitstop, when movement deliberately does not — see `World.tick`. Folding it back
 * into the movement script would freeze the impact flash for the duration of the
 * freeze it caused, which is the one moment the player is looking straight at it.
 */
export function ageEnemyCosmetics(e: EnemyInstance): void {
  if (e.hitFlashTicks > 0) e.hitFlashTicks--
}

/**
 * Tick a weapon and fire when due. Returns true on the tick a volley leaves.
 *
 * Four reactability rules, all deliberate:
 *
 *  1. The cadence clock is frozen while the enemy is still above the top edge.
 *     `firstDelayTicks` therefore counts from the moment the enemy is *visible*,
 *     not from spawn. Without this, a def with a 30-tick delay that takes 50
 *     ticks to descend into view arrives already shooting.
 *  2. Nothing fires from off-screen at all, for the same reason.
 *  3. A windup may not *start* off-screen either. A telegraph the player cannot
 *     see is not a telegraph, and a shot whose only warning played above the top
 *     edge arrives just as unannounced as one with no warning at all.
 *  4. A dead enemy fires nothing, including one killed part-way through its
 *     windup. Committing to a shot is not the same as having taken it, so killing
 *     something mid-telegraph has to be a reward.
 *
 * Cadence: `fireCooldown` is reset when the *windup starts*, not when the shot
 * leaves, and it keeps counting down during the windup. So `intervalTicks` remains
 * the shot-to-shot period it was before telegraphs existed. Charging the windup on
 * top of the interval instead would have quietly cut every armed enemy's rate of
 * fire — the turret by 21% — which is a balance change disguised as a feel change,
 * and it would have meant re-tuning all of sector 1 to stand still.
 */
export function updateEnemyWeapon(
  e: EnemyInstance,
  def: EnemyDef,
  hullX: number,
  hullY: number,
  out: AttributedEnemyBullet[],
): boolean {
  const w = def.weapon
  if (w.kind === 'none') return false
  if (!e.alive) return false
  if (e.y < e.radius) return false

  if (e.fireCooldown > 0) e.fireCooldown--

  // Already committed: count the telegraph down and fire when it runs out.
  if (e.telegraphTicks > 0) {
    e.telegraphTicks--
    if (e.telegraphTicks > 0) return false
    e.telegraphTotal = 0
    fireVolley(e, w, hullX, hullY, out)
    return true
  }

  if (e.fireCooldown > 0) return false

  // Guard against a zero interval turning one def into a projectile firehose.
  e.fireCooldown = Math.max(1, w.intervalTicks)

  const windup = Number.isFinite(w.windupTicks) ? Math.floor(w.windupTicks) : 0
  if (windup > 0) {
    e.telegraphTicks = windup
    e.telegraphTotal = windup
    return false
  }

  // windupTicks 0 means the shot arrives unannounced. content/types.ts says that
  // should be rare and deliberate; the sim still honours it.
  fireVolley(e, w, hullX, hullY, out)
  return true
}

function fireVolley(
  e: EnemyInstance,
  w: EnemyWeaponDef,
  hullX: number,
  hullY: number,
  out: AttributedEnemyBullet[],
): void {
  // Aim at where the hull is *now*. A leading shot is a different, much less
  // readable weapon, and reading enemy fire is the whole skill in sector 1.
  let ax = hullX - e.x
  let ay = hullY - e.y
  const length = Math.sqrt(ax * ax + ay * ay)
  if (length > 0) {
    ax /= length
    ay /= length
  } else {
    ax = 0
    ay = 1
  }

  const speed = w.bulletSpeed

  switch (w.kind) {
    case 'none':
      return

    case 'aimed':
      emit(e, out, ax * speed, ay * speed, w.damage, 'pellet')
      return

    case 'tracker':
      // "Keeps its heading" — it is aimed once and never corrects. That punishes
      // standing still without being unavoidable.
      emit(e, out, ax * speed, ay * speed, w.damage, 'tracker')
      return

    case 'spread': {
      const count = Math.max(1, w.count ?? 3)
      const arc = ((w.spreadDegrees ?? 30) * Math.PI) / 180
      // Centred on the aim line, so an odd count always puts one shot dead on the
      // hull and the player has to move rather than sidestep by a pixel.
      const step = count > 1 ? arc / (count - 1) : 0
      const first = count > 1 ? -arc / 2 : 0
      for (let i = 0; i < count; i++) {
        const angle = first + step * i
        const cos = Math.cos(angle)
        const sin = Math.sin(angle)
        emit(e, out, (ax * cos - ay * sin) * speed, (ax * sin + ay * cos) * speed, w.damage, 'shard')
      }
      return
    }

    case 'ring': {
      const count = Math.max(1, w.count ?? 8)
      emitRing(e, out, count, speed, w.damage, 'pellet')
      return
    }
  }
}

/**
 * A dying enemy's parting shot. Turns a kill into a positioning problem, which is
 * how a slow unarmed enemy stays interesting — see EnemyDef.deathBurst.
 */
export function fireDeathBurst(e: EnemyInstance, def: EnemyDef, out: AttributedEnemyBullet[]): void {
  const burst = def.deathBurst
  if (!burst) return
  emitRing(e, out, Math.max(1, burst.count), burst.bulletSpeed, burst.damage, 'shard')
}

function emitRing(
  e: EnemyInstance,
  out: AttributedEnemyBullet[],
  count: number,
  speed: number,
  damage: number,
  kind: EnemyBulletKind,
): void {
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * TAU
    emit(e, out, Math.cos(angle) * speed, Math.sin(angle) * speed, damage, kind)
  }
}

function emit(
  e: EnemyInstance,
  out: AttributedEnemyBullet[],
  vx: number,
  vy: number,
  damage: number,
  kind: EnemyBulletKind,
): void {
  spawnEnemyBullet(out, e.defId, e.x, e.y, vx, vy, damage, BULLET_RADIUS[kind], kind)
}
