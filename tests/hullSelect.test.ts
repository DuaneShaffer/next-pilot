/**
 * Hull selection: the offer draw, the comparison, and the card.
 *
 * Headless by construction, like `tests/hangar.test.ts` and
 * `tests/choiceScreen.test.ts`: `layoutHullSelect` returns every rect and every
 * positioned, pre-measured line, so the things that actually break on this screen are
 * assertable with no canvas. Nobody has looked at this screen rendered, which is
 * exactly why it has to be checkable.
 *
 * WIDTHS COME FROM THE SCREEN'S OWN CONSTANTS. `tests/textFits.test.ts` records why:
 * the first hardcoded width in that file was wrong by a factor of three, and "a test
 * that restates a layout number tests its own guess."
 *
 * MUTATION-VERIFIED. Each mutation below was applied, the named test confirmed to
 * fail, and the mutation reverted:
 *
 *   `improved = rawValue > rawBase` (signing from the raw delta, ignoring
 *   `lowerIsBetter`) — fails "signs a lowerIsBetter stat by the stat table", plus four
 *   more including the card-level drawback test. This is the naive implementation and
 *   it files Collateral's faster gun under GIVES UP.
 *
 *   `STAT_DISPLAY.fireIntervalTicks` losing `present: shotsPerSecond` — fails
 *   "presents fire rate in shots per second, not in ticks".
 *
 *   `chosen` seeded with `drawn` alone instead of `[LIEN_ID, ...drawn]` — fails
 *   "always offers the Lien" and three more.
 *
 *   the candidate filter losing `Object.hasOwn(HULLS, id)` — fails "never offers an id
 *   that no hull answers to" and three more.
 *
 *   Arrears' -30 integrity and -15 shield both flipped positive — fails "gives every
 *   hull but the Lien at least one cost and one gain" and the card-level "renders a
 *   GIVES UP column with rows for every hull but the Lien".
 *
 *   a STAT_DISPLAY label lengthened to "Maximum hull integrity rating" — fails "fits
 *   every stat row inside its column" here and its twin in `tests/textFits.test.ts`.
 *
 *   `PULSE_DEPTH = 1` — fails "never lets the selection wash reach zero opacity".
 *
 *   the candidate `sort` by `hullRank` removed — fails "does not depend on the order
 *   the pool arrives in".
 *
 *   `compareToBaseline` skipping `hullSpeed` — fails "draws a table row for every stat a
 *   hull moves", which is the half of the R12 guard that lives here: hull prose no
 *   longer states figures, so a stat the table drops is a figure that is nowhere.
 *
 * Two mutations that did NOT fail anything are recorded because they found dead code
 * rather than a weak test: `known.add(LIEN_ID)` and an `Object.hasOwn` guard that
 * `HULL_ORDER.indexOf` was already making redundant. Both were removed, and
 * `offerHulls` now has exactly one guard per property it promises.
 */

import { describe, expect, it } from 'vitest'
import { HULLS, HULL_ORDER, LIEN_ID, getHull } from '../src/content/hulls'
import { ITEMS } from '../src/content/items'
import type { HullDef, StatKey } from '../src/content/types'
import { Rng } from '../src/core/rng'
import { Palette, Font } from '../src/render/palette'
import { REDUCED_FLASH_SCALE } from '../src/render/intensity'
import { STATS, STAT_KEYS, resolveStat, shotsPerSecond } from '../src/sim/stats'
import { lineBounds, monoMeasure, type TextLine } from '../src/ui/choiceScreen'
import {
  HULL_BASELINE_TEXT,
  HULL_COSTS_HEADING,
  HULL_GAINS_HEADING,
  HULL_LABEL_SIZE,
  HULL_OFFER_STREAM,
  HULL_PULSE_MAX,
  HULL_PULSE_MIN,
  HULL_PULSE_RATE_HZ,
  HULL_ROW_SIZE,
  HULL_SELECT_COL_W,
  HULL_SELECT_STANDFIRST,
  HULL_SELECT_TEXT_W,
  HULL_STARTS_LABEL,
  MAX_HULL_OFFERS,
  compareToBaseline,
  layoutHullSelect,
  moveHullSelection,
  offerHulls,
  shouldShowHullSelect,
  type HullSelectLayout,
  type HullSelectLayoutInput,
} from '../src/ui/hullSelect'

const measure = monoMeasure
const SEED = 'HULL-01'

/** Every hull that exists, plus the three the design defers and one typo. */
const DIRTY_POOL = [...HULL_ORDER, 'escrow', 'indemnity', 'writ', 'no-such-hull', 'lien']

function offerFor(seed: string, pool: readonly string[] = HULL_ORDER): readonly string[] {
  return offerHulls(Rng.fromSeed(seed, HULL_OFFER_STREAM), pool)
}

function layout(overrides: Partial<HullSelectLayoutInput> = {}): HullSelectLayout {
  const base: HullSelectLayoutInput = {
    offer: [LIEN_ID, 'arrears', 'collateral'],
    selected: 0,
    tick: 0,
    seed: SEED,
    measure,
  }
  return layoutHullSelect({ ...base, ...overrides })
}

function allLines(result: HullSelectLayout): readonly TextLine[] {
  return [...result.header, ...result.footer, ...result.cards.flatMap((card) => card.lines)]
}

/** Every offer this screen can be handed, so no combination goes unmeasured. */
function everyOffer(): readonly (readonly string[])[] {
  const out: string[][] = []
  const ids = [...HULL_ORDER]
  for (const a of ids) {
    out.push([a])
    for (const b of ids) {
      if (b <= a) continue
      out.push([a, b])
      for (const c of ids) {
        if (c <= b) continue
        out.push([a, b, c])
      }
    }
  }
  return out
}

/** Numbers reachable from a layout, for the NaN sweep. */
function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') out.push(value)
  else if (Array.isArray(value)) for (const entry of value) numbersIn(entry, out)
  else if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) numbersIn(entry, out)
  }
  return out
}

// ---------------------------------------------------------------------------
// the offer
// ---------------------------------------------------------------------------

describe('offerHulls', () => {
  it('offers at most three', () => {
    // `docs/DESIGN.md` says three. A fourth card does not fit the layout and a test
    // below proves it, so this is the guard that keeps the two agreeing.
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      expect(offerFor(seed, DIRTY_POOL).length).toBeLessThanOrEqual(MAX_HULL_OFFERS)
    }
  })

  it('always offers the Lien', () => {
    // Stated outright in `docs/DESIGN.md`, and structural: every other card's
    // mechanism quotes a before-and-after, and the "before" has to be on screen.
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) {
      expect(offerFor(seed, DIRTY_POOL), seed).toContain(LIEN_ID)
    }
    // Even when the pool handed in has somehow lost it.
    expect(offerFor('x', ['arrears', 'surety'])).toContain(LIEN_ID)
    expect(offerFor('x', [])).toEqual([LIEN_ID])
  })

  it('never repeats a hull', () => {
    // Two certifications granting the same hull must not spend two of three slots.
    const doubled = [...DIRTY_POOL, ...DIRTY_POOL]
    for (const seed of ['a', 'b', 'c', 'd']) {
      const offer = offerFor(seed, doubled)
      expect(new Set(offer).size, seed).toBe(offer.length)
    }
  })

  it('never offers an id that no hull answers to', () => {
    // THE DEGRADATION TEST. The pool is data: `poolFor` copies whatever a
    // certification grants, three hulls the design names do not exist
    // (`HULLS_AWAITING_MECHANICS`), and the launch path must not be the thing that
    // crashes when someone adds a grant for one.
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      for (const id of offerFor(seed, DIRTY_POOL)) {
        expect(Object.hasOwn(HULLS, id), `${seed} offered ${id}`).toBe(true)
        expect(() => getHull(id)).not.toThrow()
      }
    }
  })

  it('drops a pool of nothing but unknown ids without throwing', () => {
    expect(() => offerFor('x', ['escrow', 'indemnity', 'writ'])).not.toThrow()
    expect(offerFor('x', ['escrow', 'indemnity', 'writ'])).toEqual([LIEN_ID])
  })

  it('is deterministic for a seed', () => {
    // The whole contract. Same seed, same offer, on any machine.
    for (const seed of ['alpha', 'beta', 'gamma']) {
      expect(offerFor(seed, DIRTY_POOL)).toEqual(offerFor(seed, DIRTY_POOL))
    }
  })

  it('does not depend on the order the pool arrives in', () => {
    // `poolFor` emits base order then roster order. Reordering `CERTIFICATIONS` must
    // not change what a given seed offers, so the candidate list is canonicalised
    // through HULL_ORDER before the draw.
    const reversed = [...DIRTY_POOL].reverse()
    for (const seed of ['alpha', 'beta', 'gamma', 'delta']) {
      expect(offerFor(seed, reversed), seed).toEqual(offerFor(seed, DIRTY_POOL))
    }
  })

  it('actually varies with the seed', () => {
    // Guards the guard: a draw that ignored the rng would pass every test above.
    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) seen.add(offerFor(`seed-${i}`, DIRTY_POOL).join(','))
    expect(seen.size).toBeGreaterThan(1)
  })

  it('returns presentation order, with the Lien first', () => {
    // HULL_ORDER drives both this screen and the hangar. Lien first means the default
    // selection is the baseline, which is the right thing for a confirm-immediately
    // player to get.
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const offer = offerFor(seed, DIRTY_POOL)
      expect(offer[0], seed).toBe(LIEN_ID)
      const ranks = offer.map((id) => HULL_ORDER.indexOf(id))
      expect([...ranks].sort((x, y) => x - y), seed).toEqual(ranks)
    }
  })

  it('offers every certifiable hull to somebody', () => {
    // A hull the draw can never produce is unreachable content wearing a certification
    // — the exact defect this screen exists to fix, one level down.
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) for (const id of offerFor(`s${i}`, DIRTY_POOL)) seen.add(id)
    for (const id of HULL_ORDER) expect(seen.has(id), `${id} is never offered`).toBe(true)
  })
})

describe('shouldShowHullSelect', () => {
  it('does not stop the player for a card with one option', () => {
    // A card whose only action is "continue" teaches that stopping is pointless. This
    // project has shipped that twice. On a fresh save the pool is `['lien']`.
    expect(shouldShowHullSelect([LIEN_ID])).toBe(false)
    expect(shouldShowHullSelect([])).toBe(false)
  })

  it('stops the player as soon as there is a real choice', () => {
    expect(shouldShowHullSelect([LIEN_ID, 'arrears'])).toBe(true)
    expect(shouldShowHullSelect([LIEN_ID, 'arrears', 'surety'])).toBe(true)
  })
})

describe('moveHullSelection', () => {
  it('wraps rather than walling', () => {
    expect(moveHullSelection(0, -1, 3)).toBe(2)
    expect(moveHullSelection(2, 1, 3)).toBe(0)
  })

  it('survives nonsense', () => {
    expect(moveHullSelection(Number.NaN, 1, 3)).toBe(1)
    expect(moveHullSelection(0, Number.NaN, 3)).toBe(0)
    expect(moveHullSelection(0, 1, 0)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// the comparison
// ---------------------------------------------------------------------------

describe('compareToBaseline', () => {
  it('signs a lowerIsBetter stat by the stat table, not by the sign of the delta', () => {
    // THE LOAD-BEARING TEST OF THIS FILE. `fireIntervalTicks` is the one stat where
    // the raw number and the number a player reads move in opposite directions:
    // Collateral takes 3 ticks to 2, which is 20 shots/second to 30. Signing from the
    // raw delta would file the roster's biggest weapon upgrade under GIVES UP and tell
    // the player the exact opposite of the truth about the hull.
    const collateral = getHull('collateral')
    expect(resolveStat('fireIntervalTicks', collateral.stats)).toBe(2)

    const { costs, gains } = compareToBaseline(collateral)
    const fire = gains.find((row) => row.stat === 'fireIntervalTicks')
    expect(fire, 'fire rate is not listed as a gain').toBeDefined()
    expect(costs.some((row) => row.stat === 'fireIntervalTicks')).toBe(false)
    expect(fire?.direction).toBe('better')
    expect(fire?.base).toBe(20)
    expect(fire?.value).toBe(30)
    expect(fire?.delta).toBe(10)
    expect(fire?.deltaText).toBe('(+10)')
  })

  it('presents fire rate in shots per second, not in ticks', () => {
    // Ticks are a simulation implementation detail. "3 → 2 ticks" under a heading that
    // says GAINS asks the player to reason about the engine to know it is good news.
    const fire = compareToBaseline(getHull('collateral')).gains.find(
      (row) => row.stat === 'fireIntervalTicks',
    )
    expect(fire?.unit).toBe('shots/s')
    expect(fire?.text).toContain('20 → 30 shots/s')
    expect(fire?.text).not.toContain('tick')
  })

  it('agrees with the stat table about direction for every hull and every stat', () => {
    // The generic form of the test above, so a future hull touching a future
    // lowerIsBetter stat is covered without anyone remembering to add a case.
    for (const [key, def] of Object.entries(HULLS)) {
      for (const row of [...compareToBaseline(def).costs, ...compareToBaseline(def).gains]) {
        const spec = STATS[row.stat]
        const raw = resolveStat(row.stat, def.stats)
        const improved = spec.lowerIsBetter === true ? raw < spec.base : raw > spec.base
        expect(row.direction, `${key}: ${row.stat}`).toBe(improved ? 'better' : 'worse')
      }
    }
  })

  it('gives every hull but the Lien at least one cost and one gain', () => {
    // `tests/hulls.test.ts` asserts this of the content. This asserts the *screen*
    // renders both halves — a hull whose only upside were an `EffectDef` would pass
    // there and show nothing but drawbacks here, and that is a card nobody picks.
    for (const [key, def] of Object.entries(HULLS)) {
      const { costs, gains } = compareToBaseline(def)
      if (key === LIEN_ID) {
        expect(costs).toEqual([])
        expect(gains).toEqual([])
        continue
      }
      expect(costs.length, `${key} shows no drawback`).toBeGreaterThan(0)
      expect(gains.length, `${key} shows no upside`).toBeGreaterThan(0)
    }
  })

  it('leaves the Lien with no net line, because it is the baseline', () => {
    expect(compareToBaseline(getHull(LIEN_ID)).net).toBeNull()
  })

  it('states the composite figures the per-stat rows hide', () => {
    // Probate trades 36 integrity for 20 shield and lands at 124 against 140 — close
    // enough that a two-row table reads as a wash, which is exactly what this figure
    // exists to contradict. The write-down was -28% until a sweep measured the hull
    // at +29 pp above the roster mean on the strength of its starting relic alone.
    const probate = compareToBaseline(getHull('probate'))
    expect(probate.baseEffectiveHealth).toBe(140)
    expect(probate.effectiveHealth).toBe(124)
    expect(probate.net).toContain('140 → 124 effective hp (-16)')
    expect(probate.net).toContain('unchanged')

    const collateral = compareToBaseline(getHull('collateral'))
    expect(collateral.damagePerSecond).toBe(120)
    expect(collateral.net).toContain('80 → 120 dmg/s output (+40)')
  })

  it('quotes every number from the live stat table', () => {
    // Ties the comparison to the data the simulation reads, so retuning `STATS` cannot
    // leave a card confidently stating the old baseline.
    for (const [key, def] of Object.entries(HULLS)) {
      for (const row of [...compareToBaseline(def).costs, ...compareToBaseline(def).gains]) {
        const spec = STATS[row.stat]
        const present = row.stat === 'fireIntervalTicks' ? shotsPerSecond : (v: number) => v
        expect(row.base, `${key}: ${row.stat}`).toBeCloseTo(
          row.stat === 'scrapMultiplier' || row.stat === 'focusFactor'
            ? spec.base * 100
            : present(spec.base),
          5,
        )
      }
    }
  })

  it('carries a unit and an explicit sign on every row', () => {
    // Rule 2. The unit sits on the value pair and the sign on the delta beside it, so
    // every number on the row is qualified by something adjacent to it.
    for (const [key, def] of Object.entries(HULLS)) {
      for (const row of [...compareToBaseline(def).costs, ...compareToBaseline(def).gains]) {
        expect(row.text, `${key}: ${row.stat}`).toContain(row.unit)
        expect(row.text, `${key}: ${row.stat}`).toContain('→')
        expect(row.deltaText, `${key}: ${row.stat}`).toMatch(/^\([+-]/)
      }
    }
  })

  it('states the baseline standfirst with the live values', () => {
    const dps = STATS.projectileDamage.base * shotsPerSecond(STATS.fireIntervalTicks.base)
    expect(HULL_SELECT_STANDFIRST).toContain(String(STATS.maxIntegrity.base + STATS.maxShield.base))
    expect(HULL_SELECT_STANDFIRST).toContain(String(STATS.hullSpeed.base))
    expect(HULL_SELECT_STANDFIRST).toContain(String(dps))
  })

  it('states the Lien card baseline with the live values', () => {
    // The Lien has no trade table, so this line is its table — and it is derived for
    // the same reason the rows are. Hull prose states no figures at all now, so if this
    // string stopped quoting `STATS` the one hull the whole content set is tuned against
    // would state none of its own numbers anywhere on the screen.
    expect(HULL_BASELINE_TEXT).toContain(String(STATS.maxIntegrity.base))
    expect(HULL_BASELINE_TEXT).toContain(String(STATS.maxShield.base))
    expect(HULL_BASELINE_TEXT).toContain(String(shotsPerSecond(STATS.fireIntervalTicks.base)))
    expect(HULL_BASELINE_TEXT).toContain(String(STATS.projectileDamage.base))
    // Rule 2: every number carries its unit.
    for (const unit of ['integrity', 'shield', 'shots/s', 'dmg']) {
      expect(HULL_BASELINE_TEXT, unit).toContain(unit)
    }
  })
})

// ---------------------------------------------------------------------------
// the other half of the R12 guard
// ---------------------------------------------------------------------------

describe('the card prints every figure the prose gave up', () => {
  /**
   * `tests/hulls.test.ts` fails if a hull's authored prose states a figure, because a
   * hand-written number is the one that goes stale when the hull is rebalanced —
   * `docs/ROADMAP.md` R12, three times over. That guard is only half safe on its own:
   * cutting a number out of a sentence and printing it nowhere would pass it while
   * leaving the player with a card that says a hull is "thin" and never says how thin.
   *
   * So this is the complement. Every stat a hull moves, every credit of starting scrap
   * and both composite figures have to be on the card, drawn, in a line the layout
   * actually emits. The two tests together say: the figures moved, they did not go.
   */

  it('draws a table row for every stat a hull moves', () => {
    for (const id of HULL_ORDER) {
      const def = getHull(id)
      const card = layout({ offer: [id] }).cards[0]
      expect(card, id).toBeDefined()
      const drawn = (card?.lines ?? []).map((entry) => entry.text)

      for (const stat of new Set(def.stats.map((m) => m.stat))) {
        // A stat the modifiers move but the bounds swallow would be legitimately
        // absent; `tests/hulls.test.ts` rejects that content separately.
        expect(resolveStat(stat, def.stats), `${id}: ${stat} is a no-op`).not.toBe(STATS[stat].base)
        const row = [...(card?.costRows ?? []), ...(card?.gainRows ?? [])].find(
          (entry) => entry.stat === stat,
        )
        expect(row, `${id}: ${stat} moved and no row on the card states it`).toBeDefined()
        expect(drawn, `${id}: the ${stat} row is not drawn`).toContain(row?.text)
        // The row is the figure's only home now, so it has to carry one.
        expect(row?.text, `${id}: the ${stat} row states no number`).toMatch(/\d/)
        expect(drawn.some((text) => text.includes(row?.deltaText ?? 'no delta')), `${id}: ${stat} delta`)
          .toBe(true)
      }
    }
  })

  it('draws the starting scrap figure for every hull that is funded', () => {
    for (const id of HULL_ORDER) {
      const def = getHull(id)
      if (def.startingScrap === undefined) continue
      const card = layout({ offer: [id] }).cards[0]
      expect(card?.startingLines.join(' '), `${id}: starting scrap`).toContain(
        String(def.startingScrap),
      )
    }
  })

  it('draws the net line for every hull that is not the baseline', () => {
    // Effective health and output are the two figures the prose used to sum up and the
    // per-stat rows cannot: integrity and shield are separate rows, and dmg/s is a
    // product of two of them.
    for (const id of HULL_ORDER) {
      const card = layout({ offer: [id] }).cards[0]
      if (id === LIEN_ID) {
        expect(card?.netLines, id).toEqual([])
        continue
      }
      const net = (card?.netLines ?? []).join(' ')
      expect(net, `${id}: no net line`).toMatch(/\d/)
      expect(net, `${id}: net line omits effective hp`).toContain('effective hp')
      expect(net, `${id}: net line omits output`).toContain('dmg/s')
      for (const text of card?.netLines ?? []) {
        expect((card?.lines ?? []).map((entry) => entry.text), `${id}: net not drawn`).toContain(text)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// the card
// ---------------------------------------------------------------------------

describe('every hull states its drawback on the card', () => {
  it('renders a GIVES UP column with rows for every hull but the Lien', () => {
    // THE HONESTY TEST. A hull added later with no stated cost fails here, on the
    // screen, rather than shipping a card that reads as a free upgrade.
    for (const id of HULL_ORDER) {
      const card = layout({ offer: [id] }).cards[0]
      expect(card, id).toBeDefined()
      if (id === LIEN_ID) {
        expect(card?.costRows).toEqual([])
        expect(card?.lines.some((line) => line.text === HULL_BASELINE_TEXT), id).toBe(true)
        continue
      }
      expect(card?.costRows.length, `${id} card shows no drawback`).toBeGreaterThan(0)
      expect(card?.lines.some((line) => line.text === HULL_COSTS_HEADING), id).toBe(true)
      expect(card?.lines.some((line) => line.text === HULL_GAINS_HEADING), id).toBe(true)
      for (const row of card?.costRows ?? []) {
        expect(card?.lines.some((line) => line.text === row.text), `${id}: ${row.text}`).toBe(true)
      }
    }
  })

  it('puts the drawback column first and at the same weight as the upside', () => {
    // "State the drawback as loudly as the upside." Costs are the left column, and
    // both headings are the same size and weight — the drawback is not a footnote.
    const card = layout({ offer: ['surety'] }).cards[0]
    const costs = card?.lines.find((line) => line.text === HULL_COSTS_HEADING)
    const gains = card?.lines.find((line) => line.text === HULL_GAINS_HEADING)
    expect(costs).toBeDefined()
    expect(gains).toBeDefined()
    expect(costs?.x).toBeLessThan(gains?.x ?? 0)
    expect(costs?.y).toBe(gains?.y)
    expect(costs?.size).toBe(gains?.size)
    expect(costs?.weight).toBe(gains?.weight)
  })

  it('draws the mechanism sentence verbatim, above the table', () => {
    // Rule 4's fixed format: name, then the complete mechanical effect with real
    // numbers, before anything else on the card.
    for (const id of HULL_ORDER) {
      const card = layout({ offer: [id] }).cards[0]
      const def = getHull(id)
      const joined = (card?.mechanismLines ?? []).join(' ')
      expect(joined.replace(/\s+/g, ' '), id).toBe(def.mechanism.replace(/\s+/g, ' '))
      const nameLine = card?.lines.find((line) => line.text === def.name)
      const firstMech = card?.lines.find((line) => line.text === card.mechanismLines[0])
      expect(nameLine?.y ?? 0, id).toBeLessThan(firstMech?.y ?? 0)
      const heading = card?.lines.find(
        (line) => line.text === HULL_COSTS_HEADING || line.text === HULL_BASELINE_TEXT,
      )
      expect(firstMech?.y ?? 0, id).toBeLessThan(heading?.y ?? Number.POSITIVE_INFINITY)
    }
  })

  it('shows starting scrap with its unit', () => {
    // Arrears begins funded. A player who finds 320 cr they did not know about has
    // been told something after the fact that they needed before it.
    const card = layout({ offer: ['arrears'] }).cards[0]
    expect(card?.startingLines.join(' ')).toContain('320 cr')
    expect(card?.lines.some((line) => line.text === HULL_STARTS_LABEL)).toBe(true)
  })

  it('names the starting relic, its tier, and what it does', () => {
    // Probate begins holding a named relic. The name alone is barely better than
    // nothing if the player has never seen the item, so its mechanism comes too.
    const card = layout({ offer: ['probate'] }).cards[0]
    const text = card?.startingLines.join(' ') ?? ''
    const nanites = ITEMS['repair-nanites']
    expect(nanites).toBeDefined()
    expect(text).toContain(nanites?.name ?? '')
    expect(text).toContain(`[${nanites?.tier}]`)
    expect(text.replace(/\s+/g, ' ')).toContain(
      (nanites?.mechanism ?? '').slice(0, 30).replace(/\s+/g, ' '),
    )
  })

  it('shows no starting block for a hull that grants nothing', () => {
    // An empty "STARTS WITH" label reads as a loadout that failed to render.
    for (const id of [LIEN_ID, 'surety', 'collateral']) {
      expect(layout({ offer: [id] }).cards[0]?.startingLines, id).toEqual([])
    }
  })

  it('keeps the seed on screen (rule 8)', () => {
    expect(allLines(layout()).some((line) => line.text === SEED)).toBe(true)
  })

  it('names the selected hull in the footer, so confirm is never blind', () => {
    for (let i = 0; i < 3; i++) {
      const result = layout({ selected: i })
      const name = result.cards[i]?.name ?? ''
      expect(result.footer.some((line) => line.text.includes(name)), name).toBe(true)
    }
  })
})

describe('the card holds its content', () => {
  for (const offer of everyOffer()) {
    it(`fits every line inside its box for [${offer.join(', ')}]`, () => {
      const result = layout({ offer, selected: offer.length - 1 })
      const cardRight = result.card.x + result.card.w
      const cardBottom = result.card.y + result.card.h
      expect(result.overflow, 'cards overflow the available height').toBe(false)
      expect(result.cards.length).toBe(offer.length)

      for (const entry of result.cards) {
        expect(entry.box.x).toBeGreaterThanOrEqual(result.card.x)
        expect(entry.box.x + entry.box.w).toBeLessThanOrEqual(cardRight)
        expect(entry.box.y).toBeGreaterThanOrEqual(result.card.y)
        expect(entry.box.y + entry.box.h).toBeLessThanOrEqual(cardBottom)

        for (const line of entry.lines) {
          const bounds = lineBounds(line)
          expect(bounds.left, `${entry.id}: "${line.text}" left of its card`).toBeGreaterThanOrEqual(
            entry.box.x,
          )
          expect(bounds.right, `${entry.id}: "${line.text}" past its card`).toBeLessThanOrEqual(
            entry.box.x + entry.box.w,
          )
          expect(line.y).toBeGreaterThanOrEqual(entry.box.y)
          expect(
            line.y + line.size,
            `${entry.id}: "${line.text}" below its card`,
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

  it('never lets two cards overlap', () => {
    const result = layout({ offer: [LIEN_ID, 'surety', 'probate'] })
    for (let i = 1; i < result.cards.length; i++) {
      const above = result.cards[i - 1]
      const below = result.cards[i]
      expect(above && below && below.box.y >= above.box.y + above.box.h).toBe(true)
    }
  })

  it('never renders below the minimum font size (rule 7)', () => {
    for (const line of allLines(layout({ offer: [LIEN_ID, 'surety', 'probate'] }))) {
      expect(line.size, `"${line.text}" is too small`).toBeGreaterThanOrEqual(Font.minSizePx - 1)
    }
  })

  it('fits every stat row inside its column', () => {
    // Rows are drawn with a single `drawText` and cannot wrap, so a long label plus a
    // four-figure value would run straight into the other column. Every real hull,
    // plus a synthetic hull per stat so a stat nothing currently touches is covered.
    const synthetic: HullDef[] = STAT_KEYS.map((stat: StatKey) => ({
      id: `synthetic-${stat}`,
      name: 'Synthetic',
      mechanism: 'Synthetic hull used to measure one stat row. 1 unit.',
      stats: [
        { stat, kind: 'add' as const, value: stat === 'focusFactor' ? 0.25 : Math.max(1, Math.round(STATS[stat].base * 0.4)) },
      ],
    }))

    for (const def of [...Object.values(HULLS), ...synthetic]) {
      for (const row of [...compareToBaseline(def).costs, ...compareToBaseline(def).gains]) {
        const width =
          measure(row.text, HULL_ROW_SIZE) + measure(` ${row.deltaText}`, HULL_LABEL_SIZE, 600)
        expect(width, `${def.id}: "${row.text} ${row.deltaText}" overflows its column`)
          .toBeLessThanOrEqual(HULL_SELECT_COL_W)
      }
    }
  })

  it('wraps every net line inside the card text column', () => {
    for (const def of Object.values(HULLS)) {
      const card = layout({ offer: [def.id] }).cards[0]
      for (const text of card?.netLines ?? []) {
        expect(measure(text, HULL_ROW_SIZE), `net for ${def.id} overflows: ${text}`)
          .toBeLessThanOrEqual(HULL_SELECT_TEXT_W)
      }
      // One line is what the card budgets for. Two is a silent height overrun.
      expect((card?.netLines ?? []).length, `${def.id} net needs ${card?.netLines.length} lines`)
        .toBeLessThanOrEqual(2)
    }
  })
})

describe('degradation and defects', () => {
  /**
   * A trio built to reach the tightest degradation level, rather than whichever real
   * hulls happen to be wordiest this week.
   *
   * THIS USED TO BE PINNED TO A REAL OFFER AND IT BROKE TWICE. First when Surety's
   * mechanism lost a clause, then when hull prose stopped stating figures at all and
   * every real trio started fitting at level 1 — the cascade was still correct and the
   * test still failed, which is a test measuring the content rather than the screen.
   * Level 2 exists for a hull wordier or busier than today's roster, so the way to
   * assert it is to hand the layout one. The real roster is covered by the containment
   * suite above, which walks every offer that `offerHulls` can produce.
   */
  const CROWDED_OFFER = ['crowded-a', 'crowded-b', 'crowded-c']

  interface CrowdedSpec {
    /** Words of mechanism. The one part of a card the cascade may never drop. */
    mech: number
    /** Words of flavour, or 0 for none. What level 1 gives up. */
    flavour: number
    /** Trade-table rows. */
    stats: number
    scrap: boolean
  }

  /** Every stat the fixture can move, in cost/gain order so both columns fill. */
  const CROWDED_STATS: HullDef['stats'] = [
    { stat: 'maxIntegrity', kind: 'add', value: -20 },
    { stat: 'maxShield', kind: 'add', value: 30 },
    { stat: 'hullSpeed', kind: 'add', value: -30 },
  ]

  /** Three identical synthetic hulls, all holding a real relic so level 2 has work. */
  function crowdedHulls(spec: CrowdedSpec): Readonly<Record<string, HullDef>> {
    const out: Record<string, HullDef> = {}
    for (const id of CROWDED_OFFER) {
      out[id] = {
        id,
        name: id,
        mechanism: `${Array.from({ length: spec.mech }, () => 'padding').join(' ')}.`,
        ...(spec.flavour > 0
          ? { flavour: `${Array.from({ length: spec.flavour }, () => 'flavour').join(' ')}.` }
          : {}),
        stats: CROWDED_STATS.slice(0, spec.stats),
        startingItems: ['repair-nanites'],
        ...(spec.scrap ? { startingScrap: 120 } : {}),
      }
    }
    return out
  }

  /**
   * The first synthetic offer that fits at exactly the degradation level asked for.
   *
   * SEARCHED, NOT HAND-TUNED, and that is the whole reason this fixture exists. These
   * tests used to name a real trio and broke twice for reasons that were not defects:
   * once when Surety's mechanism lost a clause, and again when hull prose stopped
   * stating figures and every real offer started fitting a level higher. Both times the
   * cascade was correct and the test was measuring the content. Searching a small grid
   * for a card of the required height asserts the *screen's* behaviour and cannot rot
   * that way; if a level becomes unreachable at any card size, that is a real finding
   * and this fails saying so.
   */
  function fittingAtLevel(target: 0 | 1 | 2): HullSelectLayout {
    for (const scrap of [false, true]) {
      for (const stats of [2, 3]) {
        for (let mech = 2; mech <= 60; mech++) {
          for (const flavour of [0, 4, 10, 20, 30]) {
            const result = layout({
              offer: CROWDED_OFFER,
              hulls: crowdedHulls({ mech, flavour, stats, scrap }),
            })
            if (!result.overflow && result.degrade === target) return result
          }
        }
      }
    }
    throw new Error(`no synthetic offer fits at degradation level ${target}`)
  }

  it('drops flavour before anything else when space runs out', () => {
    // Rule 4 makes flavour the only omittable part of a card, so it goes first — and
    // level 1 stops there: the relic's own sentence, which level 2 takes, is still on
    // the card.
    const flavoured = fittingAtLevel(1)
    for (const card of flavoured.cards) {
      expect(card.flavourLines, card.id).toEqual([])
      expect(card.startingLines.length, `${card.id} lost its relic text at level 1`)
        .toBeGreaterThan(1)
    }
  })

  it('never drops the mechanism, the trade table or the net line', () => {
    // The parts that make the card inform rather than sell, asserted at the tightest
    // level the cascade has.
    const tightest = fittingAtLevel(2)
    for (const card of tightest.cards) {
      expect(card.mechanismLines.length, card.id).toBeGreaterThan(0)
      expect(card.costRows.length, card.id).toBeGreaterThan(0)
      expect(card.gainRows.length, card.id).toBeGreaterThan(0)
      expect(card.netLines.length, card.id).toBeGreaterThan(0)
    }
  })

  it('keeps the starting relic named even at the tightest degradation', () => {
    // Level 2 gives up the relic's mechanism sentence and NEVER its name or tier —
    // "you are holding something and I will not say what" is the betrayal the brief
    // names, and it would be worse than the sentence being missing.
    const nanites = ITEMS['repair-nanites']
    const tightest = fittingAtLevel(2)
    for (const card of tightest.cards) {
      expect(card.startingLines.join(' '), card.id).toContain(nanites?.name ?? '')
      expect(card.startingLines.join(' '), card.id).toContain(`[${nanites?.tier}]`)
    }
    // And the sentence is there when there is room, so this is a cascade, not a cut.
    const roomy = fittingAtLevel(0)
    expect(roomy.cards[0]?.startingLines.length ?? 0).toBeGreaterThan(
      tightest.cards[0]?.startingLines.length ?? 0,
    )
  })

  it('never asks the real roster to give up its relic text', () => {
    // The side a player actually sees. Level 1 — flavour dropped — is a legitimate
    // outcome for a crowded offer; level 2 means a real card is withholding what a
    // starting relic does, and nothing in today's roster should be that tall. If this
    // fails, a hull's prose or its trade table has grown at the other cards' expense.
    for (const offer of everyOffer()) {
      const result = layout({ offer })
      expect(result.overflow, offer.join(',')).toBe(false)
      expect(result.degrade, `${offer.join(',')} degrades to ${result.degrade}`)
        .toBeLessThanOrEqual(1)
    }
  })

  it('keeps starting scrap at every degradation level', () => {
    for (const offer of [['arrears'], ['arrears', 'probate', 'collateral']]) {
      const card = layout({ offer }).cards.find((entry) => entry.id === 'arrears')
      expect(card?.startingLines.join(' '), offer.join(',')).toContain('320 cr')
    }
  })

  it('drops an unknown hull id from the offer rather than throwing', () => {
    // The same degradation `offerHulls` performs, asserted at the layout so a caller
    // that skips the draw cannot take the launch path down either.
    expect(() => layout({ offer: [LIEN_ID, 'writ', 'arrears'] })).not.toThrow()
    const result = layout({ offer: [LIEN_ID, 'writ', 'arrears'] })
    expect(result.cards.map((card) => card.id)).toEqual([LIEN_ID, 'arrears'])
  })

  it('says so rather than rendering an empty card when the offer is empty', () => {
    const result = layout({ offer: [] })
    expect(result.cards).toEqual([])
    expect(result.header.some((line) => line.text.includes('No hull can be issued'))).toBe(true)
  })

  it('produces no NaN for any plausible input', () => {
    const inputs: ReadonlyArray<Partial<HullSelectLayoutInput>> = [
      {},
      { selected: Number.NaN, tick: Number.NaN },
      { selected: -7 },
      { selected: 99 },
      { offer: [] },
      { offer: [LIEN_ID] },
      { poolCount: Number.NaN },
      { poolCount: -3 },
      { seed: '' },
    ]
    for (const overrides of inputs) {
      const result = layout(overrides)
      for (const value of numbersIn(result)) {
        expect(Number.isFinite(value), `NaN for ${JSON.stringify(overrides)}`).toBe(true)
      }
    }
  })

  it('never claims to offer more hulls than the pool holds', () => {
    expect(layout({ offer: [LIEN_ID, 'arrears'], poolCount: 1 }).footer.some((line) =>
      line.text.includes('2 of 2 certified hulls'),
    )).toBe(true)
  })
})

describe('rule 10 — nothing strobes', () => {
  it('pulses below the 1 Hz ceiling', () => {
    // 3–30 Hz can trigger photosensitive seizures. The rate is shared with
    // `src/render/intensity.ts`, so this asserts the constant this screen actually uses.
    expect(HULL_PULSE_RATE_HZ).toBeLessThanOrEqual(1)
    expect(HULL_PULSE_RATE_HZ).toBeGreaterThan(0)
  })

  it('never lets the selection wash reach zero opacity (rule 10)', () => {
    // A wash that hits zero is a blink rather than a breath.
    for (let tick = 0; tick < 600; tick++) {
      const { pulse } = layout({ tick })
      expect(pulse, `tick ${tick}`).toBeGreaterThanOrEqual(HULL_PULSE_MIN - 1e-9)
      expect(pulse, `tick ${tick}`).toBeLessThanOrEqual(HULL_PULSE_MAX + 1e-9)
    }
  })

  it('honours reduceFlashes by lowering the peak and holding the floor', () => {
    // Scaling the whole expression would have lifted the trough and made the element
    // brighter on average with the setting on — the opposite of what it asks for.
    let normalPeak = 0
    let reducedPeak = 0
    let reducedFloor = 1
    for (let tick = 0; tick < 600; tick++) {
      normalPeak = Math.max(normalPeak, layout({ tick }).pulse)
      const reduced = layout({ tick, reduceFlashes: true }).pulse
      reducedPeak = Math.max(reducedPeak, reduced)
      reducedFloor = Math.min(reducedFloor, reduced)
    }
    expect(reducedPeak).toBeLessThan(normalPeak)
    expect(reducedFloor).toBeCloseTo(HULL_PULSE_MIN, 5)
    const swing = HULL_PULSE_MAX - HULL_PULSE_MIN
    expect(reducedPeak - reducedFloor).toBeCloseTo(swing * REDUCED_FLASH_SCALE, 5)
  })

  it('marks the selection with a caret as well as a wash', () => {
    // Selection never rests on colour alone.
    const result = layout({ selected: 1 })
    expect(result.cards[1]?.selected).toBe(true)
    expect(result.cards[1]?.lines.some((line) => line.text === '>')).toBe(true)
    expect(result.cards[0]?.lines.some((line) => line.text === '>')).toBe(false)
  })
})

describe('rule 3 — colour is information', () => {
  it('uses no danger colour anywhere', () => {
    // `danger` means "can hurt you this instant". A drawback the player is choosing to
    // accept cannot. Same call the choice screen makes for CURSED.
    for (const line of allLines(layout({ offer: [LIEN_ID, 'surety', 'probate'] }))) {
      expect(line.color.toUpperCase(), line.text).not.toBe(Palette.danger.toUpperCase())
    }
    for (const card of layout().cards) {
      expect(card.accent.toUpperCase()).not.toBe(Palette.danger.toUpperCase())
    }
  })

  it('colours costs and gains with the tokens, never with hex literals', () => {
    // Read from the palette so a retune improves this screen automatically.
    const card = layout({ offer: ['surety'] }).cards[0]
    const costHeading = card?.lines.find((line) => line.text === HULL_COSTS_HEADING)
    const gainHeading = card?.lines.find((line) => line.text === HULL_GAINS_HEADING)
    expect(costHeading?.color).toBe(Palette.caution)
    expect(gainHeading?.color).toBe(Palette.good)
  })
})
