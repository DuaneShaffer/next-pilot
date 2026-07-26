/**
 * Resolved stat rows for an offered item.
 *
 * Every assertion here is a real number taken from the real content tables, not a
 * shape. `expect(text).toMatch(/\+\d+/)` would have passed the exact defect this
 * module exists to fix — an item card quoting its authored figure while the run
 * resolves to something else — so the numbers are written out and each one has a
 * comment showing the arithmetic that produces it.
 *
 * The load-bearing case is `add`-after-`mul`. Probate resolves max integrity to
 * `100 × 0.64 = 64`; Plating Shim's `+18` lands as `(100 + 18) × 0.64 = 75.5`,
 * because the fold sums every add before applying any mul. The naive implementation —
 * add the item's modifier to the resolved value — says 82, and 82 is a number no run
 * will ever have.
 */

import { describe, expect, it } from 'vitest'
import { HULLS } from '../src/content/hulls'
import { INTERACTIONS } from '../src/content/interactions'
import { ITEMS } from '../src/content/items'
import type { StatKey, StatModifier } from '../src/content/types'
import { TICK_HZ } from '../src/core/loop'
import type { ActiveInteraction, HeldItem } from '../src/sim/entities'
import { resolveInventory } from '../src/sim/inventory'
import { STATS, STAT_KEYS, resolveAllStats, resolveStat } from '../src/sim/stats'
import {
  NO_CHANGE_TEXT,
  collectBuildModifiers,
  numeral,
  signed,
  statDeltaRows,
  type StatDeltaRow,
} from '../src/ui/statDelta'

function held(...entries: readonly (string | readonly [string, number])[]): readonly HeldItem[] {
  return entries.map((entry, index) => {
    const [defId, count] = typeof entry === 'string' ? [entry, 1] : entry
    return { defId, acquiredAtTick: index * 60, count }
  })
}

interface Build {
  hullId?: string
  held?: readonly HeldItem[]
  active?: readonly ActiveInteraction[]
}

function modifiers(build: Build): readonly StatModifier[] {
  return collectBuildModifiers({
    ...(build.hullId === undefined ? {} : { hullId: build.hullId }),
    held: build.held ?? [],
    items: ITEMS,
    activeInteractions: build.active ?? [],
  })
}

/** Rows for offering `defId` on top of `build`. */
function rowsFor(build: Build, defId: string): readonly StatDeltaRow[] {
  return statDeltaRows({ current: modifiers(build), added: ITEMS[defId]?.stats ?? [] })
}

function row(build: Build, defId: string, stat: StatKey): StatDeltaRow {
  const found = rowsFor(build, defId).find((entry) => entry.stat === stat)
  expect(found, `${defId} produced no ${stat} row`).toBeDefined()
  return found as StatDeltaRow
}

describe('the after value is re-resolved, never nudged', () => {
  it('folds an `add` through a `mul` the build already has', () => {
    // Probate: maxIntegrity mul 0.64 → 64. Plating Shim adds 18 to the BASE, so the
    // subtotal is 118 and the hull's multiplier then applies: 118 × 0.64 = 75.52.
    // Applying +18 to the resolved 64 gives 82, which is 6.5 hp of lie.
    const shim = row({ hullId: 'probate' }, 'plating-shim', 'maxIntegrity')
    expect(shim.before).toBe(64)
    expect(shim.after).toBe(75.5)
    expect(shim.delta).toBe(11.5)
    expect(shim.text).toBe('Max integrity  64 → 75.5 hp')
    expect(shim.deltaText).toBe('(+11.5)')
    expect(shim.direction).toBe('better')
  })

  it('folds an `add` through an item-supplied `mul`, stacks included', () => {
    // Exposed Core (damage mul 1.35) plus TWO Machined Slugs: (4 + 1 + 1) × 1.35 = 8.1.
    // A third slug is (4 + 3) × 1.35 = 9.45. Adding 1 to 8.1 would print 9.1.
    const build = { held: held('exposed-core', ['machined-slugs', 2]) }
    const slugs = row(build, 'machined-slugs', 'projectileDamage')
    expect(slugs.before).toBe(8.1)
    expect(slugs.after).toBe(9.5)
    expect(slugs.delta).toBe(1.4)
    expect(slugs.text).toBe('Shot damage  8.1 → 9.5 dmg')
  })

  it('states what a `mul` is worth on this build, not what it is worth on paper', () => {
    // Warheads' own sentence says "4 to 5.8" — its +1.8 is true only of a stock gun.
    // On this build it is 8.1 × 1.45 = 11.745, so +3.6, twice the advertised figure.
    const build = { held: held('exposed-core', ['machined-slugs', 2]) }
    const damage = row(build, 'warheads', 'projectileDamage')
    expect(damage.before).toBe(8.1)
    expect(damage.after).toBe(11.7)
    expect(damage.delta).toBe(3.6)
    expect(ITEMS.warheads?.mechanism).toContain('4 to 5.8')
  })

  it('says outright when a pick is worth nothing on this ship', () => {
    // THE HEADLINE CASE. Exposed Core sets maxShield to mul 0, so Shield Cell's +22 is
    // multiplied away: (40 + 22) × 0 = 0. The authored sentence promises +22 max shield
    // and cannot know any of this.
    const cell = row({ held: held('exposed-core') }, 'shield-cell', 'maxShield')
    expect(cell.before).toBe(0)
    expect(cell.after).toBe(0)
    expect(cell.delta).toBe(0)
    expect(cell.direction).toBe('none')
    expect(cell.deltaText).toBe(NO_CHANGE_TEXT)
    expect(cell.text).toBe('Max shield  0 → 0 hp')
    // Still a row. Dropping it would leave the card silently promising +22.
    expect(rowsFor({ held: held('exposed-core') }, 'shield-cell')).toHaveLength(1)
  })

  it('respects the stat bounds, so an item at the floor reads as no change', () => {
    // fireIntervalTicks floors at 1. Collateral is -1 and each Feed Relay another -1,
    // so 3 - 1 - 2 = 0 clamps to 1 = 60 shots/s, and a third relay changes nothing.
    const atFloor = { hullId: 'collateral', held: held(['feed-relay', 2]) }
    expect(resolveStat('fireIntervalTicks', modifiers(atFloor))).toBe(STATS.fireIntervalTicks.min)
    const relay = row(atFloor, 'feed-relay', 'fireIntervalTicks')
    expect(relay.before).toBe(60)
    expect(relay.after).toBe(60)
    expect(relay.direction).toBe('none')
    expect(relay.deltaText).toBe(NO_CHANGE_TEXT)

    // One step off the floor it does move: 3 - 1 = 2 ticks is 30 shots/s, then 1 is 60.
    const oneOff = row({ hullId: 'collateral' }, 'feed-relay', 'fireIntervalTicks')
    expect(oneOff.before).toBe(30)
    expect(oneOff.after).toBe(60)
    expect(oneOff.deltaText).toBe('(+30)')
  })

  it('every row is internally consistent: before plus delta is after', () => {
    // A row reading `8.1 → 9.5 (+1.3)` invites the reader to decide one of the three
    // numbers is wrong. Swept over every item against four builds.
    const builds: readonly Build[] = [
      {},
      { hullId: 'probate', held: held('repair-nanites') },
      { hullId: 'collateral', held: held(['feed-relay', 3], ['machined-slugs', 2]) },
      { held: held('exposed-core', 'warheads', ['scrap-magnet', 2]) },
    ]
    for (const build of builds) {
      for (const id of Object.keys(ITEMS)) {
        for (const entry of rowsFor(build, id)) {
          expect(Math.round((entry.before + entry.delta) * 10) / 10, `${id} ${entry.stat}`).toBe(
            entry.after,
          )
          expect(entry.text).toContain(`${numeral(entry.before)} → ${numeral(entry.after)}`)
          if (entry.direction === 'none') expect(entry.delta).toBe(0)
          else if (entry.direction === 'inert') expect(entry.deltaText).toMatch(/^\(no effect: /)
          else expect(entry.deltaText).toBe(`(${signed(entry.delta)})`)
        }
      }
    }
  })
})

describe('a number that moves but cannot matter', () => {
  /**
   * Shield recovery draws from a per-sector reserve into the shield pool, so all three
   * recovery stats are inert without a pool to fill. Both ways in are reachable with
   * shipped content, which is why this is not a hypothetical: Exposed Core sets
   * `maxShield` to `mul 0`, and the Collateral hull's `-40` cancels the base 40 exactly.
   *
   * The generic before → after does NOT catch this on its own — the rate really does go
   * from 4 to 6 — so it is declared as `inertWhen` data and applied by the same code path
   * for every stat that names a dependency.
   *
   * WRITTEN AGAINST MODIFIERS RATHER THAN ITEM IDS. Which item in the roster carries
   * which recovery stat is still moving; what is under test is the mechanism, and
   * naming an id would make this a test of this week's items.ts. The sweep below covers
   * whatever the roster actually holds.
   */
  const FASTER: readonly StatModifier[] = [
    { stat: 'shieldRegenPerSecond', kind: 'mul', value: 1.5 },
  ]

  it('flags a faster recovery as no-effect on a build with no shield', () => {
    const cursed = statDeltaRows({ current: modifiers({ held: held('exposed-core') }), added: FASTER })[0]
    expect(cursed?.before).toBe(STATS.shieldRegenPerSecond.base)
    expect(cursed?.after).toBe(STATS.shieldRegenPerSecond.base * 1.5)
    expect(cursed?.direction).toBe('inert')
    expect(cursed?.deltaText).toBe('(no effect: max shield 0)')
    // Both numbers stay on the row: the reader can see the rate did rise, and why that
    // does not help. A dropped row would just look like an item with no stats.
    expect(cursed?.text).toBe('Shield regen  4 → 6 hp/s')
  })

  it('flags it on the hull whose own modifier zeroes the shield', () => {
    expect(resolveStat('maxShield', modifiers({ hullId: 'collateral' }))).toBe(0)
    const entry = statDeltaRows({ current: modifiers({ hullId: 'collateral' }), added: FASTER })[0]
    expect(entry?.direction).toBe('inert')
  })

  it('flags it when the reserve rather than the pool is what is empty', () => {
    // The second gate: a shield that absorbs but a reserve that funds no recovery.
    const entry = statDeltaRows({
      current: [{ stat: 'shieldReservePerSector', kind: 'mul', value: 0 }],
      added: FASTER,
    })[0]
    expect(entry?.direction).toBe('inert')
    expect(entry?.deltaText).toBe('(no effect: regen reserve 0)')
  })

  it('does not flag it when there is a shield and a reserve', () => {
    for (const build of [{}, { hullId: 'surety' }, { hullId: 'probate' }]) {
      const entry = statDeltaRows({ current: modifiers(build), added: FASTER })[0]
      expect(entry?.direction, JSON.stringify(build)).toBe('better')
    }
  })

  it('is decided after the item is fitted, not before', () => {
    // An item that both raises the gate off zero and moves the gated stat is not inert.
    const rows = statDeltaRows({
      current: modifiers({ hullId: 'collateral' }),
      added: [
        { stat: 'maxShield', kind: 'add', value: 30 },
        { stat: 'shieldRegenPerSecond', kind: 'add', value: 2 },
      ],
    })
    expect(rows.map((entry) => entry.direction)).toEqual(['better', 'better'])
  })

  it('reads a rate through the multipliers already fitted', () => {
    // TWO muls, which is the case the naive implementation gets wrong twice: 4 × 1.5 = 6
    // and then × 3 = 18. Applying a "3x, from 4 to 12" delta of +8 to the resolved 6
    // would print 14.
    const rows = statDeltaRows({
      current: FASTER,
      added: [
        { stat: 'maxShield', kind: 'mul', value: 0.4 },
        { stat: 'shieldRegenPerSecond', kind: 'mul', value: 3 },
      ],
    })
    expect(rows.map((entry) => `${entry.text} ${entry.deltaText}`)).toEqual([
      'Max shield  40 → 16 hp (-24)',
      'Shield regen  6 → 18 hp/s (+12)',
    ])
  })

  it('shows the recovery delay in seconds', () => {
    // 150 ticks is 2.5 s. "150 → 90" would be the engine's unit on a player's card.
    const entry = statDeltaRows({
      current: [],
      added: [{ stat: 'shieldRegenDelayTicks', kind: 'add', value: -60 }],
    })[0]
    expect(entry?.text).toBe('Regen delay  2.5 → 1.5 s')
    expect(entry?.direction).toBe('better')
    expect(entry?.deltaText).toBe('(-1)')
  })

  it('holds for every roster item that touches a gated stat', () => {
    // Derived from content, so it covers whatever the roster carries today without
    // naming an id. Vacuously true only if no item touches recovery at all, which the
    // count below refuses to let pass silently.
    const gated: readonly StatKey[] = ['shieldRegenPerSecond', 'shieldRegenDelayTicks']
    let checked = 0
    for (const def of Object.values(ITEMS)) {
      if (!def.stats?.some((modifier) => gated.includes(modifier.stat))) continue
      checked++
      for (const entry of rowsFor({ hullId: 'collateral' }, def.id)) {
        if (!gated.includes(entry.stat)) continue
        expect(entry.direction, `${def.id} ${entry.stat} on a hull with no shield`).toBe('inert')
      }
    }
    expect(checked, 'no item in the roster touches shield recovery').toBeGreaterThan(0)
  })
})

describe('direction comes from the stat table, not the printed sign', () => {
  it('reads a falling fire interval as a rising, better shots/second', () => {
    // The one stat where the two disagree: raw 3 → 2 ticks is *lower*, and
    // `lowerIsBetter`, and presented as 20 → 30 shots/s it is *higher*. A card that
    // took its sign from either one alone gets this backwards.
    const relay = row({}, 'feed-relay', 'fireIntervalTicks')
    expect(STATS.fireIntervalTicks.lowerIsBetter).toBe(true)
    expect(relay.before).toBe(20)
    expect(relay.after).toBe(30)
    expect(relay.delta).toBe(10)
    expect(relay.direction).toBe('better')
    expect(relay.unit).toBe('shots/s')
    // Ticks are an engine unit and must never reach the card.
    expect(relay.text).not.toContain('tick')
  })

  it('reads a rising focus factor as worse, and a falling one as better', () => {
    // Nothing in the roster moves `focusFactor` yet, so it is exercised directly — the
    // flag exists precisely so the first item that does cannot ship a green plus sign
    // on a drawback.
    expect(STATS.focusFactor.lowerIsBetter).toBe(true)
    const tighter = statDeltaRows({
      current: [],
      added: [{ stat: 'focusFactor', kind: 'mul', value: 0.5 }],
    })[0]
    expect(tighter?.before).toBe(45)
    expect(tighter?.after).toBe(22.5)
    expect(tighter?.direction).toBe('better')
    const looser = statDeltaRows({
      current: [],
      added: [{ stat: 'focusFactor', kind: 'mul', value: 2 }],
    })[0]
    // Clamped at 1, so 0.45 → 0.9 rather than 1.8 — the row shows the honest ceiling.
    expect(looser?.after).toBe(90)
    expect(looser?.direction).toBe('worse')
  })

  it('marks a cost as worse even when the item is mostly a gain', () => {
    const rows = rowsFor({}, 'warheads')
    const damage = rows.find((entry) => entry.stat === 'projectileDamage')
    const speed = rows.find((entry) => entry.stat === 'projectileSpeed')
    expect(damage?.direction).toBe('better')
    expect(speed?.direction).toBe('worse')
    expect(speed?.deltaText).toBe('(-93)')
  })

  it('announces nothing it cannot print', () => {
    // A change below the card's precision. Raw damage moves 4 → 4.04, which rounds to
    // the same number, so claiming an improvement would point at two identical figures.
    const hair = statDeltaRows({
      current: [],
      added: [{ stat: 'projectileDamage', kind: 'mul', value: 1.01 }],
    })[0]
    expect(hair?.before).toBe(4)
    expect(hair?.after).toBe(4)
    expect(hair?.direction).toBe('none')
    expect(hair?.deltaText).toBe(NO_CHANGE_TEXT)
  })
})

describe('the build reconstruction mirrors the simulation', () => {
  /**
   * The property the "before" column depends on.
   *
   * `collectBuildModifiers` is a read-only copy of `resolveInventory`'s fold, so it can
   * drift from it — a stack applied once, a hull ignored, an interaction's stats
   * missed. Any of those makes every "before" on the card wrong in a way no assertion
   * about the card's own arithmetic would catch, so it is checked against the sim's own
   * function.
   */
  const cases: readonly Build[] = [
    {},
    { hullId: 'lien' },
    { hullId: 'surety' },
    { hullId: 'probate', held: held('repair-nanites', ['plating-shim', 3]) },
    { hullId: 'collateral', held: held(['feed-relay', 2], 'warheads', 'scrap-magnet') },
    {
      held: held('overkill-accounting', 'warheads'),
      active: [{ defId: 'overkill-warheads', text: 'x' }],
    },
    { hullId: 'arrears', held: held('exposed-core', ['machined-slugs', 4]) },
  ]

  it('resolves every stat to the same value the sim does', () => {
    for (const build of cases) {
      const hull = build.hullId === undefined ? undefined : HULLS[build.hullId]
      const live = new Set((build.active ?? []).map((entry) => entry.defId))
      const sim = resolveInventory(
        build.held ?? [],
        ITEMS,
        INTERACTIONS.filter((entry) => live.has(entry.id)),
        hull ? { id: hull.id, stats: hull.stats } : undefined,
      )
      const mine = resolveAllStats(modifiers(build))
      for (const stat of STAT_KEYS) {
        expect(mine[stat], `${build.hullId ?? 'no hull'} / ${stat}`).toBeCloseTo(sim.stats[stat], 9)
      }
    }
  })

  it('counts an interaction the sim declared live', () => {
    // Overkill Warheads carries scrapMultiplier mul 1.2. Ignoring it would put the
    // "before" of every scrap row out of step with the panel.
    const build: Build = {
      held: held('overkill-accounting', 'warheads'),
      active: [{ defId: 'overkill-warheads', text: 'x' }],
    }
    const withIt = resolveStat('scrapMultiplier', modifiers(build))
    const withoutIt = resolveStat('scrapMultiplier', modifiers({ held: build.held ?? [] }))
    expect(withIt).toBeCloseTo(withoutIt * 1.2, 9)
  })

  it('ignores an unknown hull, an unknown item and a nonsense stack rather than throwing', () => {
    expect(modifiers({ hullId: 'no-such-hull' })).toHaveLength(0)
    expect(modifiers({ held: held('no-such-item') })).toHaveLength(0)
    expect(
      collectBuildModifiers({
        held: [{ defId: 'machined-slugs', acquiredAtTick: 0, count: Number.NaN }],
        items: ITEMS,
        activeInteractions: [],
      }),
    ).toHaveLength(0)
    expect(
      collectBuildModifiers({
        held: [{ defId: 'machined-slugs', acquiredAtTick: 0, count: -3 }],
        items: ITEMS,
        activeInteractions: [],
      }),
    ).toHaveLength(0)
  })
})

describe('a row is dropped rather than contradicting the panel', () => {
  it('keeps rows when the simulation agrees', () => {
    const build = { hullId: 'surety' as string }
    const resolved = resolveAllStats(modifiers(build))
    const rows = statDeltaRows({
      current: modifiers(build),
      added: ITEMS['shield-cell']?.stats ?? [],
      resolved,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.before).toBe(110)
  })

  it('drops the row when it disagrees', () => {
    // A hull the screen does not know about, a content table the World was not built
    // with: the reconstruction is then not the build being flown, and a "before" the
    // instrument panel contradicts is worse than no row at all.
    const rows = statDeltaRows({
      current: modifiers({ hullId: 'surety' }),
      added: ITEMS['shield-cell']?.stats ?? [],
      resolved: { ...resolveAllStats(modifiers({ hullId: 'surety' })), maxShield: 999 },
    })
    expect(rows).toHaveLength(0)
  })

  it('drops only the stat that disagrees', () => {
    const build = { held: held('exposed-core') }
    const resolved = { ...resolveAllStats(modifiers(build)), projectileSpeed: 1 }
    const rows = statDeltaRows({
      current: modifiers(build),
      added: ITEMS.warheads?.stats ?? [],
      resolved,
    })
    expect(rows.map((entry) => entry.stat)).toEqual(['projectileDamage'])
  })
})

describe('presentation', () => {
  it('gives every stat a label and a unit, and never prints a raw tick', () => {
    // Rule 2: every number carries a unit. Swept over the whole stat table via a
    // synthetic modifier, so a stat added to `src/sim/stats.ts` without a presentation
    // fails here as well as at the typecheck.
    for (const stat of STAT_KEYS) {
      const entry = statDeltaRows({
        current: [],
        added: [{ stat, kind: 'add', value: 1 }],
      })[0]
      expect(entry, `${stat} produced no row`).toBeDefined()
      expect(entry?.label.length ?? 0).toBeGreaterThan(0)
      expect(entry?.unit.length ?? 0).toBeGreaterThan(0)
      expect(entry?.text).toContain(entry?.unit ?? '')
      expect(entry?.label.toLowerCase()).not.toContain('tick')
      expect(entry?.unit.toLowerCase()).not.toContain('tick')
    }
  })

  it('presents both tick-denominated stats in the units a player thinks in', () => {
    // The two engine-unit stats, checked by value rather than by label so a change to
    // either presentation has to be deliberate.
    const rate = statDeltaRows({
      current: [],
      added: [{ stat: 'fireIntervalTicks', kind: 'add', value: -1 }],
    })[0]
    expect(rate?.before).toBe(TICK_HZ / STATS.fireIntervalTicks.base)
    const delay = statDeltaRows({
      current: [],
      added: [{ stat: 'shieldRegenDelayTicks', kind: 'add', value: -60 }],
    })[0]
    expect(delay?.before).toBe(STATS.shieldRegenDelayTicks.base / TICK_HZ)
    expect(delay?.after).toBe((STATS.shieldRegenDelayTicks.base - 60) / TICK_HZ)
    expect(delay?.unit).toBe('s')
    expect(delay?.direction).toBe('better')
  })

  it('rounds to one decimal and always shows a sign', () => {
    expect(numeral(75.52)).toBe('75.5')
    expect(numeral(22)).toBe('22')
    expect(numeral(Number.NaN)).toBe('—')
    expect(signed(11.5)).toBe('+11.5')
    expect(signed(-93)).toBe('-93')
    expect(signed(0)).toBe('0')
  })

  it('lists rows in stat-table order, so two offers agree on which comes first', () => {
    const rows = rowsFor({}, 'warheads').map((entry) => entry.stat)
    const expected = STAT_KEYS.filter((stat) => rows.includes(stat))
    expect(rows).toEqual(expected)
  })

  it('produces nothing for an item that is pure behaviour', () => {
    expect(ITEMS['retaliation-coil']?.stats).toBeUndefined()
    expect(rowsFor({}, 'retaliation-coil')).toHaveLength(0)
    expect(rowsFor({}, 'not-a-real-item')).toHaveLength(0)
  })

  it('never emits NaN or undefined text for a hostile modifier', () => {
    const hostile: readonly StatModifier[] = [
      { stat: 'projectileDamage', kind: 'mul', value: Number.NaN },
      { stat: 'maxShield', kind: 'add', value: Infinity },
    ]
    for (const entry of statDeltaRows({ current: hostile, added: hostile })) {
      expect(Number.isFinite(entry.before)).toBe(true)
      expect(Number.isFinite(entry.after)).toBe(true)
      expect(entry.text).not.toMatch(/NaN|undefined/)
      expect(entry.deltaText).not.toMatch(/NaN|undefined/)
    }
  })
})
