/**
 * Impact effects: explosions, hit flashes, and the hull's damage response.
 *
 * Two rules govern everything here.
 *
 * **The simulation owns timing, this file owns appearance.** An `Explosion`
 * carries age, lifetime, radius and kind; the visual is derived from those every
 * frame, interpolated by the render alpha. Nothing here keeps mutable state
 * between frames, which means effects cannot desynchronise from a replay and a
 * screenshot at tick N always looks the same.
 *
 * **Glow is pre-baked, never blurred per frame.** `shadowBlur` on a Canvas2D
 * context costs a full-surface blur per draw call and will eat the entire 8ms
 * frame budget with a handful of explosions on screen. So soft radial sprites
 * are rendered once to offscreen canvases and blitted with `'lighter'`
 * compositing, which is what ARCHITECTURE.md specifies.
 *
 * Rule 10 of UI.md constrains the look: impacts brighten, they never strobe, and
 * nothing here touches the full screen.
 */

import type { Explosion, ExplosionKind } from '../sim/entities'
import { Palette } from './palette'

export type GlowTint = 'warm' | 'hot' | 'danger' | 'self' | 'elite'

const GLOW_RGB: Record<GlowTint, readonly [number, number, number]> = {
  /** Explosion body. */
  warm: [255, 176, 92],
  /** Explosion core and hit flash: hotter and whiter than `warm`. */
  hot: [255, 236, 208],
  danger: [255, 74, 56],
  self: [92, 224, 240],
  elite: [245, 185, 66],
}

/**
 * Sprite resolution. 96 is enough that a 60-unit blast has no visible banding,
 * and small enough that all five tints together cost well under a megabyte.
 */
const SPRITE_PX = 96

/**
 * Hard caps. A pathological frame — a wave wiped by a chain reaction — must
 * degrade by drawing fewer effects, never by missing the frame. Effects are
 * cosmetic; the sim state they describe is still correct.
 */
const MAX_EXPLOSIONS_DRAWN = 24
const MAX_SHARDS = 8

/**
 * Ticks over which a hit flash decays for display purposes.
 *
 * Deliberately not imported from the sim: the sim's flash duration is a balance
 * knob, and if it changes, the worst outcome here is a flash that holds full
 * brightness slightly longer. Coupling rendering to a sim constant to avoid that
 * would be the wrong trade.
 */
const HIT_FLASH_TICKS = 5

let glowSprites: Record<GlowTint, HTMLCanvasElement> | null = null
let glowUnavailable = false

/**
 * Build the glow sprites on first use rather than at module load.
 *
 * Module-load creation would break `import`ing anything in this file from a Node
 * test, where `document` does not exist. First-use is still exactly once per
 * session, which is the property that matters.
 */
function sprites(): Record<GlowTint, HTMLCanvasElement> | null {
  if (glowSprites) return glowSprites
  if (glowUnavailable || typeof document === 'undefined') {
    glowUnavailable = true
    return null
  }

  const built: Partial<Record<GlowTint, HTMLCanvasElement>> = {}
  for (const tint of Object.keys(GLOW_RGB) as GlowTint[]) {
    const rgb = GLOW_RGB[tint]
    const canvas = document.createElement('canvas')
    canvas.width = SPRITE_PX
    canvas.height = SPRITE_PX
    const sctx = canvas.getContext('2d')
    if (!sctx) {
      glowUnavailable = true
      return null
    }
    const half = SPRITE_PX / 2
    const gradient = sctx.createRadialGradient(half, half, 0, half, half, half)
    const [r, g, b] = rgb
    // A steep centre and a long tail: reads as light rather than as a disc with
    // a soft edge, which is what a linear ramp looks like.
    gradient.addColorStop(0, `rgba(${r}, ${g}, ${b}, 1)`)
    gradient.addColorStop(0.22, `rgba(${r}, ${g}, ${b}, 0.52)`)
    gradient.addColorStop(0.52, `rgba(${r}, ${g}, ${b}, 0.15)`)
    gradient.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`)
    sctx.fillStyle = gradient
    sctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX)
    built[tint] = canvas
  }

  glowSprites = built as Record<GlowTint, HTMLCanvasElement>
  return glowSprites
}

/**
 * Blit one pre-baked glow sprite.
 *
 * The caller is responsible for the composite mode, so a whole pass of glows
 * costs one state change instead of two per sprite. `radius` is the visual
 * reach, not the bright core.
 */
export function blitGlow(
  ctx: CanvasRenderingContext2D,
  tint: GlowTint,
  x: number,
  y: number,
  radius: number,
  alpha: number,
): void {
  if (alpha <= 0.004 || radius <= 0) return
  const set = sprites()
  if (!set) return
  ctx.globalAlpha = alpha > 1 ? 1 : alpha
  ctx.drawImage(set[tint], x - radius, y - radius, radius * 2, radius * 2)
  ctx.globalAlpha = 1
}

/**
 * Deterministic 0..1 from two numbers.
 *
 * Explosion debris must not use `Math.random()`: a re-render of the same tick
 * would scatter differently, which breaks screenshot comparison and makes
 * effects flicker at frame rates above the tick rate. Hashing the explosion's
 * own position gives every blast its own stable, unrepeated scatter for free.
 */
function hash01(a: number, b: number): number {
  let h = Math.imul(Math.round(a * 8191) ^ Math.round(b * 131071), 0x27d4eb2d)
  h ^= h >>> 15
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  return (h >>> 8) / 0x1000000
}

function easeOut(t: number): number {
  const inv = 1 - t
  return 1 - inv * inv
}

interface ExplosionStyle {
  core: GlowTint
  body: GlowTint
  /** Shockwave ring colour, as `rgb` components so alpha can be animated. */
  ring: readonly [number, number, number]
  shards: number
  /** Peak shockwave radius as a multiple of the explosion's radius. */
  ringReach: number
  /** Peak glow radius as a multiple of the explosion's radius. */
  glowReach: number
}

/**
 * Per-kind treatment.
 *
 * `mine` is the one place an explosion is tinted with `danger`, and it earns it:
 * a detonating mine is a lethal area for the frames it is expanding, which is
 * exactly the "can hurt you right now" test in UI.md rule 3. A destroyed enemy
 * is harmless, so it burns warm instead.
 */
const EXPLOSION_STYLE: Record<ExplosionKind, ExplosionStyle> = {
  enemy: { core: 'hot', body: 'warm', ring: [255, 208, 150], shards: 5, ringReach: 0.85, glowReach: 1.15 },
  mine: { core: 'hot', body: 'danger', ring: [255, 130, 96], shards: 8, ringReach: 1.15, glowReach: 1.4 },
  hull: { core: 'hot', body: 'danger', ring: [255, 150, 120], shards: 8, ringReach: 1.5, glowReach: 1.8 },
}

/**
 * Draw every live explosion.
 *
 * The whole pass runs additive, so overlapping blasts accumulate light the way
 * light does, and the pass costs two composite changes in total.
 */
export function drawExplosions(
  ctx: CanvasRenderingContext2D,
  explosions: readonly Explosion[],
  alpha: number,
): void {
  const count = Math.min(explosions.length, MAX_EXPLOSIONS_DRAWN)
  if (count === 0) return

  ctx.globalCompositeOperation = 'lighter'

  for (let i = 0; i < count; i++) {
    const e = explosions[i]
    if (!e) continue
    const lifetime = e.lifetime > 0 ? e.lifetime : 1
    // Age is advanced by the sim once per tick, so the render alpha has to carry
    // it the rest of the way or the effect steps at 60Hz on a 144Hz display.
    const t = Math.min(1, Math.max(0, (e.age + alpha) / lifetime))
    const fade = (1 - t) * (1 - t)
    const style = EXPLOSION_STYLE[e.kind]

    blitGlow(ctx, style.body, e.x, e.y, e.radius * style.glowReach * (0.5 + 0.7 * t), fade * 0.95)
    // The core is the part that reads as "something was destroyed here", so it
    // is the brightest and the shortest-lived thing in the effect.
    blitGlow(ctx, style.core, e.x, e.y, e.radius * (0.72 - 0.34 * t), fade * 1.1)

    // Shockwave: a thinning ring is what gives an explosion a readable size and
    // a readable *end*. A pure fading blob just dims.
    //
    // Reach and lifetime are both deliberately short. An earlier pass let the
    // ring travel to ~2.9x the blast radius and fade linearly, and a screenshot
    // showed the result immediately: thin bright circles that read as soap
    // bubbles, larger and louder than the enemy projectiles they were drawn
    // among. Nothing cosmetic may out-shout the things that can kill you.
    const ringR = e.radius * (0.3 + style.ringReach * easeOut(t))
    // The ring fades faster than the core (cubed against squared) so the effect
    // never spends its middle life as a hollow outline with nothing inside it.
    const ringAlpha = (1 - t) * (1 - t) * (1 - t) * 0.9
    if (ringAlpha > 0.01) {
      const [r, g, b] = style.ring
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${ringAlpha.toFixed(3)})`
      ctx.lineWidth = 1.2 + 3.2 * (1 - t)
      ctx.beginPath()
      ctx.arc(e.x, e.y, ringR, 0, Math.PI * 2)
      ctx.stroke()
    }

    // Debris. Capped, and hashed from the blast's own position so a given
    // explosion always throws the same pieces the same way.
    const shards = Math.min(style.shards, MAX_SHARDS)
    const spread = e.radius * (0.5 + 1.5 * easeOut(t))
    const shardAlpha = fade * 0.9
    if (shardAlpha > 0.02) {
      const [r, g, b] = style.ring
      ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${shardAlpha.toFixed(3)})`
      for (let s = 0; s < shards; s++) {
        const angle = hash01(e.x + s * 7.3, e.y - s * 3.1) * Math.PI * 2
        const reach = spread * (0.55 + 0.45 * hash01(e.y + s * 11.7, e.x + s * 5.9))
        const size = 2.6 * (1 - t) + 0.5
        ctx.fillRect(
          e.x + Math.cos(angle) * reach - size / 2,
          e.y + Math.sin(angle) * reach - size / 2,
          size,
          size,
        )
      }
    }
  }

  ctx.globalCompositeOperation = 'source-over'
}

/** 0..1 flash intensity for an enemy's `hitFlashTicks`. Zero means no flash. */
export function hitFlashStrength(ticks: number): number {
  if (ticks <= 0) return 0
  return Math.min(1, ticks / HIT_FLASH_TICKS)
}

/**
 * The additive half of a hit flash.
 *
 * The silhouette half is in shapes.ts, because brightening the outline has to
 * happen while the shape is being stroked. This adds the bloom around it, and
 * expects the caller to have already switched to `'lighter'` so a whole wave of
 * flashes is one pass.
 */
export function drawHitFlash(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  strength: number,
): void {
  if (strength <= 0) return
  blitGlow(ctx, 'hot', x, y, radius * 2.1, strength * 0.42)
}

/**
 * The ring shown while the hull is in post-hit invulnerability.
 *
 * Two jobs, both from UI.md. Rule 9: the panel's integrity meter dropping is a
 * change nobody sees during a firefight, so damage has to be announced on the
 * ship itself. Rule 10: the arcade idiom for invulnerability is a fast blink,
 * which is a photosensitivity hazard — so this is a *segmented* ring instead.
 * Segments make it unmistakably different from the shield ring without any
 * flashing, and without relying on the red alone.
 */
export function drawInvulnRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  tick: number,
  ticksRemaining: number,
): void {
  if (ticksRemaining <= 0) return

  const segments = 6
  const gap = 0.34
  const step = (Math.PI * 2) / segments
  // ~0.9Hz breathing that never reaches zero opacity, per rule 10.
  const pulse = 0.66 + 0.34 * Math.sin(tick * 0.095)

  ctx.strokeStyle = Palette.danger
  ctx.globalAlpha = 0.55 * pulse
  ctx.lineWidth = 2
  for (let i = 0; i < segments; i++) {
    const start = i * step + gap / 2
    ctx.beginPath()
    ctx.arc(x, y, radius, start, start + step - gap)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  ctx.globalCompositeOperation = 'lighter'
  blitGlow(ctx, 'danger', x, y, radius * 1.7, 0.16 * pulse)
  ctx.globalCompositeOperation = 'source-over'
}
