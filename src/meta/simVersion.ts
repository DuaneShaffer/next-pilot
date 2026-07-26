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
 *
 * ## History
 *
 * **3 — the shield recharges, cards stop resolving themselves, and confirm leaves the
 * trigger.** Four independent behaviour changes landed together, and one of them also
 * moves the wire format, so this version is the *only* one so far where an old replay
 * fails to decode rather than decoding into the wrong run. That is the safe failure and
 * it is worth noting as an accident of timing rather than a design improvement.
 *
 *   - **`confirm` is its own `InputSnapshot` action** and takes bit 7 of the packed
 *     input byte. `REPLAY_FORMAT_VERSION` moves 3 → 4 with it, so a v3 replay is
 *     REFUSED rather than misread. Selection screens no longer accept on `fire`.
 *   - **Cards no longer resolve themselves.** `CHOICE_TIMEOUT_TICKS` (20 s) and the
 *     48-tick held-trigger dwell are both gone, along with `awaitingRelease`. An old
 *     replay's inputs assumed a card would close on its own; now it waits. Every seam
 *     after the first therefore lands somewhere different.
 *   - **The shield recovers**, from a per-sector reserve (`shieldReservePerSector`,
 *     base 15) at 4/second after 2.5 seconds without a hit. A straight change to how
 *     much damage every run can absorb — measured to move a competent policy's clear
 *     rate from 15% to 33%. Three new `StatKey`s and three new `Hull` fields, all
 *     hashed.
 *   - **No route pays scrap**, and the repair route pays 60% of maximum integrity
 *     instead of 35%. `buildRoutes` consumes one fewer roll off the `route` stream,
 *     which shifts every subsequent route decision on the same seed.
 *
 * The canonical probe below sees the first three of those and cannot see the fourth: it
 * runs 1,800 ticks of single-sector content and never reaches a seam. Same caveat as
 * version 2, same conclusion — the probe is evidence that *something* moved, never that
 * nothing did.
 *
 * **2 — M5, the multi-sector run.** The textbook dangerous case: every M4 replay
 * still decodes perfectly and plays back a run nobody flew.
 *
 *   - A run is five sectors, not one. The same seed and the same inputs that ended
 *     in an extraction after sector one now cross a seam into The Tally and keep
 *     going. Nothing about that fails — the input log is still valid, the ticks
 *     still line up, and the viewer watches a plausible run that is not the one
 *     that was shared.
 *   - Wave numbering restarts per sector, so the reward and shop schedule fires
 *     five times instead of once. An M4 replay's inputs land on cards that were
 *     never open when it was recorded, which redirects the run from the first seam
 *     onward.
 *   - `route`, `hazard` and `boss` are new named streams. They do not shift the
 *     existing streams (that is what named streams are for), but the decisions they
 *     make — which approach is offered, where debris falls, which boss form is
 *     fought — are new inputs to the same seed.
 *   - Enemies gained a second weapon slot and bosses a phase script, so an enemy
 *     the old build fired once per interval can now fire twice.
 *   - `retaliate` fires only when integrity actually dropped, where it used to fire
 *     on shield-absorbed hits too. That is a straight damage-output change on any
 *     build holding the coil, and it is the kind of change that diverges a replay
 *     quietly and late — the run looks right for two minutes and then does not.
 *   - `HazardField` staggers by map index rather than by `indexOf`, so a sector
 *     arming the same hazard def twice no longer fires both copies in lockstep.
 *
 * And the surface a replay can diverge *on* has grown, which matters even where the
 * additions are cosmetic. Routes now carry authored names and the direct approach's
 * `rewardText` is reworded; neither steers a tick, but each is one more thing that
 * has to agree between the build that recorded a run and the build replaying it.
 * The more state a run has, the less a clean decode is evidence of anything.
 *
 * Note what the canonical probe below could NOT see: it runs 1,800 ticks of the
 * single-sector default content, so it never reaches a seam, a boss, or a hazard.
 * Its hash moved this version only because `hashWorld` widened to cover the new
 * state (see `src/meta/snapshot.ts`). Had the digest not widened, the probe would
 * have gone green through every change listed above — which is the argument for
 * hashing the new fields, not an argument that the sim is unchanged.
 *
 * **1 — M0 through M4.** Single sector, no bosses, no hazards.
 */
export const SIM_VERSION = 3

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
      // Pulsed on a DIFFERENT period from `fire`, deliberately. Confirm is its own
      // action now rather than a second reading of the trigger, so a script that moved
      // them together would never exercise the case the split exists for: firing while a
      // card is open without resolving it.
      confirm: phase % 71 === 0,
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
