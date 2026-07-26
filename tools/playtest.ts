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
import { INTERACTIONS } from '../src/content/interactions'
import { ITEMS } from '../src/content/items'
import type {
  DeathCauseKind,
  PendingChoiceKind,
  RunState,
  WorldView,
} from '../src/sim/entities'
import type { BotName } from '../src/sim/bots'
import { BOTS, BOT_NAMES, BUILD_FOCUSED_TARGET, MAX_CHOICE_RESOLUTION_TICKS, isBotName } from '../src/sim/bots'
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
const RUN_CONTENT: RunContent = { items: ITEMS, interactions: INTERACTIONS }

const ALL_ITEM_IDS: readonly string[] = Object.keys(ITEMS).sort()
const ALL_INTERACTION_IDS: readonly string[] = INTERACTIONS.map((i) => i.id).sort()

const DEFAULT_RUNS = 200
const DEFAULT_SEED = 'K7F29XQM3RTV'
/**
 * Hard tick ceiling per run, in seconds of sim time.
 *
 * Sector 1 is nominally ~3 minutes, so 240s leaves room for a slow clear. Runs
 * that hit the cap are counted and called out: survival statistics over censored
 * data are lower bounds, and reporting a median as if it were exact when a
 * quarter of runs were cut short is exactly the kind of quiet lie this harness
 * exists to prevent.
 */
const DEFAULT_MAX_SECONDS = 240

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
   * False when the run ended with this screen still up.
   *
   * Distinct from `takenId === null`, which also covers a deliberate decline. The
   * offers still count — dropping them would inflate the affected items' pick
   * rates — but the report has to be able to say how many were never decided.
   */
  resolved: boolean
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

/** A choice screen currently open, waiting to be resolved. */
interface OpenChoice {
  kind: PendingChoiceKind
  offers: readonly OfferObservation[]
  scrapAtOpen: number
  openedAtTick: number
  frozenTicks: number
  shopOrdinal: number
  inventoryBefore: ReadonlyMap<string, number>
}

function runOnce(policyName: BotName, seed: string, options: RunOptions): RunResult {
  const world = options.content === undefined ? new World(seed) : new World(seed, options.content)
  const view: WorldView = world
  const policy = BOTS[policyName].create(seed)
  const obs = options.observations

  const choices: ChoiceObservation[] = []
  let open: OpenChoice | null = null
  let scrapSpent = 0
  let shopsSeen = 0

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
    // closes inside one. The two transitions cannot coincide: the sim refuses to
    // open a choice on a tick that resolved one, so every screen is seen open for
    // at least one tick and none is ever missed.
    const pending = view.pendingChoice
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
        inventoryBefore: inventoryCounts(view),
      }
    } else if (pending === null && open !== null) {
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
        resolved: true,
      })
      open = null
    }

    // Sampled rather than per-tick: this is coverage bookkeeping, not sim state,
    // and scanning every enemy every tick would show up in the sweep timing.
    if (ticks % ENEMY_SAMPLE_TICKS === 0) {
      for (const enemy of view.enemies) if (enemy.alive) obs.enemyDefsSeen.add(enemy.defId)
    }
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
    ['runs', 6, (s) => String(s.runs)],
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
  console.log('wave column is median/max. p10/med/p90 are survival time in seconds.')
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
      `(budget ${MAX_CHOICE_RESOLUTION_TICKS}; the sim's fallback timeout is 3600 and no policy may reach it — ` +
      'the surplus is hitstop overlapping a reward screen, which costs nothing)',
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
          'and every pick rate above is suspect',
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
  notes.push('hull variants are not swept — one hull exists')
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
  --record-fixture=NAME record one run to tests/replays/NAME.json and verify it
                        (always runs with the World default pool — see COVERAGE)

Policies:
${BOT_NAMES.map((name) => `  ${pad(name, 14)}${BOTS[name].measures}`).join('\n')}
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
  const content = args.noItems ? undefined : RUN_CONTENT
  const startedNs = process.hrtime.bigint()
  const summaries: PolicySummary[] = []
  const allRuns: RunResult[] = []
  let totalTicks = 0

  for (const policy of args.policies) {
    const runs: RunResult[] = []
    for (let i = 0; i < args.runs; i++) {
      const result = runOnce(policy, deriveSeed(args.seed, i), { maxTicks, observations, content })
      runs.push(result)
      totalTicks += result.ticks
    }
    summaries.push(summarise(policy, runs))
    allRuns.push(...runs)
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
  }

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
      },
      timing,
      policies: summaries,
      /** Pooled across every policy. This is what the M3 verdict is read from. */
      items: aggregateItems,
      builds: aggregateBuilds,
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
        notMeasured: [
          'fun',
          'hull variants',
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
    return
  }

  console.log('')
  console.log(
    `PLAYTEST  base seed ${args.seed}  ${args.runs} runs x ${args.policies.length} policies  cap ${args.maxSeconds}s  ` +
      `items ${args.noItems ? 'OFF' : `on (${ALL_ITEM_IDS.length} in pool, ${ALL_INTERACTION_IDS.length} interactions)`}`,
  )
  console.log('')
  printTable(summaries)
  printDeaths(summaries)
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
}

/** Only run as a CLI. Importable from tests without launching a sweep. */
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main(process.argv.slice(2))
}

export { deriveSeed, main, runOnce, summarise }
