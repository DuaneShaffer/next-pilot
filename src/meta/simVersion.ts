/**
 * Simulation behaviour version.
 *
 * DISTINCT FROM THE REPLAY FORMAT VERSION, and the distinction is the whole point.
 *
 *   - `REPLAY_FORMAT_VERSION` describes how the bytes are *encoded*. A mismatch
 *     means the decoder cannot read the data, which fails loudly and safely.
 *   - `SIM_VERSION` describes what those bytes *mean*. A mismatch decodes
 *     perfectly and then plays back a completely different run.
 *
 * The second is the dangerous one. Until now the replay corpus has been disposable:
 * hitstop changed tick timing, items changed every run, and each time three fixture
 * files were re-recorded and the milestone moved on. That was free only because
 * nobody outside this repository held a replay.
 *
 * Shareable replay URLs end that. After M4, the same balance change silently breaks
 * every link anyone has posted — the recipient sees a run that starts identically
 * and diverges somewhere in the middle, with no error and no explanation. A replay
 * that plays back wrong is worse than one that refuses to play.
 *
 * So every replay carries the SIM_VERSION it was recorded under, and playback
 * refuses a mismatch rather than guessing.
 *
 * ## When to bump this
 *
 * Whenever the simulation would produce a different outcome from the same seed and
 * inputs: movement, damage, spawning, item effects, timing, RNG stream usage,
 * content tuning that feeds the sim. Cosmetic-only changes do not count — they are
 * excluded from the regression hash for exactly this reason.
 *
 * You do not have to remember. `tests/simVersion.test.ts` computes a canonical run's
 * hash and fails if it moved without this constant moving too. That test exists
 * because "remember to bump the version" is not a process, it is a wish.
 */

import type { InputSnapshot } from '../core/input'
import { hashWorld } from './snapshot'

/**
 * Current simulation behaviour version.
 *
 * Bump when sim behaviour changes, and add the new canonical hash to the history in
 * `tests/simVersion.test.ts` in the same commit.
 */
export const SIM_VERSION = 1

/** Seed for the canonical run. Arbitrary but fixed forever. */
export const CANONICAL_SEED = 'K7F29XQM3RTV'

/** Ticks of the canonical run. Long enough to reach combat, short enough to be fast. */
export const CANONICAL_TICKS = 1800

/**
 * A fixed input script.
 *
 * Deliberately not a bot policy: a policy reads the world and would change what it
 * does whenever the sim changed, masking exactly the divergence this is meant to
 * detect. A dumb, repeating pattern depends on nothing.
 */
export function canonicalInputs(): InputSnapshot[] {
  const script: InputSnapshot[] = []
  for (let tick = 0; tick < CANONICAL_TICKS; tick++) {
    const phase = tick % 120
    script.push({
      moveX: phase < 40 ? 1 : phase < 80 ? -1 : 0,
      moveY: phase % 37 === 0 ? -1 : 0,
      // Released periodically so the weapon's release path is exercised too.
      fire: phase % 50 !== 0,
      special: false,
      focus: phase > 100,
    })
  }
  return script
}

/** Minimal shape the canonical run needs. Avoids importing World into meta. */
export interface CanonicalWorld {
  tick(input: InputSnapshot): void
}

/**
 * Run the canonical script and hash the result.
 *
 * Takes a factory so this module stays free of a sim import — `src/meta` is
 * consumed by the app layer, and a cycle through the simulation would be a
 * dependency-direction violation.
 */
export function canonicalHash(makeWorld: () => CanonicalWorld): string {
  const world = makeWorld()
  for (const input of canonicalInputs()) world.tick(input)
  return hashWorld(world as never)
}

export type ReplayCompatibility =
  | { kind: 'ok' }
  | { kind: 'older'; recorded: number; current: number }
  | { kind: 'newer'; recorded: number; current: number }

/**
 * Whether a replay recorded under `recorded` can be trusted on this build.
 *
 * Deliberately strict in both directions. An older replay diverges because the rules
 * changed under it; a newer one was recorded by a build that knows rules this one
 * does not. Neither can be played back honestly, and "mostly works" is the worst
 * outcome — the viewer watches a plausible run that is not the one that was shared.
 */
export function checkReplayCompatibility(recorded: number): ReplayCompatibility {
  if (recorded === SIM_VERSION) return { kind: 'ok' }
  if (recorded < SIM_VERSION) return { kind: 'older', recorded, current: SIM_VERSION }
  return { kind: 'newer', recorded, current: SIM_VERSION }
}

/** A sentence to show the player. Plain, and never blames them. */
export function describeIncompatibility(result: ReplayCompatibility): string | null {
  switch (result.kind) {
    case 'ok':
      return null
    case 'older':
      return (
        `This replay was recorded on an earlier version of the game ` +
        `(v${result.recorded}, this build is v${result.current}). The rules have changed ` +
        `since, so it would not play back the run it recorded.`
      )
    case 'newer':
      return (
        `This replay was recorded on a newer version of the game ` +
        `(v${result.recorded}, this build is v${result.current}). Refresh to update.`
      )
  }
}
