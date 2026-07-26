/**
 * Pause menu.
 *
 * Also the settings screen, deliberately. Two reasons:
 *
 * 1. Shake and flash reduction are accessibility controls (docs/UI.md rule 10),
 *    and a control a player cannot reach does not exist. Pause is where someone
 *    goes when the game is making them uncomfortable, so it is where the remedy
 *    belongs — not behind a title-screen submenu they would have to quit a run
 *    to reach.
 * 2. It keeps the game at one menu. Rule 6's spirit is that navigation is not
 *    content; a settings tree would be a second thing to learn.
 *
 * Pause is an APP-LAYER concept, not simulation state. While paused the loop
 * simply does not advance the sim, so no ticks happen and nothing is recorded.
 * A replay of a paused run is byte-identical to one played straight through,
 * which is why pause needs no representation in the sim and cannot desynchronise
 * a fixture.
 *
 * The layout logic here is pure and unit-tested; only `drawPauseMenu` touches a
 * canvas.
 */

import { formatSeed } from '../core/seed'
import { VIRTUAL_H, VIRTUAL_W } from '../core/space'
import type { Settings } from '../meta/save'
import { Palette } from '../render/palette'
import { canvasMeasure, drawLabel, drawText, wrapText } from '../render/text'

export type PauseItemId = 'resume' | 'shake' | 'volume' | 'mute' | 'abandon'

interface PauseItem {
  id: PauseItemId
  label: string
  /** `action` fires on confirm; the rest adjust with left/right. */
  kind: 'action' | 'scale' | 'toggle'
  /** One-line explanation, shown for the selected row only. */
  hint: string
}

export const PAUSE_ITEMS: readonly PauseItem[] = [
  { id: 'resume', label: 'Resume sortie', kind: 'action', hint: 'Return to the run in progress.' },
  {
    id: 'shake',
    label: 'Screen shake',
    kind: 'scale',
    hint: 'Impact camera movement. Set to 0% to disable entirely.',
  },
  // NOTE: `Settings.reduceFlashes` exists in the save schema but is deliberately
  // NOT offered here yet, because the renderer does not consume it — the scene
  // takes a shake multiplier and no flash scale. A menu row that silently does
  // nothing is worse than a missing one: it tells a photosensitive player they
  // have been protected when they have not. Add the row in the same change that
  // makes the renderer honour it.
  { id: 'volume', label: 'Volume', kind: 'scale', hint: 'Master output level.' },
  { id: 'mute', label: 'Mute', kind: 'toggle', hint: 'Silences all audio.' },
  {
    id: 'abandon',
    label: 'Abandon sortie',
    kind: 'action',
    hint: 'Ends the run. The hull is written off and the pilot is reassigned.',
  },
]

/** Step size for scale settings. Five stops is enough granularity to be useful. */
const SCALE_STEP = 0.25

export function movePauseSelection(index: number, delta: number): number {
  const count = PAUSE_ITEMS.length
  // Wrap rather than clamp: a six-item list is faster to traverse circularly, and
  // hitting an invisible wall reads as an unresponsive menu.
  return (((index + delta) % count) + count) % count
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/** Apply a left/right adjustment to the selected setting. Pure. */
export function adjustSetting(settings: Settings, id: PauseItemId, delta: number): Settings {
  switch (id) {
    case 'shake':
      return { ...settings, shake: clamp01(settings.shake + delta * SCALE_STEP) }
    case 'volume':
      return { ...settings, masterVolume: clamp01(settings.masterVolume + delta * SCALE_STEP) }
    case 'mute':
      // Toggles ignore direction: any horizontal press flips them, which is what
      // players actually expect from a two-state row.
      return delta === 0 ? settings : { ...settings, muted: !settings.muted }
    default:
      return settings
  }
}

/** Display value for a row. Percentages carry their unit; toggles read as words. */
export function formatSettingValue(
  settings: Settings,
  id: PauseItemId,
): { value: string; unit: string } {
  switch (id) {
    case 'shake':
      // "Off" rather than "0 %", because 0% of a camera effect is a state, not a
      // quantity — and a player scanning for "off" should find that word.
      return settings.shake === 0
        ? { value: 'Off', unit: '' }
        : { value: String(Math.round(settings.shake * 100)), unit: '%' }
    case 'volume':
      return settings.muted
        ? { value: 'Muted', unit: '' }
        : { value: String(Math.round(settings.masterVolume * 100)), unit: '%' }
    case 'mute':
      return { value: settings.muted ? 'On' : 'Off', unit: '' }
    default:
      return { value: '', unit: '' }
  }
}

export interface PauseMenuState {
  selected: number
  settings: Settings
  /** Ticks the menu has been open, for the selection pulse. */
  tick: number
  /** Shown as context so pausing does not hide the run's state. */
  waveIndex: number
  waveCount: number
  seed: string
}

/**
 * Widths and paddings.
 *
 * CONTENT_W is exported so tests can assert that every authored string on this card
 * fits inside it. The longest hint used to overflow the card because it was drawn as
 * one unmeasured line, and nothing checked.
 */
const CARD_W = 420
const CARD_H = 392
const CARD_X = (VIRTUAL_W - CARD_W) / 2
const CARD_Y = (VIRTUAL_H - CARD_H) / 2
const PAD = 26
const ROW_H = 34
export const PAUSE_CONTENT_W = CARD_W - PAD * 2
/** Point size the selected row's hint is drawn at. */
export const PAUSE_HINT_SIZE = 11
/** Point size of the controls footer. */
export const PAUSE_FOOTER_SIZE = 10
export const PAUSE_FOOTER_TEXT = 'Arrows adjust · ENTER confirm · ESC resume'

export function drawPauseMenu(ctx: CanvasRenderingContext2D, state: PauseMenuState): void {
  // Heavier scrim than the incident report uses: a paused playfield showing
  // through is a legibility problem rather than atmosphere, because the menu is
  // something you read and act on rather than a summary you absorb.
  ctx.fillStyle = 'rgba(5, 7, 11, 0.9)'
  ctx.fillRect(0, 0, VIRTUAL_W, VIRTUAL_H)

  ctx.fillStyle = Palette.panel
  ctx.fillRect(CARD_X, CARD_Y, CARD_W, CARD_H)
  ctx.strokeStyle = Palette.line
  ctx.lineWidth = 1
  ctx.strokeRect(CARD_X + 0.5, CARD_Y + 0.5, CARD_W - 1, CARD_H - 1)

  // A caution rule, not danger: being paused is not a threat.
  ctx.fillStyle = Palette.caution
  ctx.fillRect(CARD_X, CARD_Y, CARD_W, 2)

  const contentX = CARD_X + PAD
  const contentRight = CARD_X + CARD_W - PAD
  let y = CARD_Y + PAD

  drawLabel(ctx, 'Salvage Division // Operations Hold', contentX, y, { baseline: 'top' })
  y += 22
  drawText(ctx, 'SORTIE PAUSED', contentX, y, {
    size: 26,
    weight: 700,
    tracking: 2,
    baseline: 'top',
    color: Palette.text,
  })
  y += 34
  const context = `Wave ${state.waveIndex} of ${state.waveCount} · seed ${formatSeed(state.seed)}`
  drawText(ctx, context, contentX, y, {
    size: 12,
    baseline: 'top',
    color: Palette.textDim,
  })
  y += 26

  ctx.fillStyle = Palette.line
  ctx.fillRect(contentX, y, contentRight - contentX, 1)
  y += 14

  PAUSE_ITEMS.forEach((item, index) => {
    const isSelected = index === state.selected
    const rowY = y + index * ROW_H

    if (isSelected) {
      // A slow pulse that never reaches zero — rule 10 applies to menus too.
      const pulse = 0.16 + 0.08 * Math.sin(state.tick * 0.09)
      ctx.fillStyle = `rgba(92, 224, 240, ${pulse.toFixed(3)})`
      ctx.fillRect(contentX - 10, rowY - 5, contentRight - contentX + 20, ROW_H - 6)
      // A caret as well as a highlight: selection must not rely on colour alone.
      drawText(ctx, '>', contentX - 18, rowY, {
        size: 14,
        weight: 700,
        baseline: 'top',
        color: Palette.self,
      })
    }

    const isDestructive = item.id === 'abandon'
    drawText(ctx, item.label, contentX, rowY, {
      size: 14,
      weight: isSelected ? 600 : 400,
      baseline: 'top',
      color: isDestructive ? Palette.danger : isSelected ? Palette.text : Palette.textDim,
    })

    const { value, unit } = formatSettingValue(state.settings, item.id)
    if (value) {
      const unitWidth = unit
        ? drawText(ctx, unit, contentRight, rowY + 2, {
            size: 11,
            align: 'right',
            baseline: 'top',
            color: Palette.textDim,
          })
        : 0
      drawText(ctx, value, contentRight - (unit ? unitWidth + 4 : 0), rowY, {
        size: 14,
        weight: 600,
        align: 'right',
        baseline: 'top',
        color: isSelected ? Palette.self : Palette.text,
      })
      // Arrows only on the selected adjustable row, so the affordance appears
      // exactly where it applies instead of decorating every line.
      if (isSelected && item.kind !== 'action') {
        drawText(ctx, '<', contentX + 150, rowY, {
          size: 12,
          baseline: 'top',
          color: Palette.textFaint,
        })
      }
    }
  })

  y += PAUSE_ITEMS.length * ROW_H + 8
  ctx.fillStyle = Palette.line
  ctx.fillRect(contentX, y, contentRight - contentX, 1)
  y += 12

  const selected = PAUSE_ITEMS[state.selected]
  if (selected) {
    // WRAPPED, not drawn as one line. The "Abandon sortie" hint is 66 characters and
    // ran past the card's right edge, because a single drawText call cannot know how
    // wide its string is. Any string a designer can lengthen has to be measured.
    const lines = wrapText(
      selected.hint,
      PAUSE_CONTENT_W,
      PAUSE_HINT_SIZE,
      canvasMeasure(ctx),
    )
    lines.forEach((line, index) => {
      drawText(ctx, line, contentX, y + index * (PAUSE_HINT_SIZE + 4), {
        size: PAUSE_HINT_SIZE,
        baseline: 'top',
        color: Palette.textDim,
      })
    })
  }

  // Shortened and stepped down a size: the long form reached both card edges with
  // no breathing room, which reads as text that has overflowed rather than as a
  // caption.
  drawText(ctx, PAUSE_FOOTER_TEXT, CARD_X + CARD_W / 2, CARD_Y + CARD_H - PAD + 4, {
    size: PAUSE_FOOTER_SIZE,
    align: 'center',
    baseline: 'top',
    color: Palette.textFaint,
  })
}
