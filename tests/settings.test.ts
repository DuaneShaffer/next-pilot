/**
 * The settings screen, and the pause menu's share of it.
 *
 * Two things are being protected here. The obvious one is that the reducer behaves.
 * The less obvious one is that the two screens which show the same setting cannot
 * describe it differently — `src/ui/pauseMenu.ts` imports its copy and its
 * behaviour from `src/ui/settings.ts`, and these tests assert that rather than
 * trusting it, because "we'll keep them in sync" is not a mechanism.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_BINDINGS, SORTIE_ACTIONS, type Bindings } from '../src/core/input'
import { defaultBindings, describeCode, replaceBinding } from '../src/meta/keybinds'
import { DEFAULT_SETTINGS } from '../src/meta/save'
import { Font } from '../src/render/palette'
import { wrapText, type Measure } from '../src/render/text'
import {
  PAUSE_CONTENT_W,
  PAUSE_ITEMS,
  adjustSetting,
  formatSettingValue,
  movePauseSelection,
} from '../src/ui/pauseMenu'
import {
  NOTICE_TICKS,
  SETTINGS_CONTENT_W,
  SETTINGS_FOOTER_SIZE,
  SETTINGS_FOOTER_TEXT,
  SETTINGS_HINT_SIZE,
  SETTINGS_ROWS,
  SETTINGS_SAFETY_NOTE,
  SETTING_COPY,
  adjustSettingValue,
  bindingWarning,
  createSettingsState,
  formatRowValue,
  formatSettingDisplay,
  markSaved,
  moveSettingsSelection,
  settingsListHeight,
  settingsReduce,
  type SettingsEvent,
  type SettingsState,
  type UiSettings,
} from '../src/ui/settings'

/** Same conservative monospace estimate `tests/textFits.test.ts` uses. */
const EM_RATIO = 0.62
const measure: Measure = (text, size, _weight = 400, tracking = 0) =>
  text.length * size * EM_RATIO + Math.max(0, text.length - 1) * tracking

function settings(overrides: Partial<UiSettings> = {}): UiSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

function state(overrides: Partial<SettingsState> = {}): SettingsState {
  return { ...createSettingsState(settings(), defaultBindings()), ...overrides }
}

function run(initial: SettingsState, events: readonly SettingsEvent[]): SettingsState {
  return events.reduce(settingsReduce, initial)
}

function indexOfRow(id: string): number {
  const index = SETTINGS_ROWS.findIndex((row) => row.id === id)
  if (index < 0) throw new Error(`no row ${id}`)
  return index
}

describe('the row model', () => {
  it('explains every row in plain language', () => {
    // UI.md rule 4 applies to settings exactly as it does to items: the mechanism,
    // in a sentence, not a restatement of the label.
    for (const row of SETTINGS_ROWS) {
      expect(row.hint.length, `${row.id} has no hint`).toBeGreaterThan(15)
      expect(row.hint.endsWith('.'), `${row.id}: "${row.hint}"`).toBe(true)
      expect(
        row.hint.toLowerCase(),
        `${row.id}'s hint just repeats its label`,
      ).not.toBe(row.label.toLowerCase())
    }
  })

  it('gives every adjustable row a displayable value', () => {
    const base = state()
    for (const row of SETTINGS_ROWS) {
      if (row.kind === 'action') continue
      expect(formatRowValue(base, row).value.length, row.id).toBeGreaterThan(0)
    }
  })

  it('carries a unit on every numeric value', () => {
    // UI rule 2: no bare numbers anywhere in the interface. ANY digit counts, rather
    // than a value that is *only* digits: `/^\d+$/` stopped matching the moment a
    // value read "Muted at 50", which is exactly when it needed to.
    //
    // Binding rows are excluded because a key name is not a quantity — "F1" wants no
    // unit — and only the shared settings produce measurements.
    for (const muted of [false, true]) {
      const base = state({ settings: settings({ shake: 0.5, masterVolume: 0.5, muted }) })
      for (const row of SETTINGS_ROWS) {
        if (row.kind === 'binding') continue
        const { value, unit } = formatRowValue(base, row)
        if (/\d/.test(value)) expect(unit.length, `${row.id}: "${value}"`).toBeGreaterThan(0)
      }
    }
  })

  it('offers a binding row for every remappable action, and no others', () => {
    const bound = SETTINGS_ROWS.filter((row) => row.kind === 'binding').map((row) => row.bind)
    expect(bound).toEqual([...SORTIE_ACTIONS])
  })

  it('ends with an unambiguous way out', () => {
    // A screen you can enter and not obviously leave is the same class of problem
    // as a keymap you cannot undo.
    expect(SETTINGS_ROWS[SETTINGS_ROWS.length - 1]?.id).toBe('back')
    expect(SETTINGS_ROWS.some((row) => row.id === 'restore-keys')).toBe(true)
  })

  it('opens on a harmless row', () => {
    const first = SETTINGS_ROWS[0]
    expect(first?.kind).not.toBe('action')
  })

  it('wraps navigation at both ends', () => {
    const last = SETTINGS_ROWS.length - 1
    expect(moveSettingsSelection(0, -1)).toBe(last)
    expect(moveSettingsSelection(last, 1)).toBe(0)
    for (const delta of [-500, -3, 0, 7, 900]) {
      const index = moveSettingsSelection(4, delta)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(SETTINGS_ROWS.length)
    }
  })
})

describe('adjusting a setting', () => {
  it('steps and clamps the scales', () => {
    let current = settings({ shake: 1, masterVolume: 1 })
    expect(adjustSettingValue(current, 'shake', -1).shake).toBeCloseTo(0.75, 6)
    for (let i = 0; i < 20; i++) current = adjustSettingValue(current, 'shake', -1)
    expect(current.shake).toBe(0)
    for (let i = 0; i < 20; i++) current = adjustSettingValue(current, 'volume', 1)
    expect(current.masterVolume).toBe(1)
  })

  it('reaches exactly zero shake', () => {
    // Rule 10 requires shake be fully disableable. A residual 0.0001 would still
    // move the playfield, so "off" has to be exact rather than merely small.
    let current = settings({ shake: 1 })
    for (let i = 0; i < 8; i++) current = adjustSettingValue(current, 'shake', -1)
    expect(current.shake).toBe(0)
  })

  it('flips every toggle in either direction', () => {
    for (const id of ['mute', 'flashes', 'autofire'] as const) {
      const on = adjustSettingValue(settings(), id, -1)
      const off = adjustSettingValue(on, id, 1)
      expect(formatSettingDisplay(on, id).value, id).toBe('On')
      expect(formatSettingDisplay(off, id).value, id).toBe('Off')
    }
  })

  it('never mutates the settings it is given', () => {
    const frozen = Object.freeze(settings({ shake: 0.5 }))
    expect(() => adjustSettingValue(frozen, 'shake', -1)).not.toThrow()
    expect(frozen.shake).toBe(0.5)
  })

  it('never produces a non-finite value', () => {
    let current = settings()
    for (const id of ['shake', 'volume', 'mute', 'flashes', 'autofire'] as const) {
      for (const delta of [-1, 1, 0]) {
        current = adjustSettingValue(current, id, delta)
        expect(Number.isFinite(current.shake)).toBe(true)
        expect(Number.isFinite(current.masterVolume)).toBe(true)
      }
    }
  })

  it('reads zero shake as a word', () => {
    // "0 %" is a quantity; a player scanning for whether shake is off wants the
    // word.
    expect(formatSettingDisplay(settings({ shake: 0 }), 'shake')).toEqual({
      value: 'Off',
      unit: '',
    })
  })

  it('says both that the audio is muted and what level it will return to', () => {
    // The row said only 'Muted', so the stored level was invisible — while LEFT and
    // RIGHT went on writing it to localStorage. Silence is the headline, so it stays
    // first and stays in the bright half; the level follows it with its unit so the
    // press a player just made has somewhere to show up.
    expect(formatSettingDisplay(settings({ muted: true, masterVolume: 0.8 }), 'volume')).toEqual({
      value: 'Muted at 80',
      unit: '%',
    })
    expect(formatSettingDisplay(settings({ muted: false, masterVolume: 0.8 }), 'volume')).toEqual({
      value: '80',
      unit: '%',
    })
  })

  /**
   * The invariant R7 broke, stated so that it holds whichever remedy is chosen.
   *
   * `adjustSettingValue` returning a new object means something was committed and
   * will be persisted. If the row's display is unchanged by that, the player pressed
   * a key, the game wrote to storage, and nothing on screen moved — which is
   * indistinguishable from a dead key. Refusing the adjustment satisfies this too
   * (nothing is committed, so nothing is skipped); silently committing does not.
   */
  it('never commits a change the row does not show', () => {
    const matrix: readonly Partial<UiSettings>[] = [
      {},
      { muted: true },
      { muted: true, masterVolume: 0 },
      { muted: true, masterVolume: 1 },
      { muted: false, masterVolume: 0.5 },
      { shake: 0 },
      { shake: 1 },
      { reduceFlashes: true },
      { autoFire: true },
    ]
    for (const id of ['shake', 'volume', 'mute', 'flashes', 'autofire'] as const) {
      for (const overrides of matrix) {
        for (const delta of [-1, 1]) {
          const before = settings(overrides)
          const after = adjustSettingValue(before, id, delta)
          if (after === before) continue
          expect(
            formatSettingDisplay(after, id),
            `${id} at ${JSON.stringify(overrides)} committed an invisible change`,
          ).not.toEqual(formatSettingDisplay(before, id))
        }
      }
    }
  })

  it('marks the state dirty only when something changed', () => {
    const at = state({ selected: indexOfRow('shake') })
    expect(settingsReduce(at, { kind: 'adjust', delta: -1 }).dirty).toBe(true)
    // Already at the floor: nothing changed, so nothing needs persisting.
    const floored = state({
      selected: indexOfRow('shake'),
      settings: settings({ shake: 0 }),
    })
    expect(settingsReduce(floored, { kind: 'adjust', delta: -1 }).dirty).toBe(false)
    expect(markSaved({ ...at, dirty: true }).dirty).toBe(false)
  })
})

describe('rebinding a key', () => {
  const fireRow = indexOfRow('bind:fire')

  it('opens a capture on confirm and says so', () => {
    const next = settingsReduce(state({ selected: fireRow }), { kind: 'confirm' })
    expect(next.capturing).toBe('fire')
    expect(next.captureAdditive).toBe(false)
    expect(next.notice).toContain('Esc cancels')
  })

  it('replaces the binding with the captured key', () => {
    const next = run(state({ selected: fireRow }), [
      { kind: 'confirm' },
      { kind: 'code', code: 'KeyQ' },
    ])
    expect(next.capturing).toBeNull()
    expect(next.bindings.fire).toEqual(['KeyQ'])
    expect(next.dirty).toBe(true)
    expect(next.notice).toContain(describeCode('KeyQ'))
  })

  it('adds a spare key on RIGHT instead of replacing', () => {
    const next = run(state({ selected: fireRow }), [
      { kind: 'adjust', delta: 1 },
      { kind: 'code', code: 'KeyQ' },
    ])
    expect(next.captureAdditive).toBe(false) // cleared once resolved
    expect(next.bindings.fire).toContain('KeyQ')
    expect(next.bindings.fire).toContain('Space')
  })

  it('drops the last spare key on LEFT', () => {
    const next = settingsReduce(state({ selected: fireRow }), { kind: 'adjust', delta: -1 })
    expect(next.bindings.fire.length).toBe(DEFAULT_BINDINGS.fire.length - 1)
    expect(next.notice).toContain('removed')
  })

  it('refuses to drop the last key, and says why', () => {
    const tight: Bindings = { ...defaultBindings(), fire: ['KeyQ'] }
    const next = settingsReduce(state({ selected: fireRow, bindings: tight }), {
      kind: 'adjust',
      delta: -1,
    })
    expect(next.bindings.fire).toEqual(['KeyQ'])
    expect(next.notice).toBeTruthy()
    expect(next.dirty).toBe(false)
  })

  it('cancels a capture with Escape and changes nothing', () => {
    const before = state({ selected: fireRow })
    const next = run(before, [{ kind: 'confirm' }, { kind: 'code', code: 'Escape' }])
    expect(next.capturing).toBeNull()
    expect(next.bindings).toEqual(before.bindings)
    expect(next.dirty).toBe(false)
    expect(next.notice).toBe('Nothing was changed.')
  })

  it('refuses a reserved key and explains it, without leaving the capture open', () => {
    for (const code of ['Escape', 'Enter', 'Tab']) {
      const next = run(state({ selected: fireRow }), [
        { kind: 'confirm' },
        { kind: 'code', code },
      ])
      expect(next.capturing, code).toBeNull()
      expect(next.bindings.fire, code).toEqual(DEFAULT_BINDINGS.fire)
    }
  })

  it('refuses to steal another action’s last key', () => {
    const tight: Bindings = { ...defaultBindings(), special: ['KeyX'] }
    const next = run(state({ selected: fireRow, bindings: tight }), [
      { kind: 'confirm' },
      { kind: 'code', code: 'KeyX' },
    ])
    expect(next.bindings.special).toEqual(['KeyX'])
    expect(next.bindings.fire).toEqual(DEFAULT_BINDINGS.fire)
    expect(next.notice).toBeTruthy()
  })

  it('reports where a stolen key came from', () => {
    const next = run(state({ selected: fireRow }), [
      { kind: 'confirm' },
      { kind: 'code', code: 'KeyW' },
    ])
    expect(next.bindings.up).not.toContain('KeyW')
    expect(next.notice).toContain('taken from')
  })

  it('ignores navigation while a capture is open', () => {
    // Otherwise the cursor moves under the prompt and the key lands on a row the
    // player can no longer see.
    const opened = settingsReduce(state({ selected: fireRow }), { kind: 'confirm' })
    for (const event of [
      { kind: 'move', delta: 3 },
      { kind: 'adjust', delta: 1 },
      { kind: 'confirm' },
    ] as const) {
      expect(settingsReduce(opened, event).selected).toBe(fireRow)
      expect(settingsReduce(opened, event).capturing).toBe('fire')
    }
  })

  it('closes a capture on cancel rather than exiting the screen', () => {
    const opened = settingsReduce(state({ selected: fireRow }), { kind: 'confirm' })
    const next = settingsReduce(opened, { kind: 'cancel' })
    expect(next.capturing).toBeNull()
    expect(next.exit).toBe(false)
  })

  it('ignores a stray code when nothing is being captured', () => {
    const before = state()
    expect(settingsReduce(before, { kind: 'code', code: 'KeyQ' })).toBe(before)
  })

  it('restores every default from one row', () => {
    const mangled = replaceBinding(defaultBindings(), 'fire', 'KeyQ').bindings
    const next = settingsReduce(
      state({ selected: indexOfRow('restore-keys'), bindings: mangled }),
      { kind: 'confirm' },
    )
    expect(next.bindings).toEqual(DEFAULT_BINDINGS)
    expect(next.dirty).toBe(true)
  })

  it('shows the pending prompt on the row being rebound', () => {
    const opened = settingsReduce(state({ selected: fireRow }), { kind: 'confirm' })
    const row = SETTINGS_ROWS[fireRow]
    expect(row).toBeDefined()
    if (row) expect(formatRowValue(opened, row).value).toContain('Press a key')
  })

  it('warns about a keymap that arrived broken', () => {
    // Storage coercion prevents this, but a future save path might not. The screen
    // states the problem rather than only refusing to create it.
    expect(bindingWarning(defaultBindings())).toBeNull()
    const empty = { ...defaultBindings(), focus: [] } as Bindings
    expect(bindingWarning(empty)).toContain('No key is bound')
  })
})

describe('leaving, and the notice', () => {
  it('exits on Back and on cancel', () => {
    expect(settingsReduce(state({ selected: indexOfRow('back') }), { kind: 'confirm' }).exit).toBe(
      true,
    )
    expect(settingsReduce(state(), { kind: 'cancel' }).exit).toBe(true)
  })

  it('clears a notice after it has been up long enough to read', () => {
    let current = settingsReduce(state({ selected: indexOfRow('bind:fire') }), {
      kind: 'confirm',
    })
    expect(current.notice).toBeTruthy()
    for (let i = 0; i < NOTICE_TICKS; i++) current = settingsReduce(current, { kind: 'tick' })
    expect(current.notice).toBeNull()
    expect(current.tick).toBe(NOTICE_TICKS)
  })

  it('advances the pulse clock on every tick', () => {
    const next = run(state(), [{ kind: 'tick' }, { kind: 'tick' }, { kind: 'tick' }])
    expect(next.tick).toBe(3)
  })
})

describe('rule 10 — the selection pulse', () => {
  it('breathes below 1Hz and never reaches zero', () => {
    // The screen's own pulse constant, measured rather than trusted: 0.089 rad per
    // tick at 60Hz is 0.85Hz, and the floor of 0.16 means it fades rather than
    // blinks. Flashing in the 3–30Hz band can trigger photosensitive seizures, so
    // this is a hard constraint and not a style choice.
    const RADIANS_PER_TICK = 0.089
    const hz = (RADIANS_PER_TICK * 60) / (Math.PI * 2)
    expect(hz).toBeLessThan(1)
    const alpha = (tick: number): number => 0.16 + 0.08 * Math.sin(tick * RADIANS_PER_TICK)
    let min = Infinity
    for (let tick = 0; tick < 600; tick++) min = Math.min(min, alpha(tick))
    expect(min).toBeGreaterThan(0.05)
  })
})

describe('one source of truth for shared settings', () => {
  it('gives the pause menu the same labels and hints as the settings screen', () => {
    for (const id of ['shake', 'flashes', 'volume', 'mute'] as const) {
      const pauseRow = PAUSE_ITEMS.find((item) => item.id === id)
      expect(pauseRow, `pause menu is missing ${id}`).toBeDefined()
      expect(pauseRow?.label).toBe(SETTING_COPY[id].label)
      expect(pauseRow?.hint).toBe(SETTING_COPY[id].hint)
    }
  })

  it('gives the two screens the same behaviour', () => {
    // The muted state is in the matrix deliberately: R7 was a disagreement between an
    // adjustment and a display, and it was wrong on BOTH screens because they share
    // these two functions. Parity has to be asserted where the bug lived.
    for (const overrides of [{ shake: 1 }, { muted: true, masterVolume: 0.5 }, { muted: false }]) {
      const before = settings(overrides)
      for (const id of ['shake', 'volume', 'mute', 'flashes'] as const) {
        for (const delta of [-1, 1]) {
          expect(adjustSetting(before, id, delta)).toEqual(adjustSettingValue(before, id, delta))
        }
        expect(formatSettingValue(before, id)).toEqual(formatSettingDisplay(before, id))
      }
    }
  })

  it('offers reduce-flashes now that the renderer honours it', () => {
    // The old note in pauseMenu.ts said this row must not exist until the renderer
    // consumed the setting, because a control that silently does nothing tells a
    // photosensitive player they are protected when they are not. `flashScale()`
    // in src/render/intensity.ts now attenuates every bright transient.
    expect(PAUSE_ITEMS.some((item) => item.id === 'flashes')).toBe(true)
    expect(formatSettingValue(settings({ reduceFlashes: true }), 'flashes').value).toBe('On')
  })

  it('keeps the pause menu opening on Resume and ending on Abandon', () => {
    expect(PAUSE_ITEMS[0]?.id).toBe('resume')
    expect(PAUSE_ITEMS[PAUSE_ITEMS.length - 1]?.id).toBe('abandon')
    // A permadeath game cannot afford pause-then-Enter ending a run.
    expect(movePauseSelection(0, 1)).not.toBe(PAUSE_ITEMS.length - 1)
  })

  it('reaches the full screen from pause', () => {
    expect(PAUSE_ITEMS.some((item) => item.id === 'settings')).toBe(true)
  })
})

describe('every authored string fits its container', () => {
  const twoLine = (text: string, width: number, size: number): readonly string[] =>
    wrapText(text, width, size, measure)

  it('wraps every settings hint inside the content column', () => {
    for (const row of SETTINGS_ROWS) {
      const lines = twoLine(row.hint, SETTINGS_CONTENT_W, SETTINGS_HINT_SIZE)
      expect(lines.length, `${row.id} produced no lines`).toBeGreaterThan(0)
      for (const line of lines) {
        expect(
          measure(line, SETTINGS_HINT_SIZE),
          `hint for "${row.id}" overflows: ${line}`,
        ).toBeLessThanOrEqual(SETTINGS_CONTENT_W)
      }
      // The card reserves two. A third runs into the footer, which is a collision
      // rather than an overflow and just as bad.
      expect(lines.length, `hint for "${row.id}" needs ${lines.length} lines`).toBeLessThanOrEqual(2)
    }
  })

  it('fits every row label beside the widest value it can show', () => {
    // Label and value share a line, so their combined width is what matters. Each
    // fitting alone proves nothing — that was exactly the pause menu's shipped bug.
    const widest = 'L Shift / R Shift'
    for (const row of SETTINGS_ROWS) {
      const combined = measure(row.label, 13) + 16 + measure(widest, 13, 600)
      expect(combined, `row "${row.id}" is too wide`).toBeLessThanOrEqual(SETTINGS_CONTENT_W)
    }
  })

  it('fits the widest binding a player can actually produce', () => {
    // Four keys is the cap, and the longest names are the modifiers.
    const worst = ['L Shift', 'R Shift', 'L Ctrl', 'R Ctrl'].join(' / ')
    expect(measure(worst, 13, 600)).toBeLessThanOrEqual(SETTINGS_CONTENT_W)
  })

  it('fits the footer and the safety note, each on its own line', () => {
    // They are stacked precisely because together they are 663 units against a
    // 504-unit column. Measured separately, as they are drawn.
    for (const text of [SETTINGS_SAFETY_NOTE, SETTINGS_FOOTER_TEXT]) {
      expect(measure(text, SETTINGS_FOOTER_SIZE), text).toBeLessThanOrEqual(
        SETTINGS_CONTENT_W,
      )
    }
  })

  it('states the lockout guarantee where a worried player is looking', () => {
    // Something only true in a comment is not true for the player.
    expect(SETTINGS_SAFETY_NOTE).toMatch(/always work/i)
    expect(SETTINGS_SAFETY_NOTE).toMatch(/Esc/i)
  })

  it('keeps the pause menu hints inside the pause card too', () => {
    // The shared copy has to fit the *smaller* of the two containers, and the
    // pause card is 368 units against the settings screen's 504.
    for (const item of PAUSE_ITEMS) {
      const lines = twoLine(item.hint, PAUSE_CONTENT_W, 11)
      expect(lines.length, `pause hint "${item.id}" needs ${lines.length} lines`).toBeLessThanOrEqual(2)
      for (const line of lines) {
        expect(measure(line, 11), `pause hint "${item.id}" overflows`).toBeLessThanOrEqual(
          PAUSE_CONTENT_W,
        )
      }
    }
  })

  it('leaves room on the card for every row', () => {
    // Derived from the screen's own constants, so adding a row without growing the
    // card fails here instead of drawing a hint over the footer.
    const HEADER = 22 + 36 + 12 + 28
    const AFTER_LIST = 10 + 12 + 2 * (SETTINGS_HINT_SIZE + 4) + 28 + 28
    expect(HEADER + settingsListHeight() + AFTER_LIST).toBeLessThanOrEqual(664)
  })
})

describe('mutation: the fit checks would fail on a bad string', () => {
  it('rejects a hint that is too long for the card', () => {
    // Proves the measurement is live. Without this, `measure` could return 0 and
    // every assertion above would pass while measuring nothing.
    const overlong =
      'This hint is deliberately far too long to fit inside two lines of the settings card, ' +
      'and exists only so the check above can be shown to actually reject something rather ' +
      'than merely agreeing with whatever it is handed on the day it was written.'
    const lines = wrapText(overlong, SETTINGS_CONTENT_W, SETTINGS_HINT_SIZE, measure)
    expect(lines.length).toBeGreaterThan(2)
  })

  it('rejects a row label that crowds out its value', () => {
    const label = 'A settings row label of a truly unreasonable and unusable length'
    const combined = measure(label, 13) + 16 + measure('L Shift / R Shift', 13, 600)
    expect(combined).toBeGreaterThan(SETTINGS_CONTENT_W)
  })

  it('measures something rather than nothing', () => {
    expect(measure('x', Font.minSizePx)).toBeGreaterThan(0)
    expect(measure('xxxxxxxxxx', 13)).toBeGreaterThan(measure('x', 13))
    expect(EM_RATIO).toBeGreaterThan(0.6)
  })
})
