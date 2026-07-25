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
 */

import type { SectorDef } from './types'

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
 * Every sector that actually exists, in order.
 *
 * The HUD reads its "sector N of M" denominator from this array's length rather
 * than from the five sectors DESIGN.md plans. A tester cleared sector 1, saw the
 * panel still reading `1 / 5`, and reasonably concluded the game had failed to
 * advance — the readout was describing the design document, not the build.
 *
 * Add sectors here as they land and the HUD corrects itself.
 */
export const SECTORS: readonly SectorDef[] = [SECTOR_ONE]
