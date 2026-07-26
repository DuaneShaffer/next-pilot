import { describe, expect, it } from 'vitest'
import {
  HULLS,
  HULLS_AWAITING_MECHANICS,
  HULLS_PENDING_POOL_PLACEMENT,
  HULL_ORDER,
  LIEN_ID,
  getHull,
} from '../src/content/hulls'
import { ITEMS } from '../src/content/items'
import { BASE_POOL, CERTIFICATIONS } from '../src/content/certifications'
import { STATS, resolveStat, shotsPerSecond } from '../src/sim/stats'
import type { HullDef, StatKey, StatModifier } from '../src/content/types'

/**
 * Hull content integrity.
 *
 * The rule this file exists to enforce is the one `docs/DESIGN.md` states and that
 * nothing else can check: **a hull is defined by a drawback that shapes play**. A
 * strictly-worse hull is one nobody picks; a strictly-better one makes the rest
 * decoration. TypeScript can confirm a modifier names a real `StatKey`. Only a test
 * can confirm the modifier moves the number, that it moves it in both directions
 * across the hull, that the sentence on the selection card names it, and that the
 * result is still a flyable ship.
 *
 * Every assertion here corresponds to a defect that would otherwise ship silently and
 * be undetectable from inside the game:
 *
 * - A hull with only upsides is the hull everyone takes, and the other four become a
 *   loading screen with buttons on it.
 * - A modifier the stat bounds swallow reads correctly on the card and does nothing.
 * - A hull that floors fire rate or speed is not a trade-off, it is a broken build the
 *   player chose on purpose because the card made it sound clever.
 * - A mechanism line with no numbers is flavour wearing a mechanism's clothes —
 *   `docs/UI.md` rule 4.
 *
 * MUTATION-VERIFIED. Each test named below was confirmed to fail against a deliberate
 * break of the content, and the content reverted:
 *
 *   "gives every hull other than Lien at least one cost and one upside"
 *        — flipping Collateral's -40 shield to +40 fails it.
 *   "keeps Lien at the stat table's bases with no modifiers of any kind"
 *        — adding a single modifier to Lien fails it.
 *   "never applies a modifier that the stat bounds turn into a no-op"
 *        — Probate's mul 0.72 changed to 1.0 fails it.
 *   "leaves every stat inside the range that keeps a hull flyable"
 *        — Surety's -55 hull speed deepened to -120 fails it.
 *   "states every number it applies in the mechanism, not the flavour"
 *        — changing Arrears' +42 speed to +40 without editing the text fails it.
 *   "names every starting item it grants in the mechanism line"
 *        — removing "Repair Nanites" from Probate's text fails it.
 */

const hullEntries: [string, HullDef][] = Object.entries(HULLS)

/**
 * Stats whose floor is a *failure state* rather than a legitimate build, with the
 * value below (or above, for a cooldown) which a hull has stopped being a trade-off.
 *
 * `maxShield` is deliberately absent, and that absence is the interesting part.
 * Zero shield is not broken — it is the game M1 shipped, and Collateral is built on
 * it. Zero *integrity* is a hull that dies to its first hit and one-tick fire is a
 * divide-by-zero waiting to happen, which is why those two have floors here even
 * though `src/sim/stats.ts` already clamps them somewhere lower.
 */
const USABLE_RANGE: Partial<Record<StatKey, { min?: number; max?: number }>> = {
  // 12 ticks is 5 shots/second, a quarter of baseline. Below that the weapon has
  // stopped being a weapon whatever the damage per shot says.
  fireIntervalTicks: { max: 12 },
  projectileDamage: { min: 2 },
  projectileSpeed: { min: 300 },
  projectilesPerShot: { min: 1 },
  // 140 u/s still out-runs the fastest sector-1 projectile (130 u/s). A hull slower
  // than the bullets cannot dodge, only pre-position, and that is not a trade-off.
  hullSpeed: { min: 140 },
  maxIntegrity: { min: 40 },
  scrapMultiplier: { min: 0.5 },
  pickupRadius: { min: 16 },
  focusFactor: { min: 0.2 },
}

/**
 * The eight hulls `docs/DESIGN.md` specifies, by name.
 *
 * Restated here so the roster cannot quietly shrink: a hull that turns out to be
 * inexpressible must move to `HULLS_AWAITING_MECHANICS` with a reason, not vanish.
 */
const DESIGNED_HULL_NAMES: readonly string[] = [
  'Lien',
  'Arrears',
  'Surety',
  'Escrow',
  'Probate',
  'Indemnity',
  'Writ',
  'Collateral',
]

/**
 * Fold modifiers exactly as `resolveStat` does but WITHOUT the final clamp.
 *
 * The clamp is what hides an over-written modifier: `maxShield -60` on a base of 40
 * resolves to 0 and looks identical to `-40`, so twenty of the sixty points are
 * silently discarded and the card's arithmetic stops matching the game's.
 */
function rawResolve(stat: StatKey, modifiers: readonly StatModifier[]): number {
  let value = STATS[stat].base
  for (const m of modifiers) if (m.stat === stat && m.kind === 'add') value += m.value
  for (const m of modifiers) if (m.stat === stat && m.kind === 'mul') value *= m.value
  return value
}

/** Render a number the way hull text does, so string matching lines up. */
function numeral(value: number): string {
  return String(Number(value.toFixed(2)))
}

/**
 * Numbers a modifier could honestly be described by: the delta, or the value it
 * resolves to from the base. Both are accepted for the same reason `items.test.ts`
 * accepts both — "+42 hull speed" and "210 to 252" are both good writing, and
 * forcing one would make the test an opinion about prose.
 */
function salientNumbers(modifier: StatModifier): string[] {
  const spec = STATS[modifier.stat]
  if (modifier.kind === 'add') {
    return [numeral(Math.abs(modifier.value)), numeral(spec.base + modifier.value)]
  }
  return [
    numeral(Math.abs(Math.round((modifier.value - 1) * 100))),
    numeral(spec.base * modifier.value),
    numeral(modifier.value),
  ]
}

/** Split a hull's touched stats into those it improves and those it costs. */
function directions(def: HullDef): { better: StatKey[]; worse: StatKey[] } {
  const better: StatKey[] = []
  const worse: StatKey[] = []
  for (const stat of new Set(def.stats.map((m) => m.stat))) {
    const spec = STATS[stat]
    const resolved = resolveStat(stat, def.stats)
    if (resolved === spec.base) continue
    const improved = spec.lowerIsBetter === true ? resolved < spec.base : resolved > spec.base
    if (improved) better.push(stat)
    else worse.push(stat)
  }
  return { better, worse }
}

describe('hull registry', () => {
  it('ships a roster big enough for the three-offer selection screen', () => {
    // `docs/DESIGN.md`: three hulls are offered per run and Lien is always one of
    // them. Fewer than four and the other two slots cannot vary at all, which makes
    // the selection screen a formality.
    expect(hullEntries.length).toBeGreaterThanOrEqual(4)
  })

  it('keys match the id on each definition', () => {
    // Certifications grant hulls by id and saves persist them by id. A key that
    // disagrees with its `id` makes a grant silently unresolvable.
    for (const [key, def] of hullEntries) expect(def.id, key).toBe(key)
  })

  it('gives every hull a distinct name', () => {
    const names = hullEntries.map(([, def]) => def.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('orders exactly the hulls that exist, once each', () => {
    // HULL_ORDER drives the hangar listing. An id in the roster but not the order is
    // a hull the player never sees listed; the reverse renders an empty card.
    expect([...HULL_ORDER].sort()).toEqual(hullEntries.map(([key]) => key).sort())
    expect(new Set(HULL_ORDER).size).toBe(HULL_ORDER.length)
    expect(HULL_ORDER[0]).toBe(LIEN_ID)
  })

  it('accounts for all eight hulls the design specifies', () => {
    // THE ROSTER GUARD. Three of the eight are not expressible yet and are recorded
    // in HULLS_AWAITING_MECHANICS rather than dropped. This asserts the two lists
    // still add up to the design, so a hull cannot disappear by being quietly
    // forgotten — only by being moved to the list that says what it is waiting for.
    const shipped = hullEntries.map(([, def]) => def.name)
    const deferred = HULLS_AWAITING_MECHANICS.map((entry) => entry.name)
    expect([...shipped, ...deferred].sort()).toEqual([...DESIGNED_HULL_NAMES].sort())
  })

  it('says what each deferred hull is waiting for, and does not also ship it', () => {
    // A deferred entry with a vague reason is how a gap becomes folklore. The length
    // floor is crude and it is enough: "needs work" does not clear it.
    for (const entry of HULLS_AWAITING_MECHANICS) {
      expect(Object.hasOwn(HULLS, entry.id), `${entry.id} is both shipped and deferred`).toBe(false)
      expect(entry.needs.length, entry.id).toBeGreaterThan(80)
    }
  })
})

describe('the anti-strictly-better rule', () => {
  it('gives every hull other than Lien at least one cost and one upside', () => {
    // THE LOAD-BEARING TEST, and it is structural rather than a reviewer's opinion:
    // each touched stat is resolved through the real stat table and signed with that
    // table's own `lowerIsBetter` flag, so "better" means what the HUD will mean by
    // it. A hull with only upsides is the hull everyone takes and the roster
    // collapses to one entry; a hull with only costs is one nobody takes and the
    // selection screen is offering the player a dead slot.
    for (const [key, def] of hullEntries) {
      if (key === LIEN_ID) continue
      const { better, worse } = directions(def)
      expect(better, `${key} has no upside`).not.toEqual([])
      expect(worse, `${key} has no cost`).not.toEqual([])
    }
  })

  it('keeps Lien at the stat table bases with no modifiers of any kind', () => {
    // Lien is the "before" every other hull's mechanism line quotes, and the ship the
    // whole content set is tuned against — 140 effective health, 80 dps. One modifier
    // here and `enemies.ts` and `items.ts` are tuned against a hull nobody flies.
    const lien = getHull(LIEN_ID)
    expect(lien.stats).toEqual([])
    expect(lien.effects ?? []).toEqual([])
    expect(lien.startingItems ?? []).toEqual([])
    expect(lien.startingScrap ?? 0).toBe(0)
  })

  it('describes Lien with the live values from the stat table', () => {
    // Ties the sentence to the data. If someone retunes the base hull speed, this
    // fails rather than leaving a card that confidently states the old number.
    const lien = getHull(LIEN_ID)
    for (const stat of ['maxIntegrity', 'maxShield', 'hullSpeed', 'projectileDamage'] as const) {
      expect(lien.mechanism, stat).toContain(numeral(STATS[stat].base))
    }
    expect(lien.mechanism).toContain(numeral(shotsPerSecond(STATS.fireIntervalTicks.base)))
  })
})

describe('stat modifiers', () => {
  it('only names stats that exist in the stat table', () => {
    for (const [key, def] of hullEntries) {
      for (const m of def.stats) {
        expect(Object.hasOwn(STATS, m.stat), `${key}: ${m.stat}`).toBe(true)
      }
    }
  })

  it('never applies a modifier that the stat bounds turn into a no-op', () => {
    // Both halves matter. Per modifier catches an `add` onto a stat already at its
    // bound; per stat catches two modifiers on one stat that cancel out — a +10 and a
    // x0.9 that resolve straight back to base, which no single-modifier check sees.
    for (const [key, def] of hullEntries) {
      for (const m of def.stats) {
        const label = `${key}: ${m.stat} ${m.kind} ${m.value}`
        expect(resolveStat(m.stat, [m]), label).not.toBe(STATS[m.stat].base)
      }
      for (const stat of new Set(def.stats.map((m) => m.stat))) {
        expect(resolveStat(stat, def.stats), `${key}: ${stat}`).not.toBe(STATS[stat].base)
      }
    }
  })

  it('never writes a modifier the clamp silently discards part of', () => {
    // Distinct from the no-op check above and just as invisible: `maxShield -60` on a
    // base of 40 resolves to 0 exactly like `-40` does, so twenty points of authored
    // intent vanish and the mechanism line's arithmetic stops matching the game's.
    for (const [key, def] of hullEntries) {
      for (const stat of new Set(def.stats.map((m) => m.stat))) {
        const raw = rawResolve(stat, def.stats)
        const spec = STATS[stat]
        expect(raw, `${key}: ${stat} folds to ${raw}, below the ${spec.min} floor`).toBeGreaterThanOrEqual(spec.min)
        expect(raw, `${key}: ${stat} folds to ${raw}, above the ${spec.max} ceiling`).toBeLessThanOrEqual(spec.max)
      }
    }
  })

  it('leaves every stat inside the range that keeps a hull flyable', () => {
    // A hull that floors fire rate or halves hull speed below the bullets is a broken
    // hull, not a trade-off — and the player cannot know that from the card, because
    // the card is accurate. The bounds in `stats.ts` stop a stack of items reaching
    // an absurd value; this stops a single hull *starting* there.
    for (const [key, def] of hullEntries) {
      for (const stat of new Set(def.stats.map((m) => m.stat))) {
        const range = USABLE_RANGE[stat]
        if (range === undefined) continue
        const resolved = resolveStat(stat, def.stats)
        if (range.min !== undefined) {
          expect(resolved, `${key}: ${stat} = ${resolved}`).toBeGreaterThanOrEqual(range.min)
        }
        if (range.max !== undefined) {
          expect(resolved, `${key}: ${stat} = ${resolved}`).toBeLessThanOrEqual(range.max)
        }
      }
    }
  })

  it('modifies fireIntervalTicks only by whole-tick additions', () => {
    // The weapon cooldown is counted in whole ticks, so a fractional interval rounds
    // back to where it started: `mul 0.85` on a base of 3 is 2.55 and fires on
    // exactly the same tick as 3. Collateral's -1 is the roster's only fire-rate
    // modifier and it is an integer add for this reason. `items.ts` documents the
    // same trap; a hull is a more expensive place to fall into it, because the player
    // commits to a hull for a whole run.
    for (const [key, def] of hullEntries) {
      for (const m of def.stats) {
        if (m.stat !== 'fireIntervalTicks') continue
        expect(m.kind, `${key}: fireIntervalTicks must not use mul`).toBe('add')
        expect(Number.isInteger(m.value), `${key}: ${m.value}`).toBe(true)
      }
    }
  })
})

describe('mechanism text — UI.md rule 4', () => {
  it('states every hull mechanism with at least one digit', () => {
    // The rule 4 check. A hull card read under time pressure has to answer "what am I
    // flying", and a mood does not answer it.
    for (const [key, def] of hullEntries) expect(def.mechanism, key).toMatch(/\d/)
  })

  it('never leaves a mechanism empty or fragmentary', () => {
    for (const [key, def] of hullEntries) {
      const text = def.mechanism.trim()
      expect(text.length, key).toBeGreaterThanOrEqual(40)
      expect(text.endsWith('.'), key).toBe(true)
      expect(text[0], key).toBe(text[0]?.toUpperCase())
    }
  })

  it('states every number it applies in the mechanism, not the flavour', () => {
    // Only ever reads `mechanism`, which is what makes "flavour is never
    // load-bearing" enforceable rather than aspirational.
    for (const [key, def] of hullEntries) {
      for (const m of def.stats) {
        const stated = salientNumbers(m).some((n) => def.mechanism.includes(n))
        expect(stated, `${key}: ${m.stat} ${m.kind} ${m.value}`).toBe(true)
      }
      if (def.startingScrap !== undefined) {
        expect(def.mechanism, `${key}: startingScrap`).toContain(numeral(def.startingScrap))
      }
    }
  })

  it('keeps numbers out of the flavour line entirely', () => {
    for (const [key, def] of hullEntries) {
      if (def.flavour === undefined) continue
      expect(def.flavour.trim().length, key).toBeGreaterThan(0)
      expect(def.flavour, key).not.toMatch(/\d/)
    }
  })

  it('names every starting item it grants in the mechanism line', () => {
    // A hull that hands over a relic without saying which one is asking the player to
    // pick blind, and the name is read out of `ITEMS` rather than restated here so it
    // cannot drift out of sync with the item roster.
    for (const [key, def] of hullEntries) {
      for (const id of def.startingItems ?? []) {
        const item = ITEMS[id]
        expect(item, `${key} grants unknown item ${id}`).toBeDefined()
        expect(def.mechanism, `${key} does not name ${id}`).toContain(item?.name ?? ' ')
      }
    }
  })
})

describe('starting loadout', () => {
  it('grants only items that exist', () => {
    // A typo here is a hull that either crashes at launch or silently starts empty,
    // depending on how the caller resolves it. Both are authoring bugs the compiler
    // cannot see, because `startingItems` is `string[]`.
    for (const [key, def] of hullEntries) {
      for (const id of def.startingItems ?? []) {
        expect(Object.hasOwn(ITEMS, id), `${key}: ${id}`).toBe(true)
      }
    }
  })

  it('never grants the same item twice', () => {
    for (const [key, def] of hullEntries) {
      const ids = def.startingItems ?? []
      expect(new Set(ids).size, key).toBe(ids.length)
    }
  })

  it('keeps starting scrap positive where it is set', () => {
    // `startingScrap: 0` is indistinguishable from not setting it and reads on a diff
    // as a deliberate zero. Either the hull is funded or it is not.
    for (const [key, def] of hullEntries) {
      if (def.startingScrap === undefined) continue
      expect(def.startingScrap, key).toBeGreaterThan(0)
    }
  })

  it('gives every hull something to actually do', () => {
    // Lien excepted, by definition — it is the absence of modifiers.
    for (const [key, def] of hullEntries) {
      if (key === LIEN_ID) continue
      const size =
        def.stats.length +
        (def.effects?.length ?? 0) +
        (def.startingItems?.length ?? 0) +
        (def.startingScrap !== undefined ? 1 : 0)
      expect(size, key).toBeGreaterThan(0)
    }
  })
})

describe('pool reachability', () => {
  it('resolves every certification hull grant to a hull or a named gap', () => {
    // `src/content/certifications.ts` already grants `arrears` and `writ`, and `writ`
    // is not expressible this milestone. A grant pointing at nothing survives a
    // typecheck and shows up as a hangar entry that unlocks a hull the game does not
    // have. This makes the gap explicit: a grant must resolve either to a real hull
    // or to an entry in HULLS_AWAITING_MECHANICS that says what it is waiting for.
    const deferred = new Set(HULLS_AWAITING_MECHANICS.map((entry) => entry.id))
    for (const cert of CERTIFICATIONS) {
      for (const grant of cert.grants) {
        if (grant.slice !== 'hulls') continue
        const known = Object.hasOwn(HULLS, grant.id) || deferred.has(grant.id)
        expect(known, `${cert.id} grants unknown hull ${grant.id}`).toBe(true)
      }
    }
  })

  it('has every hull either reachable or named as pending placement', () => {
    // An authored hull no pool offers is content the player cannot reach — the same
    // defect as `weight: 0` on an item nobody meant to remove from the pool. The
    // exemption list is one-directional: a hull named there that later becomes
    // reachable still passes, so adding the grants does not require editing it in the
    // same commit.
    const granted = new Set(
      CERTIFICATIONS.flatMap((cert) =>
        cert.grants.filter((g) => g.slice === 'hulls').map((g) => g.id),
      ),
    )
    for (const [key] of hullEntries) {
      const reachable =
        BASE_POOL.hulls.includes(key) || granted.has(key) || HULLS_PENDING_POOL_PLACEMENT.includes(key)
      expect(reachable, `${key} is in no pool and is not listed as pending`).toBe(true)
    }
  })

  it('always offers Lien', () => {
    expect(BASE_POOL.hulls).toContain(LIEN_ID)
  })
})

describe('getHull', () => {
  it('returns the definition for a known id', () => {
    expect(getHull(LIEN_ID).id).toBe(LIEN_ID)
  })

  it('throws on an unknown id', () => {
    expect(() => getHull('no-such-hull')).toThrow(/no-such-hull/)
  })

  it('throws on inherited Object.prototype keys', () => {
    // The enemy lookup shipped this bug once: a plain index lookup resolves
    // `constructor` to a function and hands it back typed as a def.
    for (const id of ['constructor', '__proto__', 'toString', 'valueOf']) {
      expect(() => getHull(id), id).toThrow(/Unknown hull id/)
    }
  })
})
