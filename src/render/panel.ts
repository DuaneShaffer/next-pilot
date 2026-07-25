/**
 * The instrument panel.
 *
 * This column is the reason the layout reserves 192 units on the right: it keeps
 * every readout out of the play area. See docs/UI.md for the rules it follows.
 * The short version:
 *
 *   - Every value carries a unit and a label. No bare numbers.
 *   - Meters are segmented, because a player can count segments at a glance but
 *     cannot judge the length of a smooth bar under pressure.
 *   - `danger` colour appears only when something is actually wrong.
 */

import { PANEL_W, PLAYFIELD_W, VIRTUAL_H } from '../core/space'
import { formatSeed } from '../core/seed'
import type { WorldView } from '../sim/entities'
import { Font, Palette } from './palette'
import { drawLabel, drawText, drawValue, measureText } from './text'

const PAD = 14
const CONTENT_X = PLAYFIELD_W + PAD
const CONTENT_W = PANEL_W - PAD * 2

export function drawPanelFrame(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = Palette.panel
  ctx.fillRect(PLAYFIELD_W, 0, PANEL_W, VIRTUAL_H)
  // A single hairline divides play from instruments. Crisp because it sits on a
  // half-unit boundary rather than straddling one.
  ctx.fillStyle = Palette.line
  ctx.fillRect(PLAYFIELD_W, 0, 1, VIRTUAL_H)
}

/** A horizontal rule used to separate panel sections. */
function drawDivider(ctx: CanvasRenderingContext2D, y: number): void {
  ctx.fillStyle = Palette.line
  ctx.fillRect(CONTENT_X, y, CONTENT_W, 1)
}

interface MeterOptions {
  label: string
  value: number
  max: number
  unit: string
  color: string
  /** Below this fraction the meter switches to the caution/danger colour. */
  warnBelow?: number
  segments?: number
}

/**
 * A segmented meter: label and value on one line, bar beneath it.
 *
 * Everything is positioned from the *top* of the row, not a text baseline.
 * Mixing tops and baselines is what let an earlier version draw the value
 * string straight through the bar — a collision no unit test can see and a
 * screenshot shows instantly.
 *
 * Returns the y coordinate below the meter so callers stack sections without
 * hard-coding positions.
 */
function drawMeter(ctx: CanvasRenderingContext2D, top: number, options: MeterOptions): number {
  const { label, value, max, unit, color, warnBelow = 0, segments = 12 } = options
  const fraction = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0

  const critical = fraction <= warnBelow
  const barColor = critical ? Palette.danger : color

  drawLabel(ctx, label, CONTENT_X, top, { baseline: 'top' })

  // Unit first, right-aligned to the edge, then the value to its left. Keeps the
  // value's last digit a fixed distance from the edge as its width changes.
  const right = CONTENT_X + CONTENT_W
  const unitWidth = drawText(ctx, `/ ${max} ${unit}`, right, top + 2, {
    size: 10,
    align: 'right',
    baseline: 'top',
    color: Palette.textDim,
  })
  drawText(ctx, `${Math.round(value)}`, right - unitWidth - 5, top, {
    size: 13,
    weight: 600,
    align: 'right',
    baseline: 'top',
    color: critical ? Palette.danger : Palette.text,
  })

  const barTop = top + 18
  const barH = 8
  const gap = 2
  const segW = (CONTENT_W - gap * (segments - 1)) / segments
  const filledSegments = Math.round(fraction * segments)

  for (let i = 0; i < segments; i++) {
    const x = CONTENT_X + i * (segW + gap)
    ctx.fillStyle = i < filledSegments ? barColor : Palette.panelRaised
    ctx.fillRect(x, barTop, segW, barH)
  }

  return barTop + barH
}

/**
 * A label/value readout.
 *
 * The gap *within* a group (label to its value) is smaller than the gap
 * *between* groups, so proximity alone tells you which label owns which value.
 * Without that, `FIRE RATE` reads as a caption for the line above it.
 */
function drawRow(
  ctx: CanvasRenderingContext2D,
  top: number,
  label: string,
  value: string,
  unit = '',
  valueColor: string = Palette.text,
): number {
  drawLabel(ctx, label, CONTENT_X, top, { baseline: 'top' })
  drawValue(ctx, value, unit, CONTENT_X, top + 14, {
    size: 15,
    baseline: 'top',
    color: valueColor,
  })
  return top + 33
}

/**
 * A compact one-line readout: label left, value right-aligned on the same line.
 *
 * Used for the sortie log, where a dozen rows of the label-above-value form
 * would out-shout the meters they sit beneath. Sharing a line makes ownership
 * unambiguous — there is no vertical gap for the eye to misread, which is the
 * failure mode that once made `FIRE RATE` look like a caption for the value
 * above it.
 *
 * The hazard this form *does* have is the collision that put the warning in
 * drawMeter's comment: a long label runs into a right-aligned value. Rather than
 * trusting a character count, this measures both and drops the value onto its
 * own line if they would not fit. Degrading to two lines is ugly; overlapping
 * text is unreadable, and unreadable is a P0.
 */
const STAT_VALUE_SIZE = 13
/** Mirrors drawValue's internal unit sizing, so the measurement matches the draw. */
const STAT_UNIT_SIZE = Math.max(Font.minSizePx, STAT_VALUE_SIZE - 4)
const STAT_MIN_GAP = 10

function drawStatLine(
  ctx: CanvasRenderingContext2D,
  top: number,
  label: string,
  value: string,
  unit = '',
  valueColor: string = Palette.text,
): number {
  const right = CONTENT_X + CONTENT_W
  const labelWidth = measureText(ctx, label.toUpperCase(), { size: 12, tracking: 1.4 })
  const valueWidth = measureText(ctx, value, { size: STAT_VALUE_SIZE, weight: 600 })
  const unitWidth = unit ? measureText(ctx, unit, { size: STAT_UNIT_SIZE }) : 0
  const total = valueWidth + (unit ? 4 + unitWidth : 0)

  // The label is a point smaller than the value and both are positioned from
  // their tops, so it needs a unit of nudge to share an optical baseline.
  drawLabel(ctx, label, CONTENT_X, top + 1, { baseline: 'top' })

  if (labelWidth + STAT_MIN_GAP + total <= CONTENT_W) {
    drawValue(ctx, value, unit, right - total, top, {
      size: STAT_VALUE_SIZE,
      baseline: 'top',
      color: valueColor,
    })
    return top + 20
  }

  drawValue(ctx, value, unit, CONTENT_X, top + 15, {
    size: STAT_VALUE_SIZE,
    baseline: 'top',
    color: valueColor,
  })
  return top + 34
}

/** A faint section heading. Marks a group as secondary to the meters above it. */
function drawSectionHeading(ctx: CanvasRenderingContext2D, top: number, text: string): number {
  drawText(ctx, text.toUpperCase(), CONTENT_X, top, {
    size: 11,
    tracking: 2.2,
    baseline: 'top',
    color: Palette.textFaint,
  })
  return top + 17
}

/**
 * Accuracy as a percentage.
 *
 * Before the first shot there is no accuracy, and showing `0 %` would report a
 * failure the player has not had the chance to commit. An em dash says
 * "no data" without pretending to be a measurement.
 */
function formatAccuracy(hits: number, shotsFired: number): { value: string; unit: string } {
  if (shotsFired <= 0) return { value: '—', unit: '' }
  return { value: String(Math.round((hits / shotsFired) * 100)), unit: '%' }
}

export interface PanelState {
  pilotNumber: number
  hullName: string
  weaponName: string
  /** Shots per second, shown with a unit so it can't be mistaken for a multiplier. */
  fireRate: number
  // No `scrap` field: scrap is read from the run's own stats, so a caller cannot
  // hand the HUD a number that disagrees with the simulation.
  sector: number
  sectorCount: number
  /**
   * Waves in the current sector, for the progress readout. Omitted while the
   * sector script is not known to the caller, in which case the readout reports
   * waves released instead of a fraction — never a bare count.
   */
  waveCount?: number
}

export function drawPanel(
  ctx: CanvasRenderingContext2D,
  view: WorldView,
  state: PanelState,
): void {
  drawPanelFrame(ctx)

  // Spacing scale for this panel. BETWEEN_GROUPS is deliberately much larger
  // than the internal label-to-value gap inside drawRow, so grouping is
  // unambiguous by proximity alone.
  const BETWEEN_GROUPS = 16
  const BEFORE_DIVIDER = 14
  const AFTER_DIVIDER = 16

  let y = PAD + 8

  // Identity block — the title's premise, made literal.
  drawLabel(ctx, 'Pilot', CONTENT_X, y, { baseline: 'top' })
  drawText(ctx, `#${String(state.pilotNumber).padStart(3, '0')}`, CONTENT_X + CONTENT_W, y, {
    size: 12,
    weight: 600,
    align: 'right',
    baseline: 'top',
    color: Palette.textDim,
  })
  y += 18
  drawText(ctx, state.hullName.toUpperCase(), CONTENT_X, y, {
    size: 18,
    weight: 700,
    tracking: 1,
    baseline: 'top',
    color: Palette.self,
  })
  y += 22 + BEFORE_DIVIDER
  drawDivider(ctx, y)
  y += AFTER_DIVIDER

  // Meter labels are kept short deliberately: the label sits on the same line as
  // the right-aligned value, and a long one ("INTEGRITY") ran into it. Anything
  // longer than about 7 characters will not fit at this panel width.
  y = drawMeter(ctx, y, {
    label: 'Hull',
    value: view.hull.integrity,
    max: view.hull.maxIntegrity,
    unit: 'hp',
    color: Palette.good,
    warnBelow: 0.3,
  })
  y += BETWEEN_GROUPS

  y = drawMeter(ctx, y, {
    label: 'Shield',
    value: view.hull.shield,
    max: view.hull.maxShield,
    unit: 'sp',
    color: Palette.self,
    segments: 8,
  })
  y += BEFORE_DIVIDER
  drawDivider(ctx, y)
  y += AFTER_DIVIDER

  y = drawRow(ctx, y, 'Weapon', state.weaponName)
  y += BETWEEN_GROUPS
  y = drawRow(ctx, y, 'Fire rate', state.fireRate.toFixed(1), 'shots/s')
  y += BETWEEN_GROUPS
  // Scrap comes from the run, not the caller: a currency the HUD could get wrong
  // is a currency the player cannot trust.
  y = drawRow(ctx, y, 'Scrap', String(view.stats.scrap), 'cr', Palette.caution)
  y += BEFORE_DIVIDER
  drawDivider(ctx, y)
  y += AFTER_DIVIDER

  // Progress group. Sector and wave sit tight together with no BETWEEN_GROUPS
  // between them, because they answer one question — how far in am I — and
  // proximity is what says so.
  y = drawRow(ctx, y, 'Sector', `${state.sector} / ${state.sectorCount}`)
  const waves = state.waveCount ?? 0
  y = drawStatLine(
    ctx,
    y,
    'Wave',
    waves > 0 ? `${view.stats.waveIndex} / ${waves}` : String(view.stats.waveIndex),
    waves > 0 ? 'waves' : 'waves released',
  )
  // Footer: seed always visible, so any screenshot is a reproducible bug report.
  const footerTop = VIRTUAL_H - PAD - 34
  const footerDivider = footerTop - AFTER_DIVIDER

  // Sortie log: numbers a player checks *between* waves, not during one.
  //
  // Anchored up from the footer rather than flowed after the block above, for
  // two reasons. It fixes the log's position, so a value cannot appear to move
  // when a section above it grows — a readout that shifts is a readout you have
  // to find again. And it puts the one deliberate gap in the middle of the
  // column, where the held-items list belongs, instead of leaving a void at the
  // bottom that reads as unfinished.
  const LOG_H = 17 + 20 * 3
  const logTop = footerDivider - AFTER_DIVIDER - LOG_H
  drawDivider(ctx, logTop - AFTER_DIVIDER)

  let logY = drawSectionHeading(ctx, logTop, 'Sortie log')
  const accuracy = formatAccuracy(view.stats.hits, view.stats.shotsFired)
  logY = drawStatLine(ctx, logY, 'Kills', String(view.stats.kills), 'confirmed')
  logY = drawStatLine(ctx, logY, 'Accuracy', accuracy.value, accuracy.unit)
  drawStatLine(
    ctx,
    logY,
    'Hits',
    `${view.stats.hits} / ${view.stats.shotsFired}`,
    'shots',
    Palette.textDim,
  )

  drawDivider(ctx, footerDivider)
  drawLabel(ctx, 'Seed', CONTENT_X, footerTop, { baseline: 'top' })
  drawText(ctx, formatSeed(view.seed), CONTENT_X, footerTop + 15, {
    size: 12,
    baseline: 'top',
    color: Palette.textDim,
  })
}
