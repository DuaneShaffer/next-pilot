import { describe, expect, it } from 'vitest'
import { TICK_HZ, TICK_SECONDS } from '../src/core/loop'
import type { InputSnapshot } from '../src/core/input'
import { NEUTRAL_INPUT } from '../src/core/input'
import { Rng } from '../src/core/rng'
import { Playfield } from '../src/core/space'
import { SHOTS_PER_SECOND, World } from '../src/sim/world'
import { diffDigests, digestWorld, hashWorld } from '../src/meta/snapshot'

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
        confirm: false,
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

/** Run with one held input for `ticks`. */
function runHeld(seed: string, input: InputSnapshot, ticks: number): World {
  const world = new World(seed)
  for (let i = 0; i < ticks; i++) world.tick(input)
  return world
}

const FIRING: InputSnapshot = { moveX: 0, moveY: 0, fire: true, special: false, focus: false, confirm: false }

/**
 * Everything that defines the outcome of a run.
 *
 * The whole state, not a summary. A determinism test that compared only stats
 * would pass while enemies, projectiles, and death attribution diverged — which
 * is precisely the class of drift this is here to catch, since a replay fixture
 * is only as strong as what this function looks at.
 *
 * Deliberately includes the M2 feel state as well. Hitstop is timing, so a run
 * that froze differently is a different run; telegraph countdowns gate real
 * attacks; and the shake impulse and event stream are sim outputs that must be
 * identical on playback even though the regression *hash* keeps them separate.
 * This function is not the fixture hash and does not have to make that split — it
 * is the stricter of the two on purpose.
 */
function snapshot(world: World): string {
  return JSON.stringify({
    runState: world.runState,
    incident: world.incident,
    waveIndex: world.currentWaveIndex,
    hull: world.hull,
    playerBullets: world.playerBullets,
    enemyBullets: world.enemyBullets,
    enemies: world.enemies,
    explosions: world.explosions,
    stats: world.stats,
    freezeTicks: world.freezeTicks,
    cosmetic: world.cosmetic,
    events: world.events,
  })
}

/**
 * Run a script while watching for the states a single end-of-run snapshot cannot
 * see, so the determinism tests can prove they actually exercised them.
 */
function runObserved(
  seed: string,
  script: readonly InputSnapshot[],
): { world: World; frozenTicks: number; telegraphingTicks: number; peakShake: number; events: number } {
  const world = new World(seed)
  let frozenTicks = 0
  let telegraphingTicks = 0
  let peakShake = 0
  let events = 0
  for (const input of script) {
    world.tick(input)
    if (world.freezeTicks > 0) frozenTicks++
    if (world.enemies.some((e) => e.telegraphTicks > 0)) telegraphingTicks++
    peakShake = Math.max(peakShake, world.cosmetic.shake)
    events += world.events.length
  }
  return { world, frozenTicks, telegraphingTicks, peakShake, events }
}

describe('World determinism', () => {
  it('reaches an identical state from the same seed and inputs', () => {
    const script = inputScript('DETERMIN1SM2', 3600)
    const a = runObserved('K7F29XQM3RTV', script)
    const b = runObserved('K7F29XQM3RTV', script)
    expect(snapshot(a.world)).toEqual(snapshot(b.world))

    // The comparison is worthless unless the run actually exercised combat, so
    // assert the coverage the snapshot is supposed to be protecting.
    expect(a.world.currentWaveIndex).toBeGreaterThan(0)
    expect(a.world.stats.hits).toBeGreaterThan(0)
    expect(a.world.stats.kills).toBeGreaterThan(0)
    expect(a.world.stats.damageTaken).toBeGreaterThan(0)
    expect(a.world.explosions.length + a.world.stats.kills).toBeGreaterThan(0)

    // Including the M2 systems, which end-of-run state alone cannot evidence: a
    // freeze and a telegraph both resolve back to zero, so without this the run
    // could stop exercising either of them and this test would still pass.
    expect(a.frozenTicks).toBeGreaterThan(0)
    expect(a.telegraphingTicks).toBeGreaterThan(0)
    expect(a.peakShake).toBeGreaterThan(0)
    expect(a.events).toBeGreaterThan(0)
    // Two runs that froze and telegraphed on different ticks would have diverged
    // long before the final snapshot; comparing the counts names the cause.
    expect(b.frozenTicks).toBe(a.frozenTicks)
    expect(b.telegraphingTicks).toBe(a.telegraphingTicks)
    expect(b.events).toBe(a.events)
    expect(b.peakShake).toBe(a.peakShake)
  })

  it('reproduces a run that ends in death, incident included', () => {
    // A pilot who never moves and never shoots gets rammed. This is the only test
    // that covers the death path through the full sim rather than through
    // damage.ts directly, so it has to compare the filed incident too.
    const a = runObserved('DEATHRUN1234', new Array(5400).fill(NEUTRAL_INPUT))
    const b = runObserved('DEATHRUN1234', new Array(5400).fill(NEUTRAL_INPUT))

    expect(a.world.runState).toBe('lost')
    expect(a.world.incident).not.toBeNull()
    expect(snapshot(a.world)).toEqual(snapshot(b.world))
    expect(a.world.incident).toEqual(b.world.incident)
    // The death itself freezes, and the freeze drains rather than pinning the
    // world in a permanent hitstop behind the incident report.
    expect(a.frozenTicks).toBeGreaterThan(0)
    expect(b.frozenTicks).toBe(a.frozenTicks)
    expect(a.world.freezeTicks).toBe(0)
    expect(a.world.cosmetic.shake).toBe(0)
  })

  it('diverges when the inputs differ', () => {
    const a = runScript('K7F29XQM3RTV', inputScript('SCRIPTONE234', 600))
    const b = runScript('K7F29XQM3RTV', inputScript('SCRIPTTWO234', 600))
    expect(snapshot(a)).not.toEqual(snapshot(b))
  })

  it('diverges when the seed differs', () => {
    const script = inputScript('SAMESCRIPT12', 1800)
    const a = runScript('SEEDAAAAAAA1', script)
    const b = runScript('SEEDBBBBBBB2', script)
    expect(snapshot(a)).not.toEqual(snapshot(b))
  })

  it('keeps the RNG streams independent', () => {
    const world = runScript('STREAMSTREA2', inputScript('STREAMIN9234', 1800))
    const fresh = new World('STREAMSTREA2')

    // Spawning waves must consume the spawn stream...
    expect(world.spawnRng.state()).not.toEqual(fresh.spawnRng.state())
    // ...and must not touch loot, which nothing rolls in M1. If this ever fails,
    // a spawn decision has started drawing from the wrong stream and every
    // recorded replay's item drops have shifted.
    expect(world.lootRng.state()).toEqual(fresh.lootRng.state())
  })

  it('consumes the spawn stream identically for identical runs', () => {
    const script = inputScript('STREAMEQ1234', 1200)
    const a = runScript('STREAMSEED12', script)
    const b = runScript('STREAMSEED12', script)
    expect(a.spawnRng.state()).toEqual(b.spawnRng.state())
  })
})

describe('Hull movement', () => {
  it('stays inside the playfield under sustained input', () => {
    const hard: InputSnapshot = { moveX: 1, moveY: -1, fire: false, special: false, focus: false, confirm: false }
    const world = runHeld('BOUNDSBOUND2', hard, 1200)

    expect(world.hull.x).toBeGreaterThanOrEqual(0)
    expect(world.hull.x).toBeLessThanOrEqual(Playfield.w)
    expect(world.hull.y).toBeGreaterThanOrEqual(0)
    expect(world.hull.y).toBeLessThanOrEqual(Playfield.h)
  })

  it('does not let diagonal movement outrun cardinal movement', () => {
    const ticks = 20
    const cardinal = new World('DIAGONAL1234')
    for (let i = 0; i < ticks; i++) {
      cardinal.tick({ moveX: 1, moveY: 0, fire: false, special: false, focus: false, confirm: false })
    }
    const cardinalDistance = Math.abs(cardinal.hull.x - Playfield.centerX)

    const diagonal = new World('DIAGONAL1234')
    for (let i = 0; i < ticks; i++) {
      diagonal.tick({ moveX: 1, moveY: -1, fire: false, special: false, focus: false, confirm: false })
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
      normal.tick({ moveX: 1, moveY: 0, fire: false, special: false, focus: false, confirm: false })
      focused.tick({ moveX: 1, moveY: 0, fire: false, special: false, focus: true, confirm: false })
    }
    expect(focused.hull.x).toBeLessThan(normal.hull.x)
  })

  it('records the previous position so rendering can interpolate', () => {
    const world = new World('INTERPINTER2')
    world.tick({ moveX: 1, moveY: 0, fire: false, special: false, focus: false, confirm: false })
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
    const world = runHeld('CADENCECADE2', FIRING, TICK_HZ)
    expect(world.stats.shotsFired).toBe(SHOTS_PER_SECOND)
  })

  it('alternates muzzles so fire reads as one stream', () => {
    const world = runHeld('MUZZLEMUZZL2', FIRING, 12)

    const offsets = world.playerBullets.map((b) => Math.sign(b.x - world.hull.x))
    expect(offsets.length).toBeGreaterThan(2)
    // Consecutive shots must come from opposite sides.
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).not.toBe(offsets[i - 1])
    }
  })

  it('fires nothing when the trigger is not held', () => {
    const world = runHeld('NOFIRENOFIR2', NEUTRAL_INPUT, 120)
    expect(world.stats.shotsFired).toBe(0)
    expect(world.playerBullets).toHaveLength(0)
  })

  it('culls projectiles that leave the playfield', () => {
    const world = runHeld('CULLCULLCUL2', FIRING, 600)

    expect(world.stats.bulletsCulled).toBeGreaterThan(0)
    // Live count must stabilise rather than grow without bound.
    expect(world.playerBullets.length).toBeLessThan(40)
  })

  it('holds the live projectile count under the frame budget', () => {
    const world = new World('BUDGETBUDGE2')
    let peakPlayer = 0
    for (let i = 0; i < 3600; i++) {
      world.tick(FIRING)
      if (world.playerBullets.length > peakPlayer) peakPlayer = world.playerBullets.length
    }
    // Perf budget: the renderer is specced for low thousands of sprites, so a
    // single weapon must stay far below that on its own...
    expect(peakPlayer).toBeLessThan(64)
    // ...and a minute of sector 1 including everything shooting back must stay
    // well inside the 2,000-projectile figure in docs/ARCHITECTURE.md.
    expect(world.stats.peakProjectiles).toBeLessThan(600)
  })

  it('moves projectiles by exactly one tick of travel', () => {
    const world = new World('TRAVELTRAVE2')
    world.tick(FIRING)
    const bullet = world.playerBullets[0]
    expect(bullet).toBeDefined()
    // Spawned at the muzzle, then advanced one tick upward in the same call.
    const travelled = (bullet as { prevY: number; y: number }).prevY - (bullet as { y: number }).y
    expect(travelled).toBeCloseTo(620 * TICK_SECONDS, 6)
  })
})

describe('what the regression hash is allowed to ignore', () => {
  /**
   * snapshot.ts splits play-affecting state from presentation, and the split is
   * load-bearing in both directions. Asserted here rather than only in
   * tests/replay.test.ts's synthetic worlds, because the question is whether the
   * *real* World's new M2 fields land on the right side of the line.
   */
  /** Play until there is something on screen to mutate. */
  function played(seed: string): World {
    const world = new World(seed)
    for (let i = 0; i < 900 && world.enemies.length === 0; i++) world.tick(FIRING)
    expect(world.enemies.length).toBeGreaterThan(0)
    return world
  }

  it('counts hitstop and telegraph state as play-affecting', () => {
    const world = played('HASHFREEZE12')
    const base = hashWorld(world)

    // A freeze spends real ticks, so a run that froze differently diverges from
    // that point on. If this ever stops failing a fixture, hitstop has been moved
    // into the cosmetic digest and the corpus has stopped watching it.
    world.freezeTicks += 1
    expect(hashWorld(world)).not.toBe(base)
    world.freezeTicks -= 1
    expect(hashWorld(world)).toBe(base)

    const enemy = world.enemies[0]
    expect(enemy).toBeDefined()
    // The windup is the player's reaction window: a volley arriving a tick early is
    // a difficulty change, not a visual one.
    ;(enemy as { telegraphTicks: number }).telegraphTicks += 1
    expect(hashWorld(world)).not.toBe(base)
  })

  it('keeps the shake impulse and the event stream out of it', () => {
    const world = played('HASHCOSMET12')
    const base = digestWorld(world)

    world.cosmetic.shake = world.cosmetic.shake === 0.5 ? 0.25 : 0.5
    const shaken = digestWorld(world)
    // Retuning an impulse must not fail every fixture — that is how a corpus gets
    // rubber-stamped — but it must still be visible somewhere.
    expect(shaken.hash).toBe(base.hash)
    expect(shaken.cosmetic).not.toBe(base.cosmetic)
    expect(diffDigests(base, shaken)).toEqual(['cosmetic'])

    world.events.push({ kind: 'shield-broken', x: 1, y: 2 })
    const noisy = digestWorld(world)
    expect(noisy.hash).toBe(base.hash)
    expect(noisy.cosmetic).not.toBe(shaken.cosmetic)
  })
})
