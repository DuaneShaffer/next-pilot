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
import type { World } from '../sim/world'
import { Palette } from './palette'
import { drawLabel, drawText, drawValue } from './text'

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

export interface PanelState {
  pilotNumber: number
  hullName: string
  weaponName: string
  /** Shots per second, shown with a unit so it can't be mistaken for a multiplier. */
  fireRate: number
  scrap: number
  sector: number
  sectorCount: number
}

export function drawPanel(
  ctx: CanvasRenderingContext2D,
  world: World,
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
    value: world.hull.integrity,
    max: world.hull.maxIntegrity,
    unit: 'hp',
    color: Palette.good,
    warnBelow: 0.3,
  })
  y += BETWEEN_GROUPS

  y = drawMeter(ctx, y, {
    label: 'Shield',
    value: world.hull.shield,
    max: world.hull.maxShield,
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
  y = drawRow(ctx, y, 'Scrap', String(state.scrap), 'cr', Palette.caution)
  y += BEFORE_DIVIDER
  drawDivider(ctx, y)
  y += AFTER_DIVIDER

  drawRow(ctx, y, 'Sector', `${state.sector} / ${state.sectorCount}`)

  // Footer: seed always visible, so any screenshot is a reproducible bug report.
  const footerTop = VIRTUAL_H - PAD - 34
  drawDivider(ctx, footerTop - AFTER_DIVIDER)
  drawLabel(ctx, 'Seed', CONTENT_X, footerTop, { baseline: 'top' })
  drawText(ctx, formatSeed(world.seed), CONTENT_X, footerTop + 15, {
    size: 12,
    baseline: 'top',
    color: Palette.textDim,
  })
}
