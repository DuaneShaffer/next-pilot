/**
 * Pause menu.
 *
 * Still the place the accessibility controls live, and deliberately so:
 *
 * 1. Shake and flash reduction are accessibility controls (docs/UI.md rule 10),
 *    and a control a player cannot reach does not exist. Pause is where someone
 *    goes when the game is making them uncomfortable, so it is where the remedy
 *    belongs — not behind a title-screen submenu they would have to quit a run
 *    to reach.
 * 2. It keeps the game at one menu for everything a player needs *during* a run.
 *
 * WHAT CHANGED IN M6. There is now a full settings screen as well
 * (`src/ui/settings.ts`), because key rebinding has to be reachable *before* a
 * sortie — otherwise configuring your controls means launching a permadeath run
 * with the controls you were trying to change — and because seven rebindable
 * actions plus a capture state does not fit on this card. The reasoning is written
 * out in that file's header.
 *
 * The two screens share one source of truth. Every label, hint, adjustment and
 * formatter for a setting that appears in both comes from `src/ui/settings.ts`, so
 * "Screen shake" cannot be described one way here and another way there. This file
 * chooses *which* rows to show and lays them out; it does not author their copy.
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
import { Palette } from '../render/palette'
import { canvasMeasure, drawLabel, drawText, wrapText } from '../render/text'
import {
  SETTING_COPY,
  adjustSettingValue,
  formatSettingDisplay,
  type SharedSettingId,
  type UiSettings,
} from './settings'

export type PauseItemId =
  | 'resume'
  | 'shake'
  | 'flashes'
  | 'volume'
  | 'mute'
  | 'settings'
  | 'abandon'

interface PauseItem {
  id: PauseItemId
  label: string
  /** `action` fires on confirm; the rest adjust with left/right. */
  kind: 'action' | 'scale' | 'toggle'
  /** One-line explanation, shown for the selected row only. */
  hint: string
}

/** Rows whose copy and behaviour are owned by the settings screen. */
function shared(id: SharedSettingId & PauseItemId, kind: 'scale' | 'toggle'): PauseItem {
  return { id, label: SETTING_COPY[id].label, kind, hint: SETTING_COPY[id].hint }
}

export const PAUSE_ITEMS: readonly PauseItem[] = [
  { id: 'resume', label: 'Resume sortie', kind: 'action', hint: 'Return to the run in progress.' },
  shared('shake', 'scale'),
  // `reduceFlashes` is offered here now because the renderer genuinely honours it:
  // `flashScale()` in src/render/intensity.ts attenuates every bright transient,
  // and src/main.ts threads the setting into drawScene and drawPanel. That
  // sequencing was the condition the old note in this file set, and it is met — a
  // row that silently did nothing would tell a photosensitive player they were
  // protected when they were not.
  shared('flashes', 'toggle'),
  shared('volume', 'scale'),
  shared('mute', 'toggle'),
  {
    id: 'settings',
    label: 'All settings',
    kind: 'action',
    hint: 'Opens the full screen, including which keys do what.',
  },
  {
    id: 'abandon',
    label: 'Abandon sortie',
    kind: 'action',
    hint: 'Ends the run. The hull is written off and the pilot is reassigned.',
  },
]

export function movePauseSelection(index: number, delta: number): number {
  const count = PAUSE_ITEMS.length
  // Wrap rather than clamp: a short list is faster to traverse circularly, and
  // hitting an invisible wall reads as an unresponsive menu.
  return (((index + delta) % count) + count) % count
}

function asShared(id: PauseItemId): SharedSettingId | null {
  return id === 'shake' || id === 'flashes' || id === 'volume' || id === 'mute' ? id : null
}

/**
 * Apply a left/right adjustment to the selected setting. Pure.
 *
 * Delegates to the settings screen's reducer so the two screens cannot drift on
 * step size, clamping, or which direction flips a toggle.
 */
export function adjustSetting(
  settings: UiSettings,
  id: PauseItemId,
  delta: number,
): UiSettings {
  const shared = asShared(id)
  return shared === null ? settings : adjustSettingValue(settings, shared, delta)
}

/** Display value for a row. Percentages carry their unit; toggles read as words. */
export function formatSettingValue(
  settings: UiSettings,
  id: PauseItemId,
): { value: string; unit: string } {
  const shared = asShared(id)
  return shared === null ? { value: '', unit: '' } : formatSettingDisplay(settings, shared)
}

export interface PauseMenuState {
  selected: number
  settings: UiSettings
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
/**
 * Grown from 392 for the two rows M6 added (reduce flashes, all settings).
 *
 * Derived rather than nudged until it looked right: PAD*2 + header 94 + rows +
 * rule 21 + two hint lines 30 + footer 18. At seven rows that is 460, and
 * `tests/settings.test.ts` asserts the arithmetic so a row added later without
 * growing the card is a test failure rather than a hint drawn over the footer.
 */
const CARD_H = 460
const CARD_X = (VIRTUAL_W - CARD_W) / 2
const CARD_Y = (VIRTUAL_H - CARD_H) / 2
const PAD = 26
const ROW_H = 34
export const PAUSE_CONTENT_W = CARD_W - PAD * 2
/** The card itself, exported so tests measure containment against the real rect. */
export const PAUSE_CARD = { x: CARD_X, y: CARD_Y, w: CARD_W, h: CARD_H } as const
/** Point size the selected row's hint is drawn at. */
export const PAUSE_HINT_SIZE = 11
/** Point size of the controls footer. */
export const PAUSE_FOOTER_SIZE = 10
/** Point size shared by a row's label and its value. */
export const PAUSE_ROW_TEXT_SIZE = 14
/**
 * The left/right adjust affordance.
 *
 * Both halves of it. A single `'<'` at a fixed x — 150 units from the label, unattached
 * to anything — is what this row used to draw, so `Volume  <  75 %` pointed away from
 * the value it modifies and said LEFT was the only key that did anything.
 *
 * The GUTTER is reserved on every adjustable row whether the arrows are drawn or not,
 * so moving the cursor onto a row does not slide its number sideways. Text that moves
 * when you press a key is text you have to find again.
 */
export const PAUSE_ARROW_SIZE = 12
export const PAUSE_ARROW_GAP = 8
export const PAUSE_ARROW_GUTTER = 14
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

    /**
     * Destructive rows are marked by a danger-coloured RULE, not by danger-coloured
     * text.
     *
     * `Palette.danger` (#FF4A38) measures 3.78:1 against `Palette.panel`, which is
     * below WCAG AA's 4.5:1 for 14px text and therefore a rule 7 violation — the
     * one row on this card a player must not misread was the least legible thing on
     * it. A 2px bar carries the same information at full saturation without being
     * text, and it is a second channel besides colour, which rule 3 asks for
     * anyway. See tests/palette.test.ts for the measurement.
     */
    const isDestructive = item.id === 'abandon'
    if (isDestructive) {
      ctx.fillStyle = Palette.danger
      ctx.fillRect(contentX - 8, rowY - 2, 2, ROW_H - 10)
    }
    drawText(ctx, item.label, contentX, rowY, {
      size: PAUSE_ROW_TEXT_SIZE,
      weight: isSelected || isDestructive ? 600 : 400,
      baseline: 'top',
      color: isSelected || isDestructive ? Palette.text : Palette.textDim,
    })

    const { value, unit } = formatSettingValue(state.settings, item.id)
    if (value) {
      // The gutter is held open on every row that has a value, so the number sits at
      // the same x whether or not the cursor is on it. See PAUSE_ARROW_GUTTER.
      const valueRight = contentRight - PAUSE_ARROW_GUTTER
      const unitWidth = unit
        ? drawText(ctx, unit, valueRight, rowY + 2, {
            size: 11,
            align: 'right',
            baseline: 'top',
            color: Palette.textDim,
          })
        : 0
      const valueX = valueRight - (unit ? unitWidth + 4 : 0)
      const valueWidth = drawText(ctx, value, valueX, rowY, {
        size: PAUSE_ROW_TEXT_SIZE,
        weight: 600,
        align: 'right',
        baseline: 'top',
        color: isSelected ? Palette.self : Palette.text,
      })
      // Arrows only on the selected adjustable row, so the affordance appears
      // exactly where it applies instead of decorating every line — but BOTH of them,
      // bracketing the value, because left and right both do something on every one of
      // these rows. Positioned from the value's measured extent rather than at a fixed
      // x, so they stay attached to the thing they modify however wide it reads.
      if (isSelected && item.kind !== 'action') {
        drawText(ctx, '<', valueX - valueWidth - PAUSE_ARROW_GAP, rowY, {
          size: PAUSE_ARROW_SIZE,
          align: 'right',
          baseline: 'top',
          color: Palette.textFaint,
        })
        drawText(ctx, '>', contentRight, rowY, {
          size: PAUSE_ARROW_SIZE,
          align: 'right',
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
