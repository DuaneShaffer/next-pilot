/**
 * Boss presentation: the silhouette, the phase-segmented health bar, and the callout.
 *
 * A boss is an ordinary `EnemyInstance` carrying a `BossRuntime` (sim/entities.ts), so
 * the scene already draws it through its authored `shape`. Left alone it reads as a
 * skiff someone scaled up, which is the whole problem this file solves. Three things
 * make it a boss instead:
 *
 *   **Plating.** Two inset traces of its *own* outline, so the armour is the same
 *   geometry as the hull rather than a second shape that would drift from it.
 *   **A phase ring.** One arc per phase, sized by that phase's share of the health
 *   bar, depleting clockwise from the top. It is the panel's bar wrapped around the
 *   thing it describes, so the two can never disagree.
 *   **A core.** One bright point at the hitbox centre, breathing at the shared pulse
 *   rate. It gives the eye somewhere to aim on a shape that is otherwise 100 units of
 *   dark plating.
 *
 * **Why the bar is segmented by phase.** A boss fight you cannot read is a boss fight
 * you cannot learn: the player needs to know not only how much is left but how close
 * the next pattern change is, because that is the thing that will kill them. So the
 * segmentation is not decorative — each block *is* one phase, and the partially filled
 * block is the phase being fought. The distance from the fill edge to the block's left
 * boundary is exactly the damage remaining before the pattern changes.
 *
 * **Colour.** `hostileElite` for the phase in progress, `hostile` for phases still to
 * come. Never `danger`: a boss losing health is not a thing that can hurt the player
 * this instant, and rule 3's whole point is that the red belongs to incoming fire.
 */

import { PLAYFIELD_H, PLAYFIELD_W } from '../core/space'
import type { BossRuntime, EnemyInstance } from '../sim/entities'
import { visibleTelegraph } from '../sim/enemies'
import { hitFlashStrength } from './effects'
import { pulse } from './intensity'
import { Palette } from './palette'
import { drawEnemyShape, traceEnemyOutline } from './shapes'
import { canvasMeasure, drawText, measureText, wrapText, type Measure } from './text'

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

// ---------------------------------------------------------------------------
// bar geometry — pure, so a test can assert it without a canvas
// ---------------------------------------------------------------------------

/** One phase's slice of the health bar, in health-fraction space. */
export interface BossBarBlock {
  phaseIndex: number
  /** Health fraction at the block's left edge — the threshold that ends this phase. */
  from: number
  /** Health fraction at the block's right edge. 1 for the opening phase. */
  to: number
  /** 0..1 of this block still filled at the boss's current health. */
  fill: number
}

/**
 * Repair an authored threshold list into something drawable.
 *
 * Content is data and data can be wrong, and the failure mode of a bad threshold is a
 * bar that draws outside itself or vanishes — either of which is worse than a bar that
 * is slightly not what the author meant. So: non-finite entries are dropped, values are
 * clamped, the list is forced non-increasing, and the opening phase is pinned to 1
 * because a bar that does not start full is a bar that lies at the start of the fight.
 */
function sanitiseThresholds(thresholds: readonly number[]): number[] {
  const clean: number[] = []
  let ceiling = 1
  for (const raw of thresholds) {
    if (!Number.isFinite(raw)) continue
    const value = Math.min(ceiling, clamp01(raw))
    clean.push(value)
    ceiling = value
  }
  if (clean.length === 0) return [1]
  clean[0] = 1
  return clean
}

/** The bar, block by block, at a given health fraction. */
export function bossBarBlocks(
  thresholds: readonly number[],
  fraction: number,
): BossBarBlock[] {
  const clean = sanitiseThresholds(thresholds)
  const f = clamp01(fraction)
  return clean.map((to, index) => {
    const from = clean[index + 1] ?? 0
    const span = to - from
    const fill = span > 0 ? clamp01((f - from) / span) : f >= to ? 1 : 0
    return { phaseIndex: index, from, to, fill }
  })
}

/**
 * The interior phase boundaries, as health fractions.
 *
 * These are the marks the player is actually reading: each one is a point at which the
 * fight changes. The outer edges (0 and 1) are the bar itself and are not marks.
 */
export function bossThresholdMarks(thresholds: readonly number[]): number[] {
  // A boundary at 0 or 1 is an edge of the bar, not a mark on it. Degenerate content
  // (two phases at the same fraction) can produce those, and a tick drawn on the edge
  // reads as the bar overflowing.
  return sanitiseThresholds(thresholds)
    .slice(1)
    .filter((value) => value > 0 && value < 1)
}

export interface BossBarOptions {
  x: number
  y: number
  w: number
  h: number
  thresholds: readonly number[]
  /** Current health, 0..1. Clamped: a boss at 0 or 1 must not draw outside the bar. */
  fraction: number
  /** Phase the sim says is running. Coloured from this, never inferred from health. */
  phaseIndex: number
}

/** Gap between phase blocks, in virtual units. The gap *is* the threshold. */
const BLOCK_GAP = 2
/** Height of the tick below each interior threshold. */
const MARK_H = 3
/** Headroom the caret needs above the bar. Callers must reserve it. */
export const BAR_CARET_H = 6

/**
 * Size the boss name is drawn at, and the widest it may be laid out.
 *
 * Exported so tests/render.test.ts can run the real content table through the same
 * wrapping the panel uses, rather than through a fixture that happens to be short.
 */
export const BOSS_NAME_SIZE = 13

/**
 * Break a boss name into lines that fit, WITHOUT ever dropping any of it.
 *
 * The panel used to truncate: `The Repossessor` became `THE REPOSSESS…` because the
 * name shared its line with the hp readout. A boss whose name the player cannot read
 * is the one label they would use to talk about the fight, and the longest authored
 * name — `Unlisted Tenant — Spore Bed`, 27 characters — cannot fit one 164-unit line
 * at any size at or above the 12px floor rule 7 sets. So the name gets its own line,
 * and wraps if it needs to. There is no ellipsis path here on purpose.
 *
 * Returns however many lines the name needs; the caller sizes its block from the
 * count. A test pins the real table at two lines, so a future name that would push
 * the block taller fails there rather than surprising the layout.
 */
export function bossNameLines(
  name: string,
  maxWidth: number,
  measure: Measure,
  size = BOSS_NAME_SIZE,
): readonly string[] {
  const lines = wrapText(name, maxWidth, size, measure, 700)
  return lines.length > 0 ? lines : ['']
}

export function drawBossHealthBar(ctx: CanvasRenderingContext2D, options: BossBarOptions): void {
  const { x, y, w, h, thresholds, fraction, phaseIndex } = options
  if (!(w > 0) || !(h > 0)) return

  const blocks = bossBarBlocks(thresholds, fraction)

  for (const block of blocks) {
    const left = x + block.from * w
    const full = (block.to - block.from) * w
    // The gap is taken out of the block's right edge, so a block's LEFT edge always
    // sits exactly on its threshold. Splitting the gap across both edges would put
    // every mark half a gap away from the boundary it marks.
    //
    // Clamped to the bar rather than floored at a minimum width: authored thresholds
    // can be degenerate (two phases at the same fraction), and a minimum width there
    // would push a block past the right edge of the bar it belongs to.
    const width = Math.min(Math.max(0, full - BLOCK_GAP), x + w - left)
    if (width <= 0) continue

    ctx.fillStyle = Palette.panelRaised
    ctx.fillRect(left, y, width, h)

    const filled = Math.min(width, block.fill * full)
    if (filled > 0.01) {
      ctx.fillStyle =
        block.phaseIndex === phaseIndex ? Palette.hostileElite : Palette.hostile
      ctx.fillRect(left, y, filled, h)
    }
  }

  ctx.fillStyle = Palette.textDim
  for (const mark of bossThresholdMarks(thresholds)) {
    ctx.fillRect(x + mark * w - 0.5, y + h + 1, 1, MARK_H)
  }

  /**
   * Two marks that answer "which way does this go, and which block is now".
   *
   * A reviewer looking at a still could not tell either, and they were right to say
   * so: the fill colour alone was carrying both facts, which is one channel doing two
   * jobs and is also exactly what rule 3 forbids. So:
   *
   *   the CARET sits on the fill edge — the point that moves. It travels leftward as
   *   the boss takes damage, which makes the direction self-evident the first time
   *   anything happens, and in a frozen frame it says "here".
   *   the BRACKET encloses the phase being fought. The caret's distance to the
   *   bracket's left edge is, literally, the damage left before the pattern changes —
   *   which is the one question a phase-segmented bar exists to answer.
   *
   * Both are geometry, so they survive greyscale and they survive the palette moving
   * underneath them.
   */
  const current = blocks.find((block) => block.phaseIndex === phaseIndex) ?? blocks[0]
  if (current) {
    const left = x + current.from * w
    const width = Math.max(1, Math.min((current.to - current.from) * w - BLOCK_GAP, x + w - left))
    ctx.strokeStyle = Palette.hostileElite
    ctx.lineWidth = 1
    ctx.strokeRect(left - 0.5, y - 1.5, width + 1, h + 3)
  }

  const head = x + clamp01(fraction) * w
  ctx.fillStyle = Palette.text
  ctx.beginPath()
  ctx.moveTo(Math.max(x + 3, Math.min(x + w - 3, head)) - 3, y - BAR_CARET_H)
  ctx.lineTo(Math.max(x + 3, Math.min(x + w - 3, head)) + 3, y - BAR_CARET_H)
  ctx.lineTo(Math.max(x + 3, Math.min(x + w - 3, head)), y - 1.5)
  ctx.closePath()
  ctx.fill()
}

// ---------------------------------------------------------------------------
// the boss in the playfield
// ---------------------------------------------------------------------------

/** Armour ring radius, as a multiple of the collision radius. */
const RING_SCALE = 1.28
/** Angular gap between phase arcs, in radians. */
const RING_GAP = 0.07
/** Plating traces, as fractions of the hull radius. */
const PLATE_SCALES = [0.8, 0.34] as const

/** Health fraction to an angle on the ring: full health at the top, depleting clockwise. */
function ringAngle(fraction: number): number {
  return -Math.PI / 2 + (1 - clamp01(fraction)) * Math.PI * 2
}

export interface BossHullStyle {
  /** Interpolated tick, for the core's breath. */
  tick: number
  reduceFlashes?: boolean
}

/**
 * Draw the boss: hull, plating, phase ring, core.
 *
 * Called instead of the ordinary enemy path, not in addition to it — the base
 * silhouette is drawn here so the plating can sit on top of it in one transform.
 */
export function drawBossHull(
  ctx: CanvasRenderingContext2D,
  e: EnemyInstance,
  x: number,
  y: number,
  style: BossHullStyle,
): void {
  const boss = e.boss
  if (!boss) return
  const radius = Number.isFinite(e.radius) && e.radius > 0 ? e.radius : 24
  const reduce = style.reduceFlashes ?? false
  const flash = hitFlashStrength(e.hitFlashTicks, reduce)

  drawEnemyShape(ctx, e.shape, x, y, radius, {
    elite: true,
    flash,
    age: e.age,
    charge: telegraphCharge(e),
  })

  ctx.save()
  ctx.translate(x, y)

  // Plating. Same outline, inset twice: reads as layered armour and gives the
  // silhouette an interior scale that a plain outline of the same size does not.
  ctx.strokeStyle = Palette.hostile
  ctx.lineWidth = 1
  for (let i = 0; i < PLATE_SCALES.length; i++) {
    ctx.globalAlpha = 0.42 - i * 0.14
    traceEnemyOutline(ctx, e.shape, radius * (PLATE_SCALES[i] ?? 0.5))
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  const fraction = e.maxHp > 0 ? clamp01(e.hp / e.maxHp) : 0
  const blocks = bossBarBlocks(boss.thresholds, fraction)
  const ringR = radius * RING_SCALE

  for (const block of blocks) {
    const start = ringAngle(block.to) + RING_GAP
    const end = ringAngle(block.from) - RING_GAP
    if (end <= start) continue

    // Track first: without it a part-empty phase is just a stray curve, and the
    // player cannot tell a nearly-dead phase from a phase that never existed.
    ctx.strokeStyle = Palette.line
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(0, 0, ringR, start, end)
    ctx.stroke()

    if (block.fill <= 0.001) continue
    const span = block.to - block.from
    const fillEdge = ringAngle(block.from + block.fill * span) + RING_GAP
    if (end <= fillEdge) continue
    ctx.strokeStyle =
      block.phaseIndex === boss.phaseIndex ? Palette.hostileElite : Palette.hostile
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.arc(0, 0, ringR, fillEdge, end)
    ctx.stroke()
  }

  // Core. One bright point at the hitbox centre, breathing at the shared rate so it
  // reads as powered rather than as a highlight. Rule 10 caps the rate; `pulse` is
  // where that cap lives.
  const breath = pulse(style.tick, 0.3, reduce)
  ctx.fillStyle = Palette.hostileFill
  ctx.beginPath()
  ctx.arc(0, 0, radius * 0.22, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = Palette.hostileElite
  ctx.globalAlpha = 0.35 + 0.5 * breath
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(0, 0, radius * 0.22, 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 1

  ctx.restore()
}

/** 0..1 windup progress, defensively — a NaN line width drops the whole silhouette. */
function telegraphCharge(e: EnemyInstance): number {
  // Whichever barrel fires soonest — see visibleTelegraph. Reading `telegraphTicks`
  // alone would leave a second barrel's windup undrawn, and an attack nothing warns
  // about is what rule 3 exists to prevent.
  const { ticks: remaining, total } = visibleTelegraph(e)
  if (!(remaining > 0) || !(total > 0)) return 0
  return clamp01(1 - remaining / total)
}

// ---------------------------------------------------------------------------
// the phase callout
// ---------------------------------------------------------------------------

/**
 * Where the callout lives, and why it is allowed to be there.
 *
 * UI.md rule 1 forbids drawing state over the playfield and then names its
 * exceptions — "boss-phase callouts" is one of them, on the grounds that it is
 * transient and attached to the action rather than a readout. This implementation
 * takes that permission narrowly:
 *
 *   - It is an *announcement*, not a readout. The persistent boss state (health,
 *     phase number, thresholds) is in the instrument panel where rule 1 wants it.
 *   - It occupies the top ~90 units, the upper 12% of a 720-unit field. The player
 *     flies in the bottom third and manoeuvres through the middle; nothing here
 *     reaches the lower two-thirds, and the constant below asserts it.
 *   - It sits *above* the boss's own station (a boss holds around y=130-220), so it
 *     annotates the fight from outside it rather than over it.
 *   - There is no backing plate. A translucent panel behind the text would occlude
 *     whatever crosses it, and near the top of the screen what crosses it is fresh
 *     enemy fire. The text carries a one-unit shadow instead, which costs the two
 *     pixels under each glyph and nothing else.
 *   - It is gone in two seconds, monotonically, with no repetition (rule 10).
 */
export const CALLOUT_TOP = 26
const CALLOUT_TITLE_SIZE = 11
const CALLOUT_SIZE = 17
const CALLOUT_LINE_H = 20
const CALLOUT_MAX_LINES = 2
/** Horizontal inset, so a wrapped line never runs to the playfield edge. */
const CALLOUT_INSET = 32
/** Bottom-most unit the callout can touch. Asserted against the playfield in tests. */
export const CALLOUT_BOTTOM =
  CALLOUT_TOP + CALLOUT_TITLE_SIZE + 6 + CALLOUT_LINE_H * CALLOUT_MAX_LINES + 6

/** Ticks over which the callout fades out. */
export const CALLOUT_FADE_TICKS = 16

/**
 * Opacity from the ticks the sim says are left.
 *
 * Full on arrival and fading only at the end, deliberately. A warning that eases in
 * spends the first tenth of its life unreadable, and the whole point of the callout is
 * that the player reads it *before* the pattern it announces arrives.
 */
export function calloutOpacity(ticksRemaining: number): number {
  if (!Number.isFinite(ticksRemaining) || ticksRemaining <= 0) return 0
  return Math.min(1, ticksRemaining / CALLOUT_FADE_TICKS)
}

const CALLOUT_SHADOW = 'rgba(3, 5, 9, 0.92)'

/** Clip a title to the available width. The name is authored and can be long. */
function fitTitle(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  const options = { size: CALLOUT_TITLE_SIZE, tracking: 2 } as const
  if (measureText(ctx, text, options) <= maxWidth) return text
  let cut = text.length
  while (cut > 1 && measureText(ctx, `${text.slice(0, cut)}…`, options) > maxWidth) cut--
  return `${text.slice(0, cut)}…`
}

export function drawBossCallout(
  ctx: CanvasRenderingContext2D,
  boss: BossRuntime,
): void {
  const opacity = calloutOpacity(boss.calloutTicks)
  if (opacity <= 0.02) return

  const index = Math.max(0, Math.min(boss.callouts.length - 1, boss.phaseIndex))
  const text = boss.callouts[index]
  if (!text) return

  const centre = PLAYFIELD_W / 2
  const maxWidth = PLAYFIELD_W - CALLOUT_INSET * 2

  const lines = wrapText(text, maxWidth, CALLOUT_SIZE, canvasMeasure(ctx), 700).slice(
    0,
    CALLOUT_MAX_LINES,
  )
  if (lines.length === 0) return

  ctx.globalAlpha = opacity

  // Identity and position in the fight, so the callout answers "what is this" as well
  // as "what just changed". Dim and small: it is context, not the announcement.
  const title = fitTitle(
    ctx,
    `${boss.name} · PHASE ${index + 1} / ${boss.callouts.length}`.toUpperCase(),
    maxWidth,
  )
  drawText(ctx, title, centre, CALLOUT_TOP, {
    size: CALLOUT_TITLE_SIZE,
    tracking: 2,
    align: 'center',
    baseline: 'top',
    color: Palette.textDim,
  })

  // `caution`, not `danger`. A pattern change is a warning about what is coming;
  // rule 3 keeps the red for what is already in the air.
  let y = CALLOUT_TOP + CALLOUT_TITLE_SIZE + 6
  let widest = 0
  for (const line of lines) {
    widest = Math.max(widest, measureText(ctx, line, { size: CALLOUT_SIZE, weight: 700, tracking: 1.4 }))
    drawText(ctx, line, centre + 1, y + 1, {
      size: CALLOUT_SIZE,
      weight: 700,
      tracking: 1.4,
      align: 'center',
      baseline: 'top',
      color: CALLOUT_SHADOW,
    })
    drawText(ctx, line, centre, y, {
      size: CALLOUT_SIZE,
      weight: 700,
      tracking: 1.4,
      align: 'center',
      baseline: 'top',
      color: Palette.caution,
    })
    y += CALLOUT_LINE_H
  }

  // A hairline under the announcement, so it reads as a banner rather than as text
  // that happens to be floating in space. One unit tall: it cannot hide a projectile.
  //
  // Width follows the TEXT, measured. It was a fixed 220 units, which a capture showed
  // reading as a fragment under a line of copy nearly twice that wide — an underline
  // that does not match what it underlines looks like a rendering fault.
  const ruleW = Math.min(widest + 12, maxWidth)
  ctx.fillStyle = Palette.caution
  ctx.globalAlpha = opacity * 0.35
  ctx.fillRect(centre - ruleW / 2, Math.min(y + 4, CALLOUT_BOTTOM - 1), ruleW, 1)
  ctx.globalAlpha = 1
}

/** The lower bound rule 1 is checked against in tests. Kept next to the constant it guards. */
export const PLAYFIELD_LOWER_TWO_THIRDS_TOP = PLAYFIELD_H / 3
