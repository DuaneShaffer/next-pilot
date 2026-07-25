import { beforeEach, describe, expect, it } from 'vitest'
import {
  CURRENT_VERSION,
  DEFAULT_SETTINGS,
  adoptLegacySave,
  loadSave,
  migrate,
  persistSave,
} from '../src/meta/save'

/**
 * A minimal in-memory Storage, so these tests exercise the real load/persist
 * paths without a browser and without touching a shared global.
 */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, String(value)),
  } as Storage
}

/**
 * A real v1 payload, written by hand rather than generated.
 *
 * This is the point of the fixture: it is what shipped builds actually wrote, so
 * it cannot drift when the current types change. Generating it from today's code
 * would test that the code agrees with itself.
 */
const V1_FIXTURE = { version: 1, pilotNumber: 37 }

describe('migration', () => {
  it('upgrades a real v1 save without losing progress', () => {
    const save = migrate(V1_FIXTURE)
    expect(save.version).toBe(CURRENT_VERSION)
    // The one thing a v1 player would notice being lost.
    expect(save.pilotNumber).toBe(37)
  })

  it('gives a migrated v1 player the default settings', () => {
    const save = migrate(V1_FIXTURE)
    expect(save.settings).toEqual(DEFAULT_SETTINGS)
    // Shake defaults ON, because that is what a v1 player already experienced;
    // migrating should not silently change how the game behaves for them.
    expect(save.settings.shake).toBe(1)
  })

  it('leaves a current-version save intact', () => {
    const current = {
      version: CURRENT_VERSION,
      pilotNumber: 12,
      settings: { shake: 0, reduceFlashes: true, masterVolume: 0.5, muted: true },
    }
    expect(migrate(current)).toEqual(current)
  })

  it('falls back to defaults for a save from a newer build', () => {
    // Guessing at fields from a future schema risks corrupting them on the next
    // write. A fresh game is the honest outcome.
    const save = migrate({ version: CURRENT_VERSION + 5, pilotNumber: 9 })
    expect(save.version).toBe(CURRENT_VERSION)
    expect(save.pilotNumber).toBe(1)
  })

  it.each([
    ['null', null],
    ['a string', 'not a save'],
    ['an array', []],
    ['no version', { pilotNumber: 4 }],
    ['version 0', { version: 0, pilotNumber: 4 }],
    ['a non-numeric pilot number', { version: 1, pilotNumber: 'many' }],
    ['a NaN pilot number', { version: 1, pilotNumber: Number.NaN }],
  ])('falls back to defaults for %s', (_label, input) => {
    const save = migrate(input)
    expect(save.version).toBe(CURRENT_VERSION)
    expect(save.pilotNumber).toBe(1)
  })

  it('repairs out-of-range settings rather than trusting them', () => {
    const save = migrate({
      version: 2,
      pilotNumber: 3,
      settings: { shake: 99, reduceFlashes: 'yes', masterVolume: -5, muted: 1 },
    })
    // Clamped, not rejected: a bad value should not cost the player their run
    // count, and an unclamped volume can produce genuinely painful output.
    expect(save.settings.shake).toBe(1)
    expect(save.settings.masterVolume).toBe(0)
    expect(save.settings.reduceFlashes).toBe(DEFAULT_SETTINGS.reduceFlashes)
    expect(save.settings.muted).toBe(DEFAULT_SETTINGS.muted)
    expect(save.pilotNumber).toBe(3)
  })

  it('floors a fractional pilot number', () => {
    expect(migrate({ version: 1, pilotNumber: 8.9 }).pilotNumber).toBe(8)
  })
})

describe('storage', () => {
  let storage: Storage
  beforeEach(() => {
    storage = memoryStorage()
  })

  it('round-trips a save', () => {
    const save = migrate({ version: 1, pilotNumber: 5 })
    save.settings.shake = 0.25
    persistSave(save, storage)
    expect(loadSave(storage)).toEqual(save)
  })

  it('returns defaults when nothing is stored', () => {
    expect(loadSave(storage).pilotNumber).toBe(1)
  })

  it('survives malformed stored JSON', () => {
    storage.setItem('next-pilot/save', '{not json')
    expect(() => loadSave(storage)).not.toThrow()
    expect(loadSave(storage).pilotNumber).toBe(1)
  })

  it('never throws when storage is unavailable', () => {
    // Private browsing can throw on access, not just on write.
    expect(() => loadSave(null)).not.toThrow()
    expect(() => persistSave(migrate(V1_FIXTURE), null)).not.toThrow()
    expect(loadSave(null).pilotNumber).toBe(1)
  })
})

describe('legacy key adoption', () => {
  it('adopts a v1 save stored under the old versioned key', () => {
    // v1 keyed storage by version, which orphans data on every bump. This is the
    // one-time correction to an unsuffixed key with the version inside.
    const storage = memoryStorage({ 'next-pilot/save/v1': JSON.stringify(V1_FIXTURE) })
    const adopted = adoptLegacySave(storage)
    expect(adopted?.pilotNumber).toBe(37)
    expect(loadSave(storage).pilotNumber).toBe(37)
    // The old key is cleared so this cannot happen twice.
    expect(storage.getItem('next-pilot/save/v1')).toBeNull()
  })

  it('does not clobber an existing current save', () => {
    const storage = memoryStorage({
      'next-pilot/save': JSON.stringify({ version: 2, pilotNumber: 99, settings: DEFAULT_SETTINGS }),
      'next-pilot/save/v1': JSON.stringify(V1_FIXTURE),
    })
    expect(adoptLegacySave(storage)).toBeNull()
    expect(loadSave(storage).pilotNumber).toBe(99)
  })

  it('does nothing when there is no legacy save', () => {
    expect(adoptLegacySave(memoryStorage())).toBeNull()
  })
})
