/**
 * Hull selection: the screen `docs/DESIGN.md` has always specified and the game
 * has never had.
 *
 * "Three are offered per run, drawn from what's been certified. `Lien` is always
 * available." Until this file existed, `src/main.ts` issued `runPool.hulls[0]`,
 * which is `'lien'` for every save that will ever exist — `BASE_POOL.hulls` is
 * `['lien']` and `poolFor` appends grants *after* the base. So every certification
 * that granted a hull was inert and four shipped hulls were unreachable. That is
 * the defect this screen closes.
 *
 * ## What this screen is for, and why it is mostly a table
 *
 * A hull is a commitment for a whole permadeath run and it cannot be changed in the
 * field. `docs/UI.md` rule 4 gets the mechanism sentence onto every card verbatim,
 * but three sentences of prose is not a comparison — a player cannot hold "+70 max
 * shield, hull speed 210 to 155" against "-28% max integrity, +20 max shield" in
 * their head and work out which ship survives longer. So each card also carries the
 * *resolved* numbers, folded through the real `src/sim/stats.ts` table and signed
 * with that table's own `lowerIsBetter` flag.
 *
 * That flag is the whole reason the signing is derived rather than typed. A *lower*
 * `fireIntervalTicks` is *better*; presented in the unit a player thinks in — shots
 * per second — it is a *higher* number. Both facts are true at once, and a card
 * that got either one backwards would tell the player the exact opposite of the
 * truth about the only hull that touches fire rate. `compareToBaseline` therefore
 * decides better/worse from the raw stat and its flag, and computes the printed
 * delta from the presented value, so the two can never disagree.
 *
 * ## The drawback is stated first, and as loudly
 *
 * Costs occupy the left column and are headed `GIVES UP`; gains sit to their right
 * under `GAINS`. Same size, same weight, cost side first. A screen that leads with
 * the upside is a screen that sells rather than informs, and the player finds out
 * what they actually took ninety seconds into a run they cannot restart.
 *
 * Starting scrap and starting items are on the card for the same reason, with the
 * relic's own mechanism sentence underneath: discovering an item you did not know
 * you were holding is a small betrayal, and knowing only its *name* is barely
 * better than not knowing.
 *
 * ## Colour, per rule 3
 *
 * `caution` for a cost and `good` for a gain, and neither carries alone: the column
 * heading is a word, and every delta is written with an explicit sign. `danger`
 * appears nowhere — a drawback the player is choosing to accept is information
 * about a trade, not incoming fire. Same call the choice screen makes for CURSED.
 *
 * ## The layout is pure and the drawing is dumb
 *
 * Copying `choiceScreen.ts` and `hangar.ts`: `layoutHullSelect` returns every rect
 * and every positioned, pre-measured line, and `drawHullSelectLayout` only fills
 * rects and draws strings. That is what lets `tests/hullSelect.test.ts` assert with
 * no canvas that no string leaves its card, that every hull states a drawback, and
 * that the fire-rate delta is signed the right way round.
 */

import { HULLS, HULL_ORDER, LIEN_ID } from '../content/hulls'
import { ITEMS } from '../content/items'
import type { HullDef, ItemDef, StatKey } from '../content/types'
import type { Rng } from '../core/rng'
import { VIRTUAL_H, VIRTUAL_W } from '../core/space'
import { PULSE_HZ, pulse as breathe } from '../render/intensity'
import { Palette } from '../render/palette'
import { canvasMeasure, drawText, wrapText, type Measure } from '../render/text'
import { STATS, STAT_KEYS, resolveStat, shotsPerSecond } from '../sim/stats'
// Geometry primitives and the headless measure are shared with the other two cards
// rather than re-declared, for the reason `hangar.ts` gives: two copies of
// `lineBounds` would mean the containment tests verify a different alignment
// convention than the renderer uses.
import { monoMeasure, type Rect, type TextLine } from './choiceScreen'

export type { Rect, TextLine } from './choiceScreen'
export { lineBounds, monoMeasure } from './choiceScreen'

// ---------------------------------------------------------------------------
// the offer
// ---------------------------------------------------------------------------

/**
 * The named Rng stream the offer draws from.
 *
 * A NEW stream, not a borrowed one. CLAUDE.md contract 1 and the stream table in
 * `docs/ARCHITECTURE.md` both say why in the same words: reusing an existing stream
 * for a second purpose shifts every downstream roll and invalidates every recorded
 * replay. Drawing the hull offer off `offers` would have re-rolled which items every
 * choice screen in the run shows, silently, for every seed anyone has ever shared.
 *
 * Add to the table in `docs/ARCHITECTURE.md` as: `hull-offer` — which hulls a sortie
 * offers.
 */
export const HULL_OFFER_STREAM = 'hull-offer'

/** `docs/DESIGN.md`: "Three are offered per run." */
export const MAX_HULL_OFFERS = 3

/**
 * Presentation rank, used both to canonicalise the candidate list before the draw and
 * to order the offer that comes out of it.
 *
 * A hull missing from `HULL_ORDER` sorts to the end rather than to the front, which is
 * what `indexOf`'s -1 would do. `tests/hulls.test.ts` asserts the order list is total,
 * so this is the behaviour on a day that assertion has just been broken — and a new
 * hull appearing last is a great deal better than one silently displacing the Lien
 * from the top of the card.
 */
function hullRank(id: string): number {
  const rank = HULL_ORDER.indexOf(id)
  return rank < 0 ? HULL_ORDER.length : rank
}

/**
 * Which hulls this sortie offers.
 *
 * Pure and separately exported so the draw is testable without a screen, and so the
 * app layer can ask "is there anything to choose?" before deciding to show one.
 *
 * Four properties, each of which has a test:
 *
 * - **Lien is always offered**, per `docs/DESIGN.md`, even if the pool handed in
 *   somehow omits it. It is the baseline every other card quotes; an offer without
 *   it has no "before".
 * - **An id no `HullDef` answers to is dropped, not thrown on.** The pool is data —
 *   `poolFor` copies whatever a certification grants — and three hulls the design
 *   names do not exist yet (`HULLS_AWAITING_MECHANICS`). The moment someone adds a
 *   grant for one, this screen must degrade to offering the hulls that *are* real
 *   rather than being the thing that crashes the launch path. `getHull` throws by
 *   design and is deliberately not used here.
 * - **Duplicates collapse.** Two certifications granting the same hull must not
 *   spend two of the three slots on it.
 * - **The candidate list is canonicalised through `HULL_ORDER` before the draw**, so
 *   the offer depends on the *set* of certifications filed rather than on the order
 *   the roster happens to list them in. Reordering `CERTIFICATIONS` would otherwise
 *   change what a given seed offers.
 *
 * Returns presentation order (`HULL_ORDER`), so Lien is always the first card and
 * therefore the default selection — the safest pick is the one a player who
 * confirms immediately gets.
 */
export function offerHulls(rng: Rng, pool: readonly string[]): readonly string[] {
  // `Object.hasOwn` against the real table is the load-bearing guard, NOT an
  // intersection with `HULL_ORDER`. The two are the same set today and
  // `tests/hulls.test.ts` keeps them that way, but relying on the order list to
  // decide what *exists* would make the launch path depend on a presentation
  // constant — and would silently start offering a hull the moment someone added an
  // id to that list ahead of writing the definition.
  const candidates = [...new Set(pool)].filter(
    (id) => id !== LIEN_ID && Object.hasOwn(HULLS, id),
  )
  candidates.sort((a, b) => hullRank(a) - hullRank(b))

  // One slot is spent before the draw, which is what "Lien is always available"
  // means. Seeded into `chosen` rather than added to the candidate list, deliberately:
  // among the candidates it would be *sampled*, and a run could offer three hulls
  // without the baseline the other two cards quote.
  const drawn = rng.sample(candidates, Math.max(0, MAX_HULL_OFFERS - 1))
  return [LIEN_ID, ...drawn].sort((a, b) => hullRank(a) - hullRank(b))
}

/**
 * Is this offer worth stopping the player for?
 *
 * **A card whose only action is "continue" is worse than no card.** This project has
 * shipped that twice — a shop with nothing affordable in it, and a work-order card
 * that recorded an assignment and changed nothing — and each time it taught the
 * player that reading a screen was optional. On a fresh save the pool is `['lien']`
 * and the "choice" would be a single option with no alternative to weigh it against.
 *
 * So the screen appears only once a certification has actually widened the pool,
 * which is also the moment it becomes the *reward* for that certification. Until
 * then the Lien is issued silently and the hangar already says why: "Pool: 4 of 9
 * entries available to the next sortie."
 *
 * It keeps `docs/UI.md` rule 6 intact too, and only just: death → confirm → hull
 * card → launch is exactly the two inputs the rule allows, and one input when there
 * is nothing to choose. Anything further in this path breaks it.
 */
export function shouldShowHullSelect(offer: readonly string[]): boolean {
  return offer.length > 1
}

/** Wrap the selection, matching the hangar — an invisible wall reads as a hang. */
export function moveHullSelection(index: number, delta: number, count: number): number {
  if (count <= 0 || !Number.isFinite(count)) return 0
  const size = Math.trunc(count)
  const whole = Number.isFinite(index) ? Math.trunc(index) : 0
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0
  return (((whole + step) % size) + size) % size
}

// ---------------------------------------------------------------------------
// the comparison
// ---------------------------------------------------------------------------

interface StatDisplay {
  /** Short enough to share a half-column with its numbers. */
  label: string
  /** Rule 2. Never empty. */
  unit: string
  /**
   * Raw stat value to the number a player thinks in.
   *
   * Only `fireIntervalTicks` really needs it, and it is the reason this hook exists:
   * ticks are a simulation implementation detail (`formatSeconds` in
   * `src/render/text.ts` makes the same argument for durations), and "3 → 2 ticks"
   * next to a green arrow is a card asking the player to reason about the engine.
   */
  present?: (value: number) => number
}

/**
 * How each stat is written on a card.
 *
 * Total over `StatKey` on purpose: adding a stat to `src/sim/stats.ts` without
 * deciding how it reads is a compile error here rather than a bare number on screen.
 */
const STAT_DISPLAY: Readonly<Record<StatKey, StatDisplay>> = {
  fireIntervalTicks: { label: 'Fire rate', unit: 'shots/s', present: shotsPerSecond },
  projectileDamage: { label: 'Shot damage', unit: 'dmg' },
  projectileSpeed: { label: 'Shot speed', unit: 'u/s' },
  projectilesPerShot: { label: 'Rounds per shot', unit: 'rounds' },
  hullSpeed: { label: 'Hull speed', unit: 'u/s' },
  maxIntegrity: { label: 'Max integrity', unit: 'hp' },
  maxShield: { label: 'Max shield', unit: 'hp' },
  scrapMultiplier: { label: 'Scrap yield', unit: '%', present: (v) => v * 100 },
  pickupRadius: { label: 'Pickup radius', unit: 'u' },
  focusFactor: { label: 'Focus speed', unit: '%', present: (v) => v * 100 },
}

/** At most one decimal, and no trailing `.0`. Tabular figures stay scannable. */
function numeral(value: number): string {
  if (!Number.isFinite(value)) return '—'
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** `+10`, `-30`. The sign is always shown — rule 2's second half. */
function signed(value: number): string {
  return value > 0 ? `+${numeral(value)}` : numeral(value)
}

export interface HullStatDelta {
  stat: StatKey
  label: string
  unit: string
  /** Presented baseline value — what a Lien has. */
  base: number
  /** Presented value on this hull. */
  value: number
  /** `value - base`, in presented units. */
  delta: number
  /**
   * Signed from the RAW stat and `STATS[stat].lowerIsBetter`, never from the sign of
   * `delta` — those disagree for `fireIntervalTicks` and agreeing with the wrong one
   * puts Collateral's faster gun in the drawback column.
   */
  direction: 'better' | 'worse'
  /** `Max integrity  100 → 70 hp` */
  text: string
  /** `(-30)` — the magnitude, signed, in the unit the line beside it already names. */
  deltaText: string
}

export interface HullComparison {
  /** Stats this hull makes worse. First on the card, always. */
  costs: readonly HullStatDelta[]
  gains: readonly HullStatDelta[]
  /** Integrity plus shield. The shield does not regenerate — see `applyHullDamage`. */
  effectiveHealth: number
  baseEffectiveHealth: number
  damagePerSecond: number
  baseDamagePerSecond: number
  /**
   * The two composite figures, as one sentence. Null for the Lien, which *is* the
   * baseline.
   *
   * Worth its line because the per-stat rows hide it: Probate trades 28 integrity for
   * 20 shield and lands at 132 against Lien's 140 — practically level, and nothing in
   * a two-row table says so.
   */
  net: string | null
}

/** Column separator inside a stat row. Two spaces read as a column in monospace. */
const GAP = '  '

function deltaFor(stat: StatKey, def: HullDef): HullStatDelta | null {
  const spec = STATS[stat]
  const display = STAT_DISPLAY[stat]
  const rawBase = spec.base
  const rawValue = resolveStat(stat, def.stats)
  if (rawValue === rawBase) return null

  const present = display.present ?? ((v: number) => v)
  const base = present(rawBase)
  const value = present(rawValue)
  const improved = spec.lowerIsBetter === true ? rawValue < rawBase : rawValue > rawBase

  return {
    stat,
    label: display.label,
    unit: display.unit,
    base,
    value,
    delta: value - base,
    direction: improved ? 'better' : 'worse',
    text: `${display.label}${GAP}${numeral(base)} → ${numeral(value)} ${display.unit}`,
    deltaText: `(${signed(value - base)})`,
  }
}

/**
 * A hull's resolved stats against the Lien baseline.
 *
 * Pure, and exported separately from the layout so the signing can be tested without
 * a screen. Reads the same `resolveStat` the simulation reads, so a card cannot
 * quote a number the run will not honour — the panel has shipped that bug twice.
 */
export function compareToBaseline(def: HullDef): HullComparison {
  const costs: HullStatDelta[] = []
  const gains: HullStatDelta[] = []
  for (const stat of STAT_KEYS) {
    const delta = deltaFor(stat, def)
    if (delta === null) continue
    if (delta.direction === 'worse') costs.push(delta)
    else gains.push(delta)
  }

  const baseEffectiveHealth = STATS.maxIntegrity.base + STATS.maxShield.base
  const baseDamagePerSecond =
    STATS.projectileDamage.base * shotsPerSecond(STATS.fireIntervalTicks.base)
  const effectiveHealth = resolveStat('maxIntegrity', def.stats) + resolveStat('maxShield', def.stats)
  const damagePerSecond =
    resolveStat('projectileDamage', def.stats) *
    shotsPerSecond(resolveStat('fireIntervalTicks', def.stats))

  const health =
    effectiveHealth === baseEffectiveHealth
      ? `${numeral(baseEffectiveHealth)} effective hp, unchanged`
      : `${numeral(baseEffectiveHealth)} → ${numeral(effectiveHealth)} effective hp (${signed(effectiveHealth - baseEffectiveHealth)})`
  const output =
    damagePerSecond === baseDamagePerSecond
      ? `${numeral(baseDamagePerSecond)} dmg/s output, unchanged`
      : `${numeral(baseDamagePerSecond)} → ${numeral(damagePerSecond)} dmg/s output (${signed(damagePerSecond - baseDamagePerSecond)})`

  return {
    costs,
    gains,
    effectiveHealth,
    baseEffectiveHealth,
    damagePerSecond,
    baseDamagePerSecond,
    net: costs.length === 0 && gains.length === 0 ? null : `${health}  ·  ${output}`,
  }
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/**
 * Nearly the full viewport, matching the other two cards.
 *
 * Width is bought for the same reason: three hulls need their mechanism sentence,
 * a two-column trade table and a starting loadout on screen *at once*, and the
 * comparison is the entire point of the screen. A detail pane for the selected hull
 * would fit more comfortably and would stop being a comparison.
 */
const CARD = { x: 16, y: 10, w: 608, h: 700 } as const
const CARD_BOTTOM = CARD.y + CARD.h
const PAD = 16
const CONTENT_X = CARD.x + PAD
const CONTENT_RIGHT = CARD.x + CARD.w - PAD

/** Content column width, exported so tests measure the real layout, never a guess. */
export const HULL_SELECT_CONTENT_W = CARD.w - PAD * 2

const OPT_PAD = 11
const OPT_GAP = 9
/** Blank column so the caret appears without shifting a word. Same as the other cards. */
const CARET_GUTTER = 15

/** Usable text width inside one hull card. */
export const HULL_SELECT_TEXT_W = HULL_SELECT_CONTENT_W - OPT_PAD * 2 - CARET_GUTTER

/** Gap between the GIVES UP and GAINS columns. */
const COL_GAP = 14
/** One column of the trade table. Every stat row must fit this, and a test says so. */
export const HULL_SELECT_COL_W = Math.floor((HULL_SELECT_TEXT_W - COL_GAP) / 2)

export const HULL_TITLE_SIZE = 15
const TITLE_H = 20
export const HULL_MECH_SIZE = 13
const MECH_LH = 17
export const HULL_ROW_SIZE = 12
const ROW_LH = 15
export const HULL_LABEL_SIZE = 11
const LABEL_LH = 14
export const HULL_SUB_SIZE = 12
const SUB_LH = 15

const RULE_GAP = 11
const FOOTER_H = 22

// ---------------------------------------------------------------------------
// authored copy
// ---------------------------------------------------------------------------

const BASE_EFFECTIVE_HEALTH = STATS.maxIntegrity.base + STATS.maxShield.base
const BASE_DPS = STATS.projectileDamage.base * shotsPerSecond(STATS.fireIntervalTicks.base)

/**
 * The screen's standfirst, with the baseline quoted **out of the stat table**.
 *
 * Derived rather than typed for the reason `describeCondition` is derived: a number a
 * human writes twice is a number that eventually disagrees with itself, and here the
 * disagreement would be the screen naming a baseline no hull actually has. Retune
 * `STATS` and this sentence follows.
 */
export const HULL_SELECT_STANDFIRST =
  `Every figure below is measured against the Lien: ${numeral(BASE_EFFECTIVE_HEALTH)} effective hp, ` +
  `${numeral(STATS.hullSpeed.base)} units/second, ${numeral(BASE_DPS)} damage/second.`

/**
 * The commitment, said before the choice rather than discovered after it.
 *
 * A hull cannot be swapped mid-sortie and the run is permadeath, so this is the one
 * fact about the screen a player cannot infer from the cards.
 */
export const HULL_SELECT_NOTICE =
  'The hull is issued for the whole sortie. It cannot be changed in the field.'

export const HULL_SELECT_EYEBROW = 'Salvage Division // Hull Issue'
export const HULL_SELECT_TITLE = 'HULL ISSUE'
export const HULL_SELECT_SEED_LABEL = 'SORTIE SEED'

/** Column headings. The word carries the direction; colour only reinforces it. */
export const HULL_COSTS_HEADING = 'GIVES UP'
export const HULL_GAINS_HEADING = 'GAINS'
export const HULL_STARTS_LABEL = 'STARTS WITH'
/** Labels the composite figures, so they do not read as one more stat row. */
export const HULL_NET_LABEL = 'NET'

/** The Lien's card, where the trade table would be. It has no modifiers by design. */
export const HULL_BASELINE_TEXT = 'No modifiers. Every other card is measured against this hull.'

/** Shown if the offer is empty, which would be a defect — Lien is always offered. */
export const HULL_SELECT_EMPTY_TEXT = 'No hull can be issued. The Lien should always be available.'

export const HULL_SELECT_CONTROLS_LEFT = '↑  ↓  select'
export const HULL_SELECT_CONTROLS_RIGHT = 'SPACE / Z  launch      ESC  return to title'

/**
 * Names the pick, so confirm is never a keypress into the dark, and says the card
 * will wait.
 *
 * THE SECOND SENTENCE IS THERE BECAUSE EVERY OTHER CARD IN THIS GAME RESOLVES ITSELF.
 * A reward card confirms after a dwell if the trigger is held and times out if it is
 * not — `WorldView.choiceResolve` exists to show that countdown. This screen is the
 * one card with no simulation behind it: it runs before `World` is constructed,
 * because the hull is a *constructor argument*, so there is no tick, no pending
 * choice, and nothing to count down. Saying so is cheaper than letting a player who
 * has learned the timeout sit watching for a counter that will never appear.
 */
export function launchHint(name: string): string {
  return `Launch flies the ${name}. Nothing is running yet.`
}

/** Starting scrap, with its unit. */
export function startingScrapText(scrap: number): string {
  return `${numeral(scrap)} cr of scrap in hand at launch`
}

/**
 * How much of the pool this offer covers — the only place the screen connects back to
 * the hangar, which is where the pool is widened.
 *
 * Clamped so it can never read "3 of 2": the pool is data and the offer is a subset of
 * it, but a caller passing a stale count must not produce a nonsense fraction.
 */
export function poolCountText(offered: number, poolCount: number): string {
  const total = Math.max(offered, Math.trunc(poolCount))
  return `${offered} of ${total} certified hulls`
}

/**
 * Every string this screen authors, so `tests/textFits.test.ts` can walk them.
 *
 * Keyed rather than listed for the reason the world map's table is: adding a string
 * to the screen without placing it in the fit test becomes a typecheck failure.
 */
export const HULL_SELECT_STRINGS = {
  eyebrow: HULL_SELECT_EYEBROW,
  title: HULL_SELECT_TITLE,
  seedLabel: HULL_SELECT_SEED_LABEL,
  standfirst: HULL_SELECT_STANDFIRST,
  notice: HULL_SELECT_NOTICE,
  costsHeading: HULL_COSTS_HEADING,
  gainsHeading: HULL_GAINS_HEADING,
  startsLabel: HULL_STARTS_LABEL,
  netLabel: HULL_NET_LABEL,
  baseline: HULL_BASELINE_TEXT,
  empty: HULL_SELECT_EMPTY_TEXT,
  controlsLeft: HULL_SELECT_CONTROLS_LEFT,
  controlsRight: HULL_SELECT_CONTROLS_RIGHT,
} as const

// ---------------------------------------------------------------------------
// pulse
// ---------------------------------------------------------------------------

/**
 * Selection pulse rate, taken from `src/render/intensity.ts` rather than restated.
 *
 * Rule 10 caps blinking at ~1 Hz because flashing in the 3–30 Hz band can trigger
 * photosensitive seizures. That module exists precisely because every screen used to
 * carry its own radians-per-tick literal with a comment claiming "~0.9 Hz", and a
 * comment is not a check. Sharing the constant means `tests/render.test.ts`, which
 * measures the emitted period, is measuring this screen's waveform too.
 */
export const HULL_PULSE_RATE_HZ = PULSE_HZ
export const HULL_PULSE_MIN = 0.07
export const HULL_PULSE_MAX = 0.21
/**
 * Depth that puts the wash in `[HULL_PULSE_MIN, HULL_PULSE_MAX]`.
 *
 * `pulse()` returns `[1 - depth, 1]`, so scaling by the maximum lands the trough on
 * the minimum. With `reduceFlashes` on, that module shrinks the amplitude and leaves
 * the floor alone — same minimum, lower peak — which is what the setting asks for.
 */
const PULSE_DEPTH = 1 - HULL_PULSE_MIN / HULL_PULSE_MAX

// ---------------------------------------------------------------------------
// layout model
// ---------------------------------------------------------------------------

export interface HullCardLayout {
  index: number
  id: string
  name: string
  selected: boolean
  box: Rect
  /** True only for the Lien. */
  baseline: boolean
  mechanismLines: readonly string[]
  costRows: readonly HullStatDelta[]
  gainRows: readonly HullStatDelta[]
  netLines: readonly string[]
  /** Starting scrap and starting items, exactly as drawn. Empty when there are none. */
  startingLines: readonly string[]
  flavourLines: readonly string[]
  lines: readonly TextLine[]
  accent: string
}

export interface HullSelectLayout {
  card: Rect
  accent: string
  scrim: string
  header: readonly TextLine[]
  cards: readonly HullCardLayout[]
  footer: readonly TextLine[]
  rules: readonly Rect[]
  selected: number
  /** Selection wash opacity this frame. Never reaches 0 — rule 10. */
  pulse: number
  /** 0 nothing dropped, 1 flavour dropped. Rule 4 allows flavour to go and nothing else. */
  degrade: number
  /** True if even the tightest pass overflows. A bug, and a test asserts against it. */
  overflow: boolean
}

export interface HullSelectLayoutInput {
  /** Hull ids, in presentation order. Normally straight from `offerHulls`. */
  offer: readonly string[]
  selected: number
  /** Ticks the screen has been open, for the selection pulse. */
  tick: number
  /** Rule 8: the seed is always visible, and this offer was drawn from it. */
  seed: string
  /** Hulls in the run pool, for the footer counter. */
  poolCount?: number
  /** `Settings.reduceFlashes`. Shrinks the selection wash's swing, never its floor. */
  reduceFlashes?: boolean
  hulls?: Readonly<Record<string, HullDef>>
  items?: Readonly<Record<string, ItemDef>>
  measure?: Measure
}

interface CardContent {
  def: HullDef
  baseline: boolean
  comparison: HullComparison
  mechanism: readonly string[]
  net: readonly string[]
  /**
   * Starting loadout rows.
   *
   * `detail` marks the relic's own mechanism sentence — the only part of the block
   * the degradation cascade is allowed to drop, because the item's *name and tier*
   * are what rule 4 and the brief actually require on the card.
   */
  starting: readonly { text: string; size: number; detail: boolean }[]
  flavour: readonly string[]
  height: number
}

function cardHeight(content: CardContent, degrade: number): number {
  const { comparison } = content
  let h = OPT_PAD + TITLE_H + content.mechanism.length * MECH_LH
  h += 5
  if (content.baseline || (comparison.costs.length === 0 && comparison.gains.length === 0)) {
    h += ROW_LH
  } else {
    h += LABEL_LH + Math.max(comparison.costs.length, comparison.gains.length) * ROW_LH
  }
  if (content.net.length > 0) h += 4 + content.net.length * ROW_LH
  const starting = startingRows(content, degrade)
  if (starting.length > 0) {
    h += 5
    for (const row of starting) h += row.size === HULL_ROW_SIZE ? ROW_LH : LABEL_LH
  }
  if (degrade === 0 && content.flavour.length > 0) h += 4 + content.flavour.length * SUB_LH
  return h + OPT_PAD
}

/** The starting-loadout rows shown at this degradation level. */
function startingRows(
  content: CardContent,
  degrade: number,
): readonly { text: string; size: number; detail: boolean }[] {
  return degrade >= 2 ? content.starting.filter((row) => !row.detail) : content.starting
}

function buildContent(input: HullSelectLayoutInput, measure: Measure): readonly CardContent[] {
  const hulls = input.hulls ?? HULLS
  const items = input.items ?? ITEMS
  const out: CardContent[] = []

  for (const id of input.offer) {
    // Dropped rather than thrown on, matching `offerHulls`: the pool is data and a
    // grant for a hull that does not exist must not take the launch path down.
    if (!Object.hasOwn(hulls, id)) continue
    const def = hulls[id]
    if (!def) continue

    const comparison = compareToBaseline(def)
    const starting: { text: string; size: number; detail: boolean }[] = []
    if (def.startingScrap !== undefined && def.startingScrap > 0) {
      starting.push({
        text: startingScrapText(def.startingScrap),
        size: HULL_ROW_SIZE,
        detail: false,
      })
    }
    for (const itemId of def.startingItems ?? []) {
      const item = items[itemId]
      // An unknown id still gets a row: a hull silently starting with nothing is the
      // failure the player cannot see, so it has to be visible on the card.
      starting.push({
        text: item ? `${item.name} [${item.tier}]` : `${itemId} — no specification on file`,
        size: HULL_ROW_SIZE,
        detail: false,
      })
      if (item) {
        // What the relic actually does. Knowing only its name is barely better than
        // not knowing, so this is on the card by default — and it is the first thing
        // after flavour that a crowded screen gives up.
        for (const line of wrapText(item.mechanism, HULL_SELECT_TEXT_W, HULL_LABEL_SIZE, measure)) {
          starting.push({ text: line, size: HULL_LABEL_SIZE, detail: true })
        }
      }
    }

    const content: CardContent = {
      def,
      baseline: def.id === LIEN_ID,
      comparison,
      mechanism: wrapText(def.mechanism, HULL_SELECT_TEXT_W, HULL_MECH_SIZE, measure),
      // Wrapped against the width the LABEL leaves, not the full column: the first
      // line is drawn offset by it, and wrapping to the full width would put that line
      // through the card's right edge.
      net:
        comparison.net === null
          ? []
          : wrapText(
              comparison.net,
              HULL_SELECT_TEXT_W - (measure(HULL_NET_LABEL, HULL_LABEL_SIZE, 600, 1.4) + 10),
              HULL_ROW_SIZE,
              measure,
            ),
      starting,
      flavour: def.flavour ? wrapText(def.flavour, HULL_SELECT_TEXT_W, HULL_SUB_SIZE, measure) : [],
      height: 0,
    }
    content.height = cardHeight(content, 0)
    out.push(content)
  }
  return out
}

export function layoutHullSelect(input: HullSelectLayoutInput): HullSelectLayout {
  const measure = input.measure ?? monoMeasure

  const header: TextLine[] = []
  const footer: TextLine[] = []
  const rules: Rect[] = []

  const line = (
    text: string,
    x: number,
    y: number,
    size: number,
    color: string,
    options: {
      weight?: 400 | 600 | 700
      align?: 'left' | 'right' | 'center'
      tracking?: number
    } = {},
  ): TextLine => {
    const weight = options.weight ?? 400
    const tracking = options.tracking ?? 0
    return {
      text,
      x,
      y,
      size,
      weight,
      color,
      align: options.align ?? 'left',
      tracking,
      width: measure(text, size, weight, tracking),
    }
  }

  const contents = buildContent(input, measure)
  const selected = contents.length === 0 ? 0 : moveHullSelection(input.selected, 0, contents.length)

  // --- header ---------------------------------------------------------------
  let y = CARD.y + PAD
  header.push(
    line(HULL_SELECT_EYEBROW, CONTENT_X, y, HULL_LABEL_SIZE, Palette.textDim, { tracking: 1.6 }),
  )
  header.push(
    line(HULL_SELECT_SEED_LABEL, CONTENT_RIGHT, y, HULL_LABEL_SIZE, Palette.textDim, {
      align: 'right',
      tracking: 1.6,
    }),
  )
  y += 16
  header.push(line(HULL_SELECT_TITLE, CONTENT_X, y, 22, Palette.text, { weight: 700, tracking: 2.4 }))
  // Rule 8. The offer is drawn from this seed, so a screenshot of this card is a
  // reproducible record of what was offered as well as of what was flown.
  header.push(
    line(input.seed, CONTENT_RIGHT, y + 3, 14, Palette.text, { weight: 600, align: 'right' }),
  )
  y += 26
  for (const text of wrapText(HULL_SELECT_STANDFIRST, HULL_SELECT_CONTENT_W, HULL_SUB_SIZE, measure)) {
    header.push(line(text, CONTENT_X, y, HULL_SUB_SIZE, Palette.textDim))
    y += SUB_LH
  }
  for (const text of wrapText(HULL_SELECT_NOTICE, HULL_SELECT_CONTENT_W, HULL_LABEL_SIZE, measure)) {
    // `caution`: committing to a hull for a whole permadeath run is a risk the player
    // is taking, which is exactly what that token means. Never `danger` — nothing on
    // this screen can hurt anyone this instant.
    header.push(line(text, CONTENT_X, y, HULL_LABEL_SIZE, Palette.caution))
    y += LABEL_LH
  }

  y += RULE_GAP - 4
  rules.push({ x: CONTENT_X, y, w: HULL_SELECT_CONTENT_W, h: 1 })
  const cardsTop = y + RULE_GAP

  const footerTop = CARD_BOTTOM - PAD - FOOTER_H
  rules.push({ x: CONTENT_X, y: footerTop - RULE_GAP, w: HULL_SELECT_CONTENT_W, h: 1 })
  const available = footerTop - RULE_GAP * 2 - cardsTop

  // --- degradation ----------------------------------------------------------
  //
  // Flavour goes first, because rule 4 is the only rule that declares anything on a
  // card omittable and it names flavour. After that, only the starting relic's
  // *mechanism* sentence — never its name or tier, which is the disclosure the card
  // owes the player. The mechanism sentence, the trade table and the net line never
  // go: dropping any of them would make the card sell rather than inform.
  //
  // Level 2 is unreachable from `offerHulls` today, because the Lien is always one of
  // the three and it is the shortest card in the roster. It exists so that a fourth
  // modifier on some future hull degrades this screen instead of clipping it.
  const total = (heights: readonly number[]): number =>
    heights.reduce((sum, h) => sum + h, 0) + Math.max(0, heights.length - 1) * OPT_GAP
  let degrade = 0
  let heights = contents.map((content) => cardHeight(content, degrade))
  while (degrade < 2 && total(heights) > available) {
    degrade++
    heights = contents.map((content) => cardHeight(content, degrade))
  }
  const overflow = total(heights) > available

  // Spare room is spread between the cards and then above the stack, so two offers do
  // not sit as two bars under the header with 200 units of dead space beneath them.
  const slack = Math.max(0, available - total(heights))
  const gapCount = Math.max(1, contents.length - 1)
  const extraGap = Math.min(26, Math.floor(slack / gapCount))
  const stackGap = OPT_GAP + extraGap
  const leadIn = Math.floor(Math.max(0, slack - extraGap * gapCount) / 2)

  // --- cards ----------------------------------------------------------------
  const cards: HullCardLayout[] = []
  let cardY = cardsTop + leadIn
  contents.forEach((content, index) => {
    const height = heights[index] ?? 0
    const box: Rect = { x: CONTENT_X, y: cardY, w: HULL_SELECT_CONTENT_W, h: height }
    const isSelected = index === selected
    const textX = box.x + OPT_PAD + CARET_GUTTER
    const rightColX = textX + HULL_SELECT_TEXT_W - HULL_SELECT_COL_W
    const lines: TextLine[] = []

    const accent = isSelected ? Palette.self : Palette.line
    const nameColor = isSelected ? Palette.self : Palette.text

    let cursor = box.y + OPT_PAD
    if (isSelected) {
      // A caret as well as the wash: selection never rests on colour alone.
      lines.push(line('>', box.x + OPT_PAD, cursor, HULL_TITLE_SIZE, nameColor, { weight: 700 }))
    }

    // Line 1 is the name, per rule 4's fixed format. The Lien says outright that it is
    // the reference, because a card with an empty trade table would otherwise read as
    // one that failed to load.
    const name = line(content.def.name, textX, cursor, HULL_TITLE_SIZE, nameColor, { weight: 700 })
    lines.push(name)
    if (content.baseline) {
      lines.push(
        line('[baseline]', textX + name.width + 9, cursor + 3, HULL_SUB_SIZE, Palette.textDim),
      )
    }
    cursor += TITLE_H

    // Mechanism, verbatim from the def, in the largest body size on the card. Rule 4.
    for (const text of content.mechanism) {
      lines.push(line(text, textX, cursor, HULL_MECH_SIZE, Palette.text))
      cursor += MECH_LH
    }

    cursor += 5
    const { costs, gains } = content.comparison
    if (costs.length === 0 && gains.length === 0) {
      lines.push(line(HULL_BASELINE_TEXT, textX, cursor, HULL_ROW_SIZE, Palette.textDim))
      cursor += ROW_LH
    } else {
      // Costs LEFT and first. Same size and weight as the gains heading beside it —
      // the drawback is not a footnote to the upside.
      if (costs.length > 0) {
        lines.push(
          line(HULL_COSTS_HEADING, textX, cursor, HULL_LABEL_SIZE, Palette.caution, {
            weight: 600,
            tracking: 1.4,
          }),
        )
      }
      if (gains.length > 0) {
        lines.push(
          line(HULL_GAINS_HEADING, rightColX, cursor, HULL_LABEL_SIZE, Palette.good, {
            weight: 600,
            tracking: 1.4,
          }),
        )
      }
      cursor += LABEL_LH

      const rowsDeep = Math.max(costs.length, gains.length)
      for (let i = 0; i < rowsDeep; i++) {
        const cost = costs[i]
        if (cost) {
          const body = line(cost.text, textX, cursor + i * ROW_LH, HULL_ROW_SIZE, Palette.text)
          lines.push(body)
          lines.push(
            line(
              ` ${cost.deltaText}`,
              textX + body.width,
              cursor + i * ROW_LH,
              HULL_LABEL_SIZE,
              Palette.caution,
              { weight: 600 },
            ),
          )
        }
        const gain = gains[i]
        if (gain) {
          const body = line(gain.text, rightColX, cursor + i * ROW_LH, HULL_ROW_SIZE, Palette.text)
          lines.push(body)
          lines.push(
            line(
              ` ${gain.deltaText}`,
              rightColX + body.width,
              cursor + i * ROW_LH,
              HULL_LABEL_SIZE,
              Palette.good,
              { weight: 600 },
            ),
          )
        }
      }
      cursor += rowsDeep * ROW_LH
    }

    if (content.net.length > 0) {
      cursor += 4
      // Labelled, because without it this line sits directly under the table and reads
      // as one more stat row rather than as the two composite figures the rows above
      // do not add up to on their own.
      const netLabel = line(HULL_NET_LABEL, textX, cursor + 1, HULL_LABEL_SIZE, Palette.textFaint, {
        weight: 600,
        tracking: 1.4,
      })
      lines.push(netLabel)
      let netY = cursor
      for (const [i, text] of content.net.entries()) {
        lines.push(
          line(
            text,
            i === 0 ? textX + netLabel.width + 10 : textX,
            netY,
            HULL_ROW_SIZE,
            Palette.textDim,
          ),
        )
        netY += ROW_LH
      }
      cursor = netY
    }

    const startingShown = startingRows(content, degrade)
    if (startingShown.length > 0) {
      cursor += 5
      let first = true
      for (const row of startingShown) {
        if (first) {
          const label = line(HULL_STARTS_LABEL, textX, cursor + 1, HULL_LABEL_SIZE, Palette.relic, {
            weight: 600,
            tracking: 1.4,
          })
          lines.push(label)
          lines.push(line(row.text, textX + label.width + 10, cursor, row.size, Palette.text))
          first = false
        } else {
          lines.push(
            line(
              row.text,
              textX,
              cursor,
              row.size,
              row.size === HULL_ROW_SIZE ? Palette.text : Palette.textDim,
            ),
          )
        }
        cursor += row.size === HULL_ROW_SIZE ? ROW_LH : LABEL_LH
      }
    }

    const flavourLines = degrade === 0 ? content.flavour : []
    if (flavourLines.length > 0) {
      cursor += 4
      for (const text of flavourLines) {
        // `textFaint` is reserved for genuinely non-essential text, and flavour is the
        // definition of it — rule 4 says it is always omittable.
        lines.push(line(text, textX, cursor, HULL_SUB_SIZE, Palette.textFaint))
        cursor += SUB_LH
      }
    }

    cards.push({
      index,
      id: content.def.id,
      name: content.def.name,
      selected: isSelected,
      box,
      baseline: content.baseline,
      mechanismLines: content.mechanism,
      costRows: costs,
      gainRows: gains,
      netLines: content.net,
      startingLines: startingShown.map((row) => row.text),
      flavourLines,
      lines,
      accent,
    })
    cardY += height + stackGap
  })

  if (cards.length === 0) {
    header.push(line(HULL_SELECT_EMPTY_TEXT, CONTENT_X, cardsTop, HULL_SUB_SIZE, Palette.caution))
  }

  // --- footer ---------------------------------------------------------------
  footer.push(
    line(HULL_SELECT_CONTROLS_LEFT, CONTENT_X, footerTop + 2, HULL_SUB_SIZE, Palette.textDim, {
      tracking: 0.6,
    }),
  )
  footer.push(
    line(HULL_SELECT_CONTROLS_RIGHT, CONTENT_RIGHT, footerTop + 2, HULL_SUB_SIZE, Palette.textDim, {
      align: 'right',
      tracking: 0.6,
    }),
  )
  const picked = cards[selected]
  footer.push(
    line(
      picked ? launchHint(picked.name) : HULL_SELECT_EMPTY_TEXT,
      CONTENT_X,
      footerTop + 2 + SUB_LH,
      HULL_LABEL_SIZE,
      Palette.textFaint,
    ),
  )
  if (input.poolCount !== undefined && Number.isFinite(input.poolCount)) {
    footer.push(
      // Stated even when the offer is the whole pool, so the number does not appear
      // and disappear as certifications land — a counter that comes and goes reads as
      // a glitch. It is also the only place the screen connects to the hangar.
      line(
        poolCountText(cards.length, input.poolCount),
        CONTENT_RIGHT,
        footerTop + 2 + SUB_LH,
        HULL_LABEL_SIZE,
        Palette.textFaint,
        { align: 'right' },
      ),
    )
  }

  const tick = Number.isFinite(input.tick) ? input.tick : 0
  // 0.85 Hz, opacity 0.07..0.21, attenuated when the player has asked for fewer
  // flashes. Rule 10 is a hard constraint, not a preference.
  const pulse = HULL_PULSE_MAX * breathe(tick, PULSE_DEPTH, input.reduceFlashes === true)

  return {
    card: { ...CARD },
    // `self` — this is the player's own ship being issued, and nothing here is at risk
    // yet. The commitment notice carries `caution` on its own.
    accent: Palette.self,
    scrim: 'rgba(5, 7, 11, 0.965)',
    header,
    cards,
    footer,
    rules,
    selected,
    pulse,
    degrade,
    overflow,
  }
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

function paintLines(ctx: CanvasRenderingContext2D, lines: readonly TextLine[]): void {
  for (const item of lines) {
    if (item.text.length === 0) continue
    drawText(ctx, item.text, item.x, item.y, {
      size: item.size,
      weight: item.weight,
      color: item.color,
      align: item.align,
      baseline: 'top',
      tracking: item.tracking,
    })
  }
}

export function drawHullSelectLayout(
  ctx: CanvasRenderingContext2D,
  layout: HullSelectLayout,
): void {
  ctx.fillStyle = layout.scrim
  ctx.fillRect(0, 0, VIRTUAL_W, VIRTUAL_H)

  const card = layout.card
  ctx.fillStyle = Palette.panel
  ctx.fillRect(card.x, card.y, card.w, card.h)
  ctx.strokeStyle = Palette.line
  ctx.lineWidth = 1
  ctx.strokeRect(card.x + 0.5, card.y + 0.5, card.w - 1, card.h - 1)
  ctx.fillStyle = layout.accent
  ctx.fillRect(card.x, card.y, card.w, 2)

  ctx.fillStyle = Palette.line
  for (const rule of layout.rules) ctx.fillRect(rule.x, rule.y, rule.w, rule.h)

  paintLines(ctx, layout.header)

  for (const entry of layout.cards) {
    const { box } = entry
    ctx.fillStyle = entry.selected ? Palette.panelRaised : Palette.panel
    ctx.fillRect(box.x, box.y, box.w, box.h)

    if (entry.selected) {
      // Alpha via globalAlpha rather than an rgba string, so no colour is hardcoded.
      ctx.globalAlpha = Math.max(0.05, layout.pulse)
      ctx.fillStyle = entry.accent
      ctx.fillRect(box.x, box.y, box.w, box.h)
      ctx.globalAlpha = 1
      // A solid left stripe too, so the selected card is obvious in a monochrome
      // screenshot — selection is never colour alone.
      ctx.fillStyle = entry.accent
      ctx.fillRect(box.x, box.y, 3, box.h)
    }

    ctx.strokeStyle = entry.accent
    ctx.lineWidth = 1
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)

    paintLines(ctx, entry.lines)
  }

  paintLines(ctx, layout.footer)
}

export interface HullSelectScreenOptions {
  offer: readonly string[]
  selected: number
  tick: number
  seed: string
  poolCount?: number
  reduceFlashes?: boolean
}

/**
 * Draw the hull issue card.
 *
 * Measures against the real font rather than the monospace estimate, so wrapping on
 * screen is exact instead of conservative — the estimate exists for the tests.
 */
export function drawHullSelect(
  ctx: CanvasRenderingContext2D,
  opts: HullSelectScreenOptions,
): void {
  drawHullSelectLayout(
    ctx,
    layoutHullSelect({
      offer: opts.offer,
      selected: opts.selected,
      tick: opts.tick,
      seed: opts.seed,
      ...(opts.poolCount === undefined ? {} : { poolCount: opts.poolCount }),
      ...(opts.reduceFlashes === undefined ? {} : { reduceFlashes: opts.reduceFlashes }),
      measure: canvasMeasure(ctx),
    }),
  )
}
