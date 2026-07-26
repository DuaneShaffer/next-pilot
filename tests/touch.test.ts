/**
 * Touch control tests.
 *
 * These are pure logic — no DOM, no browser, no device. They construct synthetic
 * finger sequences and assert the `InputSnapshot`s that come out, and where the
 * question is "does the ship end up in the right place" they integrate those
 * snapshots through the same movement arithmetic `src/sim/world.ts` uses.
 *
 * The choice-card tests deliberately drive the REAL `updateCursor` from
 * `src/sim/progression.ts` rather than a copy of its rules. The failure they exist
 * to catch is an interaction between two modules, and a reimplementation of one of
 * them would agree with the bug.
 *
 * What these tests cannot cover is in docs/MOBILE.md: no touchscreen, no thumb, no
 * `attachTouch`.
 */

import { describe, expect, it } from 'vitest'

import {
  BASE_UNITS_PER_TICK,
  DEFAULT_GAIN,
  DEFAULT_MAX_DEBT_TICKS,
  DEFAULT_TAP_SLOP,
  FOCUS_FACTOR,
  TouchControls,
} from '../src/core/touch'
import type { InputSnapshot } from '../src/core/input'
import { PLAYFIELD_H, PLAYFIELD_W, clamp } from '../src/core/space'
import { TICK_SECONDS } from '../src/core/loop'
import { HULL_COLLISION_RADIUS } from '../src/sim/damage'
import { STATS } from '../src/sim/stats'
import {
  newCursor,
  updateCursor,
  type ChoiceAction,
} from '../src/sim/progression'

/**
 * Long enough that any automatic resolution would have fired by now: three times the
 * 20-second timeout the sim used to have, and 75x the dwell that replaced it.
 *
 * A local constant rather than an import, because the thing it stands in for no longer
 * exists — cards do not close themselves. See `docs/MOBILE.md`.
 */
const A_LONG_CARD_WAIT = 60 * 60

// --- helpers ----------------------------------------------------------------

const HULL_HALF_W = 11
const HULL_HALF_H = 14

/**
 * The player hull, moved exactly as `World.moveHull` moves it.
 *
 * Copied rather than driven through a real World so a movement test is not also a
 * test of spawning, collision, and the item bus. `keeps step with the sim` below
 * pins the constants it depends on.
 */
class Ship {
  constructor(
    public x = PLAYFIELD_W / 2,
    public y = PLAYFIELD_H / 2,
    private readonly speed = STATS.hullSpeed.base,
  ) {}

  apply(input: InputSnapshot): void {
    const step = this.speed * (input.focus ? STATS.focusFactor.base : 1) * TICK_SECONDS
    let dx: number = input.moveX
    let dy: number = input.moveY
    if (dx !== 0 && dy !== 0) {
      dx *= Math.SQRT1_2
      dy *= Math.SQRT1_2
    }
    this.x = clamp(this.x + dx * step, HULL_HALF_W, PLAYFIELD_W - HULL_HALF_W)
    this.y = clamp(this.y + dy * step, HULL_HALF_H, PLAYFIELD_H - HULL_HALF_H)
  }
}

interface DragResult {
  ship: Ship
  inputs: InputSnapshot[]
}

/**
 * Drag one finger in a straight line, one move event per tick, then hold still
 * until the debt has drained.
 */
function drag(
  controls: TouchControls,
  options: {
    from: { x: number; y: number }
    to: { x: number; y: number }
    ticks: number
    settleTicks?: number
    ship?: Ship
    extraFingers?: readonly { id: number; x: number; y: number; downAtTick: number }[]
  },
): DragResult {
  const ship = options.ship ?? new Ship()
  const inputs: InputSnapshot[] = []
  controls.down(1, options.from.x, options.from.y)

  for (let i = 1; i <= options.ticks; i++) {
    for (const finger of options.extraFingers ?? []) {
      if (finger.downAtTick === i) controls.down(finger.id, finger.x, finger.y)
    }
    const t = i / options.ticks
    controls.move(
      1,
      options.from.x + (options.to.x - options.from.x) * t,
      options.from.y + (options.to.y - options.from.y) * t,
    )
    const input = controls.snapshot()
    inputs.push(input)
    ship.apply(input)
  }

  for (let i = 0; i < (options.settleTicks ?? 20); i++) {
    const input = controls.snapshot()
    inputs.push(input)
    ship.apply(input)
  }

  return { ship, inputs }
}

/** Feed a sequence of snapshots to a fresh cursor and report every action. */
function driveCursor(
  inputs: readonly InputSnapshot[],
  optionCount: number,
): { actions: ChoiceAction[]; firstConfirmTick: number | null } {
  const cursor = newCursor()
  const actions: ChoiceAction[] = []
  let firstConfirmTick: number | null = null
  inputs.forEach((input, index) => {
    const action = updateCursor(cursor, input, optionCount)
    actions.push(action)
    if (action.kind === 'confirm' && firstConfirmTick === null) firstConfirmTick = index
  })
  return { actions, firstConfirmTick }
}

/**
 * The trigger, held, and NOTHING else — in particular not `confirm`.
 *
 * This is what a naive touch auto-fire produces on every tick of every card, and the
 * assertions below are that a card is completely blind to it.
 */
const HELD_TRIGGER: InputSnapshot = {
  moveX: 0,
  moveY: 0,
  fire: true,
  special: false,
  focus: false,
  confirm: false,
}

// --- the constants this module duplicates -----------------------------------

describe('touch constants keep step with the simulation', () => {
  /**
   * `core` must not import `sim` (CLAUDE.md's dependency arrow), so touch.ts
   * duplicates two sim numbers. A duplicate nobody checks is a duplicate that
   * drifts, and the drift here is silent: the debt would drain at a rate the ship
   * does not move at, and every drag would over- or under-deliver by that ratio.
   */
  it('drains the debt at the hull speed the sim actually uses', () => {
    expect(BASE_UNITS_PER_TICK).toBeCloseTo(STATS.hullSpeed.base * TICK_SECONDS, 10)
  })

  it('scales gain by the focus factor the sim actually uses', () => {
    expect(FOCUS_FACTOR).toBe(STATS.focusFactor.base)
  })
})

// --- movement ---------------------------------------------------------------

describe('relative drag', () => {
  it('moves the ship by the finger delta times the gain', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    const start = new Ship(120, 360)
    const startX = start.x
    const fingerTravel = 100

    // 100 units of finger is 194 units of ship, which at 3.5 units/tick needs 56
    // ticks minimum. Dragged faster than that the rate limit truncates it — see
    // `never banks more than a few ticks of travel`.
    const { ship } = drag(controls, {
      from: { x: 200, y: 400 },
      to: { x: 200 + fingerTravel, y: 400 },
      ticks: 90,
      ship: start,
    })

    // The first `tapSlopUnits` of finger travel are deliberately discarded.
    const expected = (fingerTravel - DEFAULT_TAP_SLOP) * DEFAULT_GAIN
    const step = BASE_UNITS_PER_TICK

    // THE GUARANTEE, and it is the reason this scheme beats a virtual stick: the
    // ship lands within half a tick's travel of where the mapping said, not within
    // however far it drifted while the player let go. 1.75 units against a 5.5-unit
    // hitbox radius is 32% of a radius, and focus cuts it to 14%.
    expect(Math.abs(ship.x - startX - expected)).toBeLessThan(step / 2)
    expect(step / 2 / HULL_COLLISION_RADIUS).toBeLessThan(0.35)
    expect(ship.y).toBe(360)
  })

  it('never emits an axis the finger did not ask for', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    const { inputs } = drag(controls, {
      from: { x: 100, y: 400 },
      to: { x: 300, y: 400 },
      ticks: 30,
    })
    expect(inputs.every((i) => i.moveY === 0)).toBe(true)
    expect(inputs.some((i) => i.moveX === 1)).toBe(true)
    expect(inputs.some((i) => i.moveX === -1)).toBe(false)
  })

  it('tracks a diagonal drag on both axes, matching the sim diagonal rule', () => {
    // The sim normalises diagonals to step/sqrt(2) per axis. A controller that
    // drained a full step per axis would land the ship 41% short on a diagonal.
    const controls = new TouchControls()
    controls.setContext('sortie')
    const start = new Ship(224, 360)
    const { ship } = drag(controls, {
      from: { x: 100, y: 100 },
      to: { x: 160, y: 160 },
      ticks: 120,
      settleTicks: 60,
      ship: start,
    })

    const diagonal = Math.hypot(60, 60)
    const expected = ((diagonal - DEFAULT_TAP_SLOP) * DEFAULT_GAIN) / Math.SQRT2
    expect(Math.abs(ship.x - 224 - expected)).toBeLessThan(BASE_UNITS_PER_TICK / 2)
    expect(Math.abs(ship.y - 360 - expected)).toBeLessThan(BASE_UNITS_PER_TICK / 2)
    // A controller that drained a whole step per axis on a diagonal would land the
    // ship 41% long, well outside that bound.
    expect(Math.abs(ship.x - 224 - expected * Math.SQRT2)).toBeGreaterThan(20)
  })

  it('holds still for a tap', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    controls.down(1, 200, 400)
    // Sensor noise well inside the slop.
    controls.move(1, 200.6, 400.4)
    controls.move(1, 199.8, 400.9)
    const first = controls.snapshot()
    controls.up(1)
    const second = controls.snapshot()

    expect(first.moveX).toBe(0)
    expect(first.moveY).toBe(0)
    expect(second.moveX).toBe(0)
    expect(second.moveY).toBe(0)
  })
})

describe('a lifted finger stops the ship', () => {
  /**
   * The failure this catches is coasting: a controller that kept emitting the last
   * vector, or that kept draining a banked debt, would fly the ship onward after
   * the thumb came off — into whatever the player lifted their thumb to avoid.
   */
  it('emits neutral immediately after the finger lifts, mid-drag', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    controls.down(1, 100, 400)

    let moved = false
    for (let i = 1; i <= 20; i++) {
      controls.move(1, 100 + i * 6, 400)
      if (controls.snapshot().moveX === 1) moved = true
    }
    expect(moved).toBe(true)

    controls.up(1)
    for (let i = 0; i < 30; i++) {
      const input = controls.snapshot()
      expect(input.moveX).toBe(0)
      expect(input.moveY).toBe(0)
    }
    expect(controls.pendingX).toBe(0)
  })

  it('discards debt banked by a flick rather than delivering it later', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    controls.down(1, 40, 400)
    controls.move(1, 400, 400)
    controls.up(1)
    for (let i = 0; i < 10; i++) expect(controls.snapshot().moveX).toBe(0)
  })
})

describe('multi-touch', () => {
  it('does not teleport the ship when a second finger lands', () => {
    // A controller that steered from "the newest finger" or from an absolute
    // position would slam the ship across the playfield the instant a second thumb
    // touched down. Relative drag off a single tracked finger cannot.
    const controls = new TouchControls()
    controls.setContext('sortie')
    const ship = new Ship(224, 360)

    const { inputs } = drag(controls, {
      from: { x: 60, y: 200 },
      to: { x: 120, y: 200 },
      ticks: 30,
      ship,
      extraFingers: [{ id: 2, x: 430, y: 700, downAtTick: 15 }],
    })

    // The tick the second finger lands must be indistinguishable from its
    // neighbours in the movement it commands. A teleport would show up here as a
    // single tick of full-speed travel in the direction of the new finger, which is
    // 370 units away on x and 500 on y.
    const landing = inputs[14]
    expect(landing?.moveX).toBe(inputs[13]?.moveX)
    expect(landing?.moveY).toBe(0)
    expect(inputs.every((i) => i.moveY === 0)).toBe(true)

    // The gesture delivers only what finger 1 travelled — reduced, because the
    // second finger engaged focus partway through, but never more.
    const unfocused = (60 - DEFAULT_TAP_SLOP) * DEFAULT_GAIN
    expect(ship.x - 224).toBeGreaterThan(unfocused * FOCUS_FACTOR)
    expect(ship.x - 224).toBeLessThan(unfocused)
  })

  it('ignores movement from a non-steering finger entirely', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    controls.down(1, 100, 400)
    controls.down(2, 300, 500)

    for (let i = 0; i < 20; i++) {
      controls.move(2, 300 + i * 8, 500 + i * 8)
      const input = controls.snapshot()
      expect(input.moveX).toBe(0)
      expect(input.moveY).toBe(0)
    }
  })

  it('promotes a surviving finger without teleporting', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    controls.down(1, 60, 200)
    controls.down(2, 400, 660)
    controls.move(1, 90, 200)
    controls.snapshot()

    controls.up(1)
    // Finger 2 now steers, from where it already is. Its first reported position is
    // unchanged, so the delta is zero and nothing moves.
    controls.move(2, 400, 660)
    expect(controls.snapshot().moveX).toBe(0)
    expect(controls.steering).toBe(true)

    // And it steers normally from there.
    let sawMovement = false
    for (let i = 1; i <= 20; i++) {
      controls.move(2, 400 - i * 6, 660)
      if (controls.snapshot().moveX === -1) sawMovement = true
    }
    expect(sawMovement).toBe(true)
  })

  it('ignores a touch that starts outside the playfield', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    // The portrait panel bar sits below the playfield; a thumb there is reading the
    // instruments, not flying.
    controls.down(1, 200, PLAYFIELD_H + 40)
    for (let i = 1; i <= 20; i++) {
      controls.move(1, 200 + i * 8, PLAYFIELD_H + 40)
      expect(controls.snapshot().moveX).toBe(0)
    }
    expect(controls.steering).toBe(false)
  })
})

describe('focus', () => {
  it('engages while a second finger is down and releases when it lifts', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    controls.down(1, 100, 400)
    expect(controls.snapshot().focus).toBe(false)

    controls.down(2, 300, 600)
    expect(controls.snapshot().focus).toBe(true)

    controls.up(2)
    expect(controls.snapshot().focus).toBe(false)
  })

  it('buys precision: the same finger travel moves the ship 0.45x as far', () => {
    const plain = new TouchControls()
    plain.setContext('sortie')
    const plainShip = new Ship(224, 360)
    drag(plain, { from: { x: 100, y: 400 }, to: { x: 160, y: 400 }, ticks: 60, ship: plainShip })

    const focused = new TouchControls()
    focused.setContext('sortie')
    const focusedShip = new Ship(224, 360)
    drag(focused, {
      from: { x: 100, y: 400 },
      to: { x: 160, y: 400 },
      ticks: 60,
      ship: focusedShip,
      // The steering finger is whichever landed first, so the modifier has to land
      // second — putting it down first would make IT the steering finger.
      extraFingers: [{ id: 2, x: 300, y: 600, downAtTick: 1 }],
    })

    expect(focusedShip.x - 224).toBeCloseTo((plainShip.x - 224) * FOCUS_FACTOR, 0)
  })

  it('gives more than twice the finger travel per hitbox radius', () => {
    // This is the whole reason focus exists on touch. At full gain the ship crosses
    // its own 5.5-unit hitbox radius in 2.75 units of finger travel, which is inside
    // a dragging thumb's jitter. Focus has to move that comfortably out of it.
    const plainTravel = HULL_COLLISION_RADIUS / DEFAULT_GAIN
    const focusTravel = HULL_COLLISION_RADIUS / (DEFAULT_GAIN * FOCUS_FACTOR)
    expect(focusTravel / plainTravel).toBeGreaterThanOrEqual(2)
    expect(focusTravel).toBeGreaterThan(5)
  })

  it('does not add latency — focus moves less, it does not move later', () => {
    // Focus scales the gain and the per-tick step by the same factor, so the number
    // of ticks to settle is unchanged. A controller that scaled only the step would
    // make focus feel like lag instead of precision.
    const settleTicks = (focus: boolean): number => {
      const controls = new TouchControls()
      controls.setContext('sortie')
      controls.down(1, 100, 400)
      if (focus) controls.down(2, 300, 600)
      controls.move(1, 160, 400)
      let ticks = 0
      while (ticks < 200) {
        const input = controls.snapshot()
        ticks++
        if (input.moveX === 0) break
      }
      return ticks
    }
    expect(settleTicks(true)).toBe(settleTicks(false))
  })
})

describe('gain is calibrated against a thumb, not a mouse', () => {
  it('crosses the playfield in a plausible thumb sweep', () => {
    const fingerTravel = PLAYFIELD_W / DEFAULT_GAIN
    // On a 390x844 phone the scale is 0.87, so this window is ~130-225 CSS pixels,
    // roughly 21-37mm. Below that the gain is too twitchy to dodge with; above it a
    // full-width traverse needs more than one thumb sweep.
    expect(fingerTravel).toBeGreaterThan(150)
    expect(fingerTravel).toBeLessThan(260)
  })

  it('actually crosses the playfield, within the hull speed limit', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    const ship = new Ship(HULL_HALF_W, 360)
    const travel = PLAYFIELD_W / DEFAULT_GAIN
    const { inputs } = drag(controls, {
      from: { x: 20, y: 400 },
      to: { x: 20 + travel, y: 400 },
      ticks: 140,
      settleTicks: 40,
      ship,
    })

    expect(ship.x).toBeGreaterThan(PLAYFIELD_W - HULL_HALF_W - 1)
    // 448 units at 3.5 units/tick is 128 ticks, so a full-width traverse cannot be
    // faster than that however hard the thumb is flicked.
    expect(inputs.length).toBeGreaterThan(PLAYFIELD_W / BASE_UNITS_PER_TICK)
  })

  it('never banks more than a few ticks of travel', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    controls.down(1, 20, 400)
    // A hard flick: the whole playfield width in a single event.
    controls.move(1, 420, 400)

    let ticksMoving = 0
    for (let i = 0; i < 60; i++) {
      if (controls.snapshot().moveX === 0) break
      ticksMoving++
    }
    expect(ticksMoving).toBeLessThanOrEqual(DEFAULT_MAX_DEBT_TICKS)
  })
})

describe('reset', () => {
  it('drops every finger and all debt', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    controls.down(1, 100, 400)
    controls.down(2, 300, 600)
    controls.move(1, 300, 400)
    controls.reset()
    expect(controls.steering).toBe(false)
    const input = controls.snapshot()
    expect(input.moveX).toBe(0)
    expect(input.focus).toBe(false)
  })
})

// --- auto-fire and the choice card ------------------------------------------

describe('auto-fire', () => {
  it('holds the trigger during a sortie, with or without a finger down', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    expect(controls.snapshot().fire).toBe(true)
    controls.down(1, 200, 400)
    expect(controls.snapshot().fire).toBe(true)
  })

  it('releases the trigger the moment a choice card opens', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    expect(controls.snapshot().fire).toBe(true)
    controls.setContext('choice')
    expect(controls.snapshot().fire).toBe(false)
    controls.setContext('menu')
    expect(controls.snapshot().fire).toBe(false)
  })

  it('stops steering the ship outside a sortie', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    controls.down(1, 100, 400)
    controls.move(1, 300, 400)
    controls.setContext('choice')
    const input = controls.snapshot()
    expect(input.moveX).toBe(0)
    expect(input.fire).toBe(false)
  })
})

describe('the held trigger versus the choice cursor', () => {
  /**
   * THE FAILURE THIS FILE EXISTS FOR, AND WHY IT IS NOW STRUCTURAL.
   *
   * Accepting a card used to be a rising `fire` edge, so a keyboard player who never
   * released the trigger could not resolve a card — and the rescue for that (a 48-tick
   * dwell that confirmed the highlighted option) turned into a much worse bug here: on
   * touch, auto-fire is the permanent state, so EVERY card on the platform took option 0
   * after 0.8 seconds. Mobile pick rates were an input-layer artefact, and the same seed
   * played out differently on a phone.
   *
   * A card reads `confirm` now, which touch only ever produces from a real tap. These
   * tests assert the hazard is gone at the source rather than mitigated by the context
   * switch — because a mitigation is one refactor away from being removed.
   */
  it('cannot resolve a card by firing, however long it fires', () => {
    const held = Array.from({ length: A_LONG_CARD_WAIT }, () => HELD_TRIGGER)
    const { actions, firstConfirmTick } = driveCursor(held, 3)

    expect(firstConfirmTick).toBeNull()
    expect(actions.every((a) => a.kind === 'none')).toBe(true)
  })

  it('cannot resolve a card by firing and navigating either', () => {
    // The old shape of this test asserted the opposite outcome — a card driven to the
    // 20-second timeout and DECLINED, losing the reward — because navigating cancelled
    // the dwell. There is no dwell and no timeout: the card simply waits for a tap.
    const inputs: InputSnapshot[] = []
    inputs.push({ ...HELD_TRIGGER, moveX: 0 })
    inputs.push({ ...HELD_TRIGGER, moveX: 1 })
    for (let i = 0; i < A_LONG_CARD_WAIT; i++) inputs.push(HELD_TRIGGER)

    const { actions } = driveCursor(inputs, 3)
    expect(actions.filter((a) => a.kind === 'confirm')).toHaveLength(0)
    expect(actions.filter((a) => a.kind === 'skip')).toHaveLength(0)
  })

  it('resolves nothing on its own once touch releases the trigger', () => {
    // A card open for a minute under real touch input never resolves at all, so the
    // player's tap is the only thing that picks.
    const controls = new TouchControls()
    controls.setContext('choice')
    const inputs = Array.from({ length: A_LONG_CARD_WAIT }, () => controls.snapshot())

    const { actions } = driveCursor(inputs, 3)
    expect(actions.every((a) => a.kind === 'none')).toBe(true)
  })

  it('cannot be pushed into a decision by a one-tick-late context switch', () => {
    // The app layer learns a card is open by reading `world.pendingChoice` after the tick
    // that opened it, so exactly one sortie-context snapshot can leak onto a card. It
    // used to matter (one tick of the 48-tick dwell); now it cannot matter at all.
    const controls = new TouchControls()
    controls.setContext('sortie')
    const inputs = [controls.snapshot()]
    controls.setContext('choice')
    for (let i = 0; i < A_LONG_CARD_WAIT; i++) inputs.push(controls.snapshot())

    const { actions } = driveCursor(inputs, 3)
    expect(actions.every((a) => a.kind === 'none')).toBe(true)
  })
})

describe('driving the choice cursor from a tap', () => {
  it('walks to the tapped option and confirms it', () => {
    for (const target of [0, 1, 2]) {
      const controls = new TouchControls()
      controls.setContext('choice')
      controls.scriptSelect(0, target, 3)

      const inputs: InputSnapshot[] = []
      while (controls.scriptLength > 0) inputs.push(controls.snapshot())

      const { actions } = driveCursor(inputs, 3)
      const confirm = actions.find((a) => a.kind === 'confirm')
      expect(confirm, `target ${target}`).toEqual({ kind: 'confirm', index: target })
    }
  })

  it('takes the short way round the wrap', () => {
    const controls = new TouchControls()
    controls.setContext('choice')
    controls.scriptSelect(0, 2, 3)
    // One press left beats two presses right: 2 pulse ticks + 2 neutral + confirm.
    expect(controls.scriptLength).toBe(5)
    const inputs: InputSnapshot[] = []
    while (controls.scriptLength > 0) inputs.push(controls.snapshot())
    expect(inputs.some((i) => i.moveX === -1)).toBe(true)
    expect(inputs.some((i) => i.moveX === 1)).toBe(false)
  })

  it('resolves fast enough to feel like a direct tap', () => {
    const controls = new TouchControls()
    controls.setContext('choice')
    controls.scriptSelect(0, 1, 3)
    const inputs: InputSnapshot[] = []
    while (controls.scriptLength > 0) inputs.push(controls.snapshot())
    const { firstConfirmTick } = driveCursor(inputs, 3)
    expect(firstConfirmTick).not.toBeNull()
    // Under 100ms at 60Hz.
    expect((firstConfirmTick ?? 999) / 60).toBeLessThan(0.1)
  })

  it('declines a card on a skip gesture', () => {
    const controls = new TouchControls()
    controls.setContext('choice')
    controls.scriptSkip()
    const inputs: InputSnapshot[] = []
    while (controls.scriptLength > 0) inputs.push(controls.snapshot())
    const { actions } = driveCursor(inputs, 3)
    expect(actions.some((a) => a.kind === 'skip')).toBe(true)
    expect(actions.some((a) => a.kind === 'confirm')).toBe(false)
  })

  it('abandons a queued script when the card closes', () => {
    const controls = new TouchControls()
    controls.setContext('choice')
    controls.scriptSelect(0, 2, 3)
    controls.setContext('sortie')
    expect(controls.scriptLength).toBe(0)
    // And the next snapshot is an ordinary sortie one, not a stray confirm pulse.
    expect(controls.snapshot()).toEqual({
      moveX: 0,
      moveY: 0,
      fire: true,
      special: false,
      focus: false,
      confirm: false,
    })
  })

  it('never confirms an option that does not exist', () => {
    const controls = new TouchControls()
    controls.setContext('choice')
    controls.scriptSelect(0, 5, 0)
    expect(controls.scriptLength).toBe(0)
  })
})

// --- determinism ------------------------------------------------------------

describe('the touch layer stays inside the input contract', () => {
  it('only ever produces snapshots the sim and the replay format can hold', () => {
    const controls = new TouchControls()
    controls.setContext('sortie')
    controls.down(1, 60, 60)
    const seen: InputSnapshot[] = []
    for (let i = 1; i <= 120; i++) {
      controls.move(1, 60 + Math.sin(i / 3) * 90, 60 + Math.cos(i / 5) * 120)
      if (i === 40) controls.down(2, 300, 600)
      if (i === 80) controls.up(2)
      seen.push(controls.snapshot())
    }
    for (const input of seen) {
      expect([-1, 0, 1]).toContain(input.moveX)
      expect([-1, 0, 1]).toContain(input.moveY)
      expect(typeof input.fire).toBe('boolean')
      expect(typeof input.focus).toBe('boolean')
      expect(input.special).toBe(false)
    }
  })

  it('is a pure function of its event sequence', () => {
    // Not a determinism-contract test — touch lives outside the sim — but a replay
    // recorded on a phone is only meaningful if the same gesture produces the same
    // bytes, and any stray clock or random here would break that quietly.
    const run = (): InputSnapshot[] => {
      const controls = new TouchControls()
      controls.setContext('sortie')
      controls.down(1, 100, 400)
      const out: InputSnapshot[] = []
      for (let i = 1; i <= 60; i++) {
        controls.move(1, 100 + i * 2.7, 400 - i * 1.3)
        out.push(controls.snapshot())
      }
      return out
    }
    expect(run()).toEqual(run())
  })
})
