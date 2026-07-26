/**
 * Sector hazards.
 *
 * A hazard is the sector's own character, separate from its enemies — the thing that
 * makes Bloomfield feel different from the Kill Grid even on a quiet stretch when
 * neither is shooting. Enemies arrive and are killed; a hazard is simply true for the
 * whole stage, and the pilot flies around it rather than through it.
 *
 * ## READ THIS FIRST: three of these descriptions used to be false
 *
 * The previous version of this file described hazards the simulation does not
 * implement, and said so out loud in its own header ("read that as a constraint on
 * the implementation, not a hint") while shipping the descriptions anyway.
 * `src/sim/world.ts` was then read line by line, and the gap is worse than the header
 * admitted. What the simulation actually does, per kind:
 *
 * - **corrosion** fires on a timer and calls `applyHullDamage(..., { bypassShield:
 *   true })`. It does not look at the hull's velocity, its position, or anything else.
 *   "Keep moving and nothing lands" was not true of a single tick of a single run.
 * - **debris** spawns five enemy bullets in a curtain. `resolvePlayerBulletHits`
 *   tests player bullets against **enemies only**, so debris cannot be shot, and
 *   nothing awards scrap for one. "It is still cargo: shoot it and it pays" was
 *   describing a mechanic that does not exist.
 * - **interdiction** applies `speedFactor()` and nothing else. `HazardDef.damage` is
 *   never read for this kind. The Interdiction Sweep's card promised 15 damage and
 *   delivered zero.
 *
 * Every description below now states what the simulation does. Where that is less
 * interesting than the design intended, the gap is recorded as data in
 * `HAZARDS_AWAITING_MECHANICS` rather than papered over in prose — the same treatment
 * `src/content/hulls.ts` gives the three hulls it cannot honestly ship.
 *
 * ## Descriptions are a route-choice interface, not flavour
 *
 * These strings are read on the world map at the moment the player commits to a lane,
 * which makes them the same class of text as an item's `mechanism` (UI.md rule 4):
 * **mechanism first, with real numbers, and the trade-off stated in plain language**.
 * A hazard the player cannot price is a route choice made blind, which is worse than
 * having no choice at all.
 *
 * So every description below is two clauses:
 *
 *   1. what it costs, with the figure and the cadence;
 *   2. what buys you out of it — the counterplay, or what the cost is paying for.
 *
 * `intervalTicks` is the FULL period — warning, active window and idle span together
 * — so `intervalTicks / 60` is the number the card may quote. It has not always been:
 * `HazardField` treated the field as the idle span alone until the fix in
 * `src/sim/hazards.ts`, which made a card saying "every 4 seconds" fire every 5 and
 * one saying "every 5" fire every 8. The intervals below are whole multiples of 60 so
 * that a card can state a whole number of seconds, and `tests/sectors.test.ts`
 * asserts it.
 *
 * ## On the numbers, and what a route hazard is allowed to cost
 *
 * The hull is 100 integrity plus 40 shield with no regeneration. A hazard is armed
 * only by taking a **priced route**, which also pays an item, scrap, or a repair — so
 * the honest budget is "less than the reward is worth", and the measurement says the
 * old numbers were nowhere near it.
 *
 * Measured, aggressor policy, 300 runs on each of two base seeds, direct routes
 * against `--route-style=rewarding`:
 *
 *   full-run clear rate      27.7% / 29.7%  ->  2.3% / 2.7%
 *   sector 2 clear on entry  59.4% / 63.7%  ->  14.3% / 15.9%
 *   sector 3 clear on entry  72.5% / 70.0%  ->  19.4% / 20.0%
 *   share of deaths that were hazards             0%  ->  59% / 60%
 *
 * `spore-bloom` alone caused 93% and 88% of every death in Bloomfield. The reason is
 * arithmetic: at 4 damage on a 3-second period, unconditional and bypassing the
 * shield, it billed **240 integrity over a 180-second sector** against a
 * 100-integrity hull. `hold-rot` billed 350 over sector five. Those are not hazards,
 * they are timers on the run ending, and the only reason the sweep did not report 0%
 * is that a fast clear outruns them.
 *
 * A route that costs 25 points of clear rate is worse than no route: it is a screen
 * that punishes the player for engaging with it. The budget now is roughly **25-30%
 * of a baseline hull's 140 effective health over a full sector**, which is a real
 * price against a real reward:
 *
 *   spore-bloom   4 x  9 fires per 180 s =  36   (26%)
 *   hold-rot      5 x  8 fires per 210 s =  42   (30%, and sector 5 pilots carry the
 *                                                 largest integrity pools in the run)
 *   convoy-wake  12 curtains per 180 s, dodgeable, absorbed by the shield
 *   grid-sweep    no damage; 2 s at 55% hull speed every 5 s
 *   manifest-blackout  no damage at all
 */

import type { HazardDef } from './types'

/**
 * Hazards whose designed behaviour the simulation cannot express, with the hook each
 * one needs.
 *
 * Written as data for the same reason `HULLS_AWAITING_MECHANICS` is: the reasoning is
 * the useful part, and a gap recorded only in prose is a gap nobody can grep for.
 * `tests/sectors.test.ts` requires every entry to name a real hazard.
 *
 * NONE of these is a balance finding. Each is a mechanic that was described to the
 * player and never implemented, and the descriptions below have stopped claiming them.
 */
export const HAZARDS_AWAITING_MECHANICS: readonly { id: string; needs: string }[] = [
  {
    id: 'spore-bloom',
    needs:
      'A CONDITIONAL corrosion tick. The design is "settles on a hull that stops", which ' +
      'needs updateHazards to test hull velocity (or ticks since the hull last moved) ' +
      'before calling applyHullDamage. It fires unconditionally, so the price of standing ' +
      'still and the price of never stopping are identical, and the sector loses the ' +
      'behaviour it was built to tax. Landing this hook should LOWER the damage figure ' +
      'further, not raise it: a conditional 36 per sector is far cheaper than an ' +
      'unconditional 36.',
  },
  { id: 'hold-rot', needs: 'The same conditional corrosion tick as spore-bloom.' },
  {
    id: 'convoy-wake',
    needs:
      'Shootable debris that pays. The design is "it is still cargo", which needs ' +
      'resolvePlayerBulletHits to test player bullets against hazard-sourced enemy bullets ' +
      'and award scrap on a hit. Player bullets collide with enemies only, so a debris ' +
      'curtain is pure cost and the sector-of-greed reading of it — the one object that ' +
      'both rewards and punishes attention — never happens.',
  },
  {
    id: 'grid-sweep',
    needs:
      'Damage from an interdiction field. HazardDef.damage is not read for this kind: ' +
      "world.ts's interdiction branch is a comment saying the effect is the active window, " +
      'and only speedFactor() consumes it. Until a caught hull takes damage this hazard ' +
      'costs position and nothing else, and the card now says so.',
  },
]

export const HAZARDS: Record<string, HazardDef> = {
  /**
   * Sector 2 — The Tally.
   *
   * The convoy sheds. Debris is the only hazard kind that is *also* meant to be an
   * opportunity, which is why it belongs to the greed sector — except that the
   * opportunity half is not implemented (see `HAZARDS_AWAITING_MECHANICS`), so what
   * ships is a positioning problem: five chunks in a jittered even spread, which
   * always leaves a gap wide enough to sit in.
   *
   * ## 15 seconds, not 4
   *
   * At a 4-second period a curtain takes 3.1 s to cross the field, so debris was on
   * screen 78% of the sector and the pilot was never not dodging it. Measured, it
   * caused 68% and 69% of every death in The Tally, and The Tally with a hazard armed
   * cleared at 14.3% against 59.4% without one — a 45-point swing from one hazard.
   *
   * Fifteen seconds is twelve curtains a sector rather than forty-five, which puts
   * debris on screen about a fifth of the time. That is the "costs attention rather
   * than integrity" the design asked for.
   *
   * Damage stays at 12 throughout. Each chunk should be worth avoiding, the shield
   * absorbs it, and the curtain is dodgeable by construction — so the honest lever is
   * how often the pilot is asked, not what being wrong costs.
   */
  'convoy-wake': {
    id: 'convoy-wake',
    name: 'Convoy Wake',
    kind: 'debris',
    description:
      'Loose freight falls across the lane every 15 seconds and deals 12 on contact. It drops in five evenly spaced chunks with a gap to sit in, so the wake costs position rather than reflexes.',
    intervalTicks: 900,
    damage: 12,
  },

  /**
   * Sector 3 — Bloomfield.
   *
   * Corrosion that settles on a stationary hull is the most direct possible statement
   * of "punishes standing still" — and the simulation does not check whether the hull
   * is standing still. See `HAZARDS_AWAITING_MECHANICS`. What ships is an unavoidable,
   * shield-bypassing tax, and the description says so rather than promising
   * counterplay that does not exist.
   *
   * ## 4 every 20 seconds, because 4 every 3 seconds was 240 damage a sector
   *
   * The old figure was authored for the conditional version ("a pilot who never stops
   * pays nothing") and applied unconditionally to a 100-integrity hull. It made
   * Bloomfield's priced routes unplayable: 93% and 88% of all deaths there.
   *
   * Nine ticks of 4 over a 180-second sector is 36, a quarter of a baseline hull,
   * paid whatever the pilot does.
   */
  'spore-bloom': {
    id: 'spore-bloom',
    name: 'Spore Bloom',
    kind: 'corrosion',
    description:
      'Corrosion strips 4 integrity every 20 seconds, through the shield and wherever the hull is. There is no dodging it; the route pays an item up front because this is what it costs.',
    intervalTicks: 1200,
    damage: 4,
  },

  /**
   * Sector 4 — Kill Grid.
   *
   * The grid's own weapon, at sector scale. Everything about Kill Grid is
   * "telegraphed and unforgiving", and an interdiction sweep is that sentence as a
   * hazard: announced, periodic, always the same way, and it takes away almost half
   * the hull's speed for two seconds at a time.
   *
   * ## Damage is 0 because the simulation applies none, and the card said 15
   *
   * `world.ts` handles `interdiction` by doing nothing except letting `speedFactor()`
   * see it, so the 15 was dead data and the route card was pricing a cost that never
   * arrived. This is the cheapest hazard in the run now, and deliberately so:
   * `INTERDICTION_SPEED_FACTOR` is 0.55 for the whole two-second active window, and
   * losing 45% of your speed in the sector built out of precise geometry is a real
   * cost even though nothing subtracts integrity for it.
   *
   * The period is unchanged at 5 seconds and the card's "every 5 seconds" is now
   * true — it was firing every 8 before the `HazardField` fix.
   */
  'grid-sweep': {
    id: 'grid-sweep',
    name: 'Interdiction Sweep',
    kind: 'interdiction',
    description:
      'A denial field closes every 5 seconds and cuts hull speed to 55% for two of them. It does no damage and it is announced a second ahead, so it costs position and nothing else.',
    intervalTicks: 300,
    damage: 0,
  },

  /**
   * Sector 5 — The Deep Manifest, first of two.
   *
   * The only hazard in the game that deals no damage, and the reason it exists is
   * that the interface is this project's stated first priority. Taking the panel away
   * for a moment is a real cost precisely *because* the readout is normally
   * trustworthy — it converts integrity and scrap from things the pilot reads into
   * things the pilot has to remember.
   *
   * It is deliberately not a screen blackout. Hiding the playfield would make incoming
   * fire unreadable, which is unfairness rather than difficulty; hiding the
   * instruments makes the pilot's *model* of the run unreliable while leaving every
   * dodge fully available.
   *
   * 7 seconds so it never overlaps itself, and so the sector still has long stretches
   * where the panel is simply correct. That is now the real period rather than the
   * idle span: before the `HazardField` fix this fired every 10.
   */
  'manifest-blackout': {
    id: 'manifest-blackout',
    name: 'Manifest Blackout',
    kind: 'blackout',
    description:
      'Interference blanks the instrument panel for two seconds every 7 seconds. It does no damage at all; the cost is the readout, so integrity and scrap have to be flown from memory.',
    intervalTicks: 420,
    damage: 0,
  },

  /**
   * Sector 5 — The Deep Manifest, second of two.
   *
   * The finale is the only stage carrying two hazards, and that is the escalation: one
   * takes integrity, the other takes information. A route arms one of them, so which
   * escalation the pilot gets is part of the choice.
   *
   * Bloomfield's corrosion returns here at 5 every 25 seconds against 4 every 20 —
   * 0.2 per second against 0.2, the same rate delivered in heavier instalments. Over a
   * 210-second sector that is 42 against Bloomfield's 36, and sector 5 pilots carry
   * the largest integrity pools in the run.
   *
   * It shares `spore-bloom`'s missing hook: the design is "vents on anything holding
   * position" and the simulation vents on everything. The description no longer claims
   * otherwise.
   */
  'hold-rot': {
    id: 'hold-rot',
    name: 'Hold Rot',
    kind: 'corrosion',
    description:
      'The flooded holds vent 5 integrity every 25 seconds, through the shield and wherever the hull is. There is no dodging it; the densest salvage in the run is what the rot is charging for.',
    intervalTicks: 1500,
    damage: 5,
  },
}

/**
 * Look up a hazard, throwing on an unknown id.
 *
 * Throws for the same reason `getEnemy` does: every caller is either content (a typo
 * in a stage's `hazardIds`) or a persisted id that has already been validated. A
 * hazard that silently fails to apply is a sector that quietly loses its character,
 * and nothing on screen would say so.
 *
 * Guards with `Object.hasOwn` so ids like `constructor` cannot resolve to an inherited
 * member of `Object.prototype`.
 */
export function getHazard(id: string): HazardDef {
  if (!Object.hasOwn(HAZARDS, id)) throw new Error(`Unknown hazard id: ${id}`)
  return HAZARDS[id] as HazardDef
}
