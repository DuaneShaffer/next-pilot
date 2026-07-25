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
  /**
   * Ticks of visible windup before each volley — the telegraph.
   *
   * The enemy commits to the shot for this long before it fires, and the renderer
   * shows that commitment. This is the player's reaction window, so it is real
   * simulation time rather than an animation played alongside the shot.
   *
   * Longer windups make an attack fairer and easier to read; shorter ones make it
   * more dangerous. Zero means the shot arrives unannounced, which should be rare
   * and deliberate — an unreadable attack is not difficulty, it is noise.
   */
  windupTicks: number
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

// ---------------------------------------------------------------------------
// items
// ---------------------------------------------------------------------------

/**
 * Numeric properties an item may modify.
 *
 * A closed union, deliberately. An open string key would let an item modify a
 * stat nothing reads, which fails silently and is nearly impossible to notice —
 * the item just does nothing and the player never knows.
 */
export type StatKey =
  | 'fireIntervalTicks'
  | 'projectileDamage'
  | 'projectileSpeed'
  | 'projectilesPerShot'
  | 'hullSpeed'
  | 'maxIntegrity'
  | 'maxShield'
  | 'scrapMultiplier'
  | 'pickupRadius'
  | 'focusFactor'

/**
 * How a modifier combines with the base value.
 *
 * THE FOLD ORDER IS FIXED AND MUST NOT CHANGE: every `add` is summed onto the
 * base, then every `mul` is applied to that subtotal, then the stat's own bounds
 * clamp the result. Additions before multiplications, never interleaved by
 * acquisition order.
 *
 * Bounds live with the stat in the simulation, not on the modifier — a fire
 * interval must never reach zero however many items stack, and that is a property
 * of the stat rather than of whichever item happened to push it there.
 *
 * This matters more than it looks. If order followed pickup order, the same two
 * items would produce different numbers depending on which was found first —
 * builds would be unreproducible, two players on one seed could diverge, and
 * "+2 damage" would mean something different every run. A fixed order costs
 * nothing and removes a whole class of unexplainable bug reports.
 */
export type ModifierKind = 'add' | 'mul'

export interface StatModifier {
  stat: StatKey
  kind: ModifierKind
  value: number
}

/**
 * Points in the simulation where an item may act.
 *
 * Hooks exist for *behavioural* items — split shot, chain lightning, retaliation
 * — because a stat modifier cannot express them. Stats handle numbers; hooks
 * handle behaviour. Anything expressible as a stat modifier should be one, since
 * stats fold in a fixed order and hooks do not.
 *
 * DETERMINISM: hooks fire in item acquisition order, which is stable within a
 * run and recorded in the replay. Any randomness a hook needs comes from the
 * run's `items` stream — never a new Rng, never `Math.random()`.
 */
export type HookName =
  /** After the weapon fires. Can append projectiles or alter the volley. */
  | 'onFire'
  /** A player projectile connected. Carries damage dealt and the target. */
  | 'onProjectileHit'
  /** An enemy died. Carries position and scrap value. */
  | 'onEnemyKilled'
  /** The hull took damage, after shields were applied. */
  | 'onHullDamaged'
  /** Scrap was collected. */
  | 'onScrapCollected'
  /** Every tick, for timers and windows. Keep these cheap. */
  | 'onTick'

/** Tiers drive offer weighting and the colour a name is drawn in. */
export type ItemTier = 'common' | 'uncommon' | 'rare' | 'relic'

/**
 * Tags describe what an item is *about*, so interactions and offer weighting can
 * reason about builds without hardcoding item ids.
 */
export type ItemTag =
  | 'weapon'
  | 'defence'
  | 'economy'
  | 'mobility'
  | 'drone'
  | 'explosive'
  | 'electric'
  | 'cursed'

export interface ItemDef {
  id: string
  name: string
  tier: ItemTier
  tags: readonly ItemTag[]
  /**
   * What the item does, in one sentence, with real numbers.
   *
   * UI.md rule 4: mechanism first, flavour third and omittable. A player choosing
   * between three items under time pressure needs the mechanism, not the joke.
   * Write "+18% fire rate for 3 s after collecting scrap", not "runs on greed".
   */
  mechanism: string
  /** Flavour. Always omittable, never load-bearing. */
  flavour?: string
  stats?: readonly StatModifier[]
  /** Hooks this item implements. The sim looks up behaviour by item id. */
  hooks?: readonly HookName[]
  /** Relative offer weight within its tier. 0 means never offered randomly. */
  weight?: number
}

/**
 * An interaction between two items — FIRST-CLASS DATA, not an emergent accident.
 *
 * UI.md rule 5 requires that synergies are *stated* when offered. "Hidden
 * synergies players discover" works for the 5% who read wikis; for everyone else
 * an undiscoverable interaction is indistinguishable from no interaction, and the
 * depth the design is paying for goes unused.
 *
 * Declaring them as data means the choice screen can look up every interaction
 * between an offered item and the current build and name it, the interaction graph
 * can be documented and tested for reachability, and a combination cannot exist
 * that the game is unable to explain.
 */
export interface InteractionDef {
  id: string
  /** Exactly two items in M3. Ordering is irrelevant; matching is set-based. */
  requires: readonly [string, string]
  /** Stated verbatim on the choice screen. Mechanism, with numbers. */
  text: string
  /** Extra modifiers that apply only while both items are held. */
  stats?: readonly StatModifier[]
  /** Extra hooks that apply only while both items are held. */
  hooks?: readonly HookName[]
}

/**
 * What a work-order assignment rewards.
 *
 * NOTE ON SCOPE: docs/DESIGN.md describes work orders as a choice *between
 * sectors*. Only one sector exists until M5, so between-sector choices have
 * nowhere to go. M3 places them at assignment points *within* a sector instead —
 * the mechanic, the interface, and the risk/reward reasoning are all identical,
 * and they relocate to sector boundaries when there are boundaries to put them
 * on. Building the choice UI now and the routing later is cheaper than the
 * reverse.
 */
export type WorkOrderKind = 'supply' | 'hazard' | 'vault' | 'repair' | 'unlisted'

export interface WorkOrderDef {
  kind: WorkOrderKind
  name: string
  /** The trade-off in plain language. No icon-guessing — see UI.md rule 4. */
  description: string
}
