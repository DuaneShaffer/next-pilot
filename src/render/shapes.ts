/**
 * Enemy geometry, defined in code.
 *
 * No image assets, ever (CLAUDE.md). The constraint that actually shapes this
 * file is legibility: six enemy classes a player must tell apart in a quarter of
 * a second while dodging, so each one owns a distinct *silhouette*.
 *
 *   hauler  wide armoured slab      skiff   small dart, nose down
 *   lancer  tall thin needle        turret  flat-topped dome with a barrel
 *   mine    spiked ball, spinning   escort  wide notched chevron
 *
 * Silhouette is the primary channel and colour is secondary, because UI.md rule
 * 3 forbids colour carrying information alone — a player with a colour vision
 * deficiency must still be able to name the thing shooting at them. That also
 * means the elite treatment is a *doubled outline* first and amber second.
 *
 * The drawing idiom is the player hull's: dark fill, bright thin outline. Dark
 * fill is what keeps a shape readable when additive glow piles up behind it; a
 * bright fill would dissolve into the explosion it is standing in.
 *
 * Geometry is authored in unit space and scaled by the instance's collision
 * radius, and every shape's bounding box reaches at least ±1 in both axes. That
 * is deliberate: the player's hull is drawn *larger* than it collides (a gift),
 * so enemies must be drawn no *smaller* than they collide, or the player gets
 * hit by empty space.
 *
 * Paths are built per enemy per frame rather than pre-rendered to sprites.
 * ARCHITECTURE.md warns off per-object path construction at "low thousands of
 * sprites" — that budget is spent on projectiles. Enemies number in the dozens,
 * and keeping them as live paths means one geometry definition serves every
 * radius crisply instead of a blurred upscale of a baked bitmap.
 */

import type { EnemyShape } from '../content/types'
import { Palette } from './palette'

type Point = readonly [number, number]

/** Traces a closed polygon in unit space, scaled by `r`. */
function poly(ctx: CanvasRenderingContext2D, r: number, points: readonly Point[]): void {
  ctx.beginPath()
  const first = points[0]
  if (!first) return
  ctx.moveTo(first[0] * r, first[1] * r)
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    if (!p) continue
    ctx.lineTo(p[0] * r, p[1] * r)
  }
  ctx.closePath()
}

/** A single straight interior marking, in unit space. */
function seam(ctx: CanvasRenderingContext2D, r: number, a: Point, b: Point): void {
  ctx.beginPath()
  ctx.moveTo(a[0] * r, a[1] * r)
  ctx.lineTo(b[0] * r, b[1] * r)
  ctx.stroke()
}

const HAULER: readonly Point[] = [
  [-1.34, -0.5],
  [-0.9, -0.96],
  [0.9, -0.96],
  [1.34, -0.5],
  [1.34, 0.5],
  [0.9, 0.96],
  [-0.9, 0.96],
  [-1.34, 0.5],
]

const SKIFF: readonly Point[] = [
  [0, 1.2],
  [1.0, -0.2],
  [0.5, -0.92],
  [-0.5, -0.92],
  [-1.0, -0.2],
]

// Wings sweep *backward* from a long nose and the tail is cut flat. An earlier
// version put the wings out square and tapered the tail to a point, and the
// result read as a four-pointed star — symmetrical, and therefore silent about
// which way the thing was travelling.
const LANCER: readonly Point[] = [
  [0, 1.32],
  [0.22, 0.14],
  [1.0, -0.62],
  [0.46, -0.66],
  [0.42, -0.92],
  [-0.42, -0.92],
  [-0.46, -0.66],
  [-1.0, -0.62],
  [-0.22, 0.14],
]

// Bottom apex first, then back up over the notch: a boomerang, not a triangle.
const ESCORT: readonly Point[] = [
  [0, 1.12],
  [1.26, -0.46],
  [0.6, -0.86],
  [0, 0.06],
  [-0.6, -0.86],
  [-1.26, -0.46],
]

const MINE_SPIKES = 8
const MINE_TIP = 1.24
const MINE_VALLEY = 0.66

interface ShapeSpec {
  /** Traces the silhouette, centred on the origin. Never fills or strokes. */
  outline(ctx: CanvasRenderingContext2D, r: number): void
  /** Interior markings, drawn in `stroke` after the silhouette. */
  detail(ctx: CanvasRenderingContext2D, r: number, stroke: string): void
  /**
   * Radians of idle rotation per tick. Non-zero only where rotation is itself a
   * recognition cue — a slowly spinning ball of spikes reads as "mine" before
   * the player has consciously identified the shape.
   */
  spinPerTick: number
  /** How far the silhouette reaches above the centre, in radii. */
  topExtent: number
}

const SHAPES: Record<EnemyShape, ShapeSpec> = {
  hauler: {
    outline: (ctx, r) => poly(ctx, r, HAULER),
    detail: (ctx, r, stroke) => {
      ctx.strokeStyle = stroke
      ctx.lineWidth = 1
      // Container seams: they read as "freighter" and give the wide slab scale.
      seam(ctx, r, [-0.45, -0.9], [-0.45, 0.9])
      seam(ctx, r, [0.45, -0.9], [0.45, 0.9])
    },
    spinPerTick: 0,
    topExtent: 0.96,
  },

  skiff: {
    outline: (ctx, r) => poly(ctx, r, SKIFF),
    detail: (ctx, r, stroke) => {
      // A single bright chip near the nose: tiny, but it tells you which way the
      // thing is pointed when it is only ten units across.
      ctx.fillStyle = stroke
      ctx.fillRect(-0.16 * r, 0.16 * r, 0.32 * r, 0.34 * r)
    },
    spinPerTick: 0,
    topExtent: 0.92,
  },

  lancer: {
    outline: (ctx, r) => poly(ctx, r, LANCER),
    detail: (ctx, r, stroke) => {
      ctx.strokeStyle = stroke
      ctx.lineWidth = 1
      seam(ctx, r, [0, -0.82], [0, 0.9])
    },
    spinPerTick: 0,
    topExtent: 0.92,
  },

  turret: {
    outline: (ctx, r) => {
      ctx.beginPath()
      // Mounting plate across the top, then a dome bulging toward the player.
      ctx.moveTo(-1.06 * r, -1.0 * r)
      ctx.lineTo(1.06 * r, -1.0 * r)
      ctx.lineTo(1.06 * r, -0.56 * r)
      ctx.lineTo(0.86 * r, -0.56 * r)
      ctx.arc(0, -0.56 * r, 0.86 * r, 0, Math.PI, false)
      ctx.lineTo(-1.06 * r, -0.56 * r)
      ctx.closePath()
      // Barrel as a second subpath so one fill and one stroke cover both. Its
      // top edge sits inside the dome and reads as a mantlet seam.
      ctx.rect(-0.2 * r, 0.22 * r, 0.4 * r, 1.0 * r)
    },
    detail: (ctx, r, stroke) => {
      // The muzzle is the brightest point: it is the part that matters.
      ctx.fillStyle = stroke
      ctx.fillRect(-0.13 * r, 1.06 * r, 0.26 * r, 0.14 * r)
    },
    spinPerTick: 0,
    topExtent: 1.0,
  },

  mine: {
    outline: (ctx, r) => {
      ctx.beginPath()
      for (let i = 0; i < MINE_SPIKES * 2; i++) {
        const angle = (i / (MINE_SPIKES * 2)) * Math.PI * 2
        const reach = (i % 2 === 0 ? MINE_TIP : MINE_VALLEY) * r
        const x = Math.cos(angle) * reach
        const y = Math.sin(angle) * reach
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
    },
    detail: (ctx, r, stroke) => {
      ctx.strokeStyle = stroke
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(0, 0, 0.42 * r, 0, Math.PI * 2)
      ctx.stroke()
    },
    // ~0.36 rad/s: visible as rotation, slow enough not to read as a strobe.
    spinPerTick: 0.006,
    topExtent: MINE_TIP,
  },

  escort: {
    outline: (ctx, r) => poly(ctx, r, ESCORT),
    detail: (ctx, r, stroke) => {
      ctx.strokeStyle = stroke
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(-0.72 * r, -0.34 * r)
      ctx.lineTo(0, 0.56 * r)
      ctx.lineTo(0.72 * r, -0.34 * r)
      ctx.stroke()
    },
    spinPerTick: 0,
    topExtent: 0.86,
  },
}

type Rgb = readonly [number, number, number]

/**
 * Colour mixing in component space rather than on hex strings.
 *
 * Deliberately not "mix two hex strings": the outline colour is now the result of
 * up to two mixes (windup, then hit flash), and a string-based helper cannot take
 * its own output as input without re-parsing something that is no longer hex. That
 * was a real bug — the second mix parsed `rgb(...)` as base-16 and produced NaN,
 * which paints nothing at all.
 *
 * Hand-rolled rather than pulled in: this project has no runtime dependencies.
 */
function parseHex(hex: string): Rgb {
  const value = parseInt(hex.slice(1), 16)
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const k = t < 0 ? 0 : t > 1 ? 1 : t
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ]
}

function rgbCss(rgb: Rgb): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
}

/** Near-white, used for the hit flash. Not `#FFFFFF`: pure white reads as a UI element. */
const FLASH_EDGE = parseHex('#F4FBFF')
const FLASH_FILL = parseHex('#6E8598')
const HOSTILE = parseHex(Palette.hostile)
const HOSTILE_ELITE = parseHex(Palette.hostileElite)
const HOSTILE_FILL = parseHex(Palette.hostileFill)
const CAUTION = parseHex(Palette.caution)

export interface EnemyShapeStyle {
  /** Reinforced variant. Doubled outline plus `hostileElite`. */
  elite?: boolean
  /** 0..1 hit-flash intensity, from `hitFlashStrength()` in effects.ts. */
  flash?: number
  /** Interpolated age in ticks, for shapes whose rotation is a recognition cue. */
  age?: number
  /**
   * 0..1 firing windup, 1 being the tick the shot leaves. Warms the outline
   * toward `caution` and thickens it.
   *
   * The silhouette itself carrying the windup matters: the telegraph ring in
   * effects.ts can be occluded or lost in a crowd, but a hull visibly tensing
   * cannot be mistaken for a hull sitting still. `caution` rather than `danger`,
   * because nothing has been fired yet — see UI.md rule 3.
   */
  charge?: number
}

/** How far above its centre a shape draws, in virtual units. Negative is up. */
export function enemyTopOffset(shape: EnemyShape, radius: number): number {
  const spec = SHAPES[shape]
  return -spec.topExtent * radius
}

/**
 * Draw one enemy silhouette.
 *
 * Position is already interpolated by the caller; this function is pure
 * geometry and knows nothing about the simulation.
 */
export function drawEnemyShape(
  ctx: CanvasRenderingContext2D,
  shape: EnemyShape,
  x: number,
  y: number,
  radius: number,
  style: EnemyShapeStyle = {},
): void {
  const spec = SHAPES[shape]
  const { elite = false, flash = 0, age = 0, charge = 0 } = style

  const base = elite ? HOSTILE_ELITE : HOSTILE
  // Windup warms the steel; the hit flash then whitens whatever that produced, so
  // an enemy hit mid-windup still reads as hit.
  let edge = charge > 0 ? mixRgb(base, CAUTION, Math.min(1, charge) * 0.85) : base
  // The flash brightens fill and edge but never alters the outline, so the
  // silhouette a player is tracking cannot change shape when it is hit.
  if (flash > 0) edge = mixRgb(edge, FLASH_EDGE, flash)
  const strokeColor = rgbCss(edge)
  const fillColor =
    flash > 0 ? rgbCss(mixRgb(HOSTILE_FILL, FLASH_FILL, flash * 0.9)) : Palette.hostileFill

  ctx.save()
  ctx.translate(x, y)
  if (spec.spinPerTick !== 0) ctx.rotate(age * spec.spinPerTick)

  spec.outline(ctx, radius)
  ctx.fillStyle = fillColor
  ctx.fill()
  ctx.strokeStyle = strokeColor
  // Thickening with the windup gives the cue a second, colour-blind-safe channel.
  ctx.lineWidth = (elite ? 2 : 1.5) + 0.9 * Math.min(1, Math.max(0, charge))
  ctx.stroke()

  // Elite marking: a second, inset trace of the same outline. A doubled edge is
  // a silhouette-level difference, so "this one is reinforced" survives both a
  // greyscale screenshot and a colour-blind player.
  if (elite) {
    spec.outline(ctx, radius * 0.56)
    ctx.lineWidth = 1
    ctx.globalAlpha = 0.8
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  spec.detail(ctx, radius, strokeColor)
  ctx.restore()
}
