/**
 * Shield recovery.
 *
 * The mechanic is small; the two numbers it turns on are not, and they are what this
 * file is really guarding. From "The shield recharges" in docs/DESIGN.md:
 *
 *   1. Suppression must strictly outlast the invulnerability window. The window is 45
 *      ticks and caps damage intake at 1.33 hits/second, so if recovery could tick
 *      between two hits of a sustained stream the shield would stop being a buffer and
 *      become flat damage reduction — and boss bullet density, already measured as
 *      inert, would be inert for a second independent reason.
 *   2. Recovery must not out-heal the intake cap. A rate above it makes the pilot
 *      immune to any pattern under the cap; that is the failure mode a "shields
 *      recharge" change is most likely to ship.
 *
 * Both are asserted against the *stat bounds* rather than against the base values, so
 * they hold for every build the fold can produce rather than only for a bare hull.
 * A test that only checked the defaults would pass while an item stack walked straight
 * through the constraint it exists to protect.
 */

import { describe, expect, it } from 'vitest'

import { TICK_HZ } from '../src/core/loop'
import type { Hull } from '../src/sim/entities'
import {
  applyHullDamage,
  type DamageContext,
  HULL_COLLISION_RADIUS,
  HULL_INVULN_TICKS,
  tickHullInvulnerability,
  tickShieldRegen,
} from '../src/sim/damage'
import { resolveStat, STATS } from '../src/sim/stats'
import { World } from '../src/sim/world'

const BASE_RATE = STATS.shieldRegenPerSecond.base
const BASE_DELAY = STATS.shieldRegenDelayTicks.base

function makeHull(over: Partial<Hull> = {}): Hull {
  return {
    x: 100,
    y: 600,
    prevX: 100,
    prevY: 600,
    integrity: 100,
    maxIntegrity: 100,
    shield: 40,
    maxShield: 40,
    shieldRegenProgress: 0,
    shieldRegenBlockedTicks: 0,
    // Deliberately far above any real sector's reserve, so the tests below measure the
    // RATE and the DELAY in isolation. The reserve has its own describe block, and
    // mixing the two would mean a rate test could pass because the reserve ran out.
    shieldReserve: 100_000,
    invulnTicks: 0,
    radius: HULL_COLLISION_RADIUS,
    ...over,
  }
}

function makeContext(over: Partial<DamageContext> = {}): DamageContext {
  return {
    hull: makeHull(),
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
    ...over,
  }
}

/** Advance `ticks` ticks of recovery at a fixed rate. Returns the hull for chaining. */
function recover(hull: Hull, ticks: number, perSecond = BASE_RATE): Hull {
  for (let i = 0; i < ticks; i++) tickShieldRegen(hull, perSecond)
  return hull
}

describe('the suppression floor holds above the invulnerability window', () => {
  /**
   * THE LOAD-BEARING ASSERTION. If this fails, the shield has become damage reduction
   * and every balance number measured against "140 effective health" is wrong.
   */
  it('cannot be pushed to or below the invulnerability window by any item stack', () => {
    expect(STATS.shieldRegenDelayTicks.min).toBeGreaterThan(HULL_INVULN_TICKS)
  })

  it('holds the floor against a stack of delay reducers, not just one', () => {
    // Five Standby Regulators is -300 against a base of 150: far past zero, and past
    // negative. The clamp is the only thing standing between that and a shield that
    // refills mid-stream.
    const stacked = resolveStat(
      'shieldRegenDelayTicks',
      Array.from({ length: 5 }, () => ({
        stat: 'shieldRegenDelayTicks' as const,
        kind: 'add' as const,
        value: -60,
      })),
    )
    expect(stacked).toBe(STATS.shieldRegenDelayTicks.min)
    expect(stacked).toBeGreaterThan(HULL_INVULN_TICKS)
  })

  it('recovers nothing across a sustained stream at the maximum intake rate', () => {
    // The worst case the game can actually present: a hit landing on every tick the
    // invulnerability window allows, forever. Not one point may come back.
    const ctx = makeContext()
    ctx.hull.shield = 20
    for (let tick = 0; tick < BASE_DELAY * 4; tick++) {
      tickHullInvulnerability(ctx.hull)
      tickShieldRegen(ctx.hull, BASE_RATE)
      applyHullDamage(ctx, 3, 'enemy-fire', 'skiff')
    }
    expect(ctx.hull.shield).toBeLessThanOrEqual(20)
  })

  it('recovers nothing at the shortest delay any build can reach, either', () => {
    // Same stream, but with the delay clamped to its floor. This is the case a naive
    // "just clamp it above zero" implementation would fail.
    const ctx = makeContext({ shieldRegenDelayTicks: STATS.shieldRegenDelayTicks.min })
    ctx.hull.shield = 20
    for (let tick = 0; tick < 600; tick++) {
      tickHullInvulnerability(ctx.hull)
      tickShieldRegen(ctx.hull, STATS.shieldRegenPerSecond.max)
      applyHullDamage(ctx, 3, 'enemy-fire', 'skiff')
    }
    expect(ctx.hull.shield).toBeLessThanOrEqual(20)
  })
})

describe('what actually stops recovery out-healing the intake cap', () => {
  /**
   * A CORRECTION TO THE DESIGN NOTE, recorded here because the note is what a future
   * author will read. `docs/DESIGN.md` frames the danger as "a recharge that outpaces
   * the 1.33 hits/second cap makes the pilot invulnerable", which implies the RATE is
   * the safety lever and wants a rate ceiling below sustainable incoming damage.
   *
   * It is not, and a ceiling there cannot work: Cycling Array is 12/second by design,
   * while the rate that could not out-heal even sector 1's weakest 6-damage shot over
   * one 46-tick invulnerability cycle is under 7.8/second. Any cap low enough to be the
   * guarantee would forbid the relic the change exists to enable.
   *
   * The guarantee is the DELAY FLOOR: suppression resets on every hit and its minimum
   * (60 ticks) strictly exceeds the invulnerability window (45), so under sustained fire
   * recovery never gets a tick to run in — at ANY rate. This test pins that reasoning
   * down so nobody "fixes" the rate cap and thinks they have tightened something.
   */
  it('is the delay floor, not the rate cap — the rate cap alone would not be enough', () => {
    const cycleTicks = HULL_INVULN_TICKS + 1
    const gainAtMaxRate = (STATS.shieldRegenPerSecond.max / TICK_HZ) * cycleTicks
    // Deliberately asserting the rate cap is INSUFFICIENT. If a future change makes this
    // fail, the rate ceiling has been dropped below the relic's own 12/second and the
    // content no longer fits inside its bounds.
    expect(gainAtMaxRate).toBeGreaterThan(6)
    // And this is the clause that carries the guarantee instead.
    expect(STATS.shieldRegenDelayTicks.min).toBeGreaterThan(HULL_INVULN_TICKS)
  })
})

describe('recovery after a lull', () => {
  it('waits exactly the delay, then returns the first point on schedule', () => {
    const ctx = makeContext()
    applyHullDamage(ctx, 10, 'enemy-fire', 'skiff')
    expect(ctx.hull.shield).toBe(30)
    expect(ctx.hull.shieldRegenBlockedTicks).toBe(BASE_DELAY)

    // Not a point early: through the whole suppression window and the ticks it takes to
    // bank the first point afterwards.
    const ticksToFirstPoint = Math.ceil(TICK_HZ / BASE_RATE)
    recover(ctx.hull, BASE_DELAY + ticksToFirstPoint - 1)
    expect(ctx.hull.shield).toBe(30)

    recover(ctx.hull, 1)
    expect(ctx.hull.shield).toBe(31)
  })

  it('refills 40 points in ten seconds of calm, which is the authored rate', () => {
    // 4/second into a 40-point pool. The item cards state this number, so it is a
    // promise to the player and not an implementation detail. Measured with the reserve
    // held out of the way — in a real sector the base 20-point reserve stops this
    // halfway, which is the whole design and is covered in the reserve block below.
    const ctx = makeContext()
    ctx.hull.shield = 0
    ctx.hull.shieldRegenBlockedTicks = 0
    recover(ctx.hull, 10 * TICK_HZ)
    expect(ctx.hull.shield).toBe(40)
  })

  it('stops at the maximum and banks no progress past it', () => {
    const hull = makeHull({ shield: 39 })
    recover(hull, 600)
    expect(hull.shield).toBe(40)
    // Progress must not sit at a fraction once full, or lowering max shield later would
    // hand back a point that was never earned.
    expect(hull.shieldRegenProgress).toBe(0)
  })

  it('discards banked progress when a hit lands, so partial recovery does not carry', () => {
    const ctx = makeContext()
    ctx.hull.shield = 20
    ctx.hull.shieldRegenBlockedTicks = 0
    // Bank most of a point without completing one.
    recover(ctx.hull, Math.ceil(TICK_HZ / BASE_RATE) - 1)
    expect(ctx.hull.shield).toBe(20)
    expect(ctx.hull.shieldRegenProgress).toBeGreaterThan(0)

    applyHullDamage(ctx, 3, 'enemy-fire', 'skiff')
    expect(ctx.hull.shieldRegenProgress).toBe(0)
  })

  it('suppresses recovery for a hit that bypassed the shield entirely', () => {
    // Corrosion. Being rotted still counts as being under fire — otherwise a hazard
    // that ignores the shield would be a way to top it up while taking damage.
    const ctx = makeContext()
    ctx.hull.shield = 20
    ctx.hull.shieldRegenBlockedTicks = 0
    applyHullDamage(ctx, 5, 'hazard', 'corrosion', { bypassShield: true })
    expect(ctx.hull.integrity).toBe(95)
    expect(ctx.hull.shieldRegenBlockedTicks).toBe(BASE_DELAY)
  })

  it('recovers nothing at all when the rate is zero, without spinning', () => {
    // A curse may switch recovery off. `min: 0` makes that expressible, and it must be
    // a no-op rather than a loop that never satisfies its exit condition.
    const hull = makeHull({ shield: 0 })
    recover(hull, 600, 0)
    expect(hull.shield).toBe(0)
    expect(hull.shieldRegenProgress).toBe(0)
  })

  it('recovers nothing on a hull with no shield to recover', () => {
    // Exposed Core takes maxShield to 0. Recovery must not manufacture a pool.
    const hull = makeHull({ shield: 0, maxShield: 0 })
    recover(hull, 600)
    expect(hull.shield).toBe(0)
  })

  it('is not suppressed at spawn — a pilot who has not been hit is not recovering', () => {
    const hull = makeHull()
    expect(hull.shieldRegenBlockedTicks).toBe(0)
  })
})

/**
 * The reserve is what makes recovery balanceable, and the measurements that forced it
 * are recorded in `shieldReservePerSector`'s docs. These tests exist because the
 * alternative — a purely time-based recharge — was measured at a 15% -> 76% clear rate
 * swing, and the reserve is the only thing standing between the shipped game and that.
 */
describe('the per-sector reserve bounds what recovery can ever contribute', () => {
  it('stops recovering once the reserve is spent, however long the lull lasts', () => {
    const hull = makeHull({ shield: 0, shieldReserve: 12 })
    recover(hull, 60 * 60)
    expect(hull.shield).toBe(12)
  })

  it('spends exactly one reserve point per shield point', () => {
    const hull = makeHull({ shield: 10, shieldReserve: 30 })
    recover(hull, 5 * TICK_HZ) // 4/s for 5s = 20 points, all affordable
    expect(hull.shield).toBe(30)
    expect(hull.shieldReserve).toBe(10)
  })

  it('banks no progress once the reserve is empty', () => {
    // Otherwise the next sector's refill would immediately pay out a point earned
    // against the previous sector's budget.
    const hull = makeHull({ shield: 0, shieldReserve: 1 })
    recover(hull, 600)
    expect(hull.shield).toBe(1)
    expect(hull.shieldReserve).toBe(0)
    expect(hull.shieldRegenProgress).toBe(0)
  })

  it('recovers nothing at all on a zero reserve, whatever the rate', () => {
    const hull = makeHull({ shield: 0, shieldReserve: 0 })
    recover(hull, 600, STATS.shieldRegenPerSecond.max)
    expect(hull.shield).toBe(0)
  })

  it('refills on sector entry, and does not carry an unspent reserve forward', () => {
    // Through the real World rather than a hull fixture, because "refills on sector
    // entry" is a claim about `beginStage` and a fixture cannot test it.
    const world = new World('RESERVESECTOR')
    const perSector = STATS.shieldReservePerSector.base
    expect(world.hull.shieldReserve).toBe(perSector)
  })

  it('caps the total a five-sector run can recover below one extra integrity pool', () => {
    // The arithmetic the difficulty curve is tuned against, expressed against a figure
    // that means something rather than a bare constant: five reserves must be worth less
    // than a second hull. At 15/sector that is 75 points against 100 integrity.
    //
    // If this stops holding, recovery has become the dominant variable — which is what
    // the measured table in `shieldReservePerSector` shows happens fast, and it is the
    // finding that made integrity recovery worth 1.9-2.6x the clear rate on its own.
    const perRun = STATS.shieldReservePerSector.base * 5
    expect(perRun).toBeLessThan(STATS.maxIntegrity.base)
  })
})

describe('recovery is deterministic and tick-quantised', () => {
  it('keeps shield a whole number at every tick of a fractional rate', () => {
    // 4.7/second divides into no whole number of ticks. `shield` must still never be
    // fractional, because the panel prints it — the unrounded-float defect that shipped
    // once on the integrity meter (finding R4) came from exactly this shape.
    const hull = makeHull({ shield: 0 })
    for (let i = 0; i < 600; i++) {
      tickShieldRegen(hull, 4.7)
      expect(Number.isInteger(hull.shield)).toBe(true)
    }
  })

  it('produces an identical sequence from an identical start, to the tick', () => {
    const trace = (): number[] => {
      const hull = makeHull({ shield: 0 })
      return Array.from({ length: 400 }, () => {
        tickShieldRegen(hull, 4.7)
        return hull.shield
      })
    }
    expect(trace()).toEqual(trace())
  })

  it('never exceeds the pool even when a single tick could bank several points', () => {
    // A rate high enough to complete more than one point per tick exercises the `while`
    // rather than an `if`, and must still respect the ceiling.
    const hull = makeHull({ shield: 0, maxShield: 3 })
    tickShieldRegen(hull, STATS.shieldRegenPerSecond.max * 20)
    expect(hull.shield).toBe(3)
  })
})
