/**
 * Wave scheduling.
 *
 * Reads a SectorDef and releases formations at their scheduled ticks. All
 * randomness comes from the caller-supplied `spawn` stream, and every draw
 * happens at a release tick that is fixed by the sector script — never in
 * response to anything the player did. That is what makes two runs of the same
 * seed face the same enemies in the same places even if they are played
 * differently.
 */

import { TICK_HZ } from '../core/loop'
import type { Rng } from '../core/rng'
import { clamp, PLAYFIELD_W } from '../core/space'
import type { EnemyDef, FormationDef, SectorDef, WaveEntry } from '../content/types'
import type { EnemyInstance } from './entities'
import { createEnemy } from './enemies'

/** Gap between the top edge and a spawning enemy's near side. */
const SPAWN_ABOVE = 16
/**
 * Positional jitter, in virtual units. Small on purpose: enough that two runs of
 * the same wave don't look stamped from a template, small enough that a line
 * still reads as a line. Formations are information, and blurring them would cost
 * priority-1 legibility for a cosmetic gain.
 */
const JITTER = 3
const DEFAULT_SPACING = 34
/** How far behind the leaders an arc's wingtips sit. */
const ARC_DEPTH = 26
/** Distance of each flank group from the formation centre, as a width fraction. */
const FLANK_OFFSET_FRACTION = 0.26
/** Vertical spread of a scatter group, per enemy. */
const SCATTER_DEPTH_PER_ENEMY = 26
/** Keep scattered spawns off the very edge, where they are hard to read. */
const SCATTER_EDGE_MARGIN = 28

interface ScheduledWave {
  releaseTick: number
  entry: WaveEntry
}

interface PendingSpawn {
  dueTick: number
  def: EnemyDef
  x: number
  y: number
}

export class Spawner {
  /**
   * Next enemy instance id. Owned here because a Spawner's lifetime is a run's
   * lifetime, so the sequence restarts with every run without any global state.
   */
  private nextUid = 1

  private readonly schedule: ScheduledWave[]
  private nextWave = 0
  /** Staggered members of already-released formations, waiting for their tick. */
  private readonly pending: PendingSpawn[] = []
  private wavesReleased = 0

  constructor(
    sector: SectorDef,
    private readonly defs: Record<string, EnemyDef>,
    private readonly rng: Rng,
  ) {
    // Fail at construction, not mid-run. A formation naming an enemy that does
    // not exist is a content bug, and discovering it as a silently missing wave
    // ninety seconds into a sortie is much worse than not starting.
    for (const wave of sector.waves) {
      for (const formation of wave.formations) {
        if (this.defs[formation.enemyId] === undefined) {
          throw new Error(
            `Sector "${sector.id}" wave at ${wave.atSeconds}s references unknown enemy "${formation.enemyId}"`,
          )
        }
      }
    }

    // Sorted so content may list waves in any order. The index tiebreak keeps the
    // ordering total, rather than relying on sort stability for equal times.
    this.schedule = sector.waves
      .map((entry, index) => ({ entry, index, releaseTick: Math.round(entry.atSeconds * TICK_HZ) }))
      .sort((a, b) => a.releaseTick - b.releaseTick || a.index - b.index)
      .map(({ entry, releaseTick }) => ({ entry, releaseTick }))
  }

  /** Number of waves released so far. 0 before the first one. */
  get waveIndex(): number {
    return this.wavesReleased
  }

  /**
   * Reserve the next instance id.
   *
   * Exposed so a boss — which is spawned by the World rather than by a wave script —
   * draws from the same sequence. Two sequences would eventually issue the same uid
   * to two live enemies, and a piercing round would then skip whichever it met
   * second, silently and only sometimes.
   */
  takeUid(): number {
    return this.nextUid++
  }

  /** True once the script is exhausted and no staggered spawns remain. */
  get finished(): boolean {
    return this.nextWave >= this.schedule.length && this.pending.length === 0
  }

  /**
   * Release anything due at `tick` into `out`.
   *
   * Releasing a wave expands it into positioned spawns immediately (consuming the
   * RNG at that moment) even when `staggerTicks` delays their arrival, so the
   * number of draws depends only on the schedule.
   */
  update(tick: number, out: EnemyInstance[]): void {
    while (this.nextWave < this.schedule.length) {
      const wave = this.schedule[this.nextWave] as ScheduledWave
      if (wave.releaseTick > tick) break
      for (const formation of wave.entry.formations) {
        this.expand(formation, wave.releaseTick)
      }
      this.nextWave++
      this.wavesReleased++
    }

    // Forward compaction rather than backwards swap-remove: spawn order within a
    // tick must match the order the formations were written in, or the entity
    // array's contents depend on removal order.
    let write = 0
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i] as PendingSpawn
      if (p.dueTick <= tick) {
        out.push(createEnemy(p.def, p.x, p.y, this.nextUid++))
      } else {
        this.pending[write++] = p
      }
    }
    this.pending.length = write
  }

  private expand(formation: FormationDef, releaseTick: number): void {
    const def = this.defs[formation.enemyId]
    if (def === undefined) return

    const count = Math.max(1, Math.floor(formation.count))
    const spacing = formation.spacing ?? DEFAULT_SPACING
    const stagger = Math.max(0, formation.staggerTicks ?? 0)
    const baseY = -(def.radius + SPAWN_ABOVE)
    // An unset centre is rolled, but kept off the walls: a formation pinned to an
    // edge is unreadable and half of it gets clamped into a stack.
    const centreX =
      formation.atXFraction !== undefined
        ? formation.atXFraction * PLAYFIELD_W
        : this.rng.range(0.22, 0.78) * PLAYFIELD_W

    const halfSpan = (count - 1) / 2

    for (let i = 0; i < count; i++) {
      const offset = i - halfSpan
      let x = centreX
      let y = baseY
      let jitter = true

      switch (formation.pattern) {
        case 'line':
          x = centreX + offset * spacing
          break

        case 'arc': {
          // Wingtips trail the centre, so the group enters as a chevron and the
          // player can see the shape before all of it is on screen.
          const u = halfSpan > 0 ? offset / halfSpan : 0
          x = centreX + offset * spacing
          y = baseY - ARC_DEPTH * u * u
          break
        }

        case 'column':
          y = baseY - i * spacing
          break

        case 'flanks': {
          // Two groups either side of centre. Odd counts weight the left group,
          // deterministically, rather than rolling for it.
          const leftCount = Math.ceil(count / 2)
          const onLeft = i < leftCount
          const side = onLeft ? -1 : 1
          const indexInSide = onLeft ? i : i - leftCount
          const sideCount = onLeft ? leftCount : count - leftCount
          const sideOffset = indexInSide - (sideCount - 1) / 2
          x = centreX + side * FLANK_OFFSET_FRACTION * PLAYFIELD_W + sideOffset * spacing
          break
        }

        case 'scatter':
          x = this.rng.range(SCATTER_EDGE_MARGIN, PLAYFIELD_W - SCATTER_EDGE_MARGIN)
          y = baseY - this.rng.range(0, count * SCATTER_DEPTH_PER_ENEMY)
          // Already random; jittering it further would only cost extra draws.
          jitter = false
          break
      }

      if (jitter) {
        x += this.rng.range(-JITTER, JITTER)
        y += this.rng.range(-JITTER, JITTER)
      }

      this.pending.push({
        dueTick: releaseTick + i * stagger,
        def,
        x: clamp(x, def.radius + 2, PLAYFIELD_W - def.radius - 2),
        y,
      })
    }
  }
}
