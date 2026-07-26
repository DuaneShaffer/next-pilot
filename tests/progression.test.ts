/**
 * Run progression: the choice cursor, the offer draw, and shop pricing.
 *
 * Everything here is a pure function of state plus one `InputSnapshot`, which is
 * why it lives outside `world.ts` — and why it can be asserted tick by tick
 * rather than inferred from a whole sortie.
 *
 * Items are FABRICATED here rather than read from `src/content/items.ts`, for the
 * same reason `combat.test.ts` fabricates enemy defs: these tests assert what the
 * *simulation* does with a weight, a tier, or an interaction declaration, and a
 * balance pass must not be able to fail them. The live tables are checked in
 * `tests/items.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import type { InputSnapshot } from '../src/core/input'
import { NEUTRAL_INPUT } from '../src/core/input'
import { Rng } from '../src/core/rng'
import type { InteractionDef, ItemDef, ItemTier } from '../src/content/types'
import type { HeldItem, ItemOffer } from '../src/sim/entities'
import {
  CHOICE_TIMEOUT_TICKS,
  HELD_CONFIRM_DWELL_TICKS,
  OFFER_COUNT,
  buildOffers,
  makeChoice,
  newCursor,
  shopCosts,
  updateCursor,
  type ChoiceAction,
  type ChoiceCursor,
} from '../src/sim/progression'

// --- fixtures ---------------------------------------------------------------

function input(over: Partial<InputSnapshot> = {}): InputSnapshot {
  return { ...NEUTRAL_INPUT, ...over }
}

const IDLE = NEUTRAL_INPUT
const FIRE = input({ fire: true })
const SPECIAL = input({ special: true })
const LEFT = input({ moveX: -1 })
const RIGHT = input({ moveX: 1 })

function item(id: string, over: Partial<ItemDef> = {}): ItemDef {
  return {
    id,
    name: id,
    tier: 'common',
    tags: ['weapon'],
    mechanism: `${id} does a thing.`,
    ...over,
  }
}

function table(...defs: ItemDef[]): Record<string, ItemDef> {
  return Object.fromEntries(defs.map((def) => [def.id, def]))
}

function held(...defIds: string[]): HeldItem[] {
  return defIds.map((defId, index) => ({ defId, acquiredAtTick: index * 10, count: 1 }))
}

const HOLDING_FIRE: InputSnapshot = {
  moveX: 0,
  moveY: 0,
  fire: true,
  special: false,
  focus: false,
}

function offer(defId: string): ItemOffer {
  return { defId, tier: 'common', interactionText: [] }
}

/** Feed a cursor a sequence of snapshots and collect what it reported. */
function drive(
  cursor: ChoiceCursor,
  inputs: readonly InputSnapshot[],
  optionCount: number,
): ChoiceAction[] {
  return inputs.map((snapshot) => updateCursor(cursor, snapshot, optionCount))
}

function repeat(snapshot: InputSnapshot, ticks: number): InputSnapshot[] {
  return Array.from({ length: ticks }, () => snapshot)
}

// --- confirming and skipping -------------------------------------------------

/**
 * The rising-edge rule.
 *
 * This is the single most load-bearing behaviour in the file. The player is
 * almost certainly holding the trigger at the moment a wave dies and a reward
 * opens, so a held button that counted as a press would confirm the first option
 * on the first tick — the reward screen would flash past before it could be read,
 * and the pick would be made by whichever option the draw happened to put first.
 * Interface clarity is priority 1 in CLAUDE.md; a screen the player never sees is
 * the worst possible failure of it.
 */
describe('choice cursor — confirming', () => {
  it('does not confirm from a held trigger before the card can be read', () => {
    /**
     * UPDATED at the soft-freeze fix. This previously asserted that a held trigger
     * NEVER confirms, which was the whole bug: a player holding fire — the normal
     * state in a shmup — got a card that ignored them for a minute.
     *
     * The property worth keeping is that a card cannot flash past unread, so the
     * assertion is now about the dwell rather than about never.
     */
    const cursor = newCursor()
    const before = drive(cursor, repeat(FIRE, HELD_CONFIRM_DWELL_TICKS - 1), OFFER_COUNT)
    for (const action of before) expect(action.kind).toBe('none')
    // And the dwell is long enough to actually read three options.
    expect(HELD_CONFIRM_DWELL_TICKS).toBeGreaterThanOrEqual(30)
  })

  it('confirms on the first press after a release', () => {
    const cursor = newCursor()
    expect(updateCursor(cursor, FIRE, OFFER_COUNT).kind).toBe('none')
    expect(updateCursor(cursor, IDLE, OFFER_COUNT).kind).toBe('none')
    expect(updateCursor(cursor, FIRE, OFFER_COUNT)).toEqual({
      kind: 'confirm',
      index: 0,
      // A deliberate press, not the held-trigger rescue. The distinction is
      // load-bearing: only a rescue may decline an unaffordable option on the
      // player's behalf. See ChoiceAction.fromDwell.
      fromDwell: false,
    })
  })

  it('confirms once per press, not once per held tick', () => {
    // A second confirm would resolve a choice that is already resolved. The world
    // clears `pendingChoice` on the first one, but the cursor must not be the thing
    // relying on that.
    const cursor = newCursor()
    drive(cursor, [IDLE], OFFER_COUNT)
    const actions = drive(cursor, repeat(FIRE, 30), OFFER_COUNT)
    expect(actions.filter((a) => a.kind === 'confirm')).toHaveLength(1)
    expect(actions[0]).toEqual({ kind: 'confirm', index: 0, fromDwell: false })
  })

  it('confirms the option the same tick moved to', () => {
    // Movement is applied before the confirm is read, so a player who flicks right
    // and presses fire on the same tick gets the option they flicked to — not the
    // one they were on a tick earlier.
    const cursor = newCursor()
    drive(cursor, [IDLE], OFFER_COUNT)
    expect(updateCursor(cursor, input({ moveX: 1, fire: true }), OFFER_COUNT)).toEqual({
      kind: 'confirm',
      index: 1,
      fromDwell: false,
    })
  })

  it('never confirms when there is nothing to confirm', () => {
    // An empty offer list must not resolve to "took option 0" — there is no option 0.
    const cursor = newCursor()
    drive(cursor, [IDLE], 0)
    expect(updateCursor(cursor, FIRE, 0).kind).toBe('none')
  })
})

describe('choice cursor — skipping', () => {
  it('never skips from a special button that was already held', () => {
    // Same failure as a held trigger, in the other direction: the reward would be
    // declined before it was seen. A shop must be *declinable*, not auto-declined.
    const cursor = newCursor()
    for (const action of drive(cursor, repeat(SPECIAL, 600), OFFER_COUNT)) {
      expect(action.kind).toBe('none')
    }
  })

  it('skips on the first press after a release', () => {
    const cursor = newCursor()
    expect(updateCursor(cursor, SPECIAL, OFFER_COUNT).kind).toBe('none')
    expect(updateCursor(cursor, IDLE, OFFER_COUNT).kind).toBe('none')
    expect(updateCursor(cursor, SPECIAL, OFFER_COUNT)).toEqual({ kind: 'skip' })
  })

  it('can skip a choice with no options at all', () => {
    // The one thing that must still work when the offer list is empty: getting out.
    const cursor = newCursor()
    drive(cursor, [IDLE], 0)
    expect(updateCursor(cursor, SPECIAL, 0)).toEqual({ kind: 'skip' })
  })
})

// --- moving the selection ----------------------------------------------------

describe('choice cursor — selection', () => {
  it('moves one step per press and does not scroll while held', () => {
    // A held direction that scrolled every tick would run through the options 60
    // times a second and land somewhere arbitrary — the selection would be
    // unaimable.
    //
    // Asserted tick by tick rather than by the index at the end of the hold: with
    // three options, a hundred ticks of level-triggered scrolling lands back on
    // index 1 (100 mod 3) and an end-state assertion would pass a broken cursor.
    const cursor = newCursor()
    drive(cursor, [IDLE], OFFER_COUNT)
    updateCursor(cursor, RIGHT, OFFER_COUNT)
    expect(cursor.index).toBe(1)
    for (let tick = 1; tick <= 100; tick++) {
      updateCursor(cursor, RIGHT, OFFER_COUNT)
      expect(cursor.index, `still held at tick ${tick}`).toBe(1)
    }

    // A second press moves it exactly one more.
    drive(cursor, [IDLE], OFFER_COUNT)
    updateCursor(cursor, RIGHT, OFFER_COUNT)
    expect(cursor.index).toBe(2)
  })

  it('moves left as well as right, one press at a time', () => {
    const cursor = newCursor()
    drive(cursor, [IDLE, RIGHT, IDLE, RIGHT], OFFER_COUNT)
    expect(cursor.index).toBe(2)

    drive(cursor, [IDLE], OFFER_COUNT)
    updateCursor(cursor, LEFT, OFFER_COUNT)
    expect(cursor.index).toBe(1)
    for (let tick = 1; tick <= 100; tick++) {
      updateCursor(cursor, LEFT, OFFER_COUNT)
      expect(cursor.index, `still held at tick ${tick}`).toBe(1)
    }
  })

  it('wraps at both ends', () => {
    // Three options on a card: wrapping means the third is one press from the
    // first in either direction, so no option is further away than any other.
    const cursor = newCursor()
    drive(cursor, [IDLE, LEFT], OFFER_COUNT)
    expect(cursor.index).toBe(OFFER_COUNT - 1)

    drive(cursor, [IDLE, RIGHT], OFFER_COUNT)
    expect(cursor.index).toBe(0)
  })

  it('stays in range for every option count, including zero', () => {
    // The offer list is built from a content table, so its length is data. A
    // selection outside it would index `undefined` and silently take nothing —
    // which reads as the confirm button being broken.
    const rng = Rng.fromSeed('CURSORFUZZ12', 'test')
    for (const optionCount of [0, 1, 2, 3, 5]) {
      const cursor = newCursor()
      for (let tick = 0; tick < 500; tick++) {
        const moveX = (rng.int(3) - 1) as -1 | 0 | 1
        const action = updateCursor(
          cursor,
          input({ moveX, fire: rng.chance(0.3), special: false }),
          optionCount,
        )
        expect(cursor.index).toBeGreaterThanOrEqual(0)
        expect(cursor.index).toBeLessThan(Math.max(1, optionCount))
        if (action.kind === 'confirm') {
          expect(action.index).toBeLessThan(optionCount)
        }
      }
    }
  })
})

// --- the deadlock guard ------------------------------------------------------

/**
 * The timeout is a SAFETY NET, not the intended path.
 *
 * Because confirming needs a rising edge, anyone who never releases the trigger
 * waits forever and the run simply stops. An aggressive bot policy that holds
 * fire constantly deadlocked its run exactly this way — which is a hang, in a
 * harness whose whole job is to run thousands of unattended sorties.
 *
 * So the tick it fires is asserted exactly. Too early and it steals a real
 * decision from a player who is reading the card; too late (or never) and the
 * deadlock is back.
 */
describe('choice timeout', () => {
  it('auto-skips on exactly CHOICE_TIMEOUT_TICKS, and not a tick before', () => {
    const cursor = newCursor()
    for (let tick = 1; tick < CHOICE_TIMEOUT_TICKS; tick++) {
      expect(updateCursor(cursor, IDLE, OFFER_COUNT).kind, `tick ${tick}`).toBe('none')
    }
    expect(updateCursor(cursor, IDLE, OFFER_COUNT)).toEqual({ kind: 'skip' })
  })

  it('resolves a never-released trigger by confirming, long before the timeout', () => {
    /**
     * UPDATED at the soft-freeze fix. The timeout used to be the only thing that
     * rescued this case, 60 seconds later — which is what the tester experienced as
     * a freeze. The dwell now resolves it in under a second, and the timeout has
     * become a true backstop that healthy input never reaches.
     */
    const cursor = newCursor()
    const actions = drive(cursor, repeat(FIRE, CHOICE_TIMEOUT_TICKS), OFFER_COUNT)
    const firstResolved = actions.findIndex((a) => a.kind !== 'none')
    expect(firstResolved).toBeGreaterThan(0)
    expect(firstResolved).toBeLessThan(HELD_CONFIRM_DWELL_TICKS + 2)
    expect(actions[firstResolved]?.kind).toBe('confirm')
  })

  it('is long enough to be a backstop rather than a timer', () => {
    // A reward screen with a visible countdown is a different design. This must
    // outlast any real decision — but it was 60s, and 60s of an apparently frozen
    // game is indistinguishable from a crash. Shortened once the dwell made it
    // genuinely unreachable by normal input.
    expect(CHOICE_TIMEOUT_TICKS).toBeGreaterThanOrEqual(15 * 60)
    expect(CHOICE_TIMEOUT_TICKS).toBeGreaterThan(HELD_CONFIRM_DWELL_TICKS * 4)
  })

  it('counts open ticks, not presses', () => {
    const cursor = newCursor()
    expect(cursor.openTicks).toBe(0)
    drive(cursor, repeat(IDLE, 42), OFFER_COUNT)
    expect(cursor.openTicks).toBe(42)
  })
})

// --- the offer draw ----------------------------------------------------------

describe('buildOffers', () => {
  const pool = table(
    item('alpha'),
    item('bravo'),
    item('charlie'),
    item('delta'),
    item('echo'),
    item('foxtrot'),
  )

  it('is deterministic for a seed', () => {
    // A build has to be reproducible from its seed, or a shared daily contract is
    // two different runs and a recorded replay picks different items on playback.
    const a = buildOffers(Rng.fromSeed('OFFERSEED123', 'offers'), pool, [], [])
    const b = buildOffers(Rng.fromSeed('OFFERSEED123', 'offers'), pool, [], [])
    expect(a).toEqual(b)
  })

  it('draws differently for a different seed', () => {
    // Without this the determinism assertion above is satisfied by a constant.
    const a = buildOffers(Rng.fromSeed('OFFERSEEDAAA', 'offers'), pool, [], [])
    const b = buildOffers(Rng.fromSeed('OFFERSEEDZZZ', 'offers'), pool, [], [])
    expect(a).not.toEqual(b)
  })

  it('offers three DISTINCT items', () => {
    // Two identical offers is a choice of two presented as a choice of three, and
    // the duplicate costs the player a real option.
    const rng = Rng.fromSeed('DISTINCT1234', 'offers')
    for (let draw = 0; draw < 200; draw++) {
      const offers = buildOffers(rng, pool, [], [])
      expect(offers).toHaveLength(OFFER_COUNT)
      expect(new Set(offers.map((o) => o.defId)).size).toBe(OFFER_COUNT)
    }
  })

  it('never offers a zero-weight item', () => {
    // Weight 0 is how content marks an item as unlockable-but-not-random. Offering
    // it anyway would leak unreleased or event-only content into a normal run.
    const withDud = table(
      item('alpha'),
      item('bravo'),
      item('charlie'),
      item('delta'),
      item('never', { weight: 0 }),
    )
    const rng = Rng.fromSeed('ZEROWEIGHT12', 'offers')
    for (let draw = 0; draw < 300; draw++) {
      for (const o of buildOffers(rng, withDud, [], [])) {
        expect(o.defId).not.toBe('never')
      }
    }
  })

  it('treats an unset weight as offerable', () => {
    const offers = buildOffers(Rng.fromSeed('UNSETWEIGHT1', 'offers'), table(item('only')), [], [])
    expect(offers.map((o) => o.defId)).toEqual(['only'])
  })

  it('returns nothing for an empty pool instead of throwing', () => {
    // A sim test running on an empty content table must not crash, and a run that
    // reaches a reward wave with nothing to offer must not stall.
    expect(buildOffers(Rng.fromSeed('EMPTYPOOL123', 'offers'), {}, [], [])).toEqual([])
  })

  it('returns nothing when every item has zero weight', () => {
    // The weighted draw throws if the total weight is zero, so the filter has to
    // empty the pool before it gets there.
    const allZero = table(item('a', { weight: 0 }), item('b', { weight: 0 }))
    expect(() => buildOffers(Rng.fromSeed('ALLZERO12345', 'offers'), allZero, [], [])).not.toThrow()
    expect(buildOffers(Rng.fromSeed('ALLZERO12345', 'offers'), allZero, [], [])).toEqual([])
  })

  it('offers a short pool without padding or repeating it', () => {
    for (const size of [1, 2]) {
      const short = table(...Array.from({ length: size }, (_, i) => item(`i${i}`)))
      const offers = buildOffers(Rng.fromSeed('SHORTPOOL123', 'offers'), short, [], [])
      expect(offers).toHaveLength(size)
      expect(new Set(offers.map((o) => o.defId)).size).toBe(size)
    }
  })

  /**
   * UI rule 5: a synergy is *stated* when it is offered.
   *
   * The choice screen asks the simulation this question rather than working it out
   * for itself, so it cannot fail to mention one. It has to be the offers that
   * carry the text — an interaction the player is never told about is
   * indistinguishable from an interaction that does not exist.
   */
  it('fills interactionText only for an offer that would newly unlock one', () => {
    const combo: InteractionDef = {
      id: 'alpha-bravo',
      requires: ['alpha', 'bravo'],
      text: 'Alpha rounds arc through Bravo.',
      stats: [{ stat: 'projectileDamage', kind: 'add', value: 1 }],
    }
    const trio = table(item('alpha'), item('bravo'), item('charlie'))
    const offers = buildOffers(Rng.fromSeed('INTERTEXT123', 'offers'), trio, [combo], held('bravo'))
    expect(offers).toHaveLength(3)

    const byId = new Map(offers.map((o) => [o.defId, o.interactionText]))
    // Taking alpha completes the pair, so the card must say so.
    expect(byId.get('alpha')).toEqual([combo.text])
    // Bravo is already held — nothing about this choice would change.
    expect(byId.get('bravo')).toEqual([])
    // Charlie is in no interaction at all.
    expect(byId.get('charlie')).toEqual([])
  })

  it('says nothing about interactions the build cannot reach yet', () => {
    const combo: InteractionDef = {
      id: 'alpha-bravo',
      requires: ['alpha', 'bravo'],
      text: 'Alpha rounds arc through Bravo.',
    }
    const trio = table(item('alpha'), item('bravo'), item('charlie'))
    const offers = buildOffers(Rng.fromSeed('NOINTERTEXT1', 'offers'), trio, [combo], [])
    for (const o of offers) expect(o.interactionText).toEqual([])
  })
})

// --- shop pricing ------------------------------------------------------------

describe('shopCosts', () => {
  const tiers: readonly ItemTier[] = ['common', 'uncommon', 'rare', 'relic']
  const priced = table(...tiers.map((tier) => item(tier, { tier })))

  it('prices each tier above the one below it', () => {
    const costs = shopCosts(
      tiers.map((tier) => offer(tier)),
      priced,
    )
    expect(costs).toHaveLength(tiers.length)
    for (let i = 1; i < costs.length; i++) {
      expect(costs[i] as number, `${tiers[i]} vs ${tiers[i - 1]}`).toBeGreaterThan(
        costs[i - 1] as number,
      )
    }
  })

  it('returns a whole, non-negative number for every tier', () => {
    // Scrap is an integer currency shown in the panel. A cost of 191.99999 would
    // render as a fraction and could never be met exactly, and a negative cost
    // would pay the player for shopping.
    for (const tier of tiers) {
      const cost = shopCosts([offer(tier)], priced)[0] as number
      expect(Number.isInteger(cost), `${tier} cost ${cost}`).toBe(true)
      expect(cost).toBeGreaterThan(0)
    }
  })

  it('keeps costs aligned with the offers they price', () => {
    // The world pairs `costs[i]` with `offers[i]`, so a reordering here would
    // charge relic prices for common items.
    const shuffled = [offer('relic'), offer('common'), offer('rare'), offer('uncommon')]
    const costs = shopCosts(shuffled, priced)
    const byTier = new Map(tiers.map((tier) => [tier, shopCosts([offer(tier)], priced)[0]]))
    expect(costs).toEqual(shuffled.map((o) => byTier.get(o.defId as ItemTier)))
  })

  it('prices an unknown item as common rather than throwing', () => {
    // A stale save or a renamed item must not crash a shop.
    const costs = shopCosts([offer('ghost')], priced)
    expect(costs).toEqual([shopCosts([offer('common')], priced)[0]])
  })

  it('prices an empty offer list as an empty cost list', () => {
    expect(shopCosts([], priced)).toEqual([])
  })
})

// --- the choice record -------------------------------------------------------

describe('makeChoice', () => {
  it('carries the offers, their costs, and no work orders or routes by default', () => {
    // A WHOLE-OBJECT comparison on purpose. Every card kind reads a different field
    // off the same struct, so a new kind that forgets to default its own field would
    // hand the world an `undefined` to take `.length` of. This is the assertion that
    // makes adding a kind fail here rather than at a stage boundary.
    const offers = [offer('alpha'), offer('bravo')]
    expect(makeChoice('item', offers, [0, 0])).toEqual({
      kind: 'item',
      offers,
      costs: [0, 0],
      workOrders: [],
      routes: [],
    })
  })

  it('carries work orders without offers', () => {
    // A work order is a choice with no items in it, so the world reads its option
    // count from `workOrders` instead. An empty `offers` here is the signal.
    const choice = makeChoice('work-order', [], [], ['supply', 'hazard'])
    expect(choice.offers).toEqual([])
    expect(choice.workOrders).toEqual(['supply', 'hazard'])
  })
})

describe('a held trigger can never make the card unresponsive', () => {
  /**
   * REGRESSION — a tester reported "the occasional soft freeze".
   *
   * Confirming required a rising fire edge, so a player holding the trigger when a
   * reward opened sat looking at a card that ignored the button they were pressing
   * until a 60-second timeout. In a shmup the trigger is always held, so this was
   * the normal case rather than an edge case, and nothing on screen explained it.
   *
   * The rising edge still matters — without it a card flashes past unread — so the
   * fix is a dwell rather than a removal, and these tests pin both halves.
   */
  it('does not confirm instantly for a trigger already held', () => {
    const cursor = newCursor()
    for (let tick = 0; tick < HELD_CONFIRM_DWELL_TICKS - 1; tick++) {
      expect(updateCursor(cursor, HOLDING_FIRE, 3).kind, `tick ${tick}`).toBe('none')
    }
  })

  it('confirms a held trigger once the dwell has passed', () => {
    const cursor = newCursor()
    let action = updateCursor(cursor, HOLDING_FIRE, 3)
    for (let tick = 1; tick < HELD_CONFIRM_DWELL_TICKS; tick++) {
      action = updateCursor(cursor, HOLDING_FIRE, 3)
    }
    // Resolves in well under a second, and far inside the timeout — the game never
    // appears to stop responding.
    expect(action.kind).toBe('confirm')
    expect(HELD_CONFIRM_DWELL_TICKS).toBeLessThan(CHOICE_TIMEOUT_TICKS / 4)
  })

  it('reports that it is waiting for a release, so the screen can say so', () => {
    const cursor = newCursor()
    updateCursor(cursor, HOLDING_FIRE, 3)
    expect(cursor.awaitingRelease).toBe(true)
    updateCursor(cursor, NEUTRAL_INPUT, 3)
    expect(cursor.awaitingRelease).toBe(false)
  })

  it('still confirms immediately on a deliberate release-and-press', () => {
    // A player who releases must not be made to wait out a dwell they never needed.
    const cursor = newCursor()
    updateCursor(cursor, HOLDING_FIRE, 3)
    updateCursor(cursor, NEUTRAL_INPUT, 3)
    expect(updateCursor(cursor, HOLDING_FIRE, 3).kind).toBe('confirm')
  })

  it('never leaves a card open longer than the timeout under any input', () => {
    // Belt and braces: whatever the player does, the run resumes.
    for (const input of [HOLDING_FIRE, NEUTRAL_INPUT]) {
      const cursor = newCursor()
      let resolved = false
      for (let tick = 0; tick < CHOICE_TIMEOUT_TICKS + 2 && !resolved; tick++) {
        if (updateCursor(cursor, input, 3).kind !== 'none') resolved = true
      }
      expect(resolved, `unresolved for input fire=${input.fire}`).toBe(true)
    }
  })
})
