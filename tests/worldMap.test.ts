/**
 * World-map layout tests.
 *
 * Headless by construction: `layoutWorldMap` returns every rect and every
 * positioned, pre-measured line, so the things that actually break on this screen —
 * a hazard description that never got drawn, a reward the screen describes
 * differently from the simulation, a boss name rendering as "null", text past the
 * pane edge — are all assertable without a canvas.
 *
 * The screen is also the one place `docs/UI.md` rule 4 is either honoured or not for
 * routing, so several of these tests are rule checks rather than geometry checks:
 * every hazard is named AND described, the reward sentence is reproduced verbatim,
 * `danger` appears nowhere, and the selection comes from the passed-in view rather
 * than from anything this module remembers.
 */

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { Palette } from '../src/render/palette'
import { wrapText } from '../src/render/text'
import type { RouteOption, RouteReward, StageView, WorldView } from '../src/sim/entities'
import {
  drawChoiceScreen,
  lineBounds,
  monoMeasure,
  type Rect,
  type TextLine,
} from '../src/ui/choiceScreen'
import {
  HAZARD_TEXT_W,
  MAP_CARD,
  MAP_CONTENT_W,
  MAP_CONTENT_X,
  MAP_STRINGS,
  NO_BOSS_TEXT,
  PULSE_MAX,
  PULSE_MIN,
  PULSE_RATE_HZ,
  ROUTE_PANE_TEXT_W,
  ROUTE_REWARD_KINDS,
  ROUTE_ROW_TEXT_W,
  UNNAMED_ROUTE_TEXT,
  drawWorldMap,
  hazardTag,
  layoutWorldMap,
  rewardChip,
  type WorldMapLayout,
  type WorldMapLayoutInput,
} from '../src/ui/worldMap'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * One reward per union variant.
 *
 * `satisfies Record<RouteReward['kind'], …>` is the test-side half of the
 * exhaustiveness contract: adding a variant to `RouteReward` fails to typecheck
 * here, and independently fails the `never` assignment in `rewardChip`. Neither can
 * be satisfied by rendering a blank chip.
 */
const REWARD_SAMPLES = {
  none: { kind: 'none' },
  item: { kind: 'item' },
  scrap: { kind: 'scrap', amount: 45 },
  repair: { kind: 'repair', amount: 20 },
} as const satisfies Readonly<Record<RouteReward['kind'], RouteReward>>

/**
 * A hazard description at the length real content is expected to reach.
 *
 * Sized off `ItemDef.mechanism`, the longest comparable authored strings in the
 * project, plus generous headroom: 160-odd characters is two full sentences with
 * numbers in them.
 */
const LONG_HAZARD =
  'Corrosive bloom removes 3 hp of integrity every 2 s while you are inside it, and the cloud drifts toward the last point where you held still for longer than one second.'

const LONG_REWARD =
  'Pays 120 scrap on arrival and adds one uncommon component to the field requisition, at the price of every hazard listed below running for the whole of the leg.'

/** Names at the length the sector tables actually use. */
const HAZARD_NAMES = ['Ion Squall', 'Debris Wash', 'Corrosive Bloom', 'Kill Grid Sweep'] as const

function hazards(count: number, description = LONG_HAZARD): RouteOption['hazards'] {
  return Array.from({ length: count }, (_, index) => ({
    name: HAZARD_NAMES[index % HAZARD_NAMES.length] ?? `Hazard ${index + 1}`,
    description,
  }))
}

function route(overrides: Partial<RouteOption> = {}): RouteOption {
  const base: RouteOption = {
    stageIndex: 2,
    name: 'DIRECT APPROACH',
    sectorName: 'The Tally',
    bossName: 'Ledger Prime',
    hazards: [],
    hazardIds: [],
    reward: { kind: 'none' },
    rewardText: 'No hazards accepted and no bonus paid. The leg is flown as briefed.',
    ...overrides,
  }
  // `hazardIds` is the sim's parallel list. Kept in step here so a fixture can never
  // describe a route the simulation could not actually arm.
  return { ...base, hazardIds: base.hazards.map((hazard, index) => `${hazard.name}-${index}`) }
}

const DIRECT = route()
const SALVAGE = route({
  name: 'SALVAGE DETOUR',
  hazards: hazards(2),
  reward: { kind: 'scrap', amount: 45 },
  rewardText: 'Pays 45 scrap on arrival, on top of whatever the sector itself yields.',
})
const CACHE = route({
  name: 'CACHE RECOVERY',
  hazards: hazards(3),
  reward: { kind: 'item' },
  rewardText: LONG_REWARD,
})

const STAGE: StageView = {
  index: 1,
  count: 5,
  sectorId: 'debris-shelf',
  sectorName: 'Debris Shelf',
  bossName: null,
}

function layout(overrides: Partial<WorldMapLayoutInput> = {}): WorldMapLayout {
  const base: WorldMapLayoutInput = {
    routes: [DIRECT, SALVAGE, CACHE],
    stage: STAGE,
    selected: 0,
    tick: 0,
    measure: monoMeasure,
  }
  return layoutWorldMap({ ...base, ...overrides })
}

function allLines(result: WorldMapLayout): readonly TextLine[] {
  return [
    ...result.header,
    ...result.track.lines,
    ...result.rows.flatMap((row) => row.lines),
    ...result.detail.lines,
    ...result.footer,
  ]
}

/** Whitespace-insensitive containment, since wrapping rewrites the spaces. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function textOf(lines: readonly TextLine[]): string {
  return collapse(lines.map((line) => line.text).join(' '))
}

function insideX(line: TextLine, box: Rect, inset = 0): void {
  const bounds = lineBounds(line)
  expect(bounds.left, `"${line.text}" escapes the left edge`).toBeGreaterThanOrEqual(box.x + inset)
  expect(bounds.right, `"${line.text}" escapes the right edge`).toBeLessThanOrEqual(
    box.x + box.w - inset,
  )
}

function insideY(line: TextLine, box: Rect): void {
  expect(line.y, `"${line.text}" starts above its box`).toBeGreaterThanOrEqual(box.y)
  expect(line.y + line.size, `"${line.text}" runs below its box`).toBeLessThanOrEqual(
    box.y + box.h,
  )
}

/** Every number reachable from the layout, for the NaN sweep. */
function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') out.push(value)
  else if (Array.isArray(value)) for (const entry of value) numbersIn(entry, out)
  else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) numbersIn(entry, out)
  }
  return out
}

const SOURCE = readFileSync(new URL('../src/ui/worldMap.ts', import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// rule 4 — a route is predictable from its text alone
// ---------------------------------------------------------------------------

describe('every route states what it does', () => {
  it('names and describes every hazard of the selected route', () => {
    // The failure this guards against is a map that shows a hazard icon, or a count,
    // and leaves the player to find out what it does by flying into it.
    for (const selected of [0, 1, 2]) {
      const result = layout({ selected })
      const pane = textOf(result.detail.lines)
      const chosen = [DIRECT, SALVAGE, CACHE][selected]
      expect(chosen).toBeDefined()
      for (const hazard of chosen?.hazards ?? []) {
        expect(pane, `hazard "${hazard.name}" is not named in the brief`).toContain(hazard.name)
        expect(pane, `hazard "${hazard.name}" has no description in the brief`).toContain(
          collapse(hazard.description),
        )
      }
      expect(result.trimmed, 'real-length hazard copy should never need trimming').toBe(0)
    }
  })

  it('reproduces rewardText verbatim, only wrapped', () => {
    // The sim owns the sentence with the numbers in it. If this screen paraphrased,
    // shortened, or re-derived it, the screen and the sim could advertise different
    // deals — the exact bug the panel already shipped once with fire rate.
    for (const selected of [0, 1, 2]) {
      const result = layout({ selected })
      const chosen = [DIRECT, SALVAGE, CACHE][selected]
      expect(result.detail.rewardLines.join(' ')).toBe(collapse(chosen?.rewardText ?? ''))
      expect(textOf(result.detail.lines)).toContain(collapse(chosen?.rewardText ?? ''))
    }
  })

  it('states the hazard count in words on every row, selected or not', () => {
    const result = layout()
    expect(result.rows).toHaveLength(3)
    expect(result.rows[0]?.hazardTag).toBe('[no hazards]')
    expect(result.rows[1]?.hazardTag).toBe('[2 hazards]')
    expect(result.rows[2]?.hazardTag).toBe('[3 hazards]')
    for (const row of result.rows) {
      expect(textOf(row.lines), `row ${row.index} omits its hazard count`).toContain(row.hazardTag)
    }
  })

  it('names every hazard of every route on the rows, not only the selected one', () => {
    // A player comparing routes must be able to see the shape of all three trades at
    // once. Only the descriptions live behind the cursor.
    const result = layout()
    const rowText = textOf(result.rows.flatMap((row) => row.lines))
    for (const hazard of [...SALVAGE.hazards, ...CACHE.hazards]) {
      expect(rowText, `"${hazard.name}" is missing from the route rows`).toContain(hazard.name)
    }
    expect(textOf(result.rows[0]?.lines ?? [])).toContain('No hazards')
  })

  it('ends the row summary in an ellipsis when the names do not all fit', () => {
    // The row is one line by design. When the list is too long for it the count tag
    // still states how many there are, the ellipsis says the list was cut, and the
    // pane carries the whole thing — so nothing is lost, only relocated.
    const verbose = route({
      hazards: [0, 1, 2].map((index) => ({
        name: `Interdiction Lattice Subsystem ${index + 1}`,
        description: LONG_HAZARD,
      })),
    })
    const result = layout({ routes: [verbose], selected: 0 })
    const summary = result.rows[0]?.lines.find((line) => line.text.startsWith('Hazards:'))
    expect(summary?.text).toMatch(/…$/)
    expect(summary?.width ?? 0).toBeLessThanOrEqual(ROUTE_ROW_TEXT_W)
    expect(result.rows[0]?.hazardTag).toBe('[3 hazards]')
    for (const hazard of verbose.hazards) {
      expect(textOf(result.detail.lines)).toContain(hazard.name)
    }
  })

  it('truncates an over-long hazard name in the well rather than running past it', () => {
    // A name is an identifier and is not wrapped, so it is the one string in the well
    // that could escape horizontally.
    const result = layout({
      routes: [route({ hazards: [{ name: 'N'.repeat(200), description: 'Short.' }] })],
      selected: 0,
    })
    const nameLine = result.detail.lines.find((line) => line.text.startsWith('·'))
    expect(nameLine?.text).toMatch(/…$/)
    expect(nameLine?.width ?? 0).toBeLessThanOrEqual(ROUTE_PANE_TEXT_W)
  })

  it('renders the name the simulation authored, not one derived from the reward', () => {
    // Two routes paying the same thing must still be distinguishable by name. A title
    // inferred from `reward.kind` gave both the same one, and it was correct only by
    // coincidence of how the builder happened to pair rewards with hazards.
    const twins = [
      route({ name: 'SALVAGE DETOUR', reward: { kind: 'scrap', amount: 45 }, hazards: hazards(1) }),
      route({ name: 'BONDED CONVOY', reward: { kind: 'scrap', amount: 90 }, hazards: hazards(2) }),
    ]
    const result = layout({ routes: twins })
    expect(result.rows.map((row) => row.title)).toEqual(['SALVAGE DETOUR', 'BONDED CONVOY'])
    for (const row of result.rows) {
      expect(textOf(row.lines)).toContain(row.title)
    }
    // And the pane echoes the selected row's name rather than re-deriving its own.
    expect(textOf(layout({ routes: twins, selected: 1 }).detail.lines)).toContain('BONDED CONVOY')
  })

  it('shows a visible placeholder rather than a blank title bar for an unnamed route', () => {
    const result = layout({ routes: [route({ name: '   ' })] })
    expect(result.rows[0]?.title).toBe(UNNAMED_ROUTE_TEXT)
  })

  it('truncates an over-long route name instead of colliding with the reward chip', () => {
    const result = layout({
      routes: [route({ name: 'N'.repeat(120), reward: { kind: 'scrap', amount: 9999 } })],
    })
    const row = result.rows[0]
    expect(row?.title).toMatch(/…$/)
    const title = row?.lines.find((line) => line.text === row.title)
    const chip = row?.lines.find((line) => line.text === '+9999')
    expect(title).toBeDefined()
    expect(chip).toBeDefined()
    if (title && chip) {
      expect(lineBounds(title).right).toBeLessThan(lineBounds(chip).left)
    }
  })

  it('states what declining does, because declining is not "nothing"', () => {
    // `World.takeRoute` flies the direct approach on a decline. A decline key that
    // silently commits the player to one of the options, unannounced, is exactly what
    // rule 4 forbids.
    const footer = textOf(layout().footer)
    expect(footer).toContain('Declining flies the direct approach')
    expect(footer).toContain('no hazards accepted, no bonus paid')
    expect(footer).toContain('X decline')
  })

  it('says so explicitly when a route accepts no hazards', () => {
    // Silence would be indistinguishable from a route whose hazards failed to load.
    const result = layout({ routes: [DIRECT], selected: 0 })
    expect(textOf(result.detail.lines)).toContain(collapse(MAP_STRINGS.noHazardPane))
    expect(result.detail.hazards.every((brief) => brief.name === '')).toBe(true)
  })

  it('shows the destination and the run track together', () => {
    const result = layout()
    const header = textOf(result.header)
    expect(header).toContain('The Tally')
    expect(header).toContain('Ledger Prime')
    expect(textOf(result.track.lines)).toContain('choosing leg 3 of 5')
  })
})

// ---------------------------------------------------------------------------
// rule 2 — every number carries a unit
// ---------------------------------------------------------------------------

describe('every number carries a unit', () => {
  it('renders each reward variant as a value, with a unit wherever it is a number', () => {
    for (const kind of ROUTE_REWARD_KINDS) {
      const chip = rewardChip(REWARD_SAMPLES[kind])
      expect(chip.value.length, `reward "${kind}" has no value`).toBeGreaterThan(0)
      expect(chip.value).not.toMatch(/NaN|undefined|null/)
      // Rule 2 is about numbers. A quantity with no unit is the bug; a word is not.
      if (/\d/.test(chip.value)) {
        expect(chip.unit.length, `reward "${kind}" is a bare number`).toBeGreaterThan(0)
      }
    }
    expect(rewardChip(REWARD_SAMPLES.scrap)).toMatchObject({ value: '+45', unit: 'cr' })
    expect(rewardChip(REWARD_SAMPLES.repair)).toMatchObject({ value: '+20', unit: 'hp' })
    expect(rewardChip(REWARD_SAMPLES.item)).toMatchObject({ value: '1', unit: 'item' })
    // A route that pays nothing says so in one word rather than showing a bare dash.
    expect(rewardChip(REWARD_SAMPLES.none)).toMatchObject({ value: 'none', pays: false })
  })

  it('covers every reward variant with a chip', () => {
    // ROUTE_REWARD_KINDS is derived from a `satisfies Record<RouteReward['kind'],…>`
    // table in the screen, so this list cannot drift from the union.
    expect([...ROUTE_REWARD_KINDS].sort()).toEqual(Object.keys(REWARD_SAMPLES).sort())
  })

  it('draws the reward value and unit on every row', () => {
    const result = layout({
      routes: ROUTE_REWARD_KINDS.map((kind) => route({ reward: REWARD_SAMPLES[kind] })),
    })
    for (const row of result.rows) {
      const text = textOf(row.lines)
      expect(text, `row for "${row.rewardKind}" lost its value`).toContain(row.rewardValue)
      expect(text, `row for "${row.rewardKind}" lost its unit`).toContain(row.rewardUnit)
    }
  })

  it('counts hazards and legs with their nouns', () => {
    expect(hazardTag(0)).toBe('[no hazards]')
    expect(hazardTag(1)).toBe('[1 hazard]')
    expect(hazardTag(4)).toBe('[4 hazards]')
    const caption = textOf(layout({ stage: { ...STAGE, count: 5 } }).track.lines)
    expect(caption).toContain('2 legs flown')
    expect(caption).toContain('2 legs after this')
  })

  it('never renders a bare number without a neighbouring word', () => {
    // Scans the authored copy rather than the data: a digit with no unit anywhere on
    // its line is the rule-2 failure mode, and it is easiest to reintroduce in a
    // hint string someone edits later.
    for (const [key, value] of Object.entries(MAP_STRINGS)) {
      if (!/\d/.test(value)) continue
      expect(value, `"${key}" has a number with no unit`).toMatch(/\d\s*[a-zA-Z%]/)
    }
  })
})

// ---------------------------------------------------------------------------
// rule 3 — colour is information
// ---------------------------------------------------------------------------

describe('the map is never painted as a live threat', () => {
  it('uses no danger colour anywhere in the layout', () => {
    // A hazard printed on a map is a future cost, not something that can hurt the
    // player this instant, and `danger` is reserved for the latter. Nothing on this
    // screen qualifies, so nothing on it may be red.
    const result = layout({ selected: 2 })
    for (const line of allLines(result)) {
      expect(line.color, `"${line.text}" is painted danger red`).not.toBe(Palette.danger)
    }
    for (const pip of result.track.pips) {
      expect(pip.fill).not.toBe(Palette.danger)
      expect(pip.stroke).not.toBe(Palette.danger)
    }
    for (const row of result.rows) expect(row.accent).not.toBe(Palette.danger)
    expect(result.accent).not.toBe(Palette.danger)
  })

  it('does not name the danger token in the source at all', () => {
    // Stronger than the layout sweep: catches a danger fill added to the draw pass,
    // which produces no TextLine to inspect.
    expect(SOURCE.replace(/`danger`/g, '')).not.toMatch(/Palette\.danger|glowDanger/)
  })

  it('marks accepted hazards with caution, the risky-choice token', () => {
    const result = layout({ selected: 1 })
    const hazardLines = result.detail.lines.filter((line) => line.text.startsWith('·'))
    expect(hazardLines.length).toBe(SALVAGE.hazards.length)
    for (const line of hazardLines) expect(line.color).toBe(Palette.caution)
  })

  it('never leaves colour as the only carrier of a state', () => {
    const result = layout({ selected: 1 })
    // Selection: a caret as well as the wash and the accent.
    const selectedRow = result.rows.find((row) => row.selected)
    expect(selectedRow).toBeDefined()
    expect(selectedRow?.lines.some((line) => line.text === '>')).toBe(true)
    // Current leg: a solid marker bar as well as the `self` outline.
    const current = result.track.pips.filter((pip) => pip.state === 'current')
    expect(current).toHaveLength(1)
    expect(current[0]?.marker).not.toBeNull()
    // And every pip carries its number, so the track survives a monochrome print.
    for (const pip of result.track.pips) {
      expect(textOf(result.track.lines)).toContain(String(pip.index + 1))
    }
  })
})

// ---------------------------------------------------------------------------
// rule 10 — no strobing
// ---------------------------------------------------------------------------

describe('the selection pulse is within the accessibility limit', () => {
  it('runs below 1 Hz', () => {
    expect(PULSE_RATE_HZ).toBeLessThan(1)
    expect(PULSE_RATE_HZ).toBeGreaterThan(0)
  })

  it('never reaches zero opacity, at any tick', () => {
    for (let tick = 0; tick < 4000; tick++) {
      const { pulse } = layout({ tick })
      expect(pulse).toBeGreaterThanOrEqual(PULSE_MIN - 1e-9)
      expect(pulse).toBeLessThanOrEqual(PULSE_MAX + 1e-9)
    }
  })
})

// ---------------------------------------------------------------------------
// the screen holds no state
// ---------------------------------------------------------------------------

describe('the selection comes from the view, not from the screen', () => {
  it('has no module-level mutable binding', () => {
    // Structural, because the behavioural tests below can only catch state that
    // happens to be observable. A `let` at module scope is a cursor waiting to
    // disagree with the simulation's.
    const moduleLevel = SOURCE.split('\n').filter((line) => /^(let|var)\s/.test(line))
    expect(moduleLevel, `module-level mutable state: ${moduleLevel.join(' | ')}`).toHaveLength(0)
    expect(SOURCE).not.toMatch(/^export\s+(let|var)\s/m)
  })

  it('exports nothing that could advance a cursor', () => {
    const movers = [...SOURCE.matchAll(/^export function (\w+)/gm)]
      .map((match) => match[1] ?? '')
      .filter((name) => /^(set|move|select|advance|next|prev|update|confirm)/.test(name))
    expect(movers, `these look like they mutate a selection: ${movers.join(', ')}`).toHaveLength(0)
  })

  it('is a pure function of its input', () => {
    const first = JSON.stringify(layout({ selected: 2, tick: 31 }))
    // Interleave other calls: anything cached between them would show up here.
    layout({ selected: 0, tick: 7 })
    layout({ selected: 1, tick: 900 })
    expect(JSON.stringify(layout({ selected: 2, tick: 31 }))).toBe(first)
  })

  it('highlights exactly the index it was handed', () => {
    for (let index = 0; index < 3; index++) {
      const result = layout({ selected: index })
      expect(result.selected).toBe(index)
      expect(result.rows.filter((row) => row.selected).map((row) => row.index)).toEqual([index])
      expect(result.detail.routeIndex).toBe(index)
    }
  })

  it('wraps an out-of-range index the same way the simulation does', () => {
    // `updateCursor` wraps rather than clamps. If this screen clamped, the highlight
    // would sit on a different option from the one confirm takes.
    expect(layout({ selected: 3 }).selected).toBe(0)
    expect(layout({ selected: -1 }).selected).toBe(2)
    expect(layout({ selected: Number.NaN }).selected).toBe(0)
  })

  it('reads awaitingRelease from the input and says so on screen', () => {
    expect(textOf(layout().footer)).toContain(collapse(MAP_STRINGS.hint))
    expect(textOf(layout({ awaitingRelease: true }).footer)).toContain(
      collapse(MAP_STRINGS.hintAwaiting),
    )
  })
})

// ---------------------------------------------------------------------------
// the run's shape
// ---------------------------------------------------------------------------

describe('the run track shows how much run is left', () => {
  it('draws one pip per leg, split into flown, current, and ahead', () => {
    const result = layout({ stage: { ...STAGE, count: 5 } })
    expect(result.track.pips).toHaveLength(5)
    expect(result.track.pips.map((pip) => pip.state)).toEqual([
      'flown',
      'flown',
      'current',
      'ahead',
      'ahead',
    ])
    expect(result.track.flown).toBe(2)
    expect(result.track.current).toBe(2)
    expect(result.track.ahead).toBe(2)
  })

  it('states the same split in prose', () => {
    // The pips are a shape; the caption is the fact. Rule 3 does not let the shape be
    // the only place a fact lives.
    const caption = textOf(layout().track.lines)
    expect(caption).toContain('2 legs flown')
    expect(caption).toContain('choosing leg 3 of 5')
    expect(caption).toContain('2 legs after this')
  })

  it('counts the leg from the routes, not from the stage the run is leaving', () => {
    // A route choice sits *between* legs, so the leg being chosen is the one the
    // routes lead to. Reading it off `StageView.index` instead would label the
    // choice with the sector the player has just finished.
    const result = layout({
      routes: [route({ stageIndex: 1 }), route({ stageIndex: 1, hazards: hazards(1) })],
      stage: { ...STAGE, index: 0 },
    })
    expect(textOf(result.track.lines)).toContain('1 leg flown')
    expect(textOf(result.track.lines)).toContain('choosing leg 2 of 5')
  })

  it('reads sensibly before a single leg has been flown', () => {
    const result = layout({
      routes: [route({ stageIndex: 0 })],
      stage: { ...STAGE, index: 0 },
    })
    expect(textOf(result.track.lines)).toContain('No legs flown yet')
    expect(textOf(result.track.lines)).toContain('choosing leg 1 of 5')
  })

  it('keeps the pips inside the content column however many legs there are', () => {
    for (const count of [1, 2, 5, 9, 14]) {
      const result = layout({ stage: { ...STAGE, count } })
      expect(result.track.pips).toHaveLength(count)
      for (const pip of result.track.pips) {
        expect(pip.box.x).toBeGreaterThanOrEqual(MAP_CONTENT_X)
        expect(pip.box.x + pip.box.w).toBeLessThanOrEqual(MAP_CONTENT_X + MAP_CONTENT_W)
        expect(pip.box.w).toBeGreaterThan(0)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// a missing boss
// ---------------------------------------------------------------------------

describe('a leg with no boss', () => {
  const bossless = [
    route({ bossName: null }),
    route({ bossName: null, hazards: hazards(2), reward: { kind: 'scrap', amount: 60 } }),
  ]

  it('fills the boss slot with words rather than a gap or "null"', () => {
    const result = layout({ routes: bossless })
    expect(textOf(result.header)).toContain(NO_BOSS_TEXT)
    for (const line of allLines(result)) {
      expect(line.text, 'a raw null or undefined reached the screen').not.toMatch(
        /\bnull\b|\bundefined\b/,
      )
      expect(line.text.length, 'an empty line was emitted where text was expected').toBeGreaterThan(
        0,
      )
    }
  })

  it('does not shift the layout relative to a leg that has one', () => {
    // An absent boss must not open a hole: the rows and pane sit where they always do.
    const withBoss = layout({ routes: [route(), route({ hazards: hazards(2) })] })
    const without = layout({ routes: bossless })
    expect(without.rows.map((row) => row.box.y)).toEqual(withBoss.rows.map((row) => row.box.y))
    expect(without.detail.box).toEqual(withBoss.detail.box)
  })

  it('says the routes disagree rather than picking one, if they ever do', () => {
    const result = layout({
      routes: [route({ bossName: 'Ledger Prime' }), route({ bossName: null })],
    })
    expect(textOf(result.header)).toContain(MAP_STRINGS.varies)
  })
})

// ---------------------------------------------------------------------------
// containment
// ---------------------------------------------------------------------------

describe('nothing escapes its container', () => {
  /**
   * @param allowOverflow only for copy far outside anything authored, where the
   * screen's contract is that it cuts and *says so* rather than painting outside.
   */
  function assertContained(result: WorldMapLayout, allowOverflow = false): void {
    const content: Rect = {
      x: MAP_CONTENT_X,
      y: MAP_CARD.y,
      w: MAP_CONTENT_W,
      h: MAP_CARD.h,
    }
    for (const line of [...result.header, ...result.footer, ...result.track.lines]) {
      insideX(line, content)
    }
    for (const line of allLines(result)) {
      expect(line.y).toBeGreaterThanOrEqual(MAP_CARD.y)
      expect(line.y + line.size).toBeLessThanOrEqual(MAP_CARD.y + MAP_CARD.h)
      expect(line.size).toBeGreaterThanOrEqual(11)
    }
    for (const row of result.rows) {
      for (const line of row.lines) {
        insideX(line, row.box, 1)
        insideY(line, row.box)
      }
    }
    for (const line of result.detail.lines) {
      insideX(line, result.detail.box, 1)
      insideY(line, result.detail.box)
    }
    const well = result.detail.hazardBox
    if (well) {
      expect(well.y).toBeGreaterThanOrEqual(result.detail.box.y)
      expect(well.y + well.h).toBeLessThanOrEqual(result.detail.box.y + result.detail.box.h)
    }
    // Rows must not run into the pane, and the pane must not run into the footer.
    for (const row of result.rows) {
      expect(row.box.y + row.box.h).toBeLessThanOrEqual(result.detail.box.y)
    }
    expect(result.detail.box.h).toBeGreaterThan(0)
    if (!allowOverflow) expect(result.overflow).toBe(false)
  }

  it('contains the ordinary case', () => {
    for (const selected of [0, 1, 2]) assertContained(layout({ selected }))
  })

  it('contains three routes of three long hazards each', () => {
    // The worst case the design admits: 2–3 routes, up to three hazards, each with a
    // two-sentence description. The pane must grow into the space the rows give up,
    // not overlap them, and no description may be cut.
    const heavy = [0, 1, 2].map(() =>
      route({
        hazards: hazards(3),
        reward: { kind: 'scrap', amount: 120 },
        rewardText: LONG_REWARD,
      }),
    )
    for (const selected of [0, 1, 2]) {
      const result = layout({ routes: heavy, selected })
      assertContained(result)
      expect(result.trimmed, 'a real-length hazard brief was cut to fit').toBe(0)
    }
  })

  it('never lets the row spacing steal room the pane was promised', () => {
    // Regression. Leftover space is spread into the rows — extra padding, wider gaps,
    // a lead-in — and one of those terms was computed against the row heights without
    // their gaps. It handed the stack 15 units the pane had already been counted for,
    // and the only visible symptom was a hazard description quietly losing its last
    // line. Swept across the content shapes the builder can produce.
    for (const routeCount of [2, 3]) {
      for (const hazardCount of [1, 2, 3]) {
        for (const descriptionWords of [8, 16, 26]) {
          const description = `${'incident '.repeat(descriptionWords)}every 9 s for 4 hp.`
          const routes = Array.from({ length: routeCount }, () =>
            route({
              hazards: hazards(hazardCount, description),
              reward: { kind: 'scrap', amount: 180 },
              rewardText: LONG_REWARD,
            }),
          )
          for (let selected = 0; selected < routeCount; selected++) {
            const result = layout({ routes, selected })
            const shape = `${routeCount} routes x ${hazardCount} hazards x ${descriptionWords} words`
            expect(result.trimmed, `${shape} lost a description line`).toBe(0)
            expect(result.overflow, `${shape} overflowed`).toBe(false)
            const well = result.detail.hazardBox
            expect(well, `${shape} produced no well`).not.toBeNull()
            if (well) {
              expect(well.y + well.h).toBeLessThanOrEqual(
                result.detail.box.y + result.detail.box.h,
              )
            }
          }
        }
      }
    }
  })

  it('contains two routes, one of them the direct approach', () => {
    assertContained(layout({ routes: [DIRECT, CACHE], selected: 1 }))
    assertContained(layout({ routes: [DIRECT, CACHE], selected: 0 }))
  })

  it('contains pathological copy by trimming rather than by overflowing', () => {
    // Rule 4 makes trimming a hazard brief a last resort, not a strategy — but a
    // 900-character description must still not paint over the footer.
    const absurd = route({
      hazards: hazards(4, 'z'.repeat(900)),
      reward: { kind: 'repair', amount: 999 },
      rewardText: 'q'.repeat(600),
    })
    const result = layout({ routes: [absurd, absurd, absurd], selected: 1 })
    assertContained(result, true)
    expect(result.trimmed).toBeGreaterThan(0)
    expect(result.degrade).toBe(2)
    // Cut, and marked as cut: an ellipsis, so no trimmed brief reads as a whole one.
    for (const brief of result.detail.hazards) {
      if (!brief.trimmed) continue
      expect(brief.lines[brief.lines.length - 1]).toMatch(/…$/)
    }
  })

  it('states how many hazards it could not brief, rather than dropping them silently', () => {
    // More hazards than lines. A shortened list the player cannot detect is worse
    // than an honest count, because the route would appear to carry fewer costs.
    const swarm = route({ hazards: hazards(14, 'z'.repeat(300)) })
    const result = layout({ routes: [swarm], selected: 0 })
    assertContained(result, true)
    expect(result.overflow).toBe(true)
    expect(textOf(result.detail.lines)).toMatch(/\+\d+ more hazards? not shown/)
  })

  it('contains an unbreakable token', () => {
    assertContained(
      layout({
        routes: [route({ hazards: hazards(2, 'A'.repeat(400)), rewardText: 'B'.repeat(300) })],
        selected: 0,
      }),
      true,
    )
  })

  it('wraps to the container width the tests import, not to a guess', () => {
    const result = layout({ selected: 2 })
    for (const text of result.detail.rewardLines) {
      expect(monoMeasure(text, 13)).toBeLessThanOrEqual(ROUTE_PANE_TEXT_W)
    }
    for (const brief of result.detail.hazards) {
      for (const text of brief.lines) {
        expect(monoMeasure(text, 12)).toBeLessThanOrEqual(HAZARD_TEXT_W + 12)
      }
    }
    for (const row of result.rows) {
      for (const line of row.lines) {
        if (line.align !== 'left') continue
        expect(line.width).toBeLessThanOrEqual(ROUTE_ROW_TEXT_W + 40)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// hostile input
// ---------------------------------------------------------------------------

describe('no NaN and no crash for any plausible input', () => {
  const cases: readonly Partial<WorldMapLayoutInput>[] = [
    {},
    { routes: [] },
    { routes: [DIRECT] },
    { selected: 1e9, tick: -1 },
    { selected: Number.NaN, tick: Number.NaN },
    { stage: { ...STAGE, count: 0, index: 0 } },
    { stage: { ...STAGE, count: Number.NaN, index: Number.NaN } },
    { routes: [route({ stageIndex: 99 })] },
    { routes: [route({ stageIndex: -5 })] },
    { routes: [route({ reward: { kind: 'scrap', amount: Number.NaN } })] },
    { routes: [route({ reward: { kind: 'repair', amount: -20 } })] },
    { routes: [route({ sectorName: '', rewardText: '', hazards: [{ name: '', description: '' }] })] },
  ]

  it('produces only finite numbers', () => {
    for (const overrides of cases) {
      const result = layout(overrides)
      for (const value of numbersIn(result)) {
        expect(Number.isFinite(value), `non-finite number for ${JSON.stringify(overrides)}`).toBe(
          true,
        )
      }
    }
  })

  it('never prints NaN, null, or undefined', () => {
    for (const overrides of cases) {
      for (const line of allLines(layout(overrides))) {
        expect(line.text).not.toMatch(/NaN|undefined|\bnull\b/)
      }
    }
  })

  it('says something useful when there are no routes at all', () => {
    const result = layout({ routes: [] })
    expect(result.rows).toHaveLength(0)
    expect(textOf(result.detail.lines)).toContain(collapse(MAP_STRINGS.noRoutes))
  })
})

// ---------------------------------------------------------------------------
// the draw path
// ---------------------------------------------------------------------------

/**
 * A recording stand-in for a 2D context.
 *
 * Enough surface for the draw pass to run headless. It exists to catch the one
 * class of bug a screenshot review cannot: `fillRect(NaN, …)` draws nothing at all
 * and looks exactly like a panel that was never wired up.
 */
function stubContext(): { ctx: CanvasRenderingContext2D; calls: { name: string; args: unknown[] }[] } {
  const calls: { name: string; args: unknown[] }[] = []
  const target: Record<string, unknown> = {
    measureText: (text: string) => ({ width: String(text).length * 7 }),
  }
  for (const name of ['fillRect', 'strokeRect', 'fillText', 'save', 'restore']) {
    target[name] = (...args: unknown[]): void => {
      calls.push({ name, args })
    }
  }
  return { ctx: target as unknown as CanvasRenderingContext2D, calls }
}

/**
 * A view carrying only what these two screens read.
 *
 * Cast rather than fully constructed on purpose: `WorldView` is the sim's contract
 * and gains fields regularly, and a render smoke test that breaks every time an
 * unrelated field is added stops being run. What it proves is the dispatch and the
 * draw pass, not the shape of the view.
 */
function viewWithRoutes(routes: readonly RouteOption[]): WorldView {
  return {
    pendingChoice: { kind: 'route', offers: [], costs: [], workOrders: [], routes },
    stage: STAGE,
  } as unknown as WorldView
}

describe('the draw path', () => {
  it('draws without producing a single NaN coordinate', () => {
    const { ctx, calls } = stubContext()
    drawWorldMap(ctx, viewWithRoutes([DIRECT, SALVAGE, CACHE]), { selected: 1, tick: 40 })
    expect(calls.length).toBeGreaterThan(20)
    for (const call of calls) {
      for (const arg of call.args) {
        if (typeof arg === 'number') {
          expect(Number.isFinite(arg), `${call.name} got a non-finite argument`).toBe(true)
        }
      }
    }
  })

  it('is what the choice screen dispatches a route to', () => {
    // `src/main.ts` calls `drawChoiceScreen` for every pending choice and must not
    // have to know that a route is a different screen.
    const viaChoice = stubContext()
    drawChoiceScreen(viaChoice.ctx, viewWithRoutes([DIRECT, SALVAGE]), {
      selected: 1,
      tick: 40,
      items: {},
    })
    const direct = stubContext()
    drawWorldMap(direct.ctx, viewWithRoutes([DIRECT, SALVAGE]), { selected: 1, tick: 40 })
    expect(viaChoice.calls.map((call) => call.name)).toEqual(
      direct.calls.map((call) => call.name),
    )
    expect(viaChoice.calls.length).toBeGreaterThan(20)
  })

  it('draws nothing when the pending choice is not a route', () => {
    const { ctx, calls } = stubContext()
    drawWorldMap(ctx, { pendingChoice: null } as unknown as WorldView, { selected: 0, tick: 0 })
    expect(calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// the measurement itself
// ---------------------------------------------------------------------------

describe('the layout measures rather than guesses', () => {
  it('wraps with the shared helper, so one wrap bug is fixed once', () => {
    expect(SOURCE).toMatch(/import \{[^}]*wrapText[^}]*\} from '\.\.\/render\/text'/)
    // A hand-rolled splitter would not go through wrapText and would drift from it.
    expect(SOURCE).not.toMatch(/\.split\(' '\)/)
  })

  it('agrees with wrapText about the pane width', () => {
    const result = layout({ selected: 2 })
    expect(result.detail.rewardLines).toEqual(
      wrapText(CACHE.rewardText, ROUTE_PANE_TEXT_W, 13, monoMeasure),
    )
  })
})
