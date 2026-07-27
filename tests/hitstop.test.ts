/**
 * Hitstop's DUTY CYCLE, which is the thing that was never bounded.
 *
 * `FREEZE_MAX_TICKS` bounds one freeze at 8 ticks and `extendFreeze` clamps to it, and
 * `world.ts` carried an invariant saying so and ending "full stop". Every word of it was
 * true and it measured the wrong quantity: nothing stopped the next freeze beginning on
 * the first unfrozen tick, so the reachable steady state was eight ticks stopped for
 * every one running — 89% of the game not happening. Reported from play as lag.
 *
 * So these tests deliberately do NOT assert anything about a single freeze; that was
 * always fine and was always tested. They assert the FRACTION OF TIME FROZEN over a
 * window, which is what a player actually experiences, and they measure it on a real
 * played run rather than on a fixture, because the failure only appears when hits are
 * dense enough to chain.
 */

import { describe, expect, it } from 'vitest'

import { NEUTRAL_INPUT } from '../src/core/input'
import { TICK_HZ } from '../src/core/loop'
import { BOSSES } from '../src/content/bosses'
import { HAZARDS } from '../src/content/hazards'
import { INTERACTIONS } from '../src/content/interactions'
import { ITEMS } from '../src/content/items'
import { STANDARD_RUN } from '../src/content/runs'
import { SECTORS } from '../src/content/sectors'
import type { HullDef } from '../src/content/types'
import { BOTS } from '../src/sim/bots'
import { FREEZE_LOCKOUT_RATIO, FREEZE_MAX_TICKS, HULL_INVULN_TICKS } from '../src/sim/damage'
import { World } from '../src/sim/world'

const SECTOR_TABLE = Object.fromEntries(SECTORS.map((sector) => [sector.id, sector]))

/**
 * A hull that survives to the dense sectors, because that is where the defect lived.
 *
 * Sector one is sparse enough that the bug barely showed: 22% in the worst second
 * against sector five's 87%. A test that only flew sector one would have passed
 * throughout, which is most of why this went unnoticed.
 */
function probeHull(startingItems: readonly string[]): HullDef {
  return {
    id: 'probe-hitstop',
    name: 'Probe Hitstop',
    mechanism: 'Instrumentation hull. Tanky enough to reach the crowded sectors.',
    stats: [{ stat: 'maxIntegrity', kind: 'add', value: 900 }],
    startingItems: [...startingItems],
  }
}

interface FreezeProfile {
  /** Frozen ticks over the whole run, as a fraction. */
  overall: number
  /** The worst one-second window anywhere in the run, as a fraction. */
  worstSecond: number
  /** Longest unbroken run of frozen ticks. */
  longestFreeze: number
  sectorsReached: number
}

function flyAndProfile(items: readonly string[], seed = 'HITSTOP00001'): FreezeProfile {
  const world = new World(seed, {
    items: ITEMS,
    interactions: INTERACTIONS,
    hull: probeHull(items),
    run: STANDARD_RUN,
    sectors: SECTOR_TABLE,
    bosses: BOSSES,
    hazards: HAZARDS,
  })
  const act = BOTS['aggressor']?.create(seed)
  if (act === undefined) throw new Error('aggressor policy missing')

  const window: number[] = []
  let frozenTicks = 0
  let total = 0
  let worstSecond = 0
  let longestFreeze = 0
  let streak = 0

  for (let i = 0; i < TICK_HZ * 60 * 25 && world.runState === 'active'; i++) {
    const frozen = world.freezeTicks > 0
    world.tick(act(world) ?? NEUTRAL_INPUT)
    total++
    if (frozen) {
      frozenTicks++
      streak++
      if (streak > longestFreeze) longestFreeze = streak
    } else {
      streak = 0
    }
    window.push(frozen ? 1 : 0)
    if (window.length > TICK_HZ) window.shift()
    if (window.length === TICK_HZ) {
      const inWindow = window.reduce((sum, n) => sum + n, 0)
      if (inWindow > worstSecond) worstSecond = inWindow
    }
  }

  return {
    overall: frozenTicks / total,
    worstSecond: worstSecond / TICK_HZ,
    longestFreeze,
    sectorsReached: world.stage.index + 1,
  }
}

/**
 * The ceiling this file defends.
 *
 * `FREEZE_LOCKOUT_RATIO` bounds ENEMY-hit hitstop at `1 / (1 + ratio)` — 25% at ratio 3.
 * Hull hits deliberately bypass the lockout, and the invulnerability window lets one
 * through every `HULL_INVULN_TICKS + 1`, so the true ceiling is the sum. Derived rather
 * than written as a literal, so retuning either constant moves the bound with it instead
 * of silently loosening what this test permits.
 */
const ENEMY_DUTY_CEILING = 1 / (1 + FREEZE_LOCKOUT_RATIO)
const HULL_DUTY_CEILING = FREEZE_MAX_TICKS / (HULL_INVULN_TICKS + 1)
const DUTY_CEILING = ENEMY_DUTY_CEILING + HULL_DUTY_CEILING

describe('hitstop cannot stop the game for long', () => {
  /**
   * Three builds, because the defect scaled with DAMAGE and the base build hid it.
   *
   * `freezeForEnemyHit` is `floor(damage / 8) + kill bonus`, so at the base 4 damage an
   * ordinary hit freezes for zero ticks and only kills stutter. At 8 — which one common
   * item reaches — EVERY BULLET becomes a freeze. The game got worse the stronger the
   * player got, which is the inversion worth keeping a test on.
   */
  const builds: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['bare hull, 4 damage', []],
    ['overpressure shells, 8 damage', ['overpressure-shells']],
    ['warheads and two slugs', ['warheads', 'machined-slugs', 'machined-slugs']],
  ]

  for (const [label, items] of builds) {
    it(`keeps every one-second window under the duty ceiling — ${label}`, () => {
      const profile = flyAndProfile(items)
      // The run has to actually reach the crowded sectors or the measurement is of
      // sector one, where the bug was nearly invisible.
      expect(profile.sectorsReached, 'run ended too early to measure anything').toBeGreaterThan(3)
      expect(
        profile.worstSecond,
        `worst second was ${Math.round(profile.worstSecond * 100)}% frozen`,
      ).toBeLessThanOrEqual(DUTY_CEILING)
    })
  }

  it('never exceeds the single-freeze ceiling either, which was always true', () => {
    // Kept so a change to the lockout cannot quietly buy its duty cycle back by making
    // individual freezes longer.
    const profile = flyAndProfile(['overpressure-shells'])
    expect(profile.longestFreeze).toBeLessThanOrEqual(FREEZE_MAX_TICKS)
  })

  it('leaves the game mostly running, not merely under a ceiling', () => {
    // A ceiling alone would be satisfied by a game frozen 24% of the time forever. The
    // whole-run figure is what says hitstop is punctuation rather than a tax.
    for (const [label, items] of builds) {
      const profile = flyAndProfile(items)
      expect(profile.overall, `${label} ran ${Math.round(profile.overall * 100)}% frozen`).toBeLessThan(0.12)
    }
  })

  it('still freezes — a bound satisfied by never freezing is not a fix', () => {
    // The obvious wrong way to pass every test above.
    const profile = flyAndProfile(['overpressure-shells'])
    expect(profile.overall).toBeGreaterThan(0)
    expect(profile.longestFreeze).toBeGreaterThan(1)
  })
})
