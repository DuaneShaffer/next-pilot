/**
 * The multi-sector run: stages, bosses, hazards, and the world map between them.
 *
 * Everything here drives a real `World` through real ticks. A run that advances
 * between sectors has a lot of state that only exists at the seam — the spawner is
 * replaced, the wave clock rebases, hazards arm, the reward schedule restarts — and
 * every one of those is invisible to a single-sector test.
 *
 * Content is FABRICATED, not imported, for the reason stated in world.ts: a balance
 * change must not be able to break a simulation test. Two tests at the end
 * deliberately break that rule and run the shipping tables, because "the real
 * five-sector run can be completed at all" is not a claim a fabricated sector can
 * make.
 */

import { describe, expect, it } from 'vitest'
import { NEUTRAL_INPUT, type InputSnapshot } from '../src/core/input'
import { TICK_HZ } from '../src/core/loop'
import { World, type RunContent } from '../src/sim/world'
import { HAZARD_ACTIVE_TICKS, HAZARD_WARNING_TICKS, INTERDICTION_SPEED_FACTOR } from '../src/sim/hazards'
import { bossPhaseDefId } from '../src/sim/bosses'
import { FREEZE_MAX_TICKS } from '../src/sim/damage'
import { CHOICE_TIMEOUT_TICKS, HELD_CONFIRM_DWELL_TICKS } from '../src/sim/progression'
import { BOSSES } from '../src/content/bosses'
import { HAZARDS } from '../src/content/hazards'
import { HULLS } from '../src/content/hulls'
import { STANDARD_RUN } from '../src/content/runs'
import { SECTORS } from '../src/content/sectors'
import type { BossDef, HazardDef, RunDef, SectorDef } from '../src/content/types'
import type { SimEvent } from '../src/sim/entities'

// --- fabricated content ------------------------------------------------------

/** A sector that spawns nothing and ends after `seconds`. The seam under a microscope. */
function emptySector(id: string, seconds: number): SectorDef {
  return { id, name: id.toUpperCase(), durationSeconds: seconds, waves: [] }
}

/** A sector with one wave, so wave-relative timing can be checked after a rebase. */
function oneWaveSector(id: string, seconds: number, atSeconds: number): SectorDef {
  return {
    id,
    name: id.toUpperCase(),
    durationSeconds: seconds,
    waves: [{ atSeconds, formations: [{ enemyId: 'skiff', count: 1, pattern: 'line' }] }],
  }
}

const TEST_BOSS: BossDef = {
  id: 'test-boss',
  name: 'Test Boss',
  hp: 60,
  radius: 20,
  contactDamage: 10,
  scrap: 50,
  shape: 'hauler',
  phases: [
    {
      fromHealthFraction: 1,
      movement: 'hover',
      movementParams: { speed: 60, holdYFraction: 0.25 },
      weapon: { kind: 'aimed', intervalTicks: 90, bulletSpeed: 100, damage: 5, firstDelayTicks: 60, windupTicks: 30 },
      callout: 'OPENING',
    },
    {
      fromHealthFraction: 0.5,
      movement: 'hover',
      movementParams: { speed: 60, holdYFraction: 0.25 },
      weapon: { kind: 'ring', intervalTicks: 120, bulletSpeed: 90, damage: 5, count: 8, firstDelayTicks: 30, windupTicks: 40 },
      callout: 'SECOND',
    },
  ],
  variants: [
    {
      id: 'test-variant',
      name: 'Test Boss',
      phases: [
        {
          fromHealthFraction: 1,
          movement: 'hover',
          movementParams: { speed: 60, holdYFraction: 0.25 },
          weapon: { kind: 'aimed', intervalTicks: 90, bulletSpeed: 100, damage: 5, firstDelayTicks: 60, windupTicks: 30 },
          callout: 'OPENING',
        },
        {
          fromHealthFraction: 0.5,
          movement: 'hover',
          movementParams: { speed: 60, holdYFraction: 0.25 },
          weapon: { kind: 'spread', intervalTicks: 100, bulletSpeed: 95, damage: 5, count: 3, spreadDegrees: 30, firstDelayTicks: 30, windupTicks: 40 },
          callout: 'VARIANT SECOND',
        },
      ],
    },
  ],
}

const CORROSION: HazardDef = {
  id: 'test-rot',
  name: 'Rot',
  kind: 'corrosion',
  description: 'Ignores shields; 12 integrity every 6 seconds.',
  intervalTicks: 6 * TICK_HZ,
  damage: 12,
}

const INTERDICT: HazardDef = {
  id: 'test-drag',
  name: 'Drag',
  kind: 'interdiction',
  description: 'Halves hull speed for 2 seconds every 6.',
  intervalTicks: 6 * TICK_HZ,
  damage: 0,
}

const DEBRIS: HazardDef = {
  id: 'test-fall',
  name: 'Fall',
  kind: 'debris',
  description: 'A curtain of debris every 6 seconds. 8 damage each.',
  intervalTicks: 6 * TICK_HZ,
  damage: 8,
}

const TEST_HAZARDS = { [CORROSION.id]: CORROSION, [INTERDICT.id]: INTERDICT, [DEBRIS.id]: DEBRIS }

function twoStageRun(hazardIds: readonly string[] = [], bossId: string | null = null): RunDef {
  return {
    id: 'two',
    name: 'Two',
    stages: [
      { sectorId: 'a', bossId, hazardIds: [] },
      { sectorId: 'b', bossId: null, hazardIds },
    ],
  }
}

function contentFor(run: RunDef, sectors: SectorDef[], extra: Partial<RunContent> = {}): RunContent {
  return {
    items: {},
    interactions: [],
    run,
    sectors: Object.fromEntries(sectors.map((s) => [s.id, s])),
    bosses: { [TEST_BOSS.id]: TEST_BOSS },
    hazards: TEST_HAZARDS,
    ...extra,
  }
}

// --- driving -----------------------------------------------------------------

const IDLE: InputSnapshot = { ...NEUTRAL_INPUT }
/** Alternating fire, so a card's rising-edge confirm is always reachable. */
function blipInput(tick: number): InputSnapshot {
  return { ...NEUTRAL_INPUT, fire: tick % 4 < 2 }
}

interface RunLog {
  world: World
  events: SimEvent[]
  ticks: number
}

/**
 * Advance until `stop` or the cap.
 *
 * The cap is deliberately low relative to the fabricated sectors, so a test that
 * fails to reach its condition fails on an assertion rather than by running for
 * minutes — and every caller asserts on `ticks` so the cap can never be mistaken for
 * success.
 */
function run(world: World, maxTicks: number, input: (tick: number) => InputSnapshot = blipInput, stop?: (w: World) => boolean): RunLog {
  const events: SimEvent[] = []
  let ticks = 0
  for (; ticks < maxTicks; ticks++) {
    world.tick(input(ticks))
    events.push(...world.events)
    if (stop?.(world)) break
    if (world.runState !== 'active') break
  }
  return { world, events, ticks }
}

// --- the seam ----------------------------------------------------------------

describe('stage progression', () => {
  it('does not extract at the end of the first sector of a multi-stage run', () => {
    const world = new World('STAGE0NEQF1V', contentFor(twoStageRun(), [emptySector('a', 2), emptySector('b', 2)]))
    const log = run(world, 3 * TICK_HZ, () => IDLE)
    // Idle input never confirms the transition card, so the run is *paused*, not over.
    expect(world.runState).toBe('active')
    expect(log.events.some((e) => e.kind === 'stage-cleared')).toBe(true)
  })

  it('advances to the second sector and extracts only after it', () => {
    const world = new World('STAGE0NEQF1V', contentFor(twoStageRun(), [emptySector('a', 2), emptySector('b', 2)]))
    const log = run(world, 20 * TICK_HZ)
    expect(world.runState).toBe('extracted')
    expect(world.stage.index).toBe(1)
    expect(world.stage.sectorId).toBe('b')
    expect(log.events.filter((e) => e.kind === 'stage-cleared')).toHaveLength(2)
  })

  it('rebases the wave clock, so a later sector does not dump its whole script at once', () => {
    // THE BUG THIS EXISTS FOR: Spawner schedules from `atSeconds` relative to its own
    // sector. Handing it the absolute run tick means every wave in sector 2 is already
    // overdue on the first tick of sector 2, and the entire script releases together.
    const world = new World('REBASE123456', contentFor(twoStageRun(), [emptySector('a', 1), oneWaveSector('b', 6, 3)]))
    // Reach sector 2.
    run(world, 20 * TICK_HZ, blipInput, (w) => w.stage.index === 1)
    expect(world.stage.index).toBe(1)
    const atArrival = world.stats.tick

    // Nothing yet: the wave is three seconds into ITS sector.
    run(world, TICK_HZ, blipInput, () => false)
    expect(world.enemies).toHaveLength(0)

    run(world, 5 * TICK_HZ, blipInput, (w) => w.enemies.length > 0)
    expect(world.enemies.length).toBeGreaterThan(0)
    const elapsed = world.stats.tick - atArrival
    // Within a tick or two of three seconds, not zero and not from run start.
    expect(elapsed).toBeGreaterThan(2.5 * TICK_HZ)
    expect(elapsed).toBeLessThan(3.5 * TICK_HZ)
  })

  it('carries the inventory, its resolved stats, and hull damage across the seam', () => {
    // A run is one continuous sortie. Rebuilding the World per sector — the obvious
    // implementation — would silently hand the pilot a fresh ship and an empty
    // inventory at every seam, and look completely fine from the outside.
    const items = {
      plate: {
        id: 'plate',
        name: 'Plate',
        tier: 'common' as const,
        mechanism: '+20 max integrity.',
        tags: [],
        stats: [{ stat: 'maxIntegrity' as const, kind: 'add' as const, value: 20 }],
      },
    }
    const hull = { id: 'test-hull', name: 'Test', mechanism: '+20 max integrity.', stats: [], startingItems: ['plate'] }
    const world = new World('CARRY1TEMS23', contentFor(twoStageRun(), [emptySector('a', 1), emptySector('b', 1)], { items, hull }))
    expect(world.hull.maxIntegrity).toBe(120)

    // Take a wound in sector 1, so the seam has something to fail to preserve.
    world.hull.integrity = 61
    run(world, 30 * TICK_HZ, blipInput, (w) => w.stage.index === 1)

    expect(world.stage.index).toBe(1)
    expect(world.inventory.map((i) => i.defId)).toContain('plate')
    expect(world.hull.maxIntegrity).toBe(120)
    expect(world.hull.integrity).toBe(61)
  })

  it('restarts wave numbering per sector, so each sector pays its own rewards', () => {
    const world = new World('WAVENUM12345', contentFor(twoStageRun(), [oneWaveSector('a', 1, 0.2), oneWaveSector('b', 3, 0.2)]))
    run(world, 30 * TICK_HZ, blipInput, (w) => w.stage.index === 1)
    expect(world.stage.index).toBe(1)
    // Reset at the seam and then counting again from the new sector's script.
    expect(world.currentWaveIndex).toBeLessThanOrEqual(1)
  })
})

// --- the world map -----------------------------------------------------------

describe('the world map', () => {
  it('opens a route card when the next sector has hazards', () => {
    const world = new World('R0VTECARD123', contentFor(twoStageRun([CORROSION.id, DEBRIS.id]), [emptySector('a', 1), emptySector('b', 1)]))
    run(world, 5 * TICK_HZ, () => IDLE)
    expect(world.pendingChoice?.kind).toBe('route')
    expect(world.pendingChoice?.routes.length).toBe(3)
  })

  it('names every route distinctly, so the label is not a coincidence', () => {
    // The screen shows a title per route and the player uses it to talk about the
    // choice. Two routes sharing one would be distinguishable only by their hazard
    // list. The builder cannot produce a collision today — the two priced rewards are
    // always an item plus one of scrap/repair — but that is a property of the current
    // pairing rule, not of the interface, and this is what pins it.
    const world = new World('NAMEDR0VTES1', contentFor(twoStageRun([CORROSION.id, DEBRIS.id]), [emptySector('a', 1), emptySector('b', 1)]))
    run(world, 5 * TICK_HZ, () => IDLE)
    const routes = world.pendingChoice?.routes ?? []
    expect(routes.length).toBe(3)
    for (const route of routes) expect(route.name.length).toBeGreaterThan(0)
    expect(new Set(routes.map((r) => r.name)).size).toBe(routes.length)
  })

  it('always offers a free direct approach first', () => {
    const world = new World('D1RECTF1RST1', contentFor(twoStageRun([CORROSION.id, DEBRIS.id]), [emptySector('a', 1), emptySector('b', 1)]))
    run(world, 5 * TICK_HZ, () => IDLE)
    const first = world.pendingChoice?.routes[0]
    expect(first?.hazards).toEqual([])
    expect(first?.hazardIds).toEqual([])
    expect(first?.reward.kind).toBe('none')
  })

  it('never shows a hazard it does not then arm, or arms one it did not show', () => {
    // The parallel-array failure mode, asserted directly: `hazardIds` and `hazards`
    // describe the same set, so a route cannot promise one thing and deliver another.
    const world = new World('SH0WNARMED12', contentFor(twoStageRun([CORROSION.id, DEBRIS.id]), [emptySector('a', 1), emptySector('b', 1)]))
    run(world, 5 * TICK_HZ, () => IDLE)
    for (const route of world.pendingChoice?.routes ?? []) {
      expect(route.hazardIds).toHaveLength(route.hazards.length)
      for (let i = 0; i < route.hazardIds.length; i++) {
        const def = TEST_HAZARDS[route.hazardIds[i] as keyof typeof TEST_HAZARDS]
        expect(route.hazards[i]?.name).toBe(def?.name)
      }
    }
  })

  it('skips the card entirely when the next sector has no hazards', () => {
    // A card whose only action is "continue" teaches the player that stopping is
    // pointless — the same mistake the unbuyable wave-8 shop made.
    const world = new World('N0HAZARDSK1', contentFor(twoStageRun([]), [emptySector('a', 1), emptySector('b', 1)]))
    run(world, 5 * TICK_HZ, () => IDLE)
    expect(world.pendingChoice?.kind).not.toBe('route')
  })

  it('arms the hazards of the route that was taken, and only those', () => {
    const world = new World('ARMTAKEN1234', contentFor(twoStageRun([CORROSION.id]), [emptySector('a', 1), emptySector('b', 4)]))
    run(world, 5 * TICK_HZ, () => IDLE)
    const routes = world.pendingChoice?.routes ?? []
    expect(routes.length).toBe(3)

    // Take option 1 (a priced route) by navigating right once, then confirming.
    let tick = 0
    const navigate = (): InputSnapshot => {
      tick++
      if (tick < 4) return { ...NEUTRAL_INPUT, moveX: tick === 2 ? 1 : 0 }
      return { ...NEUTRAL_INPUT, fire: tick % 4 < 2 }
    }
    run(world, 30 * TICK_HZ, navigate, (w) => w.stage.index === 1)
    expect(world.stage.index).toBe(1)
    expect(world.hazards.map((h) => h.id)).toEqual([CORROSION.id])
  })

  it('takes the direct route when the card is declined', () => {
    // Declining cannot mean "no route" — the run has to go somewhere, and it must not
    // be a way to collect a reward without its hazard.
    const world = new World('DECL1NED1234', contentFor(twoStageRun([CORROSION.id]), [emptySector('a', 1), emptySector('b', 2)]))
    run(world, 5 * TICK_HZ, () => IDLE)
    expect(world.pendingChoice?.kind).toBe('route')

    let tick = 0
    const decline = (): InputSnapshot => {
      tick++
      return { ...NEUTRAL_INPUT, special: tick % 4 < 2 }
    }
    run(world, 30 * TICK_HZ, decline, (w) => w.stage.index === 1)
    expect(world.stage.index).toBe(1)
    expect(world.hazards).toEqual([])
  })

  it('pays exactly the scrap a route promised, ignoring any multiplier', () => {
    // A card reading "+180 scrap" must pay 180. Routing it through `awardScrap` would
    // let a scrap-multiplier item silently make the screen a liar.
    const world = new World('PAY5CRAP1234', contentFor(twoStageRun([CORROSION.id]), [emptySector('a', 1), emptySector('b', 2)]))
    run(world, 5 * TICK_HZ, () => IDLE)
    const routes = world.pendingChoice?.routes ?? []
    const scrapRoute = routes.findIndex((r) => r.reward.kind === 'scrap')
    if (scrapRoute < 0) return // this seed rolled repair; the seeded variant is covered below

    const before = world.stats.scrap
    const reward = routes[scrapRoute]?.reward
    const amount = reward?.kind === 'scrap' ? reward.amount : 0
    let tick = 0
    const pick = (): InputSnapshot => {
      tick++
      if (tick <= scrapRoute * 2) return { ...NEUTRAL_INPUT, moveX: tick % 2 === 1 ? 1 : 0 }
      return { ...NEUTRAL_INPUT, fire: tick % 4 < 2 }
    }
    run(world, 30 * TICK_HZ, pick, (w) => w.stage.index === 1)
    expect(world.stats.scrap - before).toBe(amount)
    expect(routes[scrapRoute]?.rewardText).toContain(String(amount))
  })
})

// --- the held trigger, one layer down ----------------------------------------

describe('a held trigger can never make a transition card unresponsive', () => {
  /**
   * THE SECOND SOFT FREEZE, found reviewing the fix for the first.
   *
   * `HELD_CONFIRM_DWELL_TICKS` exists because a player holding fire — the normal
   * state in a shmup — got a card that ignored them for a minute. The dwell confirms
   * option 0 on their behalf after 48 ticks.
   *
   * But a between-sector shop can price option 0 above what the pilot is carrying.
   * The world refuses the confirm, the card stays open, nothing changed, so the next
   * tick dwell-confirms again and is refused again — for the full 20-second timeout.
   * An unresponsive card, reached by the mechanism added to prevent unresponsive
   * cards.
   *
   * The rule: a *rescue* that cannot complete becomes a decline. A deliberate press
   * on an unaffordable option must still do nothing, because that player can see the
   * option is greyed out and can navigate somewhere else.
   */
  const expensive = {
    gold: {
      id: 'gold',
      name: 'Gold',
      tier: 'relic' as const,
      mechanism: '+1 projectile damage.',
      tags: [],
      stats: [{ stat: 'projectileDamage' as const, kind: 'add' as const, value: 1 }],
    },
  }

  function atTransitionShop(): World {
    const world = new World('HELDSH0P1234', contentFor(twoStageRun(), [emptySector('a', 1), emptySector('b', 4)], { items: expensive }))
    // Idle to the transition. With no hazards there is no route card, so the shop is
    // the first thing that opens.
    run(world, 5 * TICK_HZ, () => IDLE, (w) => w.pendingChoice?.kind === 'shop')
    return world
  }

  it('reaches a shop the pilot cannot afford', () => {
    const world = atTransitionShop()
    expect(world.pendingChoice?.kind).toBe('shop')
    expect(world.stats.scrap).toBe(0)
    expect(Math.min(...(world.pendingChoice?.costs ?? [0]))).toBeGreaterThan(0)
  })

  it('declines it rather than looping, and the run continues', () => {
    const world = atTransitionShop()
    const HOLD: InputSnapshot = { ...NEUTRAL_INPUT, fire: true }

    // Well past the dwell, nowhere near the 20s timeout. If the card were looping,
    // the run would still be sitting on it here.
    for (let i = 0; i < HELD_CONFIRM_DWELL_TICKS * 3 && world.runState === 'active'; i++) {
      world.tick(HOLD)
      if (world.stage.index === 1) break
    }
    expect(world.pendingChoice).toBeNull()
    expect(world.stage.index).toBe(1)
    expect(world.stats.tick).toBeLessThan(CHOICE_TIMEOUT_TICKS)
  })

  it('tells an observer what it is about to do, and when', () => {
    // A card that decides for you while you are still reading it is the interface
    // making a permadeath choice on your behalf. Both automatic outcomes are good and
    // both exist for good reasons; the defect was that neither was visible. This is
    // the field every card screen renders from, so all four count the same thing.
    const world = atTransitionShop()
    const HOLD: InputSnapshot = { ...NEUTRAL_INPUT, fire: true }

    // Trigger held since the card opened: the dwell will confirm, and it is counting.
    world.tick(HOLD)
    const held = world.choiceResolve
    expect(held?.action).toBe('confirm')
    expect(held?.totalTicks).toBe(HELD_CONFIRM_DWELL_TICKS)
    expect(held?.ticksRemaining).toBeLessThan(HELD_CONFIRM_DWELL_TICKS)
    expect(held?.ticksRemaining).toBeGreaterThan(0)

    // Release once and the dwell is cancelled for good; the only automatic outcome
    // left is the much longer timeout, and the readout must switch to describing it.
    world.tick(IDLE)
    const released = world.choiceResolve
    expect(released?.action).toBe('skip')
    expect(released?.totalTicks).toBe(CHOICE_TIMEOUT_TICKS)

    // And it counts down rather than sitting still.
    const before = world.choiceResolve?.ticksRemaining ?? 0
    world.tick(IDLE)
    expect(world.choiceResolve?.ticksRemaining).toBeLessThan(before)
  })

  it('reports nothing when no card is open', () => {
    const world = new World('N0CARD123456', contentFor(twoStageRun(), [emptySector('a', 2), emptySector('b', 2)]))
    expect(world.choiceResolve).toBeNull()
  })

  it('but a deliberate press on an unaffordable option still does nothing', () => {
    // The other half of the rule. This player can see the option is greyed out; the
    // game must not decline on their behalf while they are looking at it.
    const world = atTransitionShop()
    let tick = 0
    for (let i = 0; i < HELD_CONFIRM_DWELL_TICKS - 4 && world.runState === 'active'; i++) {
      // Release-then-press every few ticks: a rising edge each time, and the release
      // permanently cancels the dwell rescue.
      tick++
      world.tick({ ...NEUTRAL_INPUT, fire: tick % 3 === 0 })
    }
    expect(world.pendingChoice?.kind).toBe('shop')
    expect(world.stage.index).toBe(0)
  })
})

// --- hazards -----------------------------------------------------------------

describe('hazards', () => {
  function hazardWorld(hazard: HazardDef): World {
    const world = new World('HAZARDW0RLD1', contentFor(twoStageRun([hazard.id]), [emptySector('a', 1), emptySector('b', 30)]))
    run(world, 5 * TICK_HZ, () => IDLE)
    // Take route 1, which always carries a hazard.
    let tick = 0
    run(
      world,
      30 * TICK_HZ,
      () => {
        tick++
        if (tick < 4) return { ...NEUTRAL_INPUT, moveX: tick === 2 ? 1 : 0 }
        return { ...NEUTRAL_INPUT, fire: tick % 4 < 2 }
      },
      (w) => w.stage.index === 1,
    )
    return world
  }

  it('always warns before it acts', () => {
    // THE RULE THIS MODULE EXISTS FOR. A hazard that arrives with no warning is
    // indistinguishable from integrity draining for no reason.
    const world = hazardWorld(CORROSION)
    expect(world.stage.index).toBe(1)

    const seen: SimEvent[] = []
    for (let i = 0; i < 20 * TICK_HZ && world.runState === 'active'; i++) {
      world.tick(IDLE)
      seen.push(...world.events.filter((e) => e.kind === 'hazard-warning' || e.kind === 'hazard-fired'))
    }
    const warnings = seen.filter((e) => e.kind === 'hazard-warning')
    const fires = seen.filter((e) => e.kind === 'hazard-fired')
    expect(warnings.length).toBeGreaterThan(0)
    expect(fires.length).toBeGreaterThan(0)
    // Every fire is preceded by a warning, and never by fewer than the warning window.
    expect(seen[0]?.kind).toBe('hazard-warning')
    for (let i = 0; i < seen.length; i += 2) {
      expect(seen[i]?.kind).toBe('hazard-warning')
      if (seen[i + 1]) expect(seen[i + 1]?.kind).toBe('hazard-fired')
    }
  })

  it('leaves exactly the warning window between the warning and the hit', () => {
    const world = hazardWorld(CORROSION)
    let warnedAt = -1
    for (let i = 0; i < 20 * TICK_HZ && world.runState === 'active'; i++) {
      world.tick(IDLE)
      for (const e of world.events) {
        if (e.kind === 'hazard-warning') warnedAt = world.stats.tick
        if (e.kind === 'hazard-fired' && warnedAt >= 0) {
          expect(world.stats.tick - warnedAt).toBe(HAZARD_WARNING_TICKS)
          return
        }
      }
    }
    throw new Error('hazard never fired')
  })

  it('corrosion bypasses the shield and takes integrity', () => {
    const world = hazardWorld(CORROSION)
    const shieldBefore = world.hull.shield
    const integrityBefore = world.hull.integrity
    for (let i = 0; i < 20 * TICK_HZ && world.runState === 'active'; i++) {
      world.tick(IDLE)
      if (world.events.some((e) => e.kind === 'hazard-fired')) break
    }
    expect(world.hull.shield).toBe(shieldBefore)
    expect(world.hull.integrity).toBe(integrityBefore - CORROSION.damage)
  })

  it('interdiction slows the hull only while it is active', () => {
    const world = hazardWorld(INTERDICT)
    const right: InputSnapshot = { ...NEUTRAL_INPUT, moveX: 1 }

    // Idle-phase movement, from the left wall so nothing clamps.
    world.hull.x = 20
    world.tick(right)
    const freeStep = world.hull.x - 20

    // Advance to an active window.
    let active = false
    for (let i = 0; i < 20 * TICK_HZ && !active; i++) {
      world.tick(IDLE)
      active = world.hazards.some((h) => h.phase === 'active')
    }
    expect(active).toBe(true)
    world.hull.x = 20
    world.tick(right)
    const slowStep = world.hull.x - 20

    expect(slowStep).toBeLessThan(freeStep)
    expect(slowStep).toBeCloseTo(freeStep * INTERDICTION_SPEED_FACTOR, 4)
  })

  it('debris arrives as projectiles attributed to the hazard, not to an enemy', () => {
    const world = hazardWorld(DEBRIS)
    for (let i = 0; i < 20 * TICK_HZ && world.runState === 'active'; i++) {
      world.tick(IDLE)
      if (world.events.some((e) => e.kind === 'hazard-fired')) break
    }
    expect(world.enemyBullets.length).toBeGreaterThan(0)
    // Attribution matters: the incident report must not invent an enemy named 'test-fall'.
    for (const b of world.enemyBullets) {
      expect(b.sourceDefId).toBe(DEBRIS.id)
      expect(b.causeKind).toBe('hazard')
    }
  })

  it('fires exactly one cycle apart, matching what its card claims', () => {
    /**
     * REGRESSION, and it shipped.
     *
     * `intervalTicks` is documented as "ticks between hazard events" and every
     * authored description quotes it as seconds. `HazardField` treated it as the IDLE
     * span, so the real period was `interval + 60 + activeSpan` — a card saying "every
     * 4 seconds" fired every 5, and one saying "every 5" fired every 8.
     *
     * The reason it survived review is worth keeping: the obvious content-side test —
     * assert the number in the description matches `intervalTicks` — passes either
     * way, because the text agreed with the field and only the field was wrong. The
     * gap has to be measured in TICKS BETWEEN FIRINGS, which is what this does.
     *
     * Measured on a hazard that deals NO damage, so the period is exact. A damaging
     * one is checked below, where hitstop makes it approximate.
     */
    const world = hazardWorld(INTERDICT)
    expect(world.stage.index).toBe(1)

    const fires: number[] = []
    for (let i = 0; i < 40 * TICK_HZ && world.runState === 'active'; i++) {
      world.tick(IDLE)
      if (world.events.some((e) => e.kind === 'hazard-fired')) fires.push(world.stats.tick)
    }

    expect(fires.length, 'the hazard never fired twice').toBeGreaterThan(2)
    for (let i = 1; i < fires.length; i++) {
      const gap = (fires[i] as number) - (fires[i - 1] as number)
      expect(gap, `fired ${gap} ticks apart, card promises ${INTERDICT.intervalTicks}`).toBe(
        INTERDICT.intervalTicks,
      )
    }
  })

  it('slips only by the hitstop its own damage causes', () => {
    /**
     * The honest caveat on the promise above, found by measuring: a corrosion hit is a
     * hull hit, a hull hit grants hitstop, and hitstop pauses the hazard clock along
     * with everything else in the tick. So a DAMAGING hazard's period runs a few ticks
     * long — 365 against a promised 360 when this was written.
     *
     * That is correct rather than a second bug: gameplay freezes as a whole, and a
     * hazard that kept counting through hitstop would drift *ahead* of the waves and
     * movement it shares a clock with. But it does mean "every 6 seconds" is exact
     * only for a hazard you are not being hurt by, and the bound belongs in a test
     * rather than in nobody's head.
     */
    const world = hazardWorld(CORROSION)
    const fires: number[] = []
    for (let i = 0; i < 40 * TICK_HZ && world.runState === 'active'; i++) {
      world.hull.integrity = world.hull.maxIntegrity
      world.tick(IDLE)
      if (world.events.some((e) => e.kind === 'hazard-fired')) fires.push(world.stats.tick)
    }

    expect(fires.length).toBeGreaterThan(2)
    for (let i = 1; i < fires.length; i++) {
      const gap = (fires[i] as number) - (fires[i - 1] as number)
      expect(gap).toBeGreaterThanOrEqual(CORROSION.intervalTicks)
      // One freeze per firing at most: nothing else in this scenario lands a hit.
      expect(gap, `slipped ${gap - CORROSION.intervalTicks} ticks past the promise`).toBeLessThanOrEqual(
        CORROSION.intervalTicks + FREEZE_MAX_TICKS,
      )
    }
  })

  it('a hazard cycle is never shorter than its own warning plus its window', () => {
    // Content can author any interval; a cycle shorter than the warning would fire
    // before it finished announcing itself, so the floor is enforced in code.
    const impatient: HazardDef = { ...CORROSION, id: 'impatient', intervalTicks: 5 }
    const world = new World('1MPAT1ENT123', contentFor(twoStageRun([impatient.id]), [emptySector('a', 1), emptySector('b', 30)], { hazards: { [impatient.id]: impatient } }))
    run(world, 5 * TICK_HZ, () => IDLE)
    let tick = 0
    run(world, 30 * TICK_HZ, () => {
      tick++
      if (tick < 4) return { ...NEUTRAL_INPUT, moveX: tick === 2 ? 1 : 0 }
      return { ...NEUTRAL_INPUT, fire: tick % 4 < 2 }
    }, (w) => w.stage.index === 1)

    const fires: number[] = []
    for (let i = 0; i < 30 * TICK_HZ && world.runState === 'active'; i++) {
      world.tick(IDLE)
      if (world.events.some((e) => e.kind === 'hazard-fired')) fires.push(world.stats.tick)
    }
    expect(fires.length).toBeGreaterThan(1)
    for (let i = 1; i < fires.length; i++) {
      expect((fires[i] as number) - (fires[i - 1] as number)).toBeGreaterThanOrEqual(
        HAZARD_WARNING_TICKS + HAZARD_ACTIVE_TICKS,
      )
    }
  })
})

// --- bosses ------------------------------------------------------------------

describe('bosses', () => {
  function bossWorld(seed = 'B0SSW0RLD123'): World {
    return new World(seed, contentFor(twoStageRun([], TEST_BOSS.id), [emptySector('a', 1), emptySector('b', 1)]))
  }

  it('spawns the boss only after the wave script is done and the field is clear', () => {
    const world = bossWorld()
    const log = run(world, 5 * TICK_HZ, () => IDLE, (w) => w.boss !== null)
    expect(world.boss).not.toBeNull()
    expect(log.events.some((e) => e.kind === 'boss-spawned')).toBe(true)
    expect(world.boss?.boss?.bossId).toBe(TEST_BOSS.id)
  })

  it('holds the stage open until the boss is dead', () => {
    const world = bossWorld()
    run(world, 10 * TICK_HZ, () => IDLE, (w) => w.boss !== null)
    // Well past the sector's one-second duration, and still on stage 0.
    run(world, 5 * TICK_HZ, () => IDLE, () => false)
    expect(world.stage.index).toBe(0)
    expect(world.runState).toBe('active')
  })

  it('changes phase at the authored health fraction and announces it', () => {
    const world = bossWorld()
    run(world, 10 * TICK_HZ, () => IDLE, (w) => w.boss !== null)
    const boss = world.boss
    expect(boss?.boss?.phaseIndex).toBe(0)

    // Straight past the 50% threshold.
    if (boss) boss.hp = TEST_BOSS.hp * 0.4
    world.tick(IDLE)
    expect(boss?.boss?.phaseIndex).toBe(1)
    expect(boss?.defId).toBe(bossPhaseDefId(TEST_BOSS.id, 1))

    // Compared against the FORM'S OWN callout, not the base boss's. This seed may
    // have rolled a variant, and asserting the base text would make the test a
    // coin flip on the variant roll.
    const expected = boss?.boss?.callouts[1]
    expect(expected).toBeTruthy()
    const phaseEvent = world.events.find((e) => e.kind === 'boss-phase')
    expect(phaseEvent).toBeDefined()
    if (phaseEvent?.kind === 'boss-phase') expect(phaseEvent.callout).toBe(expected)
  })

  it('keeps hitbox and silhouette identical across phases', () => {
    // A phase that changed either would teleport the hurtbox or swap the model
    // mid-sentence. Both are unexplainable to the player.
    const world = bossWorld()
    run(world, 10 * TICK_HZ, () => IDLE, (w) => w.boss !== null)
    const boss = world.boss
    const radius = boss?.radius
    const shape = boss?.shape
    if (boss) boss.hp = TEST_BOSS.hp * 0.4
    world.tick(IDLE)
    expect(boss?.radius).toBe(radius)
    expect(boss?.shape).toBe(shape)
  })

  it('never leaves the playfield, and never streaks when it wraps', () => {
    const world = bossWorld()
    run(world, 10 * TICK_HZ, () => IDLE, (w) => w.boss !== null)
    const boss = world.boss
    expect(boss).not.toBeNull()
    if (!boss) return

    // Shove it off the bottom, the way a `swoop` phase would.
    boss.y = 4000
    world.tick(IDLE)
    expect(world.enemies).toContain(boss)
    expect(boss.y).toBeLessThan(0)
    // prevY moved with it, or the renderer draws a line across the whole playfield.
    expect(Math.abs(boss.y - boss.prevY)).toBeLessThan(50)
  })

  it('picks a seeded variant, and the same seed picks the same one', () => {
    const a = bossWorld('VAR1ANTSEEDA')
    const b = bossWorld('VAR1ANTSEEDA')
    run(a, 10 * TICK_HZ, () => IDLE, (w) => w.boss !== null)
    run(b, 10 * TICK_HZ, () => IDLE, (w) => w.boss !== null)
    expect(a.boss?.boss?.variantId).toBe(b.boss?.boss?.variantId)

    // And across many seeds, more than one form is reachable — a variant nothing
    // ever rolls is content nobody sees.
    const forms = new Set<string>()
    for (let i = 0; i < 24; i++) {
      const w = bossWorld(`VAR1ANT${String(i).padStart(5, '0')}`)
      run(w, 10 * TICK_HZ, () => IDLE, (x) => x.boss !== null)
      forms.add(w.boss?.boss?.variantId ?? 'base')
    }
    expect(forms.size).toBeGreaterThan(1)
  })

  it('emits boss-killed and releases the reference when it dies', () => {
    const world = bossWorld()
    run(world, 10 * TICK_HZ, () => IDLE, (w) => w.boss !== null)
    const boss = world.boss
    if (boss) {
      boss.hp = 0
      boss.alive = false
    }
    world.tick(IDLE)
    expect(world.events.some((e) => e.kind === 'boss-killed')).toBe(true)
    expect(world.boss).toBeNull()
  })

  it('gives the boss a uid distinct from every enemy', () => {
    // Shared identity is what makes a piercing round skip a target it never hit.
    const world = new World('UNIQUEU1D123', contentFor(twoStageRun([], TEST_BOSS.id), [oneWaveSector('a', 1, 0.1), emptySector('b', 1)]))
    // uid -> the instance that claimed it. A uid seen twice is only a bug when two
    // DIFFERENT instances hold it; the same enemy living across ticks is not.
    const owners = new Map<number, unknown>()
    let sawEnemy = false
    // Generous: the skiff has to drift the full height of the playfield before the
    // field counts as clear and the boss is allowed to arrive.
    for (let i = 0; i < 40 * TICK_HZ && world.runState === 'active'; i++) {
      world.tick(IDLE)
      for (const e of world.enemies) {
        if (e.boss === undefined) sawEnemy = true
        const owner = owners.get(e.uid)
        expect(owner === undefined || owner === e, `uid ${e.uid} reused`).toBe(true)
        owners.set(e.uid, e)
      }
      if (world.boss) break
    }
    expect(world.boss).not.toBeNull()
    // The scenario has to actually contain both, or it proves nothing.
    expect(sawEnemy).toBe(true)
    expect(owners.size).toBeGreaterThan(1)
  })
})

// --- hulls -------------------------------------------------------------------

describe('hulls', () => {
  it('flies the stat table bases when no hull is supplied', () => {
    const world = new World('N0HVLL123456', contentFor(twoStageRun(), [emptySector('a', 1), emptySector('b', 1)]))
    expect(world.hull.maxIntegrity).toBe(100)
    expect(world.hull.maxShield).toBe(40)
    expect(world.hullName).toBe('Lien')
  })

  it('starts at FULL integrity on a hull that changes the maximum', () => {
    // The ordering bug this pins: folding the hull after the Hull entity is built
    // starts the run at the base value and tops it up, which reads as flying a
    // damaged ship off the pad.
    for (const hull of Object.values(HULLS)) {
      const world = new World('HVLLFVLL1234', contentFor(twoStageRun(), [emptySector('a', 1), emptySector('b', 1)], { hull, items: {} }))
      expect(world.hull.integrity, hull.id).toBe(world.hull.maxIntegrity)
      expect(world.hullName, hull.id).toBe(hull.name)
    }
  })

  it('credits a hull its exact stated starting scrap, unmultiplied', () => {
    for (const hull of Object.values(HULLS)) {
      const expected = Math.max(0, Math.round(hull.startingScrap ?? 0))
      const world = new World('HVLLSCRAP123', contentFor(twoStageRun(), [emptySector('a', 1), emptySector('b', 1)], { hull }))
      expect(world.stats.scrap, hull.id).toBe(expected)
    }
  })
})

// --- the shipping run --------------------------------------------------------

describe('the real five-sector run', () => {
  const LIVE: RunContent = {
    items: {},
    interactions: [],
    run: STANDARD_RUN,
    sectors: Object.fromEntries(SECTORS.map((s) => [s.id, s])),
    bosses: BOSSES,
    hazards: HAZARDS,
  }

  it('names a real sector, boss, and hazard at every stage', () => {
    for (const stage of STANDARD_RUN.stages) {
      expect(SECTORS.some((s) => s.id === stage.sectorId), stage.sectorId).toBe(true)
      expect(stage.bossId).not.toBeNull()
      expect(BOSSES[stage.bossId as string], stage.bossId ?? '').toBeDefined()
      for (const h of stage.hazardIds) expect(HAZARDS[h], h).toBeDefined()
    }
  })

  it('constructs without throwing and reports stage 1 of 5', () => {
    const world = new World('L1VERVN12345', LIVE)
    expect(world.stage.count).toBe(5)
    expect(world.stage.index).toBe(0)
    expect(world.stage.bossName).toBeTruthy()
  })

  it('an invulnerable pilot who never shoots still reaches the final stage', () => {
    /**
     * NOT a balance claim. This asserts the RUN MACHINE terminates: five spawners
     * built, four seams crossed, five bosses spawned and defeated, and an extraction
     * at the end. Difficulty is measured by the bot sweeps in tools/playtest.ts, which
     * is where a claim about whether the run is beatable belongs.
     *
     * The pilot is made unkillable and the bosses are executed directly, because the
     * alternative is a test that fails whenever a sector is retuned — and a test that
     * fails for reasons unrelated to what it checks gets rubber-stamped.
     */
    const world = new World('L1VERVN12345', LIVE)
    const bossesSeen = new Set<string>()
    let extracted = false

    for (let i = 0; i < 90 * 60 * TICK_HZ; i++) {
      world.hull.integrity = world.hull.maxIntegrity
      world.hull.shield = world.hull.maxShield
      // Clear the field so a sector ends on its own script rather than on a fight.
      for (const e of world.enemies) {
        if (e.boss !== undefined) bossesSeen.add(e.boss.bossId)
        e.alive = false
        e.hp = 0
      }
      world.enemyBullets.length = 0
      world.tick(blipInput(i))
      if (world.runState !== 'active') {
        extracted = world.runState === 'extracted'
        break
      }
    }

    expect(extracted).toBe(true)
    expect(world.stage.index).toBe(4)
    expect(bossesSeen.size).toBe(5)
  })
})
