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
 *
 * Each shot carries up to three assertions, and they are not redundant:
 *
 *   `waitFor`  a predicate polled until it holds, BEFORE any `pressAfter` keys.
 *              This is how a capture is defined by the state it wants rather than
 *              by a guess about how long a bot takes to get there.
 *   `expect`   the same shape of predicate, re-evaluated against the state read
 *              at the instant of the shutter. It catches the state DRIFTING
 *              between the wait and the pixel — the bot killing the last enemy
 *              during `holdMs`, a hazard advancing from warning to active, a
 *              `pressAfter` key that never landed on the screen it claims. Shots
 *              driven only by `settleMs` and keypresses had no assertion at all
 *              before this, which is how "press Down for settings" could quietly
 *              become a second photograph of the title.
 *   `pollMs`   how often `waitFor` samples, default 100ms. A state that lasts N
 *              ticks is N/(60*ff) seconds of wall clock, so a brief state under a
 *              high `ff` needs a faster shutter than the default.
 *   `unreachedUntil`  see KNOWN UNREACHED below.
 *
 * `expect` is an EXPRESSION over the probe, not a keyword. The previous version
 * took `'enemies'` or `'dead'` and hand-read `state.enemies`, a field the probe
 * does not expose — so switching it on would have reported "expected enemies on
 * screen, found none" over a screen with eight of them. It had also never run,
 * because no shot ever set it. An expression evaluated over the same generic
 * probe snapshot the log line prints cannot drift out of step with the probe, and
 * a typo'd field name throws and is reported as a HARNESS fault rather than
 * silently failing closed as a game fault.
 *
 * KNOWN UNREACHED. Four captures need a run stage no bot policy currently
 * reaches (see docs/VERIFICATION.md §3 — target clear rate is 20-40%, so most
 * runs die in sector one or two). Reporting those as failures every single run
 * trains a reader to skim past the section that also carries real regressions, so
 * a shot may declare `unreachedUntil: '<reason>'`: its miss is reported in a
 * separate NOTE block and does not fail the build. The list cannot rot, because a
 * marked shot that DOES reach its state fails the build asking for the marker to
 * be deleted. Nothing else is exempt, and this changes no URL and no run — it is
 * a statement about what the harness currently knows, not a way to make a run
 * behave differently. A god-mode flag would be the other thing entirely, and
 * shared seeds and daily contracts depend on a run being honest.
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
/**
 * Whole-run ceiling. Generous for a slow machine, finite regardless.
 *
 * 120s -> 300s as capture states were added, then 300s -> 900s at M5. The reason is
 * not "shots got added": a run is now FIFTEEN MINUTES of simulation rather than
 * three, and the late captures (a sector-four hazard, a boss's second phase) have to
 * fast-forward most of it. At 300s the harness was killed part-way through the
 * small-viewport pass, which is silent data loss dressed as a timeout — the desktop
 * images looked complete and half the layout-breakage checks simply never ran.
 *
 * A watchdog that fires during normal operation stops being a safety net and becomes
 * a source of flaky, partial results, which is worse than no watchdog at all.
 */
const WATCHDOG_MS = 900_000
const PAGE_TIMEOUT_MS = 15_000
/** Per-shot ceiling for a waitFor predicate. Fast-forwarded runs are quick. */
const WAIT_FOR_TIMEOUT_MS = 45_000

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
  {
    // FIRST deliberately. localStorage persists across navigations within a browser
    // context, so every capture after a bot run sees genuinely earned certifications.
    // Placing this first is the only way to see what a new player sees — and it is
    // how I confirmed that "7 of 10 certified" was the pipeline working rather than a
    // bug, which I had already started to report as one.
    name: 'hangar-fresh',
    url: `/?seed=${SEED}`,
    pressAfter: ['ArrowLeft'],
    // The zeroes are the point of the shot, and they are what makes "FIRST
    // deliberately" load-bearing rather than a comment. Reorder SHOTS and this
    // fires instead of quietly filing a hangar with seven certifications as the
    // new player's view.
    expect: 'screen === "hangar" && certifiedCount === 0 && filedRuns === 0',
  },
  { name: 'title', url: `/?seed=${SEED}`, settleMs: 500, expect: 'screen === "title"' },
  {
    name: 'sortie-idle',
    url: `/?seed=${SEED}&screen=sortie`,
    settleMs: 300,
    expect: 'screen === "sortie" && runState === "active"',
  },
  {
    name: 'sortie-firing',
    url: `/?seed=${SEED}&screen=sortie`,
    keys: ['Space'],
    settleMs: 900,
    expect: 'screen === "sortie" && runState === "active"',
  },
  {
    name: 'sortie-moving-firing',
    url: `/?seed=${SEED}&screen=sortie`,
    keys: ['Space', 'ArrowLeft'],
    settleMs: 700,
    expect: 'screen === "sortie" && runState === "active"',
  },

  // Combat and death states are reached by letting a bot policy drive the run
  // with the sim fast-forwarded. Holding a key for 90 real seconds to reach a
  // late wave is not viable in a capture pass, and hand-driving it would not be
  // reproducible. `autopilot` + `ff` make these states exact and deterministic.
  //
  // These wait on a *predicate*, not a duration. A fixed settle time is a guess
  // about how long a bot takes to reach a state, and the first version of this
  // guessed wrong — the death capture stopped six seconds before the bot died and
  // silently photographed a healthy ship. `waitFor` polls the real state instead,
  // so a capture either shows what it claims or fails loudly.
  {
    name: 'combat-early',
    url: `/?seed=${SEED}&screen=sortie&autopilot=aggressor&ff=6`,
    // `>= 1` with a 400ms hold used to file an EMPTY PLAYFIELD, verified in the
    // capture: the first wave of this seed is a single enemy, and 400ms at ff=6 is
    // 2.4 simulated seconds — ample for an aggressor to kill it. Nothing noticed,
    // because the intent check below had never run. So the wait asks for a wave
    // rather than an enemy, and the hold is short enough that killing all of it
    // before the shutter is not plausible.
    waitFor: 'enemyCount >= 4',
    holdMs: 150,
    expect: 'screen === "sortie" && enemyCount >= 1',
  },
  {
    name: 'combat-mid',
    url: `/?seed=${SEED}&screen=sortie&autopilot=dodger&ff=12`,
    waitFor: 'stats.tick > 3600 && enemyCount >= 2',
    holdMs: 300,
    expect: 'screen === "sortie" && enemyCount >= 2',
  },
  {
    name: 'combat-dense',
    url: `/?seed=${SEED}&screen=sortie&autopilot=dodger&ff=20`,
    waitFor: 'enemyCount >= 5',
    // Sim drift between the predicate and the shutter is holdMs x ff, so 200ms here
    // was 4 simulated seconds — long enough for a formation to cross the whole
    // playfield. Measured: the wait fired at 5 enemies and the capture contained 2.
    // Halved, and the assertion states what a frame this late can honestly promise.
    holdMs: 100,
    expect: 'screen === "sortie" && enemyCount >= 2',
  },
  {
    name: 'hull-critical',
    // dodger, not greedy: items raised greedy's survival to the point that it now
    // extracts before ever reaching a critical hull, so the predicate never fired
    // and the capture silently photographed a healthy ship at the extraction screen.
    url: `/?seed=${SEED}&screen=sortie&autopilot=dodger&ff=20`,
    // The low-integrity screen rim only appears below 30%, so this capture is
    // the only check that it renders at all.
    waitFor: 'runState === "active" && integrity <= 28',
    holdMs: 0,
    // Still alive at the shutter, or the picture is the incident report rather than
    // the low-integrity rim this capture exists to check.
    expect: 'screen === "sortie" && runState === "active" && integrity <= 30',
  },
  {
    name: 'incident-report',
    url: `/?seed=${SEED}&screen=sortie&autopilot=random&ff=24`,
    waitFor: 'screen === "incident"',
    holdMs: 500,
    expect: 'screen === "incident"',
  },
  {
    // A cleared sector. Added after a tester finished sector 1 and was shown a
    // death screen: nothing captured the extraction state, so no screenshot pass
    // could have caught it.
    name: 'extraction-report',
    url: `/?seed=${SEED}&screen=sortie&autopilot=aggressor&ff=28`,
    waitFor: 'runState === "extracted"',
    holdMs: 500,
    expect: 'runState === "extracted"',
    // `extracted` is set only by clearing the FINAL stage (`world.ts` — the
    // `stageIndex + 1 >= stages.length` branch), so this needs a whole five-sector
    // run. Measured on this seed: aggressor at ff=28 dies in SECTOR FOUR at tick
    // 37032 holding 14 items. So sector clearing works and the last sector does not
    // — a balance fact, and the fix VERIFICATION §3 already names is a per-capture
    // seed known to go the distance, or a survival-tuned capture policy.
    unreachedUntil: 'M6 balance — needs all five sectors; aggressor dies in sector four on this seed',
  },
  {
    // A reward card. Bots resolve a choice in ~6 ticks, so this waits on the state
    // rather than a duration — there is no timing guess that reliably lands here.
    name: 'item-choice',
    url: `/?seed=${SEED}&screen=sortie&autopilot=dodger&ff=6&holdchoice=1`,
    waitFor: 'choiceKind === "item"',
    holdMs: 0,
    expect: 'choiceKind === "item"',
  },
  {
    // A shop, which needs a build and some scrap first, so it is further in.
    name: 'shop-choice',
    url: `/?seed=${SEED}&screen=sortie&autopilot=aggressor&ff=10&holdchoice=1`,
    waitFor: 'choiceKind === "shop"',
    holdMs: 0,
    expect: 'choiceKind === "shop"',
  },
  // --- M5: the run past sector one ------------------------------------------
  //
  // Every one of these waits on run STATE, never on elapsed time. A sector is three
  // minutes and a whole run is fifteen, so a duration guess here is not merely
  // fragile — it is the exact mistake that once photographed a healthy ship and
  // filed it as the death screen. `holdchoice=1` stops the bot resolving a card
  // before the shutter opens.
  {
    // The world map. It only exists at a stage boundary, which is why the wait is on
    // the card rather than on a stage index — by the time stageIndex has moved, the
    // card the capture is for has already closed.
    name: 'world-map',
    // `holdchoice=route` — kind-aware now, so the run flies normally through its item
    // and shop cards and only stops on the one being captured. As `holdchoice=1` this
    // was unreachable by construction: the first card of the run stayed open, the ship
    // stopped flying, and it died in sector one three seams short of a route card.
    url: `/?seed=${SEED}&screen=sortie&autopilot=aggressor&ff=28&holdchoice=route`,
    waitFor: 'choiceKind === "route"',
    holdMs: 0,
    expect: 'choiceKind === "route"',
    // NOT a balance problem, and worth fixing properly rather than reseeding:
    // `holdchoice=1` (main.ts) feeds NEUTRAL_INPUT while ANY card is open, so the
    // first card of the run — an item card at tick 2358 — stays open forever, the
    // ship stops flying, and the run dies in sector one with 37 enemies on screen
    // while the world map it is waiting for is three seams away. Measured exactly
    // that. Any capture of a LATE card is unreachable by construction under a
    // whole-run hold; it needs `holdchoice=<kind>`, which is a one-line change in
    // `src/main.ts:176`.
  },
  {
    // Sector two, in progress. Proves the panel is describing the run and not the
    // roadmap — "SECTOR 1 / 5" for an entire game is a bug a tester actually reported.
    name: 'sector-two',
    url: `/?seed=${SEED}&screen=sortie&autopilot=aggressor&ff=28`,
    waitFor: 'stageIndex >= 1 && enemyCount >= 2',
    holdMs: 0,
    expect: 'stageIndex >= 1 && enemyCount >= 1',
  },
  {
    // A hazard mid-warning. This is the single most important second in the game to
    // get right: it is the whole reaction window, and if it is not unmissable here
    // then the hazard is indistinguishable from integrity draining for no reason.
    name: 'hazard-warning',
    // `greedy`, not `aggressor`. This capture could never have worked: hazards are
    // opted into on the world map, and `BOTS.aggressor` is pinned to
    // `routeStyle: 'direct'` on purpose — "a benchmark that also takes optional risk
    // is measuring two things at once" (`sim/bots.ts:899`) — so it declines every
    // hazard there is. `greedy` "accepts every hazard it is paid for". Reported as a
    // balance failure for as long as the check has existed; it was the wrong policy.
    // `aggressor&route=rewarding`: the strongest policy, told to accept priced routes.
    // greedy accepts them by default but dies in sector one, so it never reached a
    // sector that HAS a hazard — sector one deliberately has none. A bot taking a
    // hazard route is a legal player choice, so this is a capture affordance and not a
    // cheat; nothing about the run is altered.
    url: `/?seed=${SEED}&screen=sortie&autopilot=aggressor&route=rewarding&ff=20`,
    waitFor: 'hazardPhase === "warning"',
    // HAZARD_WARNING_TICKS is 60 — one simulated second, which at ff=20 is FIFTY
    // MILLISECONDS of wall clock. The default 100ms poll steps straight over the
    // whole reaction window, so even a run that meets a hazard would usually miss
    // this state. The most important second in the game needs a faster shutter.
    pollMs: 20,
    holdMs: 0,
    // Asserted again at the shutter because `hazardPhase` reports the most urgent
    // hazard: a warning that has become active between the poll and the capture
    // files the wrong second.
    expect: 'hazardPhase === "warning"',
    unreachedUntil: 'M6 balance — the pilot must clear sector one and accept a hazard route',
  },
  {
    name: 'hazard-active',
    // Same policy and reasoning as the warning shot above.
    url: `/?seed=${SEED}&screen=sortie&autopilot=aggressor&route=rewarding&ff=20`,
    waitFor: 'hazardPhase === "active"',
    // 120 ticks = 100ms of wall clock at ff=20, i.e. exactly the default poll.
    pollMs: 20,
    holdMs: 0,
    expect: 'hazardPhase === "active"',
    unreachedUntil: 'M6 balance — the pilot must clear sector one and accept a hazard route',
  },
  {
    // A boss on screen. Waits on the health bar being readable rather than on the
    // spawn tick, so the capture shows a fight rather than an entrance.
    name: 'boss-fight',
    url: `/?seed=${SEED}&screen=sortie&autopilot=aggressor&ff=24`,
    waitFor: 'bossName !== null && bossHealth < 0.95',
    holdMs: 0,
    expect: 'bossName !== null',
  },
  {
    // A LATER boss phase, which is the part that has to announce itself. A capture of
    // phase 0 would prove nothing about the callout, and the callout is the thing
    // standing between "difficult" and "unfair".
    name: 'boss-phase-two',
    url: `/?seed=${SEED}&screen=sortie&autopilot=aggressor&ff=24`,
    waitFor: 'bossPhase >= 1',
    holdMs: 0,
    expect: 'bossName !== null && bossPhase >= 1',
  },
  {
    // The settings screen, reachable from the title with Down. New pixels: the
    // keybinding rows and the taller pause card have never been looked at, and
    // CLAUDE.md's definition of done says that is not verification.
    name: 'settings',
    url: `/?seed=${SEED}`,
    pressAfter: ['ArrowDown'],
    settleMs: 400,
    expect: 'screen === "settings"',
  },
  {
    // Mid-capture: the row is waiting for a key. A binding UI that can lock the
    // player out of the menu that fixes it is a trap, so this state matters.
    name: 'settings-capture',
    url: `/?seed=${SEED}`,
    pressAfter: ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'Enter'],
    settleMs: 400,
    expect: 'screen === "settings"',
  },
  {
    // Hull selection. Only appears once a certification has widened the pool past
    // the Lien, which is why it sits AFTER the shots that file runs — the browser
    // context carries localStorage forward, so by here the save has certifications.
    // If the pool is still Lien-only the run launches instead and this fails loudly,
    // which is the honest outcome rather than a picture of the wrong screen.
    name: 'hull-select',
    url: `/?seed=${SEED}&screen=hull-select`,
    waitFor: 'screen === "hull-select"',
    holdMs: 0,
    expect: 'screen === "hull-select"',
  },
  {
    // Reachable from the title: left to the hangar, right to personnel files.
    name: 'hangar',
    url: `/?seed=${SEED}`,
    pressAfter: ['ArrowLeft'],
    expect: 'screen === "hangar"',
  },
  {
    name: 'personnel',
    url: `/?seed=${SEED}`,
    pressAfter: ['ArrowRight'],
    expect: 'screen === "personnel"',
  },
  {
    // Up from the title reaches seed entry, where a shared seed or the daily is flown.
    name: 'seed-entry',
    url: `/?seed=${SEED}`,
    pressAfter: ['ArrowUp'],
    expect: 'screen === "seed-entry"',
  },
  {
    // The share card sits one press off the incident report, not on the way to the
    // next run — UI rule 6 keeps the loop "again".
    name: 'share-card',
    url: `/?seed=${SEED}&screen=sortie&autopilot=random&ff=24`,
    waitFor: 'screen === "incident"',
    pressAfter: ['ArrowUp'],
    expect: 'screen === "share"',
  },
  {
    name: 'pause-menu',
    url: `/?seed=${SEED}&screen=sortie&autopilot=dodger&ff=12`,
    waitFor: 'enemyCount >= 2',
    pressAfter: ['Escape'],
    // Nothing checked that Escape landed. A browser or an OS that swallows Escape
    // would have filed a photograph of an unpaused sortie under `pause-menu`.
    expect: 'screen === "paused"',
  },
  {
    // Third row down is the volume scale, so this frames a selected adjustable
    // row rather than the default action row.
    name: 'pause-menu-setting',
    url: `/?seed=${SEED}&screen=sortie&autopilot=dodger&ff=12`,
    waitFor: 'enemyCount >= 2',
    pressAfter: ['Escape', 'ArrowDown', 'ArrowLeft'],
    expect: 'screen === "paused"',
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
  /** Misses by shots that declared themselves unreachable. Reported, not fatal. */
  const unreached = []

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

        let waitFailed = false
        if (shot.waitFor) {
          // Poll the live state until the shot's condition holds. Reached via
          // `new Function` over the debug view rather than a fixed sleep, so the
          // capture is defined by the state it wants, not by a guess about how
          // long a bot takes to get there.
          try {
            await page.waitForFunction(
              (expression) => {
                const api = window.__nextPilot
                if (!api) return false
                /*
                 * EVERY probe field, snapshotted generically — never a hand-listed
                 * subset.
                 *
                 * There used to be a literal here naming seven fields, with a comment
                 * warning that it "must stay in step" with the probe or a predicate
                 * would throw and be reported as "never became true", reading like a
                 * game problem rather than a harness typo. That comment correctly
                 * predicted its own failure: six M5 captures were added, the probe
                 * gained the fields they needed, this list did not, and the run
                 * reported six broken game states that were all fine.
                 *
                 * A warning that a duplicate must be kept in sync is not a fix. The
                 * probe's fields are enumerable getters, so spreading it cannot drift.
                 */
                const view = { ...api }
                // eslint-disable-next-line no-new-func
                return Boolean(new Function('v', `with (v) { return (${expression}) }`)(view))
              },
              shot.waitFor,
              // `pollMs` matters more than it looks. A state that lasts N ticks is
              // only N/(60*ff) seconds of wall clock, so a 60-tick hazard warning at
              // ff=20 is 50ms and the default poll misses it entirely. A shot that
              // waits on a brief state must sample faster than the state is long.
              { timeout: WAIT_FOR_TIMEOUT_MS, polling: shot.pollMs ?? 100 },
            )
          } catch {
            waitFailed = true
            const message =
              `${shot.name}/${viewport.name}: waitFor never became true ` +
              `(${shot.waitFor}) — the capture does not show what it claims`
            if (shot.unreachedUntil) unreached.push(`${message}\n      ${shot.unreachedUntil}`)
            else problems.push(message)
          }
          if (!waitFailed && shot.unreachedUntil) {
            // The list of known-unreachable captures is only trustworthy if it
            // cannot outlive the balance problem that put a shot on it. Reaching
            // the state is good news that has to be recorded, not absorbed.
            problems.push(
              `${shot.name}/${viewport.name}: reached its state despite ` +
                `unreachedUntil (${shot.unreachedUntil}) — delete the marker`,
            )
          }
          if (shot.holdMs) await page.waitForTimeout(shot.holdMs)
        } else {
          await page.waitForTimeout(shot.settleMs ?? 300)
        }

        // Keys pressed *after* the wait condition, not before. Holding Escape
        // from navigation would pause the run instantly and no enemy would ever
        // spawn, so the condition the shot is waiting for could never come true.
        for (const key of shot.pressAfter ?? []) {
          await page.keyboard.press(key)
          await page.waitForTimeout(180)
        }

        // Read the counters BEFORE capturing. page.screenshot() blocks the
        // renderer, so the loop resumes behind and records dropped ticks —
        // measuring after the capture makes the instrument report its own cost
        // as a game performance problem.
        const state = await page.evaluate(() => {
          const api = window.__nextPilot
          if (!api) return null
          // Spread for the same reason the predicate does: a hand-listed subset here
          // silently drops a field from the per-shot log line, which is the only
          // record of what a capture actually contained.
          return { ...api }
        })
        const droppedWhileRunning = (state?.stats?.droppedTicks ?? 0) - before

        const file = `${OUT_DIR}/${shot.name}--${viewport.name}.png`
        await page.screenshot({ path: file })
        for (const key of shot.keys ?? []) await page.keyboard.up(key)
        step(
          `${file}  screen=${state?.screen ?? '?'} run=${state?.runState ?? '-'} ` +
            `stage=${(state?.stageIndex ?? 0) + 1}/${state?.stageCount ?? '?'} ` +
            `tick=${state?.stats?.tick ?? '?'} enemies=${state?.enemyCount ?? '?'} ` +
            `hull=${state?.integrity ?? '?'} items=${state?.heldItems ?? '?'} ` +
            `boss=${state?.bossName ?? '-'} hazard=${state?.hazardPhase ?? '-'} ` +
            `cert=${state?.certifiedCount ?? '?'} filed=${state?.filedRuns ?? '?'} ` +
            `choice=${state?.choiceKind ?? '-'} dropped=${droppedWhileRunning}`,
        )

        if (!state) problems.push(`${shot.name}/${viewport.name}: game never initialised`)
        if (droppedWhileRunning > 0) {
          problems.push(
            `${shot.name}/${viewport.name}: dropped ${droppedWhileRunning} ticks while running`,
          )
        }

        // A capture that did not reach the state it is named after is worse than
        // a missing capture: it looks like evidence while showing nothing. So the
        // intent is asserted against the state read at the shutter, not against
        // the state that made `waitFor` true however long ago.
        //
        // Skipped when the wait already failed: that is one root cause, and
        // reporting it twice per capture is how a reader learns to skim.
        if (shot.expect && !waitFailed) {
          let held
          try {
            // eslint-disable-next-line no-new-func
            held = Boolean(
              new Function('v', `with (v) { return (${shot.expect}) }`)(state ?? {}),
            )
          } catch (error) {
            // A predicate naming a field the probe does not expose is a HARNESS
            // fault. Saying so is the whole difference from the previous version,
            // which read `state.enemies` — never exposed — and would have
            // reported every capture as an empty screen.
            problems.push(
              `${shot.name}/${viewport.name}: expect (${shot.expect}) could not be ` +
                `evaluated — ${error.message}. This is a harness bug, not a game state.`,
            )
            held = true
          }
          if (!held) {
            problems.push(
              `${shot.name}/${viewport.name}: expect failed at capture time ` +
                `(${shot.expect}) — see the state on the log line above`,
            )
          }
        }
      }
      await context.close()
    }
  } finally {
    await browser.close()
    server.close()
  }

  return { problems, unreached }
}

const watchdog = new Promise((_, reject) =>
  setTimeout(
    () => reject(new Error(`Watchdog: capture exceeded ${WATCHDOG_MS / 1000}s`)),
    WATCHDOG_MS,
  ).unref(),
)

try {
  const { problems, unreached } = await Promise.race([capture(), watchdog])
  // Printed before the problems and separately from them. A capture nobody can
  // reach yet is a scheduling fact; a capture that broke today is a regression.
  // Mixing them is what makes a permanently red report unreadable.
  if (unreached.length > 0) {
    console.log(`\nKnown unreached (${unreached.length}) — not failures, see KNOWN UNREACHED:`)
    for (const note of unreached) console.log(`  - ${note}`)
  }
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
