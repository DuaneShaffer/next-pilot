/**
 * The state hash, audited against what M5 added to the simulation.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT is not a wrong hash — it is a hash that
 * is *too narrow*. A field that steers the next tick and is not hashed makes two
 * divergent runs compare equal, and then the regression corpus goes green while the
 * game is broken. That failure is invisible: every test passes, the fixtures
 * reproduce, and nothing anywhere says the instrument stopped measuring.
 *
 * So every play-affecting field gets a mutation here, and the mutation has to move
 * the digest. `tests/replay.test.ts` owns the golden constant and the corpus; this
 * file owns the question of whether the digest covers the state at all.
 *
 * Worlds are built by hand rather than played, for the same reason the hashing
 * tests in `replay.test.ts` are: hashing is the foundation the corpus stands on, and
 * its tests must keep failing honestly regardless of what state the sim is in.
 */

import { describe, expect, it } from 'vitest'

import { diffDigests, digestWorld, hashWorld } from '../src/meta/snapshot'
import type {
  Bullet,
  EnemyBullet,
  EnemyInstance,
  Hull,
  HazardView,
  PendingChoice,
  RouteOption,
  RunStats,
  SimEvent,
  WorldView,
} from '../src/sim/entities'

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

function hull(overrides: Partial<Hull> = {}): Hull {
  return {
    x: 224,
    y: 610,
    prevX: 224,
    prevY: 610,
    integrity: 100,
    maxIntegrity: 100,
    shield: 40,
    maxShield: 40,
    invulnTicks: 0,
    radius: 7,
    ...overrides,
  }
}

function enemy(overrides: Partial<EnemyInstance> = {}): EnemyInstance {
  return {
    x: 200,
    y: 120,
    prevX: 200,
    prevY: 118,
    uid: 1,
    defId: 'skiff',
    hp: 12,
    maxHp: 12,
    radius: 10,
    shape: 'skiff',
    movement: 'sine',
    elite: false,
    vx: 0,
    vy: 40,
    age: 30,
    telegraphTicks: 0,
    telegraphTotal: 0,
    phase: 'holding',
    fireCooldown: 12,
    contactDamage: 10,
    scrap: 3,
    alive: true,
    hitFlashTicks: 0,
    originX: 200,
    holdY: 180,
    ...overrides,
  }
}

/** A boss mid-fight: phase 1 of a base form, callout still up. */
function bossEnemy(overrides: Partial<EnemyInstance> = {}): EnemyInstance {
  return enemy({
    uid: 9,
    defId: 'repossessor#1',
    hp: 800,
    maxHp: 1700,
    radius: 44,
    shape: 'hauler',
    movement: 'hover',
    elite: true,
    secondary: { cooldown: 40, windup: 0, windupTotal: 0 },
    boss: {
      bossId: 'repossessor',
      name: 'The Repossessor',
      variantId: null,
      phaseIndex: 1,
      phaseDefIds: ['repossessor#0', 'repossessor#1'],
      thresholds: [1, 0.5],
      callouts: ['OPENING', 'SECOND'],
      calloutTicks: 60,
    },
    ...overrides,
  })
}

function hazard(overrides: Partial<HazardView> = {}): HazardView {
  return {
    id: 'grid-sweep',
    name: 'Grid Sweep',
    hazardKind: 'debris',
    description: 'A curtain of debris.',
    phase: 'warning',
    ticksToChange: 33,
    progress: 0.45,
    ...overrides,
  }
}

function route(overrides: Partial<RouteOption> = {}): RouteOption {
  return {
    stageIndex: 1,
    // Display copy, authored by the route builder. Not hashed — see the note on
    // `rewardText` in `hashRun`.
    name: 'The Long Way',
    sectorName: 'The Tally',
    bossName: 'The Bailiff',
    hazards: [{ name: 'Grid Sweep', description: 'A curtain of debris.' }],
    hazardIds: ['grid-sweep'],
    reward: { kind: 'scrap', amount: 180 },
    rewardText: '+180 cr on arrival, and a grid sweep the whole way.',
    ...overrides,
  }
}

function choice(overrides: Partial<PendingChoice> = {}): PendingChoice {
  return {
    kind: 'route',
    offers: [],
    costs: [],
    workOrders: [],
    routes: [route(), route({ stageIndex: 1, hazardIds: [], hazards: [], reward: { kind: 'none' } })],
    ...overrides,
  }
}

function stats(overrides: Partial<RunStats> = {}): RunStats {
  return {
    tick: 900,
    shotsFired: 300,
    hits: 210,
    kills: 14,
    scrap: 42,
    damageTaken: 18,
    waveIndex: 3,
    peakProjectiles: 96,
    bulletsCulled: 88,
    ...overrides,
  }
}

const BULLET: Bullet = { x: 100, y: 200, prevX: 100, prevY: 210, vx: 0, vy: -620, damage: 4, radius: 2, alive: true }
const ENEMY_BULLET: EnemyBullet = {
  x: 150, y: 300, prevX: 150, prevY: 295, vx: 10, vy: 180, damage: 8, radius: 3, alive: true, kind: 'pellet',
}

/**
 * A mid-run world with every M5 feature live at once: a boss with a second barrel,
 * an armed hazard, a route card open, and something fitted.
 *
 * One rich baseline rather than a minimal one, deliberately — a mutation test
 * against an empty world proves that a field is hashed when present, not that it is
 * hashed in the state the game actually reaches.
 */
function worldView(overrides: Partial<WorldView> = {}): WorldView {
  return {
    seed: 'K7F29XQM3RTV',
    runState: 'active',
    stage: { index: 2, count: 5, sectorId: 'the-tally', sectorName: 'The Tally', bossName: 'The Bailiff' },
    hullName: 'Lien',
    boss: null,
    hazards: [hazard()],
    choiceResolve: null,
    hull: hull(),
    playerBullets: [BULLET],
    enemyBullets: [ENEMY_BULLET],
    enemies: [enemy(), bossEnemy()],
    explosions: [],
    stats: stats(),
    incident: null,
    events: [],
    cosmetic: { shake: 0 },
    freezeTicks: 0,
    inventory: [{ defId: 'warheads', acquiredAtTick: 420, count: 1 }],
    activeInteractions: [],
    resolvedStats: {},
    pendingChoice: choice(),
    ...overrides,
  }
}

/** Replace the boss instance, keeping the ordinary enemy beside it. */
function withBoss(overrides: Partial<EnemyInstance>): WorldView {
  return worldView({ enemies: [enemy(), bossEnemy(overrides)] })
}

/**
 * The boss with an optional field genuinely absent.
 *
 * `delete` rather than `{ secondary: undefined }`, because `exactOptionalPropertyTypes`
 * rejects the latter — and rightly: "the key is missing" and "the key holds
 * undefined" are different objects, and it is the missing case the sim produces.
 */
function bossWithout(key: 'secondary' | 'boss'): WorldView {
  const instance = bossEnemy()
  delete instance[key]
  return worldView({ enemies: [enemy(), instance] })
}

/** Replace the boss's runtime fields. */
function withBossRuntime(overrides: Partial<NonNullable<EnemyInstance['boss']>>): WorldView {
  const base = bossEnemy()
  const runtime = base.boss
  if (runtime === undefined) throw new Error('bossEnemy lost its runtime')
  return worldView({ enemies: [enemy(), { ...base, boss: { ...runtime, ...overrides } }] })
}

// ---------------------------------------------------------------------------

describe('the play-affecting digest covers what M5 added', () => {
  const base = hashWorld(worldView())

  /**
   * Each entry is a state that MUST hash differently from the baseline.
   *
   * Written as a table rather than as one assertion per field so that the list can
   * be read against `WorldView` directly: a field present in the contract and absent
   * from this table is the review question this file is meant to raise.
   */
  const mutations: ReadonlyArray<readonly [string, WorldView]> = [
    // --- EnemyInstance.uid: documented as hashed since M3, and was not ---------
    ['enemies[0].uid', worldView({ enemies: [enemy({ uid: 2 }), bossEnemy()] })],

    // --- EnemyInstance.secondary: a second barrel's cadence -------------------
    ['secondary.cooldown', withBoss({ secondary: { cooldown: 39, windup: 0, windupTotal: 0 } })],
    ['secondary.windup', withBoss({ secondary: { cooldown: 40, windup: 12, windupTotal: 0 } })],
    // Absent and present must differ, or an enemy that lost its second barrel
    // hashes the same as one that never had one.
    ['secondary absent', bossWithout('secondary')],

    // --- EnemyInstance.boss: the phase script ---------------------------------
    ['boss.phaseIndex', withBossRuntime({ phaseIndex: 0 })],
    ['boss.bossId', withBossRuntime({ bossId: 'bailiff' })],
    ['boss absent', bossWithout('boss')],

    // --- the stage ------------------------------------------------------------
    ['stage.index', worldView({ stage: { index: 3, count: 5, sectorId: 'the-tally', sectorName: 'The Tally', bossName: 'The Bailiff' } })],
    ['stage.sectorId', worldView({ stage: { index: 2, count: 5, sectorId: 'deep-manifest', sectorName: 'The Tally', bossName: 'The Bailiff' } })],
    ['stage.count', worldView({ stage: { index: 2, count: 4, sectorId: 'the-tally', sectorName: 'The Tally', bossName: 'The Bailiff' } })],

    // --- armed hazards --------------------------------------------------------
    ['hazards emptied', worldView({ hazards: [] })],
    ['hazard.id', worldView({ hazards: [hazard({ id: 'hold-rot' })] })],
    ['hazard.phase', worldView({ hazards: [hazard({ phase: 'active' })] })],
    ['hazard.ticksToChange', worldView({ hazards: [hazard({ ticksToChange: 32 })] })],

    // --- the hull issued and what is fitted -----------------------------------
    ['hullName', worldView({ hullName: 'Surety' })],
    ['inventory emptied', worldView({ inventory: [] })],
    ['inventory[0].defId', worldView({ inventory: [{ defId: 'split-shot', acquiredAtTick: 420, count: 1 }] })],
    ['inventory[0].count', worldView({ inventory: [{ defId: 'warheads', acquiredAtTick: 420, count: 2 }] })],
    ['inventory[0].acquiredAtTick', worldView({ inventory: [{ defId: 'warheads', acquiredAtTick: 421, count: 1 }] })],

    // --- the card the run is paused on ----------------------------------------
    ['pendingChoice cleared', worldView({ pendingChoice: null })],
    ['pendingChoice.kind', worldView({ pendingChoice: choice({ kind: 'shop' }) })],
    ['offer identity', worldView({ pendingChoice: choice({ offers: [{ defId: 'warheads', tier: 'common', interactionText: [] }] }) })],
    ['offer tier', worldView({ pendingChoice: choice({ offers: [{ defId: 'warheads', tier: 'rare', interactionText: [] }] }) })],
    ['offer cost', worldView({ pendingChoice: choice({ costs: [90] }) })],
    ['work-order kinds', worldView({ pendingChoice: choice({ workOrders: ['vault'] }) })],
    ['route.hazardIds', worldView({ pendingChoice: choice({ routes: [route({ hazardIds: ['hold-rot'] })] }) })],
    ['route.reward.kind', worldView({ pendingChoice: choice({ routes: [route({ reward: { kind: 'repair', amount: 180 } })] }) })],
    ['route.reward.amount', worldView({ pendingChoice: choice({ routes: [route({ reward: { kind: 'scrap', amount: 181 } })] }) })],
    ['route.stageIndex', worldView({ pendingChoice: choice({ routes: [route({ stageIndex: 2 })] }) })],
  ]

  it.each(mutations)('%s changes the regression hash', (_label, mutated) => {
    expect(hashWorld(mutated)).not.toBe(base)
  })

  /**
   * THE TRAP THAT MOTIVATED HASHING `variantId` AT ALL.
   *
   * `bossPhaseDefId` is `${bossId}#${phaseIndex}` with no variant in it, so the base
   * form and every variant of a boss share their derived def ids phase for phase.
   * Two runs fighting genuinely different patterns therefore agree on `defId`,
   * `phaseIndex`, `hp`, `radius` and `shape` — every other field the digest reads.
   * Without `variantId` they are indistinguishable, which is a divergence the corpus
   * would have been structurally unable to see.
   */
  it('separates two boss forms that share a defId', () => {
    const baseForm = withBossRuntime({ variantId: null })
    const variant = withBossRuntime({ variantId: 'manifest-warden' })
    const otherVariant = withBossRuntime({ variantId: 'manifest-liquidator' })

    const enemiesOf = (view: WorldView): string => digestWorld(view).enemies
    expect(enemiesOf(variant)).not.toBe(enemiesOf(baseForm))
    expect(enemiesOf(otherVariant)).not.toBe(enemiesOf(variant))

    // And the thing that makes the trap a trap: the def ids really are identical.
    expect(variant.enemies[1]?.defId).toBe(baseForm.enemies[1]?.defId)
    expect(variant.enemies[1]?.boss?.phaseIndex).toBe(baseForm.enemies[1]?.boss?.phaseIndex)
  })

  it('points at the component that moved', () => {
    // The diagnostic promise the component digests exist for: enemy state and run
    // state are named separately, so a failure localises in one line.
    const start = digestWorld(worldView())
    expect(diffDigests(start, digestWorld(withBossRuntime({ phaseIndex: 0 })))).toEqual(['enemies'])
    expect(diffDigests(start, digestWorld(worldView({ hullName: 'Surety' })))).toEqual(['run'])
    expect(diffDigests(start, digestWorld(worldView({ hazards: [] })))).toEqual(['run', 'cosmetic'])
  })

  it('is stable across calls and independent instances', () => {
    expect(hashWorld(worldView())).toBe(hashWorld(worldView()))
    expect(digestWorld(worldView())).toEqual(digestWorld(worldView()))
  })
})

describe('the cosmetic digest keeps presentation state out of the corpus', () => {
  /**
   * Each of these is a denominator or a display countdown that nothing branches on.
   * Hashing them into the regression digest would fail every fixture the day someone
   * retunes a callout's duration — which is how a corpus becomes a rubber stamp.
   * They are still hashed *somewhere*, so a divergence stays visible.
   */
  const cosmeticOnly: ReadonlyArray<readonly [string, WorldView]> = [
    ['secondary.windupTotal', withBoss({ secondary: { cooldown: 40, windup: 0, windupTotal: 30 } })],
    ['boss.calloutTicks', withBossRuntime({ calloutTicks: 59 })],
    ['hazard.progress', worldView({ hazards: [hazard({ progress: 0.46 })] })],
    ['enemy hit flash', worldView({ enemies: [enemy({ hitFlashTicks: 4 }), bossEnemy()] })],
  ]

  it.each(cosmeticOnly)('%s is excluded from the regression hash but still reported', (_label, mutated) => {
    expect(hashWorld(mutated)).toBe(hashWorld(worldView()))
    expect(digestWorld(mutated).cosmetic).not.toBe(digestWorld(worldView()).cosmetic)
    expect(diffDigests(digestWorld(worldView()), digestWorld(mutated))).toEqual(['cosmetic'])
  })
})

describe('every SimEvent variant reaches the hasher', () => {
  /**
   * M5 added six event kinds and the switch that was meant to force them to be
   * hashed did not: a `switch` with no `default` is not an exhaustiveness check, so
   * all six fell through hashing nothing but `kind`. The `never` assignment in
   * `hashEvent` now makes that a compile error; this makes it a test failure too, in
   * case the switch is ever loosened back to a `default: return`.
   */
  const events: readonly SimEvent[] = [
    { kind: 'player-shot', x: 1, y: 2 },
    { kind: 'enemy-hit', x: 1, y: 2, damage: 4, defId: 'skiff', lethal: false },
    { kind: 'enemy-killed', x: 1, y: 2, defId: 'skiff', scrap: 3, elite: false },
    { kind: 'enemy-shot', x: 1, y: 2, defId: 'skiff' },
    { kind: 'hull-hit', x: 1, y: 2, damage: 8, absorbedByShield: true },
    { kind: 'shield-broken', x: 1, y: 2 },
    { kind: 'hull-lost', x: 1, y: 2 },
    { kind: 'scrap-collected', x: 1, y: 2, amount: 5 },
    { kind: 'wave-released', index: 4 },
    { kind: 'boss-spawned', bossId: 'repossessor', name: 'The Repossessor' },
    { kind: 'boss-phase', bossId: 'repossessor', phaseIndex: 1, callout: 'SECOND' },
    { kind: 'boss-killed', x: 1, y: 2, bossId: 'repossessor' },
    { kind: 'hazard-warning', hazardId: 'grid-sweep' },
    { kind: 'hazard-fired', hazardId: 'grid-sweep' },
    { kind: 'stage-cleared', stageIndex: 2 },
  ]

  it('gives every kind a distinct cosmetic digest', () => {
    const quiet = digestWorld(worldView()).cosmetic
    const digests = events.map((event) => digestWorld(worldView({ events: [event] })).cosmetic)
    for (let i = 0; i < events.length; i++) {
      expect(digests[i], `${events[i]?.kind} did not move the cosmetic digest`).not.toBe(quiet)
    }
    expect(new Set(digests).size, 'two event kinds hash alike').toBe(events.length)
  })

  it('hashes an M5 event s payload, not only its kind', () => {
    // The specific symptom of the missing `default`: two boss-phase events differing
    // only in which phase was announced hashed identically.
    const first = digestWorld(worldView({ events: [{ kind: 'boss-phase', bossId: 'repossessor', phaseIndex: 1, callout: 'SECOND' }] }))
    const second = digestWorld(worldView({ events: [{ kind: 'boss-phase', bossId: 'repossessor', phaseIndex: 2, callout: 'THIRD' }] }))
    expect(second.cosmetic).not.toBe(first.cosmetic)

    const warn = digestWorld(worldView({ events: [{ kind: 'hazard-warning', hazardId: 'grid-sweep' }] }))
    const otherWarn = digestWorld(worldView({ events: [{ kind: 'hazard-warning', hazardId: 'hold-rot' }] }))
    expect(otherWarn.cosmetic).not.toBe(warn.cosmetic)
  })

  it('leaves the regression hash alone whatever fires', () => {
    for (const event of events) {
      expect(hashWorld(worldView({ events: [event] })), event.kind).toBe(hashWorld(worldView()))
    }
  })
})
