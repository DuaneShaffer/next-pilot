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
 *   2. enemies, then their attack telegraphs
 *   3. player projectiles
 *   4. enemy projectiles — *above* enemies, so incoming fire is never occluded
 *      by the thing that fired it
 *   5. explosions and impact effects
 *   6. the player hull, last, so it is never hidden by anything
 *   7. vignette, then the edge warnings that must survive it
 *   8. floating labels, outside the screen-shake transform
 *
 * Under a screen full of bullets the player must always be able to find their
 * own ship and the things that can kill them. That ordering is the mechanism.
 *
 * **Screen shake moves the playfield and nothing else.** The offset is applied
 * inside a clip to the playfield rect, which is why the instrument panel — drawn
 * by the caller, after this — cannot move. A vibrating readout is unreadable, and
 * a HUD that shakes with the world is the fastest way to make a player stop
 * trusting it.
 */

import { TICK_SECONDS } from '../core/loop'
import { PLAYFIELD_H, PLAYFIELD_W } from '../core/space'
import type { Bullet, EnemyBullet, EnemyInstance, Hull, WorldView } from '../sim/entities'
import { visibleTelegraph } from '../sim/enemies'
import { drawBossCallout, drawBossHull } from './boss'
import {
  blitGlow,
  drawExplosions,
  drawHitFlash,
  drawInvulnRing,
  drawTelegraph,
  hitFlashStrength,
} from './effects'
import {
  drawFeelLabels,
  drawFeelShells,
  drawFeelSparks,
  drawMuzzleGlow,
  shakeOffset,
  type FeelState,
} from './feel'
import { blackoutDepth, drawBlackout, drawHazardWarning } from './hazards'
import { pulse } from './intensity'
import { Palette, withAlpha } from './palette'
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

/**
 * Tracer length range in virtual units, and the golden-ratio step that spreads
 * variation across consecutive shots. See `tracerPhase`.
 *
 * The ceiling matters: 20 shots/second at 620 units/second puts consecutive rounds
 * 31 units apart, so a tracer longer than that fuses the stream into one unbroken
 * bar and the variation stops being visible at all. 22–30 keeps a gap between
 * every round.
 */
const TRACER_MIN_LEN = 22
const TRACER_LEN_RANGE = 8
const TRACER_STEP = 0.6180339887

/**
 * A stable 0..1 signature for one player bullet.
 *
 * The problem this solves: 20 shots a second in a perfectly even column reads as a
 * repeating texture — a ladder — rather than as gunfire. Varying the tracers fixes
 * it, but the variation has to be *constant for the life of each bullet*, or every
 * tracer flickers as it flies, which is both ugly and a strobe.
 *
 * Bullets carry no id, and hashing a position gives a different answer every tick.
 * The trick is that `y / dy + tick` is invariant along a bullet's flight: the
 * bullet loses exactly `dy` of `y` per tick, so the two terms cancel. What is left
 * is a function of the tick the bullet was *fired* on, which is exactly the
 * per-bullet identity needed — and because it survives interpolation, it does not
 * change between frames within a tick either.
 *
 * Stepping by the golden ratio means consecutive shots land far apart in 0..1, so
 * no short repeating pattern can form.
 */
function tracerPhase(y: number, vy: number, tickWithAlpha: number): number {
  const dy = Math.abs(vy) * TICK_SECONDS
  // A bullet that does not move vertically has no invariant to exploit; fall back
  // to a constant rather than dividing by zero and drawing nothing.
  if (!(dy > 0.0001)) return 0.5
  const q = (y / dy + tickWithAlpha) * TRACER_STEP
  const frac = q - Math.floor(q)
  return Number.isFinite(frac) ? frac : 0.5
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
 * 0..1 windup progress for an enemy, 1 being the tick the shot leaves.
 *
 * Defensive about both fields because the telegraph is new sim state: an enemy
 * created before the sim populated them must render as "not winding up", never as
 * NaN — a NaN line width silently drops the whole silhouette.
 */
function telegraphProgress(e: EnemyInstance): number {
  // Whichever barrel fires soonest — see visibleTelegraph. Reading `telegraphTicks`
  // alone would leave a second barrel's windup undrawn, and an attack nothing warns
  // about is what rule 3 exists to prevent.
  const { ticks: remaining, total } = visibleTelegraph(e)
  if (!(remaining > 0) || !(total > 0)) return 0
  const p = 1 - remaining / total
  return p < 0 ? 0 : p > 1 ? 1 : p
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
  tick: number,
  reduceFlashes: boolean,
): void {
  for (const e of enemies) {
    if (!e.alive) continue
    const x = lerp(e.prevX, e.x, alpha)
    const y = lerp(e.prevY, e.y, alpha)
    if (e.boss) {
      // A boss goes through render/boss.ts instead: same silhouette underneath, plus
      // the plating and phase ring that stop it reading as a scaled-up skiff. Its
      // damage bar is the ring and the panel block, so it does not get the strip
      // every other enemy gets.
      drawBossHull(ctx, e, x, y, { tick: tick + alpha, reduceFlashes })
    } else {
      drawEnemyShape(ctx, e.shape, x, y, e.radius, {
        elite: e.elite,
        flash: hitFlashStrength(e.hitFlashTicks, reduceFlashes),
        age: e.age + alpha,
        charge: telegraphProgress(e),
      })
      drawDamageBar(ctx, e, x, y)
    }
    // Drawn per enemy rather than batched: only the handful of enemies actually
    // winding up pay for it, and it must sit above its own silhouette.
    drawTelegraph(
      ctx,
      x,
      y,
      e.radius,
      visibleTelegraph(e).ticks,
      visibleTelegraph(e).total,
      reduceFlashes,
    )
  }

  ctx.globalCompositeOperation = 'lighter'
  for (const e of enemies) {
    if (!e.alive) continue
    const strength = hitFlashStrength(e.hitFlashTicks, reduceFlashes)
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
 *
 * **Variation is geometric only.** Each tracer gets its own length and one of two
 * widths from `tracerPhase`, so the stream reads as individual rounds instead of a
 * ladder — but the fill colours stay constant for the whole pass. Two fillStyles
 * for two thousand projectiles is the difference between hitting the frame budget
 * and missing it, and varying brightness per round would be a strobe at 20Hz
 * besides. The length grows *downward* from the leading edge, so a tracer never
 * draws its head anywhere except at the bullet's real position.
 *
 * THAT LAST SENTENCE WAS FALSE, and the comment was the correct half. Both passes
 * started their rect at `y - 14` and `y - 11`, putting the drawn head 11-14 units
 * *ahead* of the bullet the sim is tracking — a fifth of the 62-unit-per-tick flight,
 * and always in the direction of travel. So a stream looked like it had reached a
 * target it had not, which is a lie about the one thing the player is aiming with:
 * the visible answer to "am I on it yet" arrived a quarter of a tick early, every
 * shot. Anchoring the rect at `y` is what the invariant says and what
 * `resolvePlayerBulletHits` actually sweeps.
 */
function drawPlayerBullets(
  ctx: CanvasRenderingContext2D,
  bullets: readonly Bullet[],
  alpha: number,
  tick: number,
): void {
  const tickWithAlpha = tick + alpha

  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = Palette.glowProjectile
  for (const b of bullets) {
    if (!b.alive) continue
    const y = lerp(b.prevY, b.y, alpha)
    const phase = tracerPhase(y, b.vy, tickWithAlpha)
    ctx.fillRect(
      lerp(b.prevX, b.x, alpha) - 2,
      y,
      4,
      TRACER_MIN_LEN + TRACER_LEN_RANGE * phase,
    )
  }
  ctx.globalCompositeOperation = 'source-over'

  ctx.fillStyle = '#CFF4FA'
  for (const b of bullets) {
    if (!b.alive) continue
    const y = lerp(b.prevY, b.y, alpha)
    const phase = tracerPhase(y, b.vy, tickWithAlpha)
    // Two widths rather than a continuum: a 0.4-unit difference is visible in the
    // aggregate texture and costs nothing, while a per-bullet width computation
    // that lands on fractional pixels just looks blurry.
    const width = phase > 0.5 ? 1.9 : 1.5
    ctx.fillRect(
      lerp(b.prevX, b.x, alpha) - width / 2,
      y,
      width,
      (TRACER_MIN_LEN - 5) + TRACER_LEN_RANGE * 0.8 * phase,
    )
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

/**
 * The player hull, including its engine plume.
 *
 * EXPORTED for the rule-10 test, not because anything else draws a hull. The plume
 * shipped flickering at 8.59 Hz — inside the photosensitive band — and the existing
 * rule-10 suite could not see it, because that suite enumerates *exported* effects and
 * this function was private. A safety rule enforced only over the public surface is a
 * safety rule with a hole in it exactly where the most-looked-at object lives.
 */
export function drawHull(
  ctx: CanvasRenderingContext2D,
  hull: Hull,
  alpha: number,
  tick: number,
  muzzleHeat: number,
  reduceFlashes: boolean,
): void {
  const x = lerp(hull.prevX, hull.x, alpha)
  const y = lerp(hull.prevY, hull.y, alpha)

  /**
   * Engine plume first, so the hull sits on top of it.
   *
   * THIS WAS A RULE 10 VIOLATION AND A GENUINE SAFETY DEFECT. It read
   * `0.7 + 0.3 * Math.sin(tick * 0.9)` — 0.9 rad/tick at 60Hz is **8.59 Hz**, squarely
   * inside the 3-30 Hz photosensitive band, modulating an additive `glowSelf` plume
   * between 8.8 and 22 units of emitting area. Attached to the one object a player
   * looks at continuously for the whole run. It also ignored `reduceFlashes` while the
   * muzzle glow two lines below honoured it.
   *
   * `pulse()` is the shared rate: 0.85 Hz, and it attenuates under the setting. The
   * plume still breathes; it no longer flickers.
   *
   * Why the existing rule-10 test missed it: that suite measures the frequency of
   * every *exported* effect, and `drawHull` is not exported. The lesson is not "add
   * this one to the list" — it is that a coverage guard enumerating exports cannot see
   * a private function, so the plume is now on that list explicitly.
   */
  const flicker = pulse(tick, 0.3, reduceFlashes)
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

  // Muzzles, after the hull so the glow sits on the nose. A smoothed level, not a
  // flash per shot — see `FeelState.muzzleHeat`.
  drawMuzzleGlow(ctx, x, y - 13, muzzleHeat, reduceFlashes)

  drawInvulnRing(
    ctx,
    x,
    y,
    Math.max(hull.radius * 2.4, 21),
    tick,
    hull.invulnTicks,
    reduceFlashes,
  )
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
 * The pulse is a sub-1Hz sine that never reaches zero — rule 10 is a hard
 * accessibility constraint, so no blinking and no full-screen flash. The rate comes
 * from render/intensity.ts, which is also where `reduceFlashes` shrinks its swing.
 *
 * Exported so tests/render.test.ts can measure that swing directly: this is the
 * largest area the renderer ever modulates, so it is the one place where "the comment
 * says 0.9Hz" is not good enough.
 */
export function drawLowIntegrityRim(
  ctx: CanvasRenderingContext2D,
  hull: Hull,
  tick: number,
  reduceFlashes = false,
): void {
  if (hull.maxIntegrity <= 0 || hull.integrity <= 0) return
  const fraction = hull.integrity / hull.maxIntegrity
  if (fraction > LOW_INTEGRITY_AT) return

  const severity = 1 - fraction / LOW_INTEGRITY_AT
  const breath = pulse(tick, 0.4, reduceFlashes)
  const peak = (0.16 + 0.32 * severity) * breath
  const depth = 26

  const edges: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
    [0, 0, 0, depth, PLAYFIELD_W, depth],
    [0, PLAYFIELD_H, 0, PLAYFIELD_H - depth, PLAYFIELD_W, depth],
    [0, 0, depth, 0, depth, PLAYFIELD_H],
    [PLAYFIELD_W, 0, PLAYFIELD_W - depth, 0, depth, PLAYFIELD_H],
  ]

  for (const [x0, y0, x1, y1, w, h] of edges) {
    const gradient = ctx.createLinearGradient(x0, y0, x1, y1)
    // Derived from the token rather than written as a literal, so a palette retune
    // moves the rim with everything else instead of stranding it on the old red.
    gradient.addColorStop(0, withAlpha(Palette.danger, peak))
    gradient.addColorStop(1, withAlpha(Palette.danger, 0))
    ctx.fillStyle = gradient
    ctx.fillRect(Math.min(x0, x1), Math.min(y0, y1), w, h)
  }

  ctx.strokeStyle = Palette.danger
  ctx.globalAlpha = 0.5 + 0.45 * breath
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

export interface SceneOptions {
  /**
   * Transient impact presentation: damage numbers, hit sparks, muzzle heat.
   *
   * Owned by the caller because it has to be advanced once per *simulation tick*
   * (`feelTick`), and only the caller knows when a tick happened — a fast-forwarded
   * frame runs up to 32 of them. Omit it and the scene simply draws without the
   * labels and sparks.
   */
  feel?: FeelState
  /**
   * Screen-shake scale, 0..1. 0 disables shake completely, which is the
   * reduced-motion path required by UI rule 10.
   *
   * A parameter rather than a settings lookup: rendering must not depend on where
   * preferences live, and a test needs to be able to ask for zero.
   */
  shakeScale?: number
  /**
   * `Settings.reduceFlashes`, threaded to every bright transient in the frame.
   *
   * A parameter for the same reason `shakeScale` is one. What it attenuates is listed
   * in render/intensity.ts and enforced per effect in tests/render.test.ts, so an
   * effect added later that ignores it fails a test rather than quietly shipping.
   */
  reduceFlashes?: boolean
}

export function drawScene(
  ctx: CanvasRenderingContext2D,
  view: WorldView,
  starfield: Starfield,
  alpha: number,
  options: SceneOptions = {},
): void {
  const tick = view.stats.tick
  const feel = options.feel
  const reduceFlashes = options.reduceFlashes ?? false
  // Defensive reads. These view fields arrived with M5 and a caller may hand over a
  // world built before they existed — a missing hazard list must mean "no hazards",
  // never a thrown frame.
  const hazards = view.hazards ?? []

  /**
   * Hitstop. The sim is frozen, so the interpolation fraction must be too.
   *
   * `alpha` keeps climbing while the sim is frozen — the render clock does not
   * stop. Feeding it to `lerp` would slide every entity up to a full tick *past*
   * its position into space it never occupied, and would keep ageing explosions
   * whose `age` the sim is no longer advancing. Pinning it to 0 holds the exact
   * frame of the impact, which is what makes hitstop read as contact rather than as
   * a dropped frame. Nothing else about the frame changes: freeze is felt, not
   * drawn.
   */
  const held = (view.freezeTicks ?? 0) > 0
  const a = held ? 0 : alpha

  // Background first and *unshifted*, so shaking the contents can never expose a
  // gap at the playfield edge.
  drawPlayfieldBackground(ctx)

  const shake = shakeOffset(tick, view.cosmetic?.shake ?? 0, options.shakeScale ?? 1)
  const shaking = shake.x !== 0 || shake.y !== 0
  if (shaking) {
    ctx.save()
    // The clip is what keeps the instrument panel column clean. Without it a
    // shaken tracer at the right edge would smear into the HUD.
    ctx.beginPath()
    ctx.rect(0, 0, PLAYFIELD_W, PLAYFIELD_H)
    ctx.clip()
    ctx.translate(shake.x, shake.y)
  }

  starfield.draw(ctx)

  drawEnemies(ctx, view.enemies, a, tick, reduceFlashes)
  drawPlayerBullets(ctx, view.playerBullets, a, tick)

  // Blackout goes HERE, and the position is the entire design of the effect. The
  // background, the starfield and the enemies are behind it and go dark; everything
  // below is in front of it and does not. Enemy fire keeps full contrast because
  // hiding the bullets is a difficulty that produces deaths a player cannot explain,
  // and the player's own hull stays findable for the same reason.
  drawBlackout(ctx, blackoutDepth(hazards, reduceFlashes))

  // Above the enemies, by design. See the header comment.
  drawEnemyBullets(ctx, view.enemyBullets, a)
  drawExplosions(ctx, view.explosions, a, reduceFlashes)
  if (feel) drawFeelShells(ctx, feel, a)
  if (feel) drawFeelSparks(ctx, feel, a, reduceFlashes)
  drawHull(ctx, view.hull, a, tick, feel ? feel.muzzleHeat : 0, reduceFlashes)

  if (shaking) ctx.restore()

  drawVignette(ctx)
  // After the vignette: both of these are warnings that live at the edge, which
  // is exactly where the vignette is darkest. Muting a warning by 45% to
  // preserve draw-order purity would be the wrong trade.
  drawLowIntegrityRim(ctx, view.hull, tick, reduceFlashes)
  /*
   * The hazard alarm, after the rim and outside the shake.
   *
   * After the rim because a hazard one second from firing is the more urgent of the
   * two: low integrity is a condition the player already knows about, the reaction
   * window is a second long and then gone. Outside the shake because it is a warning
   * rather than part of the world — a rattling alarm reads as damage, not as a cue.
   *
   * The panel's hazard block still draws; this is the addition rule 9 asks for, not a
   * move. See render/hazards.ts for why the panel alone was not enough.
   */
  drawHazardWarning(ctx, hazards, tick, reduceFlashes)
  drawThreatIndicators(ctx, view.enemies, a)

  // Last, and outside the shake: text is the one thing that must never rattle, and
  // a number half-hidden by the vignette is a number nobody reads. The boss callout
  // is text under the same rule; see render/boss.ts for why rule 1 permits it over
  // the playfield at all, and where it is allowed to sit.
  if (feel) drawFeelLabels(ctx, feel, a)
  const boss = view.boss ?? null
  if (boss?.boss && boss.alive) drawBossCallout(ctx, boss.boss)
}
