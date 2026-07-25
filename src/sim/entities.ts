/**
 * Entity shapes and the read-only view of a run.
 *
 * This file is the contract between the simulation and everything that observes
 * it. Rendering, the HUD, and bot playtest policies all consume `WorldView` and
 * never the World class itself, which keeps the dependency arrow pointing one
 * way and means the sim can be restructured without touching its consumers.
 *
 * No behaviour lives here — types only.
 */

import type { EnemyShape, MovementKind } from '../content/types'

/**
 * Anything drawn between ticks keeps its previous position so the renderer can
 * interpolate. Without this, motion snaps to 60Hz on a faster display.
 */
export interface Interpolated {
  x: number
  y: number
  prevX: number
  prevY: number
}

export interface Hull extends Interpolated {
  /** Structural integrity. At zero the pilot is lost and the run ends. */
  integrity: number
  maxIntegrity: number
  /** Absorbs damage before integrity does. Does not regenerate in M1. */
  shield: number
  maxShield: number
  /** Ticks of invulnerability remaining after taking a hit. */
  invulnTicks: number
  /** Collision radius. Deliberately smaller than the drawn hull — see damage.ts. */
  radius: number
}

export interface Bullet extends Interpolated {
  vx: number
  vy: number
  damage: number
  radius: number
  alive: boolean
}

/** Visual/behavioural class of an enemy projectile. */
export type EnemyBulletKind = 'pellet' | 'shard' | 'tracker'

export interface EnemyBullet extends Interpolated {
  vx: number
  vy: number
  damage: number
  radius: number
  alive: boolean
  kind: EnemyBulletKind
}

/** Where an enemy is in its movement script. */
export type EnemyPhase = 'entering' | 'holding' | 'committed' | 'leaving'

export interface EnemyInstance extends Interpolated {
  /** Id of the EnemyDef this was spawned from. */
  defId: string
  hp: number
  maxHp: number
  radius: number
  shape: EnemyShape
  movement: MovementKind
  elite: boolean
  vx: number
  vy: number
  /** Ticks since spawn. Drives movement scripts and firing cadence. */
  age: number
  phase: EnemyPhase
  fireCooldown: number
  contactDamage: number
  scrap: number
  alive: boolean
  /** Counts down after taking damage, for the hit flash. Render-only concern. */
  hitFlashTicks: number
  /**
   * Ticks of firing windup remaining, counting down to the shot.
   *
   * This is the telegraph. Every attack must be readable *before* it lands, so
   * the enemy visibly commits for `windupTicks` before a volley leaves the
   * barrel. It is simulation state rather than a render animation because the
   * windup is real: it is the window in which the player is allowed to react,
   * and a purely cosmetic version would let the shot arrive without one.
   *
   * 0 means not currently winding up.
   */
  telegraphTicks: number
  /** Total windup for the current volley, so render can show progress. */
  telegraphTotal: number
  /** Anchor values a movement script needs (sine origin, hover target, ...). */
  originX: number
  holdY: number
}

export type ExplosionKind = 'enemy' | 'hull' | 'mine'

export interface Explosion {
  x: number
  y: number
  age: number
  lifetime: number
  radius: number
  kind: ExplosionKind
}

export type RunState = 'active' | 'lost' | 'extracted'

export type DeathCauseKind = 'enemy-fire' | 'collision' | 'hazard'

/**
 * The filed report for a lost run. Populated exactly once, when integrity hits
 * zero, and read by the incident report screen.
 */
export interface Incident {
  causeKind: DeathCauseKind
  /** Def id of whatever killed the pilot, when attributable. */
  causeEnemyId: string | null
  tick: number
  secondsSurvived: number
  waveIndex: number
  scrap: number
  kills: number
}

/**
 * Something that happened during a tick, for presentation to react to.
 *
 * Audio, damage numbers, and impact effects all need to know *when* something
 * happened, not just that state changed. Diffing state per frame cannot recover
 * that: two enemies dying in one tick, or a hit and a kill on the same target,
 * are indistinguishable after the fact.
 *
 * CRITICAL — these are cleared every tick, so they must be drained per *tick*,
 * not per rendered frame. A frame can span several ticks (and does span many
 * under `?ff=`), so a per-frame drain silently discards all but the last tick's
 * events, which shows up as audio dropping out under load.
 *
 * Events carry positions so presentation never has to look up an entity that the
 * sim may already have reaped.
 */
export type SimEvent =
  | { kind: 'player-shot'; x: number; y: number }
  | { kind: 'enemy-hit'; x: number; y: number; damage: number; defId: string; lethal: boolean }
  | { kind: 'enemy-killed'; x: number; y: number; defId: string; scrap: number; elite: boolean }
  | { kind: 'enemy-shot'; x: number; y: number; defId: string }
  | { kind: 'hull-hit'; x: number; y: number; damage: number; absorbedByShield: boolean }
  | { kind: 'shield-broken'; x: number; y: number }
  | { kind: 'hull-lost'; x: number; y: number }
  | { kind: 'scrap-collected'; x: number; y: number; amount: number }
  | { kind: 'wave-released'; index: number }

/**
 * Cosmetic state the simulation owns.
 *
 * It lives in the sim so a replay looks identical when played back, and it is
 * hashed into a separate digest that the regression corpus deliberately excludes —
 * otherwise tuning an explosion would fail every fixture and the corpus would get
 * rubber-stamped into meaninglessness.
 */
export interface CosmeticState {
  /**
   * Screen-shake energy, 0..1, decaying each tick.
   *
   * The *impulse* is sim state so playback matches; the resulting pixel offset is
   * computed by the renderer, which is free to scale or ignore it entirely when
   * the player has reduced motion enabled.
   */
  shake: number
}

export interface RunStats {
  tick: number
  shotsFired: number
  /** Player projectiles that connected. With shotsFired this gives accuracy. */
  hits: number
  kills: number
  scrap: number
  damageTaken: number
  /** Index of the last wave released, for measuring how far a run got. */
  waveIndex: number
  /** Highest simultaneous projectile count, checked against the perf budget. */
  peakProjectiles: number
  bulletsCulled: number
}

/**
 * Everything an observer may read from a run.
 *
 * Arrays are exposed as readonly. Observers must never mutate them — the sim
 * owns entity lifetimes, and a renderer that removes a dead enemy would
 * desynchronise every replay.
 */
export interface WorldView {
  readonly seed: string
  readonly runState: RunState
  readonly hull: Readonly<Hull>
  readonly playerBullets: readonly Bullet[]
  readonly enemyBullets: readonly EnemyBullet[]
  readonly enemies: readonly EnemyInstance[]
  readonly explosions: readonly Explosion[]
  readonly stats: Readonly<RunStats>
  readonly incident: Readonly<Incident> | null

  /** Events from the most recent tick. Drain per tick — see SimEvent. */
  readonly events: readonly SimEvent[]

  readonly cosmetic: Readonly<CosmeticState>

  /**
   * Ticks of hitstop remaining. Non-zero means gameplay is frozen this tick.
   *
   * Hitstop is a *feel* feature that is really a *timing* feature: briefly
   * freezing everything on a solid hit is what makes impact feel like contact
   * rather than overlap. It therefore lives in the simulation and consumes real
   * ticks. Implementing it by skipping render frames instead would look identical
   * on screen while making the run non-reproducible, and would silently
   * invalidate every recorded replay.
   */
  readonly freezeTicks: number
}
