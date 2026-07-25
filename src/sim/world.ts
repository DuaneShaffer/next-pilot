/**
 * The simulation.
 *
 * Milestone 0 scope: a controllable hull and its projectiles, nothing to shoot
 * at yet. Deliberately thin, but architecturally complete — it establishes the
 * rules the whole game is built on:
 *
 *   1. No rendering, DOM, or timing imports. This module runs headless.
 *   2. All randomness comes from named streams off the run seed.
 *   3. tick() takes an InputSnapshot and advances exactly one fixed step.
 *   4. Entities keep their previous position so rendering can interpolate.
 *
 * Anything that breaks rule 1 or 2 breaks replays and bot playtesting, which are
 * the only ways this game gets verified. See docs/ARCHITECTURE.md.
 */

import { TICK_HZ, TICK_SECONDS } from '../core/loop'
import type { InputSnapshot } from '../core/input'
import { Rng } from '../core/rng'
import { clamp, isOutOfPlay, Playfield } from '../core/space'

/** Movement speed in virtual units per second. */
const HULL_SPEED = 210
/** Multiplier applied while the focus key is held, for precise threading. */
const FOCUS_FACTOR = 0.45
/**
 * Ticks between shots. 3 ticks at 60Hz is 20 shots/second.
 *
 * The muzzles alternate rather than firing together. Simultaneous twin shots
 * rendered as two parallel columns with gaps between volleys, which read as pairs
 * of tally marks marching up the screen instead of as gunfire. Alternating puts
 * the same rate into one interleaved stream.
 */
const FIRE_INTERVAL_TICKS = 3

/**
 * Shots per second, derived from the tick rate so the HUD cannot drift out of
 * sync with the simulation. An earlier build displayed 10.0 shots/s while
 * actually firing 20 — it was showing volleys and calling them shots.
 */
export const SHOTS_PER_SECOND = TICK_HZ / FIRE_INTERVAL_TICKS

/** Horizontal offset of each muzzle from the hull centreline. */
const MUZZLE_OFFSET = 4.5
const BULLET_SPEED = 620
/** Hard ceiling on live projectiles, so a runaway weapon can't stall a frame. */
const MAX_BULLETS = 768

const HULL_HALF_W = 11
const HULL_HALF_H = 14

export interface Interpolated {
  x: number
  y: number
  prevX: number
  prevY: number
}

export interface Hull extends Interpolated {
  /** Structural integrity. At zero the pilot is lost and the run ends. */
  integrity: number
  maxIntegrity: number
  shield: number
  maxShield: number
}

export interface Bullet extends Interpolated {
  vx: number
  vy: number
  damage: number
  alive: boolean
}

export interface WorldStats {
  tick: number
  shotsFired: number
  bulletsCulled: number
  /** Highest number of simultaneously live bullets seen this run. */
  peakBullets: number
}

export class World {
  readonly seed: string
  readonly hull: Hull
  readonly bullets: Bullet[] = []
  readonly stats: WorldStats = { tick: 0, shotsFired: 0, bulletsCulled: 0, peakBullets: 0 }

  /**
   * One Rng per concern. Splitting streams means adding a cosmetic effect can
   * never shift which items drop, so recorded replays survive visual work.
   */
  private readonly rngSpawn: Rng
  private readonly rngLoot: Rng

  private fireCooldown = 0
  private nextMuzzleIsLeft = true

  constructor(seed: string) {
    this.seed = seed
    this.rngSpawn = Rng.fromSeed(seed, 'spawn')
    this.rngLoot = Rng.fromSeed(seed, 'loot')

    const startX = Playfield.centerX
    const startY = Playfield.h - 110
    this.hull = {
      x: startX,
      y: startY,
      prevX: startX,
      prevY: startY,
      integrity: 100,
      maxIntegrity: 100,
      shield: 40,
      maxShield: 40,
    }
  }

  /** Advance exactly one fixed tick. The only entry point into the sim. */
  tick(input: InputSnapshot): void {
    this.stats.tick++
    this.moveHull(input)
    this.updateWeapon(input)
    this.moveBullets()

    const live = this.bullets.length
    if (live > this.stats.peakBullets) this.stats.peakBullets = live
  }

  private moveHull(input: InputSnapshot): void {
    const hull = this.hull
    hull.prevX = hull.x
    hull.prevY = hull.y

    const speed = HULL_SPEED * (input.focus ? FOCUS_FACTOR : 1) * TICK_SECONDS
    let dx = input.moveX
    let dy = input.moveY
    // Normalise diagonals so corner-running isn't 41% faster than straight lines.
    if (dx !== 0 && dy !== 0) {
      const inv = Math.SQRT1_2
      dx *= inv
      dy *= inv
    }

    hull.x = clamp(hull.x + dx * speed, HULL_HALF_W, Playfield.w - HULL_HALF_W)
    hull.y = clamp(hull.y + dy * speed, HULL_HALF_H, Playfield.h - HULL_HALF_H)
  }

  private updateWeapon(input: InputSnapshot): void {
    if (this.fireCooldown > 0) this.fireCooldown--
    if (!input.fire || this.fireCooldown > 0) return
    if (this.bullets.length + 1 > MAX_BULLETS) return

    this.fireCooldown = FIRE_INTERVAL_TICKS
    const offset = this.nextMuzzleIsLeft ? -MUZZLE_OFFSET : MUZZLE_OFFSET
    this.nextMuzzleIsLeft = !this.nextMuzzleIsLeft
    this.spawnBullet(this.hull.x + offset, this.hull.y - HULL_HALF_H, 0, -BULLET_SPEED)
    this.stats.shotsFired++
  }

  private spawnBullet(x: number, y: number, vx: number, vy: number): void {
    this.bullets.push({ x, y, prevX: x, prevY: y, vx, vy, damage: 4, alive: true })
  }

  private moveBullets(): void {
    const bullets = this.bullets
    // Iterate backwards with swap-remove: O(1) removal, no allocation, and no
    // index skipping when an element is deleted mid-loop.
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i] as Bullet
      b.prevX = b.x
      b.prevY = b.y
      b.x += b.vx * TICK_SECONDS
      b.y += b.vy * TICK_SECONDS

      if (!b.alive || isOutOfPlay(b.x, b.y)) {
        const last = bullets[bullets.length - 1] as Bullet
        bullets[i] = last
        bullets.pop()
        this.stats.bulletsCulled++
      }
    }
  }

  /**
   * Streams are exposed for content systems (spawn tables, loot rolls) to draw
   * from. Nothing else may create an Rng from the seed, or stream independence
   * is lost.
   */
  get spawnRng(): Rng {
    return this.rngSpawn
  }

  get lootRng(): Rng {
    return this.rngLoot
  }
}
