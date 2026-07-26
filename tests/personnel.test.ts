/**
 * Personnel files: the record, the retention cap, and the screen's containment.
 *
 * Three failure classes are being pinned here, all of which this project has
 * already shipped once in some form:
 *
 * 1. **A cleared run reported as a death.** The incident report did exactly this,
 *    because `runState` has three values and the screen assumed one. A file is worse
 *    than a screen: the screen is wrong for one keypress, the file is wrong forever.
 * 2. **Text drawn outside its container.** The pause menu's longest hint ran off the
 *    card because it was one unmeasured `drawText`. So every line this screen draws
 *    is laid out as data, measured, and asserted against the box it sits in — with
 *    the widths imported from the screen's own constants, never restated here.
 * 3. **A corrupt save making a screen unopenable.** Records are the only part of the
 *    save that grows per run, so they are the part a quota error truncates.
 */

import { describe, expect, it } from 'vitest'
import { NEUTRAL_INPUT } from '../src/core/input'
import { TICK_HZ } from '../src/core/loop'
import { BOTS } from '../src/sim/bots'
import { World } from '../src/sim/world'
import type { WorldView } from '../src/sim/entities'
import {
  PERSONNEL_BYTES_BUDGET,
  PERSONNEL_HISTORY_CAP,
  PERSONNEL_ITEM_CAP,
  PERSONNEL_RECORD_VERSION,
  appendPersonnelRecord,
  buildPersonnelRecord,
  newestFirst,
  personnelAccuracy,
  personnelBytes,
  personnelFileNumber,
  personnelItemCount,
  personnelSeconds,
  sanitizePersonnelHistory,
  sanitizePersonnelRecord,
  type PersonnelRecord,
} from '../src/meta/personnel'
import { fingerprintPool, makePool, type RunPool } from '../src/meta/purist'
import { SIM_VERSION } from '../src/meta/simVersion'
import {
  PERSONNEL_CONTENT_W,
  PERSONNEL_ROW_TEXT_W,
  PERSONNEL_ROW_W,
  PERSONNEL_ROWS_VISIBLE,
  formatAccuracy,
  layoutPersonnelScreen,
  lineBounds,
  monoMeasure,
  movePersonnelSelection,
  personnelScrollFor,
  remarkFor,
  type PersonnelScreenLayout,
  type TextLine,
} from '../src/ui/personnel'

const BASE_POOL: RunPool = makePool({
  hulls: ['lien'],
  items: ['machined-slugs', 'thrust-trim'],
  enemies: ['skiff', 'turret'],
})
const BASE_FINGERPRINT = fingerprintPool(BASE_POOL)

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/**
 * A hand-built `WorldView`.
 *
 * Used alongside real `World` runs below rather than instead of them: a fixture can
 * express states a live run cannot easily be steered into — a stale incident on an
 * extracted run, sixteen held items, zero shots fired — and those are the states
 * where the misreports live.
 */
function viewOf(overrides: Partial<WorldView> = {}): WorldView {
  const base: WorldView = {
    seed: 'K7F29XQM3RTV',
    runState: 'lost',
    // M5 view fields. Fixtures state them explicitly rather than spreading a shared
    // default, so adding a WorldView field fails here and someone decides what the
    // fixture should say instead of inheriting a silent placeholder.
    stage: { index: 0, count: 1, sectorId: 'debris-shelf', sectorName: 'Debris Shelf', bossName: null },
    hullName: 'Lien',
    boss: null,
    hazards: [],
    choiceResolve: null,
    hull: {
      x: 224,
      y: 610,
      prevX: 224,
      prevY: 610,
      integrity: 0,
      maxIntegrity: 100,
      shield: 0,
      maxShield: 40,
      invulnTicks: 0,
      radius: 7,
    },
    playerBullets: [],
    enemyBullets: [],
    enemies: [],
    explosions: [],
    stats: {
      tick: 4820,
      shotsFired: 1486,
      hits: 940,
      kills: 61,
      scrap: 418,
      damageTaken: 140,
      waveIndex: 17,
      peakProjectiles: 54,
      bulletsCulled: 300,
    },
    incident: {
      causeKind: 'collision',
      causeEnemyId: 'lancer',
      tick: 4800,
      secondsSurvived: 80,
      waveIndex: 16,
      scrap: 410,
      kills: 60,
    },
    events: [],
    cosmetic: { shake: 0 },
    inventory: [{ defId: 'machined-slugs', acquiredAtTick: 420, count: 2 }],
    activeInteractions: [],
    resolvedStats: {},
    pendingChoice: null,
    freezeTicks: 0,
  }
  return { ...base, ...overrides }
}

const INPUT = {
  pilotNumber: 4,
  hullId: 'lien',
  sectorId: 'debris-shelf',
  poolFingerprint: BASE_FINGERPRINT,
}

function recordOf(overrides: Partial<PersonnelRecord> = {}): PersonnelRecord {
  return { ...buildPersonnelRecord(viewOf(), INPUT), ...overrides }
}

// ---------------------------------------------------------------------------
// building a record
// ---------------------------------------------------------------------------

describe('a record built from a lost run', () => {
  it('carries the incident, not the post-death stats', () => {
    const record = buildPersonnelRecord(viewOf(), INPUT)
    expect(record.outcome).toBe('lost')
    expect(record.causeKind).toBe('collision')
    expect(record.causeEnemyId).toBe('lancer')
    // The incident's snapshot was taken at the moment of loss; `stats` keeps
    // advancing for the ticks the death animation runs, so a file built from
    // `stats` would credit the corpse with kills it did not make.
    expect(record.ticks).toBe(4800)
    expect(record.waveIndex).toBe(16)
    expect(record.kills).toBe(60)
    expect(record.scrap).toBe(410)
    // Accuracy is a whole-run figure and has no incident equivalent, so it comes
    // from stats deliberately.
    expect(record.shotsFired).toBe(1486)
    expect(record.hits).toBe(940)
    expect(personnelSeconds(record)).toBeCloseTo(4800 / TICK_HZ)
  })

  it('records the pool it drew from and the state it ended in', () => {
    const record = buildPersonnelRecord(viewOf(), INPUT)
    expect(record.poolFingerprint).toBe(BASE_FINGERPRINT)
    expect(record.simVersion).toBe(SIM_VERSION)
    // The tier-2 evidence. Without it a shared purist claim cannot be reproduced.
    expect(record.stateDigest).toMatch(/^[0-9a-f]{16}$/)
  })

  it('files a real lost run from the simulation', () => {
    // A live run, so the record is built against the shapes the sim actually
    // produces rather than against this file's idea of them.
    const world = new World('DEATHRUN1234')
    for (let tick = 0; tick < TICK_HZ * 240 && world.runState === 'active'; tick++) {
      world.tick(NEUTRAL_INPUT)
    }
    expect(world.runState).toBe('lost')
    const record = buildPersonnelRecord(world, { ...INPUT, pilotNumber: 12 })
    expect(record.outcome).toBe('lost')
    expect(record.causeKind).not.toBeNull()
    expect(record.ticks).toBeGreaterThan(0)
    expect(record.v).toBe(PERSONNEL_RECORD_VERSION)
  })
})

describe('a record built from an extracted run', () => {
  /**
   * THE REGRESSION THIS EXISTS FOR. A tester cleared sector 1 and the summary screen
   * stamped it TOTAL LOSS with an unattributed cause of death. The history must not
   * repeat it, and a file is permanent where the screen was momentary.
   */
  it('never reads as a death', () => {
    const record = buildPersonnelRecord(viewOf({ runState: 'extracted' }), INPUT)
    expect(record.outcome).toBe('extracted')
    expect(record.causeKind).toBeNull()
    expect(record.causeEnemyId).toBeNull()
  })

  it('discards a stale incident rather than reporting a killer', () => {
    // The sim does not populate an incident for a cleared run today. "The field
    // happens to be null" is a weaker guarantee than "this branch cannot report a
    // cause for a pilot who came home", and only the second survives a refactor.
    const record = buildPersonnelRecord(
      viewOf({
        runState: 'extracted',
        incident: {
          causeKind: 'enemy-fire',
          causeEnemyId: 'turret',
          tick: 4800,
          secondsSurvived: 80,
          waveIndex: 16,
          scrap: 410,
          kills: 60,
        },
      }),
      INPUT,
    )
    expect(record.outcome).toBe('extracted')
    expect(record.causeKind).toBeNull()
    expect(record.causeEnemyId).toBeNull()
  })

  it('files a real extracted run from the simulation', () => {
    // Seeds are searched rather than pinned, for the reason integration.test.ts
    // gives: a competent policy clears ~40% of runs, so pinning one marginal seed
    // makes this a tripwire for any sim change instead of for the thing it protects.
    const seeds = ['K7F29XQM3RTV', 'WXYZ2345MNPQ', 'AAAA2345BBBB', 'CCCC3456DDDD', 'RND72QKM3HTV']
    let cleared: World | null = null
    for (const seed of seeds) {
      const world = new World(seed)
      const policy = BOTS.aggressor.create(seed)
      for (let tick = 0; tick < TICK_HZ * 240 && world.runState === 'active'; tick++) {
        world.tick(policy(world))
      }
      if (world.runState === 'extracted') {
        cleared = world
        break
      }
    }
    expect(cleared, 'no seed in the sample cleared — the sector may be unwinnable').not.toBeNull()
    if (!cleared) return
    const record = buildPersonnelRecord(cleared, INPUT)
    expect(record.outcome).toBe('extracted')
    expect(record.causeKind).toBeNull()
    expect(record.kills).toBeGreaterThan(0)
  })

  it('is distinguishable from a lost run on every field that says so', () => {
    const lost = buildPersonnelRecord(viewOf(), INPUT)
    const extracted = buildPersonnelRecord(viewOf({ runState: 'extracted' }), INPUT)
    expect(lost.outcome).not.toBe(extracted.outcome)
    expect(remarkFor(lost)).not.toEqual(remarkFor(extracted))
  })

  it('treats an abandoned sortie as a loss', () => {
    // `active` reaching here means the pause menu's "Abandon sortie", which already
    // tells the player the hull is written off. Filing it as an extraction would
    // contradict the menu.
    const record = buildPersonnelRecord(viewOf({ runState: 'active' }), INPUT)
    expect(record.outcome).toBe('lost')
  })
})

describe('a record is bounded in size', () => {
  it('caps the held-item list and reports the overflow', () => {
    const inventory = Array.from({ length: PERSONNEL_ITEM_CAP + 5 }, (_, index) => ({
      defId: `item-${index}`,
      acquiredAtTick: index * 60,
      count: 1,
    }))
    const record = buildPersonnelRecord(viewOf({ inventory }), INPUT)
    expect(record.items.length).toBe(PERSONNEL_ITEM_CAP)
    expect(record.itemsOmitted).toBe(5)
    // The count still reflects the real build, so the detail view is not lying
    // about how many systems were fitted.
    expect(personnelItemCount(record)).toBe(PERSONNEL_ITEM_CAP + 5)
  })

  it('keeps a full history inside its storage budget', () => {
    // The cap's justification is a byte budget, and a justification nobody measures
    // rots the first time a field is added.
    const worstCase = recordOf({
      hullId: 'collateral-hull-variant',
      causeEnemyId: 'reinforced-convoy-escort',
      sectorId: 'the-deep-manifest',
      kills: 99999,
      scrap: 999999,
      shotsFired: 999999,
      hits: 888888,
      ticks: 999999,
      items: Array.from({ length: PERSONNEL_ITEM_CAP }, (_, index) => ({
        id: `overkill-accounting-variant-${index}`,
        count: 9,
      })),
      itemsOmitted: 4,
    })
    const history = Array.from({ length: PERSONNEL_HISTORY_CAP }, (_, index) => ({
      ...worstCase,
      pilotNumber: index + 1,
    }))
    expect(personnelBytes(history)).toBeLessThanOrEqual(PERSONNEL_BYTES_BUDGET)
  })
})

// ---------------------------------------------------------------------------
// the cap
// ---------------------------------------------------------------------------

describe('the retention cap', () => {
  function history(count: number): readonly PersonnelRecord[] {
    let out: readonly PersonnelRecord[] = []
    for (let i = 1; i <= count; i++) {
      out = appendPersonnelRecord(out, recordOf({ pilotNumber: i })).history
    }
    return out
  }

  it('holds when fed far more records than the cap', () => {
    const filed = history(PERSONNEL_HISTORY_CAP * 3)
    expect(filed.length).toBe(PERSONNEL_HISTORY_CAP)
  })

  it('keeps the NEWEST records', () => {
    // Dropping the newest instead would mean a full history silently stopped
    // recording — the same bug as not saving at all, and much harder to notice.
    const total = PERSONNEL_HISTORY_CAP * 3
    const filed = history(total)
    expect(filed[filed.length - 1]?.pilotNumber).toBe(total)
    expect(filed[0]?.pilotNumber).toBe(total - PERSONNEL_HISTORY_CAP + 1)
    for (const record of filed) {
      expect(record.pilotNumber).toBeGreaterThan(total - PERSONNEL_HISTORY_CAP)
    }
  })

  it('reports the drop rather than performing it silently', () => {
    const full = history(PERSONNEL_HISTORY_CAP)
    const quiet = appendPersonnelRecord(full.slice(0, -1), recordOf({ pilotNumber: 999 }))
    expect(quiet.dropped).toEqual([])

    const overflowing = appendPersonnelRecord(full, recordOf({ pilotNumber: 999 }))
    expect(overflowing.dropped.length).toBe(1)
    // The evicted record itself, not just a count: the caller can name what went.
    expect(overflowing.dropped[0]?.pilotNumber).toBe(full[0]?.pilotNumber)
    expect(overflowing.history.length).toBe(PERSONNEL_HISTORY_CAP)
  })

  it('reports every eviction when several happen at once', () => {
    const oversized = Array.from({ length: PERSONNEL_HISTORY_CAP + 7 }, (_, index) =>
      recordOf({ pilotNumber: index + 1 }),
    )
    const result = appendPersonnelRecord(oversized, recordOf({ pilotNumber: 500 }))
    expect(result.history.length).toBe(PERSONNEL_HISTORY_CAP)
    expect(result.dropped.length).toBe(8)
    expect(result.dropped.map((r) => r.pilotNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('states the cap on screen, with the number', () => {
    // A cap the player cannot discover is a cap that reads as data loss. The notice
    // has to contain the actual number, not a vague promise.
    const layout = layoutScreen({ records: [recordOf()], dropped: 3 })
    const footer = layout.footer.map((line) => line.text).join(' ')
    expect(footer).toContain(String(PERSONNEL_HISTORY_CAP))
    expect(footer).toContain('3 earlier files destroyed')
  })

  it('enforces the cap when reading a save that predates it', () => {
    const oversized = Array.from({ length: PERSONNEL_HISTORY_CAP + 20 }, (_, index) =>
      recordOf({ pilotNumber: index + 1 }),
    )
    const result = sanitizePersonnelHistory(JSON.parse(JSON.stringify(oversized)))
    expect(result.history.length).toBe(PERSONNEL_HISTORY_CAP)
    expect(result.dropped.length).toBe(20)
    expect(result.history[result.history.length - 1]?.pilotNumber).toBe(
      PERSONNEL_HISTORY_CAP + 20,
    )
  })

  it('orders storage oldest-first and display newest-first', () => {
    const filed = history(4)
    expect(filed.map((r) => r.pilotNumber)).toEqual([1, 2, 3, 4])
    expect(newestFirst(filed).map((r) => r.pilotNumber)).toEqual([4, 3, 2, 1])
    // And does not disturb the stored array while doing it.
    expect(filed.map((r) => r.pilotNumber)).toEqual([1, 2, 3, 4])
  })
})

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

describe('a record survives localStorage', () => {
  it('round-trips through JSON without losing or corrupting a field', () => {
    const original = recordOf({
      items: [
        { id: 'machined-slugs', count: 2 },
        { id: 'coin-op-cannon', count: 1 },
      ],
      itemsOmitted: 1,
    })
    const reloaded = sanitizePersonnelRecord(JSON.parse(JSON.stringify(original)))
    expect(reloaded).not.toBeNull()
    expect(reloaded).toEqual(original)
    // Field-by-field as well as deep-equal: `toEqual` would pass if BOTH sides lost
    // a key, which is exactly what a sanitiser that drops a field would do.
    for (const key of Object.keys(original) as Array<keyof PersonnelRecord>) {
      expect(reloaded?.[key], `field ${key} did not round-trip`).toEqual(original[key])
    }
    expect(Object.keys(reloaded ?? {}).sort()).toEqual(Object.keys(original).sort())
  })

  it('round-trips an extracted record without acquiring a cause of loss', () => {
    const original = buildPersonnelRecord(viewOf({ runState: 'extracted' }), INPUT)
    const reloaded = sanitizePersonnelRecord(JSON.parse(JSON.stringify(original)))
    expect(reloaded?.outcome).toBe('extracted')
    expect(reloaded?.causeKind).toBeNull()
    expect(reloaded?.causeEnemyId).toBeNull()
  })

  it('is stable under a second round trip', () => {
    // A sanitiser that normalises on read must be idempotent, or a record drifts a
    // little on every load and eventually stops matching the run it describes.
    const once = sanitizePersonnelRecord(JSON.parse(JSON.stringify(recordOf())))
    const twice = sanitizePersonnelRecord(JSON.parse(JSON.stringify(once)))
    expect(twice).toEqual(once)
  })
})

describe('a damaged save does not take the screen down with it', () => {
  const GARBAGE: readonly unknown[] = [
    null,
    undefined,
    42,
    'a string',
    [],
    {},
    { v: 1 },
    { v: 0, seed: 'K7F29XQM3RTV', outcome: 'lost', hullId: 'lien', pilotNumber: 1 },
    { v: 99, seed: 'K7F29XQM3RTV', outcome: 'lost', hullId: 'lien', pilotNumber: 1 },
    // A seed that is not a seed: the seed is the run's identity (UI rule 8), so a
    // file without a real one is not a file.
    { v: 1, seed: 'nope', outcome: 'lost', hullId: 'lien', pilotNumber: 1 },
    { v: 1, seed: 'K7F29XQM3RTV', outcome: 'vanished', hullId: 'lien', pilotNumber: 1 },
    { v: 1, seed: 'K7F29XQM3RTV', outcome: 'lost', pilotNumber: 1 },
    { v: 1, seed: 'K7F29XQM3RTV', outcome: 'lost', hullId: 'lien', pilotNumber: 0 },
    { v: 1, seed: 'K7F29XQM3RTV', outcome: 'lost', hullId: 'lien' },
  ]

  it('skips every malformed entry instead of throwing', () => {
    for (const entry of GARBAGE) {
      expect(() => sanitizePersonnelRecord(entry)).not.toThrow()
      expect(sanitizePersonnelRecord(entry), JSON.stringify(entry) ?? 'undefined').toBeNull()
    }
  })

  it('keeps the readable records and counts the rest', () => {
    const good = JSON.parse(JSON.stringify(recordOf({ pilotNumber: 7 })))
    const stored = [...GARBAGE, good, ...GARBAGE]
    const result = sanitizePersonnelHistory(stored)
    expect(result.history.length).toBe(1)
    expect(result.history[0]?.pilotNumber).toBe(7)
    expect(result.skipped).toBe(GARBAGE.length * 2)
  })

  it('survives a truncated JSON write — the realistic corruption', () => {
    // A quota error mid-write leaves a partial object. Every prefix of a serialised
    // record that parses at all must either read or be skipped.
    const text = JSON.stringify([recordOf(), recordOf({ pilotNumber: 2 })])
    for (let cut = 1; cut < text.length; cut++) {
      let parsed: unknown
      try {
        parsed = JSON.parse(text.slice(0, cut))
      } catch {
        continue
      }
      expect(() => sanitizePersonnelHistory(parsed)).not.toThrow()
    }
  })

  it('is not fooled by a record whose numbers contradict each other', () => {
    const nonsense = {
      ...JSON.parse(JSON.stringify(recordOf())),
      hits: 5000,
      shotsFired: 10,
      waveIndex: -3,
      kills: Number.NaN,
      scrap: Number.POSITIVE_INFINITY,
      ticks: 12.7,
    }
    const record = sanitizePersonnelRecord(nonsense)
    expect(record).not.toBeNull()
    if (!record) return
    // Hits above shots would render as an accuracy over 100%, which reads as a bug
    // in the panel rather than in the save.
    expect(record.hits).toBeLessThanOrEqual(record.shotsFired)
    expect(personnelAccuracy(record)).toBeLessThanOrEqual(100)
    expect(record.waveIndex).toBe(0)
    expect(record.kills).toBe(0)
    expect(record.scrap).toBe(0)
    expect(Number.isInteger(record.ticks)).toBe(true)
  })

  it('refuses to invent a pool fingerprint', () => {
    // Fabricating a plausible fingerprint here could label a run purist that never
    // was. An empty one makes `verifyPurist` report `unverifiable`, which is true.
    const record = sanitizePersonnelRecord({
      ...JSON.parse(JSON.stringify(recordOf())),
      poolFingerprint: 'tampered',
    })
    expect(record?.poolFingerprint).toBe('')
  })

  it('opens the list even when nothing in the save was readable', () => {
    const result = sanitizePersonnelHistory(GARBAGE)
    expect(result.history).toEqual([])
    const layout = layoutScreen({ records: result.history, skipped: result.skipped })
    // The empty state, plus a plain statement that records were lost.
    expect(layout.detail.length).toBeGreaterThan(0)
    expect(layout.footer.map((line) => line.text).join(' ')).toContain('unreadable')
  })
})

// ---------------------------------------------------------------------------
// accuracy
// ---------------------------------------------------------------------------

describe('accuracy with zero shots', () => {
  it('is null, not NaN and not zero', () => {
    const record = recordOf({ shotsFired: 0, hits: 0 })
    // 0/0 is NaN, and `Math.round(NaN)` is NaN, which renders as the string "NaN".
    expect(personnelAccuracy(record)).toBeNull()
    expect(personnelAccuracy(record)).not.toBeNaN()
  })

  it('renders as an em dash, matching the panel and the incident report', () => {
    // 0% is a different claim — that every round missed. Two screens disagreeing
    // about one run is worse than either answer alone.
    expect(formatAccuracy(recordOf({ shotsFired: 0, hits: 0 }))).toEqual({ value: '—', unit: '' })
  })

  it('distinguishes "never fired" from "fired and missed everything"', () => {
    expect(personnelAccuracy(recordOf({ shotsFired: 10, hits: 0 }))).toBe(0)
    expect(formatAccuracy(recordOf({ shotsFired: 10, hits: 0 }))).toEqual({
      value: '0',
      unit: '%',
    })
  })

  it('carries its unit whenever it carries a number', () => {
    // UI rule 2: no bare numbers. A percentage without its sign is unreadable.
    const withShots = formatAccuracy(recordOf({ shotsFired: 100, hits: 47 }))
    expect(withShots).toEqual({ value: '47', unit: '%' })
  })

  it('never renders NaN anywhere on the screen', () => {
    const layout = layoutScreen({
      records: [recordOf({ shotsFired: 0, hits: 0, kills: 0, scrap: 0, ticks: 0 })],
      view: 'detail',
    })
    for (const line of allLines(layout)) {
      expect(line.text, `"${line.text}" contains NaN`).not.toMatch(/NaN|Infinity|undefined/)
    }
  })
})

describe('the file number', () => {
  it('matches the incident report\'s format exactly', () => {
    // The death screen prints `FILE 004-K7F2`. The same run must be findable by the
    // same string on both screens, or the history is a second numbering system.
    const record = recordOf({ pilotNumber: 4, seed: 'K7F29XQM3RTV' })
    expect(personnelFileNumber(record)).toBe('004-K7F2')
  })

  it('does not overflow its field for a long-lived save', () => {
    expect(personnelFileNumber(recordOf({ pilotNumber: 1234 }))).toBe('1234-K7F2')
  })
})

// ---------------------------------------------------------------------------
// the screen
// ---------------------------------------------------------------------------

interface ScreenOverrides {
  records?: readonly PersonnelRecord[]
  selected?: number
  scroll?: number
  view?: 'list' | 'detail'
  skipped?: number
  dropped?: number
  basePool?: RunPool
}

function layoutScreen(overrides: ScreenOverrides = {}): PersonnelScreenLayout {
  return layoutPersonnelScreen({
    records: overrides.records ?? [recordOf()],
    selected: overrides.selected ?? 0,
    scroll: overrides.scroll ?? 0,
    view: overrides.view ?? 'list',
    tick: 0,
    basePool: overrides.basePool ?? BASE_POOL,
    /**
     * Display names are supplied by the CALLER, so their length is not bounded by
     * anything this screen controls. The adversarial entries below are what make the
     * containment assertions bite: with only real M3-era names ("Lien", "Lancer")
     * nothing on the screen is close to its edge, and a truncation removed by
     * accident would go unnoticed until a content pass added a longer name.
     */
    names: {
      hulls: {
        lien: 'Lien',
        collateral: 'Collateral',
        'long-hull': 'Collateralised Obligation Vehicle Mk IV Extended',
      },
      enemies: {
        lancer: 'Lancer',
        'reinforced-convoy-escort': 'Reinforced Convoy Escort Pattern Mk II',
      },
      items: {
        'machined-slugs': 'Machined Slugs',
        'overkill-accounting': 'Overkill Accounting Interlock Assembly',
      },
      sectors: { 'debris-shelf': 'Debris Shelf', 'the-deep-manifest': 'The Deep Manifest' },
    },
    skipped: overrides.skipped ?? 0,
    dropped: overrides.dropped ?? 0,
    measure: monoMeasure,
  })
}

function allLines(layout: PersonnelScreenLayout): readonly TextLine[] {
  return [
    ...layout.header,
    ...layout.detail,
    ...layout.footer,
    ...layout.rows.flatMap((row) => row.lines),
  ]
}

/**
 * The widest plausible history.
 *
 * Long ids, long resolved names, six-figure numbers, a full item list, and every
 * cause kind — the states a real save reaches after a long session, which is when
 * an overflow would first be seen and least expected.
 */
function wideHistory(): readonly PersonnelRecord[] {
  const base = recordOf({
    hullId: 'long-hull',
    sectorId: 'the-deep-manifest',
    causeEnemyId: 'reinforced-convoy-escort',
    kills: 999999,
    scrap: 999999,
    shotsFired: 999999,
    hits: 999999,
    ticks: 999999,
    waveIndex: 9999,
    pilotNumber: 9999,
    items: Array.from({ length: PERSONNEL_ITEM_CAP }, () => ({
      id: 'overkill-accounting',
      count: 99,
    })),
    itemsOmitted: 9,
  })
  return [
    base,
    { ...base, causeKind: 'enemy-fire' },
    { ...base, causeKind: 'hazard' },
    { ...base, causeKind: null, causeEnemyId: null },
    { ...base, outcome: 'extracted', causeKind: null, causeEnemyId: null },
    { ...base, shotsFired: 0, hits: 0 },
    ...Array.from({ length: PERSONNEL_ROWS_VISIBLE * 2 }, (_, index) => ({
      ...base,
      pilotNumber: index + 1,
    })),
  ]
}

describe('every line the list draws fits its container', () => {
  /**
   * Widths come from the SCREEN'S OWN constants, imported above. Restating a layout
   * number here would test this file's guess — the mistake `tests/textFits.test.ts`
   * documents, where a hardcoded option width was wrong by a factor of three.
   *
   * The row's text column is derived from the exported row width and text width,
   * which is symmetric padding by construction.
   */
  const rowInset = (PERSONNEL_ROW_W - PERSONNEL_ROW_TEXT_W) / 2

  it('declares a text column that actually fits inside its box', () => {
    // Guards the guard. Every assertion below measures text against
    // PERSONNEL_ROW_TEXT_W, so if that constant were widened to the full row width
    // the text would touch the row's border and every bounds check would still
    // pass. The column has to be provably narrower than the thing containing it.
    expect(PERSONNEL_ROW_TEXT_W).toBeLessThan(PERSONNEL_ROW_W)
    expect(rowInset).toBeGreaterThanOrEqual(6)
    expect(PERSONNEL_ROW_W).toBeLessThanOrEqual(PERSONNEL_CONTENT_W)
  })

  it('keeps every row box inside the list and the card', () => {
    const layout = layoutScreen({ records: wideHistory() })
    for (const row of layout.rows) {
      expect(row.box.x).toBeGreaterThanOrEqual(layout.listBox.x)
      expect(row.box.x + row.box.w).toBeLessThanOrEqual(layout.listBox.x + layout.listBox.w)
    }
  })

  it('never lets two strings on one line collide', () => {
    // A bounds check against the card edge cannot see this: a label and a
    // right-aligned value can both sit well inside the card and still overlap each
    // other in the middle. That is how "Collision with hostile hull — Reinforced
    // Convoy Escort" runs into the wave count beside it, and it looks exactly like
    // corrupted text rather than like an overflow.
    const GAP = 4
    for (const view of ['list', 'detail'] as const) {
      const layout = layoutScreen({ records: wideHistory(), view, skipped: 9, dropped: 9 })
      const groups: ReadonlyArray<readonly TextLine[]> = [
        layout.header,
        layout.detail,
        layout.footer,
        ...layout.rows.map((row) => row.lines),
      ]
      for (const group of groups) {
        for (let i = 0; i < group.length; i++) {
          for (let j = i + 1; j < group.length; j++) {
            const a = group[i]
            const b = group[j]
            if (!a || !b) continue
            const verticalGap = a.y + a.size <= b.y + 1 || b.y + b.size <= a.y + 1
            if (verticalGap) continue
            const ab = lineBounds(a)
            const bb = lineBounds(b)
            const collide = ab.right + GAP > bb.left && bb.right + GAP > ab.left
            expect(collide, `"${a.text}" collides with "${b.text}"`).toBe(false)
          }
        }
      }
    }
  })

  it('draws nothing below the controls line', () => {
    // The controls line is anchored to the card's bottom edge because it is the one
    // thing a player always needs to find. A notice that lands below it is inside
    // the card and still wrong: the reading order says the controls come last.
    for (const view of ['list', 'detail'] as const) {
      const layout = layoutScreen({ records: wideHistory(), view, skipped: 9, dropped: 9 })
      const controls = layout.footer.find((line) => line.align === 'center')
      expect(controls, 'no centred controls line was laid out').toBeDefined()
      if (!controls) continue
      for (const line of allLines(layout)) {
        if (line === controls) continue
        expect(line.y, `"${line.text}" is drawn below the controls`).toBeLessThan(controls.y)
      }
    }
  })

  it('keeps every row line inside its row box', () => {
    const records = wideHistory()
    for (let selected = 0; selected < records.length; selected++) {
      const layout = layoutScreen({ records, selected, scroll: 0 })
      for (const row of layout.rows) {
        const left = row.box.x + rowInset
        const right = left + PERSONNEL_ROW_TEXT_W
        for (const line of row.lines) {
          const bounds = lineBounds(line)
          expect(
            bounds.left,
            `"${line.text}" starts left of its row`,
          ).toBeGreaterThanOrEqual(left - 0.5)
          expect(bounds.right, `"${line.text}" overflows its row`).toBeLessThanOrEqual(right + 0.5)
        }
      }
    }
  })

  it('keeps every row line inside its row vertically', () => {
    const layout = layoutScreen({ records: wideHistory() })
    for (const row of layout.rows) {
      for (const line of row.lines) {
        expect(line.y).toBeGreaterThanOrEqual(row.box.y)
        expect(line.y + line.size).toBeLessThanOrEqual(row.box.y + row.box.h)
      }
    }
  })

  it('keeps every header, footer, and detail line inside the content column', () => {
    // Derived from the card and the exported content width rather than restated;
    // the padding is symmetric by construction.
    for (const view of ['list', 'detail'] as const) {
      const layout = layoutScreen({ records: wideHistory(), view, skipped: 4, dropped: 6 })
      const contentX = layout.card.x + (layout.card.w - PERSONNEL_CONTENT_W) / 2
      const contentRight = contentX + PERSONNEL_CONTENT_W
      for (const line of [...layout.header, ...layout.detail, ...layout.footer]) {
        const bounds = lineBounds(line)
        expect(bounds.left, `"${line.text}" starts left of the card`).toBeGreaterThanOrEqual(
          contentX - 0.5,
        )
        expect(bounds.right, `"${line.text}" overflows the card`).toBeLessThanOrEqual(
          contentRight + 0.5,
        )
      }
    }
  })

  it('keeps every line inside the card vertically, on the worst screen there is', () => {
    // The worst screen: a full list, files destroyed, AND unreadable records — the
    // one day all three notices appear at once, which is when a fixed-height footer
    // pushed its last line off the card.
    for (const view of ['list', 'detail'] as const) {
      const layout = layoutScreen({
        records: wideHistory(),
        view,
        selected: 5,
        skipped: 9,
        dropped: 9,
      })
      for (const line of allLines(layout)) {
        expect(line.y, `"${line.text}" is above the card`).toBeGreaterThanOrEqual(layout.card.y)
        expect(line.y + line.size, `"${line.text}" is below the card`).toBeLessThanOrEqual(
          layout.card.y + layout.card.h,
        )
      }
    }
  })

  it('never lets the notices collide with the list', () => {
    const layout = layoutScreen({ records: wideHistory(), skipped: 9, dropped: 9 })
    const listBottom = layout.listBox.y + layout.listBox.h
    for (const line of layout.footer) {
      expect(line.y, `"${line.text}" overlaps the list`).toBeGreaterThanOrEqual(listBottom)
    }
  })

  it('draws no empty strings', () => {
    // An empty line is a formatting bug that a bounds check cannot see: it fits
    // trivially and says nothing.
    for (const view of ['list', 'detail'] as const) {
      for (const line of allLines(layoutScreen({ records: wideHistory(), view }))) {
        expect(line.text.trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('shows at most one screenful of rows', () => {
    const layout = layoutScreen({ records: wideHistory() })
    expect(layout.rows.length).toBeLessThanOrEqual(PERSONNEL_ROWS_VISIBLE)
    for (const row of layout.rows) {
      expect(row.box.y).toBeGreaterThanOrEqual(layout.listBox.y)
      expect(row.box.y + row.box.h).toBeLessThanOrEqual(layout.listBox.y + layout.listBox.h)
    }
  })
})

describe('browsing', () => {
  it('clamps rather than wrapping at both ends', () => {
    // Fifty rows are not faster to traverse circularly, and a down-press that jumps
    // from the oldest file to the newest reads as the list resetting itself.
    expect(movePersonnelSelection(0, -1, 20)).toBe(0)
    expect(movePersonnelSelection(19, 1, 20)).toBe(19)
    expect(movePersonnelSelection(5, 3, 20)).toBe(8)
    expect(movePersonnelSelection(0, 0, 0)).toBe(0)
    expect(movePersonnelSelection(Number.NaN, 1, 20)).toBe(1)
  })

  it('always keeps the selection on screen', () => {
    const count = PERSONNEL_HISTORY_CAP
    let scroll = 0
    for (let selected = 0; selected < count; selected++) {
      scroll = personnelScrollFor(selected, scroll, count)
      expect(selected).toBeGreaterThanOrEqual(scroll)
      expect(selected).toBeLessThan(scroll + PERSONNEL_ROWS_VISIBLE)
    }
    for (let selected = count - 1; selected >= 0; selected--) {
      scroll = personnelScrollFor(selected, scroll, count)
      expect(selected).toBeGreaterThanOrEqual(scroll)
      expect(selected).toBeLessThan(scroll + PERSONNEL_ROWS_VISIBLE)
    }
  })

  it('never scrolls a list that fits', () => {
    expect(personnelScrollFor(2, 5, PERSONNEL_ROWS_VISIBLE)).toBe(0)
  })

  it('highlights exactly one row, and it is the selected one', () => {
    const records = wideHistory()
    const selected = records.length - 1
    const layout = layoutScreen({ records, selected })
    const marked = layout.rows.filter((row) => row.selected)
    expect(marked.length).toBe(1)
    expect(marked[0]?.record).toBe(records[selected])
  })

  it('keeps the scrollbar thumb inside its track and proportional', () => {
    const records = wideHistory()
    for (const selected of [0, 5, records.length - 1]) {
      const layout = layoutScreen({ records, selected })
      expect(layout.scrollbar).not.toBeNull()
      if (!layout.scrollbar) continue
      const { track, thumb } = layout.scrollbar
      expect(thumb.y).toBeGreaterThanOrEqual(track.y)
      expect(thumb.y + thumb.h).toBeLessThanOrEqual(track.y + track.h)
      expect(thumb.h).toBeLessThan(track.h)
    }
  })

  it('omits the scrollbar when everything is visible', () => {
    expect(layoutScreen({ records: [recordOf()] }).scrollbar).toBeNull()
  })

  it('opens a detail view for the selected record', () => {
    const records = wideHistory()
    const layout = layoutScreen({ records, selected: 4, view: 'detail' })
    expect(layout.rows).toEqual([])
    const text = layout.detail.map((line) => line.text).join(' ')
    // Record 4 is the extraction. The detail view must agree with the row.
    expect(text).toContain('Hull recovered')
    expect(layout.footer.map((line) => line.text).join(' ')).toContain('ESC')
  })

  it('survives an out-of-range selection instead of drawing nothing', () => {
    const records = [recordOf(), recordOf({ pilotNumber: 2 })]
    for (const selected of [-5, 99, Number.NaN]) {
      const layout = layoutScreen({ records, selected })
      expect(layout.rows.filter((row) => row.selected).length).toBe(1)
    }
  })
})

describe('the writing', () => {
  it('states the cause of loss in the incident report\'s own words', () => {
    // Functional text. A pilot who read "Collision with hostile hull" on the death
    // screen must find that exact phrase in the file, not a synonym.
    const layout = layoutScreen({ records: [recordOf()], view: 'detail' })
    expect(layout.detail.map((line) => line.text).join(' ')).toContain('Collision with hostile hull')
  })

  it('files the same remark for the same record, every time', () => {
    // A line that reshuffles per open makes screenshots non-comparable and reads as
    // a bug.
    const record = recordOf()
    expect(remarkFor(record)).toEqual(remarkFor(record))
    expect(remarkFor(record)).toEqual(remarkFor({ ...record }))
  })

  it('never files a death remark against a pilot who came home', () => {
    // The tone survives only while the facts are right — the same rule that keeps
    // EXTRACTION_REMARKS separate on the death screen.
    const lostRemarks = remarkFor(recordOf({ outcome: 'lost' }))
    const homeRemarks = remarkFor(recordOf({ outcome: 'extracted' }))
    expect(homeRemarks).not.toEqual(lostRemarks)
    for (let ticks = 0; ticks < 40; ticks++) {
      const home = remarkFor(recordOf({ outcome: 'extracted', ticks })).join(' ')
      expect(home).not.toMatch(/claimant|written off|ADEQUATE/)
    }
  })

  it('has an empty state that says what to do about it', () => {
    const layout = layoutScreen({ records: [] })
    const text = layout.detail.map((line) => line.text).join(' ')
    expect(text).toContain('No files on record')
    expect(layout.rows).toEqual([])
    expect(layout.scrollbar).toBeNull()
  })
})

describe('purist status on the screen', () => {
  it('is derived from the base pool the caller supplies', () => {
    const purist = recordOf({ poolFingerprint: BASE_FINGERPRINT })
    const expanded = recordOf({
      poolFingerprint: fingerprintPool(makePool({ ...BASE_POOL, items: ['certified-only'] })),
    })

    const puristText = layoutScreen({ records: [purist], view: 'detail' }).detail
      .map((line) => line.text)
      .join(' ')
    expect(puristText).toContain('PURIST')
    expect(puristText).toContain('Base pool only')

    const expandedText = layoutScreen({ records: [expanded], view: 'detail' }).detail
      .map((line) => line.text)
      .join(' ')
    expect(expandedText).not.toContain('PURIST')
    expect(expandedText).toContain('not comparable')
  })

  it('cannot be forced by a field on the record', () => {
    const forged = {
      ...recordOf({ poolFingerprint: fingerprintPool(makePool({ items: ['certified-only'] })) }),
      purist: true,
    } as unknown as PersonnelRecord
    const text = layoutScreen({ records: [forged], view: 'detail' }).detail
      .map((line) => line.text)
      .join(' ')
    expect(text).not.toContain('PURIST')
  })
})
