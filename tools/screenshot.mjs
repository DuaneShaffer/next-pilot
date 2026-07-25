/**
 * Screenshot capture harness.
 *
 * Drives the real production build and captures each screen to `screenshots/`.
 * These images exist to be *looked at* — interface clarity is this project's
 * first priority, and a passing unit test cannot tell you that text overlaps or
 * that a meter is unreadable. See docs/VERIFICATION.md.
 *
 *   npm run screenshot          # build, then capture
 *   node tools/screenshot.mjs   # capture an existing dist/
 *
 * Design notes, both learned the hard way:
 *
 * 1. `dist/` is static files, so this serves them from node:http rather than
 *    spawning a dev server and screen-scraping its stdout for a ready signal.
 *    No child process means nothing to leak, misparse, or wait on forever.
 * 2. Everything is under a hard watchdog. A verification tool that can hang
 *    silently is worse than no tool, because unattended work stalls with no
 *    signal that anything is wrong.
 */

import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'

const DIST = 'dist'
const OUT_DIR = 'screenshots'
/** Fixed seed so captures are comparable between runs. */
const SEED = 'K7F29XQM3RTV'
/** Whole-run ceiling. Generous for a slow machine, finite regardless. */
const WATCHDOG_MS = 120_000
const PAGE_TIMEOUT_MS = 15_000

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

/**
 * Each shot names the state it captures. `keys` are held for `settleMs` before
 * capture, which is how we get a screen mid-combat rather than at rest.
 */
const SHOTS = [
  { name: 'title', url: `/?seed=${SEED}`, settleMs: 500 },
  { name: 'sortie-idle', url: `/?seed=${SEED}&screen=sortie`, settleMs: 300 },
  { name: 'sortie-firing', url: `/?seed=${SEED}&screen=sortie`, keys: ['Space'], settleMs: 900 },
  {
    name: 'sortie-moving-firing',
    url: `/?seed=${SEED}&screen=sortie`,
    keys: ['Space', 'ArrowLeft'],
    settleMs: 700,
  },
]

/** The common case, plus a small window to catch layout breakage. */
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'small', width: 900, height: 620 },
]

const startedAt = Date.now()
const step = (message) =>
  console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`)

/** Serve dist/ on an OS-assigned port. Returns { server, origin }. */
async function serveDist() {
  try {
    const info = await stat(DIST)
    if (!info.isDirectory()) throw new Error(`${DIST} is not a directory`)
  } catch {
    throw new Error(`No ${DIST}/ directory. Run \`npm run build\` first.`)
  }

  const server = createServer((request, response) => {
    const path = decodeURIComponent((request.url ?? '/').split('?')[0])
    // Strip any traversal before joining; this server is local-only but a
    // path-traversal bug in a test tool is still a bug.
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, '')
    const file = join(DIST, safe === '/' ? 'index.html' : safe)

    const stream = createReadStream(file)
    stream.on('open', () => {
      response.writeHead(200, {
        'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
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
  const { port } = server.address()
  return { server, origin: `http://127.0.0.1:${port}` }
}

async function capture() {
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  const { server, origin } = await serveDist()
  step(`serving ${DIST}/ at ${origin}`)

  const browser = await chromium.launch()
  step('browser launched')
  const problems = []

  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        colorScheme: 'dark',
      })
      const page = await context.newPage()
      page.setDefaultTimeout(PAGE_TIMEOUT_MS)

      // A silent console exception is exactly the kind of bug a screenshot alone
      // would hide, so surface it as a failure.
      page.on('pageerror', (error) => problems.push(`${viewport.name}: ${error.message}`))
      page.on('console', (message) => {
        if (message.type() === 'error') problems.push(`${viewport.name}: ${message.text()}`)
      })

      // Warm the context once with a throwaway navigation. Creating a context
      // costs a measurable stall on its first page, which otherwise shows up as
      // a dropped tick against whichever shot happened to be first.
      await page.goto(`${origin}/?seed=${SEED}`, { waitUntil: 'load' })
      await page.waitForSelector('body[data-ready="true"]')
      await page.waitForTimeout(400)

      for (const shot of SHOTS) {
        await page.goto(`${origin}${shot.url}`, { waitUntil: 'load' })
        // main() sets this once the loop is running; waiting on it avoids
        // capturing a blank first frame.
        await page.waitForSelector('body[data-ready="true"]')

        // Warm up, then baseline the tick counters. The first frames after a
        // navigation are not steady state — script compile, first paint, and
        // font work stall the loop — and counting those as dropped ticks
        // reported a performance problem that did not exist.
        await page.waitForTimeout(250)
        const before = await page.evaluate(() => window.__nextPilot?.stats?.droppedTicks ?? 0)

        for (const key of shot.keys ?? []) await page.keyboard.down(key)
        await page.waitForTimeout(shot.settleMs)

        // Read the counters BEFORE capturing. page.screenshot() blocks the
        // renderer, so the loop resumes behind and records dropped ticks —
        // measuring after the capture makes the instrument report its own cost
        // as a game performance problem.
        const state = await page.evaluate(() => {
          const api = window.__nextPilot
          return api ? { screen: api.screen, seed: api.seed, stats: api.stats } : null
        })
        const droppedWhileRunning = (state?.stats?.droppedTicks ?? 0) - before

        const file = `${OUT_DIR}/${shot.name}--${viewport.name}.png`
        await page.screenshot({ path: file })
        for (const key of shot.keys ?? []) await page.keyboard.up(key)
        step(
          `${file}  screen=${state?.screen ?? '?'} ticks=${state?.stats?.ticks ?? '?'} ` +
            `bullets=${state?.stats?.peakBullets ?? '?'} dropped=${droppedWhileRunning}`,
        )

        if (!state) problems.push(`${shot.name}/${viewport.name}: game never initialised`)
        if (droppedWhileRunning > 0) {
          problems.push(
            `${shot.name}/${viewport.name}: dropped ${droppedWhileRunning} ticks while running`,
          )
        }
      }
      await context.close()
    }
  } finally {
    await browser.close()
    server.close()
  }

  return problems
}

const watchdog = new Promise((_, reject) =>
  setTimeout(
    () => reject(new Error(`Watchdog: capture exceeded ${WATCHDOG_MS / 1000}s`)),
    WATCHDOG_MS,
  ).unref(),
)

try {
  const problems = await Promise.race([capture(), watchdog])
  if (problems.length > 0) {
    console.error('\nProblems detected:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`\nCaptured ${SHOTS.length * VIEWPORTS.length} screenshots to ${OUT_DIR}/`)
  process.exit(0)
} catch (error) {
  console.error(`\n${error.message}`)
  process.exit(1)
}
