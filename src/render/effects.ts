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

export type GlowTint = 'warm' | 'hot' | 'danger' | 'self' | 'elite' | 'smoke'

const GLOW_RGB: Record<GlowTint, readonly [number, number, number]> = {
  /** Explosion body. */
  warm: [255, 176, 92],
  /** Explosion core and hit flash: hotter and whiter than `warm`. */
  hot: [255, 236, 208],
  danger: [255, 74, 56],
  self: [92, 224, 240],
  elite: [245, 185, 66],
  /**
   * The aftermath layer. Drawn additively at a very low alpha, which reads as
   * dust caught in the blast light rather than as opaque smoke — the honest way
   * to fake smoke in an additive pass, and it costs one more sprite instead of a
   * second compositing pass.
   */
  smoke: [168, 150, 138],
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
 * Ticks of the initial hot flash on an explosion.
 *
 * 3 ticks is 50ms: brief and local, which is how rule 10 says to make something
 * punchy. It is the single frame-ish stab of light that makes a kill land, and it
 * is over before the eye can call it a flash. Nothing full-screen, ever.
 */
const EXPLOSION_FLASH_TICKS = 3

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
 *
 * Exported because screen shake and label drift need exactly the same property:
 * scatter that is stable for a given input and reproducible in a screenshot.
 */
export function hash01(a: number, b: number): number {
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

    // Aftermath. Widest, dimmest, and the slowest to fade (linear, against the
    // squared fade of the light), so the last third of the effect is a dispersing
    // haze rather than a core that simply switches off. This is most of what
    // separates a kill from a hit: the hit is over in seven ticks, the kill leaves
    // something behind.
    blitGlow(ctx, 'smoke', e.x, e.y, e.radius * (0.9 + 1.5 * easeOut(t)), (1 - t) * 0.17)

    blitGlow(ctx, style.body, e.x, e.y, e.radius * style.glowReach * (0.5 + 0.7 * t), fade * 0.95)
    // The core is the part that reads as "something was destroyed here", so it
    // is the brightest and the shortest-lived thing in the effect.
    blitGlow(ctx, style.core, e.x, e.y, e.radius * (0.72 - 0.34 * t), fade * 1.1)

    // The stab of light at t=0. Bigger than the core and gone within three ticks,
    // so the blast has an *onset* — without it the first frame of an explosion
    // looks like the middle of one, and impact loses its edge.
    const flashAge = e.age + alpha
    if (flashAge < EXPLOSION_FLASH_TICKS) {
      const f = 1 - flashAge / EXPLOSION_FLASH_TICKS
      // Tapers to exactly zero at the cutoff. A flash that ends while still at a
      // third of its brightness is a step change in luminance — small, but the
      // kind of thing rule 10 is about, and it also just looks like a bug.
      blitGlow(ctx, 'hot', e.x, e.y, e.radius * (1.7 - 0.8 * f), 0.9 * f)
    }

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

/** Shards thrown by one hit spark. Small on purpose — see `drawHitSpark`. */
const SPARK_SHARDS = 4

/**
 * One non-lethal impact: a small directional spatter at the point of contact.
 *
 * The weight difference between this and an explosion is the point of the whole
 * effect pass. A hit is ~12 units across, four shards, gone in seven ticks, and
 * never brighter than half alpha. A kill is four layers, a shockwave, and lingers
 * for half a second. If a player cannot tell those apart without reading the
 * damage bar, the impact work has failed.
 *
 * Drawn in near-white rather than in `warm`: this is the player's own fire
 * connecting, so it belongs to the cyan/white side of the palette. It is not
 * `danger` — nothing here can hurt anyone.
 *
 * `t` is 0..1 through the spark's life, `power` scales size only. Caller owns the
 * composite mode so a whole pass of sparks is one state change.
 */
export function drawHitSpark(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  t: number,
  power: number,
  seed: number,
): void {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return
  const clampedT = t < 0 ? 0 : t > 1 ? 1 : t
  const fade = (1 - clampedT) * (1 - clampedT)
  if (fade <= 0.02) return

  const scale = 4.5 + 6 * (power < 0 ? 0 : power > 1 ? 1 : power)
  blitGlow(ctx, 'self', x, y, scale * (0.9 + 0.6 * clampedT), fade * 0.45)

  ctx.fillStyle = `rgba(223, 246, 251, ${(fade * 0.85).toFixed(3)})`
  for (let i = 0; i < SPARK_SHARDS; i++) {
    // Biased upward (the direction the player's fire travels) so the spatter reads
    // as material coming off the target rather than a symmetrical puff.
    const angle = hash01(seed * 13.1 + i * 7.7, seed * 3.3 - i * 5.1) * Math.PI * 2
    const reach = scale * (0.5 + 1.4 * easeOut(clampedT)) * (0.6 + 0.4 * hash01(i, seed))
    const size = 1.8 * (1 - clampedT) + 0.4
    ctx.fillRect(
      x + Math.cos(angle) * reach - size / 2,
      y + Math.sin(angle) * reach * 0.75 - reach * 0.35 - size / 2,
      size,
      size,
    )
  }
}

/**
 * The windup an attack is readable by.
 *
 * The mechanic only exists so the player can react *before* the shot, so the cue
 * has to be unambiguous about two things: that something is coming, and how long
 * is left. A progress arc answers both — its sweep *is* the remaining time, and it
 * closes into a full circle on the tick the volley leaves the barrel.
 *
 * `caution`, never `danger`. Nothing has been fired yet, and rule 3 reserves
 * `danger` for what can hurt you this instant; spending it on "something is about
 * to happen" is how a player's threat reflex gets trained on noise. The difference
 * between winding up and firing then reads twice over: amber ring closing, then
 * saturated red round moving.
 *
 * Monotone from start to finish — it brightens and tightens, it never blinks, so a
 * fast-firing enemy cannot become a strobe (rule 10).
 */
export function drawTelegraph(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  ticksRemaining: number,
  total: number,
): void {
  if (ticksRemaining <= 0 || total <= 0) return
  const raw = 1 - ticksRemaining / total
  const p = raw < 0 ? 0 : raw > 1 ? 1 : raw

  // Tightens toward the hull as it completes, so "committed" is a shape change and
  // not only a brightness change.
  const r = radius * (1.6 - 0.28 * p)

  // Faint full circle behind the arc: without the track, a 40% arc is just a
  // curve, and the player cannot tell how much windup is left.
  ctx.strokeStyle = Palette.caution
  ctx.globalAlpha = 0.13
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.stroke()

  ctx.globalAlpha = 0.35 + 0.55 * p
  ctx.lineWidth = 1.4 + 1.6 * p
  ctx.beginPath()
  // From the top, clockwise: the same direction as every other progress readout in
  // the game.
  ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 1

  // Charge building at the muzzle end. Quadratic in p, so almost all of it arrives
  // in the last third of the windup — the "now" cue.
  ctx.globalCompositeOperation = 'lighter'
  blitGlow(ctx, 'elite', x, y + radius * 0.85, radius * (0.3 + 0.55 * p), 0.08 + 0.42 * p * p)
  ctx.globalCompositeOperation = 'source-over'
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
