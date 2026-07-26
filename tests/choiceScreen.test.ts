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
import type { ItemDef, StatModifier } from '../src/content/types'
import type { ActiveInteraction, HeldItem, ItemOffer, PendingChoiceKind } from '../src/sim/entities'
import { Palette } from '../src/render/palette'
import { resolveAllStats } from '../src/sim/stats'
import {
  CHIP_SEP,
  MONO_ADVANCE,
  OPTION_TEXT_W,
  STAT_ROW_LABEL,
  STAT_ROW_SEP,
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
  type OptionLayout,
  type TextLine,
} from '../src/ui/choiceScreen'
import { NO_CHANGE_TEXT, collectBuildModifiers } from '../src/ui/statDelta'

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

/**
 * Which items keep their authored sentence on this screen.
 *
 * A pure-stat item's sentence is dropped when the resolved rows already state every
 * figure in it — see the note in `choiceScreen.ts`. An item carrying an `effects` entry
 * keeps it, because a row cannot describe extra projectiles or a timed window.
 */
function keepsMechanism(def: ItemDef): boolean {
  return (def.effects?.length ?? 0) > 0 || (def.stats?.length ?? 0) === 0
}

describe('mechanism first (UI rule 4)', () => {
  it('states every offered item’s mechanism verbatim, or shows the rows instead', () => {
    for (const ids of everyTriple()) {
      const result = layout({ offers: ids.map((id) => offer(id)) })
      result.options.forEach((option, index) => {
        const def = ITEMS[ids[index] as string] as ItemDef
        if (keepsMechanism(def)) {
          expect(option.mechanismLines.length, def.id).toBeGreaterThan(0)
          expect(collapse(option.mechanismLines.join(' '))).toBe(collapse(def.mechanism))
        } else {
          // Dropped, but never leaving a bare name: the rows have to be there instead.
          expect(option.mechanismLines, def.id).toHaveLength(0)
          expect(option.statRows.length, def.id).toBeGreaterThan(0)
        }
      })
    }
  })

  it('never prints a figure in both a row and the sentence on the same card', () => {
    /*
     * THE GUARD FOR ROADMAP #29, WHICH CAME BACK HERE ONE CARD LATER.
     *
     * The hull cards were cleaned of exactly this — prose restating what a computed
     * table below it prints — and then the resolved rows landed on the item cards
     * above the authored sentence and recreated it. Barrel Liner drew
     * `Shot speed 620 -> 740 u/s (+120)` and then said "+120 projectile speed, from
     * 620 to 740 units per second" directly underneath: one fact twice, and only the
     * row derived from the run, so a balance change updates the row and leaves the
     * sentence selling the old item.
     *
     * Swept over every item rather than spot-checked, because the failure is per-item
     * and a new item is exactly when it would return.
     *
     * TWO ITEMS ARE KNOWN EXCEPTIONS and are named rather than skipped silently.
     * `harmonic-lance` and `buckshot-manifold` each carry an `effects` entry AND a stat,
     * so the card must keep the sentence (a row cannot say "passes through 2 extra
     * enemies") while a row also prints the stat. Rewriting their prose to drop the
     * figure was tried and reverted, for two reasons worth keeping straight.
     *
     * `tests/items.test.ts` rightly requires an item to state the numbers it applies —
     * that guard predates the resolved rows and still protects the authored spec. And
     * `src/ui/hullSelect.ts:673` prints an item's `mechanism` verbatim for a hull's
     * STARTING ITEM, with no resolved table under it, so a figure cut from the prose
     * would simply vanish there. (An earlier version of this note said the HANGAR was
     * that second consumer. It is not — the hangar shows certifications and never reads
     * `ItemDef.mechanism`. Grep before trusting a file reference in a comment, including
     * this one.)
     *
     * Only `repair-nanites` is a starting item today, so neither item below is currently
     * reachable through that path — but the path is what makes the prose a spec rather
     * than card copy, and it is one hull away from mattering. Closing this properly means
     * resolved rows on the starting-item line too. The list must not grow without that
     * work, which is what naming it here enforces.
     */
    const KNOWN_DUPLICATES: readonly string[] = ['harmonic-lance', 'buckshot-manifold']
    const stillDuplicating: string[] = []
    for (const id of ITEM_IDS) {
      const result = layout({ offers: [offer(id)] })
      const option = result.options[0]
      expect(option).toBeDefined()
      if (option === undefined || option.mechanismLines.length === 0) continue
      const sentence = collapse(option.mechanismLines.join(' '))
      for (const row of option.statRows) {
        // The resolved "after" value is the figure a row and a sentence would collide
        // on. An item keeping its sentence for an EFFECT may still legitimately mention
        // a number the rows do not carry, so only the row's own numbers are checked.
        const after = String(row.after)
        if (after.length < 2) continue
        if (sentence.includes(after)) stillDuplicating.push(`${id} (${row.stat}=${after})`)
      }
    }
    expect([...new Set(stillDuplicating.map((entry) => entry.split(' ')[0]))].sort()).toEqual(
      [...KNOWN_DUPLICATES].sort(),
    )
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
    // `split-shot` rather than a pure-stat item: an item whose figures the rows already
    // carry has its sentence dropped, so it has no mechanism line to compare against.
    const result = layout({ offers: [offer('split-shot')] })
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
      expect(option.interactionLines.length).toBeGreaterThan(0)
      // Whichever of the two the option carries must survive: the sentence for an
      // effect-bearing item, the rows for a pure-stat one. Flavour is the only thing
      // rule 4 lets go, and "the card kept neither" is the failure worth catching.
      expect(option.mechanismLines.length + option.statRows.length).toBeGreaterThan(0)
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

// ---------------------------------------------------------------------------
// the resolved stat block
// ---------------------------------------------------------------------------

/**
 * The defect: an offer's card stated its authored prose and nothing else, so it
 * described the ITEM rather than what taking it does to THIS ship. `+22 max shield` is
 * +22 on a stock hull and +0 on one holding Exposed Core; `+45% damage` is +1.8 or
 * +14 depending entirely on what is already fitted.
 *
 * `tests/statDelta.test.ts` pins the arithmetic. What these assert is that the numbers
 * reach the card: drawn, positioned above the prose, inside the box, and different
 * when the build is different.
 */

/** Modifiers a build implies, the way the app layer supplies them. */
function build(
  hullId: string | undefined,
  ...entries: readonly (string | readonly [string, number])[]
): readonly StatModifier[] {
  const heldItems = entries.map((entry, index) => {
    const [defId, count] = typeof entry === 'string' ? [entry, 1] : entry
    return { defId, acquiredAtTick: index * 60, count }
  })
  return [
    ...collectBuildModifiers({
      ...(hullId === undefined ? {} : { hullId }),
      held: heldItems,
      items: ITEMS,
      activeInteractions: [],
    }),
  ]
}

/** Every string drawn inside one option, in draw order. */
function texts(option: OptionLayout | undefined): readonly string[] {
  return option?.lines.map((line) => line.text) ?? []
}

const STAT_ITEM_IDS = ITEM_IDS.filter((id) => (ITEMS[id]?.stats?.length ?? 0) > 0)

describe('resolved stat detail (UI rule 4, dynamically)', () => {
  it('shows a resolved row for every offered item that moves a stat', () => {
    for (const ids of everyTriple()) {
      const result = layout({ offers: ids.map((id) => offer(id)) })
      result.options.forEach((option, index) => {
        const def = ITEMS[ids[index] as string] as ItemDef
        const stats = def.stats ?? []
        expect(option.statRows.map((row) => row.stat).sort()).toEqual(
          [...new Set(stats.map((modifier) => modifier.stat))].sort(),
        )
        // Modelled AND drawn: a row nobody paints is not information.
        for (const row of option.statRows) expect(texts(option)).toContain(row.text)
      })
    }
    expect(STAT_ITEM_IDS.length).toBeGreaterThan(20)
  })

  it('puts the resolved numbers above the authored sentence', () => {
    // The sentence quotes the item; the rows quote the ship. The rows are read first
    // because they are the ones that are true of this run.
    // `harmonic-lance` carries a stat AND an effect, so it is one of the few cards that
    // draws both a row and a sentence — which is what this ordering is about.
    const result = layout({ offers: [offer('harmonic-lance')] })
    const option = result.options[0]
    const rowY = option?.lines.find((line) => line.text === option?.statRows[0]?.text)?.y
    const proseY = option?.lines.find((line) => line.text === option?.mechanismLines[0])?.y
    expect(rowY).toBeDefined()
    expect(proseY).toBeDefined()
    expect(rowY!).toBeLessThan(proseY!)
    // And still under the name, not above it.
    const nameY = option?.lines.find((line) => line.text === option?.name)?.y
    expect(nameY!).toBeLessThan(rowY!)
  })

  it('names whose numbers these are', () => {
    // Without the label the card shows two different figures for the same stat — the
    // item's "4 to 5.8" and this run's "8.1 → 11.7" — with nothing saying which is which.
    for (const id of STAT_ITEM_IDS) {
      const result = layout({ offers: [offer(id)] })
      expect(texts(result.options[0]), id).toContain(STAT_ROW_LABEL)
    }
    // An item with no stats gets no label, because it has no rows to introduce.
    expect(texts(layout({ offers: [offer('retaliation-coil')] }).options[0])).not.toContain(
      STAT_ROW_LABEL,
    )
  })

  it('lines two rows up under each other, so they read as a table', () => {
    // The first row shares the label's line, so the naive placement starts it further
    // right than the second and the block reads as a table plus a stray sentence.
    const option = layout({ offers: [offer('hazard-pay-clause')] }).options[0]
    expect(option?.statRows).toHaveLength(2)
    const xs = (option?.lines ?? [])
      .filter((line) => (option?.statRows ?? []).some((row) => row.text === line.text))
      .map((line) => line.x)
    expect(xs).toHaveLength(2)
    expect(new Set(xs).size).toBe(1)
    // And indented past the label rather than under it.
    const label = option?.lines.find((line) => line.text === STAT_ROW_LABEL)
    expect(xs[0]!).toBeGreaterThan(label!.x + label!.width)
  })

  it('reads the same offer differently on two different builds', () => {
    // THE WHOLE POINT. Machined Slugs is +1 damage; on a build holding Exposed Core
    // (damage mul 1.35) and two slugs already, taking a third is (4 + 3) × 1.35 = 9.45
    // from 8.1. The static prose says "from 4 to 5".
    const stock = layout({ offers: [offer('machined-slugs')] })
    const loaded = layout({
      offers: [offer('machined-slugs')],
      currentModifiers: build(undefined, 'exposed-core', ['machined-slugs', 2]),
    })
    expect(texts(stock.options[0])).toContain('Shot damage  4 → 5 dmg')
    // 9.5, not the 9.1 that adding the modifier to the resolved value would print.
    expect(texts(loaded.options[0])).toContain('Shot damage  8.1 → 9.5 dmg')
    expect(texts(loaded.options[0])).toContain(' (+1.4)')
    expect(ITEMS['machined-slugs']?.mechanism).toContain('from 4 to 5')
  })

  it('says a pick is worth nothing when the build has made it worthless', () => {
    // Exposed Core sets maxShield to mul 0, so Shield Cell's +22 resolves to nothing.
    // The card could not say this before, and it is the most useful thing it can say.
    const result = layout({
      offers: [offer('shield-cell')],
      currentModifiers: build(undefined, 'exposed-core'),
    })
    const option = result.options[0]
    expect(option?.statRows[0]?.direction).toBe('none')
    expect(texts(option)).toContain('Max shield  0 → 0 hp')
    expect(texts(option)).toContain(` ${NO_CHANGE_TEXT}`)
    // AND THE AUTHORED SENTENCE IS GONE, which is the opposite of what this test
    // asserted when the rows first landed. It expected "+22 max shield" to still be on
    // the card beside a row reading `Max shield 0 → 0 hp` — two contradictory claims
    // about the same pick, with the row telling the truth. The sentence is dropped
    // wherever the rows already state every figure in it; see `choiceScreen.ts`.
    expect(option?.mechanismLines).toHaveLength(0)
  })

  it('says when a number rises but cannot matter on this build', () => {
    // The Collateral's -40 cancels the base 40 max shield exactly, so a shield-recovery
    // item is worth nothing on it. The rate genuinely rises — 4 to 6 — which is why the
    // generic before → after cannot catch this and the row states the reason instead.
    //
    // A synthetic def, because which roster item carries a recovery stat is still moving
    // and this is a test of the card rather than of this week's items.ts.
    const items: Record<string, ItemDef> = {
      shunt: {
        id: 'shunt',
        name: 'Recharge Shunt',
        tier: 'common',
        tags: ['defence'],
        mechanism: 'Shield recovers 50% faster, from 4 to 6 per second.',
        stats: [{ stat: 'shieldRegenPerSecond', kind: 'mul', value: 1.5 }],
      },
    }
    const result = layout({
      items,
      offers: [offer('shunt')],
      currentModifiers: build('collateral'),
    })
    const shunt = result.options[0]
    expect(shunt?.statRows[0]?.direction).toBe('inert')
    expect(texts(shunt)).toContain('Shield regen  4 → 6 hp/s')
    expect(texts(shunt)).toContain(' (no effect: max shield 0)')
    const note = shunt?.lines.find((line) => line.text === ' (no effect: max shield 0)')
    expect(note?.color).toBe(Palette.caution)
    // On a hull with a shield the same offer reads as a gain.
    expect(
      layout({ items, offers: [offer('shunt')] }).options[0]?.statRows[0]?.direction,
    ).toBe('better')
  })

  it('folds the hull the run was issued into the before value', () => {
    // Probate resolves max integrity to 100 × 0.64 = 64, and Plating Shim's +18 lands
    // as (100 + 18) × 0.64 = 75.5. A card ignoring the hull would say 100 → 118.
    const result = layout({
      offers: [offer('plating-shim')],
      currentModifiers: build('probate'),
    })
    expect(texts(result.options[0])).toContain('Max integrity  64 → 75.5 hp')
    expect(texts(result.options[0])).toContain(' (+11.5)')
  })

  it('shows fire rate in shots per second, signed the right way round', () => {
    const result = layout({ offers: [offer('feed-relay')] })
    const option = result.options[0]
    expect(texts(option)).toContain('Fire rate  20 → 30 shots/s')
    expect(option?.statRows[0]?.direction).toBe('better')
    for (const text of texts(option)) expect(text).not.toMatch(/\btick/)
  })

  it('drops a row rather than contradicting the instrument panel', () => {
    const modifiers = build('surety')
    const agreeing = layout({
      offers: [offer('shield-cell')],
      currentModifiers: modifiers,
      resolvedStats: resolveAllStats(modifiers),
    })
    expect(texts(agreeing.options[0])).toContain('Max shield  110 → 132 hp')

    const disagreeing = layout({
      offers: [offer('shield-cell')],
      currentModifiers: modifiers,
      // What a hull the screen does not know about would look like.
      resolvedStats: { ...resolveAllStats(modifiers), maxShield: 512 },
    })
    expect(disagreeing.options[0]?.statRows).toHaveLength(0)
    expect(texts(disagreeing.options[0])).not.toContain(STAT_ROW_LABEL)
    // The card is still a card: the sentence and the name are untouched.
    expect(disagreeing.options[0]?.mechanismLines.length).toBeGreaterThan(0)
  })

  it('colours a gain and a cost differently, and never uses danger', () => {
    const result = layout({
      offers: [offer('warheads'), offer('shield-cell')],
      currentModifiers: build(undefined, 'exposed-core'),
    })
    const warheads = result.options[0]
    // Exposed Core is damage mul 1.35, so 4 × 1.35 = 5.4 and Warheads takes it to
    // 5.4 × 1.45 = 7.83. Speed is untouched by the curse: 620 × 0.85 = 527.
    expect(warheads?.statRows.map((row) => row.text)).toEqual([
      'Shot damage  5.4 → 7.8 dmg',
      'Shot speed  620 → 527 u/s',
    ])
    const damage = warheads?.lines.find((line) => line.text === ' (+2.4)')
    const speed = warheads?.lines.find((line) => line.text === ' (-93)')
    expect(damage?.color).toBe(Palette.good)
    expect(speed?.color).toBe(Palette.caution)
    // A pick worth nothing is a caution, not a gain — and it says so in words too.
    const dead = result.options[1]?.lines.find((line) => line.text === ` ${NO_CHANGE_TEXT}`)
    expect(dead?.color).toBe(Palette.caution)
    for (const line of allLines(result)) expect(line.color).not.toBe('#FF4A38')
  })

  it('keeps every row inside its option box, for every item and several builds', () => {
    // Rows are drawn with a single call and cannot wrap, so a wide one would simply
    // leave the card. The label shares the first row's line, which is why the check is
    // against the drawn lines rather than against the row strings.
    const builds: readonly (readonly StatModifier[])[] = [
      build(undefined),
      build('probate', 'repair-nanites'),
      build('collateral', ['feed-relay', 3], ['machined-slugs', 2]),
      build('surety', 'exposed-core', 'warheads', ['scrap-magnet', 2]),
    ]
    for (const modifiers of builds) {
      for (const ids of everyTriple()) {
        const result = layout({ offers: ids.map((id) => offer(id)), currentModifiers: modifiers })
        expect(result.overflow).toBe(false)
        for (const option of result.options) {
          for (const line of option.lines) {
            const bounds = lineBounds(line)
            expect(bounds.left).toBeGreaterThanOrEqual(option.box.x)
            expect(bounds.right, `"${line.text}" leaves the box`).toBeLessThanOrEqual(
              option.box.x + option.box.w,
            )
            expect(line.y + line.size).toBeLessThanOrEqual(option.box.y + option.box.h)
          }
          // The label is inline for all real content; the fallback that drops it exists
          // only for a future stat with a wider range.
          if (option.statRows.length > 0) expect(texts(option)).toContain(STAT_ROW_LABEL)
        }
      }
    }
  })

  it('collapses the rows onto one line instead of dropping them when space runs out', () => {
    /*
     * SYNTHETIC CARDS, and the reason is worth stating because it looks like a cheat.
     *
     * This asserted the collapse against three named real items at `degrade === 3`. Two
     * things then moved: pure-stat items lost their redundant sentence, which freed space,
     * and a sweep of every pair of real items now finds that the only triples reaching
     * degrade 3 carry a SINGLE stat row — and one row has nothing to collapse onto. So the
     * behaviour is currently unreachable from the shipping content tables.
     *
     * That is a fact about today's item copy, not about the layout, and pinning the test to
     * it would mean asserting nothing. A fabricated item with two stats and a long enough
     * sentence exercises the branch directly. The real-content guarantee — that no card
     * overflows and rows are never dropped — is covered by the sweeps elsewhere in this file.
     */
    const longest = [...INTERACTIONS].sort((a, b) => b.text.length - a.text.length)
    const bulky: ItemDef = {
      id: 'synthetic-bulky',
      name: 'Synthetic Bulky',
      tier: 'rare',
      tags: ['weapon'],
      // Length tuned to the tightest level that still FITS. Longer sentences also reach
      // degrade 3, but overflow with it — and a card that overflows is a different bug
      // from a card that compacts, so asserting both at once would confuse the two.
      mechanism:
        'A long specification sentence kept on the card because this item carries an effect.',
      flavour: 'Synthetic, for the layout, and never offered to a player.',
      stats: [
        { stat: 'projectileDamage', kind: 'add', value: 3 },
        { stat: 'hullSpeed', kind: 'add', value: 40 },
      ],
      effects: [{ kind: 'pierce', on: 'onFire', count: 1 }],
      weight: 1,
    }
    const items = { ...ITEMS, [bulky.id]: bulky }
    const result = layout({
      kind: 'shop',
      items,
      offers: [
        offer(bulky.id, [longest[0]?.text ?? '']),
        offer(bulky.id, [longest[1]?.text ?? '']),
        offer(bulky.id, [longest[2]?.text ?? '']),
      ],
      costs: [384, 192, 288],
      scrap: 200,
    })
    expect(result.degrade).toBe(3)
    expect(result.overflow).toBe(false)

    const option = result.options[0]
    expect(option?.statCompact).toBe(true)
    expect(option?.statRows).toHaveLength(2)
    // Both stats are still on the card, and on one line.
    const joined = texts(option).join('')
    for (const row of option?.statRows ?? []) expect(joined).toContain(row.text)
    expect(joined).toContain(STAT_ROW_SEP)
    const rowLines = (option?.lines ?? []).filter((line) =>
      (option?.statRows ?? []).some((row) => row.text === line.text),
    )
    expect(new Set(rowLines.map((line) => line.y)).size).toBe(1)
  })

  it('gives a work order no rows and no label', () => {
    const result = layout({ kind: 'work-order', offers: [], workOrders: ['supply', 'hazard'] })
    for (const option of result.options) {
      expect(option.statRows).toHaveLength(0)
      expect(texts(option)).not.toContain(STAT_ROW_LABEL)
    }
  })

  it('survives a build described by nonsense', () => {
    const result = layout({
      offers: [offer('warheads'), offer('shield-cell')],
      currentModifiers: [
        { stat: 'projectileDamage', kind: 'mul', value: Number.NaN },
        { stat: 'maxShield', kind: 'add', value: Infinity },
      ],
    })
    for (const option of result.options) {
      for (const line of option.lines) expect(line.text).not.toMatch(/NaN|undefined/)
      for (const row of option.statRows) {
        expect(Number.isFinite(row.before)).toBe(true)
        expect(Number.isFinite(row.after)).toBe(true)
      }
    }
  })
})
