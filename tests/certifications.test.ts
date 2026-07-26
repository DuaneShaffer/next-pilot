/**
 * Certification tests.
 *
 * THE ONE THAT MATTERS MOST is `the design constraint, made mechanical`. Everything
 * else here is ordinary correctness; that block is the only thing standing between
 * `docs/DESIGN.md`'s "certifications expand variety, not raw power" and the version
 * of this feature the genre expects, which is a shop that sells +5% damage forever.
 * It is asserted against the *shape* of the roster rather than by reading the copy,
 * so a future certification cannot smuggle a stat in and still pass.
 *
 * Everything is a literal `RunSummary` rather than a played sortie, which is the
 * point of `evaluateRun` being pure: reachability is provable by construction, and a
 * condition nobody can satisfy fails here rather than sitting in the hangar as an
 * entry that never lights up.
 */

import { describe, expect, it } from 'vitest'
import {
  BASE_POOL,
  CERTIFICATIONS,
  POOL_SLICES,
  getCertification,
  type CertificationDef,
  type PoolSlice,
  type UnlockCondition,
} from '../src/content/certifications'
import { BOSSES } from '../src/content/bosses'
import { ENEMIES } from '../src/content/enemies'
import { HAZARDS } from '../src/content/hazards'
import { HULLS, HULLS_AWAITING_MECHANICS } from '../src/content/hulls'
import { ITEMS } from '../src/content/items'
import { WORK_ORDERS } from '../src/content/workOrders'
import { resolveStat } from '../src/sim/stats'
import {
  CERTIFICATION_IDS,
  DEFAULT_CERTIFICATIONS,
  EMPTY_RUN_SUMMARY,
  coerceProgress,
  coerceUnlockedIds,
  conditionMet,
  conditionMetric,
  conditionTarget,
  describeCondition,
  describeProgress,
  evaluateRun,
  fileRun,
  fullPool,
  grantCounts,
  isCertificationId,
  mergeProgress,
  poolFor,
  poolSize,
  sliceNoun,
  unlockedSet,
  type RunSummary,
} from '../src/meta/certifications'

/** Sector 1's wave count, used only for condition prose. */
const WAVE_COUNT = 30

const ALL_UNLOCKED: ReadonlySet<string> = new Set(CERTIFICATION_IDS)
const NONE_UNLOCKED: ReadonlySet<string> = new Set<string>()

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return { ...EMPTY_RUN_SUMMARY, waveCount: WAVE_COUNT, ...overrides }
}

/**
 * A sortie constructed to satisfy exactly one condition.
 *
 * Written as a switch over the union rather than a lookup table keyed by id, so
 * adding an eleventh condition kind fails to compile here instead of silently
 * skipping the reachability check for the new one.
 */
function satisfying(condition: UnlockCondition): RunSummary {
  switch (condition.kind) {
    case 'wavesReached':
      return summary({ waveIndex: condition.waves })
    case 'killsInRun':
      return summary({ kills: condition.kills })
    case 'scrapHeld':
      return summary({ scrapHeld: condition.scrap })
    case 'accuracy':
      return summary({
        shotsFired: condition.minShots,
        hits: Math.ceil((condition.percent / 100) * condition.minShots),
      })
    case 'bareHull':
      return summary({ waveIndex: condition.waves, systemsFitted: 0 })
    case 'combinationsLive':
      return summary({ combinationsLive: condition.combinations })
    case 'systemsFitted':
      return summary({ systemsFitted: condition.systems })
    case 'lostTo':
      return summary({ outcome: 'lost', causeEnemyId: condition.enemyId })
    case 'extracted':
      return summary({ outcome: 'extracted', waveIndex: WAVE_COUNT })
    case 'cleanExtraction':
      return summary({
        outcome: 'extracted',
        waveIndex: WAVE_COUNT,
        damageTaken: condition.damage,
      })
  }
}

// ---------------------------------------------------------------------------

describe('the design constraint, made mechanical', () => {
  it('gives a grant exactly two fields, so there is nowhere to put a number', () => {
    // THIS IS THE WHOLE THING. `docs/DESIGN.md` rules out "currency-purchased
    // permanent stat upgrades"; a grant that can only name a slice and an id cannot
    // express one. If this assertion is ever relaxed to accommodate a new field,
    // that field is the design constraint being negotiated away.
    for (const def of CERTIFICATIONS) {
      for (const grant of def.grants) {
        expect(Object.keys(grant).sort(), `${def.id} grant has extra fields`).toEqual([
          'id',
          'slice',
        ])
        expect(typeof grant.id).toBe('string')
        expect(grant.id.length).toBeGreaterThan(0)
        expect(POOL_SLICES as readonly string[]).toContain(grant.slice)
      }
    }
  })

  it('offers no pool slice that describes the pilot rather than the content', () => {
    // Asserted as an exact list, not a "does not contain" check. A `playerStats` or
    // `bonuses` slice is a one-word addition to POOL_SLICES that would read as
    // harmless in review; pinning the list makes it a deliberate act.
    expect([...POOL_SLICES]).toEqual([
      'items',
      'enemies',
      'workOrders',
      'hulls',
      'bossVariants',
      'hazards',
    ])
  })

  it('lets a certification carry no field beyond its id, name, condition, grants and copy', () => {
    const allowed = ['id', 'name', 'condition', 'grants', 'effect', 'awaiting'].sort()
    for (const def of CERTIFICATIONS) {
      expect(Object.keys(def).sort(), `${def.id} has an unexpected field`).toEqual(allowed)
    }
  })

  it('never mentions a stat any item modifies, anywhere in the roster', () => {
    // Derived from the real item table rather than restating `StatKey`, which has no
    // runtime form. Covers every stat content actually touches, which is the set a
    // smuggled bonus would have to name to do anything.
    const statKeys = new Set<string>()
    for (const item of Object.values(ITEMS)) {
      for (const modifier of item.stats ?? []) statKeys.add(modifier.stat)
    }
    expect(statKeys.size).toBeGreaterThan(0)

    const serialised = JSON.stringify(CERTIFICATIONS)
    for (const key of statKeys) {
      expect(serialised, `roster mentions the stat "${key}"`).not.toContain(key)
    }
  })

  it('carries no lifetime counter in a condition — a condition is one sortie', () => {
    // The grinding problem the design rejects would arrive as `runsPlayed` or
    // `totalKills`. Every condition kind below is a fact about a single run, and this
    // pins the list so a lifetime one cannot join it quietly.
    expect([...new Set(CERTIFICATIONS.map((def) => def.condition.kind))].sort()).toEqual([
      'accuracy',
      'bareHull',
      'cleanExtraction',
      'combinationsLive',
      'extracted',
      'killsInRun',
      'lostTo',
      'scrapHeld',
      'systemsFitted',
      'wavesReached',
    ])
  })
})

describe('the roster', () => {
  it('has ten certifications with unique ids', () => {
    expect(CERTIFICATIONS.length).toBe(10)
    expect(new Set(CERTIFICATION_IDS).size).toBe(CERTIFICATIONS.length)
  })

  it('uses every condition kind exactly once', () => {
    // An unused kind is evaluator code nothing exercises, which is where a bug waits
    // until the day someone authors the certification that needs it.
    const kinds = CERTIFICATIONS.map((def) => def.condition.kind)
    expect(new Set(kinds).size).toBe(kinds.length)
  })

  it('gives every certification a non-empty stated condition', () => {
    for (const def of CERTIFICATIONS) {
      const text = describeCondition(def.condition, { waveCount: WAVE_COUNT })
      expect(text.length, `${def.id} has no stated condition`).toBeGreaterThan(0)
      // "Keep playing" is the failure `docs/UI.md` rule 4 exists to prevent, so the
      // sentence has to end in a full stop and say something specific.
      expect(text.endsWith('.'), `${def.id}: "${text}"`).toBe(true)
      expect(text.toLowerCase()).not.toContain('keep playing')
    }
  })

  it('states a real number in every condition that has one', () => {
    for (const def of CERTIFICATIONS) {
      const target = conditionTarget(def.condition)
      if (target === null) continue
      const text = describeCondition(def.condition, { waveCount: WAVE_COUNT })
      expect(text, `${def.id} states no number`).toContain(String(target))
    }
  })

  it('quotes numbers a hull it grants actually has', () => {
    /**
     * THREE CARDS WERE SELLING HULLS THAT HAD BEEN REBALANCED UNDERNEATH THEM.
     *
     * Surety's said "+1 damage" after that modifier was removed on measured evidence.
     * Arrears' said "150 scrap, 45 less effective health" against 320 scrap and 30
     * less. Probate's said "132 effective health" where the hull lands at 124. Each
     * was a balance change that updated the hull and left the card advertising the
     * old one — UI rule 4, on the screen where a player decides what to fly.
     *
     * The test below it asserted only that the string was non-empty, which is why
     * this survived three separate rebalances.
     *
     * Effective health is checked because it is the figure these cards all quote and
     * it is derivable: integrity plus shield, both through the real stat fold, so a
     * `mul` and an `add` compose the way the game composes them. `+1 damage`-style
     * claims cannot be verified from prose in general — the guard here is that any
     * card naming a hull's effective health must name the right one.
     */
    const hullGrants = CERTIFICATIONS.flatMap((def) =>
      def.grants.filter((g) => g.slice === 'hulls').map((g) => ({ def, hullId: g.id })),
    )
    expect(hullGrants.length, 'no certification grants a hull — has the roster moved?')
      .toBeGreaterThan(0)

    for (const { def, hullId } of hullGrants) {
      const hull = HULLS[hullId]
      expect(hull, `${def.id} grants unknown hull ${hullId}`).toBeDefined()
      if (!hull) continue

      const integrity = resolveStat('maxIntegrity', hull.stats)
      const shield = resolveStat('maxShield', hull.stats)
      const effective = Math.round(integrity + shield)

      // Only cards that make the claim are held to it; a card may describe a hull
      // without quoting this particular number.
      if (!/effective health/i.test(def.effect)) continue
      expect(
        def.effect,
        `${def.id} quotes effective health for ${hullId}, which is ${effective}`,
      ).toContain(String(effective))
    }
  })

  it('does not promise a stat the hull it grants has no modifier for', () => {
    // The other half of the Surety failure: a card can be wrong by naming a stat that
    // is not there at all, which no number check catches. Only `projectileDamage` is
    // spelled out here because it is the one that actually went stale, and guessing at
    // prose for the rest would produce false positives on flavour.
    for (const def of CERTIFICATIONS) {
      for (const grant of def.grants) {
        if (grant.slice !== 'hulls') continue
        const hull = HULLS[grant.id]
        if (!hull) continue
        const touchesDamage = hull.stats.some((m) => m.stat === 'projectileDamage')
        if (touchesDamage) continue
        expect(
          /\bdamage\b/i.test(def.effect),
          `${def.id} mentions damage but ${grant.id} has no projectileDamage modifier`,
        ).toBe(false)
      }
    }
  })

  it('gives every certification at least one pool effect and non-empty copy', () => {
    for (const def of CERTIFICATIONS) {
      expect(def.grants.length, `${def.id} grants nothing`).toBeGreaterThan(0)
      expect(def.effect.trim().length, `${def.id} has no effect text`).toBeGreaterThan(0)
      expect(def.name.trim().length).toBeGreaterThan(0)
    }
  })

  /**
   * Slices the run actually draws from `poolFor(...)` today.
   *
   * THIS LIST, NOT "DOES THE ID EXIST", is what decides whether a grant is live, and
   * the distinction only started to matter with M5. Before it, a pending grant was
   * always pending because the content had not been written. Now the hulls, the boss
   * variants and the hazards all ship and are still not gated:
   *
   *   - `hulls` reaches the pool, but `src/main.ts` issues `pool.hulls[0]`, which is
   *     always the Lien because the base pool is always first. No hull selection
   *     screen exists, so a granted hull is never issued.
   *   - `bossVariants`: `pickVariant` reads `BossDef.variants` directly.
   *   - `hazards`: armed from the stage definition, never from a pool.
   *   - `items` and `enemies` are handed to the sim as whole tables.
   *
   * A grant on an ungated slice does nothing, so its card must say so — otherwise
   * the hangar advertises a reward the game will not hand over. Wiring one of these
   * up means moving it into this list and watching the `awaiting` assertions below
   * demand that the copy be corrected in the same change.
   */
  const POOL_SLICES_HONOURED: readonly PoolSlice[] = ['workOrders']

  /** Does the id resolve to something in a shipped content table? */
  function grantExists(grant: { slice: PoolSlice; id: string }): boolean {
    switch (grant.slice) {
      case 'workOrders':
        return Object.hasOwn(WORK_ORDERS, grant.id)
      case 'items':
        return Object.hasOwn(ITEMS, grant.id)
      case 'enemies':
        return Object.hasOwn(ENEMIES, grant.id)
      case 'hulls':
        return Object.hasOwn(HULLS, grant.id)
      case 'bossVariants':
        return Object.values(BOSSES).some((boss) => (boss.variants ?? []).some((v) => v.id === grant.id))
      case 'hazards':
        return Object.hasOwn(HAZARDS, grant.id)
    }
  }

  it('makes every grant either live or honestly pending', () => {
    // The check that stops the hangar advertising a reward it cannot hand over. A
    // grant is live when the id exists in a shipped table AND the run draws that
    // slice from the pool; anything else has to name what it waits on.
    for (const def of CERTIFICATIONS) {
      const live = def.grants.every(
        (grant) => POOL_SLICES_HONOURED.includes(grant.slice) && grantExists(grant),
      )
      if (live) {
        expect(def.awaiting, `${def.id} is live and should not claim to be pending`).toBeNull()
      } else {
        expect(def.awaiting, `${def.id} grants content the player cannot reach yet`).not.toBeNull()
        expect((def.awaiting ?? '').trim().length).toBeGreaterThan(0)
      }
    }
  })

  it('never says it is waiting for content that has already shipped', () => {
    // The failure that motivated this: four cards read "the hull roster (M5)" and
    // "the sector-five boss (M5)" after both shipped. Copy that describes a past
    // state of the repository is worse than no copy — it tells a player who has
    // earned something that it does not exist.
    const shipped: ReadonlyArray<readonly [string, RegExp]> = [
      ['the hull roster', /hull roster/i],
      ['the elite/sector rosters', /sector-(two|five) (roster|boss)/i],
      ['sector hazards', /^sector hazards/i],
    ]
    for (const def of CERTIFICATIONS) {
      const awaiting = def.awaiting
      if (awaiting === null) continue
      for (const [label, pattern] of shipped) {
        expect(pattern.test(awaiting), `${def.id} still awaits "${label}", which shipped`).toBe(false)
      }
    }
  })

  it('grants a hull that exists, never an id that resolves to nothing', () => {
    // THE DANGLING REFERENCE THIS PINS: the roster granted `writ`, which is not in
    // `HULLS` — it is in `HULLS_AWAITING_MECHANICS`, blocked on a player-triggered
    // phase state that `InputSnapshot` has no room for. `getHull('writ')` throws, and
    // the only reason nothing crashed is that the app never reads past
    // `pool.hulls[0]`. A grant masked by a second defect fails the day the second
    // defect is fixed, which is the worst possible time to find it.
    const awaitingIds = new Set(HULLS_AWAITING_MECHANICS.map((entry) => entry.id))
    for (const def of CERTIFICATIONS) {
      for (const grant of def.grants) {
        if (grant.slice !== 'hulls') continue
        expect(Object.hasOwn(HULLS, grant.id), `${def.id} grants unknown hull "${grant.id}"`).toBe(true)
        expect(
          awaitingIds.has(grant.id),
          `${def.id} grants "${grant.id}", which hulls.ts says has no mechanics yet`,
        ).toBe(false)
      }
    }
  })

  it('leaves no shipped hull unreachable', () => {
    // `HULLS_PENDING_POOL_PLACEMENT` recorded three hulls — surety, probate,
    // collateral — that were authored, tuned, tested and in no pool at all. That is
    // the same class of defect as an item with `weight: 0`: content that exists only
    // in the source. Asserted over `HULLS` rather than over that list, so a SIXTH
    // hull added tomorrow fails here instead of quietly joining them.
    const granted = new Set<string>(BASE_POOL.hulls)
    for (const def of CERTIFICATIONS) {
      for (const grant of def.grants) if (grant.slice === 'hulls') granted.add(grant.id)
    }
    for (const id of Object.keys(HULLS)) {
      expect(granted.has(id), `hull "${id}" is in no pool and no certification grants it`).toBe(true)
    }
  })

  it('gives each hull exactly one way in', () => {
    // Two certifications granting the same hull would make one of them a no-op
    // whenever the other was already filed, and nothing on either card would say so.
    const seen = new Map<string, string>()
    for (const def of CERTIFICATIONS) {
      for (const grant of def.grants) {
        if (grant.slice !== 'hulls') continue
        const owner = seen.get(grant.id)
        expect(owner, `${def.id} and ${owner} both grant "${grant.id}"`).toBeUndefined()
        seen.set(grant.id, def.id)
      }
    }
  })

  it('never grants an id the base pool already contains', () => {
    // A grant of something already in the pool is a certification that does nothing,
    // which is worse than a pending one: nothing on the card would say so.
    for (const def of CERTIFICATIONS) {
      for (const grant of def.grants) {
        expect(
          BASE_POOL[grant.slice],
          `${def.id} grants "${grant.id}", already in the base ${grant.slice} pool`,
        ).not.toContain(grant.id)
      }
    }
  })

  it('has at least one grant that is live today', () => {
    // Otherwise the whole feature is a promise. Two work-order kinds are real now.
    const liveGrants = CERTIFICATIONS.filter((def) => def.awaiting === null)
    expect(liveGrants.length).toBeGreaterThan(0)
  })

  it('resolves a known id and throws on an unknown one', () => {
    expect(getCertification('vault-clearance').name).toBe('Vault Clearance')
    expect(() => getCertification('nope')).toThrow(/Unknown certification/)
    // The prototype-pollution shape `getEnemy` shipped once.
    expect(() => getCertification('constructor')).toThrow(/Unknown certification/)
  })
})

describe('unlock evaluation is a pure function of a run summary', () => {
  it('returns the same result for the same input, every time', () => {
    const run = summary({ waveIndex: 22, kills: 120, scrapHeld: 640, systemsFitted: 3 })
    const first = evaluateRun(run, NONE_UNLOCKED)
    for (let i = 0; i < 5; i++) {
      expect(evaluateRun(run, NONE_UNLOCKED)).toEqual(first)
    }
    expect(first.length).toBeGreaterThan(0)
  })

  it('does not mutate the summary or the held set', () => {
    const run = summary({ waveIndex: 22 })
    const snapshot = JSON.stringify(run)
    const held = new Set<string>(['vault-clearance'])
    evaluateRun(run, held)
    expect(JSON.stringify(run)).toBe(snapshot)
    expect([...held]).toEqual(['vault-clearance'])
  })

  it('never re-files something already held', () => {
    const run = summary({ waveIndex: 30 })
    expect(evaluateRun(run, NONE_UNLOCKED)).toContain('vault-clearance')
    expect(evaluateRun(run, new Set(['vault-clearance']))).not.toContain('vault-clearance')
  })

  it('returns roster order, not set order', () => {
    // The incident report lists these; a reshuffle between two renders of the same
    // death would read as a bug.
    const run = summary({ waveIndex: 30, kills: 139, outcome: 'extracted', damageTaken: 0 })
    const filed = evaluateRun(run, NONE_UNLOCKED)
    const positions = filed.map((id) => CERTIFICATION_IDS.indexOf(id))
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  it("leaves fileRun's inputs untouched and reports what it granted", () => {
    const state = { unlocked: [] as readonly string[], progress: {} as Record<string, number> }
    const run = summary({ waveIndex: 18 })
    const result = fileRun(run, state)
    expect(result.newlyUnlocked).toContain('vault-clearance')
    expect(state.unlocked).toEqual([])
    expect(state.progress).toEqual({})
    // Filing the same run twice grants nothing the second time.
    expect(fileRun(run, result.state).newlyUnlocked).toEqual([])
  })
})

describe('every condition is reachable', () => {
  it('can be satisfied by a constructible sortie', () => {
    for (const def of CERTIFICATIONS) {
      const run = satisfying(def.condition)
      expect(conditionMet(def.condition, run), `${def.id} is unreachable`).toBe(true)
      expect(evaluateRun(run, NONE_UNLOCKED), `${def.id} was not filed`).toContain(def.id)
    }
  })

  it("is reachable within sector 1's actual limits", () => {
    // A condition can be satisfiable in the abstract and impossible in the game. These
    // are the ceilings the thresholds were chosen against, from
    // `src/content/sectors.ts` and the sweeps recorded in `docs/ROADMAP.md`.
    const SECTOR_WAVES = 30
    const SECTOR_ENEMIES = 139
    const SECTOR_SCRAP = 800
    /** Item rewards at waves 7 and 20, shops at 13 and 24. */
    const FITTING_OPPORTUNITIES = 4
    /** Declared interactions in `src/content/interactions.ts`. */
    const DECLARED_INTERACTIONS = 7

    for (const def of CERTIFICATIONS) {
      const condition = def.condition
      switch (condition.kind) {
        case 'wavesReached':
        case 'bareHull':
          expect(condition.waves, `${def.id} asks for more waves than exist`).toBeLessThanOrEqual(
            SECTOR_WAVES,
          )
          break
        case 'killsInRun':
          expect(condition.kills, `${def.id} asks for more kills than spawn`).toBeLessThanOrEqual(
            SECTOR_ENEMIES,
          )
          break
        case 'scrapHeld':
          expect(condition.scrap, `${def.id} asks for more scrap than pays out`).toBeLessThanOrEqual(
            SECTOR_SCRAP,
          )
          break
        case 'systemsFitted':
          expect(
            condition.systems,
            `${def.id} asks for more systems than a run can fit`,
          ).toBeLessThanOrEqual(FITTING_OPPORTUNITIES)
          break
        case 'combinationsLive':
          expect(condition.combinations).toBeLessThanOrEqual(DECLARED_INTERACTIONS)
          break
        case 'accuracy':
          // The held-trigger ceiling: 5,622 spawned HP at 4 damage is 1,406 hits
          // against 3,760 shots in a ~188 s run, about 37%.
          expect(condition.percent, `${def.id} is above the held-trigger ceiling`).toBeLessThan(37)
          break
        case 'lostTo':
          expect(Object.hasOwn(ENEMIES, condition.enemyId), `${def.id} names no real enemy`).toBe(
            true,
          )
          break
        case 'cleanExtraction':
          // Zero would forbid a single graze across 139 enemies. See the note on the
          // certification itself.
          expect(condition.damage, `${def.id} is unreachable at zero damage`).toBeGreaterThan(0)
          break
        case 'extracted':
          break
      }
    }
  })
})

describe('nothing unlocks from a run that achieved nothing', () => {
  it('files no certification for a zero summary', () => {
    expect(evaluateRun(EMPTY_RUN_SUMMARY, NONE_UNLOCKED)).toEqual([])
    for (const def of CERTIFICATIONS) {
      expect(conditionMet(def.condition, EMPTY_RUN_SUMMARY), `${def.id} fired on nothing`).toBe(
        false,
      )
    }
  })

  it('files nothing for a run that died on tick one', () => {
    const instantLoss = summary({ outcome: 'lost', waveIndex: 1, damageTaken: 140 })
    expect(evaluateRun(instantLoss, NONE_UNLOCKED)).toEqual([])
  })

  it('does not let a two-shot run claim the marksman rating', () => {
    // The sample gate: 2 hits from 2 shots is 100% accuracy and must file nothing.
    const lucky = summary({ shotsFired: 2, hits: 2 })
    expect(evaluateRun(lucky, NONE_UNLOCKED)).toEqual([])
    expect(conditionMetric({ kind: 'accuracy', percent: 25, minShots: 500 }, lucky)).toBeNull()
  })

  it('does not let an empty hull claim the austerity endorsement at wave zero', () => {
    // `systemsFitted === 0` is true of every run before its first reward, so the
    // depth half of that condition is what makes it mean anything.
    expect(conditionMet({ kind: 'bareHull', waves: 16 }, summary({ waveIndex: 0 }))).toBe(false)
    expect(conditionMet({ kind: 'bareHull', waves: 16 }, summary({ waveIndex: 16 }))).toBe(true)
    expect(
      conditionMet({ kind: 'bareHull', waves: 16 }, summary({ waveIndex: 16, systemsFitted: 1 })),
    ).toBe(false)
  })

  it('does not file a clean extraction for a clean death', () => {
    const died = summary({ outcome: 'lost', waveIndex: 30, damageTaken: 0 })
    expect(conditionMet({ kind: 'cleanExtraction', damage: 40 }, died)).toBe(false)
  })
})

describe('accuracy display and threshold agree', () => {
  it('files exactly when the printed percent reaches the threshold', () => {
    const condition: UnlockCondition = { kind: 'accuracy', percent: 25, minShots: 500 }
    // 24.6% — rounds to 25 and must NOT file, which is why the metric floors.
    const nearMiss = summary({ shotsFired: 1000, hits: 246 })
    expect(conditionMetric(condition, nearMiss)).toBe(24)
    expect(conditionMet(condition, nearMiss)).toBe(false)

    const exact = summary({ shotsFired: 1000, hits: 250 })
    expect(conditionMetric(condition, exact)).toBe(25)
    expect(conditionMet(condition, exact)).toBe(true)
  })
})

describe('progress', () => {
  it('raises a best and never lowers one', () => {
    const first = mergeProgress({}, summary({ waveIndex: 18 }))
    expect(first['vault-clearance']).toBe(18)
    const second = mergeProgress(first, summary({ waveIndex: 4 }))
    expect(second['vault-clearance']).toBe(18)
    const third = mergeProgress(second, summary({ waveIndex: 27 }))
    expect(third['vault-clearance']).toBe(27)
  })

  it('records nothing for an event condition', () => {
    const merged = mergeProgress({}, summary({ outcome: 'extracted', waveIndex: 30 }))
    expect(merged['extraction-certificate']).toBeUndefined()
    expect(merged['posthumous-data-annex']).toBeUndefined()
    expect(merged['flawless-conduct-citation']).toBeUndefined()
  })

  it('describes progress with a named unit, or not at all', () => {
    for (const def of CERTIFICATIONS) {
      const target = conditionTarget(def.condition)
      const label = describeProgress(def.condition, 3)
      if (target === null) {
        expect(label, `${def.id} invented progress toward an event`).toBeNull()
        continue
      }
      expect(label, `${def.id} has no progress label`).not.toBeNull()
      // Rule 2: "best 3 of 15" could be waves, kills, or credits.
      expect(label).toContain('3')
      expect(label).toContain(String(target))
      expect((label ?? '').replace(/[\d%\s]/g, '').length).toBeGreaterThan(0)
    }
  })

  it('says nothing when no sortie has reported a value', () => {
    expect(describeProgress({ kind: 'wavesReached', waves: 15 }, undefined)).toBeNull()
    expect(describeProgress({ kind: 'wavesReached', waves: 15 }, Number.NaN)).toBeNull()
  })
})

describe('the pool', () => {
  it('is never empty with nothing unlocked', () => {
    const base = poolFor(NONE_UNLOCKED)
    expect(poolSize(base)).toBeGreaterThan(0)
    // The slices with shipped content behind them must all be populated: a purist run
    // has to be playable, and an empty item or enemy pool is not a game.
    for (const slice of ['items', 'enemies', 'workOrders', 'hulls'] as const) {
      expect(base[slice].length, `base ${slice} pool is empty`).toBeGreaterThan(0)
    }
  })

  it('is a strict superset once everything is certified', () => {
    const base = poolFor(NONE_UNLOCKED)
    const full = poolFor(ALL_UNLOCKED)

    for (const slice of POOL_SLICES) {
      for (const id of base[slice]) {
        expect(full[slice], `certifying removed "${id}" from ${slice}`).toContain(id)
      }
    }
    expect(poolSize(full)).toBeGreaterThan(poolSize(base))
    expect(fullPool()).toEqual(full)
  })

  it('grows monotonically, one certification at a time', () => {
    // Additive-only stated as a property rather than trusted from the implementation.
    let previous = poolFor(NONE_UNLOCKED)
    const held = new Set<string>()
    for (const id of CERTIFICATION_IDS) {
      held.add(id)
      const next = poolFor(held)
      expect(poolSize(next)).toBeGreaterThan(poolSize(previous))
      for (const slice of POOL_SLICES) {
        for (const entry of previous[slice]) expect(next[slice]).toContain(entry)
      }
      previous = next
    }
  })

  it('adds exactly what a certification grants and nothing more', () => {
    const base = poolFor(NONE_UNLOCKED)
    for (const def of CERTIFICATIONS) {
      const one = poolFor(new Set([def.id]))
      expect(poolSize(one) - poolSize(base)).toBe(def.grants.length)
      for (const grant of def.grants) expect(one[grant.slice]).toContain(grant.id)
    }
  })

  it('is order-stable, because two players on one seed draw from it', () => {
    // `buildOffers` walks the table's values, so a pool assembled in a different
    // order would hand the same seed different offers.
    const a = poolFor(new Set(['vault-clearance', 'unlisted-clearance']))
    const b = poolFor(new Set(['unlisted-clearance', 'vault-clearance']))
    expect(a).toEqual(b)
    expect(a.workOrders.slice(0, BASE_POOL.workOrders.length)).toEqual([...BASE_POOL.workOrders])
  })

  it('ignores an id it does not know', () => {
    expect(poolFor(new Set(['not-a-certification']))).toEqual(poolFor(NONE_UNLOCKED))
  })

  it('reports every slice, including the ones with no content yet', () => {
    const pool = poolFor(NONE_UNLOCKED)
    for (const slice of POOL_SLICES) expect(Array.isArray(pool[slice as PoolSlice])).toBe(true)
  })
})

describe('grant tags are computed, not authored', () => {
  it('counts grants per slice in a stable order', () => {
    for (const def of CERTIFICATIONS) {
      const counts = grantCounts(def)
      const total = counts.reduce((sum, entry) => sum + entry.count, 0)
      expect(total, `${def.id} tag total disagrees with its grants`).toBe(def.grants.length)
      const order = counts.map((entry) => POOL_SLICES.indexOf(entry.slice))
      expect(order).toEqual([...order].sort((a, b) => a - b))
    }
  })

  it('agrees on number with the noun it prints', () => {
    expect(sliceNoun('items', 1)).toBe('item')
    expect(sliceNoun('items', 2)).toBe('items')
    expect(sliceNoun('workOrders', 1)).toBe('work-order type')
    for (const slice of POOL_SLICES) {
      expect(sliceNoun(slice, 1).length).toBeGreaterThan(0)
      expect(sliceNoun(slice, 3)).not.toBe(sliceNoun(slice, 1))
    }
  })
})

describe('the shape save.ts stores', () => {
  it('defaults to nothing filed', () => {
    expect(DEFAULT_CERTIFICATIONS.unlocked).toEqual([])
    expect(DEFAULT_CERTIFICATIONS.progress).toEqual({})
  })

  it('drops ids this build does not know, keeping the rest', () => {
    // A save written by a build with an eleventh certification must load rather than
    // reset — losing one unlock is recoverable, losing the save is not.
    expect(coerceUnlockedIds(['vault-clearance', 'invented-later', 42, null])).toEqual([
      'vault-clearance',
    ])
    expect(coerceUnlockedIds('not an array')).toEqual([])
    expect(coerceUnlockedIds(undefined)).toEqual([])
  })

  it('de-duplicates and returns roster order, so the payload is stable', () => {
    const a = coerceUnlockedIds(['unlisted-clearance', 'vault-clearance', 'vault-clearance'])
    const b = coerceUnlockedIds(['vault-clearance', 'unlisted-clearance'])
    expect(a).toEqual(b)
    expect(a).toEqual(['vault-clearance', 'unlisted-clearance'])
  })

  it('rejects a hostile progress payload', () => {
    expect(
      coerceProgress({
        'vault-clearance': 12,
        'unlisted-clearance': -5,
        'clearance-commendation': Number.NaN,
        'marksman-rating': '30',
        'invented-later': 99,
      }),
    ).toEqual({ 'vault-clearance': 12 })
    expect(coerceProgress(null)).toEqual({})
    expect(coerceProgress([1, 2, 3])).toEqual({})
  })

  it('floors a fractional best, because the hangar prints whole numbers', () => {
    expect(coerceProgress({ 'vault-clearance': 12.9 })).toEqual({ 'vault-clearance': 12 })
  })

  it('round-trips a filed state through the coercers unchanged', () => {
    const { state } = fileRun(summary({ waveIndex: 30, kills: 139, scrapHeld: 500 }))
    expect(coerceUnlockedIds(state.unlocked)).toEqual(state.unlocked)
    expect(coerceProgress(state.progress)).toEqual(state.progress)
  })

  it('validates ids the way the hangar and the sim both need', () => {
    expect(isCertificationId('vault-clearance')).toBe(true)
    expect(isCertificationId('constructor')).toBe(false)
    expect(isCertificationId(7)).toBe(false)
    expect(unlockedSet(['vault-clearance', 'bogus']).has('vault-clearance')).toBe(true)
    expect(unlockedSet(['bogus']).size).toBe(0)
  })
})

describe('condition prose', () => {
  it('degrades rather than printing "of 0 waves"', () => {
    const text = describeCondition({ kind: 'wavesReached', waves: 15 }, { waveCount: 0 })
    expect(text).not.toContain('of 0')
    expect(text).toContain('15')
  })

  it('uses a display name for an enemy rather than its id', () => {
    const text = describeCondition(
      { kind: 'lostTo', enemyId: 'turret-heavy' },
      { waveCount: WAVE_COUNT, nameFor: (id) => ENEMIES[id]?.name ?? id },
    )
    expect(text).toContain('Heavy Turret')
    expect(text).not.toContain('turret-heavy')
  })
})

describe('summarising is separate from evaluating', () => {
  it('counts distinct systems, not stacks', () => {
    // Three copies of one item must not file `full-manifest-rating`, which asks for
    // three *distinct* systems.
    const stacked = summary({ systemsFitted: 1 })
    expect(conditionMet({ kind: 'systemsFitted', systems: 3 }, stacked)).toBe(false)
  })

  it('treats a defensive certification def as data only', () => {
    // Guards against a future def carrying a function: the roster has to survive
    // JSON.stringify for the stat sweep above to mean anything.
    const clone: readonly CertificationDef[] = JSON.parse(
      JSON.stringify(CERTIFICATIONS),
    ) as CertificationDef[]
    expect(clone).toEqual(CERTIFICATIONS)
  })
})
