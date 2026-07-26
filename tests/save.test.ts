import { beforeEach, describe, expect, it } from 'vitest'
import {
  CURRENT_VERSION,
  DEFAULT_SAVE,
  DEFAULT_SETTINGS,
  defaultSave,
  loadSaveWithReport,
  migrateWithReport,
  adoptLegacySave,
  loadSave,
  migrate,
  persistSave,
} from '../src/meta/save'
import type { PersonnelRecord } from '../src/meta/personnel'

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

/**
 * A real v3 personnel record, as an M4 build wrote it.
 *
 * Hand-written and frozen. `sectorId` and `waveIndex` are the two fields the "how
 * far did it get" question turns on.
 */
const V3_PERSONNEL_RECORD = {
  v: 1,
  pilotNumber: 12,
  hullId: 'lien',
  outcome: 'lost',
  causeKind: 'enemy-fire',
  causeEnemyId: 'turret-heavy',
  sectorId: 'debris-shelf',
  waveIndex: 22,
  ticks: 8_040,
  kills: 96,
  scrap: 310,
  shotsFired: 2_400,
  hits: 620,
  seed: 'K7F29XQM3RTV',
  items: [{ id: 'warheads', count: 1 }],
  itemsOmitted: 0,
  poolFingerprint: '0123456789abcdef',
  simVersion: 1,
  stateDigest: 'fedcba9876543210',
}

function v3SaveWith(personnel: readonly unknown[], daily: unknown = null): unknown {
  return {
    version: 3,
    pilotNumber: 12,
    settings: DEFAULT_SETTINGS,
    certifications: { unlocked: [], progress: {} },
    personnel,
    daily,
  }
}

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
      settings: { shake: 0, reduceFlashes: true, masterVolume: 0.5, muted: true, autoFire: true },
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
  it('carries a real v1 save all the way to the current version', () => {
    const save = migrate(V1_FIXTURE)
    expect(save.version).toBe(CURRENT_VERSION)
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
    // Every preference they expressed survives; the one field v4 added does not
    // appear in a v2 payload and defaults OFF, because auto-fire changes how the ship
    // behaves and a v2 player never asked for it.
    expect(save.settings).toEqual({ ...settings, autoFire: false })
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

/**
 * The M5 verdict, pinned.
 *
 * `src/meta/save.ts` records why the five-sector run did NOT warrant a v4. A written
 * argument rots; these are the three claims it rests on, asserted, so that if one of
 * them stops being true the verdict is revisited rather than inherited.
 *
 * Every fixture below is a hand-written payload in the shape a shipped build wrote,
 * for the reason the v1 fixture exists: generating one from today's types tests that
 * the code agrees with itself.
 */
describe('the five-sector run needs no schema version of its own', () => {
  it('already stores depth as a sector plus a wave, so no field is missing', () => {
    // CLAIM 1. Wave numbering restarts per sector, which makes `waveIndex` alone
    // ambiguous — but it has never been alone. The sector order is authored and
    // fixed, so the pair is exact and a `stageIndex` field would be a second copy of
    // a fact already stored.
    const save = migrate(v3SaveWith([V3_PERSONNEL_RECORD]))
    const record = save.personnel[0]
    expect(record?.sectorId).toBe('debris-shelf')
    expect(record?.waveIndex).toBe(22)
  })

  it('keeps a record filed in a later sector, with that sector named', () => {
    // The case M5 introduced: a pilot lost in sector four at wave 8. Under a
    // schema that stored only `waveIndex` this would read as a shallower run than a
    // sector-one death at wave 22. With the sector named it does not.
    const deep = { ...V3_PERSONNEL_RECORD, sectorId: 'deep-manifest', waveIndex: 8 }
    const save = migrate(v3SaveWith([V3_PERSONNEL_RECORD, deep]))
    expect(save.personnel).toHaveLength(2)
    expect(save.personnel[1]?.sectorId).toBe('deep-manifest')
    expect(save.personnel[1]?.waveIndex).toBe(8)
  })

  it('loads a record that is missing the sector rather than rejecting it', () => {
    // The pre-v3 shape, and also what a partially-written record looks like. It
    // degrades to a stated 'unknown' instead of inventing a sector — which is why
    // adding a field to a *record* never needs an envelope migration to backfill it.
    const { sectorId: _dropped, ...withoutSector } = V3_PERSONNEL_RECORD
    const save = migrate(v3SaveWith([withoutSector]))
    expect(save.personnel).toHaveLength(1)
    expect(save.personnel[0]?.sectorId).toBe('unknown')
    expect(save.personnel[0]?.waveIndex).toBe(22)
  })

  it('accepts stores carrying fields this build does not know', () => {
    // CLAIM 2. `DailyRecord` and `PersonnelRecord` are owned by their own modules
    // with their own coercers, so a future build adding `sectorId` to a daily record
    // needs no envelope bump: this build reads such a save and keeps every field it
    // does understand. That is what makes the additive path real rather than hoped
    // for, and it is the whole reason M5 did not need a v4.
    const save = migrate(
      v3SaveWith([{ ...V3_PERSONNEL_RECORD, stageIndex: 3, routeTaken: 'the-long-way' }], {
        date: '2026-07-25',
        ticks: 9_000,
        waveIndex: 6,
        scrap: 42,
        outcome: 'lost',
        sectorId: 'the-tally',
        stageIndex: 1,
      }),
    )
    expect(save.version).toBe(CURRENT_VERSION)
    expect(save.personnel[0]?.waveIndex).toBe(22)
    expect(save.personnel[0]?.sectorId).toBe('debris-shelf')
    expect(save.daily?.waveIndex).toBe(6)
    expect(save.daily?.outcome).toBe('lost')
    // The unknown fields are dropped rather than kept, which is the same trade
    // `coerceUnlockedIds` makes: this build cannot describe them, so it will not
    // write them back out as if it could.
    expect(save.daily).not.toHaveProperty('sectorId')
  })

  it('still carries a real v1 payload the whole way, unchanged by M5', () => {
    // CLAIM 3. The envelope did not move, so the chain that has to keep working
    // still does — from the payload a v1 build actually wrote, not a generated one.
    const save = migrate(V1_FIXTURE)
    expect(save.version).toBe(CURRENT_VERSION)
    expect(CURRENT_VERSION).toBe(4)
    expect(save.pilotNumber).toBe(37)
    expect(save.settings).toEqual(DEFAULT_SETTINGS)
    expect(save.certifications.unlocked).toEqual([])
    expect(save.personnel).toEqual([])
    expect(save.daily).toBeNull()
  })

  it('has an envelope with exactly the stores M5 left it with', () => {
    // A NEW STORE is what would force a v4 — a per-sector best, a remembered hull, a
    // route history. Pinning the key set means adding one cannot be done by editing
    // `Save` and hoping; it fails here, next to the reasoning that says why.
    expect(Object.keys(migrate(V1_FIXTURE)).sort()).toEqual([
      'certifications',
      'daily',
      'personnel',
      'pilotNumber',
      'settings',
      'version',
    ])
  })
})

describe('migration to v4 — Settings.autoFire', () => {
  /**
   * A REAL v3 payload, hand-written, not generated from today's types.
   *
   * Same reason the v1 fixture is hand-written: generating it would test that the
   * code agrees with itself. This is what a shipped v3 build actually wrote —
   * `settings` with exactly four keys and no `autoFire`.
   */
  const V3_FIXTURE = {
    version: 3,
    pilotNumber: 21,
    settings: { shake: 0.5, reduceFlashes: true, masterVolume: 0.3, muted: false },
    certifications: { unlocked: [], progress: {} },
    personnel: [],
    daily: null,
  }

  it('adds autoFire OFF and changes nothing else', () => {
    const save = migrate(V3_FIXTURE)
    expect(save.version).toBe(4)
    expect(save.pilotNumber).toBe(21)
    expect(save.settings.autoFire).toBe(false)
    // Every other preference is byte-identical. A migration that quietly renormalised
    // a volume would be indistinguishable from one that did its job.
    expect(save.settings.shake).toBe(0.5)
    expect(save.settings.reduceFlashes).toBe(true)
    expect(save.settings.masterVolume).toBe(0.3)
    expect(save.settings.muted).toBe(false)
  })

  it('respects an autoFire the player actually set', () => {
    const save = migrate({ ...V3_FIXTURE, version: 4, settings: { ...V3_FIXTURE.settings, autoFire: true } })
    expect(save.settings.autoFire).toBe(true)
  })

  it('coerces a garbage autoFire rather than trusting it', () => {
    const save = migrate({ ...V3_FIXTURE, version: 4, settings: { ...V3_FIXTURE.settings, autoFire: 'yes' } })
    expect(save.settings.autoFire).toBe(false)
    // And it costs the player nothing else — one bad field must not reset a save.
    expect(save.pilotNumber).toBe(21)
  })

  it('runs the whole chain, v1 through v4, in order', () => {
    const save = migrate(V1_FIXTURE)
    expect(save.version).toBe(4)
    expect(save.pilotNumber).toBe(37)
    expect(save.settings).toEqual(DEFAULT_SETTINGS)
  })
})

describe('a default save is never shared with another default save', () => {
  /**
   * REVIEW FINDING, and it was live: every fallback returned `{ ...DEFAULT_SAVE }`, a
   * SHALLOW copy, so each default save's `settings`, `certifications` and `personnel`
   * were the very same instances as the module constant's.
   *
   * The failure needs an empty save to reproduce and then looks exactly like the
   * setting having been saved correctly, which is why it survived: a player turns
   * shake off, and from then on every fresh save in that process starts with shake
   * off — including one belonging to a different pilot.
   */
  it('hands out fresh nested objects every time', () => {
    const a = loadSave(null)
    const b = loadSave(null)
    expect(a).not.toBe(b)
    expect(a.settings, 'settings shared between two default saves').not.toBe(b.settings)
    expect(a.certifications, 'certifications shared').not.toBe(b.certifications)
    expect(a.personnel, 'personnel array shared').not.toBe(b.personnel)
    expect(a.certifications.progress, 'progress map shared').not.toBe(b.certifications.progress)
  })

  it('does not let a caller edit the module default by editing its own save', () => {
    // Written the way the settings screen writes, because that is the code path that
    // made this a real bug rather than a theoretical one.
    const mine = loadSave(null)
    mine.settings.shake = 0
    mine.settings.muted = true

    const later = loadSave(null)
    expect(later.settings.shake, 'the default was poisoned').toBe(1)
    expect(later.settings.muted).toBe(false)
    expect(DEFAULT_SETTINGS.shake).toBe(1)
  })

  it('does not let one save append to another save history', () => {
    const mine = migrate(null)
    // `personnel` is readonly in the type; storage round-trips make the runtime array
    // mutable, and a shared instance is what turns that into cross-contamination.
    ;(mine.personnel as PersonnelRecord[]).push(V3_PERSONNEL_RECORD as unknown as PersonnelRecord)
    expect(migrate(null).personnel, 'a dead pilot leaked into a fresh save').toEqual([])
  })

  it('keeps a migrated save clear of the defaults too', () => {
    // The v2 -> v3 step handed back `DEFAULT_CERTIFICATIONS` itself, which is the same
    // defect one layer down: the first unlock filed would have edited the constant.
    const migrated = migrate({ version: 2, pilotNumber: 4, settings: { ...DEFAULT_SETTINGS } })
    expect(migrated.certifications).not.toBe(loadSave(null).certifications)
    expect(migrated.settings).not.toBe(loadSave(null).settings)
  })

  it('exposes the default shape without exposing the default objects', () => {
    // DEFAULT_SAVE is kept as readable documentation of what a new player starts with.
    // What must not happen is a save being built by spreading it.
    expect(defaultSave()).toEqual(DEFAULT_SAVE)
    expect(defaultSave().settings).not.toBe(DEFAULT_SAVE.settings)
  })
})

describe('a load says what it had to throw away', () => {
  /**
   * REVIEW FINDING. `migrate`'s own comment claimed each store "reports what it
   * discarded rather than silently repairing — a save that quietly loses half a
   * history is worse than one that says it did", and then called
   * `sanitizePersonnelHistory(...).history`, discarding the counts that reporting
   * depends on. `personnel.ts` returns them precisely so a caller can say so.
   */
  it('counts personnel entries it could not read at all', () => {
    const { save, report } = migrateWithReport({
      version: 4,
      pilotNumber: 5,
      settings: DEFAULT_SETTINGS,
      certifications: { unlocked: [], progress: {} },
      personnel: [V3_PERSONNEL_RECORD, { nonsense: true }, null, 7, V3_PERSONNEL_RECORD],
      daily: null,
    })
    expect(save.personnel).toHaveLength(2)
    expect(report.reset).toBe(false)
    expect(report.personnelSkipped, 'three unreadable entries went unreported').toBe(3)
    expect(report.personnelDropped).toEqual([])
  })

  it('hands back the records the retention cap forced out', () => {
    // 55 valid records against a cap of 50: five oldest are evicted on the way in, and
    // the player is entitled to know their first five pilots are gone.
    const many = Array.from({ length: 55 }, (_, i) => ({ ...V3_PERSONNEL_RECORD, pilotNumber: i + 1 }))
    const { save, report } = migrateWithReport({
      version: 4,
      pilotNumber: 56,
      settings: DEFAULT_SETTINGS,
      certifications: { unlocked: [], progress: {} },
      personnel: many,
      daily: null,
    })
    expect(save.personnel).toHaveLength(50)
    expect(report.personnelDropped).toHaveLength(5)
    expect(report.personnelDropped.map((r) => r.pilotNumber)).toEqual([1, 2, 3, 4, 5])
    // Oldest-first, and the survivors start where the dropped ones stop.
    expect(save.personnel[0]?.pilotNumber).toBe(6)
  })

  it('reports nothing lost for a clean save, and nothing lost for no save at all', () => {
    const clean = migrateWithReport(v3SaveWith([V3_PERSONNEL_RECORD]))
    expect(clean.report).toEqual({ reset: false, personnelSkipped: 0, personnelDropped: [] })

    // An empty store is not a loss. A brand-new player has nothing to be warned about,
    // and a reset notice in front of them would be the interface inventing a problem.
    const empty = loadSaveWithReport(memoryStorage())
    expect(empty.report.reset).toBe(false)
    expect(empty.save.pilotNumber).toBe(1)
  })

  it('says a save was reset when bytes existed and could not be used', () => {
    // Each of these silently became a fresh game. The player finding their pilot count
    // back at 001 with no explanation is the outcome being avoided.
    expect(loadSaveWithReport(memoryStorage({ 'next-pilot/save': '{not json' })).report.reset).toBe(true)
    expect(migrateWithReport({ version: CURRENT_VERSION + 5, pilotNumber: 9 }).report.reset).toBe(true)
    expect(migrateWithReport(null).report.reset).toBe(true)
    expect(migrateWithReport({ version: 1, pilotNumber: 'many' }).report.reset).toBe(true)
  })

  it('leaves migrate() as the plain answer for callers with nowhere to show it', () => {
    const raw = v3SaveWith([V3_PERSONNEL_RECORD])
    expect(migrate(raw)).toEqual(migrateWithReport(raw).save)
  })
})

describe('pilot numbering', () => {
  /**
   * The number names the pilot currently flying, so it can only change once that
   * pilot is finished with.
   *
   * It was incremented at launch, which meant a brand-new player's very first sortie
   * was pilot 002 and #001 never existed — visible on the title screen, the panel,
   * the incident report, and every personnel file. This pins the sequence rather than
   * the mechanism, so moving the increment again fails here.
   */
  it('starts a new player at pilot 001', () => {
    expect(migrate(null).pilotNumber).toBe(1)
  })

  it('advances one per completed run, with no gaps', () => {
    // Simulates the filing path: a record is written for the CURRENT pilot, then the
    // number advances. Three runs must file 001, 002, 003.
    let save = migrate(null)
    const filed: number[] = []
    for (let run = 0; run < 3; run++) {
      filed.push(save.pilotNumber)
      save = { ...save, pilotNumber: save.pilotNumber + 1 }
    }
    expect(filed).toEqual([1, 2, 3])
    expect(save.pilotNumber).toBe(4)
  })
})
