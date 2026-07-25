/**
 * Bot policies.
 *
 * These are not attempts at human play. They are instrumented probes, each
 * answering one question that intuition cannot (`docs/VERIFICATION.md` §2):
 *
 *   dodger     — how long does a run last if the pilot only evades?
 *   aggressor  — how fast can the sector be cleared by a pilot who ignores risk?
 *   greedy     — what happens to the difficulty curve when engagement starts early?
 *   random     — control. If this gets deep, the curve is not doing any work.
 *
 * Read together they bracket the design: dodger is the survivability floor,
 * aggressor the clear-speed ceiling, and the gap between them is the space a
 * human plays in. A change that moves one but not the other is the interesting
 * kind of change.
 *
 * ## Constraints
 *
 * A policy reads `WorldView` and nothing else. Not `World`, not content tables,
 * not the spawner — a bot that knew the wave script would measure the script
 * rather than the game, and would stop being a probe the moment content changed.
 * Everything below is derived from what a player can see on screen.
 *
 * Policies are deterministic. `dodger`, `aggressor`, and `greedy` are pure
 * functions of the view. `random` carries a seeded `Rng` and a hold counter, so
 * it too replays identically from the same seed — `Math.random()` would make its
 * findings unreproducible, which is the same as having no findings.
 */

import type { Axis, InputSnapshot } from '../core/input'
import { NEUTRAL_INPUT } from '../core/input'
import { Rng } from '../core/rng'
import { Playfield } from '../core/space'
import type { EnemyBullet, EnemyInstance, WorldView } from './entities'

/**
 * A little over one tick of hull travel at the M1 hull speed.
 *
 * Not a sim constant — bots may not import sim tuning — just a jitter guard.
 * Without a deadzone a bot chasing a target one unit away flips its input every
 * tick, which reads as a stationary ship in a replay and hides real movement.
 */
const MOVE_DEADZONE = 4

/**
 * How far ahead a bot looks for incoming fire, in seconds.
 *
 * 0.75s is roughly two hull-widths of travel time for a fast pellet. Looking
 * further ahead makes the bot react to shots that later miss anyway, and it ends
 * up dodging into things.
 */
const THREAT_HORIZON_SECONDS = 0.75

/** Extra lateral slack around the hitbox when deciding whether a shot threatens. */
const THREAT_LATERAL_MARGIN = 14

/** Below this much space on the escape side, dodge the other way instead. */
const DODGE_MIN_ROOM = 26

/** Fallback player-bullet speed for lead calculation, if none are in flight. */
const ASSUMED_BULLET_SPEED = 620

/** Where each policy prefers to sit vertically, as a fraction of playfield height. */
const DODGER_HOLD_Y = Playfield.h * 0.84
const AGGRESSOR_HOLD_Y = Playfield.h * 0.78
const GREEDY_HOLD_Y = Playfield.h * 0.32

export type BotName = 'dodger' | 'aggressor' | 'greedy' | 'random'

/** A policy is called once per tick with the current view. */
export type BotPolicy = (view: WorldView) => InputSnapshot

export interface BotDef {
  readonly name: BotName
  /** What this probe measures. Printed by the playtest runner. */
  readonly measures: string
  /** Fresh policy instance for one run. The seed only matters to `random`. */
  create(seed: string): BotPolicy
}

// ---------------------------------------------------------------------------
// shared perception
// ---------------------------------------------------------------------------

function axisToward(current: number, target: number): Axis {
  const delta = target - current
  if (delta > MOVE_DEADZONE) return 1
  if (delta < -MOVE_DEADZONE) return -1
  return 0
}

export interface Threat {
  readonly bullet: EnemyBullet
  /** Where the shot will cross the hull's row. */
  readonly impactX: number
  /** Seconds until it does. */
  readonly seconds: number
}

/**
 * The most urgent incoming shot, or null if nothing is on course.
 *
 * "On course" is deliberately narrow: descending, still above the hull, arriving
 * inside the horizon, and passing within a hitbox-plus-margin of where the hull
 * is now. A bot that treats every bullet on screen as a threat panics constantly
 * and its survival time measures the panic, not the pattern.
 */
export function nearestThreat(view: WorldView): Threat | null {
  const hull = view.hull
  let best: Threat | null = null
  for (const bullet of view.enemyBullets) {
    if (!bullet.alive) continue
    // Only descending shots can reach us. Upward or level strays are ignored:
    // reacting to them produces movement away from safety for no gain.
    if (bullet.vy <= 0) continue
    const dy = hull.y - bullet.y
    if (dy <= 0) continue // already past
    const seconds = dy / bullet.vy
    if (seconds > THREAT_HORIZON_SECONDS) continue
    const impactX = bullet.x + bullet.vx * seconds
    if (Math.abs(impactX - hull.x) > hull.radius + bullet.radius + THREAT_LATERAL_MARGIN) continue
    if (best === null || seconds < best.seconds) best = { bullet, impactX, seconds }
  }
  return best
}

/**
 * Nearest live enemy by squared distance.
 *
 * Squared, because a square root per enemy per tick across thousands of runs is
 * measurable and the ordering is identical.
 */
export function nearestEnemy(view: WorldView): EnemyInstance | null {
  const hull = view.hull
  let best: EnemyInstance | null = null
  let bestDistanceSq = Infinity
  for (const enemy of view.enemies) {
    if (!enemy.alive) continue
    const dx = enemy.x - hull.x
    const dy = enemy.y - hull.y
    const distanceSq = dx * dx + dy * dy
    if (distanceSq < bestDistanceSq) {
      bestDistanceSq = distanceSq
      best = enemy
    }
  }
  return best
}

/**
 * Player bullet speed, observed rather than assumed.
 *
 * A bot may not import weapon tuning, but it can watch its own shots — which
 * means the lead calculation keeps working when the weapon changes, instead of
 * silently aiming at where enemies used to be.
 */
function observedBulletSpeed(view: WorldView): number {
  for (const bullet of view.playerBullets) {
    if (bullet.alive && bullet.vy < 0) return -bullet.vy
  }
  return ASSUMED_BULLET_SPEED
}

/** Where to aim to hit a moving enemy with a shot fired now. */
function leadX(view: WorldView, enemy: EnemyInstance): number {
  const flightSeconds = Math.max(0, view.hull.y - enemy.y) / observedBulletSpeed(view)
  return enemy.x + enemy.vx * flightSeconds
}

/**
 * Which way to break, given where a shot will land.
 *
 * Away from the impact point, unless that direction runs out of playfield — a
 * bot pinned against a wall pressing into it is how a policy dies to a shot it
 * had already identified.
 */
function dodgeDirection(hullX: number, impactX: number): Axis {
  let direction: Axis = impactX >= hullX ? -1 : 1
  const room = direction < 0 ? hullX : Playfield.w - hullX
  if (room < DODGE_MIN_ROOM) direction = direction === -1 ? 1 : -1
  return direction
}

// ---------------------------------------------------------------------------
// policies
// ---------------------------------------------------------------------------

/**
 * Survival first. Establishes the floor.
 *
 * Two details that are load-bearing:
 *
 * - While dodging, `moveY` is forced to 0. The sim normalises diagonals, so any
 *   vertical component costs ~30% of lateral escape speed. A bot that drifts
 *   while dodging appears to be a worse dodger than it is.
 * - It fires when nothing is threatening it. A bot that never fires would stall
 *   against any spawner that waits for the field to clear, and its survival time
 *   would measure the wave script's timeout rather than survivability.
 */

/**
 * Choice handling, shared by every policy.
 *
 * Bots must resolve choices or the run stalls: confirming needs a *rising* fire
 * edge, and `aggressor` holds fire permanently, so it deadlocked its own runs at
 * the first reward screen until this existed. The sim has a 60-second timeout as a
 * backstop, but relying on it would add a minute of dead time per choice and
 * corrupt every survival-time measurement.
 *
 * The alternating release/press is also how a *pick rate* becomes measurable at
 * all, which M3's exit criteria are written against.
 */
function choiceInput(view: WorldView, preferred: number): InputSnapshot | null {
  const choice = view.pendingChoice
  if (!choice) return null

  const count = choice.kind === 'work-order' ? choice.workOrders.length : choice.offers.length
  if (count === 0) return NEUTRAL_INPUT

  const target = ((preferred % count) + count) % count
  // Release on odd ticks so the next tick is a rising edge. Without the release
  // there is no edge and the choice never resolves.
  const release = view.stats.tick % 2 === 0
  if (release) return NEUTRAL_INPUT

  // Affordability: a bot must not sit pressing an option it cannot buy, which the
  // sim correctly refuses — that would look like a stall in the survival numbers.
  const cost = choice.costs[target] ?? 0
  if (cost > view.stats.scrap) {
    return { moveX: 0, moveY: 0, fire: false, special: true, focus: false }
  }
  return { moveX: 0, moveY: 0, fire: true, special: false, focus: false }
}

export const dodger: BotPolicy = (view) => {
  const choosing = choiceInput(view, 0)
  if (choosing) return choosing

  const hull = view.hull
  const threat = nearestThreat(view)
  if (threat !== null) {
    return {
      moveX: dodgeDirection(hull.x, threat.impactX),
      moveY: 0,
      fire: false,
      special: false,
      focus: false,
    }
  }
  return {
    moveX: axisToward(hull.x, Playfield.centerX),
    moveY: axisToward(hull.y, DODGER_HOLD_Y),
    fire: true,
    special: false,
    focus: false,
  }
}

/**
 * Damage first. Establishes the ceiling.
 *
 * Aligns with the nearest enemy, leads its movement, holds fire permanently, and
 * never evades. Its death rate is the price of ignoring incoming fire, and the
 * gap between its clear speed and dodger's is the difficulty budget.
 */
export const aggressor: BotPolicy = (view) => {
  const choosing = choiceInput(view, 1)
  if (choosing) return choosing

  const hull = view.hull
  const enemy = nearestEnemy(view)
  const targetX = enemy === null ? Playfield.centerX : leadX(view, enemy)
  return {
    moveX: axisToward(hull.x, targetX),
    moveY: axisToward(hull.y, AGGRESSOR_HOLD_Y),
    fire: true,
    special: false,
    focus: false,
  }
}

/**
 * Aggressor that pushes into the upper half to engage sooner.
 *
 * This is the difficulty-curve stress test. Meeting waves early means meeting
 * them before they have spread out, at close range where aimed fire is nearly
 * unavoidable — so if the curve depends on enemies being fought at a comfortable
 * distance, greedy is where that shows up.
 */
export const greedy: BotPolicy = (view) => {
  const choosing = choiceInput(view, 2)
  if (choosing) return choosing

  const hull = view.hull
  const enemy = nearestEnemy(view)
  const targetX = enemy === null ? Playfield.centerX : leadX(view, enemy)
  return {
    moveX: axisToward(hull.x, targetX),
    moveY: axisToward(hull.y, GREEDY_HOLD_Y),
    fire: true,
    special: false,
    focus: false,
  }
}

/**
 * The control, and the only policy that exercises `focus` and `special`.
 *
 * Inputs are held for a random stretch rather than rerolled every tick. Per-tick
 * rerolling is a zero-mean random walk: the ship vibrates around its spawn point
 * and never encounters most of the playfield, so the control ends up measuring
 * nothing. Holding for 4-24 ticks produces actual traversal, which is what makes
 * "random reached wave 6" a meaningful alarm.
 */
function randomPolicy(seed: string): BotPolicy {
  // Its own named stream. Sharing 'spawn' would consume draws the spawner needs
  // and make every wave in a bot run different from the same seed played by hand.
  const rng = Rng.fromSeed(seed, 'bot:random')
  let held: InputSnapshot = NEUTRAL_INPUT
  let ticksHeld = 0
  return (view) => {
    const choosing = choiceInput(view, rng.int(3))
    if (choosing) return choosing
    if (ticksHeld <= 0) {
      held = {
        moveX: (rng.int(3) - 1) as Axis,
        moveY: (rng.int(3) - 1) as Axis,
        fire: rng.chance(0.6),
        special: rng.chance(0.05),
        focus: rng.chance(0.12),
      }
      ticksHeld = rng.intBetween(4, 24)
    }
    ticksHeld--
    return held
  }
}

export const BOTS: Readonly<Record<BotName, BotDef>> = {
  dodger: {
    name: 'dodger',
    measures: 'survivability floor — evades, fires only when unthreatened',
    create: () => dodger,
  },
  aggressor: {
    name: 'aggressor',
    measures: 'clear-speed ceiling — aligns and fires constantly, never evades',
    create: () => aggressor,
  },
  greedy: {
    name: 'greedy',
    measures: 'difficulty curve under early engagement — pushes to the upper half',
    create: () => greedy,
  },
  random: {
    name: 'random',
    measures: 'control — depth here means the curve is broken',
    create: (seed) => randomPolicy(seed),
  },
}

export const BOT_NAMES = ['dodger', 'aggressor', 'greedy', 'random'] as const

export function isBotName(value: string): value is BotName {
  return (BOT_NAMES as readonly string[]).includes(value)
}
