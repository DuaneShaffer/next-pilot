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
  addShake,
  applyEnemyDamage,
  applyHullDamage,
  extendFreeze,
  freezeForEnemyHit,
  freezeForHullHit,
  HULL_COLLISION_RADIUS,
  shakeForEnemyHit,
  shakeForHullHit,
  SHAKE_SHIELD_BROKEN,
  tickHullInvulnerability,
} from './damage'
import {
  ageEnemyCosmetics,
  fireDeathBurst,
  isEnemyOutOfPlay,
  updateEnemyMovement,
  updateEnemyWeapon,
} from './enemies'
import {
  advanceProjectiles,
  cullDead,
  spawnPlayerBullet,
  type AttributedEnemyBullet,
} from './projectiles'
import { Spawner } from './spawner'
import type {
  Bullet,
  CosmeticState,
  EnemyInstance,
  Explosion,
  ExplosionKind,
  Hull,
  Incident,
  RunState,
  RunStats,
  SimEvent,
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

/**
 * Ceiling on events emitted in one tick.
 *
 * Sized against the worst legitimate tick: a screen-clearing moment can retire
 * every live enemy at once, and each death emits a hit, a kill, and a scrap award.
 * Past this we DROP the excess rather than growing the array, because a tick that
 * wanted 300 events is a tick with a hundred simultaneous deaths, and the
 * difference between 256 and 300 sound triggers is inaudible while an unbounded
 * array in the hot path is not. This is stated here rather than left as a silent
 * truncation: presentation may be missing events on such a tick, so nothing
 * downstream may treat the event stream as a complete audit log — `stats` is the
 * authority on counts, this is the authority on *when*.
 */
const MAX_EVENTS_PER_TICK = 256

/**
 * Shake decays geometrically, and snaps to exactly zero below the epsilon.
 *
 * 0.86/tick puts a full-strength impulse under the epsilon in about 0.7s, which
 * outlasts the hitstop it arrived with without lingering into the next fight. The
 * epsilon matters for more than tidiness: without it `shake` would approach zero
 * asymptotically and never reach it, so "is the screen shaking" would be true
 * forever and the cosmetic digest would never settle.
 */
const SHAKE_DECAY_PER_TICK = 0.86
const SHAKE_EPSILON = 0.002

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

  /** Cleared at the top of every tick — see SimEvent. Drain per tick, not per frame. */
  readonly events: SimEvent[] = []
  readonly cosmetic: CosmeticState = { shake: 0 }

  /**
   * Ticks of hitstop remaining. See WorldView.freezeTicks.
   *
   * Consumes real ticks: `stats.tick` still advances during a freeze, so a
   * recorded input log keeps mapping 1:1 onto ticks and the wave script keeps its
   * schedule. A freeze delays a wave's *release* by at most FREEZE_MAX_TICKS,
   * because Spawner.update releases everything due at or before the tick it is
   * handed; it can never skip one.
   */
  freezeTicks = 0

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
   *
   * Three things happen on *every* tick, including frozen ones and ones after the
   * run has ended, and the split is the whole design of hitstop:
   *
   *   - `stats.tick` advances. Hitstop spends real ticks, so one input byte still
   *     means one tick and a replay stays reproducible.
   *   - the event list is cleared, because events describe one tick.
   *   - cosmetic countdowns age. Explosions, impact flashes, and shake keep
   *     running through a freeze on purpose: a freeze in which *nothing* on screen
   *     moves reads as a hang, and the point of hitstop is to sell the impact, not
   *     to hide it. It also keeps every cosmetic lifetime bounded in real time
   *     however many freezes overlap it.
   *
   * Everything else — movement, spawning, firing, collision, extraction — is
   * gameplay and does not advance while frozen.
   */
  tick(input: InputSnapshot): void {
    this.stats.tick++
    this.events.length = 0
    this.advanceCosmetic()

    // Read before decrementing: a freeze of n granted while resolving one tick
    // freezes the n ticks that follow it, not n-1 of them.
    const frozen = this.freezeTicks > 0
    if (frozen) this.freezeTicks--

    // A finished run keeps only its cosmetic state running. The incident report is
    // drawn over the frozen playfield, and advancing the wave script behind it
    // would spawn enemies nobody can shoot and inflate the recorded run length.
    if (this.runState !== 'active') return
    if (frozen) return

    tickHullInvulnerability(this.hull)
    this.moveHull(input)
    this.updateWeapon(input)

    const wavesBefore = this.spawner.waveIndex
    this.spawner.update(this.stats.tick, this.enemies)
    this.stats.waveIndex = this.spawner.waveIndex
    // One event per wave, even if the script releases two on the same tick.
    for (let i = wavesBefore + 1; i <= this.stats.waveIndex; i++) {
      this.emit({ kind: 'wave-released', index: i })
    }

    this.updateEnemies()
    this.advanceAllProjectiles()

    this.resolvePlayerBulletHits()
    this.resolveEnemyBulletHits()
    this.resolveContact()

    this.reapEnemies()
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
    const muzzleX = this.hull.x + offset
    const muzzleY = this.hull.y - HULL_HALF_H
    const fired = spawnPlayerBullet(
      this.playerBullets,
      muzzleX,
      muzzleY,
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
    // At the muzzle, not at the hull centre: the flash has to come out of the
    // barrel that actually fired, which is how alternating muzzles read as one
    // stream instead of as a stutter.
    this.emit({ kind: 'player-shot', x: muzzleX, y: muzzleY })
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
      if (updateEnemyWeapon(e, def, hull.x, hull.y, this.enemyBullets)) {
        // Volleys only. A death burst is reported by `enemy-killed`, which the
        // renderer and audio already treat as the louder event.
        this.emit({ kind: 'enemy-shot', x: e.x, y: e.y, defId: e.defId })
      }
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

        const lethal = applyEnemyDamage(e, b.damage)
        this.stats.hits++
        // Reported at the bullet, not at the target's centroid: the spark belongs
        // where the round landed. A 30-unit hauler flashing at its centre reads as
        // a hit on empty space. The bullet is inside the target by definition here,
        // so this is never more than a radius away from it.
        this.emit({
          kind: 'enemy-hit',
          x: b.x,
          y: b.y,
          damage: b.damage,
          defId: e.defId,
          lethal,
        })
        this.addImpact(freezeForEnemyHit(b.damage, lethal), shakeForEnemyHit(b.damage, lethal))
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
      const shieldBefore = hull.shield
      const integrityBefore = hull.integrity
      // A bullet that arrives during invulnerability passes straight through
      // instead of being consumed — otherwise getting hit would clear the screen
      // and the safest play would be to take a hit on purpose.
      if (applyHullDamage(this, b.damage, 'enemy-fire', b.sourceDefId)) {
        b.alive = false
        this.onHullHit(b.damage, shieldBefore, integrityBefore)
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
      const shieldBefore = hull.shield
      const integrityBefore = hull.integrity
      if (!applyHullDamage(this, e.contactDamage, 'collision', e.defId)) continue

      // Ramming is mutual, for every enemy, with no per-shape exception: it turns
      // a collision into a costly trade instead of letting an enemy park on the
      // hull and chip it once per invulnerability window. Death bursts still fire,
      // which is what makes a mine a mine without the sim knowing about mines.
      e.alive = false
      // The ram gets the hull hit's impact and no separate kill impact. That is not
      // an oversight: taking contact damage already freezes harder than any kill,
      // and `addImpact` takes the longer freeze rather than summing them.
      this.onHullHit(e.contactDamage, shieldBefore, integrityBefore)
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
        this.emit({
          kind: 'enemy-killed',
          x: e.x,
          y: e.y,
          defId: e.defId,
          scrap: e.scrap,
          elite: e.elite,
        })
        // There is no pickup entity yet: scrap is credited at the kill, so that is
        // where it is collected and where the label belongs. When M3 adds dropped
        // scrap this moves to the pickup and stops coinciding with the kill.
        if (e.scrap > 0) {
          this.emit({ kind: 'scrap-collected', x: e.x, y: e.y, amount: e.scrap })
        }
      }
      // Enemies that simply left the playfield award nothing. Letting a wave
      // escape has to cost something, or ignoring everything would be optimal.

      enemies[i] = enemies[enemies.length - 1] as EnemyInstance
      enemies.pop()
    }
  }

  /**
   * Age everything that exists only to be looked at. Runs on every tick — frozen,
   * active, or after the run has ended. See `tick`.
   */
  private advanceCosmetic(): void {
    const list = this.explosions
    for (let i = list.length - 1; i >= 0; i--) {
      const x = list[i] as Explosion
      x.age++
      if (x.age >= x.lifetime) {
        list[i] = list[list.length - 1] as Explosion
        list.pop()
      }
    }

    for (let i = 0; i < this.enemies.length; i++) {
      ageEnemyCosmetics(this.enemies[i] as EnemyInstance)
    }

    const shake = this.cosmetic.shake * SHAKE_DECAY_PER_TICK
    this.cosmetic.shake = shake < SHAKE_EPSILON ? 0 : shake
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

  /**
   * Everything that follows from a hit that actually landed on the hull.
   *
   * Called only when `applyHullDamage` returned true, so an ignored hit (during
   * invulnerability, or after the run ended) produces no event, no shake, and no
   * freeze — the player must never see impact feedback for a hit that did nothing.
   *
   * The shield and integrity readings from *before* the hit are passed in because
   * `absorbedByShield` and the shield-break moment are only visible as a
   * transition, and `applyHullDamage` owns the subtraction.
   */
  private onHullHit(damage: number, shieldBefore: number, integrityBefore: number): void {
    const hull = this.hull
    const fatal = this.runState === 'lost'

    // Reported at the hull rather than at the projectile: the damage number belongs
    // on the ship (UI rule 9), and both damage paths — fire and ramming — then
    // agree on what the position means.
    this.emit({
      kind: 'hull-hit',
      x: hull.x,
      y: hull.y,
      damage,
      absorbedByShield: hull.integrity === integrityBefore,
    })

    let shake = shakeForHullHit(damage, fatal)
    if (shieldBefore > 0 && hull.shield === 0) {
      this.emit({ kind: 'shield-broken', x: hull.x, y: hull.y })
      shake += SHAKE_SHIELD_BROKEN
    }
    this.addImpact(freezeForHullHit(damage, fatal), shake)

    if (!fatal) return
    if (hull.integrity > 0) return
    this.emit({ kind: 'hull-lost', x: hull.x, y: hull.y })
    this.spawnExplosion(
      hull.x,
      hull.y,
      'hull',
      HULL_EXPLOSION_RADIUS,
      HULL_EXPLOSION_TICKS,
    )
  }

  /**
   * Queue an event for this tick, or drop it at the cap.
   *
   * See MAX_EVENTS_PER_TICK: past the cap the *newest* events are refused rather
   * than shifting the oldest out, because everything in one tick is simultaneous,
   * so there is no "more recent" event to prefer and refusing is O(1).
   */
  private emit(event: SimEvent): void {
    if (this.events.length >= MAX_EVENTS_PER_TICK) return
    this.events.push(event)
  }

  /**
   * Register a hit's feel response. Both rules live in damage.ts — see
   * `extendFreeze` for why the freeze takes the longest rather than the sum.
   *
   * A freeze also cannot be *extended* by damage arriving during it, because no
   * collision, movement, or firing phase runs while frozen: there is nothing that
   * can land a hit to extend it with. That plus the ceiling in `extendFreeze` bounds
   * every freeze at FREEZE_MAX_TICKS, full stop.
   */
  private addImpact(freezeTicks: number, shake: number): void {
    this.freezeTicks = extendFreeze(this.freezeTicks, freezeTicks)
    this.cosmetic.shake = addShake(this.cosmetic.shake, shake)
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
