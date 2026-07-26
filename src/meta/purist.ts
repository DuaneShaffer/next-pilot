/**
 * Purist mode: certifications disabled, base pool only, for fair comparison.
 *
 * ## Why this is not a toggle
 *
 * The obvious implementation is `settings.purist = true`, written into the save
 * and stamped onto the score. That implementation is worthless, and it is worth
 * being precise about why: the *only* thing purist mode is for is comparing two
 * runs on the same seed (`docs/DESIGN.md`, Seeded runs). A flag the player set is
 * a claim about themselves. A claim that cannot be checked is not a score, it is
 * a sentence, and a daily-contract leaderboard built out of sentences is a
 * leaderboard where the honest player comes last.
 *
 * So nothing in this module records "this run was purist". What gets recorded is
 * the **pool the run actually drew from**, as a fingerprint, and purist status is
 * *derived* by comparing that fingerprint against the base pool of the build doing
 * the asking. A run drawing from an expanded pool cannot be relabelled by editing a
 * boolean, because there is no boolean: relabelling means forging a fingerprint that
 * matches the verifier's own base pool while the run demonstrably drew from
 * something else — which is what tier 2 below exists to catch.
 *
 * ## The two tiers of verification
 *
 * **Tier 1 — pool membership (cheap, always available).** The run records
 * `fingerprintPool(pool)` of the content it was constructed with. A verifier
 * recomputes `fingerprintPool(basePool)` from *its own* tables and compares. This
 * catches the ordinary case — a player with certifications unlocked flying a daily
 * and calling it purist — and it costs nothing, so it can be shown on a list row.
 *
 * Note carefully what tier 1 compares. It does NOT compare the run's fingerprint
 * against a base fingerprint the *run itself* recorded; that would be the honour
 * system with extra steps, since one build wrote both numbers. It compares against
 * the verifier's base pool. The reference point always belongs to the verifier.
 *
 * **Tier 2 — replay agreement (strong, needs the inputs).** A run is a seed plus a
 * byte per tick (`src/meta/replay.ts`). Replay those inputs on an unmodified build
 * against the base pool and hash the result (`hashWorld`). If the run really drew
 * from the base pool, the hash matches the one the run recorded. If the pilot had a
 * certification-expanded pool, an item that does not exist in the base pool was
 * offered and taken, the run diverges within seconds, and the hashes differ. Tier 2
 * is what makes a *shared* purist claim checkable by a stranger.
 *
 * ## What this cannot prevent — stated plainly
 *
 * 1. **A modified client can write any record it likes.** `localStorage` belongs to
 *    the player and this game has no server (`docs/DESIGN.md`, non-goals). Anyone
 *    can hand-edit a record, or patch this file. Tier 1 therefore proves nothing
 *    about a record you were *handed*; it only tells an honest client the truth
 *    about its own run, which is what makes the label on the player's own screen
 *    correct rather than flattering.
 * 2. **Tier 2 needs the inputs.** A record with no replay attached is a tier-1
 *    claim, and `verifyPurist` says so — the verdict distinguishes "matches the
 *    base pool" from "reproduced against the base pool". Do not present the first
 *    as the second.
 * 3. **A cheat can patch its own base tables.** If someone edits `src/content/**`
 *    so their expanded pool *is* their base pool, their run is self-consistently
 *    "purist" on their machine. It is not on anyone else's: their fingerprint will
 *    not equal the verifier's, so the run reads `expanded` — the forgery fails at
 *    exactly the moment it is compared to someone, which is the only moment that
 *    matters. This is why the fingerprint covers pool *membership*: the ids are the
 *    thing a verifier can independently reconstruct.
 * 4. **Nothing here proves a human flew the run.** Scripted inputs replay perfectly
 *    and are indistinguishable from a person's. Purist mode certifies which content
 *    pool a run drew from; it is not an anti-TAS measure and must not be described
 *    as one.
 * 5. **The fingerprint covers membership, not tuning.** Changing an item's numbers
 *    without changing which items exist leaves the fingerprint identical. That is
 *    deliberate — tuning is what `SIM_VERSION` and the tier-2 digest are for, and a
 *    fingerprint over every weight would change on every balance pass and make
 *    every stored record instantly "unverifiable".
 */

import { POOL_SLICES, type PoolSlice } from '../content/certifications'
import { SIM_VERSION } from './simVersion'

/**
 * Kinds of content a certification can add to a run's pool.
 *
 * From `docs/DESIGN.md`: certifications add hulls, weapon families, item families,
 * enemy types, boss variants, and work-order types. Each gets a category so the
 * fingerprint distinguishes an item id from an identically-named enemy id, and so a
 * future category is an additive change rather than a silent collision.
 */
/**
 * Pool categories, taken from the canonical pool definition rather than restated.
 *
 * This module first defined its own vocabulary — hull/weapon/item/interaction/
 * enemy/work-order/sector — while `content/certifications.ts` independently defined
 * items/enemies/workOrders/hulls/bossVariants/hazards for the same concept. Two
 * agents filled a gap in the contract at the same time, and the result was two
 * incompatible descriptions of one thing, which only surfaced when the app layer
 * tried to hand one to the other.
 *
 * One vocabulary now, and it is the one the game actually grants against, because a
 * fingerprint has to cover exactly what a certification can widen. Anything a
 * certification cannot add does not belong in the pool.
 */
export const POOL_CATEGORIES = POOL_SLICES

/** One vocabulary, re-exported so callers need not know which module owns it. */
export type PoolCategory = PoolSlice

/** The set of content ids a run was allowed to draw from, by category. */
export type RunPool = Readonly<Record<PoolSlice, readonly string[]>>
type RunPoolLocal = RunPool

/**
 * Format tag for the canonical text.
 *
 * Included in the hashed input so that if the canonicalisation ever changes, every
 * old fingerprint mismatches loudly instead of colliding with a new one computed a
 * different way. Same reasoning as the replay format's version byte.
 */
const FINGERPRINT_FORMAT = 'NPPOOL1'

export const EMPTY_POOL: RunPoolLocal = Object.freeze({
  items: [],
  enemies: [],
  workOrders: [],
  hulls: [],
  bossVariants: [],
  hazards: [],
})

/**
 * Build a pool from whichever categories a caller knows about.
 *
 * Missing categories are empty rather than an error: the base pool of an M4 build
 * has no sectors 2-5 and no boss variants to list, and demanding a value for every
 * category would mean the fingerprint changed when a category was merely *filled
 * in* rather than when the pool changed.
 */
export function makePool(parts: Partial<Record<PoolSlice, readonly string[]>>): RunPoolLocal {
  const out: Record<PoolSlice, readonly string[]> = { ...EMPTY_POOL }
  for (const category of POOL_CATEGORIES) {
    out[category] = parts[category] ?? []
  }
  return out
}

/**
 * The exact string a fingerprint is computed over.
 *
 * Exported because a fingerprint mismatch is otherwise undebuggable — two 16-hex
 * strings tell you nothing about *which* item was extra. Diff two canonical texts
 * and the answer is one line.
 *
 * Ids are deduplicated and sorted, so a pool is a set: the order content tables
 * happen to be declared in must never change whether a run counts as purist.
 */
export function canonicalPoolText(pool: RunPoolLocal): string {
  const lines: string[] = [FINGERPRINT_FORMAT]
  for (const category of POOL_CATEGORIES) {
    const ids = pool[category] ?? []
    const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))]
    // Code-unit sort, not locale-aware: `localeCompare` orders differently across
    // browsers and would make the same pool fingerprint differently on two
    // machines, which is the one failure this whole module cannot tolerate.
    unique.sort()
    for (const id of unique) lines.push(`${category}:${id}`)
  }
  return lines.join('\n')
}

/** FNV-1a 32-bit with an injectable offset basis, so two passes give 64 bits. */
function fnv1a(text: string, basis: number): number {
  let h = basis | 0
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619)
  }
  return h >>> 0
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, '0')
}

/**
 * A short, stable identifier for a pool's membership.
 *
 * 64 bits as two FNV-1a passes with different offset bases. Not cryptographic and
 * not claimed to be: the threat model (point 3 in the header) is a mismatch being
 * *noticed*, not an attacker who cannot find a preimage. 16 hex characters is small
 * enough to sit in every stored record and in a URL.
 */
export function fingerprintPool(pool: RunPool): string {
  const text = canonicalPoolText(pool)
  return `${hex8(fnv1a(text, 0x811c9dc5))}${hex8(fnv1a(text, 0x01000193))}`
}

/** Shape of the fingerprint, for validating something read back from storage. */
const FINGERPRINT_PATTERN = /^[0-9a-f]{16}$/

export function isPoolFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value)
}

/**
 * What a stored run has to carry for its purist status to be derivable.
 *
 * Note what is absent: any field meaning "this was purist". `PersonnelRecord`
 * satisfies this structurally, which is the point — the record stores evidence and
 * the verdict is computed, so there is nothing to falsify locally beyond the
 * evidence itself.
 */
export interface PuristSubject {
  /** Fingerprint of the pool the run was actually constructed with. */
  readonly poolFingerprint: string
  /** Sim version the run was flown under. */
  readonly simVersion: number
  /**
   * `hashWorld` of the final state, or null when it was not captured.
   *
   * Tier 2's claimed value. A replay of the same seed and inputs on the base pool
   * has to reproduce it.
   */
  readonly stateDigest: string | null
}

export type PuristVerdict =
  /** Pool membership matches the verifier's base pool. Tier 1. */
  | { readonly kind: 'purist'; readonly reproduced: boolean }
  /** The run drew from a pool this build's base pool does not describe. */
  | { readonly kind: 'expanded'; readonly expected: string; readonly found: string }
  /** A replay against the base pool did not reproduce the recorded state. */
  | { readonly kind: 'refuted'; readonly claimed: string; readonly observed: string }
  /** Cannot be compared at all. Not an accusation. */
  | {
      readonly kind: 'unverifiable'
      readonly reason: 'sim-version' | 'no-fingerprint'
      readonly recordedSimVersion?: number
      readonly currentSimVersion?: number
    }

export interface PuristCheckOptions {
  /** Sim version of the build doing the checking. Defaults to this build's. */
  readonly simVersion?: number | undefined
  /**
   * State hash observed by replaying the run's seed and inputs on this build
   * against the base pool. Provide it to reach tier 2; omit for tier 1.
   */
  readonly observedDigest?: string | null | undefined
}

/**
 * Derive a run's purist status. Never reads a flag, because there is no flag.
 *
 * A differing `simVersion` yields `unverifiable`, not `expanded`. This build does
 * not know what an older build's base pool contained, so a mismatch there is
 * ambiguous between "they had certifications" and "the base pool gained an item
 * since" — and reporting a run as non-purist because the game was updated would
 * be a false accusation, which is worse than admitting the comparison cannot be
 * made. It also means a purist badge is scoped to a single set of rules, which is
 * exactly the scope in which two scores are comparable anyway.
 */
export function verifyPurist(
  subject: PuristSubject,
  basePool: RunPool,
  options: PuristCheckOptions = {},
): PuristVerdict {
  const currentSimVersion = options.simVersion ?? SIM_VERSION
  if (!isPoolFingerprint(subject.poolFingerprint)) {
    return { kind: 'unverifiable', reason: 'no-fingerprint' }
  }
  if (subject.simVersion !== currentSimVersion) {
    return {
      kind: 'unverifiable',
      reason: 'sim-version',
      recordedSimVersion: subject.simVersion,
      currentSimVersion,
    }
  }

  const expected = fingerprintPool(basePool)
  if (subject.poolFingerprint !== expected) {
    return { kind: 'expanded', expected, found: subject.poolFingerprint }
  }

  // Tier 2. Only reachable once membership already matched: a divergent replay on a
  // run that drew from a different pool is explained by the pool, and reporting
  // `refuted` there would blame the wrong thing.
  const observed = options.observedDigest
  if (typeof observed === 'string' && observed.length > 0) {
    if (subject.stateDigest === null) {
      // Nothing to compare against. The pool still matches, so this stays a tier-1
      // pass rather than becoming a failure — but `reproduced` says it was not
      // reproduced, and callers must not upgrade that to "verified".
      return { kind: 'purist', reproduced: false }
    }
    if (subject.stateDigest !== observed) {
      return { kind: 'refuted', claimed: subject.stateDigest, observed }
    }
    return { kind: 'purist', reproduced: true }
  }

  return { kind: 'purist', reproduced: false }
}

/** Convenience predicate. False for every verdict that is not a pass. */
export function isPurist(
  subject: PuristSubject,
  basePool: RunPool,
  options: PuristCheckOptions = {},
): boolean {
  return verifyPurist(subject, basePool, options).kind === 'purist'
}

/**
 * Short badge text for a list row, or null when there is nothing to say.
 *
 * Deliberately silent for `unverifiable`: a row that shouts UNVERIFIED at every
 * pre-update run reads as an error state rather than as history.
 */
export function puristBadge(verdict: PuristVerdict): string | null {
  switch (verdict.kind) {
    case 'purist':
      return verdict.reproduced ? 'PURIST · REPRODUCED' : 'PURIST'
    case 'expanded':
      return 'CERTIFIED POOL'
    case 'refuted':
      return 'DISPUTED'
    case 'unverifiable':
      return null
  }
}

/**
 * One sentence for the detail view. Functional text, so no jokes — a player
 * reading this is asking whether their score counts.
 */
export function describePuristVerdict(verdict: PuristVerdict): string {
  switch (verdict.kind) {
    case 'purist':
      return verdict.reproduced
        ? 'Base pool only, reproduced from the recorded inputs. Comparable on this seed.'
        : 'Base pool only. Comparable on this seed; attach the replay to reproduce it.'
    case 'expanded':
      return 'Flown with a certified pool, so it is not comparable with a base-pool run.'
    case 'refuted':
      return 'Replaying the recorded inputs on the base pool produced a different run.'
    case 'unverifiable':
      return verdict.reason === 'sim-version'
        ? `Filed under sim v${verdict.recordedSimVersion ?? 0}; this build is v${
            verdict.currentSimVersion ?? SIM_VERSION
          }. The rules have changed, so it cannot be compared.`
        : 'No pool fingerprint was recorded, so the pool cannot be checked.'
  }
}
