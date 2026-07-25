/**
 * Playfield rendering.
 *
 * Reads simulation state and draws it; never writes to it. Positions are
 * interpolated between the last two ticks by `alpha`, so motion is smooth on
 * displays faster than the 60Hz simulation.
 */

import type { Bullet, Hull } from '../sim/world'
import type { World } from '../sim/world'
import { PLAYFIELD_H, PLAYFIELD_W } from '../core/space'
import { Palette } from './palette'
import type { Starfield } from './starfield'

function lerp(prev: number, next: number, alpha: number): number {
  return prev + (next - prev) * alpha
}

export function drawPlayfieldBackground(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = Palette.void
  ctx.fillRect(0, 0, PLAYFIELD_W, PLAYFIELD_H)
}

/** Soft darkening at the edges, so bright projectiles read against the frame. */
export function drawVignette(ctx: CanvasRenderingContext2D): void {
  const gradient = ctx.createRadialGradient(
    PLAYFIELD_W / 2,
    PLAYFIELD_H / 2,
    PLAYFIELD_H * 0.28,
    PLAYFIELD_W / 2,
    PLAYFIELD_H / 2,
    PLAYFIELD_H * 0.78,
  )
  gradient.addColorStop(0, 'rgba(0,0,0,0)')
  gradient.addColorStop(1, 'rgba(0,0,0,0.45)')
  ctx.fillStyle = gradient
  ctx.fillRect(0, 0, PLAYFIELD_W, PLAYFIELD_H)
}

function drawHull(ctx: CanvasRenderingContext2D, hull: Hull, alpha: number, tick: number): void {
  const x = lerp(hull.prevX, hull.x, alpha)
  const y = lerp(hull.prevY, hull.y, alpha)

  // Engine plume first, so the hull sits on top of it.
  const flicker = 0.7 + 0.3 * Math.sin(tick * 0.9)
  ctx.globalCompositeOperation = 'lighter'
  const plume = ctx.createLinearGradient(x, y + 10, x, y + 10 + 22 * flicker)
  plume.addColorStop(0, Palette.glowSelf)
  plume.addColorStop(1, 'rgba(92, 224, 240, 0)')
  ctx.fillStyle = plume
  ctx.beginPath()
  ctx.moveTo(x - 5, y + 10)
  ctx.lineTo(x + 5, y + 10)
  ctx.lineTo(x, y + 10 + 22 * flicker)
  ctx.closePath()
  ctx.fill()
  ctx.globalCompositeOperation = 'source-over'

  // Hull body: dark fill with a bright edge keeps the silhouette readable even
  // against a screen full of glow.
  ctx.beginPath()
  ctx.moveTo(x, y - 14)
  ctx.lineTo(x + 11, y + 8)
  ctx.lineTo(x + 4, y + 12)
  ctx.lineTo(x - 4, y + 12)
  ctx.lineTo(x - 11, y + 8)
  ctx.closePath()
  ctx.fillStyle = '#0B1E28'
  ctx.fill()
  ctx.strokeStyle = Palette.self
  ctx.lineWidth = 1.5
  ctx.stroke()

  // Cockpit: the single brightest point on the player's ship, so the eye locks
  // to the exact hitbox centre under pressure.
  ctx.fillStyle = '#EAFDFF'
  ctx.fillRect(x - 1.5, y - 6, 3, 5)
}

/**
 * Player projectiles, drawn as long thin tracers.
 *
 * An earlier version used short wide rectangles at a wide muzzle offset, and the
 * result read as pairs of tally marks marching up the screen rather than as
 * gunfire — while also competing with the player's ship for attention. Tracers
 * are narrow, long, and dimmer than the hull, so they imply a stream and stay
 * subordinate to the thing the player must never lose track of.
 */
function drawBullets(ctx: CanvasRenderingContext2D, bullets: readonly Bullet[], alpha: number): void {
  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = Palette.glowProjectile
  for (const b of bullets) {
    const x = lerp(b.prevX, b.x, alpha)
    const y = lerp(b.prevY, b.y, alpha)
    ctx.fillRect(x - 2, y - 14, 4, 28)
  }
  ctx.globalCompositeOperation = 'source-over'

  ctx.fillStyle = '#CFF4FA'
  for (const b of bullets) {
    const x = lerp(b.prevX, b.x, alpha)
    const y = lerp(b.prevY, b.y, alpha)
    ctx.fillRect(x - 0.75, y - 11, 1.5, 22)
  }
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  world: World,
  starfield: Starfield,
  alpha: number,
): void {
  drawPlayfieldBackground(ctx)
  starfield.draw(ctx)
  drawBullets(ctx, world.bullets, alpha)
  drawHull(ctx, world.hull, alpha, world.stats.tick)
  drawVignette(ctx)
}
