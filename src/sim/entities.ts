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
}
