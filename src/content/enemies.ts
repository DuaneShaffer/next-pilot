/**
 * Enemy definitions.
 *
 * Sector 1 roster. Every entry here is tuned against two fixed facts about the
 * starting hull (`src/sim/world.ts`): it has 100 integrity plus 40 shield — 140
 * effective health — and it fires 20 shots/second at 4 damage, so **80 damage
 * per second** if every shot connects. "Time to kill" numbers in the comments
 * below are all against that 80 dps figure, and they are the primary tuning
 * dial: a sector-1 enemy's HP is chosen as *seconds of the player's attention*,
 * then converted.
 *
 * The hull moves at 210 units/second. Every projectile speed here is under 140,
 * which means the player always out-runs incoming fire and can dodge on sight.
 * That is the whole thesis of the Debris Shelf: nothing is unfair, so a death is
 * always legible as a mistake.
 *
 * Each enemy exists to teach exactly one thing. Where a choice was between
 * "interesting stat line" and "clear lesson", the lesson won.
 *
 * ## The windup budget
 *
 * `windupTicks` (see `EnemyWeaponDef`) is the per-volley telegraph. Values here
 * are chosen on *reaction-window* grounds — how long the pilot needs to read the
 * attack and act on it — and ordered by how much positional work the attack
 * demands rather than by how dangerous it is:
 *
 *   skiff 20 (0.33s)  single pellet, mostly self-telegraphing
 *   escort 30 (0.50s) slow fat tracker; unchanged, see the note on it below
 *   turret 32 (0.53s) 3-shot fan; the pilot must choose a lane
 *   heavy  38 (0.63s) 5-shot 46-degree fan; the sector's hardest positional ask
 *
 * **Every one is under half its weapon's `intervalTicks`, and `tests/content.test.ts`
 * enforces that.** Not tidiness — a windup that fills most of the interval means
 * the enemy is always winding up, and a warning light that is never off is not a
 * warning.
 *
 * It also bounds a risk that turned out not to materialise, and the number is
 * worth keeping written down. `src/sim/enemies.ts` charges the windup *inside*
 * `intervalTicks`: the cooldown resets when the tell starts, so the shot-to-shot
 * period is unchanged and the values below are the values. The other obvious
 * implementation — adding the windup on top of the interval — would have stretched
 * every armed enemy's cycle by its own windup. That was simulated before the sim
 * landed, over 300 seeds, and it took `aggressor`'s clear rate from 40.3% to 76.3%
 * while collapsing its survival IQR from 12.4s to 2.7s. A feel feature would have
 * silently removed the sector's ability to kill a competent pilot. If anyone ever
 * reconsiders that choice, the whole sector needs re-sweeping, not re-reasoning.
 */

import { PLAYFIELD_H } from '../core/space'
import type { EnemyDef } from './types'

/**
 * Fairness ceiling for contact damage in sector 1.
 *
 * A quarter of the hull's 140 effective health. A first-sector collision has to
 * hurt enough that the player stops treating enemies as scenery, but four
 * mistakes must still be survivable — dying to a single unlucky touch in the
 * tutorial-that-isn't-a-tutorial teaches nothing except that the game is
 * arbitrary. `tests/content.test.ts` enforces this.
 */
export const SECTOR_ONE_MAX_CONTACT_DAMAGE = 35

/**
 * How high up the playfield a pilot who is pushing forward is expected to fly,
 * as a fraction of playfield height. y = 230 at 720.
 *
 * Taken from the `greedy` bot's hold line, because that bot exists precisely to
 * probe forward play. Anything that *parks* — `hover`, `swoop`, `strafe` — must
 * leave PARKED_CLEARANCE below itself before this line, or its telegraph is
 * delivered after the collision rather than before it. See the lancer below.
 */
export const FORWARD_PLAY_Y_FRACTION = 0.32

/**
 * Clearance a parked enemy must leave between its own hull and the forward-play
 * line, in virtual units.
 *
 * 50 units is 0.24 seconds of travel at the hull's 210 u/s — enough that a pilot
 * arriving at the forward line meets a parked enemy as a thing to avoid rather
 * than as a hit that has already landed. `tests/content.test.ts` enforces it.
 */
export const PARKED_CLEARANCE = 50

/** The y a parked enemy of the given radius must stay above. */
export function maxParkedY(radius: number): number {
  return FORWARD_PLAY_Y_FRACTION * PLAYFIELD_H - PARKED_CLEARANCE - radius
}

export const ENEMIES: Record<string, EnemyDef> = {
  /**
   * LESSON: aim, and treat a closing enemy as a clock.
   *
   * The first thing the player ever sees. Unarmed, so there is no punishment for
   * getting it wrong except the hulk arriving. 30 HP is 0.375s of fire — deliberately
   * shorter than a player's reaction time to their own trigger, so the very first
   * kill happens before they have thought about it and the feedback loop closes
   * immediately.
   *
   * Radius 22 is the largest in the sector: a big slow target is a forgiving one,
   * and its size is what later makes a *pair* of them feel like a wall rather
   * than two dots. Speed 42 gives roughly 17 seconds of travel down the 720-unit
   * playfield, which is far longer than needed — the surplus time is where the
   * player learns to reposition instead of panicking.
   *
   * contactDamage 22 (was 14) is deliberately high for the sector's gentlest
   * enemy, because contact damage should scale with how *avoidable* the contact
   * is and the hauler is the most avoidable object in the game: 22 units wide,
   * unarmed, and seventeen seconds in transit. Nothing that plays deliberately
   * ever touches one — the M1 ablation sweep found that zeroing hauler contact
   * damage changed `dodger`, `aggressor`, and `greedy` medians by 0.0s each,
   * while adding 5.4s to `random`. It is the one number in this file that taxes
   * flying into things and nothing else.
   */
  hauler: {
    id: 'hauler',
    name: 'Hauler',
    hp: 30,
    radius: 22,
    contactDamage: 22,
    scrap: 4,
    movement: 'drift',
    movementParams: { speed: 42 },
    weapon: { kind: 'none', intervalTicks: 0, bulletSpeed: 0, damage: 0, firstDelayTicks: 0, windupTicks: 0 },
    shape: 'hauler',
  },

  /**
   * LESSON: a moving shooter fires from where it *is*, not where it was.
   *
   * The first thing in the game that shoots back, and the reason it moves on a
   * sine is that an `aimed` shot from a stationary enemy teaches nothing. The
   * player has to track the muzzle, not the silhouette they last looked at.
   *
   * frequency 0.4 is 2.5 seconds per oscillation, which at speed 78 is about
   * 3.7 full cycles across the playfield — slow enough that the path reads as a
   * curve rather than a jitter. amplitude 62 keeps the swing inside a third of
   * the 448-wide playfield so a skiff never teleports across the screen.
   *
   * 24 HP (0.3s) because a target that is hard to hit must not also be tanky;
   * the difficulty is in connecting, and it should pay off the moment you do.
   * firstDelayTicks 48 (0.8s) is long enough that a skiff entering from the top
   * is always visible before its first shot.
   *
   * intervalTicks 78 (was 90). The M1 ablation sweep named skiff fire as the
   * single largest contributor to how long an unskilled pilot lasts — zeroing it
   * added 13.2s to `random`'s median, exactly matching turret fire and far ahead
   * of anything else — while costing `aggressor` nothing, because a 24 HP target
   * dies before its second volley to anyone who shoots at it. That asymmetry is
   * why the rate went up here rather than on something tankier.
   */
  skiff: {
    id: 'skiff',
    name: 'Skiff',
    hp: 24,
    radius: 12,
    contactDamage: 12,
    scrap: 6,
    movement: 'sine',
    movementParams: { speed: 78, amplitude: 62, frequency: 0.4 },
    weapon: {
      kind: 'aimed',
      // 1.3s. A skiff takes ~9s to cross the playfield at speed 78, so this is
      // about seven volleys per skiff if nobody shoots it — and one or two if
      // anybody does. The gap is the whole point of the number.
      intervalTicks: 78,
      bulletSpeed: 130,
      damage: 6,
      firstDelayTicks: 48,
      // Telegraph: 20 ticks (0.33s), the shortest in the sector. A single pellet
      // at 130 u/s from a third of a screen away is ~2s in flight, so the shot
      // is most of its own warning; the windup only has to say "this one, now".
      windupTicks: 20,
    },
    shape: 'skiff',
  },

  /**
   * LESSON: read the telegraph.
   *
   * Unarmed, so the *only* thing that can kill you is failing to move during a
   * window the enemy hands you for free. That is the cleanest possible teaching
   * shape for a telegraph, and it is why the lancer has no gun.
   *
   * holdYFraction 0.2 parks it at y=144. **This number was 0.3 (y=216) in M1 and
   * it was the sector's worst defect.** A pilot pushing forward sits around
   * y=230; the lancer's radius is 13 and the hull's hitbox radius is 7, so a
   * lancer arriving at y=216 was already inside contact range of the pilot it
   * was supposed to be warning. The M1 sweep measured the consequence exactly:
   * 41% of `greedy`'s deaths were `collision:lancer`, and of those, **0 of 82
   * happened during the dive** — 42 landed while the lancer was still descending
   * and 40 while it was parked and motionless. The telegraph was being delivered
   * after impact, which is why `greedy` died at 124.1s with a 2.3s interquartile
   * range across 200 seeds: not a distribution, a wall.
   *
   * At 0.2 the same measurement reads 86 of 86 lancer collisions in the dive
   * phase, zero parked-lancer contacts in 200 runs, and `greedy`'s IQR opens to
   * 11.2s. Two suspicions were tested and **refuted** on the way here, so don't
   * re-try them: lengthening holdTicks to 72 made it *worse* (IQR 8.0, lancer
   * share 53%) because a parked lancer sitting on the pilot for longer is more
   * contact, not more warning; and softening diveMultiplier to 2.6 left greedy's
   * median untouched at 124.1s while costing `aggressor` 22 points of clear rate.
   * The dive was never the problem. The parking spot was.
   *
   * holdTicks 48 (0.8s) is the telegraph itself. diveMultiplier 3.2 turns speed
   * 118 into 378 units/second on the dive. From y=144 that is 1.2s to reach the
   * hull's home row and 0.23s to reach the forward-play line — fast enough to
   * feel committed, and it now begins from outside contact range in both cases,
   * which is what makes the 0.8s of warning mean anything.
   *
   * contactDamage 24 is the highest in the sector. It has to be: the lancer is
   * the one enemy whose entire threat is a single avoidable event, so ignoring
   * the telegraph must cost more than a sixth of the hull.
   */
  lancer: {
    id: 'lancer',
    name: 'Lancer',
    hp: 28,
    radius: 13,
    contactDamage: 24,
    scrap: 8,
    movement: 'swoop',
    movementParams: { speed: 118, holdYFraction: 0.2, holdTicks: 48, diveMultiplier: 3.2 },
    weapon: { kind: 'none', intervalTicks: 0, bulletSpeed: 0, damage: 0, firstDelayTicks: 0, windupTicks: 0 },
    shape: 'lancer',
  },

  /**
   * LESSON: some threats must be killed, not dodged.
   *
   * Everything before the turret can be waited out. The turret parks itself and
   * keeps firing, so dodging is a losing strategy — the player has to decide to
   * commit to a target. 220 HP is 2.75 seconds of uninterrupted fire, which is
   * the point: it is the first enemy that cannot be killed *while* dodging
   * something else, so it forces a priority call.
   *
   * **220 HP was suspected of being the reason an unskilled pilot gets so far, and
   * the sweep says it is not. Do not lower it.** The suspicion was reasonable:
   * `random` destroys only 15% of the turrets it meets, 58% are still alive when
   * its run ends, and 59% of its deaths are turret-attributed. But cutting HP
   * fixes none of that and breaks something else. Measured on this sim, at 200
   * runs a policy, changing *only* turret HP from 220 to 176:
   *
   *   `random`    median 104.8s -> 104.8s, wave 18 -> 18   (no effect at all)
   *   `aggressor` clear rate 45.0% -> 78.5%                (target band is 35-50%)
   *
   * `random` cannot kill a 176 HP turret either — at 14% accuracy and a 60% duty
   * cycle it is doing about 7 dps, so the difference is 32 seconds versus 25, and
   * the turret leaves on its 10-second timer long before either. All the HP
   * reduction did was hand 33 points of clear rate to a policy that already fires
   * every third tick. What *did* move `random` was the volley, below.
   *
   * holdYFraction 0.22 puts it at y=158, high enough that its spread has room to
   * fan out and become dodgeable before it arrives, and 57 units clear of the
   * forward-play line (see PARKED_CLEARANCE). holdTicks 600 (10s) means it
   * eventually leaves rather than stalling the sector forever if the player is
   * struggling — a soft failure instead of a hard wall.
   *
   * A 3-shot spread over 30 degrees at speed 120: the fan is ~5 seconds of travel
   * to the hull, and at that range the 30-degree arc has opened wide enough to
   * step between the pellets. Narrower would be a shotgun; wider would be
   * indistinguishable from three unaimed shots. The count stays **odd** on
   * purpose — a 4-shot version was measured and it straddles the aim line, so
   * standing still becomes correct: `dodger` gained 11s and `greedy` gained 14s
   * against it. An even-count spread is a weapon that rewards not moving.
   */
  turret: {
    id: 'turret',
    name: 'Turret',
    hp: 220,
    radius: 15,
    contactDamage: 16,
    scrap: 14,
    movement: 'hover',
    movementParams: { speed: 55, holdYFraction: 0.22, holdTicks: 600 },
    weapon: {
      kind: 'spread',
      // 1.6s and 7 damage, up from 1.75s and 6. This is the half of the turret
      // change that the numbers actually supported: a 9% faster volley that is
      // 17% harder took `random` from a 104.8s median at wave 18 to 102.0s at
      // wave 17 while costing `aggressor` 3.5 points of clear rate. Unlike the HP
      // cut it taxes the pilot who fails to kill the turret rather than rewarding
      // the one who was always going to.
      intervalTicks: 96,
      bulletSpeed: 120,
      damage: 7,
      count: 3,
      spreadDegrees: 30,
      firstDelayTicks: 75, // 1.25s: the hover settles before the first volley.
      // Telegraph: 32 ticks (0.53s). Longer than the skiff's because a fan cannot
      // be sidestepped by a hull-width — the pilot has to choose a lane, and
      // choosing takes longer than reacting.
      windupTicks: 32,
    },
    shape: 'turret',
  },

  /**
   * LESSON: position before you kill.
   *
   * 12 HP is three player shots — the mine dies essentially by accident, which is
   * exactly the trap. The lesson only lands if killing it is effortless and the
   * *timing* of the kill is what matters. Making it tanky would turn a
   * positioning puzzle into a damage check.
   *
   * Speed 22 is the slowest thing in the sector (33 seconds to cross), so a mine
   * is never a surprise; it is a decision the player is allowed to defer.
   *
   * The death burst is 8 shots at 45-degree intervals. At speed 92 the ring is
   * trivially escapable from any distance, and near-lethal in contact — the gaps
   * only close if you were sitting on top of it. contactDamage 18 keeps sloppy
   * ramming from being the safe answer.
   */
  mine: {
    id: 'mine',
    name: 'Drifting Mine',
    hp: 12,
    radius: 11,
    contactDamage: 18,
    scrap: 3,
    movement: 'drift',
    movementParams: { speed: 22 },
    weapon: { kind: 'none', intervalTicks: 0, bulletSpeed: 0, damage: 0, firstDelayTicks: 0, windupTicks: 0 },
    shape: 'mine',
    deathBurst: { count: 8, bulletSpeed: 92, damage: 6 },
  },

  /**
   * LESSON: standing still is punished.
   *
   * The tracker keeps its heading, so it is never unavoidable — it is a slow,
   * legible instruction to *move*, aimed at wherever the player has decided to
   * camp. Speed 105 is half the hull's 210, so a single sidestep clears it; the
   * cost is only paid by a player who has stopped thinking about position.
   *
   * intervalTicks 120 (2s) is deliberately slack. One escort is a nudge; the
   * escalation phase pairs them so the nudges overlap into genuine crossfire,
   * and that stacking is where the pressure is meant to come from rather than
   * from any single escort being dangerous.
   *
   * 40 HP (0.5s) makes it the cheapest way to add real bullets to a wave without
   * adding an HP wall, which is why it carries most of the late-sector density.
   */
  escort: {
    id: 'escort',
    name: 'Escort',
    hp: 40,
    radius: 13,
    contactDamage: 14,
    scrap: 7,
    movement: 'drift',
    movementParams: { speed: 60 },
    weapon: {
      kind: 'tracker',
      intervalTicks: 120,
      bulletSpeed: 105,
      damage: 7,
      firstDelayTicks: 66, // 1.1s — the escort is on screen and identified first.
      // Telegraph: 30 ticks (0.50s), left alone this milestone. A shorter tell was
      // considered — a tracker is fat (radius 4.5) and slow (105 u/s, half the
      // hull's speed), so the projectile is already the most readable thing in the
      // game and arguably needs less warning than the turret's fan. But escort
      // fire is the top killer of both `dodger` (42%) and `aggressor` (25%), so
      // shortening it is a real difficulty change, and the sweep put the argument
      // for it at 1.5 points of `aggressor` clear rate — inside the noise of a
      // 200-run sample. Changing a number for an unmeasurable reason is how a
      // tuned sector drifts, so this one stays where M1 left it.
      windupTicks: 30,
    },
    shape: 'escort',
  },

  /**
   * The sector's one elite. Not a seventh enemy type — a variant of the turret,
   * reusing its shape and its lesson, which is the point: the elite is a test of
   * something already taught rather than a new thing to learn mid-fight.
   *
   * 360 HP is 4.5 seconds of committed fire. That is long enough that the player
   * cannot kill it inside a single safe window and must break off, reposition,
   * and come back — the first time sector 1 asks for that. Unchanged this
   * milestone: nothing in the sweep asked for it, since `greedy` takes 7-10% of
   * its deaths from the heavy and `random` dies around 96s and never meets it.
   * The 5-shot / 46-degree
   * spread widens the fan without speeding it up much (130 vs 120), so the answer
   * is still footwork and not reflexes.
   *
   * Scrap 30 is roughly two turrets' worth: an elite must be worth choosing to
   * fight, since it appears at a moment when running is a legitimate option.
   */
  'turret-heavy': {
    id: 'turret-heavy',
    name: 'Heavy Turret',
    hp: 360,
    radius: 19,
    contactDamage: 20,
    scrap: 30,
    movement: 'hover',
    movementParams: { speed: 48, holdYFraction: 0.2, holdTicks: 780 },
    weapon: {
      kind: 'spread',
      intervalTicks: 96, // 1.6s
      bulletSpeed: 130,
      damage: 7,
      count: 5,
      spreadDegrees: 46,
      firstDelayTicks: 90, // 1.5s: the longest tell in the sector, for the biggest threat.
      // Telegraph: 38 ticks (0.63s), the longest per-volley windup in the sector.
      // A 5-shot fan over 46 degrees is the hardest positional problem sector 1
      // poses, and the tell has to cover choosing a lane *and* getting to it.
      // Held under half the 96-tick interval so the elite is never continuously
      // telegraphing — see the windup budget note at the top of this file.
      windupTicks: 38,
    },
    shape: 'turret',
    elite: true,
  },
}

/**
 * Look up an enemy definition, throwing on an unknown id.
 *
 * Throws rather than returning undefined because every caller is either content
 * (a typo in a wave script) or the spawner (a def id that no longer exists).
 * Both are authoring bugs that should fail loudly at the moment they happen, not
 * become a silently missing enemy that quietly changes a seeded run's outcome.
 *
 * Guards with `Object.hasOwn` rather than an undefined check: a plain index
 * lookup resolves ids like `constructor` and `toString` to inherited members of
 * `Object.prototype`, which would return a function where the caller expects an
 * `EnemyDef` and fail somewhere far from the actual mistake.
 */
export function getEnemy(id: string): EnemyDef {
  if (!Object.hasOwn(ENEMIES, id)) throw new Error(`Unknown enemy id: ${id}`)
  return ENEMIES[id] as EnemyDef
}
