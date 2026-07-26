/**
 * What each cue tells the player to DO, and how far apart two cues have to be as
 * a consequence.
 *
 * WHY THIS EXISTS. `tools/audio.ts` scores every important pair of cues for
 * distinguishability and required 1.0 from all of them. That flat floor was
 * wrong, and the way it was wrong is instructive: `alarm.shieldAbsorb` and
 * `alarm.shieldBroken` scored 1.46 and passed. But those two are not merely
 * different, they are *opposite instructions*, delivered in the same moment,
 * heard while dodging:
 *
 *   shield absorbed — you are fine. Keep flying the way you were flying.
 *   shield broken   — your buffer is gone. The next hit is permanent.
 *
 * A pair like that confused is a death in a permadeath run. A pair like
 * `ui.confirm` / `ui.cancel` confused is a menu press. Holding both to the same
 * number treats those as the same risk, and a floor set low enough to be fair to
 * the second is too low to protect the first.
 *
 * THE STRUCTURAL PART. The tiers are not a hand-written list of pairs, because a
 * hand-written list is exactly what goes stale the day someone adds a sound. Every
 * sound is classified by its instruction in a `Record` keyed by `SoundId`, so a new
 * cue that nobody has classified is a compile error rather than a pair that quietly
 * inherits the lenient floor. The demanding pairs are then *derived*: any
 * `stand-down` against any `evade` is opposed, automatically, forever.
 *
 * Not part of the shipped bundle — only the harness and the tests import this.
 */

import { SOUND_IDS, type SoundId } from './sounds'

/**
 * The action a cue implies. Not what caused it — what the player should do next.
 *
 * The distinction that matters is `stand-down` against `evade`, because those are
 * the two that contradict each other. `confirm` and `inform` are about things the
 * player caused or the run's structure; mistaking one for the other costs nothing
 * immediate.
 */
export type Instruction =
  /** You are fine. Whatever you were doing, keep doing it. */
  | 'stand-down'
  /** Something can hurt you now or within the second. Move. */
  | 'evade'
  /** Something you did worked. No action implied. */
  | 'confirm'
  /** Context, structure, or a fact about the run. No action implied. */
  | 'inform'

/**
 * Every cue, classified. Keyed by the union, so this cannot fall behind
 * `SoundId` — adding a sound without deciding what it tells the player is a
 * typecheck failure, which is the point.
 */
export const INSTRUCTION: Record<SoundId, Instruction> = {
  // Things you caused.
  'weapon.shot': 'confirm',
  'impact.hit': 'confirm',
  'impact.kill': 'confirm',
  'impact.killElite': 'confirm',
  'impact.bossKilled': 'confirm',
  'pickup.scrap': 'confirm',

  // Things that can hurt you.
  'threat.enemyShot': 'evade',
  'threat.telegraph': 'evade',
  'threat.bossSpawn': 'evade',
  'threat.bossPhase': 'evade',
  'alarm.hazardWarning': 'evade',
  'alarm.hullHit': 'evade',
  // The buffer is gone; every subsequent hit is permanent. This is the cue whose
  // opposite exists, and the reason this file does.
  'alarm.shieldBroken': 'evade',

  // The only cue in the game that means "you are fine".
  'alarm.shieldAbsorb': 'stand-down',

  // Already happened; nothing to do about it now.
  'threat.hazardFired': 'inform',
  'alarm.hullLost': 'inform',
  'ui.confirm': 'inform',
  'ui.cancel': 'inform',
  'ui.waveRelease': 'inform',
  'ui.stageCleared': 'inform',
}

/** How demanding the separation requirement is for a given pair. */
export type SeparationTier = 'opposed' | 'distinct'

/**
 * Minimum separation score per tier.
 *
 * `distinct` is the original floor: 1.0 means "just separable on at least one
 * axis". `opposed` is 2.0 — twice the margin on whichever axis carries the
 * difference — because these are the pairs where being *nearly* able to tell is
 * the same as not being able to tell. For reference, a comfortably separated pair
 * in the same family (`alarm.shieldAbsorb` against `alarm.hullHit`) scores above
 * 5, so 2.0 is not an unreachable bar; it is roughly the bottom of the range the
 * rest of the library already occupies.
 */
export const SEPARATION_FLOOR: Record<SeparationTier, number> = {
  opposed: 2,
  distinct: 1,
}

/**
 * Minimum in-combat discrimination margin for an opposed pair, in dB.
 *
 * Separation is measured in silence, which is the wrong room. This is the second
 * requirement: the band that best distinguishes the two cues must stand clear of
 * ordinary combat, or the difference is real in the file and absent in the ear.
 *
 * WHERE 10 dB COMES FROM. A tone is detectable in broadband noise at roughly 0 dB
 * within its critical band. Three things argue for margin on top of that: the
 * masking model in `src/audio/analysis.ts` has no spreading function, so real
 * masking is worse than modelled; the listener is dodging rather than
 * concentrating; and being *nearly* able to tell "you are fine" from "your buffer
 * is gone" is the same as not being able to. 10 dB is comfortably above detection
 * with room for all three.
 *
 * It is not fitted to the current numbers — those run 13.7 to 28.8 dB, so the
 * tightest pair keeps under 4 dB of headroom and a recipe drifting back towards
 * the crowd trips this before a player ever hears it.
 */
export const OPPOSED_DISCRIMINATION_DB = 10

/**
 * And the difference must not be buried overall, only findable in one lucky band.
 * 0 dB: averaged across the bands that distinguish them, the pair is at least as
 * loud as the combat it is heard over.
 */
export const OPPOSED_DISCRIMINATION_MEAN_DB = 0

export function tierFor(a: SoundId, b: SoundId): SeparationTier {
  const first = INSTRUCTION[a]
  const second = INSTRUCTION[b]
  const opposed =
    (first === 'stand-down' && second === 'evade') || (first === 'evade' && second === 'stand-down')
  return opposed ? 'opposed' : 'distinct'
}

export function floorFor(a: SoundId, b: SoundId): number {
  return SEPARATION_FLOOR[tierFor(a, b)]
}

/**
 * Every pair whose two cues tell the player to do contradictory things.
 *
 * Derived, never listed. Today this is `alarm.shieldAbsorb` against each of the
 * seven `evade` cues, and that is the right answer for a reason worth writing
 * down: shield-absorb is the only sound in the game that means "you are fine", so
 * it is the only sound that can be catastrophically mistaken for a warning.
 */
export function opposedPairs(): readonly (readonly [SoundId, SoundId])[] {
  const pairs: [SoundId, SoundId][] = []
  for (let i = 0; i < SOUND_IDS.length; i++) {
    for (let j = i + 1; j < SOUND_IDS.length; j++) {
      const a = SOUND_IDS[i]
      const b = SOUND_IDS[j]
      if (a === undefined || b === undefined) continue
      if (tierFor(a, b) === 'opposed') pairs.push([a, b])
    }
  }
  return pairs
}
