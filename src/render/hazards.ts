/**
 * Hazard presentation: the panel block, the playfield alarm, and the blackout scrim.
 *
 * A hazard is a cycle — idle, warning, active — and the warning is the only part the
 * player can do anything about. So the block is built around making the warning
 * impossible to miss and the idle state impossible to mistake for one.
 *
 * **The block is not enough, and for two milestones it was the only thing there was.**
 * It draws in the instrument column, and during a sortie nobody is reading the
 * instrument column — the eyes are on the hull and on the fire coming at it, which is
 * the whole point of UI.md rule 9. So the one second a hazard gives the player to react
 * was being delivered to the part of the screen they are demonstrably not looking at:
 * the mechanic was fair in the simulation and unfair on the display. `drawHazardWarning`
 * is the fix, and the division of labour is deliberate — the panel row is the
 * *reference* (what the hazard is, in prose, counted in seconds) and the playfield cue
 * is the *alarm* (that it is coming, from where, and how much of the window is left,
 * with no number to parse mid-dodge).
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
import type { HazardKind } from '../content/types'
import type { HazardPhase, HazardView } from '../sim/entities'
import { HAZARD_WARNING_TICKS } from '../sim/hazards'
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
// the playfield alarm
// ---------------------------------------------------------------------------

/**
 * Kinds that take integrity when they fire.
 *
 * Read from the SIMULATION's behaviour, not from `HazardDef.damage`: `world.ts` calls
 * `applyHullDamage` for `corrosion` and spawns damaging projectiles for `debris`, and
 * for `interdiction` and `blackout` it applies nothing at all — `HazardDef.damage` is
 * dead data for both, which is why the two cards now read "does no damage" (see
 * `content/hazards.ts`). So this is a fact about kinds and cannot be falsified by a
 * content edit, which is what makes it safe to colour a warning with.
 *
 * `HazardView` does not carry `damage`, and it should not have to: a *severity* the
 * alarm derives from the kind is one fewer field on the contract. A kind added later
 * with no entry here is treated as harmless, which understates rather than overstates —
 * the wrong direction to be wrong in, but the alternative is crying danger for
 * something that cannot hurt anyone, which is the failure rule 3 exists to prevent.
 */
const HARMFUL_KINDS: ReadonlySet<HazardKind> = new Set<HazardKind>(['corrosion', 'debris'])

/**
 * Which edges of the playfield a kind's warning is anchored to.
 *
 * `debris` is the only kind with a location: `spawnDebris` puts its curtain along the
 * TOP edge at `y = -radius` and drops it straight down across the full width. The
 * five lanes carry an rng jitter drawn on the tick it fires, so the exact x of each
 * chunk is genuinely not knowable during the warning — and it is uniform, so no x is
 * more likely than another. "The whole top edge, coming down" is therefore the most
 * specific true thing there is to say, and it is said by washing that one edge.
 *
 * The other three are global by construction — `speedFactor()` is one multiplier on the
 * hull wherever it is, corrosion "strips wherever the hull is", the blackout scrim
 * covers the field — so they wash all four edges. That is the honest shape for "there
 * is nowhere to be": inventing a direction for a hazard that has none would send the
 * player dodging something that is not there, which is worse than the panel-only
 * warning this cue replaces.
 */
const SPATIAL_KINDS: ReadonlySet<HazardKind> = new Set<HazardKind>(['debris'])

/** Inward depth of the edge wash. Inside the rim's 26, for the same reason. */
const ONSET_DEPTH = 20
/** Peak wash opacity at the edge itself, fading to nothing by ONSET_DEPTH. */
const ONSET_WASH_ALPHA = 0.34
/** Depth of the alarm's breath. Never reaches zero, so it breathes — see rule 10. */
const ONSET_PULSE_DEPTH = 0.5
/** Opacity the crisp marks hold at the bottom of the breath. Legible at every phase. */
const ONSET_FLOOR = 0.5

/** Inward-pointing teeth along a washed edge: the direction, as a shape. */
const TOOTH = 7
const TOOTH_SPACING_X = 64
const TOOTH_SPACING_Y = 80

/**
 * The onset strip: a countdown with no digits.
 *
 * Twelve pips consumed from the outside in, so the block that is left stays centred
 * under the hull and shrinking time reads as shrinking width in the same glance as the
 * ship. The empty slots stay drawn — `drawDamageBar` learned the same lesson — because
 * without the track a short bar has nothing to be short *against*, and the player
 * cannot tell a window nearly gone from a window that was always small.
 */
const STRIP_SLOTS = 12
const STRIP_PIP_W = 11
const STRIP_PIP_GAP = 3
const STRIP_H = 5
const STRIP_W = STRIP_SLOTS * STRIP_PIP_W + (STRIP_SLOTS - 1) * STRIP_PIP_GAP
const STRIP_X = (PLAYFIELD_W - STRIP_W) / 2
/** Top of the first strip. Below the hull's plume, above the bottom edge's own wash. */
const STRIP_Y = PLAYFIELD_H - 20
const STRIP_ROW_GAP = 4
/**
 * Strips drawn at once. Content ships at most two hazards in a stage; the cap is here
 * so a future sector cannot turn the alarm into a wall of bars over the ship.
 */
const MAX_ALARMS = 3

/** Fraction of the reaction window still to run, 1 at the start and never 0. */
function onsetRemaining(hazard: HazardView): number {
  const ticks = Number.isFinite(hazard.ticksToChange) ? hazard.ticksToChange : HAZARD_WARNING_TICKS
  const fraction = ticks / HAZARD_WARNING_TICKS
  return fraction < 0 ? 0 : fraction > 1 ? 1 : fraction
}

/**
 * Wash one edge, plus its teeth.
 *
 * `dx`/`dy` are the inward direction, which is all the four cases differ by. `breath`
 * arrives already computed so every edge in a frame modulates together — four edges
 * breathing out of phase would read as rotation rather than as one alarm.
 */
function drawOnsetEdge(
  ctx: CanvasRenderingContext2D,
  side: 'top' | 'bottom' | 'left' | 'right',
  color: string,
  breath: number,
): void {
  const vertical = side === 'top' || side === 'bottom'
  const x0 = side === 'right' ? PLAYFIELD_W : 0
  const y0 = side === 'bottom' ? PLAYFIELD_H : 0
  const dx = side === 'left' ? 1 : side === 'right' ? -1 : 0
  const dy = side === 'top' ? 1 : side === 'bottom' ? -1 : 0

  /*
   * THE BREATH GOES IN `globalAlpha`, NOT IN THE GRADIENT STOPS.
   *
   * Both would look identical on screen and only one of them is measurable: the
   * rule-10 harness in tests/render.test.ts reconstructs an effect's brightness from
   * recorded fill styles and `globalAlpha`, and a gradient's `addColorStop` alpha is
   * not either of those — a stub gradient swallows it. An 8.59 Hz strobe already
   * shipped once through exactly this kind of blind spot (the engine plume, which
   * modulated area while the suite watched alpha). A safety rule the suite cannot see
   * is not enforced, so the modulation is put where the suite looks.
   */
  const gradient = vertical
    ? ctx.createLinearGradient(0, y0, 0, y0 + dy * ONSET_DEPTH)
    : ctx.createLinearGradient(x0, 0, x0 + dx * ONSET_DEPTH, 0)
  gradient.addColorStop(0, withAlpha(color, ONSET_WASH_ALPHA))
  gradient.addColorStop(1, withAlpha(color, 0))
  ctx.globalAlpha = breath
  ctx.fillStyle = gradient
  ctx.fillRect(
    side === 'right' ? PLAYFIELD_W - ONSET_DEPTH : 0,
    side === 'bottom' ? PLAYFIELD_H - ONSET_DEPTH : 0,
    vertical ? PLAYFIELD_W : ONSET_DEPTH,
    vertical ? ONSET_DEPTH : PLAYFIELD_H,
  )

  // Teeth. Filled triangles sitting ON the edge and pointing inward — deliberately not
  // the hollow chevron `drawThreatIndicators` uses, because that one means "an enemy is
  // about to arrive here" and two cues sharing a silhouette is how a player learns to
  // read neither.
  const span = vertical ? PLAYFIELD_W : PLAYFIELD_H
  const spacing = vertical ? TOOTH_SPACING_X : TOOTH_SPACING_Y
  const count = Math.max(1, Math.floor(span / spacing))
  const start = (span - (count - 1) * spacing) / 2
  ctx.globalAlpha = ONSET_FLOOR + (1 - ONSET_FLOOR) * breath
  ctx.fillStyle = color
  for (let i = 0; i < count; i++) {
    const at = start + i * spacing
    ctx.beginPath()
    if (vertical) {
      ctx.moveTo(at - TOOTH / 2, y0)
      ctx.lineTo(at + TOOTH / 2, y0)
      ctx.lineTo(at, y0 + dy * TOOTH)
    } else {
      ctx.moveTo(x0, at - TOOTH / 2)
      ctx.lineTo(x0, at + TOOTH / 2)
      ctx.lineTo(x0 + dx * TOOTH, at)
    }
    ctx.closePath()
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

/**
 * The reaction window, drawn where the player is actually looking.
 *
 * Three things, and each one answers a question the panel row answers too slowly:
 *
 *   WHEN   a twelve-pip strip under the hull, emptied from the outside in. Time to
 *          onset is a length that shrinks, not a figure to read while dodging.
 *   WHERE  the playfield edge the hazard comes from is washed and grows teeth. One
 *          edge means one direction; four means everywhere, which is the truth for
 *          every kind except debris. See SPATIAL_KINDS.
 *   WHAT   whether it will cost integrity. `danger` and `caution` are the two roles
 *          for that — and they are the one pair in the palette that CANNOT be
 *          separated by hue for a protanope or deuteranope (ΔE00 12.8 at best; see
 *          tests/palette.test.ts). So severity carries a second channel: the pips of
 *          a damaging hazard are NOTCHED, exactly as the integrity meter's critical
 *          state is notched in render/panel.ts, and for exactly the same reason.
 *
 * Rule 1 permits this over the playfield on the same terms as the low-integrity rim
 * and the threat chevrons: it is transient, it exists only during the reaction window,
 * and it lives in the outer margin plus a strip below the hull rather than over the
 * space bullets are read in. Nothing here is a persistent state readout — the moment
 * the hazard fires, it is gone.
 *
 * Rule 10: every modulated value comes from `pulse()` at the shared 0.85 Hz and
 * attenuates under `reduceFlashes`. Geometry is a pure function of the countdown and
 * never of `tick`, so the alarm cannot flash by changing size — which is also what
 * makes the alpha the suite measures the axis it actually varies on.
 */
export function drawHazardWarning(
  ctx: CanvasRenderingContext2D,
  hazards: readonly HazardView[],
  tick: number,
  reduceFlashes = false,
): void {
  const breath = pulse(tick, ONSET_PULSE_DEPTH, reduceFlashes)

  // Pass one: the union of the washed edges, so two hazards warning at once cannot
  // stack two washes into an opaque frame. An edge is red if ANY hazard washing it can
  // take integrity — understating a threat that is genuinely there is not an option.
  let top = false
  let sides = false
  let harmfulTop = false
  let harmfulSides = false
  let shown = 0
  for (const hazard of hazards) {
    if (hazard.phase !== 'warning') continue
    if (shown >= MAX_ALARMS) break
    shown++
    const harmful = HARMFUL_KINDS.has(hazard.hazardKind)
    top = true
    harmfulTop = harmfulTop || harmful
    if (!SPATIAL_KINDS.has(hazard.hazardKind)) {
      sides = true
      harmfulSides = harmfulSides || harmful
    }
  }
  if (shown === 0) return

  const topColor = harmfulTop ? Palette.danger : Palette.caution
  const sideColor = harmfulSides ? Palette.danger : Palette.caution
  if (top) drawOnsetEdge(ctx, 'top', topColor, breath)
  if (sides) {
    drawOnsetEdge(ctx, 'bottom', sideColor, breath)
    drawOnsetEdge(ctx, 'left', sideColor, breath)
    drawOnsetEdge(ctx, 'right', sideColor, breath)
  }

  // Pass two: one strip per warning hazard, stacked upward from the bottom edge so the
  // first one is always in the same place. Severity is per hazard here even where the
  // washes merged, which is the point of putting it on a second channel at all.
  let row = 0
  for (const hazard of hazards) {
    if (hazard.phase !== 'warning') continue
    if (row >= MAX_ALARMS) break
    const harmful = HARMFUL_KINDS.has(hazard.hazardKind)
    const color = harmful ? Palette.danger : Palette.caution
    const y = STRIP_Y - row * (STRIP_H + STRIP_ROW_GAP)
    row++

    const filled = Math.min(
      STRIP_SLOTS,
      Math.max(1, Math.ceil(onsetRemaining(hazard) * STRIP_SLOTS)),
    )
    // Consumed from both ends, so what remains stays under the ship.
    const dropped = STRIP_SLOTS - filled
    const from = Math.ceil(dropped / 2)
    const to = STRIP_SLOTS - Math.floor(dropped / 2)

    for (let i = 0; i < STRIP_SLOTS; i++) {
      const x = STRIP_X + i * (STRIP_PIP_W + STRIP_PIP_GAP)
      const lit = i >= from && i < to
      // The spent slots stay visible at a fixed dimness: they are the scale, not a
      // second thing blinking.
      ctx.globalAlpha = lit ? ONSET_FLOOR + (1 - ONSET_FLOOR) * breath : 0.3
      ctx.fillStyle = lit ? color : Palette.line
      ctx.fillRect(x, y, STRIP_PIP_W, STRIP_H)
      if (!lit || !harmful) continue
      // The notch. Cut in the surface colour rather than drawn in a second hue, so it
      // survives greyscale, all three deficiency simulations, and a photograph.
      ctx.globalAlpha = 1
      ctx.fillStyle = Palette.void
      const notch = Math.max(1, Math.floor(STRIP_PIP_W / 3))
      ctx.fillRect(x + (STRIP_PIP_W - notch) / 2, y, notch, STRIP_H)
    }
    ctx.globalAlpha = 1
  }
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
