import { describe, expect, it } from 'vitest'
import { ENEMIES, SECTOR_ONE_MAX_CONTACT_DAMAGE, getEnemy } from '../src/content/enemies'
import { SECTOR_ONE } from '../src/content/sectors'
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
