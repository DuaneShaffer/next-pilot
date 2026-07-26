/**
 * The two limits every animated effect in this directory is drawn under.
 *
 * Both come from UI.md rule 10, which is an accessibility constraint rather than a
 * style: flashing in the 3–30Hz band can trigger photosensitive seizures.
 *
 * **One pulse rate, defined once.** Before this module every pulsing element carried
 * its own hand-written radians-per-tick literal and a comment claiming it was "~0.9Hz".
 * A comment is not a check, and a literal that is off by a factor of ten reads exactly
 * the same in review. The rate now lives here, is *derived* from a frequency in Hz, and
 * `tests/render.test.ts` measures the period of the emitted waveform rather than
 * trusting either the constant or the comment.
 *
 * **One flash attenuation, honoured explicitly.** `Settings.reduceFlashes` scales the
 * bright, transient component of an effect — never the component that carries
 * information. A telegraph's charge glow dims; the arc that says how much windup is
 * left does not. Attenuation is deliberately *not* zero: an effect that disappears
 * entirely takes its meaning with it, which trades one accessibility problem for
 * another.
 */

import { TICK_HZ } from '../core/loop'

/**
 * Pulse frequency for every breathing element in the game, in Hz.
 *
 * Below rule 10's ~1Hz ceiling with margin, so rounding the derived per-tick rate for
 * legibility can never push it over.
 */
export const PULSE_HZ = 0.85

/** Radians of pulse phase per simulation tick. Derived, never hand-written. */
export const PULSE_RATE = (Math.PI * 2 * PULSE_HZ) / TICK_HZ

/**
 * Scale applied to the transient brightness of an effect when the player has asked
 * for fewer flashes.
 *
 * Not 0: see the header. A third of the brightness is still visible as an event.
 */
export const REDUCED_FLASH_SCALE = 0.35

/** Multiplier for the bright component of an effect, given the player's preference. */
export function flashScale(reduceFlashes = false): number {
  return reduceFlashes ? REDUCED_FLASH_SCALE : 1
}

/**
 * A slow breath in `[1 - depth, 1]`.
 *
 * Never reaches zero for `depth < 1`, so a pulsing element fades and brightens but
 * never blinks — the distinction rule 10 draws.
 *
 * `reduceFlashes` shrinks the *amplitude* and leaves the floor where it is, so the
 * reduced waveform sits inside the normal one: same minimum, lower peak, smaller
 * swing. Scaling the whole expression instead would have lifted the trough and made
 * the element brighter on average with the setting on, which is the opposite of what
 * it asks for.
 */
export function pulse(tick: number, depth = 0.4, reduceFlashes = false): number {
  const t = Number.isFinite(tick) ? tick : 0
  const d = Math.min(1, Math.max(0, Number.isFinite(depth) ? depth : 0))
  const amplitude = d * flashScale(reduceFlashes)
  return 1 - d + amplitude * (0.5 + 0.5 * Math.sin(t * PULSE_RATE))
}
