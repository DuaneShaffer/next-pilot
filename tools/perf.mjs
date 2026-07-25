/**
 * Frame-time measurement harness.
 *
 * Drives the real production build in Chromium and reports what a frame actually
 * costs. This is the only instrument in the project that can answer the frame
 * budget in `docs/ARCHITECTURE.md` — "frame < 8ms at p99" — because a frame does
 * not exist headlessly. `tests/perf.test.ts` owns the sim-tick half of the budget
 * and deliberately says nothing about frames.
 *
 *   npm run build && node tools/perf.mjs
 *   node tools/perf.mjs --json
 *   node tools/perf.mjs --seconds=180        # the whole sector, at real time
 *   node tools/perf.mjs --dist=/tmp/build    # measure a build somewhere else
 *
 * Three things this tool is built around, all learned from the other harnesses:
 *
 * 1. **It serves static files from node:http rather than spawning a dev server.**
 *    No child process to leak, misparse, or wait on forever. Same pattern as
 *    `tools/screenshot.mjs`, and the same reasoning.
 * 2. **It never screenshots, and it baselines the dropped-tick counter anyway.**
 *    `page.screenshot()` blocks the renderer, so the loop resumes behind and
 *    records dropped ticks that the game did not cause — `tools/screenshot.mjs`
 *    documents that mistake and this tool must not repeat it in a subtler form.
 *    Everything here is a cheap `page.evaluate`, and the counter is still
 *    baselined after warm-up so page-load stalls are not attributed to the game.
 * 3. **Everything is under a hard watchdog.** A verification tool that can hang
 *    silently is worse than no tool, because unattended work stalls with no signal.
 *
 * The measurement itself uses the loop's own ring buffers (`src/core/loop.ts`),
 * read through `window.__nextPilot.stats.timing`. Those rings are a *sliding
 * window* — the frame ring holds the last 1024 frames — which is what makes the
 * sampling below work: poll it repeatedly and you get frame cost as a function of
 * how busy the sector is, from one page load.
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'

/** Fixed seed so runs are comparable. Same one the screenshot harness uses. */
const SEED = 'K7F29XQM3RTV'

/**
 * The budgets being checked, from docs/ARCHITECTURE.md.
 *
 * Asserted against the *worst* sampled window, not the average of them: a budget
 * that only holds when the screen is quiet is not a budget.
 */
const FRAME_P99_BUDGET_MS = 8
const TICK_P99_BUDGET_MS = 2

/**
 * Ring capacities in `src/core/loop.ts`. Keep in step with FRAME_SAMPLES and
 * TICK_SAMPLES there.
 *
 * Needed only to know when a ring has flushed its warm-up samples. There is no
 * way to reset one from out here — `window.__nextPilot` is read-only and
 * `src/main.ts` does not expose `resetTimings` — so instead we wait until enough
 * samples have been pushed that every warm-up sample has been evicted out the
 * back. Which ring we wait on depends on what the pass reports: waiting for 1024
 * *frames* at ff=12 would burn 200 seconds of sector time and measure a dead
 * pilot, which is exactly what the first version of this tool did.
 *
 * If these and loop.ts ever disagree the tool degrades rather than lies: it waits
 * for a count that may be larger or smaller than needed, and every table reports
 * the real `count`/`total` so the reader can see the window it got.
 */
const FRAME_RING_CAPACITY = 1024
const TICK_RING_CAPACITY = 2048

/**
 * Frames to let pass before measuring anything.
 *
 * The larger of the two capacities, because a window is only clean once *every*
 * ring it draws from has evicted its warm-up samples. Waiting on the frame ring
 * alone (1024) leaves the 2048-sample tick ring still holding page-load samples,
 * which showed up as tick p99 falling from 0.085ms to 0.055ms over the first four
 * windows of a run — the loop getting faster as the navigation aged out of the
 * numbers. 2048 frames is ~34 seconds at 60fps, and it is the price of a p99 that
 * describes the game.
 */
const FLUSH_FRAMES = Math.max(FRAME_RING_CAPACITY, TICK_RING_CAPACITY)

/** Real seconds of sampling after the warm-up has flushed. */
const DEFAULT_SECONDS = 30
/** How often the sliding window is sampled, in ms. */
const SAMPLE_INTERVAL_MS = 4000

const PAGE_TIMEOUT_MS = 20_000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    dist: 'dist',
    seconds: DEFAULT_SECONDS,
    policy: 'aggressor',
    ff: 1,
    json: false,
    help: false,
  }
  for (const raw of argv) {
    const eq = raw.indexOf('=')
    const flag = eq === -1 ? raw : raw.slice(0, eq)
    const value = eq === -1 ? '' : raw.slice(eq + 1)
    switch (flag) {
      case '--help':
      case '-h':
        args.help = true
        break
      case '--json':
        args.json = true
        break
      case '--dist':
        if (value === '') fail('--dist needs a path')
        args.dist = value
        break
      case '--policy':
        if (value === '') fail('--policy needs a bot name')
        args.policy = value
        break
      case '--seconds': {
        const n = Number.parseInt(value, 10)
        if (!Number.isFinite(n) || n < 5) fail(`--seconds needs an integer >= 5, got "${value}"`)
        args.seconds = n
        break
      }
      case '--ff': {
        const n = Number.parseInt(value, 10)
        if (!Number.isFinite(n) || n < 1) fail(`--ff needs an integer >= 1, got "${value}"`)
        args.ff = n
        break
      }
      default:
        fail(`unknown flag ${flag}. Try --help.`)
    }
  }
  return args
}

function fail(message) {
  console.error(`perf: ${message}`)
  process.exit(1)
}

function printHelp() {
  console.log(`Frame-time measurement in a real browser. Needs a build in dist/.

  --dist=PATH      directory of static files to serve (default dist)
  --seconds=N      real seconds of measured play (default ${DEFAULT_SECONDS})
  --policy=NAME    autopilot policy to drive the run (default aggressor)
  --ff=N           sim steps per loop tick (default 1; see the warning below)
  --json           machine-readable output

Budgets checked: frame < ${FRAME_P99_BUDGET_MS}ms p99, sim tick < ${TICK_P99_BUDGET_MS}ms p99, zero dropped ticks.

--seconds defaults to ${DEFAULT_SECONDS} so the tool is cheap enough to run often. That covers
the first ~${DEFAULT_SECONDS}s of the sector, which is its sparsest stretch. Use --seconds=180
to measure the whole arc including the clear-out beats at 164-174s, which are the
densest frames the sector produces. Whichever you pick, the report says which
sector time each sample came from, so a number is never printed without context.

--ff is NOT a shortcut to that. src/main.ts runs N sim steps inside a single loop
tick, so at ff=N every recorded duration is a batch of N steps and neither budget
can be evaluated. The tool reports the timings and refuses the verdicts.`)
}

// ---------------------------------------------------------------------------
// static server
// ---------------------------------------------------------------------------

/** Serve `dir` on an OS-assigned port. Returns { server, origin }. */
async function serve(dir) {
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) throw new Error(`${dir} is not a directory`)
    await stat(join(dir, 'index.html'))
  } catch {
    throw new Error(
      `No usable build at ${dir}/. Run \`npm run build\` first, or pass --dist=PATH.`,
    )
  }

  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0])
    // Strip any traversal before joining; local-only, but a path-traversal bug in
    // a test tool is still a bug.
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, '')
    const file = join(dir, safe === '/' ? 'index.html' : safe)

    const stream = createReadStream(file)
    stream.on('open', () => {
      response.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        // Cross-origin isolation, purely to unlock a usable clock. Chromium
        // coarsens performance.now() to 100 microseconds unless the page is
        // isolated, which quantises a 0.3ms frame into three buckets and a 0.05ms
        // tick into "zero or 0.1". With these headers the resolution is 5us and
        // the numbers below are actually numbers. Nothing in the game depends on
        // isolation, so this changes the clock and nothing else — but note that
        // the deployed build on GitHub Pages is NOT isolated, so its own
        // self-reported timings are coarse.
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
      })
      stream.pipe(response)
    })
    stream.on('error', () => {
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end('not found')
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

// ---------------------------------------------------------------------------
// scenarios
// ---------------------------------------------------------------------------

/**
 * The measurement pass, and why there is only one of it.
 *
 * The obvious second pass would use `?ff=12` to reach late-sector density in a few
 * seconds instead of waiting three real minutes. That does not work, and finding
 * out why is worth writing down because the trap is invisible:
 *
 * `src/main.ts` implements fast-forward by running N simulation steps **inside a
 * single `hooks.tick()`**. The loop therefore measures one tick as N sim steps —
 * at ff=12, `stats.timing.tick.total` advances at 1/12 the rate of
 * `stats.tick`, and every duration in the ring is twelve steps' worth of work.
 * A frame is worse: one frame does twelve ticks plus a draw. So at ff != 1 neither
 * the 2ms tick budget nor the 8ms frame budget can be evaluated at all, and
 * dividing by N does not rescue it because a percentile of sums is not a sum of
 * percentiles.
 *
 * This is the same shape of mistake `tools/screenshot.mjs` documents for dropped
 * ticks: a verification affordance quietly changing what the instrument measures.
 * So `--ff` exists for anyone who wants throughput numbers, and the tool refuses
 * to claim a budget when it is not 1. Reaching the dense end of the sector is done
 * the only honest way available: `--seconds=180`, at real time.
 */
function scenarios(args) {
  const realtime = args.ff === 1
  return [
    {
      name: realtime ? 'realtime' : `ff${args.ff}`,
      ff: args.ff,
      seconds: args.seconds,
      sampleEveryMs: SAMPLE_INTERVAL_MS,
      reports: realtime ? ['frame', 'render', 'tick'] : [],
      note: realtime
        ? 'one sim tick per frame, so frame and tick times mean what the budgets mean'
        : `${args.ff} sim steps per loop tick. Percentiles below describe batches of ` +
          `${args.ff} steps, NOT single ticks or frames, so no budget is evaluated. ` +
          'Use --ff=1 for the budgets.',
    },
  ]
}


const startedAt = Date.now()
const step = (message) =>
  console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`)

/** Everything the page can tell us, in one round trip. */
const READ_STATE = () => {
  const api = window.__nextPilot
  if (!api) return null
  const stats = api.stats ?? {}
  return {
    screen: api.screen,
    runState: api.runState,
    enemies: api.enemyCount,
    integrity: api.integrity,
    tick: stats.tick ?? 0,
    frames: stats.frames ?? 0,
    droppedTicks: stats.droppedTicks ?? 0,
    peakProjectiles: stats.peakProjectiles ?? 0,
    // `undefined` means a build without the instrumentation; `null` means the
    // loop has it but it is switched off. Those are different problems.
    timing: stats.timing === undefined ? 'absent' : stats.timing,
  }
}

async function runScenario(page, origin, scenario, args, problems) {
  const url = `${origin}/?seed=${SEED}&screen=sortie&autopilot=${args.policy}&ff=${scenario.ff}`
  await page.goto(url, { waitUntil: 'load' })
  // src/main.ts sets this once the loop is running.
  await page.waitForSelector('body[data-ready="true"]')

  const first = await page.evaluate(READ_STATE)
  if (first === null) {
    problems.push(`${scenario.name}: the game never initialised (window.__nextPilot missing)`)
    return null
  }
  if (first.timing === 'absent') {
    problems.push(
      `${scenario.name}: this build has no loop instrumentation — ` +
        'window.__nextPilot.stats.timing is missing. The dist/ being served predates ' +
        'the timing work in src/core/loop.ts; rebuild it.',
    )
    return null
  }
  if (first.timing === null) {
    problems.push(
      `${scenario.name}: loop instrumentation is switched off in this build ` +
        '(stats.timing is null), so there is nothing to measure.',
    )
    return null
  }

  // Wait for the relevant ring to flush its warm-up samples. The frames right
  // after a navigation are not steady state — script compile, first paint and
  // font work all land there — and a p99 that includes them describes the page
  // load, not the game.
  const flushTarget = first.frames + FLUSH_FRAMES
  try {
    await page.waitForFunction(
      (target) => {
        const api = window.__nextPilot
        // Bail out on a finished run too, so the check below can report *why*
        // rather than timing out with no explanation.
        return (api?.stats?.frames ?? 0) >= target || api?.runState !== 'active'
      },
      flushTarget,
      { timeout: Math.max(PAGE_TIMEOUT_MS, (FLUSH_FRAMES / 20) * 1000), polling: 250 },
    )
  } catch {
    problems.push(
      `${scenario.name}: warm-up never flushed (frames did not reach ${flushTarget}), ` +
        'so nothing here would be steady state',
    )
    return null
  }

  // Baseline the dropped-tick counter only now, for the same reason.
  const baseline = await page.evaluate(READ_STATE)
  if (baseline.runState !== 'active') {
    // The measurement window has to contain live play. Reporting frame times over
    // a frozen incident report would make the game look faster the worse it did.
    problems.push(
      `${scenario.name}: the run ended (state "${baseline.runState}") at sector ` +
        `t=${(baseline.tick / 60).toFixed(1)}s, before the ${FLUSH_FRAMES}-frame warm-up ` +
        `had flushed. At ff=${scenario.ff} the sector is consumed faster than the rings ` +
        'fill — lower --ff, or pick a policy that survives longer.',
    )
    return null
  }
  step(
    `${scenario.name}: warm-up flushed after ${baseline.frames} frames ` +
      `(sector t=${(baseline.tick / 60).toFixed(1)}s) — sampling for ${scenario.seconds}s`,
  )

  const samples = []
  const deadline = Date.now() + scenario.seconds * 1000
  while (Date.now() < deadline) {
    await page.waitForTimeout(
      Math.min(scenario.sampleEveryMs, Math.max(250, deadline - Date.now())),
    )
    const state = await page.evaluate(READ_STATE)
    if (state === null || state.timing === 'absent' || state.timing === null) break
    samples.push({
      /** Sector time this window ends at. Each window covers the preceding ~17s of frames. */
      sectorSeconds: Number((state.tick / 60).toFixed(1)),
      screen: state.screen,
      runState: state.runState,
      enemies: state.enemies,
      integrity: state.integrity,
      droppedTicks: state.droppedTicks - baseline.droppedTicks,
      frame: round(state.timing.frame),
      render: round(state.timing.render),
      tick: round(state.timing.tick),
    })
    // Once the pilot is dead the loop is drawing the incident report over a frozen
    // playfield. Those frames are cheap and folding them in would make the game
    // look faster the worse it played.
    if (state.runState !== 'active') break
  }

  const final = await page.evaluate(READ_STATE)
  return {
    name: scenario.name,
    ff: scenario.ff,
    note: scenario.note,
    reports: scenario.reports,
    url: url.replace(origin, ''),
    endedEarly: final?.runState !== 'active',
    finalRunState: final?.runState ?? 'unknown',
    finalScreen: final?.screen ?? 'unknown',
    sectorSecondsReached: Number(((final?.tick ?? 0) / 60).toFixed(1)),
    peakProjectiles: final?.peakProjectiles ?? 0,
    droppedTicks: (final?.droppedTicks ?? 0) - baseline.droppedTicks,
    samples,
  }
}

function round(summary) {
  if (!summary) return null
  const to4 = (v) => Number(Number(v ?? 0).toFixed(4))
  return {
    count: summary.count ?? 0,
    total: summary.total ?? 0,
    p50: to4(summary.p50),
    p99: to4(summary.p99),
    max: to4(summary.max),
    mean: to4(summary.mean),
  }
}

/** Worst sampled window for a given metric. A budget must hold at the peak. */
function worstWindow(result, metric) {
  let worst = null
  for (const sample of result.samples) {
    const value = sample[metric]
    if (!value) continue
    if (worst === null || value.p99 > worst.p99) worst = { ...value, at: sample.sectorSeconds }
  }
  return worst
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

const pad = (text, width) => (text.length >= width ? text : text + ' '.repeat(width - text.length))
const padStart = (text, width) =>
  text.length >= width ? text : ' '.repeat(width - text.length) + text

function printResult(result) {
  console.log('')
  console.log(`PASS ${result.name}   ff=${result.ff}   ${result.url}`)
  console.log(`  ${result.note}`)
  if (result.samples.length === 0) {
    console.log('  no samples collected')
    return
  }
  // Only the columns this pass licenses. Printing an ff=12 frame time next to an
  // 8ms budget and disclaiming it in a footnote is how a report starts lying:
  // the number gets quoted and the footnote does not.
  const columns = [
    ['sector t', 9, (s) => `${s.sectorSeconds.toFixed(1)}s`],
    ['enemies', 8, (s) => String(s.enemies)],
    ['hull', 6, (s) => String(s.integrity)],
  ]
  if (result.reports.includes('frame')) {
    columns.push(['frame p50', 10, (s) => s.frame.p50.toFixed(3)])
    columns.push(['frame p99', 10, (s) => s.frame.p99.toFixed(3)])
    columns.push(['frame max', 10, (s) => s.frame.max.toFixed(3)])
  }
  if (result.reports.includes('render')) {
    columns.push(['rend p99', 10, (s) => s.render.p99.toFixed(3)])
  }
  // At ff != 1 these are batches of ff sim steps, so they get a different name.
  // A column headed "tick p99" that is not a tick is how a caveat gets lost.
  const tickLabel = result.reports.includes('tick') ? 'tick' : `x${result.ff}`
  columns.push([`${tickLabel} p50`, 10, (s) => s.tick.p50.toFixed(3)])
  columns.push([`${tickLabel} p99`, 10, (s) => s.tick.p99.toFixed(3)])
  columns.push(['samples', 9, (s) => String(s.tick.count)])
  columns.push(['dropped', 8, (s) => String(s.droppedTicks)])

  console.log('  ' + columns.map(([name, width]) => pad(name, width)).join(''))
  console.log('  ' + '-'.repeat(columns.reduce((sum, [, width]) => sum + width, 0)))
  for (const sample of result.samples) {
    console.log(
      '  ' + columns.map(([, width, get]) => padStart(get(sample), width - 1) + ' ').join(''),
    )
  }
  const window = result.reports.includes('frame')
    ? `~${FRAME_RING_CAPACITY} frames`
    : `~${TICK_RING_CAPACITY} sim ticks`
  console.log(`  each row is a sliding window over the preceding ${window}; all times in ms`)
}

function printVerdicts(results) {
  console.log('')
  console.log('BUDGETS')
  const lines = []
  for (const result of results) {
    if (result.reports.includes('frame')) {
      const worst = worstWindow(result, 'frame')
      lines.push(
        verdict(
          `frame p99 < ${FRAME_P99_BUDGET_MS}ms`,
          worst?.p99,
          FRAME_P99_BUDGET_MS,
          worst === null ? '' : `worst window ended at sector t=${worst.at}s`,
        ),
      )
    } else {
      lines.push(
        `SKIP frame p99 < ${FRAME_P99_BUDGET_MS}ms — not evaluable at ff=${result.ff}, ` +
          'each frame did more than one tick',
      )
    }
    if (result.reports.includes('tick')) {
      const worstTick = worstWindow(result, 'tick')
      lines.push(
        verdict(
          `tick p99 < ${TICK_P99_BUDGET_MS}ms`,
          worstTick?.p99,
          TICK_P99_BUDGET_MS,
          worstTick === null ? '' : `worst window ended at sector t=${worstTick.at}s`,
        ),
      )
    } else {
      lines.push(
        `SKIP tick p99 < ${TICK_P99_BUDGET_MS}ms — not evaluable at ff=${result.ff}, ` +
          `each recorded tick was ${result.ff} sim steps`,
      )
    }
    // droppedTicks is meaningful at any ff: it counts sim ticks the loop refused
    // to run, and nothing about batching changes that.
    lines.push(verdict('droppedTicks == 0', result.droppedTicks, 0.5, 'excludes page load'))
  }
  for (const line of lines) console.log(`  ${line}`)
}

function verdict(label, value, ceiling, context) {
  if (value === undefined || value === null) return `?    ${label} — not measured`
  const ok = value < ceiling
  const shown = value < 1 ? value.toFixed(3) : value.toFixed(2)
  return `${ok ? 'PASS' : 'FAIL'} ${label} — measured ${shown}${context ? `  (${context})` : ''}`
}

function printCoverage(results, args) {
  console.log('')
  console.log('NOT MEASURED — what this tool cannot tell you')
  const notes = [
    'whether the game looks right. Frame time is orthogonal to a rendering bug; ' +
      'a blank canvas draws very fast. That is `npm run screenshot` and a human looking at it.',
    'anything about the machine you will actually ship to. This is one Chromium ' +
      'build on one CPU with software or virtualised GPU compositing. A phone at 3x DPR ' +
      'is a different measurement entirely (see M7 in docs/ROADMAP.md).',
    `density beyond what ${args.policy} reaches. A policy that dies early never renders ` +
      'the clear-out waves, and a policy that clears never renders a screen full of ' +
      'leftovers. Neither is the worst case a human can create.',
    'the 2,000-projectile case in the budget. Real play peaks near 54 live projectiles ' +
      'and the spawn caps stop at 1,792, so no browser pass can reach 2,000 at all. ' +
      'tests/perf.test.ts constructs that case directly instead.',
    'memory, GC pauses, and long-tail hitches beyond the p99 of a sliding window. ' +
      '`max` is reported per window but a single 40ms hitch is invisible in a p99.',
    'audio cost. WebAudio runs on its own thread and does not appear in these frames.',
  ]
  const reached = results.map((r) => r.sectorSecondsReached)
  if (reached.some((s) => s < 160)) {
    notes.unshift(
      `the dense end of the sector. This run reached ${reached.join('s / ')}s of sector time. ` +
        'The heaviest frames are the clear-out beats at 164-174s, and the elite at 134s. ' +
        `Add ${Math.ceil(175 - Math.max(0, ...reached))}s to --seconds to get there.`,
    )
  }
  for (const result of results) {
    if (result.endedEarly) {
      notes.unshift(
        `anything after sector t=${result.sectorSecondsReached}s in the ${result.name} pass: ` +
          `the run ended there (state "${result.finalRunState}") and sampling stopped, because ` +
          'frames spent drawing the incident report over a frozen playfield are cheap and would ' +
          'flatter the numbers.',
      )
    }
  }
  for (const note of notes) console.log(`  - ${note}`)
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function measure(args) {
  const { server, origin } = await serve(args.dist)
  step(`serving ${args.dist}/ at ${origin}`)

  const browser = await chromium.launch()
  step('browser launched')
  const problems = []
  const results = []

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      // deviceScaleFactor 1, not 2: this measures frame cost, and doubling the
      // pixel count would measure a display nobody is being budgeted for.
      deviceScaleFactor: 1,
      colorScheme: 'dark',
    })
    const page = await context.newPage()
    page.setDefaultTimeout(PAGE_TIMEOUT_MS)
    // A console exception is exactly the kind of failure a timing table would hide.
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console: ${message.text()}`)
    })

    for (const scenario of scenarios(args)) {
      const result = await runScenario(page, origin, scenario, args, problems)
      if (result !== null) results.push(result)
    }
    await context.close()
  } finally {
    await browser.close()
    server.close()
  }

  return { results, problems }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return Promise.resolve(0)
  }

  // Generous enough for --seconds=180 plus browser launch, finite regardless.
  const watchdogMs = (args.seconds + 60) * 1000 + 90_000
  const watchdog = new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Watchdog: measurement exceeded ${Math.round(watchdogMs / 1000)}s`)),
      watchdogMs,
    ).unref(),
  )

  return Promise.race([measure(args), watchdog]).then(({ results, problems }) => {
    if (args.json) {
      console.log(
        JSON.stringify(
          {
            config: { ...args, seed: SEED },
            budgets: { frameP99Ms: FRAME_P99_BUDGET_MS, tickP99Ms: TICK_P99_BUDGET_MS },
            passes: results,
            worst: results.map((r) => ({
              name: r.name,
              frame: r.reports.includes('frame') ? worstWindow(r, 'frame') : null,
              tick: r.reports.includes('tick') ? worstWindow(r, 'tick') : null,
              /** Present at any ff, but only a per-tick figure when ff is 1. */
              batch: r.reports.includes('tick') ? null : worstWindow(r, 'tick'),
              droppedTicks: r.droppedTicks,
            })),
            problems,
            notMeasured: [
              'visual correctness',
              'target hardware',
              'density beyond the driving policy',
              'the 2,000-projectile case (unreachable in a browser)',
              'GC hitches beyond a windowed p99',
              'audio cost',
            ],
          },
          null,
          2,
        ),
      )
    } else {
      for (const result of results) printResult(result)
      printVerdicts(results)
      printCoverage(results, args)
    }

    const failed = []
    for (const result of results) {
      if (result.reports.includes('frame')) {
        const worst = worstWindow(result, 'frame')
        if (worst !== null && worst.p99 >= FRAME_P99_BUDGET_MS) {
          failed.push(`${result.name}: frame p99 ${worst.p99}ms >= ${FRAME_P99_BUDGET_MS}ms`)
        }
      }
      if (result.reports.includes('tick')) {
        const worstTick = worstWindow(result, 'tick')
        if (worstTick !== null && worstTick.p99 >= TICK_P99_BUDGET_MS) {
          failed.push(`${result.name}: tick p99 ${worstTick.p99}ms >= ${TICK_P99_BUDGET_MS}ms`)
        }
      }
      if (result.droppedTicks > 0) {
        failed.push(`${result.name}: dropped ${result.droppedTicks} ticks while running`)
      }
    }
    if (results.length === 0) failed.push('no pass produced any samples')

    if (!args.json && (problems.length > 0 || failed.length > 0)) {
      console.error('\nProblems detected:')
      for (const problem of [...problems, ...failed]) console.error(`  - ${problem}`)
    }
    return problems.length > 0 || failed.length > 0 ? 1 : 0
  })
}

try {
  process.exit(await main())
} catch (error) {
  console.error(`\n${error.message}`)
  process.exit(1)
}
