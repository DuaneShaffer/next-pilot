import { WORK_ORDERS } from '../content/workOrders'

export { WORK_ORDERS }
/**
 * The choice screen: item reward, field shop, and work order in one screen.
 *
 * This is where `docs/UI.md` rules 4 and 5 are either honoured or not, so the
 * whole module is arranged around them:
 *
 * - **Rule 4, mechanism first.** Every option renders name + tier, then
 *   `ItemDef.mechanism` *verbatim* in the largest body size on the card, then
 *   flavour in the faintest colour the palette has. Flavour is the first thing
 *   dropped when the content does not fit (see the degradation cascade in
 *   `layoutChoiceScreen`), because it is the only part of an option that rule 4
 *   allows to be missing.
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

import type { InteractionDef, ItemDef, ItemTier, WorkOrderDef } from '../content/types'
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
  WorldView,
} from '../sim/entities'

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

const CHIP_SEP = '   ·   '

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

const KIND_TITLE: Readonly<Record<PendingChoiceKind, string>> = {
  item: 'SALVAGE RECOVERED',
  shop: 'FIELD REQUISITION',
  'work-order': 'WORK ORDER',
}

const KIND_SUBTITLE: Readonly<Record<PendingChoiceKind, string>> = {
  item: 'Fit one system. The sortie is held while you read.',
  shop: 'Fit one system at the listed price. Scrap not spent stays with you.',
  'work-order': 'Accept one assignment for the corridor ahead.',
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
   * interaction text past two lines, 3 past one line.
   */
  degrade: number
  /** True if even the tightest pass overflows. A bug, and a test asserts against it. */
  overflow: boolean
}

export interface ChoiceLayoutInput {
  /**
   * True while the trigger has been held for every tick since the card opened.
   *
   * Drives the "release fire to choose" hint — see the footer. A card that ignores
   * the button a player is pressing must at least explain itself.
   */
  awaitingRelease?: boolean
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
}

const TEXT_W = CONTENT_W - OPT_PAD * 2 - CARET_GUTTER

/** Lines of interaction text shown at each degradation level. */
function synLinesShown(degrade: number, total: number): number {
  if (degrade <= 1) return total
  if (degrade === 2) return Math.min(2, total)
  return Math.min(1, total)
}

function optionHeight(content: OptionContent, degrade: number): number {
  let h = OPT_PAD + TITLE_H + content.mechanism.length * MECH_LH
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

function buildOptionContent(
  input: ChoiceLayoutInput,
  scrap: number,
  measure: Measure,
): readonly OptionContent[] {
  const { kind } = input
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
      mechanism: wrapText(mechanism, TEXT_W, MECH_SIZE, measure),
      flavour: def?.flavour ? wrapText(def.flavour, TEXT_W, SUB_SIZE, measure) : [],
      interaction: offer.interactionText.flatMap((text) =>
        wrapText(text, TEXT_W - SYN_PAD * 2, SUB_SIZE, measure),
      ),
    }
  })
}

/**
 * Pack held-item chips into at most `maxLines` lines, ending with an overflow
 * count rather than silently dropping the tail.
 */
function packChips(
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

  const remaining = chips.length - placed
  if (remaining > 0) {
    const tail = `${CHIP_SEP}+${remaining} more`
    // The overflow marker has to fit on the last line, so the last chip gives way
    // to it rather than the count being dropped — an undercount of the build is
    // worse than one fewer name.
    while (line.length > 0 && measure(`${line}${tail}`, size, 400) > maxWidth) {
      const cut = line.lastIndexOf(CHIP_SEP)
      if (cut < 0) break
      line = line.slice(0, cut)
    }
    line = line.length > 0 ? `${line}${tail}` : `+${remaining} more`
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

    // Mechanism: the largest body text in the option, immediately under the name,
    // verbatim from the def. Rule 4's whole point.
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
      'SPACE / Z  confirm      X  decline',
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
  // When the trigger was already held as the card opened, say so. A tester reported
  // "the occasional soft freeze": confirm needs a rising edge, the trigger is always
  // held in a shmup, and the card silently ignored the button they were pressing.
  // The simulation now resolves it after a short dwell, but recovering quietly is
  // not enough — the player has to know why nothing is happening.
  footer.push(
    line(
      input.awaitingRelease === true
        ? 'Release fire to choose — holding it confirms the highlighted option.'
        : kind === 'shop'
          ? 'Declining is free. An option marked SHORT cannot be confirmed.'
          : 'Declining is free; the sortie resumes with nothing fitted.',
      CONTENT_X,
      footerTop + 4 + SUB_LH,
      LABEL_SIZE,
      input.awaitingRelease === true ? Palette.caution : Palette.textFaint,
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
  awaitingRelease?: boolean
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
 * Draw the item choice, shop, or work order for the run's open decision.
 *
 * No-ops when nothing is pending, so the caller can call it unconditionally.
 */
export function drawChoiceScreen(
  ctx: CanvasRenderingContext2D,
  view: WorldView,
  opts: ChoiceScreenOptions,
): void {
  const choice = view.pendingChoice
  if (choice === null) return

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
    ...(opts.awaitingRelease === undefined ? {} : { awaitingRelease: opts.awaitingRelease }),
    ...(opts.workOrderDefs ? { workOrderDefs: opts.workOrderDefs } : {}),
    // Measured against the real font, so wrapping is exact rather than estimated.
    measure: (text, size, weight, tracking) =>
      measureText(ctx, text, { size, ...(weight ? { weight } : {}), ...(tracking ? { tracking } : {}) }),
  })
  drawChoiceScreenLayout(ctx, layout)
}
