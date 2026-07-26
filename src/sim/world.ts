/**
 * The simulation.
 *
 * This class coordinates; it does not contain behaviour. Each system lives in its
 * own module (spawner, enemies, projectiles, collision, damage) and `tick()` is a
 * list of phases in the order they must happen. Read it top to bottom to know
 * what a tick does.
 *
 * The four rules everything here is built on:
 *
 *   1. No rendering, DOM, or timing imports. This module runs headless in Node.
 *   2. All randomness comes from named streams off the run seed.
 *   3. tick() takes an InputSnapshot and advances exactly one fixed step.
 *   4. Entities keep their previous position so rendering can interpolate.
 *
 * Anything that breaks rule 1 or 2 breaks replays and bot playtesting, which are
 * the only ways this game gets verified. See docs/ARCHITECTURE.md.
 */

import { TICK_HZ, TICK_SECONDS } from '../core/loop'
import type { InputSnapshot } from '../core/input'
import { Rng } from '../core/rng'
import { clamp, Playfield } from '../core/space'
import { ENEMIES } from '../content/enemies'
import { SECTOR_ONE } from '../content/sectors'
import type {
  BossDef,
  EnemyDef,
  HazardDef,
  HullDef,
  RunDef,
  RunStageDef,
  SectorDef,
} from '../content/types'
import { circlesOverlap, segmentHitsCircle } from './collision'
import {
  addShake,
  applyEnemyDamage,
  applyHullDamage,
  extendFreeze,
  freezeForEnemyHit,
  freezeForHullHit,
  HULL_COLLISION_RADIUS,
  shakeForEnemyHit,
  shakeForHullHit,
  SHAKE_SHIELD_BROKEN,
  tickHullInvulnerability,
} from './damage'
import {
  ageEnemyCosmetics,
  fireDeathBurst,
  isEnemyOutOfPlay,
  updateEnemyMovement,
  updateEnemyWeapon,
} from './enemies'
import {
  advanceProjectiles,
  cullDead,
  spawnPlayerBullet,
  type AttributedEnemyBullet,
} from './projectiles'
import { Spawner } from './spawner'
import { addItem, resolveInventory, type InventoryResolution } from './inventory'
import { NO_EFFECTS, summariseEffects, volleyAngles, type EffectTotals } from './itemEffects'
import { resolveAllStats, shotsPerSecond } from './stats'
import {
  CHOICE_TIMEOUT_TICKS,
  HELD_CONFIRM_DWELL_TICKS,
  ITEM_CHOICE_WAVES,
  SHOP_WAVES,
  WORK_ORDER_WAVES,
  buildOffers,
  buildRoutes,
  makeChoice,
  newCursor,
  shopCosts,
  transitShopCosts,
  updateCursor,
  type ChoiceCursor,
} from './progression'
import {
  advanceBossPhase,
  createBoss,
  deriveBossDefs,
  keepBossInPlay,
  pickVariant,
  type BossForm,
} from './bosses'
import { HazardField, spawnDebris } from './hazards'
import type { EffectDef, InteractionDef, ItemDef, StatModifier } from '../content/types'
import type {
  ActiveInteraction,
  ChoiceResolveView,
  HazardView,
  HeldItem,
  PendingChoice,
  ResolvedStats,
  RouteReward,
  StageView,
  Bullet,
  CosmeticState,
  EnemyInstance,
  Explosion,
  ExplosionKind,
  Hull,
  Incident,
  RunState,
  RunStats,
  SimEvent,
  WorldView,
} from './entities'

/**
 * Entity types live in `entities.ts`, which is the contract between the sim and
 * its observers. Re-exported here only so existing importers keep working —
 * prefer importing from `./entities` directly.
 */
export type { Bullet, EnemyBullet, EnemyInstance, Explosion, Hull, Interpolated } from './entities'

/** Movement speed in virtual units per second. */
/**
 * DEPRECATED FALLBACKS.
 *
 * These are shadowed by `STATS` in stats.ts, which is where the live values now
 * live — `resolvedStats.hullSpeed ?? HULL_SPEED` only reaches the constant if the
 * stat table is missing a key, which the closed `StatKey` union prevents.
 *
 * Discovered by mutating this file to prove the sim-version guard worked: changing
 * HULL_SPEED changed nothing at all, because nothing reads it. A constant that looks
 * authoritative and is not is worse than no constant — the next person to tune hull
 * speed edits it and measures no effect.
 *
 * Kept only as `??` fallbacks so a malformed resolve cannot produce NaN, and marked
 * so nobody tunes them by mistake.
 */
const HULL_SPEED = 210
/** Multiplier applied while the focus key is held, for precise threading. */
const FOCUS_FACTOR = 0.45
/**
 * Ticks between shots. 3 ticks at 60Hz is 20 shots/second.
 *
 * The muzzles alternate rather than firing together. Simultaneous twin shots
 * rendered as two parallel columns with gaps between volleys, which read as pairs
 * of tally marks marching up the screen instead of as gunfire. Alternating puts
 * the same rate into one interleaved stream.
 */
const FIRE_INTERVAL_TICKS = 3

/**
 * Shots per second, derived from the tick rate so the HUD cannot drift out of
 * sync with the simulation. An earlier build displayed 10.0 shots/s while
 * actually firing 20 — it was showing volleys and calling them shots.
 */
export const SHOTS_PER_SECOND = TICK_HZ / FIRE_INTERVAL_TICKS

/** Horizontal offset of each muzzle from the hull centreline. */
const MUZZLE_OFFSET = 4.5
const BULLET_SPEED = 620
const BULLET_DAMAGE = 4
const BULLET_RADIUS = 2.5

/** Half-extents of the *drawn* hull. The hitbox is much smaller — see damage.ts. */
const HULL_HALF_W = 11
const HULL_HALF_H = 14

const HULL_INTEGRITY = 100
const HULL_SHIELD = 40

/**
 * Explosions are cosmetic, but they are sim state because they must be identical
 * in a replay. Capped so a chain of deaths can't grow the array without bound.
 */
const MAX_EXPLOSIONS = 48
const EXPLOSION_BASE_TICKS = 18
const HULL_EXPLOSION_TICKS = 48
const HULL_EXPLOSION_RADIUS = 34

/**
 * Ceiling on events emitted in one tick.
 *
 * Sized against the worst legitimate tick: a screen-clearing moment can retire
 * every live enemy at once, and each death emits a hit, a kill, and a scrap award.
 * Past this we DROP the excess rather than growing the array, because a tick that
 * wanted 300 events is a tick with a hundred simultaneous deaths, and the
 * difference between 256 and 300 sound triggers is inaudible while an unbounded
 * array in the hot path is not. This is stated here rather than left as a silent
 * truncation: presentation may be missing events on such a tick, so nothing
 * downstream may treat the event stream as a complete audit log — `stats` is the
 * authority on counts, this is the authority on *when*.
 */
const MAX_EVENTS_PER_TICK = 256

/**
 * Shake decays geometrically, and snaps to exactly zero below the epsilon.
 *
 * 0.86/tick puts a full-strength impulse under the epsilon in about 0.7s, which
 * outlasts the hitstop it arrived with without lingering into the next fight. The
 * epsilon matters for more than tidiness: without it `shake` would approach zero
 * asymptotically and never reach it, so "is the screen shaking" would be true
 * forever and the cosmetic digest would never settle.
 */
const SHAKE_DECAY_PER_TICK = 0.86
const SHAKE_EPSILON = 0.002

/**
 * Content the run draws items from.
 *
 * Injected rather than imported so tests can fabricate items — the same reason
 * combat.test.ts fabricates enemy defs instead of asserting against the live
 * content tables. A balance change must not be able to break a sim test.
 */
export interface RunContent {
  items: Readonly<Record<string, ItemDef>>
  interactions: readonly InteractionDef[]
  /**
   * Work-order kinds this run may be offered.
   *
   * Injected rather than hardcoded so a certification that unlocks a work-order type
   * actually changes the game. It was a literal `['supply','hazard','repair']` here,
   * which meant two certifications with authored copy and passing tests could never
   * have any effect — the kind of dead feature that looks finished from every angle
   * except playing it.
   *
   * Defaults to the base three when omitted, so sim tests need not know about
   * certifications at all.
   */
  workOrders?: readonly string[]

  /**
   * The hull this run was issued.
   *
   * Optional, and omitting it means the stat table's bases — which is exactly what
   * the Lien is, so a sim test that does not care about hulls gets the baseline ship
   * without having to import one.
   */
  hull?: HullDef

  /**
   * The stage sequence. Defaults to a single sector-one stage with no boss.
   *
   * Injected for the same reason items are: a five-sector run is a *balance*
   * decision, and no sim test should break because a sector was retuned.
   */
  run?: RunDef
  sectors?: Readonly<Record<string, SectorDef>>
  bosses?: Readonly<Record<string, BossDef>>
  hazards?: Readonly<Record<string, HazardDef>>
}

export const EMPTY_CONTENT: RunContent = { items: {}, interactions: [] }

/**
 * The run a World flies when content supplies none: sector one, alone.
 *
 * This is what every pre-M5 test expects, and keeping it as the default is what let
 * multi-sector runs land without re-recording the entire replay corpus for reasons
 * unrelated to the change being tested.
 */
export const SINGLE_SECTOR_RUN: RunDef = {
  id: 'single',
  name: 'Shakedown',
  stages: [{ sectorId: SECTOR_ONE.id, bossId: null, hazardIds: [] }],
}

/** The work orders every run has, certified or not. Mirrors BASE_POOL.workOrders. */
export const BASE_WORK_ORDERS: readonly string[] = ['supply', 'hazard', 'repair']

export class World implements WorldView {
  readonly seed: string

  runState: RunState = 'active'
  readonly hull: Hull
  readonly playerBullets: Bullet[] = []
  readonly enemyBullets: AttributedEnemyBullet[] = []
  readonly enemies: EnemyInstance[] = []
  readonly explosions: Explosion[] = []
  incident: Incident | null = null

  /** Cleared at the top of every tick — see SimEvent. Drain per tick, not per frame. */
  readonly events: SimEvent[] = []
  readonly cosmetic: CosmeticState = { shake: 0 }

  /**
   * Ticks of hitstop remaining. See WorldView.freezeTicks.
   *
   * Consumes real ticks: `stats.tick` still advances during a freeze, so a
   * recorded input log keeps mapping 1:1 onto ticks and the wave script keeps its
   * schedule. A freeze delays a wave's *release* by at most FREEZE_MAX_TICKS,
   * because Spawner.update releases everything due at or before the tick it is
   * handed; it can never skip one.
   */
  freezeTicks = 0

  readonly stats: RunStats = {
    tick: 0,
    shotsFired: 0,
    hits: 0,
    kills: 0,
    scrap: 0,
    damageTaken: 0,
    waveIndex: 0,
    peakProjectiles: 0,
    bulletsCulled: 0,
  }

  /**
   * One Rng per concern. Splitting streams means adding a cosmetic effect can
   * never shift which items drop, so recorded replays survive visual work. A new
   * random concern gets a new stream; it never borrows an existing one.
   */
  private readonly rngSpawn: Rng
  private readonly rngLoot: Rng

  /**
   * Enemy defs for this run — a COPY of the content table, not the table itself.
   *
   * Boss phases are compiled into derived defs and registered here at spawn time
   * (see sim/bosses.ts). Registering them into the shared `ENEMIES` object would
   * leak one run's boss into every other World in the process, which in a test file
   * means the third test in a suite sees enemies the first one invented.
   */
  private readonly enemyDefs: Record<string, EnemyDef> = { ...ENEMIES }
  private spawner: Spawner
  /** Earliest tick the current stage may be declared complete. Absolute, not relative. */
  private extractionTick: number
  /** Tick the current stage began, so the wave script keeps sector-relative timing. */
  private stageStartTick = 0

  /**
   * Fractional shot accumulator, in ticks.
   *
   * NOT an integer countdown. `fireIntervalTicks` has a base of 3, so an integer
   * cooldown cannot express any percentage change to fire rate at all — 3/1.18
   * rounds straight back to 3, which silently turns every percentage fire-rate item
   * into a no-op. (That is why a `mul` on this stat had to be banned in content.)
   *
   * Accumulating whole ticks against a fractional interval gives the correct
   * *average* rate while still firing on tick boundaries, and subtracting the
   * interval rather than resetting to zero means the remainder carries and the rate
   * does not drift. Float arithmetic is deterministic, so replays are unaffected.
   *
   * Starts one short of full: the tick's own increment tops it up, so the first
   * trigger pull fires on the tick it is pressed *and* the cadence that follows is
   * exact. Starting at zero made the weapon spend three ticks charging its first
   * shot (input lag on the very first thing a player does); starting at exactly full
   * overshot by one and produced 21 shots a second where the HUD said 20.
   */
  private fireAccumulator = FIRE_INTERVAL_TICKS - 1
  private nextMuzzleIsLeft = true

  // --- items ---------------------------------------------------------------

  inventory: HeldItem[] = []
  activeInteractions: readonly ActiveInteraction[] = []
  resolvedStats: ResolvedStats = resolveAllStats([])
  pendingChoice: PendingChoice | null = null

  private readonly content: RunContent
  /**
   * Numeric effect parameters, recomputed only when the inventory changes.
   *
   * Every M3 effect is an aggregation, so this cannot depend on dispatch order —
   * see the header of itemEffects.ts before adding a stateful one.
   */
  private effects: EffectTotals = { ...NO_EFFECTS }
  private cursor: ChoiceCursor = newCursor()
  /** Ticks remaining on a scrap-triggered fire-rate window. */
  private fireRateWindowTicks = 0
  /** Wave indices already used for a reward, so one wave cannot pay twice. */
  private readonly rewardedWaves = new Set<number>()

  /**
   * Its own stream. `loot` was reserved for item drops, but offers and shop stock
   * are separate decisions, and a stream shared between them would make the shop's
   * stock depend on how many offers had been rolled.
   */
  private readonly rngOffers: Rng
  /** Item effect rolls. Separate so a repair roll cannot shift spawns or offers. */
  private readonly rngItems: Rng
  /** Which approach options a transition offers. Its own stream — see the field docs above. */
  private readonly rngRoute: Rng
  /** Hazard positioning. Never `spawn`, or arming a hazard would shift every wave. */
  private readonly rngHazard: Rng
  /** Boss variant selection, so learning one form is not learning the fight. */
  private readonly rngBoss: Rng

  // --- the run -------------------------------------------------------------

  private readonly runDef: RunDef
  private readonly sectorDefs: Readonly<Record<string, SectorDef>>
  private readonly bossDefs: Readonly<Record<string, BossDef>>
  private readonly hazardDefs: Readonly<Record<string, HazardDef>>
  private readonly hullDef: HullDef | null

  private stageIndex = 0
  private hazardField = new HazardField([])
  private hazardViews: readonly HazardView[] = []
  /** The live boss, if one has been spawned and is still alive. */
  private bossRef: EnemyInstance | null = null
  private bossSpawned = false

  /**
   * Where the run is in a between-sector transition.
   *
   * Modelled as a sequence of ordinary pending choices rather than as a `runState`,
   * which was the first design and the wrong one: `pendingChoice` already pauses the
   * simulation, the choice machinery already handles input edges and the held-trigger
   * rescue, and a fourth run state would have meant every consumer of `runState`
   * learning about a case that is really just "a card is open".
   */
  private transition: 'none' | 'route' | 'reward' | 'shop' = 'none'
  /** Hazards the chosen route arms on arrival. */
  private nextHazardIds: readonly string[] = []

  constructor(seed: string, content: RunContent = EMPTY_CONTENT) {
    this.seed = seed
    this.content = content
    this.rngSpawn = Rng.fromSeed(seed, 'spawn')
    this.rngLoot = Rng.fromSeed(seed, 'loot')
    this.rngOffers = Rng.fromSeed(seed, 'offers')
    this.rngItems = Rng.fromSeed(seed, 'items')
    this.rngRoute = Rng.fromSeed(seed, 'route')
    this.rngHazard = Rng.fromSeed(seed, 'hazard')
    this.rngBoss = Rng.fromSeed(seed, 'boss')

    this.runDef = content.run ?? SINGLE_SECTOR_RUN
    this.sectorDefs = content.sectors ?? { [SECTOR_ONE.id]: SECTOR_ONE }
    this.bossDefs = content.bosses ?? {}
    this.hazardDefs = content.hazards ?? {}
    this.hullDef = content.hull ?? null

    // The hull's modifiers must be folded BEFORE the hull entity is built, or a hull
    // that raises maximum integrity would start the run at the base value and be
    // topped up by the refresh — which reads as flying a damaged ship off the pad.
    this.applyResolution(
      resolveInventory([], content.items, content.interactions, this.hullSource()),
    )

    const startX = Playfield.centerX
    const startY = Playfield.h - 110
    this.hull = {
      x: startX,
      y: startY,
      prevX: startX,
      prevY: startY,
      // From the stat table, so an item that raises a maximum and the starting
      // value can never disagree about what the base is.
      integrity: this.resolvedStats.maxIntegrity ?? HULL_INTEGRITY,
      maxIntegrity: this.resolvedStats.maxIntegrity ?? HULL_INTEGRITY,
      shield: this.resolvedStats.maxShield ?? HULL_SHIELD,
      maxShield: this.resolvedStats.maxShield ?? HULL_SHIELD,
      invulnTicks: 0,
      radius: HULL_COLLISION_RADIUS,
    }

    for (const defId of this.hullDef?.startingItems ?? []) this.acquire(defId)
    // Credited directly rather than through `awardScrap`. A hull that states a
    // starting balance must hand over exactly that number, not that number times
    // whatever multiplier the hull itself grants.
    this.stats.scrap += Math.max(0, Math.round(this.hullDef?.startingScrap ?? 0))

    // Assigned in beginStage; declared definite here because TypeScript cannot see
    // through the call, and a stage always exists — a run with no stages is rejected.
    this.spawner = undefined as unknown as Spawner
    this.extractionTick = 0
    this.beginStage(0, [])
  }

  /** Waves released so far in the CURRENT sector. 0 before the first one. */
  get currentWaveIndex(): number {
    return this.spawner.waveIndex
  }

  /** Which sector script is being flown right now. */
  get sectorId(): string {
    return this.currentStage.sectorId
  }

  private get currentStage(): RunStageDef {
    const stage = this.runDef.stages[this.stageIndex]
    if (stage === undefined) {
      throw new Error(`Run "${this.runDef.id}" has no stage ${this.stageIndex}`)
    }
    return stage
  }

  private get currentSector(): SectorDef {
    const sector = this.sectorDefs[this.currentStage.sectorId]
    if (sector === undefined) {
      throw new Error(`Run "${this.runDef.id}" references unknown sector "${this.currentStage.sectorId}"`)
    }
    return sector
  }

  get stage(): StageView {
    const stage = this.currentStage
    const boss = stage.bossId === null ? null : this.bossDefs[stage.bossId]
    return {
      index: this.stageIndex,
      count: this.runDef.stages.length,
      sectorId: stage.sectorId,
      sectorName: this.currentSector.name,
      bossName: boss?.name ?? null,
    }
  }

  get hullName(): string {
    return this.hullDef?.name ?? 'Lien'
  }

  get boss(): EnemyInstance | null {
    return this.bossRef
  }

  get hazards(): readonly HazardView[] {
    return this.hazardViews
  }

  private hullSource(): { id: string; stats?: readonly StatModifier[]; effects?: readonly EffectDef[] } | undefined {
    const hull = this.hullDef
    if (hull === null) return undefined
    return { id: hull.id, stats: hull.stats, ...(hull.effects ? { effects: hull.effects } : {}) }
  }

  /**
   * Start a stage: its wave script, its clock, and whatever hazards the route armed.
   *
   * Wave numbering restarts per sector, which is what keeps the reward schedule in
   * progression.ts (`ITEM_CHOICE_WAVES = [7, 20]`) meaning "twice per sector" rather
   * than "twice per run" — two items a sector across five sectors is the ten-item
   * run its docstring is written against.
   */
  private beginStage(index: number, hazardIds: readonly string[]): void {
    this.stageIndex = index
    const sector = this.currentSector
    this.spawner = new Spawner(sector, this.enemyDefs, this.rngSpawn)
    this.stageStartTick = this.stats.tick
    this.extractionTick = this.stats.tick + Math.round(sector.durationSeconds * TICK_HZ)
    this.rewardedWaves.clear()
    this.stats.waveIndex = 0
    this.bossSpawned = false
    this.bossRef = null

    const defs: HazardDef[] = []
    for (const id of hazardIds) {
      const def = this.hazardDefs[id]
      if (def !== undefined) defs.push(def)
    }
    this.hazardField = new HazardField(defs)
    this.hazardViews = this.hazardField.empty ? [] : this.hazardField.views()
  }

  /**
   * Advance exactly one fixed tick. The only entry point into the sim.
   *
   * Phase order is deliberate. Everything moves before anything collides, so a
   * hit is decided from one consistent set of positions rather than from a mix of
   * old and new ones. Dead things are reaped after collisions so a projectile can
   * only ever connect once.
   *
   * Three things happen on *every* tick, including frozen ones and ones after the
   * run has ended, and the split is the whole design of hitstop:
   *
   *   - `stats.tick` advances. Hitstop spends real ticks, so one input byte still
   *     means one tick and a replay stays reproducible.
   *   - the event list is cleared, because events describe one tick.
   *   - cosmetic countdowns age. Explosions, impact flashes, and shake keep
   *     running through a freeze on purpose: a freeze in which *nothing* on screen
   *     moves reads as a hang, and the point of hitstop is to sell the impact, not
   *     to hide it. It also keeps every cosmetic lifetime bounded in real time
   *     however many freezes overlap it.
   *
   * Everything else — movement, spawning, firing, collision, extraction — is
   * gameplay and does not advance while frozen.
   */
  tick(input: InputSnapshot): void {
    this.stats.tick++
    this.events.length = 0
    this.advanceCosmetic()

    // Read before decrementing: a freeze of n granted while resolving one tick
    // freezes the n ticks that follow it, not n-1 of them.
    const frozen = this.freezeTicks > 0
    if (frozen) this.freezeTicks--

    // A finished run keeps only its cosmetic state running. The incident report is
    // drawn over the frozen playfield, and advancing the wave script behind it
    // would spawn enemies nobody can shoot and inflate the recorded run length.
    if (this.runState !== 'active') return
    if (frozen) return

    // A choice pauses the run. Ticks still advance so a recorded input log stays
    // aligned with wall-clock ticks, but nothing moves, spawns, or shoots — an item
    // choice is a decision, not a reflex test.
    // No advanceCosmetic() here: it already ran at the top of this tick. Calling it
    // again aged explosions, hit flashes, and shake at DOUBLE speed behind the
    // reward card — an 18-tick explosion lasted 9.
    if (this.updateChoice(input)) return

    if (this.fireRateWindowTicks > 0) this.fireRateWindowTicks--

    tickHullInvulnerability(this.hull)
    this.moveHull(input)
    this.updateWeapon(input)

    this.updateHazards()

    // Sector-relative. A wave written for t+45s must release 45 seconds into ITS
    // sector, not 45 seconds into the run — the absolute tick would have made every
    // sector after the first release its entire script on the first tick.
    const wavesBefore = this.spawner.waveIndex
    this.spawner.update(this.stats.tick - this.stageStartTick, this.enemies)
    this.stats.waveIndex = this.spawner.waveIndex
    this.maybeOpenChoice()
    // One event per wave, even if the script releases two on the same tick.
    for (let i = wavesBefore + 1; i <= this.stats.waveIndex; i++) {
      this.emit({ kind: 'wave-released', index: i })
    }

    this.updateEnemies()
    this.advanceAllProjectiles()

    this.resolvePlayerBulletHits()
    this.resolveEnemyBulletHits()
    this.resolveContact()

    this.reapEnemies()
    this.checkStageComplete()

    const live = this.playerBullets.length + this.enemyBullets.length
    if (live > this.stats.peakProjectiles) this.stats.peakProjectiles = live
  }

  // --- items ---------------------------------------------------------------

  /**
   * Fire interval after items and any active scrap window.
   *
   * The window is a flat tick reduction rather than a multiplier so it cannot
   * interact multiplicatively with a fire-rate item and collapse the interval to
   * its floor — a build that reaches the floor stops responding to further
   * upgrades, which reads as the item being broken.
   */
  private currentFireInterval(): number {
    const base = this.resolvedStats.fireIntervalTicks ?? FIRE_INTERVAL_TICKS
    // `bonus` is a FRACTIONAL RATE increase, not a tick count — content authors
    // "+18% fire rate" as 0.18, matching the worked example in UI.md rule 4. A rate
    // increase divides the interval; subtracting it as ticks made the item a no-op.
    const bonus = this.fireRateWindowTicks > 0 ? this.effects.fireRateWindowBonus : 0
    const interval = bonus > 0 ? base / (1 + bonus) : base
    return Math.max(1, interval)
  }

  /**
   * The open choice's selected index.
   *
   * The cursor lives in the simulation so a recorded run reproduces its picks; the
   * screen renders this rather than holding a selection of its own, which is what
   * keeps the two from disagreeing about what is highlighted.
   */
  get choiceSelection(): number {
    // -1 rather than 0 when nothing is open. Zero is a real index, so a screen or a
    // digest could not tell "option one is highlighted" from "there is no card".
    return this.pendingChoice === null ? -1 : this.cursor.index
  }

  /**
   * True while the card is open and the trigger has never been released.
   *
   * The screen shows a "release to choose" hint from this. Without it the card looks
   * frozen to anyone holding fire, which is the state most players are in.
   */
  get choiceAwaitingRelease(): boolean {
    return this.pendingChoice !== null && this.cursor.awaitingRelease
  }

  /**
   * What an open card will do on its own if the player does nothing.
   *
   * Derived here rather than in each screen so all four card kinds count the same
   * thing down. See ChoiceResolveView for why this needs to be visible at all.
   */
  get choiceResolve(): ChoiceResolveView | null {
    if (this.pendingChoice === null) return null
    // The dwell only applies while the trigger has been held since the card opened.
    // Once it has been released the card is in ordinary edge-triggered mode and the
    // only automatic outcome left is the timeout.
    if (this.cursor.awaitingRelease) {
      return {
        action: 'confirm',
        ticksRemaining: Math.max(0, HELD_CONFIRM_DWELL_TICKS - this.cursor.openTicks),
        totalTicks: HELD_CONFIRM_DWELL_TICKS,
      }
    }
    return {
      action: 'skip',
      ticksRemaining: Math.max(0, CHOICE_TIMEOUT_TICKS - this.cursor.openTicks),
      totalTicks: CHOICE_TIMEOUT_TICKS,
    }
  }

  /** Shots per second the HUD should display. Derived, never hand-written. */
  get shotsPerSecond(): number {
    return shotsPerSecond(this.currentFireInterval())
  }

  /**
   * Credit scrap through the economy multiplier.
   *
   * Every scrap gain goes through here. `scrapMultiplier` had no consumer at first,
   * which made the economy item silently inert — a stat nothing reads is worse than
   * a missing stat, because the item ships and does nothing.
   */
  private awardScrap(amount: number): void {
    const multiplier = this.resolvedStats.scrapMultiplier ?? 1
    const credited = Math.max(0, Math.round(amount * multiplier))
    this.stats.scrap += credited
    // Opens the fire-rate window. Without this the window ticks down from zero
    // forever and a scrap-triggered item never fires at all.
    if (this.effects.fireRateWindowTicks > 0) {
      this.fireRateWindowTicks = this.effects.fireRateWindowTicks
    }
  }

  /** Restore integrity on a kill, if an item grants it. */
  private repairOnKill(): void {
    const amount = this.effects.repairAmount
    if (amount <= 0) return
    const chance = this.effects.repairChance
    // Its own stream, so a repair roll cannot shift spawns, loot, or offers.
    if (chance < 1 && !this.rngItems.chance(chance)) return
    this.hull.integrity = clamp(this.hull.integrity + amount, 1, this.hull.maxIntegrity)
  }

  /**
   * Release retaliation fire when the hull loses INTEGRITY.
   *
   * Fires an even ring. Not on every hit — on every hit that got through the shield,
   * which is what `retaliation-coil`'s card says ("Shields absorb first, so it fires
   * only on integrity loss") and what the Cursed Hull / Heavy Shield anti-synergy in
   * docs/DESIGN.md is reasoned from.
   *
   * THIS WAS A LIE FOR A WHILE. The caller fired it on any hit `applyHullDamage`
   * accepted, including one a full shield absorbed entirely, so the item's own text
   * and the simulation disagreed — and DESIGN.md's argument for why you should NOT
   * pair this with a shield item was built on behaviour the game did not have. Found
   * by a content author trying to write a second retaliation item and discovering
   * that either one of them would have to be wrong on screen.
   *
   * The honest limitation that remains: a larger shield means strictly FEWER
   * triggers, which is a real anti-synergy. Expressing the opposite — something that
   * pays out *when the shield absorbs* — still needs an `onShieldAbsorbed` hook that
   * does not exist.
   */
  private retaliate(): void {
    const count = this.effects.retaliateCount
    if (count <= 0) return
    const speed = this.resolvedStats.projectileSpeed ?? BULLET_SPEED
    const damage = this.resolvedStats.projectileDamage ?? BULLET_DAMAGE
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2
      spawnPlayerBullet(
        this.playerBullets,
        this.hull.x,
        this.hull.y,
        Math.sin(angle) * speed * 0.7,
        -Math.cos(angle) * speed * 0.7,
        damage,
        BULLET_RADIUS,
      )
    }
  }

  /** Store a resolution. Split out so the constructor can fold the hull before a Hull exists. */
  private applyResolution(resolution: InventoryResolution): void {
    this.resolvedStats = resolution.stats
    this.activeInteractions = resolution.active
    this.effects = summariseEffects(resolution.effects)
  }

  /** Recompute everything the inventory determines. Called only when it changes. */
  private refreshInventory(): void {
    this.applyResolution(
      resolveInventory(
        this.inventory,
        this.content.items,
        this.content.interactions,
        this.hullSource(),
      ),
    )

    // Raising a maximum grants the difference rather than refilling the pool:
    // +20 max integrity on a hull at 30/100 should leave it at 50/120, not 120/120,
    // or a defence item would double as a full repair.
    const maxIntegrity = this.resolvedStats.maxIntegrity ?? this.hull.maxIntegrity
    if (maxIntegrity !== this.hull.maxIntegrity) {
      const delta = maxIntegrity - this.hull.maxIntegrity
      this.hull.maxIntegrity = maxIntegrity
      this.hull.integrity = clamp(this.hull.integrity + Math.max(0, delta), 1, maxIntegrity)
    }
    const maxShield = this.resolvedStats.maxShield ?? this.hull.maxShield
    if (maxShield !== this.hull.maxShield) {
      const delta = maxShield - this.hull.maxShield
      this.hull.maxShield = maxShield
      this.hull.shield = clamp(this.hull.shield + Math.max(0, delta), 0, maxShield)
    }
  }

  /** Take an item. The only way the inventory grows. */
  private acquire(defId: string): void {
    this.inventory = addItem(this.inventory, defId, this.stats.tick) as HeldItem[]
    this.refreshInventory()
  }

  /**
   * Open a reward if this wave is a scheduled one.
   *
   * Guarded by `rewardedWaves` so a wave cannot pay twice — waves can be released
   * more than once per tick after a hitstop, and paying per release rather than per
   * wave would hand out a reward for every frame the spawner caught up on.
   */
  private maybeOpenChoice(): void {
    if (this.pendingChoice !== null) return
    const latest = this.stats.waveIndex
    if (latest <= 0) return

    // Scan every unrewarded wave up to the latest, not just the latest itself. If
    // two waves ever release on one tick and the earlier is a reward wave, reading
    // only the newest index would silently skip its reward. Unreachable in sector 1
    // — no shared release ticks, and a freeze is at most 8 ticks against 300-tick
    // spacing — but a denser script would hit it, and a lost reward is invisible.
    let wave = -1
    for (let candidate = 1; candidate <= latest; candidate++) {
      if (this.rewardedWaves.has(candidate)) continue
      if (
        ITEM_CHOICE_WAVES.includes(candidate) ||
        SHOP_WAVES.includes(candidate) ||
        WORK_ORDER_WAVES.includes(candidate)
      ) {
        wave = candidate
        break
      }
      // Not a reward wave: mark it so the scan does not re-walk it every tick.
      this.rewardedWaves.add(candidate)
    }
    if (wave < 0) return

    const isShop = SHOP_WAVES.includes(wave)
    const isWorkOrder = WORK_ORDER_WAVES.includes(wave)

    this.rewardedWaves.add(wave)
    this.cursor = newCursor()

    if (isWorkOrder) {
      this.pendingChoice = makeChoice(
        'work-order',
        [],
        [],
        this.content.workOrders ?? BASE_WORK_ORDERS,
      )
      return
    }

    const offers = buildOffers(
      this.rngOffers,
      this.content.items,
      this.content.interactions,
      this.inventory,
    )
    // No content to offer (an empty table in a sim test) must not stall the run.
    if (offers.length === 0) return
    this.pendingChoice = makeChoice(
      isShop ? 'shop' : 'item',
      offers,
      isShop ? shopCosts(offers, this.content.items, wave) : offers.map(() => 0),
    )
  }

  /**
   * Resolve an open choice from this tick's input.
   *
   * Returns true while a choice is open, which is what pauses the rest of the
   * tick. Ticks still advance so a recorded input log stays aligned — the run is
   * paused, not stopped.
   */
  private updateChoice(input: InputSnapshot): boolean {
    const choice = this.pendingChoice
    if (choice === null) return false

    const optionCount =
      choice.kind === 'work-order'
        ? choice.workOrders.length
        : choice.kind === 'route'
          ? choice.routes.length
          : choice.offers.length
    const action = updateCursor(this.cursor, input, optionCount)

    if (action.kind === 'skip') {
      // Declining a ROUTE cannot mean "no route" — the run has to go somewhere. It
      // takes the direct approach, which is always option 0 and always the free one,
      // so skipping is the same as choosing the safe option rather than a way to get
      // a reward without its hazard.
      if (choice.kind === 'route') {
        this.takeRoute(choice, 0)
        return true
      }
      this.pendingChoice = null
      this.advanceTransition()
      return true
    }
    if (action.kind !== 'confirm') return true

    if (choice.kind === 'route') {
      this.takeRoute(choice, action.index)
      return true
    }

    if (choice.kind === 'work-order') {
      // Work orders currently record the assignment without altering the sector.
      // The between-sector routing they were designed for now exists as the world
      // map (see beginTransition); these in-sector ones are the M3 placement and
      // still change nothing. See WorkOrderKind in content/types.ts.
      this.pendingChoice = null
      return true
    }

    const offer = choice.offers[action.index]
    const cost = choice.costs[action.index] ?? 0
    if (!offer) return true
    if (cost > this.stats.scrap) {
      // Silently ignoring an unaffordable pick would read as the button not working.
      // The UI greys it out; this is the backstop, and a deliberate press stays a
      // no-op so the player can navigate to something they can afford.
      //
      // But a confirm from the held-trigger DWELL cannot be left as a no-op. Nobody
      // pressed anything, so nothing will change on the next tick either, and the card
      // re-confirms and is re-refused every tick until the 20-second timeout — an
      // unresponsive card, which is exactly the soft freeze the dwell was added to
      // fix. A rescue that cannot complete has to decline instead of looping.
      if (!action.fromDwell) return true
      this.pendingChoice = null
      this.advanceTransition()
      return true
    }

    this.stats.scrap -= cost
    this.acquire(offer.defId)
    this.pendingChoice = null
    this.advanceTransition()
    return true
  }

  /** Commit to an approach: arm its hazards, pay its reward, move the sequence on. */
  private takeRoute(choice: PendingChoice, index: number): void {
    const route = choice.routes[index] ?? choice.routes[0]
    this.pendingChoice = null
    if (route === undefined) {
      this.advanceTransition()
      return
    }
    this.nextHazardIds = route.hazardIds
    this.payRouteReward(route.reward)
    this.advanceTransition()
  }

  // --- phases ---------------------------------------------------------------

  private moveHull(input: InputSnapshot): void {
    const hull = this.hull
    hull.prevX = hull.x
    hull.prevY = hull.y

    // Resolved, not constant: mobility items change this and the HUD reads the
    // same number the sim uses.
    const base = this.resolvedStats.hullSpeed ?? HULL_SPEED
    const focus = this.resolvedStats.focusFactor ?? FOCUS_FACTOR
    // An interdiction field slows the hull for the length of its active window. It
    // multiplies the *resolved* speed rather than clamping it, so a mobility build
    // still moves faster under interdiction than a stock hull does — a hazard that
    // flattened every build to the same speed would make the stat worthless in any
    // sector that has one.
    const speed = base * this.hazardField.speedFactor() * (input.focus ? focus : 1) * TICK_SECONDS
    let dx = input.moveX
    let dy = input.moveY
    // Normalise diagonals so corner-running isn't 41% faster than straight lines.
    if (dx !== 0 && dy !== 0) {
      const inv = Math.SQRT1_2
      dx *= inv
      dy *= inv
    }

    // Clamped by the drawn silhouette, not the hitbox: the ship must never look
    // like it is hanging off the edge of the playfield.
    hull.x = clamp(hull.x + dx * speed, HULL_HALF_W, Playfield.w - HULL_HALF_W)
    hull.y = clamp(hull.y + dy * speed, HULL_HALF_H, Playfield.h - HULL_HALF_H)
  }

  private updateWeapon(input: InputSnapshot): void {
    const interval = this.currentFireInterval()
    this.fireAccumulator += 1

    // The cap applies only while the trigger is RELEASED. It exists to stop a
    // minute of not shooting banking a burst — but a held trigger cannot bank
    // anything, because it fires the instant the accumulator is full.
    //
    // Capping unconditionally is what made fractional intervals inert: the
    // accumulator was clamped to exactly `interval`, so `-= interval` always landed
    // on zero and the remainder this field's docstring says "carries" was thrown
    // away every shot. Effective period became ceil(interval), so a 2.54-tick
    // interval fired at 20/s while the HUD advertised 23.6 — the panel-lies-about-
    // the-weapon bug for the third time.
    if (!input.fire) {
      // Capped one short of full, not full. The tick's own increment tops it up, so
      // the first press still fires immediately — but capping at exactly `interval`
      // let the accumulator reach interval+1, leaving a remainder of 1 that shifted
      // the whole cadence and produced one extra shot per window. Same reasoning as
      // the field's initial value.
      this.fireAccumulator = Math.min(this.fireAccumulator, interval - 1)
      return
    }
    if (this.fireAccumulator < interval) return

    const offset = this.nextMuzzleIsLeft ? -MUZZLE_OFFSET : MUZZLE_OFFSET
    const muzzleX = this.hull.x + offset
    const muzzleY = this.hull.y - HULL_HALF_H

    const damage = this.resolvedStats.projectileDamage ?? BULLET_DAMAGE
    const speed = this.resolvedStats.projectileSpeed ?? BULLET_SPEED
    // `projectilesPerShot` is a stat (so it folds) and splitShot is an effect (so
    // it stacks); both feed the same fan. The centre shot is always kept dead
    // ahead — see volleyAngles.
    const extra =
      Math.max(1, Math.round(this.resolvedStats.projectilesPerShot ?? 1)) -
      1 +
      this.effects.splitShotCount
    const angles = volleyAngles(extra, this.effects.splitShotSpreadDegrees)

    let fired = false
    for (const angle of angles) {
      const vx = Math.sin(angle) * speed
      const vy = -Math.cos(angle) * speed
      // The first projectile decides whether the volley counted: if the cap refuses
      // the centre shot the cadence must not advance, but a fan losing its outer
      // shots to the cap is a performance limit, not a misfire.
      const ok = spawnPlayerBullet(
        this.playerBullets,
        muzzleX,
        muzzleY,
        vx,
        vy,
        damage,
        BULLET_RADIUS,
      )
      if (angle === 0) fired = ok
    }
    // Refused by the cap: leave the cooldown and the muzzle alone so the cadence
    // resumes cleanly rather than skipping a muzzle and desynchronising the
    // alternating pattern.
    if (!fired) return

    this.fireAccumulator -= interval
    this.nextMuzzleIsLeft = !this.nextMuzzleIsLeft
    this.stats.shotsFired++
    // At the muzzle, not at the hull centre: the flash has to come out of the
    // barrel that actually fired, which is how alternating muzzles read as one
    // stream instead of as a stutter.
    this.emit({ kind: 'player-shot', x: muzzleX, y: muzzleY })
  }

  private updateEnemies(): void {
    const hull = this.hull
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i] as EnemyInstance

      // Phase changes resolve BEFORE the def is read, so the whole tick — movement
      // and weapon both — runs the pattern the health bar says it is running.
      // Resolving it afterwards left the boss executing one last volley from the
      // phase it had already announced leaving.
      if (e.boss !== undefined) {
        keepBossInPlay(e)
        const phase = advanceBossPhase(e, this.enemyDefs)
        if (phase !== null) {
          this.emit({
            kind: 'boss-phase',
            bossId: e.boss.bossId,
            phaseIndex: phase,
            callout: e.boss.callouts[phase] ?? '',
          })
        }
      }

      const def = this.enemyDefs[e.defId]
      // Unknown def ids are rejected when the Spawner is built, so this can only
      // be a programming error; drop the enemy rather than crash a live run.
      if (def === undefined) {
        e.alive = false
        continue
      }
      updateEnemyMovement(e, def)
      if (updateEnemyWeapon(e, def, hull.x, hull.y, this.enemyBullets)) {
        // Volleys only. A death burst is reported by `enemy-killed`, which the
        // renderer and audio already treat as the louder event.
        this.emit({ kind: 'enemy-shot', x: e.x, y: e.y, defId: e.defId })
      }
    }
  }

  private advanceAllProjectiles(): void {
    this.stats.bulletsCulled += advanceProjectiles(this.playerBullets)
    this.stats.bulletsCulled += advanceProjectiles(this.enemyBullets)
  }

  private resolvePlayerBulletHits(): void {
    const bullets = this.playerBullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i] as Bullet
      for (let j = 0; j < this.enemies.length; j++) {
        const e = this.enemies[j] as EnemyInstance
        if (!e.alive) continue
        // Already damaged by this round. A bullet travels ~10 units per tick and a
        // large enemy has a 30-unit radius, so without this a piercing round sat
        // inside its target and hit it again every tick — worth MORE against big
        // enemies, which inverts the item.
        if (b.hitUids !== undefined && b.hitUids.includes(e.uid)) continue
        // Swept against the bullet's path: at 620 units/second a bullet covers
        // ~10 units per tick, enough to step clean over a small enemy.
        if (!segmentHitsCircle(b.prevX, b.prevY, b.x, b.y, e.x, e.y, e.radius + b.radius)) continue

        // Captured before the hit so overkill can be measured: damage beyond what
        // was needed is the difference, and after the fact the hp is already gone.
        const hpBefore = e.hp
        const lethal = applyEnemyDamage(e, b.damage)
        this.stats.hits++
        if (lethal && this.effects.overkillFraction > 0) {
          const overkill = Math.max(0, b.damage - hpBefore)
          if (overkill > 0) this.awardScrap(overkill * this.effects.overkillFraction)
        }
        this.chainFrom(e, b.damage, j)
        // Reported at the bullet, not at the target's centroid: the spark belongs
        // where the round landed. A 30-unit hauler flashing at its centre reads as
        // a hit on empty space. The bullet is inside the target by definition here,
        // so this is never more than a radius away from it.
        this.emit({
          kind: 'enemy-hit',
          x: b.x,
          y: b.y,
          damage: b.damage,
          defId: e.defId,
          lethal,
        })
        this.addImpact(freezeForEnemyHit(b.damage, lethal), shakeForEnemyHit(b.damage, lethal))

        // Piercing: the round continues through this target. Tracked per bullet so
        // it cannot hit the same enemy twice — without that a pierce shot sitting on
        // a large hauler would tick it down every frame.
        const pierced = b.pierceRemaining ?? this.effects.pierceCount
        if (pierced > 0) {
          b.pierceRemaining = pierced - 1
          if (b.hitUids === undefined) b.hitUids = [e.uid]
          else b.hitUids.push(e.uid)
          continue
        }
        b.alive = false
        break
      }
    }
    cullDead(bullets)
  }

  /**
   * Arc damage from a hit to nearby enemies.
   *
   * Skips the target that was already hit, deals a fraction of the original damage,
   * and never chains from a chain — a recursive version turns one shot into a
   * screen clear and makes the frame cost unbounded.
   */
  private chainFrom(source: EnemyInstance, damage: number, sourceIndex: number): void {
    const count = this.effects.chainCount
    if (count <= 0) return
    const radius = this.effects.chainRadius
    const share = damage * this.effects.chainFraction
    if (radius <= 0 || share <= 0) return

    let arced = 0
    for (let k = 0; k < this.enemies.length && arced < count; k++) {
      if (k === sourceIndex) continue
      const other = this.enemies[k] as EnemyInstance
      if (!other.alive) continue
      const dx = other.x - source.x
      const dy = other.y - source.y
      if (dx * dx + dy * dy > radius * radius) continue

      const hpBefore = other.hp
      const lethal = applyEnemyDamage(other, share)
      arced++
      this.emit({
        kind: 'enemy-hit',
        x: other.x,
        y: other.y,
        damage: share,
        defId: other.defId,
        lethal,
      })
      if (lethal && this.effects.overkillFraction > 0) {
        const overkill = Math.max(0, share - hpBefore)
        if (overkill > 0) this.awardScrap(overkill * this.effects.overkillFraction)
      }
    }
  }

  private resolveEnemyBulletHits(): void {
    const hull = this.hull
    const bullets = this.enemyBullets
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i] as AttributedEnemyBullet
      if (!circlesOverlap(b.x, b.y, b.radius, hull.x, hull.y, hull.radius)) continue
      const shieldBefore = hull.shield
      const integrityBefore = hull.integrity
      // A bullet that arrives during invulnerability passes straight through
      // instead of being consumed — otherwise getting hit would clear the screen
      // and the safest play would be to take a hit on purpose.
      if (applyHullDamage(this, b.damage, b.causeKind, b.sourceDefId)) {
        b.alive = false
        this.onHullHit(b.damage, shieldBefore, integrityBefore)
        break
      }
    }
    cullDead(bullets)
  }

  private resolveContact(): void {
    const hull = this.hull
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i] as EnemyInstance
      if (!e.alive) continue
      if (!circlesOverlap(e.x, e.y, e.radius, hull.x, hull.y, hull.radius)) continue
      const shieldBefore = hull.shield
      const integrityBefore = hull.integrity
      if (!applyHullDamage(this, e.contactDamage, 'collision', e.defId)) continue

      // Ramming is mutual, for every enemy, with no per-shape exception: it turns
      // a collision into a costly trade instead of letting an enemy park on the
      // hull and chip it once per invulnerability window. Death bursts still fire,
      // which is what makes a mine a mine without the sim knowing about mines.
      e.alive = false
      // The ram gets the hull hit's impact and no separate kill impact. That is not
      // an oversight: taking contact damage already freezes harder than any kill,
      // and `addImpact` takes the longer freeze rather than summing them.
      this.onHullHit(e.contactDamage, shieldBefore, integrityBefore)
      break
    }
  }

  private reapEnemies(): void {
    const enemies = this.enemies
    for (let i = enemies.length - 1; i >= 0; i--) {
      const e = enemies[i] as EnemyInstance
      const destroyed = !e.alive
      // A boss is never culled for leaving play — it comes back around instead (see
      // keepBossInPlay). Without this exception a `swoop` phase would end the fight
      // by diving off the bottom of the screen, a win condition nobody chose.
      if (!destroyed && (e.boss !== undefined || !isEnemyOutOfPlay(e))) continue

      if (destroyed) {
        if (e.boss !== undefined) {
          this.emit({ kind: 'boss-killed', x: e.x, y: e.y, bossId: e.boss.bossId })
          this.bossRef = null
        }
        const def = this.enemyDefs[e.defId]
        if (def !== undefined) fireDeathBurst(e, def, this.enemyBullets)
        this.stats.kills++
        this.awardScrap(e.scrap)
        this.repairOnKill()
        // Shape only selects which explosion the renderer draws; it changes no
        // behaviour, so this stays a presentation mapping rather than a rule.
        const kind: ExplosionKind = e.shape === 'mine' ? 'mine' : 'enemy'
        this.spawnExplosion(e.x, e.y, kind, e.radius * 2.4, EXPLOSION_BASE_TICKS + Math.min(14, e.radius))
        this.emit({
          kind: 'enemy-killed',
          x: e.x,
          y: e.y,
          defId: e.defId,
          scrap: e.scrap,
          elite: e.elite,
        })
        // There is no pickup entity yet: scrap is credited at the kill, so that is
        // where it is collected and where the label belongs. When M3 adds dropped
        // scrap this moves to the pickup and stops coinciding with the kill.
        if (e.scrap > 0) {
          this.emit({ kind: 'scrap-collected', x: e.x, y: e.y, amount: e.scrap })
        }
      }
      // Enemies that simply left the playfield award nothing. Letting a wave
      // escape has to cost something, or ignoring everything would be optimal.

      enemies[i] = enemies[enemies.length - 1] as EnemyInstance
      enemies.pop()
    }
  }

  /**
   * Age everything that exists only to be looked at. Runs on every tick — frozen,
   * active, or after the run has ended. See `tick`.
   */
  private advanceCosmetic(): void {
    const list = this.explosions
    for (let i = list.length - 1; i >= 0; i--) {
      const x = list[i] as Explosion
      x.age++
      if (x.age >= x.lifetime) {
        list[i] = list[list.length - 1] as Explosion
        list.pop()
      }
    }

    for (let i = 0; i < this.enemies.length; i++) {
      ageEnemyCosmetics(this.enemies[i] as EnemyInstance)
    }

    const shake = this.cosmetic.shake * SHAKE_DECAY_PER_TICK
    this.cosmetic.shake = shake < SHAKE_EPSILON ? 0 : shake
  }

  private checkStageComplete(): void {
    // "The sector ends when the script is done and play is clear" — see
    // SectorDef.durationSeconds. All three conditions matter: ending on the timer
    // alone would strand a live wave, and ending on an empty field alone would
    // end the sector in the gap between waves.
    //
    // A pilot who dies on the same tick the sector would have completed is dead,
    // not extracted. Losing outranks winning.
    if (this.runState !== 'active') return
    if (this.pendingChoice !== null) return
    if (!this.spawner.finished) return
    // The boss counts as a live enemy once it exists, so this also holds the stage
    // open for the whole fight.
    if (this.enemies.length > 0) return

    // Spawned only into an already-clear field. A boss arriving on top of the last
    // wave of a sector is two fights at once, and neither is readable.
    const bossId = this.currentStage.bossId
    if (bossId !== null && !this.bossSpawned) {
      this.spawnBoss(bossId)
      return
    }
    if (this.stats.tick < this.extractionTick) return

    this.emit({ kind: 'stage-cleared', stageIndex: this.stageIndex })

    if (this.stageIndex + 1 >= this.runDef.stages.length) {
      this.runState = 'extracted'
      return
    }
    this.beginTransition()
  }

  private spawnBoss(bossId: string): void {
    const def = this.bossDefs[bossId]
    // A stage naming a boss that does not exist must not silently become a stage
    // with no boss — but it must not hang the run either. Log-free sims cannot warn,
    // so the honest compromise is to proceed and let the content test catch it.
    if (def === undefined) {
      this.bossSpawned = true
      return
    }

    const form: BossForm = pickVariant(def, this.rngBoss)
    for (const phaseDef of deriveBossDefs(def, form)) {
      this.enemyDefs[phaseDef.id] = phaseDef
    }
    // Uid from the spawner's sequence, so a boss and an enemy can never collide and
    // make a piercing round skip one of them.
    const instance = createBoss(def, form, this.enemyDefs, this.spawner.takeUid(), Playfield.centerX)
    this.enemies.push(instance)
    this.bossRef = instance
    this.bossSpawned = true
    this.emit({ kind: 'boss-spawned', bossId: def.id, name: form.name })
  }

  // --- between sectors -------------------------------------------------------

  /**
   * Open the world map, or skip straight past it when there is nothing to choose.
   *
   * A stage with no hazards has nothing to price a reward against, so `buildRoutes`
   * returns nothing and the run goes directly to the shop. Showing a card whose only
   * action is "continue" teaches the player that stopping is pointless — the same
   * mistake the wave-8 shop made, where every visit was a forced decline.
   */
  private beginTransition(): void {
    const nextIndex = this.stageIndex + 1
    const nextStage = this.runDef.stages[nextIndex]
    if (nextStage === undefined) {
      this.runState = 'extracted'
      return
    }

    const sector = this.sectorDefs[nextStage.sectorId]
    const boss = nextStage.bossId === null ? null : this.bossDefs[nextStage.bossId]
    const hazards: HazardDef[] = []
    for (const id of nextStage.hazardIds) {
      const def = this.hazardDefs[id]
      if (def !== undefined) hazards.push(def)
    }

    const routes = buildRoutes(
      this.rngRoute,
      nextIndex,
      sector?.name ?? nextStage.sectorId,
      boss?.name ?? null,
      hazards,
      this.hull.maxIntegrity,
    )

    this.nextHazardIds = []
    if (routes.length === 0) {
      this.transition = 'route'
      this.advanceTransition()
      return
    }
    this.transition = 'route'
    this.cursor = newCursor()
    this.pendingChoice = makeChoice('route', [], [], [], routes)
  }

  /**
   * Move to the next step of the between-sector sequence.
   *
   * route -> (item, if the route paid one) -> shop -> next sector. Each step is an
   * ordinary pending choice, and a step with nothing to offer falls straight through
   * rather than opening an empty card.
   */
  private advanceTransition(): void {
    switch (this.transition) {
      case 'route':
        this.transition = 'reward'
        if (this.openItemChoice('item', 0)) return
        this.advanceTransition()
        return

      case 'reward':
        this.transition = 'shop'
        if (this.openItemChoice('shop', this.stageIndex + 1)) return
        this.advanceTransition()
        return

      case 'shop':
        this.transition = 'none'
        this.beginStage(this.stageIndex + 1, this.nextHazardIds)
        return

      case 'none':
        return
    }
  }

  /**
   * Whether the transition currently owes the pilot a free item.
   *
   * Cleared as it is read, so a route reward cannot be collected twice if the
   * sequence is ever re-entered.
   */
  private routeItemOwed = false

  /** Open an offer card. Returns false when there is nothing to show. */
  private openItemChoice(kind: 'item' | 'shop', stageForPricing: number): boolean {
    if (kind === 'item' && !this.routeItemOwed) return false
    this.routeItemOwed = false

    const offers = buildOffers(
      this.rngOffers,
      this.content.items,
      this.content.interactions,
      this.inventory,
    )
    if (offers.length === 0) return false

    this.cursor = newCursor()
    this.pendingChoice = makeChoice(
      kind,
      offers,
      kind === 'shop' ? transitShopCosts(offers, this.content.items, stageForPricing) : offers.map(() => 0),
    )
    return true
  }

  /** Pay out a route's reward on arrival. Exactly what its `rewardText` promised. */
  private payRouteReward(reward: RouteReward): void {
    switch (reward.kind) {
      case 'none':
        return
      case 'item':
        this.routeItemOwed = true
        return
      case 'scrap':
        // Credited flat, NOT through awardScrap: a card reading "+180 scrap" must pay
        // 180, or a scrap-multiplier item silently makes the screen a liar.
        this.stats.scrap += Math.max(0, Math.round(reward.amount))
        return
      case 'repair':
        this.hull.integrity = clamp(
          this.hull.integrity + Math.max(0, Math.round(reward.amount)),
          1,
          this.hull.maxIntegrity,
        )
        return
    }
  }

  /**
   * Run the hazard cycles and apply anything that fired this tick.
   *
   * Instant kinds act here; sustained kinds (`interdiction`, `blackout`) are read
   * live from the field by whoever cares, so there is no window state to keep in
   * sync with the field's own.
   */
  private updateHazards(): void {
    if (this.hazardField.empty) return
    for (const pulse of this.hazardField.update()) {
      if (pulse.warning) {
        this.emit({ kind: 'hazard-warning', hazardId: pulse.def.id })
        continue
      }
      if (!pulse.fired) continue
      this.emit({ kind: 'hazard-fired', hazardId: pulse.def.id })

      switch (pulse.def.kind) {
        case 'debris':
          spawnDebris(this.enemyBullets, pulse.def, this.rngHazard)
          break

        case 'corrosion': {
          const shieldBefore = this.hull.shield
          const integrityBefore = this.hull.integrity
          if (
            applyHullDamage(this, pulse.def.damage, 'hazard', pulse.def.id, { bypassShield: true })
          ) {
            this.onHullHit(pulse.def.damage, shieldBefore, integrityBefore)
          }
          break
        }

        case 'interdiction':
        case 'blackout':
          // Conditions, not events. Their effect is the active window, read from
          // `speedFactor()` and `blackout` while it lasts.
          break
      }
    }
    this.hazardViews = this.hazardField.views()
  }

  /** True while a blackout is dimming the playfield. Presentation only. */
  get blackout(): boolean {
    return this.hazardField.blackout
  }

  // --- helpers --------------------------------------------------------------

  /**
   * Everything that follows from a hit that actually landed on the hull.
   *
   * Called only when `applyHullDamage` returned true, so an ignored hit (during
   * invulnerability, or after the run ended) produces no event, no shake, and no
   * freeze — the player must never see impact feedback for a hit that did nothing.
   *
   * The shield and integrity readings from *before* the hit are passed in because
   * `absorbedByShield` and the shield-break moment are only visible as a
   * transition, and `applyHullDamage` owns the subtraction.
   */
  private onHullHit(damage: number, shieldBefore: number, integrityBefore: number): void {
    const hull = this.hull
    const fatal = this.runState === 'lost'

    // Only when integrity actually dropped — see `retaliate`. A fatal hit still
    // qualifies (integrity fell to zero), so dying to a ram and taking the rammer
    // with you, which is the fantasy the item sells, is preserved.
    if (hull.integrity < integrityBefore) this.retaliate()

    // Reported at the hull rather than at the projectile: the damage number belongs
    // on the ship (UI rule 9), and both damage paths — fire and ramming — then
    // agree on what the position means.
    this.emit({
      kind: 'hull-hit',
      x: hull.x,
      y: hull.y,
      damage,
      absorbedByShield: hull.integrity === integrityBefore,
    })

    let shake = shakeForHullHit(damage, fatal)
    if (shieldBefore > 0 && hull.shield === 0) {
      this.emit({ kind: 'shield-broken', x: hull.x, y: hull.y })
      shake += SHAKE_SHIELD_BROKEN
    }
    this.addImpact(freezeForHullHit(damage, fatal), shake)

    if (!fatal) return
    if (hull.integrity > 0) return
    this.emit({ kind: 'hull-lost', x: hull.x, y: hull.y })
    this.spawnExplosion(
      hull.x,
      hull.y,
      'hull',
      HULL_EXPLOSION_RADIUS,
      HULL_EXPLOSION_TICKS,
    )
  }

  /**
   * Queue an event for this tick, or drop it at the cap.
   *
   * See MAX_EVENTS_PER_TICK: past the cap the *newest* events are refused rather
   * than shifting the oldest out, because everything in one tick is simultaneous,
   * so there is no "more recent" event to prefer and refusing is O(1).
   */
  private emit(event: SimEvent): void {
    if (this.events.length >= MAX_EVENTS_PER_TICK) return
    this.events.push(event)
  }

  /**
   * Register a hit's feel response. Both rules live in damage.ts — see
   * `extendFreeze` for why the freeze takes the longest rather than the sum.
   *
   * A freeze also cannot be *extended* by damage arriving during it, because no
   * collision, movement, or firing phase runs while frozen: there is nothing that
   * can land a hit to extend it with. That plus the ceiling in `extendFreeze` bounds
   * every freeze at FREEZE_MAX_TICKS, full stop.
   */
  private addImpact(freezeTicks: number, shake: number): void {
    this.freezeTicks = extendFreeze(this.freezeTicks, freezeTicks)
    this.cosmetic.shake = addShake(this.cosmetic.shake, shake)
  }

  private spawnExplosion(
    x: number,
    y: number,
    kind: ExplosionKind,
    radius: number,
    lifetime: number,
  ): void {
    // At the cap, drop the oldest rather than refusing the new one: the newest
    // explosion is the one the player needs to see.
    if (this.explosions.length >= MAX_EXPLOSIONS) this.explosions.shift()
    this.explosions.push({ x, y, age: 0, lifetime, radius, kind })
  }

  /**
   * Streams are exposed for content systems (spawn tables, loot rolls) to draw
   * from. Nothing else may create an Rng from the seed, or stream independence
   * is lost.
   */
  get spawnRng(): Rng {
    return this.rngSpawn
  }

  get lootRng(): Rng {
    return this.rngLoot
  }
}
