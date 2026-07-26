import { WORK_ORDERS } from '../content/workOrders'

export { WORK_ORDERS }
/**
 * The choice screen: item reward, field shop, and work order in one screen.
 *
 * This is where `docs/UI.md` rules 4 and 5 are either honoured or not, so the
 * whole module is arranged around them:
 *
 * - **Rule 4, mechanism first.** Every option renders name + tier, then — for any
 *   offer whose def carries stat modifiers — the **resolved before → after for this
 *   run**, then `ItemDef.mechanism` *verbatim* in the largest body size on the card,
 *   then flavour in the faintest colour the palette has. Flavour is the first thing
 *   dropped when the content does not fit (see the degradation cascade in
 *   `layoutChoiceScreen`), because it is the only part of an option that rule 4
 *   allows to be missing.
 *
 *   **WHY THE RESOLVED NUMBERS COME FIRST, ABOVE THE AUTHORED SENTENCE.** The
 *   sentence in `items.ts` is written before any run exists, so it can only quote the
 *   *item*: "+22 max shield" is +22 on a stock hull, +0 on one holding Exposed Core
 *   (which sets `maxShield` to `mul 0`), and "+45% damage" is +1.8 or +14 depending
 *   entirely on what is already fitted. The rows say what the pick does to the ship
 *   the player is actually flying, so they are the priority-1 information on the card
 *   and they are read first; the sentence underneath keeps the *why*, and keeps the
 *   behaviour that no number can describe. `src/ui/statDelta.ts` explains why the
 *   after value has to be re-resolved from the whole modifier list rather than nudged
 *   from the resolved one — the naive version is wrong for every `mul` item.
 * - **Rule 5, synergies are stated.** `ItemOffer.interactionText` is resolved by
 *   the simulation, so this screen never asks whether two items combine — it can
 *   only fail to *show* an answer it was given. Any offer with a non-empty
 *   `interactionText` gets its own inset well, a text marker (`[+] COMBINES WITH
 *   YOUR BUILD`), and the interaction sentence at full body weight.
 *
 * Two structural decisions worth knowing before editing:
 *
 * **The layout is pure and the drawing is dumb.** `layoutChoiceScreen` returns
 * every rectangle and every positioned, pre-measured line of text;
 * `drawChoiceScreen` only fills rects and draws strings. That is what lets
 * `tests/choiceScreen.test.ts` assert — with no canvas — that no text escapes its
 * card and that no option can render with only a name. Nobody has looked at this
 * screen rendered yet, so the layout being checkable matters more than usual.
 *
 * **The selection index is not ours.** `World` owns the cursor so a replay makes
 * the same picks (see `ChoiceCursor` in `src/sim/progression.ts`). This screen is
 * handed an index and renders it; `clampSelection` exists only so a nonsense index
 * cannot produce a card with nothing highlighted, and it wraps the same way
 * `updateCursor` does so the highlight always agrees with what the sim will take.
 *
 * The whole card sits over the playfield, which rule 1 would normally forbid. It
 * is allowed here for the same reason the pause menu is allowed: while
 * `pendingChoice` is non-null the simulation is paused, nothing moves, and there
 * are no bullets underneath for the card to hide.
 */

import type {
  InteractionDef,
  ItemDef,
  ItemTier,
  StatModifier,
  WorkOrderDef,
} from '../content/types'
import { VIRTUAL_H, VIRTUAL_W } from '../core/space'
import { Palette } from '../render/palette'
import { drawText, measureText, wrapText, type Measure } from '../render/text'

export { wrapText }
export type { Measure } from '../render/text'
import type {
  ActiveInteraction,
  HeldItem,
  ItemOffer,
  PendingChoiceKind,
  ResolvedStats,
  WorldView,
} from '../sim/entities'
import { collectBuildModifiers, statDeltaRows, type StatDeltaRow } from './statDelta'
// A module cycle: `worldMap` imports this file's hoisted helpers back. Only the
// function declaration is used, and only inside a function body, so neither module
// reads the other during initialisation. Do not import a `const` across this edge.
import { drawWorldMap } from './worldMap'

// ---------------------------------------------------------------------------
// content the sim does not carry yet
// ---------------------------------------------------------------------------

/**
 * Work-order copy, keyed by `WorkOrderKind`.
 *
 * TEMPORARY HOME. `WorkOrderDef` lives in `src/content/types.ts` but no table of
 * them exists yet — `World` puts the bare kind strings into
 * `PendingChoice.workOrders`. This table belongs in `src/content/workOrders.ts`
 * alongside the other content and should move there in the change that gives work
 * orders an actual effect.
 *
 * Deliberately NO invented numbers, which is a knowing partial exception to rule
 * 4: `World.updateChoice` records the assignment and changes nothing about the
 * sector until M5 routes it. A mechanism line promising "+40% salvage" while the
 * simulation does nothing at all would be the same class of lie as a HUD
 * advertising a fire rate the weapon does not have. The descriptions state the
 * trade-off in words, and `WORK_ORDER_NOTICE` says outright that the assignment is
 * only recorded. Both get real numbers in the same change that makes them real.
 */

/** Removed by the change that makes a work order alter the sector. See above. */
const WORK_ORDER_NOTICE = 'Assignment is recorded only; corridor routing arrives with sector two.'

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/**
 * The card is nearly the whole viewport, and that is deliberate.
 *
 * `docs/UI.md` lists item choice under *Screens*, not as an overlay: three options
 * with full mechanical text, the synergy sentences, and the build all have to be
 * on screen at once. The interaction sentences in `content/interactions.ts` run to
 * 200-odd characters, and at a narrower width they wrap to five or six lines each
 * and stop fitting at all. Width buys legibility here, so the card takes it.
 */
const CARD = { x: 16, y: 10, w: 608, h: 700 } as const
const CARD_BOTTOM = CARD.y + CARD.h
const PAD = 16
const CONTENT_X = CARD.x + PAD
const CONTENT_W = CARD.w - PAD * 2
const CONTENT_RIGHT = CONTENT_X + CONTENT_W

/** Gap either side of a hairline rule. */
const RULE_GAP = 11
const OPT_GAP = 9
const OPT_PAD = 11
/**
 * Blank column inside every option box, selected or not, so the caret can appear
 * without shifting a single word. Text that moves when you press left is text you
 * have to re-read.
 */
const CARET_GUTTER = 15

/**
 * Usable text width inside one option box.
 *
 * Exported so tests can assert authored copy fits without restating the arithmetic.
 * A test that hardcodes a width silently stops testing the real layout the moment
 * the card is resized — which is exactly how the pause menu's overflowing hint
 * survived.
 */
export const OPTION_TEXT_W = CONTENT_W - OPT_PAD * 2 - CARET_GUTTER
export const CHOICE_CONTENT_W = CONTENT_W

const TITLE_SIZE = 15
const TITLE_H = 20
const MECH_SIZE = 13
const MECH_LH = 17
const SUB_SIZE = 12
const SUB_LH = 15
const LABEL_SIZE = 11

/**
 * The resolved stat block: one row per stat the offer moves, at `SUB_SIZE`/`SUB_LH`,
 * introduced by a run-in label at `LABEL_SIZE`. Both clear rule 7's 11px floor.
 */
const STAT_GAP = 4
/**
 * Names whose numbers these are.
 *
 * Without it the card shows two different figures for the same stat — the item's
 * authored "4 to 5.8" and this run's "5 → 7.3" — and nothing says which is which.
 * Two words is the cheapest possible answer to that.
 */
export const STAT_ROW_LABEL = 'YOUR SHIP'
/** Separator when two rows share one line at the tightest degradation level. */
export const STAT_ROW_SEP = '  ·  '

const SYN_GAP = 7
const SYN_PAD = 6
const COST_GAP = 6
const COST_H = 18

/** Controls line at the bottom of the card. Two short lines. */
const FOOTER_H = 22

/**
 * The build strip is sized to its content and anchored above the footer.
 *
 * Bounded rather than fixed: at most two lines of held items and two of live
 * combinations, so the strip cannot grow without limit into the option area, and a
 * one-item build hands its slack to the options rather than holding open air.
 */
const BUILD_PAD_TOP = 7
const BUILD_PAD_BOTTOM = 6
const BUILD_CHIP_LINES = 2
const BUILD_SYN_LINES = 2

/**
 * Separator between held-item chips.
 *
 * Exported so the packing test can split a line back into names with the real
 * separator instead of a copy of it — the count it checks is derived from that split.
 */
export const CHIP_SEP = '   ·   '

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Text measurement, injected.
 *
 * The renderer passes a canvas-backed measure so wrapping is exact for the font
 * actually in use; tests pass `monoMeasure`. Same code path either way, which is
 * the point — a wrap helper verified against a different measure than it ships
 * with is not verified.
 */

/**
 * Advance width per character as a fraction of the font size.
 *
 * The type stack is monospace throughout (see `Font.stack`), so one number
 * describes it. 0.62 is a shade wider than the ~0.6 of SF Mono/Menlo, so a
 * headless layout is marginally more conservative than the real one rather than
 * optimistic — the failure mode of an optimistic estimate is text over a card
 * edge, which is a P0.
 */
export const MONO_ADVANCE = 0.62

export function monoMeasure(
  text: string,
  size: number,
  _weight?: 400 | 600 | 700,
  tracking = 0,
): number {
  const width = text.length * size * MONO_ADVANCE
  return text.length > 1 ? width + tracking * (text.length - 1) : width
}

/**
 * Greedy word wrap.
 *
 * A word longer than the line is hard-split rather than allowed to hang past the
 * edge: item ids and long numbers appear in mechanism text, and one unbreakable
 * token must not be able to push text outside the card.
 */

/** Shorten to fit, ending in an ellipsis so the reader knows text was dropped. */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  size: number,
  measure: Measure,
  weight: 400 | 600 | 700 = 400,
): string {
  if (!Number.isFinite(maxWidth) || maxWidth <= 0) return ''
  if (measure(text, size, weight) <= maxWidth) return text
  let cut = text.length
  while (cut > 0 && measure(`${text.slice(0, cut).trimEnd()}…`, size, weight) > maxWidth) cut--
  return cut > 0 ? `${text.slice(0, cut).trimEnd()}…` : '…'
}

/**
 * Bring any index into range.
 *
 * Wraps rather than clamps, matching `updateCursor` in the simulation — the
 * highlight has to land on the option the sim will actually take. Anything
 * non-finite becomes 0: a card with no visible selection is worse than a card
 * whose selection is in the wrong place, because the player cannot tell what
 * confirm will do.
 */
export function clampSelection(index: number, count: number): number {
  if (count <= 0 || !Number.isFinite(count)) return 0
  if (!Number.isFinite(index)) return 0
  const whole = Math.trunc(index)
  const size = Math.trunc(count)
  return ((whole % size) + size) % size
}

/**
 * Can this option be taken with the scrap on hand?
 *
 * `cost === scrap` is affordable — spending your last credit is allowed, and the
 * simulation's own guard is `cost > scrap`. The two must agree exactly or the
 * screen greys out a purchase the sim would have accepted.
 */
export function isAffordable(cost: number, scrap: number): boolean {
  if (!Number.isFinite(cost)) return false
  return cost <= scrap
}

/** `coin-op-cannon` becomes `Coin Op Cannon`. Only used when an id is unknown. */
function prettifyId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Tier colours.
 *
 * The tier is always spelled out in words next to the name, so colour is
 * reinforcement here rather than the carrier — rule 3's "never colour alone".
 * `relic` is the palette's rare-tier token and covers both top tiers; commons
 * recede to `textDim` because a common is the baseline, not news.
 */
const TIER_COLOR: Readonly<Record<ItemTier, string>> = {
  common: Palette.textDim,
  uncommon: Palette.text,
  rare: Palette.relic,
  relic: Palette.relic,
}

/**
 * Titles and subtitles stay keyed by the *whole* `PendingChoiceKind`, including
 * `'route'`, even though `drawChoiceScreen` hands a route to `src/ui/worldMap.ts`
 * before either table is read.
 *
 * Keeping the records exhaustive is what made adding `'route'` a compile error here
 * rather than a card with a blank heading, and that is worth more than deleting two
 * strings that only render if someone calls `layoutChoiceScreen` with a kind this
 * card cannot lay out. They describe the world map, so a mistaken call still says
 * something true.
 */
const KIND_TITLE: Readonly<Record<PendingChoiceKind, string>> = {
  item: 'SALVAGE RECOVERED',
  shop: 'FIELD REQUISITION',
  'work-order': 'WORK ORDER',
  route: 'APPROACH SELECTION',
}

const KIND_SUBTITLE: Readonly<Record<PendingChoiceKind, string>> = {
  item: 'Fit one system. The sortie is held while you read.',
  shop: 'Fit one system at the listed price. Scrap not spent stays with you.',
  'work-order': 'Accept one assignment for the corridor ahead.',
  route: 'The next sector is fixed. What you are choosing is how you arrive at it.',
}

// ---------------------------------------------------------------------------
// layout model
// ---------------------------------------------------------------------------

export interface TextLine {
  text: string
  /** Anchor. The left edge, right edge, or centre, per `align`. */
  x: number
  y: number
  size: number
  weight: 400 | 600 | 700
  color: string
  align: 'left' | 'right' | 'center'
  tracking: number
  /** Measured at layout time, so a bounds assertion needs no canvas. */
  width: number
}

/** Horizontal extent of a drawn line, accounting for its alignment. */
export function lineBounds(line: TextLine): { left: number; right: number } {
  if (line.align === 'right') return { left: line.x - line.width, right: line.x }
  if (line.align === 'center') {
    return { left: line.x - line.width / 2, right: line.x + line.width / 2 }
  }
  return { left: line.x, right: line.x + line.width }
}

export interface OptionLayout {
  index: number
  /** Item def id, or the work-order kind. */
  id: string
  name: string
  /** The tier word, or the work-order kind word. Never colour alone. */
  tierLabel: string
  box: Rect
  selected: boolean
  /** False only ever for a shop option the player cannot pay for. */
  affordable: boolean
  cost: number
  /** Scrap still needed. Zero when affordable. */
  shortfall: number
  cursed: boolean
  hasInteraction: boolean
  /** Well the interaction text sits in, so it can be given its own surface. */
  interactionBox: Rect | null
  mechanismLines: readonly string[]
  interactionLines: readonly string[]
  flavourLines: readonly string[]
  /** Resolved before → after rows for this run. Empty when the offer moves no stat. */
  statRows: readonly StatDeltaRow[]
  /** True when the rows were collapsed onto one line to fit. Their deltas are dropped. */
  statCompact: boolean
  /** Every line inside `box`, positioned and measured. */
  lines: readonly TextLine[]
  /** Border/accent colour for this box. */
  accent: string
}

export interface BuildLayout {
  box: Rect
  lines: readonly TextLine[]
  /** Distinct items held, not stacks. */
  heldCount: number
  liveCount: number
}

export interface ChoiceScreenLayout {
  kind: PendingChoiceKind
  card: Rect
  /** Top rule of the card. `caution` where scrap or routing is at stake. */
  accent: string
  scrim: string
  selected: number
  scrap: number
  options: readonly OptionLayout[]
  header: readonly TextLine[]
  build: BuildLayout
  footer: readonly TextLine[]
  /** 1px rules, as rects, so the draw pass has no geometry of its own. */
  rules: readonly Rect[]
  /** Selection highlight opacity this frame. Never reaches 0 — rule 10. */
  pulse: number
  /**
   * How much detail was dropped to fit: 0 nothing, 1 flavour, 2 flavour and
   * interaction text past two lines, 3 past one line and the resolved stat rows
   * collapsed onto one.
   */
  degrade: number
  /** True if even the tightest pass overflows. A bug, and a test asserts against it. */
  overflow: boolean
}

export interface ChoiceLayoutInput {
  kind: PendingChoiceKind
  offers: readonly ItemOffer[]
  costs: readonly number[]
  workOrders: readonly string[]
  scrap: number
  held: readonly HeldItem[]
  activeInteractions: readonly ActiveInteraction[]
  selected: number
  tick: number
  items: Readonly<Record<string, ItemDef>>
  workOrderDefs?: Readonly<Record<string, WorkOrderDef>>
  /**
   * Every modifier already in play — hull, held items per stack, live interactions.
   *
   * The "before" of every resolved row is folded from this, and the "after" from this
   * plus the offer's own modifiers. Defaults to what `held` implies; the app layer
   * passes the full list because only it knows the hull.
   */
  currentModifiers?: readonly StatModifier[]
  /**
   * `WorldView.resolvedStats`, as a cross-check rather than as a source.
   *
   * A row whose reconstructed "before" disagrees with the simulation is dropped, so
   * this card can never quote a figure the instrument panel contradicts.
   */
  resolvedStats?: ResolvedStats
  measure?: Measure
}

interface OptionContent {
  id: string
  name: string
  tierLabel: string
  tierColor: string
  cursed: boolean
  cost: number
  affordable: boolean
  shortfall: number
  /**
   * True when the price fits on the name line.
   *
   * Measured rather than assumed, and it decides the option's height, which is why
   * it is settled here. `src/render/panel.ts` records two shipped bugs from
   * guessing at this — a value drawn through a bar, and a label that read as a
   * caption for the wrong number — so a long name and a four-figure price drop the
   * price onto its own row instead of colliding on the title line.
   */
  priceInline: boolean
  mechanism: readonly string[]
  flavour: readonly string[]
  interaction: readonly string[]
  /**
   * Resolved before → after for every stat this offer moves, for the build in hand.
   *
   * Empty for a work order, for an item that is pure behaviour, for an unknown id, and
   * for any stat whose reconstructed "before" disagreed with the simulation's own
   * resolved value — see `statDeltaRows`.
   */
  statRows: readonly StatDeltaRow[]
  /**
   * True when the label plus the first row and its delta fit one line.
   *
   * False drops the label rather than letting it push a number past the box edge. The
   * stat table's own bounds keep every row short enough that no shipped item reaches
   * this, and a test says so — it exists so a future stat with a wider range degrades
   * instead of overflowing.
   */
  statLabelInline: boolean
  /**
   * True when every row fits one line together, without deltas, after the label.
   *
   * What the tightest degradation level collapses the block to. Measured rather than
   * assumed, because a collapse that then wraps saves nothing and the height
   * calculation would be wrong about it.
   */
  statFitsOneLine: boolean
}

const TEXT_W = CONTENT_W - OPT_PAD * 2 - CARET_GUTTER

/** Lines of interaction text shown at each degradation level. */
function synLinesShown(degrade: number, total: number): number {
  if (degrade <= 1) return total
  if (degrade === 2) return Math.min(2, total)
  return Math.min(1, total)
}

/**
 * Lines the resolved stat block occupies at this degradation level.
 *
 * Never zero when there are rows: the resolved numbers are the priority-1 information
 * on the card, so at the tightest level they collapse onto one line — losing the
 * `(+22)` parentheticals, which are the one part a reader can recompute from the two
 * numbers still shown — rather than being dropped the way flavour is.
 */
function statLinesShown(content: OptionContent, degrade: number): number {
  if (content.statRows.length === 0) return 0
  return degrade >= 3 && content.statFitsOneLine ? 1 : content.statRows.length
}

function optionHeight(content: OptionContent, degrade: number): number {
  let h = OPT_PAD + TITLE_H + content.mechanism.length * MECH_LH
  const statLines = statLinesShown(content, degrade)
  if (statLines > 0) h += STAT_GAP + statLines * SUB_LH
  if (degrade === 0 && content.flavour.length > 0) {
    h += 4 + content.flavour.length * SUB_LH
  }
  if (content.interaction.length > 0) {
    h += SYN_GAP + SUB_LH + synLinesShown(degrade, content.interaction.length) * SUB_LH + SYN_PAD * 2
  }
  if (!content.priceInline) h += COST_GAP + COST_H
  return h + OPT_PAD
}

/** Width of the price group as it would be drawn: value, gap, unit. */
function priceWidth(cost: number, shortfall: number, measure: Measure): number {
  const value = measure(String(cost), 14, 600) + measure(' cr', LABEL_SIZE, 400)
  if (shortfall <= 0) return value
  return value + 10 + measure(`SHORT ${shortfall} cr`, LABEL_SIZE, 600, 1.2)
}

/**
 * Measure the stat block's two collapse decisions once, at content-build time.
 *
 * Both feed `optionHeight`, so they have to be settled before any box is sized — the
 * same reason `priceInline` is decided here. `src/render/panel.ts` records two shipped
 * bugs from guessing at a width instead of measuring it.
 */
function measureStatBlock(
  rows: readonly StatDeltaRow[],
  measure: Measure,
): { statLabelInline: boolean; statFitsOneLine: boolean } {
  if (rows.length === 0) return { statLabelInline: false, statFitsOneLine: false }
  const labelW = measure(STAT_ROW_LABEL, LABEL_SIZE, 600, 1.4) + 10
  // Every row is indented past the label, not just the one that shares its line, so two
  // rows read as a table rather than as a table and a stray sentence. Measured over the
  // WIDEST row for that reason — the second row can be longer than the first.
  const widest = rows.reduce(
    (max, row) =>
      Math.max(max, measure(row.text, SUB_SIZE) + measure(` ${row.deltaText}`, LABEL_SIZE, 600)),
    0,
  )
  const statLabelInline = labelW + widest <= TEXT_W

  const sepW = measure(STAT_ROW_SEP, SUB_SIZE)
  const joined = rows.reduce(
    (sum, row, index) => sum + (index > 0 ? sepW : 0) + measure(row.text, SUB_SIZE),
    0,
  )
  return {
    statLabelInline,
    statFitsOneLine: rows.length > 1 && (statLabelInline ? labelW : 0) + joined <= TEXT_W,
  }
}

function buildOptionContent(
  input: ChoiceLayoutInput,
  scrap: number,
  measure: Measure,
): readonly OptionContent[] {
  const { kind } = input
  // Falls back to the modifiers the *offers* imply, so a caller that hands over a build
  // without its hull still gets rows that agree with the build strip beside them. The
  // app layer passes the full list, hull included — see `drawChoiceScreen`.
  const current =
    input.currentModifiers ??
    collectBuildModifiers({
      held: input.held,
      items: input.items,
      activeInteractions: input.activeInteractions,
    })
  if (kind === 'work-order') {
    // Indexed by a raw string from the sim, not by `WorkOrderKind`, so an
    // unrecognised kind falls through to the prettified id instead of failing to
    // compile against a closed record.
    const table: Readonly<Record<string, WorkOrderDef>> = input.workOrderDefs ?? WORK_ORDERS
    return input.workOrders.map((id) => {
      const def = table[id]
      const name = def?.name ?? prettifyId(id)
      const description = def?.description ?? 'No assignment brief on file.'
      return {
        id,
        name,
        // The kind fills the tier's slot: "[hazard]" says something, "[assignment]"
        // three times over says nothing.
        tierLabel: def?.kind ?? 'unlisted',
        tierColor: Palette.textDim,
        cursed: false,
        cost: 0,
        affordable: true,
        shortfall: 0,
        priceInline: true,
        mechanism: wrapText(description, TEXT_W, MECH_SIZE, measure),
        flavour: [],
        interaction: [],
        // A work order has no `StatModifier`s to resolve. When one gets an effect it
        // will get its own resolved line, in the change that makes it real.
        statRows: [],
        statLabelInline: false,
        statFitsOneLine: false,
      }
    })
  }

  return input.offers.map((offer, index) => {
    const def = input.items[offer.defId]
    // A non-finite or negative price is a simulation bug, and `World.updateChoice`
    // would let such a "purchase" through (`NaN > scrap` is false). Showing 0 cr
    // keeps the screen and the sim saying the same thing rather than greying out
    // something the sim would accept.
    const rawCost = input.costs[index]
    const cost =
      kind === 'shop' && rawCost !== undefined && Number.isFinite(rawCost)
        ? Math.max(0, Math.round(rawCost))
        : 0
    const affordable = isAffordable(cost, scrap)
    // Mechanism text is never omitted, so an unknown id still gets a line rather
    // than rendering as a bare name — the failure has to be visible.
    const mechanism = def?.mechanism ?? 'No specification on file for this component.'
    /*
     * DROPPED WHEN THE RESOLVED ROWS ALREADY SAY IT, which is most pure-stat items.
     *
     * The resolved rows landed above this sentence and immediately recreated the defect
     * the hull cards had just been cleaned of (roadmap #29): Barrel Liner drew
     * `Shot speed 620 -> 740 u/s (+120)` and then said "+120 projectile speed, from 620
     * to 740 units per second" directly underneath. One fact, twice, and only one of the
     * two derived from the run — so a balance change updates the row and leaves the
     * sentence selling the old item. That is finding R12's shape exactly.
     *
     * The sentence is dropped ONLY when the rows are strictly better: every stat the item
     * moves has a row, and the item has no `effects`. An effect is behaviour a number
     * cannot describe — extra projectiles, chaining, a timed window — so an item carrying
     * one keeps its sentence, because the rows cannot say what it does. `flavour` is
     * never dropped; it was never claiming to be a specification.
     *
     * Note this is a per-CARD decision, not a change to `ItemDef.mechanism`. The hangar
     * has no resolved table under it and still prints the sentence in full.
     */
    const hasEffects = (def?.effects?.length ?? 0) > 0
    const movedStats = new Set((def?.stats ?? []).map((modifier) => modifier.stat))
    const name = def?.name ?? prettifyId(offer.defId)
    const tierLabel = def?.tier ?? 'unlisted'
    // `caution`, never `danger`: a drawback the player is choosing to accept is
    // information, not incoming fire. See UI.md rule 3.
    const cursed = def?.tags.includes('cursed') ?? false
    const shortfall = affordable ? 0 : Math.max(0, cost - scrap)
    const titleW =
      measure(name, TITLE_SIZE, 700) +
      9 +
      measure(`[${tierLabel}]`, SUB_SIZE, 400) +
      (cursed ? 8 + measure('CURSED', LABEL_SIZE, 600, 1.2) : 0)
    const statRows = statDeltaRows({
      current,
      added: def?.stats ?? [],
      ...(input.resolvedStats ? { resolved: input.resolvedStats } : {}),
    })
    const rowsCoverEveryStat =
      movedStats.size > 0 && [...movedStats].every((stat) => statRows.some((r) => r.stat === stat))
    const mechanismText = !hasEffects && rowsCoverEveryStat ? '' : mechanism
    return {
      id: offer.defId,
      name,
      tierLabel,
      tierColor: def ? TIER_COLOR[def.tier] : Palette.textDim,
      cursed,
      cost,
      affordable,
      shortfall,
      priceInline:
        kind !== 'shop' || titleW + 14 + priceWidth(cost, shortfall, measure) <= TEXT_W,
      mechanism: mechanismText === '' ? [] : wrapText(mechanismText, TEXT_W, MECH_SIZE, measure),
      flavour: def?.flavour ? wrapText(def.flavour, TEXT_W, SUB_SIZE, measure) : [],
      interaction: offer.interactionText.flatMap((text) =>
        wrapText(text, TEXT_W - SYN_PAD * 2, SUB_SIZE, measure),
      ),
      statRows,
      ...measureStatBlock(statRows, measure),
    }
  })
}

/**
 * Pack held-item chips into at most `maxLines` lines, ending with an overflow
 * count rather than silently dropping the tail.
 *
 * THE INVARIANT, which is the whole reason this function exists rather than a slice:
 * the names it emits plus the number in its `+N more` must equal the number of chips
 * it was given. Anything else contradicts the "N systems fitted" summary drawn on the
 * same strip, and a build readout that disagrees with itself is worse than one that
 * says less. Exported so `tests/choiceScreen.test.ts` can sweep that equality across
 * item counts and name lengths rather than sample it.
 */
export function packChips(
  chips: readonly string[],
  maxWidth: number,
  maxLines: number,
  size: number,
  measure: Measure,
): readonly string[] {
  if (chips.length === 0) return []
  const lines: string[] = []
  let line = ''
  let placed = 0

  for (const chip of chips) {
    const candidate = line === '' ? chip : `${line}${CHIP_SEP}${chip}`
    if (measure(candidate, size, 400) <= maxWidth) {
      line = candidate
      placed++
      continue
    }
    if (lines.length + 1 >= maxLines) break
    if (line !== '') lines.push(line)
    line = chip
    placed++
  }

  if (placed < chips.length) {
    // The overflow marker has to fit on the last line, so the last chip gives way
    // to it rather than the count being dropped — an undercount of the build is
    // worse than one fewer name.
    //
    // COUNTED INSIDE THE TRIM, because the trim is what changes the number. The
    // marker used to be numbered from `placed` before this loop ran, so each chip it
    // dropped went missing from both the line and the count: 5 names and `+1 more`
    // beside a summary reading 7 fitted — the exact undercount the paragraph above
    // says cannot happen. Re-deriving the tail each pass also keeps the measurement
    // honest, since `+9 more` and `+10 more` are not the same width.
    let hidden = chips.length - placed
    let tail = `${CHIP_SEP}+${hidden} more`
    while (line !== '' && measure(`${line}${tail}`, size, 400) > maxWidth) {
      const cut = line.lastIndexOf(CHIP_SEP)
      // No separator left means one chip that still will not share its line with the
      // marker. It goes too — dropping it into the count keeps the total right, where
      // leaving it drew the marker past the edge of the strip.
      line = cut < 0 ? '' : line.slice(0, cut)
      hidden++
      tail = `${CHIP_SEP}+${hidden} more`
    }
    line = line === '' ? `+${hidden} more` : `${line}${tail}`
  }
  if (line !== '') lines.push(line)
  return lines
}

export function layoutChoiceScreen(input: ChoiceLayoutInput): ChoiceScreenLayout {
  const measure = input.measure ?? monoMeasure
  const { kind } = input
  // Sanitised before anything reads it: a NaN scrap total would otherwise turn
  // every affordability comparison and every shortfall into NaN.
  const scrap = Number.isFinite(input.scrap) ? Math.round(input.scrap) : 0
  const contents = buildOptionContent(input, scrap, measure)
  const selected = clampSelection(input.selected, contents.length)

  // Spending scrap and committing to a corridor both put something at risk, so
  // they get `caution`. A free reward does not, so it gets `self` — the selection
  // colour. `danger` appears nowhere on this screen.
  const accent = kind === 'item' ? Palette.self : Palette.caution

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

  // --- header ---------------------------------------------------------------
  let y = CARD.y + PAD
  header.push(
    line('Salvage Division // Field Assignment', CONTENT_X, y, LABEL_SIZE, Palette.textDim, {
      tracking: 1.6,
    }),
  )
  // Scrap on hand, right-aligned against the title. A price is meaningless
  // without it, and rule 2 wants the unit on both.
  header.push(
    line('SCRAP ON HAND', CONTENT_RIGHT, y, LABEL_SIZE, Palette.textDim, {
      align: 'right',
      tracking: 1.6,
    }),
  )
  y += 16
  header.push(line(KIND_TITLE[kind], CONTENT_X, y, 22, Palette.text, { weight: 700, tracking: 2.4 }))
  const scrapUnit = line(' cr', CONTENT_RIGHT, y + 6, SUB_SIZE, Palette.textDim, { align: 'right' })
  header.push(scrapUnit)
  header.push(
    line(String(scrap), CONTENT_RIGHT - scrapUnit.width, y, 18, Palette.caution, {
      weight: 600,
      align: 'right',
    }),
  )
  y += 26
  header.push(line(KIND_SUBTITLE[kind], CONTENT_X, y, SUB_SIZE, Palette.textDim))
  y += SUB_LH
  if (kind === 'work-order') {
    header.push(line(WORK_ORDER_NOTICE, CONTENT_X, y, LABEL_SIZE, Palette.textFaint))
    y += 14
  }

  y += RULE_GAP - 4
  rules.push({ x: CONTENT_X, y, w: CONTENT_W, h: 1 })
  const optionsTop = y + RULE_GAP

  // --- build strip: content first, because its height sets the option budget --
  //
  // A choice made without seeing what you already hold is a guess, and the synergy
  // marker on an offer only means something next to the build that earned it.
  //
  // Sized to its content and anchored to the footer, so an early-run build of one
  // item leaves its slack to the options instead of holding open air.
  const heldCount = input.held.length
  const stacks = input.held.reduce((sum, entry) => sum + Math.max(0, entry.count), 0)
  const liveCount = input.activeInteractions.length
  const buildTextW = CONTENT_W - OPT_PAD * 2

  const buildRows: { text: string; color: string }[] = []
  if (heldCount === 0) {
    buildRows.push({
      text: 'Nothing fitted yet — this is the first system on the hull.',
      color: Palette.textDim,
    })
  } else {
    const chips = input.held.map((entry) => {
      const name = input.items[entry.defId]?.name ?? prettifyId(entry.defId)
      // A stack count reads as a count: "×2", never a bare 2 that could be
      // anything (rule 2).
      return entry.count > 1 ? `${name} ×${entry.count}` : name
    })
    for (const text of packChips(chips, buildTextW, BUILD_CHIP_LINES, SUB_SIZE, measure)) {
      buildRows.push({ text, color: Palette.text })
    }
  }

  // Live interactions, one line each, truncated rather than wrapped: the full
  // sentence appears on the offer that would create it, and this strip's job is to
  // say which combinations are currently doing something.
  const listed = liveCount > BUILD_SYN_LINES ? BUILD_SYN_LINES - 1 : liveCount
  for (let i = 0; i < listed; i++) {
    const active = input.activeInteractions[i]
    if (!active) continue
    buildRows.push({
      text: truncateToWidth(`[+] ${active.text}`, buildTextW, SUB_SIZE, measure),
      color: Palette.good,
    })
  }
  if (liveCount > BUILD_SYN_LINES) {
    buildRows.push({
      text: `[+] ${liveCount - listed} more combinations live`,
      color: Palette.good,
    })
  }

  const buildH = BUILD_PAD_TOP + SUB_LH + 2 + buildRows.length * SUB_LH + BUILD_PAD_BOTTOM
  const footerTop = CARD_BOTTOM - PAD - FOOTER_H
  const buildBox: Rect = {
    x: CONTENT_X,
    y: footerTop - RULE_GAP - buildH,
    w: CONTENT_W,
    h: buildH,
  }
  rules.push({ x: CONTENT_X, y: buildBox.y - RULE_GAP, w: CONTENT_W, h: 1 })
  rules.push({ x: CONTENT_X, y: footerTop - 6, w: CONTENT_W, h: 1 })

  const buildX = buildBox.x + OPT_PAD
  const buildLines: TextLine[] = [
    line('CURRENT BUILD', buildX, buildBox.y + BUILD_PAD_TOP, LABEL_SIZE, Palette.textFaint, {
      tracking: 2.2,
    }),
    line(
      // Counts read as counts, and the unit is the noun: rule 2 applies to a
      // summary line as much as to a meter.
      liveCount > 0
        ? `${stacks} ${stacks === 1 ? 'system' : 'systems'} fitted · ${liveCount} live`
        : `${stacks} ${stacks === 1 ? 'system' : 'systems'} fitted`,
      buildBox.x + buildBox.w - OPT_PAD,
      buildBox.y + BUILD_PAD_TOP,
      LABEL_SIZE,
      liveCount > 0 ? Palette.good : Palette.textDim,
      { align: 'right', tracking: 1.2 },
    ),
  ]
  let buildY = buildBox.y + BUILD_PAD_TOP + SUB_LH + 2
  for (const row of buildRows) {
    buildLines.push(line(row.text, buildX, buildY, SUB_SIZE, row.color))
    buildY += SUB_LH
  }

  const optionsAvailable = buildBox.y - RULE_GAP * 2 - optionsTop

  // --- degradation ----------------------------------------------------------
  //
  // Flavour goes first because rule 4 declares it omittable. Interaction text is
  // trimmed only after that, and never to nothing, because rule 5 does not make it
  // optional — a marked option always keeps its marker and at least its first
  // line, and with the run paused the player can move the cursor freely.
  let degrade = 0
  const total = (list: readonly number[]): number =>
    list.reduce((sum, h) => sum + h, 0) + Math.max(0, list.length - 1) * OPT_GAP
  let heights = contents.map((content) => optionHeight(content, degrade))
  while (degrade < 3 && total(heights) > optionsAvailable) {
    degrade++
    heights = contents.map((content) => optionHeight(content, degrade))
  }
  const overflow = total(heights) > optionsAvailable

  // Spare room is spread between the options and then above and below the stack.
  // Boxes hug their content, so without this an early choice of three one-line
  // commons would sit as three thin bars under the header with 200 units of dead
  // space beneath them, which reads as a screen that failed to load.
  const slack = Math.max(0, optionsAvailable - total(heights))
  const gapCount = Math.max(1, contents.length - 1)
  const extraGap = Math.min(22, Math.floor(slack / gapCount))
  const stackGap = OPT_GAP + extraGap
  const leadIn = Math.floor(Math.max(0, slack - extraGap * gapCount) / 2)

  // --- options --------------------------------------------------------------
  const options: OptionLayout[] = []
  let optionY = optionsTop + leadIn
  contents.forEach((content, index) => {
    const height = heights[index] ?? 0
    const box: Rect = { x: CONTENT_X, y: optionY, w: CONTENT_W, h: height }
    const isSelected = index === selected
    const textX = box.x + OPT_PAD + CARET_GUTTER
    const right = box.x + box.w - OPT_PAD
    const lines: TextLine[] = []

    // Dimming an unaffordable option is reinforcement; the SHORT tag is what
    // actually carries the information.
    const nameColor = !content.affordable
      ? Palette.textDim
      : isSelected
        ? Palette.self
        : Palette.text
    const bodyColor = content.affordable ? Palette.text : Palette.textDim
    const boxAccent = !content.affordable
      ? Palette.line
      : isSelected
        ? kind === 'shop'
          ? Palette.caution
          : Palette.self
        : Palette.line

    let cursor = box.y + OPT_PAD
    if (isSelected) {
      // A caret as well as the highlight: selection never rests on colour alone.
      lines.push(line('>', box.x + OPT_PAD, cursor, TITLE_SIZE, nameColor, { weight: 700 }))
    }

    // Line 1 is name then tier, in that order and on that line, per rule 4's fixed
    // format. The tier sits directly after the name rather than at the right edge
    // so the price can own the edge on a shop card.
    const name = line(content.name, textX, cursor, TITLE_SIZE, nameColor, { weight: 700 })
    lines.push(name)
    const tier = line(
      `[${content.tierLabel}]`,
      textX + name.width + 9,
      cursor + 3,
      SUB_SIZE,
      content.tierColor,
    )
    lines.push(tier)
    if (content.cursed) {
      // `caution`, not `danger`: a drawback is information about a trade, not an
      // incoming threat. The word carries it; the colour only reinforces.
      lines.push(
        line('CURSED', tier.x + tier.width + 8, cursor + 3, LABEL_SIZE, Palette.caution, {
          weight: 600,
          tracking: 1.2,
        }),
      )
    }

    const priceLines = (top: number): void => {
      if (kind !== 'shop') return
      const unit = line(' cr', right, top + 3, LABEL_SIZE, Palette.textDim, { align: 'right' })
      const value = line(String(content.cost), right - unit.width, top, 14, bodyColor, {
        weight: 600,
        align: 'right',
      })
      lines.push(unit, value)
      if (!content.affordable) {
        // Stated in words and numbers, before the option is ever selected. The sim
        // refuses an unaffordable pick silently, and a confirm that appears to do
        // nothing is the worst feedback this screen could give.
        lines.push(
          line(
            `SHORT ${content.shortfall} cr`,
            right - unit.width - value.width - 10,
            top + 3,
            LABEL_SIZE,
            Palette.caution,
            { weight: 600, align: 'right', tracking: 1.2 },
          ),
        )
      }
    }
    if (content.priceInline) priceLines(cursor)
    cursor += TITLE_H

    // The resolved block, above the authored sentence: what this pick does to the ship
    // being flown, before what the item does in the abstract. See the module header for
    // why that order, and `statDelta.ts` for why the numbers cannot be arithmetic on
    // the already-resolved value.
    //
    // `good` for an improvement, `caution` for a cost, a no-op or a rise that cannot
    // matter — and neither carries alone: every row is written with an explicit sign or
    // with the words that say why there is none. `danger` appears nowhere: a trade the
    // player is choosing is information, not incoming fire (rule 3, same call CURSED
    // makes).
    const rowColor = (row: StatDeltaRow): string => {
      if (!content.affordable) return Palette.textDim
      return row.direction === 'better' ? Palette.good : Palette.caution
    }
    const statLines = statLinesShown(content, degrade)
    const statCompact = statLines === 1 && content.statRows.length > 1
    if (statLines > 0) {
      cursor += STAT_GAP
      let rowX = textX
      if (content.statLabelInline) {
        const label = line(STAT_ROW_LABEL, textX, cursor + 1, LABEL_SIZE, Palette.textDim, {
          weight: 600,
          tracking: 1.4,
        })
        lines.push(label)
        rowX = textX + label.width + 10
      }
      if (statCompact) {
        // Collapsed: the rows share a line and give up their parentheticals, which are
        // the only part a reader can recompute from the two numbers still shown. The
        // direction moves onto the row text itself so it is not lost with them.
        let x = rowX
        content.statRows.forEach((row, index) => {
          if (index > 0) {
            const sep = line(STAT_ROW_SEP, x, cursor, SUB_SIZE, Palette.textFaint)
            lines.push(sep)
            x += sep.width
          }
          const body = line(row.text, x, cursor, SUB_SIZE, rowColor(row))
          lines.push(body)
          x += body.width
        })
        cursor += SUB_LH
      } else {
        // Every row at the same x, the one beside the label included: a two-row block
        // whose second line starts further left reads as a mistake, not as a table.
        for (const row of content.statRows) {
          const body = line(row.text, rowX, cursor, SUB_SIZE, bodyColor)
          lines.push(body)
          lines.push(
            line(` ${row.deltaText}`, rowX + body.width, cursor, LABEL_SIZE, rowColor(row), {
              weight: 600,
            }),
          )
          cursor += SUB_LH
        }
      }
    }

    // Mechanism: the largest body text in the option, verbatim from the def. Rule 4's
    // whole point, and the only place the *behaviour* of an effect-carrying item is
    // stated at all.
    for (const text of content.mechanism) {
      lines.push(line(text, textX, cursor, MECH_SIZE, bodyColor))
      cursor += MECH_LH
    }

    const flavourLines = degrade === 0 ? content.flavour : []
    if (flavourLines.length > 0) {
      cursor += 4
      for (const text of flavourLines) {
        // `textFaint` is reserved for genuinely non-essential text, and flavour is
        // the definition of it.
        lines.push(line(text, textX, cursor, SUB_SIZE, Palette.textFaint))
        cursor += SUB_LH
      }
    }

    let interactionBox: Rect | null = null
    const shown = synLinesShown(degrade, content.interaction.length)
    const interactionLines = content.interaction.slice(0, shown).map((text, i) => {
      // An ellipsis on the last shown line, so a trimmed sentence never reads as a
      // complete one.
      const trimmed = i === shown - 1 && shown < content.interaction.length
      return trimmed ? `${text}…` : text
    })
    if (interactionLines.length > 0) {
      cursor += SYN_GAP
      interactionBox = {
        x: textX - SYN_PAD,
        y: cursor,
        // Ends flush with the option's inner right edge; the text inside is wrapped
        // to SYN_PAD short of it, so the sentence never touches the well.
        w: right - textX + SYN_PAD,
        h: SUB_LH + interactionLines.length * SUB_LH + SYN_PAD * 2,
      }
      let synY = cursor + SYN_PAD
      lines.push(
        line('[+] COMBINES WITH YOUR BUILD', textX, synY, LABEL_SIZE, Palette.good, {
          weight: 600,
          tracking: 1.4,
        }),
      )
      synY += SUB_LH
      for (const text of interactionLines) {
        // Full body colour, not dimmed: the combined effect is the reason this
        // option is different from the other two.
        lines.push(
          line(text, textX, synY, SUB_SIZE, content.affordable ? Palette.text : Palette.textDim),
        )
        synY += SUB_LH
      }
      cursor = interactionBox.y + interactionBox.h
    }

    if (!content.priceInline) {
      cursor += COST_GAP
      lines.push(line('PRICE', textX, cursor + 3, LABEL_SIZE, Palette.textDim, { tracking: 1.4 }))
      priceLines(cursor)
    }

    options.push({
      index,
      id: content.id,
      name: content.name,
      tierLabel: content.tierLabel,
      box,
      selected: isSelected,
      affordable: content.affordable,
      cost: content.cost,
      shortfall: content.shortfall,
      cursed: content.cursed,
      hasInteraction: content.interaction.length > 0,
      interactionBox,
      mechanismLines: content.mechanism,
      interactionLines,
      flavourLines,
      statRows: content.statRows,
      statCompact,
      lines,
      accent: boxAccent,
    })
    optionY += height + stackGap
  })

  // --- footer ---------------------------------------------------------------
  footer.push(
    line('←  →  select', CONTENT_X, footerTop + 4, SUB_SIZE, Palette.textDim, { tracking: 0.6 }),
  )
  footer.push(
    line(
      'ENTER  confirm      X  decline',
      CONTENT_RIGHT,
      footerTop + 4,
      SUB_SIZE,
      Palette.textDim,
      { align: 'right', tracking: 0.6 },
    ),
  )
  // Every kind is declinable (`updateCursor` treats a rising special edge as a
  // skip), so the screen says so — a player who cannot afford anything must not be
  // left pressing confirm at a card that refuses without explanation.
  //
  // A third branch used to live here: "Release fire to choose", shown when the trigger
  // was already held as the card opened. It existed because confirm needed a rising
  // `fire` edge and the trigger is always held in a shmup, so the card silently ignored
  // the button the player was pressing — reported as "the occasional soft freeze". The
  // hint, the 48-tick dwell that rescued it, and the 20-second timeout behind that are
  // all gone: confirm is its own key now, so the case cannot arise. Worth knowing that
  // the copy was the third mitigation for one root cause nobody had removed.
  footer.push(
    line(
      kind === 'shop'
        ? 'Declining is free. An option marked SHORT cannot be confirmed.'
        : 'Declining is free; the sortie resumes with nothing fitted.',
      CONTENT_X,
      footerTop + 4 + SUB_LH,
      LABEL_SIZE,
      Palette.textFaint,
    ),
  )

  // Slow, shallow, and never dark: ~0.9 Hz, opacity 0.07..0.21. Rule 10 is a hard
  // constraint, not a style preference.
  const tick = Number.isFinite(input.tick) ? input.tick : 0
  const pulse = 0.14 + 0.07 * Math.sin(tick * 0.09)

  return {
    kind,
    card: { ...CARD },
    accent,
    // Near-opaque, matching the incident report: the paused playfield behind is
    // atmosphere, and this is a card the player has to read. The caller should skip
    // the instrument panel while a choice is open for the same reason the incident
    // report does — faint wreckage behind paperwork is atmosphere, faint numbers
    // ghosting past the card edge are noise.
    scrim: 'rgba(5, 7, 11, 0.965)',
    selected,
    scrap,
    options,
    header,
    build: { box: buildBox, lines: buildLines, heldCount, liveCount },
    footer,
    rules,
    pulse,
    degrade,
    overflow,
  }
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

export interface ChoiceScreenOptions {
  /**
   * Index the simulation's cursor is on. Owned by `World` so replays reproduce
   * picks; this screen renders it and never advances it.
   */
  selected: number
  /** Ticks the choice has been open, for the selection pulse. */
  tick: number
  items: Readonly<Record<string, ItemDef>>
  /**
   * True while the trigger has been held for every tick since the card opened.
   *
   * Drives the "release fire to choose" hint. Without it the card looks frozen to
   * anyone who was firing when it appeared, which is nearly everyone.
   */
  /**
   * Accepted so the caller can pass its whole content bundle, and DELIBERATELY
   * UNUSED. Every interaction this screen states comes pre-resolved from the sim —
   * `ItemOffer.interactionText` for the offers, `WorldView.activeInteractions` for
   * the build. If this screen ever has to read the table to satisfy rule 5, the
   * contract in `src/sim/entities.ts` has failed and that is the bug to fix.
   */
  interactions?: readonly InteractionDef[]
  /** Overrides the temporary `WORK_ORDERS` table above. */
  workOrderDefs?: Readonly<Record<string, WorkOrderDef>>
}

function paintLines(ctx: CanvasRenderingContext2D, lines: readonly TextLine[]): void {
  for (const item of lines) {
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

export function drawChoiceScreenLayout(
  ctx: CanvasRenderingContext2D,
  layout: ChoiceScreenLayout,
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

  for (const option of layout.options) {
    const { box } = option
    // An unaffordable option is left at the card's own tone so it reads as flat
    // rather than as a button: shape and tone, not just colour.
    ctx.fillStyle = option.affordable ? Palette.panelRaised : Palette.panel
    ctx.fillRect(box.x, box.y, box.w, box.h)

    if (option.selected) {
      // Alpha via globalAlpha rather than an rgba string, so the wash is always
      // exactly the accent token and no colour is hardcoded here.
      const alpha = Math.max(0.05, option.affordable ? layout.pulse : layout.pulse * 0.6)
      ctx.globalAlpha = alpha
      ctx.fillStyle = option.accent
      ctx.fillRect(box.x, box.y, box.w, box.h)
      ctx.globalAlpha = 1
      // A solid left stripe as well as the wash, so the selected row is still
      // obvious in a monochrome screenshot.
      ctx.fillRect(box.x, box.y, 3, box.h)
    }

    ctx.strokeStyle = option.accent
    ctx.lineWidth = 1
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)

    if (option.interactionBox) {
      const well = option.interactionBox
      ctx.fillStyle = Palette.panel
      ctx.fillRect(well.x, well.y, well.w, well.h)
      ctx.fillStyle = Palette.good
      ctx.fillRect(well.x, well.y, 2, well.h)
    }

    paintLines(ctx, option.lines)
  }

  ctx.fillStyle = Palette.panelRaised
  ctx.fillRect(layout.build.box.x, layout.build.box.y, layout.build.box.w, layout.build.box.h)
  paintLines(ctx, layout.build.lines)
  paintLines(ctx, layout.footer)
}

/**
 * Draw the item choice, shop, work order, or route for the run's open decision.
 *
 * No-ops when nothing is pending, so the caller can call it unconditionally.
 *
 * A route is a different screen, not a variant of this card: it has no offers, no
 * prices, and no build to show, and what it does have — a run track, a destination,
 * and a hazard brief per option — has nowhere to go here. Dispatching from this one
 * entry point is what keeps `src/main.ts` free of the distinction.
 */
export function drawChoiceScreen(
  ctx: CanvasRenderingContext2D,
  view: WorldView,
  opts: ChoiceScreenOptions,
): void {
  const choice = view.pendingChoice
  if (choice === null) return

  if (choice.kind === 'route') {
    drawWorldMap(ctx, view, {
      // The same simulation-owned cursor, passed straight through. Neither screen
      // holds a selection of its own.
      selected: opts.selected,
      tick: opts.tick,
    })
    return
  }

  const layout = layoutChoiceScreen({
    kind: choice.kind,
    offers: choice.offers,
    costs: choice.costs,
    workOrders: choice.workOrders,
    scrap: view.stats.scrap,
    held: view.inventory,
    activeInteractions: view.activeInteractions,
    selected: opts.selected,
    tick: opts.tick,
    items: opts.items,
    ...(opts.workOrderDefs ? { workOrderDefs: opts.workOrderDefs } : {}),
    // The build as the simulation has it: the hull it issued, the items held with their
    // stacks, and the interactions IT says are live. Reconstructed read-only — nothing
    // here touches the sim, and `resolvedStats` is passed alongside so a reconstruction
    // that disagrees with the run drops its rows instead of printing them.
    currentModifiers: collectBuildModifiers({
      hullId: view.hullId,
      held: view.inventory,
      items: opts.items,
      activeInteractions: view.activeInteractions,
    }),
    resolvedStats: view.resolvedStats,
    // Measured against the real font, so wrapping is exact rather than estimated.
    measure: (text, size, weight, tracking) =>
      measureText(ctx, text, { size, ...(weight ? { weight } : {}), ...(tracking ? { tracking } : {}) }),
  })
  drawChoiceScreenLayout(ctx, layout)
}
