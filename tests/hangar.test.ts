/**
 * Hangar layout tests.
 *
 * Headless by construction, the same way `tests/choiceScreen.test.ts` is:
 * `layoutHangar` returns every rect and every positioned, pre-measured line, so the
 * things that actually break on this screen — a condition that never got drawn,
 * prose past the card edge, a locked entry that fails to say what unlocks it — are
 * all assertable without a canvas. Nobody has looked at this screen rendered yet,
 * which is exactly why it has to be checkable.
 *
 * WIDTHS COME FROM THE SCREEN'S OWN CONSTANTS. `tests/textFits.test.ts` records why:
 * the first hardcoded width in that file was wrong by a factor of three, and "a test
 * that restates a layout number tests its own guess."
 */

import { describe, expect, it } from 'vitest'
import { CERTIFICATIONS, type CertificationDef } from '../src/content/certifications'
import { Font } from '../src/render/palette'
import { wrapText, type Measure } from '../src/render/text'
import { lineBounds, monoMeasure, type TextLine } from '../src/ui/choiceScreen'
import {
  HANGAR_CONTENT_W,
  HANGAR_ENTRY_TEXT_W,
  HANGAR_FOOTER_TEXT,
  HANGAR_LABEL_SIZE,
  HANGAR_BODY_SIZE,
  HANGAR_PURIST_NOTICE,
  HANGAR_STANDFIRST,
  hangarNameFor,
  hangarWindow,
  layoutHangar,
  moveHangarSelection,
  type HangarLayout,
  type HangarLayoutInput,
} from '../src/ui/hangar'
import { CERTIFICATION_IDS, describeCondition } from '../src/meta/certifications'

const WAVE_COUNT = 30

/**
 * The same conservative monospace estimate `tests/textFits.test.ts` uses.
 *
 * Erring wide is deliberate: a test that under-measures passes exactly the strings
 * that then overflow on screen.
 */
const measure: Measure = monoMeasure

function layout(overrides: Partial<HangarLayoutInput> = {}): HangarLayout {
  const base: HangarLayoutInput = {
    unlocked: new Set<string>(),
    progress: {},
    waveCount: WAVE_COUNT,
    selected: 0,
    tick: 0,
    measure,
  }
  return layoutHangar({ ...base, ...overrides })
}

function allLines(result: HangarLayout): readonly TextLine[] {
  return [...result.header, ...result.footer, ...result.entries.flatMap((entry) => entry.lines)]
}

/** Whitespace-insensitive containment, since wrapping rewrites the spaces. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
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

// ---------------------------------------------------------------------------

describe('every entry’s copy fits its container', () => {
  it('wraps every effect line inside the row text column', () => {
    for (const def of CERTIFICATIONS) {
      const lines = wrapText(def.effect, HANGAR_ENTRY_TEXT_W, HANGAR_BODY_SIZE, measure)
      expect(lines.length, `${def.id} produced no effect lines`).toBeGreaterThan(0)
      for (const line of lines) {
        expect(
          measure(line, HANGAR_BODY_SIZE),
          `effect for "${def.id}" overflows: ${line}`,
        ).toBeLessThanOrEqual(HANGAR_ENTRY_TEXT_W)
      }
    }
  })

  it('keeps every effect to at most two lines', () => {
    // Rows are a fixed pitch per line and ten of them share the card. A three-line
    // effect does not overflow horizontally; it pushes an entry out of the window,
    // which is a certification the player cannot see.
    for (const def of CERTIFICATIONS) {
      const lines = wrapText(def.effect, HANGAR_ENTRY_TEXT_W, HANGAR_BODY_SIZE, measure)
      expect(lines.length, `effect for "${def.id}" needs ${lines.length} lines`).toBeLessThanOrEqual(
        2,
      )
    }
  })

  it('wraps every stated condition inside the row text column', () => {
    for (const def of CERTIFICATIONS) {
      const text = `Unlocks: ${describeCondition(def.condition, { waveCount: WAVE_COUNT, nameFor: hangarNameFor })}`
      const lines = wrapText(text, HANGAR_ENTRY_TEXT_W, HANGAR_BODY_SIZE, measure)
      expect(lines.length, `${def.id} produced no condition lines`).toBeGreaterThan(0)
      for (const line of lines) {
        expect(
          measure(line, HANGAR_BODY_SIZE),
          `condition for "${def.id}" overflows: ${line}`,
        ).toBeLessThanOrEqual(HANGAR_ENTRY_TEXT_W)
      }
      expect(lines.length, `condition for "${def.id}" needs ${lines.length} lines`).toBeLessThanOrEqual(2)
    }
  })

  it('wraps every pending notice inside the row text column', () => {
    for (const def of CERTIFICATIONS) {
      if (def.awaiting === null) continue
      const lines = wrapText(
        `Content pending: ${def.awaiting}.`,
        HANGAR_ENTRY_TEXT_W,
        HANGAR_LABEL_SIZE,
        measure,
      )
      // One line by intent, but the layout wraps it either way — this notice ran past
      // the row edge in the first draft because it was drawn unmeasured.
      expect(lines.length, `pending notice for "${def.id}" wraps`).toBe(1)
      for (const line of lines) {
        expect(measure(line, HANGAR_LABEL_SIZE)).toBeLessThanOrEqual(HANGAR_ENTRY_TEXT_W)
      }
    }
  })

  it('fits every name beside its grant tag and its status word', () => {
    // All three share the title line, so their combined width is what matters. The
    // widest status word is used, not whichever the current state produces.
    const result = layout()
    for (const entry of layout({ unlocked: new Set(CERTIFICATION_IDS) }).entries.concat(
      result.entries,
    )) {
      const combined =
        measure(entry.name, 14, 700) +
        9 +
        measure(entry.grantTag, HANGAR_LABEL_SIZE) +
        12 +
        measure('NOT CERTIFIED', HANGAR_LABEL_SIZE, 600, 1.2)
      expect(combined, `title line for "${entry.id}" is too wide`).toBeLessThanOrEqual(
        HANGAR_ENTRY_TEXT_W,
      )
    }
  })

  it('fits the header copy and the footer inside the content column', () => {
    for (const line of wrapText(HANGAR_STANDFIRST, HANGAR_CONTENT_W, HANGAR_BODY_SIZE, measure)) {
      expect(measure(line, HANGAR_BODY_SIZE)).toBeLessThanOrEqual(HANGAR_CONTENT_W)
    }
    for (const line of wrapText(
      HANGAR_PURIST_NOTICE,
      HANGAR_CONTENT_W,
      HANGAR_LABEL_SIZE,
      measure,
    )) {
      expect(measure(line, HANGAR_LABEL_SIZE)).toBeLessThanOrEqual(HANGAR_CONTENT_W)
    }
    // The footer shares its line with a right-aligned "Showing 1 to 6 of 10".
    expect(
      measure(HANGAR_FOOTER_TEXT, HANGAR_BODY_SIZE) + measure(' Showing 10 to 10 of 10', HANGAR_LABEL_SIZE),
    ).toBeLessThanOrEqual(HANGAR_CONTENT_W)
  })

  it('measures something, so the assertions above are not vacuous', () => {
    // Guards the guard. A zeroed measure would make every containment check pass.
    expect(measure('x', Font.minSizePx)).toBeGreaterThan(0)
    expect(measure('xxxxxxxxxx', 13)).toBeGreaterThan(measure('x', 13))
    expect(HANGAR_ENTRY_TEXT_W).toBeGreaterThan(0)
    expect(HANGAR_ENTRY_TEXT_W).toBeLessThan(HANGAR_CONTENT_W)
  })
})

describe('nothing escapes its row or the card', () => {
  const cases: ReadonlyArray<{ name: string; input: Partial<HangarLayoutInput> }> = [
    { name: 'nothing filed', input: {} },
    { name: 'everything filed', input: { unlocked: new Set(CERTIFICATION_IDS) } },
    {
      name: 'half filed with progress recorded',
      input: {
        unlocked: new Set(CERTIFICATION_IDS.slice(0, 5)),
        progress: Object.fromEntries(CERTIFICATION_IDS.map((id) => [id, 999])),
      },
    },
    { name: 'purist', input: { purist: true } },
    { name: 'last entry selected', input: { selected: CERTIFICATIONS.length - 1 } },
  ]

  for (const testCase of cases) {
    it(`keeps every line inside its box — ${testCase.name}`, () => {
      const result = layout(testCase.input)
      const cardRight = result.card.x + result.card.w
      const cardBottom = result.card.y + result.card.h

      expect(result.overflow, 'a row did not fit the list area').toBe(false)
      expect(result.entries.length).toBeGreaterThan(0)

      for (const entry of result.entries) {
        expect(entry.box.x).toBeGreaterThanOrEqual(result.card.x)
        expect(entry.box.x + entry.box.w).toBeLessThanOrEqual(cardRight)
        expect(entry.box.y).toBeGreaterThanOrEqual(result.card.y)
        expect(entry.box.y + entry.box.h).toBeLessThanOrEqual(cardBottom)

        for (const line of entry.lines) {
          const bounds = lineBounds(line)
          expect(bounds.left, `${entry.id}: "${line.text}" left of its row`).toBeGreaterThanOrEqual(
            entry.box.x,
          )
          expect(
            bounds.right,
            `${entry.id}: "${line.text}" past its row`,
          ).toBeLessThanOrEqual(entry.box.x + entry.box.w)
          expect(line.y).toBeGreaterThanOrEqual(entry.box.y)
          expect(
            line.y + line.size,
            `${entry.id}: "${line.text}" below its row`,
          ).toBeLessThanOrEqual(entry.box.y + entry.box.h)
        }
      }

      for (const line of allLines(result)) {
        const bounds = lineBounds(line)
        expect(bounds.left, `"${line.text}" left of the card`).toBeGreaterThanOrEqual(result.card.x)
        expect(bounds.right, `"${line.text}" past the card`).toBeLessThanOrEqual(cardRight)
        expect(line.y + line.size, `"${line.text}" below the card`).toBeLessThanOrEqual(cardBottom)
      }
    })
  }

  it('never renders below the minimum font size (rule 7)', () => {
    for (const line of allLines(layout())) {
      expect(line.size, `"${line.text}" is too small`).toBeGreaterThanOrEqual(Font.minSizePx - 1)
    }
  })

  it('produces no NaN for any plausible input', () => {
    const inputs: ReadonlyArray<Partial<HangarLayoutInput>> = [
      {},
      { selected: Number.NaN, tick: Number.NaN },
      { selected: -7 },
      { selected: 999 },
      { waveCount: 0 },
      { progress: { 'vault-clearance': Number.NaN } },
    ]
    for (const input of inputs) {
      const result = layout(input)
      for (const value of numbersIn(result)) expect(Number.isFinite(value)).toBe(true)
    }
  })
})

describe('locked entries state their condition explicitly (UI rule 4)', () => {
  it('gives every locked row a condition line and no unlocked row one', () => {
    const result = layout({ selected: 0 })
    for (const entry of result.entries) {
      expect(entry.unlocked).toBe(false)
      expect(entry.conditionLines.length, `${entry.id} states no condition`).toBeGreaterThan(0)
    }

    const filed = layout({ unlocked: new Set(CERTIFICATION_IDS) })
    for (const entry of filed.entries) {
      expect(entry.unlocked).toBe(true)
      expect(entry.conditionLines).toEqual([])
    }
  })

  it('draws the whole condition sentence, unabbreviated', () => {
    // Truncating a condition would satisfy "states its condition" while telling the
    // player something incomplete, which is the failure mode rule 4 is aimed at.
    const result = layout()
    for (const entry of result.entries) {
      const def = CERTIFICATIONS.find((candidate) => candidate.id === entry.id) as CertificationDef
      const expected = collapse(
        `Unlocks: ${describeCondition(def.condition, { waveCount: WAVE_COUNT, nameFor: hangarNameFor })}`,
      )
      expect(collapse(entry.conditionLines.join(' '))).toBe(expected)
    }
  })

  it('never says "keep playing" and never leaves a row with only a name', () => {
    for (const entry of layout().entries) {
      expect(entry.effectLines.length, `${entry.id} shows no effect`).toBeGreaterThan(0)
      const prose = entry.lines.map((line) => line.text).join(' ').toLowerCase()
      expect(prose).not.toContain('keep playing')
      expect(prose).not.toContain('coming soon')
    }
  })

  it('states the condition for every certification in the roster across scroll positions', () => {
    // A row the window never reaches is a condition the player cannot read, so the
    // sweep walks every selection index rather than trusting the first screenful.
    const seen = new Set<string>()
    for (let i = 0; i < CERTIFICATIONS.length; i++) {
      for (const entry of layout({ selected: i }).entries) {
        if (entry.conditionLines.length > 0) seen.add(entry.id)
      }
    }
    expect([...seen].sort()).toEqual([...CERTIFICATION_IDS].sort())
  })
})

describe('what each entry adds is shown', () => {
  it('tags every row with a computed grant count', () => {
    for (const entry of layout().entries) {
      const def = CERTIFICATIONS.find((candidate) => candidate.id === entry.id) as CertificationDef
      expect(entry.grantTag, `${entry.id} has no grant tag`).not.toBe('')
      expect(entry.grantTag).toMatch(/^\+\d/)
      // The tag's numbers must add up to the grants beneath it.
      const total = [...entry.grantTag.matchAll(/\+(\d+)/g)].reduce(
        (sum, match) => sum + Number(match[1]),
        0,
      )
      expect(total).toBe(def.grants.length)
    }
  })

  it('says when a certification’s content has not shipped', () => {
    // A locked row carries the marker on its title line — it costs no vertical space,
    // and it is what stops a player chasing a reward that does not arrive. The full
    // sentence appears once the certification is filed and the fact is actionable.
    for (let i = 0; i < CERTIFICATIONS.length; i++) {
      for (const entry of layout({ selected: i }).entries) {
        const def = CERTIFICATIONS.find((c) => c.id === entry.id) as CertificationDef
        expect(entry.grantTag.includes('pending'), `${entry.id} marker`).toBe(def.awaiting !== null)
        expect(entry.pendingLines, `${entry.id} spends a line while locked`).toEqual([])
      }
    }

    for (let i = 0; i < CERTIFICATIONS.length; i++) {
      for (const entry of layout({ unlocked: new Set(CERTIFICATION_IDS), selected: i }).entries) {
        const def = CERTIFICATIONS.find((c) => c.id === entry.id) as CertificationDef
        if (def.awaiting === null) expect(entry.pendingLines).toEqual([])
        else expect(collapse(entry.pendingLines.join(' '))).toContain(collapse(def.awaiting))
      }
    }
  })

  it('keeps every effect to a single line, so the list stays dense', () => {
    // Two lines is the layout's cap; one is the target. Each extra body line costs a
    // row off the visible window, and a certification the player has to scroll to is
    // one they may never read.
    for (const entry of layout().entries) {
      expect(entry.effectLines.length, `${entry.id} needs two lines`).toBe(1)
    }
  })

  it('shows at least half the roster without scrolling', () => {
    // A flat list the player has to page through three times is flat in structure and
    // not in practice. Asserted so a longer entry cannot quietly halve the window.
    const result = layout()
    expect(result.visibleCount * 2).toBeGreaterThanOrEqual(result.rosterCount)
  })

  it('reports the pool the next sortie will actually draw from', () => {
    const none = layout()
    const all = layout({ unlocked: new Set(CERTIFICATION_IDS) })
    expect(none.poolCount).toBeLessThan(all.poolCount)
    expect(all.poolCount).toBe(all.fullPoolCount)
    expect(none.fullPoolCount).toBe(all.fullPoolCount)
    expect(none.filedCount).toBe(0)
    expect(all.filedCount).toBe(CERTIFICATIONS.length)
    expect(all.rosterCount).toBe(CERTIFICATIONS.length)
  })

  it('shows the base pool in purist mode even when certifications are held', () => {
    // A hangar advertising a certified pool while the run flies the base one would be
    // the panel-advertising-a-fire-rate-it-does-not-have bug, one screen over.
    const certified = layout({ unlocked: new Set(CERTIFICATION_IDS) })
    const purist = layout({ unlocked: new Set(CERTIFICATION_IDS), purist: true })
    expect(purist.poolCount).toBeLessThan(certified.poolCount)
    const notice = purist.header.map((line) => line.text).join(' ')
    expect(collapse(notice)).toContain(collapse(HANGAR_PURIST_NOTICE).slice(0, 30))
  })
})

describe('progress toward a condition', () => {
  it('shows a best where one is meaningful and nothing where it is not', () => {
    const result = layout({ progress: Object.fromEntries(CERTIFICATION_IDS.map((id) => [id, 12])) })
    let withProgress = 0
    for (const entry of result.entries) {
      if (entry.progressLine === null) continue
      withProgress++
      expect(entry.progressLine).toContain('12')
      // Rule 2: a bare "12 of 15" could be waves, kills, or credits.
      expect(entry.progressLine.replace(/[\d%\s]/g, '').length).toBeGreaterThan(0)
    }
    expect(withProgress).toBeGreaterThan(0)
  })

  it('shows no progress line before any sortie has reported one', () => {
    for (const entry of layout({ progress: {} }).entries) {
      expect(entry.progressLine).toBeNull()
    }
  })

  it('shows no progress line on a filed certification', () => {
    const result = layout({
      unlocked: new Set(CERTIFICATION_IDS),
      progress: Object.fromEntries(CERTIFICATION_IDS.map((id) => [id, 12])),
    })
    for (const entry of result.entries) expect(entry.progressLine).toBeNull()
  })
})

describe('selection and scrolling', () => {
  it('wraps rather than clamping, matching the pause menu', () => {
    expect(moveHangarSelection(0, -1, 10)).toBe(9)
    expect(moveHangarSelection(9, 1, 10)).toBe(0)
    expect(moveHangarSelection(4, 2, 10)).toBe(6)
    expect(moveHangarSelection(Number.NaN, 1, 10)).toBe(1)
    expect(moveHangarSelection(3, 1, 0)).toBe(0)
  })

  it('keeps the selected row visible at every index', () => {
    for (let i = 0; i < CERTIFICATIONS.length; i++) {
      const result = layout({ selected: i })
      expect(result.selected).toBe(i)
      expect(
        result.entries.some((entry) => entry.index === i && entry.selected),
        `selection ${i} is off screen`,
      ).toBe(true)
    }
  })

  it('marks exactly one row selected', () => {
    for (let i = 0; i < CERTIFICATIONS.length; i++) {
      const selected = layout({ selected: i }).entries.filter((entry) => entry.selected)
      expect(selected.length).toBe(1)
    }
  })

  it('stays top-anchored until it has to scroll', () => {
    expect(layout({ selected: 0 }).scrollTop).toBe(0)
    const last = layout({ selected: CERTIFICATIONS.length - 1 })
    expect(last.scrollTop).toBeGreaterThan(0)
    expect(last.scrollTop + last.visibleCount).toBe(CERTIFICATIONS.length)
  })

  it('does not change a row’s height when it is selected', () => {
    // Text that moves when you press down is text you have to re-read.
    const a = layout({ selected: 0 })
    const b = layout({ selected: 1 })
    const heightOf = (result: HangarLayout, id: string): number | undefined =>
      result.entries.find((entry) => entry.id === id)?.box.h
    for (const entry of a.entries) {
      const other = heightOf(b, entry.id)
      if (other === undefined) continue
      expect(other, `${entry.id} changed height with selection`).toBe(entry.box.h)
    }
  })

  it('windows an empty list without throwing', () => {
    expect(hangarWindow([], 0, 400)).toEqual({ top: 0, count: 0, overflow: false })
    const empty = layoutHangar({
      unlocked: new Set<string>(),
      progress: {},
      waveCount: WAVE_COUNT,
      selected: 0,
      tick: 0,
      roster: [],
      measure,
    })
    expect(empty.entries).toEqual([])
    expect(empty.rosterCount).toBe(0)
    expect(empty.overflow).toBe(false)
  })

  it('flags overflow rather than clipping a row that cannot fit', () => {
    // The honest failure. Silently dropping the row would hide a certification.
    expect(hangarWindow([500], 0, 100)).toEqual({ top: 0, count: 1, overflow: true })
  })
})

describe('accessibility and colour discipline', () => {
  it('carries the status in a word, not only in a colour (rule 3)', () => {
    const locked = layout().entries
    const filed = layout({ unlocked: new Set(CERTIFICATION_IDS) }).entries
    for (const entry of locked) expect(entry.statusLabel).toBe('NOT CERTIFIED')
    for (const entry of filed) expect(entry.statusLabel).toBe('CERTIFIED')
    for (const entry of [...locked, ...filed]) {
      expect(entry.lines.some((line) => line.text === entry.statusLabel)).toBe(true)
    }
  })

  it('marks the selection with a caret as well as a wash', () => {
    const selected = layout({ selected: 2 }).entries.find((entry) => entry.selected)
    expect(selected?.lines.some((line) => line.text === '>')).toBe(true)
  })

  it('never lets the selection pulse reach zero opacity (rule 10)', () => {
    // A pulse that hits zero is a blink, and rule 10 is a hard constraint.
    for (let tick = 0; tick < 400; tick++) {
      const { pulse } = layout({ tick })
      expect(pulse).toBeGreaterThan(0.05)
      expect(pulse).toBeLessThan(0.3)
    }
  })

  it('uses no danger colour anywhere', () => {
    // `danger` means "can hurt you this instant". An unearned unlock cannot.
    const DANGER = '#FF4A38'
    for (const line of allLines(layout())) {
      expect(line.color.toUpperCase()).not.toBe(DANGER)
    }
    for (const entry of layout().entries) expect(entry.accent.toUpperCase()).not.toBe(DANGER)
  })
})

describe('name resolution', () => {
  it('prefers a content table name and falls back to a readable id', () => {
    expect(hangarNameFor('turret-heavy')).toBe('Heavy Turret')
    expect(hangarNameFor('machined-slugs')).toBe('Machined Slugs')
    expect(hangarNameFor('not-in-any-table')).toBe('Not In Any Table')
  })
})
