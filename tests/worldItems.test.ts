/**
 * The item system inside a running `World`.
 *
 * `tests/inventory.test.ts` covers the fold in isolation. This file covers the
 * part that can only be wrong once a sortie is actually running: whether a stat
 * reaches the weapon, whether an effect changes what happens on the playfield,
 * whether taking an item costs what it says, and whether a run that takes items
 * still replays.
 *
 * ITEMS ARE FABRICATED. `World` takes injected content precisely so a sim test can
 * supply its own, for the same reason `combat.test.ts` fabricates enemy defs: these
 * assertions are about what the simulation does with a modifier or an effect, and
 * a balance pass on `src/content/items.ts` must not be able to fail them. The live
 * tables are checked in `tests/items.test.ts`.
 *
 * FOUR KNOWN BUGS (in five tests — two share a root cause) are pinned below with
 * `it.fails`, which passes while the bug is present and starts failing the moment it
 * is fixed. Each one says what is wrong, what the code claims instead, and what to
 * change the assertion to once it is fixed. Search KNOWN BUG.
 */

import { describe, expect, it } from 'vitest'
import type { Axis, InputSnapshot } from '../src/core/input'
import { NEUTRAL_INPUT } from '../src/core/input'
import { TICK_HZ } from '../src/core/loop'
import { ENEMIES } from '../src/content/enemies'
import type { EnemyDef, InteractionDef, ItemDef } from '../src/content/types'
import { hashWorld } from '../src/meta/snapshot'
import { createEnemy } from '../src/sim/enemies'
import type { EnemyInstance, PendingChoice, SimEvent } from '../src/sim/entities'
import { ITEM_CHOICE_WAVES, SHOP_WAVES, WORK_ORDER_WAVES } from '../src/sim/progression'
import { STATS, STAT_KEYS } from '../src/sim/stats'
import { EMPTY_CONTENT, World, type RunContent } from '../src/sim/world'

// --- input fixtures ---------------------------------------------------------

const IDLE = NEUTRAL_INPUT
/** Movement without fire, for asserting a paused run stays paused. */
const DRIFTING_NO_FIRE: InputSnapshot = {
  moveX: 1,
  moveY: -1,
  fire: false,
  special: false,
  focus: false,
  confirm: false,
}

const FIRING: InputSnapshot = { ...NEUTRAL_INPUT, fire: true }
/**
 * The accept press. A card reads `confirm`, never `fire`.
 *
 * "The selection screens must not use the fire key to accept responses" — so a test that
 * drives a card by firing at it drives nothing at all, and with no choice timeout in the
 * sim the run parks on that card until the test's tick cap.
 */
const CONFIRM: InputSnapshot = { ...NEUTRAL_INPUT, confirm: true }
const SPECIAL: InputSnapshot = { ...NEUTRAL_INPUT, special: true }
const RIGHT: InputSnapshot = { ...NEUTRAL_INPUT, moveX: 1 }
/** Asks for movement and fire at once — for asserting that a pause refuses both. */
const DRIFTING: InputSnapshot = { ...NEUTRAL_INPUT, moveX: 1, moveY: -1, fire: true }

// --- content fixtures -------------------------------------------------------

function item(id: string, over: Partial<ItemDef> = {}): ItemDef {
  return {
    id,
    name: id,
    tier: 'common',
    tags: ['weapon'],
    mechanism: `${id} does a thing.`,
    ...over,
  }
}

function content(items: readonly ItemDef[], interactions: readonly InteractionDef[] = []): RunContent {
  return { items: Object.fromEntries(items.map((def) => [def.id, def])), interactions }
}

/**
 * A target with fabricated numbers, spawned from a real def id.
 *
 * The def id has to be one the World can resolve — an enemy whose def is unknown
 * is killed on sight by `updateEnemies` — so the instance is built from the hauler
 * and then has every number under test overwritten. A hauler rebalance therefore
 * cannot move an assertion in this file. The hauler is the base because it is
 * unarmed and has no death burst: nothing it does can interfere with a measurement.
 *
 * `contactDamage` is zeroed so a target that drifts into the hull cannot end the
 * window with a ram.
 */
/**
 * Distinct identity per fabricated target.
 *
 * `uid` is what stops a piercing round from re-hitting one enemy, so a factory that
 * handed out a single uid made every target look like the same enemy and pierce
 * silently stopped after the first. Local to the test file: the real sequence is
 * owned by the Spawner.
 */
let nextTestUid = 1000

function target(over: {
  x: number
  y: number
  hp?: number
  radius?: number
  scrap?: number
}): EnemyInstance {
  const e = createEnemy(ENEMIES['hauler'] as EnemyDef, over.x, over.y, ++nextTestUid)
  e.hp = over.hp ?? 1000
  e.maxHp = e.hp
  e.radius = over.radius ?? 10
  e.scrap = over.scrap ?? 0
  e.contactDamage = 0
  return e
}

// --- driving a world --------------------------------------------------------

/**
 * Advance one tick with exactly `targets` on the playfield and no enemy fire in
 * the air.
 *
 * Sweeping *before* the tick rather than after means nothing the wave script
 * released can ever move, shoot, or be hit. Without that, every measurement here
 * would silently include hitstop ticks from an incidental kill and hull damage
 * from an incidental skiff — neither of which is the subject of any test in this
 * file, and both of which vary with the seed.
 */
function tickAgainst(world: World, input: InputSnapshot, targets: readonly EnemyInstance[]): void {
  world.enemies.length = 0
  for (const t of targets) if (t.alive) world.enemies.push(t)
  world.enemyBullets.length = 0
  world.tick(input)
}

/** Advance one tick on a swept playfield. */
function tickClear(world: World, input: InputSnapshot): void {
  tickAgainst(world, input, [])
}

/**
 * Let the weapon reach full charge, so a shot count over a fixed window is exact
 * rather than off by one depending on where the cadence happened to be.
 */
function settle(world: World, targets: readonly EnemyInstance[] = []): void {
  for (let i = 0; i < 16; i++) tickAgainst(world, IDLE, targets)
}

/** Tick until the run stops for a reward. Returns it. */
function openNextChoice(world: World): PendingChoice {
  for (let i = 0; i < 12000; i++) {
    tickClear(world, IDLE)
    const choice = world.pendingChoice
    if (choice !== null) return choice
  }
  throw new Error('no reward opened')
}

/**
 * Decline the open choice.
 *
 * Two ticks, not one: the cursor treats every button as already-held when a choice
 * opens, so the release comes first and the press second.
 */
function skipChoice(world: World): void {
  tickClear(world, IDLE)
  tickClear(world, SPECIAL)
}

/** Confirm whatever the cursor is on. Two ticks, for the same reason. */
function confirmSelection(world: World): void {
  tickClear(world, IDLE)
  tickClear(world, CONFIRM)
}

/** Move the cursor onto `defId` and confirm it. */
function takeOffer(world: World, defId: string): void {
  const choice = world.pendingChoice
  if (choice === null) throw new Error('no choice is open')
  const index = choice.offers.findIndex((o) => o.defId === defId)
  if (index < 0) throw new Error(`${defId} was not offered`)
  for (let step = 0; step < index; step++) {
    tickClear(world, IDLE)
    tickClear(world, RIGHT)
  }
  confirmSelection(world)
}

/** A world holding exactly `def`, taken through the real choice flow. */
function worldHolding(seed: string, def: ItemDef): World {
  const world = new World(seed, content([def]))
  openNextChoice(world)
  takeOffer(world, def.id)
  expect(world.inventory.map((e) => e.defId)).toEqual([def.id])
  return world
}

/**
 * The same world, at the same point in the sector, with the offer declined.
 *
 * The A/B baseline for every "measurably increases" assertion: identical seed,
 * identical content, identical wave script, differing only in whether the item was
 * taken.
 */
function worldDeclining(seed: string, def: ItemDef): World {
  const world = new World(seed, content([def]))
  openNextChoice(world)
  skipChoice(world)
  expect(world.inventory).toHaveLength(0)
  return world
}

/** Shots fired over `ticks` ticks of held trigger on a swept playfield. */
function measureShots(world: World, ticks: number): number {
  settle(world)
  const before = world.stats.shotsFired
  for (let i = 0; i < ticks; i++) tickClear(world, FIRING)
  return world.stats.shotsFired - before
}

/**
 * Fire exactly one round and let it finish its flight.
 *
 * One round rather than a held trigger because piercing, chaining and overkill are
 * all per-projectile rules: with twenty rounds a second in the air, "did this shot
 * hit that enemy twice" is not answerable.
 */
function fireOneRound(
  world: World,
  targets: readonly EnemyInstance[],
  ticks = 120,
): SimEvent[] {
  settle(world, targets)
  world.playerBullets.length = 0
  const shotsBefore = world.stats.shotsFired
  const log: SimEvent[] = []
  tickAgainst(world, FIRING, targets)
  expect(world.stats.shotsFired, 'the window must contain exactly one shot').toBe(shotsBefore + 1)
  log.push(...world.events)
  for (let i = 0; i < ticks; i++) {
    tickAgainst(world, IDLE, targets)
    log.push(...world.events)
  }
  expect(world.stats.shotsFired).toBe(shotsBefore + 1)
  return log
}

function hitsOn(log: readonly SimEvent[]): Array<Extract<SimEvent, { kind: 'enemy-hit' }>> {
  return log.filter((e) => e.kind === 'enemy-hit') as Array<
    Extract<SimEvent, { kind: 'enemy-hit' }>
  >
}

/** Degrees from straight up, which is how a volley's fan is specified. */
function angleFromUp(vx: number, vy: number): number {
  return (Math.atan2(vx, -vy) * 180) / Math.PI
}

// --- pre-item behaviour -----------------------------------------------------


/**
 * Advance to the next choice that OFFERS something, declining work orders.
 *
 * A work order has no offers, so a test that wants to take an item and happens to
 * land on one fails with "not offered" — a schedule-shape assumption, the same
 * class of fragility as hardcoding a shop's wave number.
 */
function openNextOffering(world: World): PendingChoice {
  for (let attempt = 0; attempt < 12; attempt++) {
    const choice = openNextChoice(world)
    if (choice.offers.length > 0) return choice
    skipChoice(world)
  }
  throw new Error('no choice with offers opened — check the reward schedule')
}

describe('an empty inventory reproduces pre-item behaviour', () => {
  it('leaves every resolved stat at its base', () => {
    // The bases mirror the constants the sim used before items existed. If any of
    // them resolved differently at zero items, every recorded replay from M2 would
    // have been invalidated by *adding* the system rather than by using it.
    const world = new World('NOITEMS12345', EMPTY_CONTENT)
    expect(world.inventory).toEqual([])
    expect(world.activeInteractions).toEqual([])
    for (const key of STAT_KEYS) {
      expect(world.resolvedStats[key], key).toBe(STATS[key].base)
    }
  })

  it('reports the fire rate the base interval actually produces', () => {
    // A panel advertising 10 shots/s while the weapon fired 20 has already shipped
    // once in this project. The HUD reads `shotsPerSecond`, so it is asserted
    // against a *counted* number of shots rather than against another formula.
    const world = new World('BASERATE1234', EMPTY_CONTENT)
    expect(world.shotsPerSecond).toBe(20)
    expect(measureShots(world, 300)).toBe(100)
  })

  it('never pauses a run with nothing to offer', () => {
    // Every fixture in tests/replays/ predates items and was recorded against an
    // uninterrupted sector. A choice opening on an empty content table would pause
    // the run, desynchronise the input log, and void the whole regression corpus.
    const world = new World('NOPAUSE12345', EMPTY_CONTENT)
    for (let i = 0; i < 6000 && world.runState === 'active'; i++) {
      world.tick(FIRING)
      expect(world.pendingChoice).toBeNull()
    }
  })

  it('is what the default content argument gives you', () => {
    // `new World(seed)` and `new World(seed, EMPTY_CONTENT)` must be the same run,
    // or the replay corpus and the live game would disagree about the default.
    const bare = new World('DEFAULTARG12')
    const empty = new World('DEFAULTARG12', EMPTY_CONTENT)
    for (let i = 0; i < 400; i++) {
      bare.tick(FIRING)
      empty.tick(FIRING)
    }
    expect(hashWorld(empty)).toBe(hashWorld(bare))
  })
})

// --- stats reaching the weapon ----------------------------------------------

describe('weapon stats reach the weapon', () => {
  it('a damage item increases the damage every round deals', () => {
    const heavy = item('heavy-round', {
      stats: [{ stat: 'projectileDamage', kind: 'add', value: 6 }],
    })
    const armed = worldHolding('DAMAGEITEM12', heavy)
    const bare = worldDeclining('DAMAGEITEM12', heavy)

    const big = target({ x: armed.hull.x, y: 300, hp: 4000 })
    const small = target({ x: bare.hull.x, y: 300, hp: 4000 })
    const armedHits: SimEvent[] = []
    const bareHits: SimEvent[] = []
    for (let i = 0; i < 200; i++) {
      tickAgainst(armed, FIRING, [big])
      armedHits.push(...armed.events)
      tickAgainst(bare, FIRING, [small])
      bareHits.push(...bare.events)
    }

    // Per hit, so this measures the round rather than the rate: base 4, +6 = 10.
    expect(armed.resolvedStats['projectileDamage']).toBe(10)
    expect(hitsOn(armedHits).length).toBeGreaterThan(10)
    for (const hit of hitsOn(armedHits)) expect(hit.damage).toBe(10)
    for (const hit of hitsOn(bareHits)) expect(hit.damage).toBe(4)

    const dealtWithItem = big.maxHp - big.hp
    const dealtWithout = small.maxHp - small.hp
    expect(dealtWithout).toBeGreaterThan(0)
    expect(dealtWithItem).toBeGreaterThan(dealtWithout)
    // Every point of it is accounted for by the rounds that landed, which is the
    // check that the stat reached the projectile rather than something else moving.
    expect(dealtWithItem).toBe(armed.stats.hits * 10)
    expect(dealtWithout).toBe(bare.stats.hits * 4)
    // NOTE the armed world fires *fewer* rounds over the same window, not more: a
    // 10-damage hit earns a tick of hitstop where a 4-damage hit earns none, so the
    // damage item buys impact as well as damage. Asserting equal shot counts here
    // would be asserting that hitstop does not scale with damage.
    expect(armed.stats.shotsFired).toBeLessThan(bare.stats.shotsFired)
  })

  it('a fire-rate item increases shots fired over a fixed window', () => {
    // A whole-tick reduction: 3 ticks to 2 is 20 shots/s to 30. Fractional rate
    // changes are the subject of the block below.
    const relay = item('feed', { stats: [{ stat: 'fireIntervalTicks', kind: 'add', value: -1 }] })
    const fast = worldHolding('FIRERATE1234', relay)
    const slow = worldDeclining('FIRERATE1234', relay)

    expect(fast.resolvedStats['fireIntervalTicks']).toBe(2)
    expect(fast.shotsPerSecond).toBe(30)
    expect(measureShots(fast, 300)).toBe(150)
    expect(measureShots(slow, 300)).toBe(100)
  })

  it('holds its cadence over a long window without drifting', () => {
    // The accumulator subtracts the interval rather than resetting to zero, so the
    // shot-to-shot period must be exactly the interval for the whole window — not
    // the interval plus a tick that accumulates into a visible rate loss.
    const relay = item('feed', { stats: [{ stat: 'fireIntervalTicks', kind: 'add', value: -1 }] })
    const world = worldHolding('NODRIFT12345', relay)
    settle(world)

    const shotTicks: number[] = []
    for (let i = 0; i < 1200; i++) {
      tickClear(world, FIRING)
      if (world.events.some((e) => e.kind === 'player-shot')) shotTicks.push(world.stats.tick)
    }
    expect(shotTicks.length).toBe(600)
    for (let i = 1; i < shotTicks.length; i++) {
      expect((shotTicks[i] as number) - (shotTicks[i - 1] as number), `gap ${i}`).toBe(2)
    }
  })

  it('is ready on the first tick a trigger is pulled', () => {
    // The accumulator starts full on purpose. Starting it at zero made the weapon
    // spend three ticks charging its very first shot, which reads as input lag on
    // the first thing a player ever does.
    const world = new World('FIRSTTICK123', EMPTY_CONTENT)
    world.tick(FIRING)
    expect(world.stats.tick).toBe(1)
    expect(world.stats.shotsFired).toBe(1)
    expect(world.playerBullets).toHaveLength(1)
    expect(world.events.some((e) => e.kind === 'player-shot')).toBe(true)
  })

  it('does not bank a burst while the trigger is released', () => {
    // Ten seconds of not shooting must not come out at once on the next press, or
    // tapping the trigger would out-damage holding it.
    const world = new World('NOBANKING123', EMPTY_CONTENT)
    for (let i = 0; i < 600; i++) tickClear(world, IDLE)
    expect(world.stats.shotsFired).toBe(0)
    tickClear(world, FIRING)
    expect(world.stats.shotsFired).toBe(1)
  })
})

/**
 * FRACTIONAL FIRE INTERVALS.
 *
 * `fireIntervalTicks` has a base of 3, so an integer cooldown cannot express a
 * percentage rate change at all — 3/1.18 is 2.54, which rounds straight back to 3.
 * The fractional accumulator in `world.ts` exists specifically to solve that, and
 * its header says so.
 *
 * It does not currently work. See the KNOWN BUG below.
 */
describe('fractional fire intervals', () => {
  const HALF_TICK = item('half-tick', {
    stats: [{ stat: 'fireIntervalTicks', kind: 'add', value: -0.5 }],
  })

  it('resolves a fractional interval and advertises a fractional rate', () => {
    // The stat table does not quantise: 3 - 0.5 = 2.5 ticks, and the HUD is told
    // 24 shots/s. Whether the weapon delivers it is the next test.
    const world = worldHolding('FRACSTAT1234', HALF_TICK)
    expect(world.resolvedStats['fireIntervalTicks']).toBe(2.5)
    expect(world.shotsPerSecond).toBeCloseTo(24, 6)
  })

  /**
   * FIXED (was a real bug) — a fractional fire interval fires at ceil(interval), so every
   * fractional rate change below the next whole tick is a no-op.
   *
   * `World.updateWeapon` caps the accumulator with
   * `Math.min(this.fireAccumulator + 1, interval)`. Because a shot only fires when
   * the accumulator has reached `interval`, and the cap means it can never exceed
   * it, `this.fireAccumulator -= interval` always lands on exactly 0 — so the
   * remainder the comment says "carries" is discarded on every single shot. The
   * effective period is `ceil(interval)`: 2.5 fires every 3 ticks (20/s, not 24/s),
   * 2.54 fires every 3 ticks, 1.18 fires every 2 ticks (30/s, not 50.8/s).
   *
   * This is reachable in shipped content and not only in a test. `Adaptive
   * Requisition` grants `fireRateWindow` bonus 0.18, which `currentFireInterval`
   * turns into 3/1.18 = 2.542 ticks — so the item is INERT, which is precisely the
   * failure `src/content/items.ts` documents as the reason `mul` is banned on this
   * stat. The next test pins that consequence directly.
   *
   * The HUD is wrong at the same time: `shotsPerSecond` reports 24 while the weapon
   * fires 20. That is the "panel advertising a fire rate the weapon does not have"
   * bug this project has already shipped once.
   *
   * A fix has to stop capping away the remainder — for example, only clamp the
   * accumulator on a tick where the trigger is NOT held (the cap exists to stop a
   * released trigger banking a burst, and a held trigger cannot bank one because it
   * fires immediately). When it is fixed this test starts failing; change `it.fails`
   * to `it`.
   */
  it('regression: a fractional interval should produce its fractional average rate', () => {
    const world = worldHolding('FRACRATE1234', HALF_TICK)
    const ticks = 600
    const shots = measureShots(world, ticks)

    // 600 ticks at 2.5 ticks/shot is 240 shots. The current code fires 200.
    expect(shots).toBe(240)
    // And the rate must not drift over the window: the same count in each half.
    const first = shots
    const second = measureShots(world, ticks)
    expect(second).toBe(first)
    // The panel and the weapon must agree, whatever the number is.
    expect((shots / ticks) * TICK_HZ).toBeCloseTo(world.shotsPerSecond, 6)
  })

  /**
   * KNOWN BUG (same root cause, this is the play-reachable form).
   *
   * A `fireRateWindow` bonus is applied as `base / (1 + bonus)`, which is fractional
   * for every bonus that is not exactly 0.5 or 2. With the accumulator bug the
   * window changes nothing at all, so the item costs a pick and does nothing —
   * while `shotsPerSecond` tells the player it is working.
   */
  it('regression: a fire-rate window should actually fire faster', () => {
    const surge = item('surge', {
      effects: [
        { kind: 'fireRateWindow', on: 'onScrapCollected', bonus: 0.18, durationTicks: 1800 },
      ],
    })
    const world = worldHolding('FIREWINDOW12', surge)

    // Open the window by collecting scrap, which only a kill can do.
    const prey = target({ x: world.hull.x, y: 320, hp: 4, scrap: 1 })
    fireOneRound(world, [prey], 60)
    expect(world.stats.kills).toBe(1)
    expect(world.stats.scrap).toBe(1)
    // The window is open, and the panel says the weapon is faster.
    expect(world.shotsPerSecond).toBeGreaterThan(20)

    const shots = measureShots(world, 600)
    expect((shots / 600) * TICK_HZ).toBeCloseTo(world.shotsPerSecond, 1)
  })
})

// --- split shot -------------------------------------------------------------

describe('splitShot', () => {
  function volley(world: World): Array<{ angle: number; vx: number; vy: number }> {
    settle(world)
    world.playerBullets.length = 0
    tickClear(world, FIRING)
    return world.playerBullets.map((b) => ({
      angle: angleFromUp(b.vx, b.vy),
      vx: b.vx,
      vy: b.vy,
    }))
  }

  it('adds projectiles to the volley and keeps the centre shot dead ahead', () => {
    // Taking a split item must never *remove* the shot the player was already
    // aiming. An even fan with no centre makes the weapon feel worse at the exact
    // moment it is upgraded.
    const split = item('split', {
      effects: [{ kind: 'splitShot', on: 'onFire', count: 2, spreadDegrees: 24 }],
    })
    const world = worldHolding('SPLITSHOT123', split)
    const shots = volley(world)

    expect(shots).toHaveLength(3)
    const centre = shots.filter((s) => s.angle === 0)
    expect(centre).toHaveLength(1)
    expect((centre[0] as { vx: number }).vx).toBe(0)
    expect((centre[0] as { vy: number }).vy).toBeLessThan(0)
    // One volley, not three: the cadence counts trigger pulls.
    expect(world.stats.shotsFired).toBeGreaterThan(0)
    expect(world.events.filter((e) => e.kind === 'player-shot')).toHaveLength(1)
  })

  it('fans symmetrically for an even number of extra shots', () => {
    for (const extra of [2, 4]) {
      const split = item('split', {
        effects: [{ kind: 'splitShot', on: 'onFire', count: extra, spreadDegrees: 24 }],
      })
      const world = worldHolding(`SPLITEVEN${extra}12`, split)
      const angles = volley(world)
        .map((s) => s.angle)
        .sort((a, b) => a - b)

      expect(angles).toHaveLength(extra + 1)
      // Mirror image of itself: every angle has its negation, so the fan is centred
      // on the aim line.
      const mirrored = angles.map((a) => -a).sort((a, b) => a - b)
      for (let i = 0; i < angles.length; i++) {
        expect(angles[i] as number, `angle ${i} of ${extra}`).toBeCloseTo(mirrored[i] as number, 9)
      }
      // And the arc spans the width content asked for.
      expect((angles[angles.length - 1] as number) - (angles[0] as number)).toBeCloseTo(24, 6)
    }
  })

  /**
   * FIXED (was a real bug) — the fan leans left whenever the number of extra shots is odd.
   *
   * `volleyAngles` alternates outward from the centre (-1, +1, -2, +2, ...), which
   * is symmetrical only when the extra count is even. With one extra shot it
   * returns `[0, -spread]`: the projectile the player just paid for goes entirely
   * to the LEFT, a full spread away from the aim line, and nothing balances it. At
   * three extras it returns `[0, -s, +s, -2s]`, whose outermost shot is 2s from
   * centre while the far side reaches only s.
   *
   * The docstring on `volleyAngles` claims the fan "stays symmetrical at every
   * count, including even ones", which is the opposite of what it does.
   *
   * Note that a centred fan and a symmetrical fan are mutually exclusive for an
   * even *total* count, so this cannot be fixed by reordering the angles: it needs a
   * decision. Either extras are added in symmetrical pairs (a `count` of 1 becomes
   * 2), or an odd extra count drops the centre shot and fans evenly, or the item is
   * declared to be a deliberately asymmetric weapon and the comment is corrected.
   * `src/content/items.ts` currently ships odd split counts.
   *
   * When it is fixed this test starts failing; change `it.fails` to `it` and fold
   * the counts into the symmetry test above.
   */
  it('regression: an odd number of extra shots should also fan symmetrically', () => {
    for (const extra of [1, 3]) {
      const split = item('split', {
        effects: [{ kind: 'splitShot', on: 'onFire', count: extra, spreadDegrees: 24 }],
      })
      const world = worldHolding(`SPLITODD${extra}123`, split)
      const angles = volley(world)
        .map((s) => s.angle)
        .sort((a, b) => a - b)

      expect(angles).toHaveLength(extra + 1)
      const mirrored = angles.map((a) => -a).sort((a, b) => a - b)
      for (let i = 0; i < angles.length; i++) {
        expect(angles[i] as number, `angle ${i} of ${extra}`).toBeCloseTo(mirrored[i] as number, 9)
      }
    }
  })

  it('folds projectilesPerShot and splitShot into one fan', () => {
    // One is a stat (so it folds and clamps) and the other is an effect (so it
    // stacks). Both feed the same volley, and a build with both must not fire two
    // separate fans.
    const wide = item('wide', {
      stats: [{ stat: 'projectilesPerShot', kind: 'add', value: 2 }],
      effects: [{ kind: 'splitShot', on: 'onFire', count: 2, spreadDegrees: 24 }],
    })
    const world = worldHolding('BOTHFANS1234', wide)
    // 1 base + 2 from the stat + 2 from the effect = 5 projectiles, one volley.
    expect(volley(world)).toHaveLength(5)
    expect(world.events.filter((e) => e.kind === 'player-shot')).toHaveLength(1)
  })

  it('uses the default spread when content gives no angle', () => {
    const split = item('split', { effects: [{ kind: 'splitShot', on: 'onFire', count: 2 }] })
    const world = worldHolding('DEFSPREAD123', split)
    const angles = volley(world).map((s) => s.angle)
    // Not all stacked on top of each other, which is what a zero spread would give:
    // three projectiles occupying one line is three times the cost for no benefit.
    expect(new Set(angles.map((a) => a.toFixed(6))).size).toBe(3)
  })
})

// --- piercing ---------------------------------------------------------------

describe('pierce', () => {
  it('carries a round through several distinct enemies', () => {
    const pierce = item('pierce', {
      effects: [{ kind: 'pierce', on: 'onProjectileHit', count: 8 }],
    })
    const world = worldHolding('PIERCEMANY12', pierce)
    const column = [
      target({ x: world.hull.x, y: 480, hp: 1000 }),
      target({ x: world.hull.x, y: 380, hp: 1000 }),
      target({ x: world.hull.x, y: 280, hp: 1000 }),
    ]
    fireOneRound(world, column)

    // Every enemy in the round's path took damage from that one round.
    for (const [i, e] of column.entries()) {
      expect(e.maxHp - e.hp, `target ${i}`).toBeGreaterThan(0)
    }
  })

  it('stops at the first enemy without a pierce item', () => {
    // Without this the test above proves nothing: a non-piercing round must be
    // spent on the thing it hit.
    const world = new World('PIERCENONE12', EMPTY_CONTENT)
    const column = [
      target({ x: world.hull.x, y: 480, hp: 1000 }),
      target({ x: world.hull.x, y: 380, hp: 1000 }),
    ]
    fireOneRound(world, column)
    expect((column[0] as EnemyInstance).hp).toBeLessThan(1000)
    expect((column[1] as EnemyInstance).hp).toBe(1000)
  })

  it('bounds a round to pierceCount + 1 hits in total', () => {
    // The counter is what stops a piercing round becoming a free screen clear, so the
    // ceiling is asserted as a count of hits rather than as "the third enemy
    // survived" — which would also be true of a round that expired early.
    const pierce = item('pierce', {
      effects: [{ kind: 'pierce', on: 'onProjectileHit', count: 1 }],
    })
    const world = worldHolding('PIERCEONE123', pierce)
    const column = [
      target({ x: world.hull.x, y: 500, hp: 1000, radius: 4 }),
      target({ x: world.hull.x, y: 400, hp: 1000, radius: 4 }),
      target({ x: world.hull.x, y: 300, hp: 1000, radius: 4 }),
    ]
    const log = fireOneRound(world, column)

    expect(hitsOn(log).length).toBeGreaterThan(0)
    expect(hitsOn(log).length).toBeLessThanOrEqual(2)
    // The furthest enemy is out of reach either way.
    expect((column[2] as EnemyInstance).hp).toBe(1000)
  })

  /**
   * FIXED (was a real bug) — a piercing round hits the same enemy on every tick it is inside it.
   *
   * `entities.ts` documents `Bullet.pierceRemaining` as existing so that "a piercing
   * round must not be able to hit the same enemy repeatedly — a shot resting inside
   * a large hauler would otherwise tick it down every frame", and `world.ts` repeats
   * the claim. The counter does not do that. It bounds the *total* number of hits a
   * round may land, but nothing records *which* enemies it already hit, so a round
   * crossing one large target hits it once per tick until the counter runs out.
   *
   * At 620 units/second a round covers 10.3 units per tick, so any target whose
   * radius plus the bullet's exceeds that is hit more than once. A radius-30 target
   * with `pierce: 3` takes four hits — 4x the damage — from a single round, and the
   * bigger the enemy the more the item is worth against it, which is backwards.
   *
   * The fix is to remember the enemies a round has already hit (a small array on the
   * bullet, or an id per enemy), not to raise or lower the count.
   *
   * When it is fixed this test starts failing; change `it.fails` to `it`.
   */
  it('regression: one round should never hit the same enemy twice', () => {
    const pierce = item('pierce', {
      effects: [{ kind: 'pierce', on: 'onProjectileHit', count: 3 }],
    })
    const world = worldHolding('PIERCETWICE1', pierce)
    const wide = target({ x: world.hull.x, y: 300, hp: 4000, radius: 30 })
    const log = fireOneRound(world, [wide])

    expect(hitsOn(log)).toHaveLength(1)
    expect(wide.maxHp - wide.hp).toBe(world.resolvedStats['projectileDamage'])
  })
})

// --- chaining ---------------------------------------------------------------

describe('chainOnHit', () => {
  const chain = item('chain', {
    effects: [
      { kind: 'chainOnHit', on: 'onProjectileHit', count: 1, radius: 60, fraction: 0.5 },
    ],
  })

  it('arcs to a nearby enemy for a fraction of the damage, and skips the one it hit', () => {
    const world = worldHolding('CHAINARC1234', chain)
    const damage = world.resolvedStats['projectileDamage'] as number
    const struck = target({ x: world.hull.x, y: 300, hp: 1000 })
    const near = target({ x: world.hull.x + 40, y: 300, hp: 1000 })
    fireOneRound(world, [struck, near])

    // The original target takes the round's damage once — not the round plus its own
    // arc, which is what failing to skip the source index would produce.
    expect(struck.maxHp - struck.hp).toBe(damage)
    expect(near.maxHp - near.hp).toBe(damage * 0.5)
  })

  it('respects its radius', () => {
    const world = worldHolding('CHAINRADIUS1', chain)
    const struck = target({ x: world.hull.x, y: 300, hp: 1000 })
    // 80 units away, outside the 60-unit arc. Same row, so only the distance differs.
    const far = target({ x: world.hull.x + 80, y: 300, hp: 1000 })
    fireOneRound(world, [struck, far])

    expect(struck.hp).toBeLessThan(1000)
    expect(far.hp).toBe(1000)
  })

  it('respects its count', () => {
    // Two candidates in range, one arc: exactly one of them may be damaged. A chain
    // that ignored the count would clear the screen from a single hit.
    const world = worldHolding('CHAINCOUNT12', chain)
    const struck = target({ x: world.hull.x, y: 300, hp: 1000 })
    const a = target({ x: world.hull.x + 30, y: 300, hp: 1000 })
    const b = target({ x: world.hull.x - 30, y: 300, hp: 1000 })
    fireOneRound(world, [struck, a, b])

    const arced = [a, b].filter((e) => e.hp < 1000)
    expect(arced).toHaveLength(1)
  })

  it('never chains from a chain', () => {
    // A recursive version turns one shot into a screen clear and makes the frame
    // cost of a hit unbounded. `far` is within the arc's radius of `near` but well
    // outside it of `struck`, so it can only be reached by a second hop.
    const world = worldHolding('CHAINRECURSE', chain)
    const struck = target({ x: world.hull.x, y: 300, hp: 1000 })
    const near = target({ x: world.hull.x + 40, y: 300, hp: 1000 })
    const far = target({ x: world.hull.x + 90, y: 300, hp: 1000 })
    fireOneRound(world, [struck, near, far])

    expect(struck.hp).toBeLessThan(1000)
    expect(near.hp).toBeLessThan(1000)
    expect(far.hp).toBe(1000)
  })

  it('reports the arc as its own hit so presentation can draw it', () => {
    // The player has to be able to see that a second enemy was damaged by something
    // no projectile touched, or the item is invisible while it works.
    const world = worldHolding('CHAINEVENT12', chain)
    const struck = target({ x: world.hull.x, y: 300, hp: 1000 })
    const near = target({ x: world.hull.x + 40, y: 300, hp: 1000 })
    const log = fireOneRound(world, [struck, near])

    const damages = hitsOn(log).map((h) => h.damage)
    const full = world.resolvedStats['projectileDamage'] as number
    expect(damages).toContain(full)
    expect(damages).toContain(full * 0.5)
  })
})

// --- the economy ------------------------------------------------------------

describe('scrapOnOverkill', () => {
  /** 50 damage a round, and every point past a kill converts to scrap. */
  const cannon = item('cannon', {
    stats: [{ stat: 'projectileDamage', kind: 'add', value: 46 }],
    effects: [{ kind: 'scrapOnOverkill', on: 'onProjectileHit', fraction: 1 }],
  })

  it('credits only the damage beyond what the kill needed', () => {
    const world = worldHolding('OVERKILL1234', cannon)
    expect(world.resolvedStats['projectileDamage']).toBe(50)
    // Scrap awarded for the corpse itself is zeroed, so what is left is the overkill.
    const prey = target({ x: world.hull.x, y: 320, hp: 20, scrap: 0 })
    fireOneRound(world, [prey], 60)

    expect(world.stats.kills).toBe(1)
    expect(world.stats.scrap).toBe(30)
  })

  it('measures overkill against the hp that was left, not the maximum', () => {
    // The whole point of the item is that it rewards *wasted* damage. If it measured
    // against maxHp, softening a target first would pay out as if the round had done
    // all the work.
    const world = worldHolding('OVERKILLREM1', cannon)
    const tough = target({ x: world.hull.x, y: 320, hp: 60, scrap: 0 })
    fireOneRound(world, [tough], 40)
    // First round: 50 into 60 hp. Nothing wasted, nothing paid.
    expect(tough.hp).toBe(10)
    expect(world.stats.scrap).toBe(0)

    fireOneRound(world, [tough], 40)
    // Second round: 50 into the 10 that was left, so 40 was wasted.
    expect(world.stats.kills).toBe(1)
    expect(world.stats.scrap).toBe(40)
  })

  it('pays nothing for a round that killed with nothing to spare', () => {
    const world = worldHolding('OVERKILLEXAC', cannon)
    const exact = target({ x: world.hull.x, y: 320, hp: 50, scrap: 0 })
    fireOneRound(world, [exact], 60)
    expect(world.stats.kills).toBe(1)
    expect(world.stats.scrap).toBe(0)
  })

  it('pays nothing without the item', () => {
    const world = new World('OVERKILLNONE', EMPTY_CONTENT)
    const prey = target({ x: world.hull.x, y: 320, hp: 1, scrap: 0 })
    fireOneRound(world, [prey], 60)
    expect(world.stats.kills).toBe(1)
    expect(world.stats.scrap).toBe(0)
  })
})

describe('scrapMultiplier', () => {
  it('scales every scrap award', () => {
    // `scrapMultiplier` had no consumer at first, which made the economy item
    // silently inert. A stat nothing reads is worse than a missing stat, because the
    // item ships and does nothing.
    const broker = item('broker', {
      stats: [{ stat: 'scrapMultiplier', kind: 'add', value: 1 }],
    })
    const rich = worldHolding('SCRAPMULT123', broker)
    const poor = worldDeclining('SCRAPMULT123', broker)
    expect(rich.resolvedStats['scrapMultiplier']).toBe(2)

    fireOneRound(rich, [target({ x: rich.hull.x, y: 320, hp: 4, scrap: 5 })], 60)
    fireOneRound(poor, [target({ x: poor.hull.x, y: 320, hp: 4, scrap: 5 })], 60)

    expect(poor.stats.scrap).toBe(5)
    expect(rich.stats.scrap).toBe(10)
  })
})

describe('repairOnKill', () => {
  const patch = item('patch', {
    effects: [{ kind: 'repairOnKill', on: 'onEnemyKilled', amount: 10, chance: 1 }],
  })

  it('restores integrity on a kill', () => {
    const world = worldHolding('REPAIRKILL12', patch)
    world.hull.integrity = 50
    fireOneRound(world, [target({ x: world.hull.x, y: 320, hp: 4 })], 60)
    expect(world.stats.kills).toBe(1)
    expect(world.hull.integrity).toBe(60)
  })

  it('never repairs past the maximum', () => {
    // Otherwise integrity creeps above the bar the panel draws, and the readout
    // stops describing the ship.
    const world = worldHolding('REPAIRCAP123', patch)
    world.hull.integrity = world.hull.maxIntegrity - 2
    for (let round = 0; round < 4; round++) {
      fireOneRound(world, [target({ x: world.hull.x, y: 320, hp: 4 })], 60)
      expect(world.hull.integrity).toBeLessThanOrEqual(world.hull.maxIntegrity)
    }
    expect(world.stats.kills).toBe(4)
    expect(world.hull.integrity).toBe(world.hull.maxIntegrity)
  })

  it('repairs nothing without the item', () => {
    const world = new World('REPAIRNONE12', EMPTY_CONTENT)
    world.hull.integrity = 50
    fireOneRound(world, [target({ x: world.hull.x, y: 320, hp: 4 })], 60)
    expect(world.stats.kills).toBe(1)
    expect(world.hull.integrity).toBe(50)
  })
})

// --- defence maximums -------------------------------------------------------

describe('raising a maximum grants the difference, not a refill', () => {
  it('adds the delta to a damaged hull', () => {
    // +20 max integrity on a hull at 30/100 must leave it at 50/120, not 120/120,
    // or every defence item doubles as a full repair and the hardest decision in the
    // game (take the heal or take the upgrade) stops existing.
    const plating = item('plating', {
      stats: [{ stat: 'maxIntegrity', kind: 'add', value: 20 }],
    })
    const world = new World('MAXINTEG1234', content([plating]))
    openNextChoice(world)
    world.hull.integrity = 30
    takeOffer(world, 'plating')

    expect(world.hull.maxIntegrity).toBe(120)
    expect(world.hull.integrity).toBe(50)
    expect(world.hull.integrity).toBeLessThan(world.hull.maxIntegrity)
  })

  it('adds the delta to a spent shield', () => {
    const screen = item('screen', { stats: [{ stat: 'maxShield', kind: 'add', value: 20 }] })
    const world = new World('MAXSHIELD123', content([screen]))
    openNextChoice(world)
    world.hull.shield = 10
    takeOffer(world, 'screen')

    expect(world.hull.maxShield).toBe(60)
    expect(world.hull.shield).toBe(30)
  })

  it('grants the difference again on a second stack, and nothing more', () => {
    const plating = item('plating', {
      stats: [{ stat: 'maxIntegrity', kind: 'add', value: 20 }],
    })
    const world = new World('MAXSTACK1234', content([plating]))
    openNextChoice(world)
    world.hull.integrity = 30
    takeOffer(world, 'plating')

    // Advance to a shop by kind rather than assuming the next reward is one — the
    // schedule's ordering is content, and hardcoding a position here made this test
    // fail when the first shop moved from wave 8 to 13.
    let shop = openNextChoice(world)
    while (shop.kind !== 'shop') {
      skipChoice(world)
      shop = openNextChoice(world)
    }
    world.stats.scrap = 10_000
    takeOffer(world, 'plating')

    expect(world.inventory[0]?.count).toBe(2)
    expect(world.hull.maxIntegrity).toBe(140)
    expect(world.hull.integrity).toBe(70)
  })
})

// --- the pause --------------------------------------------------------------

/**
 * A choice PAUSES the run.
 *
 * An item choice is a decision, not a reflex test: reading three cards while
 * lancers dive at you is not a choice, it is a punishment for engaging with the
 * system. But the pause has to spend real ticks, because a recorded input log is
 * one byte per tick and a paused tick that did not count would desynchronise every
 * replay from the first reward onward.
 */
describe('an open choice pauses the run', () => {
  /** Everything a paused tick must leave untouched. */
  function frozenState(world: World): string {
    return JSON.stringify({
      hull: world.hull,
      playerBullets: world.playerBullets,
      enemyBullets: world.enemyBullets,
      // hitFlashTicks is a render countdown and ages on every tick by design.
      enemies: world.enemies.map((e) => ({ ...e, hitFlashTicks: 0 })),
      waveIndex: world.currentWaveIndex,
      shotsFired: world.stats.shotsFired,
      hits: world.stats.hits,
      kills: world.stats.kills,
      scrap: world.stats.scrap,
      damageTaken: world.stats.damageTaken,
      runState: world.runState,
    })
  }

  it('advances ticks while nothing moves, spawns, or fires', () => {
    // Deliberately NOT swept: the point is that a live playfield holds still.
    const world = new World('PAUSERUN1234', content([item('pause-probe')]))
    for (let i = 0; i < 12000 && world.pendingChoice === null; i++) world.tick(FIRING)
    expect(world.pendingChoice).not.toBeNull()
    expect(world.enemies.length).toBeGreaterThan(0)

    const before = frozenState(world)
    const tickBefore = world.stats.tick
    const bulletsBefore = world.playerBullets.length

    // Movement only, for two seconds. This used to hold fire as well, on the premise
    // that a held trigger could never confirm — which was the soft-freeze bug: it
    // meant a player holding fire got an unresponsive card. A held trigger now
    // confirms after a short dwell, so holding it here would end the choice and this
    // test would be measuring a resumed run rather than a paused one.
    for (let i = 0; i < 120; i++) {
      world.tick(DRIFTING_NO_FIRE)
      expect(frozenState(world), `paused tick ${i + 1}`).toEqual(before)
      expect(world.pendingChoice).not.toBeNull()
    }

    expect(world.stats.tick).toBe(tickBefore + 120)
    expect(world.playerBullets.length).toBe(bulletsBefore)
  })

  it('resumes the moment the choice is resolved', () => {
    const world = new World('PAUSERESUME1', content([item('pause-probe')]))
    openNextChoice(world)
    takeOffer(world, 'pause-probe')
    expect(world.pendingChoice).toBeNull()

    const x = world.hull.x
    tickClear(world, RIGHT)
    expect(world.hull.x).toBeGreaterThan(x)
  })

  /**
   * FIXED (was a real bug) — cosmetic countdowns age twice per tick while a choice is open.
   *
   * `World.tick` calls `advanceCosmetic()` once at the top of every tick, and then
   * the choice branch calls it a *second* time before returning. So explosions,
   * enemy hit flashes and the shake impulse all run at double speed for as long as a
   * reward screen is up: an 18-tick explosion lasts 9 ticks, and shake decays at
   * 0.86^2 per tick instead of 0.86.
   *
   * The `tick` docstring is explicit that cosmetic countdowns age once per tick,
   * alongside `stats.tick` advancing and the event list clearing. Nothing documents
   * or wants the second call.
   *
   * The consequences are contained — it is all presentation state, and it is hashed
   * into the cosmetic digest rather than the regression hash — but it is visible on
   * screen behind the card and it makes the cosmetic digest of any run that takes an
   * item depend on a duplicated call rather than on the rule.
   *
   * The fix is to delete the second `this.advanceCosmetic()` in the choice branch.
   * When it is fixed this test starts failing; change `it.fails` to `it`.
   */
  it('regression: a paused tick should age cosmetics once, not twice', () => {
    const world = new World('PAUSECOSMET1', content([item('pause-probe')]))
    openNextChoice(world)

    // Injected rather than earned, so the age is a known number and the assertion
    // is about the countdown rather than about which enemy happened to die.
    world.explosions.push({ x: 10, y: 10, age: 0, lifetime: 600, radius: 8, kind: 'enemy' })
    tickClear(world, IDLE)
    expect(world.explosions[0]?.age).toBe(1)
  })
})

// --- paying for an item -----------------------------------------------------

describe('shop costs', () => {
  /** Reach the first shop, having declined the free reward before it. */
  /**
   * Advance until a shop opens, declining anything else on the way.
   *
   * Skips by KIND rather than assuming a position in the schedule. An earlier
   * version took "the second choice" as the shop, which was true only for one
   * particular ordering of ITEM_CHOICE_WAVES/SHOP_WAVES — moving the first shave
   * from wave 8 to 13 silently turned three shop tests into item tests.
   */
  function openShop(world: World): PendingChoice {
    for (let attempt = 0; attempt < SHOP_WAVES.length + ITEM_CHOICE_WAVES.length + 4; attempt++) {
      const choice = openNextChoice(world)
      if (choice.kind === 'shop') return choice
      skipChoice(world)
    }
    throw new Error('no shop opened — check SHOP_WAVES against the sector script')
  }

  it('deducts the cost when an item is taken', () => {
    const world = new World('SHOPCOST1234', content([item('stock')]))
    const shop = openShop(world)
    const cost = shop.costs[0] as number
    expect(cost).toBeGreaterThan(0)

    world.stats.scrap = cost + 37
    takeOffer(world, 'stock')
    expect(world.inventory.map((e) => e.defId)).toEqual(['stock'])
    expect(world.stats.scrap).toBe(37)
  })

  it('gives a free reward away for nothing', () => {
    // An item wave is not a shop: every cost is zero, and taking one must not be
    // able to reduce scrap the player is saving for the shop.
    const world = new World('FREEREWARD12', content([item('gift')]))
    const free = openNextChoice(world)
    expect(free.kind).toBe('item')
    expect(free.costs).toEqual(free.offers.map(() => 0))

    world.stats.scrap = 0
    takeOffer(world, 'gift')
    expect(world.inventory).toHaveLength(1)
    expect(world.stats.scrap).toBe(0)
  })

  it('refuses an unaffordable pick and leaves the scrap alone', () => {
    // The UI greys the option out; this is the backstop behind it. Silently taking
    // the item would be worse, and silently zeroing the scrap worse still.
    const world = new World('CANTAFFORD12', content([item('stock')]))
    const shop = openShop(world)
    const cost = shop.costs[0] as number
    world.stats.scrap = cost - 1

    takeOffer(world, 'stock')
    expect(world.inventory).toHaveLength(0)
    expect(world.stats.scrap).toBe(cost - 1)
    // And the shop is still open, so the player can decline it or come back to it
    // rather than being left in a run whose reward silently evaporated.
    expect(world.pendingChoice).not.toBeNull()

    // One more scrap is the difference between refused and taken.
    world.stats.scrap = cost
    takeOffer(world, 'stock')
    expect(world.inventory).toHaveLength(1)
    expect(world.stats.scrap).toBe(0)
  })

  it('can be declined outright', () => {
    const world = new World('SHOPDECLINE1', content([item('stock')]))
    openShop(world)
    world.stats.scrap = 10_000
    skipChoice(world)
    expect(world.pendingChoice).toBeNull()
    expect(world.inventory).toHaveLength(0)
    expect(world.stats.scrap).toBe(10_000)
  })
})

// --- one reward per wave ----------------------------------------------------

describe('a wave cannot pay a reward twice', () => {
  it('opens exactly one reward per scheduled wave, in wave order', () => {
    // Waves can be released more than once per tick after a hitstop, and
    // `maybeOpenChoice` runs on every tick rather than only on a wave change — so
    // paying per release, or per tick, would hand out a reward repeatedly. The guard
    // is a set of already-paid wave indices; this is the observable form of it.
    const world = new World('ONEREWARD123', content([item('probe')]))
    const paidAtWave: number[] = []
    for (let i = 0; i < 12000; i++) {
      tickClear(world, IDLE)
      if (world.pendingChoice !== null) {
        paidAtWave.push(world.currentWaveIndex)
        skipChoice(world)
      }
    }

    const scheduled = [...ITEM_CHOICE_WAVES, ...SHOP_WAVES, ...WORK_ORDER_WAVES].sort(
      (a, b) => a - b,
    )
    expect(paidAtWave).toEqual(scheduled)
  })

  it('does not reopen the reward for a wave already paid', () => {
    const world = new World('NOREOPEN1234', content([item('probe')]))
    openNextChoice(world)
    const wave = world.currentWaveIndex
    skipChoice(world)
    expect(world.pendingChoice).toBeNull()

    // Hundreds of ticks still on the same wave. Not one of them may pay again.
    for (let i = 0; i < 300; i++) {
      tickClear(world, IDLE)
      expect(world.pendingChoice, `tick ${i + 1} after the reward`).toBeNull()
    }
    expect(world.currentWaveIndex).toBe(wave)
  })

  it('opens a work order rather than an offer on a work-order wave', () => {
    // A work order has no items in it, so its option count comes from `workOrders`.
    // An offer list would be empty and the choice would be unresolvable.
    const world = new World('WORKORDER123', content([item('probe')]))
    let workOrder: PendingChoice | null = null
    for (let i = 0; i < 12000 && workOrder === null; i++) {
      tickClear(world, IDLE)
      const choice = world.pendingChoice
      if (choice === null) continue
      if (choice.kind === 'work-order') workOrder = choice
      else skipChoice(world)
    }
    expect(workOrder).not.toBeNull()
    expect(workOrder?.offers).toEqual([])
    expect((workOrder?.workOrders ?? []).length).toBeGreaterThan(1)

    // And it can be confirmed, which is what stops the run deadlocking on it.
    confirmSelection(world)
    expect(world.pendingChoice).toBeNull()
  })
})

// --- acquisition order ------------------------------------------------------

describe('acquisition order', () => {
  it('preserves order and keeps the original tick when stacking', () => {
    // Effect dispatch follows acquisition order and is play-affecting, so re-taking
    // an item must not reorder the build's behaviour — a replay that reordered on a
    // stack would desynchronise from the tick it happened.
    const first = item('first', { stats: [{ stat: 'projectileDamage', kind: 'add', value: 1 }] })
    const second = item('second', { stats: [{ stat: 'projectileDamage', kind: 'add', value: 2 }] })
    const world = new World('ACQORDER1234', content([first, second]))

    openNextOffering(world)
    takeOffer(world, 'first')
    const firstTick = world.inventory[0]?.acquiredAtTick as number
    expect(firstTick).toBeGreaterThan(0)

    // The next offering, so the second pick may have to be paid for.
    openNextOffering(world)
    world.stats.scrap = 10_000
    takeOffer(world, 'second')
    const secondTick = world.inventory[1]?.acquiredAtTick as number
    expect(secondTick).toBeGreaterThan(firstTick)

    // Now take `first` again, hundreds of ticks later. Must ask for an *offering*:
    // the third reward in the schedule is a work order, which has nothing to take.
    openNextOffering(world)
    world.stats.scrap = 10_000
    takeOffer(world, 'first')

    expect(world.inventory.map((e) => e.defId)).toEqual(['first', 'second'])
    expect(world.inventory[0]?.count).toBe(2)
    expect(world.inventory[1]?.count).toBe(1)
    // The stack did not move to the end of the list, and did not adopt the tick it
    // was re-taken on.
    expect(world.inventory[0]?.acquiredAtTick).toBe(firstTick)
    expect(world.inventory[1]?.acquiredAtTick).toBe(secondTick)
    // And the stack applied twice: 4 + 1 + 1 + 2.
    expect(world.resolvedStats['projectileDamage']).toBe(8)
  })

  it('activates an interaction as soon as both of its items are held', () => {
    const combo: InteractionDef = {
      id: 'first-second',
      requires: ['first', 'second'],
      text: 'First and Second combine.',
      stats: [{ stat: 'projectileDamage', kind: 'add', value: 10 }],
    }
    const world = new World('INTERACT1234', content([item('first'), item('second')], [combo]))

    openNextChoice(world)
    takeOffer(world, 'first')
    expect(world.activeInteractions).toEqual([])

    openNextChoice(world)
    world.stats.scrap = 10_000
    takeOffer(world, 'second')
    expect(world.activeInteractions).toEqual([{ defId: combo.id, text: combo.text }])
    expect(world.resolvedStats['projectileDamage']).toBe(14)
  })
})

// --- determinism ------------------------------------------------------------

/**
 * Determinism end to end, with items in the loop.
 *
 * Items add three new pieces of state that a replay depends on: the `offers` RNG
 * stream, the inventory (whose *order* is play-affecting), and the choice cursor.
 * A summary comparison — hashes of the hull and the enemies, say — would pass while
 * two runs held different items in a different order, and the divergence would only
 * surface a thousand ticks later.
 *
 * So this serialises the WHOLE world. `JSON.stringify` on a `World` reaches its
 * private fields too: every RNG stream's state, the spawner's schedule cursor, the
 * fractional fire accumulator, the resolved effect totals, and the cursor's
 * edge-detection flags.
 */
describe('determinism with items', () => {
  /**
   * A scripted input log. A fixed function of the tick index rather than a random
   * one, because that is exactly what a recorded replay is.
   *
   * It pulses CONFIRM every seventh tick so a reward choice is actually accepted. It
   * used to pulse `fire` for that, which stopped working the moment cards took their own
   * accept action — and the failure was not subtle: no item was ever taken, the run sat
   * on the first card for the whole 4,000 ticks, and a determinism test compared two
   * identical stalls.
   */
  function scripted(tick: number): InputSnapshot {
    return {
      moveX: (tick % 121 < 60 ? 1 : -1) as Axis,
      moveY: (tick % 37 < 18 ? -1 : 0) as Axis,
      fire: tick % 7 !== 0,
      special: false,
      focus: tick % 53 === 0,
      confirm: tick % 7 === 0,
    }
  }

  function fullState(world: World): string {
    return JSON.stringify(world)
  }

  function play(seed: string, table: RunContent, ticks: number): World {
    const world = new World(seed, table)
    for (let tick = 1; tick <= ticks; tick++) world.tick(scripted(tick))
    return world
  }

  const ITEMS = content(
    [
      item('alpha', { stats: [{ stat: 'projectileDamage', kind: 'add', value: 3 }] }),
      item('bravo', {
        tier: 'rare',
        effects: [{ kind: 'splitShot', on: 'onFire', count: 2, spreadDegrees: 20 }],
      }),
      item('charlie', {
        effects: [{ kind: 'chainOnHit', on: 'onProjectileHit', count: 1, radius: 70, fraction: 0.4 }],
      }),
      item('delta', { stats: [{ stat: 'maxIntegrity', kind: 'add', value: 25 }] }),
      item('echo', { stats: [{ stat: 'scrapMultiplier', kind: 'add', value: 1 }] }),
    ],
    [
      {
        id: 'alpha-bravo',
        requires: ['alpha', 'bravo'],
        text: 'Alpha and Bravo combine.',
        effects: [{ kind: 'pierce', on: 'onProjectileHit', count: 1 }],
      },
    ],
  )

  it('reproduces a full run that takes items, byte for byte', () => {
    const a = play('DETERMINISM1', ITEMS, 4000)
    const b = play('DETERMINISM1', ITEMS, 4000)

    // The assertion is worthless if the run never reached a reward.
    expect(a.inventory.length).toBeGreaterThan(0)
    // Guard against the serialisation quietly degrading to a summary: the private
    // simulation state has to actually be in there.
    const state = fullState(a)
    expect(state).toContain('fireAccumulator')
    expect(state).toContain('rngOffers')
    expect(state).toContain('inventory')

    expect(fullState(b)).toEqual(state)
    expect(hashWorld(b)).toBe(hashWorld(a))
    expect(b.inventory).toEqual(a.inventory)
    expect(b.resolvedStats).toEqual(a.resolvedStats)
    expect(b.activeInteractions).toEqual(a.activeInteractions)
  })

  it('diverges for a different seed', () => {
    // Without this the assertion above is satisfied by a run that does nothing.
    const a = play('DETERMSEEDAA', ITEMS, 4000)
    const b = play('DETERMSEEDZZ', ITEMS, 4000)
    expect(fullState(b)).not.toEqual(fullState(a))
  })

  it('diverges for a different input log', () => {
    const a = new World('DETERMINPUT1', ITEMS)
    const b = new World('DETERMINPUT1', ITEMS)
    for (let tick = 1; tick <= 4000; tick++) {
      a.tick(scripted(tick))
      b.tick(scripted(tick + 1))
    }
    expect(fullState(b)).not.toEqual(fullState(a))
  })

  it('picks the same items from the same seed however the run was played', () => {
    // The offers stream is its own stream, so what a player is *shown* must depend on
    // the seed and the number of rewards reached — not on how much shooting they did
    // on the way there. Two runs that reach the same reward with the same inventory
    // must see the same three cards.
    /**
     * Both runs must SURVIVE to the reward, so both shoot — they differ in movement
     * instead. An earlier version compared a firing run against a completely idle
     * one, which worked only while the first reward sat at wave 4: once it moved to
     * wave 7 the idle pilot was rammed to death first and the comparison was against
     * `undefined`.
     */
    const eager = new World('SAMEOFFERS12', ITEMS)
    const weaving = new World('SAMEOFFERS12', ITEMS)
    for (let i = 0; i < 12000 && eager.pendingChoice === null; i++) eager.tick(FIRING)
    for (let i = 0; i < 12000 && weaving.pendingChoice === null; i++) {
      weaving.tick(i % 40 < 20 ? DRIFTING : FIRING)
    }

    expect(eager.pendingChoice).not.toBeNull()
    expect(weaving.pendingChoice).not.toBeNull()
    expect(weaving.pendingChoice?.offers).toEqual(eager.pendingChoice?.offers)
  })
})
