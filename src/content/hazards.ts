/**
 * Sector hazards.
 *
 * A hazard is the sector's own character, separate from its enemies — the thing
 * that makes Bloomfield feel different from the Kill Grid even on a quiet
 * stretch when neither is shooting. Enemies arrive and are killed; a hazard is
 * simply true for the whole stage, and the pilot flies around it rather than
 * through it.
 *
 * ## Descriptions are a route-choice interface, not flavour
 *
 * These strings are read on the world map at the moment the player commits to a
 * lane, which makes them the same class of text as an item's `mechanism` (UI.md
 * rule 4): **mechanism first, with real numbers, and the trade-off stated in
 * plain language**. A hazard the player cannot price is a route choice made
 * blind, which is worse than having no choice at all.
 *
 * So every description below is two clauses:
 *
 *   1. what it costs, with the figure and the cadence;
 *   2. what buys you out of it — the counterplay, or what the cost is paying for.
 *
 * `tests/sectors.test.ts` asserts the first clause mechanically: the damage
 * figure and the interval in seconds must both appear in the text. That is not
 * pedantry. A hazard whose numbers are retuned and whose description is not is a
 * lie told to the player at the exact moment they are making a decision, and it
 * is invisible to every other test in the project.
 *
 * ## On the numbers
 *
 * The hull is 100 integrity plus 40 shield with no regeneration, so a hazard
 * that ticks unconditionally for a whole 180-second sector would dwarf every
 * enemy in it — `spore-bloom` at 4 damage every 2.5s is 288 damage over a sector
 * if it never misses, which is twice the hull. Every hazard here is therefore
 * written as **conditional**: it costs something when the pilot is doing a
 * particular thing (holding a firing position, standing in a swept lane, flying
 * into debris), and the description says which thing. Read that as a constraint
 * on the implementation, not a hint — a hazard implemented as unconditional
 * chip damage at these rates is not the hazard described here.
 */

import type { HazardDef } from './types'

export const HAZARDS: Record<string, HazardDef> = {
  /**
   * Sector 2 — The Tally.
   *
   * The convoy sheds. Debris is the only hazard kind that is *also* an
   * opportunity, which is why it belongs to the greed sector: every chunk in the
   * wake is both a 12-point collision and a piece of salvage, so the same object
   * rewards attention and punishes distraction. The Tally's whole design is that
   * question asked repeatedly, and the hazard asks it in the gaps between waves.
   *
   * 4 seconds is slow enough to read against a busy lane and frequent enough
   * that the pilot never fully stops accounting for it.
   */
  'convoy-wake': {
    id: 'convoy-wake',
    name: 'Convoy Wake',
    kind: 'debris',
    description:
      'Loose freight tumbles out of the lane every 4 seconds and deals 12 on contact. It is still cargo: shoot it and it pays, so the wake costs attention rather than integrity.',
    intervalTicks: 240,
    damage: 12,
  },

  /**
   * Sector 3 — Bloomfield.
   *
   * Corrosion that settles on a stationary hull is the most direct possible
   * statement of "punishes standing still", and it is aimed at exactly the
   * behaviour Bloomfield's enemies already tax: the sector is full of 300 HP
   * husks that want the pilot to hold a firing line, and the hazard is what
   * holding one costs.
   *
   * 4 damage every 2.5 seconds is 1.6 dps while it is active. A pilot who never
   * stops pays nothing; one who parks to melt a husk for three seconds pays
   * about 5. That is a price worth paying sometimes, which is what makes it a
   * decision rather than a tax.
   */
  'spore-bloom': {
    id: 'spore-bloom',
    name: 'Spore Bloom',
    kind: 'corrosion',
    description:
      'Spores settle on a hull that stops, stripping 4 integrity every 2.5 seconds. Keep moving and nothing lands; hold a firing position and it is the price of the shot.',
    intervalTicks: 150,
    damage: 4,
  },

  /**
   * Sector 4 — Kill Grid.
   *
   * The grid's own weapon, at sector scale. Everything about Kill Grid is
   * "telegraphed and unforgiving", and an interdiction sweep is that sentence as
   * a hazard: it is announced, it is periodic, it always crosses the same way,
   * and it hits for 15 — the hardest single hazard event in the run — if the
   * pilot is somewhere it is about to be.
   *
   * 5 seconds because the sweep has to be *plannable*. At 4 seconds it becomes a
   * reflex test and the sector already has sweepers for that; at 5 it is long
   * enough to finish a node and reposition, which makes it a rhythm the pilot
   * fights inside rather than an interruption.
   */
  'grid-sweep': {
    id: 'grid-sweep',
    name: 'Interdiction Sweep',
    kind: 'interdiction',
    description:
      'A denial sweep crosses the field every 5 seconds and deals 15 to anything caught in it. It is announced before it fires and always runs the same way, so it costs position, not reflexes.',
    intervalTicks: 300,
    damage: 15,
  },

  /**
   * Sector 5 — The Deep Manifest, first of two.
   *
   * The only hazard in the game that deals no damage, and the reason it exists
   * is that the interface is this project's stated first priority. Taking the
   * panel away for a moment is a real cost precisely *because* the readout is
   * normally trustworthy — it converts integrity and scrap from things the pilot
   * reads into things the pilot has to remember.
   *
   * It is deliberately not a screen blackout. Hiding the playfield would make
   * incoming fire unreadable, which is unfairness rather than difficulty; hiding
   * the instruments makes the pilot's *model* of the run unreliable while
   * leaving every dodge fully available.
   *
   * 7 seconds so it never overlaps itself, and so the sector still has long
   * stretches where the panel is simply correct.
   */
  'manifest-blackout': {
    id: 'manifest-blackout',
    name: 'Manifest Blackout',
    kind: 'blackout',
    description:
      'Interference blanks the instrument panel for a moment every 7 seconds. It does no damage at all; the cost is the readout, so integrity and scrap have to be flown from memory.',
    intervalTicks: 420,
    damage: 0,
  },

  /**
   * Sector 5 — The Deep Manifest, second of two.
   *
   * The finale is the only stage carrying two hazards, and that is the
   * escalation: one hazard takes integrity, the other takes information, and
   * they are worst together — the rot is charging the pilot for holding position
   * during the seconds the panel cannot say how much integrity is left.
   *
   * Bloomfield's corrosion returns here at 5 every 3 seconds (1.67 dps against
   * 1.6) which is barely harder in isolation. The escalation is not the rate. It
   * is that sector 5 gives the pilot far more reasons to stand still — 820 HP
   * quartermasters, 420 HP revenants — so the same tax is levied several times
   * as often.
   */
  'hold-rot': {
    id: 'hold-rot',
    name: 'Hold Rot',
    kind: 'corrosion',
    description:
      'The flooded holds vent on anything holding position, stripping 5 integrity every 3 seconds. The densest salvage in the run is in those holds, so the rot is what the best scrap costs.',
    intervalTicks: 180,
    damage: 5,
  },
}

/**
 * Look up a hazard, throwing on an unknown id.
 *
 * Throws for the same reason `getEnemy` does: every caller is either content (a
 * typo in a stage's `hazardIds`) or a persisted id that has already been
 * validated. A hazard that silently fails to apply is a sector that quietly
 * loses its character, and nothing on screen would say so.
 *
 * Guards with `Object.hasOwn` so ids like `constructor` cannot resolve to an
 * inherited member of `Object.prototype`.
 */
export function getHazard(id: string): HazardDef {
  if (!Object.hasOwn(HAZARDS, id)) throw new Error(`Unknown hazard id: ${id}`)
  return HAZARDS[id] as HazardDef
}
