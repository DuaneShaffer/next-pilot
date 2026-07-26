/**
 * Tests for the contract checker itself.
 *
 * WHY THIS FILE EXISTS. `tools/check-contracts.mjs` is the instrument every other
 * instrument stands on: replays, bot sweeps and the state digest all require the
 * sim to run headless and deterministically, and the checker is the only thing
 * asserting that it still can. It had no tests, and three of its rules had quietly
 * stopped being rules — `src/audio` was absent from the forbidden-import list that
 * `src/audio/index.ts` promises its reader, the DOM/clock patterns were never
 * applied to the `src/core/**` files the sim imports, and a `from`-anchored regex
 * could not see `await import('../render/x')`. `npm run contracts` printed
 * "Contracts OK" throughout. That is the failure mode: an unchecked checker does
 * not go red when it breaks, it goes quiet.
 *
 * So every rule gets a fixture that MUST fail, plus a clean fixture that must
 * pass, plus the real `src/` tree — because a checker that only ever passes and a
 * checker that only ever fails are equally useless. Add a rule to the checker, add
 * a fixture here.
 *
 * The fixtures are tiny trees mirroring the real layout, which is why the checker
 * takes a root argument. They are deliberately NOT typechecked or executed: the
 * question is only what the checker says about the text.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHECKER = fileURLToPath(new URL('../tools/check-contracts.mjs', import.meta.url))

const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function runChecker(root: string): { code: number; output: string } {
  const result = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' })
  return { code: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/**
 * A minimal but *realistic* src tree.
 *
 * `core/loop.ts` and `core/input.ts` matter most: they carry genuine host access
 * (`performance.now()`, `window.addEventListener`) inside declarations the sim does
 * not import, exactly as the real files do. The clean case asserts the checker
 * stays quiet about them — a rule that fires on correct code gets switched off,
 * which is how the holes it now catches were tolerated for months.
 */
const CLEAN_TREE: Record<string, string> = {
  'core/space.ts': `export const PLAYFIELD_W = 448\nexport const PLAYFIELD_H = 720\n`,
  'core/seed.ts': `export function generateSeed(): string {\n  return Math.random().toString(36).slice(2)\n}\n`,
  'core/rng.ts': `export class Rng {\n  next(): number {\n    return 0.5\n  }\n}\n`,
  'core/loop.ts': `export const TICK_HZ = 60\nexport const TICK_SECONDS = 1 / TICK_HZ\n\nfunction defaultClock(): () => number {\n  return () => performance.now()\n}\n\nexport class FixedLoop {\n  advance(nowMs: number): void {\n    const clock = defaultClock()\n    window.addEventListener('blur', () => clock())\n    void nowMs\n  }\n}\n`,
  'core/input.ts': `export interface InputSnapshot {\n  readonly fire: boolean\n}\n\nexport const NEUTRAL_INPUT: InputSnapshot = { fire: false }\n\nexport class Keyboard {\n  attach(): void {\n    window.addEventListener('keydown', () => {})\n  }\n}\n`,
  // Unwired core groundwork, like the real touch.ts/viewport.ts: outside the sim's
  // closure, so host access here is legitimate.
  'core/touch.ts': `export function attachTouch(): void {\n  document.body.addEventListener('touchstart', () => {})\n}\n`,
  'content/types.ts': `export interface EnemyDef {\n  readonly hp: number\n}\n`,
  'content/enemies.ts': `import { PLAYFIELD_W } from '../core/space'\nimport type { EnemyDef } from './types'\n\nexport const ENEMIES: readonly EnemyDef[] = [{ hp: PLAYFIELD_W / 8 }]\n`,
  'sim/world.ts': `import { TICK_HZ, TICK_SECONDS } from '../core/loop'\nimport { NEUTRAL_INPUT } from '../core/input'\nimport type { InputSnapshot } from '../core/input'\nimport { Rng } from '../core/rng'\nimport { ENEMIES } from '../content/enemies'\n\n/**\n * The invulnerability window after a hit, in ticks. Prose naming a host global\n * must not be flagged — see the checker's note on crying wolf.\n */\nconst INVULN_TICKS = TICK_HZ\n\nexport class World {\n  private readonly rng = new Rng()\n\n  tick(input: InputSnapshot = NEUTRAL_INPUT): void {\n    void input\n    void INVULN_TICKS\n    void TICK_SECONDS\n    void ENEMIES\n    void this.rng\n  }\n}\n`,
  'render/scene.ts': `export function draw(): void {\n  document.querySelector('canvas')\n}\n`,
  'ui/menu.ts': `export function menu(): void {\n  window.alert('hi')\n}\n`,
  'audio/index.ts': `export function createAudioDirector(): object {\n  return { unlock: () => performance.now() }\n}\n`,
  'main.ts': `import { FixedLoop } from './core/loop'\nimport { Keyboard } from './core/input'\nimport { draw } from './render/scene'\nimport { createAudioDirector } from './audio'\nimport { World } from './sim/world'\n\nvoid [FixedLoop, Keyboard, draw, createAudioDirector, World]\n`,
}

/** Write a fixture tree, applying overrides on top of the clean one. */
function fixture(overrides: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'next-pilot-contracts-'))
  temporaryRoots.push(root)
  for (const [path, contents] of Object.entries({ ...CLEAN_TREE, ...overrides })) {
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, contents)
  }
  return root
}

/** Append a line to a fixture file, keeping the rest of the realistic tree intact. */
function withAppended(path: string, line: string): Record<string, string> {
  const base = CLEAN_TREE[path]
  if (base === undefined) throw new Error(`no clean fixture for ${path}`)
  return { [path]: `${base}${line}\n` }
}

describe('the checker passes what it should', () => {
  it('accepts a clean tree, including host code in core that the sim does not import', () => {
    const { code, output } = runChecker(fixture())
    expect(output).toContain('Contracts OK')
    expect(code).toBe(0)
  })

  it('accepts the real src/ tree', () => {
    // Guards the other direction: a rule that false-positives on shipped code is
    // a rule someone deletes. This is the same run `npm run contracts` makes.
    const result = spawnSync(process.execPath, [CHECKER, 'src'], {
      encoding: 'utf8',
      cwd: fileURLToPath(new URL('..', import.meta.url)),
    })
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain('Contracts OK')
    expect(result.status).toBe(0)
  })

  it('does not flag a doc comment that merely names a host global', () => {
    // "invulnerability window" is a real regression: the first version of the
    // globals pattern matched a bare \bwindow\b and flagged English prose.
    const { output } = runChecker(fixture(withAppended('sim/world.ts', '// window.document?')))
    expect(output).toContain('Contracts OK')
  })

  it('exempts core/seed.ts from the Math.random ban', () => {
    // Choosing WHICH run to play is not simulating it.
    const { code } = runChecker(fixture())
    expect(code).toBe(0)
  })
})

describe('contract 1 — determinism', () => {
  it('fails on Math.random() in the sim', () => {
    const { code, output } = runChecker(
      fixture(withAppended('sim/world.ts', 'export const roll = () => Math.random()')),
    )
    expect(code).toBe(1)
    expect(output).toContain('CONTRACT 1: Math.random()')
  })

  it('fails on Math.random() outside the sim too', () => {
    const { code, output } = runChecker(
      fixture(withAppended('render/scene.ts', 'export const jitter = () => Math.random()')),
    )
    expect(code).toBe(1)
    expect(output).toContain('CONTRACT 1: Math.random()')
  })
})

describe('contract 2 — the sim reaches no forbidden layer', () => {
  // R10's headline hole. `from '../audio'` names a DIRECTORY, so the old
  // `(?:render|ui)/` pattern could not have matched it even once audio was listed.
  it.each([
    ['a static render import', `import { draw } from '../render/scene'`, 'render'],
    ['a static ui import', `import { menu } from '../ui/menu'`, 'ui'],
    ['a static audio import by directory', `import { createAudioDirector } from '../audio'`, 'audio'],
    ['a static audio import by file', `import { createAudioDirector } from '../audio/index'`, 'audio'],
    ['a side-effect import', `import '../render/scene'`, 'render'],
    ['a dynamic import', `export const load = async () => await import('../render/scene')`, 'render'],
    ['a require', `export const loaded = require('../audio/index')`, 'audio'],
  ])('fails on %s from sim', (_label, line, layer) => {
    const { code, output } = runChecker(fixture(withAppended('sim/world.ts', line)))
    expect(code).toBe(1)
    expect(output).toContain(`must not reach src/${layer}`)
  })

  it('fails on a forbidden import from content', () => {
    const { code, output } = runChecker(
      fixture(withAppended('content/enemies.ts', `import { draw } from '../render/scene'`)),
    )
    expect(code).toBe(1)
    expect(output).toContain('must not reach src/render')
  })

  it('fails on a forbidden import reached indirectly, through core', () => {
    // The closure is computed, not assumed: checking only src/sim and src/content
    // meant anything they imported was outside the contract.
    const { code, output } = runChecker(
      fixture(withAppended('core/space.ts', `import { draw } from '../render/scene'`)),
    )
    expect(code).toBe(1)
    expect(output).toContain('src/render')
  })

  it('fails when unwired core code imports upward, even outside the sim closure', () => {
    const { code, output } = runChecker(
      fixture(withAppended('core/touch.ts', `import { menu } from '../ui/menu'`)),
    )
    expect(code).toBe(1)
    expect(output).toContain('src/core must not import src/ui')
  })
})

describe('contract 2 — the sim touches no DOM and no clock', () => {
  it.each([
    ['the DOM', `export const el = () => document.querySelector('canvas')`],
    ['localStorage', `export const save = () => localStorage.setItem('a', 'b')`],
    ['performance', `export const t = () => performance.now()`],
    ['Date.now', `export const t = () => Date.now()`],
    ['new Date', `export const t = () => new Date()`],
    ['setTimeout', `export const later = () => setTimeout(() => {}, 1)`],
    ['requestAnimationFrame', `export const soon = () => requestAnimationFrame(() => {})`],
  ])('fails on %s in the sim', (_label, line) => {
    const { code, output } = runChecker(fixture(withAppended('sim/world.ts', line)))
    expect(code).toBe(1)
    expect(output).toContain('must not touch the DOM or any clock')
  })
})

describe('contract 2 — core, which is shared with the host', () => {
  it('fails on a clock at core module scope, because importing the file runs it', () => {
    // The exact case verified by hand against the old checker: a `performance.now()`
    // in core/loop.ts reaches the sim through TICK_SECONDS and passed contracts.
    const { code, output } = runChecker(
      fixture(withAppended('core/loop.ts', 'export const BOOTED_AT = performance.now()')),
    )
    expect(code).toBe(1)
    expect(output).toContain('runs when the sim imports this file')
  })

  it('fails on a bare host statement at core module scope', () => {
    const { code, output } = runChecker(
      fixture(withAppended('core/space.ts', `document.body.dataset.space = 'ready'`)),
    )
    expect(code).toBe(1)
    expect(output).toContain('runs when the sim imports this file')
  })

  it('fails when the sim imports a core function whose body reads a clock', () => {
    const { code, output } = runChecker(
      fixture({
        'core/loop.ts': `${CLEAN_TREE['core/loop.ts'] ?? ''}export function stamp(): number {\n  return Date.now()\n}\n`,
        'sim/world.ts': (CLEAN_TREE['sim/world.ts'] ?? '').replace(
          `import { TICK_HZ, TICK_SECONDS } from '../core/loop'`,
          `import { TICK_HZ, TICK_SECONDS, stamp } from '../core/loop'`,
        ),
      }),
    )
    expect(code).toBe(1)
    expect(output).toContain("`stamp` is imported by the sim's closure")
  })

  it('fails when the sim imports a core class that touches the DOM', () => {
    const { code, output } = runChecker(
      fixture({
        'sim/world.ts': (CLEAN_TREE['sim/world.ts'] ?? '').replace(
          `import { NEUTRAL_INPUT } from '../core/input'`,
          `import { NEUTRAL_INPUT, Keyboard } from '../core/input'`,
        ),
      }),
    )
    expect(code).toBe(1)
    expect(output).toContain("`Keyboard` is imported by the sim's closure")
  })

  it('stays quiet when the sim imports only a TYPE from a host-touching core file', () => {
    // Types are erased, so `import type { ... }` cannot carry host code into a
    // headless run. Flagging it would be the false positive that gets rules deleted.
    const { code, output } = runChecker(
      fixture({
        'sim/world.ts': (CLEAN_TREE['sim/world.ts'] ?? '').replace(
          `import { NEUTRAL_INPUT } from '../core/input'`,
          `import { NEUTRAL_INPUT } from '../core/input'\nimport type { Keyboard } from '../core/input'`,
        ),
      }),
    )
    expect(output).toContain('Contracts OK')
    expect(code).toBe(0)
  })

  it('treats a namespace import of a core module as reaching everything in it', () => {
    const { code, output } = runChecker(
      fixture({
        'sim/world.ts': (CLEAN_TREE['sim/world.ts'] ?? '').replace(
          `import { NEUTRAL_INPUT } from '../core/input'`,
          `import * as inputModule from '../core/input'\nconst NEUTRAL_INPUT = inputModule.NEUTRAL_INPUT`,
        ),
      }),
    )
    expect(code).toBe(1)
    expect(output).toContain('must not touch the DOM or any clock')
  })
})

describe('contract 3 — the sim only sees an InputSnapshot', () => {
  it('fails on a tick() that takes a Keyboard', () => {
    const { code, output } = runChecker(
      fixture({
        'sim/world.ts': `import type { Keyboard } from '../core/input'\n\nexport class World {\n  tick(keys: Keyboard): void {\n    void keys\n  }\n}\n`,
      }),
    )
    expect(code).toBe(1)
    expect(output).toContain('CONTRACT 3')
  })
})

describe('the checker reports its own blind spots', () => {
  it('fails on a relative import it cannot resolve, rather than skipping it', () => {
    // A module the checker cannot resolve is a module it cannot check. Going quiet
    // there is precisely the failure this test file exists to prevent.
    const { code, output } = runChecker(
      fixture(withAppended('sim/world.ts', `import { x } from './doesNotExist'`)),
    )
    expect(code).toBe(1)
    expect(output).toContain('cannot resolve')
  })
})
