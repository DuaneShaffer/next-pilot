/**
 * Persistent save, settings, and schema migration.
 *
 * THE PROMISE (CLAUDE.md): a save written by version N must load in N+1. Nothing
 * sours a roguelike faster than an update erasing progress, and the failure is
 * invisible in development because developers rarely have old saves.
 *
 * So migration is structural rather than best-effort:
 *
 *   - Every stored shape gets a numbered interface that is NEVER edited again
 *     once shipped. `SaveV1` describes what v1 builds actually wrote, forever.
 *   - `MIGRATIONS[n]` upgrades n to n+1. Loading runs every step in sequence, so
 *     a v1 save reaches the current version however many versions have passed.
 *   - Anything unrecognised or corrupt falls back to defaults rather than
 *     throwing. A player with a broken save should get a fresh game, not a blank
 *     screen.
 *
 * Adding a field means: bump CURRENT_VERSION, add SaveV{n+1}, add one migration,
 * and add a fixture test. It is deliberately more work than mutating a type,
 * because mutating a type is how progress gets silently destroyed.
 *
 * ## M5 (the five-sector run) DID NOT NEED A v4, and the reasoning is worth keeping
 *
 * The obvious reading of the milestone says otherwise — a run now has five sectors,
 * so surely "how far did it get" needs a new field. Three things say no, and the
 * third is the one that decides it.
 *
 * **Depth is already recorded, unambiguously.** `PersonnelRecord` has carried both
 * `sectorId` and `waveIndex` since v3, and `src/main.ts` fills `sectorId` from the
 * sector the run actually ended in. Wave numbering restarting per sector would make
 * `waveIndex` alone ambiguous, but it is never alone. `docs/DESIGN.md` fixes the
 * sector order — sector two is always The Tally — so the pair is exact, and a
 * `stageIndex` field would be a second copy of a fact already stored. Two copies of
 * one fact is not extra safety; it is a thing that can disagree with itself, and the
 * disagreement lands in a file the player reads as history.
 *
 * **The one real gap is inside a store that does not need this file's help.**
 * `DailyRecord` has `waveIndex` and no sector, so "wave 12" is genuinely ambiguous
 * across five sectors. But `DailyRecord` and `PersonnelRecord` are owned by
 * `seedModes.ts` and `personnel.ts`, each with its own coercer that already accepts
 * a record missing any field, and `PERSONNEL_RECORD_VERSION` exists precisely so a
 * record's shape can move without the envelope moving. Adding `sectorId` to a daily
 * record is an additive field with a default, which is the path those modules were
 * built for. The envelope — version, pilotNumber, settings, certifications,
 * personnel, daily — is unchanged by M5. There is no new *store*.
 *
 * **A migration would have nothing honest to write.** This is the deciding one. A
 * migration step must fill the new field for saves that already exist, and every v3
 * daily record was flown on a single-sector build. `MIGRATIONS[3]` could only write
 * a sentinel — which is exactly what a tolerant coercer produces for an absent field,
 * at no cost. Shipping a version whose only observable effect is a sentinel and a
 * fixture test devalues the mechanism: the next reader sees four versions where only
 * three ever meant anything, and the discipline that makes v1 loadable in v3 comes
 * from every bump being load-bearing.
 *
 * So: no v4. When the daily contract's screen starts *printing* depth, add
 * `sectorId` to `DailyRecord`, default it in `coerceDailyRecord`, and populate it in
 * `src/main.ts` — still no envelope bump. What WOULD need a v4 is a new store: a
 * per-sector best, a chosen hull remembered between runs, a route history.
 */

import {
  DEFAULT_CERTIFICATIONS,
  coerceProgress,
  coerceUnlockedIds,
  type CertificationState,
} from './certifications'
import { sanitizePersonnelHistory, type PersonnelRecord } from './personnel'
import { coerceDailyRecord, type DailyRecord } from './seedModes'

const STORAGE_KEY = 'next-pilot/save'
export const CURRENT_VERSION = 3

/** Motion and flash preferences. See docs/UI.md rule 10 — this is accessibility. */
export interface Settings {
  /**
   * Screen-shake multiplier, 0..1. 0 disables shake entirely.
   *
   * Exposed as a scale rather than a boolean because vestibular sensitivity is a
   * spectrum; "off" and "full" are not the only useful answers.
   */
  shake: number
  /** Suppress bright impact flashes for photosensitivity. */
  reduceFlashes: boolean
  masterVolume: number
  muted: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  shake: 1,
  reduceFlashes: false,
  masterVolume: 0.8,
  muted: false,
}

// --- versioned shapes. Never edit a shipped one. -----------------------------

/** What v1 builds wrote. Frozen. */
interface SaveV1 {
  version: 1
  pilotNumber: number
}

/** Adds settings, introduced with the M2 feel pass. Frozen. */
interface SaveV2 {
  version: 2
  pilotNumber: number
  settings: Settings
}

/**
 * Adds meta-progression, introduced with M4.
 *
 * Three independent stores, each owned by the module that understands it — this file
 * persists them and coerces them, and deliberately knows nothing about what a
 * certification or a personnel record means.
 */
interface SaveV3 {
  version: 3
  pilotNumber: number
  settings: Settings
  certifications: CertificationState
  /** OLDEST FIRST, capped. See personnel.ts for why the cap is a storage concern. */
  personnel: readonly PersonnelRecord[]
  /**
   * The daily contract most recently flown.
   *
   * One entry rather than a history: a record whose date is not today means "not
   * flown", so it self-invalidates with no cleanup pass and no unbounded growth.
   */
  daily: DailyRecord | null
}

export type Save = SaveV3
type AnySave = SaveV1 | SaveV2 | SaveV3

export const DEFAULT_SAVE: Save = {
  version: 3,
  pilotNumber: 1,
  settings: { ...DEFAULT_SETTINGS },
  certifications: DEFAULT_CERTIFICATIONS,
  personnel: [],
  daily: null,
}

/**
 * `MIGRATIONS[n]` upgrades a version-n save to version n+1.
 *
 * Each step assumes only that its input passed the *previous* version's
 * validation, so steps stay small and independently reviewable.
 */
const MIGRATIONS: Record<number, (save: AnySave) => AnySave> = {
  1: (save) => {
    const v1 = save as SaveV1
    return {
      version: 2,
      pilotNumber: v1.pilotNumber,
      // A v1 player never expressed a preference, so they get the defaults —
      // notably shake ON, matching what they already experienced.
      settings: { ...DEFAULT_SETTINGS },
    } satisfies SaveV2
  },
  2: (save) => {
    const v2 = save as SaveV2
    return {
      version: 3,
      pilotNumber: v2.pilotNumber,
      settings: v2.settings,
      // A returning v2 player has certified nothing and filed nobody. Starting them
      // with unlocks would hand out progression they never earned; starting them with
      // invented personnel files would put fiction in a history that is meant to be a
      // record of what actually happened.
      certifications: DEFAULT_CERTIFICATIONS,
      personnel: [],
      daily: null,
    } satisfies SaveV3
  },
}

function clamp01(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback
}

function coerceSettings(raw: unknown): Settings {
  const input = (raw ?? {}) as Partial<Settings>
  return {
    shake: clamp01(input.shake, DEFAULT_SETTINGS.shake),
    reduceFlashes:
      typeof input.reduceFlashes === 'boolean' ? input.reduceFlashes : DEFAULT_SETTINGS.reduceFlashes,
    masterVolume: clamp01(input.masterVolume, DEFAULT_SETTINGS.masterVolume),
    muted: typeof input.muted === 'boolean' ? input.muted : DEFAULT_SETTINGS.muted,
  }
}

/**
 * Bring any stored save up to the current version.
 *
 * Exported separately from storage so migration is unit-testable against
 * fixtures without touching localStorage.
 */
export function migrate(raw: unknown): Save {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SAVE }

  const candidate = raw as { version?: unknown; pilotNumber?: unknown }
  let version = typeof candidate.version === 'number' ? candidate.version : 0

  // A save from a *newer* build cannot be understood by this one. Reading it
  // anyway would mean guessing at fields, so start fresh rather than corrupt it.
  if (version > CURRENT_VERSION || version < 1) return { ...DEFAULT_SAVE }
  if (typeof candidate.pilotNumber !== 'number' || !Number.isFinite(candidate.pilotNumber)) {
    return { ...DEFAULT_SAVE }
  }

  let save = raw as AnySave
  while (version < CURRENT_VERSION) {
    const step = MIGRATIONS[version]
    // A gap in the migration chain is a programming error, not a data problem.
    if (!step) return { ...DEFAULT_SAVE }
    save = step(save)
    version = save.version
  }

  const current = save as SaveV3
  // Every store is coerced by the module that owns its shape. None of them throw on
  // hand-edited storage, and each reports what it discarded rather than silently
  // repairing — a save that quietly loses half a history is worse than one that says
  // it did.
  return {
    version: CURRENT_VERSION,
    pilotNumber: Math.max(1, Math.floor(current.pilotNumber)),
    settings: coerceSettings(current.settings),
    certifications: {
      unlocked: coerceUnlockedIds(current.certifications?.unlocked),
      progress: coerceProgress(current.certifications?.progress),
    },
    personnel: sanitizePersonnelHistory(current.personnel).history,
    daily: coerceDailyRecord(current.daily),
  }
}

export function loadSave(storage: Storage | null = safeStorage()): Save {
  if (!storage) return { ...DEFAULT_SAVE }
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULT_SAVE }
    return migrate(JSON.parse(raw))
  } catch {
    // Malformed JSON, quota errors, or a locked store. Play anyway.
    return { ...DEFAULT_SAVE }
  }
}

export function persistSave(save: Save, storage: Storage | null = safeStorage()): void {
  if (!storage) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(save))
  } catch {
    // Non-fatal: the run still works, progress just won't survive a reload.
  }
}

/**
 * localStorage if it is actually usable.
 *
 * Private browsing can throw on *access*, not just on write, so this probes it
 * once rather than trusting that the property exists.
 */
function safeStorage(): Storage | null {
  try {
    const store = globalThis.localStorage
    const probe = '__np_probe__'
    store.setItem(probe, '1')
    store.removeItem(probe)
    return store
  } catch {
    return null
  }
}

/** The v1 key, kept so a returning player's pilot count is not silently reset. */
const LEGACY_V1_KEY = 'next-pilot/save/v1'

/**
 * One-time adoption of the v1 key.
 *
 * v1 stored under a version-suffixed key, which turned out to be a mistake: the
 * key changing per version means old data is orphaned rather than migrated. The
 * current key is unsuffixed and the version lives *inside* the payload, so this
 * only ever has to happen once.
 */
export function adoptLegacySave(storage: Storage | null = safeStorage()): Save | null {
  if (!storage) return null
  try {
    if (storage.getItem(STORAGE_KEY)) return null
    const legacy = storage.getItem(LEGACY_V1_KEY)
    if (!legacy) return null
    const migrated = migrate(JSON.parse(legacy))
    persistSave(migrated, storage)
    storage.removeItem(LEGACY_V1_KEY)
    return migrated
  } catch {
    return null
  }
}
