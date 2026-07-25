/**
 * The simulation.
 *
 * This class coordinates; it does not contain behaviour. Each system lives in its
 * own module (spawner, enemies, projectiles, collision, damage) and `tick()` is a
 * list of phases in the order they must happen. Read it top to bottom to know
 * what a tick does.
 *
 * The four rules everything here is built on:
 *
 *   1. No rendering, DOM, or timing imports. This module runs headless in Node.
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
import { clamp, Playfield } from '../core/space'
import { ENEMIES } from '../content/enemies'
import { SECTOR_ONE } from '../content/sectors'
import type { EnemyDef } from '../content/types'
import { circlesOverlap, segmentHitsCircle } from './collision'
import {
  applyEnemyDamage,
  applyHullDamage,
  HULL_COLLISION_RADIUS,
  tickHullInvulnerability,
} from './damage'
import { fireDeathBurst, isEnemyOutOfPlay, updateEnemyMovement, updateEnemyWeapon } from './enemies'
import {
  advanceProjectiles,
  cullDead,
  spawnPlayerBullet,
  type AttributedEnemyBullet,
} from './projectiles'
import { Spawner } from './spawner'
import type {
  Bullet,
  EnemyInstance,
  Explosion,
  ExplosionKind,
  Hull,
  Incident,
  RunState,
  RunStats,
  WorldView,
} from './entities'

/**
 * Entity types live in `entities.ts`, which is the contract between the sim and
 * its observers. Re-exported here only so existing importers keep working —
 * prefer importing from `./entities` directly.
 */
export type { Bullet, EnemyBullet, EnemyInstance, Explosion, Hull, Interpolated } from './entities'

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
const BULLET_DAMAGE = 4
const BULLET_RADIUS = 2.5

/** Half-extents of the *drawn* hull. The hitbox is much smaller — see damage.ts. */
const HULL_HALF_W = 11
const HULL_HALF_H = 14

const HULL_INTEGRITY = 100
const HULL_SHIELD = 40

/**
 * Explosions are cosmetic, but they are sim state because they must be identical
 * in a replay. Capped so a chain of deaths can't grow the array without bound.
 */
const MAX_EXPLOSIONS = 48
const EXPLOSION_BASE_TICKS = 18
const HULL_EXPLOSION_TICKS = 48
const HULL_EXPLOSION_RADIUS = 34

export class World implements WorldView {
  readonly seed: string
  /** Which sector script this run is flying. One sector in M1. */
  readonly sectorId: string

  runState: RunState = 'active'
  readonly hull: Hull
  readonly playerBullets: Bullet[] = []
  readonly enemyBullets: AttributedEnemyBullet[] = []
  readonly enemies: EnemyInstance[] = []
  readonly explosions: Explosion[] = []
  incident: Incident | null = null

  readonly stats: RunStats = {
    tick: 0,
    shotsFired: 0,
    hits: 0,
    kills: 0,
    scrap: 0,
    damageTaken: 0,
    waveIndex: 0,
    peakProjectiles: 0,
    bulletsCulled: 0,
  }

  /**
   * One Rng per concern. Splitting streams means adding a cosmetic effect can
   * never shift which items drop, so recorded replays survive visual work. A new
   * random concern gets a new stream; it never borrows an existing one.
   */
  private readonly rngSpawn: Rng
  private readonly rngLoot: Rng

  private readonly enemyDefs: Record<string, EnemyDef> = ENEMIES
  private readonly spawner: Spawner
  /** Earliest tick the sector may be declared complete. */
  private readonly extractionTick: number

  private fireCooldown = 0
  private nextMuzzleIsLeft = true

  constructor(seed: string) {
    this.seed = seed
    this.rngSpawn = Rng.fromSeed(seed, 'spawn')
    this.rngLoot = Rng.fromSeed(seed, 'loot')

    this.sectorId = SECTOR_ONE.id
    this.spawner = new Spawner(SECTOR_ONE, this.enemyDefs, this.rngSpawn)
    this.extractionTick = Math.round(SECTOR_ONE.durationSeconds * TICK_HZ)

    const startX = Playfield.centerX
    const startY = Playfield.h - 110
    this.hull = {
      x: startX,
      y: startY,
      prevX: startX,
      prevY: startY,
      integrity: HULL_INTEGRITY,
      maxIntegrity: HULL_INTEGRITY,
      shield: HULL_SHIELD,
      maxShield: HULL_SHIELD,
      invulnTicks: 0,
      radius: HULL_COLLISION_RADIUS,
    }
  }

  /** Waves released so far. 0 before the first one. */
  get currentWaveIndex(): number {
    return this.spawner.waveIndex
  }

  /**
   * Advance exactly one fixed tick. The only entry point into the sim.
   *
   * Phase order is deliberate. Everything moves before anything collides, so a
   * hit is decided from one consistent set of positions rather than from a mix of
   * old and new ones. Dead things are reaped after collisions so a projectile can
   * only ever connect once.
   */
  tick(input: InputSnapshot): void {
    this.stats.tick++

    // A finished run keeps only its cosmetic state running. The incident report is
    // drawn over the frozen playfield, and advancing the wave script behind it
    // would spawn enemies nobody can shoot and inflate the recorded run length.
    if (this.runState !== 'active') {
      this.advanceExplosions()
      return
    }

    tickHullInvulnerability(this.hull)
    this.moveHull(input)
    this.updateWeapon(input)

    this.spawner.update(this.stats.tick, this.enemies)
    this.stats.waveIndex = this.spawner.waveIndex

    this.updateEnemies()
    this.advanceAllProjectiles()

    this.resolvePlayerBulletHits()
    this.resolveEnemyBulletHits()
    this.resolveContact()

    this.reapEnemies()
    this.advanceExplosions()
    this.checkExtraction()

    const live = this.playerBullets.length + this.enemyBullets.length
    if (live > this.stats.peakProjectiles) this.stats.peakProjectiles = live
  }

  // --- phases ---------------------------------------------------------------

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

    // Clamped by the drawn silhouette, not the hitbox: the ship must never look
    // like it is hanging off the edge of the playfield.
    hull.x = clamp(hull.x + dx * speed, HULL_HALF_W, Playfield.w - HULL_HALF_W)
    hull.y = clamp(hull.y + dy * speed, HULL_HALF_H, Playfield.h - HULL_HALF_H)
  }

  private updateWeapon(input: InputSnapshot): void {
    if (this.fireCooldown > 0) this.fireCooldown--
    if (!input.fire || this.fireCooldown > 0) return

    const offset = this.nextMuzzleIsLeft ? -MUZZLE_OFFSET : MUZZLE_OFFSET
    const fired = spawnPlayerBullet(
      this.playerBullets,
      this.hull.x + offset,
      this.hull.y - HULL_HALF_H,
      0,
      -BULLET_SPEED,
      BULLET_DAMAGE,
      BULLET_RADIUS,
    )
    // Refused by the cap: leave the cooldown and the muzzle alone so the cadence
    // resumes cleanly rather than skipping a muzzle and desynchronising the
    // alternating pattern.
    if (!fired) return

    this.fireCooldown = FIRE_INTERVAL_TICKS
    this.nextMuzzleIsLeft = !this.nextMuzzleIsLeft
    this.stats.shotsFired++
  }

  private updateEnemies(): void {
    const hull = this.hull
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i] as EnemyInstance
      const def = this.enemyDefs[e.defId]
      // Unknown def ids are rejected when the Spawner is built, so this can only
      // be a programming error; drop the enemy rather than crash a live run.
      if (def === undefined) {
        e.alive = false
        continue
      }
      updateEnemyMovement(e, def)
      updateEnemyWeapon(e, def, hull.x, hull.y, this.enemyBullets)
    }
  }

  private advanceAllProjectiles(): void {
    this.stats.bulletsCulled += advanceProjectiles(this.playerBullets)
    this.stats.bulletsCulled += advanceProjectiles(this.enemyBullets)
  }

  private resolvePlayerBulletHits(): void {
    const bullets = this.playerBullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i] as Bullet
      for (let j = 0; j < this.enemies.length; j++) {
        const e = this.enemies[j] as EnemyInstance
        if (!e.alive) continue
        // Swept against the bullet's path: at 620 units/second a bullet covers
        // ~10 units per tick, enough to step clean over a small enemy.
        if (!segmentHitsCircle(b.prevX, b.prevY, b.x, b.y, e.x, e.y, e.radius + b.radius)) continue

        applyEnemyDamage(e, b.damage)
        this.stats.hits++
        // No piercing in M1: one bullet, one target.
        b.alive = false
        break
      }
    }
    cullDead(bullets)
  }

  private resolveEnemyBulletHits(): void {
    const hull = this.hull
    const bullets = this.enemyBullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i] as AttributedEnemyBullet
      if (!circlesOverlap(b.x, b.y, b.radius, hull.x, hull.y, hull.radius)) continue
      // A bullet that arrives during invulnerability passes straight through
      // instead of being consumed — otherwise getting hit would clear the screen
      // and the safest play would be to take a hit on purpose.
      if (applyHullDamage(this, b.damage, 'enemy-fire', b.sourceDefId)) {
        b.alive = false
        this.onHullDestroyed()
        break
      }
    }
    cullDead(bullets)
  }

  private resolveContact(): void {
    const hull = this.hull
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i] as EnemyInstance
      if (!e.alive) continue
      if (!circlesOverlap(e.x, e.y, e.radius, hull.x, hull.y, hull.radius)) continue
      if (!applyHullDamage(this, e.contactDamage, 'collision', e.defId)) continue

      // Ramming is mutual, for every enemy, with no per-shape exception: it turns
      // a collision into a costly trade instead of letting an enemy park on the
      // hull and chip it once per invulnerability window. Death bursts still fire,
      // which is what makes a mine a mine without the sim knowing about mines.
      e.alive = false
      this.onHullDestroyed()
      break
    }
  }

  private reapEnemies(): void {
    const enemies = this.enemies
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i] as EnemyInstance
      const destroyed = !e.alive
      if (!destroyed && !isEnemyOutOfPlay(e)) continue

      if (destroyed) {
        const def = this.enemyDefs[e.defId]
        if (def !== undefined) fireDeathBurst(e, def, this.enemyBullets)
        this.stats.kills++
        this.stats.scrap += e.scrap
        // Shape only selects which explosion the renderer draws; it changes no
        // behaviour, so this stays a presentation mapping rather than a rule.
        const kind: ExplosionKind = e.shape === 'mine' ? 'mine' : 'enemy'
        this.spawnExplosion(e.x, e.y, kind, e.radius * 2.4, EXPLOSION_BASE_TICKS + Math.min(14, e.radius))
      }
      // Enemies that simply left the playfield award nothing. Letting a wave
      // escape has to cost something, or ignoring everything would be optimal.

      enemies[i] = enemies[enemies.length - 1] as EnemyInstance
      enemies.pop()
    }
  }

  private advanceExplosions(): void {
    const list = this.explosions
    for (let i = list.length - 1; i >= 0; i--) {
      const x = list[i] as Explosion
      x.age++
      if (x.age >= x.lifetime) {
        list[i] = list[list.length - 1] as Explosion
        list.pop()
      }
    }
  }

  private checkExtraction(): void {
    // "The sector ends when the script is done and play is clear" — see
    // SectorDef.durationSeconds. All three conditions matter: ending on the timer
    // alone would strand a live wave, and ending on an empty field alone would
    // end the sector in the gap between waves.
    //
    // A pilot who dies on the same tick the sector would have completed is dead,
    // not extracted. Losing outranks winning.
    if (this.runState !== 'active') return
    if (!this.spawner.finished) return
    if (this.enemies.length > 0) return
    if (this.stats.tick < this.extractionTick) return
    this.runState = 'extracted'
  }

  // --- helpers --------------------------------------------------------------

  private onHullDestroyed(): void {
    if (this.runState !== 'lost') return
    if (this.hull.integrity > 0) return
    this.spawnExplosion(
      this.hull.x,
      this.hull.y,
      'hull',
      HULL_EXPLOSION_RADIUS,
      HULL_EXPLOSION_TICKS,
    )
  }

  private spawnExplosion(
    x: number,
    y: number,
    kind: ExplosionKind,
    radius: number,
    lifetime: number,
  ): void {
    // At the cap, drop the oldest rather than refusing the new one: the newest
    // explosion is the one the player needs to see.
    if (this.explosions.length >= MAX_EXPLOSIONS) this.explosions.shift()
    this.explosions.push({ x, y, age: 0, lifetime, radius, kind })
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
