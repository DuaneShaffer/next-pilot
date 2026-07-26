/**
 * Boss definitions — one per sector.
 *
 * A boss is deliberately **not a new entity kind**. It is an enemy with phases, so
 * every movement and weapon behaviour `src/sim/enemies.ts` already interprets applies
 * unchanged, and authoring a boss does not mean editing the simulation — the same
 * rule that governs `enemies.ts`. What a boss adds is one thing: the definition it
 * reads its movement and weapon from is swapped when its health crosses a threshold.
 *
 * ## What the sim does, and the four rules it imposes on a phase
 *
 * Read out of `src/sim/enemies.ts` and `src/sim/bosses.ts` rather than assumed. Each
 * of these constrains what a phase is allowed to say, and each is enforced by
 * `tests/bosses.test.ts` because none of them is visible in a diff:
 *
 * 1. **`hover` with no `holdTicks` stays until killed.** No hover phase below sets
 *    `holdTicks` — on an ordinary turret it means "eventually leave", which on a boss
 *    is the fight walking away mid-phase. On a `swoop` the same field means something
 *    completely different (the pause before the dive), so there it is required.
 * 2. **`strafe` is unusable.** `keepBossInPlay` wraps a boss that leaves the *bottom*
 *    of the playfield back around to the top, which is what makes `swoop` and `drift`
 *    legal — a dive past the bottom edge reads as an attack run. Nothing wraps x, so
 *    a strafing boss crosses the lane and keeps going. The lane-crossing feel comes
 *    from `sine` **with `speed: 0`** instead: the sine branch derives x from the phase
 *    angle and sets `vy = speed`, so zero speed is a boss weaving around its spawn
 *    column forever, and it cannot exit.
 * 3. **The opening phase must be `hover`.** `sine` at zero speed never descends, so a
 *    boss whose first phase weaves would sit above the top of the playfield being shot
 *    at by nobody. `hover` is what makes the entrance.
 * 4. **A phase change resets `age`, and clamps the new hold height so it can never be
 *    above where the boss already is** (`restartMovement` in `src/sim/bosses.ts`).
 *    Both matter to content. `firstDelayTicks` is measured from age, so without the
 *    reset a long-lived boss would fire the instant a phase flipped — an unannounced
 *    volley layered on top of its own callout. And `sine` derives x from age, so
 *    entering a weave at an arbitrary age would teleport the boss sideways by up to a
 *    full amplitude. The hold-height clamp means a later phase asking to park
 *    *higher* is silently ignored rather than teleporting, which is the safe failure
 *    but still a phase that does not do what it says — so every hover phase of a
 *    given boss is authored at one height, and that is asserted.
 *
 * ## Health, and the arithmetic every HP number here comes from
 *
 * HP is chosen as **seconds of the player's attention**, the same way `enemies.ts`
 * chooses it, then converted. The player's output is not constant across a run, so
 * each boss is divided by the output expected at its own depth (`SECTOR_PLAYER_DPS`):
 *
 *   Repossessor    1700 / 80 dps  = 21.3 s
 *   Auditor        2600 / 100 dps = 26.0 s
 *   Unlisted Tenant 3400 / 120 dps = 28.3 s
 *   Bailiff        4200 / 140 dps = 30.0 s
 *   Deep Manifest  5800 / 160 dps = 36.3 s
 *
 * Those are **full-uptime** figures, matching the convention `enemies.ts` states
 * ("if every shot connects"). Real fights are longer: at a realistic 80% trigger
 * uptime against a target that has to be dodged, the same five are 26.6 s, 32.5 s,
 * 35.4 s, 37.5 s and 45.3 s. The final boss approaching three quarters of a minute is
 * the outer edge of what a 15–20 minute run can spend on one fight, and it is the
 * first number a sweep should question.
 *
 * ## Phases are announced, and long enough to be read
 *
 * Every phase carries a `callout`, because an unannounced phase shift is unfair
 * rather than difficult — the player is being asked to relearn a pattern with no
 * signal that the pattern changed. The callout states the mechanic, not a mood:
 * `docs/UI.md` rule 4 governs functional text and boss-phase callouts are explicitly
 * permitted over the playfield by rule 1, which is a licence to be legible, not to be
 * clever.
 *
 * The thresholds are chosen so **no phase is shorter than 6 seconds** at the stated
 * output. A phase the player cannot finish reading is noise wearing a mechanic's
 * clothes, and `tests/bosses.test.ts` computes each phase's span in seconds and
 * enforces the floor.
 *
 * ## Telegraphs
 *
 * `windupTicks` is real reaction time and every boss weapon has one. The budget rule
 * `enemies.ts` uses is kept here too — **a windup is always under half its own
 * `intervalTicks`** — because a boss that is always winding up has a warning light
 * that is never off. The longest telegraph in the game is the Bailiff's 70 ticks
 * (1.17 s), which is the Kill Grid's whole character: telegraphed and unforgiving.
 *
 * ## Seeded variants
 *
 * The later three bosses each carry at least one variant that replaces a **middle**
 * phase, so a player who has learned the fight opens it identically and then has to
 * read what happens next. The opening and the final phase are shared with the base
 * form on purpose: the variant is the same boss with a different second act, not a
 * different boss. The first two bosses have one form each, deliberately — they are
 * where the grammar of a boss fight is taught, and variance in a teaching fight is
 * indistinguishable from the player not having understood it the first time.
 */

import { PLAYFIELD_H, PLAYFIELD_W } from '../core/space'
import type { BossDef, BossPhaseDef } from './types'

/**
 * The player's damage per second at each sector, sector 1 first.
 *
 * 80 is measured: the base weapon is 20 shots/second at 4 damage. The rest are the
 * planning figures M5 is authored against — roughly 1.5x base by sector 3 and 2x by
 * sector 5, which is what a run that takes most of its item offers looks like. They
 * are assumptions, and they are the assumption a bot sweep is most likely to correct,
 * so every boss's HP is quoted against its entry here rather than against a number
 * buried in a comment.
 */
export const SECTOR_PLAYER_DPS: readonly number[] = [80, 100, 120, 140, 160]

/**
 * The band a boss fight's time-to-kill must fall inside, at full uptime.
 *
 * Under 20 s and the phases cannot each get their six seconds; over 40 s and one
 * fight is eating a quarter of the 15–20 minute run `docs/DESIGN.md` budgets.
 */
export const BOSS_TTK_BAND = { minSeconds: 20, maxSeconds: 40 } as const

/**
 * The shortest a phase may last, in seconds at the sector's expected output.
 *
 * Six seconds is roughly two volleys of the slowest boss weapon plus the time to read
 * the callout. Below that the player experiences a pattern change as a random hit.
 */
export const MIN_PHASE_SECONDS = 6

/**
 * Longest a callout may be, in characters.
 *
 * The playfield is 448 units wide and the callout is drawn across it at ~16 units;
 * every font in the stack advances at ~0.62 em, so 448 / (16 x 0.62) is about 45
 * characters on one line. 44 keeps a character of margin. A callout that wraps or
 * clips is a phase change the player did not read, which defeats the entire reason
 * phases are announced.
 */
export const BOSS_CALLOUT_MAX_CHARS = 44

/**
 * Clearance a parked boss must leave above the line a forward-playing pilot flies.
 *
 * Deliberately the same rule `enemies.ts` applies to every parked enemy, via the same
 * constants: a pilot pushing forward sits around y = 230, and anything parked lower
 * than that minus its own radius delivers its telegraph *after* the collision. A boss
 * is the last thing that should be exempt — it is the fight the player is most likely
 * to press into. Every `hover` phase below holds above this line, and
 * `tests/bosses.test.ts` checks it against `maxParkedY` from `enemies.ts` rather than
 * against a copy of the number.
 */
export const BOSS_PARK_LINE_Y = 0.32 * PLAYFIELD_H

// ---------------------------------------------------------------------------
// sector 3 — Unlisted Tenant. Phases are named because two of them are shared
// with the variant, and sharing them by reference is what makes "same boss,
// different middle act" structurally true rather than a claim in a comment.
// ---------------------------------------------------------------------------

const TENANT_HOLD_Y_FRACTION = 0.16

const TENANT_OPENING: BossPhaseDef = {
  fromHealthFraction: 1,
  movement: 'hover',
  movementParams: { speed: 54, holdYFraction: TENANT_HOLD_Y_FRACTION },
  weapon: {
    kind: 'ring',
    // Nine, an odd count, so the ring has no mirror symmetry and the gaps do not line
    // up with the lanes the player has been using for two sectors. Bloomfield's
    // grammar is "irregular patterns that punish standing still" and an even ring is
    // the most regular thing a boss can fire.
    count: 9,
    intervalTicks: 138,
    bulletSpeed: 96,
    damage: 9,
    firstDelayTicks: 114,
    windupTicks: 40,
  },
  callout: 'Bloom responding. Spores in nine directions.',
}

const TENANT_CREEP: BossPhaseDef = {
  fromHealthFraction: 0.6,
  // Weaving, at zero descent — the mass spreads sideways across the lane.
  movement: 'sine',
  movementParams: { speed: 0, amplitude: 130, frequency: 0.3 },
  weapon: {
    // The sector's thesis in one weapon: a tracker keeps its heading, so it is never
    // unavoidable and always an instruction to move.
    kind: 'tracker',
    intervalTicks: 66,
    bulletSpeed: 100,
    damage: 9,
    firstDelayTicks: 72,
    windupTicks: 30,
  },
  secondary: {
    kind: 'ring',
    count: 7,
    intervalTicks: 186,
    bulletSpeed: 88,
    damage: 8,
    firstDelayTicks: 126,
    windupTicks: 44,
  },
  callout: 'Creeping wide. Standing still is punished.',
}

/**
 * The variant middle: the opposite problem to `TENANT_CREEP`.
 *
 * Anchored instead of roaming, and it walls the lane with a dense slow ring rather
 * than chasing the pilot with trackers. A player who learned to keep moving through
 * the creep phase has to learn to stop and thread instead, which is what a variant is
 * for — the same fight asking a different question in the same slot.
 */
const TENANT_SPOREBED: BossPhaseDef = {
  fromHealthFraction: 0.6,
  movement: 'hover',
  movementParams: { speed: 54, holdYFraction: TENANT_HOLD_Y_FRACTION },
  weapon: {
    kind: 'ring',
    // 18 points is 20 degrees apart: at 76 u/s the wall arrives slowly enough to read
    // and the gaps are ~26 units at 75 units of range, against a 5.5-unit hitbox.
    count: 18,
    intervalTicks: 174,
    bulletSpeed: 76,
    damage: 7,
    firstDelayTicks: 90,
    windupTicks: 48,
  },
  secondary: {
    // The fast lance is what stops the slow wall being a free phase: threading the
    // ring while an aimed shot is inbound is the actual ask.
    kind: 'aimed',
    intervalTicks: 78,
    bulletSpeed: 150,
    damage: 10,
    firstDelayTicks: 66,
    windupTicks: 26,
  },
  callout: 'Spore bed open. Slow wall, fast lance.',
}

const TENANT_COLLAPSE: BossPhaseDef = {
  fromHealthFraction: 0.25,
  movement: 'hover',
  movementParams: { speed: 54, holdYFraction: TENANT_HOLD_Y_FRACTION },
  weapon: {
    kind: 'spread',
    count: 7,
    spreadDegrees: 70,
    intervalTicks: 120,
    bulletSpeed: 118,
    damage: 8,
    firstDelayTicks: 72,
    windupTicks: 44,
  },
  secondary: {
    kind: 'ring',
    count: 12,
    intervalTicks: 210,
    bulletSpeed: 104,
    damage: 8,
    firstDelayTicks: 138,
    windupTicks: 46,
  },
  callout: 'Bloom collapsing. Seven-shot spray.',
}

// ---------------------------------------------------------------------------
// sector 4 — Bailiff
// ---------------------------------------------------------------------------

const BAILIFF_HOLD_Y_FRACTION = 0.175

const BAILIFF_OPENING: BossPhaseDef = {
  fromHealthFraction: 1,
  movement: 'hover',
  movementParams: { speed: 58, holdYFraction: BAILIFF_HOLD_Y_FRACTION },
  weapon: {
    kind: 'ring',
    // Twenty points, 18 degrees apart, on a three-second cycle with a 1.17-second
    // tell. The Kill Grid is "precise laser geometry, telegraphed and unforgiving":
    // the pattern is completely knowable in advance and completely unsurvivable if
    // ignored, which is a puzzle rather than a reflex test.
    count: 20,
    intervalTicks: 180,
    bulletSpeed: 120,
    damage: 9,
    firstDelayTicks: 132,
    windupTicks: 70,
  },
  callout: 'Grid armed. Twenty-point ring every 3 s.',
}

const BAILIFF_LATTICE: BossPhaseDef = {
  fromHealthFraction: 0.55,
  movement: 'hover',
  movementParams: { speed: 58, holdYFraction: BAILIFF_HOLD_Y_FRACTION },
  weapon: {
    kind: 'spread',
    // Nine shots across 80 degrees is 10 degrees a lane. The count is odd so one shot
    // is always dead on the aim line and standing still is never the answer — the
    // even-count mistake `enemies.ts` measured on the turret and reverted.
    count: 9,
    spreadDegrees: 80,
    intervalTicks: 144,
    bulletSpeed: 132,
    damage: 8,
    firstDelayTicks: 84,
    windupTicks: 60,
  },
  secondary: {
    kind: 'ring',
    count: 12,
    intervalTicks: 300,
    bulletSpeed: 96,
    damage: 8,
    firstDelayTicks: 168,
    windupTicks: 66,
  },
  callout: 'Lattice fire. Nine-lane fan, pick a gap.',
}

/**
 * The variant middle: continuous pressure instead of periodic geometry.
 *
 * The base lattice phase is a positional puzzle solved once every 2.4 seconds. The
 * interdiction sweep is a 1.3-second tracker cadence that never lets the pilot settle,
 * with a slow five-shot fan behind it. Same slot, opposite tempo.
 */
const BAILIFF_INTERDICT: BossPhaseDef = {
  fromHealthFraction: 0.55,
  movement: 'hover',
  movementParams: { speed: 58, holdYFraction: BAILIFF_HOLD_Y_FRACTION },
  weapon: {
    kind: 'tracker',
    intervalTicks: 78,
    bulletSpeed: 108,
    damage: 8,
    firstDelayTicks: 72,
    windupTicks: 32,
  },
  secondary: {
    kind: 'spread',
    count: 5,
    spreadDegrees: 30,
    intervalTicks: 156,
    bulletSpeed: 140,
    damage: 9,
    firstDelayTicks: 108,
    windupTicks: 48,
  },
  callout: 'Interdiction sweep. Constant tracker fire.',
}

const BAILIFF_DESTABILISED: BossPhaseDef = {
  fromHealthFraction: 0.22,
  // The node comes loose from the grid: a narrow weave, so the rings no longer
  // originate from a fixed point the player has been memorising.
  movement: 'sine',
  movementParams: { speed: 0, amplitude: 70, frequency: 0.35 },
  weapon: {
    kind: 'ring',
    // 24 points is 15 degrees apart — gaps of ~26 units at 100 units of range, which
    // is threadable at distance and lethal point-blank. That is the correct shape for
    // a final phase: it enforces range on a player who wants the kill.
    count: 24,
    intervalTicks: 150,
    bulletSpeed: 130,
    damage: 9,
    firstDelayTicks: 78,
    windupTicks: 64,
  },
  secondary: {
    kind: 'tracker',
    intervalTicks: 96,
    bulletSpeed: 115,
    damage: 10,
    firstDelayTicks: 120,
    windupTicks: 34,
  },
  callout: 'Node loose. Rings and tracker fire.',
}

// ---------------------------------------------------------------------------
// sector 5 — The Deep Manifest. Four phases, two variants; the fight the whole
// run is pointed at earns the extra act and the extra unpredictability.
// ---------------------------------------------------------------------------

const MANIFEST_HOLD_Y_FRACTION = 0.15

const MANIFEST_OPENING: BossPhaseDef = {
  fromHealthFraction: 1,
  movement: 'hover',
  movementParams: { speed: 52, holdYFraction: MANIFEST_HOLD_Y_FRACTION },
  weapon: {
    kind: 'spread',
    count: 7,
    spreadDegrees: 60,
    intervalTicks: 120,
    bulletSpeed: 130,
    damage: 9,
    firstDelayTicks: 126,
    windupTicks: 46,
  },
  secondary: {
    kind: 'ring',
    count: 12,
    intervalTicks: 258,
    bulletSpeed: 100,
    damage: 8,
    firstDelayTicks: 174,
    windupTicks: 50,
  },
  callout: 'Manifest located. Fans, then a ring.',
}

const MANIFEST_BREACH: BossPhaseDef = {
  fromHealthFraction: 0.72,
  movement: 'sine',
  movementParams: { speed: 0, amplitude: 120, frequency: 0.28 },
  weapon: {
    kind: 'ring',
    count: 18,
    intervalTicks: 138,
    bulletSpeed: 112,
    damage: 9,
    firstDelayTicks: 78,
    windupTicks: 44,
  },
  secondary: {
    kind: 'aimed',
    intervalTicks: 84,
    bulletSpeed: 155,
    damage: 11,
    firstDelayTicks: 108,
    windupTicks: 26,
  },
  callout: 'Hold breached. It is moving in the lane.',
}

/**
 * The certified variant middle. `src/content/certifications.ts` unlocks this by id
 * from the Extraction Certificate and describes it to the player as "the Warden seals
 * the lane in sections", so the phase has to actually do that: an eleven-shot fan
 * across 96 degrees is a wall with gaps, thrown slowly enough (2.8 s, with a 1.03 s
 * tell) that finding the gap is the whole activity.
 *
 * If this phase is ever retuned into something that is not lane-sealing, the
 * certification's copy becomes wrong — which is a UI defect, not a balance one.
 */
const MANIFEST_WARDEN_SEAL: BossPhaseDef = {
  fromHealthFraction: 0.72,
  movement: 'hover',
  movementParams: { speed: 52, holdYFraction: MANIFEST_HOLD_Y_FRACTION },
  weapon: {
    kind: 'spread',
    count: 11,
    spreadDegrees: 96,
    intervalTicks: 168,
    bulletSpeed: 120,
    damage: 8,
    firstDelayTicks: 96,
    windupTicks: 62,
  },
  secondary: {
    kind: 'ring',
    count: 8,
    intervalTicks: 264,
    bulletSpeed: 90,
    damage: 8,
    firstDelayTicks: 156,
    windupTicks: 54,
  },
  callout: 'Warden sealing the lane. One gap at a time.',
}

const MANIFEST_HOSTILE_CARGO: BossPhaseDef = {
  fromHealthFraction: 0.44,
  movement: 'hover',
  movementParams: { speed: 52, holdYFraction: MANIFEST_HOLD_Y_FRACTION },
  weapon: {
    kind: 'tracker',
    intervalTicks: 72,
    bulletSpeed: 118,
    damage: 10,
    firstDelayTicks: 84,
    windupTicks: 32,
  },
  secondary: {
    kind: 'spread',
    count: 9,
    spreadDegrees: 72,
    intervalTicks: 150,
    bulletSpeed: 138,
    damage: 9,
    firstDelayTicks: 120,
    windupTicks: 52,
  },
  callout: 'Cargo hostile. Trackers and wide fans.',
}

/**
 * The second variant, replacing the third phase rather than the second.
 *
 * Varying a *different* slot is the point: a player who has seen the Warden knows the
 * second act can change and will be reading for it. Moving the variance one phase
 * later means the fight is never fully solved, which is the whole justification for
 * seeded variants over a fixed script.
 *
 * A 0.8-second aimed cadence at 160 u/s is the fastest sustained fire any boss puts
 * out. It is survivable because it is *aimed* — one shot, one direction, always
 * dodgeable by moving — and because the 20-tick tell is still a third of a second.
 */
const MANIFEST_LIQUIDATION: BossPhaseDef = {
  fromHealthFraction: 0.44,
  movement: 'hover',
  movementParams: { speed: 52, holdYFraction: MANIFEST_HOLD_Y_FRACTION },
  weapon: {
    kind: 'aimed',
    intervalTicks: 48,
    bulletSpeed: 160,
    damage: 8,
    firstDelayTicks: 66,
    windupTicks: 20,
  },
  secondary: {
    kind: 'ring',
    count: 16,
    intervalTicks: 192,
    bulletSpeed: 104,
    damage: 9,
    firstDelayTicks: 132,
    windupTicks: 48,
  },
  callout: 'Liquidation order. Rapid aimed fire.',
}

/**
 * The last act, and the only phase in the game that leaves the top of the playfield
 * and comes back.
 *
 * `swoop` pauses at the hold line for `holdTicks` and then accelerates downward; the
 * sim's `keepBossInPlay` wraps it around from the top rather than culling it, so the
 * phase reads as repeated attack runs. That is the sector-1 Lancer's lesson — read
 * the telegraph — restated at the scale of the thing the whole run was pointed at,
 * which is the right note for a final phase: nothing new to learn, everything to
 * execute.
 *
 * 54 ticks (0.9 s) of pause is slightly longer than the Lancer's 48, because the
 * object committing to the dive is four times the radius and the pilot needs to clear
 * a lane rather than step aside. `diveMultiplier` 2.8 turns speed 96 into 269 u/s —
 * faster than the 210 u/s hull, so the dive cannot be out-run vertically and has to
 * be dodged sideways, and well short of the Lancer's 378 because a 54-unit hull
 * crossing at that speed is not a dodge, it is a coin flip.
 */
const MANIFEST_CLOSING: BossPhaseDef = {
  fromHealthFraction: 0.18,
  movement: 'swoop',
  movementParams: {
    speed: 96,
    holdYFraction: MANIFEST_HOLD_Y_FRACTION,
    holdTicks: 54,
    diveMultiplier: 2.8,
  },
  weapon: {
    kind: 'ring',
    // Thinned from the 22-point ring an anchored phase could afford: the hull is now
    // moving through the playfield, so the ring plus the boss's own body is already
    // most of the difficulty.
    count: 16,
    intervalTicks: 126,
    bulletSpeed: 128,
    damage: 10,
    firstDelayTicks: 72,
    windupTicks: 42,
  },
  secondary: {
    kind: 'tracker',
    intervalTicks: 72,
    bulletSpeed: 120,
    damage: 10,
    firstDelayTicks: 108,
    windupTicks: 30,
  },
  callout: 'Manifest closing. It is making runs now.',
}

export const BOSSES: Record<string, BossDef> = {
  /**
   * SECTOR 1 — Debris Shelf. "Sparse, slow projectiles. Teaches pattern reading."
   *
   * 1700 HP is 21.3 seconds at the base 80 dps, the shortest fight in the game, and
   * it is short because it is the first boss the player has ever seen. Every weapon
   * on it is a *position* problem rather than an aim problem: a slow ring, then a
   * ring from a moving source, then a fan. Nothing here is faster than 130 u/s, so
   * the 210 u/s hull out-runs all of it and every death is legible as a mistake —
   * the same promise the sector's regular enemies make.
   *
   * Contact damage 30 sits under `SECTOR_ONE_MAX_CONTACT_DAMAGE` (35), which is a
   * quarter of a baseline hull. A boss that could two-shot a first-time player by
   * touching them would teach that the game is arbitrary.
   *
   * One form, no variants: this is the fight that teaches what a boss fight *is*.
   */
  repossessor: {
    id: 'repossessor',
    name: 'The Repossessor',
    hp: 1700,
    radius: 44,
    contactDamage: 30,
    scrap: 120,
    shape: 'hauler',
    phases: [
      {
        fromHealthFraction: 1,
        movement: 'hover',
        movementParams: { speed: 60, holdYFraction: 0.17 },
        weapon: {
          kind: 'ring',
          // Ten points at 88 u/s on a 2.8-second cycle. The slowest, sparsest boss
          // pattern in the game: 36 degrees between shots is a gap the player can
          // walk through rather than thread.
          count: 10,
          intervalTicks: 168,
          bulletSpeed: 88,
          damage: 8,
          firstDelayTicks: 120,
          windupTicks: 42,
        },
        callout: 'Repossessor holding. Slow rings, wide gaps.',
      },
      {
        fromHealthFraction: 0.62,
        movement: 'sine',
        movementParams: { speed: 0, amplitude: 96, frequency: 0.16 },
        weapon: {
          kind: 'ring',
          count: 12,
          intervalTicks: 150,
          bulletSpeed: 92,
          damage: 8,
          firstDelayTicks: 72,
          windupTicks: 40,
        },
        secondary: {
          // The first aimed shot the boss takes, introduced only once the player has
          // had eight seconds of pure pattern reading. Lesson order matters as much
          // here as it does across the sector's regular enemies.
          kind: 'aimed',
          intervalTicks: 96,
          bulletSpeed: 130,
          damage: 9,
          firstDelayTicks: 108,
          windupTicks: 30,
        },
        callout: 'Plating shed. It moves, and it aims now.',
      },
      {
        // 0.30 rather than 0.28: at 1700 HP against 80 dps the last 28% is 5.95
        // seconds, which is under the six-second floor a phase needs to be read.
        // The shortest fight in the game has the least room, so its thresholds are
        // the ones the floor actually binds.
        fromHealthFraction: 0.3,
        movement: 'hover',
        movementParams: { speed: 60, holdYFraction: 0.17 },
        weapon: {
          kind: 'spread',
          count: 5,
          spreadDegrees: 52,
          intervalTicks: 108,
          bulletSpeed: 125,
          damage: 9,
          firstDelayTicks: 66,
          windupTicks: 40,
        },
        secondary: {
          kind: 'ring',
          count: 14,
          intervalTicks: 240,
          bulletSpeed: 100,
          damage: 7,
          firstDelayTicks: 132,
          windupTicks: 46,
        },
        callout: 'Cargo bay venting. Wide fans and rings.',
      },
    ],
  },

  /**
   * SECTOR 2 — The Tally. "Corporate convoy lanes. Turrets and escorts, high scrap
   * yield. Greed vs safety."
   *
   * 2600 HP is 26.0 seconds at the 100 dps a sector-2 build should be running. The
   * fight is built out of the sector's own two enemy types read at boss scale: the
   * turret's aimed fan in the opening, the escort's tracker in the middle.
   *
   * 340 scrap is the largest payout before sector 5 and about eleven Heavy Turrets'
   * worth. The Tally is where the run's economy is decided, and the boss has to be
   * the sector's biggest single decision rather than a wall standing between the
   * player and the exit.
   *
   * One form. Two teaching fights before variants begin.
   */
  auditor: {
    id: 'auditor',
    name: 'The Auditor',
    hp: 2600,
    radius: 40,
    contactDamage: 28,
    scrap: 340,
    shape: 'escort',
    phases: [
      {
        fromHealthFraction: 1,
        movement: 'hover',
        movementParams: { speed: 66, holdYFraction: 0.18 },
        weapon: {
          kind: 'spread',
          count: 5,
          spreadDegrees: 44,
          intervalTicks: 114,
          bulletSpeed: 128,
          damage: 8,
          firstDelayTicks: 108,
          windupTicks: 42,
        },
        callout: 'Audit opened. Five-shot fans, aimed at you.',
      },
      {
        fromHealthFraction: 0.58,
        movement: 'sine',
        movementParams: { speed: 0, amplitude: 110, frequency: 0.22 },
        weapon: {
          kind: 'tracker',
          intervalTicks: 90,
          bulletSpeed: 110,
          damage: 10,
          firstDelayTicks: 78,
          windupTicks: 34,
        },
        secondary: {
          kind: 'spread',
          count: 3,
          spreadDegrees: 26,
          intervalTicks: 132,
          bulletSpeed: 134,
          damage: 8,
          firstDelayTicks: 120,
          windupTicks: 36,
        },
        callout: 'Escort pattern. Trackers on your position.',
      },
      {
        fromHealthFraction: 0.24,
        movement: 'hover',
        movementParams: { speed: 66, holdYFraction: 0.18 },
        weapon: {
          kind: 'ring',
          count: 16,
          intervalTicks: 132,
          bulletSpeed: 108,
          damage: 8,
          firstDelayTicks: 72,
          windupTicks: 44,
        },
        secondary: {
          kind: 'aimed',
          intervalTicks: 72,
          bulletSpeed: 140,
          damage: 9,
          firstDelayTicks: 96,
          windupTicks: 28,
        },
        callout: 'Discrepancy found. Ring fire, aimed lance.',
      },
    ],
  },

  /**
   * SECTOR 3 — Bloomfield. "Something organic has taken a dead station. Corrosive,
   * spreading, irregular patterns that punish standing still."
   *
   * 3400 HP is 28.3 seconds at 120 dps. Radius 50 makes it the second largest thing
   * in the game and the `mine` silhouette is the only round one available, which is
   * as close to organic as `EnemyShape` currently reaches.
   *
   * The first boss with a variant. Both middles are eleven seconds long and they ask
   * opposite questions — keep moving, or stop and thread — so the coin flip changes
   * what the player is practising rather than how hard it is.
   */
  tenant: {
    id: 'tenant',
    name: 'Unlisted Tenant',
    hp: 3400,
    radius: 50,
    contactDamage: 32,
    scrap: 320,
    shape: 'mine',
    phases: [TENANT_OPENING, TENANT_CREEP, TENANT_COLLAPSE],
    variants: [
      {
        id: 'tenant-sporebed',
        name: 'Unlisted Tenant — Spore Bed',
        phases: [TENANT_OPENING, TENANT_SPOREBED, TENANT_COLLAPSE],
      },
    ],
  },

  /**
   * SECTOR 4 — Kill Grid. "Automated defence net. Precise laser geometry, telegraphed
   * and unforgiving. Positional, almost puzzle-like."
   *
   * 4200 HP is 30.0 seconds at 140 dps. Every telegraph on this boss is at least a
   * full second — 70, 60 and 64 ticks on the primaries — which is double anything the
   * other four throw, and the patterns are correspondingly unforgiving: twenty and
   * twenty-four point rings, and a nine-lane fan. The fight is entirely knowable in
   * advance and entirely lethal to a pilot who is improvising, which is what
   * "puzzle-like" has to mean mechanically.
   *
   * Contact damage 34 is the highest of the first four bosses. A defence node is the
   * one boss that should punish being crowded.
   */
  bailiff: {
    id: 'bailiff',
    name: 'The Bailiff',
    hp: 4200,
    radius: 42,
    contactDamage: 34,
    scrap: 380,
    shape: 'turret',
    phases: [BAILIFF_OPENING, BAILIFF_LATTICE, BAILIFF_DESTABILISED],
    variants: [
      {
        id: 'bailiff-interdict',
        name: 'The Bailiff — Interdiction',
        phases: [BAILIFF_OPENING, BAILIFF_INTERDICT, BAILIFF_DESTABILISED],
      },
    ],
  },

  /**
   * SECTOR 5 — The Deep Manifest. "The wreck you were actually sent for."
   *
   * 5800 HP is 36.3 seconds at 160 dps, and closer to 45 at a realistic 80% uptime.
   * That is the longest single engagement in the game by a wide margin and it is
   * deliberate — it is the run's destination — but it is also the number most likely
   * to be wrong, and the one a sweep should look at first.
   *
   * Four phases rather than three, at 10.2 s, 10.2 s, 9.4 s and 6.5 s. Two variants,
   * replacing *different* slots: once a player has met the Warden they know the
   * second act can change, so the Liquidator moves the surprise to the third and the
   * fight never settles into a solved script.
   *
   * 600 scrap is nearly twice the Bailiff's. There is nothing after this to spend it
   * on, which is the point: a player who reaches the extraction with scrap in hand
   * has been playing too carefully, and the payout exists to make the last shop
   * before it worth emptying.
   */
  'deep-manifest': {
    id: 'deep-manifest',
    name: 'The Deep Manifest',
    hp: 5800,
    radius: 54,
    contactDamage: 36,
    scrap: 600,
    shape: 'lancer',
    phases: [MANIFEST_OPENING, MANIFEST_BREACH, MANIFEST_HOSTILE_CARGO, MANIFEST_CLOSING],
    variants: [
      {
        // Id fixed by `src/content/certifications.ts`, which grants exactly this
        // string from the Extraction Certificate. Renaming it silently disconnects a
        // shipped unlock, so `tests/bosses.test.ts` asserts every bossVariants grant
        // resolves to a variant that exists.
        id: 'manifest-warden',
        name: 'The Warden',
        phases: [MANIFEST_OPENING, MANIFEST_WARDEN_SEAL, MANIFEST_HOSTILE_CARGO, MANIFEST_CLOSING],
      },
      {
        id: 'manifest-liquidator',
        name: 'The Liquidator',
        phases: [MANIFEST_OPENING, MANIFEST_BREACH, MANIFEST_LIQUIDATION, MANIFEST_CLOSING],
      },
    ],
  },
}

/**
 * Bosses in sector order, sector 1 first.
 *
 * A separate list rather than relying on object key order, because `RunStageDef.bossId`
 * is authored per stage and the mapping from sector to boss has to be readable in one
 * place. The index into this list is also the index into `SECTOR_PLAYER_DPS`, which is
 * what makes every time-to-kill in this file checkable.
 */
export const BOSS_ORDER: readonly string[] = [
  'repossessor',
  'auditor',
  'tenant',
  'bailiff',
  'deep-manifest',
]

/** Seconds to kill a boss at the output expected in its sector, at full uptime. */
export function bossTimeToKillSeconds(bossId: string): number {
  const index = BOSS_ORDER.indexOf(bossId)
  if (index < 0) throw new Error(`Boss is not in BOSS_ORDER: ${bossId}`)
  const dps = SECTOR_PLAYER_DPS[index]
  if (dps === undefined || dps <= 0) throw new Error(`No player dps for sector ${index + 1}`)
  return getBoss(bossId).hp / dps
}

/**
 * The widest a `sine` phase may weave and still keep the hull on the playfield,
 * assuming the boss spawns centred.
 *
 * Content cannot see the spawn column — that belongs to whatever places the boss — so
 * this is stated as the assumption it is, and the test checks every amplitude against
 * it. A boss that weaves off the edge is invulnerable for part of its cycle.
 */
export const MAX_WEAVE_AMPLITUDE = PLAYFIELD_W / 2

/**
 * Look up a boss definition, throwing on an unknown id.
 *
 * Same contract as `getItem`, `getEnemy` and `getHull`, including the `Object.hasOwn`
 * guard: a plain index lookup resolves `constructor` and `toString` to inherited
 * members of `Object.prototype` and hands back a function typed as a `BossDef`.
 */
export function getBoss(id: string): BossDef {
  if (!Object.hasOwn(BOSSES, id)) throw new Error(`Unknown boss id: ${id}`)
  return BOSSES[id] as BossDef
}
