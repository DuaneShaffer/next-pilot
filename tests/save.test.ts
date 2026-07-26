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
    // A COMPLETE current-version save. This previously declared the current version
    // while carrying only v2's fields, so once v3 added stores the coercion correctly
    // filled them in and the test read that as corruption. A fixture that claims a
    // version must actually be that version.
    const current = {
      version: CURRENT_VERSION,
      pilotNumber: 12,
      settings: { shake: 0, reduceFlashes: true, masterVolume: 0.5, muted: true },
      certifications: { unlocked: [], progress: {} },
      personnel: [],
      daily: null,
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

describe('migration to v3', () => {
  /**
   * THE CHAIN, not just the last hop.
   *
   * A v1 save has to reach v3 through v2, and the only way to know that works is to
   * start from a payload a v1 build actually wrote. Generating the fixture from
   * today's types would test that the code agrees with itself.
   */
  it('carries a real v1 save all the way to v3', () => {
    const save = migrate(V1_FIXTURE)
    expect(save.version).toBe(3)
    // The one thing a v1 player would notice being lost.
    expect(save.pilotNumber).toBe(37)
    expect(save.settings).toEqual(DEFAULT_SETTINGS)
  })

  it('gives a migrated player no progression they did not earn', () => {
    // Seeding unlocks would hand out progression that was never played for; seeding
    // personnel files would put fiction into a record of what actually happened.
    const fromV1 = migrate(V1_FIXTURE)
    expect(fromV1.certifications.unlocked).toEqual([])
    expect(fromV1.personnel).toEqual([])
    expect(fromV1.daily).toBeNull()

    const fromV2 = migrate({ version: 2, pilotNumber: 9, settings: DEFAULT_SETTINGS })
    expect(fromV2.certifications.unlocked).toEqual([])
    expect(fromV2.personnel).toEqual([])
  })

  it('keeps a v2 player their settings', () => {
    const settings = { shake: 0.25, reduceFlashes: true, masterVolume: 0.5, muted: true }
    const save = migrate({ version: 2, pilotNumber: 4, settings })
    expect(save.settings).toEqual(settings)
    expect(save.pilotNumber).toBe(4)
  })

  it('round-trips a full v3 save through storage', () => {
    const storage = memoryStorage()
    const save = migrate(V1_FIXTURE)
    const populated: typeof save = {
      ...save,
      certifications: { unlocked: [], progress: {} },
      personnel: [],
      daily: { date: '2026-07-25', ticks: 900, waveIndex: 6, scrap: 42, outcome: 'lost' },
    }
    persistSave(populated, storage)
    expect(loadSave(storage)).toEqual(populated)
  })

  it('survives hand-edited garbage in every new store', () => {
    // Each store is coerced by the module that owns its shape, and none may throw —
    // a corrupt history must not make the game unopenable.
    const save = migrate({
      version: 3,
      pilotNumber: 5,
      settings: DEFAULT_SETTINGS,
      certifications: { unlocked: ['no-such-cert', 42, null], progress: { bogus: 'x' } },
      personnel: [{ nonsense: true }, null, 7],
      daily: { date: '2026-13-99', ticks: Number.NaN, waveIndex: -5, outcome: 'exploded' },
    })
    expect(save.pilotNumber).toBe(5)
    expect(save.certifications.unlocked).toEqual([])
    expect(save.personnel).toEqual([])
    expect(save.daily).toBeNull()
  })

  it('drops an unknown certification id rather than resetting the save', () => {
    // A save written by a build with more certifications must still load. Losing one
    // unlock is recoverable; losing the whole save is not.
    const save = migrate({
      version: 3,
      pilotNumber: 12,
      settings: DEFAULT_SETTINGS,
      certifications: { unlocked: ['from-a-future-build'], progress: {} },
      personnel: [],
      daily: null,
    })
    expect(save.pilotNumber).toBe(12)
    expect(save.certifications.unlocked).toEqual([])
  })
})
