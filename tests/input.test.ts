import { describe, expect, it } from 'vitest'
import { type Axis, NEUTRAL_INPUT, packInput, unpackInput } from '../src/core/input'

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
              const snapshot = { moveX, moveY, fire, special, focus }
              const packed = packInput(snapshot)
              expect(packed).toBeGreaterThanOrEqual(0)
              expect(packed).toBeLessThan(256)
              expect(unpackInput(packed)).toEqual(snapshot)
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
