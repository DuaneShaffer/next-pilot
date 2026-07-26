/**
 * Sector definitions.
 *
 * A sector is a *script*, not a spawn table. Waves are placed at explicit
 * seconds rather than generated from a difficulty number, because the whole
 * point of sector 1 is that it teaches in a fixed order: nothing shoots until
 * the player can aim, nothing dives until the player has seen bullets, nothing
 * stacks until each piece is recognisable alone. A random generator cannot
 * guarantee that ordering, so this file is hand-authored and the randomness is
 * confined to where formations appear (`atXFraction` left unset) rather than
 * what appears.
 *
 * Difficulty is tracked as *total spawned HP per 30-second bucket*, which is a
 * crude but honest proxy for how much of the player's attention a stretch
 * demands. `tests/content.test.ts` asserts that curve never dips. If a wave edit
 * breaks it, the wave script is wrong — not the test.
 *
 * ## The five-sector curve
 *
 * Escalation has to happen *between* sectors as well as inside them, and the
 * pilot's output is rising at the same time, so raw HP totals are meaningless on
 * their own. The number that is compared across sectors is **load**: spawned HP
 * per second divided by the damage output a pilot is assumed to have by then
 * (80 / 96 / 120 / 140 / 160 dps — see the note at the top of `enemies.ts`).
 *
 *   1  Debris Shelf      180s   5,622 HP   31 HP/s   39% load
 *   2  The Tally         180s   8,820 HP   49 HP/s   51%
 *   3  Bloomfield        180s  11,678 HP   65 HP/s   54%
 *   4  Kill Grid         180s  14,170 HP   79 HP/s   56%
 *   5  The Deep Manifest 210s  19,560 HP   93 HP/s   58%
 *
 * The big step is sector 1 to 2 (39% to 51%) and the steps after it are small,
 * which is deliberate and is the most arguable decision in this file. The
 * reasoning: sector 1 is a tutorial and is *supposed* to be clearable ~92% of
 * the time, so the first boundary is where the game stops being one. After that,
 * pushing load toward 70% would not make the run harder in an interesting way —
 * it would make it a DPS check, and a pilot whose build did not come together
 * would simply be unable to clear the screen regardless of how well they flew.
 * The escalation from 2 to 5 is carried instead by things HP cannot express:
 * projectile speed (146 -> 118 -> 166 -> 152), volley density (3 shots -> 14 ->
 * 12 -> 16), how much of the attack is aimed at the pilot versus at the
 * playfield, and how many separate threats a single body presents.
 *
 * Total run: 930 seconds of combat across five sectors, which with work-order
 * screens and five boss fights lands inside DESIGN.md's 15–20 minute target.
 */

import type { RunDef, RunStageDef, SectorDef } from './types'

/**
 * Sector 1 — Debris Shelf.
 *
 * Sparse, slow projectiles, six enemy types each introduced in isolation before
 * being combined. `docs/DESIGN.md` calls it "the tutorial that isn't labelled a
 * tutorial", and the structural commitment behind that is: **every mechanic gets
 * a wave where it is the only thing on screen.**
 *
 * Total HP by 30s bucket: 288 / 414 / 790 / 1068 / 1368 / 1694. The jumps are
 * intentionally uneven — the big steps land where a new *kind* of threat is
 * introduced (turrets at 73s, the elite at 134s), not spread evenly, because a
 * smooth curve is felt as no curve at all.
 *
 * **This curve is unchanged in M2, and that is worth a sentence rather than
 * silence.** The milestone made the sector measurably harder for an unskilled
 * pilot — `random`'s median run fell from 104.8s at wave 18 to 95.8s at wave 16 —
 * without moving a single wave or a single HP value, because all of it came from
 * how enemies *behave*: where the lancer parks, how often the skiff and turret
 * fire, what a hauler costs to ram. Spawned HP is only a proxy for how much
 * attention a stretch demands, and this is the case that proves it: the proxy sat
 * still while the difficulty moved. When the two disagree, trust the sweep.
 */
export const SECTOR_ONE: SectorDef = {
  id: 'debris-shelf',
  name: 'Debris Shelf',
  durationSeconds: 180,
  waves: [
    // ------------------------------------------------------------------
    // OPENING (0–25s) — Haulers only. Nothing shoots.
    //
    // The player has just been handed controls and has no idea what the fire
    // button does yet. So: one large, slow, unarmed target, and enough empty
    // time around it to experiment. Deaths in this phase should be essentially
    // impossible, and that is not a failure of design — it is the point. The
    // phase is over when aiming is automatic.
    // ------------------------------------------------------------------
    {
      atSeconds: 2.5,
      label: 'First contact',
      // A single hauler, dead centre, on the line the hull already occupies.
      // Fixed rather than random so the very first enemy is never off in a
      // corner where a new player might not notice it at all.
      formations: [{ enemyId: 'hauler', count: 1, pattern: 'line', atXFraction: 0.5 }],
    },
    {
      atSeconds: 8,
      label: 'Pair, left',
      // Two at once, off-centre: the first ask is "move, then shoot" rather
      // than "shoot". Offset left and then right (next wave) so neither
      // direction becomes the default.
      formations: [
        { enemyId: 'hauler', count: 2, pattern: 'line', spacing: 96, atXFraction: 0.34 },
      ],
    },
    {
      atSeconds: 14,
      label: 'Pair, right',
      formations: [
        { enemyId: 'hauler', count: 2, pattern: 'line', spacing: 120, atXFraction: 0.66 },
      ],
    },
    {
      atSeconds: 20,
      label: 'Column',
      // A column with a 26-tick stagger arrives as a stream, not a clump: the
      // player must finish one hauler before the next is in range. This is the
      // first thing in the sector that has a wrong answer (spraying between
      // targets and killing none of them in time).
      formations: [
        { enemyId: 'hauler', count: 3, pattern: 'column', staggerTicks: 26, atXFraction: 0.5 },
      ],
    },

    // ------------------------------------------------------------------
    // INTRODUCTION (25–70s) — First projectiles, then mines. Still sparse.
    //
    // Skiffs arrive alone and unaccompanied so the player's first incoming
    // bullet has nothing competing for attention. Mines land twenty seconds
    // later for the same reason. Density stays low throughout; what rises is
    // the number of *things to think about*, which is the resource actually
    // being taxed here.
    // ------------------------------------------------------------------
    {
      atSeconds: 27,
      label: 'Skiffs',
      // Two skiffs, nothing else on screen. Their 0.8s first-shot delay means
      // the player watches them oscillate before anything is fired at them.
      formations: [{ enemyId: 'skiff', count: 2, pattern: 'line', spacing: 128, atXFraction: 0.5 }],
    },
    {
      atSeconds: 33,
      label: 'Skiff arc',
      // An arc has to be dodged *through* rather than around — it presents a
      // curved front with a gap, which is the first positional question asked.
      formations: [{ enemyId: 'skiff', count: 3, pattern: 'arc', spacing: 84 }],
    },
    {
      atSeconds: 39,
      label: 'Mixed, haulers and skiffs',
      // First target-priority decision: the haulers are harmless but block
      // shots, the skiffs are the only things shooting. Correct play is to
      // ignore the big obvious threat, which is a useful thing to learn early.
      formations: [
        { enemyId: 'hauler', count: 2, pattern: 'line', spacing: 140, atXFraction: 0.5 },
        { enemyId: 'skiff', count: 2, pattern: 'flanks', spacing: 72, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 45,
      label: 'Mines',
      // Mines alone, in a spaced line. At speed 22 they take half a minute to
      // cross, so the player has as long as they want to discover the death
      // burst — and will almost certainly discover it by shooting one at point
      // blank range, which is the intended lesson delivered by the intended
      // mistake.
      formations: [{ enemyId: 'mine', count: 3, pattern: 'line', spacing: 104, atXFraction: 0.5 }],
    },
    {
      atSeconds: 51,
      label: 'Mines under fire',
      // The same mines, now with skiffs forcing movement. Suddenly *where* you
      // pop a mine is not a free choice, because the safe lane is also the lane
      // the skiff shots are in.
      formations: [
        { enemyId: 'mine', count: 2, pattern: 'line', spacing: 120, atXFraction: 0.5 },
        { enemyId: 'hauler', count: 1, pattern: 'line' },
        { enemyId: 'skiff', count: 2, pattern: 'flanks', spacing: 80, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 57,
      label: 'Skiff pincer',
      // Four skiffs on flanks: the first genuine pincer. Two aimed shooters on
      // each side means the centre of the playfield is briefly the worst place
      // to be, inverting the habit the opening phase just built.
      formations: [{ enemyId: 'skiff', count: 4, pattern: 'flanks', spacing: 56, atXFraction: 0.5 }],
    },
    {
      atSeconds: 63,
      label: 'Minefield',
      // Scatter with no atXFraction: seeded placement, so this reads differently
      // run to run. Mines are the safest enemy to randomise — a badly placed one
      // is an inconvenience, not a death.
      formations: [
        { enemyId: 'mine', count: 4, pattern: 'scatter' },
        { enemyId: 'hauler', count: 2, pattern: 'line', spacing: 150, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 68,
      label: 'Skiff stream',
      // Staggered column of shooters: an ordered queue of aimed shots. Falling
      // behind here compounds, which is the last thing the introduction phase
      // teaches before turrets change the rules.
      formations: [
        { enemyId: 'skiff', count: 3, pattern: 'column', staggerTicks: 24, atXFraction: 0.42 },
        { enemyId: 'hauler', count: 1, pattern: 'line', atXFraction: 0.75 },
      ],
    },

    // ------------------------------------------------------------------
    // PRESSURE (70–120s) — Lancers and turrets. Waves start overlapping.
    //
    // Two rule changes land here. The turret cannot be waited out, so dodging
    // stops being a complete strategy. The lancer must be *read*, so watching
    // stops being free. From this point wave spacing (6s) is shorter than the
    // time it takes to clear a wave, which is what makes the phase feel like
    // pressure rather than a sequence.
    // ------------------------------------------------------------------
    {
      atSeconds: 73,
      label: 'First turret',
      // Centre-screen, unavoidable, with only two skiffs alongside so the
      // 2.75-second kill can actually be attempted. The turret's 1.25s
      // first-volley delay plus ~3s of descent gives the player a long look at
      // it before it does anything.
      formations: [
        { enemyId: 'turret', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'skiff', count: 2, pattern: 'flanks', spacing: 88, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 79,
      label: 'First lancers',
      // Lancers alone and only two of them, on flanks so their dives converge
      // and the telegraph is visible in peripheral vision on both sides at
      // once. Unarmed, so a misread costs 24 and not the run.
      formations: [
        { enemyId: 'lancer', count: 2, pattern: 'flanks', spacing: 100, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 85,
      label: 'Turret and mines',
      // The turret is off-centre now, so the player must fight in a specific
      // part of the screen — and the mine line decides which part. Two systems
      // constraining position simultaneously, which is the phase's real subject.
      formations: [
        { enemyId: 'turret', count: 1, pattern: 'line', atXFraction: 0.28 },
        { enemyId: 'mine', count: 3, pattern: 'line', spacing: 96, atXFraction: 0.62 },
      ],
    },
    {
      atSeconds: 91,
      label: 'Lancer arc',
      // Three lancers in an arc: one telegraph is a cue, three staggered
      // telegraphs are a pattern to be read. Nothing else on screen, because
      // reading three tells at once is enough.
      formations: [{ enemyId: 'lancer', count: 3, pattern: 'arc', spacing: 76 }],
    },
    {
      atSeconds: 97,
      label: 'Turret with escorts',
      // Escorts debut here rather than earlier on purpose: a tracker is only
      // meaningful once the player has a reason to stand still, and a turret
      // they are trying to kill is exactly that reason.
      formations: [
        { enemyId: 'turret', count: 1, pattern: 'line', atXFraction: 0.72 },
        { enemyId: 'escort', count: 2, pattern: 'flanks', spacing: 92, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 103,
      label: 'Lancers over a minefield',
      // Dive lanes crossing mine positions. The safe spot from the lancers is
      // not the safe spot from the bursts, and the player has ~1s to pick.
      formations: [
        { enemyId: 'lancer', count: 2, pattern: 'flanks', spacing: 120, atXFraction: 0.5 },
        { enemyId: 'mine', count: 3, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 109,
      label: 'Twin turrets',
      // 440 HP of things that will not leave, split to opposite flanks so the
      // two spread cones overlap in the middle. This is the peak of the
      // pressure phase and the first wave where losing shield is expected.
      formations: [
        { enemyId: 'turret', count: 2, pattern: 'flanks', spacing: 150, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 115,
      label: 'Escort stream',
      // A staggered skiff column plus two escorts: a deliberate breather in HP
      // terms (152) that is still busy in bullet terms. The curve rises by
      // bucket, not by wave, precisely so moments like this can exist.
      formations: [
        { enemyId: 'escort', count: 2, pattern: 'line', spacing: 130, atXFraction: 0.5 },
        { enemyId: 'skiff', count: 3, pattern: 'column', staggerTicks: 20, atXFraction: 0.58 },
      ],
    },

    // ------------------------------------------------------------------
    // ESCALATION (120–165s) — Combined formations, and the sector's one elite.
    //
    // No new mechanics from here on. Everything the player meets has already
    // been taught in isolation; the difficulty is now composition. Three armed
    // types on screen at once, and a 7-second cadence so waves reliably
    // overlap.
    // ------------------------------------------------------------------
    {
      atSeconds: 121,
      label: 'Combined: turret, lancers, skiffs',
      // The first wave that mixes a must-kill, a telegraph, and aimed fire.
      // Each element is individually trivial by now; the cost is attention
      // switching, which is exactly what the sector has been building toward.
      formations: [
        { enemyId: 'turret', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'lancer', count: 2, pattern: 'flanks', spacing: 132, atXFraction: 0.5 },
        { enemyId: 'skiff', count: 2, pattern: 'line', spacing: 96, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 128,
      label: 'Escorts behind a mine arc',
      // The arc of mines is a wall with gaps; the escorts fire trackers at
      // whoever hesitates in front of it. Solving one problem creates the other,
      // which is the cleanest form of composed difficulty available here.
      formations: [
        { enemyId: 'escort', count: 2, pattern: 'line', spacing: 150, atXFraction: 0.5 },
        { enemyId: 'mine', count: 4, pattern: 'arc', spacing: 84 },
      ],
    },
    {
      atSeconds: 134,
      label: 'Elite: Heavy Turret',
      // The sector's single elite, centre screen, escorted only by two skiffs.
      // Kept sparse on purpose: 4.5 seconds of committed fire is the whole
      // encounter, and burying it in a swarm would turn a set-piece into noise.
      formations: [
        { enemyId: 'turret-heavy', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'skiff', count: 2, pattern: 'flanks', spacing: 104, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 141,
      label: 'Lancer pincer with escorts',
      // Deliberately arrives while the elite is likely still alive. The dives
      // come from both sides and the trackers punish the retreat, so the elite
      // fight has to be abandoned and resumed.
      formations: [
        { enemyId: 'lancer', count: 2, pattern: 'flanks', spacing: 96, atXFraction: 0.5 },
        { enemyId: 'escort', count: 2, pattern: 'line', spacing: 120, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 147,
      label: 'Turret, escorts, skiff stream',
      // Three simultaneous demands: kill the turret, keep moving for the
      // escorts, clear the column before it accumulates. 372 HP with bullets
      // from three sources.
      formations: [
        { enemyId: 'turret', count: 1, pattern: 'line', atXFraction: 0.36 },
        { enemyId: 'escort', count: 2, pattern: 'flanks', spacing: 84, atXFraction: 0.5 },
        { enemyId: 'skiff', count: 3, pattern: 'column', staggerTicks: 18, atXFraction: 0.7 },
      ],
    },
    {
      atSeconds: 152,
      label: 'Dive screen',
      // Cadence tightens to 5–6s. Lancer arc plus escorts: the arc dictates
      // where you can be, the trackers dictate that you cannot stay.
      formations: [
        { enemyId: 'lancer', count: 3, pattern: 'arc', spacing: 72 },
        { enemyId: 'escort', count: 2, pattern: 'flanks', spacing: 110, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 158,
      label: 'Twin turrets and mines',
      // The 109s twin-turret wave, now with a mine line restricting the lanes
      // between them. Same components, harder question — the sector reusing its
      // own vocabulary instead of inventing more.
      formations: [
        { enemyId: 'turret', count: 2, pattern: 'flanks', spacing: 130, atXFraction: 0.5 },
        { enemyId: 'mine', count: 3, pattern: 'line', spacing: 92, atXFraction: 0.5 },
      ],
    },

    // ------------------------------------------------------------------
    // CLEAR-OUT (165–180s) — Two dense beats, then the sector ends.
    //
    // No turrets and no elite here. The finale is deliberately built from
    // *cheap* enemies: lots of things that die in under half a second, so it
    // plays as a crescendo the player can actually win rather than an HP wall
    // that stalls them at the exit. Density is high, individual lethality is
    // low, and the phase resolves.
    // ------------------------------------------------------------------
    {
      atSeconds: 164,
      label: 'Clear-out, ramp',
      formations: [
        { enemyId: 'escort', count: 3, pattern: 'line', spacing: 118, atXFraction: 0.5 },
        { enemyId: 'skiff', count: 4, pattern: 'flanks', spacing: 62, atXFraction: 0.5 },
        { enemyId: 'lancer', count: 2, pattern: 'flanks', spacing: 140, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 169,
      label: 'Clear-out, first beat',
      // Everything the sector taught, at once: an arc to dodge through, a
      // column to clear in order, a flanking pincer, and mines deciding where
      // any of it can be done.
      formations: [
        { enemyId: 'lancer', count: 4, pattern: 'arc', spacing: 72 },
        { enemyId: 'skiff', count: 4, pattern: 'column', staggerTicks: 18, atXFraction: 0.5 },
        { enemyId: 'escort', count: 3, pattern: 'flanks', spacing: 96, atXFraction: 0.5 },
        { enemyId: 'mine', count: 3, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 174,
      label: 'Clear-out, final beat',
      // 16 enemies, ~418 HP — under six seconds of fire spread across a lot of
      // targets. Short staggers turn each formation into a trickle so the whole
      // thing arrives as a wave front rather than a single frame of chaos.
      // Ends at 174s against a 180s nominal length: the sector closes on the
      // last kill, not on a timer, so leaving room to finish is the point.
      formations: [
        { enemyId: 'hauler', count: 3, pattern: 'line', spacing: 110, atXFraction: 0.5 },
        { enemyId: 'skiff', count: 5, pattern: 'scatter', staggerTicks: 8 },
        { enemyId: 'escort', count: 4, pattern: 'flanks', spacing: 64, staggerTicks: 12, atXFraction: 0.5 },
        { enemyId: 'mine', count: 4, pattern: 'arc', spacing: 88 },
      ],
    },
  ],
}

/**
 * Sector 2 — The Tally.
 *
 * Corporate convoy lanes. **The grammar is that most of what is on screen is not
 * shooting at you.** Freight is inert, slow, and worth more per second of fire
 * than anything else in the game; the threat is a thin screen of guards who keep
 * firing while the pilot decides how much of the convoy to bill. Every wave is
 * the same question at a different price, which is what DESIGN.md means by
 * "greed vs safety".
 *
 * Three things make this read differently from sector 1 beyond the numbers:
 *
 *  - **`strafe` debuts.** Interceptors cross the top band firing downward, so
 *    the safe *column* moves. Sector 1's threats all descend, and the habit that
 *    builds — pick a lane, hold it — is the habit this sector breaks.
 *  - **Formations run in files.** Columns and lines dominate, because a convoy
 *    is an ordered thing. Sector 1 uses arcs and flanks to pose positional
 *    questions; here the shape on screen is a *queue*, and the question is how
 *    far down it you get before the guards catch up.
 *  - **Most waves are optional.** A pilot who shoots nothing but escorts and
 *    tollgates survives comfortably and arrives at the next work order with
 *    nothing to spend. That is a legitimate way to play the sector and the
 *    reason its scrap total (~1,750 against sector 1's 871) is the highest in
 *    the run outside the finale.
 *
 * Total HP by 30s bucket: 790 / 1075 / 1380 / 1560 / 1800 / 2215 = 8,820 over
 * 180s. That is 49 HP/s against an assumed 96 dps — 51% of the pilot's output
 * committed to clearing, against sector 1's 39%. The step is modest on purpose:
 * the difficulty that actually arrives here is horizontal movement and the
 * temptation to over-commit, and neither shows up in an HP count.
 *
 * ~1,920 scrap on the table, more than double sector 1's 871, and about 500 of
 * it is in objects that shoot back when opened.
 */
export const SECTOR_TWO: SectorDef = {
  id: 'the-tally',
  name: 'The Tally',
  durationSeconds: 180,
  waves: [
    // ------------------------------------------------------------------
    // THE LANE (0–30s) — Freight first, guards second.
    //
    // The sector opens with money and no threat, which is the inverse of how
    // sector 1 opens, and it is the fastest way to state what this place is.
    // By the time the first escort arrives at 15s the pilot has already decided
    // they want the cargo, so the guard reads as an obstacle to something they
    // want rather than as an enemy that turned up.
    // ------------------------------------------------------------------
    {
      atSeconds: 3.5,
      label: 'Head of the convoy',
      // One freighter, dead centre, nothing else. 240 HP is 2.5 seconds of
      // uninterrupted fire and it pays 52 — the pilot learns the exchange rate
      // before anything is at stake.
      formations: [{ enemyId: 'freighter', count: 1, pattern: 'line', atXFraction: 0.5 }],
    },
    {
      atSeconds: 9,
      label: 'Sealed freight',
      // Strongboxes alone, spaced wide. The death burst will be discovered here,
      // at leisure, by a pilot who has no reason yet to be near one — the same
      // teaching trick sector 1 uses for the mine, re-aimed at greed.
      formations: [
        { enemyId: 'strongbox', count: 2, pattern: 'line', spacing: 128, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 15,
      label: 'Billed escort',
      // First shots in the sector, and they are attached to a freighter. Killing
      // the cargo now costs 2.5 seconds of standing in tracker fire.
      formations: [
        { enemyId: 'freighter', count: 1, pattern: 'line', atXFraction: 0.34 },
        { enemyId: 'escort', count: 2, pattern: 'flanks', spacing: 96, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 23,
      label: 'Interceptors',
      // The rule change, alone on screen. Two strafers on flanks cross toward
      // each other, so the first thing the pilot sees a strafe run do is close
      // the middle of the playfield.
      formations: [
        { enemyId: 'interceptor', count: 2, pattern: 'flanks', spacing: 120, atXFraction: 0.5 },
      ],
    },

    // ------------------------------------------------------------------
    // THE TOLL (30–60s) — The lane starts charging.
    //
    // Tollgates park in a column and deny it outright: three shots over 14
    // degrees at 146 u/s has no gap to step through, so for the first time the
    // answer to a fan is to leave rather than to thread. Freight keeps coming
    // through the same columns the tollgates are covering, which is the entire
    // trade the sector is built on.
    // ------------------------------------------------------------------
    {
      atSeconds: 31,
      label: 'Tollgate',
      formations: [
        { enemyId: 'tollgate', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'strongbox', count: 2, pattern: 'line', spacing: 130, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 38,
      label: 'Freight under toll',
      formations: [
        { enemyId: 'freighter', count: 1, pattern: 'line', atXFraction: 0.28 },
        { enemyId: 'escort', count: 2, pattern: 'line', spacing: 140, atXFraction: 0.62 },
      ],
    },
    {
      atSeconds: 45,
      label: 'Interceptor pass',
      // Three from one side: they all cross the same way, so this is a wall
      // moving left to right rather than a pincer. Placed off-centre because a
      // strafe run's direction is decided by which half it spawns in.
      formations: [{ enemyId: 'interceptor', count: 3, pattern: 'line', spacing: 84, atXFraction: 0.3 }],
    },
    {
      atSeconds: 52,
      label: 'Cargo column',
      // A staggered file of strongboxes is a queue of individually trivial
      // decisions that becomes one bad decision if the pilot lets them stack.
      formations: [
        { enemyId: 'strongbox', count: 3, pattern: 'column', staggerTicks: 20, atXFraction: 0.66 },
        { enemyId: 'escort', count: 2, pattern: 'flanks', spacing: 100, atXFraction: 0.5 },
      ],
    },

    // ------------------------------------------------------------------
    // THE AUDIT (60–90s) — Defence in depth.
    //
    // Sector 1's turret joins the sector's own tollgate, and the two fans are
    // opposites: one wants to be stepped between, one wants to be left. Having
    // both alive at once is the phase's actual subject — the correct response to
    // a fan is now a question rather than a reflex.
    // ------------------------------------------------------------------
    {
      atSeconds: 61,
      label: 'Lane turret',
      formations: [
        { enemyId: 'turret', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'strongbox', count: 2, pattern: 'line', spacing: 140, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 67,
      label: 'Convoy proper',
      // 480 HP of pure money with nothing guarding it, arriving five seconds
      // after a turret the pilot probably has not killed yet. The greed decision
      // at its most naked: two freighters are 104 scrap and five seconds.
      formations: [{ enemyId: 'freighter', count: 2, pattern: 'line', spacing: 140, atXFraction: 0.5 }],
    },
    {
      atSeconds: 74,
      label: 'Tollgate and escorts',
      formations: [
        { enemyId: 'tollgate', count: 1, pattern: 'line', atXFraction: 0.7 },
        { enemyId: 'escort', count: 3, pattern: 'line', spacing: 110, atXFraction: 0.4 },
      ],
    },
    {
      atSeconds: 81,
      label: 'Toll pincer',
      formations: [
        { enemyId: 'interceptor', count: 2, pattern: 'flanks', spacing: 140, atXFraction: 0.5 },
        { enemyId: 'strongbox', count: 2, pattern: 'scatter' },
      ],
    },

    // ------------------------------------------------------------------
    // THE COMPTROLLER (90–120s) — The elite, and the sector's largest offer.
    //
    // 620 HP for 120 scrap, armed with the one weapon that punishes standing
    // still, escorted by more of the same. It drifts rather than parking, so the
    // offer expires: a pilot who dithers watches a shop tier and a half fall off
    // the bottom of the screen.
    // ------------------------------------------------------------------
    {
      atSeconds: 91,
      label: 'Elite: Comptroller Barge',
      formations: [
        { enemyId: 'comptroller', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'escort', count: 2, pattern: 'flanks', spacing: 110, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 98,
      label: 'Interceptors on the audit',
      // Deliberately arrives while the barge is likely still alive: the pilot is
      // holding a firing line on a tracker platform and now the safe column is
      // sliding out from under them.
      formations: [
        { enemyId: 'interceptor', count: 3, pattern: 'flanks', spacing: 90, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 105,
      label: 'Freight past the audit',
      formations: [
        { enemyId: 'freighter', count: 1, pattern: 'line', atXFraction: 0.72 },
        { enemyId: 'strongbox', count: 2, pattern: 'line', spacing: 120, atXFraction: 0.3 },
      ],
    },
    {
      atSeconds: 112,
      label: 'Tollgate, far side',
      formations: [
        { enemyId: 'tollgate', count: 1, pattern: 'line', atXFraction: 0.38 },
        { enemyId: 'escort', count: 2, pattern: 'line', spacing: 130, atXFraction: 0.66 },
      ],
    },

    // ------------------------------------------------------------------
    // DEPTH (120–150s) — Two tollgates, and freight through the gap.
    //
    // No new pieces. The composition is now two denied columns with a lane
    // between them, and the sector keeps putting cargo in that lane.
    // ------------------------------------------------------------------
    {
      atSeconds: 121,
      label: 'Twin tollgates',
      // Their cones are narrow, so unlike sector 1's twin turrets this does not
      // close the middle — it carves the playfield into three strips, one of
      // which is where everything valuable is about to arrive.
      formations: [
        { enemyId: 'tollgate', count: 2, pattern: 'flanks', spacing: 150, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 127,
      label: 'Convoy under fire',
      formations: [
        { enemyId: 'freighter', count: 2, pattern: 'line', spacing: 130, atXFraction: 0.5 },
        { enemyId: 'interceptor', count: 2, pattern: 'flanks', spacing: 130, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 134,
      label: 'Turret over a cargo arc',
      // An arc of strongboxes is a wall of things the pilot *wants* to shoot,
      // hung in front of a turret they *need* to shoot, with a burst attached to
      // every wrong answer.
      formations: [
        { enemyId: 'turret', count: 1, pattern: 'line', atXFraction: 0.62 },
        { enemyId: 'strongbox', count: 4, pattern: 'arc', spacing: 90 },
      ],
    },
    {
      atSeconds: 141,
      label: 'Escort screen',
      formations: [
        { enemyId: 'escort', count: 4, pattern: 'flanks', spacing: 70, atXFraction: 0.5 },
        { enemyId: 'interceptor', count: 2, pattern: 'line', spacing: 120, atXFraction: 0.3 },
      ],
    },

    // ------------------------------------------------------------------
    // THE LAST LANE (150–180s) — Everything the sector has, and the best money.
    //
    // Unlike sector 1's clear-out this finale is not built from cheap enemies.
    // The Tally's crescendo is a *payday*: the densest freight in the sector
    // arrives under the heaviest guard, and a pilot who has been playing safely
    // all sector is offered one last chance to be greedy at the worst possible
    // moment. Whether that is a trap depends entirely on what they bought.
    // ------------------------------------------------------------------
    {
      atSeconds: 150,
      label: 'Lane closes',
      formations: [
        { enemyId: 'tollgate', count: 2, pattern: 'flanks', spacing: 160, atXFraction: 0.5 },
        { enemyId: 'strongbox', count: 3, pattern: 'line', spacing: 100, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 157,
      label: 'The whole convoy',
      formations: [
        { enemyId: 'freighter', count: 2, pattern: 'line', spacing: 130, atXFraction: 0.5 },
        { enemyId: 'escort', count: 3, pattern: 'line', spacing: 140, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 163,
      label: 'Interceptor storm',
      formations: [
        { enemyId: 'interceptor', count: 3, pattern: 'flanks', spacing: 80, atXFraction: 0.5 },
        { enemyId: 'strongbox', count: 3, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 169,
      label: 'Final billing',
      // No freighter in this wave, deliberately. The 157s and 163s waves are the
      // last money in the sector; putting more here would mean the pilot's final
      // decision is made while four escorts are already firing, which is not a
      // decision so much as a tax on whoever is still alive.
      formations: [
        { enemyId: 'turret', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'escort', count: 4, pattern: 'flanks', spacing: 64, staggerTicks: 10, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 174,
      label: 'Wake',
      // Ends at 174s against 180s nominal, matching sector 1: the sector closes
      // on the last kill, not on a timer, and the gap is where that happens.
      formations: [
        { enemyId: 'strongbox', count: 3, pattern: 'scatter', staggerTicks: 8 },
        { enemyId: 'interceptor', count: 2, pattern: 'flanks', spacing: 120, atXFraction: 0.5 },
      ],
    },
  ],
}

/**
 * Sector 3 — Bloomfield.
 *
 * Something organic has taken a dead station. **The grammar is that nothing is
 * aimed at you.** Sectors 1 and 2 are read by asking "where is that shot going?"
 * and answered by leaving the line. Bloomfield is read by asking "where is there
 * still room?" and answered by moving before the answer changes. Its weapons are
 * rings and death bursts, which come from where things *are* rather than from
 * where the pilot is.
 *
 * The load-bearing inversion: **almost everything here bursts when it dies, so
 * the sector gets more dangerous the faster you clear it.** Every other sector
 * rewards damage monotonically. Here a pilot who holds the trigger through a
 * twelve-spore swarm generates seventy-two projectiles they did not have to
 * face, and the correct play — killing selectively, from range, in an order —
 * is the opposite of what four earlier hours of shooter instinct says.
 *
 * Structurally it is Sector 2's opposite in placement too: The Tally sets
 * `atXFraction` on nearly every formation because a convoy is an ordered thing,
 * and Bloomfield leaves it unset on nearly every formation because growth is
 * not. Two runs of Bloomfield do not look alike; that is the point of a sector
 * whose subject is irregularity.
 *
 * Total HP by 30s bucket: 1060 / 1634 / 1878 / 2136 / 2430 / 2540 = 11,678 over
 * 180s, 65 HP/s against an assumed 120 dps (54%). **This is the sector where the
 * HP proxy is least honest.** Ten husks are 3,000 of that total and are the
 * least dangerous thing here; 134 spores are 2,412 of it and are what kills
 * people, because their real cost is the 804 projectiles they represent. If a
 * sweep ever disagrees with this bucket curve, the curve is what is wrong.
 *
 * ~1,330 scrap, the poorest sector in the run by yield per second. Deliberate:
 * The Tally's route choice only means something if the alternatives pay worse.
 */
export const SECTOR_THREE: SectorDef = {
  id: 'bloomfield',
  name: 'Bloomfield',
  durationSeconds: 180,
  waves: [
    // ------------------------------------------------------------------
    // INFECTION (0–30s) — Spores, then the first thing that parks.
    //
    // The sector opens by handing the pilot a swarm of 18 HP targets that die on
    // contact with the crosshair and spray six shards each. There is no way to
    // learn that except by doing it, so the opening is sparse enough that
    // learning it costs a shield rather than a run.
    // ------------------------------------------------------------------
    {
      atSeconds: 5,
      label: 'Spore drift',
      // Scattered and staggered: they arrive as a drizzle, and clearing the
      // first two teaches what clearing all six would have cost.
      formations: [{ enemyId: 'spore', count: 6, pattern: 'scatter', staggerTicks: 10 }],
    },
    {
      atSeconds: 11,
      label: 'Husk',
      // 300 HP, unarmed, alone. Two and a half seconds of held trigger, which is
      // the sector quietly establishing the behaviour its hazard taxes.
      formations: [{ enemyId: 'husk', count: 1, pattern: 'line', atXFraction: 0.5 }],
    },
    {
      atSeconds: 17,
      label: 'Spores and ordnance',
      // Mines are the one sector-1 enemy Bloomfield keeps, because a drifting
      // burst is already this sector's native grammar and the pilot knows it.
      formations: [
        { enemyId: 'spore', count: 8, pattern: 'scatter', staggerTicks: 8 },
        { enemyId: 'mine', count: 3, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 23,
      label: 'First pod',
      // The first ring in the game, with only spores for company. A ring aimed at
      // nothing is genuinely confusing the first time — the 40-tick telegraph
      // fires and the pilot's instinct is to sidestep, which does nothing.
      formations: [
        { enemyId: 'bloom-pod', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'spore', count: 4, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 28,
      label: 'First creeper',
      formations: [
        { enemyId: 'creeper', count: 1, pattern: 'line', atXFraction: 0.3 },
        { enemyId: 'spore', count: 5, pattern: 'scatter' },
      ],
    },

    // ------------------------------------------------------------------
    // SPREAD (30–60s) — Pods and creepers together.
    //
    // The two halves of the sector's threat model meet: a pod says "not near
    // me", a creeper says "not where you are standing", and the intersection is
    // a shrinking, moving space. Husks keep arriving to argue that the pilot
    // should stand still anyway.
    // ------------------------------------------------------------------
    {
      atSeconds: 34,
      label: 'Husk pair',
      formations: [{ enemyId: 'husk', count: 2, pattern: 'line', spacing: 150, atXFraction: 0.5 }],
    },
    {
      atSeconds: 40,
      label: 'Pod and spores',
      formations: [
        { enemyId: 'bloom-pod', count: 1, pattern: 'line', atXFraction: 0.34 },
        { enemyId: 'spore', count: 6, pattern: 'scatter', staggerTicks: 8 },
      ],
    },
    {
      atSeconds: 46,
      label: 'Creepers cross',
      // Two creepers from opposite flanks cross in the middle, so their tracker
      // bearings sweep in opposite directions and there is a moment where the
      // centre is the only place both are firing into.
      formations: [
        { enemyId: 'creeper', count: 2, pattern: 'flanks', spacing: 120, atXFraction: 0.5 },
        { enemyId: 'mine', count: 4, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 52,
      label: 'Bloom',
      formations: [
        { enemyId: 'bloom-pod', count: 2, pattern: 'flanks', spacing: 140, atXFraction: 0.5 },
        { enemyId: 'spore', count: 6, pattern: 'scatter' },
      ],
    },

    // ------------------------------------------------------------------
    // OVERGROWTH (60–90s) — Density, and the first real swarm.
    //
    // Twelve spores at once is 216 HP and 72 potential projectiles. It is the
    // cheapest wave in the sector by HP and the most likely to kill an
    // undisciplined pilot, which is the clearest statement available that
    // spawned HP is only a proxy.
    // ------------------------------------------------------------------
    {
      atSeconds: 60,
      label: 'Husk and spores',
      formations: [
        { enemyId: 'husk', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'spore', count: 6, pattern: 'scatter', staggerTicks: 8 },
      ],
    },
    {
      atSeconds: 66,
      label: 'Pod line',
      formations: [
        { enemyId: 'bloom-pod', count: 2, pattern: 'line', spacing: 160, atXFraction: 0.5 },
        { enemyId: 'creeper', count: 1, pattern: 'line', atXFraction: 0.72 },
      ],
    },
    {
      atSeconds: 73,
      label: 'Spore storm',
      formations: [
        { enemyId: 'spore', count: 12, pattern: 'scatter', staggerTicks: 6 },
        { enemyId: 'mine', count: 4, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 79,
      label: 'Creeper pincer',
      formations: [
        { enemyId: 'creeper', count: 2, pattern: 'flanks', spacing: 110, atXFraction: 0.5 },
        { enemyId: 'bloom-pod', count: 1, pattern: 'line', atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 85,
      label: 'Bloom and ordnance',
      formations: [
        { enemyId: 'bloom-pod', count: 1, pattern: 'line', atXFraction: 0.66 },
        { enemyId: 'spore', count: 5, pattern: 'scatter' },
        { enemyId: 'mine', count: 3, pattern: 'line', spacing: 96, atXFraction: 0.34 },
      ],
    },

    // ------------------------------------------------------------------
    // THE HEART (90–120s) — The elite, whose death is the dangerous part.
    //
    // 700 HP of parked ring source that vents eighteen shards when it goes. The
    // pilot has spent ninety seconds learning that kills cost something here;
    // this is the exam, and the correct answer — back off before the last 100
    // HP — is one the sector has been teaching since its first spore.
    // ------------------------------------------------------------------
    {
      atSeconds: 91,
      label: 'Elite: Bloom Heart',
      formations: [
        { enemyId: 'bloomheart', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'spore', count: 6, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 98,
      label: 'Pods around the heart',
      formations: [
        { enemyId: 'bloom-pod', count: 2, pattern: 'flanks', spacing: 150, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 104,
      label: 'Creepers on the heart',
      formations: [
        { enemyId: 'creeper', count: 2, pattern: 'flanks', spacing: 120, atXFraction: 0.5 },
        { enemyId: 'spore', count: 6, pattern: 'scatter', staggerTicks: 8 },
      ],
    },
    {
      atSeconds: 110,
      label: 'Husks',
      formations: [{ enemyId: 'husk', count: 2, pattern: 'line', spacing: 140, atXFraction: 0.5 }],
    },

    // ------------------------------------------------------------------
    // BLOOM (120–150s) — Everything at once, still unaimed.
    //
    // The phase deliberately never introduces an aimed weapon. A sector whose
    // whole identity is "read the field, not the shot" would undo itself by
    // adding a shot to read at the end, and the escalation is available without
    // it: more sources, more overlap, less floor.
    // ------------------------------------------------------------------
    {
      atSeconds: 121,
      label: 'Pod wall',
      formations: [
        { enemyId: 'bloom-pod', count: 3, pattern: 'arc', spacing: 100 },
        { enemyId: 'spore', count: 8, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 127,
      label: 'Husk and creeper',
      formations: [
        { enemyId: 'husk', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'creeper', count: 2, pattern: 'flanks', spacing: 130, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 133,
      label: 'Spore surge',
      formations: [
        { enemyId: 'spore', count: 16, pattern: 'scatter', staggerTicks: 5 },
        { enemyId: 'mine', count: 5, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 139,
      label: 'Pods and creeper',
      formations: [
        { enemyId: 'bloom-pod', count: 2, pattern: 'flanks', spacing: 140, atXFraction: 0.5 },
        { enemyId: 'creeper', count: 1, pattern: 'line', atXFraction: 0.7 },
      ],
    },
    {
      atSeconds: 145,
      label: 'Husk and swarm',
      formations: [
        { enemyId: 'husk', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'spore', count: 6, pattern: 'scatter' },
      ],
    },

    // ------------------------------------------------------------------
    // FULL BLOOM (150–180s) — The station finishes eating itself.
    //
    // The finale is the sector's own trap at maximum scale: the last waves are
    // mostly cheap bodies, so a pilot who clears them all generates more
    // projectiles in thirty seconds than the rest of the sector combined. The
    // way out is the way it has always been — leave things alive and fly past.
    // ------------------------------------------------------------------
    {
      atSeconds: 151,
      label: 'Everything blooms',
      formations: [
        { enemyId: 'bloom-pod', count: 3, pattern: 'line', spacing: 130, atXFraction: 0.5 },
        { enemyId: 'creeper', count: 1, pattern: 'line', atXFraction: 0.28 },
      ],
    },
    {
      atSeconds: 157,
      label: 'Husk and swarm',
      formations: [
        { enemyId: 'husk', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'spore', count: 8, pattern: 'scatter', staggerTicks: 6 },
      ],
    },
    {
      atSeconds: 163,
      label: 'Spore and mine field',
      // Twelve spores and five mines is 276 HP — the cheapest wave in the last
      // ninety seconds, and the one most likely to end the run. Seventeen bodies
      // with a burst on every one of them is 102 projectiles if the pilot clears
      // it, which no amount of damage output makes safer.
      formations: [
        { enemyId: 'spore', count: 12, pattern: 'scatter', staggerTicks: 5 },
        { enemyId: 'mine', count: 5, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 169,
      label: 'Pods, husk, creeper',
      formations: [
        { enemyId: 'bloom-pod', count: 2, pattern: 'flanks', spacing: 150, atXFraction: 0.5 },
        { enemyId: 'husk', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'creeper', count: 1, pattern: 'line', atXFraction: 0.28 },
      ],
    },
    {
      atSeconds: 175,
      label: 'Final bloom',
      formations: [
        { enemyId: 'spore', count: 14, pattern: 'scatter', staggerTicks: 4 },
        { enemyId: 'bloom-pod', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'mine', count: 4, pattern: 'arc', spacing: 88 },
      ],
    },
  ],
}

/**
 * Sector 4 — Kill Grid.
 *
 * An automated defence net. **The grammar is that the grid is in the same place
 * every run.** Every formation below sets `atXFraction`; not one of them is
 * seeded. That is the structural claim of the sector and the sharpest possible
 * break from Bloomfield, where almost nothing is placed — and it is what makes
 * this the only sector that can be *solved* rather than merely survived.
 *
 * Its fire is precise rather than dense: five shots over 18 degrees at 164 u/s,
 * with the longest telegraphs in the game in front of them. Nothing in the
 * sector has a death burst, which after Bloomfield is information in itself —
 * killing things here is unambiguously good again, and the sector is free to be
 * about *where you are* instead.
 *
 * The three pieces compose into one idea:
 *
 *  - a **node** forbids a cone (static, learnable);
 *  - a **pylon** forbids an expanding shell from a known point (periodic, and
 *    always in a symmetric pair, so two shells intersect predictably);
 *  - a **sweeper** drags a forbidden column across the field (moving).
 *
 * Between them the safe space at any instant is a shape the pilot can work out
 * a second in advance and cannot find by reacting. The **snare** is the penalty
 * clause: 0.6 seconds of warning and 510 u/s on the dive, aimed squarely at
 * anyone who solved the geometry and then stopped moving inside it.
 *
 * Total HP by 30s bucket: 1160 / 1860 / 2290 / 2520 / 2840 / 3500 = 14,170 over
 * 180s, 79 HP/s against an assumed 140 dps (56%). The curve is the smoothest of
 * the five, and that is right for a sector whose difficulty is a shape rather
 * than a quantity — the steps that matter here are how many constraints overlap,
 * not how much HP arrived.
 */
export const SECTOR_FOUR: SectorDef = {
  id: 'kill-grid',
  name: 'Kill Grid',
  durationSeconds: 180,
  waves: [
    // ------------------------------------------------------------------
    // POWER-UP (0–30s) — One piece at a time, each in a fixed position.
    //
    // Sector 1 introduces mechanics in isolation because the pilot is new.
    // Kill Grid does it because the pilot needs to learn each piece's *geometry*
    // — what shape it forbids — and three overlapping shapes cannot be learned
    // at once. The pieces are the same pieces for the rest of the sector.
    // ------------------------------------------------------------------
    {
      atSeconds: 4,
      label: 'Grid opens',
      // One node, centre. The 44-tick telegraph and the 18-degree rake, with
      // nothing else to look at. Sector 4's first wave is armed — the pilot is
      // three sectors in, and the reactability rule that matters now is the
      // telegraph, not the calendar.
      formations: [{ enemyId: 'node', count: 1, pattern: 'line', atXFraction: 0.5 }],
    },
    {
      atSeconds: 10,
      label: 'Pylon pair',
      // Pylons always arrive in twos. A single ring is a puzzle with one
      // solution; two overlapping rings from known positions are a puzzle with a
      // *path*, which is the thing the sector is actually about.
      formations: [{ enemyId: 'pylon', count: 2, pattern: 'flanks', spacing: 60, atXFraction: 0.5 }],
    },
    {
      atSeconds: 16,
      label: 'First sweeper',
      // From the left third, so it crosses rightward: the forbidden column
      // travels the full width and the pilot has to move ahead of it rather than
      // away from it.
      formations: [{ enemyId: 'sweeper', count: 1, pattern: 'line', atXFraction: 0.22 }],
    },
    {
      atSeconds: 22,
      label: 'Nodes and snares',
      // The penalty clause, introduced against a geometry the pilot has just
      // learned to stand inside.
      formations: [
        { enemyId: 'node', count: 2, pattern: 'line', spacing: 180, atXFraction: 0.5 },
        { enemyId: 'snare', count: 2, pattern: 'flanks', spacing: 130, atXFraction: 0.5 },
      ],
    },

    // ------------------------------------------------------------------
    // LATTICE (30–60s) — Two pieces at a time.
    //
    // Every wave here is exactly two of the three shapes, in every pairing. The
    // sector is enumerating its own combinations before it starts stacking them,
    // which is the only honest way to build a puzzle sector: the pilot must have
    // seen each intersection before being asked to solve all of them.
    // ------------------------------------------------------------------
    {
      atSeconds: 30,
      label: 'Node inside a lattice',
      formations: [
        { enemyId: 'pylon', count: 2, pattern: 'flanks', spacing: 60, atXFraction: 0.5 },
        { enemyId: 'node', count: 1, pattern: 'line', atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 37,
      label: 'Sweep and snare',
      formations: [
        { enemyId: 'sweeper', count: 2, pattern: 'flanks', spacing: 100, atXFraction: 0.5 },
        { enemyId: 'snare', count: 2, pattern: 'flanks', spacing: 150, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 44,
      label: 'Rake and shell',
      formations: [
        { enemyId: 'node', count: 2, pattern: 'flanks', spacing: 140, atXFraction: 0.5 },
        { enemyId: 'pylon', count: 1, pattern: 'line', atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 51,
      label: 'Turret and snares',
      // Sector 1's turret, reused unchanged. Its wide slow fan is the one thing
      // in the sector that *can* be threaded, and having it here keeps the
      // pilot's reading of a fan honest — not every cone is forbidden.
      formations: [
        { enemyId: 'turret', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'snare', count: 3, pattern: 'line', spacing: 100, atXFraction: 0.5 },
      ],
    },

    // ------------------------------------------------------------------
    // CORRIDORS (60–90s) — Three nodes make a shape, not three threats.
    //
    // A line of nodes leaves gaps between the cones, and those gaps are
    // corridors. From here the sector stops being read as enemies and starts
    // being read as terrain, which is the transition the whole design is for.
    // ------------------------------------------------------------------
    {
      atSeconds: 60,
      label: 'Three-node line',
      formations: [{ enemyId: 'node', count: 3, pattern: 'line', spacing: 140, atXFraction: 0.5 }],
    },
    {
      atSeconds: 66,
      label: 'Sweep through the lattice',
      formations: [
        { enemyId: 'pylon', count: 2, pattern: 'flanks', spacing: 90, atXFraction: 0.5 },
        { enemyId: 'sweeper', count: 2, pattern: 'flanks', spacing: 120, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 73,
      label: 'Corridor',
      formations: [
        { enemyId: 'turret', count: 2, pattern: 'flanks', spacing: 150, atXFraction: 0.5 },
        { enemyId: 'snare', count: 2, pattern: 'flanks', spacing: 110, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 80,
      label: 'Pylon lattice',
      formations: [
        { enemyId: 'pylon', count: 3, pattern: 'line', spacing: 120, atXFraction: 0.5 },
        { enemyId: 'sweeper', count: 1, pattern: 'line', atXFraction: 0.78 },
      ],
    },

    // ------------------------------------------------------------------
    // THE ARBITER (90–120s) — 900 HP inside a known lattice.
    //
    // Placed with two pylons already alive on purpose. The fight is 6.4 seconds
    // of committed fire, and committing means choosing to stand somewhere inside
    // a pattern the pilot can predict — the sector's thesis as a set piece.
    // ------------------------------------------------------------------
    {
      atSeconds: 91,
      label: 'Elite: Arbiter Emplacement',
      formations: [
        { enemyId: 'arbiter', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'pylon', count: 2, pattern: 'flanks', spacing: 140, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 99,
      label: 'Snares on the arbiter',
      // The dive punish, delivered while the pilot is holding a firing line on
      // 900 HP. Four snares is 0.6s of warning four times over.
      formations: [{ enemyId: 'snare', count: 4, pattern: 'flanks', spacing: 90, atXFraction: 0.5 }],
    },
    {
      atSeconds: 105,
      label: 'Rake and sweep',
      formations: [
        { enemyId: 'node', count: 2, pattern: 'flanks', spacing: 150, atXFraction: 0.5 },
        { enemyId: 'sweeper', count: 1, pattern: 'line', atXFraction: 0.24 },
      ],
    },
    {
      atSeconds: 112,
      label: 'Grid closes',
      formations: [
        { enemyId: 'turret', count: 1, pattern: 'line', atXFraction: 0.34 },
        { enemyId: 'pylon', count: 2, pattern: 'flanks', spacing: 100, atXFraction: 0.5 },
      ],
    },

    // ------------------------------------------------------------------
    // FULL NET (120–150s) — All three shapes, stacked.
    //
    // No new pieces from here. The sector's difficulty is now the number of
    // simultaneous constraints, and the answer is always a route rather than a
    // reaction.
    // ------------------------------------------------------------------
    {
      atSeconds: 120,
      label: 'Four nodes',
      // 800 HP of static geometry across the full width: four cones, three gaps,
      // and 5.7 seconds of fire to remove any of it. This wave is a map.
      formations: [{ enemyId: 'node', count: 4, pattern: 'line', spacing: 110, atXFraction: 0.5 }],
    },
    {
      atSeconds: 126,
      label: 'Double sweep',
      formations: [
        { enemyId: 'sweeper', count: 3, pattern: 'line', spacing: 90, atXFraction: 0.28 },
        { enemyId: 'snare', count: 3, pattern: 'flanks', spacing: 100, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 133,
      label: 'Lattice and turret',
      formations: [
        { enemyId: 'pylon', count: 3, pattern: 'line', spacing: 130, atXFraction: 0.5 },
        { enemyId: 'turret', count: 1, pattern: 'line', atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 140,
      label: 'Rake, sweep, dive',
      // The first wave with all three shapes plus the punish. Everything is
      // telegraphed; nothing is optional.
      formations: [
        { enemyId: 'node', count: 2, pattern: 'flanks', spacing: 160, atXFraction: 0.5 },
        { enemyId: 'snare', count: 4, pattern: 'flanks', spacing: 80, atXFraction: 0.5 },
        { enemyId: 'sweeper', count: 1, pattern: 'line', atXFraction: 0.72 },
      ],
    },

    // ------------------------------------------------------------------
    // SHUTDOWN (150–180s) — The grid at full power.
    //
    // The finale is not denser than the previous phase by much; it is *tighter*.
    // Waves land every six seconds against geometry that takes longer than that
    // to remove, so from 150s the pilot is solving a shape that is still being
    // added to. Nothing is random, so a route exists through every frame of it —
    // which is the promise the sector has to keep at the moment it is hardest.
    // ------------------------------------------------------------------
    {
      atSeconds: 150,
      label: 'Full grid',
      formations: [
        { enemyId: 'node', count: 2, pattern: 'line', spacing: 150, atXFraction: 0.5 },
        { enemyId: 'pylon', count: 2, pattern: 'flanks', spacing: 150, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 156,
      label: 'Sweep screen',
      formations: [
        { enemyId: 'sweeper', count: 3, pattern: 'flanks', spacing: 80, atXFraction: 0.5 },
        { enemyId: 'snare', count: 3, pattern: 'line', spacing: 110, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 162,
      label: 'Emplacements',
      formations: [
        { enemyId: 'turret', count: 1, pattern: 'line', atXFraction: 0.32 },
        { enemyId: 'node', count: 2, pattern: 'flanks', spacing: 90, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 168,
      label: 'Lattice at full power',
      formations: [
        { enemyId: 'pylon', count: 3, pattern: 'line', spacing: 100, atXFraction: 0.5 },
        { enemyId: 'sweeper', count: 2, pattern: 'flanks', spacing: 120, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 174,
      label: 'Shutdown',
      // An arc, and the only one in the sector. Every other formation here is a
      // line or a flank pair because the grid is built on right angles; the last
      // wave breaks its own rule as it comes apart.
      formations: [
        { enemyId: 'node', count: 2, pattern: 'line', spacing: 150, atXFraction: 0.5 },
        { enemyId: 'sweeper', count: 2, pattern: 'arc', spacing: 90, atXFraction: 0.32 },
        { enemyId: 'snare', count: 4, pattern: 'flanks', spacing: 70, staggerTicks: 8, atXFraction: 0.5 },
      ],
    },
  ],
}

/**
 * Sector 5 — The Deep Manifest.
 *
 * The wreck you were actually sent for. **The grammar is layered threat on one
 * body**: sectors 1–4 ask one question per enemy, and this sector's own enemies
 * ask two at once — a diver that also shoots, a wall that shoots and then
 * bursts, an elite that moves sideways while fanning.
 *
 * It introduces no new *idea*, deliberately. The finale is the exam, and an exam
 * that introduces material is a bad exam. What it does instead is draw on
 * earlier sectors' rosters — sector 1's skiffs and escorts, sector 2's freight —
 * and re-cast sector 1's set-piece elite, the Heavy Turret, as a common enemy
 * that turns up two at a time. That single decision says more about how far the
 * run has come than any new stat line could.
 *
 * **The one sector-1 enemy this sector will not take is the lancer**, and the
 * reason is legibility rather than difficulty. The bailiff is a lancer with a
 * gun and it uses the lancer's silhouette, so a wave containing both would put
 * two identically-shaped ships on screen, one of which shoots. Making the pilot
 * guess which is which is not a reading test, it is a coin flip with the
 * telegraph turned off, and UI clarity outranks content volume (CLAUDE.md).
 * Where sector 1 would have sent lancers, this sector sends bailiffs.
 *
 * It is the longest sector (210s, seven 30-second buckets) and by a wide margin
 * the richest: ~2,950 scrap, because a pilot arriving here has a build to finish
 * paying for and because the wreck is the thing the whole contract was about.
 *
 * Total HP by 30s bucket: 2028 / 2288 / 2326 / 2758 / 2850 / 3414 / 3896 =
 * 19,560 over 210s, 93 HP/s against an assumed 160 dps (58%).
 *
 * **That 2x output assumption is the shakiest number in the whole content
 * layer.** At 1.6x real output this sector is a 73% load and almost certainly a
 * wall. The lever to pull if a sweep says so is the `count` on the freighter and
 * revenant formations in the last three buckets: they are 4,700 HP between them,
 * they are the least interesting HP in the sector, and removing a third of it
 * costs the sector nothing it is actually about.
 */
export const SECTOR_FIVE: SectorDef = {
  id: 'deep-manifest',
  name: 'The Deep Manifest',
  durationSeconds: 210,
  waves: [
    // ------------------------------------------------------------------
    // THE OUTER HOLD (0–30s) — The manifest, read aloud.
    //
    // Opens on freight, which is a deliberate echo of The Tally: the pilot is
    // being told what this place is by being shown what is in it. Then a
    // revenant, which is that same freight with a gun and a burst, and the
    // sector's method is stated inside twenty seconds.
    // ------------------------------------------------------------------
    {
      atSeconds: 4.5,
      label: 'Manifest, page one',
      formations: [{ enemyId: 'freighter', count: 2, pattern: 'line', spacing: 140, atXFraction: 0.5 }],
    },
    {
      atSeconds: 10,
      label: 'Bailiffs',
      // The armed diver, alone, so its two telegraphs can be told apart. A pilot
      // who reads it as a lancer stands still and takes an aimed shot; one who
      // reads it as a shooter sidesteps into the dive.
      formations: [{ enemyId: 'bailiff', count: 2, pattern: 'flanks', spacing: 120, atXFraction: 0.5 }],
    },
    {
      atSeconds: 16,
      label: 'Revenant',
      formations: [
        { enemyId: 'revenant', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'skiff', count: 3, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 22,
      label: 'Company hardware',
      // Sector 1's early roster in one wave, as background noise. Nothing here
      // is a threat on its own any more, and that is the joke.
      formations: [
        { enemyId: 'skiff', count: 4, pattern: 'flanks', spacing: 70, atXFraction: 0.5 },
        { enemyId: 'escort', count: 3, pattern: 'line', spacing: 130, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 27,
      label: 'Freight and bailiffs',
      formations: [
        { enemyId: 'freighter', count: 2, pattern: 'line', spacing: 130, atXFraction: 0.5 },
        { enemyId: 'bailiff', count: 2, pattern: 'flanks', spacing: 140, atXFraction: 0.5 },
      ],
    },

    // ------------------------------------------------------------------
    // SALVAGE (30–60s) — The Heavy Turret, demoted.
    //
    // Sector 1's elite arrives as an ordinary enemy with skiffs around it, at a
    // point in the run where 360 HP is 2.25 seconds. Nothing else in the sector
    // makes the same point as economically.
    // ------------------------------------------------------------------
    {
      atSeconds: 33,
      label: 'Heavy on the manifest',
      formations: [
        { enemyId: 'turret-heavy', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'skiff', count: 4, pattern: 'flanks', spacing: 80, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 39,
      label: 'Revenant pair',
      formations: [{ enemyId: 'revenant', count: 2, pattern: 'line', spacing: 150, atXFraction: 0.5 }],
    },
    {
      atSeconds: 46,
      label: 'Bailiff dive',
      formations: [
        { enemyId: 'bailiff', count: 4, pattern: 'flanks', spacing: 90, atXFraction: 0.5 },
        { enemyId: 'escort', count: 2, pattern: 'line', spacing: 130, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 52,
      label: 'Freight column',
      formations: [
        { enemyId: 'freighter', count: 2, pattern: 'column', staggerTicks: 24, atXFraction: 0.4 },
        { enemyId: 'skiff', count: 3, pattern: 'arc', spacing: 76 },
      ],
    },

    // ------------------------------------------------------------------
    // THE QUARTERMASTER (60–90s) — 820 HP of ring, early.
    //
    // The sector's first elite lands at 61s rather than at the traditional 90s
    // because it is the encounter that sets the tempo: 5.1 seconds of committed
    // fire while three other things are happening. Everything after it is that
    // same demand with less notice.
    // ------------------------------------------------------------------
    {
      atSeconds: 61,
      label: 'Elite: Quartermaster',
      formations: [
        { enemyId: 'quartermaster', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'escort', count: 2, pattern: 'flanks', spacing: 120, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 68,
      label: 'Bailiffs on the quartermaster',
      formations: [
        { enemyId: 'bailiff', count: 3, pattern: 'arc', spacing: 90 },
        { enemyId: 'skiff', count: 4, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 75,
      label: 'Revenant and heavy',
      formations: [
        { enemyId: 'revenant', count: 1, pattern: 'line', atXFraction: 0.32 },
        { enemyId: 'turret-heavy', count: 1, pattern: 'line', atXFraction: 0.68 },
      ],
    },
    {
      atSeconds: 82,
      label: 'Old escort screen',
      formations: [
        { enemyId: 'escort', count: 4, pattern: 'flanks', spacing: 70, atXFraction: 0.5 },
        { enemyId: 'skiff', count: 5, pattern: 'column', staggerTicks: 16, atXFraction: 0.5 },
      ],
    },

    // ------------------------------------------------------------------
    // THE DEEP HOLD (90–120s) — Tonnage.
    //
    // The phase where the sector simply weighs more than any before it: three
    // freighters and a revenant in one wave is 1,140 HP, seven seconds of held
    // trigger, and the bailiffs arrive at 97s specifically to make holding it
    // impossible.
    // ------------------------------------------------------------------
    {
      atSeconds: 90,
      label: 'Freight and revenants',
      formations: [
        { enemyId: 'freighter', count: 3, pattern: 'line', spacing: 120, atXFraction: 0.5 },
        { enemyId: 'revenant', count: 1, pattern: 'line', atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 97,
      label: 'Bailiff storm',
      formations: [
        { enemyId: 'bailiff', count: 5, pattern: 'flanks', spacing: 80, atXFraction: 0.5 },
        { enemyId: 'skiff', count: 4, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 104,
      label: 'Two heavies',
      // What sector 1 built a whole set piece around, twice, as a mid-phase
      // wave. 720 HP of 46-degree fan from both flanks.
      formations: [
        { enemyId: 'turret-heavy', count: 2, pattern: 'flanks', spacing: 150, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 111,
      label: 'Screen',
      formations: [
        { enemyId: 'escort', count: 4, pattern: 'flanks', spacing: 76, atXFraction: 0.5 },
        { enemyId: 'skiff', count: 4, pattern: 'arc', spacing: 72 },
        { enemyId: 'skiff', count: 4, pattern: 'column', staggerTicks: 14, atXFraction: 0.6 },
      ],
    },

    // ------------------------------------------------------------------
    // THE LIQUIDATOR (120–150s) — An elite that will not hold still.
    //
    // Every other elite in the game parks or drifts down, so the pilot picks the
    // column the fight happens in. This one crosses at 58 u/s throwing a
    // 66-degree fan, and the column is whichever one it is currently in.
    // ------------------------------------------------------------------
    {
      atSeconds: 121,
      label: 'Elite: Liquidator',
      formations: [
        { enemyId: 'liquidator', count: 1, pattern: 'line', atXFraction: 0.3 },
        { enemyId: 'escort', count: 2, pattern: 'flanks', spacing: 120, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 128,
      label: 'Revenants and bailiffs',
      formations: [
        { enemyId: 'revenant', count: 2, pattern: 'line', spacing: 140, atXFraction: 0.5 },
        { enemyId: 'bailiff', count: 2, pattern: 'flanks', spacing: 130, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 135,
      label: 'Freight run',
      formations: [
        { enemyId: 'freighter', count: 1, pattern: 'line', atXFraction: 0.5 },
        { enemyId: 'skiff', count: 5, pattern: 'scatter', staggerTicks: 8 },
      ],
    },
    {
      atSeconds: 142,
      label: 'Heavy and bailiffs',
      formations: [
        { enemyId: 'turret-heavy', count: 1, pattern: 'line', atXFraction: 0.62 },
        { enemyId: 'bailiff', count: 3, pattern: 'arc', spacing: 88 },
      ],
    },

    // ------------------------------------------------------------------
    // THE LEDGER (150–180s) — Everything, at once, with no elite to organise it.
    //
    // The two elites are behind the pilot. What is left is composition: two
    // revenants and a heavy is 1,200 HP of three different fans, and the sector
    // never again gives the pilot a single most-important target.
    // ------------------------------------------------------------------
    {
      atSeconds: 150,
      label: 'Manifest, in full',
      formations: [
        { enemyId: 'revenant', count: 2, pattern: 'line', spacing: 150, atXFraction: 0.5 },
        { enemyId: 'turret-heavy', count: 1, pattern: 'line', atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 157,
      label: 'Bailiffs and old stock',
      formations: [
        { enemyId: 'bailiff', count: 4, pattern: 'flanks', spacing: 90, atXFraction: 0.5 },
        { enemyId: 'skiff', count: 6, pattern: 'scatter', staggerTicks: 6 },
        { enemyId: 'escort', count: 3, pattern: 'line', spacing: 120, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 164,
      label: 'Freight, last lot',
      formations: [
        { enemyId: 'freighter', count: 2, pattern: 'line', spacing: 130, atXFraction: 0.5 },
        { enemyId: 'escort', count: 3, pattern: 'arc', spacing: 96 },
      ],
    },
    {
      atSeconds: 170,
      label: 'Heavies and dive',
      formations: [
        { enemyId: 'turret-heavy', count: 2, pattern: 'flanks', spacing: 140, atXFraction: 0.5 },
        { enemyId: 'bailiff', count: 3, pattern: 'flanks', spacing: 100, atXFraction: 0.5 },
      ],
    },

    // ------------------------------------------------------------------
    // THE CORE (180–210s) — The last thirty seconds before the boss.
    //
    // Sector 1's finale is built from cheap enemies so it plays as a crescendo
    // the pilot can win. This one cannot be, because the HP curve has to keep
    // rising and a bucket of skiffs cannot carry 4,000 HP — so it is built from
    // *bodies the pilot already knows how to fight*, at a density that leaves no
    // idle time. Same intent, different means: the pilot should arrive at the
    // boss having been busy rather than having been stalled.
    // ------------------------------------------------------------------
    {
      atSeconds: 180,
      label: 'The hold',
      formations: [
        { enemyId: 'revenant', count: 2, pattern: 'line', spacing: 140, atXFraction: 0.5 },
        { enemyId: 'skiff', count: 4, pattern: 'scatter', staggerTicks: 6 },
      ],
    },
    {
      atSeconds: 186,
      label: 'Bailiff wall',
      formations: [
        { enemyId: 'bailiff', count: 5, pattern: 'flanks', spacing: 76, staggerTicks: 8, atXFraction: 0.5 },
        { enemyId: 'escort', count: 4, pattern: 'flanks', spacing: 80, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 192,
      label: 'Everything left on the manifest',
      formations: [
        { enemyId: 'freighter', count: 2, pattern: 'line', spacing: 130, atXFraction: 0.5 },
        { enemyId: 'escort', count: 3, pattern: 'arc', spacing: 96 },
        { enemyId: 'skiff', count: 4, pattern: 'scatter' },
      ],
    },
    {
      atSeconds: 198,
      label: 'Last of the salvage',
      // One heavy and three bailiffs rather than a revenant as well. The last
      // *big* body in the sector lands at 192s: the final twelve seconds should
      // be things the pilot can finish, so the boss opens on a clear field
      // rather than over the top of 420 HP the pilot never had time to remove.
      formations: [
        { enemyId: 'turret-heavy', count: 1, pattern: 'line', atXFraction: 0.72 },
        { enemyId: 'bailiff', count: 3, pattern: 'arc', spacing: 84 },
        { enemyId: 'escort', count: 3, pattern: 'flanks', spacing: 90, atXFraction: 0.5 },
      ],
    },
    {
      atSeconds: 204,
      label: 'Clear the core',
      // Ends at 204s against 210s nominal — the same six-second tail sector 1
      // leaves, so the sector closes on the last kill and the boss is not
      // announced over the top of a live wave.
      formations: [
        { enemyId: 'freighter', count: 2, pattern: 'line', spacing: 120, atXFraction: 0.5 },
        { enemyId: 'skiff', count: 6, pattern: 'scatter', staggerTicks: 5 },
        { enemyId: 'escort', count: 4, pattern: 'flanks', spacing: 62, staggerTicks: 10, atXFraction: 0.5 },
        { enemyId: 'skiff', count: 5, pattern: 'arc', spacing: 66 },
      ],
    },
  ],
}

/**
 * Every sector that actually exists, in order.
 *
 * The HUD reads its "sector N of M" denominator from this array's length rather
 * than from the five sectors DESIGN.md plans. A tester cleared sector 1, saw the
 * panel still reading `1 / 5`, and reasonably concluded the game had failed to
 * advance — the readout was describing the design document, not the build.
 *
 * All five now exist as content, so the denominator is 5 again — legitimately
 * this time. **That makes it the simulation's job to keep the promise:** until
 * `World` advances through `RUN_STAGES`, a run still ends after sector 1 and the
 * panel will once again be describing a plan rather than a build. The readout is
 * correct only when both halves have landed.
 */
export const SECTORS: readonly SectorDef[] = [
  SECTOR_ONE,
  SECTOR_TWO,
  SECTOR_THREE,
  SECTOR_FOUR,
  SECTOR_FIVE,
]

/**
 * The standard five-stop run: which sector, guarded by what, complicated by
 * which hazards.
 *
 * Sector 1 carries no hazard, and that is a design choice rather than an
 * omission. The Debris Shelf's whole thesis is that nothing is unfair and every
 * death is legible as a mistake; a field effect the pilot cannot shoot is
 * exactly the wrong first lesson. Hazards start at The Tally, where the pilot
 * has a build and a route choice, and the finale carries two because doubling up
 * is itself an escalation — one takes integrity, the other takes information,
 * and they are worst together.
 *
 * `bossId` is null on every stage and must not be read as "these sectors have no
 * boss". Boss definitions live in `src/content/bosses.ts`, which this file
 * deliberately does not import: naming an id here that no table can be checked
 * against would be an unverifiable cross-file promise, and the failure mode is a
 * run that dies at a stage boundary. Whoever wires the run assembles the pairing
 * from both tables, and `tests/sectors.test.ts` will check it the moment ids
 * appear here.
 */
export const RUN_STAGES: readonly RunStageDef[] = [
  { sectorId: SECTOR_ONE.id, bossId: null, hazardIds: [] },
  { sectorId: SECTOR_TWO.id, bossId: null, hazardIds: ['convoy-wake'] },
  { sectorId: SECTOR_THREE.id, bossId: null, hazardIds: ['spore-bloom'] },
  { sectorId: SECTOR_FOUR.id, bossId: null, hazardIds: ['grid-sweep'] },
  { sectorId: SECTOR_FIVE.id, bossId: null, hazardIds: ['manifest-blackout', 'hold-rot'] },
]

export const STANDARD_RUN: RunDef = {
  id: 'standard',
  name: 'Salvage Contract',
  stages: RUN_STAGES,
}

/** Look up a sector by id, throwing on an unknown one. */
export function getSector(id: string): SectorDef {
  const found = SECTORS.find((sector) => sector.id === id)
  if (found === undefined) throw new Error(`Unknown sector id: ${id}`)
  return found
}
