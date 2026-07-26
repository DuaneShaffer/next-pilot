/**
 * Bot playtest sweep runner.
 *
 *   npx tsx tools/playtest.ts --runs=200
 *   npx tsx tools/playtest.ts --policy=aggressor --runs=1000 --json
 *   npx tsx tools/playtest.ts --record-fixture=sector1-aggressor --policy=aggressor
 *
 * WHY THIS EXISTS: nobody plays this game before it ships a change. Balance is
 * whatever this tool says it is (`docs/VERIFICATION.md` §2), so "Arrears felt
 * weak" is not a reason for a change and "random reaches wave 5 in 12% of runs"
 * is. The sim is headless and deterministic, so a few thousand complete runs cost
 * seconds; there is no excuse for guessing.
 *
 * WHAT IT DELIBERATELY DOES NOT MEASURE: fun. A bot cannot tell you a pattern is
 * boring, only that it is survivable. Everything this tool skips is printed under
 * COVERAGE at the bottom of the report, because a table with no caveats reads as
 * "everything is covered" and that is how a harness starts lying.
 */

import { pathToFileURL } from 'node:url'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

import type { InputSnapshot } from '../src/core/input'
import { TICK_HZ } from '../src/core/loop'
import { normalizeSeed } from '../src/core/seed'
import { Playfield } from '../src/core/space'
import { BOSSES, SECTOR_PLAYER_DPS } from '../src/content/bosses'
import { HAZARDS } from '../src/content/hazards'
import { HULLS, HULL_ORDER } from '../src/content/hulls'
import { INTERACTIONS } from '../src/content/interactions'
import { ITEMS } from '../src/content/items'
import { STANDARD_RUN } from '../src/content/runs'
import { SECTORS } from '../src/content/sectors'
import type {
  Bullet,
  DeathCauseKind,
  PendingChoiceKind,
  RunState,
  WorldView,
} from '../src/sim/entities'
import type { BotName, RouteStyle } from '../src/sim/bots'
import {
  BOTS,
  BOT_NAMES,
  BUILD_FOCUSED_TARGET,
  MAX_CHOICE_RESOLUTION_TICKS,
  ROUTE_STYLES,
  choiceOpenTicks,
  isBotName,
  isRouteStyle,
} from '../src/sim/bots'
import type { RunContent } from '../src/sim/world'
import { World } from '../src/sim/world'
import { digestWorld } from '../src/meta/snapshot'
import { decodeReplay, playback, ReplayRecorder } from '../src/meta/replay'

/**
 * The content a sweep runs against.
 *
 * `new World(seed)` defaults to `EMPTY_CONTENT`, which offers no items at all —
 * so before this existed every sweep in this file was measuring a run with the
 * entire M3 loop switched off, and reporting item coverage as "M3 work, no
 * coverage yet" while the items sat there unmeasured.
 *
 * THIS IS THE ONE PLACE THE HARNESS READS THE CONTENT TABLES, and it does so for
 * two specific reasons that the bots deliberately cannot: to hand the sim a real
 * item pool, and to name the items that were **never offered**. A sweep that only
 * counts what it saw cannot tell the difference between "no such item" and "a
 * weight or pool bug is hiding one", which is exactly the failure M3's pick-rate
 * criterion is meant to catch. The bots themselves still see nothing but
 * `WorldView`.
 */
const RUN_CONTENT: RunContent = {
  items: ITEMS,
  interactions: INTERACTIONS,
  run: STANDARD_RUN,
  sectors: Object.fromEntries(SECTORS.map((sector) => [sector.id, sector])),
  bosses: BOSSES,
  hazards: HAZARDS,
}

/**
 * The five-sector run as the app wires it, plus one hull.
 *
 * Mirrors `src/main.ts` exactly. A sweep that flew a different run from the one
 * that ships would produce numbers about a game nobody plays, and this is the one
 * place in the harness where that could quietly happen.
 */
function contentForHull(hullId: string | null): RunContent {
  if (hullId === null) return RUN_CONTENT
  const hull = HULLS[hullId]
  if (hull === undefined) fail(`unknown hull "${hullId}". Known: ${HULL_ORDER.join(', ')}`)
  return { ...RUN_CONTENT, hull }
}

/**
 * Hand the flown hull extra starting items. `--give=repair-nanites`.
 *
 * THE ABLATION SWITCH FOR ITEMS, and it exists because the item claims in
 * `src/content/items.ts` were measured with an edit to the content table that no
 * flag recorded. "Give the baseline Lien this relic and change nothing else" is the
 * only way to turn an item's strength into a number rather than a correlation — the
 * interaction splits printed further down are conditioned on surviving long enough
 * to be offered both halves, and say so.
 *
 * It builds a NEW hull def rather than mutating `HULLS`, so a sweep cannot leak the
 * ablation into the hull table that the rest of the process reads.
 */
function withStartingItems(content: RunContent, give: readonly string[]): RunContent {
  if (give.length === 0) return content
  const base = content.hull ?? HULLS['lien']
  if (base === undefined) fail('no baseline hull to give items to')
  return {
    ...content,
    hull: { ...base, startingItems: [...(base.startingItems ?? []), ...give] },
  }
}

/** Single-sector content, for numbers comparable with the M1–M4 sweeps. */
const SECTOR_ONE_CONTENT: RunContent = { items: ITEMS, interactions: INTERACTIONS }

const ALL_ITEM_IDS: readonly string[] = Object.keys(ITEMS).sort()
const ALL_INTERACTION_IDS: readonly string[] = INTERACTIONS.map((i) => i.id).sort()

/** Boss id -> authored HP, so a measured time-to-kill can become a measured dps. */
const BOSS_HP: Readonly<Record<string, number>> = Object.fromEntries(
  Object.values(BOSSES).map((boss) => [boss.id, boss.hp]),
)

/** Sector id -> authored wave count, so "died on wave 12" has a denominator. */
const SECTOR_WAVES: Readonly<Record<string, number>> = Object.fromEntries(
  SECTORS.map((sector) => [sector.id, sector.waves.length]),
)

function sectorWaveCount(sectorId: string): number {
  return SECTOR_WAVES[sectorId] ?? 0
}

/** A route as it was offered, reduced to what can be matched after the fact. */
interface RouteOfferSummary {
  hazardIds: string
  reward: string
}

/**
 * Which approach the policy took, inferred from the hazards that ended up armed.
 *
 * The sim does not report the chosen index on `WorldView` — a route resolves and
 * the card is gone — so this matches the hazard set the next sector actually armed
 * against the sets the card offered. THE AMBIGUOUS CASE IS REAL AND IS NOT HIDDEN:
 * when a sector has only one hazard, `buildRoutes` puts the same hazard on both
 * priced options and only the reward differs, so the two are indistinguishable
 * here and the first match wins. That makes the `routeReward` column unreliable in
 * exactly that case, which COVERAGE states. The column this report actually reads
 * is "did the pilot arrive with a hazard armed", and that is exact.
 */
function matchRoute(
  offered: readonly RouteOfferSummary[] | null,
  armed: readonly string[],
): { index: number; reward: string } | null {
  if (offered === null) return null
  const key = [...armed].sort().join(',')
  const matches: number[] = []
  for (let i = 0; i < offered.length; i++) {
    if (offered[i]?.hazardIds === key) matches.push(i)
  }
  const first = matches[0]
  if (first === undefined) return null
  // Two options carrying the same hazard are indistinguishable after the fact, and
  // this used to answer with the first one's reward anyway — a number that reads as
  // measured and is a coin flip. Saying `ambiguous` costs one row of the reward table
  // and keeps the rest of it true.
  const reward = matches.length > 1 ? 'ambiguous' : (offered[first]?.reward ?? 'none')
  return { index: first, reward }
}

const DEFAULT_RUNS = 200
const DEFAULT_SEED = 'K7F29XQM3RTV'
/**
 * Hard tick ceiling per run, in seconds of sim time.
 *
 * The shipped run is 180+180+180+180+210 = 930 seconds of authored sector time
 * before a single boss fight, and a stage is held open until its boss is dead —
 * so a *cleared* run is comfortably over twenty minutes. 1,800s is roughly 1.6x
 * the longest clear observed, which leaves room for a slow build without letting
 * a stalled run consume a sweep.
 *
 * Runs that hit the cap are counted and called out: survival statistics over
 * censored data are lower bounds, and reporting a median as if it were exact when
 * a quarter of runs were cut short is exactly the kind of quiet lie this harness
 * exists to prevent.
 */
const DEFAULT_MAX_SECONDS = 1800

/** How often to sample the live enemy set for coverage reporting. */
const ENEMY_SAMPLE_TICKS = 15

// ---------------------------------------------------------------------------
// seeds
// ---------------------------------------------------------------------------

/**
 * Derive run N's seed from the sweep's base seed.
 *
 * Hashed rather than `${base}-${n}` so that consecutive runs are not
 * near-neighbours in seed space, and pushed through `normalizeSeed` so every
 * seed a sweep reports is a seed a human can type back into the game to see the
 * run for themselves. A finding you cannot reproduce by hand is hard to act on.
 */
function deriveSeed(base: string, index: number): string {
  const key = `${base}#${index}`
  let h1 = 0x811c9dc5 | 0
  let h2 = 0x9e3779b9 | 0
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 ^ c, 2246822519)
  }
  const hex =
    (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')
  return normalizeSeed(hex)
}

// ---------------------------------------------------------------------------
// one run
// ---------------------------------------------------------------------------

/**
 * One option as it was presented, with everything needed to tell an offer from a
 * pick afterwards.
 *
 * OFFER RATE AND PICK RATE ARE DIFFERENT NUMBERS and conflating them is the trap
 * this whole structure exists to avoid. An item offered twice in 200 runs and
 * taken both times has a 100% pick rate and is nearly absent from play; an item
 * offered 400 times and taken 40 has a 10% pick rate and is on screen constantly.
 * M3's exit criterion is about the pick rate *given an offer*, so both halves have
 * to be counted separately at the moment of the offer.
 */
interface OfferObservation {
  defId: string
  cost: number
  /** The offer stated a synergy with the build already held (UI rule 5). */
  synergy: boolean
  /** Cost was within the pilot's scrap when the screen opened. */
  affordable: boolean
}

interface ChoiceObservation {
  kind: PendingChoiceKind
  offers: readonly OfferObservation[]
  /** Item actually acquired, or null when the bot declined or skipped. */
  takenId: string | null
  /** Scrap paid. Non-zero only in a shop. */
  spent: number
  /** Ticks the screen stayed open. */
  ticksOpen: number
  /**
   * Ticks of the above the sim discarded to hitstop.
   *
   * `ticksOpen - frozenTicks` is what the bot's scripted resolution actually cost,
   * and is the number that must stay inside `MAX_CHOICE_RESOLUTION_TICKS`. Without
   * this split, a freeze that overlaps a reward screen is indistinguishable from a
   * policy that has lost track of the cursor and is pressing right in circles —
   * one is harmless and the other silently corrupts every pick rate.
   */
  frozenTicks: number
  /** Scrap held when the screen opened, for reading the affordability flags. */
  scrapAtOpen: number
  /** 1 for a run's first shop, 2 for its second, and so on. 0 for a free choice. */
  shopOrdinal: number
  /**
   * True when this card opened in the tick the previous one closed.
   *
   * A seam is route -> (transit item) -> transit shop with no gap between them, and
   * until this existed the observer below could not see past the first card: the
   * whole chain was recorded as one long route card, which has no offers, so
   * `summariseItems` dropped it. That is why every transit item and transit shop in
   * M5 was missing from the pick-rate table, why the transit shops were missing from
   * ECONOMY, and why R1's 1,201-tick stalls never tripped the resolution-budget
   * guard: the ticks were charged to a card the report throws away.
   */
  chained: boolean
  /**
   * False when the run ended with this screen still up.
   *
   * Distinct from `takenId === null`, which also covers a deliberate decline. The
   * offers still count — dropping them would inflate the affected items' pick
   * rates — but the report has to be able to say how many were never decided.
   */
  resolved: boolean
}

/**
 * One sector of one run, from arrival to whatever ended it.
 *
 * THE REASON THIS TYPE EXISTS: every M5 exit criterion is per-sector or per-hull,
 * and an aggregate clear rate cannot show a cliff. "38% of runs clear" is the same
 * number whether the difficulty is a smooth ramp or whether four sectors are free
 * and the fifth kills everyone, and those are opposite problems with opposite fixes.
 *
 * Entry state is snapshotted BEFORE the sector's first tick, so "scrap on entry to
 * sector 4" is what the pilot arrived with rather than what they left with.
 */
export interface StageObservation {
  index: number
  sectorId: string
  sectorName: string

  // --- what the pilot arrived with -----------------------------------------
  entryScrap: number
  entryItems: number
  entryIntegrity: number
  entryMaxIntegrity: number
  entryShield: number
  /**
   * Maximum shield, which is NOT the shield the pilot arrived with.
   *
   * It was missing, and its absence is R1's sibling: `medianEntryHealthPct` divided
   * by `entryMaxIntegrity + entryShield`, so the *current* shield appeared in both
   * halves and cancelled. 100 integrity with a spent 40-point shield — 100 of 140
   * effective HP — reported 100%, while 90 integrity behind a full shield (130 of
   * 140) reported 92.9%. The error is always in the same direction and is largest for
   * exactly the pilots that spend their shield and recover their integrity, which is
   * the reading Repair Nanites and Probate were both justified with.
   */
  entryMaxShield: number
  /**
   * The build's damage-per-second CEILING on arrival: damage x volley x rate.
   *
   * Same arithmetic `SECTOR_PLAYER_DPS` in `src/content/bosses.ts` is built from
   * (80 = 4 damage x 1 projectile x 20 shots/s). The volley width is MEASURED —
   * counted off new player bullets — because `projectilesPerShot` is a stat and
   * split-shot is an *effect*, and only the first reaches `resolvedStats`. A build
   * holding Flak Spread reports `projectilesPerShot: 1` and fires six.
   *
   * IT IS A CEILING, NOT A PREDICTION, and the gap matters for exactly the builds
   * that make it large. It assumes every projectile in the fan lands on one target,
   * which is true for a single stream and false for a six-shot spread — so a
   * split-shot build's ceiling can be several times its real single-target output.
   * The honest single-target figure is `hp / measured boss ttk`, which is reported
   * beside it. Read the two together or not at all.
   */
  entryCeilingDps: number
  /** Volley width the nominal figure was computed from. 1 until an item widens it. */
  entryVolley: number
  /** Hazards armed for this sector by the route the policy took in. */
  hazardIds: readonly string[]
  /** Index of the approach taken. 0 is always the free direct one. Null for sector 1. */
  routeIndex: number | null
  routeReward: string | null

  // --- what happened --------------------------------------------------------
  ticks: number
  /** Positive hp decrements observed across every live enemy. See COVERAGE. */
  damageDealt: number
  /**
   * Ticks with at least one enemy on screen.
   *
   * `damageDealt / ticks` is not a dps: a sector is 180 seconds of authored script
   * with real gaps between waves, so dividing by wall time measures how much HP the
   * sector contains rather than what the pilot can put out. Dividing by engaged
   * time is the honest denominator.
   */
  engagedTicks: number
  damageTaken: number
  kills: number
  scrapEarned: number
  /** Waves released in this sector. Resets per sector, so it is not survival time. */
  wavesReached: number
  waveCount: number

  // --- how it ended ---------------------------------------------------------
  outcome: 'cleared' | 'died' | 'unfinished'
  deathCauseKind: string | null
  deathCauseId: string | null
  /** Wave of THIS sector the pilot died on. Null when they did not die here. */
  deathWaveIndex: number | null

  // --- the boss -------------------------------------------------------------
  bossId: string | null
  bossName: string | null
  bossSpawned: boolean
  bossKilled: boolean
  /** Ticks from `boss-spawned` to `boss-killed`, or to death. Null if never met. */
  bossTicks: number | null
  /** Highest phase index reached. -1 when the boss never spawned. */
  bossPhaseReached: number
  /** True when the run ended during the boss fight rather than during the waves. */
  diedToBoss: boolean
}

export interface RunResult {
  seed: string
  policy: BotName
  ticks: number
  seconds: number
  runState: RunState
  /** Stopped by the tick cap rather than by the sim. Censors survival stats. */
  truncated: boolean
  waveIndex: number
  kills: number
  scrap: number
  shotsFired: number
  hits: number
  damageTaken: number
  peakProjectiles: number
  causeKind: DeathCauseKind | 'unattributed' | 'none'
  causeEnemyId: string | null
  /** Hull position at the final tick — where the run actually ended. */
  endX: number
  endY: number
  hash: string

  // --- M3: what the run did with its choices -------------------------------
  /** Every choice screen this run saw, in order. */
  choices: readonly ChoiceObservation[]
  /** Item ids held when the run ended, in acquisition order. */
  finalInventory: readonly string[]
  /** Stack counts for the held items, so re-takes are visible. */
  finalStacks: Readonly<Record<string, number>>
  /** Interaction ids live at run end. Items are never lost, so this is also "ever live". */
  finalInteractions: readonly string[]
  /** Scrap paid out across the run. `scrap` is the balance left over. */
  scrapSpent: number

  // --- M5: the five-sector run ---------------------------------------------
  hullId: string
  routeStyle: RouteStyle
  /** One entry per sector entered, in order. Length is "how far the run got". */
  stages: readonly StageObservation[]
  /** Index of the sector the run ended in. */
  finalStageIndex: number
  /** Stages cleared. 5 means the run was completed. */
  stagesCleared: number
  /**
   * Set when this run was ABANDONED on a card nothing was resolving.
   *
   * Non-null means the numbers in this run are not measurements of anything: it ends
   * where the stall was, not where the pilot died. See `CHOICE_STALL_ABORT_TICKS`.
   */
  choiceStall: ChoiceStall | null
}

interface RunObservations {
  /** Enemy def ids seen alive at any sample point, across the whole sweep. */
  enemyDefsSeen: Set<string>
  sawFocus: boolean
  sawSpecial: boolean
  sawFire: boolean
  distinctInputBytes: Set<number>
}

function emptyObservations(): RunObservations {
  return {
    enemyDefsSeen: new Set(),
    sawFocus: false,
    sawSpecial: false,
    sawFire: false,
    distinctInputBytes: new Set(),
  }
}

interface RunOptions {
  maxTicks: number
  observations: RunObservations
  /** Hull the run flies. Null means the stat-table baseline, which is the Lien. */
  hullId?: string | null
  /** Overrides the policy's own world-map appetite, for ablation sweeps. */
  routeStyle?: RouteStyle | undefined
  /**
   * Item pool the run draws from.
   *
   * Left undefined for fixture recording, so the run is built exactly the way
   * `tests/replay.test.ts` rebuilds it — `new World(seed)` with the class default.
   * A fixture recorded against a content table that the replaying process does not
   * pass in cannot reproduce, and the corpus would fail for a reason that has
   * nothing to do with the simulation.
   */
  content?: RunContent
  /** When present, every input is recorded for fixture generation. */
  recorder?: ReplayRecorder
}

/** Stack counts by item id, for diffing an acquisition out of the inventory. */
function inventoryCounts(view: WorldView): Map<string, number> {
  const out = new Map<string, number>()
  for (const entry of view.inventory) out.set(entry.defId, entry.count)
  return out
}

/** The one id whose stack grew, or null when nothing was acquired. */
function acquiredId(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): string | null {
  for (const [defId, count] of after) {
    if (count > (before.get(defId) ?? 0)) return defId
  }
  return null
}

/**
 * Everything accumulating about the sector currently being flown.
 *
 * Separate from `StageObservation` because the entry snapshot has to be taken at a
 * different moment from the totals: entry is read the instant `stage.index` moves,
 * and the totals are differences against the run-wide counters at that instant.
 */
interface OpenStage {
  index: number
  sectorId: string
  sectorName: string
  bossId: string | null
  bossName: string | null
  startTick: number
  entryScrap: number
  entryItems: number
  entryIntegrity: number
  entryMaxIntegrity: number
  entryShield: number
  entryMaxShield: number
  entryCeilingDps: number
  entryVolley: number
  hazardIds: readonly string[]
  routeIndex: number | null
  routeReward: string | null
  killsAtStart: number
  damageTakenAtStart: number
  scrapEarnedAtStart: number
  damageDealt: number
  engagedTicks: number
  maxWaveIndex: number
  bossSpawnTick: number | null
  bossEndTick: number | null
  bossKilled: boolean
  bossPhaseReached: number
}

/**
 * The build's damage-per-second ceiling as it stands. See `entryCeilingDps`.
 */
function ceilingDps(view: WorldView, volley: number): number {
  const damage = view.resolvedStats.projectileDamage ?? 4
  const interval = view.resolvedStats.fireIntervalTicks ?? 3
  if (interval <= 0) return 0
  return damage * volley * (TICK_HZ / interval)
}

/** A choice screen currently open, waiting to be resolved. */
/**
 * Unfrozen ticks one card may stay open before this harness declares the sweep broken
 * and stops the run.
 *
 * THIS IS NOW A REAL CEILING AND IT HAS TO BE. The sim used to auto-resolve any card
 * after 1,200 ticks, so a policy that stopped resolving cards produced a corrupted
 * measurement rather than a hang — and the corruption was invisible, because the guard
 * that was supposed to catch it compared against a stale copy of the timeout (3,600)
 * while the timeout was 1,200. R1 in docs/ROADMAP.md: a bot sat 1,201 ticks on an
 * unaffordable shop option, every survival number in the report was inflated by it,
 * and nothing said a word.
 *
 * With the timeout removed a stuck card stays open for the rest of the run, which is
 * an improvement ONLY because of this bound. Exceeding it aborts the run, prints a
 * FAIL, and exits non-zero — a stall must cost a red sweep, never a quiet row in a
 * table.
 *
 * Derived from the bots' own budget rather than written down, so the two cannot drift.
 * The multiple is slack, not tolerance: a card that overruns
 * `MAX_CHOICE_RESOLUTION_TICKS` at all is already reported as over-budget below; ten
 * times it (one second of sim time on a screen a bot resolves in six ticks) is a
 * policy that has stopped resolving rather than one that is navigating badly.
 */
const CHOICE_STALL_ABORT_TICKS = MAX_CHOICE_RESOLUTION_TICKS * 10

/** A card a run gave up on: the bound above fired and the run was cut short. */
export interface ChoiceStall {
  kind: PendingChoiceKind
  /** Unfrozen ticks the card had been open when the run was abandoned. */
  scriptTicks: number
  /** Sim tick the card opened, so a repro can be driven to it. */
  openedAtTick: number
}

interface OpenChoice {
  kind: PendingChoiceKind
  offers: readonly OfferObservation[]
  scrapAtOpen: number
  openedAtTick: number
  frozenTicks: number
  shopOrdinal: number
  chained: boolean
  inventoryBefore: ReadonlyMap<string, number>
}

function runOnce(policyName: BotName, seed: string, options: RunOptions): RunResult {
  const world = options.content === undefined ? new World(seed) : new World(seed, options.content)
  const view: WorldView = world
  const policy = BOTS[policyName].create(
    seed,
    options.routeStyle === undefined ? undefined : { routeStyle: options.routeStyle },
  )
  const obs = options.observations

  const choices: ChoiceObservation[] = []
  let open: OpenChoice | null = null
  /** Set when the stall bound fired and this run was abandoned. */
  let stall: ChoiceStall | null = null
  /** The open card's sim-side `openTicks` as last observed. See `chained` below. */
  let lastChoiceOpenTicks = -1
  let scrapSpent = 0
  let shopsSeen = 0

  // --- per-sector instrumentation --------------------------------------------
  const stages: StageObservation[] = []
  let stagesCleared = 0
  /**
   * Enemy hp as it stood at the end of the previous tick, keyed by uid.
   *
   * Summing positive decrements is the only way to see damage output from outside
   * the sim: nothing on `WorldView` reports damage dealt. It undercounts by the
   * hp an enemy had left on the tick it died, because reaping removes it from the
   * array in the same tick — see COVERAGE.
   */
  const enemyHp = new Map<number, number>()
  /** Player bullets already counted, so each volley's width is counted once. */
  const seenBullets = new WeakSet<Bullet>()
  /** Widest volley seen in the current sector. Max, not last: the cap can clip one. */
  let volley = 1
  /** The route card resolved most recently, waiting for its sector to open. */
  let pendingRoute: { index: number; reward: string } | null = null
  /** The route card's options while it is open, for `matchRoute` after it closes. */
  let routeOffer: readonly RouteOfferSummary[] | null = null

  const takeStage = (): OpenStage => ({
    index: view.stage.index,
    sectorId: view.stage.sectorId,
    sectorName: view.stage.sectorName,
    bossId: null,
    bossName: view.stage.bossName,
    startTick: view.stats.tick,
    entryScrap: view.stats.scrap,
    entryItems: view.inventory.length,
    entryIntegrity: view.hull.integrity,
    entryMaxIntegrity: view.hull.maxIntegrity,
    entryShield: view.hull.shield,
    entryMaxShield: view.hull.maxShield,
    entryCeilingDps: ceilingDps(view, volley),
    entryVolley: volley,
    hazardIds: view.hazards.map((h) => h.id),
    routeIndex: pendingRoute?.index ?? null,
    routeReward: pendingRoute?.reward ?? null,
    killsAtStart: view.stats.kills,
    damageTakenAtStart: view.stats.damageTaken,
    scrapEarnedAtStart: view.stats.scrap + scrapSpent,
    damageDealt: 0,
    engagedTicks: 0,
    maxWaveIndex: 0,
    bossSpawnTick: null,
    bossEndTick: null,
    bossKilled: false,
    bossPhaseReached: -1,
  })

  const closeStage = (stage: OpenStage, outcome: StageObservation['outcome']): StageObservation => {
    const diedToBoss = outcome === 'died' && stage.bossSpawnTick !== null && !stage.bossKilled
    return {
      index: stage.index,
      sectorId: stage.sectorId,
      sectorName: stage.sectorName,
      entryScrap: stage.entryScrap,
      entryItems: stage.entryItems,
      entryIntegrity: stage.entryIntegrity,
      entryMaxIntegrity: stage.entryMaxIntegrity,
      entryShield: stage.entryShield,
      entryMaxShield: stage.entryMaxShield,
      entryCeilingDps: stage.entryCeilingDps,
      entryVolley: stage.entryVolley,
      hazardIds: stage.hazardIds,
      routeIndex: stage.routeIndex,
      routeReward: stage.routeReward,
      ticks: view.stats.tick - stage.startTick,
      damageDealt: stage.damageDealt,
      engagedTicks: stage.engagedTicks,
      damageTaken: view.stats.damageTaken - stage.damageTakenAtStart,
      kills: view.stats.kills - stage.killsAtStart,
      scrapEarned: view.stats.scrap + scrapSpent - stage.scrapEarnedAtStart,
      wavesReached: stage.maxWaveIndex,
      waveCount: sectorWaveCount(stage.sectorId),
      outcome,
      deathCauseKind: outcome === 'died' ? (view.incident?.causeKind ?? 'unattributed') : null,
      deathCauseId: outcome === 'died' ? (view.incident?.causeEnemyId ?? null) : null,
      deathWaveIndex: outcome === 'died' ? stage.maxWaveIndex : null,
      bossId: stage.bossId,
      bossName: stage.bossName,
      bossSpawned: stage.bossSpawnTick !== null,
      bossKilled: stage.bossKilled,
      bossTicks:
        stage.bossSpawnTick === null
          ? null
          : (stage.bossEndTick ?? view.stats.tick) - stage.bossSpawnTick,
      bossPhaseReached: stage.bossPhaseReached,
      diedToBoss,
    }
  }

  let stage: OpenStage = takeStage()

  let ticks = 0
  while (view.runState === 'active' && ticks < options.maxTicks) {
    // Both read BEFORE the tick: `freezeTicks` is pre-decrement here, which is
    // exactly the set of ticks the sim throws away, and `open` must be the state
    // as it was when this tick's input was chosen.
    const wasOpen = open
    const frozenThisTick = view.freezeTicks > 0

    const input: InputSnapshot = policy(view)
    if (input.focus) obs.sawFocus = true
    if (input.special) obs.sawSpecial = true
    if (input.fire) obs.sawFire = true
    options.recorder?.record(input)
    world.tick(input)
    ticks++
    if (wasOpen !== null && frozenThisTick) wasOpen.frozenTicks++

    // Choice bookkeeping runs AFTER the tick, because a screen both opens and
    // closes inside one.
    //
    // THE TWO TRANSITIONS DO COINCIDE, and the comment that used to sit here said
    // they could not. In a *sector* that is true — the sim refuses to open a reward
    // card on a tick that resolved one — but a SEAM chains them deliberately:
    // `takeRoute` nulls the card and calls `advanceTransition`, which opens the next
    // one in the same tick. `choiceOpenTicks` is the sim's own per-card counter, and
    // it going backwards is the only observable that says the card was swapped.
    const pending = view.pendingChoice
    const openTicks = choiceOpenTicks(view)
    // Not on a frozen tick: the sim returns before `updateChoice`, so the counter
    // stands still and a stalled card would read as a swapped one. Nothing can
    // resolve on a frozen tick either, so there is nothing to detect.
    const chained =
      pending !== null &&
      open !== null &&
      !frozenThisTick &&
      openTicks !== null &&
      openTicks <= lastChoiceOpenTicks
    if (open !== null && (pending === null || chained)) {
      const taken = acquiredId(open.inventoryBefore, inventoryCounts(view))
      const spent = Math.max(0, open.scrapAtOpen - view.stats.scrap)
      scrapSpent += spent
      choices.push({
        kind: open.kind,
        offers: open.offers,
        takenId: taken,
        spent,
        ticksOpen: ticks - open.openedAtTick,
        frozenTicks: open.frozenTicks,
        scrapAtOpen: open.scrapAtOpen,
        shopOrdinal: open.shopOrdinal,
        chained: open.chained,
        resolved: true,
      })
      open = null
    }
    if (pending !== null && open === null) {
      if (pending.kind === 'shop') shopsSeen++
      open = {
        kind: pending.kind,
        offers: pending.offers.map((offer, index) => {
          const cost = pending.costs[index] ?? 0
          return {
            defId: offer.defId,
            cost,
            synergy: offer.interactionText.length > 0,
            affordable: cost <= view.stats.scrap,
          }
        }),
        scrapAtOpen: view.stats.scrap,
        openedAtTick: ticks,
        frozenTicks: 0,
        shopOrdinal: pending.kind === 'shop' ? shopsSeen : 0,
        chained,
        inventoryBefore: inventoryCounts(view),
      }
    }
    if (pending === null) lastChoiceOpenTicks = -1
    else if (!frozenThisTick) lastChoiceOpenTicks = openTicks ?? lastChoiceOpenTicks + 1

    // --- the stall bound ------------------------------------------------------
    //
    // THE HARD CEILING. Nothing in the sim resolves a card on the player's behalf at
    // all — no timeout, no dwell — so a card the policy has stopped resolving stays open
    // until the tick cap: one run silently spending its whole budget on one screen, which
    // is what R1 looked like. Abandon it instead, loudly, and let `printChoiceHealth`
    // fail the sweep over it. Bounded by construction: this check runs on every tick a
    // card is open, so the run cannot outlive it.
    if (open !== null) {
      const scriptTicks = ticks - open.openedAtTick - open.frozenTicks
      if (scriptTicks > CHOICE_STALL_ABORT_TICKS) {
        stall = {
          kind: open.kind,
          scriptTicks,
          openedAtTick: view.stats.tick - (ticks - open.openedAtTick),
        }
        break
      }
    }

    // --- damage output, measured from the outside --------------------------
    // Every live enemy's hp against what it was last tick. Unavoidably per-tick:
    // sampling would miss most of the decrements entirely.
    let engaged = false
    for (const enemy of view.enemies) {
      if (enemy.alive) engaged = true
      const previous = enemyHp.get(enemy.uid)
      if (previous !== undefined && enemy.hp < previous) stage.damageDealt += previous - enemy.hp
      enemyHp.set(enemy.uid, enemy.hp)
    }
    if (engaged) stage.engagedTicks++

    // --- volley width, measured from new player bullets ---------------------
    let fresh = 0
    for (const bullet of view.playerBullets) {
      if (seenBullets.has(bullet)) continue
      seenBullets.add(bullet)
      fresh++
    }
    // RETALIATION FIRE IS ALSO A PLAYER BULLET. `retaliate()` pushes a whole ring
    // into the same array on any tick the hull loses integrity, so counting fresh
    // bullets blindly reported a Retaliation Coil build as firing a 13-shot volley
    // and inflated its nominal dps by an order of magnitude. Only ticks that fired
    // the weapon and took no hull hit are admissible.
    let shot = false
    let hit = false
    for (const event of view.events) {
      if (event.kind === 'player-shot') shot = true
      else if (event.kind === 'hull-hit') hit = true
    }
    // Max over admissible ticks, not last: the projectile cap can refuse a fan's
    // outer shots, and one clipped volley must not read as a narrower build.
    if (shot && !hit && fresh > volley) volley = fresh

    // --- the boss ------------------------------------------------------------
    for (const event of view.events) {
      if (event.kind === 'boss-spawned') {
        stage.bossId = event.bossId
        stage.bossName = event.name
        stage.bossSpawnTick = view.stats.tick
        stage.bossPhaseReached = 0
      } else if (event.kind === 'boss-phase') {
        if (event.phaseIndex > stage.bossPhaseReached) stage.bossPhaseReached = event.phaseIndex
      } else if (event.kind === 'boss-killed') {
        stage.bossKilled = true
        stage.bossEndTick = view.stats.tick
      }
    }
    if (view.stats.waveIndex > stage.maxWaveIndex) stage.maxWaveIndex = view.stats.waveIndex

    // --- the route card, so an arriving sector knows how it was entered ------
    if (routeOffer === null && pending?.kind === 'route') {
      routeOffer = pending.routes.map((route) => ({
        hazardIds: [...route.hazardIds].sort().join(','),
        reward: route.reward.kind,
      }))
    }

    // --- the seam ------------------------------------------------------------
    if (view.stage.index !== stage.index) {
      stages.push(closeStage(stage, 'cleared'))
      stagesCleared++
      // Set, read by `takeStage`, then cleared — so a sector entered without a
      // route card (sector 1, or a stage whose card was skipped) reports null
      // rather than inheriting the previous seam's answer.
      pendingRoute = matchRoute(routeOffer, view.hazards.map((h) => h.id))
      routeOffer = null
      stage = takeStage()
      pendingRoute = null
    }

    // Sampled rather than per-tick: this is coverage bookkeeping, not sim state,
    // and scanning every enemy every tick would show up in the sweep timing.
    if (ticks % ENEMY_SAMPLE_TICKS === 0) {
      for (const enemy of view.enemies) if (enemy.alive) obs.enemyDefsSeen.add(enemy.defId)
    }
  }

  // The final sector: cleared only when the run actually extracted, because the
  // last stage has no seam to cross and would otherwise never be recorded.
  if (view.runState === 'extracted') {
    stages.push(closeStage(stage, 'cleared'))
    stagesCleared++
  } else {
    stages.push(closeStage(stage, view.runState === 'lost' ? 'died' : 'unfinished'))
  }

  // A run that ended (or was truncated) with a screen still open never got to
  // decide, so it is recorded as an offer with no pick rather than dropped —
  // dropping it would quietly inflate every pick rate.
  if (open !== null) {
    choices.push({
      kind: open.kind,
      offers: open.offers,
      takenId: null,
      spent: 0,
      ticksOpen: ticks - open.openedAtTick,
      frozenTicks: open.frozenTicks,
      scrapAtOpen: open.scrapAtOpen,
      shopOrdinal: open.shopOrdinal,
      chained: open.chained,
      resolved: false,
    })
  }

  const truncated = view.runState === 'active' && ticks >= options.maxTicks
  const incident = view.incident
  const stats = view.stats
  const causeKind: RunResult['causeKind'] =
    view.runState !== 'lost' ? 'none' : (incident?.causeKind ?? 'unattributed')

  return {
    seed,
    policy: policyName,
    ticks,
    seconds: ticks / TICK_HZ,
    runState: view.runState,
    truncated,
    waveIndex: stats.waveIndex,
    kills: stats.kills,
    scrap: stats.scrap,
    shotsFired: stats.shotsFired,
    hits: stats.hits,
    damageTaken: stats.damageTaken,
    peakProjectiles: stats.peakProjectiles,
    causeKind,
    causeEnemyId: incident?.causeEnemyId ?? null,
    endX: view.hull.x,
    endY: view.hull.y,
    hash: digestWorld(view).hash,
    choices,
    finalInventory: view.inventory.map((entry) => entry.defId),
    finalStacks: Object.fromEntries(view.inventory.map((entry) => [entry.defId, entry.count])),
    finalInteractions: view.activeInteractions.map((entry) => entry.defId),
    scrapSpent,
    hullId: options.hullId ?? 'lien',
    routeStyle: options.routeStyle ?? BOTS[policyName].routeStyle,
    stages,
    finalStageIndex: view.stage.index,
    stagesCleared,
    choiceStall: stall,
  }
}

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile on a sorted array.
 *
 * No interpolation: interpolated percentiles invent values that no run produced,
 * and every number in this report should be traceable to an actual run.
 */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[rank] ?? 0
}

function sortedNumbers(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b)
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0
  let total = 0
  for (const v of values) total += v
  return total / values.length
}

// ---------------------------------------------------------------------------
// M3: items, builds, economy
// ---------------------------------------------------------------------------

/**
 * M3's exit criteria, as numbers rather than prose (`docs/ROADMAP.md`).
 *
 * "No single item above a 70% pick rate and none below 10%." Both bounds are on
 * the pick rate *given an offer*. With three distinct options per screen, an item
 * chosen by coin-flip sits at 33%, so 70% means "almost always correct" and 10%
 * means "worse than a third of chance" — the band is deliberately wide.
 */
const PICK_RATE_MAX = 0.7
const PICK_RATE_MIN = 0.1

/**
 * Offers below this are reported but excluded from the pass/fail verdict.
 *
 * A pick rate over five offers is not a measurement, and letting a 5-offer item
 * fail an exit criterion would send someone tuning a weight against noise.
 */
const MIN_OFFERS_FOR_VERDICT = 20

export interface ItemRow {
  defId: string
  offered: number
  picked: number
  /** picked / offered. The number M3's exit criterion is written against. */
  pickRate: number
  /** offered / total offer slots in the sweep. How much of the pool this item is. */
  offerShare: number
  offeredWithSynergy: number
  pickedWithSynergy: number
  offeredWithoutSynergy: number
  pickedWithoutSynergy: number
  offeredInShop: number
  pickedInShop: number
  /** Offers the pilot could not have afforded. Shop only. */
  offeredUnaffordable: number
  /**
   * Pick rate over FREE choices only, where price cannot interfere.
   *
   * The purest reading of preference, and the one to compare against the 1-in-3
   * baseline: on a free three-option screen exactly one option is always taken, so
   * the offer-weighted mean of this column is exactly 33.3% by construction and any
   * deviation is a real preference. `pickRate` pools in the shop screens, where an
   * unaffordable option is an offer with a guaranteed zero — so a shop nobody can
   * use drags every item's pooled rate down without saying anything about the item.
   */
  pickRateFree: number
  offeredFree: number
}

export interface ItemReport {
  rows: readonly ItemRow[]
  /** Items in the content table that no choice ever presented. A pool/weight bug. */
  neverOffered: readonly string[]
  /** Items that were offered and never once taken. */
  neverPicked: readonly string[]
  totalChoices: number
  totalOfferSlots: number
  /** Choices resolved without taking anything. */
  choicesDeclined: number
  /** Longest a screen stayed open, in ticks, hitstop included. */
  maxChoiceTicks: number
  /**
   * Longest a screen stayed open with the frozen ticks removed.
   *
   * THIS is the number that must stay inside `MAX_CHOICE_RESOLUTION_TICKS`. If it
   * ever exceeds it, a policy has lost the cursor and its picks are not the picks
   * it intended — which would make every row in the table above wrong.
   */
  maxChoiceScriptTicks: number
  /** Choices still open when the run ended. Counted as offers with no pick. */
  choicesUnresolvedAtRunEnd: number
}

/**
 * Whether the BOTS decided their cards, or the SIM did it for them.
 *
 * Its own section, over every card of every kind, because the item report cannot
 * host it: `summariseItems` skips any choice with no offers, so a route card — the
 * first card of every seam — is invisible there, and so was the 1,201-tick stall
 * that used to sit behind it.
 *
 * THE SIM NO LONGER HAS A BACKSTOP. It used to auto-resolve any card after 1,200
 * ticks, which meant a policy that stopped resolving cards produced a corrupted
 * measurement — a pick nobody made plus twenty seconds of dead time charged to a
 * survival number — instead of a hang. This section was where that showed up, and it
 * did not: the guard compared against a stale 3,600 while the constant was 1,200.
 *
 * So the numbers below are now the ONLY thing standing between a broken policy and a
 * green sweep, and both of them are hard failures that exit non-zero:
 *
 *   overBudget — a card took longer than the bots' own navigation budget. The policy
 *                has lost the cursor, so its picks are not the picks it chose.
 *   stalls     — a card was never resolved at all and the run was abandoned on it.
 *
 * The thresholds are IMPORTED or derived, never written down. A guard comparing
 * against a stale copy of a number is a guard that passes.
 */
interface ChoiceHealth {
  cards: number
  /** Cards that opened in the tick the previous one closed. A seam makes 2-3. */
  chained: number
  /** Cards whose unfrozen ticks exceeded the bot's own navigation budget. */
  overBudget: number
  worstScriptTicks: number
  worstKind: string
  /** Runs abandoned on a card nothing was resolving. Each is a hang, not a slow bot. */
  stalls: readonly ChoiceStall[]
  /** Ticks spent on over-budget cards. What a survival median was inflated by. */
  deadTicks: number
}

function summariseChoiceHealth(runs: readonly RunResult[]): ChoiceHealth {
  const stalls: ChoiceStall[] = []
  const health = {
    cards: 0,
    chained: 0,
    overBudget: 0,
    worstScriptTicks: 0,
    worstKind: '-',
    stalls,
    deadTicks: 0,
  }
  for (const run of runs) {
    if (run.choiceStall !== null) stalls.push(run.choiceStall)
    for (const choice of run.choices) {
      health.cards++
      if (choice.chained) health.chained++
      const scriptTicks = choice.ticksOpen - choice.frozenTicks
      if (scriptTicks > health.worstScriptTicks) {
        health.worstScriptTicks = scriptTicks
        health.worstKind = choice.kind
      }
      if (scriptTicks > MAX_CHOICE_RESOLUTION_TICKS) {
        health.overBudget++
        health.deadTicks += scriptTicks
      }
    }
  }
  return health
}

/** True when the sweep's cards are unhealthy enough that its numbers cannot be read. */
function choiceHealthFailed(health: ChoiceHealth): boolean {
  return health.stalls.length > 0 || health.overBudget > 0
}

function printChoiceHealth(health: ChoiceHealth): void {
  console.log('')
  console.log('CHOICE RESOLUTION — did the POLICIES decide, or did nobody decide?')
  console.log(
    `  ${health.cards} cards seen, ${health.chained} of them opened in the same tick the previous one closed` +
      ' (a seam chains route -> transit item -> transit shop)',
  )
  if (health.stalls.length > 0) {
    console.log(
      `  FAIL  ${health.stalls.length} run(s) were ABANDONED on a card nobody resolved, after ` +
        `${CHOICE_STALL_ABORT_TICKS} unfrozen ticks on one screen. NOTHING in the sim closes a card on its own,` +
        ' so this is a hang rather than a slow bot: the policy stopped producing the inputs the card needs' +
        ' (accepting is `InputSnapshot.confirm`, not `fire`). Every number in those runs ends at the stall.',
    )
    for (const stall of health.stalls) {
      console.log(
        `          ${stall.kind} card opened at sim tick ${stall.openedAtTick}, still open ` +
          `${stall.scriptTicks} unfrozen ticks later`,
      )
    }
  }
  if (health.overBudget > 0) {
    console.log(
      `  FAIL  ${health.overBudget} card(s) exceeded the ${MAX_CHOICE_RESOLUTION_TICKS}-tick navigation budget ` +
        `(worst: ${health.worstScriptTicks} unfrozen ticks on a ${health.worstKind}), ${health.deadTicks} ticks in total.` +
        ' A policy that overruns has lost the cursor, so its picks are not the ones it chose.',
    )
  }
  if (!choiceHealthFailed(health)) {
    console.log(
      `  PASS  every card was resolved by its policy inside ${MAX_CHOICE_RESOLUTION_TICKS} unfrozen ticks ` +
        `(worst ${health.worstScriptTicks} on a ${health.worstKind}); no run stalled on a card`,
    )
  }
}

function summariseItems(runs: readonly RunResult[]): ItemReport {
    interface Acc
    extends Omit<ItemRow, 'defId' | 'pickRate' | 'offerShare' | 'pickRateFree' | 'offeredFree'> {}
  const acc = new Map<string, Acc>()
  const blank = (): Acc => ({
    offered: 0,
    picked: 0,
    offeredWithSynergy: 0,
    pickedWithSynergy: 0,
    offeredWithoutSynergy: 0,
    pickedWithoutSynergy: 0,
    offeredInShop: 0,
    pickedInShop: 0,
    offeredUnaffordable: 0,
  })

  let totalChoices = 0
  let totalOfferSlots = 0
  let choicesDeclined = 0
  let maxChoiceTicks = 0
  let maxChoiceScriptTicks = 0
  let unresolved = 0

  for (const run of runs) {
    for (const choice of run.choices) {
      // Work orders are not item offers and must not dilute the offer share.
      if (choice.offers.length === 0) continue
      totalChoices++
      if (!choice.resolved) unresolved++
      else if (choice.takenId === null) choicesDeclined++
      if (choice.ticksOpen > maxChoiceTicks) maxChoiceTicks = choice.ticksOpen
      const scriptTicks = choice.ticksOpen - choice.frozenTicks
      if (scriptTicks > maxChoiceScriptTicks) maxChoiceScriptTicks = scriptTicks

      for (const offer of choice.offers) {
        totalOfferSlots++
        let row = acc.get(offer.defId)
        if (row === undefined) {
          row = blank()
          acc.set(offer.defId, row)
        }
        const taken = choice.takenId === offer.defId
        row.offered++
        if (taken) row.picked++
        if (offer.synergy) {
          row.offeredWithSynergy++
          if (taken) row.pickedWithSynergy++
        } else {
          row.offeredWithoutSynergy++
          if (taken) row.pickedWithoutSynergy++
        }
        if (choice.kind === 'shop') {
          row.offeredInShop++
          if (taken) row.pickedInShop++
          if (!offer.affordable) row.offeredUnaffordable++
        }
      }
    }
  }

  const rows: ItemRow[] = [...acc.entries()]
    .map(([defId, row]) => {
      const offeredFree = row.offered - row.offeredInShop
      const pickedFree = row.picked - row.pickedInShop
      return {
        defId,
        ...row,
        pickRate: row.offered === 0 ? 0 : row.picked / row.offered,
        offerShare: totalOfferSlots === 0 ? 0 : row.offered / totalOfferSlots,
        offeredFree,
        pickRateFree: offeredFree === 0 ? 0 : pickedFree / offeredFree,
      }
    })
    // Sorted by pick rate, because that is the column the exit criterion reads.
    .sort((a, b) => b.pickRate - a.pickRate || b.offered - a.offered)

  const seen = new Set(rows.map((row) => row.defId))
  return {
    rows,
    neverOffered: ALL_ITEM_IDS.filter((id) => !seen.has(id)),
    neverPicked: rows.filter((row) => row.picked === 0).map((row) => row.defId),
    totalChoices,
    totalOfferSlots,
    choicesDeclined,
    maxChoiceTicks,
    maxChoiceScriptTicks,
    choicesUnresolvedAtRunEnd: unresolved,
  }
}

export interface EconomyReport {
  /** Balance left at run end, summed. Scrap that never became anything. */
  scrapUnspent: number
  scrapSpent: number
  /** Unspent plus spent. What the sector actually paid out. */
  scrapEarned: number
  /** scrapSpent / scrapEarned. Zero means the shop is decoration. */
  spendRate: number
  shopChoices: number
  shopPurchases: number
  shopDeclines: number
  shopOptions: number
  /** Options priced above the pilot's balance at the moment the screen opened. */
  shopOptionsUnaffordable: number
  /** Screens where NOT ONE option was affordable. The economy's failure mode. */
  shopsWithNothingAffordable: number
  medianScrapAtShop: number
  medianCheapestShopCost: number
  /**
   * The same figures split by which shop of the run it was.
   *
   * Aggregating over shops hides the actual shape of the problem: a first shop
   * nobody can afford and a second one everybody can averages to "half the options
   * are too dear", which reads as a pricing curve rather than as one dead screen.
   */
  byShop: ReadonlyArray<{
    ordinal: number
    screens: number
    purchases: number
    nothingAffordable: number
    medianScrap: number
    medianCheapest: number
  }>
}

function summariseEconomy(runs: readonly RunResult[]): EconomyReport {
  let scrapUnspent = 0
  let scrapSpent = 0
  let shopChoices = 0
  let shopPurchases = 0
  let shopOptions = 0
  let shopOptionsUnaffordable = 0
  let shopsWithNothingAffordable = 0
  const scrapAtShop: number[] = []
  const cheapest: number[] = []

  interface ShopAcc {
    screens: number
    purchases: number
    nothingAffordable: number
    scrap: number[]
    cheapest: number[]
  }
  const perShop = new Map<number, ShopAcc>()

  for (const run of runs) {
    scrapUnspent += run.scrap
    scrapSpent += run.scrapSpent
    for (const choice of run.choices) {
      if (choice.kind !== 'shop') continue
      shopChoices++
      if (choice.takenId !== null) shopPurchases++
      shopOptions += choice.offers.length
      let affordableHere = 0
      let min = Infinity
      for (const offer of choice.offers) {
        if (offer.affordable) affordableHere++
        else shopOptionsUnaffordable++
        if (offer.cost < min) min = offer.cost
      }
      const dead = affordableHere === 0 && choice.offers.length > 0
      if (dead) shopsWithNothingAffordable++
      scrapAtShop.push(choice.scrapAtOpen)
      if (Number.isFinite(min)) cheapest.push(min)

      let bucket = perShop.get(choice.shopOrdinal)
      if (bucket === undefined) {
        bucket = { screens: 0, purchases: 0, nothingAffordable: 0, scrap: [], cheapest: [] }
        perShop.set(choice.shopOrdinal, bucket)
      }
      bucket.screens++
      if (choice.takenId !== null) bucket.purchases++
      if (dead) bucket.nothingAffordable++
      bucket.scrap.push(choice.scrapAtOpen)
      if (Number.isFinite(min)) bucket.cheapest.push(min)
    }
  }

  const earned = scrapUnspent + scrapSpent
  return {
    scrapUnspent,
    scrapSpent,
    scrapEarned: earned,
    spendRate: earned === 0 ? 0 : scrapSpent / earned,
    shopChoices,
    shopPurchases,
    shopDeclines: shopChoices - shopPurchases,
    shopOptions,
    shopOptionsUnaffordable,
    shopsWithNothingAffordable,
    medianScrapAtShop: percentile(sortedNumbers(scrapAtShop), 0.5),
    medianCheapestShopCost: percentile(sortedNumbers(cheapest), 0.5),
    byShop: [...perShop.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ordinal, bucket]) => ({
        ordinal,
        screens: bucket.screens,
        purchases: bucket.purchases,
        nothingAffordable: bucket.nothingAffordable,
        medianScrap: percentile(sortedNumbers(bucket.scrap), 0.5),
        medianCheapest: percentile(sortedNumbers(bucket.cheapest), 0.5),
      })),
  }
}

export interface InteractionSplit {
  id: string
  withRuns: number
  withoutRuns: number
  /** Fraction of runs that ended 'extracted' — the actual win path. */
  withClearRate: number
  withoutClearRate: number
  clearDelta: number
  withMedianSeconds: number
  withoutMedianSeconds: number
  secondsDelta: number
}

export interface BuildReport {
  /** Runs that ended holding at least one item. */
  runsWithItems: number
  meanItemsHeld: number
  /** Item id → runs that ended holding it, and how many held more than one. */
  heldAtEnd: ReadonlyArray<{ defId: string; runs: number; share: number; stackedRuns: number }>
  /** Interaction id → runs that ended with it live. */
  liveAtEnd: ReadonlyArray<{ id: string; runs: number; share: number }>
  /** Declared interactions that never went live in any run. */
  neverActive: readonly string[]
  /**
   * Win rate and survival split by whether the interaction was live.
   *
   * This is the point of the whole section: a synergy's strength becomes a
   * measured delta instead of a claim in a comment. It is a correlation, not a
   * causal estimate — an interaction is only live in runs that survived long
   * enough to be offered both halves — so the sign is trustworthy and the
   * magnitude is an upper bound. See COVERAGE.
   */
  splits: readonly InteractionSplit[]
}

function summariseBuilds(runs: readonly RunResult[]): BuildReport {
  const heldRuns = new Map<string, number>()
  const stackedRuns = new Map<string, number>()
  const liveRuns = new Map<string, number>()
  let totalHeld = 0
  let runsWithItems = 0

  for (const run of runs) {
    const unique = new Set(run.finalInventory)
    if (unique.size > 0) runsWithItems++
    totalHeld += unique.size
    for (const defId of unique) {
      heldRuns.set(defId, (heldRuns.get(defId) ?? 0) + 1)
      if ((run.finalStacks[defId] ?? 1) > 1) {
        stackedRuns.set(defId, (stackedRuns.get(defId) ?? 0) + 1)
      }
    }
    for (const id of new Set(run.finalInteractions)) {
      liveRuns.set(id, (liveRuns.get(id) ?? 0) + 1)
    }
  }

  const total = runs.length
  const splits: InteractionSplit[] = []
  for (const id of ALL_INTERACTION_IDS) {
    const withRuns = runs.filter((run) => run.finalInteractions.includes(id))
    const withoutRuns = runs.filter((run) => !run.finalInteractions.includes(id))
    if (withRuns.length === 0) continue
    const clearRate = (list: readonly RunResult[]): number =>
      list.length === 0 ? 0 : list.filter((r) => r.runState === 'extracted').length / list.length
    const median = (list: readonly RunResult[]): number =>
      percentile(sortedNumbers(list.map((r) => r.seconds)), 0.5)
    splits.push({
      id,
      withRuns: withRuns.length,
      withoutRuns: withoutRuns.length,
      withClearRate: clearRate(withRuns),
      withoutClearRate: clearRate(withoutRuns),
      clearDelta: clearRate(withRuns) - clearRate(withoutRuns),
      withMedianSeconds: median(withRuns),
      withoutMedianSeconds: median(withoutRuns),
      secondsDelta: median(withRuns) - median(withoutRuns),
    })
  }

  return {
    runsWithItems,
    meanItemsHeld: total === 0 ? 0 : totalHeld / total,
    heldAtEnd: [...heldRuns.entries()]
      .map(([defId, count]) => ({
        defId,
        runs: count,
        share: total === 0 ? 0 : count / total,
        stackedRuns: stackedRuns.get(defId) ?? 0,
      }))
      .sort((a, b) => b.runs - a.runs),
    liveAtEnd: [...liveRuns.entries()]
      .map(([id, count]) => ({ id, runs: count, share: total === 0 ? 0 : count / total }))
      .sort((a, b) => b.runs - a.runs),
    neverActive: ALL_INTERACTION_IDS.filter((id) => !liveRuns.has(id)),
    splits,
  }
}

// ---------------------------------------------------------------------------
// M5: the five-sector run, per sector
// ---------------------------------------------------------------------------

export interface SectorRow {
  index: number
  sectorId: string
  sectorName: string
  waveCount: number

  entered: number
  cleared: number
  died: number
  unfinished: number
  /** cleared / entered. The conditional clear rate — the shape of the curve. */
  clearRate: number
  /**
   * This sector's share of ALL deaths in the sweep.
   *
   * The number M5's third exit criterion is written against ("no single spike
   * above 35%"). Deliberately NOT the same as `1 - clearRate`: a sector that kills
   * everyone who reaches it is a cliff only if people reach it, and a conditional
   * rate on eleven survivors is not a spike.
   */
  deathShare: number

  medianSeconds: number
  /** Entry state, at the median across every run that arrived. */
  medianEntryScrap: number
  medianEntryItems: number
  medianEntryIntegrity: number
  medianEntryHealthPct: number
  /** Damage x volley x rate at entry. An UPPER BOUND — see `entryCeilingDps`. */
  medianEntryCeilingDps: number
  p10EntryCeilingDps: number
  p90EntryCeilingDps: number
  /** Realised dps: observed damage dealt over ENGAGED seconds. Includes uptime. */
  medianSectorDps: number
  medianDamageTaken: number
  /**
   * Incoming damage per ENGAGED second. How hard the sector hits, build-independent.
   */
  medianIncomingDps: number
  /**
   * Effective health at entry divided by incoming damage per engaged second.
   *
   * "Seconds of contact this pilot could survive on arrival." The point of it is to
   * separate two explanations of a death spike that a clear rate cannot: a sector
   * that throws more damage, and a sector entered by a weaker pilot. Both move the
   * clear rate; only the first moves incoming dps, and only the second moves entry
   * health. This combines them into the number that actually decides the fight.
   */
  medianSurvivableSeconds: number
  /** Runs that arrived with at least one hazard armed. */
  hazardRuns: number

  deathsDuringWaves: number
  deathsDuringBoss: number
  medianDeathWave: number
  topDeathCauses: ReadonlyArray<[string, number]>

  bossId: string | null
  bossName: string | null
  bossHp: number | null
  bossEncounters: number
  bossKills: number
  bossKillRate: number
  /** Seconds from `boss-spawned` to `boss-killed`, over kills only. */
  bossTtkMedian: number
  bossTtkP10: number
  bossTtkP90: number
  /** bossHp / measured ttk. The realistic dps the boss HP figures should assume. */
  bossDpsMedian: number
  /** Phase index the pilot reached when they died to this boss. */
  bossPhaseAtDeath: Readonly<Record<number, number>>
}

export interface SectorReport {
  rows: readonly SectorRow[]
  totalRuns: number
  totalDeaths: number
  /** Runs that reached 'extracted'. The five-sector clear rate. */
  fullClears: number
  fullClearRate: number
  /** Sector time of a completed run, median seconds. Zero when none completed. */
  medianClearSeconds: number
}

function summariseSectors(runs: readonly RunResult[]): SectorReport {
  const byIndex = new Map<number, StageObservation[]>()
  for (const run of runs) {
    for (const stage of run.stages) {
      let bucket = byIndex.get(stage.index)
      if (bucket === undefined) {
        bucket = []
        byIndex.set(stage.index, bucket)
      }
      bucket.push(stage)
    }
  }

  const totalDeaths = runs.filter((r) => r.runState === 'lost').length
  const rows: SectorRow[] = []

  for (const [index, observed] of [...byIndex.entries()].sort((a, b) => a[0] - b[0])) {
    const first = observed[0] as StageObservation
    const died = observed.filter((s) => s.outcome === 'died')
    const withBoss = observed.filter((s) => s.bossSpawned)
    const killed = withBoss.filter((s) => s.bossKilled && s.bossTicks !== null)
    const bossId = observed.find((s) => s.bossId !== null)?.bossId ?? null
    const bossHp = bossId === null ? null : (BOSS_HP[bossId] ?? null)
    const ttk = sortedNumbers(killed.map((s) => (s.bossTicks as number) / TICK_HZ))

    const causes: Record<string, number> = {}
    const phases: Record<number, number> = {}
    for (const stage of died) {
      const key = `${stage.deathCauseKind ?? 'unattributed'}:${stage.deathCauseId ?? '-'}`
      causes[key] = (causes[key] ?? 0) + 1
      if (stage.diedToBoss) phases[stage.bossPhaseReached] = (phases[stage.bossPhaseReached] ?? 0) + 1
    }

    const entryDps = sortedNumbers(observed.map((s) => s.entryCeilingDps))
    const sectorDps = observed
      .filter((s) => s.engagedTicks > 0)
      .map((s) => s.damageDealt / (s.engagedTicks / TICK_HZ))
    const engaged = observed.filter((s) => s.engagedTicks > 0)
    const incoming = engaged.map((s) => s.damageTaken / (s.engagedTicks / TICK_HZ))
    const survivable = engaged
      .map((s) => {
        const rate = s.damageTaken / (s.engagedTicks / TICK_HZ)
        return rate <= 0 ? Infinity : (s.entryIntegrity + s.entryShield) / rate
      })
      .filter((v) => Number.isFinite(v))

    rows.push({
      index,
      sectorId: first.sectorId,
      sectorName: first.sectorName,
      waveCount: first.waveCount,
      entered: observed.length,
      cleared: observed.filter((s) => s.outcome === 'cleared').length,
      died: died.length,
      unfinished: observed.filter((s) => s.outcome === 'unfinished').length,
      clearRate:
        observed.length === 0
          ? 0
          : observed.filter((s) => s.outcome === 'cleared').length / observed.length,
      deathShare: totalDeaths === 0 ? 0 : died.length / totalDeaths,
      medianSeconds: percentile(sortedNumbers(observed.map((s) => s.ticks / TICK_HZ)), 0.5),
      medianEntryScrap: percentile(sortedNumbers(observed.map((s) => s.entryScrap)), 0.5),
      medianEntryItems: percentile(sortedNumbers(observed.map((s) => s.entryItems)), 0.5),
      medianEntryIntegrity: percentile(sortedNumbers(observed.map((s) => s.entryIntegrity)), 0.5),
      // Effective HP over MAXIMUM effective HP. The denominator has to be the
      // pilot's ceiling, not the shield they happen to be carrying — see
      // `entryMaxShield`, which this divided by the current shield for the whole of
      // M5 and so cancelled it out of the reading entirely.
      medianEntryHealthPct: percentile(
        sortedNumbers(
          observed.map((s) =>
            s.entryMaxIntegrity + s.entryMaxShield === 0
              ? 0
              : (s.entryIntegrity + s.entryShield) / (s.entryMaxIntegrity + s.entryMaxShield),
          ),
        ),
        0.5,
      ),
      medianEntryCeilingDps: percentile(entryDps, 0.5),
      p10EntryCeilingDps: percentile(entryDps, 0.1),
      p90EntryCeilingDps: percentile(entryDps, 0.9),
      medianSectorDps: percentile(sortedNumbers(sectorDps), 0.5),
      medianDamageTaken: percentile(sortedNumbers(observed.map((s) => s.damageTaken)), 0.5),
      medianIncomingDps: percentile(sortedNumbers(incoming), 0.5),
      medianSurvivableSeconds: percentile(sortedNumbers(survivable), 0.5),
      hazardRuns: observed.filter((s) => s.hazardIds.length > 0).length,
      deathsDuringWaves: died.filter((s) => !s.diedToBoss).length,
      deathsDuringBoss: died.filter((s) => s.diedToBoss).length,
      medianDeathWave: percentile(sortedNumbers(died.map((s) => s.deathWaveIndex ?? 0)), 0.5),
      topDeathCauses: Object.entries(causes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4),
      bossId,
      bossName: observed.find((s) => s.bossName !== null)?.bossName ?? null,
      bossHp,
      bossEncounters: withBoss.length,
      bossKills: killed.length,
      bossKillRate: withBoss.length === 0 ? 0 : killed.length / withBoss.length,
      bossTtkMedian: percentile(ttk, 0.5),
      bossTtkP10: percentile(ttk, 0.1),
      bossTtkP90: percentile(ttk, 0.9),
      bossDpsMedian:
        bossHp === null || ttk.length === 0 || percentile(ttk, 0.5) === 0
          ? 0
          : bossHp / percentile(ttk, 0.5),
      bossPhaseAtDeath: phases,
    })
  }

  const clears = runs.filter((r) => r.runState === 'extracted')
  return {
    rows,
    totalRuns: runs.length,
    totalDeaths,
    fullClears: clears.length,
    fullClearRate: runs.length === 0 ? 0 : clears.length / runs.length,
    medianClearSeconds: percentile(sortedNumbers(clears.map((r) => r.seconds)), 0.5),
  }
}

/**
 * What the policies did with the world map, and what it cost them.
 *
 * NEW, and it is new because the conclusion it supports had never been measured
 * directly. M5 recorded that "the world map is no longer a trap" off an ablation
 * between route styles; what nobody printed was how often a detour was actually
 * taken, or whether the sector behind one is survivable. `chooseRoute` is a stated
 * PREFERENCE (see `bots.ts`), so a table of what it prefers is the only way to tell
 * a policy that declines every hazard from one that never saw a card.
 *
 * The conditional clear rates are the trap question in its honest form: the clear
 * rate of a sector entered with a hazard armed against one entered without, pooled
 * over sectors 2-5. It is still not a controlled experiment — a policy that takes
 * detours is also a policy that got paid for them — which is what `--route-style`
 * exists to separate.
 */
export interface RouteReport {
  /** Sectors arrived at through a seam. Sector one is not one. */
  seams: number
  /** Seams where the free direct approach was taken. */
  direct: number
  /** Seams where a hazard was accepted for a reward. */
  detour: number
  /**
   * Seams whose approach could not be matched to an offered route.
   *
   * Not an error and not hidden: a sector with no hazards has no card to show, so
   * there is nothing to attribute. See `matchRoute` and COVERAGE.
   */
  unmatched: number
  /** Sectors entered with at least one hazard armed. The exact reading. */
  hazardArmed: number
  /** Reward kind taken, by name. Unreliable when a sector has one hazard — COVERAGE. */
  byReward: Readonly<Record<string, number>>
  enteredWithHazard: number
  clearedWithHazard: number
  enteredWithoutHazard: number
  clearedWithoutHazard: number
}

function summariseRoutes(runs: readonly RunResult[]): RouteReport {
  const byReward: Record<string, number> = {}
  const report = {
    seams: 0,
    direct: 0,
    detour: 0,
    unmatched: 0,
    hazardArmed: 0,
    enteredWithHazard: 0,
    clearedWithHazard: 0,
    enteredWithoutHazard: 0,
    clearedWithoutHazard: 0,
  }
  for (const run of runs) {
    for (const stage of run.stages) {
      if (stage.index === 0) continue
      report.seams++
      if (stage.routeIndex === null) report.unmatched++
      else if (stage.routeIndex === 0) report.direct++
      else {
        report.detour++
        const reward = stage.routeReward ?? 'unknown'
        byReward[reward] = (byReward[reward] ?? 0) + 1
      }
      if (stage.hazardIds.length > 0) {
        report.hazardArmed++
        report.enteredWithHazard++
        if (stage.outcome === 'cleared') report.clearedWithHazard++
      } else {
        report.enteredWithoutHazard++
        if (stage.outcome === 'cleared') report.clearedWithoutHazard++
      }
    }
  }
  return { ...report, byReward }
}

function printRoutes(summaries: readonly PolicySummary[]): void {
  console.log('')
  console.log('ROUTES — what each probe did at the seams, and whether the detour was survivable')
  const header =
    `  ${pad('policy', 14)}${pad('style', 11)}${padStart('seams', 7)}${padStart('direct', 8)}${padStart('detour', 8)}` +
    `${padStart('detour%', 9)}${padStart('hazard', 8)}${padStart('clear w/', 10)}${padStart('clear w/o', 11)}${padStart('rewards taken', 24)}`
  console.log(header)
  console.log(`  ${'-'.repeat(header.length - 2)}`)
  for (const summary of summaries) {
    const r = summary.routes
    const rewards = Object.entries(r.byReward)
      .sort((a, b) => b[1] - a[1])
      .map(([kind, n]) => `${kind} ${n}`)
      .join(', ')
    console.log(
      `  ${pad(summary.policy, 14)}${pad(summary.routeStyle, 11)}${padStart(String(r.seams), 7)}` +
        `${padStart(String(r.direct), 8)}${padStart(String(r.detour), 8)}` +
        `${padStart(r.seams === 0 ? '-' : pct(r.detour / r.seams), 9)}` +
        `${padStart(r.seams === 0 ? '-' : pct(r.hazardArmed / r.seams), 8)}` +
        `${padStart(r.enteredWithHazard === 0 ? '-' : pct(r.clearedWithHazard / r.enteredWithHazard), 10)}` +
        `${padStart(r.enteredWithoutHazard === 0 ? '-' : pct(r.clearedWithoutHazard / r.enteredWithoutHazard), 11)}` +
        `${padStart(rewards === '' ? '-' : rewards.slice(0, 23), 24)}`,
    )
  }
  console.log('')
  console.log(
    '  seams = sectors arrived at through a route card (sector one is not one). detour = a hazard accepted',
  )
  console.log(
    '  for a reward; hazard = sectors that actually armed one, which is the exact reading (the reward kind',
  )
  console.log(
    '  is inferred and unreliable when a sector has only one hazard — see COVERAGE). clear w/ and w/o are',
  )
  console.log(
    '  the clear rate of a sector entered WITH a hazard against WITHOUT, pooled over sectors 2-5: the',
  )
  console.log(
    '  "is the world map a trap" number. NOT a controlled comparison — a probe that takes detours also',
  )
  console.log('  collects their rewards, and `--route-style` is the switch that separates the two.')
}

export interface PolicySummary {
  policy: BotName
  measures: string
  runs: number
  lost: number
  extracted: number
  stillActive: number
  truncated: number
  /** Fraction of runs that did not end in a loss. */
  survivalRate: number
  seconds: { p10: number; median: number; p90: number; max: number }
  wave: { median: number; max: number }
  kills: { median: number; mean: number }
  scrap: { median: number; mean: number }
  accuracy: number
  damageTaken: { median: number }
  peakProjectiles: number
  /** `enemy-fire:skiff` style keys, counted. Only lost runs. */
  deathsByCause: Record<string, number>
  deathsByKind: Record<string, number>
  /** Deaths per vertical third of the playfield: [top, middle, bottom]. */
  deathThirdsVertical: [number, number, number]
  /** Deaths per horizontal third: [left, centre, right]. */
  deathThirdsHorizontal: [number, number, number]
  /** M3: offer rate vs pick rate per item, for this policy alone. */
  items: ItemReport
  economy: EconomyReport
  builds: BuildReport
  /** M5: how far the run got, sector by sector. */
  sectors: SectorReport
  /** M5: what it did at the seams. */
  routes: RouteReport
  /** Default world-map appetite of this probe, or the sweep's override. */
  routeStyle: RouteStyle
  /** Runs that reached 'extracted' — a completed five-sector run. */
  fullClearRate: number
  /** Mean stages cleared. A blunt depth number that survives a 0% clear rate. */
  meanStagesCleared: number
}

function summarise(policy: BotName, runs: readonly RunResult[]): PolicySummary {
  const lostRuns = runs.filter((r) => r.runState === 'lost')
  const seconds = sortedNumbers(runs.map((r) => r.seconds))
  const waves = sortedNumbers(runs.map((r) => r.waveIndex))
  const kills = runs.map((r) => r.kills)
  const scrap = runs.map((r) => r.scrap)

  const deathsByCause: Record<string, number> = {}
  const deathsByKind: Record<string, number> = {}
  const vertical: [number, number, number] = [0, 0, 0]
  const horizontal: [number, number, number] = [0, 0, 0]
  for (const run of lostRuns) {
    const key = `${run.causeKind}:${run.causeEnemyId ?? '-'}`
    deathsByCause[key] = (deathsByCause[key] ?? 0) + 1
    deathsByKind[run.causeKind] = (deathsByKind[run.causeKind] ?? 0) + 1
    const vIndex = Math.min(2, Math.max(0, Math.floor((run.endY / Playfield.h) * 3)))
    const hIndex = Math.min(2, Math.max(0, Math.floor((run.endX / Playfield.w) * 3)))
    vertical[vIndex] = (vertical[vIndex] ?? 0) + 1
    horizontal[hIndex] = (horizontal[hIndex] ?? 0) + 1
  }

  const totalShots = runs.reduce((sum, r) => sum + r.shotsFired, 0)
  const totalHits = runs.reduce((sum, r) => sum + r.hits, 0)

  return {
    policy,
    measures: BOTS[policy].measures,
    runs: runs.length,
    lost: lostRuns.length,
    extracted: runs.filter((r) => r.runState === 'extracted').length,
    stillActive: runs.filter((r) => r.runState === 'active').length,
    truncated: runs.filter((r) => r.truncated).length,
    survivalRate: runs.length === 0 ? 0 : 1 - lostRuns.length / runs.length,
    seconds: {
      p10: percentile(seconds, 0.1),
      median: percentile(seconds, 0.5),
      p90: percentile(seconds, 0.9),
      max: seconds[seconds.length - 1] ?? 0,
    },
    wave: { median: percentile(waves, 0.5), max: waves[waves.length - 1] ?? 0 },
    kills: { median: percentile(sortedNumbers(kills), 0.5), mean: mean(kills) },
    scrap: { median: percentile(sortedNumbers(scrap), 0.5), mean: mean(scrap) },
    accuracy: totalShots === 0 ? 0 : totalHits / totalShots,
    damageTaken: { median: percentile(sortedNumbers(runs.map((r) => r.damageTaken)), 0.5) },
    peakProjectiles: runs.reduce((max, r) => Math.max(max, r.peakProjectiles), 0),
    deathsByCause,
    deathsByKind,
    deathThirdsVertical: vertical,
    deathThirdsHorizontal: horizontal,
    items: summariseItems(runs),
    economy: summariseEconomy(runs),
    builds: summariseBuilds(runs),
    sectors: summariseSectors(runs),
    routes: summariseRoutes(runs),
    routeStyle: runs[0]?.routeStyle ?? BOTS[policy].routeStyle,
    fullClearRate:
      runs.length === 0 ? 0 : runs.filter((r) => r.runState === 'extracted').length / runs.length,
    meanStagesCleared: mean(runs.map((r) => r.stagesCleared)),
  }
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function topCauses(summary: PolicySummary, limit: number): string {
  const entries = Object.entries(summary.deathsByCause).sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return '(no deaths)'
  return entries
    .slice(0, limit)
    .map(([key, count]) => `${key} ${((count / summary.lost) * 100).toFixed(0)}%`)
    .join(', ')
}

function printTable(summaries: readonly PolicySummary[]): void {
  const columns: Array<[string, number, (s: PolicySummary) => string]> = [
    ['policy', 10, (s) => s.policy],
    ['route', 11, (s) => s.routeStyle],
    ['runs', 6, (s) => String(s.runs)],
    // The M5 number. `surv` counts a truncated run as survival; `clear` counts only
    // a run that actually reached the extraction at the end of sector five.
    ['clear', 7, (s) => pct(s.fullClearRate)],
    ['stages', 7, (s) => s.meanStagesCleared.toFixed(2)],
    ['surv', 7, (s) => pct(s.survivalRate)],
    ['p10 s', 7, (s) => s.seconds.p10.toFixed(1)],
    ['med s', 7, (s) => s.seconds.median.toFixed(1)],
    ['p90 s', 7, (s) => s.seconds.p90.toFixed(1)],
    ['wave', 9, (s) => `${s.wave.median}/${s.wave.max}`],
    ['kills', 7, (s) => s.kills.median.toFixed(0)],
    ['acc', 7, (s) => pct(s.accuracy)],
    ['scrap', 7, (s) => s.scrap.median.toFixed(0)],
    ['dmg', 6, (s) => s.damageTaken.median.toFixed(0)],
  ]

  const header = columns.map(([name, width]) => pad(name, width)).join('')
  console.log(header)
  console.log('-'.repeat(header.length))
  for (const summary of summaries) {
    console.log(
      columns
        .map(([, width, get], i) => (i === 0 ? pad(get(summary), width) : padStart(get(summary), width - 1) + ' '))
        .join(''),
    )
  }
  console.log('')
  console.log(
    'clear = full five-sector runs, the M5 number. stages = mean sectors cleared, which stays' +
      ' informative at a 0% clear rate. wave is median/max WITHIN A SECTOR, so it is no longer',
  )
  console.log(
    'survival time re-expressed. p10/med/p90 are survival time in seconds across the whole run.',
  )
}

function printDeaths(summaries: readonly PolicySummary[]): void {
  console.log('')
  console.log('DEATHS')
  for (const summary of summaries) {
    if (summary.lost === 0) {
      console.log(`  ${pad(summary.policy, 10)} no deaths in ${summary.runs} runs`)
      continue
    }
    console.log(`  ${summary.policy}  (${summary.lost} of ${summary.runs} runs)`)
    const kinds = Object.entries(summary.deathsByKind).sort((a, b) => b[1] - a[1])
    console.log(
      `    by kind: ${kinds.map(([k, n]) => `${k} ${((n / summary.lost) * 100).toFixed(0)}%`).join(', ')}`,
    )
    console.log(`    by cause: ${topCauses(summary, 6)}`)
    const [top, mid, bottom] = summary.deathThirdsVertical
    const [left, centre, right] = summary.deathThirdsHorizontal
    const share = (n: number) => `${((n / summary.lost) * 100).toFixed(0)}%`
    console.log(
      `    where (vertical thirds): top ${share(top)}  middle ${share(mid)}  bottom ${share(bottom)}`,
    )
    console.log(
      `    where (horizontal thirds): left ${share(left)}  centre ${share(centre)}  right ${share(right)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// M5 reporting
// ---------------------------------------------------------------------------

/** M5's third exit criterion: no sector may own more than this share of deaths. */
const DEATH_SPIKE_MAX = 0.35
/** M5's first exit criterion: a competent policy's full-run clear rate band. */
const CLEAR_RATE_BAND = { min: 0.2, max: 0.4 } as const
/** M5's second exit criterion: hull spread around the mean, in percentage points. */
const HULL_SPREAD_MAX_PP = 15

/**
 * The per-sector table. THE central output of an M5 sweep.
 *
 * Every column here answers something the aggregate cannot. `enter` and `clear%`
 * separate "hard" from "rarely reached"; `death%` is the cliff criterion and is a
 * share of all deaths rather than a conditional rate; `dps` is what the boss HP
 * ladder in `src/content/bosses.ts` is built on.
 */
function printSectors(report: SectorReport, label: string): void {
  console.log('')
  console.log(`PER-SECTOR — ${label}`)
  if (report.rows.length === 0) {
    console.log('  no sector was entered')
    return
  }
  const header =
    `  ${pad('#', 3)}${pad('sector', 16)}${padStart('enter', 7)}${padStart('clear', 7)}${padStart('clear%', 8)}` +
    `${padStart('died', 6)}${padStart('death%', 8)}${padStart('med s', 8)}${padStart('scrap', 8)}` +
    `${padStart('items', 7)}${padStart('hp%', 7)}${padStart('dps', 7)}${padStart('real', 7)}` +
    `${padStart('incoming', 10)}${padStart('survive s', 11)}${padStart('hazard', 8)}`
  console.log(header)
  console.log(`  ${'-'.repeat(header.length - 2)}`)
  for (const row of report.rows) {
    console.log(
      `  ${pad(String(row.index + 1), 3)}${pad(row.sectorName.slice(0, 15), 16)}` +
        `${padStart(String(row.entered), 7)}${padStart(String(row.cleared), 7)}${padStart(pct(row.clearRate), 8)}` +
        `${padStart(String(row.died), 6)}${padStart(pct(row.deathShare), 8)}` +
        `${padStart(row.medianSeconds.toFixed(0), 8)}${padStart(row.medianEntryScrap.toFixed(0), 8)}` +
        `${padStart(row.medianEntryItems.toFixed(0), 7)}${padStart(pct(row.medianEntryHealthPct), 7)}` +
        `${padStart(row.medianEntryCeilingDps.toFixed(0), 7)}${padStart(row.medianSectorDps.toFixed(0), 7)}` +
        `${padStart(row.medianIncomingDps.toFixed(1), 10)}${padStart(row.medianSurvivableSeconds.toFixed(1), 11)}` +
        `${padStart(pct(row.entered === 0 ? 0 : row.hazardRuns / row.entered), 8)}`,
    )
  }
  console.log('')
  console.log(
    '  clear% is conditional on ARRIVING; death% is this sector\'s share of every death in the sweep,',
  )
  console.log(
    '  which is the number the "no difficulty cliff" criterion is written against. scrap/items/hp%/dps',
  )
  console.log(
    '  are medians AT ENTRY. dps is the CEILING (damage x volley x rate, all shots on one target); real is',
  )
  console.log(
    '  observed damage dealt over ENGAGED seconds (ticks with an enemy on screen), so it carries trigger',
  )
  console.log(
    '  uptime, accuracy and dodging without being diluted by the gaps the wave script leaves.',
  )
  console.log(
    '  incoming = damage TAKEN per engaged second; survive s = effective health at entry / incoming.',
  )
  console.log(
    '  Those two split a death spike into its causes: a sector that hits harder moves `incoming`, a',
  )
  console.log(
    '  sector entered by a weaker pilot moves `hp%`, and only `survive s` combines them the way the',
  )
  console.log('  fight does. It is the column to read when clear% and death% disagree.')

  console.log('')
  console.log('  where the deaths happened')
  for (const row of report.rows) {
    if (row.died === 0) {
      console.log(`  ${pad(`${row.index + 1} ${row.sectorName}`, 20)} no deaths`)
      continue
    }
    const phases = Object.entries(row.bossPhaseAtDeath)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([phase, n]) => `p${phase}:${n}`)
      .join(' ')
    console.log(
      `  ${pad(`${row.index + 1} ${row.sectorName}`, 20)} ${padStart(String(row.died), 4)} deaths — ` +
        `${row.deathsDuringWaves} in the waves (median wave ${row.medianDeathWave}/${row.waveCount}), ` +
        `${row.deathsDuringBoss} on the boss${phases === '' ? '' : ` [${phases}]`}`,
    )
    console.log(
      `  ${' '.repeat(20)} ${row.topDeathCauses
        .map(([cause, n]) => `${cause} ${((n / row.died) * 100).toFixed(0)}%`)
        .join(', ')}`,
    )
  }
}

/**
 * Boss defeat rates and measured time-to-kill against what the content assumed.
 *
 * `src/content/bosses.ts` derives every boss's HP from `SECTOR_PLAYER_DPS` and
 * states a band of 20-40 seconds at full uptime. Both halves are checkable here:
 * the measured ttk is the fight the player actually has, and `hp / ttk` is the dps
 * the HP figure should have been divided by.
 */
function printBosses(report: SectorReport): void {
  const rows = report.rows.filter((row) => row.bossId !== null)
  if (rows.length === 0) return
  console.log('')
  console.log('BOSSES — defeat rate and measured time-to-kill')
  const header =
    `  ${pad('#', 3)}${pad('boss', 20)}${padStart('hp', 7)}${padStart('met', 6)}${padStart('killed', 8)}` +
    `${padStart('kill%', 8)}${padStart('ttk p10', 9)}${padStart('ttk med', 9)}${padStart('ttk p90', 9)}` +
    `${padStart('hp/ttk', 8)}${padStart('assumed', 9)}`
  console.log(header)
  console.log(`  ${'-'.repeat(header.length - 2)}`)
  for (const row of rows) {
    const assumed = SECTOR_PLAYER_DPS[row.index]
    console.log(
      `  ${pad(String(row.index + 1), 3)}${pad((row.bossName ?? row.bossId ?? '?').slice(0, 19), 20)}` +
        `${padStart(String(row.bossHp ?? 0), 7)}${padStart(String(row.bossEncounters), 6)}` +
        `${padStart(String(row.bossKills), 8)}${padStart(pct(row.bossKillRate), 8)}` +
        `${padStart(row.bossKills === 0 ? '-' : row.bossTtkP10.toFixed(1), 9)}` +
        `${padStart(row.bossKills === 0 ? '-' : row.bossTtkMedian.toFixed(1), 9)}` +
        `${padStart(row.bossKills === 0 ? '-' : row.bossTtkP90.toFixed(1), 9)}` +
        `${padStart(row.bossKills === 0 ? '-' : row.bossDpsMedian.toFixed(0), 8)}` +
        `${padStart(assumed === undefined ? '-' : String(assumed), 9)}`,
    )
  }
  console.log('')
  console.log(
    `  hp/ttk is the dps the fight actually took, measured. assumed is SECTOR_PLAYER_DPS from`,
  )
  console.log(
    `  src/content/bosses.ts, which every HP figure in that file is divided by. ttk band is` +
      ` ${20}-${40}s at full uptime.`,
  )
  console.log('  kill% is conditional on the boss having spawned at all.')
}

/**
 * The assumed dps ladder against three measured ones.
 *
 * Printed as its own block because it is the highest-leverage number in M5: if the
 * ladder is wrong then all five boss HP figures are wrong with it, and no amount of
 * per-phase tuning fixes a fight that is twice as long as intended.
 */
function printDpsLadder(report: SectorReport): void {
  console.log('')
  console.log('PLAYER DPS LADDER — SECTOR_PLAYER_DPS against what the sweep measured')
  const header =
    `  ${pad('#', 3)}${pad('sector', 16)}${padStart('assumed', 9)}${padStart('ceiling', 9)}` +
    `${padStart('p10', 8)}${padStart('p90', 8)}${padStart('realised', 10)}${padStart('boss dps', 10)}${padStart('ratio', 8)}`
  console.log(header)
  console.log(`  ${'-'.repeat(header.length - 2)}`)
  for (const row of report.rows) {
    const assumed = SECTOR_PLAYER_DPS[row.index]
    // Ratio is read off the BOSS figure, not the ceiling: a boss fight is the only
    // sustained single-target engagement in the game, which is exactly the situation
    // SECTOR_PLAYER_DPS was authored to describe.
    const ratio =
      assumed === undefined || assumed === 0 || row.bossKills === 0
        ? 0
        : row.bossDpsMedian / assumed
    console.log(
      `  ${pad(String(row.index + 1), 3)}${pad(row.sectorName.slice(0, 15), 16)}` +
        `${padStart(assumed === undefined ? '-' : String(assumed), 9)}` +
        `${padStart(row.medianEntryCeilingDps.toFixed(0), 9)}${padStart(row.p10EntryCeilingDps.toFixed(0), 8)}` +
        `${padStart(row.p90EntryCeilingDps.toFixed(0), 8)}${padStart(row.medianSectorDps.toFixed(0), 10)}` +
        `${padStart(row.bossKills === 0 ? '-' : row.bossDpsMedian.toFixed(0), 10)}` +
        `${padStart(ratio === 0 ? '-' : `${ratio.toFixed(2)}x`, 8)}`,
    )
  }
  console.log('')
  console.log(
    '  ceiling  = projectile damage x MEASURED volley width x volleys/second, at entry. Same arithmetic',
  )
  console.log(
    '             the assumed column was authored from (80 = 4 damage x 1 projectile x 20 shots/s), but',
  )
  console.log(
    '             it assumes EVERY projectile lands on one target — false for a split-shot fan, so this',
  )
  console.log('             is an upper bound and not the number to retune HP against.')
  console.log(
    '  realised = observed damage dealt / engaged seconds. Spread across whatever is on screen.',
  )
  console.log(
    '  boss dps = boss hp / measured time-to-kill. THE COMPARABLE FIGURE: a boss fight is the only',
  )
  console.log(
    '             sustained single-target engagement in the game, which is the situation SECTOR_PLAYER_DPS',
  )
  console.log('             describes. ratio is boss dps / assumed. All figures are medians.')
}

/**
 * Offer rate against pick rate, per item, with the synergy split.
 *
 * The two rate columns are the whole point. `offer%` is how much of the pool an
 * item is; `pick%` is how often a pilot took it when it was on the table. An item
 * can be common and unwanted or rare and irresistible, and only reading both
 * columns tells them apart.
 */
function printItems(report: ItemReport, label: string): void {
  console.log('')
  console.log(`ITEMS — offer rate vs pick rate (${label})`)
  if (report.rows.length === 0) {
    console.log('  no item offers were made in this sweep')
    return
  }
  const header =
    `  ${pad('item', 20)}${padStart('offers', 7)}${padStart('offer%', 8)}` +
    `${padStart('picks', 7)}${padStart('pick%', 8)}${padStart('free%', 8)}${padStart('syn', 6)}${padStart('pick%', 8)}` +
    `${padStart('nosyn', 7)}${padStart('pick%', 8)}${padStart('shop', 6)}${padStart('unaff', 7)}`
  console.log(header)
  console.log(`  ${'-'.repeat(header.length - 2)}`)
  for (const row of report.rows) {
    const synRate = row.offeredWithSynergy === 0 ? '  -' : pct(row.pickedWithSynergy / row.offeredWithSynergy)
    const noSynRate =
      row.offeredWithoutSynergy === 0 ? '  -' : pct(row.pickedWithoutSynergy / row.offeredWithoutSynergy)
    // Flags read at a glance; the verdict block below states them in words.
    const flag = row.offered < MIN_OFFERS_FOR_VERDICT ? ' ?' : row.pickRate > PICK_RATE_MAX ? ' HI' : row.pickRate < PICK_RATE_MIN ? ' LO' : ''
    console.log(
      `  ${pad(row.defId, 20)}${padStart(String(row.offered), 7)}${padStart(pct(row.offerShare), 8)}` +
        `${padStart(String(row.picked), 7)}${padStart(pct(row.pickRate), 8)}${padStart(pct(row.pickRateFree), 8)}` +
        `${padStart(String(row.offeredWithSynergy), 6)}${padStart(synRate, 8)}` +
        `${padStart(String(row.offeredWithoutSynergy), 7)}${padStart(noSynRate, 8)}` +
        `${padStart(String(row.offeredInShop), 6)}${padStart(String(row.offeredUnaffordable), 7)}${flag}`,
    )
  }
  console.log('')
  console.log(
    `  ${report.totalChoices} item/shop screens, ${report.totalOfferSlots} offer slots, ` +
      `${report.choicesDeclined} declined (${pct(report.totalChoices === 0 ? 0 : report.choicesDeclined / report.totalChoices)}), ` +
      `${report.choicesUnresolvedAtRunEnd} never decided (the run ended on them)`,
  )
  console.log(
    `  syn/nosyn split the same offers by whether the screen stated an interaction. ` +
      `? = under ${MIN_OFFERS_FOR_VERDICT} offers, too few to judge.`,
  )
  console.log(
    '  pick% pools free and shop screens; free% covers free screens only, where price cannot interfere.',
  )
  console.log(
    '  READ free% AGAINST 33.3%: on a free three-option screen one option is always taken, so the',
  )
  console.log(
    '  offer-weighted mean of that column is 33.3% by construction and any deviation is a real',
  )
  console.log(
    '  preference. pick% is mechanically lower whenever shop options are unaffordable — see ECONOMY.',
  )
  if (report.neverOffered.length > 0) {
    console.log('')
    console.log(
      `  NEVER OFFERED (${report.neverOffered.length} of ${ALL_ITEM_IDS.length} items in the table): ${report.neverOffered.join(', ')}`,
    )
    console.log(
      '    An item in the content table that no screen ever presented is a pool or weight bug,' +
        ' not a balance finding — no pick rate exists for it at all.',
    )
  } else {
    console.log(`  every one of the ${ALL_ITEM_IDS.length} items in the table was offered at least once`)
  }
  if (report.neverPicked.length > 0) {
    console.log(`  OFFERED BUT NEVER TAKEN: ${report.neverPicked.join(', ')}`)
  }
  console.log(
    `  longest screen open: ${report.maxChoiceTicks} ticks, of which ` +
      `${report.maxChoiceScriptTicks} were the bot's scripted navigation ` +
      `(budget ${MAX_CHOICE_RESOLUTION_TICKS}; the sim has no fallback timeout, so a card this harness does not ` +
      `resolve stays open — ${CHOICE_STALL_ABORT_TICKS} unfrozen ticks on one screen abandons the run. The surplus ` +
      'over the budget is hitstop overlapping a reward screen, which costs nothing. See CHOICE RESOLUTION' +
      ' above, which covers route and work-order cards too; this line only sees cards that carry offers)',
  )
}

/** Pick rate per item per policy, so one heuristic cannot hide behind the mean. */
function printPickRatesByPolicy(summaries: readonly PolicySummary[], aggregate: ItemReport): void {
  if (aggregate.rows.length === 0) return
  console.log('')
  console.log('PICK RATE BY POLICY — offers in brackets; the aggregate above is what M3 is scored on')
  const header = `  ${pad('item', 20)}${summaries.map((s) => padStart(s.policy.slice(0, 11), 13)).join('')}`
  console.log(header)
  console.log(`  ${'-'.repeat(header.length - 2)}`)
  for (const row of aggregate.rows) {
    const cells = summaries.map((summary) => {
      const found = summary.items.rows.find((r) => r.defId === row.defId)
      if (found === undefined || found.offered === 0) return padStart('-', 13)
      return padStart(`${pct(found.pickRate)}(${found.offered})`, 13)
    })
    console.log(`  ${pad(row.defId, 20)}${cells.join('')}`)
  }
}

/**
 * M3's exit criteria, stated as pass or fail against the numbers above.
 *
 * Printed rather than left for a reader to derive, because a criterion nobody
 * evaluates is a criterion nobody meets.
 */
function printExitCriteria(report: ItemReport, builds: BuildReport): void {
  console.log('')
  console.log('M3 EXIT CRITERIA — "no single item above a 70% pick rate and none below 10%"')

  const judged = report.rows.filter((row) => row.offered >= MIN_OFFERS_FOR_VERDICT)
  const tooFew = report.rows.filter((row) => row.offered < MIN_OFFERS_FOR_VERDICT)
  const above = judged.filter((row) => row.pickRate > PICK_RATE_MAX)
  const below = judged.filter((row) => row.pickRate < PICK_RATE_MIN)

  const describe = (rows: readonly ItemRow[]): string =>
    rows.map((row) => `${row.defId} ${pct(row.pickRate)} (${row.picked}/${row.offered})`).join(', ')

  // The same verdict on free screens alone, so a pricing problem cannot be mistaken
  // for an item problem. Both are printed because M3's criterion does not say which
  // it meant, and a harness should not quietly pick the flattering reading.
  const freeJudged = report.rows.filter((row) => row.offeredFree >= MIN_OFFERS_FOR_VERDICT)
  const freeAbove = freeJudged.filter((row) => row.pickRateFree > PICK_RATE_MAX)
  const freeBelow = freeJudged.filter((row) => row.pickRateFree < PICK_RATE_MIN)

  console.log(
    above.length === 0
      ? `  PASS  no item judged is above ${pct(PICK_RATE_MAX)}`
      : `  FAIL  above ${pct(PICK_RATE_MAX)}: ${describe(above)}`,
  )
  console.log(
    below.length === 0
      ? `  PASS  no item judged is below ${pct(PICK_RATE_MIN)}`
      : `  FAIL  below ${pct(PICK_RATE_MIN)}: ${describe(below)}`,
  )
  const freeVerdict =
    freeAbove.length === 0 && freeBelow.length === 0
      ? `  PASS  and on free screens alone (${pct(PICK_RATE_MIN)}-${pct(PICK_RATE_MAX)}), where price cannot interfere`
      : `  FAIL  on free screens alone: above ${[...freeAbove.map((r) => `${r.defId} ${pct(r.pickRateFree)}`)].join(', ') || 'none'}; ` +
        `below ${[...freeBelow.map((r) => `${r.defId} ${pct(r.pickRateFree)}`)].join(', ') || 'none'}`
  console.log(freeVerdict)

  if (report.neverOffered.length > 0) {
    console.log(
      `  FAIL  ${report.neverOffered.length} item(s) never offered, so they have no pick rate: ${report.neverOffered.join(', ')}`,
    )
  }
  if (tooFew.length > 0) {
    console.log(`  UNJUDGED  under ${MIN_OFFERS_FOR_VERDICT} offers: ${describe(tooFew)}`)
  }
  if (builds.neverActive.length > 0) {
    console.log(
      `  interactions that never went live in any run: ${builds.neverActive.join(', ')} ` +
        `(of ${ALL_INTERACTION_IDS.length} declared)`,
    )
  } else {
    console.log(`  all ${ALL_INTERACTION_IDS.length} declared interactions went live at least once`)
  }
  console.log(
    '  NOTE: a pick rate is a property of the *bots\' heuristics* as much as of the items.' +
      ' These policies prefer a stated synergy, then a new item, then price; `random` is uniform.' +
      ' Read the per-policy table before tuning a weight.',
  )
}

export interface HullRow {
  hullId: string
  hullName: string
  runs: number
  clears: number
  clearRate: number
  meanStagesCleared: number
  medianSeconds: number
  medianEntryCeilingDpsSector1: number
  deepestStage: number
}

/**
 * M5's exit criteria, stated as met or not met against the numbers above.
 *
 * The verdicts are printed rather than left for a reader to derive, for the same
 * reason M3's are: a criterion nobody evaluates is a criterion nobody meets.
 *
 * WHICH POLICY COUNTS AS "COMPETENT" IS A JUDGEMENT AND IT IS STATED, not hidden.
 * `aggressor` is the one the roadmap's clear-rate band is read off — it is the only
 * policy that has ever cleared a sector in any sweep since M1 — and its route style
 * is held at `direct` so the number is not also measuring optional risk-taking.
 */
const COMPETENT_POLICY: BotName = 'aggressor'

function printM5ExitCriteria(
  summaries: readonly PolicySummary[],
  pooled: SectorReport,
  hulls: readonly HullRow[],
): void {
  console.log('')
  console.log('M5 EXIT CRITERIA')

  // --- 1. clear rate --------------------------------------------------------
  const competent = summaries.find((s) => s.policy === COMPETENT_POLICY)
  /**
   * THE DEATH DISTRIBUTION IS READ OFF THE COMPETENT POLICY, NOT THE POOL, and
   * that is a correction rather than a preference.
   *
   * Pooling every probe puts `random`, `dodger` and `greedy` into the denominator,
   * and all three are designed to die in sector one — `random` cleared it 0 times
   * in 300 runs. Pooled, sector one owns two thirds of all deaths and the criterion
   * reads NOT MET for a reason that is a property of the instruments rather than of
   * the game. The criterion is about the difficulty curve a player experiences, so
   * it has to be read off the probe that experiences a curve at all.
   *
   * The pooled table is still printed above, because "the control never leaves
   * sector one" is exactly the signal `random` exists to give.
   */
  const lead = competent ?? (summaries.length === 1 ? summaries[0] : undefined)
  const cliffSource = lead?.sectors ?? pooled
  const cliffLabel = lead === undefined ? 'all policies pooled' : lead.policy
  if (competent === undefined) {
    console.log(
      `  UNJUDGED  clear rate: ${COMPETENT_POLICY} was not in this sweep (--policy excluded it)`,
    )
  } else {
    const rate = competent.fullClearRate
    const met = rate >= CLEAR_RATE_BAND.min && rate <= CLEAR_RATE_BAND.max
    console.log(
      `  ${met ? 'MET    ' : 'NOT MET'}  20-40% clear rate for a competent policy: ` +
        `${COMPETENT_POLICY} ${pct(rate)} over ${competent.runs} runs ` +
        `(${Math.round(rate * competent.runs)} full five-sector clears), ` +
        `mean ${competent.meanStagesCleared.toFixed(2)}/5 stages`,
    )
    if (!met) {
      console.log(
        `           ${rate < CLEAR_RATE_BAND.min ? 'BELOW the band — the run is too hard' : 'ABOVE the band — the run is too easy'}`,
      )
    }
  }

  // --- 2. hull spread -------------------------------------------------------
  if (hulls.length === 0) {
    console.log('  UNJUDGED  hull spread: no hull sweep was run (pass --hulls)')
  } else {
    const meanRate = mean(hulls.map((h) => h.clearRate))
    const worst = hulls.reduce((acc, h) =>
      Math.abs(h.clearRate - meanRate) > Math.abs(acc.clearRate - meanRate) ? h : acc,
    )
    const spreadPp = Math.abs(worst.clearRate - meanRate) * 100
    const met = spreadPp <= HULL_SPREAD_MAX_PP
    console.log(
      `  ${met ? 'MET    ' : 'NOT MET'}  every hull within ${HULL_SPREAD_MAX_PP}pp of the mean: ` +
        `mean ${pct(meanRate)}, furthest is ${worst.hullName} at ${pct(worst.clearRate)} ` +
        `(${spreadPp.toFixed(1)}pp)`,
    )
    for (const hull of hulls) {
      const delta = (hull.clearRate - meanRate) * 100
      console.log(
        `           ${pad(hull.hullName, 12)}${padStart(pct(hull.clearRate), 8)}` +
          `${padStart(`${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp`, 10)}` +
          `${Math.abs(delta) > HULL_SPREAD_MAX_PP ? '  OUT OF BAND' : ''}`,
      )
    }
  }

  // --- 3. no difficulty cliff ----------------------------------------------
  if (cliffSource.totalDeaths === 0) {
    console.log('  UNJUDGED  death distribution: nothing died in this sweep')
  } else {
    const spikes = cliffSource.rows.filter((row) => row.deathShare > DEATH_SPIKE_MAX)
    const worst = cliffSource.rows.reduce((acc, row) =>
      row.deathShare > acc.deathShare ? row : acc,
    )
    const met = spikes.length === 0
    console.log(
      `  ${met ? 'MET    ' : 'NOT MET'}  no sector above a ${pct(DEATH_SPIKE_MAX)} share of deaths ` +
        `(read off ${cliffLabel}): worst is sector ${worst.index + 1} ${worst.sectorName} at ` +
        `${pct(worst.deathShare)} (${worst.died} of ${cliffSource.totalDeaths} deaths)`,
    )
    for (const row of cliffSource.rows) {
      console.log(
        `           sector ${row.index + 1} ${pad(row.sectorName, 18)}${padStart(pct(row.deathShare), 8)} of deaths` +
          `${padStart(pct(row.clearRate), 9)} cleared on arrival` +
          `${row.deathShare > DEATH_SPIKE_MAX ? '   SPIKE' : ''}`,
      )
    }
    // Only worth saying when the pool is actually wider than the competent policy.
    if (lead !== undefined && summaries.length > 1 && pooled.totalDeaths > 0) {
      const pooledWorst = pooled.rows.reduce((acc, row) =>
        row.deathShare > acc.deathShare ? row : acc,
      )
      console.log(
        `           (pooled over every probe the worst is sector ${pooledWorst.index + 1} at ` +
          `${pct(pooledWorst.deathShare)}, which is dominated by the control policies dying in sector one` +
          ' by design — see the note in the source)',
      )
    }
  }
}

function printHulls(hulls: readonly HullRow[]): void {
  if (hulls.length === 0) return
  console.log('')
  console.log('HULLS — same policy, same seeds, one hull each')
  const header =
    `  ${pad('hull', 14)}${padStart('runs', 6)}${padStart('clears', 8)}${padStart('clear%', 8)}` +
    `${padStart('stages', 8)}${padStart('deepest', 9)}${padStart('med s', 8)}${padStart('dps s1', 8)}`
  console.log(header)
  console.log(`  ${'-'.repeat(header.length - 2)}`)
  for (const hull of hulls) {
    console.log(
      `  ${pad(hull.hullName, 14)}${padStart(String(hull.runs), 6)}${padStart(String(hull.clears), 8)}` +
        `${padStart(pct(hull.clearRate), 8)}${padStart(hull.meanStagesCleared.toFixed(2), 8)}` +
        `${padStart(String(hull.deepestStage + 1), 9)}${padStart(hull.medianSeconds.toFixed(0), 8)}` +
        `${padStart(hull.medianEntryCeilingDpsSector1.toFixed(0), 8)}`,
    )
  }
  console.log('')
  console.log(
    '  Same base seed for every hull, so the wave scripts and offer rolls are identical and the',
  )
  console.log(
    '  difference is the hull. stages is the mean number cleared; deepest is the furthest sector any',
  )
  console.log('  run reached. dps s1 is the full-uptime output the hull launches with.')
}

function printBuilds(report: BuildReport, runs: number): void {
  console.log('')
  console.log('BUILDS AT RUN END')
  console.log(
    `  ${report.runsWithItems}/${runs} runs ended holding at least one item; ` +
      `mean ${report.meanItemsHeld.toFixed(2)} distinct items held`,
  )
  if (report.heldAtEnd.length > 0) {
    console.log(`  ${pad('item', 20)}${padStart('runs', 7)}${padStart('share', 8)}${padStart('stacked', 9)}`)
    for (const row of report.heldAtEnd) {
      console.log(
        `  ${pad(row.defId, 20)}${padStart(String(row.runs), 7)}${padStart(pct(row.share), 8)}${padStart(String(row.stackedRuns), 9)}`,
      )
    }
  }

  console.log('')
  console.log('INTERACTIONS LIVE AT RUN END, and the survival delta when they were')
  if (report.liveAtEnd.length === 0) {
    console.log('  none — no run ever assembled a declared pair')
  }
  for (const split of report.splits) {
    console.log(
      `  ${pad(split.id, 20)} live in ${padStart(String(split.withRuns), 4)} runs (${pct(split.withRuns / Math.max(1, runs))})`,
    )
    console.log(
      `    clear ${pct(split.withClearRate)} with vs ${pct(split.withoutClearRate)} without ` +
        `(${split.clearDelta >= 0 ? '+' : ''}${(split.clearDelta * 100).toFixed(1)}pp)   ` +
        `median ${split.withMedianSeconds.toFixed(1)}s vs ${split.withoutMedianSeconds.toFixed(1)}s ` +
        `(${split.secondsDelta >= 0 ? '+' : ''}${split.secondsDelta.toFixed(1)}s)`,
    )
  }
  if (report.splits.length > 0) {
    console.log(
      '  CORRELATION, NOT CAUSATION: an interaction can only be live in a run that survived long' +
        ' enough to be offered both halves, so the sign is trustworthy and the magnitude is an' +
        ' upper bound. Isolating it needs a forced-build sweep, not this partition.',
    )
  }
}

function printEconomy(summaries: readonly PolicySummary[]): void {
  console.log('')
  console.log('ECONOMY — scrap earned vs spent, and whether the shop is reachable')
  const header =
    `  ${pad('policy', 14)}${padStart('earned', 9)}${padStart('spent', 9)}${padStart('spend%', 8)}` +
    `${padStart('shops', 7)}${padStart('bought', 8)}${padStart('unaff', 7)}${padStart('dead', 6)}${padStart('med scrap', 11)}${padStart('cheapest', 10)}`
  console.log(header)
  console.log(`  ${'-'.repeat(header.length - 2)}`)
  for (const summary of summaries) {
    const e = summary.economy
    console.log(
      `  ${pad(summary.policy, 14)}${padStart(String(Math.round(e.scrapEarned)), 9)}` +
        `${padStart(String(Math.round(e.scrapSpent)), 9)}${padStart(pct(e.spendRate), 8)}` +
        `${padStart(String(e.shopChoices), 7)}${padStart(String(e.shopPurchases), 8)}` +
        `${padStart(e.shopOptions === 0 ? '-' : pct(e.shopOptionsUnaffordable / e.shopOptions), 7)}` +
        `${padStart(String(e.shopsWithNothingAffordable), 6)}` +
        `${padStart(String(Math.round(e.medianScrapAtShop)), 11)}${padStart(String(Math.round(e.medianCheapestShopCost)), 10)}`,
    )
  }
  console.log('')
  console.log(
    '  earned = scrap left at run end plus scrap paid out. unaff = share of shop options priced above',
  )
  console.log(
    '  the balance when the screen opened. dead = screens where NOT ONE option was affordable.',
  )

  // Pooled by shop ordinal, because that is where a dead screen actually shows up.
  const pooled = new Map<number, { screens: number; purchases: number; dead: number; scrap: number[]; cheap: number[] }>()
  for (const summary of summaries) {
    for (const row of summary.economy.byShop) {
      let bucket = pooled.get(row.ordinal)
      if (bucket === undefined) {
        bucket = { screens: 0, purchases: 0, dead: 0, scrap: [], cheap: [] }
        pooled.set(row.ordinal, bucket)
      }
      bucket.screens += row.screens
      bucket.purchases += row.purchases
      bucket.dead += row.nothingAffordable
      bucket.scrap.push(row.medianScrap)
      bucket.cheap.push(row.medianCheapest)
    }
  }
  if (pooled.size > 0) {
    console.log('')
    console.log('  by shop of the run (all policies pooled)')
    console.log(
      `  ${pad('shop', 8)}${padStart('screens', 9)}${padStart('bought', 8)}${padStart('dead', 7)}${padStart('dead%', 8)}${padStart('med scrap', 11)}${padStart('cheapest', 10)}`,
    )
    for (const [ordinal, bucket] of [...pooled.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(
        `  ${pad(`#${ordinal}`, 8)}${padStart(String(bucket.screens), 9)}${padStart(String(bucket.purchases), 8)}` +
          `${padStart(String(bucket.dead), 7)}${padStart(pct(bucket.dead / Math.max(1, bucket.screens)), 8)}` +
          `${padStart(String(Math.round(mean(bucket.scrap))), 11)}${padStart(String(Math.round(mean(bucket.cheap))), 10)}`,
      )
    }
  }
}

interface Coverage {
  skippedPolicies: readonly BotName[]
  observations: RunObservations
  maxSeconds: number
  totalTruncated: number
  unattributedDeaths: number
  extractions: number
  enemyDefsSeen: readonly string[]
  /** False when --no-items ran the sweep against an empty pool. */
  itemsEnabled: boolean
  items: ItemReport
  builds: BuildReport
  /** Hull flown, and whether the whole roster was covered. */
  hullId: string
  hullsSwept: boolean
}

function printCoverage(coverage: Coverage, summaries: readonly PolicySummary[]): void {
  console.log('')
  console.log('COVERAGE — what this sweep did NOT measure')
  const notes: string[] = []

  if (coverage.skippedPolicies.length > 0) {
    notes.push(`policies not run: ${coverage.skippedPolicies.join(', ')} (--policy was set)`)
  }
  if (coverage.totalTruncated > 0) {
    const total = summaries.reduce((sum, s) => sum + s.runs, 0)
    notes.push(
      `${coverage.totalTruncated}/${total} runs hit the ${coverage.maxSeconds}s cap and were cut short — ` +
        `their survival times are lower bounds, so median/p90 understate real survival`,
    )
  }
  if (coverage.extractions === 0) {
    notes.push(
      "no run ended in 'extracted' — the win path is unexercised, so nothing here says the sector is completable",
    )
  }
  if (coverage.unattributedDeaths > 0) {
    notes.push(
      `${coverage.unattributedDeaths} deaths had no incident report attached — those rows are blind on cause`,
    )
  }
  if (!coverage.observations.sawFocus) {
    notes.push('no bot ever held focus — precision movement is untested by this sweep')
  }
  if (!coverage.observations.sawSpecial) {
    notes.push('no bot ever pressed special — that input path is untested by this sweep')
  }
  notes.push(
    `enemy defs actually encountered: ${coverage.enemyDefsSeen.length === 0 ? 'none' : coverage.enemyDefsSeen.join(', ')} ` +
      '(sampled every 15 ticks; this tool does not read the ENEMY table, so a def that never spawns is absent here rather than reported as missing — unlike items, which are cross-checked against src/content/items.ts)',
  )

  if (!coverage.itemsEnabled) {
    notes.push(
      'ITEMS WERE SWITCHED OFF for this sweep (--no-items), so every pick rate, build, and shop' +
        ' number above is absent rather than zero. M3 cannot be judged from this run.',
    )
  } else {
    if (coverage.items.totalChoices === 0) {
      notes.push(
        'no item or shop screen ever opened, so nothing about items was measured — check whether the' +
          ' reward waves are being reached at all',
      )
    }
    if (coverage.items.choicesUnresolvedAtRunEnd > 0) {
      notes.push(
        `${coverage.items.choicesUnresolvedAtRunEnd} screens were still open when their run ended — those offers` +
          ' are counted with no pick, which drags the affected items\' pick rates down',
      )
    }
    if (coverage.items.maxChoiceScriptTicks > MAX_CHOICE_RESOLUTION_TICKS) {
      notes.push(
        `A POLICY IS MIS-NAVIGATING THE CURSOR: a screen took ${coverage.items.maxChoiceScriptTicks} unfrozen ticks ` +
          `against a ${MAX_CHOICE_RESOLUTION_TICKS}-tick budget, so some picks are not the picks the policy chose ` +
          'and every pick rate above is suspect. This sweep exited non-zero over it — see CHOICE RESOLUTION',
      )
    }
    notes.push(
      'a pick rate here is a joint property of the items AND the bots\' heuristics. No bot can see an' +
        " item's TIER or TAGS — ItemOffer exposes only defId and interactionText — so \"prefer a rare\"" +
        ' exists only in shops (via tier-scaled costs) and "prefer a defensive item" does not exist at all.',
    )
    notes.push(
      'item MECHANICAL STRENGTH is not measured. Nothing here says whether Machined Slugs is worth its' +
        ' pick — only how often a bot took it. Per-item damage contribution needs an ablation sweep' +
        ' (zero one item, re-measure), which this tool does not do.',
    )
    notes.push(
      'the interaction survival deltas are CORRELATIONS. Runs that assembled a pair are runs that lived' +
        ' long enough to be offered both halves, so the deltas overstate the synergies.',
    )
    notes.push(
      'stacking is barely exercised: a policy prefers a new item over a re-take, so the sim\'s stack path' +
        ' (including the double Feed Relay flagged as a sharp edge in items.ts) is close to untested here',
    )
    notes.push(
      'work-order choices are resolved but not measured: WorldView exposes them as bare strings with no' +
        ' cost or effect, and the sim applies nothing when one is confirmed, so there is nothing to score',
    )
  }
  notes.push(
    'RECORDED FIXTURES DO NOT COVER ITEMS. --record-fixture deliberately runs on the World default' +
      " (empty pool), because tests/replay.test.ts rebuilds fixtures with `new World(seed)` and a" +
      ' content-bearing fixture could not reproduce there. The item path has no replay regression.',
  )
  if (!coverage.hullsSwept) {
    notes.push(
      `only one hull was flown (${coverage.hullId}) — M5's per-hull criterion needs --hulls, and nothing` +
        ' here says anything about the other four',
    )
  }
  notes.push(
    'EVERY PER-SECTOR NUMBER PAST SECTOR ONE IS CONDITIONED ON SURVIVING TO IT. The population entering' +
      ' sector four is the population that already cleared three, so a later sector looking easier is' +
      ' partly the sector and partly the pilots. `survive s` is the column written to separate those two' +
      ' — it divides entry health by measured incoming damage — but it is an index, not a controlled' +
      ' experiment. Isolating a sector properly needs a run that STARTS there with a fixed build, which' +
      ' the sim cannot currently be asked for.',
  )
  notes.push(
    'DAMAGE DEALT IS OBSERVED, NOT REPORTED. Nothing on WorldView says how much damage the pilot did,' +
      ' so it is summed from per-tick hp decrements across live enemies. That undercounts by whatever hp' +
      ' an enemy had left on the tick it died (reaping removes it inside the same tick), which is up to' +
      " one tick of output per kill — order 1-2% of the total. The `dps` column's *nominal* figure is" +
      ' unaffected; the `realised` and `hp/ttk` columns are the ones this touches, and only downward.',
  )
  notes.push(
    'A ROUTE REWARD IS INFERRED FROM THE HAZARD ARMED, not reported. When a sector has only one hazard,' +
      ' both priced routes carry it and the two are indistinguishable afterwards, so `routeReward` is' +
      ' unreliable in that case. "Arrived with a hazard armed" is exact; "took the scrap one" is not.',
  )
  notes.push(
    'BOSS VARIANTS ARE NOT SPLIT OUT. Three bosses roll a seeded variant that replaces a middle phase,' +
      ' and every time-to-kill above pools them. A variant that is twice as long as its sibling would be' +
      ' invisible here as anything but a wide p10-p90 spread.',
  )
  notes.push(
    'ELITES, VAULTS AND CURSES are not measured as such: this tool sees enemy def ids and item offers,' +
      ' and has no column for whether a spawn was elite beyond what the enemy table names.',
  )
  notes.push('nothing here measures whether the game is fun; that needs screenshots and a human')

  for (const note of notes) console.log(`  - ${note}`)
}

// ---------------------------------------------------------------------------
// the World contract precheck
// ---------------------------------------------------------------------------

const REQUIRED_VIEW_FIELDS = [
  'seed',
  'runState',
  'hull',
  'playerBullets',
  'enemyBullets',
  'enemies',
  'explosions',
  'stats',
  'incident',
  // M3. The item measurements below read all four, and a World missing one would
  // otherwise fail deep inside the aggregation with an unreadable stack.
  'inventory',
  'activeInteractions',
  'pendingChoice',
  'freezeTicks',
] as const

const REQUIRED_STATS_FIELDS = [
  'tick',
  'shotsFired',
  'hits',
  'kills',
  'scrap',
  'damageTaken',
  'waveIndex',
  'peakProjectiles',
  'bulletsCulled',
] as const

/**
 * Fail with a sentence instead of a stack trace when the sim does not yet
 * satisfy `WorldView`.
 *
 * This harness is written against the fixed contract in `src/sim/entities.ts`
 * while the sim itself is under concurrent construction. When they disagree,
 * "World is missing runState, incident" is a useful thirty-second fix and
 * "TypeError: Cannot read properties of undefined" is an afternoon.
 */
function checkWorldContract(): string[] {
  const problems: string[] = []
  let probe: Record<string, unknown>
  try {
    probe = new World('CONTRACTCHK2') as unknown as Record<string, unknown>
  } catch (error) {
    return [`new World(seed) threw: ${String(error)}`]
  }
  for (const field of REQUIRED_VIEW_FIELDS) {
    if (!(field in probe)) problems.push(`World is missing WorldView.${field}`)
  }
  const stats = probe['stats']
  if (stats === undefined || stats === null || typeof stats !== 'object') {
    problems.push('World.stats is missing')
  } else {
    for (const field of REQUIRED_STATS_FIELDS) {
      if (!(field in (stats as Record<string, unknown>))) {
        problems.push(`World.stats is missing RunStats.${field}`)
      }
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// fixture recording
// ---------------------------------------------------------------------------

const FIXTURE_FORMAT_VERSION = 1

/**
 * Record one bot run as a replay fixture for `tests/replays/`.
 *
 * The fixture is verified before it is written: the encoded inputs are decoded
 * and replayed into a fresh World, and the digest must match the live run's. A
 * fixture that does not reproduce at the moment of recording is worse than no
 * fixture — it turns the regression corpus into noise that gets re-recorded on
 * every failure until nobody trusts it.
 */
function recordFixture(name: string, policy: BotName, seed: string, maxTicks: number): void {
  const observations = emptyObservations()
  const recorder = new ReplayRecorder(seed)
  // No `content`: the fixture must be reproducible by `new World(seed)`, which is
  // how tests/replay.test.ts rebuilds it. Recording against the item pool while the
  // corpus replays without it would fail the regression suite on day one, and the
  // failure would look like a determinism bug in the sim. Stated in COVERAGE.
  const live = runOnce(policy, seed, { maxTicks, observations, recorder })
  const encoded = recorder.encode()

  const decoded = decodeReplay(encoded)
  const { world: replayed } = playback(decoded, (s) => new World(s))
  const replayDigest = digestWorld(replayed)
  if (replayDigest.hash !== live.hash) {
    console.error(
      `refusing to write ${name}: replay produced ${replayDigest.hash}, live run produced ${live.hash}.\n` +
        'The simulation is not deterministic under replay — fix that before recording a fixture.',
    )
    process.exit(3)
  }

  const liveDigest = { ...replayDigest }
  const fixture = {
    fixtureVersion: FIXTURE_FORMAT_VERSION,
    name,
    policy,
    seed,
    ticks: live.ticks,
    note:
      'Recorded by tools/playtest.ts --record-fixture. Replaying these inputs must reproduce ' +
      'expected.hash exactly. If a deliberate balance change breaks this, re-record and let the ' +
      'diff show what moved.',
    replay: encoded,
    expected: {
      runState: live.runState,
      hash: liveDigest.hash,
      components: {
        hull: liveDigest.hull,
        playerBullets: liveDigest.playerBullets,
        enemyBullets: liveDigest.enemyBullets,
        enemies: liveDigest.enemies,
        stats: liveDigest.stats,
        run: liveDigest.run,
      },
      cosmetic: liveDigest.cosmetic,
      counts: liveDigest.counts,
      stats: {
        tick: live.ticks,
        waveIndex: live.waveIndex,
        kills: live.kills,
        scrap: live.scrap,
        shotsFired: live.shotsFired,
        hits: live.hits,
        damageTaken: live.damageTaken,
      },
      incident: { causeKind: live.causeKind, causeEnemyId: live.causeEnemyId },
    },
  }

  const path = resolve(process.cwd(), 'tests/replays', `${name}.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${path}`)
  console.log(
    `  ${policy} on ${seed}: ${live.ticks} ticks (${live.seconds.toFixed(1)}s), ${live.runState}, ` +
      `wave ${live.waveIndex}, ${live.kills} kills`,
  )
  console.log(`  replay is ${encoded.length} chars for ${live.ticks} ticks`)
  console.log(`  hash ${liveDigest.hash} — verified by replaying into a fresh World`)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface Args {
  runs: number
  policies: BotName[]
  seed: string
  json: boolean
  detail: boolean
  maxSeconds: number
  recordFixture: string | null
  /** Sweep with an empty item pool, for comparison against the M1/M2 numbers. */
  noItems: boolean
  /** Fly sector one alone, for numbers comparable with the M1-M4 sweeps. */
  singleSector: boolean
  /** One hull for the whole sweep. Null means the baseline Lien. */
  hull: string | null
  /** Repeat the sweep once per hull and report the spread. M5 criterion two. */
  hulls: boolean
  /** Override every policy's world-map appetite. The ablation switch. */
  routeStyle: RouteStyle | null
  /** Item ids handed to the flown hull at launch. The item ablation switch. */
  give: string[]
  help: boolean
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = {
    runs: DEFAULT_RUNS,
    policies: [...BOT_NAMES],
    seed: DEFAULT_SEED,
    json: false,
    detail: false,
    maxSeconds: DEFAULT_MAX_SECONDS,
    recordFixture: null,
    noItems: false,
    singleSector: false,
    hull: null,
    hulls: false,
    routeStyle: null,
    give: [],
    help: false,
  }
  for (const raw of argv) {
    const [flag, value = ''] = raw.includes('=') ? splitOnce(raw, '=') : [raw, '']
    switch (flag) {
      case '--help':
      case '-h':
        args.help = true
        break
      case '--json':
        args.json = true
        break
      case '--detail':
        args.detail = true
        break
      case '--no-items':
        args.noItems = true
        break
      case '--single-sector':
        args.singleSector = true
        break
      case '--hulls':
        args.hulls = true
        break
      case '--hull':
        if (value === '') fail(`--hull needs a name. Known: ${HULL_ORDER.join(', ')}`)
        if (HULLS[value] === undefined) fail(`unknown hull "${value}". Known: ${HULL_ORDER.join(', ')}`)
        args.hull = value
        break
      case '--give': {
        const ids = value.split(',').filter((id) => id !== '')
        if (ids.length === 0) fail('--give needs at least one item id, e.g. --give=repair-nanites')
        for (const id of ids) {
          if (!Object.hasOwn(ITEMS, id)) fail(`--give: "${id}" is not in src/content/items.ts`)
        }
        args.give = ids
        break
      }
      case '--route-style':
        if (!isRouteStyle(value)) fail(`--route-style must be one of ${ROUTE_STYLES.join(', ')}`)
        args.routeStyle = value
        break
      case '--runs': {
        const n = Number.parseInt(value, 10)
        if (!Number.isFinite(n) || n < 1) fail(`--runs needs a positive integer, got ${value}`)
        args.runs = n
        break
      }
      case '--max-seconds': {
        const n = Number.parseInt(value, 10)
        if (!Number.isFinite(n) || n < 1) fail(`--max-seconds needs a positive integer, got ${value}`)
        args.maxSeconds = n
        break
      }
      case '--seed':
        if (value === '') fail('--seed needs a value')
        args.seed = value
        break
      case '--policy': {
        const names = value.split(',').filter((n) => n !== '')
        if (names.length === 0) fail('--policy needs at least one name')
        for (const name of names) {
          if (!isBotName(name)) fail(`unknown policy "${name}". Known: ${BOT_NAMES.join(', ')}`)
        }
        args.policies = names.filter(isBotName)
        break
      }
      case '--record-fixture':
        if (value === '') fail('--record-fixture needs a name, e.g. --record-fixture=sector1-aggressor')
        args.recordFixture = value
        break
      default:
        fail(`unknown flag ${flag}. Try --help.`)
    }
  }
  return args
}

function splitOnce(text: string, separator: string): [string, string] {
  const index = text.indexOf(separator)
  return [text.slice(0, index), text.slice(index + separator.length)]
}

function fail(message: string): never {
  console.error(`playtest: ${message}`)
  process.exit(1)
}

function printHelp(): void {
  console.log(`Bot playtest sweeps. Headless, deterministic, no renderer.

  --runs=N              full runs per policy (default ${DEFAULT_RUNS})
  --policy=NAME[,NAME]  restrict to these policies (default: all)
  --seed=SEED           base seed; per-run seeds are derived from it (default ${DEFAULT_SEED})
  --max-seconds=N       per-run tick cap in sim seconds (default ${DEFAULT_MAX_SECONDS})
  --json                machine-readable output instead of the table
  --detail              with --json, include every individual run
  --no-items            sweep with an empty item pool (M1/M2-comparable numbers)
  --single-sector       fly sector one alone (M1-M4-comparable numbers)
  --hull=ID             fly one hull for the whole sweep (default: lien)
  --hulls               repeat the sweep once per hull; M5's per-hull criterion
  --route-style=STYLE   override every policy's world-map appetite, for ablation
                        (${ROUTE_STYLES.join(', ')})
  --give=ID[,ID]        hand the flown hull these items at launch; the item ablation
                        (e.g. --give=repair-nanites against a plain sweep)
  --record-fixture=NAME record one run to tests/replays/NAME.json and verify it
                        (always runs with the World default pool — see COVERAGE)

Policies:
${BOT_NAMES.map((name) => `  ${pad(name, 14)}${pad(name === 'build-focused' ? 'item-only' : BOTS[name].routeStyle, 11)}${BOTS[name].measures}`).join('\n')}

The second column is the policy's default world-map appetite. --route-style overrides it.

Exit codes: 0 healthy, 1 bad flags, 2 World does not implement WorldView, 3 a fixture
failed to reproduce, 4 CHOICE RESOLUTION failed — a policy stalled on a card or overran
its ${MAX_CHOICE_RESOLUTION_TICKS}-tick navigation budget, so the sweep's numbers are not measurements. The sim has
no choice timeout, so ${CHOICE_STALL_ABORT_TICKS} unfrozen ticks on one card abandons the run.
`)
}

function main(argv: readonly string[]): void {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return
  }

  const contractProblems = checkWorldContract()
  if (contractProblems.length > 0) {
    console.error('playtest: the simulation does not implement WorldView yet.\n')
    for (const problem of contractProblems) console.error(`  - ${problem}`)
    console.error(
      '\nsrc/sim/entities.ts is the fixed contract; this harness is written against it.\n' +
        'Nothing can be swept until World satisfies it.',
    )
    process.exit(2)
  }

  const maxTicks = Math.round(args.maxSeconds * TICK_HZ)

  if (args.recordFixture !== null) {
    const policy = args.policies[0] ?? 'aggressor'
    recordFixture(args.recordFixture, policy, args.seed, maxTicks)
    return
  }

  // A typo in a bot's named build would otherwise look like a balance finding:
  // "build-focused never acquired its targets" reads identically whether the item
  // is unpickable or the id does not exist. Say which.
  const missingTargets = BUILD_FOCUSED_TARGET.filter((id) => !Object.hasOwn(ITEMS, id))
  if (missingTargets.length > 0) {
    console.error(
      `playtest: build-focused targets ${missingTargets.join(', ')} are not in src/content/items.ts — ` +
        'that probe will measure nothing until BUILD_FOCUSED_TARGET in src/sim/bots.ts is updated.',
    )
  }

  const observations = emptyObservations()
  const baseContent = withStartingItems(
    args.singleSector ? SECTOR_ONE_CONTENT : contentForHull(args.hull),
    args.give,
  )
  const content = args.noItems
    ? args.singleSector
      ? undefined
      : { ...baseContent, items: {}, interactions: [] }
    : baseContent
  const startedNs = process.hrtime.bigint()
  const summaries: PolicySummary[] = []
  const allRuns: RunResult[] = []
  let totalTicks = 0

  const routeOverride = args.routeStyle ?? undefined
  for (const policy of args.policies) {
    const runs: RunResult[] = []
    for (let i = 0; i < args.runs; i++) {
      const result = runOnce(policy, deriveSeed(args.seed, i), {
        maxTicks,
        observations,
        content,
        hullId: args.hull,
        routeStyle: routeOverride,
      })
      runs.push(result)
      totalTicks += result.ticks
    }
    summaries.push(summarise(policy, runs))
    allRuns.push(...runs)
  }

  // --- the hull sweep -------------------------------------------------------
  // Deliberately the SAME seeds for every hull. Comparing hulls across different
  // seeds would put the wave scripts and the offer rolls inside the difference,
  // and a 15pp criterion cannot survive that much noise at any sample size a
  // sweep can afford.
  const hullRows: HullRow[] = []
  if (args.hulls) {
    const hullPolicy = args.policies.includes(COMPETENT_POLICY)
      ? COMPETENT_POLICY
      : (args.policies[0] ?? COMPETENT_POLICY)
    for (const hullId of HULL_ORDER) {
      const hull = HULLS[hullId]
      const withHull: RunContent =
        hull === undefined
          ? (args.singleSector ? SECTOR_ONE_CONTENT : RUN_CONTENT)
          : { ...(args.singleSector ? SECTOR_ONE_CONTENT : RUN_CONTENT), hull }
      const given = withStartingItems(withHull, args.give)
      const hullContent = args.noItems ? { ...given, items: {}, interactions: [] } : given
      const runs: RunResult[] = []
      for (let i = 0; i < args.runs; i++) {
        const result = runOnce(hullPolicy, deriveSeed(args.seed, i), {
          maxTicks,
          observations,
          content: hullContent,
          hullId,
          routeStyle: routeOverride,
        })
        runs.push(result)
        totalTicks += result.ticks
      }
      const clears = runs.filter((r) => r.runState === 'extracted')
      hullRows.push({
        hullId,
        hullName: HULLS[hullId]?.name ?? hullId,
        runs: runs.length,
        clears: clears.length,
        clearRate: runs.length === 0 ? 0 : clears.length / runs.length,
        meanStagesCleared: mean(runs.map((r) => r.stagesCleared)),
        medianSeconds: percentile(sortedNumbers(runs.map((r) => r.seconds)), 0.5),
        medianEntryCeilingDpsSector1: percentile(
          sortedNumbers(runs.map((r) => r.stages[0]?.entryCeilingDps ?? 0)),
          0.5,
        ),
        deepestStage: runs.reduce((max, r) => Math.max(max, r.finalStageIndex), 0),
      })
    }
  }

  // The exit criterion is about the game, not about one probe, so the verdict is
  // read off the pooled offers. The per-policy table is printed beside it so a
  // single heuristic driving a number is visible rather than averaged away.
  const aggregateItems = summariseItems(allRuns)
  const aggregateBuilds = summariseBuilds(allRuns)

  const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6
  const runCount = allRuns.length
  const coverage: Coverage = {
    skippedPolicies: BOT_NAMES.filter((name) => !args.policies.includes(name)),
    observations,
    maxSeconds: args.maxSeconds,
    totalTruncated: allRuns.filter((r) => r.truncated).length,
    unattributedDeaths: allRuns.filter((r) => r.causeKind === 'unattributed').length,
    extractions: allRuns.filter((r) => r.runState === 'extracted').length,
    enemyDefsSeen: [...observations.enemyDefsSeen].sort(),
    itemsEnabled: !args.noItems,
    items: aggregateItems,
    builds: aggregateBuilds,
    hullId: args.hull ?? 'lien',
    hullsSwept: hullRows.length > 0,
  }

  const aggregateSectors = summariseSectors(allRuns)
  const choiceHealth = summariseChoiceHealth(allRuns)

  const timing = {
    elapsedMs: Math.round(elapsedMs),
    runs: runCount,
    ticks: totalTicks,
    runsPerSecond: Math.round(runCount / (elapsedMs / 1000)),
    ticksPerSecond: Math.round(totalTicks / (elapsedMs / 1000)),
    /** Sim seconds simulated per wall-clock second. The reason sweeps are cheap. */
    realtimeFactor: Math.round(totalTicks / TICK_HZ / (elapsedMs / 1000)),
  }

  const judged = aggregateItems.rows.filter((row) => row.offered >= MIN_OFFERS_FOR_VERDICT)

  if (args.json) {
    const payload: Record<string, unknown> = {
      config: {
        baseSeed: args.seed,
        runsPerPolicy: args.runs,
        policies: args.policies,
        maxSeconds: args.maxSeconds,
        itemsEnabled: !args.noItems,
        itemPoolSize: args.noItems ? 0 : ALL_ITEM_IDS.length,
        buildFocusedTarget: BUILD_FOCUSED_TARGET,
        run: args.singleSector ? 'sector-one' : STANDARD_RUN.id,
        hull: args.hull ?? 'lien',
        hullsSwept: hullRows.map((row) => row.hullId),
        routeStyleOverride: args.routeStyle,
        startingItemsGiven: args.give,
      },
      timing,
      policies: summaries,
      /** Pooled across every policy. This is what the M3 verdict is read from. */
      items: aggregateItems,
      builds: aggregateBuilds,
      sectors: aggregateSectors,
      hulls: hullRows,
      m5ExitCriteria: {
        clearRateBand: CLEAR_RATE_BAND,
        competentPolicy: COMPETENT_POLICY,
        competentClearRate: summaries.find((s) => s.policy === COMPETENT_POLICY)?.fullClearRate ?? null,
        hullSpreadMaxPp: HULL_SPREAD_MAX_PP,
        hullMeanClearRate: hullRows.length === 0 ? null : mean(hullRows.map((h) => h.clearRate)),
        deathSpikeMax: DEATH_SPIKE_MAX,
        worstDeathShare:
          aggregateSectors.rows.length === 0
            ? null
            : Math.max(...aggregateSectors.rows.map((row) => row.deathShare)),
        assumedDps: SECTOR_PLAYER_DPS,
        measuredCeilingDps: aggregateSectors.rows.map((row) => Math.round(row.medianEntryCeilingDps)),
        measuredBossDps: aggregateSectors.rows.map((row) => Math.round(row.bossDpsMedian)),
      },
      exitCriteria: {
        pickRateMax: PICK_RATE_MAX,
        pickRateMin: PICK_RATE_MIN,
        minOffersForVerdict: MIN_OFFERS_FOR_VERDICT,
        abovePickRateMax: judged.filter((row) => row.pickRate > PICK_RATE_MAX).map((row) => row.defId),
        belowPickRateMin: judged.filter((row) => row.pickRate < PICK_RATE_MIN).map((row) => row.defId),
        unjudgedTooFewOffers: aggregateItems.rows
          .filter((row) => row.offered < MIN_OFFERS_FOR_VERDICT)
          .map((row) => row.defId),
        neverOffered: aggregateItems.neverOffered,
        neverPicked: aggregateItems.neverPicked,
        interactionsNeverActive: aggregateBuilds.neverActive,
      },
      coverage: {
        skippedPolicies: coverage.skippedPolicies,
        truncatedRuns: coverage.totalTruncated,
        unattributedDeaths: coverage.unattributedDeaths,
        extractions: coverage.extractions,
        enemyDefsSeen: coverage.enemyDefsSeen,
        focusExercised: observations.sawFocus,
        specialExercised: observations.sawSpecial,
        itemsEnabled: !args.noItems,
        maxChoiceTicks: aggregateItems.maxChoiceTicks,
        choiceResolutionBudgetTicks: MAX_CHOICE_RESOLUTION_TICKS,
        /** The sim has no choice timeout; this is the harness's own hard ceiling. */
        choiceStallAbortTicks: CHOICE_STALL_ABORT_TICKS,
        choiceHealth,
        notMeasured: [
          'fun',
          'boss variants split out (all time-to-kill figures pool them)',
          'per-sector difficulty free of survivorship (later sectors are conditioned on clearing earlier ones)',
          'per-item damage contribution (needs an ablation sweep)',
          'item tier and tag preference (not on ItemOffer)',
          'stacking',
          'work-order outcomes (the sim applies none)',
          'the item path under replay (fixtures record with an empty pool)',
        ],
      },
    }
    if (args.detail) payload['runs'] = allRuns
    console.log(JSON.stringify(payload, null, 2))
    // On stderr, so the JSON on stdout stays parseable. The exit code is the part a
    // caller cannot overlook.
    exitIfChoicesUnhealthy(choiceHealth)
    return
  }

  console.log('')
  console.log(
    `PLAYTEST  base seed ${args.seed}  ${args.runs} runs x ${args.policies.length} policies  cap ${args.maxSeconds}s  ` +
      `items ${args.noItems ? 'OFF' : `on (${ALL_ITEM_IDS.length} in pool, ${ALL_INTERACTION_IDS.length} interactions)`}`,
  )
  console.log(
    `          run ${args.singleSector ? 'sector one alone' : `${STANDARD_RUN.name} (${STANDARD_RUN.stages.length} sectors)`}  ` +
      `hull ${args.hull ?? 'lien'}${hullRows.length > 0 ? ` (+ ${hullRows.length}-hull sweep)` : ''}  ` +
      `routes ${args.routeStyle ?? 'per policy'}` +
      `${args.give.length === 0 ? '' : `  GIVEN ${args.give.join(', ')} at launch`}`,
  )
  console.log('')
  printTable(summaries)
  printDeaths(summaries)
  if (!args.singleSector) {
    // The competent policy's own tables come FIRST and are what the verdicts read.
    // Pooling puts three probes that are designed to die in sector one into every
    // denominator, which makes the pooled death distribution a fact about the
    // instruments rather than about the difficulty curve.
    // Whichever single policy the verdicts will be read off gets its own tables
    // first; the pool is printed after it, and only when it is actually wider.
    const competentSummary = summaries.find((s) => s.policy === COMPETENT_POLICY)
    const lead = competentSummary ?? summaries[0]
    if (lead !== undefined) {
      printSectors(lead.sectors, `${lead.runs} ${lead.policy} runs`)
      printBosses(lead.sectors)
      printDpsLadder(lead.sectors)
    }
    if (summaries.length > 1) {
      printSectors(aggregateSectors, `${allRuns.length} runs, ALL policies pooled (diagnostic only)`)
    }
  }
  printHulls(hullRows)
  if (!args.singleSector) printRoutes(summaries)
  if (!args.singleSector) printM5ExitCriteria(summaries, aggregateSectors, hullRows)
  // Before the item tables, because it says whether they can be believed at all.
  printChoiceHealth(choiceHealth)
  if (!args.noItems) {
    printItems(aggregateItems, `${allRuns.length} runs, all policies pooled`)
    printPickRatesByPolicy(summaries, aggregateItems)
    printExitCriteria(aggregateItems, aggregateBuilds)
    printBuilds(aggregateBuilds, allRuns.length)
    printEconomy(summaries)
  }
  printCoverage(coverage, summaries)
  console.log('')
  console.log(
    `TIMING  ${runCount} runs / ${totalTicks} ticks in ${timing.elapsedMs}ms ` +
      `(${timing.runsPerSecond} runs/s, ${timing.ticksPerSecond} ticks/s, ${timing.realtimeFactor}x realtime)`,
  )
  console.log('')
  exitIfChoicesUnhealthy(choiceHealth)
}

/**
 * Turn a choice-resolution failure into a non-zero exit, or return.
 *
 * A FAIL line in a wall of output is a FAIL nobody acts on, and there is no human
 * reading these sweeps — see docs/VERIFICATION.md. The sim used to auto-resolve a card
 * nobody was resolving, so this class of bug could only ever be a wrong number in a
 * table; now it is a stalled run, and a stalled run has to be a red sweep.
 */
function exitIfChoicesUnhealthy(health: ChoiceHealth): void {
  if (!choiceHealthFailed(health)) return
  console.error(
    `playtest: CHOICE RESOLUTION FAILED — ${health.stalls.length} run(s) abandoned on an unresolved card, ` +
      `${health.overBudget} card(s) over the ${MAX_CHOICE_RESOLUTION_TICKS}-tick navigation budget. ` +
      'The pick rates and survival numbers in this sweep are not measurements. See CHOICE RESOLUTION above.',
  )
  process.exit(4)
}

/** Only run as a CLI. Importable from tests without launching a sweep. */
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
}

export { deriveSeed, main, runOnce, summarise }
