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
import type { DeathCauseKind, RunState, WorldView } from '../src/sim/entities'
import type { BotName } from '../src/sim/bots'
import { BOTS, BOT_NAMES, isBotName } from '../src/sim/bots'
import { World } from '../src/sim/world'
import { digestWorld } from '../src/meta/snapshot'
import { decodeReplay, playback, ReplayRecorder } from '../src/meta/replay'

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
  /** When present, every input is recorded for fixture generation. */
  recorder?: ReplayRecorder
}

function runOnce(policyName: BotName, seed: string, options: RunOptions): RunResult {
  const world = new World(seed)
  const view: WorldView = world
  const policy = BOTS[policyName].create(seed)
  const obs = options.observations

  let ticks = 0
  while (view.runState === 'active' && ticks < options.maxTicks) {
    const input: InputSnapshot = policy(view)
    if (input.focus) obs.sawFocus = true
    if (input.special) obs.sawSpecial = true
    if (input.fire) obs.sawFire = true
    options.recorder?.record(input)
    world.tick(input)
    ticks++
    // Sampled rather than per-tick: this is coverage bookkeeping, not sim state,
    // and scanning every enemy every tick would show up in the sweep timing.
    if (ticks % ENEMY_SAMPLE_TICKS === 0) {
      for (const enemy of view.enemies) if (enemy.alive) obs.enemyDefsSeen.add(enemy.defId)
    }
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

interface Coverage {
  skippedPolicies: readonly BotName[]
  observations: RunObservations
  maxSeconds: number
  totalTruncated: number
  unattributedDeaths: number
  extractions: number
  enemyDefsSeen: readonly string[]
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
      '(sampled every 15 ticks; this tool does not read the content tables, so a def that never spawns is absent here rather than reported as missing)',
  )
  notes.push('hull variants, items, and shop choices are not swept — M3 work, no coverage yet')
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
  --record-fixture=NAME record one run to tests/replays/NAME.json and verify it

Policies:
${BOT_NAMES.map((name) => `  ${pad(name, 11)}${BOTS[name].measures}`).join('\n')}
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

  const observations = emptyObservations()
  const startedNs = process.hrtime.bigint()
  const summaries: PolicySummary[] = []
  const allRuns: RunResult[] = []
  let totalTicks = 0

  for (const policy of args.policies) {
    const runs: RunResult[] = []
    for (let i = 0; i < args.runs; i++) {
      const result = runOnce(policy, deriveSeed(args.seed, i), { maxTicks, observations })
      runs.push(result)
      totalTicks += result.ticks
    }
    summaries.push(summarise(policy, runs))
    allRuns.push(...runs)
  }

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

  if (args.json) {
    const payload: Record<string, unknown> = {
      config: {
        baseSeed: args.seed,
        runsPerPolicy: args.runs,
        policies: args.policies,
        maxSeconds: args.maxSeconds,
      },
      timing,
      policies: summaries,
      coverage: {
        skippedPolicies: coverage.skippedPolicies,
        truncatedRuns: coverage.totalTruncated,
        unattributedDeaths: coverage.unattributedDeaths,
        extractions: coverage.extractions,
        enemyDefsSeen: coverage.enemyDefsSeen,
        focusExercised: observations.sawFocus,
        specialExercised: observations.sawSpecial,
        notMeasured: ['fun', 'hull variants', 'items', 'shop choices'],
      },
    }
    if (args.detail) payload['runs'] = allRuns
    console.log(JSON.stringify(payload, null, 2))
    return
  }

  console.log('')
  console.log(
    `PLAYTEST  base seed ${args.seed}  ${args.runs} runs x ${args.policies.length} policies  cap ${args.maxSeconds}s`,
  )
  console.log('')
  printTable(summaries)
  printDeaths(summaries)
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
