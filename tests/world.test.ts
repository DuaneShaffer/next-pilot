import { describe, expect, it } from 'vitest'
import { TICK_HZ, TICK_SECONDS } from '../src/core/loop'
import type { InputSnapshot } from '../src/core/input'
import { NEUTRAL_INPUT } from '../src/core/input'
import { Rng } from '../src/core/rng'
import { Playfield } from '../src/core/space'
import { SHOTS_PER_SECOND, World } from '../src/sim/world'

/**
 * Build a reproducible input script.
 *
 * Uses a seeded Rng rather than Math.random so a failing determinism test can be
 * re-run and debugged, instead of vanishing on the next attempt.
 */
function inputScript(seed: string, ticks: number): InputSnapshot[] {
  const rng = Rng.fromSeed(seed, 'test:inputs')
  const script: InputSnapshot[] = []
  let current: InputSnapshot = NEUTRAL_INPUT
  for (let i = 0; i < ticks; i++) {
    // Change direction occasionally, like a player would, rather than every tick.
    if (i % 7 === 0) {
      current = {
        moveX: (rng.int(3) - 1) as -1 | 0 | 1,
        moveY: (rng.int(3) - 1) as -1 | 0 | 1,
        fire: rng.chance(0.8),
        special: false,
        focus: rng.chance(0.15),
      }
    }
    script.push(current)
  }
  return script
}

function runScript(seed: string, script: readonly InputSnapshot[]): World {
  const world = new World(seed)
  for (const input of script) world.tick(input)
  return world
}

/** Everything that defines the outcome of a run. */
function snapshot(world: World): string {
  return JSON.stringify({
    hull: world.hull,
    bullets: world.bullets,
    stats: world.stats,
  })
}

describe('World determinism', () => {
  it('reaches an identical state from the same seed and inputs', () => {
    const script = inputScript('DETERMIN1SM2', 900)
    const a = runScript('K7F29XQM3RTV', script)
    const b = runScript('K7F29XQM3RTV', script)
    expect(snapshot(a)).toEqual(snapshot(b))
  })

  it('diverges when the inputs differ', () => {
    const a = runScript('K7F29XQM3RTV', inputScript('SCRIPTONE234', 600))
    const b = runScript('K7F29XQM3RTV', inputScript('SCRIPTTWO234', 600))
    expect(snapshot(a)).not.toEqual(snapshot(b))
  })

  it('keeps the RNG streams unconsumed by movement and firing', () => {
    // Milestone 0 has no spawns or loot, so flying around must not advance those
    // streams at all. When enemies land, this test should be replaced with one
    // asserting spawn draws are stable for a fixed tick count.
    const world = runScript('STREAMSTREA2', inputScript('STREAMIN9234', 600))
    const fresh = new World('STREAMSTREA2')
    expect(world.spawnRng.state()).toEqual(fresh.spawnRng.state())
    expect(world.lootRng.state()).toEqual(fresh.lootRng.state())
  })
})

describe('Hull movement', () => {
  it('stays inside the playfield under sustained input', () => {
    const hard: InputSnapshot = { moveX: 1, moveY: -1, fire: false, special: false, focus: false }
    const world = new World('BOUNDSBOUND2')
    for (let i = 0; i < 1200; i++) world.tick(hard)

    expect(world.hull.x).toBeGreaterThanOrEqual(0)
    expect(world.hull.x).toBeLessThanOrEqual(Playfield.w)
    expect(world.hull.y).toBeGreaterThanOrEqual(0)
    expect(world.hull.y).toBeLessThanOrEqual(Playfield.h)
  })

  it('does not let diagonal movement outrun cardinal movement', () => {
    const ticks = 20
    const cardinal = new World('DIAGONAL1234')
    for (let i = 0; i < ticks; i++) {
      cardinal.tick({ moveX: 1, moveY: 0, fire: false, special: false, focus: false })
    }
    const cardinalDistance = Math.abs(cardinal.hull.x - Playfield.centerX)

    const diagonal = new World('DIAGONAL1234')
    for (let i = 0; i < ticks; i++) {
      diagonal.tick({ moveX: 1, moveY: -1, fire: false, special: false, focus: false })
    }
    const dx = diagonal.hull.x - Playfield.centerX
    const dy = diagonal.hull.y - (Playfield.h - 110)
    const diagonalDistance = Math.hypot(dx, dy)

    expect(diagonalDistance).toBeCloseTo(cardinalDistance, 4)
  })

  it('moves more slowly while focusing', () => {
    const ticks = 20
    const normal = new World('FOCUSFOCUS23')
    const focused = new World('FOCUSFOCUS23')
    for (let i = 0; i < ticks; i++) {
      normal.tick({ moveX: 1, moveY: 0, fire: false, special: false, focus: false })
      focused.tick({ moveX: 1, moveY: 0, fire: false, special: false, focus: true })
    }
    expect(focused.hull.x).toBeLessThan(normal.hull.x)
  })

  it('records the previous position so rendering can interpolate', () => {
    const world = new World('INTERPINTER2')
    world.tick({ moveX: 1, moveY: 0, fire: false, special: false, focus: false })
    expect(world.hull.prevX).not.toBe(world.hull.x)
    expect(world.hull.prevX).toBeCloseTo(Playfield.centerX, 6)
  })
})

describe('Weapon and projectiles', () => {
  it('fires at exactly the rate the HUD advertises', () => {
    // Guards a real bug this replaced: the panel displayed 10.0 shots/s while the
    // weapon fired 20, because it was reporting volleys and labelling them shots.
    // Tying the assertion to the exported constant means the HUD and the sim
    // cannot drift apart again without failing here.
    const world = new World('CADENCECADE2')
    const firing: InputSnapshot = { moveX: 0, moveY: 0, fire: true, special: false, focus: false }
    for (let i = 0; i < TICK_HZ; i++) world.tick(firing)
    expect(world.stats.shotsFired).toBe(SHOTS_PER_SECOND)
  })

  it('alternates muzzles so fire reads as one stream', () => {
    const world = new World('MUZZLEMUZZL2')
    const firing: InputSnapshot = { moveX: 0, moveY: 0, fire: true, special: false, focus: false }
    for (let i = 0; i < 12; i++) world.tick(firing)

    const offsets = world.bullets.map((b) => Math.sign(b.x - world.hull.x))
    // Consecutive shots must come from opposite sides.
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).not.toBe(offsets[i - 1])
    }
  })

  it('fires nothing when the trigger is not held', () => {
    const world = new World('NOFIRENOFIR2')
    for (let i = 0; i < 120; i++) world.tick(NEUTRAL_INPUT)
    expect(world.stats.shotsFired).toBe(0)
    expect(world.bullets).toHaveLength(0)
  })

  it('culls projectiles that leave the playfield', () => {
    const world = new World('CULLCULLCUL2')
    const firing: InputSnapshot = { moveX: 0, moveY: 0, fire: true, special: false, focus: false }
    for (let i = 0; i < 600; i++) world.tick(firing)

    expect(world.stats.bulletsCulled).toBeGreaterThan(0)
    // Live count must stabilise rather than grow without bound.
    expect(world.bullets.length).toBeLessThan(40)
  })

  it('holds the live projectile count under the frame budget', () => {
    const world = new World('BUDGETBUDGE2')
    const firing: InputSnapshot = { moveX: 0, moveY: 0, fire: true, special: false, focus: false }
    for (let i = 0; i < 3600; i++) world.tick(firing)
    // Perf budget: the renderer is specced for low thousands of sprites, so a
    // single weapon must stay far below that on its own.
    expect(world.stats.peakBullets).toBeLessThan(64)
  })

  it('moves projectiles by exactly one tick of travel', () => {
    const world = new World('TRAVELTRAVE2')
    world.tick({ moveX: 0, moveY: 0, fire: true, special: false, focus: false })
    const bullet = world.bullets[0]
    expect(bullet).toBeDefined()
    // Spawned at the muzzle, then advanced one tick upward in the same call.
    const travelled = (bullet as { prevY: number; y: number }).prevY - (bullet as { y: number }).y
    expect(travelled).toBeCloseTo(620 * TICK_SECONDS, 6)
  })
})
