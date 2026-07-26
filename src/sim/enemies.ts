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
/**
 * Create an enemy instance.
 *
 * `uid` is supplied by the caller rather than drawn from a module counter. A
 * module-global counter was the first attempt and it is wrong in a way that hides:
 * two `World`s alive in the same process would draw from the same sequence, so the
 * same seed would produce different uids depending on what else had been
 * constructed — and uids are hashed, so every replay fixture would become dependent
 * on test execution order. Ownership belongs to the thing with a run's lifetime.
 *
 * REQUIRED, with no default. A default of 1 was the second attempt and it is also
 * wrong: every fabricated enemy shared one identity, so a piercing round hit the
 * first target and then skipped all the others as "already hit". A parameter that
 * silently collides is worse than one the caller is forced to think about.
 */
export function createEnemy(def: EnemyDef, x: number, y: number, uid: number): EnemyInstance {
  const holdFraction = def.movementParams.holdYFraction ?? DEFAULT_HOLD_Y_FRACTION
  return {
    uid,
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
    ...(def.secondaryWeapon
      ? {
          secondary: {
            cooldown: def.secondaryWeapon.firstDelayTicks,
            windup: 0,
            windupTotal: 0,
          },
        }
      : {}),
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
  if (!e.alive) return false
  // Rules 2 and 3: nothing fires, and no windup starts, from above the top edge.
  if (e.y < e.radius) return false

  let fired = false

  const primary = stepWeapon(e.fireCooldown, e.telegraphTicks, e.telegraphTotal, def.weapon)
  e.fireCooldown = primary.cooldown
  e.telegraphTicks = primary.windup
  e.telegraphTotal = primary.windupTotal
  if (primary.fire) {
    fireVolley(e, def.weapon, hullX, hullY, out)
    fired = true
  }

  // Second barrel, for layered patterns. Optional and absent on almost every
  // enemy; a boss phase that fires two overlapping patterns is what it exists for.
  const secondDef = def.secondaryWeapon
  const slot = e.secondary
  if (secondDef !== undefined && slot !== undefined) {
    const next = stepWeapon(slot.cooldown, slot.windup, slot.windupTotal, secondDef)
    slot.cooldown = next.cooldown
    slot.windup = next.windup
    slot.windupTotal = next.windupTotal
    if (next.fire) {
      fireVolley(e, secondDef, hullX, hullY, out)
      fired = true
    }
  }

  return fired
}

/**
 * The warning to draw: whichever barrel fires soonest.
 *
 * A PURE READ, and it lives here rather than in `updateEnemyWeapon` because of a bug
 * that shipped. The first version wrote the secondary's windup into
 * `e.telegraphTicks` so the renderer would show the nearest incoming volley — but
 * that field is also the primary's authoritative windup, read back into `stepWeapon`
 * on the next tick. The primary saw a committed telegraph it had never started,
 * counted it down, and fired off its own cadence: **2.4x its authored rate**, paced
 * by the other barrel's warning. Deterministic, so no replay fixture could catch it,
 * and every boss in the game was tuned against it.
 *
 * The rule that failed is worth stating plainly: a field that is both authoritative
 * state and a display value will eventually be written for the display and read as
 * the state. So the two barrels now keep entirely private cadence, and "which warning
 * is on screen" is answered here — a presentation question, answered without writing
 * anything.
 */
export function visibleTelegraph(e: EnemyInstance): { ticks: number; total: number } {
  const primary = { ticks: e.telegraphTicks, total: e.telegraphTotal }
  const slot = e.secondary
  if (slot === undefined || slot.windup <= 0) return primary
  if (primary.ticks <= 0 || slot.windup < primary.ticks) {
    return { ticks: slot.windup, total: slot.windupTotal }
  }
  return primary
}

/** One weapon slot's bookkeeping for a tick. Pure, so both barrels share it. */
interface WeaponStep {
  cooldown: number
  windup: number
  windupTotal: number
  fire: boolean
}

/**
 * Advance one weapon slot by a tick.
 *
 * Extracted as a pure function so the primary and secondary barrels cannot drift
 * apart in behaviour — a second copy of this bookkeeping is exactly where a
 * telegraph would quietly go missing.
 */
function stepWeapon(
  cooldown: number,
  windup: number,
  windupTotal: number,
  w: EnemyWeaponDef,
): WeaponStep {
  if (w.kind === 'none') return { cooldown, windup, windupTotal, fire: false }

  let cd = cooldown > 0 ? cooldown - 1 : cooldown

  // Already committed: count the telegraph down and fire when it runs out.
  if (windup > 0) {
    const next = windup - 1
    if (next > 0) return { cooldown: cd, windup: next, windupTotal, fire: false }
    return { cooldown: cd, windup: 0, windupTotal: 0, fire: true }
  }

  if (cd > 0) return { cooldown: cd, windup: 0, windupTotal: 0, fire: false }

  // Guard against a zero interval turning one def into a projectile firehose.
  cd = Math.max(1, w.intervalTicks)

  const next = Number.isFinite(w.windupTicks) ? Math.floor(w.windupTicks) : 0
  if (next > 0) return { cooldown: cd, windup: next, windupTotal: next, fire: false }

  // windupTicks 0 means the shot arrives unannounced. content/types.ts says that
  // should be rare and deliberate; the sim still honours it.
  return { cooldown: cd, windup: 0, windupTotal: 0, fire: true }
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
