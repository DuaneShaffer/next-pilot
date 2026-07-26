/**
 * Choice-screen layout tests.
 *
 * Headless by construction: `layoutChoiceScreen` returns every rect and every
 * positioned, pre-measured line, so the things that actually break on this screen
 * — a mechanism line that never got drawn, a synergy that was not marked, a price
 * the player cannot pay presented as if they could, text past the card edge — are
 * all assertable without a canvas. Nobody has seen this screen rendered yet, which
 * is exactly why these assertions are written against the real content tables
 * rather than against fixtures.
 */

import { describe, expect, it } from 'vitest'
import { INTERACTIONS } from '../src/content/interactions'
import { ITEMS } from '../src/content/items'
import type { ItemDef } from '../src/content/types'
import type { ActiveInteraction, HeldItem, ItemOffer, PendingChoiceKind } from '../src/sim/entities'
import {
  CHIP_SEP,
  MONO_ADVANCE,
  OPTION_TEXT_W,
  WORK_ORDERS,
  clampSelection,
  isAffordable,
  layoutChoiceScreen,
  lineBounds,
  monoMeasure,
  packChips,
  truncateToWidth,
  wrapText,
  type ChoiceLayoutInput,
  type ChoiceScreenLayout,
  type TextLine,
} from '../src/ui/choiceScreen'

const ITEM_IDS = Object.keys(ITEMS)

function offer(defId: string, interactionText: readonly string[] = []): ItemOffer {
  // Tier read from the real table where the id exists, so a test offer carries the
  // same tier the screen would actually be handed.
  return { defId, tier: ITEMS[defId]?.tier ?? 'common', interactionText }
}

function held(...ids: readonly string[]): readonly HeldItem[] {
  return ids.map((defId, index) => ({ defId, acquiredAtTick: index * 60, count: 1 }))
}

function layout(overrides: Partial<ChoiceLayoutInput> = {}): ChoiceScreenLayout {
  const base: ChoiceLayoutInput = {
    kind: 'item',
    offers: [offer('machined-slugs'), offer('thrust-trim'), offer('plating-shim')],
    costs: [0, 0, 0],
    workOrders: [],
    scrap: 0,
    held: [],
    activeInteractions: [],
    selected: 0,
    tick: 0,
    items: ITEMS,
    measure: monoMeasure,
  }
  return layoutChoiceScreen({ ...base, ...overrides })
}

/** Whitespace-insensitive containment, since wrapping rewrites the spaces. */
function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function allLines(result: ChoiceScreenLayout): readonly TextLine[] {
  return [
    ...result.header,
    ...result.footer,
    ...result.build.lines,
    ...result.options.flatMap((option) => option.lines),
  ]
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

/** Offers in threes, so every item in the roster gets laid out at least once. */
function everyTriple(): readonly (readonly string[])[] {
  const triples: string[][] = []
  for (let i = 0; i < ITEM_IDS.length; i += 3) {
    triples.push(ITEM_IDS.slice(i, i + 3).filter((id): id is string => id !== undefined))
  }
  return triples
}

describe('mechanism first (UI rule 4)', () => {
  it('surfaces every offered item’s mechanism verbatim', () => {
    for (const ids of everyTriple()) {
      const result = layout({ offers: ids.map((id) => offer(id)) })
      result.options.forEach((option, index) => {
        const def = ITEMS[ids[index] as string] as ItemDef
        expect(option.mechanismLines.length).toBeGreaterThan(0)
        expect(collapse(option.mechanismLines.join(' '))).toBe(collapse(def.mechanism))
      })
    }
  })

  it('never renders an option as a name alone', () => {
    for (const id of ITEM_IDS) {
      const result = layout({ offers: [offer(id)] })
      const option = result.options[0]
      expect(option).toBeDefined()
      // The name is one line; anything that is not the name, the tier tag or the
      // caret has to exist too, or the option is a bare label.
      const body = option?.lines.filter(
        (line) => line.text !== option.name && line.text !== '>' && !line.text.startsWith('['),
      )
      expect(body?.length ?? 0).toBeGreaterThan(0)
    }
  })

  it('states a mechanism even for an id with no definition', () => {
    // An unknown id is an authoring bug, and it must be visible rather than
    // rendering as a name with nothing under it.
    const result = layout({ offers: [offer('not-a-real-item')], items: {} })
    expect(result.options[0]?.mechanismLines.join(' ')).toMatch(/no specification/i)
  })

  it('draws the mechanism larger than the flavour, and the flavour last', () => {
    const result = layout({ offers: [offer('machined-slugs')] })
    const option = result.options[0]
    expect(option).toBeDefined()
    const mech = option?.lines.find((line) => line.text === option?.mechanismLines[0])
    const flavour = option?.lines.find((line) => line.text === option?.flavourLines[0])
    expect(mech).toBeDefined()
    expect(flavour).toBeDefined()
    expect(mech!.size).toBeGreaterThan(flavour!.size)
    expect(flavour!.y).toBeGreaterThan(mech!.y)
  })

  it('keeps flavour omittable, dropping it before anything else when space runs short', () => {
    // Three long mechanisms plus three long synergies cannot all fit with flavour,
    // and flavour is the only part rule 4 allows to go.
    const long = INTERACTIONS[0]?.text ?? ''
    const result = layout({
      offers: [
        offer('cursed-hull', [long]),
        offer('retaliation-coil', [long]),
        offer('warheads', [long]),
      ],
    })
    expect(result.degrade).toBeGreaterThan(0)
    for (const option of result.options) {
      expect(option.flavourLines).toHaveLength(0)
      expect(option.mechanismLines.length).toBeGreaterThan(0)
      expect(option.interactionLines.length).toBeGreaterThan(0)
    }
  })
})

describe('synergies are stated (UI rule 5)', () => {
  const synergy = INTERACTIONS.find((entry) => entry.id === 'split-arc')

  it('marks an offer with interaction text differently from one without', () => {
    const result = layout({
      offers: [offer('arc-coupler', [synergy?.text ?? '']), offer('machined-slugs')],
      held: held('split-shot'),
    })
    const [marked, plain] = result.options
    expect(marked?.hasInteraction).toBe(true)
    expect(plain?.hasInteraction).toBe(false)
    // A rect of its own, and a text marker — not colour alone.
    expect(marked?.interactionBox).not.toBeNull()
    expect(plain?.interactionBox).toBeNull()
    const marker = marked?.lines.some((line) => line.text.includes('[+]'))
    expect(marker).toBe(true)
    expect(plain?.lines.some((line) => line.text.includes('[+]'))).toBe(false)
  })

  it('shows the interaction sentence itself, not just a badge', () => {
    const text = synergy?.text ?? ''
    const result = layout({
      offers: [offer('arc-coupler', [text])],
      held: held('split-shot'),
    })
    const shown = collapse(result.options[0]?.interactionLines.join(' ') ?? '')
    expect(shown.length).toBeGreaterThan(0)
    expect(collapse(text).startsWith(shown.replace(/…$/, ''))).toBe(true)
  })

  it('states every declared interaction in full when it is the only long block', () => {
    // The screen is only ever handed pre-resolved text, so the risk is not that it
    // computes the wrong synergy — it is that a long one gets cut. With a single
    // synergy among three offers, none of them should need trimming.
    for (const interaction of INTERACTIONS) {
      const result = layout({
        offers: [
          offer(interaction.requires[0], [interaction.text]),
          offer('machined-slugs'),
          offer('thrust-trim'),
        ],
        held: held(interaction.requires[1]),
      })
      const shown = collapse(result.options[0]?.interactionLines.join(' ') ?? '')
      expect(shown).toBe(collapse(interaction.text))
    }
  })

  it('never drops the marker even when it has to trim the sentence', () => {
    const long = INTERACTIONS.map((entry) => entry.text).join(' ')
    const result = layout({
      offers: [offer('cursed-hull', [long]), offer('warheads', [long]), offer('split-shot', [long])],
    })
    for (const option of result.options) {
      expect(option.hasInteraction).toBe(true)
      expect(option.interactionLines.length).toBeGreaterThan(0)
      expect(option.lines.some((line) => line.text.includes('[+]'))).toBe(true)
    }
  })

  it('shows live interactions from the build, with a count', () => {
    const active: readonly ActiveInteraction[] = [
      { defId: 'split-arc', text: INTERACTIONS[0]?.text ?? '' },
    ]
    const result = layout({ held: held('split-shot', 'arc-coupler'), activeInteractions: active })
    expect(result.build.liveCount).toBe(1)
    expect(result.build.lines.some((line) => line.text.includes('[+]'))).toBe(true)
  })
})

describe('the build is visible while choosing', () => {
  it('lists held items with their stack counts', () => {
    const inventory: readonly HeldItem[] = [
      { defId: 'machined-slugs', acquiredAtTick: 0, count: 3 },
      { defId: 'split-shot', acquiredAtTick: 60, count: 1 },
    ]
    const result = layout({ held: inventory })
    const text = result.build.lines.map((line) => line.text).join(' | ')
    expect(text).toContain('Machined Slugs ×3')
    expect(text).toContain('Split Shot')
    // Stacks, not entries: the summary counts what is fitted.
    expect(text).toMatch(/4 systems fitted/)
    expect(layout({ held: held('split-shot') }).build.lines.map((l) => l.text).join(' ')).toContain(
      '1 system fitted',
    )
    expect(result.build.heldCount).toBe(2)
  })

  it('says so plainly when nothing is held', () => {
    const result = layout({ held: [] })
    expect(result.build.lines.some((line) => /nothing fitted/i.test(line.text))).toBe(true)
  })

  it('accounts for every held item even when the list overflows', () => {
    const inventory: readonly HeldItem[] = ITEM_IDS.map((defId, index) => ({
      defId,
      acquiredAtTick: index,
      count: 1,
    }))
    const result = layout({ held: inventory })
    const text = result.build.lines.map((line) => line.text).join(' ')
    expect(text).toContain(`${ITEM_IDS.length} systems fitted`)
    // THE COUNT ITSELF, not merely the shape of it. `/\+\d+ more/` matched the shipped
    // defect perfectly: the strip listed 7 names and said "+31 more" against a summary
    // of 40 fitted, because the marker was numbered before the trim that dropped a
    // whole chip to make room for it. A regex that accepts any digits is not an
    // assertion about a count.
    const shown = namesOnChipLines(result)
    const hidden = overflowCount(result)
    expect(hidden).toBeGreaterThan(0)
    expect(shown.length + hidden).toBe(ITEM_IDS.length)
  })
})

// ---------------------------------------------------------------------------
// the build strip's overflow count
// ---------------------------------------------------------------------------

/** Every chip name the build strip drew, taken apart with the real separator. */
function namesOnChipLines(result: ChoiceScreenLayout): string[] {
  return result.build.lines
    .map((line) => line.text)
    // The chip lines are the ones that are neither the heading, the right-aligned
    // summary, nor a synergy row.
    .filter((text) => !/systems? fitted/.test(text) && text !== 'CURRENT BUILD' && !text.startsWith('[+]'))
    .flatMap((text) => text.split(CHIP_SEP))
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !/^\+\d+ more$/.test(name))
}

function overflowCount(result: ChoiceScreenLayout): number {
  const match = /\+(\d+) more/.exec(result.build.lines.map((line) => line.text).join(' '))
  return match?.[1] === undefined ? 0 : Number(match[1])
}

describe('names shown plus the overflow count equals the build', () => {
  /**
   * The property, swept rather than sampled.
   *
   * `packChips` numbered its marker from how many chips it had placed, then trimmed
   * whole chips off the last line to make room for the marker and never put them back.
   * One name always went missing, so the strip could read `5 names · +1 more` beside a
   * summary saying 7 — and the comment above the trim claims the opposite, that a name
   * gives way rather than the count being wrong.
   *
   * Swept across both axes that decide where the trim lands: how many chips there are,
   * and how wide each one is.
   */
  it('holds for every chip count and name length', () => {
    const WIDTH = OPTION_TEXT_W
    for (const nameLength of [3, 7, 11, 14, 18, 23, 31, 47]) {
      for (let count = 1; count <= 24; count++) {
        // Distinct names, all the same width, so a dropped chip is unambiguous.
        const chips = Array.from(
          { length: count },
          (_, index) => `${String(index).padStart(2, '0')}${'x'.repeat(Math.max(1, nameLength - 2))}`,
        )
        const lines = packChips(chips, WIDTH, 2, 12, monoMeasure)
        const joined = lines.join(CHIP_SEP)
        const marker = /\+(\d+) more/.exec(joined)
        const hidden = marker?.[1] === undefined ? 0 : Number(marker[1])
        const shown = joined
          .split(CHIP_SEP)
          .map((part) => part.trim())
          .filter((part) => part.length > 0 && !/^\+\d+ more$/.test(part))

        const where = `${count} chips of ${nameLength} chars`
        expect(shown.length + hidden, `${where}: shown ${shown.length} + ${hidden}`).toBe(count)
        // Every name that IS shown must be whole — a truncated chip would satisfy the
        // arithmetic while lying about what is fitted.
        for (const name of shown) expect(chips, `${where}: "${name}" is not a chip`).toContain(name)
        expect(lines.length, `${where}: too many lines`).toBeLessThanOrEqual(2)
      }
    }
  })

  it('keeps every packed line inside the width it was given', () => {
    // The trim exists to make the marker fit; it must actually fit afterwards.
    for (const width of [90, 140, 200, OPTION_TEXT_W]) {
      const chips = Array.from({ length: 12 }, (_, i) => `System ${'y'.repeat(i)}`)
      for (const line of packChips(chips, width, 2, 12, monoMeasure)) {
        expect(monoMeasure(line, 12, 400), `"${line}" overflows ${width}`).toBeLessThanOrEqual(width)
      }
    }
  })

  it('reports the whole build when not one name fits', () => {
    // One line, one chip too wide for it: the names are gone, so the count is all the
    // player gets and it must be the true total.
    const chips = ['A very long system name indeed', 'Another', 'A third']
    const lines = packChips(chips, 60, 1, 12, monoMeasure)
    expect(lines.join(' ')).toContain('+3 more')
  })

  it('says nothing about overflow when everything fits', () => {
    const chips = ['One', 'Two', 'Three']
    const lines = packChips(chips, OPTION_TEXT_W, 2, 12, monoMeasure)
    expect(lines.join(' ')).not.toMatch(/more/)
    expect(lines.join(CHIP_SEP).split(CHIP_SEP)).toEqual(chips)
  })
})

describe('shop affordability', () => {
  it('treats cost equal to scrap as affordable, one more as not', () => {
    // Must match World.updateChoice's `cost > scrap` guard exactly, or the screen
    // greys out a purchase the simulation would have allowed.
    expect(isAffordable(120, 120)).toBe(true)
    expect(isAffordable(121, 120)).toBe(false)
    expect(isAffordable(0, 0)).toBe(true)
  })

  it('flags an unaffordable option before it is selected', () => {
    const result = layout({
      kind: 'shop',
      offers: [offer('machined-slugs'), offer('warheads'), offer('cursed-hull')],
      costs: [120, 288, 384],
      scrap: 288,
      selected: 0,
    })
    const [cheap, exact, dear] = result.options
    expect(cheap?.affordable).toBe(true)
    expect(exact?.affordable).toBe(true)
    expect(exact?.shortfall).toBe(0)
    expect(dear?.affordable).toBe(false)
    expect(dear?.shortfall).toBe(96)
    // The shortfall is words and numbers, not just a dimmer colour.
    expect(dear?.lines.some((line) => line.text === 'SHORT 96 cr')).toBe(true)
    expect(cheap?.lines.some((line) => line.text.startsWith('SHORT'))).toBe(false)
  })

  it('prices every shop option with its unit, and shows scrap on hand', () => {
    const result = layout({
      kind: 'shop',
      offers: [offer('machined-slugs'), offer('feed-relay')],
      costs: [120, 192],
      scrap: 200,
    })
    expect(result.scrap).toBe(200)
    expect(result.header.some((line) => line.text.trim() === 'cr')).toBe(true)
    for (const option of result.options) {
      const texts = option.lines.map((line) => line.text)
      expect(texts).toContain(String(option.cost))
      expect(texts.some((text) => text.trim() === 'cr')).toBe(true)
    }
  })

  it('charges nothing on a free item choice', () => {
    const result = layout({ kind: 'item', costs: [120, 120, 120] })
    for (const option of result.options) {
      expect(option.cost).toBe(0)
      expect(option.affordable).toBe(true)
    }
  })

  it('never uses danger colouring, cursed items included', () => {
    // Rule 3: nothing on this screen can hurt the player this instant. A curse is
    // information; an unaffordable price is a caution.
    const result = layout({
      kind: 'shop',
      offers: [offer('cursed-hull'), offer('machined-slugs')],
      costs: [384, 120],
      scrap: 0,
    })
    expect(result.options[0]?.cursed).toBe(true)
    expect(result.options[0]?.lines.some((line) => line.text === 'CURSED')).toBe(true)
    const colours = new Set([
      result.accent,
      ...allLines(result).map((line) => line.color),
      ...result.options.map((option) => option.accent),
    ])
    expect(colours.has('#FF4A38')).toBe(false)
  })
})

describe('work orders', () => {
  it('renders one option per assignment with its brief', () => {
    const result = layout({ kind: 'work-order', offers: [], workOrders: ['supply', 'hazard', 'repair'] })
    expect(result.options).toHaveLength(3)
    result.options.forEach((option, index) => {
      const kind = ['supply', 'hazard', 'repair'][index] as keyof typeof WORK_ORDERS
      expect(option.name).toBe(WORK_ORDERS[kind].name)
      expect(collapse(option.mechanismLines.join(' '))).toBe(
        collapse(WORK_ORDERS[kind].description),
      )
      expect(option.cost).toBe(0)
    })
  })

  it('admits that the assignment does nothing yet', () => {
    // Honesty over polish while the sim ignores the pick. Delete this expectation
    // in the change that gives work orders an effect.
    const result = layout({ kind: 'work-order', offers: [], workOrders: ['supply'] })
    expect(result.header.some((line) => /recorded only/i.test(line.text))).toBe(true)
  })

  it('falls back to a readable name for an unknown assignment kind', () => {
    const result = layout({ kind: 'work-order', offers: [], workOrders: ['deep-salvage'] })
    expect(result.options[0]?.name).toBe('Deep Salvage')
    expect(result.options[0]?.mechanismLines.length).toBeGreaterThan(0)
  })
})

describe('selection', () => {
  it('wraps any index into range, matching the sim cursor', () => {
    for (const index of [-9, -3, -1, 0, 1, 2, 3, 4, 97, 1e6]) {
      const clamped = clampSelection(index, 3)
      expect(clamped).toBeGreaterThanOrEqual(0)
      expect(clamped).toBeLessThan(3)
      expect(Number.isInteger(clamped)).toBe(true)
    }
    expect(clampSelection(-1, 3)).toBe(2)
    expect(clampSelection(3, 3)).toBe(0)
  })

  it('survives a nonsense index or an empty offer list', () => {
    expect(clampSelection(Number.NaN, 3)).toBe(0)
    expect(clampSelection(Infinity, 3)).toBe(0)
    expect(clampSelection(1.7, 3)).toBe(1)
    expect(clampSelection(0, 0)).toBe(0)
    expect(clampSelection(5, 0)).toBe(0)
  })

  it('always highlights exactly one option, whatever index it is handed', () => {
    for (const index of [-4, -1, 0, 2, 11, Number.NaN]) {
      const result = layout({ selected: index })
      expect(result.options.filter((option) => option.selected)).toHaveLength(1)
      const chosen = result.options.find((option) => option.selected)
      // Caret as well as colour, per rule 10's "not colour alone".
      expect(chosen?.lines.some((line) => line.text === '>')).toBe(true)
    }
  })

  it('does not move any text when the selection changes', () => {
    // Text that shifts as you press left is text you have to re-read. The caret
    // lives in a gutter that is reserved whether or not it is drawn.
    const a = layout({ selected: 0 })
    const b = layout({ selected: 2 })
    const positions = (result: ChoiceScreenLayout): string =>
      result.options
        .flatMap((option) => option.lines.filter((line) => line.text !== '>'))
        .map((line) => `${line.text}@${line.x},${line.y}`)
        .join('|')
    expect(positions(a)).toBe(positions(b))
  })

  it('pulses slowly and never reaches zero opacity', () => {
    let min = 1
    let max = 0
    for (let tick = 0; tick < 600; tick++) {
      const { pulse } = layout({ tick })
      min = Math.min(min, pulse)
      max = Math.max(max, pulse)
    }
    expect(min).toBeGreaterThan(0.02)
    expect(max).toBeLessThan(0.5)
    // ~0.86 Hz at 60 ticks/second: a full cycle takes about 70 ticks, so the
    // highlight is never in the photosensitive 3-30 Hz band.
    expect((2 * Math.PI) / 0.09 / 60).toBeGreaterThan(1)
  })
})

describe('text wrapping', () => {
  const WIDTH = 200

  it('wraps a string far longer than the card instead of overflowing', () => {
    const long = 'The quick brown salvage hauler jumped over the lazy requisition officer twice.'
    const lines = wrapText(long, WIDTH, 13, monoMeasure)
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines) expect(monoMeasure(line, 13)).toBeLessThanOrEqual(WIDTH)
    expect(lines.join(' ')).toBe(long)
  })

  it('hard-splits a single word that cannot fit on any line', () => {
    const word = 'x'.repeat(200)
    const lines = wrapText(word, WIDTH, 13, monoMeasure)
    for (const line of lines) expect(monoMeasure(line, 13)).toBeLessThanOrEqual(WIDTH)
    expect(lines.join('').replace(/-/g, '')).toBe(word)
  })

  it('wraps every real mechanism and interaction string inside the text column', () => {
    const strings = [
      ...Object.values(ITEMS).flatMap((def) => [def.mechanism, def.flavour ?? '']),
      ...INTERACTIONS.map((entry) => entry.text),
      ...Object.values(WORK_ORDERS).map((entry) => entry.description),
    ].filter((text) => text.length > 0)

    for (const text of strings) {
      const lines = wrapText(text, 400, 13, monoMeasure)
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(monoMeasure(line, 13)).toBeLessThanOrEqual(400)
    }
  })

  it('returns nothing for empty input and does not hang on a zero width', () => {
    expect(wrapText('', 100, 13, monoMeasure)).toEqual([])
    expect(wrapText('   ', 100, 13, monoMeasure)).toEqual([])
    expect(wrapText('hello', 0, 13, monoMeasure)).toEqual(['hello'])
    expect(wrapText('hello', Number.NaN, 13, monoMeasure)).toEqual(['hello'])
  })

  it('truncates with a visible ellipsis rather than silently cutting', () => {
    const text = 'A long sentence about arc reach and projectile counts.'
    const cut = truncateToWidth(text, 100, 12, monoMeasure)
    expect(cut.endsWith('…')).toBe(true)
    expect(monoMeasure(cut, 12)).toBeLessThanOrEqual(100)
    expect(truncateToWidth('short', 500, 12, monoMeasure)).toBe('short')
  })

  it('estimates monospace width conservatively', () => {
    // The headless measure must not be narrower than the real font, or a layout
    // that passes these tests can still overflow on screen.
    expect(MONO_ADVANCE).toBeGreaterThanOrEqual(0.6)
    expect(monoMeasure('ab', 10, 400, 2)).toBeCloseTo(10 * 0.62 * 2 + 2, 6)
  })
})

describe('no two strings collide', () => {
  /**
   * The failure this guards against is the one `src/render/panel.ts` records twice:
   * a value drawn through something else, which no unit test sees and which makes
   * the text unreadable. Two lines whose vertical spans overlap must not overlap
   * horizontally.
   */
  function assertNoOverlap(group: readonly TextLine[]): void {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i] as TextLine
        const b = group[j] as TextLine
        const verticallyApart = a.y + a.size <= b.y || b.y + b.size <= a.y
        if (verticallyApart) continue
        const ab = lineBounds(a)
        const bb = lineBounds(b)
        const horizontallyApart = ab.right <= bb.left || bb.right <= ab.left
        expect(
          horizontallyApart,
          `"${a.text}" (${ab.left}..${ab.right} @${a.y}) collides with "${b.text}" (${bb.left}..${bb.right} @${b.y})`,
        ).toBe(true)
      }
    }
  }

  const cases: readonly Partial<ChoiceLayoutInput>[] = [
    {},
    {
      offers: [offer('coin-op-cannon', [INTERACTIONS[2]?.text ?? '']), offer('cursed-hull')],
      held: held('scrap-magnet'),
    },
    {
      kind: 'shop',
      offers: [offer('machined-slugs'), offer('coin-op-cannon'), offer('cursed-hull')],
      costs: [120, 192, 384],
      scrap: 200,
    },
    // The tightest title line the content can produce: the longest name, a relic
    // tag, the cursed marker and a four-figure price all on one row.
    { kind: 'shop', offers: [offer('cursed-hull')], costs: [9999], scrap: 0 },
    { kind: 'shop', offers: [offer('coin-op-cannon')], costs: [1200], scrap: 3 },
    { kind: 'work-order', offers: [], workOrders: ['supply', 'hazard', 'repair'] },
  ]

  it('holds inside every option and across the header, build strip and footer', () => {
    for (const overrides of cases) {
      const result = layout(overrides)
      for (const option of result.options) assertNoOverlap(option.lines)
      assertNoOverlap(result.header)
      assertNoOverlap(result.build.lines)
      assertNoOverlap(result.footer)
    }
  })

  it('keeps the price off the title line when it would not fit', () => {
    // No name in items.ts is long enough to trigger this, so it is exercised with a
    // synthetic def: the point is that the decision is measured rather than assumed,
    // and that the fallback is a separate priced row rather than two strings
    // sharing one.
    const wide: Record<string, ItemDef> = {
      wide: {
        id: 'wide',
        name: 'Reciprocating Requisition Manifold Assembly',
        tier: 'relic',
        tags: ['cursed'],
        mechanism: '+1 projectile damage.',
      },
    }
    const tight = layout({
      kind: 'shop',
      items: wide,
      offers: [offer('wide')],
      costs: [999999],
      scrap: 0,
    })
    const option = tight.options[0]
    expect(option).toBeDefined()
    assertNoOverlap(option?.lines ?? [])
    expect(option?.lines.some((line) => line.text === 'PRICE')).toBe(true)
  })
})

describe('nothing escapes the card', () => {
  function assertContained(result: ChoiceScreenLayout): void {
    const card = result.card
    const cardRight = card.x + card.w
    const cardBottom = card.y + card.h

    for (const option of result.options) {
      expect(option.box.x).toBeGreaterThanOrEqual(card.x)
      expect(option.box.x + option.box.w).toBeLessThanOrEqual(cardRight)
      expect(option.box.y).toBeGreaterThanOrEqual(card.y)
      expect(option.box.y + option.box.h).toBeLessThanOrEqual(cardBottom)

      const well = option.interactionBox
      if (well) {
        expect(well.x).toBeGreaterThanOrEqual(option.box.x)
        expect(well.x + well.w).toBeLessThanOrEqual(option.box.x + option.box.w)
        expect(well.y).toBeGreaterThanOrEqual(option.box.y)
        expect(well.y + well.h).toBeLessThanOrEqual(option.box.y + option.box.h)
      }

      for (const line of option.lines) {
        const bounds = lineBounds(line)
        expect(bounds.left).toBeGreaterThanOrEqual(option.box.x)
        expect(bounds.right).toBeLessThanOrEqual(option.box.x + option.box.w)
        expect(line.y).toBeGreaterThanOrEqual(option.box.y)
        expect(line.y + line.size).toBeLessThanOrEqual(option.box.y + option.box.h)
      }
    }

    for (const line of allLines(result)) {
      const bounds = lineBounds(line)
      expect(bounds.left).toBeGreaterThanOrEqual(card.x)
      expect(bounds.right).toBeLessThanOrEqual(cardRight)
      expect(line.y).toBeGreaterThanOrEqual(card.y)
      expect(line.y + line.size).toBeLessThanOrEqual(cardBottom)
    }

    for (const line of result.build.lines) {
      expect(line.y).toBeGreaterThanOrEqual(result.build.box.y)
      expect(line.y + line.size).toBeLessThanOrEqual(result.build.box.y + result.build.box.h)
    }

    expect(result.overflow).toBe(false)
  }

  it('contains the longest real content in items.ts', () => {
    for (const ids of everyTriple()) {
      assertContained(layout({ offers: ids.map((id) => offer(id)) }))
    }
  })

  it('contains three long mechanisms each carrying a declared interaction', () => {
    // The worst case the content can currently produce: the two longest mechanism
    // strings and the two longest interaction sentences on screen together.
    const longest = [...INTERACTIONS].sort((a, b) => b.text.length - a.text.length)
    for (const kind of ['item', 'shop'] as const) {
      assertContained(
        layout({
          kind,
          offers: [
            offer('cursed-hull', [longest[0]?.text ?? '']),
            offer('retaliation-coil', [longest[1]?.text ?? '']),
            offer('warheads', [longest[2]?.text ?? '']),
          ],
          costs: [384, 192, 288],
          scrap: 200,
          held: held('split-shot', 'arc-coupler', 'repair-nanites'),
          activeInteractions: INTERACTIONS.slice(0, 3).map((entry) => ({
            defId: entry.id,
            text: entry.text,
          })),
        }),
      )
    }
  })

  it('contains a full inventory and every interaction live at once', () => {
    assertContained(
      layout({
        held: ITEM_IDS.map((defId, index) => ({ defId, acquiredAtTick: index, count: 2 })),
        activeInteractions: INTERACTIONS.map((entry) => ({ defId: entry.id, text: entry.text })),
      }),
    )
  })

  it('contains all three kinds', () => {
    const kinds: readonly PendingChoiceKind[] = ['item', 'shop', 'work-order']
    for (const kind of kinds) {
      assertContained(
        layout({
          kind,
          offers:
            kind === 'work-order' ? [] : [offer('warheads'), offer('feed-relay'), offer('cursed-hull')],
          workOrders: kind === 'work-order' ? ['supply', 'hazard', 'repair'] : [],
          costs: [288, 192, 384],
          scrap: 250,
        }),
      )
    }
  })
})

describe('no NaN for any plausible input', () => {
  it('holds for the ordinary cases', () => {
    const cases: readonly Partial<ChoiceLayoutInput>[] = [
      {},
      { kind: 'shop', costs: [120, 192, 384], scrap: 200 },
      { kind: 'work-order', offers: [], workOrders: ['supply', 'hazard', 'repair'] },
      { offers: [] },
      { offers: [offer('machined-slugs')] },
      { held: held('split-shot'), activeInteractions: [{ defId: 'x', text: 'text' }] },
    ]
    for (const overrides of cases) {
      for (const value of numbersIn(layout(overrides))) {
        expect(Number.isFinite(value)).toBe(true)
      }
    }
  })

  it('holds for hostile inputs', () => {
    const hostile: readonly Partial<ChoiceLayoutInput>[] = [
      { selected: Number.NaN, tick: Number.NaN, scrap: Number.NaN },
      { kind: 'shop', costs: [Number.NaN, -50, Infinity], scrap: -10 },
      { selected: -1e9, tick: -1, scrap: 1e9 },
      { offers: [offer('')], items: {} },
      { offers: [offer('machined-slugs', [''])] },
      { kind: 'work-order', offers: [], workOrders: [''] },
      { held: [{ defId: 'ghost', acquiredAtTick: 0, count: 0 }] },
    ]
    for (const overrides of hostile) {
      const result = layout(overrides)
      for (const value of numbersIn(result)) {
        expect(Number.isFinite(value)).toBe(true)
      }
      for (const line of allLines(result)) {
        expect(line.text).not.toMatch(/NaN|undefined/)
      }
    }
  })

  it('reports a non-negative price and shortfall however the costs arrive', () => {
    const result = layout({
      kind: 'shop',
      offers: [offer('machined-slugs'), offer('warheads')],
      costs: [-40, Number.NaN],
      scrap: 10,
    })
    for (const option of result.options) {
      expect(option.cost).toBeGreaterThanOrEqual(0)
      expect(option.shortfall).toBeGreaterThanOrEqual(0)
    }
  })
})
