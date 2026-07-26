/**
 * Hazard presentation: the panel block, and the blackout scrim.
 *
 * A hazard is a cycle — idle, warning, active — and the warning is the only part the
 * player can do anything about. So the block is built around making the warning
 * impossible to miss and the idle state impossible to mistake for one.
 *
 * **Rule 3, applied carefully.** `danger` means *can hurt you this instant*, and a
 * hazard one second from firing qualifies: the reaction window is the moment the
 * player has to move. The `active` phase does **not** get it. By the time a hazard is
 * active it has either already done its damage (corrosion, debris — both act on a
 * single tick) or it is a condition that does no damage at all (interdiction slows the
 * hull, blackout dims the screen). Painting all three phases red would train the
 * player's threat reflex on a timer, which is the precise failure rule 3 exists to
 * prevent — and the debris a hazard drops is drawn in `danger` anyway, because those
 * are projectiles.
 *
 * **Rule 2.** Every countdown is in seconds with the unit drawn. Ticks are a
 * simulation detail; a player counting in sixtieths is a player the interface failed.
 *
 * **Rule 10.** The warning band breathes at the shared `pulse()` rate — below 1Hz, and
 * it never reaches zero, so it is a breath rather than a blink. `reduceFlashes`
 * attenuates the swing and leaves the floor, so the row stays exactly as informative
 * at a third of the modulation.
 *
 * **Colour is never the only channel.** Each phase also has a distinct marker glyph
 * and a distinct state word, so the row survives a greyscale screenshot.
 */

import { PLAYFIELD_H, PLAYFIELD_W } from '../core/space'
import type { HazardPhase, HazardView } from '../sim/entities'
import { flashScale, pulse } from './intensity'
import { Palette, withAlpha } from './palette'
import { drawText, drawValue, formatSeconds, measureText } from './text'

/** What one hazard row says, independent of where it is drawn. */
export interface HazardStatus {
  /** The state word. Left of the countdown, and the row's second channel. */
  word: string
  /** Countdown value, already in seconds. */
  seconds: string
  color: string
  /** True only for the reaction window — see the file header on rule 3. */
  urgent: boolean
}

export function hazardStatus(hazard: HazardView): HazardStatus {
  const seconds = formatSeconds(hazard.ticksToChange)
  switch (hazard.phase) {
    case 'warning':
      return { word: 'INBOUND', seconds, color: Palette.dangerText, urgent: true }
    case 'active':
      return { word: 'ACTIVE', seconds, color: Palette.caution, urgent: false }
    default:
      return { word: 'NEXT', seconds, color: Palette.textDim, urgent: false }
  }
}

/**
 * Row heights, in virtual units.
 *
 * Tight on purpose: this block shares the panel's one flexible region with the boss
 * readout and the held build, and a hazard the player cannot see counting down is a
 * worse outcome than an item name they cannot see. Every unit saved here is a unit the
 * build keeps.
 *
 * TWO densities, and the block picks the densest that shows EVERY hazard:
 *
 *   full     name + countdown, then the state word and what the hazard does
 *   compact  name + countdown only; state carried by the marker, the colour and
 *            the band, which are three channels and enough to act on
 *
 * The first version had a third failure mode instead — dropping the description but
 * keeping its line height — and the state word landed a unit below the name and drew
 * straight through it. A screenshot showed it immediately; the lesson taken is that
 * adaptive layout wants *whole rows* whose contents cannot move independently, not a
 * height computed in one place and offsets computed in another.
 */
const NAME_H = 15
const DESC_H = 13
const HEADING_H = 14
const ROW_GAP = 3
/** Width of the state bar down the left of a row. */
const EDGE_W = 2
/** Inset from the edge bar to the row's text. */
const TEXT_INSET = EDGE_W + 6

/** Depth of the warning band's breath. Attenuated by `reduceFlashes`. */
const WARNING_PULSE_DEPTH = 0.55
/** Floor alpha of the warning band. The row is legible even at the bottom of the breath. */
const WARNING_BAND_ALPHA = 0.2

export interface HazardBlockOptions {
  x: number
  y: number
  w: number
  hazards: readonly HazardView[]
  tick: number
  /** Vertical space the block may use. Descriptions are dropped before rows are. */
  available: number
  reduceFlashes?: boolean
}

/** Height of one row at each density. */
const ROW_FULL = NAME_H + DESC_H + ROW_GAP
const ROW_COMPACT = NAME_H + ROW_GAP

/** Height the block needs, so a caller can lay out around it before drawing. */
export function hazardBlockHeight(count: number, withDescriptions: boolean): number {
  if (count <= 0) return 0
  return HEADING_H + (withDescriptions ? ROW_FULL : ROW_COMPACT) * count
}

/**
 * The phase marker.
 *
 * Three distinct shapes, because rule 3 forbids colour carrying information alone: a
 * hollow dot idles, a solid triangle warns, a solid square is in force. A player who
 * cannot separate amber from red still reads three different rows.
 */
function drawMarker(
  ctx: CanvasRenderingContext2D,
  phase: HazardPhase,
  x: number,
  y: number,
  color: string,
): void {
  const size = 6
  const top = y + 3
  if (phase === 'warning') {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.moveTo(x + size / 2, top)
    ctx.lineTo(x + size, top + size)
    ctx.lineTo(x, top + size)
    ctx.closePath()
    ctx.fill()
    return
  }
  if (phase === 'active') {
    ctx.fillStyle = color
    ctx.fillRect(x, top + 1, size, size - 1)
    return
  }
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(x + size / 2, top + size / 2, size / 2 - 0.5, 0, Math.PI * 2)
  ctx.stroke()
}

/** Clip to fit with an ellipsis, so a shortened description cannot read as the whole one. */
function truncate(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  size: number,
): string {
  if (measureText(ctx, text, { size }) <= maxWidth) return text
  let cut = text.length
  while (cut > 0 && measureText(ctx, `${text.slice(0, cut).trimEnd()}…`, { size }) > maxWidth) {
    cut--
  }
  return cut > 0 ? `${text.slice(0, cut).trimEnd()}…` : '…'
}

/**
 * Draw the hazard block, and return the y below it.
 *
 * Degrades by dropping the descriptions first and rows last. A hazard the player
 * cannot see coming is the thing this block exists to prevent, so the countdown
 * survives everything; the sentence explaining what it does is the part that can wait
 * for the world map.
 */
export function drawHazardBlock(
  ctx: CanvasRenderingContext2D,
  options: HazardBlockOptions,
): number {
  const { x, y, w, hazards, tick, available } = options
  const reduce = options.reduceFlashes ?? false
  if (hazards.length === 0) return y

  // Densest layout that still shows every hazard. Rows are only dropped when even the
  // compact form does not fit, which is the point: the block gives up its prose before
  // it gives up a countdown.
  const withDescriptions = hazardBlockHeight(hazards.length, true) <= available
  const rowH = withDescriptions ? ROW_FULL : ROW_COMPACT
  const maxRows = Math.max(0, Math.floor((available - HEADING_H) / rowH))
  if (maxRows <= 0) return y

  const shown = Math.min(hazards.length, maxRows)

  drawText(ctx, 'HAZARDS', x, y, {
    size: 11,
    tracking: 2.2,
    baseline: 'top',
    color: Palette.textFaint,
  })
  let top = y + HEADING_H

  for (let i = 0; i < shown; i++) {
    const hazard = hazards[i]
    if (!hazard) continue
    const status = hazardStatus(hazard)
    const bodyH = rowH - ROW_GAP

    // The band. Only the reaction window gets one, and only the reaction window
    // breathes: a row that pulses while nothing is happening is a row nobody reads
    // when something is.
    if (status.urgent) {
      const breath = pulse(tick, WARNING_PULSE_DEPTH, reduce)
      // Derived from the token, never written as a literal: see `withAlpha`.
      ctx.fillStyle = withAlpha(Palette.danger, WARNING_BAND_ALPHA * breath)
      ctx.fillRect(x - 4, top - 2, w + 8, bodyH + 2)
    }

    ctx.fillStyle = status.color
    ctx.globalAlpha = status.urgent ? 0.55 + 0.45 * pulse(tick, WARNING_PULSE_DEPTH, reduce) : 0.8
    ctx.fillRect(x - 4, top - 2, EDGE_W, bodyH + 2)
    ctx.globalAlpha = 1

    drawMarker(ctx, hazard.phase, x, top, status.color)

    // Countdown right-aligned, name left, measured so the two cannot collide — the
    // same failure the panel's stat line was built to avoid.
    const right = x + w
    const valueW = measureText(ctx, status.seconds, { size: 12, weight: 600 })
    const unitW = measureText(ctx, 's', { size: 12 })
    const total = valueW + 4 + unitW
    drawValue(ctx, status.seconds, 's', right - total, top, {
      size: 12,
      baseline: 'top',
      color: status.color,
    })

    const nameW = w - total - 10 - TEXT_INSET
    drawText(ctx, truncate(ctx, hazard.name.toUpperCase(), nameW, 12), x + TEXT_INSET, top, {
      size: 12,
      weight: 600,
      baseline: 'top',
      color: status.urgent ? Palette.dangerText : Palette.text,
    })

    if (withDescriptions) {
      // The second line carries whichever of the two things is worth more RIGHT NOW,
      // because 164 units will not hold both without truncating the sentence into
      // uselessness ("Wreckage d…").
      //
      // Idle: what the hazard does. This is the only place in a sortie that says so,
      // and idle is when there is time to read it.
      // Warning or active: the state word, large and in the row's colour. The player
      // has already read the description; what they need in the reaction window is
      // confirmation of what the countdown is counting down to.
      const urgent = hazard.phase !== 'idle'
      const line = urgent ? status.word : hazard.description
      drawText(ctx, truncate(ctx, line, w - TEXT_INSET, 11), x + TEXT_INSET, top + NAME_H, {
        size: 11,
        ...(urgent ? { weight: 600 as const, tracking: 1.4 } : {}),
        baseline: 'top',
        color: urgent ? status.color : Palette.textFaint,
      })
    }

    top += rowH
  }

  if (shown < hazards.length) {
    drawText(ctx, `+${hazards.length - shown} more`, x + TEXT_INSET, top - ROW_GAP, {
      size: 11,
      baseline: 'top',
      color: Palette.textDim,
    })
  }

  return top
}

// ---------------------------------------------------------------------------
// blackout
// ---------------------------------------------------------------------------

/**
 * Peak dimming of a blackout, as a scrim alpha.
 *
 * Deliberately short of opaque. The hazard's job is to make the playfield hard to
 * read, not to remove it: a player who cannot see the enemy they are about to fly into
 * dies to a thing they were never shown, which is the same unexplainable death the
 * warning phase exists to prevent.
 */
export const BLACKOUT_DEPTH = 0.62
/** Fraction of the active window spent ramping in, and out. */
const BLACKOUT_RAMP_IN = 0.12
const BLACKOUT_RAMP_OUT = 0.25

/**
 * Scrim alpha for the current hazard state.
 *
 * Ramped at both ends rather than switched. A 62% scrim appearing in one tick over the
 * whole playfield is a large-area luminance step — exactly what rule 10's "no
 * full-screen flashes" is about — and it also reads as a dropped frame rather than as
 * the lights going out.
 */
export function blackoutDepth(
  hazards: readonly HazardView[],
  reduceFlashes = false,
): number {
  let deepest = 0
  for (const hazard of hazards) {
    if (hazard.hazardKind !== 'blackout' || hazard.phase !== 'active') continue
    const progress = Number.isFinite(hazard.progress)
      ? Math.min(1, Math.max(0, hazard.progress))
      : 1
    const envelope = Math.min(
      1,
      progress / BLACKOUT_RAMP_IN,
      (1 - progress) / BLACKOUT_RAMP_OUT,
    )
    deepest = Math.max(deepest, Math.max(0, envelope))
  }
  return deepest * BLACKOUT_DEPTH * flashScale(reduceFlashes)
}

/**
 * Dim the playfield.
 *
 * MUST be drawn after the background, the starfield and the enemies, and BEFORE the
 * enemy projectiles. That ordering is the whole design: occluding incoming fire is a
 * cheap difficulty that produces deaths the player cannot explain or learn from, so
 * the bullets are simply painted on top of the darkness at full contrast. The player's
 * own hull is drawn after them and stays visible for the same reason.
 */
export function drawBlackout(ctx: CanvasRenderingContext2D, depth: number): void {
  if (!(depth > 0.004)) return
  ctx.fillStyle = `rgba(2, 3, 6, ${Math.min(1, depth).toFixed(3)})`
  ctx.fillRect(0, 0, PLAYFIELD_W, PLAYFIELD_H)
}
