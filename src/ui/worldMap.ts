/**
 * The world map: choosing how to fly the next leg.
 *
 * `PendingChoice.kind === 'route'` opens this instead of the item card. The sector
 * ORDER is authored and fixed — every option on this screen arrives at the same
 * sector — so what the player is choosing is the *approach*: which hazards they
 * accept for which reward. That is why this is not a branching node graph. A tree
 * of nodes would imply a choice of destination the simulation does not offer, and
 * an interface that implies a mechanic which does not exist is a lie told in
 * pictures.
 *
 * How `docs/UI.md` shaped it, rule by rule:
 *
 * - **Rule 4 is the whole screen.** Every route states, in words with numbers: what
 *   it pays (`RouteOption.rewardText`, rendered VERBATIM — this module wraps it and
 *   never rewrites, shortens, or paraphrases it), what it costs (each hazard by name
 *   *and* description), and where it goes. No glyph on this screen carries meaning
 *   that is not also written next to it: the track pips are numbered and captioned
 *   in prose, the hazard count is spelled out as "[2 hazards]", and the reward chip
 *   is a value with a unit. Nothing about a route is discoverable only by taking it.
 * - **Rule 3, colour is information.** `danger` appears NOWHERE here, and a test
 *   asserts it. A hazard printed on a map is a future cost, not a live threat — it
 *   cannot hurt the player this instant, and painting the map red would train the
 *   threat reflex on paperwork. The palette's word for a risky choice is `caution`,
 *   and that is what the hazard well and the card accent use. Gains use `good`, the
 *   cursor uses `self`, a waiting boss uses `hostile` (an enemy hull, not incoming
 *   fire). Every one of those is also stated in text, so colour is reinforcement.
 * - **Rule 2, every number carries a unit.** "+45 cr", "+20 hp", "1 item",
 *   "leg 3 of 5", "2 hazards". There is no bare number on this screen.
 * - **Rule 10, no strobing.** One pulse, on the selected row, at ~0.86 Hz, with an
 *   opacity floor well above zero. See `PULSE_RATE_HZ`.
 * - **Rule 1** would normally forbid drawing over the playfield. Permitted here for
 *   the same reason the choice card is: while `pendingChoice` is non-null the
 *   simulation is paused and there is nothing underneath to occlude.
 *
 * Two structural decisions worth knowing before editing:
 *
 * **Rows are compact, and the selected route gets a fixed detail pane.** Three
 * routes with three hazards each cannot show every hazard description at once —
 * measured, not guessed: laid out the way the choice card lays out its options, that
 * is ~735 units of content in a ~490-unit budget. The alternatives were to cut
 * hazard descriptions (a rule 4 failure) or to let the boxes overlap. Instead each
 * route keeps a two-line row carrying its name, hazard count, hazard *names*, and
 * reward chip, and the pane below shows the full brief for whichever row the cursor
 * is on. **When every detour accepts the same hazard** — three of the four seams in the
 * shipped run — the name is hoisted into one line above the stack instead and the rows
 * spend that line on what each one pays; see `SHARED_HAZARD_LABEL`. The pane is sized for the worst route on offer, not the selected one, so
 * its rectangle does not move or resize as the cursor moves — no text on this screen
 * shifts when you press left, and text that moves is text you have to re-read.
 *
 * **The layout is pure and the drawing is dumb.** `layoutWorldMap` returns every
 * rect and every positioned, pre-measured line; `drawWorldMapLayout` only fills
 * rects and draws strings. That is what lets `tests/worldMap.test.ts` prove, with no
 * canvas, that nothing escapes its box. Nobody has looked at this screen rendered
 * yet, so being checkable matters more than usual.
 *
 * **The selection is not ours.** `World` owns the cursor so a replay makes the same
 * picks. This module holds no mutable state of any kind — it has no module-level
 * `let`, and a test asserts that structurally. A screen with its own cursor and a
 * sim with its own cursor disagree, and the sim's is the one that replays.
 */

import { VIRTUAL_H, VIRTUAL_W } from '../core/space'
import { Palette } from '../render/palette'
import { drawText, measureText, wrapText, type Measure } from '../render/text'
import type { RouteOption, RouteReward, StageView, WorldView } from '../sim/entities'
// Only *function declarations* and types are imported from `choiceScreen`, never a
// const. `choiceScreen` imports `drawWorldMap` back from here so it can dispatch
// kind 'route', which makes the pair a module cycle; function declarations are
// hoisted and safe to read during a partial initialisation, a `const` is not.
import {
  clampSelection,
  monoMeasure,
  truncateToWidth,
  type Rect,
  type TextLine,
} from './choiceScreen'

export type { Rect, TextLine } from './choiceScreen'
export { clampSelection, monoMeasure } from './choiceScreen'

// ---------------------------------------------------------------------------
// geometry
//
// Same card rectangle as the choice screen on purpose: these two screens open in
// the same situation (the run paused for a decision) and a card that jumps a few
// units between them reads as a rendering fault rather than as a different screen.
// ---------------------------------------------------------------------------

export const MAP_CARD = { x: 16, y: 10, w: 608, h: 700 } as const
const CARD_BOTTOM = MAP_CARD.y + MAP_CARD.h
const PAD = 16

export const MAP_CONTENT_X = MAP_CARD.x + PAD
/** Full content column of the card. The widest container any string may use. */
export const MAP_CONTENT_W = MAP_CARD.w - PAD * 2
const CONTENT_RIGHT = MAP_CONTENT_X + MAP_CONTENT_W

/** Gap either side of a hairline rule. */
const RULE_GAP = 10
const ROW_GAP = 8
const ROW_PAD = 10

/**
 * Blank column inside every route row, selected or not, so the caret can appear
 * without shifting a single word.
 */
const CARET_GUTTER = 15

const PANE_PAD = 11
const WELL_PAD = 8
/** Indent of a hazard's text past the bullet, so wrapped lines align under the name. */
const BULLET_INDENT = 14

/**
 * Usable text width inside one route row.
 *
 * Exported so tests measure the real container instead of restating the arithmetic.
 * A previous test in this repo hardcoded a width and was wrong by a factor of three;
 * it passed while text ran off the screen.
 */
export const ROUTE_ROW_TEXT_W = MAP_CONTENT_W - ROW_PAD * 2 - CARET_GUTTER

/** Usable text width inside the detail pane, outside the hazard well. */
export const ROUTE_PANE_TEXT_W = MAP_CONTENT_W - PANE_PAD * 2

/** Usable text width for a hazard description, inside the well and past the bullet. */
export const HAZARD_TEXT_W = ROUTE_PANE_TEXT_W - WELL_PAD * 2 - BULLET_INDENT

export const TITLE_SIZE = 15
const TITLE_H = 19
/** Body size for the one string on this screen a player MUST be able to read. */
export const REWARD_TEXT_SIZE = 13
const BODY_LH = 17
export const SUB_SIZE = 12
const SUB_LH = 15
export const LABEL_SIZE = 11

const TRACK_PIP_H = 16
const TRACK_PIP_GAP = 5
const TRACK_H = TRACK_PIP_H + 6 + SUB_LH

/** Two lines: the controls, and one hint under them. */
const FOOTER_H = 22

// ---------------------------------------------------------------------------
// authored copy
//
// Every string a designer can lengthen lives here as an exported constant, so
// `tests/textFits.test.ts` can walk all of it and measure it against the container
// constants above rather than against a number someone typed into a test.
// ---------------------------------------------------------------------------

export const MAP_EYEBROW = 'Salvage Division // Route Authorisation'
export const MAP_TITLE = 'APPROACH SELECTION'
export const MAP_SUBTITLE =
  'The next sector is fixed. What you are choosing is how you arrive at it.'

export const DESTINATION_LABEL = 'DESTINATION'
export const BOSS_LABEL = 'BOSS'
/** Shown in the boss slot when the leg has none. Never a blank gap, never "null". */
export const NO_BOSS_TEXT = 'None on this leg'
/**
 * Shown when the routes disagree about where they go, so the header cannot speak
 * for them and the rows do instead.
 *
 * Short on purpose: destination and boss share one row, and the worst case is both
 * halves showing this at once.
 */
export const VARIES_TEXT = 'Varies by route below'

export const NO_ROUTES_TEXT = 'No routes on file for this leg. Decline to fly on.'
export const NO_HAZARD_ROW_TEXT = 'No hazards will be active on this leg.'
/**
 * States the *mechanism*, not just the absence.
 *
 * This used to read "adds nothing to the sector ahead", which was hedged against a
 * case that does not exist: a sector carries no hazards of its own, and the only way
 * one becomes live is a route arming it. Sitting under a `rewardText` that now says
 * "No hazards on this leg" flatly, the hedge actively reintroduced the doubt the
 * simulation had just removed. So the well says the rule instead, which is the one
 * thing about this screen a player cannot work out from anywhere else.
 */
export const NO_HAZARD_PANE_TEXT =
  'No hazards will be active. One only becomes live if the route you take accepts it.'

/**
 * THE ONE PRICE, STATED ONCE.
 *
 * `buildRoutes` gives both priced routes the same hazard whenever the next sector only
 * has one — which is three of the four seams in the shipped run. The rows used to
 * print that hazard's name twice, once per route, and two differently-named options
 * listing an identical cost does not read as "same price, different payout": it reads
 * as the screen having drawn the same row twice. Reported as a bug; it was not one.
 *
 * So when every detour on the card accepts the same hazard, the cost is hoisted out of
 * the rows and stated once above them, and the rows spend their second line on what
 * each one PAYS instead. The card then says what is actually true — one price, three
 * payouts — and the rows differ from each other on the axis the choice is really made
 * on. This is the same device the header already uses for a fact the routes agree on
 * (see `VARIES_TEXT`, which is its inverse).
 *
 * DELIBERATELY NOT IN `MAP_STRINGS`. Every key there needs a matching container in
 * `tests/textFits.test.ts`'s placement table, and these two are not measured the way
 * that sweep measures: the tail is composed with a hazard name at runtime and
 * truncated against whatever the label left, so what has to be proved is "the label
 * fits and the composite is truncated", not "this literal fits a fixed box".
 * `tests/worldMap.test.ts` asserts exactly that against the real container width.
 */
export const SHARED_HAZARD_LABEL = 'SAME HAZARD, EVERY DETOUR'
export const SHARED_HAZARD_TAIL = 'only the payout differs'

export const HAZARD_WELL_LABEL = 'ACCEPTED HAZARDS'
/** The same well when the route accepts none. Stated, so the absence is deliberate. */
export const NO_HAZARD_WELL_LABEL = 'NO HAZARDS'
export const HAZARD_WELL_NOTE = 'ACTIVE FOR THE WHOLE LEG'
export const REWARD_WELL_LABEL = 'ON ARRIVAL'
export const BRIEF_LABEL = 'ROUTE BRIEF'

export const FOOTER_CONTROLS_LEFT = '←  →  select'
/**
 * ENTER, not SPACE and not Z.
 *
 * Accepting is `InputSnapshot.confirm` now, whose codes deliberately exclude the fire
 * bindings — "the selection screens must not use the fire key to accept responses". A
 * footer naming the trigger names a key that does nothing on this screen.
 */
export const FOOTER_CONTROLS_RIGHT = 'ENTER  confirm      X  decline'
/**
 * What declining does, which is NOT "nothing".
 *
 * `World.takeRoute` flies the direct approach on a decline, deliberately — the run
 * has to go somewhere, and declining must not be a way to collect a reward without
 * its hazard. A card whose decline key silently commits you to one of the options is
 * exactly the kind of thing rule 4 exists to forbid, so it is stated.
 *
 * The "every route ends at the same sector" invariant this line used to carry now
 * lives in `MAP_SUBTITLE`, where it belongs: it is a fact about the screen, not about
 * a key.
 */
export const FOOTER_HINT =
  'Declining flies the direct approach: no hazards accepted, no bonus paid.'
/**
 * Shown in place of a route's name when the simulation sends an empty one.
 *
 * A visible failure rather than a blank title bar: an option with no name cannot be
 * discussed, remembered, or reported in a bug.
 */
export const UNNAMED_ROUTE_TEXT = 'UNNAMED ROUTE'

/**
 * Compile-time proof that every `RouteReward` variant is handled.
 *
 * `satisfies` fails if a key is missing *or* extra, so adding a variant to
 * `RouteReward` breaks the build here rather than rendering a blank chip. The
 * exhaustive `switch` in `rewardChip` carries a `never` check for the same reason;
 * this one additionally hands the test suite a list to iterate.
 */
const REWARD_KIND_COVERAGE = {
  none: true,
  item: true,
  scrap: true,
  repair: true,
} as const satisfies Readonly<Record<RouteReward['kind'], true>>

export const ROUTE_REWARD_KINDS = Object.keys(
  REWARD_KIND_COVERAGE,
) as readonly RouteReward['kind'][]

/** Every authored string on this screen, for the copy-fits sweep. */
export const MAP_STRINGS = {
  eyebrow: MAP_EYEBROW,
  title: MAP_TITLE,
  subtitle: MAP_SUBTITLE,
  destinationLabel: DESTINATION_LABEL,
  bossLabel: BOSS_LABEL,
  noBoss: NO_BOSS_TEXT,
  varies: VARIES_TEXT,
  noRoutes: NO_ROUTES_TEXT,
  noHazardRow: NO_HAZARD_ROW_TEXT,
  noHazardPane: NO_HAZARD_PANE_TEXT,
  hazardWellLabel: HAZARD_WELL_LABEL,
  noHazardWellLabel: NO_HAZARD_WELL_LABEL,
  hazardWellNote: HAZARD_WELL_NOTE,
  rewardWellLabel: REWARD_WELL_LABEL,
  briefLabel: BRIEF_LABEL,
  controlsLeft: FOOTER_CONTROLS_LEFT,
  controlsRight: FOOTER_CONTROLS_RIGHT,
  hint: FOOTER_HINT,
  unnamedRoute: UNNAMED_ROUTE_TEXT,
} as const

// ---------------------------------------------------------------------------
// pulse
// ---------------------------------------------------------------------------

/** Radians per tick of the selection pulse. */
const PULSE_RADIANS_PER_TICK = 0.09
const TICKS_PER_SECOND = 60
/**
 * Selection pulse frequency, in hertz.
 *
 * UI rule 10 caps blinking at ~1 Hz because flashing in the 3–30 Hz band can trigger
 * photosensitive seizures. This is a hard accessibility constraint, so the rate is a
 * derived constant a test can assert rather than a magic number in a sine call.
 */
export const PULSE_RATE_HZ = (PULSE_RADIANS_PER_TICK * TICKS_PER_SECOND) / (Math.PI * 2)

/** Opacity floor of the selection wash. Never reaches zero, so it breathes rather than blinks. */
export const PULSE_MIN = 0.07
export const PULSE_MAX = 0.21

// ---------------------------------------------------------------------------
// layout model
// ---------------------------------------------------------------------------

export type PipState = 'flown' | 'current' | 'ahead'

export interface TrackPip {
  index: number
  state: PipState
  box: Rect
  fill: string
  stroke: string
  /** Solid marker under the current pip, so the cursor is not colour alone. */
  marker: Rect | null
}

export interface TrackLayout {
  box: Rect
  pips: readonly TrackPip[]
  lines: readonly TextLine[]
  /** Legs behind, the leg being chosen, and legs after it. All stated in the caption too. */
  flown: number
  current: number
  ahead: number
}

export interface RouteRowLayout {
  index: number
  box: Rect
  selected: boolean
  title: string
  /** "[2 hazards]" — spelled out, because a bare 2 could be anything. */
  hazardTag: string
  hazardCount: number
  rewardKind: RouteReward['kind']
  /** The reward as a scannable value plus unit, e.g. "+45" / "cr". */
  rewardValue: string
  rewardUnit: string
  accent: string
  lines: readonly TextLine[]
}

export interface HazardBrief {
  name: string
  lines: readonly string[]
  /** True when the description had to be cut to fit. Zero of these for real content. */
  trimmed: boolean
}

export interface DetailLayout {
  box: Rect
  /** The hazard well, or null when the route accepts none. */
  hazardBox: Rect | null
  /** Index of the route being briefed. Always the selected row. */
  routeIndex: number
  /** `RouteOption.rewardText`, wrapped and otherwise untouched. */
  rewardLines: readonly string[]
  hazards: readonly HazardBrief[]
  lines: readonly TextLine[]
}

export interface WorldMapLayout {
  card: Rect
  accent: string
  scrim: string
  /** Index the simulation's cursor is on, brought into range. Never our own. */
  selected: number
  header: readonly TextLine[]
  track: TrackLayout
  /**
   * The one-price banner above the rows, or null when the routes accept different
   * hazards. `names` is carried separately so a test can assert *which* hazard was
   * hoisted without parsing the rendered line.
   */
  sharedHazard: { names: string; lines: readonly TextLine[] } | null
  rows: readonly RouteRowLayout[]
  detail: DetailLayout
  footer: readonly TextLine[]
  rules: readonly Rect[]
  /** Selection highlight opacity this frame. Never reaches 0 — rule 10. */
  pulse: number
  /** How much was given up to fit: 0 nothing, 1 the pane's label row, 2 the rows' hazard names. */
  degrade: number
  /** Hazard description lines cut to fit. A test asserts 0 for plausible content. */
  trimmed: number
  /** True if even the tightest pass overflows. A bug, and a test asserts against it. */
  overflow: boolean
}

export interface WorldMapLayoutInput {
  routes: readonly RouteOption[]
  stage: StageView
  /**
   * The simulation's cursor index. This screen renders it and never advances it.
   */
  selected: number
  /** Ticks the choice has been open, for the selection pulse. */
  tick: number
  measure?: Measure
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** A finite, non-negative, whole number, however the value arrived. */
function safeCount(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

/**
 * The reward as a value and a unit.
 *
 * Exhaustive by construction: the `default` branch assigns to `never`, so a new
 * `RouteReward` variant is a compile error here rather than a route that silently
 * advertises nothing. Rule 2 — the unit is never dropped, and a gain always shows
 * its sign, because "+20 hp" and "20 hp" are different promises.
 */
export function rewardChip(reward: RouteReward): {
  value: string
  unit: string
  /** True when the route pays something, so the chip can use `good`. */
  pays: boolean
} {
  switch (reward.kind) {
    case 'none':
      // One word, not a value/unit pair: "none" is not a quantity, and rule 2 asks
      // for a unit on every *number*. Splitting it set "no" at value size and
      // "bonus" at unit size, which read as two unrelated words.
      return { value: 'none', unit: '', pays: false }
    case 'item':
      return { value: '1', unit: 'item', pays: true }
    case 'scrap':
      return { value: `+${safeCount(reward.amount)}`, unit: 'cr', pays: true }
    case 'repair':
      return { value: `+${safeCount(reward.amount)}`, unit: 'hp', pays: true }
    default: {
      // Unreachable. Present so adding a variant breaks the build.
      const exhaustive: never = reward
      return exhaustive
    }
  }
}

/** "[no hazards]" / "[1 hazard]" / "[3 hazards]". Spelled out — rule 2. */
export function hazardTag(count: number): string {
  const n = safeCount(count)
  if (n === 0) return '[no hazards]'
  return `[${n} ${plural(n, 'hazard', 'hazards')}]`
}

/**
 * The value shared by every route, or null when they disagree.
 *
 * `bossName` is legitimately `null`, so "they all agree it is null" and "they
 * disagree" have to be distinguishable — hence the wrapper rather than a bare
 * `T | null` return.
 */
function sharedValue<T>(values: readonly T[]): { shared: true; value: T } | { shared: false } {
  const first = values[0]
  if (values.length === 0 || first === undefined) return { shared: false }
  for (const value of values) if (value !== first) return { shared: false }
  return { shared: true, value: first }
}

/**
 * The hazard list every route on this card accepts, or null when they differ.
 *
 * Returns null unless at least TWO routes carry hazards and all of them carry the same
 * ones: with one priced route there is nothing to mistake for a duplicate, and with
 * different hazards the rows are already telling the player something they need. The
 * direct route is ignored here rather than counted as a disagreement — it accepts
 * nothing, which is stated by its own `[no hazards]` tag.
 *
 * Compared by name list, because names are what the row prints and what the player
 * would compare. Ids would be the tighter key, but a card showing two identically
 * *named* hazards has the reported problem whether or not their ids match.
 */
export function sharedHazardNames(routes: readonly RouteOption[]): string | null {
  const priced = routes.filter((route) => route.hazards.length > 0)
  if (priced.length < 2) return null
  const keys = priced.map((route) => route.hazards.map((hazard) => hazard.name).join(', '))
  const shared = sharedValue(keys)
  if (!shared.shared || shared.value === '') return null
  return shared.value
}

/**
 * Fit hazard briefs into the lines available, cutting description lines last.
 *
 * Rule 4 makes a hazard's description load-bearing, so this is a last resort, not a
 * layout strategy: the pane is sized so that three hazards with 160-character
 * descriptions fit untouched (asserted in `tests/worldMap.test.ts`). What this
 * guarantees is that a pathological string cannot draw *outside* the well — it gets
 * an ellipsis, which at least tells the reader something was dropped, rather than
 * being painted over the footer.
 */
function fitHazards(
  briefs: readonly { name: string; lines: readonly string[] }[],
  availableLines: number,
): { hazards: readonly HazardBrief[]; trimmed: number; overflow: boolean } {
  const working = briefs.map((brief) => ({
    name: brief.name,
    lines: [...brief.lines],
    trimmed: false,
  }))
  const used = (): number =>
    working.reduce((sum, entry) => sum + (entry.name === '' ? 0 : 1) + entry.lines.length, 0)
  let trimmed = 0

  // Trim the longest description first, so one verbose hazard is shortened before
  // three terse ones are all damaged equally.
  while (used() > availableLines) {
    let victim = -1
    let longest = 1
    working.forEach((entry, index) => {
      if (entry.lines.length > longest) {
        longest = entry.lines.length
        victim = index
      }
    })
    if (victim < 0) break
    const entry = working[victim]
    if (!entry) break
    entry.lines.pop()
    const last = entry.lines[entry.lines.length - 1]
    if (last !== undefined) entry.lines[entry.lines.length - 1] = `${last}…`
    entry.trimmed = true
    trimmed++
  }

  // Last resort, reached only by content far outside anything authored: even one
  // line each does not fit. Whole hazards come off the end and the well says how
  // many, because a silently shortened list is worse than an honest count — the
  // player would have no way to know the route carried a hazard at all. `overflow`
  // stays true so a test fails rather than this shipping unnoticed.
  let overflow = false
  if (used() > availableLines) {
    // One line is held back for the count itself.
    while (working.length > 0 && used() + 1 > availableLines) {
      working.pop()
      overflow = true
    }
    const missing = briefs.length - working.length
    if (missing > 0) {
      working.push({
        name: '',
        lines: [`+${missing} more ${plural(missing, 'hazard', 'hazards')} not shown`],
        trimmed: true,
      })
    }
  }

  return { hazards: working, trimmed, overflow: overflow || used() > availableLines }
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

export function layoutWorldMap(input: WorldMapLayoutInput): WorldMapLayout {
  const measure = input.measure ?? monoMeasure
  const routes = input.routes
  const selected = clampSelection(input.selected, routes.length)

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

  const header: TextLine[] = []
  const footer: TextLine[] = []
  const rules: Rect[] = []

  // --- where the run is ------------------------------------------------------
  //
  // Sourced from the routes rather than from the roadmap: the panel once read
  // "SECTOR 1 / 5" for the whole game because it displayed a plan instead of the
  // simulation, and `StageView` exists to stop that recurring.
  const legCount = Math.max(1, safeCount(input.stage.count))
  const firstRoute = routes[0]
  const rawTarget =
    firstRoute !== undefined ? firstRoute.stageIndex : safeCount(input.stage.index) + 1
  const target = Math.min(Math.max(0, safeCount(rawTarget)), legCount - 1)
  const flown = target
  const ahead = legCount - target - 1

  const destination = sharedValue(routes.map((route) => route.sectorName))
  const bossNames = sharedValue(routes.map((route) => route.bossName))

  // --- header ----------------------------------------------------------------
  let y = MAP_CARD.y + PAD
  header.push(line(MAP_EYEBROW, MAP_CONTENT_X, y, LABEL_SIZE, Palette.textDim, { tracking: 1.6 }))
  header.push(
    line('LEG', CONTENT_RIGHT, y, LABEL_SIZE, Palette.textDim, { align: 'right', tracking: 1.6 }),
  )
  y += 16
  header.push(line(MAP_TITLE, MAP_CONTENT_X, y, 22, Palette.text, { weight: 700, tracking: 2.4 }))
  // The leg counter reads "3 of 5", not "3": rule 2 applies to progress as much as
  // to a stat. The unit is dimmer than the value so the eye lands on the number.
  const legUnit = line(` of ${legCount}`, CONTENT_RIGHT, y + 6, SUB_SIZE, Palette.textDim, {
    align: 'right',
  })
  header.push(legUnit)
  header.push(
    line(String(target + 1), CONTENT_RIGHT - legUnit.width, y, 18, Palette.self, {
      weight: 600,
      align: 'right',
    }),
  )
  y += 26
  header.push(line(MAP_SUBTITLE, MAP_CONTENT_X, y, SUB_SIZE, Palette.textDim))
  y += SUB_LH + 3

  // Destination and boss share one row. Both slots are always filled — an empty gap
  // where a boss name would go is indistinguishable from a bug, and "null" is worse.
  const destLabel = line(DESTINATION_LABEL, MAP_CONTENT_X, y + 3, LABEL_SIZE, Palette.textDim, {
    tracking: 1.6,
  })
  header.push(destLabel)
  const destText = destination.shared
    ? destination.value
    : routes.length === 0
      ? NO_ROUTES_TEXT
      : VARIES_TEXT
  header.push(
    line(destText, destLabel.x + destLabel.width + 10, y, REWARD_TEXT_SIZE, Palette.text, {
      weight: 600,
    }),
  )
  const bossText = bossNames.shared
    ? (bossNames.value ?? NO_BOSS_TEXT)
    : routes.length === 0
      ? NO_BOSS_TEXT
      : VARIES_TEXT
  const bossKnown = bossNames.shared && bossNames.value !== null
  const bossValue = line(
    bossText,
    CONTENT_RIGHT,
    y,
    REWARD_TEXT_SIZE,
    // `hostile`, not `danger`: a boss waiting at the end of a leg is an enemy hull on
    // a map, and it cannot hurt anyone from here. Rule 3's split is the whole point.
    bossKnown ? Palette.hostile : Palette.textDim,
    { align: 'right', weight: bossKnown ? 600 : 400 },
  )
  header.push(
    line(BOSS_LABEL, CONTENT_RIGHT - bossValue.width - 10, y + 3, LABEL_SIZE, Palette.textDim, {
      align: 'right',
      tracking: 1.6,
    }),
  )
  header.push(bossValue)
  y += 20

  y += RULE_GAP - 4
  rules.push({ x: MAP_CONTENT_X, y, w: MAP_CONTENT_W, h: 1 })
  y += RULE_GAP

  // --- run track -------------------------------------------------------------
  //
  // The shape of the whole run, so a player choosing a route knows how much of it is
  // left. Pips are numbered and the caption states the same facts in prose, so the
  // strip is never the only place a fact lives (rule 3: colour never carries
  // information alone, and neither does a shape).
  const trackBox: Rect = { x: MAP_CONTENT_X, y, w: MAP_CONTENT_W, h: TRACK_H }
  // The pips span the full content column rather than sitting as a short strip on
  // the left. At that width the track reads as the segmented meters the panel
  // already uses — countable at a glance, and unmistakably "the whole run".
  const pipW = Math.max(12, Math.floor((MAP_CONTENT_W - (legCount - 1) * TRACK_PIP_GAP) / legCount))
  const pips: TrackPip[] = []
  for (let i = 0; i < legCount; i++) {
    const state: PipState = i < target ? 'flown' : i === target ? 'current' : 'ahead'
    const box: Rect = {
      x: MAP_CONTENT_X + i * (pipW + TRACK_PIP_GAP),
      y: trackBox.y,
      w: pipW,
      h: TRACK_PIP_H,
    }
    pips.push({
      index: i,
      state,
      box,
      fill: state === 'flown' ? Palette.line : Palette.panel,
      stroke: state === 'current' ? Palette.self : Palette.line,
      // The current pip additionally carries a solid bar, so which leg is being
      // chosen survives a monochrome screenshot.
      marker: state === 'current' ? { x: box.x, y: box.y + box.h, w: box.w, h: 2 } : null,
    })
  }
  const trackLines: TextLine[] = pips.map((pip) =>
    line(
      String(pip.index + 1),
      pip.box.x + pip.box.w / 2,
      pip.box.y + 3,
      LABEL_SIZE,
      pip.state === 'current'
        ? Palette.self
        : pip.state === 'flown'
          ? Palette.textDim
          : Palette.textFaint,
      { align: 'center', weight: pip.state === 'current' ? 600 : 400 },
    ),
  )
  const caption =
    flown === 0
      ? `No legs flown yet · choosing leg ${target + 1} of ${legCount} · ${ahead} ${plural(ahead, 'leg', 'legs')} after this`
      : `${flown} ${plural(flown, 'leg', 'legs')} flown · choosing leg ${target + 1} of ${legCount} · ${ahead} ${plural(ahead, 'leg', 'legs')} after this`
  trackLines.push(
    line(caption, MAP_CONTENT_X, trackBox.y + TRACK_PIP_H + 6, SUB_SIZE, Palette.textDim),
  )
  y += TRACK_H

  y += RULE_GAP - 4
  rules.push({ x: MAP_CONTENT_X, y, w: MAP_CONTENT_W, h: 1 })

  const rowsTopBase = y + RULE_GAP

  // --- footer geometry, reserved before the rows so nothing can grow into it ---
  const footerTop = CARD_BOTTOM - PAD - FOOTER_H
  rules.push({ x: MAP_CONTENT_X, y: footerTop - 6, w: MAP_CONTENT_W, h: 1 })

  /**
   * Whether this card has one price to hoist, and what it costs in height.
   *
   * Only a CANDIDATE here: the banner is the first thing dropped when the card runs
   * out of room, decided with the degradation cascade below. It cannot be paid for out
   * of the hazard well — a note explaining the price must never be the reason the price
   * itself gets trimmed.
   */
  const sharedCandidate = sharedHazardNames(routes)
  const SHARED_NOTE_H = SUB_LH + 6

  // --- rows ------------------------------------------------------------------
  //
  // Fixed height, and the same height whether selected or not, so the stack never
  // reflows under the cursor.
  const buildRowContents = (shared: string | null) => routes.map((route) => {
    const hazardCount = route.hazards.length
    const chip = rewardChip(route.reward)
    const names = route.hazards.map((hazard) => hazard.name).join(', ')
    const prefix = destination.shared ? '' : `To ${route.sectorName}. `
    // With the price hoisted, the row's one spare line goes to what this route PAYS —
    // `rewardText` verbatim, the simulation's own sentence, never a paraphrase. That
    // makes all three payouts comparable without moving the cursor, which is the whole
    // reason for hoisting: repeating one hazard three times crowded out the only thing
    // the rows actually differ on.
    const summary =
      shared !== null
        ? `${prefix}${route.rewardText}`
        : hazardCount === 0
          ? `${prefix}${NO_HAZARD_ROW_TEXT}`
          : `${prefix}Hazards: ${names}`
    const tag = hazardTag(hazardCount)
    // Name, hazard tag, and reward chip share the title line, so the name is
    // truncated against what is actually beside it rather than against the row
    // width. `src/render/panel.ts` records two shipped bugs from guessing at this.
    const chipW =
      measure(chip.value, 14, 600) + (chip.unit === '' ? 0 : measure(` ${chip.unit}`, LABEL_SIZE))
    const nameRoom = ROUTE_ROW_TEXT_W - 9 - measure(tag, SUB_SIZE) - 14 - chipW
    return {
      route,
      chip,
      hazardCount,
      title: truncateToWidth(
        route.name.trim() === '' ? UNNAMED_ROUTE_TEXT : route.name,
        nameRoom,
        TITLE_SIZE,
        measure,
        700,
      ),
      tag,
      summary,
    }
  })

  /**
   * The degradation cascade, ordered by how much rule 4 is hurt.
   *
   * 0. Everything.
   * 1. The pane's label row goes. It is a label — "ROUTE BRIEF … ON ARRIVAL" — and
   *    the selected row directly above it already identifies what is being briefed.
   *    Nothing mechanical is in it, which is the same reason the choice screen drops
   *    flavour first.
   * 2. The rows lose their hazard-name line. Costly, because it is what lets a player
   *    compare all three trades without moving the cursor, so it goes after the label
   *    and before anything with numbers in it.
   *
   * Hazard descriptions and `rewardText` are never on this list. They are the
   * mechanism; if they still do not fit, `fitHazards` cuts as a last resort and
   * raises `overflow` so a test fails.
   */
  const rowHeight = (degrade: number): number =>
    ROW_PAD + TITLE_H + (degrade <= 1 ? SUB_LH : 0) + ROW_PAD

  const showsPaneLabel = (degrade: number): boolean => degrade === 0

  // Both blocks inside the pane are sized for the worst route on offer, not for the
  // selected one. That is what makes the well a fixed rectangle: its top edge does
  // not slide up and down as the cursor moves between a one-line reward sentence and
  // a three-line one, and its bottom edge is always the pane's. A box that resizes
  // under the cursor is a box the player has to re-read.
  const linesOfReward = (route: RouteOption): number =>
    wrapText(route.rewardText, ROUTE_PANE_TEXT_W, REWARD_TEXT_SIZE, measure).length
  const linesOfHazards = (route: RouteOption): number =>
    route.hazards.length === 0
      ? wrapText(NO_HAZARD_PANE_TEXT, HAZARD_TEXT_W, SUB_SIZE, measure).length
      : route.hazards.reduce(
          (sum, hazard) =>
            sum + 1 + wrapText(hazard.description, HAZARD_TEXT_W, SUB_SIZE, measure).length,
          0,
        )

  const rewardBlockLines = Math.max(1, ...routes.map(linesOfReward))
  const worstHazardLines = Math.max(1, ...routes.map(linesOfHazards))
  /** Well label plus one line, the least that can be shown without lying by omission. */
  const minWellH = SUB_LH * 2 + WELL_PAD * 2
  const paneWanted =
    PANE_PAD +
    rewardBlockLines * BODY_LH +
    8 +
    SUB_LH +
    worstHazardLines * SUB_LH +
    WELL_PAD * 2 +
    PANE_PAD

  const availableWith = (withNote: boolean): number =>
    footerTop - RULE_GAP - rowsTopBase - (withNote ? SHARED_NOTE_H : 0)
  const stackHeight = (degrade: number): number =>
    routes.length * rowHeight(degrade) + Math.max(0, routes.length - 1) * ROW_GAP
  const fitsWith = (degrade: number, withNote: boolean): boolean =>
    stackHeight(degrade) + RULE_GAP + paneWanted + (showsPaneLabel(degrade) ? SUB_LH : 0) <=
    availableWith(withNote)

  /*
   * THE BANNER DEGRADES BEFORE THE MECHANISM DOES, AND AFTER THE ROWS DO.
   *
   * Order matters both ways. It is dropped only once the rows have already given up
   * their label row and their second line, because at that point the banner is the ONLY
   * place outside the pane that names what the detours cost — dropping it earlier would
   * take the price off the card to save a label. And it is dropped before `fitHazards`
   * starts cutting hazard descriptions, because a note *about* the price must never be
   * the reason the price is trimmed. Nothing the sim can produce reaches this: it takes
   * three routes carrying four 900-character hazards each.
   */
  let withNote = sharedCandidate !== null
  let degrade = 0
  while (degrade < 2 && routes.length > 0 && !fitsWith(degrade, withNote)) degrade++
  if (withNote && routes.length > 0 && !fitsWith(degrade, true)) {
    withNote = false
    degrade = 0
    while (degrade < 2 && !fitsWith(degrade, false)) degrade++
  }

  const shared = withNote ? sharedCandidate : null
  const rowContents = buildRowContents(shared)
  const rowsTop = rowsTopBase + (withNote ? SHARED_NOTE_H : 0)
  const available = availableWith(withNote)

  const sharedLines: TextLine[] = []
  if (shared !== null) {
    const label = line(
      SHARED_HAZARD_LABEL,
      MAP_CONTENT_X,
      rowsTopBase + 1,
      LABEL_SIZE,
      // `caution` — this is the risky half of the card, stated once. Never `danger`:
      // nothing on a map can hurt anyone this instant (rule 3).
      Palette.caution,
      { weight: 600, tracking: 1.4 },
    )
    sharedLines.push(label)
    const tailX = label.x + label.width + 10
    sharedLines.push(
      line(
        // Truncated against what is actually beside it: a sector could name a hazard
        // long enough to push this off the card, and a price clipped by the card edge is
        // the failure this note exists to fix.
        truncateToWidth(`${shared} · ${SHARED_HAZARD_TAIL}`, CONTENT_RIGHT - tailX, SUB_SIZE, measure),
        tailX,
        rowsTopBase,
        SUB_SIZE,
        Palette.text,
      ),
    )
  }

  // Space left over once the rows and the pane have what they need is spread, in
  // this order and each capped: into the rows themselves, then between them, then as
  // a lead-in above the stack. Pooling it in any one place is what looks wrong —
  // inside the pane it made the hazard well a two-thirds-empty bordered box, and all
  // of it in the gaps made one canyon in the middle of the card. Same reasoning, and
  // roughly the same caps, as the choice card's option stack.
  //
  // Every term here is a function of the card as a whole, never of the selection, so
  // none of it moves when the cursor does.
  const rowCount = rowContents.length
  const gapCount = Math.max(1, rowCount - 1)
  const spare = (usedByRows: number): number =>
    Math.max(
      0,
      available -
        usedByRows -
        RULE_GAP -
        paneWanted -
        (showsPaneLabel(degrade) ? SUB_LH : 0),
    )

  const extraPad = rowCount > 0 ? Math.min(7, Math.floor(spare(stackHeight(degrade)) / (rowCount * 2))) : 0
  const rowPad = ROW_PAD + extraPad
  const rowH = rowHeight(degrade) + extraPad * 2
  // `spare` is asked what is left once the rows AND their base gaps are paid for.
  // Passing only the row heights double-spent `ROW_GAP` and handed the stack 15 units
  // the pane had already been promised, which showed up as a trimmed hazard brief.
  const gapSpare = spare(rowCount * rowH + Math.max(0, rowCount - 1) * ROW_GAP)
  const stackGap = ROW_GAP + (rowCount > 1 ? Math.min(24, Math.floor(gapSpare / gapCount)) : 0)
  const rowsH = rowCount * rowH + Math.max(0, rowCount - 1) * stackGap
  // Half of whatever is still unspent goes above the stack; the other half falls
  // between the last row and the pane, so the two gaps read as deliberate.
  const leadIn = Math.floor(spare(rowsH) / 2)

  const rows: RouteRowLayout[] = []
  let rowY = rowsTop + leadIn
  rowContents.forEach((content, index) => {
    const height = rowH
    const box: Rect = { x: MAP_CONTENT_X, y: rowY, w: MAP_CONTENT_W, h: height }
    const isSelected = index === selected
    const textX = box.x + ROW_PAD + CARET_GUTTER
    const right = box.x + box.w - ROW_PAD
    const lines: TextLine[] = []
    const nameColor = isSelected ? Palette.self : Palette.text

    let cursor = box.y + rowPad
    if (isSelected) {
      // A caret as well as the wash: selection never rests on colour alone.
      lines.push(line('>', box.x + ROW_PAD, cursor, TITLE_SIZE, nameColor, { weight: 700 }))
    }

    const name = line(content.title, textX, cursor, TITLE_SIZE, nameColor, { weight: 700 })
    lines.push(name)
    // The hazard count sits directly after the name, in `caution` when there is one
    // to accept. Never `danger` — nothing on a map can hurt anyone this instant.
    lines.push(
      line(
        content.tag,
        textX + name.width + 9,
        cursor + 3,
        SUB_SIZE,
        content.hazardCount > 0 ? Palette.caution : Palette.textDim,
      ),
    )

    // Reward chip owns the right edge, value then unit, both on the title line.
    const unit =
      content.chip.unit === ''
        ? null
        : line(` ${content.chip.unit}`, right, cursor + 3, LABEL_SIZE, Palette.textDim, {
            align: 'right',
          })
    if (unit) lines.push(unit)
    lines.push(
      line(
        content.chip.value,
        right - (unit?.width ?? 0),
        cursor,
        14,
        content.chip.pays ? Palette.good : Palette.textDim,
        { weight: 600, align: 'right' },
      ),
    )
    cursor += TITLE_H

    if (degrade <= 1) {
      // Hazard *names* on the row so the shape of every trade is visible at once;
      // the descriptions are in the pane for whichever row the cursor is on.
      lines.push(
        line(
          truncateToWidth(content.summary, ROUTE_ROW_TEXT_W, SUB_SIZE, measure),
          textX,
          cursor,
          SUB_SIZE,
          content.hazardCount > 0 ? Palette.text : Palette.textDim,
        ),
      )
    }

    rows.push({
      index,
      box,
      selected: isSelected,
      title: content.title,
      hazardTag: content.tag,
      hazardCount: content.hazardCount,
      rewardKind: content.route.reward.kind,
      rewardValue: content.chip.value,
      rewardUnit: content.chip.unit,
      accent: isSelected ? Palette.self : Palette.line,
      lines,
    })
    rowY += height + stackGap
  })

  // --- detail pane -----------------------------------------------------------
  //
  // Anchored to the footer and sized to the worst route ON THIS CARD, so it is a
  // fixed rectangle whichever row the cursor is on — but no larger than it needs.
  // Filling the pane to the rows instead put the leftover space inside the hazard
  // well, and with the one-hazard routes the builder actually produces that left a
  // bordered box two thirds empty. An empty gap between two groups reads as layout;
  // an empty bordered container reads as a broken widget.
  const paneFloor = rowsTop + leadIn + rowsH + (rowCount > 0 ? RULE_GAP : 0)
  const paneRoom = Math.max(0, footerTop - RULE_GAP - paneFloor)
  const paneH = Math.min(paneRoom, paneWanted + (showsPaneLabel(degrade) ? SUB_LH : 0))
  const paneBox: Rect = {
    x: MAP_CONTENT_X,
    y: footerTop - RULE_GAP - paneH,
    w: MAP_CONTENT_W,
    h: paneH,
  }
  const paneX = paneBox.x + PANE_PAD
  const paneRight = paneBox.x + paneBox.w - PANE_PAD
  const paneLines: TextLine[] = []
  const route = routes[selected]

  let paneY = paneBox.y + PANE_PAD
  const paneBottom = paneBox.y + paneBox.h - PANE_PAD
  if (showsPaneLabel(degrade)) {
    const briefLabel = line(BRIEF_LABEL, paneX, paneY, LABEL_SIZE, Palette.textFaint, {
      tracking: 2.2,
    })
    paneLines.push(briefLabel)
    if (route !== undefined) {
      paneLines.push(
        line(
          // The same string the row shows, so the pane is unmistakably about it.
          rowContents[selected]?.title ?? UNNAMED_ROUTE_TEXT,
          paneX + briefLabel.width + 10,
          paneY,
          LABEL_SIZE,
          Palette.self,
          { weight: 600, tracking: 1.4 },
        ),
      )
      paneLines.push(
        line(REWARD_WELL_LABEL, paneRight, paneY, LABEL_SIZE, Palette.textFaint, {
          align: 'right',
          tracking: 2.2,
        }),
      )
    }
    paneY += SUB_LH
  }

  let overflow = false

  // `rewardText` is the simulation's own one-sentence statement of the trade, with
  // its numbers already in it. It is wrapped and NOTHING else: rewriting it here
  // would mean the screen and the sim could describe different deals.
  const wrappedReward =
    route === undefined
      ? wrapText(NO_ROUTES_TEXT, ROUTE_PANE_TEXT_W, REWARD_TEXT_SIZE, measure)
      : wrapText(route.rewardText, ROUTE_PANE_TEXT_W, REWARD_TEXT_SIZE, measure)
  // Room held back for the well, so a runaway reward sentence cannot push the
  // hazards out of the pane entirely. `rewardText` is a *one-sentence* field;
  // anything that reaches this is a content bug, and `overflow` says so.
  const rewardRoom = Math.max(BODY_LH, paneBottom - paneY - 8 - minWellH)
  const maxRewardLines = Math.max(1, Math.floor(rewardRoom / BODY_LH))
  const rewardLines =
    wrappedReward.length > maxRewardLines
      ? wrappedReward.slice(0, maxRewardLines).map((text, index, all) =>
          index === all.length - 1 ? `${text}…` : text,
        )
      : wrappedReward
  if (rewardLines.length < wrappedReward.length) overflow = true
  for (const text of rewardLines) {
    paneLines.push(line(text, paneX, paneY, REWARD_TEXT_SIZE, Palette.text))
    paneY += BODY_LH
  }

  // The well starts below room for the LONGEST reward sentence on offer, not below
  // this one, and it runs to the bottom of the pane. Both edges are therefore the
  // same on every route, and the pane has no dead strip under it — an unexplained
  // empty third of a card reads as a screen that failed to load.
  const wellTop = Math.min(
    paneBox.y + PANE_PAD + (showsPaneLabel(degrade) ? SUB_LH : 0) +
      Math.min(rewardBlockLines, maxRewardLines) * BODY_LH +
      8,
    paneBottom - minWellH,
  )

  let hazardBox: Rect | null = null
  let hazards: readonly HazardBrief[] = []
  let trimmed = 0

  if (route !== undefined && wellTop >= paneY && paneBottom - wellTop >= minWellH) {
    const wellHeight = paneBottom - wellTop
    const lineBudget = Math.max(1, Math.floor((wellHeight - SUB_LH - WELL_PAD * 2) / SUB_LH))

    const briefs =
      route.hazards.length === 0
        ? [
            {
              name: '',
              lines: wrapText(NO_HAZARD_PANE_TEXT, HAZARD_TEXT_W, SUB_SIZE, measure),
            },
          ]
        : route.hazards.map((hazard) => ({
            name: hazard.name,
            lines: wrapText(hazard.description, HAZARD_TEXT_W, SUB_SIZE, measure),
          }))

    const fitted = fitHazards(briefs, lineBudget)
    hazards = fitted.hazards
    trimmed = fitted.trimmed
    overflow = overflow || fitted.overflow

    // Filled to the pane's bottom edge rather than hugging its content: a bordered
    // list with room to spare reads as a short list, which is true, where a bordered
    // list floating above 250 units of empty panel reads as a bug.
    hazardBox = { x: paneBox.x, y: wellTop, w: paneBox.w, h: wellHeight }

    let wellY = wellTop + WELL_PAD
    const hasHazards = route.hazards.length > 0
    paneLines.push(
      line(
        hasHazards ? HAZARD_WELL_LABEL : NO_HAZARD_WELL_LABEL,
        paneX,
        wellY,
        LABEL_SIZE,
        // `caution` is the palette's token for a risky choice, and accepting a hazard
        // is exactly that. It is a future cost, so it must not read as incoming fire.
        hasHazards ? Palette.caution : Palette.textDim,
        { weight: 600, tracking: 1.4 },
      ),
    )
    if (hasHazards) {
      paneLines.push(
        line(HAZARD_WELL_NOTE, paneRight, wellY, LABEL_SIZE, Palette.textDim, {
          align: 'right',
          tracking: 1.4,
        }),
      )
    }
    wellY += SUB_LH

    for (const brief of hazards) {
      if (brief.name !== '') {
        // Truncated, not wrapped: a name is an identifier, and a two-line identifier
        // makes the list harder to scan than a shortened one. The full name is on the
        // route's own row.
        paneLines.push(
          line(
            truncateToWidth(`· ${brief.name}`, ROUTE_PANE_TEXT_W, SUB_SIZE, measure, 600),
            paneX,
            wellY,
            SUB_SIZE,
            Palette.caution,
            { weight: 600 },
          ),
        )
        wellY += SUB_LH
      }
      for (const text of brief.lines) {
        // Full body colour: the description is the price of the route, and rule 4
        // does not let the price be the faint line.
        paneLines.push(
          line(
            text,
            paneX + (brief.name === '' ? 0 : BULLET_INDENT),
            wellY,
            SUB_SIZE,
            hasHazards ? Palette.text : Palette.textDim,
          ),
        )
        wellY += SUB_LH
      }
    }
  } else if (route !== undefined) {
    // No room for even a one-line well. Out of contract — the sim offers 2-3 routes
    // — but it must fail loudly rather than paint hazards over the footer.
    overflow = true
  }

  // --- footer ----------------------------------------------------------------
  footer.push(
    line(FOOTER_CONTROLS_LEFT, MAP_CONTENT_X, footerTop + 4, SUB_SIZE, Palette.textDim, {
      tracking: 0.6,
    }),
  )
  footer.push(
    line(FOOTER_CONTROLS_RIGHT, CONTENT_RIGHT, footerTop + 4, SUB_SIZE, Palette.textDim, {
      align: 'right',
      tracking: 0.6,
    }),
  )
  footer.push(
    line(FOOTER_HINT, MAP_CONTENT_X, footerTop + 4 + SUB_LH, LABEL_SIZE, Palette.textFaint),
  )

  // Slow, shallow, and never dark: ~0.86 Hz, opacity 0.07..0.21. Rule 10 is a hard
  // accessibility constraint, not a style preference.
  const tick = Number.isFinite(input.tick) ? input.tick : 0
  const pulse =
    (PULSE_MIN + PULSE_MAX) / 2 +
    ((PULSE_MAX - PULSE_MIN) / 2) * Math.sin(tick * PULSE_RADIANS_PER_TICK)

  return {
    card: { ...MAP_CARD },
    // Committing to a corridor puts something at risk, so the card's rule is
    // `caution` — the same accent the shop and work-order cards use, and for the same
    // reason. `danger` appears nowhere on this screen.
    accent: Palette.caution,
    // Near-opaque, matching the choice card: the paused playfield behind is
    // atmosphere, and this is a card the player has to read.
    scrim: 'rgba(5, 7, 11, 0.965)',
    selected,
    header,
    track: { box: trackBox, pips, lines: trackLines, flown, current: target, ahead },
    sharedHazard: shared === null ? null : { names: shared, lines: sharedLines },
    rows,
    detail: {
      box: paneBox,
      hazardBox,
      routeIndex: selected,
      rewardLines,
      hazards,
      lines: paneLines,
    },
    footer,
    rules,
    pulse,
    degrade,
    trimmed,
    overflow: overflow || paneBox.h <= 0,
  }
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

export interface WorldMapOptions {
  /**
   * Index the simulation's cursor is on. Owned by `World` so replays reproduce
   * picks; this screen renders it and never advances it.
   */
  selected: number
  /** Ticks the choice has been open, for the selection pulse. */
  tick: number
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

export function drawWorldMapLayout(
  ctx: CanvasRenderingContext2D,
  layout: WorldMapLayout,
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

  for (const pip of layout.track.pips) {
    ctx.fillStyle = pip.fill
    ctx.fillRect(pip.box.x, pip.box.y, pip.box.w, pip.box.h)
    ctx.strokeStyle = pip.stroke
    ctx.lineWidth = 1
    ctx.strokeRect(pip.box.x + 0.5, pip.box.y + 0.5, pip.box.w - 1, pip.box.h - 1)
    if (pip.marker) {
      ctx.fillStyle = Palette.self
      ctx.fillRect(pip.marker.x, pip.marker.y, pip.marker.w, pip.marker.h)
    }
  }
  paintLines(ctx, layout.track.lines)

  if (layout.sharedHazard) paintLines(ctx, layout.sharedHazard.lines)

  for (const row of layout.rows) {
    const { box } = row
    ctx.fillStyle = Palette.panelRaised
    ctx.fillRect(box.x, box.y, box.w, box.h)

    if (row.selected) {
      // Alpha via globalAlpha rather than an rgba string, so the wash is always
      // exactly the accent token and no colour is hardcoded here.
      ctx.globalAlpha = Math.max(PULSE_MIN, layout.pulse)
      ctx.fillStyle = row.accent
      ctx.fillRect(box.x, box.y, box.w, box.h)
      ctx.globalAlpha = 1
      // A solid left stripe as well as the wash, so the selected row is still
      // obvious in a monochrome screenshot.
      ctx.fillRect(box.x, box.y, 3, box.h)
    }

    ctx.strokeStyle = row.accent
    ctx.lineWidth = 1
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)
    paintLines(ctx, row.lines)
  }

  const pane = layout.detail.box
  ctx.fillStyle = Palette.panelRaised
  ctx.fillRect(pane.x, pane.y, pane.w, pane.h)
  ctx.strokeStyle = Palette.line
  ctx.lineWidth = 1
  ctx.strokeRect(pane.x + 0.5, pane.y + 0.5, pane.w - 1, pane.h - 1)

  const well = layout.detail.hazardBox
  if (well) {
    ctx.fillStyle = Palette.panel
    ctx.fillRect(well.x, well.y, well.w, well.h)
    // A caution stripe, the same device the choice screen uses for a synergy well.
    ctx.fillStyle = layout.detail.hazards.some((brief) => brief.name !== '')
      ? Palette.caution
      : Palette.line
    ctx.fillRect(well.x, well.y, 2, well.h)
  }
  paintLines(ctx, layout.detail.lines)

  paintLines(ctx, layout.footer)
}

/**
 * Draw the route choice for the run's open decision.
 *
 * Reads the selection from `opts`, which the caller takes from
 * `world.choiceSelection` — the simulation's cursor, the one a replay reproduces.
 * No-ops when the pending choice is not a route, so the caller can dispatch blindly.
 */
export function drawWorldMap(
  ctx: CanvasRenderingContext2D,
  view: WorldView,
  opts: WorldMapOptions,
): void {
  const choice = view.pendingChoice
  if (choice === null || choice.kind !== 'route') return

  const layout = layoutWorldMap({
    routes: choice.routes,
    stage: view.stage,
    selected: opts.selected,
    tick: opts.tick,
    // Measured against the real font, so wrapping is exact rather than estimated.
    measure: (text, size, weight, tracking) =>
      measureText(ctx, text, {
        size,
        ...(weight ? { weight } : {}),
        ...(tracking ? { tracking } : {}),
      }),
  })
  drawWorldMapLayout(ctx, layout)
}
