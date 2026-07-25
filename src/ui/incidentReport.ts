/**
 * The death screen, filed as an incident report.
 *
 * Two things drive the whole design.
 *
 * **UI.md rule 6: death to the next run in two inputs, ideally one.** So this
 * screen has exactly one primary action and no menu tree, no submenus, and
 * nothing to navigate. A roguelike's core loop is "again", and every input
 * between death and the next attempt is friction applied at the precise moment
 * the player is deciding whether to keep playing. The single secondary exit is a
 * faint line, not a menu item.
 *
 * **DESIGN.md's tone: deadpan institutional.** The humour is in the paperwork —
 * the file number, the closing remark, the fact that the company's only stated
 * concern is its hull. It never touches functional text: the cause of loss, the
 * numbers, and the prompt are written to be read at a glance by someone who is
 * annoyed. Clarity wins outright there.
 *
 * Everything shown is derived from `WorldView`; the caller supplies only
 * presentation context it owns (pilot number, hull name, and names for ids this
 * module deliberately does not import content tables to resolve).
 */

import { TICK_HZ } from '../core/loop'
import { formatSeed } from '../core/seed'
import { VIRTUAL_H, VIRTUAL_W } from '../core/space'
import type { DeathCauseKind, WorldView } from '../sim/entities'
import { Palette } from '../render/palette'
import { drawLabel, drawText, drawValue, measureText } from '../render/text'

export interface IncidentReportOptions {
  pilotNumber: number
  hullName: string
  /** Ticks this screen has been up, for the prompt's slow pulse. */
  tick: number
  /**
   * Display name of whatever killed the pilot.
   *
   * Passed in rather than looked up: resolving `incident.causeEnemyId` would
   * couple the death screen to the content tables, and a UI screen that cannot
   * be drawn without the enemy registry loaded is a screen that is hard to test.
   * When omitted, the id itself is formatted into something readable.
   */
  causeName?: string
  sectorName?: string
  sector?: number
  sectorCount?: number
  /** Waves in the sector where the run ended, so depth reads as a fraction. */
  waveCount?: number
  /** Certifications earned by this run. The section is omitted when empty. */
  certifications?: readonly string[]
}

const CARD_X = 48
const CARD_Y = 52
const CARD_W = 544
const CARD_H = 616
const PAD = 26
const CONTENT_X = CARD_X + PAD
const CONTENT_RIGHT = CARD_X + CARD_W - PAD
const CONTENT_W = CARD_W - PAD * 2

/**
 * Group thousands manually rather than with `toLocaleString`.
 *
 * Locale formatting would make the same run render differently on two machines,
 * which breaks screenshot comparison — the project's only visual regression
 * check — for no benefit at these magnitudes.
 */
function groupDigits(value: number): string {
  const whole = Math.abs(Math.round(value))
  const digits = String(whole)
  let out = ''
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ','
    out += digits[i]
  }
  return value < 0 ? `-${out}` : out
}

/** `tally-turret` becomes `Tally Turret`. */
function prettifyId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

/** Duration with both units present, so `3 m 12 s` can't be read as 3.12 of anything. */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return minutes > 0 ? `${minutes} m ${rest} s` : `${rest} s`
}

const CAUSE_TEXT: Record<DeathCauseKind, string> = {
  'enemy-fire': 'Hostile fire',
  collision: 'Collision with hostile hull',
  hazard: 'Environmental hazard',
}

/**
 * Closing remarks. Flavour, and the only place on this screen it is allowed.
 *
 * Selected by the incident's tick so a given death always files the same remark:
 * a line that reshuffles every frame reads as a bug, and one that reshuffles per
 * death makes screenshots non-comparable.
 */
const REMARKS: ReadonlyArray<readonly string[]> = [
  [
    'Hazard pay dispute filed on the pilot’s behalf.',
    'Company liability: none. Case closed pending nothing.',
  ],
  [
    'Hull recovery costs have been deducted from the final balance.',
    'The balance was insufficient. The difference has been waived.',
  ],
  [
    'Performance rated ADEQUATE by the reviewing officer.',
    'The rating does not affect the outcome and cannot be appealed.',
  ],
  [
    'Next of kin notified by standard form letter, second class.',
    'Requisition has been asked to reuse the envelope where possible.',
  ],
  [
    'Salvage recovered from the debris field: 0 units.',
    'The company thanks you and would like the hull back.',
  ],
]

/**
 * The TOTAL LOSS stamp.
 *
 * `danger` for death is one of the colour's sanctioned uses, and this is the
 * screen's one piece of visual comedy: the company's response to losing a pilot
 * is a rubber stamp, applied slightly crooked.
 */
function drawStamp(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  const w = 122
  const h = 52
  ctx.save()
  ctx.translate(cx, cy)
  // Slightly off-square, like it was applied by hand by someone with a quota.
  ctx.rotate(-0.12)
  ctx.strokeStyle = Palette.danger
  ctx.globalAlpha = 0.85
  ctx.lineWidth = 2
  ctx.strokeRect(-w / 2, -h / 2, w, h)
  ctx.lineWidth = 1
  ctx.strokeRect(-w / 2 + 4, -h / 2 + 4, w - 8, h - 8)
  drawText(ctx, 'TOTAL', 0, -4, {
    size: 15,
    weight: 700,
    align: 'center',
    tracking: 2,
    color: Palette.danger,
  })
  drawText(ctx, 'LOSS', 0, 15, {
    size: 15,
    weight: 700,
    align: 'center',
    tracking: 2,
    color: Palette.danger,
  })
  ctx.globalAlpha = 1
  ctx.restore()
}

function drawDivider(ctx: CanvasRenderingContext2D, y: number): void {
  ctx.fillStyle = Palette.line
  ctx.fillRect(CONTENT_X, y, CONTENT_W, 1)
}

/**
 * Row pitch for the body list.
 *
 * Tuned down from 26 so that eight rows plus a three-line certifications section
 * still leave clear air above the prompt. The card is a fixed height and the
 * prompt is anchored to it, so the body's pitch is what has to give.
 */
const ENTRY_H = 24

/**
 * One row of the report body: label left, value right-aligned.
 *
 * Same-line pairing removes any ambiguity about which label owns which value,
 * and this card is 492 units wide, so unlike the instrument panel there is no
 * collision risk worth designing around. Every value still carries its unit.
 */
function drawEntry(
  ctx: CanvasRenderingContext2D,
  top: number,
  label: string,
  value: string,
  unit = '',
  valueColor: string = Palette.text,
): number {
  drawLabel(ctx, label, CONTENT_X, top + 2, { baseline: 'top' })
  const valueWidth = measureText(ctx, value, { size: 14, weight: 600 })
  const unitWidth = unit ? measureText(ctx, unit, { size: 12 }) : 0
  const total = valueWidth + (unit ? 4 + unitWidth : 0)
  drawValue(ctx, value, unit, CONTENT_RIGHT - total, top, {
    size: 14,
    baseline: 'top',
    color: valueColor,
  })
  return top + ENTRY_H
}

export function drawIncidentReport(
  ctx: CanvasRenderingContext2D,
  view: WorldView,
  opts: IncidentReportOptions,
): void {
  const incident = view.incident
  const stats = view.stats

  // A near-opaque scrim rather than a fill: the wreck of the last frame stays
  // faintly visible behind the paperwork, which is both where the player was
  // looking and a reminder of what the report is about.
  ctx.fillStyle = 'rgba(5, 7, 11, 0.965)'
  ctx.fillRect(0, 0, VIRTUAL_W, VIRTUAL_H)

  ctx.fillStyle = Palette.panel
  ctx.fillRect(CARD_X, CARD_Y, CARD_W, CARD_H)
  ctx.strokeStyle = Palette.line
  ctx.lineWidth = 1
  ctx.strokeRect(CARD_X + 0.5, CARD_Y + 0.5, CARD_W - 1, CARD_H - 1)

  // Severity bar. `danger` for death is one of its sanctioned uses, and it is a
  // static bar, not a flash — rule 10.
  ctx.fillStyle = Palette.danger
  ctx.fillRect(CARD_X, CARD_Y, CARD_W, 3)

  // Header band.
  const headerTop = CARD_Y + 3
  const headerH = 30
  ctx.fillStyle = Palette.panelRaised
  ctx.fillRect(CARD_X, headerTop, CARD_W, headerH)
  ctx.fillStyle = Palette.line
  ctx.fillRect(CARD_X, headerTop + headerH, CARD_W, 1)

  const pilotTag = String(opts.pilotNumber).padStart(3, '0')
  drawText(ctx, 'Salvage Division // Incident Report', CONTENT_X, headerTop + 10, {
    size: 11,
    tracking: 2,
    baseline: 'top',
    color: Palette.textDim,
  })
  drawText(
    ctx,
    `FILE ${pilotTag}-${formatSeed(view.seed).slice(0, 4)}`,
    CONTENT_RIGHT,
    headerTop + 10,
    { size: 11, align: 'right', tracking: 1, baseline: 'top', color: Palette.textFaint },
  )

  // Verdict. The stamp sits to the right of the title; the title is sized so the
  // two cannot meet even with the stamp's rotation widening its footprint.
  drawText(ctx, 'HULL LOSS CONFIRMED', CONTENT_X, 100, {
    size: 24,
    weight: 700,
    tracking: 3,
    baseline: 'top',
    color: Palette.text,
  })
  drawStamp(ctx, 494, 128)

  // Kept short on purpose: this line shares its band with the stamp, and the
  // longest hull name in DESIGN.md ("Collateral") plus a third clause would run
  // straight into it. "Not recovered" would be redundant anyway — the stamp
  // already says TOTAL LOSS.
  drawText(ctx, `Pilot #${pilotTag}  ·  hull ${opts.hullName.toUpperCase()}`, CONTENT_X, 136, {
    size: 13,
    tracking: 0.5,
    baseline: 'top',
    color: Palette.textDim,
  })

  drawDivider(ctx, 170)

  // Cause of loss: the one thing the player actually came to this screen for, so
  // it gets its own block and the largest type in the body.
  const causeKind: DeathCauseKind = incident?.causeKind ?? 'hazard'
  const causeId = incident?.causeEnemyId ?? null
  const causeName = opts.causeName ?? (causeId ? prettifyId(causeId) : null)
  const causeLine = causeName ? `${CAUSE_TEXT[causeKind]} — ${causeName}` : CAUSE_TEXT[causeKind]

  drawLabel(ctx, 'Cause of loss', CONTENT_X, 186, { baseline: 'top' })
  drawText(ctx, incident ? causeLine : 'Unattributed', CONTENT_X, 204, {
    size: 17,
    weight: 600,
    baseline: 'top',
    color: Palette.danger,
  })
  const tickOfLoss = incident?.tick ?? stats.tick
  drawText(
    ctx,
    opts.sectorName
      ? `Logged at tick ${groupDigits(tickOfLoss)} in ${opts.sectorName}.`
      : `Logged at tick ${groupDigits(tickOfLoss)}.`,
    CONTENT_X,
    228,
    { size: 12, baseline: 'top', color: Palette.textFaint },
  )

  drawDivider(ctx, 256)

  // Body. Every row is a label and a value with a unit — no bare numbers, per
  // rule 2 — and the seed is here as well as in the panel, per rule 8, so a
  // screenshot of this screen is a reproducible bug report on its own.
  let y = 272
  if (opts.sector !== undefined && opts.sectorCount !== undefined) {
    y = drawEntry(ctx, y, 'Sector reached', `${opts.sector} / ${opts.sectorCount}`, 'sectors')
  } else if (opts.sectorName) {
    y = drawEntry(ctx, y, 'Sector reached', opts.sectorName)
  }

  const waveIndex = incident?.waveIndex ?? stats.waveIndex
  const waveCount = opts.waveCount ?? 0
  y = drawEntry(
    ctx,
    y,
    'Wave reached',
    waveCount > 0 ? `${waveIndex} / ${waveCount}` : String(waveIndex),
    waveCount > 0 ? 'waves' : 'waves released',
  )

  const seconds = incident?.secondsSurvived ?? stats.tick / TICK_HZ
  y = drawEntry(ctx, y, 'Time logged', formatDuration(seconds))
  y = drawEntry(ctx, y, 'Kills', groupDigits(incident?.kills ?? stats.kills), 'confirmed')
  y = drawEntry(
    ctx,
    y,
    'Scrap recovered',
    groupDigits(incident?.scrap ?? stats.scrap),
    'cr',
    Palette.caution,
  )

  const accuracy =
    stats.shotsFired > 0 ? `${Math.round((stats.hits / stats.shotsFired) * 100)}` : '—'
  y = drawEntry(ctx, y, 'Accuracy', accuracy, stats.shotsFired > 0 ? '%' : '')
  // Label and unit must both agree with the *order* of the numbers. An earlier
  // version read "ROUNDS FIRED  240 / 1,486 hits", which attached the label to the
  // hit count and the unit to the shot count — a reader would take 240 as rounds
  // fired and 1,486 as hits, i.e. exactly backwards. See docs/UI.md rule 2.
  y = drawEntry(
    ctx,
    y,
    'Rounds on target',
    `${groupDigits(stats.hits)} / ${groupDigits(stats.shotsFired)}`,
    'fired',
    Palette.textDim,
  )
  y = drawEntry(ctx, y, 'Seed', formatSeed(view.seed), '', Palette.self)

  // The one primary action. Boxed, pulsed at the title screen's ~0.6Hz so it
  // draws the eye without blinking, and labelled with the key that does it.
  const promptW = 340
  const promptH = 42
  const promptX = CARD_X + (CARD_W - promptW) / 2
  const promptY = 574

  // Only three certifications are listed, with an overflow line if there are
  // more. The card is a fixed size, and a section that can grow without bound
  // would eventually push the primary action off it — the one element on this
  // screen that must never move.
  const certifications = opts.certifications ?? []
  const CERT_SLOTS = 3
  if (certifications.length > 0) {
    drawDivider(ctx, y + 4)
    y += 18
    drawLabel(ctx, 'Certifications granted', CONTENT_X, y, { baseline: 'top' })
    y += 18
    const listed = certifications.length > CERT_SLOTS ? CERT_SLOTS - 1 : certifications.length
    for (let i = 0; i < listed; i++) {
      drawText(ctx, `+ ${certifications[i] ?? ''}`, CONTENT_X, y, {
        size: 13,
        baseline: 'top',
        color: Palette.good,
      })
      y += 17
    }
    if (certifications.length > CERT_SLOTS) {
      drawText(ctx, `+ ${certifications.length - listed} more filed`, CONTENT_X, y, {
        size: 13,
        baseline: 'top',
        color: Palette.textDim,
      })
      y += 17
    }
  }

  // Closing remark: flavour, visually subordinate, and omittable without losing
  // any information — the same rule item text follows. Dropped entirely when the
  // body ran long, because a joke is the first thing that should give way.
  const remark = REMARKS[tickOfLoss % REMARKS.length] ?? []
  let remarkY = Math.max(494, y + 10)
  if (remarkY + remark.length * 17 <= promptY - 10) {
    for (const line of remark) {
      drawText(ctx, line, CONTENT_X, remarkY, {
        size: 12,
        baseline: 'top',
        color: Palette.textFaint,
      })
      remarkY += 17
    }
  }
  const pulse = 0.62 + 0.38 * Math.sin(opts.tick * 0.065)

  ctx.fillStyle = Palette.panelRaised
  ctx.fillRect(promptX, promptY, promptW, promptH)
  ctx.globalAlpha = pulse
  ctx.strokeStyle = Palette.caution
  ctx.lineWidth = 1.5
  ctx.strokeRect(promptX + 0.5, promptY + 0.5, promptW - 1, promptH - 1)
  drawText(ctx, 'PRESS ENTER — DEPLOY NEXT PILOT', promptX + promptW / 2, promptY + promptH / 2, {
    size: 15,
    weight: 600,
    align: 'center',
    baseline: 'middle',
    tracking: 1,
    color: Palette.caution,
  })
  ctx.globalAlpha = 1

  drawText(ctx, 'ESC returns to the title screen', VIRTUAL_W / 2, promptY + promptH + 16, {
    size: 12,
    align: 'center',
    tracking: 0.5,
    baseline: 'top',
    color: Palette.textFaint,
  })
}
