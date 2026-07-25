import { describe, expect, it } from 'vitest'
import {
  ENEMIES,
  FORWARD_PLAY_Y_FRACTION,
  PARKED_CLEARANCE,
  PLAYER_BASELINE_DPS,
  SECTOR_ONE_MAX_CONTACT_DAMAGE,
  SECTOR_ONE_MAX_HP_SECONDS,
  getEnemy,
  maxParkedY,
} from '../src/content/enemies'
import { SECTOR_ONE } from '../src/content/sectors'
import { PLAYFIELD_H } from '../src/core/space'
import type { EnemyDef, FormationPattern, MovementKind, SectorDef } from '../src/content/types'

/**
 * Content integrity tests.
 *
 * These exist because content is data and data has no compiler. TypeScript can
 * check that a wave has an `enemyId: string`; only a test can check that the
 * string names an enemy that exists. Every assertion here corresponds to a bug
 * that would otherwise surface as a silent no-spawn or a crash mid-run.
 *
 * The difficulty-curve assertion is the load-bearing one: it is the only
 * automated check that a hand-authored wave script is still a difficulty curve
 * after an edit.
 */

const SECTORS: SectorDef[] = [SECTOR_ONE]

/** Movement fields the sim requires per kind. Mirrors the doc comments on MovementParams. */
const REQUIRED_MOVEMENT_PARAMS: Record<MovementKind, readonly (keyof EnemyDef['movementParams'])[]> =
  {
    drift: ['speed'],
    sine: ['speed', 'amplitude', 'frequency'],
    swoop: ['speed', 'holdYFraction'],
    hover: ['speed', 'holdYFraction'],
    strafe: ['speed', 'holdYFraction'],
  }

const enemyEntries: [string, EnemyDef][] = Object.entries(ENEMIES)

function isArmed(def: EnemyDef): boolean {
  return def.weapon.kind !== 'none'
}

describe('enemy registry', () => {
  it('is not empty', () => {
    // Guards against the whole roster being accidentally emptied, which would
    // make every other assertion here pass vacuously.
    expect(enemyEntries.length).toBeGreaterThanOrEqual(6)
  })

  it('keys match the id on each definition', () => {
    // The spawner looks enemies up by key but attributes deaths by `id`. If they
    // disagree, an incident report names the wrong enemy.
    for (const [key, def] of enemyEntries) {
      expect(def.id).toBe(key)
    }
  })

  it('gives every enemy a name, positive hp, and a positive radius', () => {
    for (const [key, def] of enemyEntries) {
      expect(def.name.length, key).toBeGreaterThan(0)
      expect(def.hp, key).toBeGreaterThan(0)
      expect(def.radius, key).toBeGreaterThan(0)
      expect(def.scrap, key).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('getEnemy', () => {
  it('returns the definition for a known id', () => {
    expect(getEnemy('hauler').id).toBe('hauler')
  })

  it('throws on an unknown id', () => {
    // Loudly, not undefined: a typo in a wave script must not become a missing
    // enemy that silently changes a seeded run.
    expect(() => getEnemy('no-such-enemy')).toThrow(/no-such-enemy/)
  })

  it('throws on an id that collides with an Object prototype member', () => {
    // `ENEMIES` is an object literal, so a naive lookup would resolve
    // 'constructor' or 'toString' to inherited members instead of failing.
    expect(() => getEnemy('constructor')).toThrow()
    expect(() => getEnemy('toString')).toThrow()
  })
})

describe('enemy weapons', () => {
  it('gives every armed enemy a reaction window and a repeat interval', () => {
    // Something that fires the instant it spawns is unreactable, not difficult.
    for (const [key, def] of enemyEntries) {
      if (!isArmed(def)) continue
      expect(def.weapon.firstDelayTicks, key).toBeGreaterThan(0)
      expect(def.weapon.intervalTicks, key).toBeGreaterThan(0)
      expect(def.weapon.bulletSpeed, key).toBeGreaterThan(0)
      expect(def.weapon.damage, key).toBeGreaterThan(0)
    }
  })

  it('defines count for spread and ring weapons, and spreadDegrees for spread', () => {
    for (const [key, def] of enemyEntries) {
      const { kind, count, spreadDegrees } = def.weapon
      if (kind === 'spread' || kind === 'ring') {
        expect(count, `${key} count`).toBeDefined()
        expect(count as number, `${key} count`).toBeGreaterThan(1)
      }
      if (kind === 'spread') {
        expect(spreadDegrees, `${key} spreadDegrees`).toBeDefined()
        expect(spreadDegrees as number, `${key} spreadDegrees`).toBeGreaterThan(0)
        expect(spreadDegrees as number, `${key} spreadDegrees`).toBeLessThan(360)
      }
    }
  })

  it('leaves unarmed enemies with no projectile configuration', () => {
    for (const [key, def] of enemyEntries) {
      if (isArmed(def)) continue
      expect(def.weapon.damage, key).toBe(0)
      expect(def.weapon.bulletSpeed, key).toBe(0)
    }
  })

  it('gives every armed enemy a readable telegraph', () => {
    // The M2 mechanic. A volley with no windup arrives unannounced, which
    // `types.ts` says should be rare and deliberate — in sector 1 it is simply
    // wrong, because "nothing is unfair" is the sector's whole thesis.
    //
    // The 15-tick floor is 0.25s, roughly the time to see a cue and begin
    // moving. Below that the tell exists in the data and not in the game.
    for (const [key, def] of enemyEntries) {
      if (!isArmed(def)) continue
      expect(def.weapon.windupTicks, `${key} windupTicks`).toBeGreaterThanOrEqual(15)
    }
  })

  it('keeps every telegraph under half its own firing interval', () => {
    // Two reasons, and the second is why this is asserted rather than merely
    // preferred.
    //
    // 1. A windup that fills most of the interval means the enemy is always
    //    winding up, and a warning light that is never off is not a warning.
    // 2. The sim has not landed the mechanic yet, and whether the windup runs
    //    inside `intervalTicks` or is added on top of it changes the sector's
    //    entire damage output. Simulating the additive reading took
    //    `aggressor`'s clear rate from 40.3% to 76.3% across 300 seeds. Capping
    //    the windup at half the interval bounds that blast radius to a factor
    //    of 1.5 on cadence, and bounds the correction if it has to be made.
    //    See the windup budget note at the top of `enemies.ts`.
    for (const [key, def] of enemyEntries) {
      if (!isArmed(def)) continue
      expect(def.weapon.windupTicks, `${key} windup vs interval`).toBeLessThanOrEqual(
        def.weapon.intervalTicks / 2,
      )
    }
  })

  it('leaves unarmed enemies with no telegraph', () => {
    // An unarmed enemy that reports a windup would make the renderer draw a
    // tell for a shot that never comes, which is worse than no tell at all.
    for (const [key, def] of enemyEntries) {
      if (isArmed(def)) continue
      expect(def.weapon.windupTicks, key).toBe(0)
    }
  })

  it('gives every death burst a count, speed, and damage', () => {
    for (const [key, def] of enemyEntries) {
      const burst = def.deathBurst
      if (burst === undefined) continue
      expect(burst.count, key).toBeGreaterThan(1)
      expect(burst.bulletSpeed, key).toBeGreaterThan(0)
      expect(burst.damage, key).toBeGreaterThan(0)
    }
  })
})

describe('enemy movement', () => {
  it('supplies every parameter the movement kind needs', () => {
    for (const [key, def] of enemyEntries) {
      const required = REQUIRED_MOVEMENT_PARAMS[def.movement]
      for (const field of required) {
        expect(def.movementParams[field], `${key}.${field}`).toBeDefined()
      }
      expect(def.movementParams.speed, key).toBeGreaterThan(0)
    }
  })

  it('keeps hold positions inside the playfield', () => {
    for (const [key, def] of enemyEntries) {
      const hold = def.movementParams.holdYFraction
      if (hold === undefined) continue
      expect(hold, key).toBeGreaterThan(0)
      expect(hold, key).toBeLessThan(1)
    }
  })

  it('gives swoop enemies a telegraph and a dive that is faster than the approach', () => {
    // A swoop without a pause is just a fast drift, and the lancer's whole
    // lesson is that the pause is the warning.
    for (const [key, def] of enemyEntries) {
      if (def.movement !== 'swoop') continue
      expect(def.movementParams.holdTicks, key).toBeGreaterThan(0)
      expect(def.movementParams.diveMultiplier as number, key).toBeGreaterThan(1)
    }
  })

  it('never parks an enemy inside the band a forward-flying pilot occupies', () => {
    // THIS IS THE M1 DEFECT, WRITTEN DOWN. The lancer parked at y=216 and a
    // pilot pushing forward sits at y=230; lancer radius 13 plus hull hitbox
    // radius 7 is 20, so the enemy arrived already touching the pilot it was
    // supposed to be warning. 41% of `greedy`'s deaths were `collision:lancer`
    // and *none of the 82 measured happened during the dive* — the telegraph was
    // being delivered after the impact. `greedy` therefore died at 124.1s with a
    // 2.3-second interquartile range across 200 seeds: not a distribution, a
    // wall, and half the playfield unusable from wave 21 on.
    //
    // The bug is not "the number was too big". It is that a stationary phase and
    // contact damage are the same enemy: anything that stops moving becomes an
    // obstacle, and an obstacle placed where the player flies is a hit, not a
    // lesson. That is a class of mistake, not one typo, which is why it is
    // asserted for every parking movement kind rather than for the lancer.
    const parking: readonly MovementKind[] = ['hover', 'swoop', 'strafe']
    for (const [key, def] of enemyEntries) {
      if (!parking.includes(def.movement)) continue
      const hold = def.movementParams.holdYFraction
      expect(hold, `${key} parks but has no holdYFraction`).toBeDefined()
      const holdY = (hold as number) * PLAYFIELD_H
      expect(holdY + def.radius, `${key} parks at y=${holdY.toFixed(0)}`).toBeLessThanOrEqual(
        maxParkedY(def.radius) + def.radius,
      )
      // Same assertion spelled out, so a failure reads as a distance rather than
      // as two numbers the reader has to subtract.
      const clearance = FORWARD_PLAY_Y_FRACTION * PLAYFIELD_H - holdY - def.radius
      expect(clearance, `${key} clearance below its parking spot`).toBeGreaterThanOrEqual(
        PARKED_CLEARANCE,
      )
    }
  })

  it('keeps sine oscillation inside the playfield width', () => {
    for (const [key, def] of enemyEntries) {
      if (def.movement !== 'sine') continue
      expect(def.movementParams.amplitude as number, key).toBeGreaterThan(0)
      // Full swing is 2x amplitude; keep it under half the 448-wide playfield so
      // a sine enemy reads as a curve rather than a screen-wide sweep.
      expect((def.movementParams.amplitude as number) * 2, key).toBeLessThan(224)
      expect(def.movementParams.frequency as number, key).toBeGreaterThan(0)
    }
  })
})

describe('sector 1 fairness constraints', () => {
  it('keeps contact damage under the sector-1 ceiling', () => {
    // A quarter of the hull's 140 effective health. See enemies.ts.
    for (const [key, def] of enemyEntries) {
      expect(def.contactDamage, key).toBeGreaterThan(0)
      expect(def.contactDamage, key).toBeLessThanOrEqual(SECTOR_ONE_MAX_CONTACT_DAMAGE)
    }
  })

  it('keeps every projectile slower than the hull', () => {
    // HULL_SPEED is 210. Anything at or above that cannot be out-run, and
    // "dodgeable on sight" is the defining property of the Debris Shelf.
    const HULL_SPEED = 210
    for (const [key, def] of enemyEntries) {
      if (isArmed(def)) {
        expect(def.weapon.bulletSpeed, `${key} weapon`).toBeLessThan(HULL_SPEED)
      }
      if (def.deathBurst !== undefined) {
        expect(def.deathBurst.bulletSpeed, `${key} deathBurst`).toBeLessThan(HULL_SPEED)
      }
    }
  })

  it('keeps non-elite HP inside a killable window', () => {
    // HP in this sector is authored as *seconds of the player's attention*, and
    // 2.5s at the starting hull's 80 dps is the ceiling. The turret shipped at
    // 220 (2.75s) in M1 and the sweep showed what that buys: `random` killed 15%
    // of the turrets it met, 58% were still alive when its run ended, and 59% of
    // its deaths were turret-attributed. Past this line an enemy stops forcing a
    // priority call and starts simply outlasting the player, which reads as the
    // game refusing to end rather than as difficulty.
    //
    // Elites are exempt by design — being fought across several windows is what
    // makes one an elite.
    const ceiling = SECTOR_ONE_MAX_HP_SECONDS * PLAYER_BASELINE_DPS
    for (const [key, def] of enemyEntries) {
      if (def.elite === true) continue
      expect(def.hp, `${key} is ${(def.hp / PLAYER_BASELINE_DPS).toFixed(2)}s of fire`).toBeLessThanOrEqual(
        ceiling,
      )
    }
  })

  it('has at most one elite in the sector', () => {
    // "One elite variant" is a structural claim about the sector, not a stat.
    const eliteSpawns = SECTOR_ONE.waves
      .flatMap((wave) => wave.formations)
      .filter((formation) => getEnemy(formation.enemyId).elite === true)
    expect(eliteSpawns).toHaveLength(1)
    expect(eliteSpawns[0]?.count).toBe(1)
  })
})

describe.each(SECTORS.map((sector) => [sector.id, sector] as const))(
  'sector %s wave script',
  (_id, sector) => {
    const formations = sector.waves.flatMap((wave) => wave.formations)

    it('references only enemies that exist', () => {
      for (const formation of formations) {
        expect(
          Object.hasOwn(ENEMIES, formation.enemyId),
          `unknown enemyId: ${formation.enemyId}`,
        ).toBe(true)
        expect(() => getEnemy(formation.enemyId)).not.toThrow()
      }
    })

    it('spawns a positive count in every formation', () => {
      for (const formation of formations) {
        expect(formation.count, formation.enemyId).toBeGreaterThan(0)
        if (formation.staggerTicks !== undefined) {
          expect(formation.staggerTicks, formation.enemyId).toBeGreaterThanOrEqual(0)
        }
        if (formation.atXFraction !== undefined) {
          expect(formation.atXFraction, formation.enemyId).toBeGreaterThan(0)
          expect(formation.atXFraction, formation.enemyId).toBeLessThan(1)
        }
      }
    })

    it('lists waves in ascending atSeconds order', () => {
      // The spawner walks the list once and releases waves in order; an
      // out-of-order entry would either fire late or never.
      const times = sector.waves.map((wave) => wave.atSeconds)
      for (let i = 1; i < times.length; i++) {
        expect(times[i] as number, `wave ${i}`).toBeGreaterThan(times[i - 1] as number)
      }
      expect(times[0] as number).toBeGreaterThan(0)
    })

    it('fits the last wave inside the sector duration', () => {
      const last = sector.waves[sector.waves.length - 1]
      expect(last).toBeDefined()
      expect((last as { atSeconds: number }).atSeconds).toBeLessThan(sector.durationSeconds)
    })

    it('uses every formation pattern at least once', () => {
      // Not decoration: each pattern asks a different positional question, and a
      // sector that only ever spawns lines is a sector with one idea in it.
      const used = new Set<FormationPattern>(formations.map((f) => f.pattern))
      for (const pattern of ['line', 'arc', 'column', 'scatter', 'flanks'] as const) {
        expect(used.has(pattern), `pattern ${pattern} unused`).toBe(true)
      }
    })

    it('does not release projectiles before the player has learned to shoot', () => {
      // The opening phase is the sector's teaching contract: nothing shoots for
      // the first 25 seconds. Documented in DESIGN.md and easy to break by
      // nudging one wave earlier.
      const armedBefore = sector.waves
        .filter((wave) => wave.atSeconds < 25)
        .flatMap((wave) => wave.formations)
        .filter((formation) => {
          const def = getEnemy(formation.enemyId)
          return def.weapon.kind !== 'none' || def.deathBurst !== undefined
        })
      expect(armedBefore.map((f) => f.enemyId)).toEqual([])
    })

    it('never decreases spawned HP across 30-second buckets', () => {
      // Total HP released per bucket is a proxy for how much of the player's
      // attention a stretch demands. A dip means the sector gets easier as it
      // goes on, which is a wave-script bug — fix the script, not this test.
      const bucketSeconds = 30
      const bucketCount = Math.ceil(sector.durationSeconds / bucketSeconds)
      const hpByBucket = new Array<number>(bucketCount).fill(0)

      for (const wave of sector.waves) {
        const bucket = Math.floor(wave.atSeconds / bucketSeconds)
        expect(bucket).toBeLessThan(bucketCount)
        for (const formation of wave.formations) {
          hpByBucket[bucket] =
            (hpByBucket[bucket] as number) + getEnemy(formation.enemyId).hp * formation.count
        }
      }

      // Every bucket must contain something, or the "curve" has a hole in it.
      for (let i = 0; i < bucketCount; i++) {
        expect(hpByBucket[i] as number, `bucket ${i} is empty`).toBeGreaterThan(0)
      }
      for (let i = 1; i < bucketCount; i++) {
        expect(
          hpByBucket[i] as number,
          `bucket ${i} (${hpByBucket[i]}) is easier than bucket ${i - 1} (${hpByBucket[i - 1]})`,
        ).toBeGreaterThanOrEqual(hpByBucket[i - 1] as number)
      }
      // And the end must be meaningfully harder than the start, not merely flat —
      // non-decreasing alone would be satisfied by a constant sector.
      expect(hpByBucket[bucketCount - 1] as number).toBeGreaterThan(
        (hpByBucket[0] as number) * 2,
      )
    })
  },
)
