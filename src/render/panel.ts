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
 * A segmented meter with its label and numeric value.
 *
 * Returns the y coordinate below the meter, so callers stack sections without
 * hard-coding positions.
 */
function drawMeter(ctx: CanvasRenderingContext2D, y: number, options: MeterOptions): number {
  const { label, value, max, unit, color, warnBelow = 0, segments = 12 } = options
  const fraction = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0

  const critical = fraction <= warnBelow
  const barColor = critical ? Palette.danger : color

  drawLabel(ctx, label, CONTENT_X, y)
  drawText(ctx, `${Math.round(value)}`, CONTENT_X + CONTENT_W, y, {
    size: 12,
    weight: 600,
    align: 'right',
    color: critical ? Palette.danger : Palette.text,
  })
  drawText(ctx, ` / ${max} ${unit}`, CONTENT_X + CONTENT_W, y + 13, {
    size: 10,
    align: 'right',
    color: Palette.textDim,
  })

  const barY = y + 7
  const barH = 7
  const gap = 2
  const segW = (CONTENT_W - gap * (segments - 1)) / segments
  const filledSegments = Math.round(fraction * segments)

  for (let i = 0; i < segments; i++) {
    const x = CONTENT_X + i * (segW + gap)
    ctx.fillStyle = i < filledSegments ? barColor : Palette.panelRaised
    ctx.fillRect(x, barY, segW, barH)
  }

  return barY + barH
}

/** A label/value row for non-metered readouts. */
function drawRow(
  ctx: CanvasRenderingContext2D,
  y: number,
  label: string,
  value: string,
  unit = '',
  valueColor: string = Palette.text,
): number {
  drawLabel(ctx, label, CONTENT_X, y)
  drawValue(ctx, value, unit, CONTENT_X, y + 20, { size: 15, color: valueColor })
  return y + 26
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

  let y = PAD + 10

  // Identity block — the title's premise, made literal.
  drawLabel(ctx, 'Pilot', CONTENT_X, y)
  drawText(ctx, `#${String(state.pilotNumber).padStart(3, '0')}`, CONTENT_X + CONTENT_W, y, {
    size: 12,
    weight: 600,
    align: 'right',
    color: Palette.textDim,
  })
  y += 20
  drawText(ctx, state.hullName.toUpperCase(), CONTENT_X, y, {
    size: 17,
    weight: 700,
    tracking: 1,
    color: Palette.self,
  })
  y += 16
  drawDivider(ctx, y)
  y += 18

  y = drawMeter(ctx, y, {
    label: 'Integrity',
    value: world.hull.integrity,
    max: world.hull.maxIntegrity,
    unit: 'hp',
    color: Palette.good,
    warnBelow: 0.3,
  })
  y += 22

  y = drawMeter(ctx, y, {
    label: 'Shield',
    value: world.hull.shield,
    max: world.hull.maxShield,
    unit: 'sp',
    color: Palette.self,
    segments: 8,
  })
  y += 24
  drawDivider(ctx, y)
  y += 18

  y = drawRow(ctx, y, 'Weapon', state.weaponName, '', Palette.text)
  y += 6
  y = drawRow(ctx, y, 'Fire rate', state.fireRate.toFixed(1), 'shots/s', Palette.text)
  y += 6
  y = drawRow(ctx, y, 'Scrap', String(state.scrap), 'cr', Palette.caution)
  y += 10
  drawDivider(ctx, y)
  y += 18

  y = drawRow(
    ctx,
    y,
    'Sector',
    `${state.sector} / ${state.sectorCount}`,
    '',
    Palette.text,
  )

  // Footer: seed always visible, so any screenshot is a reproducible bug report.
  const footerY = VIRTUAL_H - PAD - 22
  drawDivider(ctx, footerY - 14)
  drawLabel(ctx, 'Seed', CONTENT_X, footerY)
  drawText(ctx, formatSeed(world.seed), CONTENT_X, footerY + 15, {
    size: 11,
    color: Palette.textDim,
  })
}
