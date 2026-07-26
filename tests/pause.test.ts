import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../src/meta/save'
import type { Measure } from '../src/render/text'
import {
  PAUSE_ARROW_GAP,
  PAUSE_ARROW_GUTTER,
  PAUSE_ARROW_SIZE,
  PAUSE_CARD,
  PAUSE_CONTENT_W,
  PAUSE_ITEMS,
  PAUSE_ROW_TEXT_SIZE,
  adjustSetting,
  drawPauseMenu,
  formatSettingValue,
  movePauseSelection,
  type PauseItemId,
  type PauseMenuState,
} from '../src/ui/pauseMenu'

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

// ---------------------------------------------------------------------------
// a recording context, so what the card actually draws can be asserted
// ---------------------------------------------------------------------------

interface Drawn {
  readonly text: string
  /** Left edge of the ink: `drawText` resolves alignment before calling fillText. */
  readonly x: number
  readonly y: number
  readonly width: number
}

/** 7 units per character, the same stub advance `tests/render.test.ts` measures with. */
const STUB_ADVANCE = 7

function stubCtx(): { ctx: CanvasRenderingContext2D; texts: Drawn[] } {
  const texts: Drawn[] = []
  const target: Record<string, unknown> = {
    measureText: (text: string) => ({ width: String(text).length * STUB_ADVANCE }),
    fillRect: (): void => {},
    strokeRect: (): void => {},
    fillText: (text: string, x: number, y: number): void => {
      const value = String(text)
      texts.push({ text: value, x, y, width: value.length * STUB_ADVANCE })
    },
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
  }
  return { ctx: target as unknown as CanvasRenderingContext2D, texts }
}

function pauseState(overrides: Partial<PauseMenuState> = {}): PauseMenuState {
  return {
    selected: 0,
    settings: settings(),
    tick: 0,
    waveIndex: 3,
    waveCount: 9,
    seed: 'TEST-SEED',
    ...overrides,
  }
}

function rowIndex(id: PauseItemId): number {
  const index = PAUSE_ITEMS.findIndex((item) => item.id === id)
  if (index < 0) throw new Error(`no pause row ${id}`)
  return index
}

function render(overrides: Partial<PauseMenuState> = {}): Drawn[] {
  const { ctx, texts } = stubCtx()
  drawPauseMenu(ctx, pauseState(overrides))
  return texts
}

/**
 * The value glyphs of one row.
 *
 * Located by the row's own label first, because two rows can legitimately show the
 * same string — 'Mute' and 'Reduce flashes' both read 'Off' — and matching on the
 * value alone silently asserted against the wrong row.
 */
function valueDraw(texts: readonly Drawn[], id: PauseItemId, state: Settings): Drawn {
  const item = PAUSE_ITEMS.find((row) => row.id === id)
  if (!item) throw new Error(`no pause row ${id}`)
  const label = texts.find((drawn) => drawn.text === item.label)
  if (!label) throw new Error(`the card never drew the label "${item.label}"`)
  const { value } = formatSettingValue(state, id)
  const found = texts.find((drawn) => drawn.text === value && drawn.y === label.y)
  if (!found) throw new Error(`the card never drew "${value}" on the ${id} row`)
  return found
}

/**
 * The content column's right edge, DERIVED from the card and the exported column
 * width rather than restated. A test that hardcodes a width stops testing the layout
 * the moment the card is resized, which is how the overflowing hint survived.
 */
const PAUSE_PAD = (PAUSE_CARD.w - PAUSE_CONTENT_W) / 2
const CONTENT_RIGHT = PAUSE_CARD.x + PAUSE_PAD + PAUSE_CONTENT_W

describe('the adjust affordance', () => {
  /**
   * R9: the card drew a lone '<' at a fixed x, 150 units from the label and nowhere
   * near the value it modifies. A row read `Volume  <  75 %` — one arrow, pointing
   * away from the number, telling the player LEFT is the only key that does anything.
   */
  it('brackets the value with both arrows on the selected row', () => {
    for (const id of ['shake', 'volume', 'mute', 'flashes'] as const) {
      const state = settings()
      const texts = render({ selected: rowIndex(id), settings: state })
      const value = valueDraw(texts, id, state)
      const onRow = texts.filter((drawn) => drawn.y === value.y)

      const before = onRow.filter((drawn) => drawn.text === '<')
      // The selection caret is also a '>', drawn to the LEFT of the label, so the
      // affordance is the one on the value's right.
      const after = onRow.filter((drawn) => drawn.text === '>' && drawn.x > value.x)

      expect(before, `${id} row is missing its left arrow`).toHaveLength(1)
      expect(after, `${id} row is missing its right arrow`).toHaveLength(1)

      const left = before[0]
      const right = after[0]
      if (!left || !right) throw new Error('unreachable')
      // Bracketing, not merely present: an arrow on the wrong side of the value is
      // the defect, not the absence of a glyph. And ATTACHED to it — the old arrow sat
      // at a fixed x, which happens to land left of the value too, so a test that only
      // checked the side would have passed on the bug.
      expect(value.x - (left.x + left.width), `${id}: left arrow is not beside the value`).toBe(
        PAUSE_ARROW_GAP,
      )
      expect(right.x, `${id}: right arrow overlaps the value`).toBeGreaterThanOrEqual(
        value.x + value.width,
      )
      // And inside the column, measured to the far edge of the glyph.
      expect(right.x + right.width, `${id}: right arrow escapes the card`).toBeLessThanOrEqual(
        CONTENT_RIGHT,
      )
    }
  })

  it('draws no arrows on an unselected row, or on a row nothing adjusts', () => {
    const onlyResume = render({ selected: rowIndex('resume') })
    expect(onlyResume.filter((drawn) => drawn.text === '<')).toHaveLength(0)
    // Resume is an action: its row has no value, so there is nothing to point at.
    const resumeY = onlyResume.find((drawn) => drawn.text === 'Resume sortie')?.y
    expect(
      onlyResume.filter((drawn) => drawn.text === '>' && drawn.y === resumeY),
    ).toHaveLength(1) // the caret alone
  })

  it('keeps the value in the same place whether or not the row is selected', () => {
    // The arrow gutter is reserved on every row, so moving the cursor does not slide
    // the number sideways. A readout that moves is a readout you have to find again.
    const state = settings()
    const selected = valueDraw(render({ selected: rowIndex('volume'), settings: state }), 'volume', state)
    const idle = valueDraw(render({ selected: rowIndex('resume'), settings: state }), 'volume', state)
    expect(selected.x).toBe(idle.x)
  })

  it('leaves room for the label, the widest value and both arrows', () => {
    // Measured with the conservative monospace estimate the other fit tests use, and
    // against the row's own exported constants rather than restated numbers.
    const EM_RATIO = 0.62
    const measure: Measure = (text, size) => text.length * size * EM_RATIO
    const { value, unit } = formatSettingValue(settings({ muted: true, masterVolume: 1 }), 'volume')
    const widest = measure(value, PAUSE_ROW_TEXT_SIZE) + 4 + measure(unit, 11)
    const arrows =
      PAUSE_ARROW_GAP + measure('<', PAUSE_ARROW_SIZE) + PAUSE_ARROW_GUTTER
    for (const item of PAUSE_ITEMS) {
      if (item.kind === 'action') continue
      const combined = measure(item.label, PAUSE_ROW_TEXT_SIZE) + 16 + widest + arrows
      expect(combined, `pause row "${item.id}" is too wide`).toBeLessThanOrEqual(PAUSE_CONTENT_W)
    }
  })
})

describe('pause menu navigation', () => {
  it('wraps at both ends', () => {
    const last = PAUSE_ITEMS.length - 1
    expect(movePauseSelection(0, -1)).toBe(last)
    expect(movePauseSelection(last, 1)).toBe(0)
  })

  it('stays in range for absurd deltas', () => {
    for (const delta of [-100, -7, 0, 3, 250]) {
      const index = movePauseSelection(2, delta)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(PAUSE_ITEMS.length)
    }
  })

  it('opens on a non-destructive row', () => {
    // The menu resets selection to 0 each time it opens. If that row were
    // "Abandon sortie", pause-then-Enter would end a run the player was trying to
    // resume — a permadeath game cannot afford that adjacency.
    expect(PAUSE_ITEMS[0]?.id).toBe('resume')
    expect(PAUSE_ITEMS[PAUSE_ITEMS.length - 1]?.id).toBe('abandon')
  })

  it('gives every row a hint', () => {
    for (const item of PAUSE_ITEMS) {
      expect(item.hint.length).toBeGreaterThan(0)
    }
  })
})

describe('setting adjustment', () => {
  it('lowers and raises shake in steps', () => {
    const lowered = adjustSetting(settings({ shake: 1 }), 'shake', -1)
    expect(lowered.shake).toBeCloseTo(0.75, 6)
    expect(adjustSetting(lowered, 'shake', 1).shake).toBeCloseTo(1, 6)
  })

  it('clamps scales to 0..1 however hard it is pushed', () => {
    let current = settings({ shake: 1, masterVolume: 1 })
    for (let i = 0; i < 20; i++) current = adjustSetting(current, 'shake', 1)
    for (let i = 0; i < 20; i++) current = adjustSetting(current, 'volume', -1)
    expect(current.shake).toBe(1)
    expect(current.masterVolume).toBe(0)
  })

  it('reaches exactly zero shake', () => {
    // Rule 10 requires shake be fully disableable. A residual 0.0001 would still
    // move the playfield, so "off" has to be exact rather than merely small.
    let current = settings({ shake: 1 })
    for (let i = 0; i < 8; i++) current = adjustSetting(current, 'shake', -1)
    expect(current.shake).toBe(0)
  })

  it('flips mute in either direction', () => {
    const muted = adjustSetting(settings({ muted: false }), 'mute', -1)
    expect(muted.muted).toBe(true)
    expect(adjustSetting(muted, 'mute', 1).muted).toBe(false)
  })

  it('never mutates the input', () => {
    const original = settings({ shake: 0.5 })
    const frozen = Object.freeze({ ...original })
    expect(() => adjustSetting(frozen, 'shake', -1)).not.toThrow()
    expect(frozen.shake).toBe(0.5)
  })

  it('ignores adjustment on action rows', () => {
    const before = settings()
    expect(adjustSetting(before, 'resume', 1)).toEqual(before)
    expect(adjustSetting(before, 'abandon', -1)).toEqual(before)
  })

  it('never produces a non-finite value', () => {
    let current = settings()
    for (const id of PAUSE_ITEMS.map((item) => item.id)) {
      for (const delta of [-1, 1]) {
        current = adjustSetting(current, id, delta)
        expect(Number.isFinite(current.shake)).toBe(true)
        expect(Number.isFinite(current.masterVolume)).toBe(true)
      }
    }
  })
})

describe('setting display', () => {
  it('reads zero shake as a word, not a quantity', () => {
    // "0 %" is a quantity; a player scanning for whether shake is off wants the
    // word "off". Percentages are for values that are actually on.
    expect(formatSettingValue(settings({ shake: 0 }), 'shake')).toEqual({ value: 'Off', unit: '' })
  })

  it('shows shake as a percentage with its unit', () => {
    expect(formatSettingValue(settings({ shake: 0.5 }), 'shake')).toEqual({
      value: '50',
      unit: '%',
    })
  })

  it('reports a muted volume as muted, and still shows the level it stores', () => {
    // Showing a bare "80 %" while silent would be a readout contradicting reality, so
    // 'Muted' leads. But the level cannot be hidden either: left and right still write
    // it, and a keypress that changes a stored value while the row sits still is
    // indistinguishable from a dead key. Both facts, in the order that matters.
    expect(formatSettingValue(settings({ muted: true, masterVolume: 0.8 }), 'volume')).toEqual({
      value: 'Muted at 80',
      unit: '%',
    })
  })

  it('gives every adjustable row a displayable value', () => {
    for (const item of PAUSE_ITEMS) {
      if (item.kind === 'action') continue
      const { value } = formatSettingValue(settings(), item.id)
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it('carries a unit on every numeric value', () => {
    // UI rule 2: no bare numbers anywhere in the interface. ANY digit in the value
    // triggers this, not a value that is only digits — `/^\d+$/` stopped matching the
    // moment a value read "Muted at 80", which is precisely when it needed to.
    for (const muted of [false, true]) {
      for (const item of PAUSE_ITEMS) {
        const { value, unit } = formatSettingValue(settings({ shake: 0.5, muted }), item.id)
        if (/\d/.test(value)) expect(unit.length, `${item.id}: "${value}"`).toBeGreaterThan(0)
      }
    }
  })
})
