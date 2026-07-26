/**
 * Every authored string must fit the box it is drawn in.
 *
 * WHY THIS FILE EXISTS: the pause menu shipped with its longest hint — "Ends the
 * run. The hull is written off and the pilot is reassigned." — running past the
 * card's right edge. It was drawn with a single `drawText` call, which cannot know
 * how wide its string is, and nothing anywhere checked. It took a human looking at
 * a screenshot to find it.
 *
 * The class of bug is what matters, not that one string. Any time someone lengthens
 * a hint, renames an item, writes a longer interaction sentence, or adds a work
 * order, the text can silently leave its container — and a passing unit test suite
 * plus a green typecheck say nothing about it. So this file walks *all* the authored
 * copy in the project and measures it.
 *
 * MEASUREMENT: a conservative monospace estimate rather than a canvas. Every font in
 * the stack advances at ~0.6em; 0.62 is used so a string that passes here has margin
 * in the real renderer. Erring wide is deliberate — a test that under-measures would
 * pass exactly the strings that then overflow on screen.
 */

import { describe, expect, it } from 'vitest'
import { HAZARDS } from '../src/content/hazards'
import { HULLS } from '../src/content/hulls'
import { ITEMS } from '../src/content/items'
import { INTERACTIONS } from '../src/content/interactions'
import { WORK_ORDERS } from '../src/content/workOrders'
import { Rng } from '../src/core/rng'
import { Font } from '../src/render/palette'
import { buildRoutes } from '../src/sim/progression'
import type { RouteOption } from '../src/sim/entities'
import { wrapText, type Measure } from '../src/render/text'
import { CHOICE_CONTENT_W, OPTION_TEXT_W } from '../src/ui/choiceScreen'
import {
  PAUSE_CONTENT_W,
  PAUSE_FOOTER_SIZE,
  PAUSE_FOOTER_TEXT,
  PAUSE_HINT_SIZE,
  PAUSE_ITEMS,
} from '../src/ui/pauseMenu'
import {
  HULL_LABEL_SIZE,
  HULL_MECH_SIZE,
  HULL_ROW_SIZE,
  HULL_SELECT_COL_W,
  HULL_SELECT_CONTENT_W,
  HULL_SELECT_STRINGS,
  HULL_SELECT_TEXT_W,
  HULL_SUB_SIZE,
  HULL_TITLE_SIZE,
  compareToBaseline,
  launchHint,
  poolCountText,
} from '../src/ui/hullSelect'
import {
  HAZARD_TEXT_W,
  LABEL_SIZE,
  MAP_CONTENT_W,
  MAP_STRINGS,
  REWARD_TEXT_SIZE,
  ROUTE_PANE_TEXT_W,
  ROUTE_ROW_TEXT_W,
  SUB_SIZE,
  TITLE_SIZE,
  hazardTag,
  rewardChip,
} from '../src/ui/worldMap'

/** Advance per character as a fraction of size. Deliberately wider than reality. */
const EM_RATIO = 0.62

const measure: Measure = (text, size, _weight = 400, tracking = 0) =>
  text.length * size * EM_RATIO + Math.max(0, text.length - 1) * tracking

/** Widths of the cards that hold authored copy, from each screen's own constants. */
const CARDS = {
  /** Pause menu content column. */
  pause: PAUSE_CONTENT_W,
  /** Incident report content column: CARD_W 544 minus PAD 26 either side. */
  incident: 544 - 26 * 2,
  /**
   * Usable text width inside one option box, read from the screen's own constant.
   *
   * Hardcoding this was the first attempt and it was wrong by a factor of three —
   * options stack vertically at nearly full card width rather than sitting in
   * columns. A test that restates a layout number tests its own guess.
   */
  choiceOption: OPTION_TEXT_W,
  choiceCard: CHOICE_CONTENT_W,
  /**
   * World map, all four read from the screen's own constants for the same reason.
   *
   * The map has four distinct containers rather than one, and they differ by nearly
   * 100 units — a string that fits the pane can still overflow the hazard well,
   * which sits inside it and is indented past a bullet.
   */
  mapCard: MAP_CONTENT_W,
  mapRow: ROUTE_ROW_TEXT_W,
  mapPane: ROUTE_PANE_TEXT_W,
  mapHazard: HAZARD_TEXT_W,
  /**
   * Hull issue: the card's content column, one hull card's text column, and one
   * column of the two-column trade table.
   *
   * Three containers rather than one, and they differ by more than 2x. A stat row
   * fits the card comfortably and still runs into the column beside it — which is the
   * only overflow on that screen a reader would actually see, because rows are drawn
   * with a single `drawText` and cannot wrap.
   */
  hullCard: HULL_SELECT_CONTENT_W,
  hullText: HULL_SELECT_TEXT_W,
  hullCol: HULL_SELECT_COL_W,
} as const

describe('pause menu copy fits its card', () => {
  it('wraps every hint inside the content width', () => {
    for (const item of PAUSE_ITEMS) {
      const lines = wrapText(item.hint, CARDS.pause, PAUSE_HINT_SIZE, measure)
      expect(lines.length, `${item.id} produced no lines`).toBeGreaterThan(0)
      for (const line of lines) {
        expect(
          measure(line, PAUSE_HINT_SIZE),
          `hint for "${item.id}" overflows: ${line}`,
        ).toBeLessThanOrEqual(CARDS.pause)
      }
    }
  })

  it('keeps every hint to at most two lines', () => {
    // The card reserves room for two. A third would run into the controls footer,
    // which is a collision rather than an overflow and just as bad.
    for (const item of PAUSE_ITEMS) {
      const lines = wrapText(item.hint, CARDS.pause, PAUSE_HINT_SIZE, measure)
      expect(lines.length, `hint for "${item.id}" needs ${lines.length} lines`).toBeLessThanOrEqual(
        2,
      )
    }
  })

  it('fits the controls footer on one line', () => {
    // Centred, so an overflow escapes BOTH edges and is doubly obvious — and the
    // footer is the string most likely to grow as controls are added.
    expect(measure(PAUSE_FOOTER_TEXT, PAUSE_FOOTER_SIZE)).toBeLessThanOrEqual(CARDS.pause)
  })

  it('fits every row label beside its value', () => {
    // Label and value share a line, so their combined width is what matters. The
    // widest plausible value is used, not the current one.
    const widestValue = 'Muted'
    for (const item of PAUSE_ITEMS) {
      const combined =
        measure(item.label, 14) + measure(widestValue, 14, 600) + measure(' 100 %', 11)
      expect(combined, `row "${item.id}" is too wide`).toBeLessThanOrEqual(CARDS.pause)
    }
  })
})

describe('item copy fits the choice screen', () => {
  it('wraps every mechanism inside an option column', () => {
    // The mechanism is the one string on that screen a player MUST be able to read
    // (UI rule 4), so it is the least acceptable thing to clip.
    for (const item of Object.values(ITEMS)) {
      const lines = wrapText(item.mechanism, CARDS.choiceOption, 13, measure)
      for (const line of lines) {
        expect(
          measure(line, 13),
          `mechanism for "${item.id}" overflows: ${line}`,
        ).toBeLessThanOrEqual(CARDS.choiceOption)
      }
    }
  })

  it('keeps every mechanism within a readable number of lines', () => {
    // Three options share the card. A mechanism that needs six lines does not
    // overflow horizontally but pushes the build strip off the bottom.
    for (const item of Object.values(ITEMS)) {
      const lines = wrapText(item.mechanism, CARDS.choiceOption, 13, measure)
      expect(lines.length, `mechanism for "${item.id}" needs ${lines.length} lines`).toBeLessThanOrEqual(6)
    }
  })

  it('fits every item name on its title line', () => {
    // The title line also carries a tier tag and, in a shop, a price.
    const decoration = measure(' [uncommon]  384 cr', 11)
    for (const item of Object.values(ITEMS)) {
      expect(
        measure(item.name, 13, 600) + decoration,
        `name "${item.name}" leaves no room for its tier and price`,
      ).toBeLessThanOrEqual(CARDS.choiceOption + 40)
    }
  })

  it('wraps every flavour line', () => {
    for (const item of Object.values(ITEMS)) {
      if (!item.flavour) continue
      const lines = wrapText(item.flavour, CARDS.choiceOption, 12, measure)
      for (const line of lines) {
        expect(measure(line, 12), `flavour for "${item.id}" overflows`).toBeLessThanOrEqual(
          CARDS.choiceOption,
        )
      }
    }
  })
})

describe('interaction copy fits', () => {
  it('wraps every interaction sentence inside an option column', () => {
    // Rule 5 requires this text be *shown*, so it cannot be allowed to clip. It is
    // also the copy most likely to grow, since it describes two items at once.
    for (const interaction of INTERACTIONS) {
      const lines = wrapText(interaction.text, CARDS.choiceOption, 12, measure)
      expect(lines.length, `${interaction.id} produced no lines`).toBeGreaterThan(0)
      for (const line of lines) {
        expect(
          measure(line, 12),
          `interaction "${interaction.id}" overflows: ${line}`,
        ).toBeLessThanOrEqual(CARDS.choiceOption)
      }
    }
  })

  it('keeps interaction text short enough to show alongside a mechanism', () => {
    // An option shows both. Four lines of synergy plus six of mechanism does not
    // fit, and the screen degrades by truncating — which is rule 5 failing quietly.
    for (const interaction of INTERACTIONS) {
      const lines = wrapText(interaction.text, CARDS.choiceOption, 12, measure)
      expect(lines.length, `${interaction.id} needs ${lines.length} lines`).toBeLessThanOrEqual(5)
    }
  })
})

describe('work order copy fits', () => {
  it('wraps every description', () => {
    for (const order of Object.values(WORK_ORDERS)) {
      const lines = wrapText(order.description, CARDS.choiceOption, 12, measure)
      for (const line of lines) {
        expect(
          measure(line, 12),
          `work order "${order.kind}" overflows: ${line}`,
        ).toBeLessThanOrEqual(CARDS.choiceOption)
      }
    }
  })

  it('fits every work order name on its title line', () => {
    for (const order of Object.values(WORK_ORDERS)) {
      expect(measure(order.name, 13, 600), `name "${order.name}" is too wide`).toBeLessThanOrEqual(
        CARDS.choiceOption,
      )
    }
  })
})

describe('world map copy fits its containers', () => {
  /**
   * Which container each authored string is drawn in, and at what size.
   *
   * Written out per string rather than measured against the widest container,
   * because the map's four containers differ by ~100 units and "it fits the card"
   * says nothing about whether it fits the well.
   */
  interface Placement {
    /** The container the string is drawn in, less whatever shares its line. */
    width: number
    size: number
    /** Charged for, because tracked labels are meaningfully wider than untracked. */
    tracking?: number
    weight?: 400 | 600 | 700
    /** The screen runs this one through `wrapText`, so its lines are measured, not the whole string. */
    wraps?: true
  }

  /** Room reserved on the header row for the right-aligned leg counter. */
  const LEG_COUNTER_W = 90
  /** Room reserved on the destination row for the other half of it. */
  const DEST_HALF = CARDS.mapCard / 2

  const PLACED: Readonly<Record<keyof typeof MAP_STRINGS, Placement>> = {
    eyebrow: { width: CARDS.mapCard - LEG_COUNTER_W, size: LABEL_SIZE, tracking: 1.6 },
    title: { width: CARDS.mapCard - LEG_COUNTER_W, size: 22, tracking: 2.4, weight: 700 },
    subtitle: { width: CARDS.mapCard, size: SUB_SIZE },
    // Destination and boss share one row, label and value each.
    destinationLabel: { width: DEST_HALF / 2, size: LABEL_SIZE, tracking: 1.6 },
    bossLabel: { width: DEST_HALF / 2, size: LABEL_SIZE, tracking: 1.6 },
    noBoss: { width: DEST_HALF, size: REWARD_TEXT_SIZE, weight: 600 },
    varies: { width: DEST_HALF, size: REWARD_TEXT_SIZE, weight: 600 },
    noRoutes: { width: CARDS.mapPane, size: REWARD_TEXT_SIZE, wraps: true },
    noHazardRow: { width: CARDS.mapRow, size: SUB_SIZE },
    // Drawn inside the well, where the width is smallest on the whole screen.
    noHazardPane: { width: CARDS.mapHazard, size: SUB_SIZE, wraps: true },
    // Well label and its note share a line.
    hazardWellLabel: { width: CARDS.mapPane / 2, size: LABEL_SIZE, tracking: 1.4, weight: 600 },
    noHazardWellLabel: { width: CARDS.mapPane / 2, size: LABEL_SIZE, tracking: 1.4, weight: 600 },
    hazardWellNote: { width: CARDS.mapPane / 2, size: LABEL_SIZE, tracking: 1.4 },
    rewardWellLabel: { width: CARDS.mapPane / 3, size: LABEL_SIZE, tracking: 2.2 },
    briefLabel: { width: CARDS.mapPane / 3, size: LABEL_SIZE, tracking: 2.2 },
    // The two control groups share the footer line.
    controlsLeft: { width: CARDS.mapCard / 2, size: SUB_SIZE, tracking: 0.6 },
    controlsRight: { width: CARDS.mapCard / 2, size: SUB_SIZE, tracking: 0.6 },
    hint: { width: CARDS.mapCard, size: LABEL_SIZE },
    unnamedRoute: { width: CARDS.mapRow / 2, size: TITLE_SIZE, weight: 700 },
  }

  it('fits every authored string in the container it is drawn in', () => {
    for (const [key, text] of Object.entries(MAP_STRINGS)) {
      const placement = PLACED[key as keyof typeof MAP_STRINGS]
      const weight = placement.weight ?? 400
      // A wrapped string is measured line by line; an unwrapped one whole, because a
      // string the screen draws with a single `drawText` cannot break.
      const parts = placement.wraps
        ? wrapText(text, placement.width, placement.size, measure, weight)
        : [text]
      expect(parts.length, `"${key}" produced no lines`).toBeGreaterThan(0)
      for (const part of parts) {
        expect(
          measure(part, placement.size, weight, placement.tracking ?? 0),
          `"${key}" overflows its container: ${part}`,
        ).toBeLessThanOrEqual(placement.width)
      }
      // Two lines is what the well and the pane reserve for these.
      if (placement.wraps) expect(parts.length, `"${key}" needs ${parts.length} lines`).toBeLessThanOrEqual(2)
    }
  })

  it('fits both halves of every shared line together', () => {
    // Each half fitting proves nothing about the line: the pause menu's overflowing
    // hint fit its own box too.
    const pairs: readonly [keyof typeof MAP_STRINGS, keyof typeof MAP_STRINGS, number][] = [
      ['controlsLeft', 'controlsRight', CARDS.mapCard],
      ['hazardWellLabel', 'hazardWellNote', CARDS.mapPane],
      ['briefLabel', 'rewardWellLabel', CARDS.mapPane],
      ['destinationLabel', 'varies', DEST_HALF],
      ['bossLabel', 'noBoss', DEST_HALF],
    ]
    for (const [left, right, width] of pairs) {
      const a = PLACED[left]
      const b = PLACED[right]
      const combined =
        measure(MAP_STRINGS[left], a.size, a.weight ?? 400, a.tracking ?? 0) +
        16 +
        measure(MAP_STRINGS[right], b.size, b.weight ?? 400, b.tracking ?? 0)
      expect(combined, `"${left}" and "${right}" collide`).toBeLessThanOrEqual(width)
    }
  })

  it('covers every authored string, so a new one cannot skip the check', () => {
    // The record above is keyed by `keyof typeof MAP_STRINGS`, so adding a string to
    // the screen without placing it here is a typecheck failure. This asserts the
    // other direction at runtime for good measure.
    expect(Object.keys(PLACED).sort()).toEqual(Object.keys(MAP_STRINGS).sort())
  })

  it('wraps a long hazard description inside the well', () => {
    const description =
      'Corrosive bloom removes 3 hp of integrity every 2 s while you are inside it, and the cloud drifts toward the last point where you held still for longer than one second.'
    const lines = wrapText(description, CARDS.mapHazard, SUB_SIZE, measure)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(measure(line, SUB_SIZE), `hazard description overflows: ${line}`).toBeLessThanOrEqual(
        CARDS.mapHazard,
      )
    }
    // Three of these are the worst case the screen is designed for; more than four
    // lines each and the pane starts trimming, which rule 4 does not tolerate.
    expect(lines.length).toBeLessThanOrEqual(4)
  })

  it('keeps the hazard well narrower than the pane that holds it', () => {
    // Guards the guard: if these two constants ever became equal, the description
    // test above would silently stop testing the inner container.
    expect(CARDS.mapHazard).toBeLessThan(CARDS.mapPane)
    expect(CARDS.mapPane).toBeLessThanOrEqual(CARDS.mapCard)
    expect(CARDS.mapRow).toBeLessThan(CARDS.mapCard)
  })
})

describe('authored route copy fits the world map', () => {
  /**
   * Every route the builder can actually produce.
   *
   * Driven through the real `buildRoutes` rather than a table of strings copied into
   * this file, because the thing that breaks is someone writing a longer hazard
   * description in `src/content/hazards.ts` — a table restated here would not notice.
   * One pass per hazard so every authored description is measured, plus passes over
   * the whole pool at every stage index, which is what the game hands it.
   */
  function everyAuthoredRoute(): readonly RouteOption[] {
    const out: RouteOption[] = []
    const pool = Object.values(HAZARDS)
    const stages = [0, 1, 2, 3, 4]
    for (const hazard of pool) {
      for (const stageIndex of stages) {
        const rng = Rng.fromSeed(`fits-${hazard.id}-${stageIndex}`, 'routes')
        out.push(
          ...buildRoutes(rng, stageIndex, 'The Deep Manifest', 'Ledger Prime', [hazard], 120),
        )
      }
    }
    for (const stageIndex of stages) {
      const rng = Rng.fromSeed(`fits-pool-${stageIndex}`, 'routes')
      out.push(...buildRoutes(rng, stageIndex, 'The Deep Manifest', 'Ledger Prime', pool, 120))
    }
    return out
  }

  const ROUTES = everyAuthoredRoute()

  it('produced routes to measure at all', () => {
    // Guards the guard: `buildRoutes` returns [] for a stage with no hazards, and an
    // empty corpus would make every assertion below vacuous.
    expect(ROUTES.length).toBeGreaterThan(10)
    expect(ROUTES.some((route) => route.hazards.length > 0)).toBe(true)
    expect(ROUTES.some((route) => route.reward.kind === 'none')).toBe(true)
  })

  it('fits every route name beside its hazard tag and reward chip', () => {
    // The three groups share the title line. Measured together, because each fitting
    // alone proves nothing about the line. The screen truncates a name that does not
    // fit, so this failing means a name is being silently shortened on screen.
    for (const route of ROUTES) {
      const chip = rewardChip(route.reward)
      const combined =
        measure(route.name, TITLE_SIZE, 700) +
        9 +
        measure(hazardTag(route.hazards.length), SUB_SIZE) +
        14 +
        measure(chip.value, 14, 600) +
        (chip.unit === '' ? 0 : measure(` ${chip.unit}`, LABEL_SIZE))
      expect(combined, `route name "${route.name}" leaves no room for its tag and chip`)
        .toBeLessThanOrEqual(CARDS.mapRow)
    }
  })

  it('wraps every rewardText inside the detail pane', () => {
    // Rendered verbatim by the screen (UI rule 4), so it is the one string here that
    // cannot be shortened to make it fit.
    for (const route of ROUTES) {
      const lines = wrapText(route.rewardText, CARDS.mapPane, REWARD_TEXT_SIZE, measure)
      expect(lines.length, `rewardText for "${route.name}" produced no lines`).toBeGreaterThan(0)
      for (const line of lines) {
        expect(
          measure(line, REWARD_TEXT_SIZE),
          `rewardText for "${route.name}" overflows: ${line}`,
        ).toBeLessThanOrEqual(CARDS.mapPane)
      }
      // The pane reserves room for the longest sentence on the card; past three lines
      // it starts eating the hazard well.
      expect(lines.length, `rewardText for "${route.name}" needs ${lines.length} lines`)
        .toBeLessThanOrEqual(3)
    }
  })

  it('wraps every hazard description inside the well', () => {
    for (const route of ROUTES) {
      for (const hazard of route.hazards) {
        expect(
          measure(`· ${hazard.name}`, SUB_SIZE, 600),
          `hazard name "${hazard.name}" overflows the well`,
        ).toBeLessThanOrEqual(CARDS.mapPane)
        const lines = wrapText(hazard.description, CARDS.mapHazard, SUB_SIZE, measure)
        expect(lines.length, `"${hazard.name}" has no description`).toBeGreaterThan(0)
        for (const line of lines) {
          expect(
            measure(line, SUB_SIZE),
            `description for "${hazard.name}" overflows: ${line}`,
          ).toBeLessThanOrEqual(CARDS.mapHazard)
        }
        // Three of these share the well on the heaviest route.
        expect(lines.length, `"${hazard.name}" needs ${lines.length} lines`).toBeLessThanOrEqual(4)
      }
    }
  })

  it('fits the whole hazard-name summary on a single-hazard row', () => {
    // The row truncates, so this is about the common case reading in full rather than
    // about overflow: one hazard per route is what the builder produces today.
    for (const route of ROUTES) {
      if (route.hazards.length !== 1) continue
      const summary = `Hazards: ${route.hazards.map((hazard) => hazard.name).join(', ')}`
      expect(measure(summary, SUB_SIZE), `row summary truncated: ${summary}`).toBeLessThanOrEqual(
        CARDS.mapRow,
      )
    }
  })
})

describe('hull issue copy fits its containers', () => {
  /** Which container each authored string is drawn in, and at what size. */
  interface HullPlacement {
    width: number
    size: number
    tracking?: number
    weight?: 400 | 600 | 700
    /** The screen wraps this one, so its lines are measured rather than the whole string. */
    wraps?: true
  }

  /** Room reserved on the header rows for the right-aligned seed and its label. */
  const SEED_W = measure('SORTIE SEED', HULL_LABEL_SIZE, 400, 1.6) + 16
  /** The two column headings share a row, one per half of the trade table. */
  const HALF = CARDS.hullCol

  const HULL_PLACED: Readonly<Record<keyof typeof HULL_SELECT_STRINGS, HullPlacement>> = {
    eyebrow: { width: CARDS.hullCard - SEED_W, size: HULL_LABEL_SIZE, tracking: 1.6 },
    title: { width: CARDS.hullCard - SEED_W, size: 22, tracking: 2.4, weight: 700 },
    seedLabel: { width: SEED_W, size: HULL_LABEL_SIZE, tracking: 1.6 },
    standfirst: { width: CARDS.hullCard, size: HULL_SUB_SIZE, wraps: true },
    notice: { width: CARDS.hullCard, size: HULL_LABEL_SIZE, wraps: true },
    costsHeading: { width: HALF, size: HULL_LABEL_SIZE, tracking: 1.4, weight: 600 },
    gainsHeading: { width: HALF, size: HULL_LABEL_SIZE, tracking: 1.4, weight: 600 },
    // Shares its row with the loadout's first value.
    startsLabel: { width: CARDS.hullText / 3, size: HULL_LABEL_SIZE, tracking: 1.4, weight: 600 },
    // Shares its row with the net sentence, measured together below.
    netLabel: { width: CARDS.hullText / 4, size: HULL_LABEL_SIZE, tracking: 1.4, weight: 600 },
    baseline: { width: CARDS.hullText, size: HULL_ROW_SIZE },
    empty: { width: CARDS.hullCard, size: HULL_SUB_SIZE },
    controlsLeft: { width: CARDS.hullCard / 3, size: HULL_SUB_SIZE, tracking: 0.6 },
    controlsRight: { width: (CARDS.hullCard * 2) / 3, size: HULL_SUB_SIZE, tracking: 0.6 },
  }

  it('fits every authored string in the container it is drawn in', () => {
    for (const [key, text] of Object.entries(HULL_SELECT_STRINGS)) {
      const placement = HULL_PLACED[key as keyof typeof HULL_SELECT_STRINGS]
      const weight = placement.weight ?? 400
      const parts = placement.wraps
        ? wrapText(text, placement.width, placement.size, measure, weight)
        : [text]
      expect(parts.length, `"${key}" produced no lines`).toBeGreaterThan(0)
      for (const part of parts) {
        expect(
          measure(part, placement.size, weight, placement.tracking ?? 0),
          `"${key}" overflows its container: ${part}`,
        ).toBeLessThanOrEqual(placement.width)
      }
      // Two lines is what the header reserves for each of the wrapped strings.
      if (placement.wraps) {
        expect(parts.length, `"${key}" needs ${parts.length} lines`).toBeLessThanOrEqual(2)
      }
    }
  })

  it('covers every authored string, so a new one cannot skip the check', () => {
    expect(Object.keys(HULL_PLACED).sort()).toEqual(Object.keys(HULL_SELECT_STRINGS).sort())
  })

  it('fits both halves of every shared line together', () => {
    // Each half fitting proves nothing about the line: the pause menu's overflowing
    // hint fit its own box too.
    expect(
      measure(HULL_SELECT_STRINGS.controlsLeft, HULL_SUB_SIZE, 400, 0.6) +
        16 +
        measure(HULL_SELECT_STRINGS.controlsRight, HULL_SUB_SIZE, 400, 0.6),
      'the two control groups collide',
    ).toBeLessThanOrEqual(CARDS.hullCard)

    expect(
      measure(HULL_SELECT_STRINGS.costsHeading, HULL_LABEL_SIZE, 600, 1.4) + CARDS.hullCol,
      'the GIVES UP heading runs into the GAINS column',
    ).toBeLessThanOrEqual(CARDS.hullText)
  })

  it('fits the launch hint beside the pool counter for every hull name', () => {
    // The hint names the selected hull, so its width depends on the roster. The
    // counter shares the line and the longest plausible one is used, not today's.
    const counter = poolCountText(3, 12)
    for (const def of Object.values(HULLS)) {
      const combined =
        measure(launchHint(def.name), HULL_LABEL_SIZE) + 16 + measure(counter, HULL_LABEL_SIZE)
      expect(combined, `the hint for "${def.name}" collides with the pool counter`)
        .toBeLessThanOrEqual(CARDS.hullCard)
    }
  })

  it('wraps every hull mechanism inside a hull card', () => {
    // Rule 4's sentence, rendered verbatim, so it is the least acceptable thing to
    // clip on the one screen where a player commits to a hull for a whole run.
    for (const def of Object.values(HULLS)) {
      const lines = wrapText(def.mechanism, CARDS.hullText, HULL_MECH_SIZE, measure)
      expect(lines.length, `${def.id} produced no mechanism lines`).toBeGreaterThan(0)
      for (const line of lines) {
        expect(
          measure(line, HULL_MECH_SIZE),
          `mechanism for "${def.id}" overflows: ${line}`,
        ).toBeLessThanOrEqual(CARDS.hullText)
      }
      // Three cards share the height. A four-line mechanism does not overflow
      // horizontally; it pushes the third card off the bottom.
      expect(lines.length, `mechanism for "${def.id}" needs ${lines.length} lines`)
        .toBeLessThanOrEqual(3)
    }
  })

  it('fits every hull name on its title line', () => {
    for (const def of Object.values(HULLS)) {
      expect(
        measure(def.name, HULL_TITLE_SIZE, 700) + measure(' [baseline]', HULL_SUB_SIZE),
        `name "${def.name}" leaves no room for its tag`,
      ).toBeLessThanOrEqual(CARDS.hullText)
    }
  })

  it('wraps every hull flavour line', () => {
    for (const def of Object.values(HULLS)) {
      if (!def.flavour) continue
      const lines = wrapText(def.flavour, CARDS.hullText, HULL_SUB_SIZE, measure)
      for (const line of lines) {
        expect(measure(line, HULL_SUB_SIZE), `flavour for "${def.id}" overflows`)
          .toBeLessThanOrEqual(CARDS.hullText)
      }
      expect(lines.length, `flavour for "${def.id}" needs ${lines.length} lines`)
        .toBeLessThanOrEqual(2)
    }
  })

  it('fits every stat row and its signed delta inside one table column', () => {
    // The rows are DERIVED from the stat table, so this is the check that catches a
    // stat rename or a retune widening a row into the column beside it. Rows cannot
    // wrap — they are drawn with a single `drawText`.
    for (const def of Object.values(HULLS)) {
      const { costs, gains } = compareToBaseline(def)
      for (const row of [...costs, ...gains]) {
        expect(
          measure(row.text, HULL_ROW_SIZE) + measure(` ${row.deltaText}`, HULL_LABEL_SIZE, 600),
          `"${row.text} ${row.deltaText}" on ${def.id} overflows its column`,
        ).toBeLessThanOrEqual(CARDS.hullCol)
      }
    }
  })

  it('fits every derived net line beside its label on one line of a card', () => {
    // The label shares the row, so the two are measured together — each fitting alone
    // proves nothing about the line.
    const label = measure(HULL_SELECT_STRINGS.netLabel, HULL_LABEL_SIZE, 600, 1.4) + 10
    for (const def of Object.values(HULLS)) {
      const net = compareToBaseline(def).net
      if (net === null) continue
      const lines = wrapText(net, CARDS.hullText - label, HULL_ROW_SIZE, measure)
      for (const line of lines) {
        expect(
          label + measure(line, HULL_ROW_SIZE),
          `net for "${def.id}" collides with its label: ${line}`,
        ).toBeLessThanOrEqual(CARDS.hullText)
      }
      expect(lines.length, `net for "${def.id}" needs ${lines.length} lines`).toBe(1)
    }
  })

  it('fits every starting relic name, tier and mechanism', () => {
    // Rule 4 applied to the loadout block: the item's own sentence is on the card, so
    // it has to fit the card.
    for (const def of Object.values(HULLS)) {
      for (const id of def.startingItems ?? []) {
        const item = ITEMS[id]
        expect(item, `${def.id} grants unknown item ${id}`).toBeDefined()
        if (!item) continue
        expect(
          measure(`${item.name} [${item.tier}]`, HULL_ROW_SIZE),
          `"${item.name}" overflows the loadout row`,
        ).toBeLessThanOrEqual(CARDS.hullText)
        const lines = wrapText(item.mechanism, CARDS.hullText, HULL_LABEL_SIZE, measure)
        for (const line of lines) {
          expect(
            measure(line, HULL_LABEL_SIZE),
            `mechanism for "${item.id}" overflows the loadout block: ${line}`,
          ).toBeLessThanOrEqual(CARDS.hullText)
        }
        expect(lines.length, `${item.id} needs ${lines.length} loadout lines`).toBeLessThanOrEqual(2)
      }
    }
  })

  it('keeps a table column narrower than the card that holds it', () => {
    // Guards the guard: if these constants ever became equal, the row test above would
    // silently stop testing the inner container.
    expect(CARDS.hullCol).toBeLessThan(CARDS.hullText)
    expect(CARDS.hullText).toBeLessThan(CARDS.hullCard)
  })
})

describe('the measurement itself', () => {
  it('never reports a width below the minimum font size would allow', () => {
    // Guards the guard: if `measure` were accidentally zeroed, every test above
    // would pass while measuring nothing.
    expect(measure('x', Font.minSizePx)).toBeGreaterThan(0)
    expect(measure('xxxxxxxxxx', 13)).toBeGreaterThan(measure('x', 13))
  })

  it('errs wide, so passing here means fitting on screen', () => {
    // A real monospace advance is ~0.6em. Under-measuring would let exactly the
    // overflowing strings through, which is the failure this file exists to stop.
    expect(EM_RATIO).toBeGreaterThan(0.6)
  })
})
