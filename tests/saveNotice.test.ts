/**
 * The startup save-loss notice.
 *
 * WHY THIS FILE EXISTS. `SaveLoadReport` was computed on every load and shown to
 * nobody: a save that could not be read silently became a fresh game, so a pilot with
 * thirty sorties behind them opened the game at #001, with an empty hangar, and nothing
 * anywhere said why. The fix is a message, and a message is exactly the kind of thing
 * that is only ever verified by someone happening to look at it — unless the mapping
 * from report to words is pure and tested. That is why `describeSaveLoss` is not code
 * inside `main.ts`, which has no test at all.
 *
 * MEASUREMENT follows `tests/textFits.test.ts`: a conservative monospace estimate at
 * 0.62em rather than a canvas, so a string that fits here has margin in the real
 * renderer. Erring wide is deliberate — under-measuring passes exactly the strings that
 * then overlap the controls line.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import type { PersonnelRecord } from '../src/meta/personnel'
import type { SaveLoadReport } from '../src/meta/save'
import { migrateWithReport, loadSaveWithReport } from '../src/meta/save'
import type { Measure } from '../src/render/text'
import {
  SAVE_NOTICE_BODY_SIZE,
  SAVE_NOTICE_BOTTOM,
  SAVE_NOTICE_TEXT_W,
  SAVE_NOTICE_TOP_LIMIT,
  describeSaveLoss,
  layoutSaveNotice,
  type SaveNotice,
} from '../src/ui/saveNotice'

/** Advance per character as a fraction of size. Deliberately wider than reality. */
const EM_RATIO = 0.62
const measure: Measure = (text, size, _weight = 400, tracking = 0) =>
  text.length * size * EM_RATIO + Math.max(0, text.length - 1) * tracking

const CLEAN: SaveLoadReport = { reset: false, personnelSkipped: 0, personnelDropped: [] }

function record(pilotNumber: number): PersonnelRecord {
  return {
    v: 1,
    pilotNumber,
    hullId: 'lien',
    outcome: 'lost',
    causeKind: 'enemy-fire',
    causeEnemyId: 'turret-heavy',
    sectorId: 'debris-shelf',
    waveIndex: 12,
    ticks: 8_040,
    kills: 96,
    scrap: 310,
    shotsFired: 2_400,
    hits: 620,
    seed: 'K7F29XQM3RTV',
    items: [],
    itemsOmitted: 0,
    poolFingerprint: '0123456789abcdef',
    simVersion: 1,
    stateDigest: null,
  }
}

/** Every line of a notice as one string, for "does it say X" assertions. */
function allText(notice: SaveNotice): string {
  return [notice.heading, ...notice.lines.map((line) => line.text), notice.dismiss].join('\n')
}

describe('a clean load says nothing', () => {
  it('produces no notice when nothing was lost', () => {
    expect(describeSaveLoss(CLEAN)).toBeNull()
  })

  it('produces no notice for a brand-new player', () => {
    // An empty store is not a loss. A reset notice in front of someone whose save
    // simply does not exist yet is the interface inventing a problem — and this is the
    // real report from the real loader, not a hand-built one.
    const empty = loadSaveWithReport(null)
    expect(describeSaveLoss(empty.report)).toBeNull()
  })

  it('produces no notice for a save that migrated cleanly', () => {
    const { report } = migrateWithReport({ version: 1, pilotNumber: 37 })
    expect(describeSaveLoss(report)).toBeNull()
  })
})

describe('a reset save says everything is gone', () => {
  const notice = describeSaveLoss({ ...CLEAN, reset: true })

  it('reports the reset severity', () => {
    expect(notice?.severity).toBe('reset')
  })

  it('names every store the player just lost', () => {
    const text = allText(notice as SaveNotice).toLowerCase()
    // The four things a returning player would notice missing. Naming them is the
    // difference between "something happened" and knowing what to expect on screen.
    expect(text).toContain('pilot number')
    expect(text).toContain('certifications')
    expect(text).toContain('personnel files')
    expect(text).toContain('settings')
  })

  it('says the game itself is fine, and does not say "corrupt"', () => {
    const text = allText(notice as SaveNotice)
    // "Corrupt" describes the bytes. A player needs to know what it means for them,
    // and to know the thing in front of them still works.
    expect(text.toLowerCase()).not.toContain('corrupt')
    expect(notice?.lines.some((line) => line.tone === 'reassurance')).toBe(true)
  })

  it('is worded differently from the partial loss, not merely coloured differently', () => {
    // UI.md rule 3: colour never carries information alone. The two severities differ
    // enormously in what they cost, so the words have to differ too.
    const partial = describeSaveLoss({ ...CLEAN, personnelSkipped: 1 })
    expect(partial?.heading).not.toBe(notice?.heading)
    expect(partial?.severity).not.toBe(notice?.severity)
  })
})

describe('a partial loss says what survived', () => {
  it('counts unreadable records, with the count first', () => {
    const notice = describeSaveLoss({ ...CLEAN, personnelSkipped: 3 })
    expect(notice?.severity).toBe('partial')
    expect(notice?.lines[0]?.text).toContain('3 stored records')
    expect(notice?.lines[0]?.text).toContain('unreadable')
  })

  it('reads correctly for exactly one of each', () => {
    const skipped = describeSaveLoss({ ...CLEAN, personnelSkipped: 1 })
    expect(skipped?.lines[0]?.text).toContain('1 stored record was')
    const dropped = describeSaveLoss({ ...CLEAN, personnelDropped: [record(1)] })
    expect(dropped?.lines[0]?.text).toContain('1 older file was')
    expect(dropped?.lines[0]?.text).toContain('(pilot #001)')
  })

  it('summarises dropped records as a count and the oldest file, never a dump', () => {
    // 50 evicted records. A raw list would be unreadable and would grow the card past
    // the screen; "my first pilot is gone" is the fact being looked for.
    const dropped = Array.from({ length: 50 }, (_, i) => record(i + 1))
    const notice = describeSaveLoss({ ...CLEAN, personnelDropped: dropped })
    const line = notice?.lines[0]?.text ?? ''
    expect(line).toContain('50 older files')
    expect(line).toContain('oldest pilot #001')
    // No id soup: one sentence, whatever the length of the list.
    expect(line.length).toBeLessThan(120)
    expect(notice?.lines).toHaveLength(2)
  })

  it('states that unlocks, settings and the pilot number are intact', () => {
    const notice = describeSaveLoss({ ...CLEAN, personnelSkipped: 2, personnelDropped: [record(4)] })
    const survived = notice?.lines.filter((line) => line.tone === 'reassurance') ?? []
    expect(survived).toHaveLength(1)
    expect(survived[0]?.text.toLowerCase()).toContain('intact')
    // Both losses are reported, and the reassurance comes last: what is wrong first,
    // what is fine after.
    expect(notice?.lines.map((line) => line.tone)).toEqual(['loss', 'loss', 'reassurance'])
  })

  it('describes the losses a real damaged save produces', () => {
    // End to end from the loader rather than from a hand-built report: 55 records, two
    // of them unreadable, against a cap of 50.
    const many = Array.from({ length: 55 }, (_, i) => ({ ...record(i + 1) }))
    const { report } = migrateWithReport({
      version: 4,
      pilotNumber: 56,
      settings: { shake: 1, reduceFlashes: false, masterVolume: 0.8, muted: false, autoFire: false },
      certifications: { unlocked: [], progress: {} },
      personnel: [...many, { nonsense: true }, null],
      daily: null,
    })
    const notice = describeSaveLoss(report)
    expect(notice?.severity).toBe('partial')
    expect(allText(notice as SaveNotice)).toContain('2 stored records')
    expect(allText(notice as SaveNotice)).toContain('5 older files')
  })

  it('never reports a partial loss as a reset', () => {
    expect(describeSaveLoss({ ...CLEAN, personnelSkipped: 9 })?.severity).toBe('partial')
    expect(describeSaveLoss({ reset: true, personnelSkipped: 9, personnelDropped: [] })?.severity).toBe(
      'reset',
    )
  })
})

describe('the card fits the band it is drawn in', () => {
  /**
   * The worst cases, not the pretty ones. Every string here is authored copy, so the
   * question is whether the longest thing the module can produce still clears the
   * title's controls line — which sits immediately above the card and is the one line
   * on that screen a player always needs.
   */
  const cases: ReadonlyArray<readonly [string, SaveLoadReport]> = [
    ['reset', { ...CLEAN, reset: true }],
    ['unreadable records only', { ...CLEAN, personnelSkipped: 999 }],
    ['dropped files only', { ...CLEAN, personnelDropped: [record(1), record(2)] }],
    [
      'both, at their longest',
      {
        reset: false,
        personnelSkipped: 999,
        personnelDropped: Array.from({ length: 999 }, (_, i) => record(i + 1)),
      },
    ],
  ]

  it.each(cases)('%s stays inside the card and clear of the controls line', (_label, report) => {
    const notice = describeSaveLoss(report)
    expect(notice).not.toBeNull()
    const layout = layoutSaveNotice(notice as SaveNotice, measure)
    expect(layout.y, 'the notice overlaps the controls line').toBeGreaterThanOrEqual(
      SAVE_NOTICE_TOP_LIMIT,
    )
    expect(layout.y + layout.h).toBe(SAVE_NOTICE_BOTTOM)
    for (const line of [...layout.body.map((entry) => entry.text), ...layout.dismiss]) {
      expect(
        measure(line, SAVE_NOTICE_BODY_SIZE),
        `"${line}" is wider than the card`,
      ).toBeLessThanOrEqual(SAVE_NOTICE_TEXT_W)
    }
  })

  it('keeps the tone of a sentence on every line it wraps onto', () => {
    const notice = describeSaveLoss({ ...CLEAN, reset: true }) as SaveNotice
    const layout = layoutSaveNotice(notice, measure)
    // Wrapping is per sentence, so a two-line reassurance must not come back as one
    // loss line and one reassurance line.
    expect(layout.body.filter((line) => line.tone === 'reassurance').length).toBeGreaterThan(0)
    expect(layout.body.length).toBeGreaterThanOrEqual(notice.lines.length)
  })
})

/**
 * The wiring, asserted against the source text.
 *
 * `main.ts` has no unit test — that is the whole reason the notice itself is a pure
 * module — but the two connections that make it reach a player are single lines that a
 * later edit can quietly undo, and the failure mode is silence. Grepping the source is
 * the same trade `tools/check-contracts.mjs` makes: it checks the text, not the
 * behaviour, and it is the only check available.
 */
describe('main.ts is wired to the reporting load', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')

  it('loads the save through the variant that reports losses', () => {
    expect(main).toContain('loadSaveWithReport()')
  })

  it('hands the notice to the title screen', () => {
    expect(main).toContain('describeSaveLoss(')
    expect(main).toContain('notice: saveNotice')
  })

  it('keeps the acknowledgement out of the save', () => {
    // Session-local by design: persisting "I have seen this" would mean a new numbered
    // save interface, a migration and a fixture test (CLAUDE.md) for a fact that stops
    // mattering the moment the card is dismissed.
    expect(main).toContain('let saveNotice')
    expect(main).not.toMatch(/save\.(noticeAcknowledged|acknowledged|seenNotice)/)
  })

  it('lets the notice be dismissed and does not gate a sortie on it', () => {
    expect(main).toMatch(/saveNotice !== null && keyboard\.consumePressed\('cancel'\)/)
    // The confirm branch must not be conditional on the notice being gone: a data-loss
    // message that blocks starting a run is worse than the silence it replaced.
    expect(main).not.toMatch(/saveNotice === null && keyboard\.consumePressed\('confirm'\)/)
  })
})
