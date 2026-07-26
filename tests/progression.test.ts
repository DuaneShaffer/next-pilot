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
/**
 * The accept press: `confirm`, never `fire`.
 *
 * A card does not read the trigger — "the selection screens must not use the fire key to
 * accept responses" — so `input({ fire: true })` is now indistinguishable from IDLE as far
 * as this cursor is concerned. `HOLDING_FIRE` below exists to assert exactly that.
 */
const CONFIRM = input({ confirm: true })
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

/** The trigger, held. A card must be completely blind to it. */
const HOLDING_FIRE: InputSnapshot = input({ fire: true })

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
 * The rising-edge rule, and the key it reads.
 *
 * ACCEPTING IS `confirm`, NOT `fire`. Reported from play: "the selection screens must not
 * use the fire key to accept responses." The trigger is held permanently in a shmup, so
 * an accept action bound to it could not be pressed *on* a card at all — it was already
 * down — and every workaround for that (a 48-tick dwell that confirmed for the player, a
 * 20-second timeout that declined for them) had the interface making the choice.
 *
 * The rising edge still matters, for the seam rather than for the trigger: a seam opens
 * the next card in the same tick the previous one was accepted, so a level-triggered read
 * would take option 0 of the two cards behind it before the player could lift a finger.
 */
describe('choice cursor — confirming', () => {
  it('ignores the fire key completely, however long it is held', () => {
    // The whole point of the change. Not "waits for a dwell", not "resolves eventually":
    // a card cannot see the trigger. A minute of it, so a reinstated dwell fails here.
    const cursor = newCursor()
    for (const action of drive(cursor, repeat(HOLDING_FIRE, 60 * 60), OFFER_COUNT)) {
      expect(action.kind).toBe('none')
    }
  })

  it('does not confirm from a confirm key that was already down', () => {
    // The seam case: a card that opens under a still-held accept key must not take
    // option 0 before it has been on screen for a single readable tick.
    const cursor = newCursor()
    for (const action of drive(cursor, repeat(CONFIRM, 30), OFFER_COUNT)) {
      expect(action.kind).toBe('none')
    }
  })

  it('confirms on the first press after a release', () => {
    const cursor = newCursor()
    expect(updateCursor(cursor, CONFIRM, OFFER_COUNT).kind).toBe('none')
    expect(updateCursor(cursor, IDLE, OFFER_COUNT).kind).toBe('none')
    expect(updateCursor(cursor, CONFIRM, OFFER_COUNT)).toEqual({ kind: 'confirm', index: 0 })
  })

  it('confirms immediately when the key was not down as the card opened', () => {
    // The normal case, and the one the old design could not deliver: one press, one
    // accept, no waiting for anything.
    const cursor = newCursor()
    drive(cursor, [IDLE], OFFER_COUNT)
    expect(updateCursor(cursor, CONFIRM, OFFER_COUNT)).toEqual({ kind: 'confirm', index: 0 })
  })

  it('confirms once per press, not once per held tick', () => {
    // A second confirm would resolve a choice that is already resolved. The world
    // clears `pendingChoice` on the first one, but the cursor must not be the thing
    // relying on that.
    const cursor = newCursor()
    drive(cursor, [IDLE], OFFER_COUNT)
    const actions = drive(cursor, repeat(CONFIRM, 30), OFFER_COUNT)
    expect(actions.filter((a) => a.kind === 'confirm')).toHaveLength(1)
    expect(actions[0]).toEqual({ kind: 'confirm', index: 0 })
  })

  it('confirms the option the same tick moved to', () => {
    // Movement is applied before the confirm is read, so a player who flicks right
    // and presses accept on the same tick gets the option they flicked to — not the
    // one they were on a tick earlier.
    const cursor = newCursor()
    drive(cursor, [IDLE], OFFER_COUNT)
    expect(updateCursor(cursor, input({ moveX: 1, confirm: true }), OFFER_COUNT)).toEqual({
      kind: 'confirm',
      index: 1,
    })
  })

  it('never confirms when there is nothing to confirm', () => {
    // An empty offer list must not resolve to "took option 0" — there is no option 0.
    const cursor = newCursor()
    drive(cursor, [IDLE], 0)
    expect(updateCursor(cursor, CONFIRM, 0).kind).toBe('none')
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

// --- no timeout --------------------------------------------------------------

/**
 * A CARD NEVER CLOSES ITSELF. Reported from play: "the shops shouldn't close
 * automatically, that's annoying."
 *
 * Two rules used to close one: `CHOICE_TIMEOUT_TICKS = 20 * 60` declined any open card
 * after twenty seconds, and a 48-tick dwell confirmed the highlighted option for anyone
 * still holding the fire key. Both existed because accepting WAS the fire key, so a card
 * opened under a held trigger could not be accepted at all — and what the timeout
 * actually reached, once the dwell covered that, was a player holding nothing: somebody
 * reading the card, which is what the screen is for.
 *
 * A paused run is not a deadlock. These tests are what stops either rule coming back.
 */
describe('a choice never resolves itself on time alone', () => {
  /** Three times the old 20-second timeout, so any plausible reinstatement fails. */
  const A_LONG_TIME = 60 * 60

  it('never resolves an untouched card, however long it is left', () => {
    const cursor = newCursor()
    for (let tick = 1; tick <= A_LONG_TIME; tick++) {
      expect(updateCursor(cursor, IDLE, OFFER_COUNT).kind, `tick ${tick}`).toBe('none')
    }
  })

  it('never resolves a card under any held input', () => {
    // Every button, held for a minute each. The old design had two escapes from this
    // state and both of them decided the card; there must now be none.
    for (const stuck of [HOLDING_FIRE, CONFIRM, SPECIAL, LEFT, RIGHT]) {
      const cursor = newCursor()
      for (const action of drive(cursor, repeat(stuck, A_LONG_TIME), OFFER_COUNT)) {
        expect(action.kind, `held ${JSON.stringify(stuck)}`).toBe('none')
      }
    }
  })

  it('still counts open ticks, because an observer reads them', () => {
    // Nothing in the sim branches on this any more; `WorldView.choiceResolve.openTicks`
    // is how a bot or the playtest harness tells this card from the next one at a seam,
    // and the harness's stall bound is measured in it.
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

describe('the trigger is not an accept key', () => {
  /**
   * REGRESSION, TWICE OVER.
   *
   * A tester reported "the occasional soft freeze": accepting required a rising fire
   * edge, so a player holding the trigger when a reward opened sat looking at a card
   * that ignored the button they were pressing. The first fix was a dwell that confirmed
   * the highlighted option after 48 ticks, which fixed the freeze by making the
   * interface pick for them — and on touch, where auto-fire never releases, that was
   * every card on the platform.
   *
   * The real fix was to stop reading the trigger. "The selection screens must not use
   * the fire key to accept responses."
   */
  it('does not confirm from a held trigger, ever', () => {
    const cursor = newCursor()
    for (const action of drive(cursor, repeat(HOLDING_FIRE, 60 * 60), 3)) {
      expect(action.kind).toBe('none')
    }
  })

  it('does not confirm from a pulsed trigger either', () => {
    // Rising fire edges, over and over. The edge was the whole mechanism before; now the
    // key simply is not read, so pressing it a hundred times must change nothing.
    const cursor = newCursor()
    for (let tick = 0; tick < 300; tick++) {
      const action = updateCursor(cursor, tick % 2 === 0 ? HOLDING_FIRE : IDLE, 3)
      expect(action.kind, `tick ${tick}`).toBe('none')
    }
  })

  it('confirms from the accept key while the trigger is held down', () => {
    // The case that used to be impossible: a player who is still shooting can accept.
    const cursor = newCursor()
    drive(cursor, [HOLDING_FIRE], 3)
    expect(updateCursor(cursor, input({ fire: true, confirm: true }), 3)).toEqual({
      kind: 'confirm',
      index: 0,
    })
  })

  it('declines from the decline key while the trigger is held down', () => {
    const cursor = newCursor()
    drive(cursor, [HOLDING_FIRE], 3)
    expect(updateCursor(cursor, input({ fire: true, special: true }), 3)).toEqual({ kind: 'skip' })
  })

  it('navigates while the trigger is held down', () => {
    // Movement used to cancel the dwell rescue, which meant a player who navigated with
    // the trigger down could not resolve the card at all. Nothing interacts now.
    const cursor = newCursor()
    drive(cursor, [HOLDING_FIRE], 3)
    updateCursor(cursor, input({ fire: true, moveX: 1 }), 3)
    expect(cursor.index).toBe(1)
    updateCursor(cursor, input({ fire: true }), 3)
    expect(updateCursor(cursor, input({ fire: true, confirm: true }), 3)).toEqual({
      kind: 'confirm',
      index: 1,
    })
  })
})

describe('an unaffordable option cannot be selected', () => {
  /**
   * REPORTED FROM PLAY: "if an item can't be purchased, don't allow it to be selected."
   *
   * The cursor used to land on it, the card drew it greyed, and confirming did
   * literally nothing — a button that visibly does not work. This project has now
   * shipped that same shape three times (the wave-8 shop nobody could buy from, the
   * work-order card that changed nothing, the `reduceFlashes` row the renderer never
   * read), which is why this one gets a test rather than a fix.
   */
  const AFFORDABLE = [true, false, true]

  it('steps over an unaffordable option when navigating', () => {
    const cursor = newCursor()
    drive(cursor, [IDLE], 3)
    // Right from 0 must land on 2, not on the unaffordable 1.
    updateCursor(cursor, RIGHT, 3, AFFORDABLE)
    expect(cursor.index).toBe(2)
  })

  it('steps over it going the other way too', () => {
    const cursor = newCursor()
    drive(cursor, [IDLE], 3)
    updateCursor(cursor, LEFT, 3, AFFORDABLE)
    expect(cursor.index).toBe(2)
  })

  it('never confirms an unaffordable option', () => {
    const cursor = newCursor()
    drive(cursor, [IDLE], 3)
    // Walk the whole card in both directions and assert every confirm lands on
    // something buyable. A pass here is the property, not one sampled path.
    for (const key of [RIGHT, LEFT, RIGHT, RIGHT, LEFT]) {
      updateCursor(cursor, key, 3, AFFORDABLE)
      updateCursor(cursor, IDLE, 3, AFFORDABLE)
      const action = updateCursor(cursor, CONFIRM, 3, AFFORDABLE)
      if (action.kind === 'confirm') {
        expect(AFFORDABLE[action.index], `confirmed unaffordable index ${action.index}`).toBe(true)
      }
      updateCursor(cursor, IDLE, 3, AFFORDABLE)
    }
  })

  it('moves off an unaffordable option the card opened on', () => {
    // The first option is not guaranteed affordable. Opening with the cursor parked on
    // something inert is the same defect one tick earlier.
    const cursor = newCursor()
    updateCursor(cursor, IDLE, 3, [false, true, true])
    expect(cursor.index).not.toBe(0)
    expect([1, 2]).toContain(cursor.index)
  })

  it('stays put rather than spinning when nothing is affordable', () => {
    // A card the player cannot buy from at all must still be *readable* and
    // declinable. Cycling forever looking for a valid option would hang the tick.
    const cursor = newCursor()
    const none = [false, false, false]
    drive(cursor, [IDLE], 3)
    updateCursor(cursor, RIGHT, 3, none)
    expect(cursor.index).toBeGreaterThanOrEqual(0)
    expect(cursor.index).toBeLessThan(3)
    // And it can still be declined.
    updateCursor(cursor, IDLE, 3, none)
    expect(updateCursor(cursor, SPECIAL, 3, none)).toEqual({ kind: 'skip' })
  })

  it('leaves a free card alone', () => {
    // No `selectable` means every option is choosable — an item reward costs nothing,
    // and passing affordability for it would be inventing a constraint.
    const cursor = newCursor()
    drive(cursor, [IDLE], 3)
    updateCursor(cursor, RIGHT, 3)
    expect(cursor.index).toBe(1)
  })
})
