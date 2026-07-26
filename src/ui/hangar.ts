/**
 * The hangar: certifications as a flat readable list.
 *
 * `docs/UI.md` names this screen and constrains it in two sentences: "Unlocks as a
 * flat readable list with real descriptions, not an opaque tech tree. Locked
 * entries state their unlock condition explicitly." Both halves are structural
 * here rather than aspirational:
 *
 * - **No tree.** Certifications have no prerequisites and no ordering, so there is
 *   nothing to draw edges between. The list is roster order, top to bottom, and it
 *   does not re-sort as entries unlock — a list whose rows move when you achieve
 *   something is a list you have to re-read every time you open it.
 * - **Every locked row prints its condition and its progress.** Not on hover, not
 *   on selection: on the row. Revealing a condition only for the highlighted entry
 *   would technically satisfy the rule while making the player press a key ten
 *   times to learn what the screen is for, and `docs/UI.md` rule 6's spirit is that
 *   navigation is not content. Selection changes nothing about a row's height for
 *   the same reason: text that moves when you press down is text you re-read.
 *
 * **Everything a certification says here is derived, never re-typed.** The
 * condition sentence comes from `describeCondition`, the "+2 items" tag from
 * `grantCounts`, the pool totals from `poolFor`. Nothing on this card is a number a
 * human typed twice, because a number typed twice is a number that eventually
 * disagrees with itself — and on this screen the disagreement would be the game
 * asking for one thing and rewarding another.
 *
 * **The layout is pure and the drawing is dumb**, copying `choiceScreen.ts`:
 * `layoutHangar` returns every rect and every positioned, pre-measured line, so
 * `tests/hangar.test.ts` can assert that no string escapes its row without a
 * canvas. That matters more than usual here — this screen holds the longest prose
 * in the project, and the project has already shipped a card with a hint running
 * off its right edge because a single `drawText` cannot know how wide its string is.
 */

import { ENEMIES } from '../content/enemies'
import { ITEMS } from '../content/items'
import { CERTIFICATIONS, type CertificationDef } from '../content/certifications'
import { VIRTUAL_H, VIRTUAL_W } from '../core/space'
import {
  describeCondition,
  describeProgress,
  fullPool,
  grantCounts,
  poolFor,
  poolSize,
  sliceNoun,
} from '../meta/certifications'
import { Palette } from '../render/palette'
import { canvasMeasure, drawText, wrapText, type Measure } from '../render/text'
// Geometry primitives and the headless measure are shared with the choice screen
// rather than re-declared. `lineBounds` in particular is what the containment tests
// assert with, and two copies of it would mean the tests verify a different
// alignment convention than the renderer uses.
import { monoMeasure, type Rect, type TextLine } from './choiceScreen'

export type { Rect, TextLine } from './choiceScreen'
export { lineBounds, monoMeasure } from './choiceScreen'

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

/**
 * Nearly the full viewport, matching the choice screen.
 *
 * Width is bought for the same reason: a certification row carries an effect
 * sentence *and* an unlock condition, and at a narrower measure each wraps to three
 * or four lines and four entries fill the card. The screen's whole job is to be
 * scannable, so it takes the width.
 */
const CARD = { x: 16, y: 10, w: 608, h: 700 } as const
const CARD_BOTTOM = CARD.y + CARD.h
const PAD = 16
const CONTENT_X = CARD.x + PAD
const CONTENT_RIGHT = CARD.x + CARD.w - PAD

/**
 * Content column width, exported so tests measure against the real layout.
 *
 * `tests/textFits.test.ts` records why: the first attempt at a width constant in a
 * test was wrong by a factor of three, and "a test that restates a layout number
 * tests its own guess."
 */
export const HANGAR_CONTENT_W = CARD.w - PAD * 2

const ENTRY_PAD = 9
/**
 * Blank column inside every row so the selection caret appears without shifting a
 * single word. Same reasoning as the choice screen's caret gutter.
 */
const CARET_GUTTER = 15

/** Usable text width inside one certification row. The number copy must fit. */
export const HANGAR_ENTRY_TEXT_W = HANGAR_CONTENT_W - ENTRY_PAD * 2 - CARET_GUTTER

const TITLE_SIZE = 14
const TITLE_H = 19
const BODY_SIZE = 12
const BODY_LH = 15
const LABEL_SIZE = 11
const LABEL_LH = 14

const ENTRY_GAP = 6
const RULE_GAP = 11
const FOOTER_H = 20

/** Point size the header's standfirst is drawn at. Exported for the copy tests. */
export const HANGAR_BODY_SIZE = BODY_SIZE
export const HANGAR_LABEL_SIZE = LABEL_SIZE

/**
 * The screen's own standfirst, and the one place it states the design position in
 * words.
 *
 * A player opening a meta-progression screen in a roguelike arrives expecting
 * permanent power, because that is what the genre has trained them to expect. If
 * the screen does not say otherwise they will read "Adds the Arrears hull" as a
 * stat upgrade they have not understood yet. Saying it outright costs two lines.
 */
export const HANGAR_STANDFIRST =
  'Certifications widen the pool a sortie draws from. None makes the hull stronger.'

export const HANGAR_FOOTER_TEXT = '↑  ↓  select      ESC  return to title'

/** Shown instead of the list when the roster is empty. Should never be seen. */
export const HANGAR_EMPTY_TEXT = 'No certifications are on file for this build.'

/**
 * Notice for a purist run.
 *
 * `docs/DESIGN.md` puts purist mode alongside the daily contract and shared seeds —
 * it exists so two runs are comparable. A hangar that showed a certified pool while
 * the run used the base one would be the panel-advertising-a-fire-rate-the-weapon-
 * does-not-have bug, one screen over.
 */
export const HANGAR_PURIST_NOTICE =
  'Purist mode is on: this build flies the base pool and certifications are ignored.'

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** Wrap the selection, matching the pause menu — an invisible wall reads as a hang. */
export function moveHangarSelection(index: number, delta: number, count: number): number {
  if (count <= 0 || !Number.isFinite(count)) return 0
  const size = Math.trunc(count)
  const whole = Number.isFinite(index) ? Math.trunc(index) : 0
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0
  return (((whole + step) % size) + size) % size
}

/** `turret-heavy` becomes `Turret Heavy`. Fallback when no table knows the id. */
function prettifyId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/**
 * Resolve an id to a display name from the content tables.
 *
 * The hangar names enemies and items in unlock conditions, and unlike the incident
 * report it can afford to import the tables: it is not drawn during a sortie, and a
 * condition that reads "Be lost to a Turret Heavy" instead of "a Heavy Turret" is a
 * screen that looks unfinished.
 */
export function hangarNameFor(id: string): string {
  return ENEMIES[id]?.name ?? ITEMS[id]?.name ?? prettifyId(id)
}

/**
 * Pick the window of rows to show.
 *
 * Top-anchored and scrolls only as far as it must to reveal the selection, which
 * keeps the list still while the player moves within the visible block. Returns
 * `overflow` when even one row on its own does not fit the available height — a
 * bug, and a test asserts against it rather than letting the card silently clip.
 */
export function hangarWindow(
  heights: readonly number[],
  selected: number,
  available: number,
): { readonly top: number; readonly count: number; readonly overflow: boolean } {
  if (heights.length === 0) return { top: 0, count: 0, overflow: false }
  const target = Math.max(0, Math.min(heights.length - 1, Math.trunc(selected)))

  for (let top = 0; top < heights.length; top++) {
    let used = 0
    let last = top - 1
    for (let i = top; i < heights.length; i++) {
      const add = (i === top ? 0 : ENTRY_GAP) + (heights[i] ?? 0)
      if (used + add > available) break
      used += add
      last = i
    }
    // A single row taller than the whole list area: show it anyway and flag it,
    // because dropping the row would hide a certification entirely.
    if (last < top) return { top, count: 1, overflow: true }
    if (last >= target) return { top, count: last - top + 1, overflow: false }
  }
  return { top: Math.max(0, heights.length - 1), count: 1, overflow: true }
}

// ---------------------------------------------------------------------------
// layout model
// ---------------------------------------------------------------------------

export interface HangarEntryLayout {
  /** Index into the roster, not into the visible window. */
  index: number
  id: string
  name: string
  unlocked: boolean
  selected: boolean
  box: Rect
  /** `CERTIFIED` / `NOT CERTIFIED`. The word carries it; colour only reinforces. */
  statusLabel: string
  /** Computed from the grants — "+1 work-order type", "+2 items". */
  grantTag: string
  effectLines: readonly string[]
  /** Empty for an unlocked row. Never empty for a locked one — that is rule 4. */
  conditionLines: readonly string[]
  progressLine: string | null
  /** Empty when everything this certification grants is live. */
  pendingLines: readonly string[]
  lines: readonly TextLine[]
  accent: string
}

export interface HangarLayout {
  card: Rect
  accent: string
  scrim: string
  header: readonly TextLine[]
  entries: readonly HangarEntryLayout[]
  footer: readonly TextLine[]
  rules: readonly Rect[]
  selected: number
  /** First visible roster index. */
  scrollTop: number
  visibleCount: number
  filedCount: number
  rosterCount: number
  poolCount: number
  fullPoolCount: number
  /** Selection wash opacity this frame. Never reaches 0 — rule 10. */
  pulse: number
  /** True if a row could not fit its area. A bug; a test asserts against it. */
  overflow: boolean
}

export interface HangarLayoutInput {
  unlocked: ReadonlySet<string>
  progress: Readonly<Record<string, number>>
  /**
   * Waves in the sector conditions are measured against.
   *
   * Required rather than defaulted: "wave 15 of 30" is only true for sector 1, and
   * a default here is a hardcoded 30 that nobody notices when sector 2 lands.
   */
  waveCount: number
  selected: number
  /** Ticks the screen has been open, for the selection pulse. */
  tick: number
  /** Certifications are ignored for the run; the screen says so. */
  purist?: boolean
  roster?: readonly CertificationDef[]
  nameFor?: (id: string) => string
  measure?: Measure
}

interface EntryContent {
  def: CertificationDef
  unlocked: boolean
  statusLabel: string
  grantTag: string
  effect: readonly string[]
  condition: readonly string[]
  progress: string | null
  pending: readonly string[]
  height: number
}

/**
 * "+1 work-order type", "+2 items · +1 hull", and a `pending` marker where the
 * content has not shipped. Computed, never authored.
 *
 * THE MARKER LIVES ON THE TITLE LINE and the full "content pending: …" sentence only
 * appears once a certification is filed. That split is a density decision with an
 * honesty constraint attached: the notice is what stops a player chasing a reward
 * that does not arrive, so it must be visible on a locked row — but as a *word* it
 * costs no vertical space, and spending a whole line on it took the visible list from
 * six rows of ten down to four. The sentence returns the moment it becomes
 * actionable, which is when the certification is earned.
 */
function grantTagFor(def: CertificationDef): string {
  const counts = grantCounts(def)
    .map(({ slice, count }) => `+${count} ${sliceNoun(slice, count)}`)
    .join(' · ')
  return def.awaiting === null ? counts : `${counts} · pending`
}

function buildEntries(input: HangarLayoutInput, measure: Measure): readonly EntryContent[] {
  const roster = input.roster ?? CERTIFICATIONS
  const nameFor = input.nameFor ?? hangarNameFor
  const ctx = { waveCount: input.waveCount, nameFor }

  return roster.map((def) => {
    const unlocked = input.unlocked.has(def.id)
    const effect = wrapText(def.effect, HANGAR_ENTRY_TEXT_W, BODY_SIZE, measure)
    // A locked row's condition is never dropped and never truncated: it is the one
    // string on this screen `docs/UI.md` requires be present and complete.
    const condition = unlocked
      ? []
      : wrapText(
          `Unlocks: ${describeCondition(def.condition, ctx)}`,
          HANGAR_ENTRY_TEXT_W,
          BODY_SIZE,
          measure,
        )
    const progress = unlocked ? null : describeProgress(def.condition, input.progress[def.id])
    // Shown on locked rows too, deliberately. Someone deciding which certification
    // to chase is entitled to know that the reward has not shipped, and finding out
    // only after earning it is the worse of the two disappointments.
    //
    // WRAPPED, not drawn as one line. It shipped unwrapped in the first draft of this
    // file and `tests/hangar.test.ts` caught it running 16 units past the row — the
    // same bug the pause menu shipped, in the same shape, one screen over. `awaiting`
    // is authored prose that a content change can lengthen at any time, so it gets
    // measured rather than eyeballed.
    const pending =
      def.awaiting === null || !unlocked
        ? []
        : wrapText(`Content pending: ${def.awaiting}.`, HANGAR_ENTRY_TEXT_W, LABEL_SIZE, measure)

    let height = ENTRY_PAD + TITLE_H + effect.length * BODY_LH
    if (condition.length > 0) height += 3 + condition.length * BODY_LH
    if (progress !== null) height += LABEL_LH
    height += pending.length * LABEL_LH
    height += ENTRY_PAD

    return {
      def,
      unlocked,
      statusLabel: unlocked ? 'CERTIFIED' : 'NOT CERTIFIED',
      grantTag: grantTagFor(def),
      effect,
      condition,
      progress,
      pending,
      height,
    }
  })
}

export function layoutHangar(input: HangarLayoutInput): HangarLayout {
  const measure = input.measure ?? monoMeasure
  const roster = input.roster ?? CERTIFICATIONS
  const purist = input.purist === true

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

  const contents = buildEntries(input, measure)
  const filedCount = contents.reduce((sum, entry) => sum + (entry.unlocked ? 1 : 0), 0)
  // Purist mode flies the base pool, so the number on screen is the number the run
  // will actually draw from rather than the number the player has earned.
  const pool = poolFor(purist ? new Set<string>() : input.unlocked, undefined, roster)
  const full = fullPool(undefined, roster)
  const poolCount = poolSize(pool)
  const fullPoolCount = poolSize(full)

  const selected =
    contents.length === 0
      ? 0
      : moveHangarSelection(Number.isFinite(input.selected) ? input.selected : 0, 0, contents.length)

  // --- header ---------------------------------------------------------------
  let y = CARD.y + PAD
  header.push(
    line('Salvage Division // Equipment Roster', CONTENT_X, y, LABEL_SIZE, Palette.textDim, {
      tracking: 1.6,
    }),
  )
  header.push(
    line('CERTIFICATIONS FILED', CONTENT_RIGHT, y, LABEL_SIZE, Palette.textDim, {
      align: 'right',
      tracking: 1.6,
    }),
  )
  y += 16
  header.push(line('HANGAR', CONTENT_X, y, 22, Palette.text, { weight: 700, tracking: 2.4 }))
  // The count carries its unit, per rule 2: "2" alone on a meta screen could be
  // certifications, hulls, or sectors.
  const filedUnit = line(
    ` of ${roster.length}`,
    CONTENT_RIGHT,
    y + 6,
    BODY_SIZE,
    Palette.textDim,
    { align: 'right' },
  )
  header.push(filedUnit)
  header.push(
    line(String(filedCount), CONTENT_RIGHT - filedUnit.width, y, 18, Palette.good, {
      weight: 600,
      align: 'right',
    }),
  )
  y += 26

  for (const text of wrapText(HANGAR_STANDFIRST, HANGAR_CONTENT_W, BODY_SIZE, measure)) {
    header.push(line(text, CONTENT_X, y, BODY_SIZE, Palette.textDim))
    y += BODY_LH
  }
  header.push(
    line(
      `Pool: ${poolCount} of ${fullPoolCount} entries available to the next sortie.`,
      CONTENT_X,
      y,
      LABEL_SIZE,
      Palette.textFaint,
    ),
  )
  y += LABEL_LH
  if (purist) {
    for (const text of wrapText(HANGAR_PURIST_NOTICE, HANGAR_CONTENT_W, LABEL_SIZE, measure)) {
      header.push(line(text, CONTENT_X, y, LABEL_SIZE, Palette.caution))
      y += LABEL_LH
    }
  }

  y += RULE_GAP - 4
  rules.push({ x: CONTENT_X, y, w: HANGAR_CONTENT_W, h: 1 })
  const entriesTop = y + RULE_GAP

  const footerTop = CARD_BOTTOM - PAD - FOOTER_H
  rules.push({ x: CONTENT_X, y: footerTop - RULE_GAP, w: HANGAR_CONTENT_W, h: 1 })
  const available = footerTop - RULE_GAP * 2 - entriesTop

  // --- rows -----------------------------------------------------------------
  const window = hangarWindow(
    contents.map((entry) => entry.height),
    selected,
    available,
  )

  const entries: HangarEntryLayout[] = []
  let entryY = entriesTop
  for (let i = window.top; i < window.top + window.count && i < contents.length; i++) {
    const content = contents[i]
    if (!content) continue
    const isSelected = i === selected
    const box: Rect = { x: CONTENT_X, y: entryY, w: HANGAR_CONTENT_W, h: content.height }
    const textX = box.x + ENTRY_PAD + CARET_GUTTER
    const right = box.x + box.w - ENTRY_PAD
    const lines: TextLine[] = []

    // `good` for a filed certification (a gain), `line` for a locked one. Never
    // `danger`: an unearned unlock is not a threat, and rule 3 keeps that colour for
    // things that can hurt the player.
    const accent = isSelected ? Palette.self : content.unlocked ? Palette.good : Palette.line
    const nameColor = isSelected ? Palette.self : content.unlocked ? Palette.text : Palette.textDim
    const bodyColor = content.unlocked ? Palette.text : Palette.textDim

    let cursor = box.y + ENTRY_PAD
    if (isSelected) {
      // A caret as well as the wash: selection never rests on colour alone.
      lines.push(line('>', box.x + ENTRY_PAD, cursor, TITLE_SIZE, nameColor, { weight: 700 }))
    }

    const name = line(content.def.name, textX, cursor, TITLE_SIZE, nameColor, { weight: 700 })
    lines.push(name)
    lines.push(
      line(content.grantTag, textX + name.width + 9, cursor + 2, LABEL_SIZE, Palette.relic, {
        tracking: 0.6,
      }),
    )
    lines.push(
      line(content.statusLabel, right, cursor + 2, LABEL_SIZE, content.unlocked ? Palette.good : Palette.textFaint, {
        weight: 600,
        align: 'right',
        tracking: 1.2,
      }),
    )
    cursor += TITLE_H

    for (const text of content.effect) {
      lines.push(line(text, textX, cursor, BODY_SIZE, bodyColor))
      cursor += BODY_LH
    }

    if (content.condition.length > 0) {
      cursor += 3
      for (const text of content.condition) {
        // `caution` because an unmet requirement is a cost to the player's time, and
        // it is the row's most important line — it must not be the faintest.
        lines.push(line(text, textX, cursor, BODY_SIZE, Palette.caution))
        cursor += BODY_LH
      }
    }

    if (content.progress !== null) {
      lines.push(line(content.progress, textX, cursor, LABEL_SIZE, Palette.textDim))
      cursor += LABEL_LH
    }

    for (const text of content.pending) {
      // `textFaint` is reserved for genuinely non-essential text, and this is the
      // one line on the row that changes nothing about what the player should do.
      lines.push(line(text, textX, cursor, LABEL_SIZE, Palette.textFaint))
      cursor += LABEL_LH
    }

    entries.push({
      index: i,
      id: content.def.id,
      name: content.def.name,
      unlocked: content.unlocked,
      selected: isSelected,
      box,
      statusLabel: content.statusLabel,
      grantTag: content.grantTag,
      effectLines: content.effect,
      conditionLines: content.condition,
      progressLine: content.progress,
      pendingLines: content.pending,
      lines,
      accent,
    })
    entryY += content.height + ENTRY_GAP
  }

  if (contents.length === 0) {
    header.push(line(HANGAR_EMPTY_TEXT, CONTENT_X, entriesTop, BODY_SIZE, Palette.textDim))
  }

  // --- footer ---------------------------------------------------------------
  footer.push(
    line(HANGAR_FOOTER_TEXT, CONTENT_X, footerTop + 2, BODY_SIZE, Palette.textDim, {
      tracking: 0.6,
    }),
  )
  const shownFrom = entries.length > 0 ? window.top + 1 : 0
  const shownTo = entries.length > 0 ? window.top + entries.length : 0
  footer.push(
    // Stated even when everything fits, so the number does not appear and disappear
    // as the roster grows — a counter that comes and goes reads as a glitch.
    line(
      `Showing ${shownFrom} to ${shownTo} of ${contents.length}`,
      CONTENT_RIGHT,
      footerTop + 2,
      LABEL_SIZE,
      Palette.textFaint,
      { align: 'right' },
    ),
  )

  const tick = Number.isFinite(input.tick) ? input.tick : 0
  // ~0.9 Hz, opacity 0.07..0.21. Rule 10 is a hard constraint, not a preference.
  const pulse = 0.14 + 0.07 * Math.sin(tick * 0.09)

  return {
    card: { ...CARD },
    // `self` — the hangar is the player's own record, and nothing on it is at risk.
    accent: Palette.self,
    scrim: 'rgba(5, 7, 11, 0.965)',
    header,
    entries,
    footer,
    rules,
    selected,
    scrollTop: window.top,
    visibleCount: entries.length,
    filedCount,
    rosterCount: contents.length,
    poolCount,
    fullPoolCount,
    pulse,
    overflow: window.overflow,
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

export function drawHangarLayout(ctx: CanvasRenderingContext2D, layout: HangarLayout): void {
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

  for (const entry of layout.entries) {
    const { box } = entry
    // A locked row is left at the card's own tone so it reads as flat rather than as
    // a button: shape and tone, not just colour.
    ctx.fillStyle = entry.unlocked ? Palette.panelRaised : Palette.panel
    ctx.fillRect(box.x, box.y, box.w, box.h)

    if (entry.selected) {
      ctx.globalAlpha = Math.max(0.05, layout.pulse)
      ctx.fillStyle = entry.accent
      ctx.fillRect(box.x, box.y, box.w, box.h)
      ctx.globalAlpha = 1
    }

    ctx.strokeStyle = entry.accent
    ctx.lineWidth = 1
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1)
    // A solid left stripe, so a filed certification and the selected row are both
    // still obvious in a monochrome screenshot.
    if (entry.selected || entry.unlocked) {
      ctx.fillStyle = entry.accent
      ctx.fillRect(box.x, box.y, 3, box.h)
    }

    paintLines(ctx, entry.lines)
  }

  paintLines(ctx, layout.footer)
}

export interface HangarScreenOptions {
  unlocked: ReadonlySet<string>
  progress: Readonly<Record<string, number>>
  waveCount: number
  selected: number
  tick: number
  purist?: boolean
}

/**
 * Draw the hangar.
 *
 * Measures against the real font rather than the monospace estimate, so wrapping on
 * screen is exact instead of conservative — the estimate exists for the tests, not
 * for the renderer.
 */
export function drawHangar(ctx: CanvasRenderingContext2D, opts: HangarScreenOptions): void {
  drawHangarLayout(
    ctx,
    layoutHangar({
      unlocked: opts.unlocked,
      progress: opts.progress,
      waveCount: opts.waveCount,
      selected: opts.selected,
      tick: opts.tick,
      ...(opts.purist === undefined ? {} : { purist: opts.purist }),
      measure: canvasMeasure(ctx),
    }),
  )
}
