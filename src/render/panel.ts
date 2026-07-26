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
import type { EnemyInstance, HazardView, StageView, WorldView } from '../sim/entities'
import {
  BAR_CARET_H,
  BOSS_NAME_SIZE,
  bossNameLines,
  drawBossHealthBar,
} from './boss'
import { drawHazardBlock } from './hazards'
import { Font, Palette } from './palette'
import { canvasMeasure, drawLabel, drawText, drawValue, measureText } from './text'

const PAD = 14
const CONTENT_X = PLAYFIELD_W + PAD
const CONTENT_W = PANEL_W - PAD * 2

/**
 * Defensive reads of the M5 view fields.
 *
 * The panel is drawn every frame from whatever it is handed, including by tests and
 * tools that build a `WorldView` by hand and by a save-scummed replay from an older
 * build. A missing field must degrade to "nothing to show" — a HUD that throws takes
 * the whole frame with it, and in a permadeath game that costs a run.
 */
function stageOf(view: WorldView): StageView {
  const stage = view.stage as StageView | undefined
  if (!stage || !Number.isFinite(stage.index) || !Number.isFinite(stage.count)) {
    return { index: 0, count: 1, sectorId: '', sectorName: '', bossName: null }
  }
  return stage
}

function hazardsOf(view: WorldView): readonly HazardView[] {
  return Array.isArray(view.hazards) ? view.hazards : []
}

function bossOf(view: WorldView): EnemyInstance | null {
  const boss = view.boss ?? null
  return boss && boss.alive && boss.boss ? boss : null
}

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
    color: critical ? Palette.dangerText : Palette.text,
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

  /**
   * A SECOND CHANNEL for critical, because colour alone cannot carry it.
   *
   * Going critical used to be a hue swap in place — same bar, same segments, same
   * position, `caution` becomes `danger`. Those two differ only along the L–M axis,
   * which is exactly the axis protanopes and deuteranopes lack (measured ΔE00 13.1
   * deuteranopic, 6.3 tritanopic against a bar of 15), and a constrained search over
   * the whole palette could not clear it without destroying `caution`'s separation
   * from `good`. So for a meaningful share of players, the most important state
   * change in the game was invisible.
   *
   * It is not a colour problem and cannot be solved with a better red. Notches cut
   * into the filled segments give it a second channel that survives greyscale, every
   * simulated deficiency, and a photograph of a screen. See tests/palette.test.ts.
   */
  if (critical) {
    ctx.fillStyle = Palette.panel
    const notch = Math.max(1, Math.floor(segW / 3))
    for (let i = 0; i < filledSegments; i++) {
      const x = CONTENT_X + i * (segW + gap)
      ctx.fillRect(x + (segW - notch) / 2, barTop, notch, barH)
    }
  }

  return barTop + barH
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
/** Below this much space the build collapses to one line; below one line it is dropped. */
const BUILD_MIN_H = 32

function drawHeldBuild(
  ctx: CanvasRenderingContext2D,
  view: WorldView,
  top: number,
  bottom: number,
  items?: Readonly<Record<string, ItemDef>>,
): void {
  // The boss and hazard blocks above can legitimately take the whole void during a
  // late-sector fight. Drawing anyway would run this readout straight through the
  // sortie log, and overlapping text is a P0 — so it collapses, then disappears.
  const space = bottom - top
  if (space < BUILD_MIN_H) {
    if (space >= 18 && view.inventory.length > 0) {
      drawStatLine(ctx, top, 'Build', String(view.inventory.length), 'fitted', Palette.textDim)
    }
    return
  }

  let y = drawSectionHeading(ctx, top, 'Build')

  // Damage per shot lives here rather than with the weapon group above because it
  // is the number items move most, and reading it next to the list that changed it
  // is what makes an item's effect legible.
  //
  // EVERY row from here down is gated on fitting. The block used to assume it owned
  // ~110 units, which stopped being true the moment a boss and a hazard block moved
  // into the same region: with one hazard live the damage line, the overflow count and
  // the synergy row together ran straight through the sortie log heading. Nothing here
  // may draw at a y the caller did not grant.
  const damage = view.resolvedStats.projectileDamage
  if (damage !== undefined && y + 20 <= bottom) {
    y = drawStatLine(ctx, y, 'Damage', formatStat(damage), 'per shot')
  }

  if (view.inventory.length === 0) {
    if (y + 14 <= bottom) {
      drawText(ctx, 'Nothing fitted', CONTENT_X, y, {
        size: 12,
        baseline: 'top',
        color: Palette.textFaint,
      })
    }
    return
  }

  const live = view.activeInteractions.length
  // Reserve the synergy row up front, so the item list cannot eat the space and
  // push a live combination off the panel — but only if there is a row to reserve.
  const reserved = live > 0 && y + 20 <= bottom ? 20 : 0
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
  // Not one name fits, but there is still a line's worth of room: say how many are
  // fitted rather than nothing at all. "I have eight items" is a smaller answer than
  // the list, and a much larger one than silence.
  if (rows === 0) {
    if (y + 18 <= bottom) {
      drawStatLine(ctx, y, 'Fitted', String(view.inventory.length), 'items', Palette.textDim)
    }
    return
  }

  const hidden = view.inventory.length - listed
  if (hidden > 0 && y + BUILD_ROW_H <= bottom) {
    drawText(ctx, `+${hidden} more fitted`, CONTENT_X, y, {
      size: 12,
      baseline: 'top',
      color: Palette.textDim,
    })
    y += BUILD_ROW_H
  }

  if (live > 0 && reserved > 0 && y + 18 <= bottom) {
    // `good` because a live combination is a gain. The count carries the
    // information; the colour only reinforces it. The interaction text itself is
    // too long for this column and is stated on the choice screen instead.
    drawStatLine(ctx, y, 'Synergy', String(live), 'live', Palette.good)
  }
}

/**
 * The boss readout.
 *
 * Deliberately in the panel rather than across the top of the playfield, which is
 * where the genre puts it. UI.md rule 1 names its permitted playfield overlays and a
 * boss *health bar* is not among them — it is persistent state, the exact thing the
 * 192-unit column exists to hold. What goes over the playfield is the phase callout,
 * which is an announcement and is named in the rule; and the ring on the boss itself,
 * which is attached to a moving entity like the damage strip every other enemy gets.
 *
 * Layout is a heading, the name on its OWN line or lines, a phase/hp row, and the bar:
 *
 *   BOSS
 *   Unlisted Tenant —
 *   Spore Bed
 *   PHASE 2 / 3              1240 hp
 *   [====|=====|=========]
 *
 * The name owning its line is the fix for a defect a capture caught: sharing the row
 * with the hp readout clipped `The Repossessor` to `THE REPOSSESS…`. The longest
 * authored name is 27 characters and cannot fit 164 units at the 12px floor, so
 * sharing was never going to work — it wraps instead, and never truncates.
 * `tests/render.test.ts` runs the real `src/content/bosses.ts` table through the same
 * wrapping, so a boss added later with a longer name fails there.
 *
 * Authored case, not upper: `The Deep Manifest` is a name, and the panel already
 * reserves uppercase for labels.
 */
const BOSS_HEADING_H = 14
const BOSS_NAME_LINE_H = 15
const BOSS_STAT_H = 15
const BOSS_BAR_H = 9
/** Bar row: the caret's headroom, the bar, and the threshold ticks under it. */
const BOSS_BAR_ROW_H = BAR_CARET_H + BOSS_BAR_H + 5

/** Height this block needs for a given name, so the caller can reserve it. */
function bossBlockHeight(ctx: CanvasRenderingContext2D, name: string): number {
  const lines = bossNameLines(name, CONTENT_W, canvasMeasure(ctx))
  return BOSS_HEADING_H + BOSS_NAME_LINE_H * lines.length + BOSS_STAT_H + BOSS_BAR_ROW_H
}

function drawBossBlock(
  ctx: CanvasRenderingContext2D,
  top: number,
  enemy: EnemyInstance,
): number {
  const boss = enemy.boss
  if (!boss) return top

  const right = CONTENT_X + CONTENT_W
  const phases = Math.max(1, boss.thresholds.length)
  const phaseIndex = Math.max(0, Math.min(phases - 1, boss.phaseIndex))

  drawText(ctx, 'BOSS', CONTENT_X, top, {
    size: 11,
    tracking: 2.2,
    baseline: 'top',
    color: Palette.textFaint,
  })

  let y = top + BOSS_HEADING_H
  for (const line of bossNameLines(boss.name, CONTENT_W, canvasMeasure(ctx))) {
    drawText(ctx, line, CONTENT_X, y, {
      size: BOSS_NAME_SIZE,
      weight: 700,
      baseline: 'top',
      color: Palette.hostileElite,
    })
    y += BOSS_NAME_LINE_H
  }

  drawText(ctx, `PHASE ${phaseIndex + 1} / ${phases}`, CONTENT_X, y, {
    size: 11,
    weight: 600,
    baseline: 'top',
    color: Palette.textDim,
  })
  // Remaining hull, with its unit. A bar answers "how far through"; the number
  // answers "is my damage doing anything", and during a four-minute fight both are
  // questions the player is actually asking. Right-ALIGNED, not merely positioned at
  // the right edge — drawn left-aligned from `right` it ran off the panel, which is
  // now caught by a test that measures a string's width instead of its anchor.
  drawText(ctx, `${Math.max(0, Math.round(enemy.hp))} hp`, right, y, {
    size: 11,
    align: 'right',
    baseline: 'top',
    color: Palette.textDim,
  })
  y += BOSS_STAT_H

  drawBossHealthBar(ctx, {
    x: CONTENT_X,
    y: y + BAR_CARET_H,
    w: CONTENT_W,
    h: BOSS_BAR_H,
    thresholds: boss.thresholds,
    fraction: enemy.maxHp > 0 ? enemy.hp / enemy.maxHp : 0,
    phaseIndex,
  })

  return y + BOSS_BAR_ROW_H
}

export interface PanelState {
  pilotNumber: number
  /**
   * Fallback hull name.
   *
   * The run itself is the source of truth (`WorldView.hullName`) now that a run can be
   * issued different hulls; this is used only when the view has not supplied one.
   */
  hullName: string
  weaponName: string
  /** Shots per second, shown with a unit so it can't be mistaken for a multiplier. */
  fireRate: number
  // No `scrap` field: scrap is read from the run's own stats, so a caller cannot
  // hand the HUD a number that disagrees with the simulation.
  /**
   * IGNORED. The sector readout is sourced from `WorldView.stage`.
   *
   * These two fields are what produced the defect this milestone fixed: the panel read
   * "SECTOR 1 / 5" for the entire game because the app handed it the number of sectors
   * that were *planned* rather than the leg the simulation was actually running. They
   * survive only so the app layer, which also feeds the incident report from them,
   * keeps compiling; nothing in this file reads them and they should be deleted once
   * that caller moves over.
   *
   * @deprecated read `view.stage` instead.
   */
  sector?: number
  /** @deprecated see `sector`. */
  sectorCount?: number
  /** `Settings.reduceFlashes`. Attenuates the hazard warning band's pulse. */
  reduceFlashes?: boolean
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
  // The run names its own hull. `state.hullName` is only a fallback now: with eight
  // hulls the app cannot hold a copy of this without it eventually disagreeing with
  // the ship being flown, which is the same class of bug as the fire-rate readout.
  const hullName = view.hullName || state.hullName
  drawText(ctx, hullName.toUpperCase(), CONTENT_X, y, {
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

  // Weapon, rate and scrap share a line with their labels rather than sitting under
  // them. Each was a two-line group until M5 put a boss and a hazard block in the
  // flexible region below, and 39 units of airiness up here was costing the hazard
  // readout its descriptions during a boss fight — which is a worse trade than a
  // slightly denser stat group. `drawStatLine` measures both halves and falls back to
  // two lines if a long weapon name would ever collide with its label, so the density
  // cannot turn into an overlap.
  y = drawStatLine(ctx, y, 'Weapon', state.weaponName)
  y += BETWEEN_GROUPS
  y = drawStatLine(ctx, y, 'Fire rate', state.fireRate.toFixed(1), 'shots/s')
  y += BETWEEN_GROUPS
  // Scrap comes from the run, not the caller: a currency the HUD could get wrong
  // is a currency the player cannot trust.
  y = drawStatLine(ctx, y, 'Scrap', String(view.stats.scrap), 'cr', Palette.caution)
  y += BEFORE_DIVIDER
  drawDivider(ctx, y)
  y += AFTER_DIVIDER

  // Progress group. Sector and wave sit tight together with no BETWEEN_GROUPS
  // between them, because they answer one question — how far in am I — and
  // proximity is what says so.
  //
  // Sourced from the run, never from a planned count. See PanelState.sector.
  const stage = stageOf(view)
  y = drawStatLine(ctx, y, 'Sector', `${stage.index + 1} / ${stage.count}`)
  // The name is what makes the number mean something: "2 / 3" says how far, "THE
  // TALLY" says where, and a player reading a screenshot needs both.
  drawText(ctx, truncateToWidth(ctx, stage.sectorName, CONTENT_W, 12), CONTENT_X, y, {
    size: 12,
    baseline: 'top',
    color: Palette.textDim,
  })
  y += 15
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

  // The void the comment above reserved, now shared three ways.
  //
  // Drawn after the log's divider is known because the region is bounded by it: the
  // space is whatever is left between the progress group and the fixed block below,
  // and nothing here may grow past it.
  //
  // Priority, when it does not all fit, is threat first: the boss keeps its full
  // block, the hazards drop their descriptions and then their rows, and the build —
  // the only readout here that is about a decision already made — yields last and
  // degrades to a count. A player can check what they are carrying between waves;
  // they cannot check a hazard countdown after it has fired.
  y += BEFORE_DIVIDER
  drawDivider(ctx, y)
  let blockY = y + 12
  const blocksBottom = logDivider - 8

  const boss = bossOf(view)
  // Measured, not a constant: the block is taller when a long boss name wraps, and a
  // fixed reserve would let the hazard block above it claim space the name needs.
  const bossReserve = boss?.boss ? bossBlockHeight(ctx, boss.boss.name) + 10 : 0

  const hazards = hazardsOf(view)
  if (hazards.length > 0) {
    blockY =
      drawHazardBlock(ctx, {
        x: CONTENT_X,
        y: blockY,
        w: CONTENT_W,
        hazards,
        tick: view.stats.tick,
        available: blocksBottom - blockY - bossReserve,
        ...(state.reduceFlashes === undefined ? {} : { reduceFlashes: state.reduceFlashes }),
      }) + 8
  }

  if (boss) blockY = drawBossBlock(ctx, blockY, boss) + 10

  drawHeldBuild(ctx, view, blockY, blocksBottom, state.items)

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
