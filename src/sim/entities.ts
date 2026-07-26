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

import type { EnemyShape, HazardKind, ItemTier, MovementKind } from '../content/types'

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
  /**
   * Targets this round may still pass through.
   *
   * Undefined means the bullet has not pierced yet and should take the build's
   * current value.
   */
  pierceRemaining?: number
  /**
   * Enemies this round has already damaged.
   *
   * The count alone is NOT sufficient, and assuming it was shipped a real bug: a
   * bullet travels ~10 units per tick and a large enemy has a 30-unit radius, so a
   * round sits inside its target for several ticks and re-hit it on every one. A
   * `pierce: 3` round did 4x damage to a single hauler — making the item worth
   * *more* against big targets, the exact inversion of its intent.
   */
  hitUids?: number[]
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

/** Firing cadence for one weapon barrel. */
export interface WeaponSlotState {
  cooldown: number
  /** Ticks of telegraph remaining. 0 means not currently winding up. */
  windup: number
  windupTotal: number
}

export interface EnemyInstance extends Interpolated {
  /**
   * Unique instance identity, monotonic within a run.
   *
   * `defId` is shared by every enemy of a type and array position is unstable
   * (projectile and enemy lists use swap-remove), so neither can identify *this*
   * enemy. Piercing needs to, in order to not hit the same target twice.
   *
   * Play-affecting, therefore hashed.
   */
  uid: number
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
  /**
   * Total windup for the current volley, so render can show progress.
   *
   * With a second barrel these two fields become the *display* telegraph — whichever
   * barrel fires soonest — rather than strictly the primary's. See updateEnemyWeapon.
   */
  telegraphTotal: number
  /** Cadence state for `EnemyDef.secondaryWeapon`. Absent when there is no second barrel. */
  secondary?: WeaponSlotState
  /** Anchor values a movement script needs (sine origin, hover target, ...). */
  originX: number
  holdY: number
  /**
   * Phase script, present only on a boss.
   *
   * A boss is an ordinary enemy carrying this. Everything else about it — movement,
   * weapons, collision, death — runs through exactly the same code paths, which is
   * why authoring a boss adds no simulation code. See sim/bosses.ts.
   */
  boss?: BossRuntime
}

/**
 * A boss fight's progress through its phases.
 *
 * Each phase is a *derived* `EnemyDef` registered under a synthetic id, so advancing
 * a phase is a one-field swap of `defId` and the existing movement and weapon
 * interpreters pick the new behaviour up on the next tick. The alternative — a
 * `BossInstance` with its own update path — would mean every future movement kind
 * had to be implemented twice.
 */
export interface BossRuntime {
  bossId: string
  name: string
  /** Which seeded variant is being fought, or null for the base form. */
  variantId: string | null
  phaseIndex: number
  /** Derived def id per phase, parallel to `thresholds`. */
  phaseDefIds: readonly string[]
  /** `fromHealthFraction` per phase, descending. */
  thresholds: readonly number[]
  callouts: readonly string[]
  /**
   * Ticks the current phase callout stays on screen.
   *
   * Sim state rather than a render animation because the callout is the *warning*,
   * and a warning whose duration depends on framerate is not a warning.
   */
  calloutTicks: number
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
  | { kind: 'boss-spawned'; bossId: string; name: string }
  | { kind: 'boss-phase'; bossId: string; phaseIndex: number; callout: string }
  | { kind: 'boss-killed'; x: number; y: number; bossId: string }
  /**
   * A hazard is about to fire. This is the telegraph, and it is a real event rather
   * than a render cue for the same reason `telegraphTicks` is: the warning window is
   * the time the player is given to react, so it has to be simulation state.
   */
  | { kind: 'hazard-warning'; hazardId: string }
  | { kind: 'hazard-fired'; hazardId: string }
  | { kind: 'stage-cleared'; stageIndex: number }

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

  /** Items held, in acquisition order. Effect dispatch follows this order. */
  readonly inventory: readonly HeldItem[]
  /** Interactions live because both their items are held. */
  readonly activeInteractions: readonly ActiveInteraction[]
  /**
   * Stat values after folding every modifier.
   *
   * The single source the HUD reads. This project has already shipped a panel
   * advertising a fire rate the weapon did not have, and items are about to make
   * these numbers move constantly — recomputing them anywhere else reintroduces
   * exactly that bug.
   */
  readonly resolvedStats: ResolvedStats
  /**
   * Set when the run is waiting on a player decision.
   *
   * While this is non-null, time is paused: an item choice is a decision, not a
   * reflex test. Ticks still advance so a recorded input log stays aligned with
   * wall-clock ticks, but nothing moves and nothing spawns.
   */
  readonly pendingChoice: Readonly<PendingChoice> | null

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

  /** Which leg of the run is being flown. Never a planned figure — see StageView. */
  readonly stage: StageView

  /** The hull this run was issued, by name. */
  readonly hullName: string

  /**
   * The live boss, or null.
   *
   * Exposed separately from `enemies` (where it also appears) because the boss needs
   * a health bar and a phase callout of its own, and finding it by scanning for a
   * `boss` field every frame would make presentation responsible for a fact the sim
   * already knows.
   */
  readonly boss: EnemyInstance | null

  /** Hazards active in this stage, with their countdowns. */
  readonly hazards: readonly HazardView[]

  /**
   * How an open choice will resolve itself if the player does nothing, and when.
   *
   * Null when no choice is open. Every card in this game resolves without input
   * eventually — a held trigger confirms the highlighted option after a dwell, and an
   * untouched card times out — and until this existed, NOTHING on screen said so.
   *
   * Both mechanisms are good and both were added for good reasons (see
   * HELD_CONFIRM_DWELL_TICKS, which fixed a soft freeze a tester actually hit). The
   * defect was that they were invisible: a card that decides for you while you are
   * still reading it is the interface making a permadeath choice on your behalf
   * without warning. Surfaced on the view rather than recomputed per screen so all
   * four card kinds say the same thing — four screens each inventing their own
   * countdown is how they end up disagreeing.
   */
  readonly choiceResolve: ChoiceResolveView | null

  /**
   * Which option an open choice has highlighted. -1 when no choice is open.
   *
   * PLAY-AFFECTING, and it was invisible. Every card resolves itself if the player
   * does nothing — the dwell confirms the *highlighted* option — so two runs sitting
   * on the same card with different options selected take different items. Until this
   * was on the view, the state hash could not see the difference and those two runs
   * compared equal, which is precisely the silent divergence the replay corpus exists
   * to catch.
   *
   * The simulation owns the cursor so a recorded run reproduces its picks; screens
   * render this rather than holding a selection of their own, which is what keeps the
   * two from ever disagreeing about what is highlighted.
   */
  readonly choiceSelection: number
}

/** What an open choice will do on its own, and how long is left. */
export interface ChoiceResolveView {
  /**
   * `confirm` — the trigger is held and the dwell will take the highlighted option.
   * `skip` — nobody has touched anything and the card will decline itself.
   */
  action: 'confirm' | 'skip'
  ticksRemaining: number
  /** Length of the window this is counting down, so a bar can show progress. */
  totalTicks: number
}

// ---------------------------------------------------------------------------
// items — runtime state
// ---------------------------------------------------------------------------

/** One item held by the pilot, in acquisition order. */
export interface HeldItem {
  defId: string
  /** Tick it was acquired. Hook dispatch order follows this, so it is play-affecting. */
  acquiredAtTick: number
  /** Stacks, for items that can be taken more than once. */
  count: number
}

/**
 * An interaction currently active because both of its items are held.
 *
 * Resolved by the simulation and exposed so the HUD can show the player which of
 * their combinations are live — UI rule 5 requires that a synergy is stated, and
 * that obligation does not end once the item has been picked.
 */
export interface ActiveInteraction {
  defId: string
  text: string
}

/**
 * One of the three options on the item-choice screen.
 *
 * `interactionText` is filled in by the simulation when this option would combine
 * with something already held. It is the mechanism behind UI rule 5: the choice
 * screen never has to work out for itself whether two items interact, so it cannot
 * fail to mention one.
 */
export interface ItemOffer {
  defId: string
  /**
   * The item's tier.
   *
   * Included because the choice screen displays it, and a `WorldView` that withholds
   * something visible on screen makes any observer — a bot measuring pick rates, most
   * of all — blind to information the player has. Tier preference was unmeasurable
   * outside shops until this existed.
   */
  tier: ItemTier
  /** Non-empty when taking this would activate an interaction with the build. */
  interactionText: readonly string[]
}

/** Why the run is currently paused for a decision. */
export type PendingChoiceKind = 'item' | 'shop' | 'work-order' | 'route'

export interface PendingChoice {
  kind: PendingChoiceKind
  offers: readonly ItemOffer[]
  /** Scrap cost per option; all zero for a free reward. */
  costs: readonly number[]
  /** Work-order options, when kind is 'work-order'. */
  workOrders: readonly string[]
  /** Approach options into the next sector, when kind is 'route'. */
  routes: readonly RouteOption[]
}

/**
 * What taking a route grants on arrival.
 *
 * A discriminated union rather than a number and a label, so the screen cannot
 * describe a reward the sim will not actually pay.
 */
export type RouteReward =
  | { kind: 'none' }
  | { kind: 'item' }
  | { kind: 'scrap'; amount: number }
  | { kind: 'repair'; amount: number }

/**
 * One approach into the next sector — the world map's nodes.
 *
 * The sector order is authored and fixed (sector 2 is always The Tally), so what a
 * route varies is *how* you arrive: which hazard you accept for which reward. That
 * is the risk/reward decision docs/DESIGN.md asks work orders to be, and it keeps
 * the authored difficulty curve intact instead of letting a route skip it.
 *
 * Everything shown on the map is stated here in plain language. Nothing about a
 * route may be discoverable only by taking it — see UI.md rule 4.
 */
export interface RouteOption {
  /** Stage this leads to. Always the next one; routes differ in approach, not order. */
  stageIndex: number
  /**
   * The route's own name, authored here rather than derived by the screen.
   *
   * A screen inferring a title from `reward.kind` gives two routes with the same
   * reward the same title, and they are then distinguishable only by their hazard
   * lists. That cannot happen with today's route builder — but a title that is
   * correct by coincidence is a title that breaks the next time the builder changes,
   * and this is the label the player uses to talk about their choice.
   */
  name: string
  sectorName: string
  /** Named so the map can say what is waiting at the end of the leg. */
  bossName: string | null
  /** Hazards accepted by taking this route. Empty for the direct approach. */
  hazards: readonly { name: string; description: string }[]
  /**
   * Ids of the same hazards, for the simulation to arm on arrival.
   *
   * Parallel to `hazards` and carried on the same object deliberately: a side table
   * keyed by route index is exactly the kind of parallel array that desynchronises
   * and arms a hazard the player was never shown.
   */
  hazardIds: readonly string[]
  reward: RouteReward
  /** The trade-off in one sentence, with numbers. Rendered verbatim. */
  rewardText: string
}

/** Where a hazard is in its cycle. */
export type HazardPhase = 'idle' | 'warning' | 'active'

/**
 * A hazard as an observer sees it.
 *
 * `phase` and `ticksToChange` exist so the panel can count a hazard down. A hazard
 * that arrives with no visible warning is indistinguishable from an unexplained loss
 * of integrity, which is the single worst thing a roguelike can do to a player
 * trying to learn it.
 */
export interface HazardView {
  id: string
  name: string
  hazardKind: HazardKind
  description: string
  phase: HazardPhase
  ticksToChange: number
  /** 0..1 through the current phase, for a progress arc. */
  progress: number
}

/**
 * Which leg of the run is being flown.
 *
 * Sourced from the live run rather than from a planned count. The panel once read
 * "SECTOR 1 / 5" for the whole game because it displayed the roadmap instead of the
 * simulation; a view field is what stops that recurring.
 */
export interface StageView {
  /** 0-based. */
  index: number
  count: number
  sectorId: string
  sectorName: string
  bossName: string | null
}

/**
 * Resolved stat values after folding every modifier.
 *
 * Exposed so the HUD reads the same numbers the simulation uses. The panel
 * advertising a fire rate the weapon does not have is a bug this project has
 * already shipped once, and reading resolved stats rather than recomputing them is
 * how it stays fixed.
 */
export type ResolvedStats = Readonly<Record<string, number>>
