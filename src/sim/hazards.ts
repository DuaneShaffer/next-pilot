/**
 * Sector hazards: the environment as an opponent.
 *
 * A hazard is a cycle, not a constant. It idles, it *warns*, then it acts, then it
 * idles again. The warning phase is the whole reason this is simulation state rather
 * than a render effect: it is the time the player is given to react, and a hazard
 * that arrives without one is indistinguishable from integrity draining for no
 * reason — the single most corrosive thing a roguelike can do to someone trying to
 * learn it.
 *
 * Every kind acts exactly once per cycle. Chip damage every tick was the obvious
 * first design and it is wrong twice over: the invulnerability window would swallow
 * most of it, and a health bar that slides down continuously teaches nothing about
 * *when* to move.
 */

import { TICK_HZ } from '../core/loop'
import { PLAYFIELD_W } from '../core/space'
import type { HazardDef, HazardKind } from '../content/types'
import type { Rng } from '../core/rng'
import type { HazardPhase, HazardView } from './entities'
import { spawnHazardBullet, type AttributedEnemyBullet } from './projectiles'

/**
 * Warning before a hazard acts: 1 second.
 *
 * The same order as an enemy telegraph (`windupTicks` runs 20-70 ticks), because it
 * is the same promise. Shorter and it is a jump scare; longer and the hazard stops
 * being a threat and becomes a metronome you walk around.
 */
export const HAZARD_WARNING_TICKS = 60

/** How long an ongoing hazard lasts once it fires: 2 seconds. */
export const HAZARD_ACTIVE_TICKS = 120

/** Hull speed multiplier while an interdiction field is up. */
export const INTERDICTION_SPEED_FACTOR = 0.55

/** Debris projectiles per fall, and how fast they come down. */
const DEBRIS_COUNT = 5
const DEBRIS_SPEED = 165
const DEBRIS_RADIUS = 4

/**
 * Kinds whose effect is a WINDOW rather than an instant.
 *
 * `corrosion` and `debris` do their work on the tick they fire and are then over;
 * `interdiction` and `blackout` are conditions that persist for HAZARD_ACTIVE_TICKS.
 * Getting this backwards would make a blackout a single dark frame.
 */
const SUSTAINED: ReadonlySet<HazardKind> = new Set<HazardKind>(['interdiction', 'blackout'])

/** What the field wants the world to do on a given tick. */
export interface HazardPulse {
  def: HazardDef
  /** True on the single tick the hazard begins warning. */
  warning: boolean
  /** True on the single tick the hazard acts. */
  fired: boolean
}

interface HazardRuntime {
  def: HazardDef
  phase: HazardPhase
  /** Ticks left in the current phase. */
  remaining: number
  /** Length of the current phase, for the progress arc. */
  span: number
}

export class HazardField {
  private readonly runtimes: HazardRuntime[]
  /** Reused across ticks so a quiet tick allocates nothing. */
  private readonly pulses: HazardPulse[] = []

  constructor(defs: readonly HazardDef[]) {
    this.runtimes = defs.map((def, index) => {
      // Staggered by position so two hazards in one sector do not fire in lockstep
      // and read as a single event. A sector with three hazards should feel like
      // three things going wrong, not one big one.
      //
      // The stagger uses the MAP INDEX, not `defs.indexOf(def)`. Two entries pointing
      // at the same def object — which a route that armed the same hazard twice would
      // produce — both resolve to the first index under `indexOf`, so they would come
      // out perfectly synchronised: precisely the failure the stagger exists to stop,
      // and invisible in every case where the ids happen to differ.
      const interval = intervalOf(def)
      const offset = Math.round((interval / (defs.length + 1)) * (index + 1))
      return { def, phase: 'idle' as HazardPhase, remaining: interval + offset, span: interval + offset }
    })
  }

  get empty(): boolean {
    return this.runtimes.length === 0
  }

  /**
   * Advance every hazard one tick and report the transitions.
   *
   * The returned array is reused, so callers must consume it before the next call —
   * the same rule `WorldView.events` states, for the same reason.
   */
  update(): readonly HazardPulse[] {
    this.pulses.length = 0
    for (const r of this.runtimes) {
      r.remaining--
      if (r.remaining > 0) continue

      switch (r.phase) {
        case 'idle':
          r.phase = 'warning'
          r.span = HAZARD_WARNING_TICKS
          r.remaining = HAZARD_WARNING_TICKS
          this.pulses.push({ def: r.def, warning: true, fired: false })
          break

        case 'warning': {
          r.phase = 'active'
          // An instant hazard holds `active` only long enough to be visible; a
          // sustained one holds it for the whole window it is actually in force.
          const span = SUSTAINED.has(r.def.kind) ? HAZARD_ACTIVE_TICKS : 1
          r.span = span
          r.remaining = span
          this.pulses.push({ def: r.def, warning: false, fired: true })
          break
        }

        case 'active':
          r.phase = 'idle'
          r.span = intervalOf(r.def)
          r.remaining = r.span
          break
      }
    }
    return this.pulses
  }

  /**
   * Combined hull-speed multiplier from every active interdiction field.
   *
   * Multiplicative rather than "slowest wins", so two overlapping fields are worse
   * than one — a route that stacks them has to actually cost something.
   */
  speedFactor(): number {
    let factor = 1
    for (const r of this.runtimes) {
      if (r.phase === 'active' && r.def.kind === 'interdiction') factor *= INTERDICTION_SPEED_FACTOR
    }
    return factor
  }

  /** True while any blackout is in force. Presentation reads this; nothing else. */
  get blackout(): boolean {
    return this.runtimes.some((r) => r.phase === 'active' && r.def.kind === 'blackout')
  }

  /** Snapshot for the panel. Allocates — call once per frame, not per hazard check. */
  views(): HazardView[] {
    return this.runtimes.map((r) => ({
      id: r.def.id,
      name: r.def.name,
      hazardKind: r.def.kind,
      description: r.def.description,
      phase: r.phase,
      ticksToChange: r.remaining,
      progress: r.span > 0 ? 1 - r.remaining / r.span : 1,
    }))
  }
}

/**
 * A hazard's cycle length, floored.
 *
 * A cycle shorter than its own warning would fire before it finished announcing
 * itself, which is the one thing this module exists to prevent — so content cannot
 * express it, whatever the number says.
 */
function intervalOf(def: HazardDef): number {
  const authored = Number.isFinite(def.intervalTicks) ? Math.floor(def.intervalTicks) : TICK_HZ * 8
  return Math.max(HAZARD_WARNING_TICKS + HAZARD_ACTIVE_TICKS, authored)
}

/**
 * Drop a curtain of debris across the playfield.
 *
 * Spread evenly with a jittered offset rather than fully at random: an even spread
 * always leaves a gap wide enough to sit in, so the fall is a *positioning* problem
 * with a correct answer, not a dice roll about whether one lands on you.
 */
export function spawnDebris(
  out: AttributedEnemyBullet[],
  def: HazardDef,
  rng: Rng,
): void {
  const lane = PLAYFIELD_W / DEBRIS_COUNT
  const jitter = rng.range(0, lane)
  for (let i = 0; i < DEBRIS_COUNT; i++) {
    const x = (i * lane + jitter) % PLAYFIELD_W
    spawnHazardBullet(out, def.id, x, -DEBRIS_RADIUS, 0, DEBRIS_SPEED, def.damage, DEBRIS_RADIUS, 'tracker')
  }
}
