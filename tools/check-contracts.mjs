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
 *   node tools/check-contracts.mjs [srcRoot]
 *
 * `srcRoot` defaults to `src`. It exists so `tests/checkContracts.test.ts` can
 * point the checker at fixture trees — see "THIS FILE HAS ITS OWN TESTS" below.
 *
 * ---------------------------------------------------------------------------
 * THIS FILE HAS ITS OWN TESTS, and the reason is the whole point of R10.
 *
 * Three of contract 2's rules were unenforced for months while `npm run contracts`
 * printed "Contracts OK": `src/audio` was missing from the forbidden-import list
 * even though `src/audio/index.ts` tells its reader this checker forbids it, the
 * DOM/clock patterns were never applied to the `src/core/**` files the sim
 * imports, and a `from`-anchored regex cannot see `await import('../render/x')`.
 * All three were verified by hand: the import, the dynamic import and a
 * `performance.now()` in `src/core/loop.ts` each passed contracts *and* typecheck.
 *
 * An instrument with no test around it does not fail when it stops checking — it
 * goes quiet, which reads as success. `tests/checkContracts.test.ts` therefore
 * feeds this file one fixture per rule that MUST fail, plus a clean fixture and
 * the real `src/` tree that must both pass. Add a rule here, add a fixture there.
 * ---------------------------------------------------------------------------
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'

const ROOT = process.argv[2] ?? 'src'

const violations = []

/** Path as it should appear in output and in comparisons: relative, forward slashes. */
function display(path) {
  return relative('.', path).replaceAll('\\', '/')
}

async function walk(dir) {
  const out = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // A tree without, say, src/content is a valid fixture, not an error.
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(path)))
    else if (extname(entry.name) === '.ts') out.push(path)
  }
  return out
}

/** Report a violation with a line number so it is directly actionable. */
function flag(file, lineNumber, line, rule) {
  violations.push(`${display(file)}:${lineNumber}  ${rule}\n      ${line.trim()}`)
}

/**
 * Contract 1 — determinism.
 *
 * Unseeded randomness anywhere the simulation can reach breaks replays, seeded
 * runs, and the daily contract simultaneously. `src/core/seed.ts` is the one
 * legitimate exception: choosing *which* run to play is not simulating it.
 */
const RANDOM_EXEMPT = ['core/seed.ts']

/**
 * Contract 2 — the simulation never touches the outside world.
 *
 * Layers the sim may not reach, checked by RESOLVED PATH rather than by a regex
 * over the import line. Three reasons, each one a hole the previous version had:
 *
 *   - `src/audio` belongs here. It is a host concern exactly like rendering, it
 *     is driven by `SimEvent`s from the app layer, and `src/audio/index.ts`
 *     documents this checker as the thing that forbids reaching it from the sim.
 *   - `from '../audio'` names a directory, not a file, so a pattern demanding a
 *     trailing slash (`(?:render|ui)/`) misses the most natural way to write the
 *     violation.
 *   - `await import('../render/x')` and `require(...)` are imports too. Anchoring
 *     on `from` means the checker can be walked around by accident.
 */
const FORBIDDEN_LAYERS = ['render', 'ui', 'audio']

/** Which forbidden layer a resolved path lives in, or undefined. */
function layerOf(resolvedFile) {
  const rel = display(resolvedFile)
  return FORBIDDEN_LAYERS.find((layer) => {
    const dir = display(join(ROOT, layer))
    return rel === dir || rel.startsWith(`${dir}/`)
  })
}

/**
 * Every module specifier, whatever syntax introduces it: static `from`, a
 * side-effect `import '…'`, a dynamic `import('…')`, or `require('…')`.
 */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g

/** Static and type-only import statements, for working out WHICH names cross a boundary. */
const IMPORT_STATEMENT = /\bimport\s+(type\s+)?([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g

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
    String.raw`\b(?:requestAnimationFrame|requestIdleCallback|setTimeout|setInterval)\s*\(`,
    String.raw`\bperformance\s*[.[]`,
    String.raw`\bDate\s*\.\s*now\s*\(`,
    String.raw`\bnew\s+Date\s*\(`,
  ].join('|'),
)

const HOST_RULE =
  'CONTRACT 2: sim/content must not touch the DOM or any clock (it runs headless)'

/**
 * Blank out comments while preserving line count and column positions, so
 * reported line numbers still point at the real offending line.
 */
function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
  out = out.replace(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length))
  return out
}

/**
 * Resolve a relative specifier the way the bundler does: `./x` → `x.ts`, and a
 * bare directory → its `index.ts`. Returns null for a bare package specifier.
 */
async function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (extname(candidate) !== '.ts') continue
    try {
      const info = await stat(candidate)
      if (info.isFile()) return candidate
    } catch {
      /* try the next shape */
    }
  }
  return null
}

/** Which exported names a static import pulls in as *values* (types are erased). */
function valueImportsOf(clause) {
  const names = new Set()
  const braces = /\{([^}]*)\}/.exec(clause)
  const outside = clause.replace(/\{[^}]*\}/g, '').trim()

  // `import * as ns from 'x'` can reach every export, so nothing in the target is
  // narrowed by name. `default` likewise names one specific export.
  if (/\*\s*as\s+/.test(outside)) return '*'
  const defaultBinding = outside.replace(/,\s*$/, '').trim()
  if (defaultBinding) names.add('default')

  for (const raw of braces?.[1]?.split(',') ?? []) {
    const specifier = raw.trim()
    if (!specifier || /^type\s/.test(specifier)) continue
    const exported = specifier.split(/\s+as\s+/)[0]?.trim()
    if (exported) names.add(exported)
  }
  return names
}

/**
 * Split a file into top-level declarations by brace depth.
 *
 * Used only for `src/core/**` — see `checkCoreFile` for why the granularity has
 * to be finer there than a whole file.
 */
const DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/

function depthDelta(line) {
  const bare = line
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  let delta = 0
  for (const character of bare) {
    if (character === '{') delta++
    else if (character === '}') delta--
  }
  return delta
}

function topLevelChunks(codeLines) {
  const chunks = []
  let depth = 0
  for (let index = 0; index < codeLines.length; index++) {
    const line = codeLines[index] ?? ''
    if (depth <= 0 && /^\S/.test(line)) {
      const match = DECLARATION.exec(line)
      const keyword = match?.[1]
      chunks.push({
        kind: keyword ? (keyword.startsWith('function') ? 'function' : keyword) : 'statement',
        name: match?.[2] ?? null,
        start: index,
        end: index,
      })
    }
    const current = chunks.at(-1)
    if (current) current.end = index
    else chunks.push({ kind: 'statement', name: null, start: index, end: index })
    depth += depthDelta(line)
    if (depth < 0) depth = 0
  }
  return chunks
}

/**
 * The rule for `src/core/**`, and the one judgement call in this file.
 *
 * `src/core/**` is shared by the sim, the renderer AND the app layer, so it
 * legitimately contains things the sim must never reach: `FixedLoop` reads
 * `performance.now()` for its timing rings and `Keyboard` calls
 * `window.addEventListener`. Both are correct, both are host-side, and neither is
 * reachable from a headless run — the sim imports `TICK_HZ`, `TICK_SECONDS` and
 * `NEUTRAL_INPUT` and nothing else.
 *
 * So "core is sim-clean" is not the rule. It would fail on correct code today, and
 * a checker that is red on correct code gets switched off, which is how this class
 * of bug happens in the first place.
 *
 * The rule is: **whatever the sim can actually reach in a core file must be
 * sim-clean.** Two things can be reached, and they are treated differently:
 *
 *   1. Anything that runs at IMPORT time — a bare top-level statement, or a
 *      `const`/`let`/`var` initialiser. `import`ing the file executes these, so
 *      they are checked whether or not the sim names them. `export const BOOTED_AT
 *      = performance.now()` in `core/loop.ts` reaches the sim through `TICK_MS`.
 *   2. A `function` or `class` body, which runs only when called — checked when,
 *      and only when, some file in the sim's import closure imports that name as a
 *      value. Import `Keyboard` into the sim and its `window` access becomes a
 *      violation; leave it for the app layer and it does not.
 *
 * KNOWN LIMIT, stated rather than papered over: a sim-imported function that calls
 * a module-private helper which touches the host is not caught. Closing that needs
 * a call graph, not a line scanner. The two cases above are the ones that have
 * actually happened, and the module-scope half is the one that breaks headless
 * immediately rather than eventually.
 */
function checkCoreFile(file, raw, imported) {
  const code = stripComments(raw).split('\n')
  const source = raw.split('\n')

  for (const chunk of topLevelChunks(code)) {
    const runsOnImport = chunk.kind === 'statement' || ['const', 'let', 'var'].includes(chunk.kind)
    const named = imported === '*' || (chunk.name !== null && imported.has(chunk.name))
    if (!runsOnImport && !named) continue

    for (let index = chunk.start; index <= chunk.end; index++) {
      const line = code[index] ?? ''
      if (!line.trim()) continue
      if (!FORBIDDEN_SIM_GLOBALS.test(line)) continue
      const why = runsOnImport
        ? `${HOST_RULE} — runs when the sim imports this file`
        : `${HOST_RULE} — \`${chunk.name}\` is imported by the sim's closure`
      flag(file, index + 1, source[index] ?? line, why)
    }
  }
}

/** Full-file host check, for everything in the closure that is not shared with the host. */
function checkSimFile(file, raw) {
  const code = stripComments(raw).split('\n')
  const source = raw.split('\n')
  code.forEach((line, index) => {
    if (!line.trim()) return
    if (FORBIDDEN_SIM_GLOBALS.test(line)) flag(file, index + 1, source[index] ?? line, HOST_RULE)
  })
}

/**
 * Every module the simulation can reach, by following relative imports.
 *
 * Computed rather than assumed: the previous version checked `src/sim` and
 * `src/content` and stopped, so anything they imported was outside the contract
 * even though importing it is exactly how the sim reaches the outside world.
 * Returns the closure plus, per file, the value names imported from within it.
 */
async function importClosure(seeds) {
  const files = new Map()
  const importedNames = new Map()
  const queue = [...seeds]

  const note = (target, clause, typeOnly) => {
    const key = display(target)
    if (importedNames.get(key) === '*') return
    if (typeOnly) {
      if (!importedNames.has(key)) importedNames.set(key, new Set())
      return
    }
    const names = valueImportsOf(clause)
    if (names === '*') {
      importedNames.set(key, '*')
      return
    }
    const existing = importedNames.get(key)
    if (existing instanceof Set) for (const name of names) existing.add(name)
    else importedNames.set(key, names)
  }

  while (queue.length > 0) {
    const file = queue.pop()
    const key = display(file)
    if (files.has(key)) continue
    const raw = await readFile(file, 'utf8')
    files.set(key, { path: file, raw })
    const code = stripComments(raw)

    // Static clauses first, so a named import records WHAT it brought over.
    for (const match of code.matchAll(IMPORT_STATEMENT)) {
      const target = await resolveSpecifier(file, match[3] ?? '')
      if (target) note(target, match[2] ?? '', Boolean(match[1]))
    }

    // Then every specifier of any shape, for the layer check and the walk itself.
    const lines = code.split('\n')
    const source = raw.split('\n')
    for (const [index, line] of lines.entries()) {
      SPECIFIER.lastIndex = 0
      let match
      while ((match = SPECIFIER.exec(line)) !== null) {
        const specifier = match[1] ?? ''
        if (!specifier.startsWith('.')) continue
        const target = await resolveSpecifier(file, specifier)
        if (!target) {
          // An import the checker cannot resolve is a module it cannot check, and
          // silence there is the failure mode this whole file exists to prevent.
          flag(
            file,
            index + 1,
            source[index] ?? line,
            `CHECKER: cannot resolve '${specifier}' — the contract check cannot see this module`,
          )
          continue
        }
        const layer = layerOf(target)
        if (layer) {
          flag(
            file,
            index + 1,
            source[index] ?? line,
            `CONTRACT 2: the sim's import closure must not reach src/${layer} ` +
              `(static, dynamic or require — this is what lets the sim run headless)`,
          )
          // Report the crossing and stop there. Walking INTO the renderer would
          // then flag every import inside it, burying the one line at fault under
          // twenty consequences of it — and a report nobody reads to the end is
          // most of the way to a check nobody runs.
          continue
        }
        queue.push(target)
      }
    }
  }

  return { files, importedNames }
}

async function main() {
  const simDir = join(ROOT, 'sim')
  const contentDir = join(ROOT, 'content')
  const coreDir = join(ROOT, 'core')

  const simFiles = await walk(simDir)
  const seeds = [...simFiles, ...(await walk(contentDir))]
  const allFiles = await walk(ROOT)

  // The rules are about executable code. The codebase deliberately *documents*
  // these hazards in prose, so comments are blanked before matching.
  const exempt = new Set(RANDOM_EXEMPT.map((path) => display(join(ROOT, path))))
  for (const file of allFiles) {
    const raw = await readFile(file, 'utf8')
    const code = stripComments(raw).split('\n')
    const source = raw.split('\n')
    if (exempt.has(display(file))) continue

    code.forEach((line, index) => {
      if (!line.trim()) return
      if (/Math\.random\s*\(/.test(line)) {
        flag(
          file,
          index + 1,
          source[index] ?? line,
          'CONTRACT 1: Math.random() — use Rng from a named seed stream',
        )
      }
    })
  }

  // Contract 2. The closure walk itself reports forbidden-layer imports; the host
  // check then runs over every module the sim can reach, at the granularity that
  // module's role allows.
  const { files, importedNames } = await importClosure(seeds)
  const corePrefix = `${display(coreDir)}/`
  for (const [key, { path, raw }] of files) {
    if (key.startsWith(corePrefix)) {
      checkCoreFile(path, raw, importedNames.get(key) ?? new Set())
    } else {
      checkSimFile(path, raw)
    }
  }

  // `src/core/**` must not depend upward even where the sim cannot reach it: the
  // dependency arrow is core <- sim <- render/ui, and an unwired core module
  // (touch.ts, viewport.ts) becomes wired eventually.
  for (const file of await walk(coreDir)) {
    if (files.has(display(file))) continue
    const raw = await readFile(file, 'utf8')
    const code = stripComments(raw).split('\n')
    const source = raw.split('\n')
    for (const [index, line] of code.entries()) {
      SPECIFIER.lastIndex = 0
      let match
      while ((match = SPECIFIER.exec(line)) !== null) {
        const target = await resolveSpecifier(file, match[1] ?? '')
        if (!target) continue
        const layer = layerOf(target)
        if (layer) {
          flag(
            file,
            index + 1,
            source[index] ?? line,
            `CONTRACT 2: src/core must not import src/${layer} — the dependency arrow ` +
              `is core <- sim <- render/ui`,
          )
        }
      }
    }
  }

  // Contract 3 — the sim's only input is an InputSnapshot. A tick() that reads
  // anything else cannot be replayed from a recorded input log.
  for (const file of simFiles) {
    const source = await readFile(file, 'utf8')
    if (/\btick\s*\([^)]*\bKeyboard\b/.test(source)) {
      violations.push(
        `${display(file)}  CONTRACT 3: tick() must take an InputSnapshot, not a Keyboard`,
      )
    }
  }

  if (violations.length > 0) {
    console.error(`\nContract violations (${violations.length}):\n`)
    for (const violation of violations) console.error(`  - ${violation}`)
    console.error('\nSee CLAUDE.md — these three contracts are what make the game verifiable.\n')
    process.exit(1)
  }

  console.log(
    `Contracts OK — ${allFiles.length} source files checked, ` +
      `${files.size} of them reachable from the simulation (determinism, isolation, input).`,
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
