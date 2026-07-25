/**
 * Screenshot capture harness.
 *
 * Drives the real production build and captures each screen to `screenshots/`.
 * These images exist to be *looked at* — interface clarity is this project's
 * first priority, and a passing unit test cannot tell you that text overlaps or
 * that a meter is unreadable. See docs/VERIFICATION.md.
 *
 *   npm run build && node tools/screenshot.mjs
 *   node tools/screenshot.mjs --keep   # leave the preview server running
 */

import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { chromium } from 'playwright'

const PORT = 4173
const BASE = `http://localhost:${PORT}`
const OUT_DIR = 'screenshots'
/** Fixed seed so captures are comparable between runs. */
const SEED = 'K7F29XQM3RTV'

/**
 * Each shot names the state it captures. `keys` are held for `holdTicks` frames
 * before capture, which is how we get a screen mid-combat rather than at rest.
 */
const SHOTS = [
  { name: 'title', url: `/?seed=${SEED}`, settleMs: 400 },
  { name: 'sortie-idle', url: `/?seed=${SEED}&screen=sortie`, settleMs: 300 },
  {
    name: 'sortie-firing',
    url: `/?seed=${SEED}&screen=sortie`,
    keys: ['Space'],
    settleMs: 900,
  },
  {
    name: 'sortie-moving-firing',
    url: `/?seed=${SEED}&screen=sortie`,
    keys: ['Space', 'ArrowLeft'],
    settleMs: 700,
  },
]

/** Viewports: the common case, plus a small window to catch layout breakage. */
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 900 },
  { name: 'small', width: 900, height: 620 },
]

function startPreview() {
  const child = spawn(
    'npx',
    ['vite', 'preview', '--port', String(PORT), '--strictPort'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('vite preview did not start within 30s')),
      30_000,
    )
    const onData = (buffer) => {
      if (buffer.toString().includes(String(PORT))) {
        clearTimeout(timeout)
        resolve(child)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timeout)
      reject(new Error(`vite preview exited early with code ${code}`))
    })
  })
}

async function main() {
  const keepServer = process.argv.includes('--keep')

  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  const server = await startPreview()
  const browser = await chromium.launch()
  const failures = []

  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        colorScheme: 'dark',
        reducedMotion: 'no-preference',
      })
      const page = await context.newPage()

      // Surface anything the game logs as an error — a silent console exception
      // is exactly the kind of bug a screenshot alone would hide.
      page.on('pageerror', (error) => failures.push(`${viewport.name}: ${error.message}`))
      page.on('console', (message) => {
        if (message.type() === 'error') failures.push(`${viewport.name}: ${message.text()}`)
      })

      for (const shot of SHOTS) {
        await page.goto(`${BASE}${shot.url}`, { waitUntil: 'load' })
        // main() sets this once the loop is running; waiting on it avoids
        // capturing a blank first frame.
        await page.waitForSelector('body[data-ready="true"]', { timeout: 10_000 })

        for (const key of shot.keys ?? []) await page.keyboard.down(key)
        await page.waitForTimeout(shot.settleMs)

        const file = `${OUT_DIR}/${shot.name}--${viewport.name}.png`
        await page.screenshot({ path: file })
        for (const key of shot.keys ?? []) await page.keyboard.up(key)

        const state = await page.evaluate(() => {
          const api = window.__nextPilot
          return api ? { screen: api.screen, seed: api.seed, stats: api.stats } : null
        })
        console.log(
          `${file}  screen=${state?.screen ?? '?'} ticks=${state?.stats?.ticks ?? '?'} ` +
            `dropped=${state?.stats?.droppedTicks ?? '?'}`,
        )

        // A dropped tick in a quiet capture means the loop is already struggling.
        if ((state?.stats?.droppedTicks ?? 0) > 0) {
          failures.push(`${shot.name}/${viewport.name}: dropped ${state.stats.droppedTicks} ticks`)
        }
      }

      await context.close()
    }
  } finally {
    await browser.close()
    if (!keepServer) server.kill('SIGTERM')
  }

  if (failures.length > 0) {
    console.error('\nProblems detected:')
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exitCode = 1
    return
  }
  console.log(`\nCaptured ${SHOTS.length * VIEWPORTS.length} screenshots to ${OUT_DIR}/`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
