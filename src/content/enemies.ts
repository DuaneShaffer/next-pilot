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

/**
 * The fastest a projectile may ever travel, in virtual units per second.
 *
 * 168 is 80% of the hull's 210. Sector 1 caps itself far lower (130) because
 * "dodgeable on sight" is that sector's thesis, but later sectors need faster
 * fire to feel different, and the question is how much faster is still fair.
 *
 * The margin, not the ratio, is what matters: at 168 a pilot moving directly
 * away gains 42 units per second on the shot, so a bullet fired from the top of
 * the playfield is escapable for its whole flight. Above about 190 that margin
 * stops covering reaction time and the projectile becomes a hit that has already
 * happened. `tests/sectors.test.ts` enforces this for every sector, including
 * death bursts, which is the case an eyeball check misses.
 */
export const DODGEABLE_BULLET_SPEED = 168

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

  // ===========================================================================
  // SECTORS 2-5
  //
  // Everything above this line is sector 1 and is tuned against measured bot
  // sweeps. Nothing below it may change a number above it.
  //
  // ## The output assumption these are tuned against
  //
  // Sector 1's roster is priced in seconds of an 80 dps gun. Later sectors are
  // priced against a pilot who has been picking items up, and the assumed curve
  // is deliberately conservative:
  //
  //   sector 2  ~1.2x  ->  96 dps
  //   sector 3  ~1.5x  -> 120 dps
  //   sector 4  ~1.75x -> 140 dps
  //   sector 5  ~2.0x  -> 160 dps
  //
  // Every "TTK" in the comments below is against its own sector's figure, so an
  // enemy that reads as "2.5 seconds of fire" costs the same *attention* in
  // sector 4 as a 200 HP enemy would have cost in sector 1. THIS ASSUMPTION IS
  // THE LARGEST UNMEASURED INPUT IN THIS FILE. If a sweep shows real output
  // landing nearer 1.6x by sector 5, sector 5's HP is ~20% too high and the fix
  // is its wave counts, not these stat lines.
  //
  // ## Projectile speed
  //
  // Sector 1 caps bullets at 130 against a 210 u/s hull. Later sectors raise
  // that, but never past `DODGEABLE_BULLET_SPEED` — the hull must out-run every
  // bullet in the game by a clear margin, not by a rounding error. Bloomfield
  // (sector 3) deliberately goes the *other* way: its projectiles are the
  // slowest after sector 1's, because its difficulty is how much of the screen
  // is occupied rather than how fast anything crosses it.
  //
  // ## Parking
  //
  // `maxParkedY` is a sector-1 constant that applies to the whole game: anything
  // that stops moving is an obstacle, and an obstacle where the pilot flies is a
  // hit rather than a lesson. Every `hover`, `swoop`, and `strafe` below is
  // inside it, which is why later sectors' emplacements all sit in the top
  // quarter of the playfield however big they get.
  // ===========================================================================

  // ---------------------------------------------------------------------------
  // Sector 2 — The Tally. Convoy lanes: greed against safety.
  //
  // The grammar is that MOST OF THE SCREEN IS NOT SHOOTING AT YOU. Freight is
  // inert, valuable, and slow; the threat is a small number of guards who keep
  // firing while you decide how much of the convoy to bill. Every wave is the
  // same question at a different price.
  // ---------------------------------------------------------------------------

  /**
   * The payday. Unarmed, so the only thing it costs is time — which is the
   * entire point, because time is what the escorts are charging for.
   *
   * 240 HP is 2.5 seconds at sector 2's assumed 96 dps: long enough that you
   * cannot kill one *while* dodging a tollgate volley, short enough that
   * committing is a real option rather than a fantasy. 52 scrap at 240 HP is
   * 4.6 HP per scrap, the best rate in the game (sector 1's best is the lancer
   * at 3.5, and it is worth 8). Bulk value at a bulk price.
   *
   * Radius 26 makes it the biggest common enemy: a freighter physically blocks
   * the lane it is in, so ignoring one is also a positioning decision.
   */
  freighter: {
    id: 'freighter',
    name: 'Bonded Freighter',
    hp: 240,
    radius: 26,
    contactDamage: 26,
    scrap: 52,
    movement: 'drift',
    movementParams: { speed: 34 },
    weapon: { kind: 'none', intervalTicks: 0, bulletSpeed: 0, damage: 0, firstDelayTicks: 0, windupTicks: 0 },
    shape: 'hauler',
  },

  /**
   * The greed trap, stated in numbers: 45 HP for 26 scrap is 1.7 HP per scrap,
   * five times better than anything else in the sector — and it vents twelve
   * shards when it opens.
   *
   * This is the mine's lesson re-asked as an economic one. The mine is a thing
   * you kill by accident and regret; the strongbox is a thing you kill on
   * purpose and must set up for. Killing one from across the playfield is free
   * money; killing one at point blank because it was in the way costs about half
   * a shield. The burst at 116 u/s is comfortably out-run at 210.
   *
   * Speed 26 (barely above the mine's 22) so the decision can always be
   * deferred — a strongbox you are not ready for is still there in ten seconds.
   *
   * ## The burst is 10 shards at 5, not 12 at 6, and the measurement says why
   *
   * "Killing one at point blank costs about half a shield" was the intent, and 12 x 6
   * is 72 against a 40-point shield — so a pilot who ate even half a burst lost the
   * whole shield and some integrity. Measured, this was 15% and 21% of every death in
   * a sector that already owned 43-47% of the deaths in the run: the second largest
   * named cause in it.
   *
   * 10 x 5 is 50, so half a burst is 25 and the sentence above becomes true. The
   * lesson is unchanged and the trap still bites; it no longer ends runs in the
   * sector where a pilot has the least health and the fewest items to fix it.
   */
  strongbox: {
    id: 'strongbox',
    name: 'Sealed Strongbox',
    hp: 45,
    radius: 14,
    contactDamage: 20,
    scrap: 26,
    movement: 'drift',
    movementParams: { speed: 26 },
    weapon: { kind: 'none', intervalTicks: 0, bulletSpeed: 0, damage: 0, firstDelayTicks: 0, windupTicks: 0 },
    shape: 'mine',
    deathBurst: { count: 10, bulletSpeed: 116, damage: 5 },
  },

  /**
   * The first horizontally-moving shooter in the game, and the reason `strafe`
   * exists in the sector-2 vocabulary at all.
   *
   * Sector 1's threats all descend, so the pilot's model of danger is "top to
   * bottom". An interceptor crosses the top band at 118 u/s firing aimed shots
   * downward, which means the safe column keeps moving sideways and the old
   * habit of picking a lane and holding it stops working. That is a rule change
   * of the same class as sector 1's turret, delivered by movement instead of by
   * a stat.
   *
   * 70 HP is 0.73s — cheap, because its threat is where it is rather than how
   * long it lives, and a tanky crosser would just be a moving wall. Its aimed
   * shot at 142 u/s is faster than anything in sector 1 (130) but still 68 u/s
   * slower than the hull.
   */
  interceptor: {
    id: 'interceptor',
    name: 'Lane Interceptor',
    hp: 70,
    radius: 12,
    contactDamage: 18,
    scrap: 12,
    movement: 'strafe',
    movementParams: { speed: 118, holdYFraction: 0.19 },
    weapon: {
      kind: 'aimed',
      // 72 rather than 60, so ~3 aimed shots per crossing rather than ~4. Third
      // named cause of death in the run's cliff sector at 9-13%, and the shot count
      // is the honest lever: the threat is stated above as "where it is rather than
      // how long it lives", and a crosser landing four aimed shots is being paid for
      // its uptime rather than for its position.
      intervalTicks: 72, // 1.2s. It is on screen for ~4s, so this is ~3 shots.
      bulletSpeed: 142,
      damage: 7,
      firstDelayTicks: 42, // 0.7s — it has crossed a visible distance before firing.
      windupTicks: 24,
    },
    shape: 'escort',
  },

  /**
   * The lane toll: a turret that covers one column precisely rather than fanning
   * across three.
   *
   * The deliberate inversion of sector 1's turret. That one fires 3 shots over
   * 30 degrees at 120 u/s, and the answer is to step *between* the pellets. This
   * one fires 3 shots over 14 degrees at 146 u/s, and there is no gap to step
   * into — the answer is to not be in the column at all. Same weapon kind, same
   * shot count, opposite question, which is the cheapest way to make a familiar
   * silhouette teach something new.
   *
   * 240 HP is 2.5s at 96 dps. holdTicks 420 (7s) so a tollgate the pilot decides
   * to run past eventually leaves, exactly as sector 1's does.
   *
   * ## Retuned against the measured death distribution, not against feel
   *
   * The Tally took 47.0% and 43.1% of every death in a 300-run sweep on each of two
   * seeds, against a 35% ceiling that says no sector may be a cliff, and it is
   * entered at the lowest health of any sector (57% / 63%). This enemy was the
   * largest single named cause inside it, at 31% and 21% of the sector's deaths.
   *
   * Three numbers moved, each aimed at a different part of why:
   *
   * - `holdTicks` 540 -> 420. The stated design is "a tollgate the pilot decides to
   *   run past eventually leaves". Nine seconds against a 1.4-second cadence is six
   *   volleys, which is not a decision to run past — it is a wall that outlasts the
   *   decision. Seven seconds is five.
   * - `intervalTicks` 84 -> 96 (1.4s -> 1.6s). The answer to this turret is to LEAVE
   *   THE COLUMN, and at 1.4 s the pilot who commits to leaving is still inside the
   *   next volley. A gap has to be wide enough to contain the manoeuvre the enemy is
   *   asking for, or the telegraph is decorative.
   * - `damage` 8 -> 7. The smallest of the three and last on purpose: a 3-shot column
   *   at 146 u/s should still hurt. It went to 6 on a second pass, when the sector
   *   was still at 41.8% of every death in the run and this was still its largest
   *   named cause at 23%.
   */
  tollgate: {
    id: 'tollgate',
    name: 'Tollgate Turret',
    hp: 240,
    radius: 16,
    contactDamage: 18,
    scrap: 24,
    movement: 'hover',
    movementParams: { speed: 60, holdYFraction: 0.22, holdTicks: 420 },
    weapon: {
      kind: 'spread',
      intervalTicks: 96, // 1.6s
      bulletSpeed: 146,
      damage: 6,
      count: 3,
      spreadDegrees: 14,
      firstDelayTicks: 72,
      // 34 ticks (0.57s). Slightly longer than sector 1's turret because leaving
      // a column is a bigger move than sidestepping inside one.
      windupTicks: 34,
    },
    shape: 'turret',
  },

  /**
   * Sector 2's elite, and the sector's thesis in one object: 620 HP for 120
   * scrap — six and a half seconds of your gun for a shop tier and a half.
   *
   * Armed with a tracker rather than a fan on purpose. A tracker is the weapon
   * that punishes standing still, and killing a 620 HP target is the single
   * longest period in the sector during which the pilot wants to stand still.
   * The elite therefore attacks the exact behaviour that greed produces, which
   * is a better fight than one that simply does more damage.
   *
   * It drifts rather than parking: the barge is *leaving*, so the offer expires.
   * At speed 30 it is on screen for ~24s, which is generous — the pressure comes
   * from what else arrives during those 24 seconds, not from the clock.
   */
  comptroller: {
    id: 'comptroller',
    name: 'Comptroller Barge',
    hp: 620,
    radius: 28,
    contactDamage: 30,
    scrap: 120,
    movement: 'drift',
    movementParams: { speed: 30 },
    weapon: {
      kind: 'tracker',
      intervalTicks: 78, // 1.3s — nearly twice the escort's rate, from one body.
      bulletSpeed: 122,
      damage: 9,
      firstDelayTicks: 90,
      windupTicks: 30,
    },
    shape: 'hauler',
    elite: true,
  },

  // ---------------------------------------------------------------------------
  // Sector 3 — Bloomfield. Something organic has taken a dead station.
  //
  // The grammar is that NOTHING IS AIMED AT YOU. Sectors 1 and 2 are read by
  // asking "where is that shot going?"; Bloomfield is read by asking "where is
  // there still room?". Its weapons are rings and death bursts, so the field
  // fills from wherever things happen to be rather than from wherever you are —
  // and because almost everything here bursts when it dies, THE SECTOR GETS MORE
  // DANGEROUS THE FASTER YOU KILL. That inversion is the sector, and it is why
  // its projectiles are slow: the threat is occupancy, not velocity.
  // ---------------------------------------------------------------------------

  /**
   * The spreading unit. Cheap, erratic, and it seeds when it dies.
   *
   * 18 HP is a quarter-second of fire, so spores die essentially on contact with
   * the crosshair — and each one pays six shards for the privilege. A screen of
   * twelve spores is 216 HP and 72 outgoing projectiles if you clear all of it,
   * which is the sector teaching its own core lesson without a single aimed
   * shot: clearing indiscriminately is how you die here.
   *
   * The sine is faster and wider than the skiff's (96 u/s, 72 amplitude, 0.65 Hz
   * against 78/62/0.4) so a spore's path is a wander rather than a readable
   * curve. Amplitude is held under the 112 the playfield allows so a swarm still
   * reads as a swarm rather than as screen-wide sweeps.
   */
  spore: {
    id: 'spore',
    name: 'Drift Spore',
    hp: 18,
    radius: 9,
    contactDamage: 12,
    scrap: 4,
    movement: 'sine',
    movementParams: { speed: 96, amplitude: 72, frequency: 0.65 },
    weapon: { kind: 'none', intervalTicks: 0, bulletSpeed: 0, damage: 0, firstDelayTicks: 0, windupTicks: 0 },
    shape: 'mine',
    deathBurst: { count: 6, bulletSpeed: 96, damage: 5 },
  },

  /**
   * The area-denial unit, and the first `ring` weapon in the game.
   *
   * A ring is aimed at nothing. It is the pod's *position* that threatens, which
   * makes it the exact opposite of every sector-1 and sector-2 shooter: you
   * cannot dodge it by moving out of a line, only by being somewhere the
   * expanding circle is not. Ten shots at 104 u/s from a parked source is a
   * slowly closing net, and the counterplay is to be moving through the gaps
   * before it fires rather than reacting after it does — hence the long 40-tick
   * telegraph, which is a "the field is about to fill" warning rather than a
   * "this shot is coming at you" one.
   *
   * 150 HP is 1.25s at 120 dps. Cheap for something that parks, because a tanky
   * ring source turns the sector into a stalemate. It bursts when killed, so
   * removing a pod is itself a positioning problem.
   */
  'bloom-pod': {
    id: 'bloom-pod',
    name: 'Bloom Pod',
    hp: 150,
    radius: 17,
    contactDamage: 20,
    scrap: 16,
    movement: 'hover',
    movementParams: { speed: 44, holdYFraction: 0.2, holdTicks: 420 },
    weapon: {
      kind: 'ring',
      intervalTicks: 108, // 1.8s
      bulletSpeed: 104,
      damage: 6,
      count: 10,
      firstDelayTicks: 84,
      windupTicks: 40,
    },
    shape: 'mine',
    deathBurst: { count: 8, bulletSpeed: 88, damage: 5 },
  },

  /**
   * The thing that makes standing still impossible.
   *
   * A tracker on a body that crosses laterally. Sector 1's escort fires trackers
   * while drifting down, so its shots all come from roughly the same bearing and
   * a pilot can hold a horizontal band and be broadly safe. A creeper's shots
   * arrive from a bearing that is *changing*, so the band that was safe two
   * seconds ago is the one being fired into now.
   *
   * 9 damage at 118 u/s is the hardest-hitting tracker in the game and the
   * fattest, slowest projectile in the sector — legible, unhurried, and
   * unforgiving of a pilot who has stopped to shoot a husk.
   */
  creeper: {
    id: 'creeper',
    name: 'Crawling Growth',
    hp: 160,
    radius: 15,
    contactDamage: 22,
    scrap: 14,
    movement: 'strafe',
    movementParams: { speed: 74, holdYFraction: 0.21 },
    weapon: {
      kind: 'tracker',
      intervalTicks: 78, // 1.3s, against the escort's 2s. It crosses in ~6s: ~4 shots.
      bulletSpeed: 118,
      damage: 9,
      firstDelayTicks: 54,
      windupTicks: 30,
    },
    shape: 'escort',
  },

  /**
   * Infected plating off the station itself. Unarmed, 300 HP, and it vents
   * fourteen shards when it finally goes.
   *
   * The husk is the sector's HP tonnage and its cruellest joke: 2.5 seconds of
   * committed fire, paid off with the largest death burst in the game. It is the
   * one enemy here that *must* be dealt with at range, and a wave that pairs a
   * husk with a creeper is asking the pilot to hold a firing line while
   * something is actively taxing them for holding one.
   *
   * 12 scrap for 300 HP (25 HP per scrap) is deliberately terrible. Bloomfield
   * is the poorest sector in the run, which is what makes The Tally's route
   * choice mean something.
   */
  husk: {
    id: 'husk',
    name: 'Station Husk',
    hp: 300,
    radius: 24,
    contactDamage: 24,
    scrap: 12,
    movement: 'drift',
    movementParams: { speed: 38 },
    weapon: { kind: 'none', intervalTicks: 0, bulletSpeed: 0, damage: 0, firstDelayTicks: 0, windupTicks: 0 },
    shape: 'hauler',
    deathBurst: { count: 14, bulletSpeed: 100, damage: 6 },
  },

  /**
   * Sector 3's elite. 700 HP of parked ring source with an eighteen-shot burst
   * on death — the only enemy in the game whose most dangerous moment is the one
   * after you win.
   *
   * That is the sector's inversion taken to its conclusion. Everywhere else,
   * killing the elite ends the problem; here the kill *is* the problem, and a
   * pilot who dumps the last 200 HP into it from close range while celebrating
   * eats most of a shield. The burst is 110 u/s, so it is escapable from any
   * distance and near-unavoidable in contact, exactly like the mine's — the
   * lesson sector 1 taught with 12 HP, re-asked with 700.
   */
  bloomheart: {
    id: 'bloomheart',
    name: 'Bloom Heart',
    hp: 700,
    radius: 26,
    contactDamage: 28,
    scrap: 70,
    movement: 'hover',
    movementParams: { speed: 40, holdYFraction: 0.18, holdTicks: 900 },
    weapon: {
      kind: 'ring',
      intervalTicks: 114, // 1.9s
      bulletSpeed: 98,
      damage: 7,
      count: 14,
      firstDelayTicks: 96, // 1.6s
      windupTicks: 46,
    },
    shape: 'turret',
    elite: true,
    deathBurst: { count: 18, bulletSpeed: 110, damage: 7 },
  },

  // ---------------------------------------------------------------------------
  // Sector 4 — Kill Grid. An automated defence net.
  //
  // The grammar is that THE GRID IS IN THE SAME PLACE EVERY RUN. Every formation
  // in the sector script sets `atXFraction`, so nothing here is seeded — which
  // is what makes it a puzzle rather than a reflex test, and is the sharpest
  // structural break from Bloomfield, where almost nothing is placed.
  //
  // Its weapons are precise rather than dense: tight fans at high speed with the
  // longest telegraphs in the game. Nothing in this sector has a death burst.
  // The grid is clean; it does not leave residue, and after Bloomfield that
  // absence is itself information.
  // ---------------------------------------------------------------------------

  /**
   * The grid's basic emplacement: a five-shot rake over 18 degrees at 164 u/s.
   *
   * At that arc the pellets are ~0.3 hull-widths apart by the time they arrive,
   * so unlike every earlier fan there is nothing to step between. The cone is
   * simply forbidden, and the 44-tick (0.73s) telegraph is long enough to leave
   * it entirely. That is the sector's whole design contract: you are always told,
   * and being told is not the same as being safe.
   *
   * 200 HP is 1.43s at 140 dps — deliberately cheaper than sector 1's turret in
   * *time* despite being a worse threat, because the sector wants three or four
   * nodes alive at once forming a shape, not one node soaking the clip.
   */
  node: {
    id: 'node',
    name: 'Grid Node',
    hp: 200,
    radius: 14,
    contactDamage: 20,
    scrap: 16,
    movement: 'hover',
    movementParams: { speed: 70, holdYFraction: 0.21, holdTicks: 480 },
    weapon: {
      kind: 'spread',
      intervalTicks: 90, // 1.5s
      bulletSpeed: 164,
      damage: 8,
      count: 5,
      spreadDegrees: 18,
      firstDelayTicks: 66,
      windupTicks: 44,
    },
    shape: 'turret',
  },

  /**
   * The lattice piece. A twelve-shot ring at 128 u/s every 2.2 seconds.
   *
   * Bloomfield's pod fires a slow, frequent, messy ring; the pylon fires a fast,
   * rare, geometrically clean one, and pylons are always placed in symmetric
   * pairs. Two shells expanding from known positions intersect in a pattern the
   * pilot can learn and stand inside — the difference between the two sectors'
   * rings is not the number but that ONE OF THEM IS SOLVABLE IN ADVANCE.
   *
   * The 50-tick (0.83s) telegraph is the second-longest in the game. A shell you
   * cannot dodge sideways has to be dodged by being in the right place before it
   * exists.
   */
  pylon: {
    id: 'pylon',
    name: 'Interdiction Pylon',
    hp: 150,
    radius: 13,
    contactDamage: 20,
    scrap: 12,
    movement: 'hover',
    movementParams: { speed: 66, holdYFraction: 0.19, holdTicks: 600 },
    weapon: {
      kind: 'ring',
      intervalTicks: 132, // 2.2s
      bulletSpeed: 128,
      damage: 7,
      count: 12,
      firstDelayTicks: 90,
      windupTicks: 50,
    },
    shape: 'turret',
  },

  /**
   * The moving constraint. Crosses at 132 u/s firing a 10-degree three-shot
   * burst every 0.8 seconds, so it drags a forbidden column across the field.
   *
   * Where a node says "not here", a sweeper says "not here, and in one second
   * not there either". Between two sweepers moving opposite ways the safe space
   * is a shrinking wedge, which is the most puzzle-like thing the current
   * movement vocabulary can express.
   *
   * 120 HP (0.86s) because it must be killable *during* its pass. A sweeper that
   * survives its crossing has already done its job; one that survives two would
   * simply be a wall.
   */
  sweeper: {
    id: 'sweeper',
    name: 'Grid Sweeper',
    hp: 120,
    radius: 13,
    contactDamage: 22,
    scrap: 12,
    movement: 'strafe',
    movementParams: { speed: 132, holdYFraction: 0.17 },
    weapon: {
      kind: 'spread',
      intervalTicks: 48, // 0.8s — the fastest cadence in the game.
      bulletSpeed: 158,
      damage: 8,
      count: 3,
      spreadDegrees: 10,
      firstDelayTicks: 36,
      // 22 ticks (0.37s), the shortest telegraph outside sector 1's skiff. It has
      // to be: at 0.8s between volleys, anything longer is a tell that never
      // stops, and the windup budget caps it at 24 anyway.
      windupTicks: 22,
    },
    shape: 'lancer',
  },

  /**
   * The anti-camping measure, and the lancer's lesson made unforgiving.
   *
   * Identical in structure to sector 1's lancer — unarmed, parks, telegraphs,
   * dives — with every number moved against the pilot: 0.6s of warning instead
   * of 0.8, 510 u/s on the dive instead of 378, and 30 contact damage instead of
   * 24. Reusing the shape deliberately: the pilot already knows what a parked
   * diver means, and the sector's job is to punish assuming it means the same
   * thing it did an hour ago.
   *
   * It is unarmed for the same reason the lancer is. A snare that also shot
   * would make the telegraph one input among several instead of the only one
   * that matters, and this enemy is the sector's argument that reading a tell
   * correctly is a skill with a ceiling.
   */
  snare: {
    id: 'snare',
    name: 'Snare Drone',
    hp: 70,
    radius: 12,
    contactDamage: 30,
    scrap: 10,
    movement: 'swoop',
    movementParams: { speed: 150, holdYFraction: 0.18, holdTicks: 36, diveMultiplier: 3.4 },
    weapon: { kind: 'none', intervalTicks: 0, bulletSpeed: 0, damage: 0, firstDelayTicks: 0, windupTicks: 0 },
    shape: 'lancer',
  },

  /**
   * Sector 4's elite: 900 HP and a seven-shot 52-degree fan at 166 u/s, the
   * fastest projectile in the game.
   *
   * 6.4 seconds of committed fire at 140 dps — the longest single fight before
   * the boss, and it is placed where two pylons are already alive so that
   * committing to it means committing inside a known lattice. The fan is wide
   * *and* fast, which sector 1 explicitly refused to do (the heavy turret widens
   * without speeding up "so the answer is still footwork"). Here the answer is
   * footwork planned a second ahead, which is what the 52-tick telegraph is for.
   */
  arbiter: {
    id: 'arbiter',
    name: 'Arbiter Emplacement',
    hp: 900,
    radius: 27,
    contactDamage: 30,
    scrap: 90,
    movement: 'hover',
    movementParams: { speed: 40, holdYFraction: 0.18, holdTicks: 960 },
    weapon: {
      kind: 'spread',
      intervalTicks: 108, // 1.8s
      bulletSpeed: 166,
      damage: 9,
      count: 7,
      spreadDegrees: 52,
      firstDelayTicks: 108, // 1.8s: the longest first-shot delay in the game.
      windupTicks: 52,
    },
    shape: 'turret',
    elite: true,
  },

  // ---------------------------------------------------------------------------
  // Sector 5 — The Deep Manifest. The wreck you were actually sent for.
  //
  // The grammar is LAYERED THREAT ON ONE BODY. Sectors 1-4 each ask one question
  // per enemy; the Deep Manifest's enemies ask two at once — a diver that also
  // shoots, a wall that shoots and then bursts. Nothing here is a new *idea*, and
  // that is deliberate: the finale is the exam, and an exam that introduces
  // material is a bad exam.
  //
  // It also draws heavily on sector 1's roster, which is the one place in the
  // game where reuse is the point rather than a saving. The Deep Manifest is
  // where everything the company lost ends up, so it is full of the company's
  // oldest hardware — including the Heavy Turret, which was sector 1's set-piece
  // elite and is a common enemy here. Meeting it three at a time is the clearest
  // possible statement of how far the run has come.
  // ---------------------------------------------------------------------------

  /**
   * The armed diver. Parks, shoots, then dives — the first enemy in the game
   * that telegraphs two different attacks out of one body.
   *
   * Sector 1's lancer is unarmed precisely so its dive is the only thing to
   * read; the bailiff removes that courtesy. While it holds, its 20-tick muzzle
   * tell and its 54-tick dive tell are running at the same time and mean
   * opposite things: one says "move sideways", the other says "get out of this
   * column". A pilot who has only ever learned "parked diver = wait for the
   * dive" will stand in the aimed shot.
   *
   * 90 HP (0.56s at 160 dps) keeps it a decision rather than a duel. Contact 28
   * because, like the lancer, its whole threat is one avoidable event.
   */
  bailiff: {
    id: 'bailiff',
    name: 'Bailiff',
    hp: 90,
    radius: 14,
    contactDamage: 28,
    scrap: 14,
    movement: 'swoop',
    movementParams: { speed: 128, holdYFraction: 0.2, holdTicks: 54, diveMultiplier: 3.0 },
    weapon: {
      kind: 'aimed',
      intervalTicks: 66, // 1.1s: about one shot while parked, sometimes two.
      bulletSpeed: 148,
      damage: 8,
      firstDelayTicks: 48,
      windupTicks: 20,
    },
    shape: 'lancer',
  },

  /**
   * A derelict still running its last standing order. 420 HP, a five-shot fan,
   * and a twelve-shard burst when it dies.
   *
   * The sector's tonnage, and its clearest "two things at once": a revenant has
   * to be out-ranged while alive and out-positioned as it dies, and 2.6 seconds
   * of fire at 160 dps is long enough that where you are standing when it
   * finally goes is a decision made several seconds earlier.
   *
   * Structurally it is the husk and the turret welded together, which is the
   * finale's whole method — no new vocabulary, one more thing to hold in mind.
   */
  revenant: {
    id: 'revenant',
    name: 'Revenant Hulk',
    hp: 420,
    radius: 25,
    contactDamage: 28,
    scrap: 40,
    movement: 'drift',
    movementParams: { speed: 34 },
    weapon: {
      kind: 'spread',
      intervalTicks: 96, // 1.6s
      bulletSpeed: 138,
      damage: 8,
      count: 5,
      spreadDegrees: 40,
      firstDelayTicks: 78,
      windupTicks: 36,
    },
    shape: 'hauler',
    deathBurst: { count: 12, bulletSpeed: 118, damage: 7 },
  },

  /**
   * Elite. The wreck's caretaker: a sixteen-shot ring every two seconds from a
   * parked 820 HP body.
   *
   * Sixteen shots at 132 u/s is the densest single volley in the game, and it is
   * survivable only because it is a ring — the gaps are wide near the source's
   * own bearing and the pilot is nearly always outside it. It is placed early in
   * the sector rather than late because it is the encounter that teaches the
   * Deep Manifest's tempo: 5.1 seconds of committed fire while three other
   * things are happening.
   */
  quartermaster: {
    id: 'quartermaster',
    name: 'Quartermaster',
    hp: 820,
    radius: 26,
    contactDamage: 30,
    scrap: 90,
    movement: 'hover',
    movementParams: { speed: 42, holdYFraction: 0.18, holdTicks: 900 },
    weapon: {
      kind: 'ring',
      intervalTicks: 120, // 2s
      bulletSpeed: 132,
      damage: 8,
      count: 16,
      firstDelayTicks: 96,
      windupTicks: 54,
    },
    shape: 'turret',
    elite: true,
  },

  /**
   * Elite, and the only elite in the game that moves sideways.
   *
   * Every other elite parks or drifts down, so the fight happens in a column the
   * pilot chooses. The liquidator crosses at 58 u/s throwing a seven-shot
   * 66-degree fan, which means the fight happens in a column *it* chooses and
   * that column is always moving. 760 HP is 4.75s at 160 dps against roughly 8
   * seconds of crossing time: killable, but only by someone who commits early
   * and follows it.
   *
   * Contact 32 is the highest in the game, two under the sector-1 ceiling. A
   * moving elite is the one thing a pilot is most likely to back into.
   */
  liquidator: {
    id: 'liquidator',
    name: 'Liquidator',
    hp: 760,
    radius: 24,
    contactDamage: 32,
    scrap: 100,
    movement: 'strafe',
    movementParams: { speed: 58, holdYFraction: 0.17 },
    weapon: {
      kind: 'spread',
      intervalTicks: 90, // 1.5s
      bulletSpeed: 152,
      damage: 9,
      count: 7,
      spreadDegrees: 66,
      firstDelayTicks: 84,
      windupTicks: 42,
    },
    shape: 'escort',
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
