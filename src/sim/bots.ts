/**
 * Bot policies.
 *
 * These are not attempts at human play. They are instrumented probes, each
 * answering one question that intuition cannot (`docs/VERIFICATION.md` §2):
 *
 *   dodger        — how long does a run last if the pilot only evades?
 *   aggressor     — how fast can the sector be cleared by a pilot who ignores risk?
 *   greedy        — what happens to the difficulty curve when engagement starts early?
 *   random        — control. If this gets deep, the curve is not doing any work.
 *   build-focused — how strong is one *named* synergy, measured rather than claimed?
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
 * Policies are deterministic. Every one of them is a closure over per-run state
 * that is created fresh by `BotDef.create`, and the only randomness is a seeded
 * `Rng` — `Math.random()` would make a finding unreproducible, which is the same
 * as having no finding.
 *
 * ## Choosing items is a measurement, not a formality
 *
 * M3's exit criteria are pick rates, and a pick rate only exists if the bots have
 * *preferences*. Before this file grew `chooseOffer`, every policy confirmed
 * whichever option the cursor happened to start on (the old `preferred` argument
 * was never navigated to — no policy ever pressed left or right), so a sweep
 * measured the offer RNG and told you nothing about any item.
 *
 * WHAT THE VIEW WILL NOT TELL A BOT: `ItemOffer` carries a `defId` and
 * `interactionText`, and nothing else. **There is no tier, no tag, and no
 * mechanism text.** So:
 *
 * - "prefer a stated synergy" is expressible, and is the strongest signal
 *   available — `interactionText` is non-empty exactly when taking the item
 *   would activate a declared interaction with the build already held.
 * - "prefer by tier" is expressible **only in a shop**, where
 *   `PendingChoice.costs` is tier-scaled and therefore a faithful ordinal proxy
 *   for tier. On a free item choice every cost is 0 and tier is simply not
 *   observable. See `costScore` — and see the report accompanying this change for
 *   the recommendation to put `tier` on `ItemOffer`.
 * - "prefer a defensive item" is NOT expressible at all: tags never reach the
 *   view. That is why `dodger` shares the aggressive policies' heuristic instead
 *   of having a survival-flavoured one, and why the roster's `defence` items are
 *   currently only ever picked for their synergies or their price.
 */

import type { Axis, InputSnapshot } from '../core/input'
import { NEUTRAL_INPUT } from '../core/input'
import { Rng } from '../core/rng'
import { Playfield } from '../core/space'
import type { EnemyBullet, EnemyInstance, PendingChoice, WorldView } from './entities'

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
/**
 * Between dodger's and aggressor's. `build-focused` must be a *competent* pilot
 * or its numbers measure the pilot rather than the build, which is the one thing
 * it exists to isolate.
 */
const BUILD_FOCUSED_HOLD_Y = Playfield.h * 0.8

export type BotName = 'dodger' | 'aggressor' | 'greedy' | 'random' | 'build-focused'

/** A policy is called once per tick with the current view. */
export type BotPolicy = (view: WorldView) => InputSnapshot

export interface BotDef {
  readonly name: BotName
  /** What this probe measures. Printed by the playtest runner. */
  readonly measures: string
  /** Fresh policy instance for one run. Per-run state lives in the closure. */
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
// choices — selection
// ---------------------------------------------------------------------------

/**
 * How a policy ranks the options on a choice screen.
 *
 *   synergy   — take a stated interaction, then a new item, then the dearest.
 *   expensive — take the dearest affordable option. The economy stress test:
 *               scrap that is never spent is a score, not an economy.
 *   build     — take a named target build's items; fall back to `synergy`.
 *   random    — uniform over the options on offer. The control that anchors the
 *               1-in-3 baseline every other policy's pick rate is read against.
 */
export type SelectionStyle = 'synergy' | 'expensive' | 'build' | 'random'

/**
 * The build `build-focused` chases, as item ids.
 *
 * These two ids form `warhead-fragments` in `src/content/interactions.ts`, chosen
 * because it is the highest-weight declared pair in the roster (split-shot 8,
 * warheads 5 out of 97 total weight) and therefore the one a sweep can actually
 * assemble often enough to measure.
 *
 * Naming content ids here is the one coupling this probe cannot avoid: a
 * build-focused bot has to name a build. It stays honest because the ids are
 * *data the sweep prints* rather than a table this file imports — if an id stops
 * existing, the sweep reports the target as never offered and never acquired,
 * which is a visible failure rather than a probe that silently measures nothing.
 */
export const BUILD_FOCUSED_TARGET: readonly string[] = ['split-shot', 'warheads']

/**
 * Ticks the scripted resolution of one choice can take, worst case.
 *
 * One release tick, then up to two navigation press/release pairs for a
 * three-option screen, then the confirm: 1 + 4 + 1 = 6. Asserted in
 * `tests/bots.test.ts` against a real run, because the alternative failure mode is
 * silent — the sim's `CHOICE_TIMEOUT_TICKS` backstop is 3,600 ticks, and a policy
 * that quietly leans on it adds a minute of dead sim time per choice and corrupts
 * every survival number in the report.
 */
export const MAX_CHOICE_RESOLUTION_TICKS = 6

/**
 * Cost as a tie-break score, in the range [0, 1).
 *
 * Costs are tier-scaled in a shop and zero on a free item choice, so this is a
 * tier preference where tier is observable and a no-op where it is not. Divided
 * down so it can only ever break a tie between options that scored equally on
 * everything a bot *can* see — see this file's header on what the view withholds.
 */
function costScore(cost: number): number {
  return cost / (cost + 1000)
}

/** Ids currently held, for "is this new to me". */
function heldIds(view: WorldView): ReadonlySet<string> {
  const out = new Set<string>()
  for (const entry of view.inventory) out.add(entry.defId)
  return out
}

/**
 * Which option to take, or null to decline.
 *
 * Declining is a real outcome, not an error: a shop where nothing is affordable
 * must be walked away from, and the sim refuses an unaffordable confirm anyway.
 * The sweep counts these, because an economy in which every option is always
 * declined is not an economy.
 *
 * Ties resolve to the lowest index. That is arbitrary but it must be *stated* —
 * an unstable tie-break would make a pick rate depend on array order and quietly
 * unreproducible.
 */
function chooseOffer(
  view: WorldView,
  choice: Readonly<PendingChoice>,
  style: SelectionStyle,
  rng: Rng | null,
  targets: readonly string[],
): number | null {
  // Work orders expose nothing but a label, so no policy can have a preference
  // among them. `random` rolls; everyone else takes the first. Stated rather than
  // dressed up, because the sim currently applies no work-order effect either.
  if (choice.kind === 'work-order') {
    const count = choice.workOrders.length
    if (count === 0) return null
    return rng === null ? 0 : rng.int(count)
  }

  const count = choice.offers.length
  if (count === 0) return null

  const affordable: number[] = []
  for (let i = 0; i < count; i++) {
    if ((choice.costs[i] ?? 0) <= view.stats.scrap) affordable.push(i)
  }

  if (style === 'random') {
    // Deliberately rolls over *all* options and then declines if the roll landed
    // on something unaffordable, rather than rolling over the affordable subset.
    // The control has to be able to walk away from a shop, or it stops being a
    // control and starts being a shopper.
    if (rng === null) return null
    const index = rng.int(count)
    return (choice.costs[index] ?? 0) <= view.stats.scrap ? index : null
  }

  if (affordable.length === 0) return null

  const held = heldIds(view)
  let bestIndex = -1
  let bestScore = -Infinity
  for (const index of affordable) {
    const offer = choice.offers[index]
    if (offer === undefined) continue
    const synergies = offer.interactionText.length
    const novel = held.has(offer.defId) ? 0 : 1
    const cost = choice.costs[index] ?? 0

    // Weights are separated by an order of magnitude each so the ordering is a
    // strict priority list rather than a blend: one stated synergy always beats
    // any number of "it is new", which always beats any price difference.
    let score: number
    if (style === 'expensive') {
      // Price first, on purpose. This is the probe that answers "can the shop be
      // used at all", so it buys the dearest thing it can and lets the synergy
      // score break ties — including on a free choice, where every cost is 0 and
      // this collapses to the synergy ordering.
      score = cost * 10 + synergies * 2 + novel
    } else {
      const targeted = style === 'build' && targets.includes(offer.defId) && novel === 1 ? 1 : 0
      score = targeted * 1000 + synergies * 100 + novel * 10 + costScore(cost)
    }

    if (score > bestScore) {
      bestScore = score
      bestIndex = index
    }
  }
  return bestIndex < 0 ? null : bestIndex
}

// ---------------------------------------------------------------------------
// choices — resolution
// ---------------------------------------------------------------------------

const PRESS_RIGHT: InputSnapshot = { moveX: 1, moveY: 0, fire: false, special: false, focus: false }
const PRESS_FIRE: InputSnapshot = { moveX: 0, moveY: 0, fire: true, special: false, focus: false }
const PRESS_SKIP: InputSnapshot = { moveX: 0, moveY: 0, fire: false, special: true, focus: false }

/**
 * The exact input sequence that moves the cursor `steps` right and then acts.
 *
 * Every press is preceded by a neutral tick because `updateCursor` requires a
 * *rising* edge on each button — it starts every choice with all buttons
 * considered already-held so a player holding the trigger cannot skip the reward
 * screen before reading it. A bot that just holds fire therefore resolves
 * nothing, which is exactly how `aggressor` used to deadlock its own runs.
 */
function scriptFor(steps: number, confirm: boolean): InputSnapshot[] {
  const out: InputSnapshot[] = [NEUTRAL_INPUT]
  for (let i = 0; i < steps; i++) {
    out.push(PRESS_RIGHT)
    out.push(NEUTRAL_INPUT)
  }
  out.push(confirm ? PRESS_FIRE : PRESS_SKIP)
  return out
}

/**
 * Drives one choice screen to a decision.
 *
 * The cursor lives inside the sim and is not on `WorldView`, so this mirrors it
 * rather than reading it: the cursor starts at 0 on every choice, and one rising
 * right-edge moves it one place. That is a small amount of duplicated knowledge,
 * and the guard against it drifting is the queue-exhaustion branch below plus the
 * measured `maxChoiceTicks` the sweep prints — if the mirror is ever wrong, a
 * choice takes longer than `MAX_CHOICE_RESOLUTION_TICKS` and the report says so.
 */
class ChoiceResolver {
  private queue: InputSnapshot[] = []
  private open = false
  /**
   * The action this screen was resolved with, for the retry branch.
   *
   * Kept so a retry repeats the *decision* rather than always confirming: a policy
   * that decided to decline an unaffordable shop must not end up mashing fire at
   * it, which the sim would refuse anyway and which reads in a log as a bot that
   * cannot tell what it can afford.
   */
  private action: InputSnapshot = PRESS_FIRE

  /** The input for this tick, or null when no choice is open. */
  next(view: WorldView, select: (choice: Readonly<PendingChoice>) => number | null): InputSnapshot | null {
    const choice = view.pendingChoice
    if (choice === null) {
      this.open = false
      this.queue.length = 0
      return null
    }

    // A frozen tick is discarded by the sim before it reaches the choice, so the
    // script must not advance or a press would be eaten and the cursor would end
    // up somewhere this class does not think it is. `freezeTicks` is read before
    // the sim decrements it, so this is exactly the set of ticks that get skipped.
    if (view.freezeTicks > 0) return NEUTRAL_INPUT

    if (!this.open) {
      this.open = true
      const count = choice.kind === 'work-order' ? choice.workOrders.length : choice.offers.length
      if (count === 0) {
        // Zero options cannot be confirmed at all — the sim requires
        // `optionCount > 0` — so the only exit is a skip. Without this branch the
        // run sits on an empty screen until the 60-second timeout fires.
        this.queue = scriptFor(0, false)
        this.action = PRESS_SKIP
      } else {
        const target = select(choice)
        const confirm = target !== null
        this.queue = scriptFor(confirm ? ((target % count) + count) % count : 0, confirm)
        this.action = confirm ? PRESS_FIRE : PRESS_SKIP
      }
    }

    const next = this.queue.shift()
    if (next !== undefined) return next

    // The script ran out with the choice still open, so an input this class
    // expected to land did not. Repeat the decision rather than waiting out the
    // sim's 60-second backstop: acting on the wrong cursor position is one skewed
    // row in a pick table, and a timeout skews every survival number in the sweep.
    this.queue = [this.action]
    return NEUTRAL_INPUT
  }
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
 *
 * Its item selection is the same synergy-first heuristic the aggressive policies
 * use, because a survival-flavoured one is not expressible: `ItemOffer` carries no
 * tags, so nothing in the view distinguishes Plating Shim from Machined Slugs.
 */
function dodgerPolicy(): BotPolicy {
  const resolver = new ChoiceResolver()
  return (view) => {
    const choosing = resolver.next(view, (choice) =>
      chooseOffer(view, choice, 'synergy', null, BUILD_FOCUSED_TARGET),
    )
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
}

/**
 * Damage first. Establishes the ceiling.
 *
 * Aligns with the nearest enemy, leads its movement, holds fire permanently, and
 * never evades. Its death rate is the price of ignoring incoming fire, and the
 * gap between its clear speed and dodger's is the difficulty budget.
 */
function aggressorPolicy(): BotPolicy {
  const resolver = new ChoiceResolver()
  return (view) => {
    const choosing = resolver.next(view, (choice) =>
      chooseOffer(view, choice, 'synergy', null, BUILD_FOCUSED_TARGET),
    )
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
}

/**
 * Aggressor that pushes into the upper half to engage sooner, and spends.
 *
 * This is the difficulty-curve stress test. Meeting waves early means meeting
 * them before they have spread out, at close range where aimed fire is nearly
 * unavoidable — so if the curve depends on enemies being fought at a comfortable
 * distance, greedy is where that shows up.
 *
 * It is also the *economy* stress test, which is why it buys the dearest option
 * it can afford rather than the best one: the question it answers is whether the
 * shop's prices are reachable at all from the scrap the sector pays.
 */
function greedyPolicy(): BotPolicy {
  const resolver = new ChoiceResolver()
  return (view) => {
    const choosing = resolver.next(view, (choice) =>
      chooseOffer(view, choice, 'expensive', null, BUILD_FOCUSED_TARGET),
    )
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
}

/**
 * The control, and the only policy that exercises `focus`.
 *
 * Inputs are held for a random stretch rather than rerolled every tick. Per-tick
 * rerolling is a zero-mean random walk: the ship vibrates around its spawn point
 * and never encounters most of the playfield, so the control ends up measuring
 * nothing. Holding for 4-24 ticks produces actual traversal, which is what makes
 * "random reached wave 6" a meaningful alarm.
 *
 * Its choice rolls come from a SECOND stream. Sharing one stream would mean the
 * number of choices a run happened to reach shifted every subsequent movement
 * draw, so `random`'s survival numbers would stop being comparable with the M1
 * and M2 sweeps for a reason that has nothing to do with the game.
 */
function randomPolicy(seed: string): BotPolicy {
  // Its own named stream. Sharing 'spawn' would consume draws the spawner needs
  // and make every wave in a bot run different from the same seed played by hand.
  const rng = Rng.fromSeed(seed, 'bot:random')
  const choiceRng = Rng.fromSeed(seed, 'bot:random-choice')
  const resolver = new ChoiceResolver()
  let held: InputSnapshot = NEUTRAL_INPUT
  let ticksHeld = 0
  return (view) => {
    const choosing = resolver.next(view, (choice) =>
      chooseOffer(view, choice, 'random', choiceRng, BUILD_FOCUSED_TARGET),
    )
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

/**
 * Chases one named build so a specific synergy's strength can be measured.
 *
 * `docs/VERIFICATION.md` §2 has listed this probe since M1 and it did not exist:
 * without it, "Warheads plus Split Shot is strong" is a claim about a data file.
 * With it, the sweep can partition runs by whether the interaction was actually
 * live at the end and report the survival and clear-rate *delta* — which is a
 * measurement, and is allowed to come out negative.
 *
 * Flight is a deliberate hybrid: it dodges like `dodger` but keeps firing while
 * it does, and it aligns on targets like `aggressor`. A probe measuring an item
 * build must not be so bad at flying that the build's contribution disappears
 * into its death rate.
 */
function buildFocusedPolicy(targets: readonly string[] = BUILD_FOCUSED_TARGET): BotPolicy {
  const resolver = new ChoiceResolver()
  return (view) => {
    const choosing = resolver.next(view, (choice) =>
      chooseOffer(view, choice, 'build', null, targets),
    )
    if (choosing) return choosing

    const hull = view.hull
    const threat = nearestThreat(view)
    if (threat !== null) {
      return {
        moveX: dodgeDirection(hull.x, threat.impactX),
        moveY: 0,
        // Keeps firing through the dodge, unlike `dodger`. The build is the
        // subject of the measurement, so its damage output has to stay on.
        fire: true,
        special: false,
        focus: false,
      }
    }
    const enemy = nearestEnemy(view)
    const targetX = enemy === null ? Playfield.centerX : leadX(view, enemy)
    return {
      moveX: axisToward(hull.x, targetX),
      moveY: axisToward(hull.y, BUILD_FOCUSED_HOLD_Y),
      fire: true,
      special: false,
      focus: false,
    }
  }
}

export const BOTS: Readonly<Record<BotName, BotDef>> = {
  dodger: {
    name: 'dodger',
    measures: 'survivability floor — evades, fires only when unthreatened, takes stated synergies',
    create: () => dodgerPolicy(),
  },
  aggressor: {
    name: 'aggressor',
    measures: 'clear-speed ceiling — aligns and fires constantly, takes stated synergies',
    create: () => aggressorPolicy(),
  },
  greedy: {
    name: 'greedy',
    measures: 'difficulty curve under early engagement, and whether the shop is affordable at all',
    create: () => greedyPolicy(),
  },
  random: {
    name: 'random',
    measures: 'control — depth here means the curve is broken; uniform picks anchor the 1-in-3 baseline',
    create: (seed) => randomPolicy(seed),
  },
  'build-focused': {
    name: 'build-focused',
    measures: `strength of one named synergy — chases ${BUILD_FOCUSED_TARGET.join(' + ')}`,
    create: () => buildFocusedPolicy(),
  },
}

export const BOT_NAMES = ['dodger', 'aggressor', 'greedy', 'random', 'build-focused'] as const

export function isBotName(value: string): value is BotName {
  return (BOT_NAMES as readonly string[]).includes(value)
}

/**
 * Exported for tests only: a build-focused policy chasing an arbitrary pair.
 *
 * Lets `tests/bots.test.ts` prove the targeting works against fabricated items
 * rather than against whatever `src/content/items.ts` happens to hold, for the
 * same reason the combat tests fabricate enemy defs — a balance change must not
 * be able to break a bot test.
 */
export function createBuildFocused(targets: readonly string[]): BotPolicy {
  return buildFocusedPolicy(targets)
}
