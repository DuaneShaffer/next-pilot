/**
 * Run modes, the daily contract, share links, and seed entry.
 *
 * THE THINGS THAT MUST NOT BE ALLOWED TO REGRESS, in order:
 *
 * 1. **Mode resolution is total.** Every combination of parameters — including
 *    contradictory, malformed, and hostile ones — yields exactly one mode and
 *    never throws. A URL is the only sharing channel this game has, so an
 *    unhandled parameter combination is a blank page for the recipient.
 * 2. **A replay from another sim version is refused, not played.** See
 *    src/meta/simVersion.ts: a mismatch decodes perfectly and then plays back a
 *    different run. That failure is silent by nature, so it needs a test.
 * 3. **Link length is measured, not assumed.** The numbers here come from real
 *    `ReplayRecorder` output driven by real bot policies, because the whole point
 *    of the length policy is that estimates were wrong by a factor of five.
 * 4. **Every authored string fits its box**, using the same conservative
 *    monospace measurement as `tests/textFits.test.ts` for the same reason.
 */

import { describe, expect, it } from 'vitest'

import { NEUTRAL_INPUT, packInput, type InputSnapshot } from '../src/core/input'
import { SEED_LENGTH, dailySeed, formatSeed, isValidSeed, normalizeSeed } from '../src/core/seed'
import { INTERACTIONS } from '../src/content/interactions'
import { ITEMS } from '../src/content/items'
import { BOTS } from '../src/sim/bots'
import { World, type RunContent } from '../src/sim/world'
import {
  REPLAY_FORMAT_VERSION,
  ReplayRecorder,
  encodeReplay,
  type Replay,
} from '../src/meta/replay'
import { SIM_VERSION } from '../src/meta/simVersion'
import {
  DAILY_ARCHIVE_DAYS,
  MAX_REPLAY_PARAM_CHARS,
  RUN_PARAM,
  URL_SAFE_CHARS,
  buildDailyLink,
  buildSeedLink,
  claimSortieMode,
  coerceDailyRecord,
  dailyContract,
  dailyDateForSeed,
  dailyProse,
  describeDaily,
  describeRunMode,
  parseSeedLink,
  parseUtcDateKey,
  replayPayloadBudget,
  resolveRunMode,
  secondsUntilNextContract,
  shareReplay,
  utcDateKey,
  type DailyRecord,
  type ResolveOptions,
  type RunMode,
} from '../src/meta/seedModes'
import { wrapText, type Measure } from '../src/render/text'
import {
  EMPTY_SEED_ENTRY,
  FOOTER_SIZE,
  MODE_TAG_DETAIL_SIZE,
  MODE_TAG_LABEL_SIZE,
  MODE_TAG_MAX_W,
  PICKER_COLS,
  PICKER_ROWS,
  PROSE_SIZE,
  REPLAY_LINK_PROSE,
  SEED_ALPHABET,
  SEED_CONTENT_W,
  SEED_ENTRY_FOOTER,
  SEED_ENTRY_PROSE,
  SEED_FOLDS,
  SEED_FOOTER_Y,
  SEED_LINK_PROSE,
  SHARE_CONTENT_W,
  SHARE_FOOTER,
  SHARE_FOOTER_Y,
  describePasteRepair,
  drawSeedEntry,
  drawShareCard,
  moveShareSelection,
  seedEntryReduce,
  shortSeedLink,
  validateSeedDraft,
  type SeedEntryState,
} from '../src/ui/seedEntry'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const BASE = 'https://duaneshaffer.github.io/next-pilot/'
const SEED_A = 'K7F29XQM3RTV'
const SEED_B = 'A2B3C4D5E6F7'

/** A fixed instant, mid-day UTC, so nothing here depends on when it runs. */
const NOON = new Date('2026-07-25T12:00:00.000Z')

const CONTENT: RunContent = { items: ITEMS, interactions: INTERACTIONS }

function resolve(
  params: Record<string, string>,
  overrides: Partial<Omit<ResolveOptions, 'params'>> = {},
) {
  return resolveRunMode({
    params: new URLSearchParams(params),
    now: overrides.now ?? NOON,
    dailyRecord: overrides.dailyRecord ?? null,
    randomSeed: overrides.randomSeed ?? (() => SEED_B),
  })
}

/** A replay of held inputs — the case RLE was designed for. */
function heldReplay(ticks: number, seed = SEED_A): Replay {
  const recorder = new ReplayRecorder(seed)
  const held: InputSnapshot = { moveX: 1, moveY: 0, fire: true, special: false, focus: false }
  for (let i = 0; i < ticks; i++) recorder.record(held)
  return recorder.toReplay()
}

/** Run a real bot policy and return its recorded replay. */
function botReplay(policy: 'dodger' | 'aggressor', seed = SEED_A, maxTicks = 14_400): Replay {
  const bot = BOTS[policy].create(seed)
  const world = new World(seed, CONTENT)
  const recorder = new ReplayRecorder(seed)
  for (let tick = 0; tick < maxTicks && world.runState === 'active'; tick++) {
    const input = bot(world)
    recorder.record(input)
    world.tick(input)
  }
  return recorder.toReplay()
}

/** Re-stamp a replay with a different sim version, keeping the bytes valid. */
function withSimVersion(replay: Replay, simVersion: number): string {
  return encodeReplay({ ...replay, simVersion })
}

/**
 * The same deliberately-wide monospace estimate `tests/textFits.test.ts` uses.
 *
 * Erring wide is the point: a string that passes here has margin in the real
 * renderer, whereas under-measuring would pass exactly the strings that overflow.
 */
const EM_RATIO = 0.62
const measure: Measure = (text, size, _weight = 400, tracking = 0) =>
  text.length * size * EM_RATIO + Math.max(0, text.length - 1) * tracking

function fits(text: string, width: number, size: number, tracking = 0): boolean {
  return measure(text, size, 400, tracking) <= width
}

// ---------------------------------------------------------------------------
// mode resolution
// ---------------------------------------------------------------------------

describe('run mode resolution', () => {
  it('gives a free run on a random seed when the URL says nothing', () => {
    const { mode, rejections, notice } = resolve({})
    expect(mode.kind).toBe('free')
    expect(mode.seed).toBe(SEED_B)
    expect(mode.purist).toBe(false)
    expect(rejections).toEqual([])
    expect(notice).toBeNull()
  })

  it('gives a shared run for a valid seed, normalised', () => {
    // Lower case, dashes, and a look-alike O all mean the same run.
    const { mode } = resolve({ [RUN_PARAM.seed]: 'k7f2-9xqm-3rtv' })
    expect(mode.kind).toBe('shared')
    expect(mode.seed).toBe(SEED_A)
  })

  it('honours the purist flag on a shared seed', () => {
    const { mode } = resolve({ [RUN_PARAM.seed]: SEED_A, [RUN_PARAM.purist]: '1' })
    expect(mode.purist).toBe(true)
  })

  it('gives todays contract for daily=1, and forces purist', () => {
    const { mode } = resolve({ [RUN_PARAM.daily]: '1' })
    expect(mode.kind).toBe('daily')
    expect(mode.seed).toBe(dailySeed(NOON))
    // A contract whose item pool depends on the recipient's unlocks is not a
    // shared contract at all, so this is not configurable.
    expect(mode.purist).toBe(true)
    if (mode.kind !== 'daily') throw new Error('unreachable')
    expect(mode.date).toBe('2026-07-25')
    expect(mode.isToday).toBe(true)
    expect(mode.alreadyFlown).toBe(false)
  })

  it('reports the contract as already flown from the stored record', () => {
    const record: DailyRecord = {
      date: '2026-07-25',
      ticks: 6000,
      waveIndex: 12,
      scrap: 340,
      outcome: 'lost',
    }
    const { mode } = resolve({ [RUN_PARAM.daily]: '1' }, { dailyRecord: record })
    if (mode.kind !== 'daily') throw new Error('expected a daily run')
    expect(mode.alreadyFlown).toBe(true)
  })

  it('treats a record from another day as not flown', () => {
    const record: DailyRecord = {
      date: '2026-07-24',
      ticks: 6000,
      waveIndex: 12,
      scrap: 340,
      outcome: 'lost',
    }
    const { mode } = resolve({ [RUN_PARAM.daily]: '1' }, { dailyRecord: record })
    if (mode.kind !== 'daily') throw new Error('expected a daily run')
    // The structure invalidates itself: no cleanup pass, no clock trust.
    expect(mode.alreadyFlown).toBe(false)
  })

  it('serves a past contract as an archive rather than as today', () => {
    const { mode } = resolve({ [RUN_PARAM.daily]: '2026-07-01' })
    if (mode.kind !== 'daily') throw new Error('expected a daily run')
    expect(mode.date).toBe('2026-07-01')
    expect(mode.isToday).toBe(false)
    expect(mode.seed).toBe(dailySeed(new Date('2026-07-01T00:00:00Z')))
  })

  it('falls back to today for a future contract, and says so', () => {
    const { mode, rejections, notice } = resolve({ [RUN_PARAM.daily]: '2099-01-01' })
    if (mode.kind !== 'daily') throw new Error('expected a daily run')
    expect(mode.date).toBe('2026-07-25')
    expect(rejections).toContain('daily-date-future')
    expect(notice).toMatch(/has not opened yet/)
  })

  it('plays a replay when the URL carries one', () => {
    const replay = heldReplay(600)
    const { mode, rejections } = resolve({ [RUN_PARAM.replay]: encodeReplay(replay) })
    expect(mode.kind).toBe('replay')
    if (mode.kind !== 'replay') throw new Error('unreachable')
    expect(mode.seed).toBe(SEED_A)
    expect(mode.replay.inputs.length).toBe(600)
    expect(rejections).toEqual([])
  })

  it('labels a replay of the daily contract as one', () => {
    const seed = dailySeed(NOON)
    const { mode } = resolve({ [RUN_PARAM.replay]: encodeReplay(heldReplay(300, seed)) })
    if (mode.kind !== 'replay') throw new Error('expected a replay run')
    expect(mode.ofDaily).toBe('2026-07-25')
    expect(describeRunMode(mode).label).toBe('CONTRACT REPLAY')
  })
})

describe('precedence, pinned', () => {
  // The whole point of the union: contradictory URLs must resolve one way and
  // keep resolving that way. Precedence is replay > daily > seed > free.

  it('a replay beats a daily param', () => {
    const encoded = encodeReplay(heldReplay(120))
    const { mode, rejections, notice } = resolve({
      [RUN_PARAM.replay]: encoded,
      [RUN_PARAM.daily]: '1',
    })
    expect(mode.kind).toBe('replay')
    expect(rejections).toContain('daily-overridden-by-replay')
    expect(notice).not.toBeNull()
  })

  it('a replay beats an explicit seed, and says which seed won', () => {
    const encoded = encodeReplay(heldReplay(120, SEED_A))
    const { mode, rejections } = resolve({
      [RUN_PARAM.replay]: encoded,
      [RUN_PARAM.seed]: SEED_B,
    })
    expect(mode.kind).toBe('replay')
    expect(mode.seed).toBe(SEED_A)
    expect(rejections).toContain('seed-overridden-by-replay')
  })

  it('a replay whose seed matches the seed param reports no conflict', () => {
    const encoded = encodeReplay(heldReplay(120, SEED_A))
    const { rejections } = resolve({ [RUN_PARAM.replay]: encoded, [RUN_PARAM.seed]: SEED_A })
    // Agreeing parameters are not a contradiction, and warning about them would
    // train players to ignore the notice.
    expect(rejections).toEqual([])
  })

  it('a daily param beats an explicit seed', () => {
    const { mode, rejections, notice } = resolve({
      [RUN_PARAM.daily]: '1',
      [RUN_PARAM.seed]: SEED_A,
    })
    expect(mode.kind).toBe('daily')
    expect(mode.seed).toBe(dailySeed(NOON))
    expect(rejections).toContain('seed-overridden-by-daily')
    expect(notice).toMatch(/same for everyone/)
  })

  it('resolves all three at once to a replay, reporting both overrides', () => {
    const encoded = encodeReplay(heldReplay(120, SEED_A))
    const { mode, rejections } = resolve({
      [RUN_PARAM.replay]: encoded,
      [RUN_PARAM.daily]: '1',
      [RUN_PARAM.seed]: SEED_B,
      [RUN_PARAM.purist]: '1',
    })
    expect(mode.kind).toBe('replay')
    expect(mode.purist).toBe(true)
    expect(rejections).toEqual(['daily-overridden-by-replay', 'seed-overridden-by-replay'])
  })

  it('is total: every combination of the four params resolves to exactly one mode', () => {
    const encoded = encodeReplay(heldReplay(60))
    const values = {
      [RUN_PARAM.replay]: [null, '', encoded, 'not-a-replay'],
      [RUN_PARAM.daily]: [null, '', '0', '1', '2026-07-01', 'yesterday'],
      [RUN_PARAM.seed]: [null, '', SEED_A, 'nope'],
      [RUN_PARAM.purist]: [null, '0', '1'],
    } as const

    const kinds = new Set<RunMode['kind']>()
    let combinations = 0
    for (const replay of values[RUN_PARAM.replay]) {
      for (const daily of values[RUN_PARAM.daily]) {
        for (const seed of values[RUN_PARAM.seed]) {
          for (const purist of values[RUN_PARAM.purist]) {
            const params = new URLSearchParams()
            if (replay !== null) params.set(RUN_PARAM.replay, replay)
            if (daily !== null) params.set(RUN_PARAM.daily, daily)
            if (seed !== null) params.set(RUN_PARAM.seed, seed)
            if (purist !== null) params.set(RUN_PARAM.purist, purist)
            const resolved = resolveRunMode({
              params,
              now: NOON,
              dailyRecord: null,
              randomSeed: () => SEED_B,
            })
            combinations++
            kinds.add(resolved.mode.kind)
            // Every mode carries a usable seed, whatever the URL said.
            expect(isValidSeed(resolved.mode.seed)).toBe(true)
            expect(typeof resolved.mode.purist).toBe('boolean')
            // A notice exists exactly when something was not honoured.
            expect(resolved.notice === null).toBe(resolved.rejections.length === 0)
          }
        }
      }
    }
    expect(combinations).toBe(4 * 6 * 4 * 3)
    // All four kinds are reachable from parameters alone; if one stopped being
    // reachable, a feature would have quietly become dead code.
    expect([...kinds].sort()).toEqual(['daily', 'free', 'replay', 'shared'])
  })
})

describe('hostile and malformed params are rejected without throwing', () => {
  const HOSTILE: readonly (readonly [string, Record<string, string>])[] = [
    ['seed of the wrong alphabet', { [RUN_PARAM.seed]: '!!!!!!!!!!!!' }],
    ['seed too short', { [RUN_PARAM.seed]: 'K7F2' }],
    ['seed too long', { [RUN_PARAM.seed]: 'K7F29XQM3RTVK7F29XQM3RTV' }],
    ['seed of 100k characters', { [RUN_PARAM.seed]: 'K'.repeat(100_000) }],
    ['replay that is not base64url', { [RUN_PARAM.replay]: '@@@@@@@@' }],
    ['replay that is empty', { [RUN_PARAM.replay]: '' }],
    ['replay of one character', { [RUN_PARAM.replay]: 'A' }],
    ['replay with injected markup', { [RUN_PARAM.replay]: '<script>alert(1)</script>' }],
    ['replay over the parse bound', { [RUN_PARAM.replay]: 'A'.repeat(MAX_REPLAY_PARAM_CHARS + 1) }],
    ['daily as a script tag', { [RUN_PARAM.daily]: '<img onerror=x>' }],
    ['daily as a nonexistent date', { [RUN_PARAM.daily]: '2026-02-30' }],
    ['daily as month 13', { [RUN_PARAM.daily]: '2026-13-01' }],
    ['daily as year zero', { [RUN_PARAM.daily]: '0000-01-01' }],
    ['daily as a huge number', { [RUN_PARAM.daily]: '9'.repeat(5000) }],
    ['everything hostile at once', {
      [RUN_PARAM.replay]: '💥'.repeat(500),
      [RUN_PARAM.daily]: 'NaN',
      [RUN_PARAM.seed]: '  ',
      [RUN_PARAM.purist]: 'yes',
    }],
  ]

  for (const [name, params] of HOSTILE) {
    it(`survives: ${name}`, () => {
      const resolved = resolve(params)
      expect(isValidSeed(resolved.mode.seed)).toBe(true)
      // Nothing hostile may ever produce a replay to play back.
      if (resolved.mode.kind === 'replay') throw new Error('hostile input produced a replay')
    })
  }

  it('never echoes an unbounded parameter into a player-facing notice', () => {
    // A notice is drawn on a card. An echoed 5,000-character parameter would run
    // off it, which is the same class of bug tests/textFits.test.ts exists for.
    const { notice } = resolve({ [RUN_PARAM.daily]: 'x'.repeat(5000) })
    expect(notice).not.toBeNull()
    expect((notice ?? '').length).toBeLessThan(200)
  })

  it('truncates the oversize replay param out of the message', () => {
    const { rejections, notice } = resolve({
      [RUN_PARAM.replay]: 'A'.repeat(MAX_REPLAY_PARAM_CHARS + 10),
    })
    expect(rejections).toEqual(['replay-oversize'])
    expect((notice ?? '').length).toBeLessThan(200)
  })

  it('falls back to a seed param when the replay is damaged', () => {
    // The realistic case: a chat client cut the link. The starting conditions are
    // still recoverable, so offer them rather than nothing.
    const encoded = encodeReplay(heldReplay(4000))
    const { mode, rejections } = resolve({
      [RUN_PARAM.replay]: encoded.slice(0, encoded.length - 40),
      [RUN_PARAM.seed]: SEED_B,
    })
    expect(rejections).toEqual(['replay-malformed'])
    expect(mode.kind).toBe('shared')
    expect(mode.seed).toBe(SEED_B)
  })
})

describe('a replay from another sim version is refused, not played', () => {
  // THE reason src/meta/simVersion.ts exists: a mismatch decodes perfectly and
  // then plays back a different run, with no error anywhere.

  it('refuses an older recording and keeps its seed', () => {
    const older = withSimVersion(heldReplay(900), SIM_VERSION - 1)
    const { mode, rejections, notice } = resolve({ [RUN_PARAM.replay]: older })
    expect(rejections).toEqual(['replay-incompatible'])
    expect(mode.kind).toBe('shared')
    expect(mode.seed).toBe(SEED_A)
    expect(notice).toMatch(/earlier version of the game/)
    expect(notice).toMatch(/still fly its seed/)
  })

  it('refuses a newer recording', () => {
    const newer = withSimVersion(heldReplay(900), SIM_VERSION + 1)
    const { mode, rejections, notice } = resolve({ [RUN_PARAM.replay]: newer })
    expect(rejections).toEqual(['replay-incompatible'])
    expect(mode.kind).toBe('shared')
    expect(notice).toMatch(/newer version of the game/)
  })

  it('accepts a recording from this exact version', () => {
    const { mode, rejections } = resolve({
      [RUN_PARAM.replay]: withSimVersion(heldReplay(900), SIM_VERSION),
    })
    expect(rejections).toEqual([])
    expect(mode.kind).toBe('replay')
  })

  it('prefers the explicit seed over the refused replay′s seed', () => {
    const older = withSimVersion(heldReplay(900, SEED_A), SIM_VERSION - 1)
    const { mode } = resolve({ [RUN_PARAM.replay]: older, [RUN_PARAM.seed]: SEED_B })
    expect(mode.kind).toBe('shared')
    expect(mode.seed).toBe(SEED_B)
  })
})

// ---------------------------------------------------------------------------
// the daily contract
// ---------------------------------------------------------------------------

describe('daily seed stability across UTC midnight', () => {
  it('is identical for every instant within one UTC day', () => {
    const instants = [
      '2026-07-25T00:00:00.000Z',
      '2026-07-25T00:00:00.001Z',
      '2026-07-25T11:59:59.999Z',
      '2026-07-25T12:00:00.000Z',
      '2026-07-25T23:59:59.999Z',
    ].map((iso) => new Date(iso))
    const seeds = new Set(instants.map((date) => dailyContract(date, null).seed))
    expect(seeds.size).toBe(1)
    const keys = new Set(instants.map(utcDateKey))
    expect([...keys]).toEqual(['2026-07-25'])
  })

  it('changes at the midnight boundary and not one millisecond earlier', () => {
    const lastMs = new Date('2026-07-25T23:59:59.999Z')
    const firstMs = new Date('2026-07-26T00:00:00.000Z')
    expect(dailyContract(lastMs, null).date).toBe('2026-07-25')
    expect(dailyContract(firstMs, null).date).toBe('2026-07-26')
    expect(dailyContract(lastMs, null).seed).not.toBe(dailyContract(firstMs, null).seed)
  })

  it('does not depend on the machine local timezone', () => {
    // Two instants that fall on different *local* dates in most of the world but
    // the same UTC date. A local-date implementation would split these.
    const a = new Date('2026-07-25T00:30:00.000Z')
    const b = new Date('2026-07-25T23:30:00.000Z')
    expect(dailyContract(a, null).seed).toBe(dailyContract(b, null).seed)
  })

  it('counts down to the next contract, hitting exactly one day at midnight', () => {
    expect(secondsUntilNextContract(new Date('2026-07-25T00:00:00.000Z'))).toBe(86_400)
    expect(secondsUntilNextContract(new Date('2026-07-25T23:59:59.000Z'))).toBe(1)
    expect(secondsUntilNextContract(new Date('2026-07-25T12:00:00.000Z'))).toBe(43_200)
  })

  it('produces a different seed for every day of a month', () => {
    const seeds = new Set<string>()
    for (let day = 1; day <= 31; day++) {
      const key = `2026-07-${String(day).padStart(2, '0')}`
      const parsed = parseUtcDateKey(key)
      expect(parsed).not.toBeNull()
      seeds.add(dailyContract(parsed as Date, null).seed)
    }
    expect(seeds.size).toBe(31)
  })

  it('recognises a seed as the contract for its own date, within the archive window', () => {
    const now = NOON
    expect(dailyDateForSeed(dailySeed(now), now)).toBe('2026-07-25')
    const tenDaysAgo = new Date(now.getTime() - 10 * 86_400_000)
    expect(dailyDateForSeed(dailySeed(tenDaysAgo), now)).toBe(utcDateKey(tenDaysAgo))
    // Outside the window it is just a seed, which is the honest answer.
    const ancient = new Date(now.getTime() - (DAILY_ARCHIVE_DAYS + 5) * 86_400_000)
    expect(dailyDateForSeed(dailySeed(ancient), now)).toBeNull()
    expect(dailyDateForSeed(SEED_A, now)).toBeNull()
  })

  it('rejects impossible date keys', () => {
    for (const key of ['2026-02-30', '2026-13-01', '0000-01-01', '2026-7-5', '', 'today']) {
      expect(parseUtcDateKey(key), key).toBeNull()
    }
    expect(parseUtcDateKey('2024-02-29')?.toISOString()).toBe('2024-02-29T00:00:00.000Z')
  })
})

describe('the save shape', () => {
  it('coerces a well-formed record', () => {
    const record = coerceDailyRecord({
      date: '2026-07-25',
      ticks: 6000,
      waveIndex: 12,
      scrap: 340,
      outcome: 'extracted',
    })
    expect(record).toEqual({
      date: '2026-07-25',
      ticks: 6000,
      waveIndex: 12,
      scrap: 340,
      outcome: 'extracted',
    })
  })

  it('rejects anything a hand-edited localStorage could inject', () => {
    for (const raw of [
      null,
      undefined,
      42,
      'daily',
      {},
      { date: 'nope', outcome: 'lost' },
      { date: '2026-07-25', outcome: 'exploded' },
      { date: '2026-13-01', outcome: 'lost' },
    ]) {
      expect(coerceDailyRecord(raw)).toBeNull()
    }
  })

  it('repairs non-finite and negative counters rather than passing them to the HUD', () => {
    const record = coerceDailyRecord({
      date: '2026-07-25',
      ticks: Number.NaN,
      waveIndex: -4,
      scrap: 12.9,
      outcome: 'abandoned',
    })
    expect(record).toEqual({
      date: '2026-07-25',
      ticks: 0,
      waveIndex: 0,
      scrap: 12,
      outcome: 'abandoned',
    })
  })
})

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

describe('seed links round-trip', () => {
  it('builds and parses back to the same seed', () => {
    const url = buildSeedLink(BASE, SEED_A)
    expect(url).toBe(`${BASE}?seed=${SEED_A}`)
    expect(parseSeedLink(url)).toBe(SEED_A)
  })

  it('round-trips through resolution, not just through the parser', () => {
    const url = buildSeedLink(BASE, SEED_A, true)
    const { mode } = resolve(Object.fromEntries(new URL(url).searchParams))
    expect(mode.kind).toBe('shared')
    expect(mode.seed).toBe(SEED_A)
    expect(mode.purist).toBe(true)
  })

  it('normalises a sloppy seed on the way in', () => {
    // 'o' folds to Q and 'l' folds to J, so this is a different string naming the
    // same run — which is the entire reason the fold table exists.
    const url = buildSeedLink(BASE, 'k7f2-9xqm-3rtv')
    expect(parseSeedLink(url)).toBe(SEED_A)
  })

  it('drops harness parameters rather than sharing them', () => {
    // A link built while a capture was running must not hand the recipient a bot
    // flying at 32x.
    const url = buildSeedLink(`${BASE}?autopilot=aggressor&ff=32#frag`, SEED_A)
    expect(url).toBe(`${BASE}?seed=${SEED_A}`)
  })

  it('is comfortably short', () => {
    expect(buildSeedLink(BASE, SEED_A).length).toBeLessThan(120)
  })

  it('parses links only, and never guesses a seed out of prose', () => {
    // normalizeSeed is deliberately permissive so paste-and-fix works, which makes
    // it far too permissive to be a link parser: it turns "not a seed at all" into
    // a valid seed by stripping the spaces. Bare text is the seed field's job.
    expect(parseSeedLink('not a seed at all')).toBeNull()
    expect(parseSeedLink('K7F2-9XQM-3RTV')).toBeNull()
    expect(parseSeedLink(`${BASE}?seed=zzz`)).toBeNull()
    expect(parseSeedLink(`${BASE}?daily=1`)).toBeNull()
    expect(parseSeedLink('')).toBeNull()
  })

  it('builds a daily link for today or for a named date', () => {
    expect(buildDailyLink(BASE)).toBe(`${BASE}?daily=1`)
    expect(buildDailyLink(BASE, '2026-07-01')).toBe(`${BASE}?daily=2026-07-01`)
    const { mode } = resolve(Object.fromEntries(new URL(buildDailyLink(BASE)).searchParams))
    expect(mode.kind).toBe('daily')
  })
})

describe('replay links round-trip', () => {
  it('carries the input log back byte for byte', () => {
    const original = heldReplay(1200)
    const share = shareReplay(BASE, original)
    expect(share.url).not.toBeNull()
    const { mode } = resolve(Object.fromEntries(new URL(share.url as string).searchParams))
    if (mode.kind !== 'replay') throw new Error('expected a replay run')
    expect(mode.replay.seed).toBe(original.seed)
    expect(mode.replay.simVersion).toBe(SIM_VERSION)
    expect([...mode.replay.inputs]).toEqual([...original.inputs])
  })

  it('carries the purist flag, which the replay format cannot', () => {
    // Purism changes the item pool, so it changes the sim. A replay link that
    // dropped it would play back a divergent run and look fine doing it.
    const share = shareReplay(BASE, heldReplay(600), true)
    const { mode } = resolve(Object.fromEntries(new URL(share.url as string).searchParams))
    expect(mode.kind).toBe('replay')
    expect(mode.purist).toBe(true)
  })

  it('always offers a seed link alongside', () => {
    const share = shareReplay(BASE, heldReplay(600))
    expect(parseSeedLink(share.seedUrl)).toBe(SEED_A)
  })
})

describe('replay link length policy, from real encoded runs', () => {
  // MEASURED, not estimated. RLE only pays when inputs are held, and the spread
  // between policies is a factor of five — which is exactly why a threshold and a
  // refusal path exist instead of an unconditional `?r=` builder.

  it('shares a held-input run', () => {
    // Three minutes of one held input is the case RLE was designed for.
    const share = shareReplay(BASE, heldReplay(10_800))
    expect(share.url).not.toBeNull()
    expect(share.message).toBeNull()
    expect(share.chars).toBeLessThanOrEqual(URL_SAFE_CHARS)
    // A single run is a handful of bytes; the base URL dominates.
    expect(share.chars).toBeLessThan(120)
  })

  it('shares a real aggressor run — the policy that holds its inputs', () => {
    const replay = botReplay('aggressor')
    const share = shareReplay(BASE, replay)
    expect(share.ticks).toBeGreaterThan(3600)
    expect(share.url, `aggressor run was ${share.chars} chars`).not.toBeNull()
    expect(share.chars).toBeLessThanOrEqual(URL_SAFE_CHARS)
  })

  it('refuses a real dodger run — the policy that churns them', () => {
    // The M1 finding, re-measured: dodger re-picks its dodge direction most ticks,
    // so a SHORTER run encodes several times larger. ~0.82 chars/tick against
    // aggressor's ~0.14.
    const replay = botReplay('dodger')
    const share = shareReplay(BASE, replay)
    expect(share.url).toBeNull()
    expect(share.chars).toBeGreaterThan(URL_SAFE_CHARS)
    // The refusal has to carry the numbers, or it reads as an arbitrary "no".
    expect(share.message).toMatch(/characters/)
    expect(share.message).toContain(share.chars.toLocaleString('en-US'))
    // And it must still hand back something usable.
    expect(parseSeedLink(share.seedUrl)).toBe(SEED_A)
  })

  it('a dodger run is several times larger than a longer aggressor run', () => {
    const dodger = shareReplay(BASE, botReplay('dodger'))
    const aggressor = shareReplay(BASE, botReplay('aggressor'))
    expect(dodger.ticks).toBeLessThan(aggressor.ticks)
    expect(dodger.chars).toBeGreaterThan(aggressor.chars * 3)
  })

  it('refuses the synthetic worst case: a different input every tick', () => {
    // ~2.67 encoded chars per tick, because every tick is its own RLE run. Thirty
    // seconds of this already exceeds the limit.
    const recorder = new ReplayRecorder(SEED_A)
    const a: InputSnapshot = { moveX: 1, moveY: 0, fire: true, special: false, focus: false }
    const b: InputSnapshot = { moveX: -1, moveY: 0, fire: false, special: false, focus: false }
    expect(packInput(a)).not.toBe(packInput(b))
    for (let tick = 0; tick < 1800; tick++) recorder.record(tick % 2 === 0 ? a : b)
    const share = shareReplay(BASE, recorder.toReplay())
    expect(share.url).toBeNull()
    expect(share.chars).toBeGreaterThan(4000)
  })

  it('never emits a URL over the limit, whatever the length', () => {
    // The invariant the whole policy reduces to: a link that exists is pasteable.
    for (const ticks of [1, 60, 600, 6000]) {
      const recorder = new ReplayRecorder(SEED_A)
      for (let tick = 0; tick < ticks; tick++) {
        recorder.record(tick % 3 === 0 ? NEUTRAL_INPUT : { ...NEUTRAL_INPUT, fire: true })
      }
      const share = shareReplay(BASE, recorder.toReplay())
      if (share.url !== null) expect(share.url.length).toBeLessThanOrEqual(URL_SAFE_CHARS)
      else expect(share.chars).toBeGreaterThan(URL_SAFE_CHARS)
    }
  })

  it('reports a payload budget that matches what it will actually accept', () => {
    const budget = replayPayloadBudget(BASE)
    expect(budget).toBeGreaterThan(1800)
    expect(budget).toBeLessThan(URL_SAFE_CHARS)
    // A longer deploy path eats the budget; the measurement is of the finished URL.
    expect(replayPayloadBudget('https://example.com/a/very/long/deploy/path/here/')).toBeLessThan(
      budget,
    )
  })

  it('accepts links longer than it emits — strict out, liberal in', () => {
    // A link built by a future build with a better encoder must still play if it
    // arrived intact, so the accept bound is far above the emit threshold.
    const replay = botReplay('dodger')
    const encoded = encodeReplay(replay)
    expect(encoded.length).toBeGreaterThan(URL_SAFE_CHARS)
    expect(encoded.length).toBeLessThan(MAX_REPLAY_PARAM_CHARS)
    const { mode, rejections } = resolve({ [RUN_PARAM.replay]: encoded })
    expect(rejections).toEqual([])
    expect(mode.kind).toBe('replay')
  })

  it('explains an unencodable replay instead of throwing', () => {
    const broken: Replay = {
      version: REPLAY_FORMAT_VERSION,
      simVersion: SIM_VERSION,
      hullId: '',
      // A space is not printable-ASCII by the encoder's rule, so this cannot encode.
      seed: 'not a seed ',
      inputs: new Uint8Array([0b0000101]),
    }
    const share = shareReplay(BASE, broken)
    expect(share.url).toBeNull()
    expect(share.message).toMatch(/could not be encoded/)
  })
})

// ---------------------------------------------------------------------------
// seed entry
// ---------------------------------------------------------------------------

describe('the derived seed alphabet', () => {
  it('matches the 30 characters core/seed.ts documents', () => {
    expect(SEED_ALPHABET.join('')).toBe('23456789ABCDEFGHJKMNPQRSTVWXYZ')
  })

  it('excludes exactly the ambiguous characters', () => {
    for (const char of 'ILOU01') expect(SEED_ALPHABET).not.toContain(char)
  })

  it('every character in it produces a valid seed', () => {
    for (const char of SEED_ALPHABET) {
      expect(isValidSeed(char.repeat(SEED_LENGTH)), char).toBe(true)
      expect(normalizeSeed(char.repeat(SEED_LENGTH))).toBe(char.repeat(SEED_LENGTH))
    }
  })

  it('divides evenly into the picker grid, so no cell is empty', () => {
    // If the alphabet ever changes size this fails loudly, rather than shipping a
    // cursor that can land on nothing.
    expect(SEED_ALPHABET.length % PICKER_COLS).toBe(0)
    expect(PICKER_ROWS * PICKER_COLS).toBe(SEED_ALPHABET.length)
  })

  it('derives the fold table from normalizeSeed', () => {
    const folds = new Map(SEED_FOLDS.map((f) => [f.from, f.to]))
    expect(folds.get('O')).toBe('Q')
    expect(folds.get('0')).toBe('Q')
    expect(folds.get('I')).toBe('J')
    expect(folds.get('L')).toBe('J')
    expect(folds.get('1')).toBe('J')
    expect(folds.get('U')).toBe('V')
    for (const char of SEED_ALPHABET) expect(folds.has(char)).toBe(false)
  })
})

describe('seed entry', () => {
  const type = (state: SeedEntryState, chars: string): SeedEntryState => {
    let next = state
    for (const char of chars) {
      const index = SEED_ALPHABET.indexOf(char)
      expect(index, `${char} is not in the alphabet`).toBeGreaterThanOrEqual(0)
      next = seedEntryReduce({ ...next, pick: index }, { kind: 'commit' })
    }
    return next
  }

  it('starts empty and says what to do', () => {
    const validation = validateSeedDraft(EMPTY_SEED_ENTRY)
    expect(validation.status).toBe('empty')
    expect(validation.seed).toBeNull()
    expect(validation.remaining).toBe(SEED_LENGTH)
    expect(validation.message).toMatch(/Paste a seed/)
  })

  it('reports partial input as unfinished, not as an error', () => {
    const state = type(EMPTY_SEED_ENTRY, 'K7F2')
    const validation = validateSeedDraft(state)
    expect(state.draft).toBe('K7F2')
    expect(validation.status).toBe('partial')
    expect(validation.remaining).toBe(SEED_LENGTH - 4)
    expect(validation.message).toBe('8 more characters to go.')
    // Calling an unfinished seed invalid would be a lie the player has to decode.
    expect(validation.message).not.toMatch(/invalid|error/i)
  })

  it('uses the singular with one character left', () => {
    expect(validateSeedDraft(type(EMPTY_SEED_ENTRY, 'K7F29XQM3RT')).message).toBe(
      '1 more character to go.',
    )
  })

  it('accepts a full valid seed', () => {
    const state = type(EMPTY_SEED_ENTRY, SEED_A)
    const validation = validateSeedDraft(state)
    expect(validation.status).toBe('complete')
    expect(validation.seed).toBe(SEED_A)
    expect(validation.remaining).toBe(0)
    // And that seed must survive the round trip it exists for.
    expect(parseSeedLink(buildSeedLink(BASE, validation.seed as string))).toBe(SEED_A)
  })

  it('refuses to overflow the field', () => {
    const full = type(EMPTY_SEED_ENTRY, SEED_A)
    const again = seedEntryReduce({ ...full, pick: 0 }, { kind: 'commit' })
    expect(again.draft).toBe(SEED_A)
    expect(again.draft.length).toBe(SEED_LENGTH)
  })

  it('backspaces and clears', () => {
    const state = type(EMPTY_SEED_ENTRY, 'K7F2')
    expect(seedEntryReduce(state, { kind: 'erase' }).draft).toBe('K7F')
    expect(seedEntryReduce(EMPTY_SEED_ENTRY, { kind: 'erase' }).draft).toBe('')
    expect(seedEntryReduce(state, { kind: 'clear' }).draft).toBe('')
    // Clearing keeps the picker where it was, so the next character is one press.
    expect(seedEntryReduce({ ...state, pick: 7 }, { kind: 'clear' }).pick).toBe(7)
  })

  it('wraps the picker in every direction, and always lands on a character', () => {
    let state = EMPTY_SEED_ENTRY
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [-7, 0],
      [0, 11],
    ] as const) {
      for (let i = 0; i < 40; i++) {
        state = seedEntryReduce(state, { kind: 'move', dx, dy })
        expect(state.pick).toBeGreaterThanOrEqual(0)
        expect(state.pick).toBeLessThan(SEED_ALPHABET.length)
        expect(SEED_ALPHABET[state.pick]).toBeDefined()
      }
    }
  })

  it('pastes a formatted seed straight in', () => {
    const state = seedEntryReduce(EMPTY_SEED_ENTRY, { kind: 'paste', text: 'K7F2-9XQM-3RTV' })
    expect(state.draft).toBe(SEED_A)
    expect(validateSeedDraft(state).status).toBe('complete')
    expect(describePasteRepair(state)).toBeNull()
  })

  it('pastes a whole share link, not twelve characters of the hostname', () => {
    // People paste the link, not the seed. Running a URL through normalizeSeed
    // yields a valid-looking seed made of the hostname — the wrong run, silently.
    const state = seedEntryReduce(EMPTY_SEED_ENTRY, {
      kind: 'paste',
      text: buildSeedLink(BASE, SEED_A),
    })
    expect(state.draft).toBe(SEED_A)
    expect(validateSeedDraft(state).status).toBe('complete')
    expect(describePasteRepair(state)).toBeNull()
  })

  it('pastes a link with surrounding whitespace from a chat client', () => {
    const state = seedEntryReduce(EMPTY_SEED_ENTRY, {
      kind: 'paste',
      text: `\n  ${buildSeedLink(BASE, SEED_A, true)}  \n`,
    })
    expect(state.draft).toBe(SEED_A)
  })

  it('folds ambiguous characters and says that it did', () => {
    const state = seedEntryReduce(EMPTY_SEED_ENTRY, { kind: 'paste', text: 'k7f2-9xom-3rtl' })
    // O folds to Q, L folds to J — the same run as if they had been typed right.
    expect(state.draft).toBe('K7F29XQM3RTJ')
    expect(isValidSeed(state.draft)).toBe(true)
    const repair = describePasteRepair(state)
    expect(repair).not.toBeNull()
    expect(repair).toContain('O→Q')
    expect(repair).toContain('L→J')
  })

  it('reports every distinct fold once, not once per occurrence', () => {
    const state = seedEntryReduce(EMPTY_SEED_ENTRY, { kind: 'paste', text: 'OOOO-IIII-UUUU' })
    expect(state.draft).toBe('QQQQJJJJVVVV')
    const repair = describePasteRepair(state) ?? ''
    expect(repair.match(/O→Q/g)?.length).toBe(1)
    expect(repair).toContain('I→J')
    expect(repair).toContain('U→V')
  })

  it('reports truncation of an over-long paste', () => {
    const state = seedEntryReduce(EMPTY_SEED_ENTRY, {
      kind: 'paste',
      text: `${SEED_A}EXTRASTUFF`,
    })
    expect(state.draft).toBe(SEED_A)
    expect(state.truncated).toBe(true)
    expect(describePasteRepair(state)).toMatch(/Kept the first 12/)
  })

  it('reports characters it had to throw away, but not punctuation', () => {
    const dashes = seedEntryReduce(EMPTY_SEED_ENTRY, {
      kind: 'paste',
      text: ' K7F2 - 9XQM / 3RTV ',
    })
    expect(dashes.draft).toBe(SEED_A)
    expect(dashes.dropped).toBe(0)
    expect(describePasteRepair(dashes)).toBeNull()

    const junk = seedEntryReduce(EMPTY_SEED_ENTRY, { kind: 'paste', text: 'K7F2!!9XQM##3RTV' })
    expect(junk.draft).toBe(SEED_A)
    expect(junk.dropped).toBe(4)
    expect(describePasteRepair(junk)).toMatch(/Ignored 4 characters/)
  })

  it('survives hostile paste text without throwing', () => {
    for (const text of [
      '',
      ' ',
      '   ',
      '💥'.repeat(200),
      'K'.repeat(100_000),
      '<script>alert(1)</script>',
      'https://example.com/?seed=' + 'Z'.repeat(4000),
    ]) {
      const state = seedEntryReduce(EMPTY_SEED_ENTRY, { kind: 'paste', text })
      expect(state.draft.length).toBeLessThanOrEqual(SEED_LENGTH)
      const validation = validateSeedDraft(state)
      expect(['empty', 'partial', 'complete', 'invalid']).toContain(validation.status)
      if (validation.seed !== null) expect(isValidSeed(validation.seed)).toBe(true)
      // A repair note is drawn on the card, so it can never be unbounded.
      expect((describePasteRepair(state) ?? '').length).toBeLessThan(240)
    }
  })

  it('retires the paste report as soon as the draft is edited', () => {
    const pasted = seedEntryReduce(EMPTY_SEED_ENTRY, { kind: 'paste', text: 'K7F2-9XOM-3RTV' })
    expect(describePasteRepair(pasted)).not.toBeNull()
    // The note described a string that no longer exists once a key is pressed.
    expect(describePasteRepair(seedEntryReduce(pasted, { kind: 'erase' }))).toBeNull()
    expect(describePasteRepair(seedEntryReduce(pasted, { kind: 'clear' }))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// share card behaviour
// ---------------------------------------------------------------------------

describe('share card selection', () => {
  it('never parks on a replay row that cannot be copied', () => {
    // FIRE doing nothing is indistinguishable from a broken screen.
    const refused = shareReplay(BASE, botReplay('dodger'))
    expect(refused.url).toBeNull()
    expect(moveShareSelection('seed', 1, refused)).toBe('seed')
    expect(moveShareSelection('replay', 1, refused)).toBe('seed')
  })

  it('cycles both rows when a replay link exists', () => {
    const ok = shareReplay(BASE, heldReplay(600))
    expect(ok.url).not.toBeNull()
    expect(moveShareSelection('seed', 1, ok)).toBe('replay')
    expect(moveShareSelection('replay', 1, ok)).toBe('seed')
    expect(moveShareSelection('seed', -1, ok)).toBe('replay')
  })

  it('displays a seed link short enough to read', () => {
    expect(shortSeedLink(SEED_A)).toBe(`?seed=${formatSeed(SEED_A)}`)
  })
})

// ---------------------------------------------------------------------------
// copy fits its container
// ---------------------------------------------------------------------------

describe('run mode labels fit the instrument panel', () => {
  const MODES: readonly RunMode[] = [
    { kind: 'free', seed: SEED_A, purist: false },
    { kind: 'shared', seed: SEED_A, purist: false },
    { kind: 'shared', seed: SEED_A, purist: true },
    { kind: 'daily', seed: SEED_A, purist: true, date: '2026-07-25', isToday: true, alreadyFlown: false },
    { kind: 'daily', seed: SEED_A, purist: true, date: '2026-07-25', isToday: true, alreadyFlown: true },
    { kind: 'daily', seed: SEED_A, purist: true, date: '2026-07-01', isToday: false, alreadyFlown: false },
    { kind: 'replay', seed: SEED_A, purist: false, replay: heldReplay(10_800), ofDaily: null },
    { kind: 'replay', seed: SEED_A, purist: false, replay: heldReplay(10_800), ofDaily: '2026-07-25' },
  ]

  it('keeps every label and detail inside the panel column', () => {
    // UI rule 1: nothing in the panel may spill into the playfield.
    for (const mode of MODES) {
      const { label, detail } = describeRunMode(mode)
      expect(fits(label, MODE_TAG_MAX_W, MODE_TAG_LABEL_SIZE, 1.2), `label "${label}"`).toBe(true)
      expect(fits(detail, MODE_TAG_MAX_W, MODE_TAG_DETAIL_SIZE), `detail "${detail}"`).toBe(true)
    }
  })

  it('never shows a bare seed as the whole label', () => {
    // UI rule 8 wants the seed visible; the label has to say what KIND of run it
    // is, or a daily and a free run are indistinguishable at a glance.
    for (const mode of MODES) {
      const { label } = describeRunMode(mode)
      expect(label).not.toBe(mode.seed)
      expect(label).toMatch(/^[A-Z ·]+$/)
    }
  })

  it('distinguishes every mode from every other', () => {
    const labels = MODES.map((mode) => {
      const { label, detail } = describeRunMode(mode)
      return `${label}|${detail}`
    })
    expect(new Set(labels).size).toBe(labels.length)
  })
})

describe('daily copy fits its card', () => {
  const CONTRACTS = [
    dailyContract(NOON, null),
    dailyContract(NOON, {
      date: '2026-07-25',
      ticks: 9000,
      waveIndex: 18,
      scrap: 900,
      outcome: 'lost',
    }),
    dailyContract(NOON, null, '2026-07-01'),
    // Just before midnight, where the countdown string is shortest, and just
    // after, where it is longest.
    dailyContract(new Date('2026-07-25T23:59:00.000Z'), null),
    dailyContract(new Date('2026-07-25T00:00:00.000Z'), null),
  ]

  it('wraps every prose variant inside the card', () => {
    for (const contract of CONTRACTS) {
      const lines = wrapText(dailyProse(contract), SEED_CONTENT_W, PROSE_SIZE, measure)
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) {
        expect(measure(line, PROSE_SIZE), `overflows: ${line}`).toBeLessThanOrEqual(SEED_CONTENT_W)
      }
      // The card reserves three lines for this block.
      expect(lines.length, `${contract.date} needs ${lines.length} lines`).toBeLessThanOrEqual(3)
    }
  })

  it('fits every label and detail on the daily row', () => {
    for (const contract of CONTRACTS) {
      const { label, detail } = describeDaily(contract)
      // Label and detail share a line at opposite ends of the content column.
      expect(
        measure(label, 13, 600) + measure(detail, 12) + measure('    ', 12),
        `row for ${contract.date} is too wide: ${label} / ${detail}`,
      ).toBeLessThanOrEqual(SEED_CONTENT_W)
    }
  })
})

describe('seed entry and share copy fits', () => {
  it('wraps the seed entry explanation', () => {
    const lines = wrapText(SEED_ENTRY_PROSE, SEED_CONTENT_W, PROSE_SIZE, measure)
    expect(lines.length).toBeLessThanOrEqual(3)
    for (const line of lines) {
      expect(measure(line, PROSE_SIZE)).toBeLessThanOrEqual(SEED_CONTENT_W)
    }
  })

  it('fits both footers on one line', () => {
    // Centred, so an overflow escapes both edges — and footers grow every time a
    // control is added.
    expect(measure(SEED_ENTRY_FOOTER, FOOTER_SIZE)).toBeLessThanOrEqual(SEED_CONTENT_W)
    expect(measure(SHARE_FOOTER, FOOTER_SIZE)).toBeLessThanOrEqual(SHARE_CONTENT_W)
  })

  it('wraps both share row descriptions', () => {
    for (const prose of [SEED_LINK_PROSE, REPLAY_LINK_PROSE]) {
      const lines = wrapText(prose, SHARE_CONTENT_W, PROSE_SIZE, measure)
      expect(lines.length).toBeLessThanOrEqual(2)
      for (const line of lines) {
        expect(measure(line, PROSE_SIZE), `overflows: ${line}`).toBeLessThanOrEqual(SHARE_CONTENT_W)
      }
    }
  })

  it('wraps every validation and repair message', () => {
    const states: SeedEntryState[] = [
      EMPTY_SEED_ENTRY,
      seedEntryReduce(EMPTY_SEED_ENTRY, { kind: 'paste', text: 'K7F2' }),
      seedEntryReduce(EMPTY_SEED_ENTRY, { kind: 'paste', text: 'K7F29XQM3RT' }),
      seedEntryReduce(EMPTY_SEED_ENTRY, { kind: 'paste', text: SEED_A }),
      seedEntryReduce(EMPTY_SEED_ENTRY, { kind: 'paste', text: 'oooo-illl-uuuu!!!!extra' }),
    ]
    for (const state of states) {
      for (const text of [validateSeedDraft(state).message, describePasteRepair(state) ?? '']) {
        if (text === '') continue
        const lines = wrapText(text, SEED_CONTENT_W, PROSE_SIZE, measure)
        // Three lines is what the card reserves between the field and the picker.
        expect(lines.length, `"${text}" needs ${lines.length} lines`).toBeLessThanOrEqual(3)
        for (const line of lines) {
          expect(measure(line, PROSE_SIZE), `overflows: ${line}`).toBeLessThanOrEqual(
            SEED_CONTENT_W,
          )
        }
      }
    }
  })

  it('wraps every resolution notice', () => {
    // A notice is the one string built from URL contents, so it is the one most
    // able to surprise the layout.
    const notices: string[] = []
    const encoded = encodeReplay(heldReplay(120))
    const cases: Record<string, string>[] = [
      { [RUN_PARAM.seed]: 'nope' },
      { [RUN_PARAM.daily]: 'tomorrow' },
      { [RUN_PARAM.daily]: '2099-01-01' },
      { [RUN_PARAM.replay]: 'A'.repeat(MAX_REPLAY_PARAM_CHARS + 1) },
      { [RUN_PARAM.replay]: 'zzzz' },
      { [RUN_PARAM.replay]: withSimVersion(heldReplay(120), SIM_VERSION - 1) },
      { [RUN_PARAM.replay]: withSimVersion(heldReplay(120), SIM_VERSION + 1) },
      { [RUN_PARAM.replay]: encoded, [RUN_PARAM.daily]: '1' },
      { [RUN_PARAM.replay]: encoded, [RUN_PARAM.seed]: SEED_B },
      { [RUN_PARAM.daily]: '1', [RUN_PARAM.seed]: SEED_A },
    ]
    for (const params of cases) {
      const notice = resolve(params).notice
      expect(notice, JSON.stringify(Object.keys(params))).not.toBeNull()
      notices.push(notice as string)
    }
    for (const notice of notices) {
      const lines = wrapText(notice, SEED_CONTENT_W, PROSE_SIZE, measure)
      // Four lines is a generous ceiling for a card notice; more is a wall of text.
      expect(lines.length, `notice needs ${lines.length} lines: ${notice}`).toBeLessThanOrEqual(4)
      for (const line of lines) {
        expect(measure(line, PROSE_SIZE), `overflows: ${line}`).toBeLessThanOrEqual(SEED_CONTENT_W)
      }
    }
  })

  it('wraps the too-long-replay refusal, which carries real numbers', () => {
    const share = shareReplay(BASE, botReplay('dodger'))
    const lines = wrapText(share.message as string, SHARE_CONTENT_W, PROSE_SIZE, measure)
    expect(lines.length).toBeLessThanOrEqual(5)
    for (const line of lines) {
      expect(measure(line, PROSE_SIZE), `overflows: ${line}`).toBeLessThanOrEqual(SHARE_CONTENT_W)
    }
  })
})

// ---------------------------------------------------------------------------
// headless rendering
//
// Not a substitute for looking at a screenshot, but it catches the two failures a
// screenshot review is worst at: a draw call that throws (black screen, and every
// later screen with it) and a NaN coordinate, which draws nothing at all and looks
// identical to a feature that was never wired up. Same approach as
// tests/feel.test.ts.
// ---------------------------------------------------------------------------

interface RecordedCall {
  readonly name: string
  readonly args: readonly unknown[]
}

function stubContext(): { ctx: CanvasRenderingContext2D; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const target: Record<string, unknown> = {
    measureText: (text: string) => ({ width: String(text).length * 7 }),
  }
  for (const name of ['fillRect', 'strokeRect', 'fillText', 'beginPath', 'moveTo', 'lineTo', 'stroke']) {
    target[name] = (...args: unknown[]): void => {
      calls.push({ name, args })
    }
  }
  return { ctx: target as unknown as CanvasRenderingContext2D, calls }
}

function assertNoNaN(calls: readonly RecordedCall[]): void {
  for (const call of calls) {
    for (const [index, arg] of call.args.entries()) {
      if (typeof arg === 'number') {
        expect(Number.isFinite(arg), `${call.name} arg ${index} is ${arg}`).toBe(true)
      }
    }
  }
}

describe('both screens draw headless without throwing or emitting NaN', () => {
  const ENTRY_STATES: SeedEntryState[] = [
    EMPTY_SEED_ENTRY,
    { ...EMPTY_SEED_ENTRY, pick: SEED_ALPHABET.length - 1 },
    seedEntryReduce(EMPTY_SEED_ENTRY, { kind: 'paste', text: 'K7F2' }),
    seedEntryReduce(EMPTY_SEED_ENTRY, { kind: 'paste', text: 'oooo-illl-uuuu!!!!extra' }),
    seedEntryReduce(EMPTY_SEED_ENTRY, { kind: 'paste', text: SEED_A }),
  ]

  const DAILY_VARIANTS = [
    dailyContract(NOON, null),
    dailyContract(NOON, null, '2026-07-01'),
    dailyContract(NOON, {
      date: '2026-07-25',
      ticks: 9000,
      waveIndex: 18,
      scrap: 900,
      outcome: 'lost',
    }),
  ]

  it('lays the seed card out identically in every state', () => {
    // The picker is the control the player is holding. If a paste note pushes it
    // 50 units down, it moves out from under their cursor mid-interaction, which
    // reads as a glitch and costs a mis-press. Every block reserves its worst case,
    // so the height is a constant — asserted rather than assumed.
    const heights = new Set<number>()
    for (const entry of ENTRY_STATES) {
      for (const daily of DAILY_VARIANTS) {
        const { ctx } = stubContext()
        heights.add(drawSeedEntry(ctx, { entry, daily, tick: 0 }))
      }
    }
    expect(heights.size, `card height varies: ${[...heights].join(', ')}`).toBe(1)
  })

  it('draws the seed entry card in every state', () => {
    for (const entry of ENTRY_STATES) {
      for (const daily of DAILY_VARIANTS) {
        const { ctx, calls } = stubContext()
        const bottom = drawSeedEntry(ctx, { entry, daily, tick: 37 })
        expect(calls.length).toBeGreaterThan(0)
        assertNoNaN(calls)
        // Vertical containment: the picker must never run into the footer. This is
        // the axis a width test cannot see.
        expect(bottom, 'content collides with the footer').toBeLessThanOrEqual(SEED_FOOTER_Y)
        // Every character of the alphabet must actually reach the screen, or the
        // picker silently offers fewer than it navigates.
        const drawn = calls.filter((call) => call.name === 'fillText').map((call) => call.args[0])
        for (const char of SEED_ALPHABET) expect(drawn).toContain(char)
      }
    }
  })

  it('lays the share card out identically whether or not the replay fit', () => {
    const heights = new Set<number>()
    for (const share of [shareReplay(BASE, heldReplay(600)), shareReplay(BASE, botReplay('dodger'))]) {
      const { ctx } = stubContext()
      heights.add(
        drawShareCard(ctx, {
          mode: { kind: 'shared', seed: SEED_A, purist: false },
          share,
          selected: 'seed',
          copied: null,
          tick: 0,
        }),
      )
    }
    expect(heights.size, `card height varies: ${[...heights].join(', ')}`).toBe(1)
  })

  it('draws the share card whether or not a replay link exists', () => {
    const shares = [shareReplay(BASE, heldReplay(600)), shareReplay(BASE, botReplay('dodger'))]
    for (const share of shares) {
      for (const selected of ['seed', 'replay'] as const) {
        for (const copied of [null, 'seed', 'replay'] as const) {
          const { ctx, calls } = stubContext()
          const bottom = drawShareCard(ctx, {
            mode: { kind: 'shared', seed: SEED_A, purist: false },
            share,
            selected,
            copied,
            tick: 12,
          })
          expect(calls.length).toBeGreaterThan(0)
          assertNoNaN(calls)
          expect(bottom, 'content collides with the footer').toBeLessThanOrEqual(SHARE_FOOTER_Y)
        }
      }
    }
  })
})

describe('claiming a URL mode for a sortie', () => {
  /**
   * THE REGRESSION THESE PIN was M4's entire headline feature.
   *
   * `resolveRunMode` did its job, the title screen displayed the contract, and then
   * the first keypress threw it away: `beginSortie()` was called with no argument, so
   * `seed = withSeed ?? generateSeed()` rolled a fresh seed, and `launchSortie`
   * overwrote the mode with `{ kind: 'free', seed, purist: false }`. Share links carry
   * only `seed`/`r`/`daily` and never `screen=sortie`, so **every** shared seed, daily
   * contract and replay landed on the title and was discarded.
   *
   * It survived because the decision lived in `main.ts`, which has no unit test — it
   * is DOM-bound app wiring. Extracting it here is the actual fix; these assertions
   * are what makes it stay fixed.
   */
  const FRESH = 'FRESHSEED2345'
  const fresh = (): string => FRESH

  it('flies a shared seed from a link rather than rolling a new one', () => {
    const pending = { kind: 'shared', seed: 'K7F29XQM3RTV', purist: false } as const
    const { mode } = claimSortieMode(pending, undefined, fresh)
    expect(mode.seed).toBe('K7F29XQM3RTV')
    expect(mode.kind).toBe('shared')
  })

  it('keeps a daily contract a daily, with its date', () => {
    const pending = {
      kind: 'daily',
      seed: 'DA1LYSEED234',
      purist: false,
      date: '2026-07-26',
      isToday: true,
      alreadyFlown: false,
    } as const
    const { mode } = claimSortieMode(pending, undefined, fresh)
    expect(mode).toEqual(pending)
  })

  it('carries purist through, so ?purist=1 means something', () => {
    // Hardcoding `purist: false` was a separate half of the same bug: a purist link
    // resolved as purist and was then flown as an ordinary run.
    const pending = { kind: 'shared', seed: 'PVR1STSEED23', purist: true } as const
    expect(claimSortieMode(pending, undefined, fresh).mode.purist).toBe(true)
  })

  it('lets a typed seed override a link the player is ignoring', () => {
    // The seed-entry screen is the most explicit statement of intent available, so it
    // outranks a URL — and it produces a `shared` run, because the seed came from
    // outside and purist accounting has to know that.
    const pending = { kind: 'shared', seed: 'FR0MTHEL1NK2', purist: false } as const
    const { mode } = claimSortieMode(pending, 'typed-seed-x', fresh)
    expect(mode.kind).toBe('shared')
    expect(mode.seed).toBe(normalizeSeed('typed-seed-x'))
  })

  it('rolls a fresh free run when nothing is pending', () => {
    const { mode } = claimSortieMode(null, undefined, fresh)
    expect(mode).toEqual({ kind: 'free', seed: FRESH, purist: false })
  })

  it('consumes the pending mode, so the run after a death is a fresh one', () => {
    // A daily is ONE attempt. Without this, dying and pressing confirm would re-fly
    // the same contract for free — and `save.daily` would stop meaning anything.
    const pending = { kind: 'shared', seed: 'K7F29XQM3RTV', purist: false } as const
    const first = claimSortieMode(pending, undefined, fresh)
    expect(first.nextPending).toBeNull()
    const second = claimSortieMode(first.nextPending, undefined, fresh)
    expect(second.mode).toEqual({ kind: 'free', seed: FRESH, purist: false })
  })
})
