/**
 * Text drawing helpers.
 *
 * Tracking (letter spacing) is applied manually rather than via ctx.letterSpacing
 * so it behaves identically in every browser and in headless screenshots. Since
 * everything is monospace, per-character advance is uniform and exact.
 */

import { font, Font, Palette } from './palette'

export interface TextOptions {
  size?: number
  weight?: 400 | 600 | 700
  color?: string
  align?: 'left' | 'center' | 'right'
  baseline?: CanvasTextBaseline
  /** Extra pixels between characters. Wide tracking reads as "instrument label". */
  tracking?: number
}

export function measureText(
  ctx: CanvasRenderingContext2D,
  text: string,
  options: TextOptions = {},
): number {
  const { size = 13, weight = 400, tracking = 0 } = options
  ctx.font = font(size, weight)
  const base = ctx.measureText(text).width
  return text.length > 1 ? base + tracking * (text.length - 1) : base
}

export function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: TextOptions = {},
): number {
  const {
    size = 13,
    weight = 400,
    color = Palette.text,
    align = 'left',
    baseline = 'alphabetic',
    tracking = 0,
  } = options

  ctx.font = font(size, weight)
  ctx.fillStyle = color
  ctx.textBaseline = baseline
  ctx.textAlign = 'left'

  const width = measureText(ctx, text, options)
  let cursor = x
  if (align === 'center') cursor = x - width / 2
  else if (align === 'right') cursor = x - width

  if (tracking === 0) {
    ctx.fillText(text, cursor, y)
    return width
  }

  for (const char of text) {
    ctx.fillText(char, cursor, y)
    cursor += ctx.measureText(char).width + tracking
  }
  return width
}

/** A dim, wide-tracked, uppercase label. The panel's standard field name. */
export function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options: TextOptions = {},
): number {
  return drawText(ctx, text.toUpperCase(), x, y, {
    size: 12,
    color: Palette.textDim,
    tracking: 1.4,
    ...options,
  })
}

/**
 * A value with its unit.
 *
 * THE RULE: no bare numbers in the UI. A player should never have to guess
 * whether 1.15 is a multiplier, a percentage, or seconds. The unit is drawn
 * dimmer than the value so scanning stays fast.
 */
export function drawValue(
  ctx: CanvasRenderingContext2D,
  value: string,
  unit: string,
  x: number,
  y: number,
  options: TextOptions = {},
): number {
  const { size = 16, color = Palette.text, baseline } = options
  const valueWidth = drawText(ctx, value, x, y, { ...options, size, weight: 600, color })
  if (!unit) return valueWidth
  // The unit must inherit the caller's baseline, or it drifts off the value's
  // line whenever the caller positions by top rather than by baseline.
  const unitWidth = drawText(ctx, unit, x + valueWidth + 4, y, {
    size: Math.max(Font.minSizePx, size - 4),
    color: Palette.textDim,
    ...(baseline ? { baseline } : {}),
  })
  return valueWidth + 4 + unitWidth
}
