/**
 * Personnel files — the data side.
 *
 * `docs/DESIGN.md`: "Personnel files record every dead pilot: hull, cause of loss,
 * depth, seed. It's a run history that doubles as the game's writing surface — a
 * browsable list of institutional indifference." This module owns the record; the
 * writing lives in `src/ui/personnel.ts`.
 *
 * ## This module never touches storage
 *
 * Every function here takes a history and returns one. `src/meta/save.ts` owns
 * persistence and schema migration, and its header is explicit that the way saves
 * get destroyed is by code reaching around it. A history that read `localStorage`
 * itself would also be untestable without a DOM, and would give two owners to the
 * same bytes.
 *
 * ## The cap is a policy, not an accident
 *
 * `PERSONNEL_HISTORY_CAP` is a hard limit and `appendPersonnelRecord` *returns what
 * it dropped*. Two failure modes are being avoided at once:
 *
 *   - An unbounded list eventually exceeds the origin's `localStorage` quota. The
 *     write throws, `persistSave` swallows it (correctly — a full disk must not end
 *     a run), and from then on **nothing saves**: pilot number, settings, and
 *     certifications all quietly stop persisting because the history got too big.
 *     One feature's growth would break every other feature's storage.
 *   - Silently discarding the oldest file is worse than a stated cap. The player
 *     scrolls to the bottom and their first pilot is gone, with nothing anywhere
 *     saying it ever could be. So the drop is returned to the caller and the screen
 *     states the retention rule.
 *
 * ## No timestamp, deliberately
 *
 * There is no `filedAt`. Ordering is append order, which is all the list needs, and
 * a wall-clock date rendered on the screen would change between two captures of the
 * same state — breaking screenshot comparison, which is this project's only visual
 * regression check (`docs/VERIFICATION.md`). If dates are wanted later they are an
 * additive field and a new record version.
 */

import { TICK_HZ } from '../core/loop'
import { isValidSeed, normalizeSeed } from '../core/seed'
import type { DeathCauseKind, WorldView } from '../sim/entities'
import { hashWorld } from './snapshot'
import { isPoolFingerprint, type PuristSubject } from './purist'
import { SIM_VERSION } from './simVersion'

/**
 * Record schema version, independent of the save version.
 *
 * A record travels inside the save but is also the unit a corrupt entry gets
 * rejected at, so it carries its own version: a save migration upgrades the
 * envelope, and `sanitizePersonnelRecord` decides whether an individual file is
 * readable. Bump this when a field's meaning changes, and prefer additive fields
 * with defaults so old records stay readable.
 */
export const PERSONNEL_RECORD_VERSION = 1

/**
 * How many files are retained.
 *
 * 50, from a measured storage budget rather than from taste. Measured, because the
 * first estimate written here was ~600 bytes per record and the real numbers are:
 *
 *   - a typical record (10 held items, real ids): **705 bytes** of JSON → 35KB at
 *     the cap
 *   - an adversarial record (16 items, 30-character ids, six-figure counters):
 *     **1,193 bytes** → 60KB at the cap
 *
 * Against a conservative 5MB `localStorage` quota shared with settings,
 * certifications, and any saved replays, the worst case is ~1.2% of the budget. The
 * failure this bounds is not disk space, it is that one oversized value makes
 * `setItem` throw, `persistSave` correctly swallows the error, and from then on
 * *nothing* saves — pilot number and settings included. One feature's growth must
 * not be able to break every other feature's storage.
 *
 * `tests/personnel.test.ts` asserts a full adversarial history against
 * `PERSONNEL_BYTES_BUDGET`, so this claim cannot rot as fields are added.
 *
 * 50 is also more history than anyone browses: 50 runs at 15-20 minutes is 12-16
 * hours of play, and a scroll list of 50 rows is still navigable with a keyboard.
 * The cap could be 500 and still fit; it is 50 because a longer list is not a
 * better one.
 */
export const PERSONNEL_HISTORY_CAP = 50

/**
 * Byte ceiling a full history must stay under. Asserted by a test, not hoped for.
 *
 * 80KB against a measured worst case of 60KB — a third of headroom, so adding a
 * field is a deliberate decision rather than an instant test failure, and doubling
 * the record size is not.
 */
export const PERSONNEL_BYTES_BUDGET = 80 * 1024

/**
 * How many held items a record keeps.
 *
 * Bounds the one field that can grow without limit — an inventory is unbounded in
 * principle, and a record whose size depends on how greedy the pilot was makes the
 * storage budget unpredictable. Overflow is reported as a count, so the detail view
 * can say "+3 more" rather than lying about the build.
 */
export const PERSONNEL_ITEM_CAP = 16

export type PersonnelOutcome = 'lost' | 'extracted'

/** One held item at the end of the run, with its stack count. */
export interface PersonnelHolding {
  readonly id: string
  readonly count: number
}

/**
 * One filed pilot.
 *
 * Flat and primitive-only, because it round-trips through `JSON.stringify` into
 * `localStorage`: a `Map`, a `Set`, or a class instance would silently become `{}`.
 * `tests/personnel.test.ts` round-trips a fully-populated record field by field.
 *
 * Note what is stored raw: `shotsFired` and `hits`, not accuracy. A stored
 * percentage cannot represent "no shots fired" — it rounds to 0, which reads as
 * having missed everything rather than as having never fired. See
 * `personnelAccuracy`.
 */
export interface PersonnelRecord extends PuristSubject {
  readonly v: number
  /** The pilot's file number. Not an index into the history — files outlive it. */
  readonly pilotNumber: number
  readonly hullId: string
  readonly outcome: PersonnelOutcome
  /** Null on an extraction: a pilot who came home has no cause of loss. */
  readonly causeKind: DeathCauseKind | null
  readonly causeEnemyId: string | null
  readonly sectorId: string
  readonly waveIndex: number
  /** Whole sim ticks. Stored rather than seconds so it is exact and integral. */
  readonly ticks: number
  readonly kills: number
  readonly scrap: number
  readonly shotsFired: number
  readonly hits: number
  /** Normalised, so a file number derived from it is stable. */
  readonly seed: string
  readonly items: readonly PersonnelHolding[]
  /** Held items beyond `PERSONNEL_ITEM_CAP`. Zero normally. */
  readonly itemsOmitted: number
  /** From `src/meta/purist.ts`. Purist status is derived from this, never stored. */
  readonly poolFingerprint: string
  readonly simVersion: number
  /** `hashWorld` of the final state, for purist tier 2. Null if not captured. */
  readonly stateDigest: string | null
}

export interface PersonnelRecordInput {
  readonly pilotNumber: number
  readonly hullId: string
  readonly sectorId: string
  /** Fingerprint of the pool this run drew from. See `src/meta/purist.ts`. */
  readonly poolFingerprint: string
  readonly simVersion?: number | undefined
  /**
   * Skip the final-state hash.
   *
   * Costs a pass over the live entity lists. Left on by default because it is the
   * evidence purist tier 2 checks against and a run ends once; pass `false` in a
   * bulk harness that files thousands of records.
   */
  readonly captureDigest?: boolean | undefined
}

// ---------------------------------------------------------------------------
// building
// ---------------------------------------------------------------------------

function nonNegativeInt(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(0, Math.floor(value))
}

/**
 * File a completed run.
 *
 * THE OUTCOME IS READ FROM `runState`, NOT FROM THE PRESENCE OF AN INCIDENT. The
 * incident report screen already shipped this bug once: a tester cleared sector 1
 * and was shown "HULL LOSS CONFIRMED" with a TOTAL LOSS stamp, because the screen
 * assumed one outcome where `runState` has three. A history that repeats it is
 * worse than a screen that does — the screen is wrong for one keypress, the file is
 * wrong forever.
 *
 * `active` is treated as `lost`, because the only way a run reaches here still
 * active is an abandoned sortie, which the pause menu already describes as the hull
 * being written off.
 */
export function buildPersonnelRecord(
  view: WorldView,
  input: PersonnelRecordInput,
): PersonnelRecord {
  const extracted = view.runState === 'extracted'
  const incident = view.incident
  const stats = view.stats

  const items: PersonnelHolding[] = []
  for (const held of view.inventory.slice(0, PERSONNEL_ITEM_CAP)) {
    items.push({ id: held.defId, count: Math.max(1, nonNegativeInt(held.count, 1)) })
  }
  const itemsOmitted = Math.max(0, view.inventory.length - items.length)

  return {
    v: PERSONNEL_RECORD_VERSION,
    pilotNumber: Math.max(1, nonNegativeInt(input.pilotNumber, 1)),
    hullId: input.hullId,
    outcome: extracted ? 'extracted' : 'lost',
    // Cleared unconditionally on an extraction rather than copied from the
    // incident. The sim does not populate an incident for a cleared run today, but
    // "the field happens to be null" is not the same guarantee as "this branch
    // cannot report a cause for a pilot who came home".
    causeKind: extracted ? null : (incident?.causeKind ?? null),
    causeEnemyId: extracted ? null : (incident?.causeEnemyId ?? null),
    sectorId: input.sectorId,
    // The incident's snapshot wins where it exists: it was taken at the moment of
    // loss, and `stats` keeps advancing for the ticks the death animation runs.
    waveIndex: nonNegativeInt(incident?.waveIndex ?? stats.waveIndex),
    ticks: nonNegativeInt(incident?.tick ?? stats.tick),
    kills: nonNegativeInt(incident?.kills ?? stats.kills),
    scrap: nonNegativeInt(incident?.scrap ?? stats.scrap),
    shotsFired: nonNegativeInt(stats.shotsFired),
    hits: nonNegativeInt(stats.hits),
    seed: normalizeSeed(view.seed),
    items,
    itemsOmitted,
    poolFingerprint: input.poolFingerprint,
    simVersion: input.simVersion ?? SIM_VERSION,
    stateDigest: input.captureDigest === false ? null : hashWorld(view),
  }
}

// ---------------------------------------------------------------------------
// the history
// ---------------------------------------------------------------------------

export interface PersonnelAppendResult {
  /** Oldest first, newest last, never longer than the cap. */
  readonly history: readonly PersonnelRecord[]
  /**
   * Records the cap forced out, oldest first.
   *
   * Returned rather than logged, so the caller can *say so*. An empty array is the
   * normal case and means nothing was lost.
   */
  readonly dropped: readonly PersonnelRecord[]
}

/**
 * Append a record, evicting the oldest files if the cap is exceeded.
 *
 * Stored oldest-first because that is append order and appending is the only write;
 * the screen reverses it for display (`newestFirst`). Keeping storage in display
 * order would mean every filing rewrote the whole array's indices for no gain.
 */
export function appendPersonnelRecord(
  history: readonly PersonnelRecord[],
  record: PersonnelRecord,
  cap: number = PERSONNEL_HISTORY_CAP,
): PersonnelAppendResult {
  const limit = Math.max(1, Math.floor(cap))
  const combined = [...history, record]
  if (combined.length <= limit) return { history: combined, dropped: [] }
  const cut = combined.length - limit
  // Trims from the FRONT, so the newest are what survive. Dropping the newest
  // would mean a full history stopped recording, which is the same bug as not
  // saving at all and much harder to notice.
  return { history: combined.slice(cut), dropped: combined.slice(0, cut) }
}

/** Display order: newest file first. Does not mutate the stored array. */
export function newestFirst(
  history: readonly PersonnelRecord[],
): readonly PersonnelRecord[] {
  return [...history].reverse()
}

// ---------------------------------------------------------------------------
// reading back
// ---------------------------------------------------------------------------

const OUTCOMES: readonly PersonnelOutcome[] = ['lost', 'extracted']
const CAUSE_KINDS: readonly DeathCauseKind[] = ['enemy-fire', 'collision', 'hazard']
/** 16 lowercase hex, matching both `Hasher.digest()` and a pool fingerprint. */
const DIGEST_PATTERN = /^[0-9a-f]{16}$/

function optionalString(value: unknown, maxLength = 64): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > maxLength) return null
  return trimmed
}

function sanitizeHoldings(raw: unknown): readonly PersonnelHolding[] {
  if (!Array.isArray(raw)) return []
  const out: PersonnelHolding[] = []
  for (const entry of raw.slice(0, PERSONNEL_ITEM_CAP)) {
    if (typeof entry !== 'object' || entry === null) continue
    const holding = entry as { id?: unknown; count?: unknown }
    const id = optionalString(holding.id)
    if (id === null) continue
    out.push({ id, count: Math.max(1, nonNegativeInt(holding.count, 1)) })
  }
  return out
}

/**
 * Coerce one stored value into a record, or reject it.
 *
 * A CORRUPT SAVE MUST NOT MAKE THE SCREEN UNOPENABLE. Records are the one part of
 * the save that grows per run, so they are the part most likely to be truncated by
 * a quota error mid-write, and the personnel screen is reachable from the title —
 * a throw here would mean a player with one bad byte cannot get past the menu.
 *
 * The split between "coerce" and "reject" follows what the screen can honestly
 * draw. A missing count is drawn as zero and the file still means something. A
 * missing *seed*, *hull*, or *outcome* is not a file: the seed is the run's
 * identity (UI rule 8) and the outcome decides whether the row says the pilot died,
 * so guessing either would fabricate history rather than degrade it.
 */
export function sanitizePersonnelRecord(raw: unknown): PersonnelRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const candidate = raw as Record<string, unknown>

  const version = nonNegativeInt(candidate['v'], 0)
  // A record from a future build may have re-used a field name for something else.
  // Reading it anyway would put invented history on screen.
  if (version < 1 || version > PERSONNEL_RECORD_VERSION) return null

  const seedRaw = optionalString(candidate['seed'], 32)
  if (seedRaw === null || !isValidSeed(seedRaw)) return null

  const outcome = candidate['outcome']
  if (typeof outcome !== 'string' || !OUTCOMES.includes(outcome as PersonnelOutcome)) return null

  const hullId = optionalString(candidate['hullId'])
  if (hullId === null) return null

  const pilotNumber = nonNegativeInt(candidate['pilotNumber'], 0)
  if (pilotNumber < 1) return null

  const extracted = outcome === 'extracted'
  const causeKindRaw = candidate['causeKind']
  const causeKind =
    !extracted && typeof causeKindRaw === 'string' && CAUSE_KINDS.includes(causeKindRaw as DeathCauseKind)
      ? (causeKindRaw as DeathCauseKind)
      : null

  const fingerprint = candidate['poolFingerprint']
  const digest = candidate['stateDigest']

  return {
    v: PERSONNEL_RECORD_VERSION,
    pilotNumber,
    hullId,
    outcome: outcome as PersonnelOutcome,
    causeKind,
    // Cleared for an extraction on the way *in* as well as on the way out, so a
    // hand-edited or half-migrated record cannot show a killer for a pilot the
    // same record says came home.
    causeEnemyId: extracted ? null : optionalString(candidate['causeEnemyId']),
    sectorId: optionalString(candidate['sectorId']) ?? 'unknown',
    waveIndex: nonNegativeInt(candidate['waveIndex']),
    ticks: nonNegativeInt(candidate['ticks']),
    kills: nonNegativeInt(candidate['kills']),
    scrap: nonNegativeInt(candidate['scrap']),
    shotsFired: nonNegativeInt(candidate['shotsFired']),
    // Clamped to the shots taken. `hits > shotsFired` would render as an accuracy
    // above 100%, which reads as a bug in the panel rather than in the save.
    hits: Math.min(nonNegativeInt(candidate['hits']), nonNegativeInt(candidate['shotsFired'])),
    seed: normalizeSeed(seedRaw),
    items: sanitizeHoldings(candidate['items']),
    itemsOmitted: nonNegativeInt(candidate['itemsOmitted']),
    // An unreadable fingerprint becomes empty rather than fabricated: `verifyPurist`
    // reports `unverifiable` for it, which is the truth. Inventing a plausible
    // fingerprint here could label a run purist that never was.
    poolFingerprint: isPoolFingerprint(fingerprint) ? fingerprint : '',
    simVersion: nonNegativeInt(candidate['simVersion']),
    stateDigest: typeof digest === 'string' && DIGEST_PATTERN.test(digest) ? digest : null,
  }
}

export interface PersonnelLoadResult {
  readonly history: readonly PersonnelRecord[]
  /** Entries that could not be read at all. Non-zero means the save was damaged. */
  readonly skipped: number
  /** Records the cap forced out while reading, oldest first. */
  readonly dropped: readonly PersonnelRecord[]
}

/**
 * Read a stored history.
 *
 * Enforces the cap on the way in as well as on append: a hand-edited or
 * pre-cap save can contain any number of records, and the screen must not have to
 * lay out nine hundred rows to find that out.
 */
export function sanitizePersonnelHistory(
  raw: unknown,
  cap: number = PERSONNEL_HISTORY_CAP,
): PersonnelLoadResult {
  if (!Array.isArray(raw)) return { history: [], skipped: 0, dropped: [] }
  const records: PersonnelRecord[] = []
  let skipped = 0
  for (const entry of raw) {
    const record = sanitizePersonnelRecord(entry)
    if (record === null) {
      skipped++
      continue
    }
    records.push(record)
  }
  const limit = Math.max(1, Math.floor(cap))
  if (records.length <= limit) return { history: records, skipped, dropped: [] }
  const cut = records.length - limit
  return { history: records.slice(cut), skipped, dropped: records.slice(0, cut) }
}

// ---------------------------------------------------------------------------
// derived values
// ---------------------------------------------------------------------------

/**
 * Accuracy as a percentage, or null when the pilot never fired.
 *
 * NULL, NOT ZERO. Zero shots is not zero accuracy: 0% says every round missed,
 * which is a statement about aim, when the truth is that there is no statement to
 * make. Both the instrument panel and the incident report already render this case
 * as an em dash, and this returning 0 would put a different answer in the history
 * than the death screen gave — see `formatAccuracy`.
 */
export function personnelAccuracy(record: PersonnelRecord): number | null {
  if (record.shotsFired <= 0) return null
  return Math.round((record.hits / record.shotsFired) * 100)
}

/** Seconds survived, derived from whole ticks. */
export function personnelSeconds(record: PersonnelRecord): number {
  return record.ticks / TICK_HZ
}

/**
 * The file number.
 *
 * Pilot number and the head of the seed, matching the incident report's `FILE
 * 004-K7F2` exactly. The same run must be findable by the same string on both
 * screens, so this is a shared format and not a second invention.
 */
export function personnelFileNumber(record: PersonnelRecord): string {
  return `${String(record.pilotNumber).padStart(3, '0')}-${record.seed.slice(0, 4)}`
}

/** Total item count including stacks, for the "systems fitted" line. */
export function personnelItemCount(record: PersonnelRecord): number {
  let total = record.itemsOmitted
  for (const holding of record.items) total += holding.count
  return total
}

/** Byte cost of a history as stored. Used by the budget test, and cheap enough to log. */
export function personnelBytes(history: readonly PersonnelRecord[]): number {
  return JSON.stringify(history).length
}
