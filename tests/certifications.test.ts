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

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BASE_POOL,
  CERTIFICATIONS,
  GRANTS_AWAITING_CONTENT,
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
  MAX_CERTIFICATION_MASK_BYTES,
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
  packCertifications,
  poolFor,
  poolForRun,
  poolSize,
  unpackCertifications,
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

  it('quotes the other hull figures it names: speed and starting scrap', () => {
    /**
     * THE REST OF R12, closed the same way effective health was.
     *
     * Two of the three cards state figures the check above does not read: Arrears' says
     * "+42 speed, 320 cr of scrap" and Surety's says "155 speed". Both are hand-written
     * restatements of `HullDef` data, which is exactly the shape of the defect that
     * shipped three times — the hull is retuned, the card is not, and nothing fails.
     *
     * Read as "if the card names this stat, the number beside it must be one the hull
     * actually resolves to", so a card is still free to describe a hull without
     * quoting either figure. `src/content/hulls.ts` took the stronger route for its own
     * prose and states no figures at all; these cards keep theirs because a hangar
     * entry has no trade table under it to compute them.
     */
    for (const def of CERTIFICATIONS) {
      for (const grant of def.grants) {
        if (grant.slice !== 'hulls') continue
        const hull = HULLS[grant.id]
        if (!hull) continue

        if (/\bspeed\b/i.test(def.effect)) {
          const speed = resolveStat('hullSpeed', hull.stats)
          // The baseline through the same fold rather than a literal 210: a test that
          // restates a tuning number is one more copy to go stale.
          const delta = Math.abs(speed - resolveStat('hullSpeed', []))
          const stated =
            def.effect.includes(String(Math.round(speed))) ||
            def.effect.includes(String(Math.round(delta)))
          expect(
            stated,
            `${def.id} names speed for ${grant.id}, which is ${speed} u/s (${delta} off base)`,
          ).toBe(true)
        }

        if (/\bscrap\b/i.test(def.effect) && hull.startingScrap !== undefined) {
          expect(
            def.effect,
            `${def.id} names scrap for ${grant.id}, which starts with ${hull.startingScrap}`,
          ).toContain(String(hull.startingScrap))
        }
      }
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
   * THIS LIST, NOT "DOES THE ID EXIST", is what decides whether a grant is live.
   * Two slices are wired:
   *
   *   - `workOrders`: the app passes `runPool.workOrders` into `new World(...)` and
   *     `World.maybeOpenChoice` builds the card from it.
   *   - `hulls`: the app passes `runPool.hulls` to `offerHulls` and shows
   *     `src/ui/hullSelect.ts`, then launches on the hull the player picked.
   *
   * Four are not:
   *
   *   - `bossVariants`: `pickVariant` reads `BossDef.variants` directly.
   *   - `hazards`: armed from the stage definition, never from a pool.
   *   - `items` and `enemies` are handed to the sim as whole tables. Those two
   *     additionally cannot ever carry a live grant while `BASE_POOL` derives them
   *     from `Object.keys` — see the header of `src/content/certifications.ts`.
   *
   * THIS LIST WENT STALE ONCE AND THE COST WAS PAID BY THE PLAYER. It said
   * `['workOrders']` for the whole of the milestone in which `src/ui/hullSelect.ts`
   * shipped, so four cards kept `awaiting: 'a hull selection screen'` — the hangar
   * telling a pilot an earned hull could not be flown while the screen that flies it
   * was one keypress away. Worse, the `awaiting` assertion below *required* that
   * string, so the guard was holding the wrong copy in place.
   *
   * A hand-maintained list cannot notice that. So `derives the honoured list from
   * what src/ actually reads` below re-derives it from the source and fails if the
   * two disagree, in either direction.
   */
  const POOL_SLICES_HONOURED: readonly PoolSlice[] = ['workOrders', 'hulls']

  /**
   * The other side of the partition, with the reason each slice is inert.
   *
   * Stated rather than computed as `POOL_SLICES minus honoured`, so that adding a
   * seventh slice is a decision someone has to write a sentence about instead of a
   * default that lands silently on the inert side.
   */
  const POOL_SLICES_INERT: Readonly<Partial<Record<PoolSlice, string>>> = {
    items: 'handed to the sim as the whole ITEMS table; BASE_POOL.items is Object.keys(ITEMS)',
    enemies: 'handed to the sim as whole tables; BASE_POOL.enemies is Object.keys(ENEMIES)',
    bossVariants: 'pickVariant reads BossDef.variants directly, never poolFor(...).bossVariants',
    hazards: 'armed from the stage definition, never drawn from a pool',
  }

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

  /**
   * ---------------------------------------------------------------------------
   * THE GUARD D6 SHOULD HAVE HAD. Four tests, and they are worth more than any of
   * the individual grants they were written to catch.
   *
   * Eight granted ids resolved to nothing in any content table — `tally-turret`,
   * `tally-escort`, `drone-uplink`, `mirror-mount`, `ranging-computer`,
   * `precision-sights`, `turret-siege`, `debris-cascade` — and every one of them
   * typechecked, because `PoolGrant.id` is a `string` and `poolFor` never looks an id
   * up. `fingerprintPool` then hashed the phantoms into the pilot's record. Nothing
   * failed, and nothing would have failed until a slice was wired and `getEnemy`
   * threw on a launch path.
   *
   * `tests/hulls.test.ts` and `tests/bosses.test.ts` each had this check for their own
   * slice, which is exactly why `hulls` and `bossVariants` were clean and the other
   * four were not. Doing it per-table means the table nobody thought about is the one
   * that rots. These are over every slice at once.
   * ---------------------------------------------------------------------------
   */

  it('resolves every granted id to a real entry in the table its slice names', () => {
    const registered = new Set(
      GRANTS_AWAITING_CONTENT.map((entry) => `${entry.slice}/${entry.id}`),
    )
    for (const def of CERTIFICATIONS) {
      for (const grant of def.grants) {
        const key = `${grant.slice}/${grant.id}`
        expect(
          grantExists(grant) || registered.has(key),
          `${def.id} grants "${key}", which no content table answers to and which is ` +
            `not registered in GRANTS_AWAITING_CONTENT. Author the content, delete the ` +
            `grant, or register the id with the reason it cannot exist yet.`,
        ).toBe(true)
      }
    }
  })

  it('keeps the awaiting-content registry from becoming folklore', () => {
    // Both directions, because a registry is only load-bearing if it cannot drift.
    // An entry whose content has since shipped would let a real id sit in the escape
    // hatch forever; an entry no grant names is a note about nothing.
    const granted = new Set(
      CERTIFICATIONS.flatMap((def) => def.grants.map((g) => `${g.slice}/${g.id}`)),
    )
    for (const entry of GRANTS_AWAITING_CONTENT) {
      const key = `${entry.slice}/${entry.id}`
      expect(
        grantExists({ slice: entry.slice, id: entry.id }),
        `${key} is registered as awaiting content but the content SHIPPED — delete the ` +
          `registry entry so the grant is checked against the table like every other one`,
      ).toBe(false)
      expect(granted.has(key), `${key} is registered but no certification grants it`).toBe(true)
      // A vague reason is how a gap becomes folklore, per HULLS_AWAITING_MECHANICS.
      expect(entry.needs.length, `${key} gives no real reason`).toBeGreaterThan(80)
    }
    // And a grant that is dangling must be registered exactly once.
    const keys = GRANTS_AWAITING_CONTENT.map((e) => `${e.slice}/${e.id}`)
    expect(new Set(keys).size, 'duplicate registry entry').toBe(keys.length)
  })

  it('accounts for every pool slice as either honoured or inert, with a reason', () => {
    // POOL_SLICES is a closed list and this is the partition of it. A seventh slice
    // added tomorrow fails here until somebody says which side it is on and why,
    // rather than defaulting to "inert" and taking a grant down with it.
    const honoured = [...POOL_SLICES_HONOURED].sort()
    const inert = Object.keys(POOL_SLICES_INERT).sort()
    expect(
      [...honoured, ...inert].sort(),
      'POOL_SLICES_HONOURED and POOL_SLICES_INERT must partition POOL_SLICES exactly',
    ).toEqual([...POOL_SLICES].sort())
    for (const slice of honoured) {
      expect(inert, `${slice} is listed as both honoured and inert`).not.toContain(slice)
    }
    for (const [slice, reason] of Object.entries(POOL_SLICES_INERT)) {
      expect((reason ?? '').length, `${slice} is inert for no stated reason`).toBeGreaterThan(20)
    }
  })

  it('derives the honoured list from what src/ actually reads, not from this file', () => {
    /**
     * THE ONE THAT WOULD HAVE CAUGHT D4.
     *
     * `POOL_SLICES_HONOURED` is a claim about code in another directory, and every
     * other assertion in this block trusts it. A hand-maintained claim about someone
     * else's file is a claim that goes stale on the day that file improves — which is
     * precisely what happened: `src/ui/hullSelect.ts` shipped, `src/main.ts` started
     * reading `runPool.hulls`, and this list did not move for a whole milestone.
     *
     * So the wired set is re-derived from the source text: any read of `<something
     * pool>.<slice>` outside a comment is a consumer. Anchored on an identifier
     * containing "pool" rather than on any `.hulls`, because `world.enemies` and
     * `world.hazards` are entity arrays and would otherwise read as pool draws.
     *
     * If this fails after an app-layer change, the fix is to move the slice between
     * POOL_SLICES_HONOURED and POOL_SLICES_INERT — and then to correct the `awaiting`
     * copy the assertions above will immediately start demanding.
     */
    const root = fileURLToPath(new URL('../src', import.meta.url))
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(root, name))
    expect(files.length, 'found no source to scan — has src/ moved?').toBeGreaterThan(10)

    const slicePattern = POOL_SLICES.join('|')
    // `\w*[Pp]ool\w*` covers runPool, pool, basePool, fullPool and anything else a
    // future rename produces, without matching `world.hazards`.
    const readPattern = new RegExp(`\\b\\w*[Pp]ool\\w*\\s*\\.\\s*(${slicePattern})\\b`, 'g')
    const wired = new Set<string>()
    const where = new Map<string, string>()
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '')
      for (const match of source.matchAll(readPattern)) {
        const slice = match[1]
        if (slice === undefined) continue
        wired.add(slice)
        if (!where.has(slice)) where.set(slice, file.slice(root.length + 1))
      }
    }

    const claimed = [...POOL_SLICES_HONOURED].sort()
    const actual = [...wired].sort()
    const claimedText: readonly string[] = claimed
    const newlyWired = actual.filter((s) => !claimedText.includes(s))
    const noLongerWired = claimed.filter((s) => !actual.includes(s))
    expect(
      actual,
      newlyWired.length > 0
        ? `src/ now draws ${newlyWired.join(', ')} from the pool (see ` +
            `${newlyWired.map((s) => where.get(s)).join(', ')}) but POOL_SLICES_HONOURED ` +
            `does not list ${newlyWired.length === 1 ? 'it' : 'them'}. Grants on ` +
            `${newlyWired.join(', ')} are LIVE and their cards must stop saying pending.`
        : `POOL_SLICES_HONOURED claims ${noLongerWired.join(', ')} is drawn from the pool ` +
            `and no file under src/ reads it. Those grants are inert and their cards must say so.`,
    ).toEqual(claimed)
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

/**
 * THE POOL AND THE IDS THAT PRODUCED IT COME OUT OF ONE CALL.
 *
 * A run that draws from a pool has to record which grants widened it, or the replay
 * cannot be rebuilt (`Replay.certifications`). Two calls are two chances to build from
 * one set and file another, and a record that names the wrong pool is worse than one
 * that names none: it is checkable, and it is wrong.
 */
describe('the pool a sortie flies', () => {
  it('returns the pool and the exact ids it was built from', () => {
    const chosen = poolForRun(['vault-clearance'])
    expect(chosen.certifications).toEqual(['vault-clearance'])
    expect(chosen.pool).toEqual(poolFor(new Set(['vault-clearance'])))
  })

  it('normalises the ids the same way the save and the wire format do', () => {
    // Roster order, de-duplicated, unknowns dropped — so "what was recorded" and "what
    // the run used" are the same list rather than two spellings of one.
    const messy = ['unlisted-clearance', 'not-a-certification', 'vault-clearance', 'vault-clearance']
    const chosen = poolForRun(messy)
    expect(chosen.certifications).toEqual(coerceUnlockedIds(messy))
    expect(chosen.certifications).toEqual(['vault-clearance', 'unlisted-clearance'])
    expect(chosen.pool).toEqual(poolFor(new Set(chosen.certifications)))
  })

  it('is the base pool for no ids, which is what purist means', () => {
    const chosen = poolForRun([])
    expect(chosen.certifications).toEqual([])
    expect(chosen.pool).toEqual(poolFor(NONE_UNLOCKED))
  })

  it('never files a pool it did not build', () => {
    // The property that makes the pairing worth having, over every subset size the
    // roster can produce.
    for (let cut = 0; cut <= CERTIFICATION_IDS.length; cut++) {
      const ids = CERTIFICATION_IDS.slice(0, cut)
      const chosen = poolForRun(ids)
      expect(chosen.pool, `${cut} certifications`).toEqual(poolFor(new Set(chosen.certifications)))
    }
  })
})

/**
 * THE POOL ON THE WIRE.
 *
 * A replay carries the certified pool as a bitmask over `CERTIFICATION_IDS`, which
 * makes the ORDER OF THE ROSTER part of the wire format: reordering `CERTIFICATIONS`
 * would silently reinterpret every recorded replay, with no decode error and no
 * symptom except a run that plays differently. Nothing else in the codebase would
 * notice, so it is pinned here id by id.
 */
describe('the certification bitmask', () => {
  it('assigns each certification a fixed bit, and this list is the wire format', () => {
    // NOT derived from CERTIFICATION_IDS — a test that recomputes the thing it is
    // checking cannot fail. If a roster change makes this list wrong, the change has
    // invalidated every recorded replay and the fix is a REPLAY_FORMAT_VERSION bump,
    // not an edit to this array.
    expect([...CERTIFICATION_IDS]).toEqual([
      'vault-clearance',
      'unlisted-clearance',
      'full-manifest-rating',
      'combination-endorsement',
      'austerity-endorsement',
      'marksman-rating',
      'clearance-commendation',
      'posthumous-data-annex',
      'extraction-certificate',
      'flawless-conduct-citation',
    ])
    expect([...packCertifications(['vault-clearance'])]).toEqual([0b0000_0001])
    expect([...packCertifications(['unlisted-clearance'])]).toEqual([0b0000_0010])
    expect([...packCertifications(['extraction-certificate'])]).toEqual([0x00, 0b0000_0001])
    expect([...packCertifications(['flawless-conduct-citation'])]).toEqual([0x00, 0b0000_0010])
  })

  it('round-trips every subset of the roster', () => {
    // 2^10 = 1,024 subsets. Exhaustive is cheap, and a bit-order bug that only shows
    // up on one combination is exactly what a sample would miss.
    const total = 1 << CERTIFICATION_IDS.length
    for (let bits = 0; bits < total; bits++) {
      const ids = CERTIFICATION_IDS.filter((_, index) => (bits & (1 << index)) !== 0)
      expect(unpackCertifications(packCertifications(ids)), `subset ${bits}`).toEqual(ids)
    }
  })

  it('costs nothing for a base-pool run', () => {
    // Trailing zero bytes are trimmed, so purist runs and every sim test recording pay
    // one length byte in a payload measured against a 2,000-character URL.
    expect(packCertifications([]).length).toBe(0)
    expect(unpackCertifications(new Uint8Array(0))).toEqual([])
    expect(unpackCertifications(new Uint8Array([0, 0, 0]))).toEqual([])
  })

  it('encodes a set, not a sequence', () => {
    const shuffled = ['marksman-rating', 'vault-clearance', 'marksman-rating']
    expect([...packCertifications(shuffled)]).toEqual([
      ...packCertifications(['vault-clearance', 'marksman-rating']),
    ])
    expect(unpackCertifications(packCertifications(shuffled))).toEqual([
      'vault-clearance',
      'marksman-rating',
    ])
  })

  it('drops an id it does not know on the way out', () => {
    // Same rule as `coerceUnlockedIds`: there is no bit to set, so there is nothing to
    // write. The refusal belongs on the way IN, where a set bit means a grant that
    // cannot be rebuilt.
    expect([...packCertifications(['not-a-certification'])]).toEqual([])
  })

  it('refuses a mask naming a certification this build does not have', () => {
    // A replay from a build with an eleventh certification. Not corruption — but the
    // mask is positional, so this build cannot name the grant, cannot rebuild the
    // pool, and must not play the run without it and call it the same run.
    const beyond = CERTIFICATION_IDS.length
    const mask = new Uint8Array(Math.floor(beyond / 8) + 1)
    mask[beyond >> 3] = 1 << (beyond & 7)
    expect(unpackCertifications(mask)).toBeNull()
  })

  it('bounds the mask so a length field cannot allocate a run', () => {
    expect(MAX_CERTIFICATION_MASK_BYTES * 8).toBeGreaterThanOrEqual(CERTIFICATION_IDS.length)
    expect(packCertifications(CERTIFICATION_IDS).length).toBeLessThanOrEqual(
      MAX_CERTIFICATION_MASK_BYTES,
    )
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
