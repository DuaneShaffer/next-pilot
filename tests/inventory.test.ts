import { describe, expect, it } from 'vitest'
import type { InteractionDef, ItemDef } from '../src/content/types'
import type { HeldItem } from '../src/sim/entities'
import {
  addItem,
  effectsFor,
  interactionsUnlockedBy,
  resolveInventory,
} from '../src/sim/inventory'
import { STATS, resolveStat, shotsPerSecond } from '../src/sim/stats'

function item(id: string, overrides: Partial<ItemDef> = {}): ItemDef {
  return {
    id,
    name: id,
    tier: 'common',
    tags: ['weapon'],
    mechanism: `${id} does a thing.`,
    ...overrides,
  }
}

function held(...entries: Array<[string, number]>): HeldItem[] {
  return entries.map(([defId, count], index) => ({
    defId,
    acquiredAtTick: index * 10,
    count,
  }))
}

function table(...defs: ItemDef[]): Record<string, ItemDef> {
  return Object.fromEntries(defs.map((def) => [def.id, def]))
}

describe('stat fold order', () => {
  /**
   * The load-bearing invariant of the whole item system.
   *
   * If modifiers folded in acquisition order, the same two items would produce
   * different numbers depending on which was found first. A build would stop being
   * reproducible from its seed, two players on one daily contract could diverge,
   * and "+2 damage" would mean something different every run. None of that would
   * throw — it would just quietly make the game unverifiable.
   */
  it('applies every addition before any multiplication', () => {
    // base 4, +2 = 6, then x2 = 12. Interleaved by array order it would be
    // (4 x 2) + 2 = 10, so the two orders are distinguishable by construction.
    const value = resolveStat('projectileDamage', [
      { stat: 'projectileDamage', kind: 'mul', value: 2 },
      { stat: 'projectileDamage', kind: 'add', value: 2 },
    ])
    expect(value).toBe(12)
  })

  it('is independent of the order modifiers arrive in', () => {
    const modifiers = [
      { stat: 'projectileDamage', kind: 'add', value: 3 } as const,
      { stat: 'projectileDamage', kind: 'mul', value: 1.5 } as const,
      { stat: 'projectileDamage', kind: 'add', value: 1 } as const,
    ]
    const forwards = resolveStat('projectileDamage', modifiers)
    const backwards = resolveStat('projectileDamage', [...modifiers].reverse())
    expect(forwards).toBe(backwards)
    expect(forwards).toBe((4 + 3 + 1) * 1.5)
  })

  it('gives the same stats however the same items were picked up', () => {
    const items = table(
      item('a', { stats: [{ stat: 'projectileDamage', kind: 'add', value: 5 }] }),
      item('b', { stats: [{ stat: 'projectileDamage', kind: 'mul', value: 2 }] }),
    )
    const ab = resolveInventory(held(['a', 1], ['b', 1]), items, [])
    const ba = resolveInventory(held(['b', 1], ['a', 1]), items, [])
    expect(ab.stats).toEqual(ba.stats)
  })
})

describe('stat bounds', () => {
  it('never lets the fire interval reach zero', () => {
    // A zero interval is an infinite fire rate: a divide-by-zero waiting to
    // happen, and instantly past every projectile cap.
    const value = resolveStat('fireIntervalTicks', [
      { stat: 'fireIntervalTicks', kind: 'add', value: -100 },
      { stat: 'fireIntervalTicks', kind: 'mul', value: 0 },
    ])
    expect(value).toBe(STATS.fireIntervalTicks.min)
    expect(value).toBeGreaterThan(0)
    expect(Number.isFinite(shotsPerSecond(value))).toBe(true)
  })

  it('never lets a build fire nothing', () => {
    // A softlock, not a trade-off.
    const value = resolveStat('projectilesPerShot', [
      { stat: 'projectilesPerShot', kind: 'mul', value: 0 },
    ])
    expect(value).toBeGreaterThanOrEqual(1)
  })

  it('clamps rather than trusting a runaway stack', () => {
    const modifiers = Array.from({ length: 200 }, () => ({
      stat: 'projectileDamage' as const,
      kind: 'mul' as const,
      value: 2,
    }))
    expect(resolveStat('projectileDamage', modifiers)).toBe(STATS.projectileDamage.max)
  })

  it('falls back to the base value rather than propagating a non-finite number', () => {
    // A NaN stat silently disables whatever reads it, which is far harder to
    // diagnose than a stat that simply did not change.
    const value = resolveStat('hullSpeed', [
      { stat: 'hullSpeed', kind: 'mul', value: Number.POSITIVE_INFINITY },
      { stat: 'hullSpeed', kind: 'mul', value: 0 },
    ])
    expect(Number.isFinite(value)).toBe(true)
  })

  it('leaves every stat at its base for an empty inventory', () => {
    // M2 behaviour must be exactly preserved when nothing is held, or every
    // recorded fixture from before items would have been invalidated by adding
    // the system rather than by using it.
    const resolution = resolveInventory([], {}, [])
    for (const [key, spec] of Object.entries(STATS)) {
      expect(resolution.stats[key as keyof typeof STATS]).toBe(spec.base)
    }
  })
})

describe('stacking', () => {
  it('applies a stacked item once per stack', () => {
    const items = table(item('a', { stats: [{ stat: 'projectileDamage', kind: 'add', value: 2 }] }))
    expect(resolveInventory(held(['a', 3]), items, []).stats.projectileDamage).toBe(4 + 6)
  })

  it('keeps the original acquisition tick when stacking', () => {
    // Effect dispatch order is play-affecting, so re-taking an item must not
    // reorder the build's behaviour and desynchronise a replay.
    const first = addItem([], 'a', 100)
    const second = addItem(first, 'a', 900)
    expect(second).toHaveLength(1)
    expect(second[0]?.count).toBe(2)
    expect(second[0]?.acquiredAtTick).toBe(100)
  })

  it('preserves acquisition order for new items', () => {
    const result = addItem(addItem(addItem([], 'a', 1), 'b', 2), 'c', 3)
    expect(result.map((entry) => entry.defId)).toEqual(['a', 'b', 'c'])
  })

  it('never mutates the array it was given', () => {
    const original = addItem([], 'a', 1)
    addItem(original, 'b', 2)
    expect(original).toHaveLength(1)
  })
})

describe('interactions', () => {
  const arc: InteractionDef = {
    id: 'split-arc',
    requires: ['split', 'coupler'],
    text: 'Each split fragment arcs to a nearby target.',
    stats: [{ stat: 'projectileDamage', kind: 'add', value: 1 }],
  }

  it('activates only when both items are held', () => {
    const items = table(item('split'), item('coupler'))
    expect(resolveInventory(held(['split', 1]), items, [arc]).active).toHaveLength(0)
    expect(resolveInventory(held(['split', 1], ['coupler', 1]), items, [arc]).active).toHaveLength(1)
  })

  it('applies once regardless of stacking', () => {
    // A synergy is a relationship between two items, not a quantity of them.
    const items = table(item('split'), item('coupler'))
    const single = resolveInventory(held(['split', 1], ['coupler', 1]), items, [arc])
    const stacked = resolveInventory(held(['split', 5], ['coupler', 4]), items, [arc])
    expect(single.active).toHaveLength(1)
    expect(stacked.active).toHaveLength(1)
    expect(stacked.stats.projectileDamage).toBe(single.stats.projectileDamage)
  })

  it('reports the text a choice would newly unlock', () => {
    // UI rule 5: the choice screen asks this rather than deciding for itself
    // whether two items combine, so it cannot fail to mention one.
    expect(interactionsUnlockedBy('coupler', held(['split', 1]), [arc])).toEqual([arc.text])
  })

  it('says nothing when the interaction is already live', () => {
    // The screen is telling the player what this choice *changes*.
    expect(interactionsUnlockedBy('coupler', held(['split', 1], ['coupler', 1]), [arc])).toEqual([])
  })

  it('says nothing when the partner is not held', () => {
    expect(interactionsUnlockedBy('coupler', held(['unrelated', 1]), [arc])).toEqual([])
  })
})

describe('effect dispatch', () => {
  it('collects effects in acquisition order', () => {
    const items = table(
      item('first', { effects: [{ kind: 'splitShot', on: 'onFire', count: 1 }] }),
      item('second', { effects: [{ kind: 'pierce', on: 'onProjectileHit', count: 1 }] }),
      item('third', { effects: [{ kind: 'splitShot', on: 'onFire', count: 2 }] }),
    )
    const resolution = resolveInventory(held(['first', 1], ['second', 1], ['third', 1]), items, [])
    expect(resolution.effects.map((bound) => bound.sourceId)).toEqual([
      'first',
      'second',
      'third',
    ])
  })

  it('filters effects to a single hook without reordering them', () => {
    const items = table(
      item('a', { effects: [{ kind: 'splitShot', on: 'onFire', count: 1 }] }),
      item('b', { effects: [{ kind: 'pierce', on: 'onProjectileHit', count: 1 }] }),
      item('c', { effects: [{ kind: 'splitShot', on: 'onFire', count: 3 }] }),
    )
    const resolution = resolveInventory(held(['a', 1], ['b', 1], ['c', 1]), items, [])
    expect(effectsFor(resolution.effects, 'onFire').map((bound) => bound.sourceId)).toEqual([
      'a',
      'c',
    ])
  })

  it('marks which effects came from an interaction', () => {
    // Provenance so a build readout can say where a behaviour came from — a player
    // who cannot tell which of their picks caused something cannot plan.
    const items = table(item('split'), item('coupler'))
    const interaction: InteractionDef = {
      id: 'combo',
      requires: ['split', 'coupler'],
      text: 'Fragments arc.',
      effects: [{ kind: 'chainOnHit', on: 'onProjectileHit', count: 2, radius: 60, fraction: 0.5 }],
    }
    const resolution = resolveInventory(held(['split', 1], ['coupler', 1]), items, [interaction])
    const fromCombo = resolution.effects.filter((bound) => bound.fromInteraction)
    expect(fromCombo).toHaveLength(1)
    expect(fromCombo[0]?.sourceId).toBe('combo')
  })

  it('ignores an item id that is not in the table', () => {
    // A stale save or a renamed item must not crash a run.
    expect(() => resolveInventory(held(['ghost', 1]), {}, [])).not.toThrow()
    expect(resolveInventory(held(['ghost', 1]), {}, []).effects).toHaveLength(0)
  })
})
