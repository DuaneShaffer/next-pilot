/**
 * Cross-boundary assertions.
 *
 * These test agreements that span module boundaries — the places where two
 * correct-looking pieces of code can disagree about what a number means. Nothing
 * here fails a typecheck, and none of it belongs to a single module's test file,
 * which is exactly why these are the ones that rot silently.
 */

import { describe, expect, it } from 'vitest'
import { TICK_HZ } from '../src/core/loop'
import { NEUTRAL_INPUT } from '../src/core/input'
import { PLAYFIELD_H, PLAYFIELD_W, VIRTUAL_H, VIRTUAL_W, PANEL_W } from '../src/core/space'
import { getEnemy } from '../src/content/enemies'
import { SECTOR_ONE, SECTORS } from '../src/content/sectors'
import { createEnemy, updateEnemyMovement } from '../src/sim/enemies'
import { BOTS } from '../src/sim/bots'
import { World } from '../src/sim/world'
import type { EnemyDef } from '../src/content/types'

describe('sine frequency means oscillations per second', () => {
  /**
   * The content author tuned the skiff at frequency 0.4 believing it meant
   * 2.5 seconds per oscillation, because that is what the doc comment in
   * content/types.ts promises. The simulation independently chose to read it the
   * same way. Nothing enforced that agreement.
   *
   * If someone later "optimises" the sine to advance per-tick instead of per
   * second, skiffs would wobble 60x faster, the sector's second teaching beat
   * would quietly stop working, and every existing test would still pass.
   */
  function measurePeriodTicks(def: EnemyDef): number {
    const enemy = createEnemy(def, PLAYFIELD_W / 2, 0)
    const startX = enemy.x
    let previousX = startX
    let crossings = 0
    let firstCrossing = -1
    let lastCrossing = -1

    // Count zero crossings of (x - origin) over 10 simulated seconds. Two
    // crossings make one full oscillation.
    for (let tick = 0; tick < TICK_HZ * 10; tick++) {
      updateEnemyMovement(enemy, def)
      const offset = enemy.x - startX
      const previousOffset = previousX - startX
      if (previousOffset !== 0 && Math.sign(offset) !== Math.sign(previousOffset)) {
        crossings++
        if (firstCrossing < 0) firstCrossing = tick
        lastCrossing = tick
      }
      previousX = enemy.x
    }

    expect(crossings).toBeGreaterThanOrEqual(3)
    const halfPeriods = crossings - 1
    return ((lastCrossing - firstCrossing) / halfPeriods) * 2
  }

  it('gives the skiff the period its tuning comment claims', () => {
    const skiff = getEnemy('skiff')
    expect(skiff.movement).toBe('sine')
    const frequency = skiff.movementParams.frequency
    expect(frequency).toBeDefined()

    const expectedPeriodTicks = TICK_HZ / (frequency as number)
    const measured = measurePeriodTicks(skiff)

    // Within 5%: this is measuring a discretised sine, not solving one.
    expect(Math.abs(measured - expectedPeriodTicks) / expectedPeriodTicks).toBeLessThan(0.05)
  })

  it('oscillates around its spawn column rather than drifting off it', () => {
    const skiff = getEnemy('skiff')
    const enemy = createEnemy(skiff, PLAYFIELD_W / 2, 0)
    const originX = enemy.x
    let minX = originX
    let maxX = originX
    for (let tick = 0; tick < TICK_HZ * 6; tick++) {
      updateEnemyMovement(enemy, skiff)
      minX = Math.min(minX, enemy.x)
      maxX = Math.max(maxX, enemy.x)
    }
    const amplitude = skiff.movementParams.amplitude as number
    // The midpoint of travel must stay at the spawn column.
    expect((minX + maxX) / 2).toBeCloseTo(originX, 0)
    expect(maxX - minX).toBeGreaterThan(amplitude)
  })
})

describe('frozen playfield geometry', () => {
  /**
   * The mobile plan (docs/DESIGN.md) freezes the playfield's aspect ratio and
   * virtual units forever, and makes only the panel's *placement* responsive.
   *
   * This is not a style preference. A wider playfield makes dodging easier and a
   * narrower one makes it harder, so if the play area flexed per device, seeded
   * runs, daily contracts, and shared replays would stop being comparable and the
   * whole competitive feature set would become meaningless. Freezing it in a test
   * is how that survives someone later trying to "use the whole screen".
   */
  it('keeps the playfield at its committed dimensions', () => {
    expect(PLAYFIELD_W).toBe(448)
    expect(PLAYFIELD_H).toBe(720)
  })

  it('keeps the panel column accounted for in the virtual space', () => {
    expect(PLAYFIELD_W + PANEL_W).toBe(VIRTUAL_W)
    expect(PLAYFIELD_H).toBe(VIRTUAL_H)
  })
})

describe('sector content agrees with the simulation', () => {
  it('never asks the spawner for an enemy that does not exist', () => {
    // content.test.ts asserts this against its own table; this asserts it through
    // the same getEnemy() the simulation actually calls, so a lookup that throws
    // only at runtime cannot hide behind a passing content test.
    for (const wave of SECTOR_ONE.waves) {
      for (const formation of wave.formations) {
        expect(() => getEnemy(formation.enemyId)).not.toThrow()
      }
    }
  })

  it('can construct every enemy the sector references', () => {
    for (const wave of SECTOR_ONE.waves) {
      for (const formation of wave.formations) {
        const def = getEnemy(formation.enemyId)
        const enemy = createEnemy(def, PLAYFIELD_W / 2, -20)
        expect(enemy.hp).toBe(def.hp)
        expect(enemy.maxHp).toBe(def.hp)
        expect(enemy.alive).toBe(true)
        expect(Number.isFinite(enemy.x)).toBe(true)
        expect(Number.isFinite(enemy.y)).toBe(true)
      }
    }
  })
})

describe('run outcomes are distinguishable', () => {
  /**
   * Regression: a tester cleared sector 1 and was shown "HULL LOSS CONFIRMED"
   * with a TOTAL LOSS stamp and an unattributed cause of death.
   *
   * `runState` has three values and the summary screen assumed one of them.
   * Telling a player who just won that they died is the worst misreport the
   * interface can make, so both outcomes are now pinned here rather than only in
   * a screenshot.
   */
  it('reaches extraction on a seed where a competent policy clears', () => {
    const seed = 'K7F29XQM3RTV'
    const world = new World(seed)
    const policy = BOTS.aggressor.create(seed)
    for (let tick = 0; tick < TICK_HZ * 240 && world.runState === 'active'; tick++) {
      world.tick(policy(world))
    }
    expect(world.runState).toBe('extracted')
    // Nothing killed the pilot, so there is no incident to file. The summary
    // screen must not read this as an unattributed death.
    expect(world.incident).toBeNull()
  })

  it('files an incident only when the run was actually lost', () => {
    const seed = 'DEATHRUN1234'
    const world = new World(seed)
    for (let tick = 0; tick < TICK_HZ * 240 && world.runState === 'active'; tick++) {
      world.tick(NEUTRAL_INPUT)
    }
    expect(world.runState).toBe('lost')
    expect(world.incident).not.toBeNull()
  })

  it('never advertises more sectors than exist', () => {
    // The panel's denominator comes from SECTORS, not from the five that
    // docs/DESIGN.md plans, so it cannot claim progress that is unreachable.
    expect(SECTORS.length).toBeGreaterThan(0)
    expect(SECTORS.map((sector) => sector.id)).toContain(SECTOR_ONE.id)
  })
})
