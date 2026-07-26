/**
 * Certifications at runtime: what a completed sortie files, what the pool
 * contains, and how a locked entry's progress reads.
 *
 * ## Everything here is a pure function of data handed in
 *
 * Nothing in this module reads storage, and nothing holds state. `save.ts` owns
 * persistence and passes the unlocked set in; `World` is never involved at all,
 * because a certification is decided *after* a run rather than during one. That is
 * what lets `tests/certifications.test.ts` assert reachability by constructing a
 * `RunSummary` literal instead of playing a sortie, and it is why unlock
 * evaluation is trivially deterministic: same summary in, same ids out, no clock,
 * no rng, no `localStorage`.
 *
 * ## THE SHAPE I NEED FROM save.ts (v3)
 *
 * ```ts
 *   certifications: {
 *     unlocked: readonly string[]                    // ids, order irrelevant
 *     progress: Readonly<Record<string, number>>     // best value per condition
 *   }
 * ```
 *
 * An array rather than a `Set` because the payload is JSON; callers convert once
 * with `unlockedSet`. Two coercers below are written for the migration to use:
 * `coerceUnlockedIds` drops ids this build does not know (a save written by a
 * build with an eleventh certification must load, not reset), and
 * `coerceProgress` drops non-finite and negative values. `DEFAULT_CERTIFICATIONS`
 * is the v2→v3 value: a v2 player never had certifications, so they start with
 * none rather than being granted a retroactive amnesty for runs nobody recorded.
 *
 * ## Why progress is one number per certification
 *
 * The hangar has to show "best 12 of 15 waves" for a locked entry, which needs a
 * *persisted* best rather than the last run's value. The alternative — a field per
 * measurable fact (best wave, best scrap, best accuracy, …) — grows the save
 * schema every time a condition is authored, and each addition is a numbered
 * interface plus a migration plus a fixture. Keying the best by *certification id*
 * means the condition owns its own metric, and adding an eleventh certification is
 * a content change with no schema change at all.
 */

import {
  BASE_POOL,
  CERTIFICATIONS,
  POOL_SLICES,
  type CertificationDef,
  type PoolSlice,
  type UnlockCondition,
} from '../content/certifications'
import type { WorldView } from '../sim/entities'

/**
 * Everything a finished sortie reports, and nothing else.
 *
 * Deliberately narrow. Every field is read by at least one condition, so there is
 * no fact in here that nothing checks — the same rule the pause menu applies to
 * settings rows. Two facts that a condition could plausibly have used are absent
 * on purpose: seconds survived, because `docs/ROADMAP.md` records that it is
 * `waveIndex` re-expressed while waves release on a fixed clock, and lifetime
 * totals of any kind, because a condition satisfied by attrition is the grinding
 * problem `docs/DESIGN.md` rejects.
 */
export interface RunSummary {
  readonly outcome: 'lost' | 'extracted'
  /** Last wave released. Depth. */
  readonly waveIndex: number
  /** Waves in the sector flown, so "of 30" is a fact rather than an assumption. */
  readonly waveCount: number
  readonly kills: number
  /**
   * Scrap in hand when the sortie ended — a BALANCE, not a lifetime total.
   *
   * `World` decrements it on a purchase, so hoarding and equipping compete for the
   * same number. `unlisted-clearance` is built on exactly that tension, and the
   * field name says `Held` so nobody reads it as "recovered".
   */
  readonly scrapHeld: number
  /** Includes damage absorbed by shields — see `applyHullDamage`. */
  readonly damageTaken: number
  readonly shotsFired: number
  readonly hits: number
  /** Def id of whatever ended the run, when attributable. */
  readonly causeEnemyId: string | null
  /** Distinct item ids fitted, not stacks. */
  readonly systemsFitted: number
  /** Declared interactions live at the end of the run. */
  readonly combinationsLive: number
}

/**
 * A sortie that achieved nothing, which is also the shape a run that never started
 * would report.
 *
 * Exported because it is the fixture the "nothing unlocks from a zero run" test is
 * written against, and because a caller with no run to summarise should have one
 * obvious thing to pass rather than assembling eleven zeroes and getting one wrong.
 */
export const EMPTY_RUN_SUMMARY: RunSummary = {
  outcome: 'lost',
  waveIndex: 0,
  waveCount: 0,
  kills: 0,
  scrapHeld: 0,
  damageTaken: 0,
  shotsFired: 0,
  hits: 0,
  causeEnemyId: null,
  systemsFitted: 0,
  combinationsLive: 0,
}

/**
 * Read a summary off a finished run.
 *
 * Lives here rather than in the app layer so there is one place that decides what
 * "systems fitted" means. `view.inventory` holds one entry per *distinct* id with a
 * stack count, so its length is distinct systems and not picks — a caller
 * open-coding `reduce((n, e) => n + e.count)` would file
 * `full-manifest-rating` for three copies of one item, which is the opposite of
 * what the certification is for.
 *
 * Falls back to `stats` when `incident` is null, because an extraction files no
 * incident and its wave count and scrap still have to come from somewhere.
 */
export function summariseRun(view: WorldView, waveCount: number): RunSummary {
  const stats = view.stats
  const incident = view.incident
  return {
    outcome: view.runState === 'extracted' ? 'extracted' : 'lost',
    waveIndex: incident?.waveIndex ?? stats.waveIndex,
    waveCount,
    kills: incident?.kills ?? stats.kills,
    scrapHeld: incident?.scrap ?? stats.scrap,
    damageTaken: stats.damageTaken,
    shotsFired: stats.shotsFired,
    hits: stats.hits,
    causeEnemyId: incident?.causeEnemyId ?? null,
    systemsFitted: view.inventory.length,
    combinationsLive: view.activeInteractions.length,
  }
}

// ---------------------------------------------------------------------------
// conditions
// ---------------------------------------------------------------------------

/**
 * Accuracy as a whole percent, floored.
 *
 * FLOOR AND NOT ROUND, so the number the hangar prints and the number the
 * evaluator compares can never disagree: 24.6% rounds to "25%" on the card while
 * failing a 25% threshold, and a player looking at a card that shows the number
 * they were asked for is entitled to the unlock. Floored, `display >= threshold`
 * holds exactly when the condition is met.
 */
function accuracyPercent(summary: RunSummary): number {
  if (summary.shotsFired <= 0) return 0
  return Math.floor((summary.hits / summary.shotsFired) * 100)
}

/** Did this sortie satisfy the condition? Pure, total, no side conditions. */
export function conditionMet(condition: UnlockCondition, summary: RunSummary): boolean {
  switch (condition.kind) {
    case 'wavesReached':
      return summary.waveIndex >= condition.waves
    case 'killsInRun':
      return summary.kills >= condition.kills
    case 'scrapHeld':
      return summary.scrapHeld >= condition.scrap
    case 'accuracy':
      // The sample gate is load-bearing: two lucky hits out of two is 100%, and
      // without a floor on shots the strictest-looking condition in the roster
      // would be the easiest one to file by accident.
      return summary.shotsFired >= condition.minShots && accuracyPercent(summary) >= condition.percent
    case 'bareHull':
      return summary.systemsFitted === 0 && summary.waveIndex >= condition.waves
    case 'combinationsLive':
      return summary.combinationsLive >= condition.combinations
    case 'systemsFitted':
      return summary.systemsFitted >= condition.systems
    case 'lostTo':
      return summary.outcome === 'lost' && summary.causeEnemyId === condition.enemyId
    case 'extracted':
      return summary.outcome === 'extracted'
    case 'cleanExtraction':
      return summary.outcome === 'extracted' && summary.damageTaken <= condition.damage
  }
}

/**
 * The comparable value this sortie achieved, or null when the condition is an
 * event rather than a quantity.
 *
 * Null is not "zero progress" — it means there is nothing honest to print. Coming
 * home is not 60% done at wave 18, and the hangar showing a bar creeping toward an
 * extraction would be inventing a number the game does not have.
 *
 * `accuracy` returns null below its sample gate rather than the raw percent, so a
 * 40-shot run cannot record a flattering best that a 3,000-shot run then fails to
 * beat.
 */
export function conditionMetric(condition: UnlockCondition, summary: RunSummary): number | null {
  switch (condition.kind) {
    case 'wavesReached':
      return summary.waveIndex
    case 'killsInRun':
      return summary.kills
    case 'scrapHeld':
      return summary.scrapHeld
    case 'accuracy':
      return summary.shotsFired >= condition.minShots ? accuracyPercent(summary) : null
    case 'bareHull':
      // Depth only counts while nothing is fitted, so a fully kitted clear reports
      // zero here rather than a best this condition can never be checked against.
      return summary.systemsFitted === 0 ? summary.waveIndex : 0
    case 'combinationsLive':
      return summary.combinationsLive
    case 'systemsFitted':
      return summary.systemsFitted
    case 'lostTo':
    case 'extracted':
    case 'cleanExtraction':
      return null
  }
}

/** The value `conditionMetric` has to reach. Null where there is no metric. */
export function conditionTarget(condition: UnlockCondition): number | null {
  switch (condition.kind) {
    case 'wavesReached':
      return condition.waves
    case 'killsInRun':
      return condition.kills
    case 'scrapHeld':
      return condition.scrap
    case 'accuracy':
      return condition.percent
    case 'bareHull':
      return condition.waves
    case 'combinationsLive':
      return condition.combinations
    case 'systemsFitted':
      return condition.systems
    case 'lostTo':
    case 'extracted':
    case 'cleanExtraction':
      return null
  }
}

/** `turret-heavy` becomes `Turret Heavy`. Only used when no name table is supplied. */
function prettifyId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export interface ConditionContext {
  /**
   * Waves in the sector the condition will be measured against.
   *
   * Passed in rather than imported: "wave 15 of 30" is only true for sector 1, and
   * a hangar that hardcodes 30 starts lying the day sector 2 has 40 waves.
   */
  readonly waveCount: number
  /** Resolves an enemy or item id to a display name. Defaults to prettifying it. */
  readonly nameFor?: (id: string) => string
}

/**
 * The condition as a sentence.
 *
 * DERIVED, NEVER AUTHORED. `docs/UI.md` rule 4 wants the mechanism stated with real
 * numbers, and a hand-written string beside a machine-checked predicate is a
 * promise nothing verifies — the number in the copy and the number in the
 * comparison drift the first time one is tuned. Generating the sentence from the
 * same literal the evaluator reads makes them the same fact.
 */
export function describeCondition(condition: UnlockCondition, ctx: ConditionContext): string {
  const name = ctx.nameFor ?? prettifyId
  // A sector with no wave count is a caller bug, but printing "of 0 waves" would
  // put it on screen. Degrade to the unqualified form instead.
  const waves = Number.isFinite(ctx.waveCount) && ctx.waveCount > 0 ? ctx.waveCount : null
  switch (condition.kind) {
    case 'wavesReached':
      return waves === null
        ? `Reach wave ${condition.waves} in one sortie.`
        : `Reach wave ${condition.waves} of ${waves} in one sortie.`
    case 'killsInRun':
      return `Destroy ${condition.kills} hostiles in one sortie.`
    case 'scrapHeld':
      return `End a sortie holding ${condition.scrap} cr or more, unspent.`
    case 'accuracy':
      return `End a sortie with ${condition.percent}% of at least ${condition.minShots} rounds on target.`
    case 'bareHull':
      return waves === null
        ? `Reach wave ${condition.waves} with no systems fitted.`
        : `Reach wave ${condition.waves} of ${waves} with no systems fitted.`
    case 'combinationsLive':
      return `End a sortie with ${condition.combinations} item combinations live.`
    case 'systemsFitted':
      return `End a sortie with ${condition.systems} distinct systems fitted.`
    case 'lostTo':
      return `Be lost to a ${name(condition.enemyId)}.`
    case 'extracted':
      return waves === null
        ? 'Extract from the corridor.'
        : `Extract from the corridor — all ${waves} waves cleared.`
    case 'cleanExtraction':
      return `Extract having taken no more than ${condition.damage} damage, shields included.`
  }
}

/**
 * Progress toward a locked condition, or null when there is nothing to say.
 *
 * Every unit is named, per `docs/UI.md` rule 2 — "best 12 of 15" could be waves,
 * kills, or credits, and on this screen it could plausibly be any of the three.
 */
export function describeProgress(
  condition: UnlockCondition,
  best: number | undefined,
): string | null {
  const target = conditionTarget(condition)
  if (target === null) return null
  if (best === undefined || !Number.isFinite(best)) return null
  const value = Math.max(0, Math.floor(best))
  switch (condition.kind) {
    case 'wavesReached':
    case 'bareHull':
      return `Best ${value} of ${target} waves`
    case 'killsInRun':
      return `Best ${value} of ${target} hostiles`
    case 'scrapHeld':
      return `Best ${value} of ${target} cr held`
    case 'accuracy':
      return `Best ${value}% of ${target}% on target`
    case 'combinationsLive':
      return `Best ${value} of ${target} combinations`
    case 'systemsFitted':
      return `Best ${value} of ${target} systems`
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// filing a run
// ---------------------------------------------------------------------------

/**
 * The persisted half of certifications. This is the shape `save.ts` should store
 * verbatim — see the header.
 */
export interface CertificationState {
  readonly unlocked: readonly string[]
  readonly progress: Readonly<Record<string, number>>
}

export const DEFAULT_CERTIFICATIONS: CertificationState = { unlocked: [], progress: {} }

/** Every id in the roster, for validation and for the "everything unlocked" pool. */
export const CERTIFICATION_IDS: readonly string[] = CERTIFICATIONS.map((def) => def.id)

export function isCertificationId(value: unknown): value is string {
  return typeof value === 'string' && CERTIFICATION_IDS.includes(value)
}

/**
 * Drop anything this build does not recognise, de-duplicate, and return roster
 * order.
 *
 * Unknown ids are DROPPED RATHER THAN KEPT, which is a real trade-off and the
 * milder of the two failures: keeping them would let a save round-trip through an
 * older build with its unlocks intact, but it would also mean `poolFor` handing
 * the sim ids from a roster it cannot describe, and the hangar listing a
 * certification it has no name or effect for. A player who runs a newer build and
 * then an older one loses the newer certifications from the older build's view;
 * they are re-earnable, and nothing crashes.
 *
 * Roster order rather than stored order so the persisted payload is stable —
 * otherwise two saves with the same unlocks serialise differently and every
 * fixture comparison becomes order-dependent.
 */
export function coerceUnlockedIds(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  for (const entry of raw) if (isCertificationId(entry)) seen.add(entry)
  return CERTIFICATION_IDS.filter((id) => seen.has(id))
}

/** Keep known ids with finite, non-negative bests. Everything else is dropped. */
export function coerceProgress(raw: unknown): Readonly<Record<string, number>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const source = raw as Record<string, unknown>
  const out: Record<string, number> = {}
  for (const id of CERTIFICATION_IDS) {
    if (!Object.hasOwn(source, id)) continue
    const value = source[id]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue
    out[id] = Math.floor(value)
  }
  return out
}

export function unlockedSet(ids: readonly string[]): ReadonlySet<string> {
  return new Set(coerceUnlockedIds(ids))
}

/**
 * Which certifications this sortie files, given what is already held.
 *
 * Returns roster order, which is what the incident report lists — a set has no
 * order and "certifications granted" reshuffling between two renders of the same
 * death would read as a bug.
 */
export function evaluateRun(
  summary: RunSummary,
  alreadyUnlocked: ReadonlySet<string>,
  roster: readonly CertificationDef[] = CERTIFICATIONS,
): readonly string[] {
  return roster
    .filter((def) => !alreadyUnlocked.has(def.id) && conditionMet(def.condition, summary))
    .map((def) => def.id)
}

/** Raise each recorded best by what this sortie managed. Never lowers one. */
export function mergeProgress(
  previous: Readonly<Record<string, number>>,
  summary: RunSummary,
  roster: readonly CertificationDef[] = CERTIFICATIONS,
): Readonly<Record<string, number>> {
  const out: Record<string, number> = { ...previous }
  for (const def of roster) {
    const metric = conditionMetric(def.condition, summary)
    if (metric === null || !Number.isFinite(metric)) continue
    const value = Math.max(0, Math.floor(metric))
    const best = out[def.id]
    if (best === undefined || value > best) out[def.id] = value
  }
  return out
}

/**
 * File a completed sortie: the new state, plus what it granted.
 *
 * One call so the app layer cannot update the unlocked set and forget the bests,
 * or persist one without the other. Pure — it returns a new state and mutates
 * nothing, so a caller can compute the result, show it on the incident report, and
 * persist it in whichever order suits.
 */
export function fileRun(
  summary: RunSummary,
  state: CertificationState = DEFAULT_CERTIFICATIONS,
  roster: readonly CertificationDef[] = CERTIFICATIONS,
): { readonly state: CertificationState; readonly newlyUnlocked: readonly string[] } {
  const held = unlockedSet(state.unlocked)
  const newlyUnlocked = evaluateRun(summary, held, roster)
  return {
    state: {
      unlocked: coerceUnlockedIds([...state.unlocked, ...newlyUnlocked]),
      progress: mergeProgress(state.progress, summary, roster),
    },
    newlyUnlocked,
  }
}

// ---------------------------------------------------------------------------
// the pool
// ---------------------------------------------------------------------------

export type RunPool = Readonly<Record<PoolSlice, readonly string[]>>

/**
 * What the run draws from, given what has been certified.
 *
 * Additive only. The base pool is always present in full and always first, so this
 * function has no way to *remove* content — purist mode is `poolFor(new Set())`
 * rather than a separate code path, and a certification cannot make a run's
 * options narrower.
 *
 * Order is base order then roster order, and duplicates collapse to the first
 * occurrence. That matters because `buildOffers` draws from `Object.values` of a
 * table: two players with the same seed and the same unlocks must be handed the
 * pool in the same order or their offers diverge, which would break shared seeds
 * for exactly the players who have progressed furthest.
 */
export function poolFor(
  unlocked: ReadonlySet<string>,
  base: RunPool = BASE_POOL,
  roster: readonly CertificationDef[] = CERTIFICATIONS,
): RunPool {
  const out = {} as Record<PoolSlice, string[]>
  for (const slice of POOL_SLICES) out[slice] = [...(base[slice] ?? [])]

  for (const def of roster) {
    if (!unlocked.has(def.id)) continue
    for (const grant of def.grants) {
      const list = out[grant.slice]
      if (!list.includes(grant.id)) list.push(grant.id)
    }
  }
  return out
}

/** Total ids across every slice. The hangar's "pool: X of Y entries". */
export function poolSize(pool: RunPool): number {
  let total = 0
  for (const slice of POOL_SLICES) total += pool[slice].length
  return total
}

/** The pool with every certification filed. Also the denominator in the hangar. */
export function fullPool(
  base: RunPool = BASE_POOL,
  roster: readonly CertificationDef[] = CERTIFICATIONS,
): RunPool {
  return poolFor(new Set(roster.map((def) => def.id)), base, roster)
}

/**
 * The `slice: count` deltas one certification contributes, for the hangar's tag.
 *
 * Computed rather than authored, so the "+2 items" on a card cannot disagree with
 * the grants beneath it. This is the same reasoning as `describeCondition`: any
 * number a human types twice is a number that will eventually be wrong once.
 */
export function grantCounts(def: CertificationDef): ReadonlyArray<{
  readonly slice: PoolSlice
  readonly count: number
}> {
  const counts = new Map<PoolSlice, number>()
  for (const grant of def.grants) counts.set(grant.slice, (counts.get(grant.slice) ?? 0) + 1)
  // Emitted in POOL_SLICES order rather than insertion order, so two certifications
  // granting the same slices always tag them the same way round.
  return POOL_SLICES.filter((slice) => counts.has(slice)).map((slice) => ({
    slice,
    count: counts.get(slice) ?? 0,
  }))
}

/** Singular/plural noun for a slice, for the computed grant tag. */
export function sliceNoun(slice: PoolSlice, count: number): string {
  const one = count === 1
  switch (slice) {
    case 'items':
      return one ? 'item' : 'items'
    case 'enemies':
      return one ? 'enemy type' : 'enemy types'
    case 'workOrders':
      return one ? 'work-order type' : 'work-order types'
    case 'hulls':
      return one ? 'hull' : 'hulls'
    case 'bossVariants':
      return one ? 'boss variant' : 'boss variants'
    case 'hazards':
      return one ? 'hazard' : 'hazards'
  }
}
