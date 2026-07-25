/**
 * Title screen.
 *
 * Doubles as the reference implementation of the interface language: cold
 * instrumentation, monospace with wide tracking on labels, one accent colour,
 * corner brackets instead of boxes. Deliberately full-bleed — the panel column
 * only appears once a sortie starts, so the game's first frame isn't a form.
 */

import { formatSeed } from '../core/seed'
import { VIRTUAL_H, VIRTUAL_W } from '../core/space'
import { Palette } from '../render/palette'
import type { Starfield } from '../render/starfield'
import { drawText } from '../render/text'

export interface TitleScreenState {
  seed: string
  pilotNumber: number
  /** Ticks elapsed, for the prompt's slow pulse. */
  tick: number
  version: string
}

/** Corner brackets. Cheaper on the eye than a full border and reads as a HUD. */
function drawCornerBrackets(ctx: CanvasRenderingContext2D): void {
  const inset = 18
  const len = 26
  ctx.strokeStyle = Palette.line
  ctx.lineWidth = 1
  const corners: ReadonlyArray<readonly [number, number, number, number]> = [
    [inset, inset, 1, 1],
    [VIRTUAL_W - inset, inset, -1, 1],
    [inset, VIRTUAL_H - inset, 1, -1],
    [VIRTUAL_W - inset, VIRTUAL_H - inset, -1, -1],
  ]
  for (const [x, y, dx, dy] of corners) {
    ctx.beginPath()
    ctx.moveTo(x + dx * len, y)
    ctx.lineTo(x, y)
    ctx.lineTo(x, y + dy * len)
    ctx.stroke()
  }
}

export function drawTitleScreen(
  ctx: CanvasRenderingContext2D,
  starfield: Starfield,
  state: TitleScreenState,
): void {
  ctx.fillStyle = Palette.void
  ctx.fillRect(0, 0, VIRTUAL_W, VIRTUAL_H)
  starfield.draw(ctx)

  // A faint horizon glow gives the void some depth without costing legibility.
  const glow = ctx.createRadialGradient(
    VIRTUAL_W / 2,
    VIRTUAL_H * 0.42,
    0,
    VIRTUAL_W / 2,
    VIRTUAL_H * 0.42,
    VIRTUAL_W * 0.62,
  )
  glow.addColorStop(0, 'rgba(92, 224, 240, 0.10)')
  glow.addColorStop(1, 'rgba(92, 224, 240, 0)')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, VIRTUAL_W, VIRTUAL_H)

  drawCornerBrackets(ctx)

  const cx = VIRTUAL_W / 2

  drawText(ctx, 'Salvage Division // Personnel Deployment', cx, VIRTUAL_H * 0.3, {
    size: 11,
    align: 'center',
    tracking: 2.5,
    color: Palette.textDim,
  })

  // The wordmark. Two lines, heavy tracking — it should read as stencilled onto
  // equipment rather than designed.
  drawText(ctx, 'NEXT', cx, VIRTUAL_H * 0.385, {
    size: 62,
    weight: 700,
    align: 'center',
    tracking: 10,
    color: Palette.text,
  })
  drawText(ctx, 'PILOT', cx, VIRTUAL_H * 0.465, {
    size: 62,
    weight: 700,
    align: 'center',
    tracking: 10,
    color: Palette.self,
  })

  ctx.fillStyle = Palette.line
  ctx.fillRect(cx - 90, VIRTUAL_H * 0.495, 180, 1)

  drawText(ctx, 'A vertical shooter roguelike', cx, VIRTUAL_H * 0.535, {
    size: 13,
    align: 'center',
    tracking: 1.5,
    color: Palette.textDim,
  })

  // Slow pulse — a 1.6s cycle that never fully disappears, so it draws the eye
  // without flashing. Hard blinking is an accessibility problem, not polish.
  const pulse = 0.62 + 0.38 * Math.sin(state.tick * 0.065)
  ctx.globalAlpha = pulse
  drawText(ctx, 'Press ENTER to report for duty', cx, VIRTUAL_H * 0.615, {
    size: 15,
    weight: 600,
    align: 'center',
    tracking: 1,
    color: Palette.caution,
  })
  ctx.globalAlpha = 1

  drawText(
    ctx,
    'Move: WASD / Arrows    Fire: Space    Focus: Ctrl',
    cx,
    VIRTUAL_H * 0.672,
    { size: 12, align: 'center', tracking: 0.5, color: Palette.textFaint },
  )

  // Bottom corners: identity on the left, reproducibility on the right.
  //
  // Positioned clear of the corner brackets, which occupy 26 units along each
  // edge from an 18-unit inset. An earlier version put the version string at
  // y-20 and it cut straight through the bottom-right bracket.
  const footerTop = VIRTUAL_H - 62
  drawText(
    ctx,
    `Pilot #${String(state.pilotNumber).padStart(3, '0')} standing by`,
    52,
    footerTop,
    { size: 12, tracking: 1, baseline: 'top', color: Palette.textFaint },
  )
  drawText(ctx, `Seed ${formatSeed(state.seed)}`, VIRTUAL_W - 52, footerTop, {
    size: 12,
    align: 'right',
    tracking: 1,
    baseline: 'top',
    color: Palette.textFaint,
  })
  drawText(ctx, state.version, VIRTUAL_W - 52, footerTop + 15, {
    size: 12,
    align: 'right',
    baseline: 'top',
    color: Palette.textFaint,
  })
}
