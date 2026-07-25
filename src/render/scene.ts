/**
 * Playfield rendering.
 *
 * Reads a `WorldView` and draws it; never writes to it, and never imports the
 * World class — the view interface in sim/entities.ts is the whole contract, so
 * the simulation can be restructured without touching this file.
 *
 * Two things in here are not negotiable.
 *
 * **Everything that moves is interpolated.** The sim advances in whole 60Hz
 * ticks; a 144Hz display draws between them. Any entity drawn from `x`/`y`
 * without `prevX`/`prevY` visibly stutters, so `lerp` is applied to every moving
 * thing without exception.
 *
 * **Draw order is a legibility decision, not an aesthetic one.** From back to
 * front:
 *
 *   1. background and starfield
 *   2. enemies
 *   3. player projectiles
 *   4. enemy projectiles — *above* enemies, so incoming fire is never occluded
 *      by the thing that fired it
 *   5. explosions and impact effects
 *   6. the player hull, last, so it is never hidden by anything
 *   7. vignette, then the edge warnings that must survive it
 *
 * Under a screen full of bullets the player must always be able to find their
 * own ship and the things that can kill them. That ordering is the mechanism.
 */

import { PLAYFIELD_H, PLAYFIELD_W } from '../core/space'
import type { Bullet, EnemyBullet, EnemyInstance, Hull, WorldView } from '../sim/entities'
import { blitGlow, drawExplosions, drawHitFlash, drawInvulnRing, hitFlashStrength } from './effects'
import { Palette } from './palette'
import { drawEnemyShape, enemyTopOffset } from './shapes'
import type { Starfield } from './starfield'

function lerp(prev: number, next: number, alpha: number): number {
  return prev + (next - prev) * alpha
}

/** Integrity fraction at or below which the screen edge starts warning. Matches the panel's meter. */
const LOW_INTEGRITY_AT = 0.3
/** How far above the top edge an approaching enemy gets an indicator. */
const THREAT_RANGE = 170
/**
 * Enemies smaller than this never show a damage bar. A pip strip over every
 * skiff in a wave is noise, and noise over the playfield is what UI.md rule 1
 * exists to prevent — so the annotation is reserved for targets whose remaining
 * health is actually a decision.
 */
const DAMAGE_BAR_MIN_MAX_HP = 24
/**
 * Floor on the drawn radius of an enemy projectile.
 *
 * Independent of the sim's collision radius, and larger than the small ones. A
 * hitbox may be 2 units for fairness, but a 2-unit dot cannot be the
 * highest-contrast object on a 448-unit-wide screen, and the projectile the
 * player must dodge losing that contest is the worst outcome in the file.
 */
const MIN_BULLET_R = 3.2

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

/**
 * A short segmented strip above a damaged enemy.
 *
 * Not a persistent state readout — it is attached to a moving entity, appears
 * only once that entity is hurt, and disappears with it. Same category as a
 * lock-on marker under rule 1's permitted exceptions.
 */
function drawDamageBar(ctx: CanvasRenderingContext2D, e: EnemyInstance, x: number, y: number): void {
  if (e.hp >= e.maxHp) return
  if (!e.elite && e.maxHp < DAMAGE_BAR_MIN_MAX_HP) return

  const segments = 5
  const w = Math.max(18, e.radius * 1.8)
  const h = 2.5
  const gap = 1.5
  const segW = (w - gap * (segments - 1)) / segments
  const left = x - w / 2
  const top = y + enemyTopOffset(e.shape, e.radius) - 8
  const filled = Math.ceil(Math.max(0, e.hp / e.maxHp) * segments)

  for (let i = 0; i < segments; i++) {
    // Empty segments stay visible so the strip's total length reads as the
    // enemy's maximum: fill alone would make a hurt elite look like a fresh
    // skiff. Colour is doing no work here that length isn't also doing.
    //
    // `line` rather than `hostileFill` for the empty ones — at hull-fill
    // darkness they vanished against the void and the strip lost its scale.
    ctx.fillStyle = i < filled ? (e.elite ? Palette.hostileElite : Palette.hostile) : Palette.line
    ctx.fillRect(left + i * (segW + gap), top, segW, h)
  }
}

/**
 * Enemies: silhouettes first, then one additive pass for hit flashes.
 *
 * Split into two passes on purpose. Interleaving them would flip the composite
 * mode twice per enemy; batched, the whole wave costs two changes.
 */
function drawEnemies(
  ctx: CanvasRenderingContext2D,
  enemies: readonly EnemyInstance[],
  alpha: number,
): void {
  for (const e of enemies) {
    if (!e.alive) continue
    const x = lerp(e.prevX, e.x, alpha)
    const y = lerp(e.prevY, e.y, alpha)
    drawEnemyShape(ctx, e.shape, x, y, e.radius, {
      elite: e.elite,
      flash: hitFlashStrength(e.hitFlashTicks),
      age: e.age + alpha,
    })
    drawDamageBar(ctx, e, x, y)
  }

  ctx.globalCompositeOperation = 'lighter'
  for (const e of enemies) {
    if (!e.alive) continue
    const strength = hitFlashStrength(e.hitFlashTicks)
    if (strength <= 0) continue
    drawHitFlash(ctx, lerp(e.prevX, e.x, alpha), lerp(e.prevY, e.y, alpha), e.radius, strength)
  }
  ctx.globalCompositeOperation = 'source-over'
}

/**
 * Player projectiles, drawn as long thin tracers.
 *
 * An earlier version used short wide rectangles at a wide muzzle offset, and the
 * result read as pairs of tally marks marching up the screen rather than as
 * gunfire — while also competing with the player's ship for attention. Tracers
 * are narrow, long, and dimmer than the hull, so they imply a stream and stay
 * subordinate to the thing the player must never lose track of.
 *
 * The vertical-tracer silhouette is also half of how player and enemy fire are
 * told apart: tall and thin versus small and round. Hue is the other half, and
 * it is never the only one.
 */
function drawPlayerBullets(
  ctx: CanvasRenderingContext2D,
  bullets: readonly Bullet[],
  alpha: number,
): void {
  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = Palette.glowProjectile
  for (const b of bullets) {
    if (!b.alive) continue
    ctx.fillRect(lerp(b.prevX, b.x, alpha) - 2, lerp(b.prevY, b.y, alpha) - 14, 4, 28)
  }
  ctx.globalCompositeOperation = 'source-over'

  ctx.fillStyle = '#CFF4FA'
  for (const b of bullets) {
    if (!b.alive) continue
    ctx.fillRect(lerp(b.prevX, b.x, alpha) - 0.75, lerp(b.prevY, b.y, alpha) - 11, 1.5, 22)
  }
}

/**
 * Enemy projectiles. The most important pixels on the screen.
 *
 * These are the only things drawn in `danger`, and they are drawn to be the
 * highest-contrast objects in the frame: a near-black halo underneath so the red
 * survives sitting inside an explosion, saturated red body, white-hot core.
 *
 * Each kind gets its own silhouette, because UI.md rule 3 forbids hue being the
 * only difference — and because the three behave differently, so a player who
 * can read them apart at a glance can plan:
 *
 *   pellet   round dot        travels straight, fast
 *   shard    diamond, aligned to travel — the angle *is* the telegraph
 *   tracker  hollow ring      slow, came looking for you
 *
 * Drawn in kind order so the pass costs a handful of state changes rather than
 * one per projectile.
 */
function drawEnemyBullets(
  ctx: CanvasRenderingContext2D,
  bullets: readonly EnemyBullet[],
  alpha: number,
): void {
  if (bullets.length === 0) return

  // Halo pass. Every kind, one fill style: this is what keeps a red bullet
  // legible against a bright warm explosion behind it.
  ctx.fillStyle = 'rgba(4, 6, 10, 0.82)'
  for (const b of bullets) {
    if (!b.alive) continue
    const r = Math.max(b.radius, MIN_BULLET_R) + 2.2
    ctx.beginPath()
    ctx.arc(lerp(b.prevX, b.x, alpha), lerp(b.prevY, b.y, alpha), r, 0, Math.PI * 2)
    ctx.fill()
  }

  // Bodies.
  ctx.fillStyle = Palette.danger
  ctx.strokeStyle = Palette.danger
  for (const b of bullets) {
    if (!b.alive || b.kind !== 'pellet') continue
    const r = Math.max(b.radius, MIN_BULLET_R)
    ctx.beginPath()
    ctx.arc(lerp(b.prevX, b.x, alpha), lerp(b.prevY, b.y, alpha), r, 0, Math.PI * 2)
    ctx.fill()
  }

  for (const b of bullets) {
    if (!b.alive || b.kind !== 'shard') continue
    const x = lerp(b.prevX, b.x, alpha)
    const y = lerp(b.prevY, b.y, alpha)
    const r = Math.max(b.radius, MIN_BULLET_R)
    const angle = Math.atan2(b.vy, b.vx)
    const half = r * 2.2
    const wide = r * 1.05
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(angle)
    ctx.beginPath()
    ctx.moveTo(half, 0)
    ctx.lineTo(0, wide)
    ctx.lineTo(-half * 0.7, 0)
    ctx.lineTo(0, -wide)
    ctx.closePath()
    ctx.fill()
    ctx.restore()
  }

  ctx.lineWidth = 2
  for (const b of bullets) {
    if (!b.alive || b.kind !== 'tracker') continue
    const x = lerp(b.prevX, b.x, alpha)
    const y = lerp(b.prevY, b.y, alpha)
    const r = Math.max(b.radius, MIN_BULLET_R * 1.25)
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.arc(x, y, r * 0.34, 0, Math.PI * 2)
    ctx.fill()
  }

  // Cores. A white-hot centre on every kind gives the eye a precise point to
  // dodge, which a soft red blob does not.
  ctx.fillStyle = '#FFF1EC'
  for (const b of bullets) {
    if (!b.alive || b.kind === 'tracker') continue
    const r = Math.max(b.radius, MIN_BULLET_R) * 0.44
    ctx.beginPath()
    ctx.arc(lerp(b.prevX, b.x, alpha), lerp(b.prevY, b.y, alpha), r, 0, Math.PI * 2)
    ctx.fill()
  }

  // Glow last and additive. Tight to the body rather than a wide halo: the halo
  // has to make these the highest-contrast objects in the frame without
  // out-glowing the single ship the player is tracking, and a wide soft bloom
  // does the opposite — it dilutes the exact point that has to be dodged.
  ctx.globalCompositeOperation = 'lighter'
  for (const b of bullets) {
    if (!b.alive) continue
    const r = Math.max(b.radius, MIN_BULLET_R)
    blitGlow(ctx, 'danger', lerp(b.prevX, b.x, alpha), lerp(b.prevY, b.y, alpha), r * 2.6, 0.6)
  }
  ctx.globalCompositeOperation = 'source-over'
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

  // Shield, as an unbroken ring whose radius grows with what is left. Rule 9:
  // the panel's shield meter is not where the player is looking, so the state
  // has to exist on the ship too. Continuous ring versus the segmented
  // invulnerability ring means the two can never be confused.
  if (hull.maxShield > 0 && hull.shield > 0) {
    const fraction = Math.min(1, hull.shield / hull.maxShield)
    ctx.strokeStyle = Palette.self
    ctx.globalAlpha = 0.1 + 0.16 * fraction
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(x, y, 15 + 5 * fraction, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

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

  drawInvulnRing(ctx, x, y, Math.max(hull.radius * 2.4, 21), tick, hull.invulnTicks)
}

/**
 * Indicators for enemies that have spawned above the top edge.
 *
 * A permitted overlay under rule 1 — transient, attached to the action, and not
 * a state readout. Without it, anything that spawns off-screen arrives as an
 * ambush the player could not have planned for, which is unfair rather than
 * hard.
 *
 * Drawn in `hostile`, never `danger`: these enemies cannot hurt anyone yet, and
 * spending the danger colour on "something is coming" is exactly how a player's
 * threat reflex gets trained on noise.
 */
function drawThreatIndicators(
  ctx: CanvasRenderingContext2D,
  enemies: readonly EnemyInstance[],
  alpha: number,
): void {
  for (const e of enemies) {
    if (!e.alive) continue
    const y = lerp(e.prevY, e.y, alpha)
    if (y >= -2 || y < -THREAT_RANGE) continue

    // Closer means more opaque, so the indicator reads as a countdown to arrival
    // rather than a fixed marker. It never reaches zero opacity while visible.
    const nearness = 1 - Math.min(1, -y / THREAT_RANGE)
    const x = Math.max(9, Math.min(PLAYFIELD_W - 9, lerp(e.prevX, e.x, alpha)))
    const color = e.elite ? Palette.hostileElite : Palette.hostile

    ctx.globalAlpha = 0.25 + 0.6 * nearness
    ctx.strokeStyle = color
    ctx.lineWidth = 1.5
    // Chevron pointing the way the threat is travelling, plus a tick on the very
    // edge so the marker is locatable even where the chevron is faint.
    const top = 7 + 4 * (1 - nearness)
    ctx.beginPath()
    ctx.moveTo(x - 5.5, top)
    ctx.lineTo(x, top + 6)
    ctx.lineTo(x + 5.5, top)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, 3)
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}

/**
 * Red rim at the screen edge when the hull is nearly gone.
 *
 * The one piece of state this file draws over the playfield, and it is a
 * considered exception: it occupies the outer 26 units where nothing gameplay
 * relevant can be read anyway, and integrity approaching zero is precisely the
 * state a player must not have to look away to discover. Corner brackets appear
 * with it so the warning has a shape as well as a colour (rule 3).
 *
 * The pulse is a ~0.9Hz sine that never reaches zero — rule 10 is a hard
 * accessibility constraint, so no blinking and no full-screen flash.
 */
function drawLowIntegrityRim(ctx: CanvasRenderingContext2D, hull: Hull, tick: number): void {
  if (hull.maxIntegrity <= 0 || hull.integrity <= 0) return
  const fraction = hull.integrity / hull.maxIntegrity
  if (fraction > LOW_INTEGRITY_AT) return

  const severity = 1 - fraction / LOW_INTEGRITY_AT
  const pulse = 0.6 + 0.4 * Math.sin(tick * 0.092)
  const peak = (0.16 + 0.32 * severity) * pulse
  const depth = 26

  const edges: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
    [0, 0, 0, depth, PLAYFIELD_W, depth],
    [0, PLAYFIELD_H, 0, PLAYFIELD_H - depth, PLAYFIELD_W, depth],
    [0, 0, depth, 0, depth, PLAYFIELD_H],
    [PLAYFIELD_W, 0, PLAYFIELD_W - depth, 0, depth, PLAYFIELD_H],
  ]

  for (const [x0, y0, x1, y1, w, h] of edges) {
    const gradient = ctx.createLinearGradient(x0, y0, x1, y1)
    gradient.addColorStop(0, `rgba(255, 74, 56, ${peak.toFixed(3)})`)
    gradient.addColorStop(1, 'rgba(255, 74, 56, 0)')
    ctx.fillStyle = gradient
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), w, h)
  }

  ctx.strokeStyle = Palette.danger
  ctx.globalAlpha = 0.5 + 0.45 * pulse
  ctx.lineWidth = 2
  const inset = 5
  const len = 20
  const corners: ReadonlyArray<readonly [number, number, number, number]> = [
    [inset, inset, 1, 1],
    [PLAYFIELD_W - inset, inset, -1, 1],
    [inset, PLAYFIELD_H - inset, 1, -1],
    [PLAYFIELD_W - inset, PLAYFIELD_H - inset, -1, -1],
  ]
  for (const [cx, cy, dx, dy] of corners) {
    ctx.beginPath()
    ctx.moveTo(cx + dx * len, cy)
    ctx.lineTo(cx, cy)
    ctx.lineTo(cx, cy + dy * len)
    ctx.stroke()
  }
  ctx.globalAlpha = 1
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  view: WorldView,
  starfield: Starfield,
  alpha: number,
): void {
  const tick = view.stats.tick

  drawPlayfieldBackground(ctx)
  starfield.draw(ctx)

  drawEnemies(ctx, view.enemies, alpha)
  drawPlayerBullets(ctx, view.playerBullets, alpha)
  // Above the enemies, by design. See the header comment.
  drawEnemyBullets(ctx, view.enemyBullets, alpha)
  drawExplosions(ctx, view.explosions, alpha)
  drawHull(ctx, view.hull, alpha, tick)

  drawVignette(ctx)
  // After the vignette: both of these are warnings that live at the edge, which
  // is exactly where the vignette is darkest. Muting a warning by 45% to
  // preserve draw-order purity would be the wrong trade.
  drawLowIntegrityRim(ctx, view.hull, tick)
  drawThreatIndicators(ctx, view.enemies, alpha)
}
