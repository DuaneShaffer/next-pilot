/**
 * Seed entry and share screens.
 *
 * ## The actual problem
 *
 * The game's entire input vocabulary is four directions, fire, special and focus
 * (`src/core/input.ts`). Typing twelve characters with that is miserable, and the
 * usual answer — an arcade "cycle A-Z with up/down" field — is worst-case fifteen
 * presses per character, one hundred and eighty for a seed. So this screen is
 * built around what actually happens instead:
 *
 * 1. **Paste is the primary path.** A seed arrives in a chat message or under a
 *    screenshot. `normalizeSeed` already folds case, dashes, spaces and the
 *    look-alike characters, so pasting sloppy text works — and the screen *says*
 *    what it folded (see `SeedFold`), because silently rewriting what someone
 *    pasted is how a field loses their trust.
 * 2. **A grid, not a cycle.** All thirty characters are on screen in alphabet
 *    order, six by five. Any character is at most five moves from any other, and
 *    the whole alphabet is visible so nobody has to hunt by scrolling.
 * 3. **The slot cursor is implicit.** Confirming a character appends it and moves
 *    on, so you never navigate the field itself — you type left to right, which is
 *    what typing is. `special` backspaces. Nobody needs to learn a mode.
 *
 * ## The alphabet is derived, never restated
 *
 * `src/core/seed.ts` does not export its alphabet, and copying those thirty
 * characters here would create a second source of truth that silently drifts the
 * first time the alphabet changes — producing a picker offering characters the
 * validator rejects. So the alphabet and the fold table are both *probed* out of
 * `normalizeSeed` and `isValidSeed` at module load. They cannot disagree with the
 * validator, because they are defined by it.
 *
 * ## Sizes are never below Font.minSizePx
 *
 * `font()` clamps to 12, so a nominal size of 10 is *drawn* at 12 while a naive
 * width estimate computes it at 10 — which means text that measures as fitting
 * overflows on screen. Everything here is 12 or above so the measurement in
 * `tests/seedModes.test.ts` describes what is actually drawn.
 */

import { SEED_LENGTH, formatSeed, isValidSeed, normalizeSeed } from '../core/seed'
import { PANEL_W, VIRTUAL_H, VIRTUAL_W } from '../core/space'
import type { DailyContract, ReplayShare, RunMode } from '../meta/seedModes'
import { dailyProse, describeDaily, describeRunMode, parseSeedLink } from '../meta/seedModes'
import { Font, Palette } from '../render/palette'
import { canvasMeasure, drawLabel, drawText, wrapText } from '../render/text'

// ---------------------------------------------------------------------------
// the alphabet, probed out of core/seed.ts
// ---------------------------------------------------------------------------

const CANDIDATES = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * What one character becomes after normalisation, or null if it is discarded.
 *
 * Probed by normalising a full-length run of the character: `normalizeSeed` works
 * on whole strings, so a single character is the cleanest way to ask it "what do
 * you think this means".
 */
function foldOf(char: string): string | null {
  const normalized = normalizeSeed(char.repeat(SEED_LENGTH))
  const first = normalized[0]
  return first === undefined ? null : first
}

export interface SeedFold {
  readonly from: string
  readonly to: string
}

/** Every character normalisation rewrites, e.g. O→Q, 1→J, U→V. */
export const SEED_FOLDS: readonly SeedFold[] = (() => {
  const out: SeedFold[] = []
  for (const char of CANDIDATES) {
    const to = foldOf(char)
    if (to !== null && to !== char) out.push({ from: char, to })
  }
  return out
})()

const FOLD_MAP: ReadonlyMap<string, string> = new Map(SEED_FOLDS.map((f) => [f.from, f.to]))

/**
 * The characters a seed may actually contain, in the order `core/seed.ts` lists them.
 *
 * A character qualifies when normalisation leaves it alone AND a seed made
 * entirely of it validates. Both halves are needed: the first excludes the
 * look-alikes, the second excludes anything the alphabet drops.
 */
export const SEED_ALPHABET: readonly string[] = (() => {
  const out: string[] = []
  for (const char of CANDIDATES) {
    if (foldOf(char) !== char) continue
    if (!isValidSeed(char.repeat(SEED_LENGTH))) continue
    out.push(char)
  }
  return out
})()

/**
 * Picker columns.
 *
 * Six divides the thirty-character alphabet exactly, so the grid has no dead
 * cells and navigation needs no bounds special case. `tests/seedModes.test.ts`
 * asserts the division, so an alphabet change that would leave a ragged last row
 * fails a test instead of shipping a cursor that lands on nothing.
 */
export const PICKER_COLS = 6
export const PICKER_ROWS = Math.ceil(SEED_ALPHABET.length / PICKER_COLS)

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

export interface SeedEntryState {
  /** Always normalised, 0..SEED_LENGTH characters. */
  readonly draft: string
  /** Index into SEED_ALPHABET. */
  readonly pick: number
  /** What the last paste rewrote. Cleared by the next edit. */
  readonly folded: readonly SeedFold[]
  /** How many characters the last paste discarded outright. */
  readonly dropped: number
  /** Whether the last paste was longer than a seed. */
  readonly truncated: boolean
}

export const EMPTY_SEED_ENTRY: SeedEntryState = {
  draft: '',
  pick: 0,
  folded: [],
  dropped: 0,
  truncated: false,
}

export type SeedEntryAction =
  | { readonly kind: 'move'; readonly dx: number; readonly dy: number }
  /** Append the picked character. */
  | { readonly kind: 'commit' }
  /** Backspace. */
  | { readonly kind: 'erase' }
  | { readonly kind: 'clear' }
  /**
   * Replace the draft from arbitrary text — a clipboard paste, or a freshly
   * generated seed. Both are "here is a seed, take it", so they are one action.
   */
  | { readonly kind: 'paste'; readonly text: string }

/** Wrap an index into the picker grid. Total: every dx/dy lands on a character. */
function movePick(pick: number, dx: number, dy: number): number {
  const count = SEED_ALPHABET.length
  if (count === 0) return 0
  // Wrap rather than clamp, for the same reason the pause menu does: an invisible
  // wall reads as an unresponsive control.
  const stepped = pick + dx + dy * PICKER_COLS
  return ((stepped % count) + count) % count
}

/**
 * Analyse arbitrary pasted text.
 *
 * Reports what normalisation did rather than only its result, so the screen can
 * explain the difference between what was pasted and what is now in the field.
 *
 * A whole share link is tried FIRST. People paste the link, not the seed, and
 * running a URL through `normalizeSeed` produces twelve characters of the hostname
 * — a valid-looking seed for entirely the wrong run, with nothing to indicate it.
 */
function analysePaste(text: string): SeedEntryState {
  const fromLink = parseSeedLink(text.trim())
  if (fromLink !== null) {
    return { draft: fromLink, pick: 0, folded: [], dropped: 0, truncated: false }
  }

  const folded: SeedFold[] = []
  let dropped = 0
  let kept = 0
  for (const raw of text.toUpperCase()) {
    const fold = FOLD_MAP.get(raw)
    if (fold !== undefined) {
      // Only report folds that survive into the seed; a look-alike in the 13th
      // position was truncated away and mentioning it is noise.
      if (kept < SEED_LENGTH) folded.push({ from: raw, to: fold })
      kept++
      continue
    }
    if (SEED_ALPHABET.includes(raw)) {
      kept++
      continue
    }
    // Formatting is expected in a pasted seed and is not a complaint. Anything
    // else is a real character that vanished, which the player should hear about.
    if (!/[\s\-_.:,/]/.test(raw)) dropped++
  }
  return {
    draft: normalizeSeed(text),
    pick: 0,
    folded,
    dropped,
    truncated: kept > SEED_LENGTH,
  }
}

/** Pure reducer. Total over every action; never throws. */
export function seedEntryReduce(
  state: SeedEntryState,
  action: SeedEntryAction,
): SeedEntryState {
  switch (action.kind) {
    case 'move':
      return { ...state, pick: movePick(state.pick, action.dx, action.dy) }
    case 'commit': {
      if (state.draft.length >= SEED_LENGTH) return state
      const char = SEED_ALPHABET[state.pick]
      if (char === undefined) return state
      // Any manual edit retires the paste report: it described a string that no
      // longer exists, and a stale "we folded your O" is worse than no note.
      return { ...state, draft: state.draft + char, folded: [], dropped: 0, truncated: false }
    }
    case 'erase':
      if (state.draft.length === 0) return state
      return {
        ...state,
        draft: state.draft.slice(0, -1),
        folded: [],
        dropped: 0,
        truncated: false,
      }
    case 'clear':
      return { ...EMPTY_SEED_ENTRY, pick: state.pick }
    case 'paste': {
      const analysed = analysePaste(action.text)
      // Keep the picker where it was: a paste that needs one character fixed
      // should not also move the cursor the player was about to use.
      return { ...analysed, pick: state.pick }
    }
  }
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

export type SeedDraftStatus = 'empty' | 'partial' | 'complete' | 'invalid'

export interface SeedDraftValidation {
  readonly status: SeedDraftStatus
  /** The seed to fly, non-null only when `status` is 'complete'. */
  readonly seed: string | null
  readonly remaining: number
  /** Shown beneath the field. Always says what to do next. */
  readonly message: string
}

/**
 * Validation state for the draft.
 *
 * 'invalid' is reachable only if the alphabet and `normalizeSeed` ever disagree —
 * a full-length normalised draft is otherwise valid by construction. It is
 * modelled anyway rather than asserted away, because the alternative to a state
 * you did not model is a screen that offers a Fly button for a seed the sim will
 * reject.
 */
export function validateSeedDraft(state: SeedEntryState): SeedDraftValidation {
  const remaining = SEED_LENGTH - state.draft.length
  if (state.draft.length === 0) {
    return {
      status: 'empty',
      seed: null,
      remaining,
      message: `Paste a seed, or pick ${SEED_LENGTH} characters below.`,
    }
  }
  if (remaining > 0) {
    return {
      status: 'partial',
      seed: null,
      remaining,
      // The count is the whole message: a partial seed is not an error, it is an
      // unfinished one, and saying "invalid" about it would be a lie.
      message: `${remaining} more character${remaining === 1 ? '' : 's'} to go.`,
    }
  }
  if (!isValidSeed(state.draft)) {
    return {
      status: 'invalid',
      seed: null,
      remaining: 0,
      message: 'That is not a usable seed. Clear it and try again.',
    }
  }
  return {
    status: 'complete',
    seed: state.draft,
    remaining: 0,
    message: `Ready. This seed flies the same run for everyone.`,
  }
}

/** The "here is what we changed about your paste" note, or null. */
export function describePasteRepair(state: SeedEntryState): string | null {
  const parts: string[] = []
  if (state.folded.length > 0) {
    // Deduplicated and listed, not summarised as a count: "we changed 3
    // characters" invites a hunt, "O reads as Q" explains the alphabet.
    const seen = new Set<string>()
    const pairs: string[] = []
    for (const fold of state.folded) {
      const key = `${fold.from}${fold.to}`
      if (seen.has(key)) continue
      seen.add(key)
      pairs.push(`${fold.from}→${fold.to}`)
    }
    parts.push(
      `Read ${pairs.join(', ')} — seeds leave out look-alike characters, so those fold in.`,
    )
  }
  if (state.truncated) parts.push(`Kept the first ${SEED_LENGTH} characters.`)
  if (state.dropped > 0) {
    parts.push(
      `Ignored ${state.dropped} character${state.dropped === 1 ? '' : 's'} that a seed cannot contain.`,
    )
  }
  return parts.length === 0 ? null : parts.join(' ')
}

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

/**
 * Card width.
 *
 * 500 rather than the pause menu's 420 because this card carries the widest
 * footer in the game — five control hints, since the screen has five verbs — and
 * at 460 that footer measured 439 units against a 408-unit column. Widening the
 * container was the right fix rather than abbreviating the controls into
 * "ESC out": a footer nobody can decode is not a footer.
 */
const SEED_CARD_W = 500
/**
 * Height, sized to the *reserved* layout rather than to any one state.
 *
 * Every block below has a fixed line count, so the content is exactly the same
 * height whatever the player has typed. A test asserts the total against
 * `SEED_FOOTER_Y`, so this number is checked rather than judged.
 */
const SEED_CARD_H = 544
const SEED_CARD_X = (VIRTUAL_W - SEED_CARD_W) / 2
const SEED_CARD_Y = (VIRTUAL_H - SEED_CARD_H) / 2
const PAD = 26

/** Usable text width on the seed card. Exported so tests measure the real box. */
export const SEED_CONTENT_W = SEED_CARD_W - PAD * 2

const SHARE_CARD_W = 480
/** Also sized to the reserved layout. See SEED_CARD_H. */
const SHARE_CARD_H = 312
const SHARE_CARD_X = (VIRTUAL_W - SHARE_CARD_W) / 2
const SHARE_CARD_Y = (VIRTUAL_H - SHARE_CARD_H) / 2

export const SHARE_CONTENT_W = SHARE_CARD_W - PAD * 2

/**
 * The y each card's footer sits at.
 *
 * Both draw functions return the y their content ended at, and
 * `tests/seedModes.test.ts` asserts it stays above these. Vertical containment is
 * the axis `tests/textFits.test.ts` cannot cover — it measures line widths, and the
 * pause menu's other near-miss was a third hint line *colliding* with the footer
 * rather than overflowing sideways. A returned height is checkable; a running local
 * variable inside a draw call is not.
 */
export const SEED_FOOTER_Y = SEED_CARD_Y + SEED_CARD_H - PAD + 2
export const SHARE_FOOTER_Y = SHARE_CARD_Y + SHARE_CARD_H - PAD + 2

/** Body copy size. At or above Font.minSizePx so measurement matches drawing. */
export const PROSE_SIZE = Math.max(Font.minSizePx, 12)
export const FOOTER_SIZE = Math.max(Font.minSizePx, 12)

export const SEED_ENTRY_FOOTER = 'Arrows pick · FIRE add · X back · CTRL+V paste · ESC cancel'
export const SHARE_FOOTER = 'Up/Down choose · FIRE copy · ESC back'

/**
 * What the seed-entry screen explains about itself.
 *
 * Kept as a constant so `tests/seedModes.test.ts` measures the shipped copy
 * rather than a paraphrase — the pause menu's overflowing hint got through
 * precisely because the string only existed inside a draw call.
 */
export const SEED_ENTRY_PROSE =
  'Every run is a seed. Fly the same one as someone else and you get the same ' +
  'waves, the same offers, and the same fight.'

/**
 * Width the run-mode tag must fit into in the instrument panel.
 *
 * Deliberately tighter than the panel's real content column: `src/render/panel.ts`
 * keeps its padding private, so rather than restate a number that could change
 * without this noticing, this leaves 20 units of slack on each side. Anything that
 * fits here fits any panel padding up to 20.
 */
export const MODE_TAG_MAX_W = PANEL_W - 40
export const MODE_TAG_LABEL_SIZE = Math.max(Font.minSizePx, 12)
export const MODE_TAG_DETAIL_SIZE = Math.max(Font.minSizePx, 12)

const SLOT_W = 24
const SLOT_GAP = 3
const SLOT_H = 32
const CELL_W = 30
const CELL_H = 26

/**
 * Reserved line counts per prose block. The layout is these numbers.
 *
 * Each is the worst case the corresponding test measures, so a copy edit that
 * needs one more line fails a test rather than silently colliding with whatever
 * is beneath it.
 */
const RESERVE = {
  /** SEED_ENTRY_PROSE. */
  intro: 2,
  /** dailyProse, whose longest variant is the archive one. */
  daily: 3,
  /** The validation line. Always one. */
  status: 1,
  /** describePasteRepair, worst case being folds + truncation + drops together. */
  repair: 3,
  /** SEED_LINK_PROSE / REPLAY_LINK_PROSE. */
  shareBody: 2,
  /** The over-length refusal, which carries two formatted numbers. */
  shareRefusal: 4,
} as const

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

function drawCard(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  rule: string,
): void {
  // Same heavy scrim as the pause menu: this is a card you read and act on, so a
  // playfield showing through is a legibility problem, not atmosphere.
  ctx.fillStyle = 'rgba(5, 7, 11, 0.9)'
  ctx.fillRect(0, 0, VIRTUAL_W, VIRTUAL_H)
  ctx.fillStyle = Palette.panel
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = Palette.line
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  ctx.fillStyle = rule
  ctx.fillRect(x, y, w, 2)
}

function drawDivider(ctx: CanvasRenderingContext2D, x: number, y: number, w: number): void {
  ctx.fillStyle = Palette.line
  ctx.fillRect(x, y, w, 1)
}

const LINE_H = PROSE_SIZE + 4

/**
 * Wrapped prose in a block of a FIXED number of lines.
 *
 * `reserve` is what keeps these cards still. Advancing by however many lines the
 * text happened to need means the picker grid jumps 50 units downward the moment a
 * paste note appears — the control the player is using moves out from under them,
 * which reads as a glitch and costs a mis-press. Reserving the worst case costs
 * some blank space and is worth it; `tests/seedModes.test.ts` asserts the content
 * height is identical across every state, so a future edit cannot quietly
 * reintroduce the jump.
 */
function drawProse(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  width: number,
  color: string,
  reserve: number,
): number {
  const lines = wrapText(text, width, PROSE_SIZE, canvasMeasure(ctx))
  lines.forEach((line, index) => {
    drawText(ctx, line, x, y + index * LINE_H, { size: PROSE_SIZE, baseline: 'top', color })
  })
  return y + reserve * LINE_H
}

export interface SeedEntryScreenState {
  readonly entry: SeedEntryState
  /** Today's contract, so the screen can offer it without a second menu. */
  readonly daily: DailyContract
  /** Ticks the screen has been open, for the cursor pulse. */
  readonly tick: number
}

/** Draws the card and returns the y its content ended at. See SEED_FOOTER_Y. */
export function drawSeedEntry(
  ctx: CanvasRenderingContext2D,
  state: SeedEntryScreenState,
): number {
  drawCard(ctx, SEED_CARD_X, SEED_CARD_Y, SEED_CARD_W, SEED_CARD_H, Palette.self)

  const contentX = SEED_CARD_X + PAD
  const contentRight = SEED_CARD_X + SEED_CARD_W - PAD
  let y = SEED_CARD_Y + PAD

  drawLabel(ctx, 'Salvage Division // Flight Requisition', contentX, y, { baseline: 'top' })
  y += 22
  drawText(ctx, 'SEED ENTRY', contentX, y, {
    size: 26,
    weight: 700,
    tracking: 2,
    baseline: 'top',
    color: Palette.text,
  })
  y += 34
  y = drawProse(ctx, SEED_ENTRY_PROSE, contentX, y, SEED_CONTENT_W, Palette.textDim, RESERVE.intro)
  y += 10

  drawDivider(ctx, contentX, y, SEED_CONTENT_W)
  y += 14

  // --- the daily contract, offered here rather than behind another menu -------
  const daily = describeDaily(state.daily)
  drawText(ctx, daily.label, contentX, y, {
    size: 13,
    weight: 600,
    baseline: 'top',
    color: state.daily.flown ? Palette.textDim : Palette.caution,
  })
  drawText(ctx, daily.detail, contentRight, y, {
    size: 12,
    align: 'right',
    baseline: 'top',
    color: Palette.textDim,
  })
  y += 18
  y = drawProse(
    ctx,
    dailyProse(state.daily),
    contentX,
    y,
    SEED_CONTENT_W,
    Palette.textFaint,
    RESERVE.daily,
  )
  y += 10

  drawDivider(ctx, contentX, y, SEED_CONTENT_W)
  y += 16

  // --- the field -------------------------------------------------------------
  const validation = validateSeedDraft(state.entry)
  const fieldW = SEED_LENGTH * SLOT_W + (SEED_LENGTH - 1) * SLOT_GAP
  const fieldX = contentX + (SEED_CONTENT_W - fieldW) / 2
  // A slow pulse on the next empty slot. Never reaches zero opacity — UI rule 10
  // applies to a text cursor as much as to an impact flash.
  const pulse = 0.35 + 0.25 * Math.sin(state.tick * 0.09)

  for (let i = 0; i < SEED_LENGTH; i++) {
    const slotX = fieldX + i * (SLOT_W + SLOT_GAP)
    const char = state.entry.draft[i]
    const isCursor = i === state.entry.draft.length
    ctx.fillStyle = Palette.panelRaised
    ctx.fillRect(slotX, y, SLOT_W, SLOT_H)
    if (isCursor) {
      ctx.fillStyle = `rgba(92, 224, 240, ${pulse.toFixed(3)})`
      ctx.fillRect(slotX, y, SLOT_W, SLOT_H)
    }
    // A baseline rule under every slot, so an empty field still reads as twelve
    // places rather than as a gap. Filled slots get the accent, so progress is
    // legible without relying on the characters alone.
    ctx.fillStyle = char === undefined ? Palette.line : Palette.self
    ctx.fillRect(slotX, y + SLOT_H - 2, SLOT_W, 2)
    if (char !== undefined) {
      drawText(ctx, char, slotX + SLOT_W / 2, y + 7, {
        size: 18,
        weight: 600,
        align: 'center',
        baseline: 'top',
        color: Palette.text,
      })
    }
    // Group separators every four characters, matching formatSeed's dashes, so
    // what is typed here looks like what was pasted in.
    if (i % 4 === 3 && i < SEED_LENGTH - 1) {
      drawText(ctx, '-', slotX + SLOT_W + SLOT_GAP / 2, y + 9, {
        size: 13,
        align: 'center',
        baseline: 'top',
        color: Palette.textFaint,
      })
    }
  }
  y += SLOT_H + 10

  // --- validation, then any paste repair -------------------------------------
  const statusColor =
    validation.status === 'complete'
      ? Palette.good
      : validation.status === 'invalid'
        ? Palette.caution
        : Palette.textDim
  y = drawProse(ctx, validation.message, contentX, y, SEED_CONTENT_W, statusColor, RESERVE.status)

  // The repair block is reserved whether or not there is a note, so the picker
  // below does not move under the player's cursor when a paste produces one.
  const repair = describePasteRepair(state.entry)
  y = drawProse(ctx, repair ?? '', contentX, y + 4, SEED_CONTENT_W, Palette.caution, RESERVE.repair)
  y += 10

  drawDivider(ctx, contentX, y, SEED_CONTENT_W)
  y += 14

  // --- the picker ------------------------------------------------------------
  const gridW = PICKER_COLS * CELL_W
  const gridX = contentX + (SEED_CONTENT_W - gridW) / 2
  const full = state.entry.draft.length >= SEED_LENGTH
  SEED_ALPHABET.forEach((char, index) => {
    const col = index % PICKER_COLS
    const row = Math.floor(index / PICKER_COLS)
    const cellX = gridX + col * CELL_W
    const cellY = y + row * CELL_H
    const isPicked = index === state.entry.pick
    if (isPicked) {
      ctx.fillStyle = `rgba(92, 224, 240, ${(0.18 + 0.1 * Math.sin(state.tick * 0.09)).toFixed(3)})`
      ctx.fillRect(cellX, cellY, CELL_W - 2, CELL_H - 2)
      ctx.strokeStyle = Palette.self
      ctx.lineWidth = 1
      ctx.strokeRect(cellX + 0.5, cellY + 0.5, CELL_W - 3, CELL_H - 3)
    }
    drawText(ctx, char, cellX + (CELL_W - 2) / 2, cellY + 6, {
      size: 14,
      weight: isPicked ? 700 : 400,
      align: 'center',
      baseline: 'top',
      // A full field greys the whole picker: the affordance has to stop looking
      // available at the moment it stops working, or the next press reads as a
      // dropped input.
      color: full ? Palette.textFaint : isPicked ? Palette.self : Palette.textDim,
    })
  })
  y += PICKER_ROWS * CELL_H + 6

  drawText(ctx, SEED_ENTRY_FOOTER, SEED_CARD_X + SEED_CARD_W / 2, SEED_FOOTER_Y, {
    size: FOOTER_SIZE,
    align: 'center',
    baseline: 'top',
    color: Palette.textFaint,
  })
  return y
}

// ---------------------------------------------------------------------------
// share card
// ---------------------------------------------------------------------------

export type ShareChoice = 'seed' | 'replay'

export interface ShareCardState {
  readonly mode: RunMode
  readonly share: ReplayShare
  readonly selected: ShareChoice
  /** Which link was last copied, so the confirmation is attached to its row. */
  readonly copied: ShareChoice | null
  readonly tick: number
}

/** Row order, and therefore what up/down cycles between. */
export const SHARE_CHOICES: readonly ShareChoice[] = ['seed', 'replay']

/** Copy on the share card. Constants so the fit test measures the real strings. */
export const SEED_LINK_PROSE =
  'Short and always works. The recipient flies the same starting conditions.'

export const REPLAY_LINK_PROSE =
  'Carries every input, so the recipient watches the run that happened.'

/**
 * Move the selection, skipping a replay row that has no link.
 *
 * Selecting a row that cannot be copied would leave FIRE doing nothing, which is
 * indistinguishable from a broken screen.
 */
export function moveShareSelection(
  selected: ShareChoice,
  delta: number,
  share: ReplayShare,
): ShareChoice {
  if (share.url === null) return 'seed'
  const index = SHARE_CHOICES.indexOf(selected)
  const count = SHARE_CHOICES.length
  const next = SHARE_CHOICES[(((index + delta) % count) + count) % count]
  return next ?? 'seed'
}

/** The short, readable form of a seed link. The full URL is what gets copied. */
export function shortSeedLink(seed: string): string {
  // The origin is long and carries no information a player needs to verify, so the
  // display shows the part that identifies the run and the clipboard gets the rest.
  return `?seed=${formatSeed(seed)}`
}

/** Draws the card and returns the y its content ended at. See SHARE_FOOTER_Y. */
export function drawShareCard(ctx: CanvasRenderingContext2D, state: ShareCardState): number {
  drawCard(ctx, SHARE_CARD_X, SHARE_CARD_Y, SHARE_CARD_W, SHARE_CARD_H, Palette.good)

  const contentX = SHARE_CARD_X + PAD
  const contentRight = SHARE_CARD_X + SHARE_CARD_W - PAD
  let y = SHARE_CARD_Y + PAD

  drawLabel(ctx, 'Salvage Division // Flight Record', contentX, y, { baseline: 'top' })
  y += 22
  drawText(ctx, 'SHARE THIS RUN', contentX, y, {
    size: 24,
    weight: 700,
    tracking: 2,
    baseline: 'top',
    color: Palette.text,
  })
  y += 32

  const tag = describeRunMode(state.mode)
  drawText(ctx, tag.label, contentX, y, {
    size: 12,
    weight: 600,
    tracking: 1.2,
    baseline: 'top',
    color: Palette.self,
  })
  drawText(ctx, tag.detail, contentRight, y, {
    size: 12,
    align: 'right',
    baseline: 'top',
    color: Palette.textDim,
  })
  y += 20

  drawDivider(ctx, contentX, y, SHARE_CONTENT_W)
  y += 14

  const rows: readonly {
    choice: ShareChoice
    title: string
    body: string
    ok: boolean
    reserve: number
  }[] = [
    {
      choice: 'seed',
      title: 'SEED LINK',
      body: SEED_LINK_PROSE,
      ok: true,
      reserve: RESERVE.shareBody,
    },
    {
      choice: 'replay',
      title: 'REPLAY LINK',
      body: state.share.message ?? REPLAY_LINK_PROSE,
      ok: state.share.url !== null,
      // Reserved for the refusal in BOTH cases: the rows must sit in the same place
      // whether or not the run fit, or the screen reflows between two runs and the
      // budget bar lands somewhere different each time.
      reserve: RESERVE.shareRefusal,
    },
  ]

  for (const row of rows) {
    const isSelected = row.choice === state.selected
    if (isSelected) {
      const pulse = 0.16 + 0.08 * Math.sin(state.tick * 0.09)
      ctx.fillStyle = `rgba(92, 224, 240, ${pulse.toFixed(3)})`
      ctx.fillRect(contentX - 10, y - 5, SHARE_CONTENT_W + 20, 20)
      drawText(ctx, '>', contentX - 18, y, {
        size: 13,
        weight: 700,
        baseline: 'top',
        color: Palette.self,
      })
    }
    drawText(ctx, row.title, contentX, y, {
      size: 13,
      weight: 600,
      tracking: 1,
      baseline: 'top',
      // Caution, not danger: a run too long to link is a limit, not a threat.
      color: row.ok ? Palette.text : Palette.caution,
    })
    const right =
      state.copied === row.choice
        ? 'copied'
        : row.choice === 'seed'
          ? shortSeedLink(state.mode.seed)
          : row.ok
            ? `${state.share.chars} / ${state.share.limit} chars`
            : 'too long to paste'
    drawText(ctx, right, contentRight, y, {
      size: 12,
      align: 'right',
      baseline: 'top',
      color: state.copied === row.choice ? Palette.good : row.ok ? Palette.textDim : Palette.caution,
    })
    y += 18
    y = drawProse(ctx, row.body, contentX, y, SHARE_CONTENT_W, Palette.textDim, row.reserve) + 6

    if (row.choice === 'replay' && state.share.chars > 0) {
      // A budget bar, because "1,412 of 2,000" is a number and this is a ratio.
      // Over-budget is drawn full and in caution, so the bar never implies the
      // link would fit.
      const fraction = Math.min(1, state.share.chars / state.share.limit)
      ctx.fillStyle = Palette.panelRaised
      ctx.fillRect(contentX, y, SHARE_CONTENT_W, 4)
      ctx.fillStyle = row.ok ? Palette.good : Palette.caution
      ctx.fillRect(contentX, y, SHARE_CONTENT_W * fraction, 4)
      y += 12
    }
  }

  drawText(ctx, SHARE_FOOTER, SHARE_CARD_X + SHARE_CARD_W / 2, SHARE_FOOTER_Y, {
    size: FOOTER_SIZE,
    align: 'center',
    baseline: 'top',
    color: Palette.textFaint,
  })
  return y
}
