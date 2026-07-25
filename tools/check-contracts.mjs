/**
 * Enforces the three architectural contracts from CLAUDE.md.
 *
 * These were prose that everyone agreed to and nothing checked. Each one is
 * silently breakable in a single line, and each break invalidates the project's
 * entire verification story — a `Math.random()` in sim code makes every recorded
 * replay meaningless, and it would pass typecheck and every existing test.
 *
 * So they run in CI and in `npm run check`. Cheap, static, no false comfort.
 *
 *   node tools/check-contracts.mjs
 */

import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

const violations = []

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else if (extname(entry.name) === '.ts') out.push(path)
  }
  return out
}

/** Report a violation with a line number so it is directly actionable. */
function flag(file, lineNumber, line, rule) {
  violations.push(`${relative('.', file)}:${lineNumber}  ${rule}\n      ${line.trim()}`)
}

/**
 * Contract 1 — determinism.
 *
 * Unseeded randomness anywhere the simulation can reach breaks replays, seeded
 * runs, and the daily contract simultaneously. `src/core/seed.ts` is the one
 * legitimate exception: choosing *which* run to play is not simulating it.
 */
const RANDOM_EXEMPT = ['src/core/seed.ts']

/**
 * Contract 2 — the simulation never touches the outside world.
 *
 * If sim code can reach the DOM, a renderer, or a clock, it cannot run headless,
 * and bot playtests plus replay regression both stop working. src/sim/bots.ts is
 * simulation-adjacent tooling and is held to the same rule.
 */
const FORBIDDEN_SIM_IMPORTS = /from\s+['"](?:\.\.\/)+(?:render|ui)\//

/**
 * Match actual *use* of a host global, not the mere appearance of its name.
 *
 * The first version of this matched a bare `\bwindow\b`, which flagged the phrase
 * "invulnerability window" in a doc comment. A checker that cries wolf on English
 * prose gets disabled within a week, so every pattern here requires the syntax of
 * real access: a member lookup, a call, or a construction.
 */
const FORBIDDEN_SIM_GLOBALS = new RegExp(
  [
    String.raw`\b(?:document|window|globalThis|localStorage|sessionStorage|navigator)\s*[.[]`,
    String.raw`\b(?:requestAnimationFrame|setTimeout|setInterval)\s*\(`,
    String.raw`\bperformance\s*\.\s*now\s*\(`,
    String.raw`\bDate\s*\.\s*now\s*\(`,
    String.raw`\bnew\s+Date\s*\(`,
  ].join('|'),
)

/**
 * Blank out comments while preserving line count and column positions, so
 * reported line numbers still point at the real offending line.
 */
function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' '),
  )
  out = out.replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length))
  return out
}

async function main() {
  const simFiles = await walk('src/sim')
  const contentFiles = await walk('src/content')
  const allFiles = await walk('src')

  // The rules are about executable code. The codebase deliberately *documents*
  // these hazards in prose, so comments are blanked before matching.
  for (const file of allFiles) {
    const raw = await readFile(file, 'utf8')
    const code = stripComments(raw).split('\n')
    const source = raw.split('\n')
    const rel = relative('.', file).replaceAll('\\', '/')

    code.forEach((line, index) => {
      if (!line.trim()) return
      if (/Math\.random\s*\(/.test(line) && !RANDOM_EXEMPT.includes(rel)) {
        flag(
          file,
          index + 1,
          source[index] ?? line,
          'CONTRACT 1: Math.random() — use Rng from a named seed stream',
        )
      }
    })
  }

  for (const file of [...simFiles, ...contentFiles]) {
    const raw = await readFile(file, 'utf8')
    const code = stripComments(raw).split('\n')
    const source = raw.split('\n')

    code.forEach((line, index) => {
      if (!line.trim()) return
      const original = source[index] ?? line

      if (FORBIDDEN_SIM_IMPORTS.test(line)) {
        flag(file, index + 1, original, 'CONTRACT 2: sim/content must not import render or ui')
      }
      if (FORBIDDEN_SIM_GLOBALS.test(line)) {
        flag(
          file,
          index + 1,
          original,
          'CONTRACT 2: sim/content must not touch the DOM or any clock (it runs headless)',
        )
      }
    })
  }

  // Contract 3 — the sim's only input is an InputSnapshot. A tick() that reads
  // anything else cannot be replayed from a recorded input log.
  for (const file of simFiles) {
    const source = await readFile(file, 'utf8')
    if (/\btick\s*\([^)]*\bKeyboard\b/.test(source)) {
      violations.push(
        `${relative('.', file)}  CONTRACT 3: tick() must take an InputSnapshot, not a Keyboard`,
      )
    }
  }

  if (violations.length > 0) {
    console.error(`\nContract violations (${violations.length}):\n`)
    for (const violation of violations) console.error(`  - ${violation}`)
    console.error('\nSee CLAUDE.md — these three contracts are what make the game verifiable.\n')
    process.exit(1)
  }

  const checked = allFiles.length
  console.log(`Contracts OK — ${checked} source files checked (determinism, isolation, input).`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
