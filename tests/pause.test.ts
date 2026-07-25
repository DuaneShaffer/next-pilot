import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '../src/meta/save'
import {
  PAUSE_ITEMS,
  adjustSetting,
  formatSettingValue,
  movePauseSelection,
} from '../src/ui/pauseMenu'

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

describe('pause menu navigation', () => {
  it('wraps at both ends', () => {
    const last = PAUSE_ITEMS.length - 1
    expect(movePauseSelection(0, -1)).toBe(last)
    expect(movePauseSelection(last, 1)).toBe(0)
  })

  it('stays in range for absurd deltas', () => {
    for (const delta of [-100, -7, 0, 3, 250]) {
      const index = movePauseSelection(2, delta)
      expect(index).toBeGreaterThanOrEqual(0)
      expect(index).toBeLessThan(PAUSE_ITEMS.length)
    }
  })

  it('opens on a non-destructive row', () => {
    // The menu resets selection to 0 each time it opens. If that row were
    // "Abandon sortie", pause-then-Enter would end a run the player was trying to
    // resume — a permadeath game cannot afford that adjacency.
    expect(PAUSE_ITEMS[0]?.id).toBe('resume')
    expect(PAUSE_ITEMS[PAUSE_ITEMS.length - 1]?.id).toBe('abandon')
  })

  it('gives every row a hint', () => {
    for (const item of PAUSE_ITEMS) {
      expect(item.hint.length).toBeGreaterThan(0)
    }
  })
})

describe('setting adjustment', () => {
  it('lowers and raises shake in steps', () => {
    const lowered = adjustSetting(settings({ shake: 1 }), 'shake', -1)
    expect(lowered.shake).toBeCloseTo(0.75, 6)
    expect(adjustSetting(lowered, 'shake', 1).shake).toBeCloseTo(1, 6)
  })

  it('clamps scales to 0..1 however hard it is pushed', () => {
    let current = settings({ shake: 1, masterVolume: 1 })
    for (let i = 0; i < 20; i++) current = adjustSetting(current, 'shake', 1)
    for (let i = 0; i < 20; i++) current = adjustSetting(current, 'volume', -1)
    expect(current.shake).toBe(1)
    expect(current.masterVolume).toBe(0)
  })

  it('reaches exactly zero shake', () => {
    // Rule 10 requires shake be fully disableable. A residual 0.0001 would still
    // move the playfield, so "off" has to be exact rather than merely small.
    let current = settings({ shake: 1 })
    for (let i = 0; i < 8; i++) current = adjustSetting(current, 'shake', -1)
    expect(current.shake).toBe(0)
  })

  it('flips mute in either direction', () => {
    const muted = adjustSetting(settings({ muted: false }), 'mute', -1)
    expect(muted.muted).toBe(true)
    expect(adjustSetting(muted, 'mute', 1).muted).toBe(false)
  })

  it('never mutates the input', () => {
    const original = settings({ shake: 0.5 })
    const frozen = Object.freeze({ ...original })
    expect(() => adjustSetting(frozen, 'shake', -1)).not.toThrow()
    expect(frozen.shake).toBe(0.5)
  })

  it('ignores adjustment on action rows', () => {
    const before = settings()
    expect(adjustSetting(before, 'resume', 1)).toEqual(before)
    expect(adjustSetting(before, 'abandon', -1)).toEqual(before)
  })

  it('never produces a non-finite value', () => {
    let current = settings()
    for (const id of PAUSE_ITEMS.map((item) => item.id)) {
      for (const delta of [-1, 1]) {
        current = adjustSetting(current, id, delta)
        expect(Number.isFinite(current.shake)).toBe(true)
        expect(Number.isFinite(current.masterVolume)).toBe(true)
      }
    }
  })
})

describe('setting display', () => {
  it('reads zero shake as a word, not a quantity', () => {
    // "0 %" is a quantity; a player scanning for whether shake is off wants the
    // word "off". Percentages are for values that are actually on.
    expect(formatSettingValue(settings({ shake: 0 }), 'shake')).toEqual({ value: 'Off', unit: '' })
  })

  it('shows shake as a percentage with its unit', () => {
    expect(formatSettingValue(settings({ shake: 0.5 }), 'shake')).toEqual({
      value: '50',
      unit: '%',
    })
  })

  it('reports volume as muted rather than as a number when muted', () => {
    // Showing "80 %" while silent is a readout contradicting reality — the same
    // class of bug as the HUD that advertised 10 shots/s while firing 20.
    expect(formatSettingValue(settings({ muted: true, masterVolume: 0.8 }), 'volume')).toEqual({
      value: 'Muted',
      unit: '',
    })
  })

  it('gives every adjustable row a displayable value', () => {
    for (const item of PAUSE_ITEMS) {
      if (item.kind === 'action') continue
      const { value } = formatSettingValue(settings(), item.id)
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it('carries a unit on every numeric value', () => {
    // UI rule 2: no bare numbers anywhere in the interface.
    for (const item of PAUSE_ITEMS) {
      const { value, unit } = formatSettingValue(settings({ shake: 0.5 }), item.id)
      if (/^\d+$/.test(value)) expect(unit.length).toBeGreaterThan(0)
    }
  })
})
