/**
 * What run am I flying, and how do I hand it to someone else?
 *
 * Three things live here because they are one question asked three ways:
 *
 *   1. **Run modes.** A run is a free flight, a seed someone shared, the daily
 *      contract, or a replay being watched. That is modelled as a discriminated
 *      union rather than a bag of booleans, because the booleans version does not
 *      survive contact with reality: `isDaily && isReplay && isPurist` has eight
 *      states, six of which are nonsense, and the HUD ends up guessing which of
 *      them it is looking at. UI.md rule 8 says the seed is always visible; the
 *      corollary is that the *kind* of run must be too, and a label the code
 *      cannot derive unambiguously is a label that will eventually lie.
 *
 *   2. **The daily contract.** `dailySeed()` has existed since M0 and nothing has
 *      ever called it. This is the wiring, plus the exact persistence shape the
 *      save needs (see `DailyRecord`). Storage is deliberately NOT touched here —
 *      resolution takes the stored record as an argument so it stays a pure
 *      function and every combination can be tested without a browser.
 *
 *   3. **Share links.** Two different artifacts with two different promises. A
 *      seed link reproduces the *starting conditions* and is always short enough
 *      to paste. A replay link carries the input log so the recipient watches the
 *      run that actually happened — and it is not always short enough to paste.
 *      See the length policy below; that measurement is the reason this module
 *      exists rather than a one-line `?r=` builder.
 *
 * ## Length policy — measured, not assumed
 *
 * Measured on this build, ten seeds per policy, full runs to death or a 240s cap,
 * real `ReplayRecorder.encode()` output:
 *
 * ```
 *   policy          ticks           encoded chars (min / median / max)
 *   aggressor       10386..11306      954 /  1310 /  1610
 *   greedy           9012..11343     1124 /  1491 /  1916
 *   random           3487..7999       680 /  1256 /  1504
 *   build-focused   10800..11317     2432 /  2991 /  4835
 *   dodger           7198..9283      4255 /  5754 /  7626
 * ```
 *
 * RLE only pays when inputs are *held*. `aggressor` holds fire and drifts, so a
 * three-minute run is 1.3KB. `dodger` re-evaluates its dodge direction every tick
 * and produces a shorter run that is **five times larger** — 0.82 encoded chars
 * per tick versus 0.14. A synthetic worst case (input changing every single tick)
 * costs ~2.67 chars/tick: 4,832 chars for 30 seconds, 38,432 for four minutes.
 *
 * A human pilot is closer to `dodger` than to `aggressor`. So the honest
 * conclusion is that **a replay link fits sometimes**, and the interesting
 * engineering is what happens when it does not — because a silently truncated
 * replay link is strictly worse than no link at all. `shareReplay` therefore
 * measures the finished URL, refuses to emit one over the limit, says so with the
 * real numbers, and hands back the seed link instead.
 *
 * ## Why 2,000 characters
 *
 * Not a browser limit — Chrome's omnibox takes ~32k, Firefox and Safari far more.
 * 2,000 is the smallest cap in the chain a shared link actually travels through,
 * and the chain is only as strong as that link:
 *
 *   - 2,083 chars: the historic IE address-bar cap, which is the number virtually
 *     every "maximum safe URL" guide, link shortener, and URL-validating form
 *     field in existence was written against and still enforces.
 *   - 2,048 / 8,190 chars: default request-line limits in IIS and Apache
 *     (`LimitRequestLine`); nginx defaults to an 8k header buffer.
 *   - 2,953 bytes: a QR code at version 40 / EC level L. Under 2,000 a link is
 *     still scannable, which is how a link gets from a stream to a phone.
 *   - Mail clients and word processors auto-linkify by scanning for whitespace and
 *     have historically broken long URLs at around 2,000 characters.
 *
 * The failure modes above are silent: the link looks fine, the recipient gets a
 * checksum error or a 414, and blames the game. Being conservative costs a share
 * that would probably have worked; being generous costs trust in every share.
 *
 * Note the deliberate asymmetry: we are **strict about what we emit and liberal
 * about what we accept**. An incoming replay is parsed up to
 * `MAX_REPLAY_PARAM_CHARS`, far above the emit limit, so a link built by hand or
 * by a future build with a better encoder still plays if it arrived intact.
 */

import { dailySeed, formatSeed, isValidSeed, normalizeSeed } from '../core/seed'
import { TICK_HZ } from '../core/loop'
import type { Replay } from './replay'
import { decodeReplay, encodeReplay, ReplayError } from './replay'
import { checkReplayCompatibility, describeIncompatibility } from './simVersion'

// ---------------------------------------------------------------------------
// params
// ---------------------------------------------------------------------------

/**
 * URL parameter names.
 *
 * `seed` matches what `src/main.ts` has read since M0 — renaming it would break
 * every screenshot URL and bug report already written down. The replay parameter
 * is `r` because it is the one whose length is contested; four saved characters
 * are four more ticks of run that fit.
 */
export const RUN_PARAM = {
  seed: 'seed',
  replay: 'r',
  daily: 'daily',
  purist: 'purist',
} as const

/**
 * Total URL characters we are willing to emit. See the header for the derivation.
 */
export const URL_SAFE_CHARS = 2000

/**
 * Largest `r=` payload we will even attempt to decode.
 *
 * Generous on purpose (see the asymmetry note in the header) but bounded, because
 * the parameter is attacker-controlled and `decodeReplay` allocates from a length
 * field inside it. 64k of base64url is ~48KB of replay, which is roughly eleven
 * hours of worst-case churn — nothing legitimate comes close.
 */
export const MAX_REPLAY_PARAM_CHARS = 65_536

/**
 * How far back a seed is checked against the daily archive when labelling a replay.
 *
 * Bounded so the check stays cheap and so a seed that merely *collides* with some
 * daily from two years ago is not announced as that contract.
 */
export const DAILY_ARCHIVE_DAYS = 30

// ---------------------------------------------------------------------------
// dates
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` in UTC. The daily contract's identity, worldwide. */
export function utcDateKey(date: Date): string {
  const y = String(date.getUTCFullYear()).padStart(4, '0')
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Contracts only exist inside this window.
 *
 * `0000-01-01` is a perfectly valid `Date` and round-trips through `utcDateKey`
 * cleanly, so structural validation alone accepts it and the game cheerfully
 * serves the daily contract for the year zero. A range is the only thing that
 * catches that class of input; the bounds are deliberately loose — this rejects
 * nonsense, it is not a launch-date check that needs maintaining.
 */
const EARLIEST_CONTRACT_YEAR = 2020
const LATEST_CONTRACT_YEAR = 2100

/**
 * Parse a `YYYY-MM-DD` key back to UTC midnight, or null.
 *
 * Round-trips through `utcDateKey` to reject dates that parse but do not exist:
 * `2026-02-30` becomes 2026-03-02 rather than failing, and `2026-13-01` rolls
 * into the next year. A regex-only check accepts both and then produces a seed
 * for a day that never happened.
 */
export function parseUtcDateKey(key: string): Date | null {
  if (!DATE_KEY_PATTERN.test(key)) return null
  const date = new Date(`${key}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return null
  if (utcDateKey(date) !== key) return null
  const year = date.getUTCFullYear()
  if (year < EARLIEST_CONTRACT_YEAR || year > LATEST_CONTRACT_YEAR) return null
  return date
}

const MS_PER_DAY = 86_400_000

/** Seconds until the next UTC midnight, when the next contract opens. */
export function secondsUntilNextContract(now: Date): number {
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Math.max(0, Math.ceil((startOfDay + MS_PER_DAY - now.getTime()) / 1000))
}

// ---------------------------------------------------------------------------
// the daily contract
// ---------------------------------------------------------------------------

/**
 * THE SAVE SHAPE THIS MODULE WANTS. Add as `daily: DailyRecord | null` in v3.
 *
 * Exactly one entry, not a history. That is a deliberate limit:
 *
 *   - The question the UI asks is "have I flown *today's*?", and one dated record
 *     answers it. A record whose `date` is not today means not flown, so the
 *     structure invalidates itself with no cleanup pass and no clock trust.
 *   - It cannot grow without bound in `localStorage`, which an append-only list
 *     of every daily ever flown would.
 *   - A browsable history of runs is the personnel-files feature, and duplicating
 *     it here would mean two stores disagreeing about the same run.
 *
 * `outcome` mirrors the sim's own vocabulary plus `abandoned`, because a contract
 * quit from the pause menu has still been *used up* — otherwise the daily is
 * re-rollable by abandoning until the first wave looks survivable, which quietly
 * destroys the comparability the daily exists for.
 */
export interface DailyRecord {
  /** UTC date the contract was flown, `YYYY-MM-DD`. */
  readonly date: string
  /** Ticks survived. Authoritative over any wall-clock duration. */
  readonly ticks: number
  readonly waveIndex: number
  readonly scrap: number
  readonly outcome: 'lost' | 'extracted' | 'abandoned'
}

const OUTCOMES: readonly DailyRecord['outcome'][] = ['lost', 'extracted', 'abandoned']

/**
 * Validate an untrusted stored record.
 *
 * Exported for `save.ts` to use inside its v3 coercion: every other field in the
 * save is coerced rather than trusted, and a daily record read straight from JSON
 * would be the one place a hand-edited `localStorage` could inject a NaN tick
 * count into the HUD.
 */
export function coerceDailyRecord(raw: unknown): DailyRecord | null {
  if (typeof raw !== 'object' || raw === null) return null
  const value = raw as Partial<DailyRecord>
  if (typeof value.date !== 'string' || parseUtcDateKey(value.date) === null) return null
  if (typeof value.outcome !== 'string' || !OUTCOMES.includes(value.outcome)) return null
  const count = (input: unknown): number =>
    typeof input === 'number' && Number.isFinite(input) ? Math.max(0, Math.floor(input)) : 0
  return {
    date: value.date,
    ticks: count(value.ticks),
    waveIndex: count(value.waveIndex),
    scrap: count(value.scrap),
    outcome: value.outcome,
  }
}

export interface DailyContract {
  /** UTC date this contract belongs to, `YYYY-MM-DD`. */
  readonly date: string
  readonly seed: string
  /** False for an archive contract from a past date. */
  readonly isToday: boolean
  /** True only when the stored record is for this exact date. */
  readonly flown: boolean
  /** The stored result, when it belongs to this date. */
  readonly result: DailyRecord | null
  /** Seconds until the next contract opens. 0 for an archive date. */
  readonly secondsUntilNext: number
}

/**
 * Today's contract (or a named past one), against what the save remembers.
 *
 * Pure: the clock and the stored record both arrive as arguments, which is what
 * makes the UTC-midnight boundary testable at all.
 */
export function dailyContract(
  now: Date,
  record: DailyRecord | null,
  date: string = utcDateKey(now),
): DailyContract {
  const today = utcDateKey(now)
  const parsed = parseUtcDateKey(date)
  // An unparseable date can only reach here from a caller that bypassed
  // resolveRunMode; fall back to today rather than producing a seedless contract.
  const key = parsed === null ? today : date
  const isToday = key === today
  const flown = record !== null && record.date === key
  return {
    date: key,
    seed: dailySeed(parsed ?? now),
    isToday,
    flown,
    result: flown ? record : null,
    secondsUntilNext: isToday ? secondsUntilNextContract(now) : 0,
  }
}

/**
 * The UTC date whose daily contract uses `seed`, or null.
 *
 * Used to label a replay honestly: a replay of the daily should say so, and the
 * only evidence available is the seed itself, since the replay format carries no
 * mode flag. Searching a bounded window rather than storing the answer means an
 * old link keeps labelling correctly without a migration.
 */
export function dailyDateForSeed(
  seed: string,
  now: Date,
  days: number = DAILY_ARCHIVE_DAYS,
): string | null {
  const normalized = normalizeSeed(seed)
  for (let back = 0; back <= days; back++) {
    const day = new Date(now.getTime() - back * MS_PER_DAY)
    if (dailySeed(day) === normalized) return utcDateKey(day)
  }
  return null
}

// ---------------------------------------------------------------------------
// run modes
// ---------------------------------------------------------------------------

interface RunModeBase {
  /** Normalised, always `SEED_LENGTH` characters. */
  readonly seed: string
  /**
   * Certifications disabled, base item pool only (docs/DESIGN.md).
   *
   * Lives on every mode rather than only on `daily` because it is orthogonal to
   * all four kinds: a shared seed can be flown purist, and a replay *must* be
   * played back with whatever pool it was recorded against or it diverges. That
   * is also why the share link carries it — the replay format does not.
   *
   * NOT the same thing as `src/meta/purist.ts`'s verdict, and the difference
   * matters. This is an **input**: which pool to build the run from, decided before
   * the run exists, so it necessarily has to be trusted. That module produces an
   * **output**: which pool a finished run demonstrably drew from, derived from a
   * recorded fingerprint and therefore checkable. Collapsing the two would mean
   * either a verdict that has to be known before the run starts, or a run
   * configuration derived from a run that has not happened yet.
   *
   * FOLLOW-UP for whoever owns `replay.ts`: the format carries `simVersion` but no
   * pool fingerprint, so this flag arrives on a replay link as a claim rather than
   * as evidence. A wrong claim diverges the playback silently — the same failure
   * class `simVersion` exists to prevent. A pool fingerprint in the header would
   * make it detectable.
   */
  readonly purist: boolean
}

/** A fresh random seed. What pressing start on the title screen gives you. */
export interface FreeRun extends RunModeBase {
  readonly kind: 'free'
}

/** A seed that came from somewhere else: a link, a screenshot, or typed in. */
export interface SharedRun extends RunModeBase {
  readonly kind: 'shared'
}

export interface DailyRun extends RunModeBase {
  readonly kind: 'daily'
  readonly date: string
  readonly isToday: boolean
  /** Always false for an archive date — the save only remembers the latest. */
  readonly alreadyFlown: boolean
}

export interface ReplayRun extends RunModeBase {
  readonly kind: 'replay'
  readonly replay: Replay
  /** The UTC date whose contract this replay flew, when it was one. */
  readonly ofDaily: string | null
}

export type RunMode = FreeRun | SharedRun | DailyRun | ReplayRun
export type RunModeKind = RunMode['kind']

/**
 * Everything a URL asked for that was not honoured.
 *
 * Enumerated rather than free text so tests can pin behaviour and the UI can
 * decide how loudly to say it. An `-overridden-by-` reason is not an error: it is
 * a contradictory link resolved by the stated precedence, and the player is told
 * which way it went so the run label is never a surprise.
 */
export type RunParamRejection =
  | 'seed-invalid'
  | 'replay-oversize'
  | 'replay-malformed'
  | 'replay-incompatible'
  | 'daily-date-invalid'
  | 'daily-date-future'
  | 'seed-overridden-by-daily'
  | 'seed-overridden-by-replay'
  | 'daily-overridden-by-replay'

/**
 * Rejection significance, most significant first.
 *
 * This is the *published* order of `ResolvedRun.rejections`, and it mirrors the mode
 * precedence — replay, then daily, then seed — because the thing a player needs told
 * first is what decided the run they are about to fly, not what happened to be parsed
 * first.
 *
 * WHY IT IS A TABLE rather than an emergent property of the code below: parse order
 * is not this order and cannot be made to be. The seed is validated FIRST so that a
 * rejected replay can fall back to it, so a link with both a damaged replay and a
 * junk seed collected `seed-invalid` ahead of `replay-malformed` and then took its one
 * player-facing sentence off the wrong end — telling the pilot about the seed while
 * the headline fact was that the shared replay was cut in half. Ordering here, once,
 * where the order is also written down, is the only version of this that stays true.
 *
 * A `Record` over the union rather than a list, so a rejection reason added later
 * cannot be left unranked: it is a typecheck failure, not a reason that silently
 * sorts to the end.
 */
const REJECTION_RANK: Readonly<Record<RunParamRejection, number>> = {
  // The replay tier. The refusals and the overrides are mutually exclusive — a replay
  // is either honoured or it is not — so their relative order is unobservable, but the
  // ranking has to be total for the sort to be.
  'replay-oversize': 0,
  'replay-malformed': 1,
  'replay-incompatible': 2,
  'daily-overridden-by-replay': 3,
  'seed-overridden-by-replay': 4,
  // The daily tier.
  'daily-date-invalid': 5,
  'daily-date-future': 6,
  'seed-overridden-by-daily': 7,
  // The seed tier: least significant, because a bad seed costs the player the least —
  // it is the only one of the three that cannot change which run gets flown.
  'seed-invalid': 8,
}

/** The published order of `ResolvedRun.rejections`. Exported so a test can pin it. */
export const REJECTION_PRECEDENCE: readonly RunParamRejection[] = (
  Object.keys(REJECTION_RANK) as RunParamRejection[]
).sort((a, b) => REJECTION_RANK[a] - REJECTION_RANK[b])

export interface ResolvedRun {
  readonly mode: RunMode
  /** In precedence order, most significant first. Empty when the URL was honoured. */
  readonly rejections: readonly RunParamRejection[]
  /** One sentence for the player, from the most significant rejection. */
  readonly notice: string | null
}

export interface ResolveOptions {
  readonly params: URLSearchParams
  readonly now: Date
  /** What the save remembers about the daily. Never read from storage here. */
  readonly dailyRecord: DailyRecord | null
  /**
   * Seed for a free run, injected.
   *
   * `generateSeed()` is unseeded by design, so taking it as an argument is what
   * keeps this function pure and its tests deterministic.
   */
  readonly randomSeed: () => string
}

/**
 * PRECEDENCE, pinned: replay > daily > shared seed > free.
 *
 * The rule is "most specific intent wins", and each step is defensible on its own:
 *
 *   - A replay beats everything because it is the only artifact that fully
 *     determines the run — seed *and* inputs. Nothing else in the URL can add
 *     information to it, so honouring a `seed=` alongside it could only
 *     contradict it.
 *   - The daily beats an explicit seed because the daily's entire value is that
 *     the seed is not negotiable. Honouring `?daily=1&seed=K7F2...` would produce
 *     a run the HUD labels DAILY CONTRACT that is not the daily contract, which is
 *     precisely the class of quiet lie UI.md exists to prevent.
 *   - A seed beats a random one, obviously.
 *
 * Resolution is TOTAL: every combination of parameters, including malformed and
 * hostile ones, yields exactly one mode. Nothing here throws.
 */
export function resolveRunMode(options: ResolveOptions): ResolvedRun {
  const { params, now, dailyRecord, randomSeed } = options
  const collected: { reason: RunParamRejection; message: string }[] = []

  const note = (reason: RunParamRejection, message: string): void => {
    collected.push({ reason, message })
  }

  /**
   * Publish, sorting parse order into `REJECTION_PRECEDENCE` order.
   *
   * The sentence comes off the head of the sorted list rather than the first `note()`
   * call: one notice, and it is the one about the thing that decided the run. A stack
   * of notices is a wall of text nobody reads.
   */
  const resolved = (mode: RunMode): ResolvedRun => {
    const ordered = [...collected].sort(
      (a, b) => REJECTION_RANK[a.reason] - REJECTION_RANK[b.reason],
    )
    return {
      mode,
      rejections: ordered.map((entry) => entry.reason),
      notice: ordered[0]?.message ?? null,
    }
  }

  const purist = params.get(RUN_PARAM.purist) === '1'

  // --- seed, validated first so later branches can fall back to it ------------
  const rawSeed = params.get(RUN_PARAM.seed)
  let sharedSeed: string | null = null
  if (rawSeed !== null) {
    if (isValidSeed(rawSeed)) sharedSeed = normalizeSeed(rawSeed)
    else {
      note(
        'seed-invalid',
        `That link's seed is not a valid one, so this is a fresh run instead. ` +
          `A seed is 12 characters from the game's alphabet.`,
      )
    }
  }

  // --- daily -----------------------------------------------------------------
  const rawDaily = params.get(RUN_PARAM.daily)
  let dailyDate: string | null = null
  if (rawDaily !== null && rawDaily !== '' && rawDaily !== '0') {
    if (rawDaily === '1') dailyDate = utcDateKey(now)
    else {
      const parsed = parseUtcDateKey(rawDaily)
      if (parsed === null) {
        note(
          'daily-date-invalid',
          `That link asked for a contract dated "${clip(rawDaily)}", which is not a date. ` +
            `Showing today's contract instead.`,
        )
        dailyDate = utcDateKey(now)
      } else if (parsed.getTime() > Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) {
        note(
          'daily-date-future',
          `The contract for ${rawDaily} has not opened yet. Showing today's instead.`,
        )
        dailyDate = utcDateKey(now)
      } else {
        dailyDate = rawDaily
      }
    }
  }

  // --- replay ----------------------------------------------------------------
  const rawReplay = params.get(RUN_PARAM.replay)
  let replay: Replay | null = null
  if (rawReplay !== null && rawReplay !== '') {
    if (rawReplay.length > MAX_REPLAY_PARAM_CHARS) {
      // Bounded before decoding: the length field inside the payload drives an
      // allocation, and this parameter comes from whoever sent the link.
      note(
        'replay-oversize',
        `That replay link is ${rawReplay.length.toLocaleString('en-US')} characters, ` +
          `far longer than any real run. It has not been loaded.`,
      )
    } else {
      const decoded = tryDecodeReplay(rawReplay)
      if (decoded === null) {
        note(
          'replay-malformed',
          `That replay link is damaged — chat clients and link shorteners cut long ` +
            `links. Ask for it again, or fly the seed instead.`,
        )
      } else {
        const compatibility = checkReplayCompatibility(decoded.simVersion)
        const problem = describeIncompatibility(compatibility)
        if (problem !== null) {
          // Decoding cleanly is NOT permission to play. See src/meta/simVersion.ts:
          // a sim-version mismatch plays back a plausible run that is not the one
          // that was shared, which is worse than refusing. We keep the seed, so the
          // recipient can still fly the same starting conditions.
          note('replay-incompatible', `${problem} You can still fly its seed.`)
          if (sharedSeed === null && isValidSeed(decoded.seed)) {
            sharedSeed = normalizeSeed(decoded.seed)
          }
        } else {
          replay = decoded
        }
      }
    }
  }

  if (replay !== null) {
    if (dailyDate !== null) {
      note(
        'daily-overridden-by-replay',
        `That link carries a recorded run, so it is being played back rather than ` +
          `starting a contract.`,
      )
    }
    if (sharedSeed !== null && sharedSeed !== normalizeSeed(replay.seed)) {
      note(
        'seed-overridden-by-replay',
        `That link carries a recorded run, so its own seed is used rather than the ` +
          `one in the address.`,
      )
    }
    return resolved({
      kind: 'replay',
      seed: normalizeSeed(replay.seed),
      purist,
      replay,
      ofDaily: dailyDateForSeed(replay.seed, now),
    })
  }

  if (dailyDate !== null) {
    if (sharedSeed !== null) {
      note(
        'seed-overridden-by-daily',
        `That link asked for the daily contract, so its seed is ignored — the ` +
          `contract's seed is the same for everyone.`,
      )
    }
    const contract = dailyContract(now, dailyRecord, dailyDate)
    return resolved({
      kind: 'daily',
      seed: contract.seed,
      // The daily is always purist. If certifications could change its item
      // pool, two players flying "the same" contract would be flying different
      // runs, and the one thing the daily is for is comparability.
      purist: true,
      date: contract.date,
      isToday: contract.isToday,
      alreadyFlown: contract.flown,
    })
  }

  if (sharedSeed !== null) {
    return resolved({ kind: 'shared', seed: sharedSeed, purist })
  }

  return resolved({ kind: 'free', seed: normalizeSeed(randomSeed()), purist })
}

/** Trim an echoed parameter before it reaches a UI string. */
function clip(value: string, max = 24): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

/**
 * Decode, or null.
 *
 * Only `ReplayError` is swallowed. A `RangeError` from a hostile length field
 * would be a bug in the decoder's bounds, and hiding it here is how that bug
 * survives to production.
 */
function tryDecodeReplay(text: string): Replay | null {
  try {
    return decodeReplay(text)
  } catch (error) {
    if (error instanceof ReplayError) return null
    throw error
  }
}

// ---------------------------------------------------------------------------
// HUD labelling
// ---------------------------------------------------------------------------

export interface RunModeLabel {
  /** Short, all-caps, fits the instrument panel. Never a bare seed. */
  readonly label: string
  /** One line of context beneath it. */
  readonly detail: string
}

/**
 * What the HUD says about this run.
 *
 * The label answers "what am I flying", the detail answers "which one". Both are
 * kept inside the panel column's width, asserted in `tests/seedModes.test.ts`
 * against `MODE_TAG_MAX_W` — the failure mode for an over-long label is text
 * running into the playfield, which is UI.md rule 1.
 */
export function describeRunMode(mode: RunMode): RunModeLabel {
  switch (mode.kind) {
    case 'free':
      return { label: 'FREE FLIGHT', detail: formatSeed(mode.seed) }
    case 'shared':
      return {
        label: mode.purist ? 'SHARED · PURIST' : 'SHARED SEED',
        detail: formatSeed(mode.seed),
      }
    case 'daily':
      return {
        // "ARCHIVE" rather than "DAILY" for a past date, because a run that
        // cannot be compared with anyone flying today must not wear the same
        // badge as one that can.
        label: mode.isToday ? 'DAILY CONTRACT' : 'ARCHIVE CONTRACT',
        detail: mode.isToday && mode.alreadyFlown ? `${mode.date} · FLOWN` : mode.date,
      }
    case 'replay': {
      const seconds = Math.round(mode.replay.inputs.length / TICK_HZ)
      return {
        label: mode.ofDaily === null ? 'REPLAY' : 'CONTRACT REPLAY',
        detail: `${seconds} s · sim v${mode.replay.simVersion}`,
      }
    }
  }
}

/** The daily's own line, for the title screen and the seed-entry card. */
export function describeDaily(contract: DailyContract): RunModeLabel {
  if (!contract.isToday) {
    return { label: 'ARCHIVE CONTRACT', detail: contract.date }
  }
  if (!contract.flown) {
    const hours = Math.floor(contract.secondsUntilNext / 3600)
    const minutes = Math.floor((contract.secondsUntilNext % 3600) / 60)
    return { label: 'DAILY CONTRACT', detail: `open · ${hours} h ${minutes} m left` }
  }
  const result = contract.result
  const seconds = result === null ? 0 : Math.round(result.ticks / TICK_HZ)
  return { label: 'DAILY CONTRACT', detail: `flown · ${seconds} s` }
}

/**
 * The paragraph explaining what the contract is.
 *
 * Wrapped by the caller with `wrapText`; kept here so the copy sits next to the
 * behaviour it describes and is measured by the same test that measures the rest.
 */
export function dailyProse(contract: DailyContract): string {
  if (!contract.isToday) {
    return (
      `An archive contract from ${contract.date}. The seed is the one everyone flew ` +
      `that day, so a run is still comparable with theirs — but not with today's.`
    )
  }
  if (!contract.flown) {
    return (
      `One seed per day, the same for every pilot worldwide, computed from the UTC ` +
      `date with no server involved. Certifications are off so the comparison is fair.`
    )
  }
  return (
    `Today's contract has been flown. It can be flown again for practice, but the ` +
    `recorded attempt stands until the next contract opens.`
  )
}

// ---------------------------------------------------------------------------
// share links
// ---------------------------------------------------------------------------

/**
 * Build a URL with exactly the parameters given, in a fixed order.
 *
 * Existing query and hash are dropped rather than merged. A share link built from
 * the page you are on would otherwise carry `?autopilot=` and `?ff=32` from a
 * capture session, and the recipient would watch a bot fly at 32× speed.
 */
function buildLink(baseUrl: string, entries: readonly (readonly [string, string])[]): string {
  const url = new URL(baseUrl)
  url.search = ''
  url.hash = ''
  const search = new URLSearchParams()
  for (const [key, value] of entries) search.set(key, value)
  const query = search.toString()
  return query === '' ? url.toString() : `${url.toString()}?${query}`
}

/**
 * What a sortie should actually fly, given a pending URL mode and an optional typed
 * seed.
 *
 * A PURE FUNCTION, extracted out of `main.ts` because that is where this decision
 * went wrong and stayed wrong. `main.ts` has no unit test — it is DOM-bound app
 * wiring — so the whole of M4's headline feature lived in untestable code: the URL
 * resolved correctly, the title screen displayed the seed, and then
 * `beginSortie()`'s `seed = withSeed ?? generateSeed()` rolled a fresh one and
 * `launchSortie` overwrote the mode with `{ kind: 'free' }`. Every shared seed, daily
 * contract and replay was discarded on the first keypress.
 *
 * Precedence, and each clause is a real case:
 *
 *  1. `typed` wins outright — that is the seed-entry screen, the most explicit
 *     statement of intent there is, and it must override a link the player is
 *     ignoring. It produces a `shared` run: the seed came from outside, so purist
 *     accounting has to know that.
 *  2. Otherwise a `pending` URL mode is flown as itself, so a daily stays a daily.
 *  3. Otherwise a fresh free run.
 *
 * `nextPending` is always null: a URL mode is a single attempt. That is what makes
 * `save.daily` meaningful, and what stops the run after a death silently re-flying
 * yesterday's contract.
 */
export function claimSortieMode(
  pending: RunMode | null,
  typed: string | undefined,
  freshSeed: () => string,
): { readonly mode: RunMode; readonly nextPending: null } {
  if (typed !== undefined) {
    return { mode: { kind: 'shared', seed: normalizeSeed(typed), purist: false }, nextPending: null }
  }
  if (pending !== null) return { mode: pending, nextPending: null }
  return { mode: { kind: 'free', seed: freshSeed(), purist: false }, nextPending: null }
}

/** Short, always shareable, reproduces the starting conditions. */
export function buildSeedLink(baseUrl: string, seed: string, purist = false): string {
  const entries: [string, string][] = [[RUN_PARAM.seed, normalizeSeed(seed)]]
  if (purist) entries.push([RUN_PARAM.purist, '1'])
  return buildLink(baseUrl, entries)
}

/** A link to a contract. `date` null means "whatever today is when it is opened". */
export function buildDailyLink(baseUrl: string, date: string | null = null): string {
  return buildLink(baseUrl, [[RUN_PARAM.daily, date ?? '1']])
}

/**
 * The seed a link carries, or null.
 *
 * URLs only, deliberately. The first version also accepted a bare string and ran
 * it through `normalizeSeed`, which is far too permissive to be a *link* parser:
 * `normalizeSeed('not a seed at all')` strips the spaces, folds the letters, and
 * returns a perfectly valid seed. Guessing a run out of English prose is not
 * parsing. Bare text is the seed *field's* job — see `analysePaste` in
 * `src/ui/seedEntry.ts`, which tries this first and falls back to normalising.
 */
export function parseSeedLink(url: string): string | null {
  let query: string
  try {
    query = new URL(url).search
  } catch {
    return null
  }
  const raw = new URLSearchParams(query).get(RUN_PARAM.seed)
  if (raw === null || !isValidSeed(raw)) return null
  return normalizeSeed(raw)
}

export interface ReplayShare {
  /** The replay link, or null when it is too long to paste safely. */
  readonly url: string | null
  /** Always present. Starting conditions survive every length limit. */
  readonly seedUrl: string
  /** Length the replay URL has (or would have). Real, not estimated. */
  readonly chars: number
  /** The ceiling `chars` was compared against. */
  readonly limit: number
  readonly ticks: number
  /** What to tell the player. Non-null exactly when `url` is null. */
  readonly message: string | null
}

/**
 * Offer a replay link, or explain why there isn't one.
 *
 * The measurement is of the **finished URL**, not the payload: the base path
 * counts, and `/next-pilot/` on GitHub Pages is not free. Returning the seed link
 * unconditionally is the point — the answer to "this run is too long to share" is
 * never "nothing", it is "here are the same starting conditions".
 */
export function shareReplay(baseUrl: string, replay: Replay, purist = false): ReplayShare {
  const seedUrl = buildSeedLink(baseUrl, replay.seed, purist)
  const ticks = replay.inputs.length

  let encoded: string
  try {
    encoded = encodeReplay(replay)
  } catch (error) {
    // Encoding a recorder's own output cannot fail, so this is a corrupt Replay
    // rather than a length problem — say so plainly instead of blaming the URL.
    const reason = error instanceof ReplayError ? error.reason : 'unknown'
    return {
      url: null,
      seedUrl,
      chars: 0,
      limit: URL_SAFE_CHARS,
      ticks,
      message: `This run could not be encoded (${reason}), so only its seed can be shared.`,
    }
  }

  const entries: [string, string][] = [[RUN_PARAM.replay, encoded]]
  if (purist) entries.push([RUN_PARAM.purist, '1'])
  const url = buildLink(baseUrl, entries)

  if (url.length <= URL_SAFE_CHARS) {
    return { url, seedUrl, chars: url.length, limit: URL_SAFE_CHARS, ticks, message: null }
  }

  return {
    url: null,
    seedUrl,
    chars: url.length,
    limit: URL_SAFE_CHARS,
    ticks,
    // The numbers are in the message on purpose. "Too long to share" invites the
    // player to try anyway; "7,626 of 2,000 characters" does not.
    message:
      `This run needs ${url.length.toLocaleString('en-US')} characters and links are only ` +
      `safe to about ${URL_SAFE_CHARS.toLocaleString('en-US')} — a lot of dodging does not ` +
      `compress. Share the seed instead; it starts the same run.`,
  }
}

/**
 * How many payload characters a replay link has to spare at this base URL.
 *
 * Lets the share UI show a budget bar rather than only a verdict, and lets a test
 * assert the budget without rebuilding a URL.
 */
export function replayPayloadBudget(baseUrl: string, purist = false): number {
  // Measured against a single-character payload, so the separators, the parameter
  // name, and the base path are all counted exactly rather than assumed.
  const probe = buildLink(
    baseUrl,
    purist
      ? [
          [RUN_PARAM.replay, 'x'],
          [RUN_PARAM.purist, '1'],
        ]
      : [[RUN_PARAM.replay, 'x']],
  )
  return Math.max(0, URL_SAFE_CHARS - (probe.length - 1))
}
