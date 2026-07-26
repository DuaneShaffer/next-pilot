/**
 * Personnel files — the browsable list, and the game's writing surface.
 *
 * `docs/DESIGN.md` calls this "a run history that doubles as the game's writing
 * surface — a browsable list of institutional indifference." So this screen has two
 * jobs that pull in opposite directions, and the resolution is fixed:
 *
 * **The tone is deadpan institutional and it lives ONLY in the paperwork.** The
 * eyebrow, the retention notice, the closing remarks on a file, and the empty state
 * carry the voice. The cause of loss, every number, every label, and every unit are
 * written to be read at a glance by someone checking what killed them — UI rule 4,
 * clarity wins outright. `CAUSE_TEXT` below is deliberately the same wording the
 * incident report uses, because a pilot who read "Collision with hostile hull" on
 * the death screen must find that exact phrase in the file, not a synonym.
 *
 * **The voice is the incident report's, not a second one.** `FILE_REMARKS` matches
 * `REMARKS` in `src/ui/incidentReport.ts` in register. The one difference is point
 * of view: the incident report is filed at the moment of loss, these are annotations
 * added later by whoever processed the file, which is why they can be about the
 * *paperwork* rather than about the pilot.
 *
 * ## Layout is pure and pre-measured
 *
 * `layoutPersonnelScreen` returns every rect and every positioned, measured
 * `TextLine`; only `drawPersonnelScreen` touches a canvas. That is the same split
 * `src/ui/choiceScreen.ts` uses, and it exists because a string drawn as one
 * unmeasured line has already shipped as a bug in this project (the pause menu's
 * longest hint ran off the card). Every authored string here is either wrapped with
 * `wrapText` or truncated with `truncateToWidth`, and `tests/personnel.test.ts`
 * asserts the drawn bounds of every line against the box it sits in, using the
 * widths exported from this module rather than restated numbers.
 *
 * ## Purist status is never drawn from a stored flag
 *
 * The badge on a row comes from `verifyPurist` against the base pool the *caller*
 * supplies, so a record cannot claim to be purist. See `src/meta/purist.ts`.
 */

import { formatSeed } from '../core/seed'
import { VIRTUAL_H, VIRTUAL_W } from '../core/space'
import type { DeathCauseKind } from '../sim/entities'
import {
  PERSONNEL_HISTORY_CAP,
  personnelAccuracy,
  personnelFileNumber,
  personnelSeconds,
  type PersonnelRecord,
} from '../meta/personnel'
import {
  describePuristVerdict,
  puristBadge,
  verifyPurist,
  type PuristVerdict,
  type RunPool,
} from '../meta/purist'
import { Palette } from '../render/palette'
import { canvasMeasure, drawText, wrapText, type Measure } from '../render/text'
import {
  lineBounds,
  monoMeasure,
  truncateToWidth,
  type Rect,
  type TextLine,
} from './choiceScreen'

/**
 * Re-exported so a test asserting this screen's containment uses this screen's own
 * measure and bounds helper rather than importing a sibling's. The helpers live in
 * `choiceScreen.ts` because that is where the layout-as-data idiom was established;
 * duplicating a measurement estimator would be how the two screens drift apart.
 */
export { lineBounds, monoMeasure, truncateToWidth }
export type { Rect, TextLine }

// ---------------------------------------------------------------------------
// layout constants — imported by tests, never restated there
// ---------------------------------------------------------------------------

const CARD = { x: 16, y: 10, w: 608, h: 700 } as const
const PAD = 18

export const PERSONNEL_CARD_W = CARD.w
export const PERSONNEL_CONTENT_W = CARD.w - PAD * 2
const CONTENT_X = CARD.x + PAD
const CONTENT_RIGHT = CONTENT_X + PERSONNEL_CONTENT_W

/** A row's own inner padding, and the gutter the caret and scrollbar occupy. */
const ROW_PAD = 10
const CARET_GUTTER = 14
const SCROLLBAR_W = 4
const SCROLLBAR_GAP = 6

export const PERSONNEL_ROW_H = 46
export const PERSONNEL_ROW_GAP = 4
/**
 * Rows on screen at once.
 *
 * Nine, from the space left over rather than chosen: the card is a fixed 700 units,
 * the controls line is anchored to its bottom edge, and the footer above it has to
 * hold the retention notice plus — on a bad day — a destroyed-files line and an
 * unreadable-records line. Ten rows fit right up until both of those appear at once,
 * which is precisely the day the screen must still be readable.
 */
export const PERSONNEL_ROWS_VISIBLE = 9

/**
 * Usable text width inside one row.
 *
 * The row is inset from the content column by the caret gutter and the scrollbar,
 * and padded on both sides. A test that restated this as a literal would be testing
 * its own arithmetic — the exact mistake `tests/textFits.test.ts` documents.
 */
export const PERSONNEL_ROW_W =
  PERSONNEL_CONTENT_W - CARET_GUTTER - SCROLLBAR_W - SCROLLBAR_GAP
export const PERSONNEL_ROW_TEXT_W = PERSONNEL_ROW_W - ROW_PAD * 2
/** Text column in the detail view. Full content width; nothing is inset there. */
export const PERSONNEL_DETAIL_TEXT_W = PERSONNEL_CONTENT_W

/**
 * Lines the fitted-systems section may occupy in the detail view.
 *
 * Four. A record holds up to `PERSONNEL_ITEM_CAP` items, and at sixteen long names
 * the list alone would run past the closing remark and then past the controls. Same
 * reasoning as the incident report's three certification slots.
 */
export const PERSONNEL_ITEM_LINES = 4

const EYEBROW_SIZE = 11
const TITLE_SIZE = 24
const SUB_SIZE = 12
const FILE_SIZE = 11
const CAUSE_SIZE = 13
const STAT_SIZE = 12
const LABEL_SIZE = 12
const VALUE_SIZE = 14
const REMARK_SIZE = 12
const FOOTER_SIZE = 11
const LINE_H = 15
/** Tracking on the file-number line. Wide tracking reads as an instrument label. */
const IDENTITY_TRACKING = 1
/** Clear air between the notices and the controls line. */
const FOOTER_GAP = 8

// ---------------------------------------------------------------------------
// authored copy
// ---------------------------------------------------------------------------

/**
 * Cause of loss, in institutional language.
 *
 * MUST MATCH `CAUSE_TEXT` in `src/ui/incidentReport.ts` word for word. It is
 * restated rather than imported because that table is not exported and this screen
 * should not force it to be; the constraint is a review one, and the wording is
 * short enough that a diff is obvious. This is functional text — no jokes.
 */
const CAUSE_TEXT: Readonly<Record<DeathCauseKind, string>> = {
  'enemy-fire': 'Hostile fire',
  collision: 'Collision with hostile hull',
  hazard: 'Environmental hazard',
}

/** Shown when a lost run has no attributable cause. Matches the death screen. */
const UNATTRIBUTED = 'Unattributed'
/** Shown for a cleared run. Matches the extraction report's outcome line. */
const EXTRACTED_TEXT = 'Hull recovered — corridor cleared'

export const PERSONNEL_EYEBROW = 'Salvage Division // Personnel Files'
export const PERSONNEL_TITLE = 'PERSONNEL FILES'

/**
 * The subtitle, and the first place the voice appears.
 *
 * Not functional: it says nothing a player needs, which is exactly why it is
 * allowed to be funny. The controls are in the footer where they can be found.
 */
export const PERSONNEL_SUBTITLE =
  'Completed sorties, most recent first. Retained for reference; no action is planned.'

/**
 * The retention rule, stated on screen.
 *
 * The cap is not negotiable (see `PERSONNEL_HISTORY_CAP`) but hiding it is: a player
 * who scrolls to the bottom and finds their first pilot missing, with nothing
 * anywhere saying that could happen, has been lied to by omission. So the number is
 * printed. The second sentence is the joke; the first is the fact.
 */
export const PERSONNEL_RETENTION_TEXT =
  `Records are retained for the last ${PERSONNEL_HISTORY_CAP} pilots. ` +
  'Older files are destroyed on filing, which Requisition considers a saving.'

/** Appended when this session's filing actually evicted something. Plain count first. */
export function personnelDroppedText(dropped: number): string {
  if (dropped <= 0) return ''
  const plural = dropped === 1 ? 'file' : 'files'
  return `${dropped} earlier ${plural} destroyed under the retention schedule.`
}

/** Corrupt entries. Functional: it tells the player data is gone, so no joke. */
export function personnelSkippedText(skipped: number): string {
  if (skipped <= 0) return ''
  const plural = skipped === 1 ? 'record was' : 'records were'
  return `${skipped} stored ${plural} unreadable and have been left out of this list.`
}

export const PERSONNEL_EMPTY_LINES: readonly string[] = [
  'No files on record.',
  'The roster is short and the corridor is not. Fly a sortie and it will fill.',
]

export const PERSONNEL_LIST_FOOTER = 'UP/DOWN browse · ENTER opens the file · ESC returns'
export const PERSONNEL_DETAIL_FOOTER = 'ESC returns to the list'

/**
 * Closing remarks on a lost pilot's file.
 *
 * Flavour, and the only place on this screen it is allowed. Same register as
 * `REMARKS` in the incident report, but written from the archive rather than from
 * the scene — these are what a clerk added afterwards, which is why the subject is
 * the paperwork and not the pilot.
 *
 * Selected by the record's own numbers so a given file always shows the same
 * remark: a line that reshuffles per frame reads as a bug, and one that reshuffles
 * per open makes screenshots non-comparable.
 */
export const FILE_REMARKS: ReadonlyArray<readonly string[]> = [
  [
    'Reviewed. No procedural changes are recommended.',
    'The corridor remains listed as viable.',
  ],
  [
    'Hazard pay dispute closed for want of a claimant.',
    'Filed under resolved.',
  ],
  [
    'Equipment recovered: none. Equipment written off: all of it.',
    'The ledger was balanced by rounding.',
  ],
  [
    'File retained for training purposes.',
    'No training has been scheduled, and none is anticipated.',
  ],
  [
    'Performance rated ADEQUATE on review. The rating stands.',
    'Appeals were not made available to the appellant.',
  ],
]

/**
 * Closing remarks on a pilot who came home.
 *
 * A separate table for the same reason the incident report keeps
 * `EXTRACTION_REMARKS` separate: every line above presumes a corpse, and filing
 * "for want of a claimant" against a living pilot is the same class of misreport as
 * stamping a cleared run TOTAL LOSS.
 */
export const EXTRACTION_FILE_REMARKS: ReadonlyArray<readonly string[]> = [
  [
    'Hull returned. Pilot returned. Both within tolerance.',
    'Neither is commended.',
  ],
  [
    'Recovered materiel credited against the hull lease.',
    'The lease continues.',
  ],
  [
    'Rated SATISFACTORY on review. Satisfactory is the target.',
    'Exceeding the target is not rewarded and is mildly discouraged.',
  ],
  [
    'Retained on the active roster pending the next corridor.',
    'The next corridor is always pending.',
  ],
]

/** Deterministic remark for a file. Keyed off stored numbers, never a clock. */
export function remarkFor(record: PersonnelRecord): readonly string[] {
  const pool = record.outcome === 'extracted' ? EXTRACTION_FILE_REMARKS : FILE_REMARKS
  // Both terms so two runs with the same tick count still differ, and so the
  // selection is stable for one record forever.
  const index = (record.ticks + record.pilotNumber) % pool.length
  return pool[index] ?? []
}

// ---------------------------------------------------------------------------
// formatting — shared with the incident report's conventions
// ---------------------------------------------------------------------------

/** `tally-turret` becomes `Tally Turret`. Only used when a name is not supplied. */
function prettifyId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Thousands grouped by hand rather than with `toLocaleString`.
 *
 * Locale formatting renders the same run differently on two machines, which breaks
 * screenshot comparison for no benefit at these magnitudes. Same reasoning, and the
 * same implementation, as the incident report.
 */
function groupDigits(value: number): string {
  const whole = Math.abs(Math.round(value))
  const digits = String(whole)
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return value < 0 ? `-${out}` : out
}

/** Both units present, so `3 m 12 s` cannot be read as 3.12 of anything. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return minutes > 0 ? `${minutes} m ${rest} s` : `${rest} s`
}

/**
 * Accuracy for display.
 *
 * An em dash when nothing was fired, matching the incident report and the
 * instrument panel exactly. `0 %` would be a different claim — that every round
 * missed — and two screens disagreeing about the same run is worse than either
 * answer alone.
 */
export function formatAccuracy(record: PersonnelRecord): { value: string; unit: string } {
  const accuracy = personnelAccuracy(record)
  return accuracy === null ? { value: '—', unit: '' } : { value: String(accuracy), unit: '%' }
}

export interface PersonnelNames {
  readonly hulls?: Readonly<Record<string, string>> | undefined
  readonly enemies?: Readonly<Record<string, string>> | undefined
  readonly items?: Readonly<Record<string, string>> | undefined
  readonly sectors?: Readonly<Record<string, string>> | undefined
}

function nameOf(
  table: Readonly<Record<string, string>> | undefined,
  id: string,
): string {
  return table?.[id] ?? prettifyId(id)
}

/**
 * The cause line: the one thing a player opens a file to read.
 *
 * Functional text, so it is the incident report's wording verbatim and carries no
 * flavour at all.
 */
export function causeLine(record: PersonnelRecord, names: PersonnelNames = {}): string {
  if (record.outcome === 'extracted') return EXTRACTED_TEXT
  if (record.causeKind === null) return UNATTRIBUTED
  const base = CAUSE_TEXT[record.causeKind]
  if (record.causeEnemyId === null) return base
  return `${base} — ${nameOf(names.enemies, record.causeEnemyId)}`
}

/** The dim numeric summary on a list row. Every value carries its unit (rule 2). */
export function rowStatsText(record: PersonnelRecord): string {
  return `wave ${groupDigits(record.waveIndex)} · ${formatDuration(personnelSeconds(record))}`
}

// ---------------------------------------------------------------------------
// selection and scrolling — pure
// ---------------------------------------------------------------------------

/**
 * Move the selection.
 *
 * CLAMPS rather than wraps, unlike the pause menu. Six rows traverse faster
 * circularly; fifty do not, and a down-press that jumps from the oldest file to the
 * newest reads as the list having reset itself.
 */
export function movePersonnelSelection(selected: number, delta: number, count: number): number {
  if (count <= 0) return 0
  const next = Math.trunc(Number.isFinite(selected) ? selected : 0) + Math.trunc(delta)
  return Math.max(0, Math.min(count - 1, next))
}

/**
 * Smallest scroll offset that keeps the selection on screen.
 *
 * Derived from the selection rather than tracked alongside it: two pieces of state
 * that must agree are two pieces of state that eventually do not, and the failure
 * mode is a highlighted row nobody can see.
 */
export function personnelScrollFor(
  selected: number,
  scroll: number,
  count: number,
  rows: number = PERSONNEL_ROWS_VISIBLE,
): number {
  if (count <= rows) return 0
  const maxScroll = count - rows
  let next = Math.max(0, Math.min(maxScroll, Math.trunc(Number.isFinite(scroll) ? scroll : 0)))
  if (selected < next) next = selected
  if (selected > next + rows - 1) next = selected - rows + 1
  return Math.max(0, Math.min(maxScroll, next))
}

// ---------------------------------------------------------------------------
// layout model
// ---------------------------------------------------------------------------

export type PersonnelView = 'list' | 'detail'

export interface PersonnelLayoutInput {
  /** Newest first. Use `newestFirst()` from `src/meta/personnel.ts`. */
  readonly records: readonly PersonnelRecord[]
  readonly selected: number
  readonly scroll: number
  readonly view: PersonnelView
  /** Ticks the screen has been open, for the selection pulse. */
  readonly tick: number
  /**
   * The base pool of THIS build, for deriving purist status. See purist.ts: the
   * reference point must belong to the verifier, never to the record.
   */
  readonly basePool: RunPool
  /** Display names for ids, so this screen never imports the content tables. */
  readonly names?: PersonnelNames | undefined
  /** Unreadable stored entries, reported by `sanitizePersonnelHistory`. */
  readonly skipped?: number | undefined
  /** Files the cap evicted this session, reported by `appendPersonnelRecord`. */
  readonly dropped?: number | undefined
  readonly measure: Measure
  readonly simVersion?: number | undefined
}

export interface PersonnelRowLayout {
  readonly box: Rect
  readonly selected: boolean
  readonly accent: string
  readonly record: PersonnelRecord
  readonly lines: readonly TextLine[]
}

export interface PersonnelScreenLayout {
  readonly scrim: string
  readonly card: Rect
  readonly accent: string
  readonly rules: readonly Rect[]
  readonly header: readonly TextLine[]
  readonly listBox: Rect
  readonly rows: readonly PersonnelRowLayout[]
  readonly scrollbar: { readonly track: Rect; readonly thumb: Rect } | null
  /** Populated in the detail view only. */
  readonly detail: readonly TextLine[]
  readonly footer: readonly TextLine[]
  /** Selection wash alpha. A slow pulse that never reaches zero — rule 10. */
  readonly pulse: number
}

interface LineOptions {
  size?: number
  weight?: 400 | 600 | 700
  color?: string
  align?: 'left' | 'right' | 'center'
  tracking?: number
}

function makeLine(
  measure: Measure,
  text: string,
  x: number,
  y: number,
  options: LineOptions = {},
): TextLine {
  const size = options.size ?? STAT_SIZE
  const weight = options.weight ?? 400
  const tracking = options.tracking ?? 0
  return {
    text,
    x,
    y,
    size,
    weight,
    color: options.color ?? Palette.text,
    align: options.align ?? 'left',
    tracking,
    width: measure(text, size, weight, tracking),
  }
}

/**
 * A measure that always includes a fixed tracking.
 *
 * `truncateToWidth` calls its measure without a tracking argument, so a string drawn
 * with wide tracking gets truncated against its *untracked* width — and this screen's
 * file-number line is tracked at 1, which on a 65-character line is 64 units of
 * unaccounted advance. It fit the row and ran straight into the outcome tag beside
 * it. Tracking is part of a string's width and has to be measured as such.
 */
function trackedMeasure(measure: Measure, tracking: number): Measure {
  return (text, size, weight, extra = 0) => measure(text, size, weight, tracking + extra)
}

/** The outcome tag. Colour agrees with the outcome, and the word carries it alone. */
function outcomeTag(record: PersonnelRecord): { text: string; color: string } {
  return record.outcome === 'extracted'
    ? { text: 'EXTRACTED', color: Palette.good }
    : { text: 'LOST', color: Palette.danger }
}

function verdictFor(input: PersonnelLayoutInput, record: PersonnelRecord): PuristVerdict {
  return verifyPurist(record, input.basePool, { simVersion: input.simVersion })
}

/** Badge colour. The word is the information; colour only reinforces it (rule 3). */
function badgeColor(verdict: PuristVerdict): string {
  switch (verdict.kind) {
    case 'purist':
      return Palette.textDim
    case 'refuted':
      return Palette.caution
    case 'expanded':
    case 'unverifiable':
      return Palette.textFaint
  }
}

function layoutRow(
  input: PersonnelLayoutInput,
  record: PersonnelRecord,
  box: Rect,
  selected: boolean,
): PersonnelRowLayout {
  const measure = input.measure
  const lines: TextLine[] = []
  const left = box.x + ROW_PAD
  // Both derived from the exported width rather than recomputed from the box, so the
  // constant a test measures against is the constant the layout actually uses. A
  // parallel derivation that happens to agree is not a single source of truth: the
  // test then verifies its own copy of the arithmetic.
  const textW = PERSONNEL_ROW_TEXT_W
  const right = left + textW

  // Line 1: the file number and hull on the left, the outcome on the right.
  const tag = outcomeTag(record)
  const tagLine = makeLine(measure, tag.text, right, box.y + 8, {
    size: FILE_SIZE,
    weight: 600,
    tracking: 1.4,
    color: tag.color,
    align: 'right',
  })
  const identity = `FILE ${personnelFileNumber(record)} · ${nameOf(
    input.names?.hulls,
    record.hullId,
  ).toUpperCase()}`
  lines.push(
    makeLine(
      measure,
      truncateToWidth(
        identity,
        textW - tagLine.width - 12,
        FILE_SIZE,
        trackedMeasure(measure, IDENTITY_TRACKING),
      ),
      left,
      box.y + 8,
      { size: FILE_SIZE, tracking: IDENTITY_TRACKING, color: Palette.textFaint },
    ),
  )
  lines.push(tagLine)

  // Line 2: cause of loss, the reason this row exists, with the depth and duration
  // right-aligned beside it. Truncated against the *measured* width of the stats,
  // so a long enemy name shortens rather than collides.
  const stats = makeLine(measure, rowStatsText(record), right, box.y + 25, {
    size: STAT_SIZE,
    color: Palette.textDim,
    align: 'right',
  })
  const cause = causeLine(record, input.names ?? {})
  lines.push(
    makeLine(
      measure,
      truncateToWidth(cause, textW - stats.width - 12, CAUSE_SIZE, measure, 600),
      left,
      box.y + 24,
      {
        size: CAUSE_SIZE,
        weight: 600,
        color: record.outcome === 'extracted' ? Palette.good : Palette.danger,
      },
    ),
  )
  lines.push(stats)

  return {
    box,
    selected,
    accent: selected ? Palette.self : Palette.line,
    record,
    lines,
  }
}

/** Label left, value and unit right — the incident report's row, same conventions. */
function detailEntry(
  measure: Measure,
  out: TextLine[],
  y: number,
  label: string,
  value: string,
  unit = '',
  valueColor: string = Palette.text,
): number {
  out.push(
    makeLine(measure, label.toUpperCase(), CONTENT_X, y + 2, {
      size: LABEL_SIZE,
      tracking: 1.4,
      color: Palette.textDim,
    }),
  )
  const unitLine = unit
    ? makeLine(measure, unit, CONTENT_RIGHT, y + 3, {
        size: Math.max(11, VALUE_SIZE - 3),
        color: Palette.textDim,
        align: 'right',
      })
    : null
  const valueX = unitLine ? CONTENT_RIGHT - unitLine.width - 4 : CONTENT_RIGHT
  out.push(
    makeLine(measure, value, valueX, y, {
      size: VALUE_SIZE,
      weight: 600,
      color: valueColor,
      align: 'right',
    }),
  )
  if (unitLine) out.push(unitLine)
  return y + 22
}

interface ProseOptions extends LineOptions {
  /**
   * Hard line budget.
   *
   * Used for the sections that can grow without bound — a build is up to
   * `PERSONNEL_ITEM_CAP` names long. The incident report learned this the same way:
   * a section with no ceiling eventually pushes the element below it off a
   * fixed-height card, and the element below here is the closing remark, then the
   * controls. The last kept line ends in an ellipsis so the reader knows.
   */
  maxLines?: number
  width?: number
}

/** Wrapped prose. Every multi-word string on this screen goes through here. */
function detailProse(
  measure: Measure,
  out: TextLine[],
  y: number,
  text: string,
  options: ProseOptions = {},
): number {
  const size = options.size ?? REMARK_SIZE
  const weight = options.weight ?? 400
  const width = options.width ?? PERSONNEL_DETAIL_TEXT_W
  const wrapped = wrapText(text, width, size, measure, weight)
  const budget = options.maxLines ?? wrapped.length
  const kept = wrapped.slice(0, Math.max(1, budget))
  let cursor = y
  kept.forEach((wrappedLine, index) => {
    const clipped =
      index === kept.length - 1 && kept.length < wrapped.length
        ? truncateToWidth(`${wrappedLine} …`, width, size, measure, weight)
        : wrappedLine
    out.push(makeLine(measure, clipped, CONTENT_X, cursor, options))
    cursor += size + 4
  })
  return cursor
}

export function layoutPersonnelScreen(input: PersonnelLayoutInput): PersonnelScreenLayout {
  const measure = input.measure
  const count = input.records.length
  const selected = count > 0 ? movePersonnelSelection(input.selected, 0, count) : 0
  const scroll = personnelScrollFor(selected, input.scroll, count)
  const detailView = input.view === 'detail' && count > 0
  const record = input.records[selected]

  const header: TextLine[] = []
  const detail: TextLine[] = []
  const rows: PersonnelRowLayout[] = []
  const rules: Rect[] = []
  const footer: TextLine[] = []

  let y = CARD.y + PAD
  header.push(
    makeLine(measure, PERSONNEL_EYEBROW, CONTENT_X, y, {
      size: EYEBROW_SIZE,
      tracking: 2,
      color: Palette.textDim,
    }),
  )
  y += 20
  header.push(
    makeLine(measure, detailView ? 'PILOT FILE' : PERSONNEL_TITLE, CONTENT_X, y, {
      size: TITLE_SIZE,
      weight: 700,
      tracking: 3,
    }),
  )

  // Right of the title: the position in the list, so scrolling has a readout.
  if (count > 0) {
    header.push(
      makeLine(measure, `${selected + 1} / ${count}`, CONTENT_RIGHT, y + 6, {
        size: SUB_SIZE,
        weight: 600,
        color: Palette.textDim,
        align: 'right',
      }),
    )
  }
  y += TITLE_SIZE + 10

  if (detailView && record) {
    header.push(
      makeLine(measure, `FILE ${personnelFileNumber(record)}`, CONTENT_X, y, {
        size: SUB_SIZE,
        tracking: 1,
        color: Palette.textFaint,
      }),
    )
    y += 20
  } else {
    // The subtitle wraps: it is the longest authored string on the screen and the
    // one most likely to be rewritten, which is exactly the shape of string that
    // has run off a card here before.
    y = detailProse(
      measure,
      header,
      y,
      PERSONNEL_SUBTITLE,
      { size: SUB_SIZE, color: Palette.textDim },
    )
    y += 4
  }

  rules.push({ x: CONTENT_X, y, w: PERSONNEL_CONTENT_W, h: 1 })
  y += 12

  const listTop = y
  const listBox: Rect = {
    x: CONTENT_X,
    y: listTop,
    w: PERSONNEL_CONTENT_W,
    h: PERSONNEL_ROWS_VISIBLE * (PERSONNEL_ROW_H + PERSONNEL_ROW_GAP),
  }

  let scrollbar: { track: Rect; thumb: Rect } | null = null

  if (detailView && record) {
    const verdict = verdictFor(input, record)
    const seconds = personnelSeconds(record)
    let dy = listTop

    // Cause of loss first and largest: it is what the file is about. Colour agrees
    // with the outcome, and the words say it too.
    detail.push(
      makeLine(
        measure,
        record.outcome === 'extracted' ? 'OUTCOME' : 'CAUSE OF LOSS',
        CONTENT_X,
        dy,
        { size: LABEL_SIZE, tracking: 1.4, color: Palette.textDim },
      ),
    )
    dy += 18
    dy = detailProse(
      measure,
      detail,
      dy,
      causeLine(record, input.names ?? {}),
      {
        size: 17,
        weight: 600,
        color: record.outcome === 'extracted' ? Palette.good : Palette.danger,
      },
    )
    dy += 8

    rules.push({ x: CONTENT_X, y: dy, w: PERSONNEL_CONTENT_W, h: 1 })
    dy += 14

    dy = detailEntry(measure, detail, dy, 'Pilot', `#${String(record.pilotNumber).padStart(3, '0')}`)
    dy = detailEntry(
      measure,
      detail,
      dy,
      'Hull',
      nameOf(input.names?.hulls, record.hullId).toUpperCase(),
    )
    dy = detailEntry(measure, detail, dy, 'Sector', nameOf(input.names?.sectors, record.sectorId))
    dy = detailEntry(
      measure,
      detail,
      dy,
      'Wave reached',
      groupDigits(record.waveIndex),
      'waves released',
    )
    dy = detailEntry(measure, detail, dy, 'Time logged', formatDuration(seconds))
    dy = detailEntry(measure, detail, dy, 'Kills', groupDigits(record.kills), 'confirmed')
    dy = detailEntry(
      measure,
      detail,
      dy,
      'Scrap recovered',
      groupDigits(record.scrap),
      'cr',
      Palette.caution,
    )
    const accuracy = formatAccuracy(record)
    dy = detailEntry(measure, detail, dy, 'Accuracy', accuracy.value, accuracy.unit)
    // Label and unit both agree with the ORDER of the numbers, which the incident
    // report got wrong once: "240 / 1,486 hits" read as 240 rounds fired.
    dy = detailEntry(
      measure,
      detail,
      dy,
      'Rounds on target',
      `${groupDigits(record.hits)} / ${groupDigits(record.shotsFired)}`,
      'fired',
      Palette.textDim,
    )
    dy = detailEntry(measure, detail, dy, 'Seed', formatSeed(record.seed), '', Palette.self)

    dy += 6
    rules.push({ x: CONTENT_X, y: dy, w: PERSONNEL_CONTENT_W, h: 1 })
    dy += 14

    detail.push(
      makeLine(measure, 'SYSTEMS FITTED', CONTENT_X, dy, {
        size: LABEL_SIZE,
        tracking: 1.4,
        color: Palette.textDim,
      }),
    )
    dy += 18
    if (record.items.length === 0) {
      dy = detailProse(measure, detail, dy, 'None fitted.', {
        size: STAT_SIZE,
        color: Palette.textFaint,
      })
    } else {
      const fitted = record.items
        .map((holding) => {
          const name = nameOf(input.names?.items, holding.id)
          return holding.count > 1 ? `${name} ×${holding.count}` : name
        })
        .join(' · ')
      const trailing =
        record.itemsOmitted > 0 ? ` · +${record.itemsOmitted} not recorded` : ''
      dy = detailProse(measure, detail, dy, `${fitted}${trailing}`, {
        size: STAT_SIZE,
        color: Palette.text,
        maxLines: PERSONNEL_ITEM_LINES,
      })
    }

    dy += 10
    detail.push(
      makeLine(measure, 'RECORD STATUS', CONTENT_X, dy, {
        size: LABEL_SIZE,
        tracking: 1.4,
        color: Palette.textDim,
      }),
    )
    const badge = puristBadge(verdict)
    if (badge) {
      detail.push(
        makeLine(measure, badge, CONTENT_RIGHT, dy, {
          size: SUB_SIZE,
          weight: 600,
          tracking: 1.2,
          color: badgeColor(verdict),
          align: 'right',
        }),
      )
    }
    dy += 18
    // Functional: a player reading this is asking whether their score counts, so it
    // is plain, wrapped, and never a joke.
    dy = detailProse(measure, detail, dy, describePuristVerdict(verdict), {
      size: STAT_SIZE,
      color: Palette.textDim,
    })

    // The closing remark: flavour, visually subordinate, and the last thing to be
    // laid out so it is the first thing that would be pushed off the card.
    dy += 12
    for (const remarkLine of remarkFor(record)) {
      dy = detailProse(measure, detail, dy, remarkLine, {
        size: REMARK_SIZE,
        color: Palette.textFaint,
      })
    }
  } else if (count === 0) {
    let dy = listTop
    for (const emptyLine of PERSONNEL_EMPTY_LINES) {
      dy = detailProse(measure, detail, dy, emptyLine, {
        size: SUB_SIZE,
        color: Palette.textFaint,
      })
      dy += 4
    }
  } else {
    const rowW = PERSONNEL_ROW_W
    const rowX = CONTENT_X + CARET_GUTTER
    const visible = Math.min(PERSONNEL_ROWS_VISIBLE, count - scroll)
    for (let i = 0; i < visible; i++) {
      const index = scroll + i
      const entry = input.records[index]
      if (!entry) continue
      const box: Rect = {
        x: rowX,
        y: listTop + i * (PERSONNEL_ROW_H + PERSONNEL_ROW_GAP),
        w: rowW,
        h: PERSONNEL_ROW_H,
      }
      rows.push(layoutRow(input, entry, box, index === selected))
    }

    if (count > PERSONNEL_ROWS_VISIBLE) {
      // A real scrollbar, not a hint: a list that scrolls without saying how far it
      // goes leaves the player unable to tell 12 files from 50.
      const trackX = CONTENT_RIGHT - SCROLLBAR_W
      const trackH = listBox.h
      const thumbH = Math.max(24, Math.round((PERSONNEL_ROWS_VISIBLE / count) * trackH))
      const travel = trackH - thumbH
      const maxScroll = count - PERSONNEL_ROWS_VISIBLE
      const thumbY = listTop + Math.round((scroll / maxScroll) * travel)
      scrollbar = {
        track: { x: trackX, y: listTop, w: SCROLLBAR_W, h: trackH },
        thumb: { x: trackX, y: thumbY, w: SCROLLBAR_W, h: thumbH },
      }
    }
  }

  // Footer band, laid out BOTTOM-UP.
  //
  // The controls line is anchored to the card's bottom edge — it is the one thing on
  // this screen a player always needs to find — and the notices are stacked upward
  // from it. Laying them downward from a fixed top was the first attempt and it put
  // the last notice past the card edge on the one screen that shows all three
  // (retention plus destroyed files plus unreadable records), because the band's
  // height depends on how much went wrong.
  const controlsY = CARD.y + CARD.h - PAD - FOOTER_SIZE
  if (!detailView) {
    const notices: Array<{ text: string; color: string }> = [
      { text: PERSONNEL_RETENTION_TEXT, color: Palette.textFaint },
    ]
    const droppedText = personnelDroppedText(input.dropped ?? 0)
    if (droppedText) notices.push({ text: droppedText, color: Palette.textFaint })
    const skippedText = personnelSkippedText(input.skipped ?? 0)
    // `caution` because data the player had is gone: a resource in a bad state is
    // one of that colour's sanctioned uses, and this must not read as boilerplate.
    if (skippedText) notices.push({ text: skippedText, color: Palette.caution })

    const blocks = notices.map((notice) => ({
      color: notice.color,
      lines: wrapText(notice.text, PERSONNEL_CONTENT_W, FOOTER_SIZE, measure),
    }))
    const totalLines = blocks.reduce((sum, block) => sum + block.lines.length, 0)
    let fy = controlsY - FOOTER_GAP - totalLines * LINE_H
    for (const block of blocks) {
      for (const text of block.lines) {
        footer.push(makeLine(measure, text, CONTENT_X, fy, { size: FOOTER_SIZE, color: block.color }))
        fy += LINE_H
      }
    }
  }
  footer.push(
    makeLine(
      measure,
      detailView ? PERSONNEL_DETAIL_FOOTER : PERSONNEL_LIST_FOOTER,
      CARD.x + CARD.w / 2,
      controlsY,
      { size: FOOTER_SIZE, color: Palette.textFaint, align: 'center' },
    ),
  )

  return {
    // Opaque enough to read a long list against, since this screen is reached from
    // the title and there is no playfield behind it worth preserving.
    scrim: 'rgba(5, 7, 11, 0.97)',
    card: { ...CARD },
    // Neutral, not `danger`: a history of dead pilots is not a threat this instant,
    // and rule 3 keeps that colour for things that are.
    accent: Palette.line,
    rules,
    header,
    listBox,
    rows,
    scrollbar,
    detail,
    footer,
    pulse: 0.16 + 0.08 * Math.sin(input.tick * 0.09),
  }
}

// ---------------------------------------------------------------------------
// painting
// ---------------------------------------------------------------------------

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

export function drawPersonnelScreenLayout(
  ctx: CanvasRenderingContext2D,
  layout: PersonnelScreenLayout,
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

  for (const row of layout.rows) {
    const box = row.box
    ctx.fillStyle = Palette.panelRaised
    ctx.fillRect(box.x, box.y, box.w, box.h)
    if (row.selected) {
      ctx.globalAlpha = Math.max(0.05, layout.pulse)
      ctx.fillStyle = row.accent
      ctx.fillRect(box.x, box.y, box.w, box.h)
      ctx.globalAlpha = 1
      // A solid stripe and a caret as well as the wash, so the selected row is
      // still obvious without colour (rule 3).
      ctx.fillStyle = row.accent
      ctx.fillRect(box.x, box.y, 3, box.h)
      drawText(ctx, '>', box.x - CARET_GUTTER + 2, box.y + box.h / 2, {
        size: 14,
        weight: 700,
        baseline: 'middle',
        color: Palette.self,
      })
    }
    ctx.strokeStyle = row.accent
    ctx.lineWidth = 1
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)
    paintLines(ctx, row.lines)
  }

  if (layout.scrollbar) {
    ctx.fillStyle = Palette.line
    const { track, thumb } = layout.scrollbar
    ctx.fillRect(track.x, track.y, track.w, track.h)
    ctx.fillStyle = Palette.textFaint
    ctx.fillRect(thumb.x, thumb.y, thumb.w, thumb.h)
  }

  paintLines(ctx, layout.detail)
  paintLines(ctx, layout.footer)
}

/** Lay out with a canvas-backed measure and paint. The app layer's entry point. */
export function drawPersonnelScreen(
  ctx: CanvasRenderingContext2D,
  input: Omit<PersonnelLayoutInput, 'measure'>,
): PersonnelScreenLayout {
  const layout = layoutPersonnelScreen({ ...input, measure: canvasMeasure(ctx) })
  drawPersonnelScreenLayout(ctx, layout)
  return layout
}
