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
 *
 * ## Routes are a SECOND, INDEPENDENT preference — deliberately
 *
 * A five-sector run opens a `'route'` card at every seam: option 0 is always the
 * free direct approach, and the rest trade a sector-long hazard for a reward. That
 * is a risk appetite, and risk appetite is not the same axis as item preference —
 * so it is chosen by `chooseRoute` and a per-policy `RouteStyle`, and `chooseOffer`
 * is untouched.
 *
 * Keeping them separate is not tidiness, it is the measurement. Item pick rates
 * were swept over 2,000 runs and sit in a documented band; folding route scoring
 * into the item heuristic would have moved every one of those numbers for a reason
 * that has nothing to do with items. `random` even draws its route rolls from a
 * *third* stream (`bot:random-route`) so that the number of seams a run reaches
 * cannot shift a single one of its item draws.
 *
 * Route preference varying by policy is itself an instrument: `greedy` accepts
 * every hazard it is paid for and `dodger` never does, so the gap between them is
 * the measured price of the world map. `aggressor` is deliberately held at
 * `direct` — it is the policy the clear-rate exit criterion is read off, and a
 * benchmark that also takes optional risk is measuring two things at once.
 */

import type { Axis, InputSnapshot } from '../core/input'
import { NEUTRAL_INPUT } from '../core/input'
import { Rng } from '../core/rng'
import { Playfield } from '../core/space'
import type { EnemyBullet, EnemyInstance, PendingChoice, RouteOption, WorldView } from './entities'

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
  /**
   * How this probe treats the world map by default. See `RouteStyle`.
   *
   * Declared on the def rather than buried in the closure so a sweep can print it:
   * a clear-rate table where one policy silently accepts hazards and another does
   * not is unreadable unless the report says which is which.
   */
  readonly routeStyle: RouteStyle
  /** Fresh policy instance for one run. Per-run state lives in the closure. */
  create(seed: string, options?: BotOptions): BotPolicy
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
 * silent — the sim's `CHOICE_TIMEOUT_TICKS` backstop is 1,200 ticks (20 seconds),
 * and a policy that quietly leans on it adds twenty seconds of dead sim time per
 * choice and corrupts every survival number in the report. That is not
 * hypothetical: it happened, at 1,201 ticks a seam, for as long as `ChoiceResolver`
 * only reset on a null gap. See `ChoiceResolver.cardOpenTicks`.
 */
export const MAX_CHOICE_RESOLUTION_TICKS = 6

/**
 * How a policy treats the world map between sectors.
 *
 *   direct    — always the free approach. No hazard, no bonus, no confound.
 *   rewarding — take the best-paying hazard route. The risk appetite probe.
 *   item-only — accept a hazard only for an *item*; decline scrap and repair.
 *   random    — uniform over the options. The control.
 */
export type RouteStyle = 'direct' | 'rewarding' | 'item-only' | 'random'

/**
 * What one free item is worth to a `rewarding` policy, in route-score units.
 *
 * The other rewards are scaled so the comparison is legible rather than tuned:
 * scrap is worth its face value over `ROUTE_SCRAP_UNIT`, and repair is worth the
 * integrity it would *actually* restore over `ROUTE_REPAIR_UNIT`. At the shipped
 * numbers (70-290 scrap, ~35% of maximum integrity) an item outscores a scrap
 * payout until the last seam and outscores a repair on a healthy hull always,
 * which is the ordering a player who is building a run would use.
 *
 * These are the PROBE'S STATED PREFERENCE, not a claim about which route is
 * correct. `chooseRoute` is where you change the question a sweep is asking.
 */
const ROUTE_ITEM_SCORE = 2.5
const ROUTE_SCRAP_UNIT = 100
const ROUTE_REPAIR_UNIT = 20

/**
 * What a route is worth to this policy, right now. Zero means "not worth a hazard".
 *
 * Repair is scored against the damage the hull has actually taken, because a full
 * repair on a full hull is worth nothing and a bot that took a hazard for it would
 * make the world map look more attractive than it is. That reading is available
 * from `WorldView.hull` alone — no content table involved.
 */
function routeScore(view: WorldView, route: RouteOption, style: RouteStyle): number {
  const reward = route.reward
  switch (reward.kind) {
    case 'none':
      return 0
    case 'item':
      return style === 'item-only' ? 1 : ROUTE_ITEM_SCORE
    case 'scrap':
      return style === 'item-only' ? 0 : reward.amount / ROUTE_SCRAP_UNIT
    case 'repair': {
      if (style === 'item-only') return 0
      const missing = Math.max(0, view.hull.maxIntegrity - view.hull.integrity)
      return Math.min(reward.amount, missing) / ROUTE_REPAIR_UNIT
    }
  }
}

/**
 * Which approach into the next sector to take. Never null — the run must go on.
 *
 * Index 0 is always the free direct approach (`buildRoutes` guarantees it and
 * `tests/run.test.ts` asserts it), so falling back to 0 is the safe answer for
 * every degenerate case: an empty card, a style with no appetite, a tie. That is
 * also what the sim does when a route card is declined, so a policy that cannot
 * decide behaves identically to one that walked away.
 */
function chooseRoute(
  view: WorldView,
  choice: Readonly<PendingChoice>,
  style: RouteStyle,
  rng: Rng | null,
): number | null {
  const count = choice.routes.length
  if (count === 0) return null
  if (style === 'random') return rng === null ? 0 : rng.int(count)
  if (style === 'direct') return 0

  let bestIndex = 0
  let bestScore = 0
  for (let i = 0; i < count; i++) {
    const route = choice.routes[i]
    if (route === undefined) continue
    const score = routeScore(view, route, style)
    // Strictly greater, so a tie keeps the earlier (and therefore safer) option and
    // the tie-break is stated rather than dependent on array order.
    if (score > bestScore) {
      bestScore = score
      bestIndex = i
    }
  }
  return bestIndex
}

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

/**
 * How many options this card has, which is what the cursor wraps on.
 *
 * MUST mirror `World.updateChoice`. It got out of step once: this returned
 * `offers.length` for every non-work-order kind, and a route card carries its
 * options in `routes` with `offers` empty — so every policy saw a zero-option
 * screen, took the skip branch, and the sim resolved the skip as "take the direct
 * approach". Nothing stalled and nothing crashed; the world map simply never
 * happened, in every run, for every policy, silently.
 */
function optionCountOf(choice: Readonly<PendingChoice>): number {
  if (choice.kind === 'work-order') return choice.workOrders.length
  if (choice.kind === 'route') return choice.routes.length
  return choice.offers.length
}

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
 * How long the open card has been open, as the sim counts it, or null if it will
 * not say.
 *
 * `ChoiceCursor.openTicks` is not on `WorldView`, but `choiceResolve` is a
 * countdown derived from it, so the elapsed half is recoverable: a card resets its
 * cursor when it opens, which resets this to 0 and makes it the one observable
 * signal that says "this is a DIFFERENT card from the one you were scripting".
 *
 * Both branches of the `World.choiceResolve` getter are counting the same
 * `openTicks` — the dwell while the trigger has not been released, the timeout once
 * it has — so the difference is correct across the switch between them, which
 * happens on the second tick of every card a bot resolves.
 *
 * Null for a fabricated view that carries a card without a countdown (the test
 * fixtures do this deliberately). A static fixture cannot chain, so the fallback is
 * simply "the card I already have".
 *
 * Exported because `tools/playtest.ts` and `tests/bots.test.ts` need the same
 * question answered — "is this the card I was already watching?" — and two copies of
 * this arithmetic would be two chances for one of them to drift. An observer that
 * cannot see a chained card counts a seam's three cards as one, which is how the
 * 1,200-tick stalls above stayed out of every report.
 */
export function choiceOpenTicks(view: WorldView): number | null {
  const resolve = view.choiceResolve
  if (resolve === null) return null
  return resolve.totalTicks - resolve.ticksRemaining
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
 *
 * ## WHAT COUNTS AS A NEW CARD, and why it is not "pendingChoice became null"
 *
 * It was, and that was wrong for every card after the first. `advanceTransition`
 * opens the next card in the *same tick* the previous one confirms — route, then the
 * transit item the route paid for, then the transit shop — so at a seam there is
 * never a null gap to reset on. The consequence was silent and total: the second and
 * third cards of every seam fell through to the retry branch, which navigates
 * nothing and repeats the previous card's action, so `chooseOffer` was never
 * consulted at a seam and the pick was whatever index 0 happened to be. When index 0
 * was unaffordable the world refused it, the branch re-confirmed, and the card sat
 * there for the full 1,200-tick timeout: measured at 7-9 stalls per 100 five-sector
 * runs before the fix, ~8,400 dead ticks per 100 runs.
 *
 * So the reset condition is the sim's own per-card tick counter going backwards.
 * That is exact rather than heuristic — the sim builds a fresh `ChoiceCursor` for
 * every card, and within one card the count rises by exactly one per unfrozen tick,
 * which is exactly the set of ticks this method scripts.
 */
class ChoiceResolver {
  private queue: InputSnapshot[] = []
  private open = false
  /**
   * The sim's `openTicks` for the card being scripted, as last observed. -1 when
   * no card is open.
   *
   * Compared rather than trusted: a drop means the sim swapped the card underneath
   * this resolver, which is what a seam does three times in three ticks.
   */
  private cardOpenTicks = -1
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
      this.cardOpenTicks = -1
      return null
    }

    // A frozen tick is discarded by the sim before it reaches the choice, so the
    // script must not advance or a press would be eaten and the cursor would end
    // up somewhere this class does not think it is. `freezeTicks` is read before
    // the sim decrements it, so this is exactly the set of ticks that get skipped.
    // It also means `openTicks` does not move on a frozen tick, which is why the
    // comparison below only ever sees ticks the sim actually counted.
    if (view.freezeTicks > 0) return NEUTRAL_INPUT

    const openTicks = choiceOpenTicks(view)
    // A card is new when this resolver has none, or when the sim's per-card counter
    // failed to advance — which is a card swap, not a slow tick.
    const fresh = !this.open || (openTicks !== null && openTicks <= this.cardOpenTicks)
    this.cardOpenTicks = openTicks ?? this.cardOpenTicks + 1

    if (fresh) {
      this.open = true
      this.queue.length = 0
      const count = optionCountOf(choice)
      if (count === 0) {
        // Zero options cannot be confirmed at all — the sim requires
        // `optionCount > 0` — so the only exit is a skip. Without this branch the
        // run sits on an empty screen until the 20-second timeout fires.
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
    // sim's 20-second backstop: acting on the wrong cursor position is one skewed
    // row in a pick table, and a timeout skews every survival number in the sweep.
    this.queue = [this.action]
    return NEUTRAL_INPUT
  }
}

// ---------------------------------------------------------------------------
// policies
// ---------------------------------------------------------------------------

/**
 * The route stream a policy rolls on, but ONLY when it has been asked to roll.
 *
 * `--route-style=random` silently did nothing. Every policy except `random` passed
 * `null` as its route Rng, and `chooseRoute`'s degenerate fallback for a missing Rng
 * is index 0 — which is the direct approach — so an ablation sweep at
 * `--route-style=random` produced a run byte-identical to `direct` while the report
 * printed "route random" beside it. Measured: aggressor at `random` and at `direct`
 * both clear 26.5% / 36.5% on the same two base seeds, to the run.
 *
 * Its own named stream per CLAUDE.md contract 1, and constructed only for the style
 * that consumes it, so the four shipped defaults draw exactly what they drew before
 * and every recorded number stays comparable. `random`'s own `bot:random-route`
 * stream is deliberately left alone for the same reason.
 */
function routeStreamFor(seed: string, style: RouteStyle): Rng | null {
  return style === 'random' ? Rng.fromSeed(seed, 'bot:route') : null
}

/**
 * Per-run knobs a sweep may override.
 *
 * `routeStyle` exists so the world map can be ABLATED: running one policy at
 * `direct` and again at `rewarding` on the same seeds isolates what accepting
 * hazards costs, which a comparison between two different policies cannot do
 * because they also fly differently. Everything else about a policy stays fixed.
 */
export interface BotOptions {
  readonly routeStyle?: RouteStyle
}

/**
 * One selector for every card kind a run can open.
 *
 * Routes and items are scored by separate functions on purpose — see this file's
 * header. This only routes the card to the right one.
 */
function selectorFor(
  view: WorldView,
  style: SelectionStyle,
  routeStyle: RouteStyle,
  offerRng: Rng | null,
  routeRng: Rng | null,
  targets: readonly string[],
): (choice: Readonly<PendingChoice>) => number | null {
  return (choice) =>
    choice.kind === 'route'
      ? chooseRoute(view, choice, routeStyle, routeRng)
      : chooseOffer(view, choice, style, offerRng, targets)
}

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
function dodgerPolicy(seed: string, routeStyle: RouteStyle): BotPolicy {
  const resolver = new ChoiceResolver()
  const routeRng = routeStreamFor(seed, routeStyle)
  return (view) => {
    const choosing = resolver.next(
      view,
      selectorFor(view, 'synergy', routeStyle, null, routeRng, BUILD_FOCUSED_TARGET),
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
function aggressorPolicy(seed: string, routeStyle: RouteStyle): BotPolicy {
  const resolver = new ChoiceResolver()
  const routeRng = routeStreamFor(seed, routeStyle)
  return (view) => {
    const choosing = resolver.next(
      view,
      selectorFor(view, 'synergy', routeStyle, null, routeRng, BUILD_FOCUSED_TARGET),
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
function greedyPolicy(seed: string, routeStyle: RouteStyle): BotPolicy {
  const resolver = new ChoiceResolver()
  const routeRng = routeStreamFor(seed, routeStyle)
  return (view) => {
    const choosing = resolver.next(
      view,
      selectorFor(view, 'expensive', routeStyle, null, routeRng, BUILD_FOCUSED_TARGET),
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
function randomPolicy(seed: string, routeStyle: RouteStyle): BotPolicy {
  // Its own named stream. Sharing 'spawn' would consume draws the spawner needs
  // and make every wave in a bot run different from the same seed played by hand.
  const rng = Rng.fromSeed(seed, 'bot:random')
  const choiceRng = Rng.fromSeed(seed, 'bot:random-choice')
  // A THIRD stream, for the same reason `choiceRng` is a second one. Rolling a
  // route off `bot:random-choice` would mean the number of seams a run reached
  // shifted every subsequent item draw, and this policy's measured pick rates
  // would stop being comparable with the M3 sweep for a reason unrelated to items.
  const routeRng = Rng.fromSeed(seed, 'bot:random-route')
  const resolver = new ChoiceResolver()
  let held: InputSnapshot = NEUTRAL_INPUT
  let ticksHeld = 0
  return (view) => {
    const choosing = resolver.next(
      view,
      selectorFor(view, 'random', routeStyle, choiceRng, routeRng, BUILD_FOCUSED_TARGET),
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
function buildFocusedPolicy(
  seed: string,
  targets: readonly string[] = BUILD_FOCUSED_TARGET,
  routeStyle: RouteStyle = 'item-only',
): BotPolicy {
  const resolver = new ChoiceResolver()
  const routeRng = routeStreamFor(seed, routeStyle)
  return (view) => {
    const choosing = resolver.next(
      view,
      selectorFor(view, 'build', routeStyle, null, routeRng, targets),
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
    routeStyle: 'direct',
    create: (seed, options) => dodgerPolicy(seed, options?.routeStyle ?? 'direct'),
  },
  aggressor: {
    name: 'aggressor',
    measures: 'clear-speed ceiling — aligns and fires constantly, takes stated synergies',
    // The clear-rate benchmark. Held at `direct` so the number the M5 exit criterion
    // is read off is not also a measurement of optional risk-taking.
    routeStyle: 'direct',
    create: (seed, options) => aggressorPolicy(seed, options?.routeStyle ?? 'direct'),
  },
  greedy: {
    name: 'greedy',
    measures:
      'difficulty curve under early engagement, whether the shop is affordable, and the price of the world map',
    // "Always takes the scrap and the risky route" — docs/VERIFICATION.md §2. The
    // route half of that sentence was unimplementable until the world map existed.
    routeStyle: 'rewarding',
    create: (seed, options) => greedyPolicy(seed, options?.routeStyle ?? 'rewarding'),
  },
  random: {
    name: 'random',
    measures: 'control — depth here means the curve is broken; uniform picks anchor the 1-in-3 baseline',
    routeStyle: 'random',
    create: (seed, options) => randomPolicy(seed, options?.routeStyle ?? 'random'),
  },
  'build-focused': {
    name: 'build-focused',
    measures: `strength of one named synergy — chases ${BUILD_FOCUSED_TARGET.join(' + ')}`,
    // Accepts a hazard for an item and for nothing else: extra item screens are the
    // only route reward that helps it assemble the pair it exists to measure, and
    // taking a hazard for scrap would add deaths that the build gets blamed for.
    routeStyle: 'item-only',
    create: (seed, options) =>
      buildFocusedPolicy(seed, BUILD_FOCUSED_TARGET, options?.routeStyle ?? 'item-only'),
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
export function createBuildFocused(
  targets: readonly string[],
  routeStyle: RouteStyle = 'item-only',
  seed = 'BU1LDF0CUSED',
): BotPolicy {
  return buildFocusedPolicy(seed, targets, routeStyle)
}

/** Every route style, so a sweep can enumerate them without hardcoding the list. */
export const ROUTE_STYLES = ['direct', 'rewarding', 'item-only', 'random'] as const

export function isRouteStyle(value: string): value is RouteStyle {
  return (ROUTE_STYLES as readonly string[]).includes(value)
}
