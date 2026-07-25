/**
 * Content definition types.
 *
 * Content is *data*. Adding an enemy or a wave must never require editing the
 * simulation — if a new enemy idea can't be expressed here, the right move is to
 * add a movement or weapon kind that the sim interprets, not to special-case the
 * enemy in sim code.
 */

/**
 * How an enemy moves. The simulation interprets these; content only selects one.
 *
 * - `drift`   — straight down at `speed`. The baseline.
 * - `sine`    — down while oscillating horizontally around its spawn x.
 * - `swoop`   — descends to `holdY`, pauses, then accelerates downward.
 * - `hover`   — descends to `holdY` and stays there, firing.
 * - `strafe`  — descends to `holdY`, then crosses horizontally.
 */
export type MovementKind = 'drift' | 'sine' | 'swoop' | 'hover' | 'strafe'

/**
 * How an enemy shoots.
 *
 * - `none`    — unarmed; threat is contact only.
 * - `aimed`   — a single shot toward the hull's position at fire time.
 * - `spread`  — `count` shots in an arc of `spreadDegrees`, centred on the hull.
 * - `ring`    — `count` shots evenly around a full circle. Position, not aim.
 * - `tracker` — a slow shot toward the hull that keeps its heading. Punishes
 *               standing still without being unavoidable.
 */
export type EnemyWeaponKind = 'none' | 'aimed' | 'spread' | 'ring' | 'tracker'

/** Selects the code-defined geometry the renderer draws. No art assets. */
export type EnemyShape = 'hauler' | 'skiff' | 'lancer' | 'turret' | 'mine' | 'escort'

export interface EnemyWeaponDef {
  kind: EnemyWeaponKind
  /** Ticks between volleys. */
  intervalTicks: number
  /** Virtual units per second. */
  bulletSpeed: number
  damage: number
  /** Projectiles per volley. Required for `spread` and `ring`. */
  count?: number
  /** Total arc width for `spread`, in degrees. */
  spreadDegrees?: number
  /**
   * Ticks before the first volley. Give every armed enemy a nonzero value —
   * something that shoots the instant it appears is unreactable, not difficult.
   */
  firstDelayTicks: number
}

/** Movement tuning. Which fields matter depends on `movement`. */
export interface MovementParams {
  /** Virtual units per second along the enemy's primary axis. */
  speed: number
  /** `sine`: horizontal half-range in virtual units. */
  amplitude?: number
  /** `sine`: oscillations per second. */
  frequency?: number
  /** `swoop`/`hover`/`strafe`: y to settle at, as a fraction of playfield height. */
  holdYFraction?: number
  /** `swoop`: ticks to pause before diving. `hover`: ticks before leaving. */
  holdTicks?: number
  /** `swoop`: downward speed multiplier once committed. */
  diveMultiplier?: number
}

export interface EnemyDef {
  id: string
  /** Shown in the incident report, so it reads as prose: "lost to a Lancer". */
  name: string
  hp: number
  /** Collision radius in virtual units. */
  radius: number
  /** Damage dealt to the hull on contact. */
  contactDamage: number
  /** Scrap awarded on destruction. */
  scrap: number
  movement: MovementKind
  movementParams: MovementParams
  weapon: EnemyWeaponDef
  shape: EnemyShape
  elite?: boolean
  /**
   * Fires a ring of projectiles when destroyed. Turns a kill into a positioning
   * problem, which is how a slow unarmed enemy stays interesting.
   */
  deathBurst?: { count: number; bulletSpeed: number; damage: number }
}

/** How a group of enemies is arranged when it spawns. */
export type FormationPattern = 'line' | 'arc' | 'column' | 'scatter' | 'flanks'

export interface FormationDef {
  enemyId: string
  count: number
  pattern: FormationPattern
  /** Horizontal spacing in virtual units. Pattern-dependent. */
  spacing?: number
  /** Centre of the formation as a fraction of playfield width. Random if unset. */
  atXFraction?: number
  /** Ticks between successive spawns within the formation. 0 spawns together. */
  staggerTicks?: number
}

export interface WaveEntry {
  /** Seconds from sector start at which this wave releases. */
  atSeconds: number
  formations: FormationDef[]
  /** Optional label for playtest reports and death attribution. */
  label?: string
}

export interface SectorDef {
  id: string
  name: string
  /** Nominal length. The sector ends when the script is done and play is clear. */
  durationSeconds: number
  waves: WaveEntry[]
}
