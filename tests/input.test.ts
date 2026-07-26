import { describe, expect, it } from 'vitest'
import {
  CONFIRM_CODES,
  DEFAULT_BINDINGS,
  Keyboard,
  MENU_FLOOR,
  SORTIE_ACTIONS,
  SYSTEM_CODES,
  type Axis,
  NEUTRAL_INPUT,
  packInput,
  unpackInput,
} from '../src/core/input'

const AXES: readonly Axis[] = [-1, 0, 1]

describe('input packing', () => {
  it('round-trips every possible snapshot through one byte', () => {
    // Replays store one byte per tick. If packing is lossy, every recorded run
    // desynchronises, so this is exhaustive rather than sampled.
    for (const moveX of AXES) {
      for (const moveY of AXES) {
        for (const fire of [false, true]) {
          for (const special of [false, true]) {
            for (const focus of [false, true]) {
              // `confirm` is the eighth and last bit the byte has room for — see
              // packInput. Exhaustive over it too, because a bit that is packed and not
              // unpacked desynchronises every replay that ever touched a card.
              for (const confirm of [false, true]) {
                const snapshot = { moveX, moveY, fire, special, focus, confirm }
                const packed = packInput(snapshot)
                expect(packed).toBeGreaterThanOrEqual(0)
                expect(packed).toBeLessThan(256)
                expect(unpackInput(packed)).toEqual(snapshot)
              }
            }
          }
        }
      }
    }
  })

  it('packs the neutral snapshot', () => {
    expect(unpackInput(packInput(NEUTRAL_INPUT))).toEqual(NEUTRAL_INPUT)
  })
})

/**
 * THE ACCEPT KEY IS NOT THE FIRE KEY, and it cannot be made into one.
 *
 * Reported from play: "the selection screens must not use the fire key to accept
 * responses." Accepting a card used to be a rising `fire` edge, which in a shmup is a key
 * the player is already holding — so a card could not be accepted at all until they let
 * go, and the two mitigations for that (a dwell that confirmed the highlighted option
 * after 48 ticks, a timeout that declined the card after 20 seconds) both had the
 * interface making a permadeath choice on the player's behalf.
 *
 * These tests pin the separation, including the part a settings screen could otherwise
 * undo: rule 2 in `src/core/input.ts` says confirm is not remappable, and `SYSTEM_CODES`
 * is what stops a player pointing `fire` at the accept key from the other direction.
 */
describe('confirm is separate from fire, and stays separate', () => {
  it('shares no code with any default gameplay binding', () => {
    for (const action of SORTIE_ACTIONS) {
      for (const code of DEFAULT_BINDINGS[action]) {
        expect(CONFIRM_CODES, `${action} is bound to the accept key ${code}`).not.toContain(code)
      }
    }
  })

  it('is made of codes no gameplay action may ever be bound to', () => {
    // The other direction, and the one a binding screen could otherwise reach: Enter is
    // refused as a gameplay binding, so `fire` can never become an accept key.
    for (const code of CONFIRM_CODES) {
      expect(SYSTEM_CODES.has(code), `${code} is bindable to a gameplay action`).toBe(true)
    }
  })

  it('excludes Space, which is a default fire binding', () => {
    // Space accepts in a MENU (via MENU_FLOOR, edge-triggered through consumePressed)
    // where nothing is being shot at. It must never reach a snapshot as `confirm`.
    expect(DEFAULT_BINDINGS.fire).toContain('Space')
    expect(CONFIRM_CODES).not.toContain('Space')
    expect(MENU_FLOOR.confirm).toContain('Space')
  })

  it('reports confirm from Enter and never from the trigger', () => {
    const keyboard = new Keyboard()
    keyboard.setContext('choice')

    keyboard.pressForTest('Space')
    expect(keyboard.snapshot().fire).toBe(true)
    expect(keyboard.snapshot().confirm, 'the fire key accepted a selection').toBe(false)

    keyboard.pressForTest('Enter')
    expect(keyboard.snapshot().confirm).toBe(true)
    // And releasing the trigger does not release the accept key, or vice versa.
    keyboard.releaseForTest('Space')
    expect(keyboard.snapshot().confirm).toBe(true)
    expect(keyboard.snapshot().fire).toBe(false)
  })

  it('reports confirm during a sortie too, so nothing has to special-case a card', () => {
    // The sim decides what a snapshot means; the app layer only says what happened. A
    // context-dependent `confirm` would put that decision in two places.
    const keyboard = new Keyboard()
    keyboard.setContext('sortie')
    keyboard.pressForTest('Enter')
    expect(keyboard.snapshot().confirm).toBe(true)
  })
})
