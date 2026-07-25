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
 */

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
   */
  hauler: {
    id: 'hauler',
    name: 'Hauler',
    hp: 30,
    radius: 22,
    contactDamage: 14,
    scrap: 4,
    movement: 'drift',
    movementParams: { speed: 42 },
    weapon: { kind: 'none', intervalTicks: 0, bulletSpeed: 0, damage: 0, firstDelayTicks: 0 },
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
      intervalTicks: 90, // 1.5s — one shot per skiff per screen-crossing quarter.
      bulletSpeed: 130,
      damage: 6,
      firstDelayTicks: 48,
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
   * holdYFraction 0.3 parks it at y=216, well clear of the hull's home position
   * at y=610, so the pause happens in plain sight rather than on top of you.
   * holdTicks 48 (0.8s) is the telegraph itself. diveMultiplier 3.2 turns speed
   * 118 into 378 units/second on the dive: it covers the ~390 units to the hull
   * in a little over a second, which is fast enough to feel committed and slow
   * enough that 0.8s of warning is genuinely sufficient.
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
    movementParams: { speed: 118, holdYFraction: 0.3, holdTicks: 48, diveMultiplier: 3.2 },
    weapon: { kind: 'none', intervalTicks: 0, bulletSpeed: 0, damage: 0, firstDelayTicks: 0 },
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
   * holdYFraction 0.22 puts it at y=158, high enough that its spread has room to
   * fan out and become dodgeable before it arrives. holdTicks 600 (10s) means it
   * eventually leaves rather than stalling the sector forever if the player is
   * struggling — a soft failure instead of a hard wall.
   *
   * A 3-shot spread over 30 degrees at speed 120: the fan is ~5 seconds of travel
   * to the hull, and at that range the 30-degree arc has opened wide enough to
   * step between the pellets. Narrower would be a shotgun; wider would be
   * indistinguishable from three unaimed shots.
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
      intervalTicks: 105, // 1.75s — a gap wide enough to reposition inside.
      bulletSpeed: 120,
      damage: 6,
      count: 3,
      spreadDegrees: 30,
      firstDelayTicks: 75, // 1.25s: the hover settles before the first volley.
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
    weapon: { kind: 'none', intervalTicks: 0, bulletSpeed: 0, damage: 0, firstDelayTicks: 0 },
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
   * and come back — the first time sector 1 asks for that. The 5-shot / 46-degree
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
