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
import { ITEMS } from '../src/content/items'
import { INTERACTIONS } from '../src/content/interactions'
import { WORK_ORDERS } from '../src/content/workOrders'
import { Font } from '../src/render/palette'
import { wrapText, type Measure } from '../src/render/text'
import { CHOICE_CONTENT_W, OPTION_TEXT_W } from '../src/ui/choiceScreen'
import {
  PAUSE_CONTENT_W,
  PAUSE_FOOTER_SIZE,
  PAUSE_FOOTER_TEXT,
  PAUSE_HINT_SIZE,
  PAUSE_ITEMS,
} from '../src/ui/pauseMenu'

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
