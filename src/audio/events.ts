/**
 * SimEvent → sound. The whole of the audio layer's knowledge of the game.
 *
 * `SimEvent` (src/sim/entities.ts) is a fixed contract this module consumes and
 * never changes. The mapping is exhaustive by construction: `cueForEvent` is a
 * switch with a `never` fallthrough, so adding a variant to the union is a
 * compile error here rather than a sound that silently never plays. That matters
 * because a missing sound is invisible in a screenshot and inaudible in CI —
 * nothing except the type system is going to notice it.
 *
 * Two cues are *not* driven by events, because the sim has no event for them:
 *
 *  - `ui.confirm` / `ui.cancel` are menu feedback, which happens outside a tick.
 *  - the telegraph is enemy *state* (`EnemyInstance.telegraphTicks`), not an
 *    event, so the director detects its rising edge. See src/audio/index.ts.
 */

import { PLAYFIELD_W } from '../core/space'
import type { SimEvent } from '../sim/entities'
import type { SoundId } from './sounds'

/** A resolved instruction to play one sound, before mixing. */
export interface SoundCue {
  readonly sound: SoundId
  /** Event-derived scaling, 0..~1.2. Multiplied by category and recipe gain. */
  readonly gain: number
  readonly pitch: number
  readonly timeScale: number
  /** -1..1. */
  readonly pan: number
}

/**
 * How far off-centre a sound may be placed.
 *
 * Hard-panned game audio is worse than mono: a fully-left explosion is
 * disorienting on headphones and vanishes entirely on a phone held sideways.
 * ±0.55 is enough to tell which side of a 448-unit playfield something happened
 * on, which is all the information there is to convey.
 */
const MAX_PAN = 0.55

/** Playfield x → stereo position. Off-playfield coordinates clamp, not wrap. */
export function panForX(x: number): number {
  if (!Number.isFinite(x)) return 0
  const centred = (x / PLAYFIELD_W) * 2 - 1
  return Math.max(-MAX_PAN, Math.min(MAX_PAN, centred * MAX_PAN))
}

/**
 * Damage → loudness, on a saturating curve.
 *
 * Linear scaling would make a 1-damage tick inaudible and an overkill hit
 * deafening. `reference` is the damage at which the sound reaches full level;
 * above it there is only 15% of extra headroom, because "a big hit" and "a very
 * big hit" are the same piece of information.
 */
function damageScale(damage: number, reference: number): number {
  if (!Number.isFinite(damage) || damage <= 0) return 0.8
  return 0.8 + Math.min(1, damage / reference) * 0.35
}

/** Nominal player shot damage (src/content/enemies.ts header: 4 per shot). */
const PLAYER_DAMAGE_REFERENCE = 8

/** Nominal serious hit on the hull — enemy bullets are 6–7, contact is worse. */
const HULL_DAMAGE_REFERENCE = 18

function cue(sound: SoundId, gain = 1, pitch = 1, pan = 0, timeScale = 1): SoundCue {
  return { sound, gain, pitch, timeScale, pan }
}

/**
 * The mapping. Total over `SimEvent` — the `never` default is the enforcement.
 */
export function cueForEvent(event: SimEvent): SoundCue {
  switch (event.kind) {
    case 'player-shot':
      return cue('weapon.shot', 1, 1, panForX(event.x))

    case 'enemy-hit':
      // A lethal hit is halved: `enemy-killed` lands in the same tick and the
      // explosion is the feedback. Playing both at full level doubles the
      // transient and makes a kill sound like a mistake.
      return cue(
        'impact.hit',
        damageScale(event.damage, PLAYER_DAMAGE_REFERENCE) * (event.lethal ? 0.5 : 1),
        1,
        panForX(event.x),
      )

    case 'enemy-killed':
      return cue(event.elite ? 'impact.killElite' : 'impact.kill', 1, 1, panForX(event.x))

    case 'enemy-shot':
      return cue('threat.enemyShot', 1, 1, panForX(event.x))

    case 'hull-hit':
      // The distinction the player needs is "did that cost me integrity", so it
      // is two different sounds rather than one sound at two volumes.
      return event.absorbedByShield
        ? cue('alarm.shieldAbsorb', damageScale(event.damage, HULL_DAMAGE_REFERENCE), 1, panForX(event.x))
        : cue('alarm.hullHit', damageScale(event.damage, HULL_DAMAGE_REFERENCE), 1, panForX(event.x))

    case 'shield-broken':
      return cue('alarm.shieldBroken', 1, 1, panForX(event.x))

    case 'hull-lost':
      // Centred deliberately: the run ending is not an event happening somewhere
      // on the playfield, it is an event happening to the player.
      return cue('alarm.hullLost')

    case 'scrap-collected':
      return cue('pickup.scrap', 1, 1, panForX(event.x))

    case 'wave-released':
      return cue('ui.waveRelease')

    default: {
      // Exhaustiveness: if `SimEvent` grows a variant, this stops compiling.
      const unreachable: never = event
      return unreachable
    }
  }
}

/**
 * Every `SimEvent.kind`, iterable at runtime.
 *
 * A `Record` keyed by the union means TypeScript rejects both a missing key and
 * an invented one, so this list cannot drift from the contract the way a
 * hand-written array would. Tests iterate it to prove the mapping is total.
 */
const EVENT_KINDS: Record<SimEvent['kind'], true> = {
  'player-shot': true,
  'enemy-hit': true,
  'enemy-killed': true,
  'enemy-shot': true,
  'hull-hit': true,
  'shield-broken': true,
  'hull-lost': true,
  'scrap-collected': true,
  'wave-released': true,
}

export const SIM_EVENT_KINDS = Object.keys(EVENT_KINDS) as readonly SimEvent['kind'][]
