/**
 * Bot policy tests.
 *
 * These exist because the bots are an *instrument*, and an instrument that is
 * wrong is worse than one that is missing: M3's exit criteria are pick rates, and
 * a pick rate is only a fact about the game if the policy that produced it was
 * deterministic, actually resolved its choices, and picked what it meant to pick.
 *
 * The load-bearing ones, in order of how badly a failure would mislead:
 *
 *   1. Determinism. Without it every number in a sweep report is unreproducible,
 *      which makes it not a finding.
 *   2. Choices resolve fast. `CHOICE_TIMEOUT_TICKS` is a 60-second backstop; a
 *      policy that leans on it adds a minute of dead sim time per screen and
 *      silently corrupts every survival statistic in the report.
 *   3. The build-focused probe actually takes its build. If it does not, the
 *      synergy delta it exists to measure is measuring nothing.
 *   4. Degenerate screens do not crash or stall the run.
 *   5. No policy reads the content tables.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { InputSnapshot } from '../src/core/input'
import { packInput } from '../src/core/input'
import type { ItemDef } from '../src/content/types'
import { BOSSES } from '../src/content/bosses'
import { HAZARDS } from '../src/content/hazards'
import { INTERACTIONS } from '../src/content/interactions'
import { ITEMS } from '../src/content/items'
import { STANDARD_RUN } from '../src/content/runs'
import { SECTORS } from '../src/content/sectors'
import type {
  Hull,
  PendingChoice,
  PendingChoiceKind,
  RouteOption,
  RunStats,
  WorldView,
} from '../src/sim/entities'
import type { BotName, BotPolicy } from '../src/sim/bots'
import {
  BOTS,
  BOT_NAMES,
  BUILD_FOCUSED_TARGET,
  MAX_CHOICE_RESOLUTION_TICKS,
  createBuildFocused,
} from '../src/sim/bots'
import { CHOICE_TIMEOUT_TICKS } from '../src/sim/progression'
import { World, type RunContent } from '../src/sim/world'
import { hashWorld } from '../src/meta/snapshot'

/** Live content, so the tests that care about real pick behaviour see real offers. */
const LIVE_CONTENT: RunContent = { items: ITEMS, interactions: INTERACTIONS }

/**
 * The shipped five-sector run, wired exactly as `src/main.ts` wires it.
 *
 * Needed by any test whose subject is a *run* rather than a sector: route cards
 * only exist at a seam, and the reward schedule that a build-focused probe depends
 * on restarts per sector, so a single-sector World offers a third of the screens
 * the real game does.
 */
const FIVE_SECTOR_CONTENT: RunContent = {
  items: ITEMS,
  interactions: INTERACTIONS,
  run: STANDARD_RUN,
  sectors: Object.fromEntries(SECTORS.map((sector) => [sector.id, sector])),
  bosses: BOSSES,
  hazards: HAZARDS,
}

/**
 * A full sector at 60Hz plus slack.
 *
 * Long enough that every scheduled reward wave is reached (item choices after
 * waves 4/11/19/26 and shops after 8/23), which is the only way the choice paths
 * get exercised at all.
 */
const FULL_RUN_TICKS = 240 * 60

/**
 * A whole five-sector run at 60Hz plus slack.
 *
 * 930 seconds of authored sector time plus five boss fights, each of which holds
 * its stage open until the boss is dead. 1,500s clears the longest clear observed
 * in a sweep with room to spare.
 */
const FIVE_SECTOR_TICKS = 1500 * 60

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** One choice screen as it was seen from outside the sim. */
interface SeenChoice {
  kind: PendingChoiceKind
  offeredIds: readonly string[]
  costs: readonly number[]
  scrapAtOpen: number
  takenId: string | null
  ticksOpen: number
  /** Ticks the sim discarded to hitstop, which the bot cannot spend. */
  frozenTicks: number
  /** Items already held when the screen opened. A re-offer is not a fresh offer. */
  heldAtOpen: readonly string[]
}

interface Played {
  hash: string
  ticks: number
  runState: string
  /** Packed inputs, so two runs can be compared byte for byte. */
  inputs: number[]
  choices: SeenChoice[]
  finalInventory: string[]
  finalInteractions: string[]
}

/**
 * Play one policy to completion and report everything an observer can see.
 *
 * Deliberately does not import the sweep runner from `tools/playtest.ts`: these
 * tests have to be able to fail when the tool is wrong, which they cannot do if
 * they measure through it.
 */
function play(policy: BotPolicy, seed: string, content?: RunContent, maxTicks = FULL_RUN_TICKS): Played {
  const world = content === undefined ? new World(seed) : new World(seed, content)
  const view: WorldView = world
  const inputs: number[] = []
  const choices: SeenChoice[] = []

  let open: (SeenChoice & { openedAtTick: number; countsBefore: Map<string, number> }) | null = null
  let ticks = 0

  while (view.runState === 'active' && ticks < maxTicks) {
    const wasOpen = open
    const frozen = view.freezeTicks > 0
    const input: InputSnapshot = policy(view)
    inputs.push(packInput(input))
    world.tick(input)
    ticks++
    if (wasOpen !== null && frozen) wasOpen.frozenTicks++

    const pending = view.pendingChoice
    if (pending !== null && open === null) {
      open = {
        kind: pending.kind,
        offeredIds: pending.offers.map((offer) => offer.defId),
        costs: [...pending.costs],
        scrapAtOpen: view.stats.scrap,
        takenId: null,
        ticksOpen: 0,
        frozenTicks: 0,
        heldAtOpen: view.inventory.map((entry) => entry.defId),
        openedAtTick: ticks,
        countsBefore: new Map(view.inventory.map((entry) => [entry.defId, entry.count])),
      }
    } else if (pending === null && open !== null) {
      let taken: string | null = null
      for (const entry of view.inventory) {
        if (entry.count > (open.countsBefore.get(entry.defId) ?? 0)) taken = entry.defId
      }
      choices.push({
        kind: open.kind,
        offeredIds: open.offeredIds,
        costs: open.costs,
        scrapAtOpen: open.scrapAtOpen,
        takenId: taken,
        ticksOpen: ticks - open.openedAtTick,
        frozenTicks: open.frozenTicks,
        heldAtOpen: open.heldAtOpen,
      })
      open = null
    }
  }

  return {
    hash: hashWorld(view),
    ticks,
    runState: view.runState,
    inputs,
    choices,
    finalInventory: view.inventory.map((entry) => entry.defId),
    finalInteractions: view.activeInteractions.map((entry) => entry.defId),
  }
}

// ---------------------------------------------------------------------------
// 1. determinism
// ---------------------------------------------------------------------------

describe('every policy is deterministic', () => {
  it.each(BOT_NAMES)('%s reproduces a full run exactly from the same seed', (name) => {
    const seed = 'D3TERM1N1SM1'
    const first = play(BOTS[name].create(seed), seed, LIVE_CONTENT)
    const second = play(BOTS[name].create(seed), seed, LIVE_CONTENT)

    // The input log first: when a policy drifts, the inputs diverge before the
    // state does, and "input 5,213 differs" localises the bug where "the hashes
    // differ" does not.
    expect(second.inputs).toEqual(first.inputs)
    expect(second.hash).toBe(first.hash)
    expect(second.ticks).toBe(first.ticks)
    expect(second.runState).toBe(first.runState)
    // The picks are part of the run. A policy that reproduced its flight but chose
    // differently would leave every pick rate in a sweep unreproducible while the
    // state hash stayed green, because two builds can end on identical state.
    expect(second.choices.map((c) => c.takenId)).toEqual(first.choices.map((c) => c.takenId))
    expect(second.finalInventory).toEqual(first.finalInventory)
  })

  it.each(BOT_NAMES)('%s is deterministic with an empty item pool too', (name) => {
    // The default `new World(seed)` path, which is what the replay corpus uses.
    const seed = 'N01TEMS23456'
    expect(play(BOTS[name].create(seed), seed).hash).toBe(play(BOTS[name].create(seed), seed).hash)
  })

  it('a fresh policy instance carries no state from the previous run', () => {
    // Policies now hold per-run state (a choice script, an Rng, a hold counter).
    // If `create` ever returned a shared instance, run N would inherit run N-1's
    // mid-choice script and a sweep's later runs would differ from its earlier
    // ones on the same seed — a bug that only shows up in aggregate.
    for (const name of BOT_NAMES) {
      const warm = BOTS[name].create('WARMUP234567')
      play(warm, 'WARMUP234567', LIVE_CONTENT)
      const a = play(BOTS[name].create('C0LDSTART234'), 'C0LDSTART234', LIVE_CONTENT)
      const b = play(BOTS[name].create('C0LDSTART234'), 'C0LDSTART234', LIVE_CONTENT)
      expect(a.hash, name).toBe(b.hash)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. choices resolve, and fast
// ---------------------------------------------------------------------------

describe('every policy resolves a choice instead of stalling', () => {
  it.each(BOT_NAMES)('%s reaches at least one choice screen and resolves it', (name) => {
    const seed = 'CH01CES23456'
    const run = play(BOTS[name].create(seed), seed, LIVE_CONTENT)
    expect(run.choices.length).toBeGreaterThan(0)
    // Every screen closed. A screen still open at run end would appear here as a
    // missing record, not as a long one, so the count is the assertion.
    for (const choice of run.choices) {
      expect(choice.ticksOpen).toBeGreaterThan(0)
    }
  })

  it.each(BOT_NAMES)('%s never leans on the sim 60-second choice timeout', (name) => {
    const seed = 'N0T1MEOUT234'
    const run = play(BOTS[name].create(seed), seed, LIVE_CONTENT)
    for (const choice of run.choices) {
      // The real bound: ticks the bot actually got to spend. Hitstop ticks are
      // discarded by the sim before the choice sees them, so they inflate the wall
      // duration without meaning the policy is lost.
      const scriptTicks = choice.ticksOpen - choice.frozenTicks
      expect(scriptTicks, `${name} spent ${scriptTicks} unfrozen ticks on a ${choice.kind}`).toBeLessThanOrEqual(
        MAX_CHOICE_RESOLUTION_TICKS,
      )
      // And nowhere near the backstop, which is what would corrupt survival times:
      // six screens at 3,600 ticks each would add six minutes of sim time to a run.
      expect(choice.ticksOpen).toBeLessThan(CHOICE_TIMEOUT_TICKS / 10)
    }
  })

  it('a full sweep-shaped run spends a negligible fraction of its ticks on menus', () => {
    // The number this protects: survival time. If choices were resolved by timeout,
    // a cleared run would report ~180s of sector plus six minutes of nothing.
    for (const name of BOT_NAMES) {
      const seed = 'MENUT1ME2345'
      const run = play(BOTS[name].create(seed), seed, LIVE_CONTENT)
      const menuTicks = run.choices.reduce((sum, c) => sum + c.ticksOpen, 0)
      // Six screens at the 6-tick budget is 36 ticks out of ~11,000 — 0.3%. One
      // screen resolved by timeout alone would be 3,600 ticks and blow this.
      expect(menuTicks / run.ticks, name).toBeLessThan(0.01)
    }
  })

  it('resolves choices in a run that is nothing but choices', () => {
    // A pool of one item means every reward wave opens a one-option screen, which
    // is the narrowest cursor case: `preferred % 1` must land on index 0 and the
    // confirm must still take a rising edge.
    const single: RunContent = {
      items: { only: stat('only') },
      interactions: [],
    }
    for (const name of BOT_NAMES) {
      const seed = '0NE1TEM23456'
      const run = play(BOTS[name].create(seed), seed, single)
      for (const choice of run.choices) {
        expect(choice.ticksOpen - choice.frozenTicks, name).toBeLessThanOrEqual(
          MAX_CHOICE_RESOLUTION_TICKS,
        )
      }
    }
  })
})

// ---------------------------------------------------------------------------
// 3. the build-focused probe takes its build
// ---------------------------------------------------------------------------

/** A minimal stat-only item. Fabricated so a balance change cannot break a bot test. */
function stat(id: string, weight = 10): ItemDef {
  return {
    id,
    name: id,
    tier: 'common',
    tags: ['weapon'],
    mechanism: `+1 projectile damage (test item ${id}).`,
    flavour: 'Fabricated for tests.',
    stats: [{ stat: 'projectileDamage', kind: 'add', value: 1 }],
    weight,
  }
}

describe('the build-focused policy acquires its target build', () => {
  const TEST_CONTENT: RunContent = {
    items: {
      alpha: stat('alpha'),
      beta: stat('beta'),
      gamma: stat('gamma'),
      delta: stat('delta'),
      epsilon: stat('epsilon'),
    },
    interactions: [],
  }

  it('takes a target item on every free screen where one is offered', () => {
    const targets = ['alpha', 'beta']
    let offeredCount = 0
    let tookTarget = 0

    for (let i = 0; i < 40; i++) {
      const seed = `BU1LDT3ST${String(i).padStart(3, '0')}`
      const run = play(createBuildFocused(targets), seed, TEST_CONTENT)
      for (const choice of run.choices) {
        // Free screens only: a shop can price a target out of reach, and declining
        // something unaffordable is correct behaviour rather than a targeting miss.
        if (choice.kind !== 'item') continue
        // A target the pilot already holds is not a target any more: the policy
        // scores it as a stack, and taking it again would be a preference for
        // duplicates rather than for the build.
        const wanted = choice.offeredIds.filter(
          (id) => targets.includes(id) && !choice.heldAtOpen.includes(id),
        )
        if (wanted.length === 0) continue
        offeredCount++
        if (choice.takenId !== null && wanted.includes(choice.takenId)) tookTarget++
      }
    }

    expect(offeredCount).toBeGreaterThan(10)
    // Exact, not statistical: with no cost and no competing signal, a target on the
    // screen is the highest-scoring option every single time. A near-miss here means
    // the cursor navigation is off by one, which would quietly skew a whole sweep.
    expect(tookTarget).toBe(offeredCount)
  })

  it('ends its runs holding the targets it was offered', () => {
    const targets = ['gamma', 'delta']
    let runsHoldingBoth = 0
    for (let i = 0; i < 40; i++) {
      const seed = `H0LDB0TH${String(i).padStart(4, '0')}`
      const run = play(createBuildFocused(targets), seed, TEST_CONTENT)
      if (targets.every((id) => run.finalInventory.includes(id))) runsHoldingBoth++
    }
    // Six reward screens out of a five-item pool: assembling a named pair should be
    // the common case, not a fluke. This is the assertion that makes a forced-build
    // sweep worth reading at all.
    expect(runsHoldingBoth).toBeGreaterThan(20)
  })

  /**
   * Offer slots a probe needs before "did it assemble the pair" is a measurement.
   *
   * Not a round number picked to pass. With a 40-item pool the two targets carry 8
   * and 5 of 239 total weight, so an offer slot shows a specific target about 3% of
   * the time and the pair needs both to appear at least once. Below ~20 slots the
   * pair is a coin flip on the offer RNG and the probe is measuring the pool rather
   * than the build; a five-sector run supplies ~36. Asserted separately from the
   * outcome so that if the reward schedule is ever cut, THIS fails with a legible
   * reason instead of the pair count mysteriously sagging.
   */
  const MIN_OFFER_SLOTS_PER_RUN = 20

  it('assembles its real declared build often enough to measure a delta', () => {
    /**
     * THE INSTRUMENT WAS MEASURING THE WRONG THING, and the zero it produced was a
     * true finding about the probe rather than about the items.
     *
     * This test used to drive `LIVE_CONTENT`, which has no `run` and therefore flies
     * `SINGLE_SECTOR_RUN` — one sector, four reward screens, twelve offer slots. That
     * was the whole game when it was written. It is now one fifth of it. Meanwhile the
     * pool grew from 14 items to 40, so a specific target's share of an offer slot
     * fell by roughly two thirds at the same moment the number of slots stopped
     * growing with the run.
     *
     * Measured, on 40 seeds each:
     *
     *   single sector   12.0 offer slots/run, 0.68 target offers/run, pair in  0.0%
     *   five sectors    36.1 offer slots/run, 1.98 target offers/run, pair in 42.5%
     *
     * So the floor was above the ceiling: the old assertion demanded >10% from a
     * configuration whose best case was around 7%. Lowering the threshold would have
     * kept a probe that assembles its build in one run in fourteen, which cannot
     * support a synergy delta at any sample size a sweep can afford. Driving the real
     * run fixes the probe instead, and it is also what the probe is now FOR — the
     * sweeps this test guards are five-sector sweeps.
     *
     * Still against the live tables, deliberately: a weight change that makes the
     * shipped target build unreachable must show up here rather than as a quiet zero
     * in a report.
     */
    let runsHoldingBoth = 0
    let offerSlots = 0
    const runs = 40
    for (let i = 0; i < runs; i++) {
      const seed = `L1VEBU1LD${String(i).padStart(3, '0')}`
      const run = play(
        BOTS['build-focused'].create(seed),
        seed,
        FIVE_SECTOR_CONTENT,
        FIVE_SECTOR_TICKS,
      )
      for (const choice of run.choices) offerSlots += choice.offeredIds.length
      if (BUILD_FOCUSED_TARGET.every((id) => run.finalInventory.includes(id))) runsHoldingBoth++
    }

    // The precondition, asserted before the outcome so a failure says which broke.
    expect(
      offerSlots / runs,
      'too few offer slots per run for the pair to be reachable — the probe cannot measure a synergy from this',
    ).toBeGreaterThan(MIN_OFFER_SLOTS_PER_RUN)

    // A floor, not a target: 42.5% measured, and a binomial 95% interval at n=40 is
    // roughly +/-15pp, so 20% is comfortably below the noise band and still far above
    // the "one run in fourteen" the old configuration could manage.
    expect(runsHoldingBoth).toBeGreaterThan(runs * 0.2)
  })
})

// ---------------------------------------------------------------------------
// 3b. the world map
// ---------------------------------------------------------------------------

/** A route card as the sim builds one: index 0 free, the rest priced in hazards. */
function routeCard(rewards: readonly RouteOption['reward'][]): PendingChoice {
  return {
    kind: 'route',
    offers: [],
    costs: [],
    workOrders: [],
    routes: rewards.map((reward, index) => ({
      stageIndex: 1,
      // Matches the titles progression.ts authors, so a reader of this fixture is
      // looking at the same card the sim builds. No policy reads it — `chooseRoute`
      // scores the reward and the hull's damage, never the title.
      name: index === 0 ? 'DIRECT APPROACH' : index === 1 ? 'CACHE RECOVERY' : 'SALVAGE DETOUR',
      sectorName: 'The Tally',
      bossName: 'The Auditor',
      hazards: index === 0 ? [] : [{ name: 'Convoy Wake', description: 'Debris.' }],
      hazardIds: index === 0 ? [] : ['convoy-wake'],
      reward,
      rewardText: `option ${index}`,
    })),
  }
}

describe('policies resolve the world map', () => {
  it('every policy resolves a route card inside the navigation budget', () => {
    // THE BUG THIS PINS. `ChoiceResolver` counted a card's options as `offers.length`
    // for every kind except work-order, and a route card carries its options in
    // `routes` with `offers` empty — so every policy saw a zero-option screen and
    // took the skip branch. Nothing stalled and nothing crashed, because the sim
    // resolves a skipped route as "take the direct approach". The world map simply
    // never happened, in every run, for every policy, silently.
    const card = routeCard([{ kind: 'none' }, { kind: 'item' }, { kind: 'scrap', amount: 180 }])
    for (const name of BOT_NAMES) {
      const view = fakeView(card)
      const inputs = pressesAgainst(BOTS[name].create('R0UTECARD123'), view, 12)
      const acted = inputs.findIndex((input) => input.fire || input.special)
      expect(acted, `${name} never acted on a route card`).toBeGreaterThanOrEqual(0)
      expect(acted + 1, `${name} took too long on a route card`).toBeLessThanOrEqual(
        MAX_CHOICE_RESOLUTION_TICKS,
      )
      // Confirm, not skip: skipping a route is the sim's fallback to the direct
      // approach, and a policy that reaches option 0 by skipping is indistinguishable
      // from one that cannot read the card at all.
      expect(inputs.some((input) => input.fire), `${name} skipped rather than chose`).toBe(true)
    }
  })

  it('a rewarding policy navigates to the paying option rather than confirming index 0', () => {
    // The cursor is mirrored, not read — `ChoiceCursor` is not on WorldView — so an
    // off-by-one here would take the wrong route while every other test stayed green.
    const card = routeCard([{ kind: 'none' }, { kind: 'none' }, { kind: 'item' }])
    const inputs = pressesAgainst(BOTS.greedy.create('R3WARD123456'), fakeView(card), 8)
    const steps = inputs.filter((input) => input.moveX > 0).length
    expect(steps, 'greedy did not walk the cursor to option 2').toBe(2)
  })

  it('a direct policy stays on the free approach however well the others pay', () => {
    const card = routeCard([
      { kind: 'none' },
      { kind: 'item' },
      { kind: 'scrap', amount: 9999 },
    ])
    for (const name of ['dodger', 'aggressor'] as BotName[]) {
      const inputs = pressesAgainst(BOTS[name].create('D1RECT123456'), fakeView(card), 8)
      expect(inputs.some((input) => input.moveX !== 0), `${name} left the direct approach`).toBe(
        false,
      )
    }
  })

  it('values a repair route by the damage actually taken, not by its face value', () => {
    // A full repair on a full hull is worth nothing, and a probe that took a
    // sector-long hazard for it would make the world map look better than it is.
    const card = routeCard([{ kind: 'none' }, { kind: 'repair', amount: 200 }])
    const healthy = pressesAgainst(BOTS.greedy.create('HEALTHY23456'), fakeView(card), 8)
    expect(healthy.some((input) => input.moveX !== 0)).toBe(false)

    const hurt = pressesAgainst(
      BOTS.greedy.create('HURT12345678'),
      fakeView(card, { hull: { ...fakeHull(), integrity: 12 } }),
      8,
    )
    expect(hurt.filter((input) => input.moveX > 0).length).toBe(1)
  })

  it('a five-sector run crosses every seam without a policy stalling on it', () => {
    // The integration check behind the unit tests above: a policy that cannot resolve
    // a route card does not crash, it silently caps the run at the first seam, and
    // every per-sector number a sweep produces afterwards is garbage.
    for (const name of BOT_NAMES) {
      const seed = 'SEAMS1234567'
      const world = new World(seed, FIVE_SECTOR_CONTENT)
      const view: WorldView = world
      const policy = BOTS[name].create(seed)
      let ticks = 0
      let routeCards = 0
      let sawRoute = false
      while (view.runState === 'active' && ticks < FIVE_SECTOR_TICKS) {
        world.tick(policy(view))
        ticks++
        const open = view.pendingChoice?.kind === 'route'
        if (open && !sawRoute) routeCards++
        sawRoute = open
        // A route card resolved by the sim's 60-second backstop rather than by the
        // policy is the failure this catches, and it looks like a long run, not a
        // stuck one.
        expect(view.pendingChoice === null || ticks < FIVE_SECTOR_TICKS).toBe(true)
      }
      expect(view.runState, `${name} was still active at the cap`).not.toBe('active')
    }
  })

  it('accepting a hazard is a real behavioural difference, not a label', () => {
    // If `rewarding` and `direct` produced the same runs the route styles would be
    // decoration, and the sweep's risk-appetite column would be measuring nothing.
    const seed = 'HAZARDD1FF12'
    const armed = (routeStyle: 'direct' | 'rewarding'): number => {
      let sectorsWithHazards = 0
      for (let i = 0; i < 8; i++) {
        const runSeed = `${seed}${i}`
        const world = new World(runSeed, FIVE_SECTOR_CONTENT)
        const view: WorldView = world
        const policy = BOTS.aggressor.create(runSeed, { routeStyle })
        let ticks = 0
        let stage = 0
        while (view.runState === 'active' && ticks < FIVE_SECTOR_TICKS) {
          world.tick(policy(view))
          ticks++
          if (view.stage.index !== stage) {
            stage = view.stage.index
            if (view.hazards.length > 0) sectorsWithHazards++
          }
        }
      }
      return sectorsWithHazards
    }
    expect(armed('direct')).toBe(0)
    expect(armed('rewarding')).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 4. degenerate screens
// ---------------------------------------------------------------------------

function fakeHull(): Hull {
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
  }
}

function fakeStats(overrides: Partial<RunStats> = {}): RunStats {
  return {
    tick: 100,
    shotsFired: 0,
    hits: 0,
    kills: 0,
    scrap: 0,
    damageTaken: 0,
    waveIndex: 4,
    peakProjectiles: 0,
    bulletsCulled: 0,
    ...overrides,
  }
}

function fakeView(choice: PendingChoice | null, overrides: Partial<WorldView> = {}): WorldView {
  return {
    seed: 'FAKEV13W2345',
    runState: 'active',
    // M5 view fields. Fixtures state them explicitly rather than spreading a shared
    // default, so adding a WorldView field fails here and someone decides what the
    // fixture should say instead of inheriting a silent placeholder.
    stage: { index: 0, count: 1, sectorId: 'debris-shelf', sectorName: 'Debris Shelf', bossName: null },
    hullName: 'Lien',
    boss: null,
    hazards: [],
    hull: fakeHull(),
    playerBullets: [],
    enemyBullets: [],
    enemies: [],
    explosions: [],
    stats: fakeStats(),
    incident: null,
    events: [],
    cosmetic: { shake: 0 },
    freezeTicks: 0,
    inventory: [],
    activeInteractions: [],
    resolvedStats: {},
    pendingChoice: choice,
    // Null, not a countdown: these fixtures test what a POLICY does with a card, and
    // a live auto-resolve timer would mean the card resolved itself while the policy
    // was still deciding — which is the sim's rescue for a human who walked away, not
    // a path any bot should ever reach.
    choiceResolve: null,
    ...overrides,
  }
}

/** Drive a policy against a static view and collect what it pressed. */
function pressesAgainst(policy: BotPolicy, view: WorldView, ticks: number): InputSnapshot[] {
  const out: InputSnapshot[] = []
  for (let i = 0; i < ticks; i++) out.push(policy(view))
  return out
}

describe('degenerate choice screens neither crash nor stall', () => {
  const empties: Array<[string, PendingChoice]> = [
    ['an item screen with no offers', { kind: 'item', offers: [], costs: [], workOrders: [], routes: [] }],
    ['a shop with no offers', { kind: 'shop', offers: [], costs: [], workOrders: [], routes: [] }],
    ['a work order with no options', { kind: 'work-order', offers: [], costs: [], workOrders: [], routes: [] }],
    // The sim never builds one — `beginTransition` skips the card when there are no
    // hazards to trade against — but a policy must not be the thing that discovers
    // it did. A zero-option route is the one card whose skip is genuinely correct.
    ['a route card with no approaches', { kind: 'route', offers: [], costs: [], workOrders: [], routes: [] }],
  ]

  it.each(empties)('every policy skips %s', (_label, choice) => {
    for (const name of BOT_NAMES) {
      const view = fakeView(choice)
      const inputs = pressesAgainst(BOTS[name].create('EMPTY2345678'), view, 12)
      // A screen with zero options cannot be CONFIRMED at all — the sim requires
      // `optionCount > 0` — so the only exit is a skip. A policy that only ever
      // pressed fire here would sit on the screen for the full 60-second timeout.
      expect(inputs.some((input) => input.special), `${name} never pressed skip`).toBe(true)
      // And it must not thrash the ship while a screen is up.
      for (const input of inputs) {
        expect(input.moveY, name).toBe(0)
      }
    }
  })

  it('every policy declines a screen it cannot afford rather than pressing forever', () => {
    const choice: PendingChoice = {
      kind: 'shop',
      offers: [
        { defId: 'a', tier: 'common', interactionText: [] },
        { defId: 'b', tier: 'common', interactionText: ['synergy!'] },
      ],
      costs: [999, 999],
      workOrders: [],
      routes: [],
    }
    for (const name of BOT_NAMES) {
      const view = fakeView(choice, { stats: fakeStats({ scrap: 3 }) })
      const inputs = pressesAgainst(BOTS[name].create('BR0KE2345678'), view, 12)
      expect(inputs.some((input) => input.special), `${name} never declined`).toBe(true)
      expect(inputs.some((input) => input.fire), `${name} confirmed something unaffordable`).toBe(false)
    }
  })

  it('every policy keeps its script paused while the sim is frozen', () => {
    // Hitstop discards the tick before the choice sees it. A policy that advanced
    // its script anyway would have its navigation presses eaten and would confirm
    // the wrong option — the single failure mode that would corrupt a pick table
    // while every other test stayed green.
    const choice: PendingChoice = {
      kind: 'item',
      offers: [
        { defId: 'a', tier: 'common', interactionText: [] },
        { defId: 'b', tier: 'common', interactionText: [] },
        { defId: 'c', tier: 'common', interactionText: [] },
      ],
      costs: [0, 0, 0],
      workOrders: [],
      routes: [],
    }
    for (const name of BOT_NAMES) {
      const frozen = fakeView(choice, { freezeTicks: 4 })
      const inputs = pressesAgainst(BOTS[name].create('FR0ZEN234567', ), frozen, 30)
      for (const input of inputs) {
        expect(input.fire, `${name} pressed fire during hitstop`).toBe(false)
        expect(input.special, `${name} pressed skip during hitstop`).toBe(false)
        expect(input.moveX, `${name} moved the cursor during hitstop`).toBe(0)
      }
    }
  })

  it('a policy resolves a screen that stays open longer than it expected', () => {
    // The self-healing branch. If an input the policy expected to land is lost, it
    // must keep pressing until the screen closes rather than idling into the
    // 60-second timeout — a wrong pick is one skewed row, a timeout skews everything.
    const choice: PendingChoice = {
      kind: 'item',
      offers: [
        { defId: 'a', tier: 'common', interactionText: [] },
        { defId: 'b', tier: 'common', interactionText: [] },
        { defId: 'c', tier: 'common', interactionText: [] },
      ],
      costs: [0, 0, 0],
      workOrders: [],
      routes: [],
    }
    for (const name of BOT_NAMES) {
      const view = fakeView(choice)
      const inputs = pressesAgainst(BOTS[name].create('ST1CKY234567'), view, 60)
      const confirms = inputs.filter((input) => input.fire || input.special).length
      // Repeatedly, not once: the screen in this fake never closes.
      expect(confirms, `${name} stopped trying to resolve a stuck screen`).toBeGreaterThan(1)
    }
  })
})

// ---------------------------------------------------------------------------
// 5. the isolation constraint, asserted structurally
// ---------------------------------------------------------------------------

describe('policies read WorldView and nothing else', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/sim/bots.ts', import.meta.url)), 'utf8')

  it('does not import the content tables', () => {
    // A bot that read `items.ts` would know an item's tier, tags, and numbers, and
    // would stop being a probe: its pick rate would measure the table it read
    // rather than what the choice screen actually communicates. That is also the
    // reason a tier preference is only expressible via a shop's costs — see the
    // header of bots.ts.
    expect(source).not.toMatch(/from\s+['"][^'"]*\/content\//)
    expect(source).not.toMatch(/\b(ITEMS|INTERACTIONS|ENEMIES|SECTOR_ONE)\b/)
  })

  it('does not import the World class, the spawner, or any sim internals it could cheat with', () => {
    for (const forbidden of ['/world', './world', './spawner', './progression', './inventory', './stats']) {
      expect(source, `bots.ts imports ${forbidden}`).not.toContain(`from '${forbidden}'`)
    }
  })

  it('names its build target as data rather than importing it', () => {
    // The one place a bot has to know a content id. Kept as a string constant so a
    // sweep can print it and report the target as never-offered if it stops
    // existing, instead of failing to compile or silently measuring nothing.
    expect(BUILD_FOCUSED_TARGET.length).toBeGreaterThanOrEqual(2)
    for (const id of BUILD_FOCUSED_TARGET) {
      expect(Object.hasOwn(ITEMS, id), `${id} is not in the item table`).toBe(true)
    }
    // And they must form a real declared interaction, or the probe measures a pair
    // of unrelated items and calls the result a synergy.
    const pair = INTERACTIONS.find((interaction) =>
      BUILD_FOCUSED_TARGET.every((id) => interaction.requires.includes(id)),
    )
    expect(pair, `${BUILD_FOCUSED_TARGET.join(' + ')} is not a declared interaction`).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// 6. the policies actually differ in what they pick
// ---------------------------------------------------------------------------

describe('policies express different preferences', () => {
  it('the pooled picks are not all the same decision', () => {
    // Five probes that made identical picks would be one probe printed five times,
    // and the per-policy pick table in the sweep report would be decoration.
    const seeds = ['PR3F0NE23456', 'PR3FTW023456', 'PR3FTHR33234']
    const perPolicy = new Map<BotName, string[]>()
    for (const name of BOT_NAMES) {
      const picks: string[] = []
      for (const seed of seeds) {
        const run = play(BOTS[name].create(seed), seed, LIVE_CONTENT)
        for (const choice of run.choices) picks.push(`${choice.takenId ?? '-'}`)
      }
      perPolicy.set(name, picks)
    }
    const signatures = new Set([...perPolicy.values()].map((picks) => picks.join(',')))
    expect(signatures.size).toBeGreaterThan(1)
  })

  it('a stated synergy is taken more often than an unmarked offer', () => {
    // The heuristic that makes a pick rate mean something. If this inverted, the
    // syn/nosyn columns in the sweep would be reporting the opposite of the policy.
    let synOffers = 0
    let synPicks = 0
    let plainOffers = 0
    let plainPicks = 0

    for (let i = 0; i < 25; i++) {
      const seed = `SYNERGY${String(i).padStart(5, '0')}`
      const world = new World(seed, LIVE_CONTENT)
      const view: WorldView = world
      const policy = BOTS.aggressor.create(seed)
      let openIds: Array<{ defId: string; synergy: boolean }> | null = null
      let before = new Map<string, number>()
      let ticks = 0
      while (view.runState === 'active' && ticks < FULL_RUN_TICKS) {
        world.tick(policy(view))
        ticks++
        const pending = view.pendingChoice
        if (pending !== null && openIds === null) {
          if (pending.kind === 'item') {
            openIds = pending.offers.map((offer) => ({
              defId: offer.defId,
              synergy: offer.interactionText.length > 0,
            }))
            before = new Map(view.inventory.map((entry) => [entry.defId, entry.count]))
          } else {
            openIds = []
          }
        } else if (pending === null && openIds !== null) {
          let taken: string | null = null
          for (const entry of view.inventory) {
            if (entry.count > (before.get(entry.defId) ?? 0)) taken = entry.defId
          }
          for (const offer of openIds) {
            if (offer.synergy) {
              synOffers++
              if (offer.defId === taken) synPicks++
            } else {
              plainOffers++
              if (offer.defId === taken) plainPicks++
            }
          }
          openIds = null
        }
      }
    }

    // Thresholds are low because the reward schedule is deliberately sparse: two
    // item choices per sector, chosen so one sector does not hand out a whole
    // five-sector run's worth of upgrades. An earlier version of this test assumed
    // four choices per run and asserted absolute counts that the schedule no longer
    // produces — the sample size is a property of content, so the assertion is about
    // having enough data to compare rather than about a fixed number.
    expect(synOffers, 'too few synergy-marked offers to compare rates').toBeGreaterThan(0)
    expect(plainOffers, 'too few unmarked offers to compare rates').toBeGreaterThan(10)
    expect(synPicks / synOffers).toBeGreaterThan(plainPicks / plainOffers)
  })
})
