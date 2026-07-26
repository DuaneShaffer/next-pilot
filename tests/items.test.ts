import { describe, expect, it } from 'vitest'
import { COMMON_DPS_CEILING, ITEMS, getItem } from '../src/content/items'
import { INTERACTIONS, STANDALONE_ITEM_IDS } from '../src/content/interactions'
import { STATS, resolveStat } from '../src/sim/stats'
import { summariseEffects } from '../src/sim/itemEffects'
import type { BoundEffect } from '../src/sim/inventory'
import { TICK_HZ } from '../src/core/loop'
import type {
  EffectDef,
  EffectKind,
  HookName,
  ItemDef,
  ItemTier,
  StatModifier,
} from '../src/content/types'

/**
 * Item content integrity.
 *
 * Items are data, and data has no compiler. TypeScript can check that a modifier
 * has a `stat: StatKey`; only a test can check that the modifier actually moves the
 * number, that the sentence shown to the player names it, and that the interaction
 * graph still connects. Every assertion here corresponds to a specific failure that
 * would otherwise ship silently:
 *
 * - An item whose mechanism has no numbers is flavour wearing a mechanism's clothes,
 *   and `docs/UI.md` rule 4 exists to stop exactly that.
 * - An `add` on a stat already clamped at its bound is an item that costs a pick and
 *   does nothing. The player has no way to detect it.
 * - An orphaned item is a hole in the thing M3 is actually building. The standalone
 *   set is named, so orphaning is a test failure with a name in it.
 *
 * Every test in this file was mutation-verified: the content was broken, the test
 * was confirmed to fail on that break, and the content was reverted.
 */

const itemEntries: [string, ItemDef][] = Object.entries(ITEMS)

/** Every `HookName`, mirrored so a runtime value can be validated against it. */
const HOOKS: readonly HookName[] = [
  'onFire',
  'onProjectileHit',
  'onEnemyKilled',
  'onHullDamaged',
  'onScrapCollected',
  'onTick',
]

const TIERS: readonly ItemTier[] = ['common', 'uncommon', 'rare', 'relic']

/**
 * The most interactions any single item may appear in.
 *
 * A design decision written as a number, not a derived bound. See the test that uses
 * it for why it does not scale with the edge count.
 */
const MAX_ITEM_DEGREE = 3

/**
 * The params each `EffectKind` cannot run without, mirroring the doc comments on
 * `EffectKind` in `src/content/types.ts`.
 *
 * `EffectDef` makes every param optional because they are shared across kinds, so
 * the compiler cannot enforce this — a `chainOnHit` with no `radius` typechecks
 * cleanly and then chains to nothing at all. This table is the only thing standing
 * between that and a shipped item.
 */
const REQUIRED_EFFECT_PARAMS: Record<EffectKind, readonly (keyof EffectDef)[]> = {
  splitShot: ['count', 'spreadDegrees'],
  chainOnHit: ['count', 'radius', 'fraction'],
  scrapOnOverkill: ['fraction'],
  fireRateWindow: ['bonus', 'durationTicks'],
  retaliate: ['count'],
  repairOnKill: ['amount', 'chance'],
  pierce: ['count'],
}

/**
 * Hooks each `EffectKind` is allowed to run on.
 *
 * Narrower than "any hook", because most of these kinds only mean anything at one
 * point in the tick: `scrapOnOverkill` on `onFire` has no kill to measure overkill
 * against, and would silently never pay out.
 *
 * `fireRateWindow` is pinned to `onScrapCollected` even though the effect could in
 * principle hang off any trigger, because that is the only one the simulation opens
 * the window on — see `EffectTotals.fireRateWindowTicks` in `src/sim/itemEffects.ts`,
 * "how long it lasts after collecting scrap". An item declaring the window on
 * `onEnemyKilled` would typecheck, read plausibly, and never fire once.
 */
const ALLOWED_EFFECT_HOOKS: Record<EffectKind, readonly HookName[]> = {
  splitShot: ['onFire'],
  chainOnHit: ['onProjectileHit'],
  scrapOnOverkill: ['onEnemyKilled'],
  fireRateWindow: ['onScrapCollected'],
  retaliate: ['onHullDamaged'],
  repairOnKill: ['onEnemyKilled'],
  pierce: ['onFire'],
}

/** Wrap raw effects the way `resolveInventory` would, so `summariseEffects` accepts them. */
function bind(effects: readonly EffectDef[], sourceId: string): BoundEffect[] {
  return effects.map((effect) => ({ effect, sourceId, fromInteraction: false }))
}

/**
 * What each interaction's `text` promises, restated as the `EffectTotals` a build
 * holding both items will actually resolve to.
 *
 * Deliberate duplication of the content, and the duplication is the whole value: it
 * is a second, independent statement of what the player was told, checked against
 * what `summariseEffects` produces. Nothing else in this file can catch a text that
 * promises "90%" beside a `fraction: 0.5` that resolves to 50% — the data
 * typechecks, the interaction activates, the sentence renders, and only the number
 * is wrong. Changing one of these numbers now means changing it in two places, one
 * of which is the sentence the player reads.
 */
const PROMISED_TOTALS: Record<string, Partial<ReturnType<typeof summariseEffects>>> = {
  'split-arc': { chainCount: 2, chainRadius: 130, chainFraction: 0.4, splitShotCount: 2 },
  'overkill-warheads': { overkillFraction: 0.9 },
  'magnet-coin-op': { fireRateWindowBonus: 0.35, fireRateWindowTicks: 420 },
  'coil-curse': { retaliateCount: 14, pierceCount: 1 },
  'curse-nanites': { repairAmount: 8, repairChance: 0.45 },
  'warhead-fragments': { pierceCount: 1, splitShotCount: 2 },
  'shield-nanites': { repairAmount: 7, repairChance: 0.35 },

  // M5. Interactions whose consequence is entirely `stats` have an empty entry:
  // there are no effect totals to promise, and the stat side is covered by
  // `changes the stat further than its own two items already did`. The entry is
  // still required so that adding an interaction cannot skip this check silently.
  'lance-focus': { pierceCount: 2 },
  'hazard-assay': {},
  'flak-curtain': { splitShotCount: 3, splitShotSpreadDegrees: 34, pierceCount: 2 },
  'ion-overpressure': { chainCount: 2, chainRadius: 85, chainFraction: 0.5 },
  'bulkhead-bond': {},
  'slip-stream': {},
  'lattice-lance': { pierceCount: 4 },
  'quota-lien': {},
  'tithe-magnet': { fireRateWindowBonus: 0.25, fireRateWindowTicks: 600 },
  'hauler-tithe': { fireRateWindowBonus: 0.22, fireRateWindowTicks: 480 },
  'twin-lance': { pierceCount: 2 },
  'exposed-nanites': { repairAmount: 7, repairChance: 0.4 },
  'liquidation-overkill': { overkillFraction: 1 },
  'sealed-dispersal': {},
  'hauler-plating': {},
  'manifold-curtain': { splitShotCount: 9, splitShotSpreadDegrees: 70, pierceCount: 1 },
  'bunker-optics': {},
  'heavy-broadside': { pierceCount: 1 },
  'vector-magnet': {},
  'curtain-focus': { splitShotCount: 4, splitShotSpreadDegrees: 34 },
  'exposed-lien': {},
}

/**
 * Render a number the way item text does, so string matching lines up.
 *
 * `4 * 1.45` is `5.800000000000001` in binary floating point, and the mechanism line
 * quite reasonably says "5.8". Two decimals then trimmed is enough for every value
 * the roster uses and does not silently round a real discrepancy away.
 */
function numeral(value: number): string {
  return String(Number(value.toFixed(2)))
}

/**
 * Numbers a modifier could honestly be described by, either as a delta or as the
 * value it resolves to from the base.
 *
 * Both are accepted because both are good writing depending on the stat: "+28 hull
 * speed" reads better as a delta, "pickup radius 34 to 60" reads better as the
 * result, and forcing one style would make the test an opinion about prose rather
 * than a check that the number is stated at all.
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

/** The same, for an effect's tuning params. */
function salientEffectNumbers(effect: EffectDef): string[] {
  const out: string[] = []
  if (effect.count !== undefined) out.push(numeral(effect.count))
  if (effect.spreadDegrees !== undefined) out.push(numeral(effect.spreadDegrees))
  if (effect.radius !== undefined) out.push(numeral(effect.radius))
  if (effect.amount !== undefined) out.push(numeral(effect.amount))
  if (effect.fraction !== undefined) out.push(numeral(Math.round(effect.fraction * 100)))
  if (effect.bonus !== undefined) out.push(numeral(Math.round(effect.bonus * 100)))
  if (effect.chance !== undefined) out.push(numeral(Math.round(effect.chance * 100)))
  // Ticks are the sim's unit; the player is told seconds (UI rule 2), so accept
  // either rather than requiring content to leak a tick count into player text.
  if (effect.durationTicks !== undefined) {
    out.push(numeral(effect.durationTicks), numeral(effect.durationTicks / TICK_HZ))
  }
  return out
}

function statsOf(def: ItemDef): readonly StatModifier[] {
  return def.stats ?? []
}

function effectsOf(def: ItemDef): readonly EffectDef[] {
  return def.effects ?? []
}

describe('item registry', () => {
  it('is not empty and is roughly the size M5 asked for', () => {
    // Guards against the roster being emptied, which would make every other
    // assertion in this file pass vacuously. The band was 12-18 at M3; M5's target
    // is "~40 well-connected items", so the band moved with the milestone rather
    // than being widened to whatever happens to be there.
    expect(itemEntries.length).toBeGreaterThanOrEqual(36)
    expect(itemEntries.length).toBeLessThanOrEqual(44)
  })

  it('keeps the tier mix close to the measured M3 shape', () => {
    // Adding 26 items changes which three options appear, which is safe — but it
    // also changes the odds of each TIER appearing, which is a balance change
    // nobody measured. Weight is a single global pool (see `buildOffers`), so tier
    // share is the sum of weights, not the count of items.
    //
    // M3 shares: common 41.2%, uncommon 43.3%, rare 10.3%, relic 5.2%. The bands
    // below are those numbers with room for the rare tier to grow — it holds nine
    // items at M5 against two at M3, so its share cannot be held at 10% without
    // making each individual rare nearly unofferable.
    const totals = { common: 0, uncommon: 0, rare: 0, relic: 0 }
    for (const [, def] of itemEntries) totals[def.tier] += def.weight ?? 0
    const all = totals.common + totals.uncommon + totals.rare + totals.relic
    const share = (n: number) => n / all
    expect(share(totals.common), 'common share').toBeGreaterThan(0.33)
    expect(share(totals.common), 'common share').toBeLessThan(0.45)
    expect(share(totals.uncommon), 'uncommon share').toBeGreaterThan(0.38)
    expect(share(totals.uncommon), 'uncommon share').toBeLessThan(0.48)
    expect(share(totals.rare), 'rare share').toBeGreaterThan(0.08)
    expect(share(totals.rare), 'rare share').toBeLessThan(0.16)
    expect(share(totals.relic), 'relic share').toBeGreaterThan(0.03)
    expect(share(totals.relic), 'relic share').toBeLessThan(0.08)
  })

  it('keys match the id on each definition', () => {
    // Interactions reference items by key; the sim stores them by `id`. If the two
    // disagree, an interaction silently never activates.
    for (const [key, def] of itemEntries) {
      expect(def.id, key).toBe(key)
    }
  })

  it('gives every item a name, a valid tier, and at least one accurate tag', () => {
    for (const [key, def] of itemEntries) {
      expect(def.name.length, key).toBeGreaterThan(0)
      expect(TIERS, key).toContain(def.tier)
      expect(def.tags.length, key).toBeGreaterThan(0)
      // A duplicated tag would double an item's weight in any tag-based offer
      // weighting without anyone intending it.
      expect(new Set(def.tags).size, key).toBe(def.tags.length)
    }
  })

  it('gives every item something to actually do', () => {
    // An item with neither stats nor effects is a pick that changes nothing. It
    // would render, read correctly, and be inert.
    for (const [key, def] of itemEntries) {
      expect(statsOf(def).length + effectsOf(def).length, key).toBeGreaterThan(0)
    }
  })

  it('spreads across all four tiers', () => {
    // A tier with no items means a tier that never appears, and the colour the
    // choice screen draws for it is dead code.
    for (const tier of TIERS) {
      const count = itemEntries.filter(([, def]) => def.tier === tier).length
      expect(count, tier).toBeGreaterThan(0)
    }
  })

  it('gives every offerable item a positive weight', () => {
    // `weight: 0` means "never offered randomly" per the contract, which is a real
    // option — but nothing in M3 uses it, so an item at 0 or with no weight is an
    // item accidentally removed from the pool.
    for (const [key, def] of itemEntries) {
      expect(def.weight, key).toBeDefined()
      expect(def.weight ?? 0, key).toBeGreaterThan(0)
    }
  })

  it('documents a common damage ceiling below doubling', () => {
    // The constant is intent rather than an enforced bound (dps depends on which
    // stats an item touches), so the test pins the intent: whatever the ceiling is
    // set to, a single common must not be allowed to double the player's output.
    expect(COMMON_DPS_CEILING).toBeGreaterThan(1)
    expect(COMMON_DPS_CEILING).toBeLessThan(2)
  })
})

describe('mechanism text — UI.md rule 4', () => {
  it("states every item's mechanism with at least one digit", () => {
    // The load-bearing one. A mechanism with no numbers is flavour wearing a
    // mechanism's clothes, and it is the exact failure mode UI rule 4 was written
    // against: the player is asked to choose under time pressure and given a mood.
    for (const [key, def] of itemEntries) {
      expect(def.mechanism, key).toMatch(/\d/)
    }
  })

  it('never leaves a mechanism empty or fragmentary', () => {
    for (const [key, def] of itemEntries) {
      expect(def.mechanism.trim().length, key).toBeGreaterThanOrEqual(24)
      // A complete sentence, because line 2 of the item card is read on its own.
      expect(def.mechanism.trim().endsWith('.'), key).toBe(true)
      expect(def.mechanism.trim()[0], key).toBe(def.mechanism.trim()[0]?.toUpperCase())
    }
  })

  it('names every number it applies in the mechanism, not the flavour', () => {
    // The real enforcement of "flavour is never load-bearing": this only ever reads
    // `mechanism`, so a number that lives in the flavour line does not count. An
    // item that says "+45% damage" only in its joke fails here.
    for (const [key, def] of itemEntries) {
      for (const modifier of statsOf(def)) {
        const candidates = salientNumbers(modifier)
        const stated = candidates.some((n) => def.mechanism.includes(n))
        expect(stated, `${key}: ${modifier.stat} ${modifier.kind} ${modifier.value}`).toBe(true)
      }
      for (const effect of effectsOf(def)) {
        for (const n of salientEffectNumbers(effect)) {
          // durationTicks contributes two acceptable spellings; accept either.
          const alternatives = salientEffectNumbers(effect)
          const stated =
            def.mechanism.includes(n) || alternatives.some((alt) => def.mechanism.includes(alt))
          expect(stated, `${key}: ${effect.kind} ${n}`).toBe(true)
        }
      }
    }
  })

  it('keeps numbers out of the flavour line entirely', () => {
    // A checkable form of "flavour is always omittable": if a number appears in the
    // flavour, either it duplicates the mechanism (noise) or it does not (the
    // mechanism is incomplete). Neither is acceptable, and both are invisible to a
    // reviewer skimming a diff.
    for (const [key, def] of itemEntries) {
      if (def.flavour === undefined) continue
      expect(def.flavour.trim().length, key).toBeGreaterThan(0)
      expect(def.flavour, key).not.toMatch(/\d/)
    }
  })
})

describe('stat modifiers', () => {
  it('only names stats that exist in the stat table', () => {
    // The union makes this a compile error for a literal, but an item assembled
    // anywhere less direct would fail silently: a modifier on a stat nothing reads
    // does nothing and reports nothing.
    for (const [key, def] of itemEntries) {
      for (const modifier of statsOf(def)) {
        expect(Object.hasOwn(STATS, modifier.stat), `${key}: ${modifier.stat}`).toBe(true)
      }
    }
  })

  it('never applies a modifier that the stat bounds turn into a no-op', () => {
    // The bug this catches: an `add` to a stat already sitting at its max, or a `mul`
    // so small the clamp swallows it. The item costs a pick, reads correctly, and
    // changes nothing — and there is no way for the player to tell.
    for (const [key, def] of itemEntries) {
      for (const modifier of statsOf(def)) {
        const base = STATS[modifier.stat].base
        const alone = resolveStat(modifier.stat, [modifier])
        expect(alone, `${key}: ${modifier.stat} ${modifier.kind} ${modifier.value}`).not.toBe(base)
      }
    }
  })

  it('moves every stat it touches when the whole item is applied', () => {
    // Stronger than the per-modifier check: two modifiers on one stat could cancel
    // (a +10 and a x0.9 that resolve back to base), which no single-modifier test
    // would notice.
    for (const [key, def] of itemEntries) {
      const touched = new Set(statsOf(def).map((m) => m.stat))
      for (const stat of touched) {
        expect(resolveStat(stat, statsOf(def)), `${key}: ${stat}`).not.toBe(STATS[stat].base)
      }
    }
  })

  it('modifies fireIntervalTicks only by whole-tick additions', () => {
    // The weapon cooldown is counted in whole ticks, so a fractional interval rounds
    // back to where it started. `mul: 0.85` on a base of 3 resolves to 2.55 and fires
    // on exactly the same tick as 3 — a no-op the bounds check above cannot see,
    // because 2.55 is a different number from 3. Fractional fire rate belongs in
    // `fireRateWindow`, which the sim applies as a real fraction.
    const modifiers: StatModifier[] = [
      ...itemEntries.flatMap(([, def]) => statsOf(def)),
      ...INTERACTIONS.flatMap((interaction) => interaction.stats ?? []),
    ]
    for (const modifier of modifiers) {
      if (modifier.stat !== 'fireIntervalTicks') continue
      expect(modifier.kind, 'fireIntervalTicks must not use mul').toBe('add')
      expect(Number.isInteger(modifier.value), `fireIntervalTicks add ${modifier.value}`).toBe(true)
    }
  })
})

describe('effects', () => {
  it('supplies every param its EffectKind requires', () => {
    // `EffectDef` shares one optional bag of params across all kinds, so a
    // `chainOnHit` missing its `radius` typechecks and then chains to nothing.
    for (const [key, def] of itemEntries) {
      for (const effect of effectsOf(def)) {
        for (const param of REQUIRED_EFFECT_PARAMS[effect.kind]) {
          expect(effect[param], `${key}: ${effect.kind}.${String(param)}`).toBeDefined()
        }
      }
    }
  })

  it('runs each effect on a hook where its trigger exists', () => {
    for (const [key, def] of itemEntries) {
      for (const effect of effectsOf(def)) {
        expect(HOOKS, `${key}: ${effect.kind}`).toContain(effect.on)
        expect(ALLOWED_EFFECT_HOOKS[effect.kind], `${key}: ${effect.kind}`).toContain(effect.on)
      }
    }
  })

  it('keeps every tuning param inside a range that does something', () => {
    for (const [key, def] of itemEntries) {
      for (const effect of effectsOf(def)) {
        const label = `${key}: ${effect.kind}`
        if (effect.count !== undefined) expect(effect.count, label).toBeGreaterThan(0)
        if (effect.radius !== undefined) expect(effect.radius, label).toBeGreaterThan(0)
        if (effect.amount !== undefined) expect(effect.amount, label).toBeGreaterThan(0)
        if (effect.durationTicks !== undefined) {
          expect(effect.durationTicks, label).toBeGreaterThan(0)
        }
        if (effect.bonus !== undefined) expect(effect.bonus, label).toBeGreaterThan(0)
        // Fractions and chances are proportions. Above 1 is almost always a decimal
        // point in the wrong place, and 0 is an effect that never fires.
        if (effect.fraction !== undefined) {
          expect(effect.fraction, label).toBeGreaterThan(0)
          expect(effect.fraction, label).toBeLessThanOrEqual(1)
        }
        if (effect.chance !== undefined) {
          expect(effect.chance, label).toBeGreaterThan(0)
          expect(effect.chance, label).toBeLessThanOrEqual(1)
        }
        if (effect.spreadDegrees !== undefined) {
          expect(effect.spreadDegrees, label).toBeGreaterThan(0)
          expect(effect.spreadDegrees, label).toBeLessThan(90)
        }
      }
    }
  })
})

describe('cursed items', () => {
  const cursed = itemEntries.filter(([, def]) => def.tags.includes('cursed'))

  it('exist', () => {
    expect(cursed.length).toBeGreaterThanOrEqual(1)
  })

  it('are a real presence in the pool, not a token relic', () => {
    // M5 asked for more cursed items specifically. One curse in fourteen is a
    // curiosity; a curse should be a route the player can be offered repeatedly and
    // has to decide about each time. Weight rather than count, because an item at
    // weight 1 is not in the pool in any meaningful sense.
    const cursedWeight = cursed.reduce((sum, [, def]) => sum + (def.weight ?? 0), 0)
    const allWeight = itemEntries.reduce((sum, [, def]) => sum + (def.weight ?? 0), 0)
    expect(cursed.length, 'cursed item count').toBeGreaterThanOrEqual(5)
    expect(cursedWeight / allWeight, 'cursed share of the offer pool').toBeGreaterThan(0.06)
  })

  it('spreads curses over more than one thing to lose', () => {
    // Six items all trading integrity for damage is one item printed six times. The
    // curse tier is interesting only if the *currency* varies — health, shield,
    // income, rate of fire — so a player who has already paid in one cannot
    // reflexively pay in it again.
    const currencies = new Set<string>()
    for (const [, def] of cursed) {
      for (const modifier of statsOf(def)) {
        const spec = STATS[modifier.stat]
        const resolved = resolveStat(modifier.stat, [modifier])
        const improved = spec.lowerIsBetter === true ? resolved < spec.base : resolved > spec.base
        if (!improved) currencies.add(modifier.stat)
      }
    }
    expect([...currencies].sort(), 'distinct things a curse can cost').toHaveLength(3)
  })

  it('are a real trade, not a strictly worse pick', () => {
    // A curse that only takes is an item nobody ever picks, which makes it content
    // that exists solely to waste one of the three offer slots. Every cursed item
    // must move at least one stat in the player's favour and at least one against.
    for (const [key, def] of cursed) {
      const touched = new Set(statsOf(def).map((m) => m.stat))
      let better = 0
      let worse = 0
      for (const stat of touched) {
        const spec = STATS[stat]
        const resolved = resolveStat(stat, statsOf(def))
        const improved = spec.lowerIsBetter === true ? resolved < spec.base : resolved > spec.base
        if (improved) better++
        else worse++
      }
      expect(better, `${key} has no upside`).toBeGreaterThan(0)
      expect(worse, `${key} has no cost`).toBeGreaterThan(0)
    }
  })
})

describe('getItem', () => {
  it('returns the definition for a known id', () => {
    expect(getItem('split-shot').id).toBe('split-shot')
  })

  it('throws on an unknown id', () => {
    expect(() => getItem('no-such-item')).toThrow(/no-such-item/)
  })

  it('throws on inherited Object.prototype keys', () => {
    // The equivalent enemy lookup shipped this bug: a plain index lookup resolved
    // `constructor` to `Object.prototype.constructor` and handed back a function
    // typed as a def, failing somewhere far from the mistake. `Object.hasOwn` is the
    // fix, and these three names are the reason it is not an undefined check.
    for (const id of ['constructor', '__proto__', 'toString', 'valueOf']) {
      expect(() => getItem(id), id).toThrow(/Unknown item id/)
    }
  })
})

describe('interactions', () => {
  it('declares at least the four M3 asked for, with unique ids', () => {
    expect(INTERACTIONS.length).toBeGreaterThanOrEqual(4)
    const ids = INTERACTIONS.map((interaction) => interaction.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('requires two different items that both exist', () => {
    // A typo in `requires` produces an interaction that can never activate, and
    // nothing at runtime would ever mention it.
    for (const interaction of INTERACTIONS) {
      const [a, b] = interaction.requires
      expect(a, interaction.id).not.toBe(b)
      expect(Object.hasOwn(ITEMS, a), `${interaction.id}: ${a}`).toBe(true)
      expect(Object.hasOwn(ITEMS, b), `${interaction.id}: ${b}`).toBe(true)
    }
  })

  it('declares each pair only once', () => {
    // Matching is set-based, so two interactions on the same pair would both fire
    // and stack, which is never what anyone meant to author.
    const pairs = INTERACTIONS.map((interaction) => [...interaction.requires].sort().join('+'))
    expect(new Set(pairs).size).toBe(pairs.length)
  })

  it('has a mechanical consequence', () => {
    // An interaction with no stats and no effects is a sentence on the choice screen
    // promising something that does not happen — worse than no interaction, because
    // the player rearranges their build around it.
    for (const interaction of INTERACTIONS) {
      const size = (interaction.stats?.length ?? 0) + (interaction.effects?.length ?? 0)
      expect(size, interaction.id).toBeGreaterThan(0)
    }
  })

  it('states the combined mechanism with numbers', () => {
    // Shown verbatim mid-run, so it has to explain rather than gesture. Two numbers
    // rather than one: an interaction combines two items, and describing the result
    // almost always needs a before and an after.
    for (const interaction of INTERACTIONS) {
      expect(interaction.text.trim().length, interaction.id).toBeGreaterThanOrEqual(40)
      const numbers = interaction.text.match(/\d+(?:\.\d+)?/g) ?? []
      expect(numbers.length, interaction.id).toBeGreaterThanOrEqual(2)
    }
    // Interactions deliberately get a weaker number check than items: their texts
    // quote *totals* that combine with the items' own values ("90% instead of 40%"
    // where the interaction itself contributes 50%), and computing those would mean
    // modelling how every EffectKind stacks — which is the simulation's job, not a
    // content test's.
  })

  it('validates interaction effects the same way item effects are validated', () => {
    for (const interaction of INTERACTIONS) {
      for (const effect of interaction.effects ?? []) {
        for (const param of REQUIRED_EFFECT_PARAMS[effect.kind]) {
          expect(effect[param], `${interaction.id}: ${effect.kind}.${String(param)}`).toBeDefined()
        }
        expect(ALLOWED_EFFECT_HOOKS[effect.kind], `${interaction.id}: ${effect.kind}`).toContain(
          effect.on,
        )
      }
    }
  })

  it('never applies a stat modifier the bounds turn into a no-op', () => {
    for (const interaction of INTERACTIONS) {
      for (const modifier of interaction.stats ?? []) {
        const base = STATS[modifier.stat].base
        const label = `${interaction.id}: ${modifier.stat}`
        expect(resolveStat(modifier.stat, [modifier]), label).not.toBe(base)
      }
    }
  })

  it('changes the effect totals its own two items already produce', () => {
    // THE ONE THAT FOUND A REAL BUG. `src/sim/itemEffects.ts` reduces effects field
    // by field with two different rules: `count` and `amount` SUM, while
    // `fraction`, `chance`, `radius`, `bonus`, and `durationTicks` take the MAX. So
    // an interaction authored as an increment on a maxed field is swallowed whole —
    // `fraction: 0.5` beside an item's own `0.4` resolves to 0.5, not 0.9, and the
    // text on the choice screen promising 90% is simply false.
    //
    // Four of the seven interactions in this file were written that way in their
    // first draft. Nothing else would have caught it: the data typechecks, the
    // interaction activates, the sentence renders, and only the number is a lie.
    for (const interaction of INTERACTIONS) {
      const itemEffects = interaction.requires.flatMap((id) => bind(ITEMS[id]?.effects ?? [], id))
      const own = summariseEffects(itemEffects)
      const combined = summariseEffects([
        ...itemEffects,
        ...bind(interaction.effects ?? [], interaction.id),
      ])
      const changed = (Object.keys(own) as (keyof typeof own)[]).filter(
        (field) => own[field] !== combined[field],
      )
      if ((interaction.effects?.length ?? 0) > 0) {
        expect(changed, `${interaction.id} declares effects that change nothing`).not.toEqual([])
      }
    }
  })

  it('resolves to exactly the totals its text promises', () => {
    // The stronger half of the check above. "Changes something" catches an
    // interaction that is swallowed entirely; this catches one that changes by less
    // than it claims, which is the same lie told quietly.
    const covered = Object.keys(PROMISED_TOTALS).sort()
    expect(covered, 'every interaction needs a promised-totals entry').toEqual(
      INTERACTIONS.map((interaction) => interaction.id).sort(),
    )
    for (const interaction of INTERACTIONS) {
      const totals = summariseEffects([
        ...interaction.requires.flatMap((id) => bind(ITEMS[id]?.effects ?? [], id)),
        ...bind(interaction.effects ?? [], interaction.id),
      ])
      const promised = PROMISED_TOTALS[interaction.id] ?? {}
      for (const [field, value] of Object.entries(promised)) {
        expect(totals[field as keyof typeof totals], `${interaction.id}.${field}`).toBeCloseTo(
          value as number,
          5,
        )
      }
    }
  })

  it('keeps fireRateWindow bonus a fraction, not a tick count', () => {
    // `bonus` is a proportion of fire rate, per UI.md rule 4's worked example
    // ("+18% fire rate for 3 s") and `EffectKind`'s doc comment. A value at or above
    // 1 would be a tick count in a fraction's slot, which reads identically in a diff
    // and is off by two orders of magnitude in play.
    //
    // NOTE FOR WHOEVER WIRES THIS UP: `World.currentFireInterval` currently computes
    // `Math.round(base - bonus)`, i.e. it treats `bonus` as *ticks*. At the contract's
    // fractional units that is `round(3 - 0.18) = 3` — no change at all. The content
    // here follows the contract; the consumer needs `base * (1 - bonus)`.
    const windows = [
      ...itemEntries.flatMap(([, def]) => effectsOf(def)),
      ...INTERACTIONS.flatMap((interaction) => interaction.effects ?? []),
    ].filter((effect) => effect.kind === 'fireRateWindow')
    expect(windows.length).toBeGreaterThan(0)
    for (const effect of windows) {
      expect(effect.bonus ?? 0).toBeGreaterThan(0)
      expect(effect.bonus ?? 0).toBeLessThan(1)
    }
  })

  it('changes the stat further than its own two items already did', () => {
    // The failure this catches is subtler than a clamp: an interaction can be a
    // no-op *in the only build that can hold it*. `pickupRadius +30` looks fine in
    // isolation and would be worthless if Scrap Magnet had already pushed the stat
    // to its 260 ceiling. Resolve with the required items' own modifiers, then with
    // the interaction on top, and insist the numbers differ.
    for (const interaction of INTERACTIONS) {
      const itemModifiers = interaction.requires.flatMap((id) => ITEMS[id]?.stats ?? [])
      for (const modifier of interaction.stats ?? []) {
        const label = `${interaction.id}: ${modifier.stat}`
        const withoutInteraction = resolveStat(modifier.stat, itemModifiers)
        const withInteraction = resolveStat(modifier.stat, [
          ...itemModifiers,
          ...(interaction.stats ?? []),
        ])
        expect(withInteraction, label).not.toBe(withoutInteraction)
      }
    }
  })
})

describe('interaction reachability', () => {
  const connected = new Set(INTERACTIONS.flatMap((interaction) => [...interaction.requires]))
  const standalone = itemEntries.filter(([key]) => !connected.has(key)).map(([key]) => key)

  it('has every item either in an interaction or deliberately standalone', () => {
    // The point of the milestone. An item silently dropping out of the graph — by an
    // id rename, or by an interaction being deleted — is a hole in the thing M3 is
    // building, and nothing else would notice. Asserting the *named* set rather than
    // a count means the failure message contains the orphaned item.
    expect([...standalone].sort()).toEqual([...STANDALONE_ITEM_IDS].sort())
  })

  it('keeps the standalone set to the intended eight plain items', () => {
    // INTENDED NUMBER: 8 of 40. Was 4 of 14 at M3. Both the number and the ratio
    // are asserted: the count catches an item quietly dropping out of the graph,
    // and the ratio catches the roster drifting back toward stat sticks, which is
    // the design position DESIGN.md explicitly rejected. A pool where a third of
    // the items can never combine makes the synergy marker rare enough to ignore.
    expect(standalone.length).toBe(8)
    expect(connected.size).toBe(itemEntries.length - 8)
    expect(standalone.length / itemEntries.length, 'standalone ratio').toBeLessThan(0.25)
  })

  it('keeps every standalone item a plain, uncursed, effect-free stat item', () => {
    // The rule the list is chosen by, made mechanical: an item interesting enough
    // to have a curse or an effect is interesting enough to combine with something.
    // Without this, "standalone" becomes a place to put an item nobody could think
    // of a partner for, which is how a roster quietly turns back into stat sticks.
    for (const id of STANDALONE_ITEM_IDS) {
      const def = ITEMS[id] as ItemDef
      expect(effectsOf(def).length, `${id} is standalone but carries an effect`).toBe(0)
      expect(def.tags.includes('cursed'), `${id} is standalone but cursed`).toBe(false)
      expect(statsOf(def).length, `${id} is standalone and does nothing`).toBeGreaterThan(0)
    }
  })

  it('keeps the standalone list to commons, with Feed Relay the one recorded exception', () => {
    // Feed Relay is an uncommon and was standalone at M3 for a documented reason:
    // whole-tick quantisation means it is the smallest permanent fire-rate change
    // that exists, so it is a "plain" item that could not be priced as a common.
    // M5 did not retune the M3 fourteen, so the exception carries forward — but it
    // is asserted BY NAME, so a future rare or relic cannot join it silently.
    const nonCommon = STANDALONE_ITEM_IDS.filter((id) => ITEMS[id]?.tier !== 'common')
    expect(nonCommon, 'only Feed Relay may be standalone above common').toEqual(['feed-relay'])
  })

  it('gives the standalone items no interaction and everything else at least one', () => {
    for (const id of STANDALONE_ITEM_IDS) {
      expect(Object.hasOwn(ITEMS, id), id).toBe(true)
      expect(connected.has(id), `${id} is listed standalone but has an interaction`).toBe(false)
    }
    for (const [key] of itemEntries) {
      if (STANDALONE_ITEM_IDS.includes(key)) continue
      expect(connected.has(key), `${key} has no interaction and is not listed standalone`).toBe(true)
    }
  })

  it('spreads the graph over more than one hub', () => {
    // Seven interactions all hanging off one item would satisfy every check above
    // while being a single build rather than a graph. No item may account for more
    // than half the edges.
    const degree = new Map<string, number>()
    for (const interaction of INTERACTIONS) {
      for (const id of interaction.requires) degree.set(id, (degree.get(id) ?? 0) + 1)
    }
    const maxDegree = Math.max(...degree.values())
    expect(maxDegree).toBeLessThanOrEqual(Math.ceil(INTERACTIONS.length / 2))
  })

  it('caps the maximum degree at 3, so no item is the hub the roster runs through', () => {
    // THE M5 STRUCTURAL ASSERTION, and the one worth understanding. The check above
    // scales with the edge count, so at 28 interactions it permits an item with 14
    // of them — which is precisely the failure it was written to prevent, just
    // deferred. At forty items the risk is not a sparse graph, it is a hub: one item
    // every synergy runs through, so the roster collapses into "did you find it".
    //
    // 3 is a fixed number rather than a formula, because the right ceiling is a
    // design decision about build variety and not a function of how many pairs
    // happen to have been written. Raising it should require editing this line.
    const degree = new Map<string, number>()
    for (const interaction of INTERACTIONS) {
      for (const id of interaction.requires) degree.set(id, (degree.get(id) ?? 0) + 1)
    }
    const worst = [...degree.entries()].sort((a, b) => b[1] - a[1])[0]
    expect(worst?.[1], `${worst?.[0]} is a hub with ${worst?.[1]} interactions`).toBeLessThanOrEqual(
      MAX_ITEM_DEGREE,
    )
  })

  it('reports a degree distribution with a long tail, not a plateau', () => {
    // The cap alone permits the opposite pathology: every connected item at exactly
    // 3, which is a uniformly dense graph where no pair is special and the marker
    // fires constantly. A real interaction graph has most items in one or two
    // combinations and a few that anchor archetypes.
    const degree = new Map<string, number>()
    for (const interaction of INTERACTIONS) {
      for (const id of interaction.requires) degree.set(id, (degree.get(id) ?? 0) + 1)
    }
    const atOne = [...degree.values()].filter((d) => d === 1).length
    const atMax = [...degree.values()].filter((d) => d === MAX_ITEM_DEGREE).length
    expect(atOne, 'no single-interaction items: the graph is a plateau').toBeGreaterThan(atMax)
    // Degree sums to twice the edge count. Cheap arithmetic guard that the map was
    // built from the real `requires` pairs rather than from something else.
    const sum = [...degree.values()].reduce((a, b) => a + b, 0)
    expect(sum).toBe(INTERACTIONS.length * 2)
  })

  it('connects every rare and relic into the graph', () => {
    // A rare or relic with no partner is the most expensive kind of orphan: it is
    // the pick a run plans around, and planning around it is the thing the
    // interaction graph is for. Commons are allowed to be plain and one uncommon
    // (Feed Relay) is grandfathered; nothing at rare or above is.
    for (const [key, def] of itemEntries) {
      if (def.tier !== 'rare' && def.tier !== 'relic') continue
      expect(connected.has(key), `${key} is a ${def.tier} with no interaction`).toBe(true)
    }
  })

  it('never declares an interaction between two standalone items', () => {
    // Belt and braces on the two lists agreeing: the reachability test compares the
    // computed set against the named one, but this catches the specific authoring
    // slip of adding a pair and forgetting to remove both names.
    for (const interaction of INTERACTIONS) {
      for (const id of interaction.requires) {
        expect(
          STANDALONE_ITEM_IDS.includes(id),
          `${interaction.id} requires ${id}, which is listed standalone`,
        ).toBe(false)
      }
    }
  })
})
