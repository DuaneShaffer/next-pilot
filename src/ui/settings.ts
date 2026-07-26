/**
 * The settings screen.
 *
 * THE VERDICT ON WHETHER THIS SHOULD EXIST, since the pause menu's header argues
 * the opposite and that argument is still right as far as it goes.
 *
 * Pause keeps its accessibility rows. A photosensitive or motion-sensitive player
 * reaches for pause *because* the game is hurting them, and making them travel two
 * screens for the remedy is the failure that comment describes. Shake, flashes,
 * volume and mute stay exactly where they were, one keypress deep.
 *
 * But settings now need a screen of their own as well, for two reasons the M2
 * argument could not have anticipated:
 *
 *   1. **Controls must be reachable before a run.** Pause only exists inside a
 *      sortie, so "change my keys" would have meant launching a permadeath run in
 *      order to configure the keys you are about to fly it with. The first thing a
 *      new player wants is to know what the controls are.
 *   2. **It no longer fits.** Seven rebindable actions plus a capture state plus
 *      restore-defaults is fourteen rows. The pause card holds five comfortably,
 *      and a fourteen-row pause menu is not "one menu to learn", it is a menu tree
 *      with the tree hidden.
 *
 * So: both, with **one source of truth**. `SETTING_COPY`, `adjustSettingValue` and
 * `formatSettingDisplay` live here and the pause menu imports them, so the label
 * and the plain-language explanation of "Screen shake" are the same string in both
 * places by construction rather than by discipline. Two screens that describe the
 * same setting differently is the bug this arrangement makes unrepresentable.
 *
 * UI.md rule 4 applies to settings text exactly as it does to items: every row says
 * what it *does*, in a sentence, with the mechanism first. "Reduce flashes" is a
 * label; "Dims bright impact flares and explosion cores" is what a player needs.
 *
 * The layout and reducer here are pure and unit-tested; only `drawSettingsScreen`
 * touches a canvas.
 */

import {
  MENU_FLOOR,
  SORTIE_ACTIONS,
  type Bindings,
  type SortieAction,
} from '../core/input'
import { VIRTUAL_H, VIRTUAL_W } from '../core/space'
import {
  assignBinding,
  checkBindings,
  clearBinding,
  defaultBindings,
  describeBinding,
  describeCode,
  explainRejection,
  replaceBinding,
} from '../meta/keybinds'
import type { Settings } from '../meta/save'
import { Palette } from '../render/palette'
import { canvasMeasure, drawLabel, drawText, wrapText } from '../render/text'

/**
 * Alias for `Settings`, kept as a name rather than deleted.
 *
 * It was an intersection widening `Settings` with an optional `autoFire`, so this
 * screen could ship before save.ts had the field — a settings screen that cannot
 * compile until another file lands is a settings screen that blocks. `autoFire` is
 * now required in save schema v4, so the widening is gone and the alias is only here
 * to keep both screens naming one type.
 */
export type UiSettings = Settings

/** Settings rows that both screens can show. Keyed so neither can drift. */
export type SharedSettingId = 'shake' | 'flashes' | 'volume' | 'mute' | 'autofire'

interface Copy {
  label: string
  /** One sentence. What it does, mechanism first. Never flavour. */
  hint: string
}

/**
 * The single definition of every shared setting's on-screen text.
 *
 * Hints are measured against both screens' content widths by
 * `tests/settings.test.ts`, so lengthening one is a test failure rather than a
 * string that quietly runs off a card — the bug `tests/textFits.test.ts` exists for.
 */
export const SETTING_COPY: Readonly<Record<SharedSettingId, Copy>> = {
  shake: {
    label: 'Screen shake',
    hint: 'How far the view kicks on impact. Set to 0% to hold the camera still.',
  },
  flashes: {
    label: 'Reduce flashes',
    hint: 'Dims impact flares and explosion cores to a third. Nothing is hidden.',
  },
  volume: { label: 'Volume', hint: 'Master output level for every sound.' },
  mute: { label: 'Mute', hint: 'Silences all audio without changing the volume.' },
  autofire: {
    label: 'Auto-fire',
    hint: 'Holds the trigger for you during a sortie. Never while a card is open.',
  },
}

/** Step size for scale settings. Five stops is enough granularity to be useful. */
export const SCALE_STEP = 0.25

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/**
 * Apply a left/right adjustment to one shared setting. Pure.
 *
 * Toggles ignore direction: any horizontal press flips them, which is what players
 * expect from a two-state row.
 */
export function adjustSettingValue(
  settings: UiSettings,
  id: SharedSettingId,
  delta: number,
): UiSettings {
  switch (id) {
    case 'shake': {
      // Returning the SAME reference when the value did not move is load-bearing:
      // it is how the caller knows there is nothing to persist, and pressing left
      // at 0% should not write to localStorage sixty times a second.
      const shake = clamp01(settings.shake + delta * SCALE_STEP)
      return shake === settings.shake ? settings : { ...settings, shake }
    }
    case 'volume': {
      const masterVolume = clamp01(settings.masterVolume + delta * SCALE_STEP)
      return masterVolume === settings.masterVolume ? settings : { ...settings, masterVolume }
    }
    case 'mute':
      return delta === 0 ? settings : { ...settings, muted: !settings.muted }
    case 'flashes':
      return delta === 0 ? settings : { ...settings, reduceFlashes: !settings.reduceFlashes }
    case 'autofire':
      return delta === 0 ? settings : { ...settings, autoFire: settings.autoFire !== true }
  }
}

/**
 * Display value for a shared setting. Percentages carry their unit; toggles read as
 * words, because 0% of a camera effect is a state rather than a quantity and a
 * player scanning for "off" should find that word.
 *
 * WHY A MUTED VOLUME STILL SHOWS ITS NUMBER. The row used to read just 'Muted', while
 * `adjustSettingValue` went on writing `masterVolume` on every left/right press — so
 * the press changed the setting, marked the state dirty and reached localStorage while
 * nothing on screen moved. Three remedies were available and this is the one that
 * survives being wrong:
 *
 *   - *Refuse the adjustment.* Honest, but the row still does not move, so the player
 *     learns nothing except that two keys are dead. The settings screen could put an
 *     explanation in its notice line; the pause card has no notice line, so the
 *     feedback would exist on one screen and not the other — the exact divergence
 *     these shared functions exist to make impossible.
 *   - *Unmute on adjust.* Pressing LEFT — "quieter" — would turn the sound back ON,
 *     and it contradicts the Mute row's own promise to silence audio "without changing
 *     the volume". Un-silencing a game by surprise is a bad failure for the player who
 *     reached for Mute in the first place.
 *   - *Show the level beside the mute marker.* The change becomes visible, the state
 *     stays stated, the pre-set-while-silent gesture keeps working, and the feedback
 *     lives in this one formatter — so both screens get it by construction rather than
 *     by discipline.
 *
 * 'Muted' stays first and in the bright half because silence is the headline; the level
 * follows with its unit, per rule 2, so the number a keypress moves is on screen.
 */
export function formatSettingDisplay(
  settings: UiSettings,
  id: SharedSettingId,
): { value: string; unit: string } {
  switch (id) {
    case 'shake':
      return settings.shake === 0
        ? { value: 'Off', unit: '' }
        : { value: String(Math.round(settings.shake * 100)), unit: '%' }
    case 'volume': {
      const level = String(Math.round(settings.masterVolume * 100))
      return settings.muted
        ? { value: `Muted at ${level}`, unit: '%' }
        : { value: level, unit: '%' }
    }
    case 'mute':
      return { value: settings.muted ? 'On' : 'Off', unit: '' }
    case 'flashes':
      return { value: settings.reduceFlashes ? 'On' : 'Off', unit: '' }
    case 'autofire':
      return { value: settings.autoFire === true ? 'On' : 'Off', unit: '' }
  }
}

// --- rows --------------------------------------------------------------------

export type SettingsRowId =
  | SharedSettingId
  | `bind:${SortieAction}`
  | 'restore-keys'
  | 'back'

export interface SettingsRow {
  id: SettingsRowId
  label: string
  kind: 'scale' | 'toggle' | 'binding' | 'action'
  hint: string
  /** Group heading drawn above this row, when it starts a group. */
  group?: string
  /** Present exactly on binding rows. */
  bind?: SortieAction
}

/** What each rebindable action does, in the player's words rather than the code's. */
const ACTION_COPY: Readonly<Record<SortieAction, Copy>> = {
  left: { label: 'Move left', hint: 'Steers the hull left.' },
  right: { label: 'Move right', hint: 'Steers the hull right.' },
  up: { label: 'Move up', hint: 'Steers the hull toward the top of the field.' },
  down: { label: 'Move down', hint: 'Steers the hull toward the bottom of the field.' },
  fire: { label: 'Fire', hint: 'Fires the primary weapon while held.' },
  special: { label: 'Special', hint: 'Uses the hull special, and declines a reward card.' },
  focus: { label: 'Focus', hint: 'Halves your speed while held, for threading dense fire.' },
}

/** Appended to every binding row's hint, so the controls are stated on the row. */
const BIND_HOWTO = 'ENTER sets a key, RIGHT adds a spare, LEFT drops one.'

function bindingRow(action: SortieAction, group?: string): SettingsRow {
  const copy = ACTION_COPY[action]
  return {
    id: `bind:${action}`,
    label: copy.label,
    kind: 'binding',
    hint: `${copy.hint} ${BIND_HOWTO}`,
    bind: action,
    ...(group ? { group } : {}),
  }
}

function sharedRow(
  id: SharedSettingId,
  kind: 'scale' | 'toggle',
  group?: string,
): SettingsRow {
  const copy = SETTING_COPY[id]
  return { id, label: copy.label, kind, hint: copy.hint, ...(group ? { group } : {}) }
}

export const SETTINGS_ROWS: readonly SettingsRow[] = [
  sharedRow('shake', 'scale', 'Motion and light'),
  sharedRow('flashes', 'toggle'),
  sharedRow('volume', 'scale', 'Audio'),
  sharedRow('mute', 'toggle'),
  sharedRow('autofire', 'toggle', 'Controls'),
  ...SORTIE_ACTIONS.map((action) => bindingRow(action)),
  {
    id: 'restore-keys',
    label: 'Restore default keys',
    kind: 'action',
    hint: 'Puts every control back to the keys the game shipped with.',
  },
  {
    id: 'back',
    label: 'Back',
    kind: 'action',
    hint: 'Returns to where you came from. Every change here is already saved.',
  },
]

export function moveSettingsSelection(index: number, delta: number): number {
  const count = SETTINGS_ROWS.length
  return (((index + delta) % count) + count) % count
}

// --- state -------------------------------------------------------------------

/** How long a notice stays up. Four seconds: long enough to read, short enough to go. */
export const NOTICE_TICKS = 240

export interface SettingsState {
  readonly selected: number
  readonly settings: UiSettings
  readonly bindings: Bindings
  /** The action awaiting a keypress, or null. While set, raw codes are routed in. */
  readonly capturing: SortieAction | null
  /**
   * Whether the open capture adds a spare key or replaces the whole list.
   *
   * Carried on the state rather than in two capture entry points, because two
   * entry points is two ways to leave a capture open.
   */
  readonly captureAdditive: boolean
  /** One line of feedback under the list. Plain language, never a raw code. */
  readonly notice: string | null
  readonly noticeTicks: number
  readonly tick: number
  /** Set once the player asks to leave. The app reads it and clears the screen. */
  readonly exit: boolean
  /** Something worth persisting changed. The app clears it with `markSaved`. */
  readonly dirty: boolean
}

export function createSettingsState(
  settings: UiSettings,
  bindings: Bindings,
): SettingsState {
  return {
    selected: 0,
    settings,
    bindings,
    capturing: null,
    captureAdditive: false,
    notice: null,
    noticeTicks: 0,
    tick: 0,
    exit: false,
    dirty: false,
  }
}

export function markSaved(state: SettingsState): SettingsState {
  return state.dirty ? { ...state, dirty: false } : state
}

export type SettingsEvent =
  | { kind: 'move'; delta: number }
  | { kind: 'adjust'; delta: number }
  | { kind: 'confirm' }
  | { kind: 'cancel' }
  /** A raw `event.code`, delivered only while `capturing` is set. */
  | { kind: 'code'; code: string }
  | { kind: 'tick' }

function withNotice(state: SettingsState, notice: string | null): SettingsState {
  return { ...state, notice, noticeTicks: notice === null ? 0 : NOTICE_TICKS }
}

function captureNotice(action: SortieAction): string {
  return `Press a key for ${ACTION_COPY[action].label}. Esc cancels.`
}

/**
 * The whole screen as one pure function.
 *
 * Capture is a *state* rather than a callback so it is testable without a keyboard
 * and, more importantly, so it cannot be left half-open: there is exactly one field
 * that says whether a key is being captured, and every event either sets it or
 * clears it.
 */
export function settingsReduce(state: SettingsState, event: SettingsEvent): SettingsState {
  if (event.kind === 'tick') {
    const ticks = state.noticeTicks > 0 ? state.noticeTicks - 1 : 0
    return { ...state, tick: state.tick + 1, noticeTicks: ticks, notice: ticks > 0 ? state.notice : null }
  }

  // While capturing, ONLY a raw code (or a cancel) can be acted on. Navigation is
  // ignored rather than queued: the player is being asked for one key, and moving
  // the cursor underneath the prompt would rebind a row they can no longer see.
  if (state.capturing !== null) {
    if (event.kind === 'code') return applyCapturedCode(state, state.capturing, event.code)
    if (event.kind === 'cancel') {
      return withNotice({ ...state, capturing: null, captureAdditive: false }, 'Nothing was changed.')
    }
    return state
  }

  const row = SETTINGS_ROWS[state.selected]
  if (!row) return state

  switch (event.kind) {
    case 'move':
      return { ...state, selected: moveSettingsSelection(state.selected, event.delta) }

    case 'adjust':
      return adjustRow(state, row, event.delta)

    case 'confirm':
      if (row.kind === 'binding' && row.bind) {
        return withNotice(
          { ...state, capturing: row.bind, captureAdditive: false },
          captureNotice(row.bind),
        )
      }
      if (row.id === 'restore-keys') {
        return withNotice(
          { ...state, bindings: defaultBindings(), dirty: true },
          'Every control is back to its shipped keys.',
        )
      }
      if (row.id === 'back') return { ...state, exit: true }
      // A toggle confirms as a flip, so ENTER does the obvious thing on every row.
      if (row.kind === 'toggle') return adjustRow(state, row, 1)
      return state

    case 'cancel':
      return { ...state, exit: true }

    case 'code':
      // A stray code with nothing being captured. Ignore rather than guess.
      return state
  }
}

function isSharedId(id: SettingsRowId): id is SharedSettingId {
  return id === 'shake' || id === 'flashes' || id === 'volume' || id === 'mute' || id === 'autofire'
}

function adjustRow(state: SettingsState, row: SettingsRow, delta: number): SettingsState {
  if (isSharedId(row.id)) {
    const settings = adjustSettingValue(state.settings, row.id, delta)
    return settings === state.settings ? state : { ...state, settings, dirty: true }
  }
  if (row.kind === 'binding' && row.bind) {
    const action = row.bind
    if (delta > 0) {
      // RIGHT adds a spare key: the same capture prompt, additive instead of
      // replacing, so a player can keep WASD and add the arrows back.
      return withNotice(
        { ...state, capturing: action, captureAdditive: true },
        captureNotice(action),
      )
    }
    if (delta < 0) {
      const codes = state.bindings[action]
      const last = codes[codes.length - 1]
      if (last === undefined) return state
      const result = clearBinding(state.bindings, action, last)
      if (!result.ok) {
        return withNotice(state, explainRejection(result.rejection ?? 'last-key', last))
      }
      return withNotice(
        { ...state, bindings: result.bindings, dirty: true },
        `${describeCode(last)} removed from ${ACTION_COPY[action].label}.`,
      )
    }
  }
  return state
}

/**
 * Resolve a captured key.
 *
 * `replaceBinding` when the prompt came from ENTER, additive when it came from
 * RIGHT. Both arrive here, so there is one place a capture can end.
 */
function applyCapturedCode(
  state: SettingsState,
  action: SortieAction,
  code: string,
): SettingsState {
  const cleared: SettingsState = { ...state, capturing: null, captureAdditive: false }
  if (code === 'Escape') return withNotice(cleared, 'Nothing was changed.')

  const additive = state.captureAdditive && state.bindings[action].length > 0
  const result = additive
    ? assignBinding(state.bindings, action, code)
    : replaceBinding(state.bindings, action, code)

  if (!result.ok) {
    return withNotice(cleared, explainRejection(result.rejection ?? 'reserved', code))
  }

  const moved = result.evictedFrom
    ? ` It was taken from ${ACTION_COPY[result.evictedFrom].label}.`
    : ''
  return withNotice(
    { ...cleared, bindings: result.bindings, dirty: true },
    `${ACTION_COPY[action].label} is now ${describeBinding(result.bindings, action)}.${moved}`,
  )
}

// --- display -----------------------------------------------------------------

/** Display value for any row, including bindings. */
export function formatRowValue(
  state: SettingsState,
  row: SettingsRow,
): { value: string; unit: string } {
  if (isSharedId(row.id)) return formatSettingDisplay(state.settings, row.id)
  if (row.kind === 'binding' && row.bind) {
    if (state.capturing === row.bind) return { value: 'Press a key…', unit: '' }
    return { value: describeBinding(state.bindings, row.bind), unit: '' }
  }
  return { value: '', unit: '' }
}

/**
 * The sentence shown under the list when nothing else needs saying.
 *
 * States the guarantee that makes the binding screen safe to use, in the place a
 * worried player is already looking. Anything that is only true in a comment is not
 * true for the player.
 */
export const SETTINGS_SAFETY_NOTE =
  'Arrow keys, Enter and Esc always work in menus, whatever you bind.'

export const SETTINGS_FOOTER_TEXT = 'Arrows adjust · ENTER select · ESC back'

/** Warning shown when the stored keymap arrived broken. Empty when it is fine. */
export function bindingWarning(bindings: Bindings): string | null {
  const health = checkBindings(bindings)
  if (health.unbound.length > 0) {
    const names = health.unbound.map((a) => ACTION_COPY[a].label).join(', ')
    return `No key is bound to: ${names}.`
  }
  if (health.duplicated.length > 0) {
    const names = health.duplicated.map(describeCode).join(', ')
    return `Bound to more than one control: ${names}.`
  }
  return null
}

// --- layout ------------------------------------------------------------------

const CARD_W = 560
const CARD_H = 664
const CARD_X = (VIRTUAL_W - CARD_W) / 2
const CARD_Y = (VIRTUAL_H - CARD_H) / 2
const PAD = 28
const ROW_H = 28
const GROUP_H = 22

/** Content column width. Exported so tests measure against the real container. */
export const SETTINGS_CONTENT_W = CARD_W - PAD * 2
export const SETTINGS_HINT_SIZE = 11
export const SETTINGS_FOOTER_SIZE = 10
/** Room reserved on a row for its right-aligned value. */
export const SETTINGS_VALUE_W = 210

/** Vertical offset of each row from the top of the list. Pure, so it is testable. */
export function settingsRowOffsets(): readonly number[] {
  const offsets: number[] = []
  let y = 0
  for (const row of SETTINGS_ROWS) {
    if (row.group) y += GROUP_H
    offsets.push(y)
    y += ROW_H
  }
  return offsets
}

/** Total height the list needs. Asserted against the card by the tests. */
export function settingsListHeight(): number {
  const offsets = settingsRowOffsets()
  const last = offsets[offsets.length - 1] ?? 0
  return last + ROW_H
}

export const SETTINGS_CARD = { x: CARD_X, y: CARD_Y, w: CARD_W, h: CARD_H } as const

export function drawSettingsScreen(ctx: CanvasRenderingContext2D, state: SettingsState): void {
  ctx.fillStyle = 'rgba(5, 7, 11, 0.94)'
  ctx.fillRect(0, 0, VIRTUAL_W, VIRTUAL_H)

  ctx.fillStyle = Palette.panel
  ctx.fillRect(CARD_X, CARD_Y, CARD_W, CARD_H)
  ctx.strokeStyle = Palette.line
  ctx.lineWidth = 1
  ctx.strokeRect(CARD_X + 0.5, CARD_Y + 0.5, CARD_W - 1, CARD_H - 1)
  // `self`, not `caution`: settings are somewhere you chose to be, not a warning.
  ctx.fillStyle = Palette.self
  ctx.fillRect(CARD_X, CARD_Y, CARD_W, 2)

  const contentX = CARD_X + PAD
  const contentRight = CARD_X + CARD_W - PAD
  let y = CARD_Y + PAD

  drawLabel(ctx, 'Salvage Division // Pilot Preferences', contentX, y, { baseline: 'top' })
  y += 22
  drawText(ctx, 'SETTINGS', contentX, y, {
    size: 26,
    weight: 700,
    tracking: 2,
    baseline: 'top',
    color: Palette.text,
  })
  y += 36

  ctx.fillStyle = Palette.line
  ctx.fillRect(contentX, y, contentRight - contentX, 1)
  y += 12

  const listTop = y
  const offsets = settingsRowOffsets()

  SETTINGS_ROWS.forEach((row, index) => {
    const rowY = listTop + (offsets[index] ?? 0)
    const isSelected = index === state.selected

    if (row.group) {
      drawLabel(ctx, row.group, contentX, rowY - GROUP_H + 4, {
        baseline: 'top',
        color: Palette.textDim,
      })
    }

    if (isSelected) {
      // A slow pulse that never reaches zero — rule 10 applies to menus too. The
      // rate matches every other pulsing element in the game.
      const pulse = 0.16 + 0.08 * Math.sin(state.tick * 0.089)
      ctx.fillStyle = `rgba(92, 224, 240, ${pulse.toFixed(3)})`
      ctx.fillRect(contentX - 10, rowY - 4, contentRight - contentX + 20, ROW_H - 6)
      // A caret as well as a highlight: selection must not rely on colour alone.
      drawText(ctx, '>', contentX - 18, rowY, {
        size: 13,
        weight: 700,
        baseline: 'top',
        color: Palette.self,
      })
    }

    drawText(ctx, row.label, contentX, rowY, {
      size: 13,
      weight: isSelected ? 600 : 400,
      baseline: 'top',
      color: isSelected ? Palette.text : Palette.textDim,
    })

    const { value, unit } = formatRowValue(state, row)
    if (value) {
      const capturing = row.kind === 'binding' && state.capturing === row.bind
      const unitWidth = unit
        ? drawText(ctx, unit, contentRight, rowY + 2, {
            size: 11,
            align: 'right',
            baseline: 'top',
            color: Palette.textDim,
          })
        : 0
      drawText(ctx, value, contentRight - (unit ? unitWidth + 4 : 0), rowY, {
        size: 13,
        weight: 600,
        align: 'right',
        baseline: 'top',
        color: capturing ? Palette.caution : isSelected ? Palette.self : Palette.text,
      })
    }
  })

  y = listTop + settingsListHeight() + 10
  ctx.fillStyle = Palette.line
  ctx.fillRect(contentX, y, contentRight - contentX, 1)
  y += 12

  // Precedence: a broken keymap outranks a transient notice, which outranks the
  // selected row's hint. The most urgent true thing gets the line.
  const warning = bindingWarning(state.bindings)
  const selected = SETTINGS_ROWS[state.selected]
  const message = warning ?? state.notice ?? selected?.hint ?? ''
  const messageColor = warning ? Palette.caution : state.notice ? Palette.text : Palette.textDim

  const lines = wrapText(message, SETTINGS_CONTENT_W, SETTINGS_HINT_SIZE, canvasMeasure(ctx))
  lines.forEach((line, index) => {
    drawText(ctx, line, contentX, y + index * (SETTINGS_HINT_SIZE + 4), {
      size: SETTINGS_HINT_SIZE,
      baseline: 'top',
      color: messageColor,
    })
  })

  // Stacked, not side by side. Together they are 663 units against a 504-unit
  // column, and `tests/settings.test.ts` measures both — a centred footer that
  // overflows escapes at both edges and is doubly obvious.
  drawText(ctx, SETTINGS_SAFETY_NOTE, contentX, CARD_Y + CARD_H - PAD - 28, {
    size: SETTINGS_FOOTER_SIZE,
    baseline: 'top',
    color: Palette.textDim,
  })
  drawText(ctx, SETTINGS_FOOTER_TEXT, contentX, CARD_Y + CARD_H - PAD - 14, {
    size: SETTINGS_FOOTER_SIZE,
    baseline: 'top',
    color: Palette.textDim,
  })
}

/**
 * The floor keys, for anything that wants to state them.
 *
 * Re-exported rather than duplicated: the guarantee in `SETTINGS_SAFETY_NOTE` and
 * the table that implements it must be the same thing.
 */
export const MENU_GUARANTEE = MENU_FLOOR
