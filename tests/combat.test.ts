import { describe, expect, it } from 'vitest'
import { TICK_HZ } from '../src/core/loop'
import { Rng } from '../src/core/rng'
import { PLAYFIELD_H, PLAYFIELD_W, Playfield } from '../src/core/space'
import type { InputSnapshot } from '../src/core/input'
import { NEUTRAL_INPUT } from '../src/core/input'
import type {
  EnemyDef,
  EnemyWeaponDef,
  FormationPattern,
  SectorDef,
  WaveEntry,
} from '../src/content/types'
import { ENEMIES } from '../src/content/enemies'
import { SECTOR_ONE } from '../src/content/sectors'
import { circlesOverlap, pointInCircle, segmentHitsCircle } from '../src/sim/collision'
import type { DamageContext } from '../src/sim/damage'
import {
  addShake,
  applyEnemyDamage,
  applyHullDamage,
  extendFreeze,
  freezeForEnemyHit,
  freezeForHullHit,
  FREEZE_MAX_TICKS,
  HULL_COLLISION_RADIUS,
  HULL_INVULN_TICKS,
  shakeForEnemyHit,
  shakeForHullHit,
  tickHullInvulnerability,
} from '../src/sim/damage'
import {
  ageEnemyCosmetics,
  createEnemy,
  fireDeathBurst,
  isEnemyOutOfPlay,
  updateEnemyMovement,
  updateEnemyWeapon,
} from '../src/sim/enemies'
import type { AttributedEnemyBullet } from '../src/sim/projectiles'
import {
  MAX_ENEMY_BULLETS,
  MAX_PLAYER_BULLETS,
  spawnEnemyBullet,
  spawnPlayerBullet,
} from '../src/sim/projectiles'
import { Spawner } from '../src/sim/spawner'
import type { Bullet, EnemyInstance, SimEvent } from '../src/sim/entities'
import { World } from '../src/sim/world'

// --- fixtures ---------------------------------------------------------------

const UNARMED: EnemyWeaponDef = {
  kind: 'none',
  intervalTicks: 0,
  bulletSpeed: 0,
  damage: 0,
  firstDelayTicks: 0,
  windupTicks: 0,
}

/**
 * Test defs are fabricated rather than drawn from `src/content/enemies.ts` on
 * purpose: these tests assert what the *sim* does with a MovementKind or a
 * EnemyWeaponKind, and must not start failing because someone rebalanced a
 * skiff. Content values are checked in tests/content.test.ts.
 */
function makeDef(over: Partial<EnemyDef>): EnemyDef {
  return {
    id: 'test-def',
    name: 'Test Def',
    hp: 10,
    radius: 10,
    contactDamage: 5,
    scrap: 1,
    movement: 'drift',
    movementParams: { speed: 60 },
    weapon: UNARMED,
    shape: 'skiff',
    ...over,
  }
}

function makeContext(): DamageContext {
  return {
    hull: {
      x: 100,
      y: 600,
      prevX: 100,
      prevY: 600,
      integrity: 100,
      maxIntegrity: 100,
      shield: 40,
      maxShield: 40,
      invulnTicks: 0,
      radius: HULL_COLLISION_RADIUS,
    },
    stats: {
      tick: 0,
      shotsFired: 0,
      hits: 0,
      kills: 0,
      scrap: 0,
      damageTaken: 0,
      waveIndex: 0,
      peakProjectiles: 0,
      bulletsCulled: 0,
    },
    runState: 'active',
    incident: null,
  }
}

/** Run an enemy's movement script for `ticks` ticks. */
function moveFor(e: EnemyInstance, def: EnemyDef, ticks: number): void {
  for (let i = 0; i < ticks; i++) updateEnemyMovement(e, def)
}

/** Run an enemy's weapon for `ticks` ticks against a fixed hull position. */
function fireFor(
  e: EnemyInstance,
  def: EnemyDef,
  ticks: number,
  hullX = 100,
  hullY = 600,
): AttributedEnemyBullet[] {
  const out: AttributedEnemyBullet[] = []
  for (let i = 0; i < ticks; i++) updateEnemyWeapon(e, def, hullX, hullY, out)
  return out
}

/**
 * Formation positions carry a few units of spawn jitter in both axes, so a
 * spacing assertion has to allow two enemies' worth of it.
 */
function expectWithinJitter(actual: number, expected: number, jitter = 3): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(jitter * 2)
}

/** Degrees clockwise from straight down (+y), which is how the aim is specified. */
function angleFromDown(vx: number, vy: number): number {
  return (Math.atan2(vx, vy) * 180) / Math.PI
}

const FIRING: InputSnapshot = { moveX: 0, moveY: 0, fire: true, special: false, focus: false }

// --- collision --------------------------------------------------------------

describe('collision', () => {
  it('treats touching circles as overlapping', () => {
    expect(circlesOverlap(0, 0, 5, 10, 0, 5)).toBe(true)
    expect(circlesOverlap(0, 0, 5, 10.1, 0, 5)).toBe(false)
    expect(pointInCircle(3, 4, 0, 0, 5)).toBe(true)
    expect(pointInCircle(3, 4.1, 0, 0, 5)).toBe(false)
  })

  it('catches a fast projectile that a point test would miss', () => {
    // A bullet that started below a small target and ended above it in one tick.
    // Both endpoints are clear; the path is not.
    const targetX = 0
    const targetY = 100
    const radius = 4
    expect(pointInCircle(0, 110, targetX, targetY, radius)).toBe(false)
    expect(pointInCircle(0, 90, targetX, targetY, radius)).toBe(false)
    expect(segmentHitsCircle(0, 110, 0, 90, targetX, targetY, radius)).toBe(true)
    // A path that passes to one side still misses.
    expect(segmentHitsCircle(20, 110, 20, 90, targetX, targetY, radius)).toBe(false)
  })

  it('falls back to a point test for a stationary projectile', () => {
    expect(segmentHitsCircle(0, 100, 0, 100, 0, 102, 4)).toBe(true)
    expect(segmentHitsCircle(0, 100, 0, 100, 0, 120, 4)).toBe(false)
  })
})

// --- damage -----------------------------------------------------------------

describe('damage', () => {
  it('spends shield before integrity', () => {
    const ctx = makeContext()
    expect(applyHullDamage(ctx, 10, 'enemy-fire', 'skiff')).toBe(true)
    expect(ctx.hull.shield).toBe(30)
    expect(ctx.hull.integrity).toBe(100)
    expect(ctx.stats.damageTaken).toBe(10)
  })

  it('spills the remainder into integrity once shield is gone', () => {
    const ctx = makeContext()
    applyHullDamage(ctx, 50, 'enemy-fire', 'skiff')
    expect(ctx.hull.shield).toBe(0)
    expect(ctx.hull.integrity).toBe(90)
  })

  it('does not regenerate shield', () => {
    const ctx = makeContext()
    applyHullDamage(ctx, 15, 'enemy-fire', 'skiff')
    for (let i = 0; i < 600; i++) tickHullInvulnerability(ctx.hull)
    expect(ctx.hull.shield).toBe(25)
  })

  it('ignores further hits during invulnerability frames', () => {
    const ctx = makeContext()
    expect(applyHullDamage(ctx, 10, 'enemy-fire', 'skiff')).toBe(true)
    expect(ctx.hull.invulnTicks).toBe(HULL_INVULN_TICKS)

    // A spread arriving in the same tick, and everything up to the last invulnerable
    // tick, must cost nothing.
    expect(applyHullDamage(ctx, 10, 'enemy-fire', 'skiff')).toBe(false)
    for (let i = 0; i < HULL_INVULN_TICKS - 1; i++) {
      tickHullInvulnerability(ctx.hull)
      expect(applyHullDamage(ctx, 10, 'enemy-fire', 'skiff')).toBe(false)
    }
    expect(ctx.hull.shield).toBe(30)

    // The window closes on schedule, not one tick early or late.
    tickHullInvulnerability(ctx.hull)
    expect(ctx.hull.invulnTicks).toBe(0)
    expect(applyHullDamage(ctx, 10, 'enemy-fire', 'skiff')).toBe(true)
    expect(ctx.hull.shield).toBe(20)
  })

  it('files an incident exactly once, attributed to enemy fire', () => {
    const ctx = makeContext()
    ctx.stats.tick = 1200
    ctx.stats.kills = 7
    ctx.stats.scrap = 42
    ctx.stats.waveIndex = 5

    applyHullDamage(ctx, 500, 'enemy-fire', 'turret')
    expect(ctx.runState).toBe('lost')
    expect(ctx.hull.integrity).toBe(0)
    expect(ctx.incident).toEqual({
      causeKind: 'enemy-fire',
      causeEnemyId: 'turret',
      tick: 1200,
      secondsSurvived: 20,
      waveIndex: 5,
      scrap: 42,
      kills: 7,
    })

    // Anything arriving after death must not overwrite the report.
    const filed = ctx.incident
    ctx.hull.invulnTicks = 0
    expect(applyHullDamage(ctx, 500, 'collision', 'hauler')).toBe(false)
    expect(ctx.incident).toBe(filed)
  })

  it('attributes a collision death to the enemy that was rammed', () => {
    const ctx = makeContext()
    ctx.hull.shield = 0
    ctx.hull.integrity = 5
    applyHullDamage(ctx, 14, 'collision', 'hauler')
    expect(ctx.incident?.causeKind).toBe('collision')
    expect(ctx.incident?.causeEnemyId).toBe('hauler')
  })

  it('destroys an enemy only when its hp reaches zero', () => {
    const e = createEnemy(makeDef({ hp: 10 }), 100, 100, 1001)
    expect(applyEnemyDamage(e, 4)).toBe(false)
    expect(applyEnemyDamage(e, 4)).toBe(false)
    expect(e.hitFlashTicks).toBeGreaterThan(0)
    expect(applyEnemyDamage(e, 4)).toBe(true)
    expect(e.alive).toBe(false)
    expect(e.hp).toBe(0)
    // A corpse cannot be killed twice — that would double-count kills and scrap.
    expect(applyEnemyDamage(e, 4)).toBe(false)
  })
})

// --- movement scripts -------------------------------------------------------

describe('movement kinds', () => {
  it('drift falls straight down at speed', () => {
    const def = makeDef({ movement: 'drift', movementParams: { speed: 60 } })
    const e = createEnemy(def, 200, 0, 1002)
    moveFor(e, def, 60)
    expect(e.x).toBe(200)
    expect(e.y).toBeCloseTo(60, 6)
    expect(e.prevY).toBeCloseTo(59, 6)
  })

  it('sine oscillates around its spawn column while descending', () => {
    const def = makeDef({
      movement: 'sine',
      movementParams: { speed: 60, amplitude: 40, frequency: 1 },
    })
    const e = createEnemy(def, 100, 0, 1003)
    expect(e.originX).toBe(100)

    // A quarter of a 1Hz cycle is 15 ticks, at which point the offset is +amplitude.
    // The script reads `age` before incrementing it, so the 16th update uses age 15.
    moveFor(e, def, 16)
    expect(e.x).toBeCloseTo(140, 4)
    expect(e.y).toBeCloseTo(16, 6)

    // And it never wanders off its column, which is what deriving x from the phase
    // angle rather than integrating a velocity buys.
    let maxOffset = 0
    for (let i = 0; i < 600; i++) {
      updateEnemyMovement(e, def)
      maxOffset = Math.max(maxOffset, Math.abs(e.x - e.originX))
    }
    expect(maxOffset).toBeLessThanOrEqual(40 + 1e-9)
  })

  it('swoop descends, pauses, then dives faster', () => {
    const holdY = 100
    const def = makeDef({
      movement: 'swoop',
      movementParams: {
        speed: 60,
        holdYFraction: holdY / PLAYFIELD_H,
        holdTicks: 30,
        diveMultiplier: 3,
      },
    })
    const e = createEnemy(def, 200, 0, 1004)
    expect(e.holdY).toBeCloseTo(holdY, 6)

    moveFor(e, def, 100)
    expect(e.phase).toBe('holding')
    // Snapped to exactly holdY so the pause height never depends on overshoot.
    expect(e.y).toBe(holdY)

    moveFor(e, def, 30)
    expect(e.y).toBe(holdY)

    // Committed within a tick or two of the telegraph ending, and three times as
    // fast as the approach.
    moveFor(e, def, 3)
    expect(e.phase).toBe('committed')
    const before = e.y
    moveFor(e, def, 60)
    expect(e.y - before).toBeCloseTo(180, 4)
  })

  it('hover settles at its hold height and stays there', () => {
    const def = makeDef({
      movement: 'hover',
      movementParams: { speed: 60, holdYFraction: 0.25 },
    })
    const e = createEnemy(def, 200, 0, 1005)
    moveFor(e, def, 600)
    expect(e.phase).toBe('holding')
    expect(e.y).toBeCloseTo(0.25 * PLAYFIELD_H, 6)
    expect(e.vy).toBe(0)
  })

  it('hover leaves after holdTicks when content asks it to', () => {
    const def = makeDef({
      movement: 'hover',
      movementParams: { speed: 60, holdYFraction: 0.25, holdTicks: 60 },
    })
    const e = createEnemy(def, 200, 0, 1006)
    moveFor(e, def, 180 + 62)
    expect(e.phase).toBe('leaving')
    moveFor(e, def, 900)
    expect(isEnemyOutOfPlay(e)).toBe(true)
  })

  it('strafe crosses away from the nearer edge', () => {
    const def = makeDef({
      movement: 'strafe',
      movementParams: { speed: 60, holdYFraction: 0.25 },
    })
    const holdY = 0.25 * PLAYFIELD_H

    const fromLeft = createEnemy(def, 40, 0, 1007)
    moveFor(fromLeft, def, 200 + 60)
    expect(fromLeft.phase).toBe('committed')
    expect(fromLeft.y).toBeCloseTo(holdY, 6)
    expect(fromLeft.x).toBeGreaterThan(40)

    const fromRight = createEnemy(def, PLAYFIELD_W - 40, 0, 1008)
    moveFor(fromRight, def, 200 + 60)
    expect(fromRight.x).toBeLessThan(PLAYFIELD_W - 40)
  })

  it('is never culled for being above the playfield, only for leaving it', () => {
    const def = makeDef({})
    const above = createEnemy(def, 200, -300, 1009)
    expect(isEnemyOutOfPlay(above)).toBe(false)

    const below = createEnemy(def, 200, PLAYFIELD_H + 200, 1010)
    expect(isEnemyOutOfPlay(below)).toBe(true)

    const sideways = createEnemy(def, -200, 100, 1011)
    expect(isEnemyOutOfPlay(sideways)).toBe(true)
  })
})

// --- weapons ----------------------------------------------------------------

/**
 * These defs all set `windupTicks: 0`, which keeps the assertions about *what* a
 * volley looks like independent of *when* it leaves. The windup has its own
 * describe block below, where the timing is the subject rather than the noise.
 */
describe('enemy weapons', () => {
  it('never fires when unarmed', () => {
    const def = makeDef({ weapon: UNARMED })
    const e = createEnemy(def, 100, 200, 1012)
    expect(fireFor(e, def, 600)).toHaveLength(0)
  })

  it('waits firstDelayTicks before the first volley, then keeps interval', () => {
    const def = makeDef({
      weapon: { kind: 'aimed', intervalTicks: 20, bulletSpeed: 100, damage: 3, firstDelayTicks: 30, windupTicks: 0 },
    })
    const e = createEnemy(def, 100, 200, 1013)

    // An enemy that fires the instant it appears is unreactable, not difficult.
    expect(fireFor(e, def, 29)).toHaveLength(0)
    expect(fireFor(e, def, 1)).toHaveLength(1)
    // Then exactly one volley per interval, no drift.
    expect(fireFor(e, def, 19)).toHaveLength(0)
    expect(fireFor(e, def, 1)).toHaveLength(1)
    expect(fireFor(e, def, 100)).toHaveLength(5)
  })

  it('holds its cadence clock while still above the top edge', () => {
    // Otherwise a def with a 30-tick delay that takes 90 ticks to descend into
    // view arrives already shooting.
    const def = makeDef({
      radius: 10,
      weapon: { kind: 'aimed', intervalTicks: 20, bulletSpeed: 100, damage: 3, firstDelayTicks: 30, windupTicks: 0 },
    })
    const e = createEnemy(def, 100, -40, 1014)
    expect(fireFor(e, def, 300)).toHaveLength(0)
    expect(e.fireCooldown).toBe(30)

    e.y = 200
    expect(fireFor(e, def, 29)).toHaveLength(0)
    expect(fireFor(e, def, 1)).toHaveLength(1)
  })

  it('aimed fires one shot at the hull, at exactly bulletSpeed', () => {
    const def = makeDef({
      weapon: { kind: 'aimed', intervalTicks: 60, bulletSpeed: 120, damage: 3, firstDelayTicks: 10, windupTicks: 0 },
    })
    const e = createEnemy(def, 100, 200, 1015)
    const shots = fireFor(e, def, 10, 100, 600)
    expect(shots).toHaveLength(1)

    const b = shots[0] as AttributedEnemyBullet
    expect(b.kind).toBe('pellet')
    expect(b.sourceDefId).toBe('test-def')
    expect(b.damage).toBe(3)
    expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(120, 6)
    // Hull directly below: straight down.
    expect(b.vx).toBeCloseTo(0, 6)
    expect(b.vy).toBeCloseTo(120, 6)
  })

  it('aimed leads nothing — it aims where the hull is at fire time', () => {
    const def = makeDef({
      weapon: { kind: 'aimed', intervalTicks: 30, bulletSpeed: 100, damage: 3, firstDelayTicks: 1, windupTicks: 0 },
    })
    const e = createEnemy(def, 100, 100, 1016)
    const left = fireFor(e, def, 1, 0, 200)
    const right = fireFor(e, def, 30, 400, 200)
    expect((left[0] as AttributedEnemyBullet).vx).toBeLessThan(0)
    expect((right[0] as AttributedEnemyBullet).vx).toBeGreaterThan(0)
  })

  it('spread puts count shots in a spreadDegrees arc centred on the hull', () => {
    const def = makeDef({
      weapon: {
        kind: 'spread',
        intervalTicks: 60,
        bulletSpeed: 120,
        damage: 4,
        count: 5,
        spreadDegrees: 40,
        firstDelayTicks: 5,
      windupTicks: 0,
      },
    })
    const e = createEnemy(def, 100, 200, 1017)
    const shots = fireFor(e, def, 5, 100, 600)
    expect(shots).toHaveLength(5)

    const angles = shots.map((b) => angleFromDown(b.vx, b.vy))
    expect(Math.min(...angles)).toBeCloseTo(-20, 4)
    expect(Math.max(...angles)).toBeCloseTo(20, 4)
    // Odd count means one shot is dead on the hull, so the player has to move.
    expect(angles[2]).toBeCloseTo(0, 6)
    for (const b of shots) {
      expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(120, 6)
      expect(b.kind).toBe('shard')
    }
  })

  it('spread with a count of one collapses to a single aimed shot', () => {
    const def = makeDef({
      weapon: {
        kind: 'spread',
        intervalTicks: 60,
        bulletSpeed: 100,
        damage: 4,
        count: 1,
        spreadDegrees: 40,
        firstDelayTicks: 1,
      windupTicks: 0,
      },
    })
    const e = createEnemy(def, 100, 200, 1018)
    const shots = fireFor(e, def, 1, 300, 200)
    expect(shots).toHaveLength(1)
    expect((shots[0] as AttributedEnemyBullet).vy).toBeCloseTo(0, 6)
    expect((shots[0] as AttributedEnemyBullet).vx).toBeCloseTo(100, 6)
  })

  it('ring fires evenly all the way round and ignores the hull entirely', () => {
    const def = makeDef({
      weapon: {
        kind: 'ring',
        intervalTicks: 60,
        bulletSpeed: 90,
        damage: 5,
        count: 8,
        firstDelayTicks: 4,
      windupTicks: 0,
      },
    })

    const a = createEnemy(def, 100, 200, 1019)
    const shots = fireFor(a, def, 4, 0, 0)
    expect(shots).toHaveLength(8)
    // Evenly spaced: the velocities sum to zero and every speed is identical.
    let sumX = 0
    let sumY = 0
    for (const b of shots) {
      sumX += b.vx
      sumY += b.vy
      expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(90, 6)
    }
    expect(sumX).toBeCloseTo(0, 6)
    expect(sumY).toBeCloseTo(0, 6)

    const sorted = shots.map((b) => angleFromDown(b.vx, b.vy)).sort((p, q) => p - q)
    for (let i = 1; i < sorted.length; i++) {
      expect((sorted[i] as number) - (sorted[i - 1] as number)).toBeCloseTo(45, 4)
    }

    // Position, not aim: the same volley regardless of where the hull is.
    const b1 = createEnemy(def, 100, 200, 1020)
    const b2 = createEnemy(def, 100, 200, 1021)
    const near = fireFor(b1, def, 4, 100, 210).map((b) => [b.vx, b.vy])
    const far = fireFor(b2, def, 4, 400, 700).map((b) => [b.vx, b.vy])
    expect(near).toEqual(far)
  })

  it('tracker fires one slow shot that keeps its heading', () => {
    const def = makeDef({
      weapon: {
        kind: 'tracker',
        intervalTicks: 90,
        bulletSpeed: 70,
        damage: 8,
        firstDelayTicks: 6,
      windupTicks: 0,
      },
    })
    const e = createEnemy(def, 100, 100, 1022)
    const shots = fireFor(e, def, 6, 300, 300)
    expect(shots).toHaveLength(1)

    const b = shots[0] as AttributedEnemyBullet
    expect(b.kind).toBe('tracker')
    // Fat, so it is readable from across the playfield.
    expect(b.radius).toBeGreaterThan(3)
    expect(b.vx).toBeCloseTo(70 * Math.SQRT1_2, 4)
    expect(b.vy).toBeCloseTo(70 * Math.SQRT1_2, 4)

    // "Keeps its heading" is the whole reason it is dodgeable: moving the hull must
    // not steer the shot already in flight.
    const vx = b.vx
    const vy = b.vy
    fireFor(e, def, 60, 0, 700)
    expect(b.vx).toBe(vx)
    expect(b.vy).toBe(vy)
  })

  it('deathBurst fires a ring when the enemy dies', () => {
    const def = makeDef({ deathBurst: { count: 6, bulletSpeed: 80, damage: 4 } })
    const e = createEnemy(def, 120, 240, 1023)
    const out: AttributedEnemyBullet[] = []

    fireDeathBurst(e, def, out)
    expect(out).toHaveLength(6)
    let sumX = 0
    let sumY = 0
    for (const b of out) {
      expect(b.x).toBe(120)
      expect(b.y).toBe(240)
      expect(b.damage).toBe(4)
      expect(b.sourceDefId).toBe('test-def')
      expect(Math.hypot(b.vx, b.vy)).toBeCloseTo(80, 6)
      sumX += b.vx
      sumY += b.vy
    }
    expect(sumX).toBeCloseTo(0, 6)
    expect(sumY).toBeCloseTo(0, 6)
  })

  it('fires no death burst for a def without one', () => {
    const def = makeDef({})
    const out: AttributedEnemyBullet[] = []
    fireDeathBurst(createEnemy(def, 100, 100, 1024), def, out)
    expect(out).toHaveLength(0)
  })
})

// --- spawner ----------------------------------------------------------------

describe('spawner', () => {
  const defs: Record<string, EnemyDef> = { grunt: makeDef({ id: 'grunt', radius: 10 }) }

  function sector(waves: WaveEntry[]): SectorDef {
    return { id: 'test-sector', name: 'Test Sector', durationSeconds: 60, waves }
  }

  function formationSector(pattern: FormationPattern, count: number, extra = {}): SectorDef {
    return sector([
      { atSeconds: 1, formations: [{ enemyId: 'grunt', count, pattern, ...extra }] },
    ])
  }

  /** Release everything scheduled in the first `ticks` ticks. */
  function collect(def: SectorDef, seed: string, ticks = 120): EnemyInstance[] {
    const out: EnemyInstance[] = []
    const spawner = new Spawner(def, defs, Rng.fromSeed(seed, 'spawn'))
    for (let t = 1; t <= ticks; t++) spawner.update(t, out)
    return out
  }

  it('releases a wave at its scheduled tick and not before', () => {
    const spawner = new Spawner(
      sector([{ atSeconds: 2, formations: [{ enemyId: 'grunt', count: 3, pattern: 'line' }] }]),
      defs,
      Rng.fromSeed('SCHEDULE1234', 'spawn'),
    )
    const out: EnemyInstance[] = []
    for (let t = 1; t < 120; t++) spawner.update(t, out)
    expect(out).toHaveLength(0)
    expect(spawner.waveIndex).toBe(0)

    spawner.update(120, out)
    expect(out).toHaveLength(3)
    expect(spawner.waveIndex).toBe(1)
    expect(spawner.finished).toBe(true)
  })

  it('spawns above the playfield so waves are never dropped into play', () => {
    for (const pattern of ['line', 'arc', 'column', 'scatter', 'flanks'] as FormationPattern[]) {
      for (const e of collect(formationSector(pattern, 4, { spacing: 40 }), 'ABOVE1234567')) {
        expect(e.y).toBeLessThan(0)
        expect(e.x).toBeGreaterThanOrEqual(0)
        expect(e.x).toBeLessThanOrEqual(PLAYFIELD_W)
      }
    }
  })

  it('line spaces a row evenly around its centre', () => {
    const spawned = collect(
      formationSector('line', 3, { spacing: 60, atXFraction: 0.5 }),
      'LINELINELIN1',
    )
    const xs = spawned.map((e) => e.x).sort((a, b) => a - b)
    expect(xs).toHaveLength(3)
    // Positions carry a few units of spawn jitter, so these compare within it
    // rather than exactly — asserting exact spacing would be asserting that the
    // jitter does not exist.
    expectWithinJitter(xs[1] as number, Playfield.centerX)
    expectWithinJitter((xs[1] as number) - (xs[0] as number), 60)
    expectWithinJitter((xs[2] as number) - (xs[1] as number), 60)
    // A line arrives level.
    const ys = spawned.map((e) => e.y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(8)
  })

  it('arc trails its wingtips behind the leaders', () => {
    const spawned = collect(
      formationSector('arc', 5, { spacing: 40, atXFraction: 0.5 }),
      'ARCARCARCAR1',
    ).sort((a, b) => a.x - b.x)
    expect(spawned).toHaveLength(5)
    const centre = spawned[2] as EnemyInstance
    expect((spawned[0] as EnemyInstance).y).toBeLessThan(centre.y)
    expect((spawned[4] as EnemyInstance).y).toBeLessThan(centre.y)
  })

  it('column stacks vertically on one line', () => {
    const spawned = collect(
      formationSector('column', 4, { spacing: 50, atXFraction: 0.5 }),
      'COLUMNCOLUM1',
    )
    expect(spawned).toHaveLength(4)
    const xs = spawned.map((e) => e.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(8)
    const ys = spawned.map((e) => e.y).sort((a, b) => a - b)
    expectWithinJitter((ys[1] as number) - (ys[0] as number), 50)
  })

  it('flanks splits the group either side of centre', () => {
    const spawned = collect(
      formationSector('flanks', 4, { spacing: 30, atXFraction: 0.5 }),
      'FLANKFLANKF1',
    )
    expect(spawned).toHaveLength(4)
    const left = spawned.filter((e) => e.x < Playfield.centerX)
    const right = spawned.filter((e) => e.x > Playfield.centerX)
    expect(left).toHaveLength(2)
    expect(right).toHaveLength(2)
    // The two groups are genuinely apart, not two names for the same cluster.
    const gap = Math.min(...right.map((e) => e.x)) - Math.max(...left.map((e) => e.x))
    expect(gap).toBeGreaterThan(60)
  })

  it('scatter spreads across the playfield', () => {
    const spawned = collect(formationSector('scatter', 8), 'SCATTERSCAT1')
    expect(spawned).toHaveLength(8)
    const xs = spawned.map((e) => e.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(60)
    const ys = spawned.map((e) => e.y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(20)
  })

  it('staggers formation members across ticks', () => {
    const spawner = new Spawner(
      sector([
        {
          atSeconds: 1,
          formations: [{ enemyId: 'grunt', count: 4, pattern: 'column', staggerTicks: 10 }],
        },
      ]),
      defs,
      Rng.fromSeed('STAGGERSTAG1', 'spawn'),
    )
    const out: EnemyInstance[] = []
    for (let t = 1; t <= 60; t++) spawner.update(t, out)
    expect(out).toHaveLength(1)
    expect(spawner.finished).toBe(false)

    for (let t = 61; t <= 90; t++) spawner.update(t, out)
    expect(out).toHaveLength(4)
    expect(spawner.finished).toBe(true)
  })

  it('releases identical waves for identical seeds', () => {
    const script = sector([
      { atSeconds: 1, formations: [{ enemyId: 'grunt', count: 5, pattern: 'line', spacing: 40 }] },
      { atSeconds: 1.5, formations: [{ enemyId: 'grunt', count: 6, pattern: 'scatter' }] },
    ])
    const a = collect(script, 'SAMESEED1234')
    const b = collect(script, 'SAMESEED1234')
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b))
  })

  it('releases different waves for different seeds', () => {
    const script = sector([
      { atSeconds: 1, formations: [{ enemyId: 'grunt', count: 5, pattern: 'line', spacing: 40 }] },
      { atSeconds: 1.5, formations: [{ enemyId: 'grunt', count: 6, pattern: 'scatter' }] },
    ])
    const a = collect(script, 'SEEDONE12345')
    const b = collect(script, 'SEEDTWO12345')
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b))
  })

  it('honours a fixed atXFraction rather than rolling for it', () => {
    const script = formationSector('line', 1, { atXFraction: 0.25 })
    const a = collect(script, 'FIXEDONE1234')
    const b = collect(script, 'FIXEDTWO1234')
    // Only the jitter differs, so the two agree to within a few units.
    expectWithinJitter((a[0] as EnemyInstance).x, (b[0] as EnemyInstance).x)
    expectWithinJitter((a[0] as EnemyInstance).x, 0.25 * PLAYFIELD_W)
  })

  it('releases waves in schedule order even if content lists them out of order', () => {
    const spawner = new Spawner(
      sector([
        { atSeconds: 3, formations: [{ enemyId: 'grunt', count: 1, pattern: 'line' }] },
        { atSeconds: 1, formations: [{ enemyId: 'grunt', count: 1, pattern: 'line' }] },
      ]),
      defs,
      Rng.fromSeed('ORDERORDER12', 'spawn'),
    )
    const out: EnemyInstance[] = []
    for (let t = 1; t <= 100; t++) spawner.update(t, out)
    expect(out).toHaveLength(1)
    for (let t = 101; t <= 200; t++) spawner.update(t, out)
    expect(out).toHaveLength(2)
  })

  it('refuses to construct against an unknown enemy id', () => {
    // A content typo must fail before the sortie starts, not appear as a wave that
    // silently never arrives ninety seconds in.
    expect(
      () =>
        new Spawner(
          sector([{ atSeconds: 1, formations: [{ enemyId: 'ghost', count: 1, pattern: 'line' }] }]),
          defs,
          Rng.fromSeed('GHOSTGHOST12', 'spawn'),
        ),
    ).toThrow(/ghost/)
  })
})

// --- projectile caps --------------------------------------------------------

describe('projectile caps', () => {
  it('refuses player bullets past the cap', () => {
    const list: Bullet[] = []
    let refused = 0
    for (let i = 0; i < MAX_PLAYER_BULLETS + 50; i++) {
      if (!spawnPlayerBullet(list, 0, 0, 0, -100, 4, 2)) refused++
    }
    expect(list).toHaveLength(MAX_PLAYER_BULLETS)
    expect(refused).toBe(50)
  })

  it('refuses enemy bullets past the cap', () => {
    const list: AttributedEnemyBullet[] = []
    for (let i = 0; i < MAX_ENEMY_BULLETS + 200; i++) {
      spawnEnemyBullet(list, 'test-def', 0, 0, 0, 100, 4, 3, 'pellet')
    }
    expect(list).toHaveLength(MAX_ENEMY_BULLETS)
  })

  it('holds the cap under sustained ring fire', () => {
    // A stack of ring-firing enemies with death bursts is the pathological case:
    // it generates projectiles far faster than they leave the playfield.
    const def = makeDef({
      weapon: {
        kind: 'ring',
        intervalTicks: 1,
        bulletSpeed: 60,
        damage: 1,
        count: 40,
        firstDelayTicks: 1,
      windupTicks: 0,
      },
      deathBurst: { count: 40, bulletSpeed: 60, damage: 1 },
    })
    const out: AttributedEnemyBullet[] = []
    const enemies = [
      createEnemy(def, 100, 200, 1025),
      createEnemy(def, 200, 200, 1026),
      createEnemy(def, 300, 200, 1027),
    ]
    for (let t = 0; t < 200; t++) {
      for (const e of enemies) {
        updateEnemyWeapon(e, def, 200, 600, out)
        fireDeathBurst(e, def, out)
      }
      expect(out.length).toBeLessThanOrEqual(MAX_ENEMY_BULLETS)
    }
    expect(out).toHaveLength(MAX_ENEMY_BULLETS)
  })

  it('never exceeds the caps across a whole sortie', () => {
    const world = new World('CAPSCAPSCAP1')
    for (let i = 0; i < 6000; i++) {
      world.tick(FIRING)
      expect(world.playerBullets.length).toBeLessThanOrEqual(MAX_PLAYER_BULLETS)
      expect(world.enemyBullets.length).toBeLessThanOrEqual(MAX_ENEMY_BULLETS)
    }
    expect(world.stats.peakProjectiles).toBeLessThanOrEqual(
      MAX_PLAYER_BULLETS + MAX_ENEMY_BULLETS,
    )
  })
})

// --- world integration ------------------------------------------------------

describe('combat in the world', () => {
  it('spawns the sector script and records the wave index', () => {
    const world = new World('WAVESWAVESW1')
    for (let i = 0; i < 200; i++) world.tick(NEUTRAL_INPUT)
    expect(world.currentWaveIndex).toBeGreaterThan(0)
    expect(world.stats.waveIndex).toBe(world.currentWaveIndex)
    expect(world.enemies.length).toBeGreaterThan(0)
    expect(world.sectorId).toBe('debris-shelf')
  })

  it('awards a kill, scrap, and an explosion when player fire destroys an enemy', () => {
    const world = new World('KILLKILLKIL1')
    const def = ENEMIES['hauler'] as EnemyDef
    world.enemies.push(createEnemy(def, world.hull.x, world.hull.y - 120, 1028))

    for (let i = 0; i < 40; i++) world.tick(FIRING)
    expect(world.stats.kills).toBeGreaterThanOrEqual(1)
    expect(world.stats.scrap).toBeGreaterThanOrEqual(def.scrap)
    expect(world.stats.hits).toBeGreaterThan(0)
    expect(world.explosions.length).toBeGreaterThan(0)
  })

  it('fires a mine death burst into the world when the mine is shot', () => {
    const world = new World('MINEMINEMIN1')
    const mine = ENEMIES['mine'] as EnemyDef
    expect(mine.deathBurst).toBeDefined()
    // Far enough up that the ring does not reach the hull before we look at it,
    // and short enough that the sector's own first wave (t=150) has not released.
    world.enemies.push(createEnemy(mine, world.hull.x, 120, 1029))

    for (let i = 0; i < 140; i++) world.tick(FIRING)
    expect(world.stats.kills).toBe(1)
    expect(world.enemyBullets.length).toBeGreaterThan(0)
    for (const b of world.enemyBullets) expect(b.sourceDefId).toBe('mine')
  })

  it('awards nothing for an enemy that escapes off the bottom', () => {
    const world = new World('ESCAPEESCAP1')
    const def = ENEMIES['hauler'] as EnemyDef
    world.enemies.push(createEnemy(def, 20, PLAYFIELD_H - 20, 1030))

    for (let i = 0; i < 300; i++) world.tick(NEUTRAL_INPUT)
    expect(world.stats.kills).toBe(0)
    expect(world.stats.scrap).toBe(0)
  })

  it('ends the run and files an incident when integrity is gone', () => {
    const world = new World('LOSTLOSTLOS1')
    for (let i = 0; i < 5400 && world.runState === 'active'; i++) world.tick(NEUTRAL_INPUT)

    expect(world.runState).toBe('lost')
    const incident = world.incident
    expect(incident).not.toBeNull()
    expect(incident?.causeEnemyId).not.toBeNull()
    expect(ENEMIES[incident?.causeEnemyId as string]).toBeDefined()
    expect(incident?.tick).toBe(world.stats.tick)
    expect(incident?.secondsSurvived).toBeGreaterThan(0)

    // The playfield freezes: the report is drawn over it, and the wave script must
    // not keep running behind it.
    const frozen = JSON.stringify(world.enemies)
    const waveAtDeath = world.currentWaveIndex
    for (let i = 0; i < 600; i++) world.tick(FIRING)
    expect(JSON.stringify(world.enemies)).toEqual(frozen)
    expect(world.currentWaveIndex).toBe(waveAtDeath)
    expect(world.explosions).toHaveLength(0)
  })

  it('keeps the hull hitbox much smaller than its silhouette', () => {
    // Genre-standard and load-bearing for fairness — see damage.ts. A hitbox that
    // covered the drawn wings would register hits the player is sure they dodged.
    const world = new World('HITBOXHITBO1')
    expect(world.hull.radius).toBe(HULL_COLLISION_RADIUS)
    expect(world.hull.radius).toBeLessThan(11)
  })
})

// --- telegraphs -------------------------------------------------------------

/** A def whose windup is the thing under test. */
function telegraphDef(over: Partial<EnemyWeaponDef> = {}): EnemyDef {
  return makeDef({
    weapon: {
      kind: 'aimed',
      intervalTicks: 20,
      bulletSpeed: 100,
      damage: 3,
      firstDelayTicks: 30,
      windupTicks: 12,
      ...over,
    },
  })
}

/**
 * Tick a weapon one tick at a time, recording the tick each volley left on and
 * the telegraph countdown as observed after every tick.
 */
function fireTimeline(
  e: EnemyInstance,
  def: EnemyDef,
  ticks: number,
): { shotTicks: number[]; telegraph: number[]; shots: AttributedEnemyBullet[] } {
  const shots: AttributedEnemyBullet[] = []
  const shotTicks: number[] = []
  const telegraph: number[] = []
  for (let t = 1; t <= ticks; t++) {
    const before = shots.length
    updateEnemyWeapon(e, def, 100, 600, shots)
    if (shots.length > before) shotTicks.push(t)
    telegraph.push(e.telegraphTicks)
  }
  return { shotTicks, telegraph, shots }
}

describe('enemy telegraphs', () => {
  it('commits for exactly windupTicks before every volley', () => {
    const def = telegraphDef()
    const e = createEnemy(def, 100, 200, 1031)
    const { shotTicks, telegraph } = fireTimeline(e, def, 130)

    // firstDelayTicks 30, then a 12-tick windup: the first shot lands on tick 42.
    expect(shotTicks[0]).toBe(42)
    // The countdown is visible for all 12 ticks before it, one step per tick, and
    // is zero on the tick the shot leaves. That window is the whole feature: it is
    // the time the player has to react, so it is asserted tick by tick rather than
    // as "greater than zero at some point".
    for (let i = 0; i < 12; i++) {
      expect(telegraph[30 + i - 1], `telegraph at tick ${30 + i}`).toBe(12 - i)
    }
    expect(telegraph[41]).toBe(0)

    // And every later volley is preceded by the same windup, not just the first.
    for (const shotTick of shotTicks) {
      for (let back = 1; back <= 12; back++) {
        expect(telegraph[shotTick - back - 1], `telegraph ${back} ticks before ${shotTick}`).toBe(back)
      }
    }
  })

  it('reports the windup total so render can show progress', () => {
    const def = telegraphDef()
    const e = createEnemy(def, 100, 200, 1032)
    fireFor(e, def, 35)
    expect(e.telegraphTicks).toBeGreaterThan(0)
    expect(e.telegraphTotal).toBe(12)

    // Cleared once the volley is away, so nothing draws a stale progress bar over
    // an enemy that is no longer committed to anything.
    expect(fireFor(e, def, 7)).toHaveLength(1)
    expect(e.telegraphTicks).toBe(0)
    expect(e.telegraphTotal).toBe(0)
  })

  it('keeps intervalTicks as the shot-to-shot period', () => {
    // Charging the windup on top of the interval would have cut every armed
    // enemy's rate of fire — a balance change wearing a feel change's clothes.
    const def = telegraphDef()
    const e = createEnemy(def, 100, 200, 1033)
    const { shotTicks } = fireTimeline(e, def, 200)
    expect(shotTicks.length).toBeGreaterThan(4)
    for (let i = 1; i < shotTicks.length; i++) {
      expect((shotTicks[i] as number) - (shotTicks[i - 1] as number)).toBe(20)
    }
  })

  it('starts no windup while still above the top edge', () => {
    // A telegraph the player cannot see is not a telegraph. The cadence clock and
    // the windup both wait for the enemy to be visible.
    const def = telegraphDef()
    const e = createEnemy(def, 100, -40, 1034)
    const offScreen = fireTimeline(e, def, 300)
    expect(offScreen.shots).toHaveLength(0)
    expect(Math.max(...offScreen.telegraph)).toBe(0)
    expect(e.fireCooldown).toBe(30)

    // firstDelayTicks still counts from the moment it becomes visible, and the
    // windup follows it.
    e.y = 200
    const visible = fireTimeline(e, def, 60)
    expect(visible.shotTicks[0]).toBe(42)
  })

  it('fires nothing when killed mid-windup', () => {
    const def = telegraphDef()
    const e = createEnemy(def, 100, 200, 1035)
    expect(fireFor(e, def, 35)).toHaveLength(0)
    expect(e.telegraphTicks).toBeGreaterThan(0)

    // Killing something that has committed to a shot has to be a reward, so the
    // volley it was winding up must never arrive.
    expect(applyEnemyDamage(e, 999)).toBe(true)
    expect(fireFor(e, def, 300)).toHaveLength(0)
  })

  it('fires without warning only when content asks for windupTicks 0', () => {
    const def = telegraphDef({ windupTicks: 0 })
    const e = createEnemy(def, 100, 200, 1036)
    const { shotTicks, telegraph } = fireTimeline(e, def, 60)
    expect(shotTicks[0]).toBe(30)
    expect(Math.max(...telegraph)).toBe(0)
  })

  it('starts every enemy un-telegraphed', () => {
    const e = createEnemy(telegraphDef(), 100, 200, 1037)
    expect(e.telegraphTicks).toBe(0)
    expect(e.telegraphTotal).toBe(0)
  })
})

// --- the impact budget ------------------------------------------------------

describe('impact budget', () => {
  it('scales the freeze with damage dealt', () => {
    // A single bullet is 4 damage: deliberately not worth a tick. At 20 shots a
    // second, freezing on every hit would leave the game frozen a third of the
    // time.
    expect(freezeForEnemyHit(4, false)).toBe(0)
    expect(freezeForEnemyHit(8, false)).toBe(1)
    expect(freezeForEnemyHit(24, false)).toBeGreaterThan(freezeForEnemyHit(8, false))
    expect(shakeForEnemyHit(24, false)).toBeGreaterThan(shakeForEnemyHit(4, false))
  })

  it('freezes longer for a kill than for a glancing hit', () => {
    expect(freezeForEnemyHit(4, true)).toBeGreaterThan(freezeForEnemyHit(4, false))
    expect(shakeForEnemyHit(4, true)).toBeGreaterThan(shakeForEnemyHit(4, false))
  })

  it('caps every freeze, however large the damage', () => {
    // A long freeze does not read as weight, it reads as a hang.
    expect(freezeForEnemyHit(1e9, true)).toBe(FREEZE_MAX_TICKS)
    expect(freezeForHullHit(1e9, false)).toBe(FREEZE_MAX_TICKS)
    expect(freezeForHullHit(4, true)).toBe(FREEZE_MAX_TICKS)
    expect(FREEZE_MAX_TICKS).toBeLessThanOrEqual(10)
  })

  it('keeps every shake impulse inside 0..1', () => {
    for (const damage of [0, 1, 4, 12, 40, 400, 1e9]) {
      for (const flag of [false, true]) {
        for (const impulse of [shakeForEnemyHit(damage, flag), shakeForHullHit(damage, flag)]) {
          expect(impulse).toBeGreaterThanOrEqual(0)
          expect(impulse).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('treats taking a hit as a bigger event than landing one', () => {
    expect(freezeForHullHit(8, false)).toBeGreaterThan(freezeForEnemyHit(8, true))
    expect(shakeForHullHit(8, false)).toBeGreaterThan(shakeForEnemyHit(8, true))
  })

  it('takes the longest freeze rather than the sum of them', () => {
    // Four enemies dying on one tick is one impact, not four. Summing is the
    // failure mode that stops the game dead on a lucky tick, and the player's
    // weapon lands at most one hit per tick, so the sim alone would never show it.
    expect(extendFreeze(3, 3)).toBe(3)
    expect(extendFreeze(3, 5)).toBe(5)
    expect(extendFreeze(5, 3)).toBe(5)

    // However many grants arrive, the total cannot grow past the cap...
    let freeze = 0
    for (let i = 0; i < 100; i++) freeze = extendFreeze(freeze, 3)
    expect(freeze).toBe(3)
    // ...and no single grant can either.
    expect(extendFreeze(0, 1000)).toBe(FREEZE_MAX_TICKS)
    expect(extendFreeze(FREEZE_MAX_TICKS, 1000)).toBe(FREEZE_MAX_TICKS)
    expect(extendFreeze(0, -5)).toBe(0)
  })

  it('accumulates shake but never past full strength', () => {
    expect(addShake(0.2, 0.3)).toBeCloseTo(0.5, 12)
    expect(addShake(0.9, 0.9)).toBe(1)
    expect(addShake(1, 1)).toBe(1)
    expect(addShake(0, -1)).toBe(0)
  })

  it('ignores damage that cannot have landed', () => {
    expect(freezeForEnemyHit(0, false)).toBe(0)
    expect(freezeForEnemyHit(-5, false)).toBe(0)
    expect(freezeForEnemyHit(Number.NaN, false)).toBe(0)
    expect(shakeForEnemyHit(Number.NaN, false)).toBeGreaterThanOrEqual(0)
  })
})

// --- hitstop, events, and shake through the world ---------------------------

/** Every event emitted over `ticks` ticks, paired with the tick it came from. */
function eventLog(
  world: World,
  input: InputSnapshot,
  ticks: number,
): Array<{ tick: number; event: SimEvent }> {
  const log: Array<{ tick: number; event: SimEvent }> = []
  for (let i = 0; i < ticks; i++) {
    world.tick(input)
    for (const event of world.events) log.push({ tick: world.stats.tick, event })
  }
  return log
}

function eventsOfKind<K extends SimEvent['kind']>(
  log: Array<{ tick: number; event: SimEvent }>,
  kind: K,
): Array<Extract<SimEvent, { kind: K }>> {
  return log
    .filter((entry) => entry.event.kind === kind)
    .map((entry) => entry.event as Extract<SimEvent, { kind: K }>)
}

/** Put a real def in front of the hull. Fabricated defs are not in ENEMIES. */
function withEnemy(world: World, id: string, x: number, y: number): EnemyDef {
  const def = ENEMIES[id] as EnemyDef
  expect(def).toBeDefined()
  world.enemies.push(createEnemy(def, x, y, 1038))
  return def
}

/** Everything a frozen tick must leave untouched. */
function gameplaySnapshot(world: World): string {
  return JSON.stringify({
    hull: world.hull,
    playerBullets: world.playerBullets,
    enemyBullets: world.enemyBullets,
    enemies: world.enemies.map((e) => ({ ...e, hitFlashTicks: 0 })),
    waveIndex: world.currentWaveIndex,
    shotsFired: world.stats.shotsFired,
    hits: world.stats.hits,
    kills: world.stats.kills,
  })
}

const DRIFTING: InputSnapshot = { moveX: 1, moveY: -1, fire: true, special: false, focus: false }

/** Tick until the world is frozen, or give up. Returns the tick it froze on. */
function tickUntilFrozen(world: World, input: InputSnapshot, max: number): number {
  for (let i = 0; i < max; i++) {
    world.tick(input)
    if (world.freezeTicks > 0) return world.stats.tick
  }
  return -1
}

describe('hitstop', () => {
  it('freezes gameplay while consuming real ticks, then resumes', () => {
    const world = new World('H1TST0P12345')
    withEnemy(world, 'hauler', world.hull.x, world.hull.y - 140)

    // A kill is the event that earns a freeze; a single 4-damage hit does not.
    // Held still and firing, so the shots actually connect.
    const frozeOn = tickUntilFrozen(world, FIRING, 140)
    expect(frozeOn).toBeGreaterThan(0)
    expect(world.stats.kills).toBe(1)

    const granted = world.freezeTicks
    expect(granted).toBeGreaterThan(0)
    expect(granted).toBeLessThanOrEqual(FREEZE_MAX_TICKS)

    // Now ask for movement and fire. Neither may happen while frozen: input is not
    // buffered, the tick is simply spent.
    for (let i = 0; i < granted; i++) {
      const before = gameplaySnapshot(world)
      const tickBefore = world.stats.tick
      const explosionAges = world.explosions.map((x) => x.age)

      world.tick(DRIFTING)

      // Gameplay held: the hull did not move, nothing fired, nothing advanced.
      expect(gameplaySnapshot(world), `frozen tick ${i + 1}`).toEqual(before)
      // ...but the tick was really spent, which is what keeps one input byte
      // meaning one tick and a replay reproducible.
      expect(world.stats.tick).toBe(tickBefore + 1)
      expect(world.freezeTicks).toBe(granted - i - 1)
      // ...and presentation kept breathing, so the freeze reads as impact and not
      // as a hang.
      expect(world.explosions.map((x) => x.age)).toEqual(explosionAges.map((a) => a + 1))
    }

    expect(world.freezeTicks).toBe(0)
    const hullBefore = { x: world.hull.x, y: world.hull.y }
    const shotsBefore = world.stats.shotsFired
    world.tick(DRIFTING)
    expect(world.hull.x).toBeGreaterThan(hullBefore.x)
    expect(world.hull.y).toBeLessThan(hullBefore.y)
    // The weapon's cadence was frozen with everything else rather than banking
    // ticks, so it resumes rather than catching up: the shot arrives within one
    // fire interval of the thaw, not on the first tick after it.
    world.tick(DRIFTING)
    world.tick(DRIFTING)
    expect(world.stats.shotsFired).toBeGreaterThan(shotsBefore)
  })

  it('never exceeds its cap, and no freeze can be extended by another', () => {
    // The cap is enforced at the point of application, and because no collision or
    // firing phase runs while frozen, nothing can land a hit to extend a freeze.
    // A run of consecutive frozen ticks longer than the cap would mean one of those
    // two properties broke — most likely by summing freezes instead of taking the
    // longest.
    const world = new World('CAPFREEZE123')
    let consecutive = 0
    let longest = 0
    let frozenTicks = 0
    for (let i = 0; i < 6000; i++) {
      world.tick(FIRING)
      expect(world.freezeTicks).toBeLessThanOrEqual(FREEZE_MAX_TICKS)
      expect(world.freezeTicks).toBeGreaterThanOrEqual(0)
      if (world.freezeTicks > 0) {
        frozenTicks++
        consecutive++
        longest = Math.max(longest, consecutive)
      } else {
        consecutive = 0
      }
    }
    // The assertion is worthless if the run never froze.
    expect(frozenTicks).toBeGreaterThan(20)
    expect(longest).toBeLessThanOrEqual(FREEZE_MAX_TICKS)
  })

  it('spends a small enough share of a sortie to stay a garnish', () => {
    // Hitstop trades away real playing time. Measured rather than assumed: if a
    // retune ever pushes this past a few percent, the game is stuttering.
    const world = new World('FREEZESHARE1')
    let frozen = 0
    const ticks = 6000
    for (let i = 0; i < ticks; i++) {
      world.tick(FIRING)
      if (world.freezeTicks > 0) frozen++
    }
    expect(frozen / ticks).toBeLessThan(0.08)
  })

  it('delays a wave release by at most one freeze, and never drops one', () => {
    // The wave clock is stats.tick, which advances through a freeze, and Spawner
    // releases everything due at or *before* the tick it is handed. So a freeze can
    // postpone a release but can never skip it. Implementing hitstop by not
    // advancing the tick counter would break this immediately.
    const world = new World('FREEZEWAVES1')
    const scheduled = [...SECTOR_ONE.waves]
      .sort((a, b) => a.atSeconds - b.atSeconds)
      .map((wave) => Math.round(wave.atSeconds * TICK_HZ))

    let froze = false
    const releases: number[] = []
    for (let i = 0; i < 6000 && world.runState === 'active'; i++) {
      world.tick(FIRING)
      if (world.freezeTicks > 0) froze = true
      for (const event of world.events) {
        if (event.kind === 'wave-released') releases.push(world.stats.tick)
      }
    }

    expect(froze).toBe(true)
    expect(releases.length).toBeGreaterThan(4)
    for (let i = 0; i < releases.length; i++) {
      const due = scheduled[i] as number
      const actual = releases[i] as number
      expect(actual, `wave ${i + 1} released early`).toBeGreaterThanOrEqual(due)
      expect(actual - due, `wave ${i + 1} released late`).toBeLessThanOrEqual(FREEZE_MAX_TICKS)
    }
  })
})

describe('sim events', () => {
  it('clears the list every tick', () => {
    const world = new World('EVENTCLEAR12')
    world.tick(FIRING)
    expect(world.events.some((e) => e.kind === 'player-shot')).toBe(true)
    // The next tick's list describes that tick and nothing before it. Draining per
    // frame instead of per tick is what this protects against.
    world.tick(NEUTRAL_INPUT)
    expect(world.events.some((e) => e.kind === 'player-shot')).toBe(false)
  })

  it('reports a player shot at the muzzle that fired it', () => {
    const world = new World('EVENTSHOT123')
    world.tick(FIRING)
    const shots = world.events.filter((e) => e.kind === 'player-shot')
    expect(shots).toHaveLength(1)
    const bullet = world.playerBullets[0] as Bullet
    const shot = shots[0] as Extract<SimEvent, { kind: 'player-shot' }>
    // Same x as the bullet that left it; the bullet has already travelled a tick.
    expect(shot.x).toBeCloseTo(bullet.x, 6)
    expect(shot.y).toBeCloseTo(bullet.prevY, 6)
    expect(Math.abs(shot.x - world.hull.x)).toBeCloseTo(4.5, 6)
  })

  it('reports hits, the kill, and the scrap it paid out', () => {
    const world = new World('EVENTKILL123')
    const def = withEnemy(world, 'hauler', world.hull.x, world.hull.y - 140)
    const log = eventLog(world, FIRING, 140)

    const hits = eventsOfKind(log, 'enemy-hit')
    expect(hits.length).toBe(world.stats.hits)
    for (const hit of hits) {
      expect(hit.defId).toBe('hauler')
      expect(hit.damage).toBeGreaterThan(0)
    }
    // Exactly one hit is lethal, and it is the last one.
    expect(hits.filter((h) => h.lethal)).toHaveLength(1)
    expect((hits[hits.length - 1] as { lethal: boolean }).lethal).toBe(true)

    const killed = eventsOfKind(log, 'enemy-killed')
    expect(killed).toHaveLength(1)
    const kill = killed[0] as Extract<SimEvent, { kind: 'enemy-killed' }>
    expect(kill.defId).toBe('hauler')
    expect(kill.scrap).toBe(def.scrap)
    expect(kill.elite).toBe(false)
    // The position must be the enemy's, not the killing bullet's: the sim already
    // reaped the entity, so this is the only record of where the explosion goes.
    expect(kill.x).toBeCloseTo(world.hull.x, 6)

    const collected = eventsOfKind(log, 'scrap-collected')
    expect(collected).toHaveLength(1)
    const scrap = collected[0] as Extract<SimEvent, { kind: 'scrap-collected' }>
    expect(scrap.amount).toBe(def.scrap)
    expect(scrap.x).toBe(kill.x)
    expect(scrap.y).toBe(kill.y)
  })

  it('reports the hit at the point of impact, not the target centre', () => {
    const world = new World('EVENTSPARK12')
    const def = withEnemy(world, 'hauler', world.hull.x, world.hull.y - 140)
    const log = eventLog(world, FIRING, 60)
    const hit = eventsOfKind(log, 'enemy-hit')[0] as Extract<SimEvent, { kind: 'enemy-hit' }>
    expect(hit).toBeDefined()
    // Inside the target by definition, so never more than its radius away from the
    // centre — but not exactly at it, which would read as a hit on empty space.
    expect(Math.abs(hit.y - (world.hull.y - 140))).toBeLessThanOrEqual(def.radius + 3)
  })

  it('reports an enemy volley when it leaves, not when it was telegraphed', () => {
    const world = new World('EVENTVOLLEY1')
    const skiff = ENEMIES['skiff'] as EnemyDef
    world.enemies.push(createEnemy(skiff, 60, 220, 1039))

    const log = eventLog(world, NEUTRAL_INPUT, 145)
    const shots = eventsOfKind(log, 'enemy-shot')
    expect(shots.length).toBeGreaterThan(0)
    expect((shots[0] as { defId: string }).defId).toBe('skiff')

    // The volley event lands on the tick the bullet appears, which is
    // windupTicks after the cadence clock came due — not on the earlier tick.
    const shotTick = (log.find((e) => e.event.kind === 'enemy-shot') as { tick: number }).tick
    expect(shotTick).toBe(skiff.weapon.firstDelayTicks + skiff.weapon.windupTicks)
  })

  it('reports shield absorption, the break, and the loss of the hull', () => {
    const world = new World('EVENTDEATH12')
    const log: Array<{ tick: number; event: SimEvent }> = []
    for (let i = 0; i < 5400 && world.runState === 'active'; i++) {
      world.tick(NEUTRAL_INPUT)
      for (const event of world.events) log.push({ tick: world.stats.tick, event })
    }
    expect(world.runState).toBe('lost')

    const hullHits = eventsOfKind(log, 'hull-hit')
    expect(hullHits.length).toBeGreaterThan(1)
    expect(hullHits.some((h) => h.absorbedByShield)).toBe(true)
    expect(hullHits.some((h) => !h.absorbedByShield)).toBe(true)
    // One hull-hit per landed hit, and stats agrees.
    expect(hullHits.reduce((sum, h) => sum + h.damage, 0)).toBe(world.stats.damageTaken)

    // The shield breaks exactly once — it does not regenerate in M1.
    expect(eventsOfKind(log, 'shield-broken')).toHaveLength(1)

    const lost = eventsOfKind(log, 'hull-lost')
    expect(lost).toHaveLength(1)
    const death = lost[0] as Extract<SimEvent, { kind: 'hull-lost' }>
    expect(death.x).toBeCloseTo(world.hull.x, 6)
    expect(death.y).toBeCloseTo(world.hull.y, 6)
  })

  it('reports no impact for a hit absorbed by invulnerability', () => {
    // The player must never see a flash, a shake, or a freeze for a hit that cost
    // nothing.
    const world = new World('EVENTINVULN1')
    for (let i = 0; i < 5400 && world.stats.damageTaken === 0; i++) world.tick(NEUTRAL_INPUT)
    expect(world.hull.invulnTicks).toBeGreaterThan(0)

    const damageTaken = world.stats.damageTaken
    let hullHits = 0
    for (let i = 0; i < 20; i++) {
      world.tick(NEUTRAL_INPUT)
      hullHits += world.events.filter((e) => e.kind === 'hull-hit').length
    }
    expect(world.stats.damageTaken).toBe(damageTaken)
    expect(hullHits).toBe(0)
  })

  it('reports each wave release exactly once, in order', () => {
    const world = new World('EVENTWAVES12')
    const log = eventLog(world, NEUTRAL_INPUT, 1200)
    const released = eventsOfKind(log, 'wave-released').map((e) => e.index)
    expect(released.length).toBeGreaterThan(1)
    expect(released).toEqual(released.map((_, i) => i + 1))
    expect(released[released.length - 1]).toBe(world.currentWaveIndex)
  })

  it('stays bounded on a tick that retires a screen full of enemies', () => {
    const world = new World('EVENTFLOOD12')
    for (let i = 0; i < 3600; i++) {
      world.tick(FIRING)
      expect(world.events.length).toBeLessThanOrEqual(256)
    }
  })
})

describe('screen shake impulse', () => {
  it('stays inside 0..1 and decays to exactly zero', () => {
    const world = new World('SHAKESHAKE12')
    withEnemy(world, 'hauler', world.hull.x, world.hull.y - 140)

    let peak = 0
    for (let i = 0; i < 140; i++) {
      world.tick(FIRING)
      peak = Math.max(peak, world.cosmetic.shake)
      expect(world.cosmetic.shake).toBeGreaterThanOrEqual(0)
      expect(world.cosmetic.shake).toBeLessThanOrEqual(1)
    }
    expect(peak).toBeGreaterThan(0)

    // It must reach exactly zero, not merely approach it: an asymptote would leave
    // "is the screen shaking" true forever and the cosmetic digest never settling.
    const quiet = new World('SHAKEQUIET12')
    withEnemy(quiet, 'hauler', quiet.hull.x, quiet.hull.y - 140)
    for (let i = 0; i < 140; i++) quiet.tick(FIRING)
    for (let i = 0; i < 240; i++) quiet.tick(NEUTRAL_INPUT)
    expect(quiet.cosmetic.shake).toBe(0)
  })

  it('shakes harder for a bigger event', () => {
    const world = new World('SHAKESIZE123')
    withEnemy(world, 'hauler', world.hull.x, world.hull.y - 140)
    let hitShake = 0
    let killShake = 0
    for (let i = 0; i < 140; i++) {
      world.tick(FIRING)
      const killed = world.events.some((e) => e.kind === 'enemy-killed')
      if (killed) killShake = world.cosmetic.shake
      else if (world.events.some((e) => e.kind === 'enemy-hit') && killShake === 0) {
        hitShake = Math.max(hitShake, world.cosmetic.shake)
      }
    }
    expect(hitShake).toBeGreaterThan(0)
    expect(killShake).toBeGreaterThan(hitShake)
  })

  it('never starts a run already shaking', () => {
    expect(new World('SHAKESTART12').cosmetic.shake).toBe(0)
    expect(new World('SHAKESTART12').freezeTicks).toBe(0)
    expect(new World('SHAKESTART12').events).toHaveLength(0)
  })
})

describe('render-only countdowns', () => {
  it('ages the hit flash independently of the movement script', () => {
    // Split out of updateEnemyMovement so it can keep running during hitstop, when
    // movement deliberately does not.
    const def = makeDef({})
    const e = createEnemy(def, 100, 100, 1040)
    applyEnemyDamage(e, 1)
    const flash = e.hitFlashTicks
    expect(flash).toBeGreaterThan(0)

    updateEnemyMovement(e, def)
    expect(e.hitFlashTicks).toBe(flash)

    ageEnemyCosmetics(e)
    expect(e.hitFlashTicks).toBe(flash - 1)

    for (let i = 0; i < flash * 2; i++) ageEnemyCosmetics(e)
    expect(e.hitFlashTicks).toBe(0)
  })
})
