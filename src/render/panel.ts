/**
 * The instrument panel.
 *
 * This column is the reason the layout reserves 192 units on the right: it keeps
 * every readout out of the play area. See docs/UI.md for the rules it follows.
 * The short version:
 *
 *   - Every value carries a unit and a label. No bare numbers.
 *   - Meters are segmented, because a player can count segments at a glance but
 *     cannot judge the length of a smooth bar under pressure.
 *   - `danger` colour appears only when something is actually wrong.
 */

import type { ItemDef } from '../content/types'
import { PANEL_W, PLAYFIELD_W, VIRTUAL_H } from '../core/space'
import { formatSeed } from '../core/seed'
import type { WorldView } from '../sim/entities'
import { Font, Palette } from './palette'
import { drawLabel, drawText, drawValue, measureText } from './text'

const PAD = 14
const CONTENT_X = PLAYFIELD_W + PAD
const CONTENT_W = PANEL_W - PAD * 2

export function drawPanelFrame(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = Palette.panel
  ctx.fillRect(PLAYFIELD_W, 0, PANEL_W, VIRTUAL_H)
  // A single hairline divides play from instruments. Crisp because it sits on a
  // half-unit boundary rather than straddling one.
  ctx.fillStyle = Palette.line
  ctx.fillRect(PLAYFIELD_W, 0, 1, VIRTUAL_H)
}

/** A horizontal rule used to separate panel sections. */
function drawDivider(ctx: CanvasRenderingContext2D, y: number): void {
  ctx.fillStyle = Palette.line
  ctx.fillRect(CONTENT_X, y, CONTENT_W, 1)
}

interface MeterOptions {
  label: string
  value: number
  max: number
  unit: string
  color: string
  /** Below this fraction the meter switches to the caution/danger colour. */
  warnBelow?: number
  segments?: number
}

/**
 * A segmented meter: label and value on one line, bar beneath it.
 *
 * Everything is positioned from the *top* of the row, not a text baseline.
 * Mixing tops and baselines is what let an earlier version draw the value
 * string straight through the bar — a collision no unit test can see and a
 * screenshot shows instantly.
 *
 * Returns the y coordinate below the meter so callers stack sections without
 * hard-coding positions.
 */
function drawMeter(ctx: CanvasRenderingContext2D, top: number, options: MeterOptions): number {
  const { label, value, max, unit, color, warnBelow = 0, segments = 12 } = options
  const fraction = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0

  const critical = fraction <= warnBelow
  const barColor = critical ? Palette.danger : color

  drawLabel(ctx, label, CONTENT_X, top, { baseline: 'top' })

  // Unit first, right-aligned to the edge, then the value to its left. Keeps the
  // value's last digit a fixed distance from the edge as its width changes.
  const right = CONTENT_X + CONTENT_W
  const unitWidth = drawText(ctx, `/ ${max} ${unit}`, right, top + 2, {
    size: 10,
    align: 'right',
    baseline: 'top',
    color: Palette.textDim,
  })
  drawText(ctx, `${Math.round(value)}`, right - unitWidth - 5, top, {
    size: 13,
    weight: 600,
    align: 'right',
    baseline: 'top',
    color: critical ? Palette.danger : Palette.text,
  })

  const barTop = top + 18
  const barH = 8
  const gap = 2
  const segW = (CONTENT_W - gap * (segments - 1)) / segments
  const filledSegments = Math.round(fraction * segments)

  for (let i = 0; i < segments; i++) {
    const x = CONTENT_X + i * (segW + gap)
    ctx.fillStyle = i < filledSegments ? barColor : Palette.panelRaised
    ctx.fillRect(x, barTop, segW, barH)
  }

  return barTop + barH
}

/**
 * A label/value readout.
 *
 * The gap *within* a group (label to its value) is smaller than the gap
 * *between* groups, so proximity alone tells you which label owns which value.
 * Without that, `FIRE RATE` reads as a caption for the line above it.
 */
function drawRow(
  ctx: CanvasRenderingContext2D,
  top: number,
  label: string,
  value: string,
  unit = '',
  valueColor: string = Palette.text,
): number {
  drawLabel(ctx, label, CONTENT_X, top, { baseline: 'top' })
  drawValue(ctx, value, unit, CONTENT_X, top + 14, {
    size: 15,
    baseline: 'top',
    color: valueColor,
  })
  return top + 33
}

/**
 * A compact one-line readout: label left, value right-aligned on the same line.
 *
 * Used for the sortie log, where a dozen rows of the label-above-value form
 * would out-shout the meters they sit beneath. Sharing a line makes ownership
 * unambiguous — there is no vertical gap for the eye to misread, which is the
 * failure mode that once made `FIRE RATE` look like a caption for the value
 * above it.
 *
 * The hazard this form *does* have is the collision that put the warning in
 * drawMeter's comment: a long label runs into a right-aligned value. Rather than
 * trusting a character count, this measures both and drops the value onto its
 * own line if they would not fit. Degrading to two lines is ugly; overlapping
 * text is unreadable, and unreadable is a P0.
 */
const STAT_VALUE_SIZE = 13
/** Mirrors drawValue's internal unit sizing, so the measurement matches the draw. */
const STAT_UNIT_SIZE = Math.max(Font.minSizePx, STAT_VALUE_SIZE - 4)
const STAT_MIN_GAP = 10

function drawStatLine(
  ctx: CanvasRenderingContext2D,
  top: number,
  label: string,
  value: string,
  unit = '',
  valueColor: string = Palette.text,
): number {
  const right = CONTENT_X + CONTENT_W
  const labelWidth = measureText(ctx, label.toUpperCase(), { size: 12, tracking: 1.4 })
  const valueWidth = measureText(ctx, value, { size: STAT_VALUE_SIZE, weight: 600 })
  const unitWidth = unit ? measureText(ctx, unit, { size: STAT_UNIT_SIZE }) : 0
  const total = valueWidth + (unit ? 4 + unitWidth : 0)

  // The label is a point smaller than the value and both are positioned from
  // their tops, so it needs a unit of nudge to share an optical baseline.
  drawLabel(ctx, label, CONTENT_X, top + 1, { baseline: 'top' })

  if (labelWidth + STAT_MIN_GAP + total <= CONTENT_W) {
    drawValue(ctx, value, unit, right - total, top, {
      size: STAT_VALUE_SIZE,
      baseline: 'top',
      color: valueColor,
    })
    return top + 20
  }

  drawValue(ctx, value, unit, CONTENT_X, top + 15, {
    size: STAT_VALUE_SIZE,
    baseline: 'top',
    color: valueColor,
  })
  return top + 34
}

/** A faint section heading. Marks a group as secondary to the meters above it. */
function drawSectionHeading(ctx: CanvasRenderingContext2D, top: number, text: string): number {
  drawText(ctx, text.toUpperCase(), CONTENT_X, top, {
    size: 11,
    tracking: 2.2,
    baseline: 'top',
    color: Palette.textFaint,
  })
  return top + 17
}

/**
 * Accuracy as a percentage.
 *
 * Before the first shot there is no accuracy, and showing `0 %` would report a
 * failure the player has not had the chance to commit. An em dash says
 * "no data" without pretending to be a measurement.
 */
function formatAccuracy(hits: number, shotsFired: number): { value: string; unit: string } {
  if (shotsFired <= 0) return { value: '—', unit: '' }
  return { value: String(Math.round((hits / shotsFired) * 100)), unit: '%' }
}

/**
 * The held-build readout.
 *
 * Fills the ~140-unit void the layout comment below deliberately left in the
 * middle of the column. Items are the fastest-moving state in the run now, and a
 * player who cannot see what is fitted cannot read their own numbers.
 *
 * Three constraints shape it, all of them scars:
 *
 * - **Names are truncated, never wrapped.** The column's content width is 164
 *   units and the longest item name ("Coin-Operated Cannon") is wider than that
 *   once a stack count is beside it. `drawStatLine` degrades to two lines when a
 *   value would collide with its label, but that answer does not scale to a list —
 *   a dozen two-line rows would run straight into the sortie log. So a row
 *   measures its name and clips it with an ellipsis instead.
 * - **The list length comes from the available height**, not a constant, so the
 *   readout cannot overflow into the log below it if anything above it grows.
 * - **Every number is read from `view.resolvedStats`.** The panel advertising a
 *   fire rate the weapon did not have shipped once already; items make these
 *   numbers move constantly, and recomputing one here would reintroduce it.
 */
const BUILD_ROW_H = 15

/** Clip to fit, with an ellipsis so a shortened name cannot read as the whole one. */
function truncateToWidth(
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

/** `coin-op-cannon` becomes `Coin Op Cannon`. Only reached when no table is supplied. */
function prettifyId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** At most one decimal: items produce values like 5.8 and 7.25, not integers. */
function formatStat(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

/**
 * Draw the build between `top` and `bottom`, and return nothing — the block is
 * anchored, not flowed, so nothing below it depends on how tall it turned out.
 */
function drawHeldBuild(
  ctx: CanvasRenderingContext2D,
  view: WorldView,
  top: number,
  bottom: number,
  items?: Readonly<Record<string, ItemDef>>,
): void {
  let y = drawSectionHeading(ctx, top, 'Build')

  // Damage per shot lives here rather than with the weapon group above because it
  // is the number items move most, and reading it next to the list that changed it
  // is what makes an item's effect legible.
  const damage = view.resolvedStats.projectileDamage
  if (damage !== undefined) {
    y = drawStatLine(ctx, y, 'Damage', formatStat(damage), 'per shot')
  }

  if (view.inventory.length === 0) {
    drawText(ctx, 'Nothing fitted', CONTENT_X, y, {
      size: 12,
      baseline: 'top',
      color: Palette.textFaint,
    })
    return
  }

  const live = view.activeInteractions.length
  // Reserve the synergy row up front, so the item list cannot eat the space and
  // push a live combination off the panel.
  const reserved = live > 0 ? 20 : 0
  const rows = Math.max(0, Math.floor((bottom - y - reserved) / BUILD_ROW_H))

  // One row is given up to the overflow count when the list is longer than the
  // void: an undercount of the build is worse than one fewer name.
  const listed = view.inventory.length > rows ? Math.max(0, rows - 1) : view.inventory.length
  for (let i = 0; i < listed; i++) {
    const entry = view.inventory[i]
    if (!entry) continue
    const count = entry.count > 1 ? `×${entry.count}` : ''
    const countWidth = count ? measureText(ctx, count, { size: 12 }) : 0
    const name = items?.[entry.defId]?.name ?? prettifyId(entry.defId)
    drawText(ctx, truncateToWidth(ctx, name, CONTENT_W - countWidth - 8, 12), CONTENT_X, y, {
      size: 12,
      baseline: 'top',
      color: Palette.text,
    })
    if (count) {
      // A count, not a bare number: "×2" cannot be misread as a quantity of
      // anything else on the row.
      drawText(ctx, count, CONTENT_X + CONTENT_W, y, {
        size: 12,
        align: 'right',
        baseline: 'top',
        color: Palette.textDim,
      })
    }
    y += BUILD_ROW_H
  }
  const hidden = view.inventory.length - listed
  if (hidden > 0) {
    drawText(ctx, `+${hidden} more fitted`, CONTENT_X, y, {
      size: 12,
      baseline: 'top',
      color: Palette.textDim,
    })
    y += BUILD_ROW_H
  }

  if (live > 0) {
    // `good` because a live combination is a gain. The count carries the
    // information; the colour only reinforces it. The interaction text itself is
    // too long for this column and is stated on the choice screen instead.
    drawStatLine(ctx, y, 'Synergy', String(live), 'live', Palette.good)
  }
}

export interface PanelState {
  pilotNumber: number
  hullName: string
  weaponName: string
  /** Shots per second, shown with a unit so it can't be mistaken for a multiplier. */
  fireRate: number
  // No `scrap` field: scrap is read from the run's own stats, so a caller cannot
  // hand the HUD a number that disagrees with the simulation.
  sector: number
  sectorCount: number
  /**
   * Waves in the current sector, for the progress readout. Omitted while the
   * sector script is not known to the caller, in which case the readout reports
   * waves released instead of a fraction — never a bare count.
   */
  waveCount?: number
  /**
   * Item table, for resolving held ids to names.
   *
   * Optional and injected rather than imported, for the reason the incident report
   * takes its `causeName` the same way: a render module that cannot be drawn
   * without the content registry loaded is hard to test. Without it the readout
   * formats the id, which is readable but not the authored name.
   */
  items?: Readonly<Record<string, ItemDef>>
}

export function drawPanel(
  ctx: CanvasRenderingContext2D,
  view: WorldView,
  state: PanelState,
): void {
  drawPanelFrame(ctx)

  // Spacing scale for this panel. BETWEEN_GROUPS is deliberately much larger
  // than the internal label-to-value gap inside drawRow, so grouping is
  // unambiguous by proximity alone.
  const BETWEEN_GROUPS = 16
  const BEFORE_DIVIDER = 14
  const AFTER_DIVIDER = 16

  let y = PAD + 8

  // Identity block — the title's premise, made literal.
  drawLabel(ctx, 'Pilot', CONTENT_X, y, { baseline: 'top' })
  drawText(ctx, `#${String(state.pilotNumber).padStart(3, '0')}`, CONTENT_X + CONTENT_W, y, {
    size: 12,
    weight: 600,
    align: 'right',
    baseline: 'top',
    color: Palette.textDim,
  })
  y += 18
  drawText(ctx, state.hullName.toUpperCase(), CONTENT_X, y, {
    size: 18,
    weight: 700,
    tracking: 1,
    baseline: 'top',
    color: Palette.self,
  })
  y += 22 + BEFORE_DIVIDER
  drawDivider(ctx, y)
  y += AFTER_DIVIDER

  // Meter labels are kept short deliberately: the label sits on the same line as
  // the right-aligned value, and a long one ("INTEGRITY") ran into it. Anything
  // longer than about 7 characters will not fit at this panel width.
  y = drawMeter(ctx, y, {
    label: 'Hull',
    value: view.hull.integrity,
    max: view.hull.maxIntegrity,
    unit: 'hp',
    color: Palette.good,
    warnBelow: 0.3,
  })
  y += BETWEEN_GROUPS

  y = drawMeter(ctx, y, {
    label: 'Shield',
    value: view.hull.shield,
    max: view.hull.maxShield,
    unit: 'sp',
    color: Palette.self,
    segments: 8,
  })
  y += BEFORE_DIVIDER
  drawDivider(ctx, y)
  y += AFTER_DIVIDER

  y = drawRow(ctx, y, 'Weapon', state.weaponName)
  y += BETWEEN_GROUPS
  y = drawRow(ctx, y, 'Fire rate', state.fireRate.toFixed(1), 'shots/s')
  y += BETWEEN_GROUPS
  // Scrap comes from the run, not the caller: a currency the HUD could get wrong
  // is a currency the player cannot trust.
  y = drawRow(ctx, y, 'Scrap', String(view.stats.scrap), 'cr', Palette.caution)
  y += BEFORE_DIVIDER
  drawDivider(ctx, y)
  y += AFTER_DIVIDER

  // Progress group. Sector and wave sit tight together with no BETWEEN_GROUPS
  // between them, because they answer one question — how far in am I — and
  // proximity is what says so.
  y = drawRow(ctx, y, 'Sector', `${state.sector} / ${state.sectorCount}`)
  const waves = state.waveCount ?? 0
  y = drawStatLine(
    ctx,
    y,
    'Wave',
    waves > 0 ? `${view.stats.waveIndex} / ${waves}` : String(view.stats.waveIndex),
    waves > 0 ? 'waves' : 'waves released',
  )
  // Footer: seed always visible, so any screenshot is a reproducible bug report.
  const footerTop = VIRTUAL_H - PAD - 34
  const footerDivider = footerTop - AFTER_DIVIDER

  // Sortie log: numbers a player checks *between* waves, not during one.
  //
  // Anchored up from the footer rather than flowed after the block above, for
  // two reasons. It fixes the log's position, so a value cannot appear to move
  // when a section above it grows — a readout that shifts is a readout you have
  // to find again. And it puts the one deliberate gap in the middle of the
  // column, where the held-items list belongs, instead of leaving a void at the
  // bottom that reads as unfinished.
  const LOG_H = 17 + 20 * 3
  const logTop = footerDivider - AFTER_DIVIDER - LOG_H
  const logDivider = logTop - AFTER_DIVIDER
  drawDivider(ctx, logDivider)

  // The void the comment above reserved, now spent on the build.
  //
  // Drawn after the log's divider is known because the readout is bounded by it:
  // the space it gets is whatever is left between the progress group and the fixed
  // block below, and it must never grow past that. The gap above the heading is
  // tighter than AFTER_DIVIDER on purpose — every unit there is a unit the item
  // list does not get, and the void is only ~110 tall to begin with.
  y += BEFORE_DIVIDER
  drawDivider(ctx, y)
  drawHeldBuild(ctx, view, y + 12, logDivider - 8, state.items)

  let logY = drawSectionHeading(ctx, logTop, 'Sortie log')
  const accuracy = formatAccuracy(view.stats.hits, view.stats.shotsFired)
  logY = drawStatLine(ctx, logY, 'Kills', String(view.stats.kills), 'confirmed')
  logY = drawStatLine(ctx, logY, 'Accuracy', accuracy.value, accuracy.unit)
  drawStatLine(
    ctx,
    logY,
    'Hits',
    `${view.stats.hits} / ${view.stats.shotsFired}`,
    'shots',
    Palette.textDim,
  )

  drawDivider(ctx, footerDivider)
  drawLabel(ctx, 'Seed', CONTENT_X, footerTop, { baseline: 'top' })
  drawText(ctx, formatSeed(view.seed), CONTENT_X, footerTop + 15, {
    size: 12,
    baseline: 'top',
    color: Palette.textDim,
  })
}
