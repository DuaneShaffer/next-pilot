import { describe, expect, it } from 'vitest'
import { DODGEABLE_BULLET_SPEED, ENEMIES, getEnemy } from '../src/content/enemies'
import { BOSSES } from '../src/content/bosses'
import { HAZARDS, HAZARDS_AWAITING_MECHANICS, getHazard } from '../src/content/hazards'
import { STAGES } from '../src/content/runs'
import { RUN_STAGES, SECTORS, STANDARD_RUN, getSector } from '../src/content/sectors'
import { TICK_HZ } from '../src/core/loop'
import type { EnemyDef, SectorDef } from '../src/content/types'

/**
 * The multi-sector content contract.
 *
 * `tests/content.test.ts` checks that one hand-authored sector is internally
 * coherent. This file checks the things that only become checkable once there
 * are five of them: that the run gets harder rather than longer, that each
 * sector is a different *kind* of fight rather than the previous one with bigger
 * numbers, and that the fairness rules sector 1 established still hold four
 * sectors later, where the temptation to break them is strongest.
 *
 * The two load-bearing assertions here are the enemy-grammar ones. Everything
 * else guards against a typo; those two guard against the design failure
 * `docs/DESIGN.md` names explicitly — "a distinct enemy grammar so the run has
 * texture rather than escalating sameness". That is a property no compiler and
 * no eyeball review reliably catches, because a sector built by copying the
 * previous one and editing counts looks perfectly fine in a diff.
 */

/** Damage output a pilot is assumed to have in each sector. See enemies.ts. */
const ASSUMED_DPS: readonly number[] = [80, 96, 120, 140, 160]

/** src/sim/world.ts. Every projectile in the game is measured against this. */
const HULL_SPEED = 210

/**
 * Seconds at the start of a sector during which nothing armed may spawn.
 *
 * Sector 1 holds its fire for 25 seconds because it is teaching. Later sectors
 * do not need that, but they do need the reason underneath it: a sector begins
 * immediately after a work-order screen, so the pilot's first sight of the
 * playfield is also their first frame of it. Four seconds is enough to read the
 * field before anything is committed to a shot at it, and it is the floor rather
 * than the target — the actual openings are 3.5–5s of unarmed contact.
 */
const ARMED_GRACE_SECONDS = 4

/** Sector 1's own, stricter opening contract. Asserted separately. */
const SECTOR_ONE_ARMED_GRACE_SECONDS = 25

const BUCKET_SECONDS = 30

function isArmed(def: EnemyDef): boolean {
  return def.weapon.kind !== 'none' || def.deathBurst !== undefined
}

/** Every distinct enemy id a sector's script can spawn. */
function enemySet(sector: SectorDef): Set<string> {
  return new Set(sector.waves.flatMap((wave) => wave.formations).map((f) => f.enemyId))
}

function totalSpawnedHp(sector: SectorDef): number {
  return sector.waves
    .flatMap((wave) => wave.formations)
    .reduce((sum, f) => sum + getEnemy(f.enemyId).hp * f.count, 0)
}

function hpByBucket(sector: SectorDef): number[] {
  const buckets = new Array<number>(Math.ceil(sector.durationSeconds / BUCKET_SECONDS)).fill(0)
  for (const wave of sector.waves) {
    const bucket = Math.floor(wave.atSeconds / BUCKET_SECONDS)
    for (const formation of wave.formations) {
      buckets[bucket] = (buckets[bucket] as number) + getEnemy(formation.enemyId).hp * formation.count
    }
  }
  return buckets
}

describe('the run is five sectors', () => {
  it('ships every sector docs/DESIGN.md names, in order', () => {
    expect(SECTORS.map((sector) => sector.id)).toEqual([
      'debris-shelf',
      'the-tally',
      'bloomfield',
      'kill-grid',
      'deep-manifest',
    ])
  })

  it('gives every sector a unique id and a name', () => {
    const ids = new Set(SECTORS.map((sector) => sector.id))
    expect(ids.size).toBe(SECTORS.length)
    for (const sector of SECTORS) {
      expect(sector.name.length, sector.id).toBeGreaterThan(0)
      expect(sector.durationSeconds, sector.id).toBeGreaterThan(0)
      expect(sector.waves.length, sector.id).toBeGreaterThan(0)
    }
  })

  it('keeps the whole run inside the 15–20 minute target', () => {
    // DESIGN.md: "A full successful run should take 15-20 minutes." Combat is
    // the floor; work-order screens and five boss fights sit on top of it, so
    // the sectors themselves have to leave room.
    const combatSeconds = SECTORS.reduce((sum, sector) => sum + sector.durationSeconds, 0)
    expect(combatSeconds).toBeGreaterThanOrEqual(13 * 60)
    expect(combatSeconds).toBeLessThanOrEqual(17 * 60)
  })

  it('resolves every sector by id and throws on an unknown one', () => {
    for (const sector of SECTORS) expect(getSector(sector.id).id).toBe(sector.id)
    expect(() => getSector('no-such-sector')).toThrow(/no-such-sector/)
  })
})

describe('difficulty escalates from sector to sector', () => {
  it('increases total spawned HP at every boundary', () => {
    // The blunt instrument, and the one that catches a sector authored as a
    // sidegrade. It is necessary and nowhere near sufficient — see the load
    // assertion below, which is the number the sectors were actually tuned to.
    const totals = SECTORS.map(totalSpawnedHp)
    for (let i = 1; i < totals.length; i++) {
      expect(
        totals[i] as number,
        `${SECTORS[i]?.id} (${totals[i]}) spawns no more than ${SECTORS[i - 1]?.id} (${totals[i - 1]})`,
      ).toBeGreaterThan(totals[i - 1] as number)
    }
  })

  it('increases the share of the pilot output a sector demands', () => {
    // Raw HP rising proves nothing on its own: the pilot's damage output is
    // rising too, so a sector with 40% more HP against a pilot with 40% more
    // damage is exactly as hard as the one before it. Load — HP per second over
    // assumed dps — is the comparison that survives that, and it is what the
    // wave counts in sectors.ts were fitted to.
    const loads = SECTORS.map(
      (sector, i) => totalSpawnedHp(sector) / sector.durationSeconds / (ASSUMED_DPS[i] as number),
    )
    for (let i = 1; i < loads.length; i++) {
      expect(
        loads[i] as number,
        `${SECTORS[i]?.id} demands ${((loads[i] as number) * 100).toFixed(0)}% against ${((loads[i - 1] as number) * 100).toFixed(0)}%`,
      ).toBeGreaterThan(loads[i - 1] as number)
    }
    // And the finale must be hard without being a pure damage check. Above ~70%
    // a pilot whose build did not come together cannot clear the screen however
    // well they fly, which converts a skill problem into an item-luck problem.
    expect(loads[loads.length - 1] as number).toBeLessThan(0.7)
  })

  it('gives the later sectors more waves per minute than the tutorial', () => {
    const perMinute = (sector: SectorDef): number =>
      (sector.waves.length / sector.durationSeconds) * 60
    const first = perMinute(SECTORS[0] as SectorDef)
    for (const sector of SECTORS.slice(1)) {
      expect(perMinute(sector), sector.id).toBeGreaterThanOrEqual(first * 0.75)
    }
  })
})

describe.each(SECTORS.map((sector) => [sector.id, sector] as const))(
  'sector %s',
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

    it('spawns a positive count from a sane position in every formation', () => {
      for (const formation of formations) {
        expect(formation.count, formation.enemyId).toBeGreaterThan(0)
        if (formation.atXFraction !== undefined) {
          expect(formation.atXFraction, formation.enemyId).toBeGreaterThan(0)
          expect(formation.atXFraction, formation.enemyId).toBeLessThan(1)
        }
        if (formation.staggerTicks !== undefined) {
          expect(formation.staggerTicks, formation.enemyId).toBeGreaterThanOrEqual(0)
        }
      }
    })

    it('lists waves in ascending order and fits them inside the duration', () => {
      const times = sector.waves.map((wave) => wave.atSeconds)
      expect(times[0] as number).toBeGreaterThan(0)
      for (let i = 1; i < times.length; i++) {
        expect(times[i] as number, `wave ${i}`).toBeGreaterThan(times[i - 1] as number)
      }
      expect(times[times.length - 1] as number).toBeLessThan(sector.durationSeconds)
    })

    it('leaves the last wave time to resolve before the sector ends', () => {
      // Sector 1 closes its script at 174s against 180s nominal so the sector
      // ends on the last kill rather than on a timer. A wave released at 179s
      // would still be descending when the stage boundary arrives, which reads
      // to the player as enemies being deleted.
      const last = sector.waves[sector.waves.length - 1]?.atSeconds as number
      expect(sector.durationSeconds - last, 'tail before the sector ends').toBeGreaterThanOrEqual(5)
    })

    it('releases nothing armed inside the opening grace period', () => {
      // Reactability, not teaching: the pilot's first frame of a sector is also
      // their first sight of it. Death bursts count as armed — a strongbox that
      // spawns at 1s and is shot at 2s is a volley the pilot never saw coming.
      const grace =
        sector.id === 'debris-shelf' ? SECTOR_ONE_ARMED_GRACE_SECONDS : ARMED_GRACE_SECONDS
      const early = sector.waves
        .filter((wave) => wave.atSeconds < grace)
        .flatMap((wave) => wave.formations)
        .filter((formation) => isArmed(getEnemy(formation.enemyId)))
      expect(early.map((f) => f.enemyId)).toEqual([])
    })

    it('never decreases spawned HP across 30-second buckets', () => {
      const buckets = hpByBucket(sector)
      for (let i = 0; i < buckets.length; i++) {
        expect(buckets[i] as number, `${sector.id} bucket ${i} is empty`).toBeGreaterThan(0)
      }
      for (let i = 1; i < buckets.length; i++) {
        expect(
          buckets[i] as number,
          `bucket ${i} (${buckets[i]}) is easier than bucket ${i - 1} (${buckets[i - 1]})`,
        ).toBeGreaterThanOrEqual(buckets[i - 1] as number)
      }
      // Non-decreasing alone is satisfied by a flat sector, which is not a curve.
      expect(buckets[buckets.length - 1] as number).toBeGreaterThan(
        (buckets[0] as number) * 1.5,
      )
    })

    it('never fires a projectile the hull cannot out-run', () => {
      // The fairness floor for the whole game. Checked per sector rather than
      // per enemy so a failure names the place the player would meet it.
      for (const id of enemySet(sector)) {
        const def = getEnemy(id)
        if (def.weapon.kind !== 'none') {
          expect(def.weapon.bulletSpeed, `${id} weapon in ${sector.id}`).toBeLessThan(HULL_SPEED)
          expect(def.weapon.bulletSpeed, `${id} weapon in ${sector.id}`).toBeLessThanOrEqual(
            DODGEABLE_BULLET_SPEED,
          )
        }
        if (def.deathBurst !== undefined) {
          expect(def.deathBurst.bulletSpeed, `${id} burst in ${sector.id}`).toBeLessThanOrEqual(
            DODGEABLE_BULLET_SPEED,
          )
        }
      }
    })

    it('telegraphs every volley it fires', () => {
      // The 15-tick floor is 0.25s, roughly the time to see a cue and begin
      // moving. content.test.ts asserts this over the registry; here it is
      // asserted over what a player actually *meets*, which is the claim that
      // matters and the one that survives an enemy being added to a sector
      // without being reviewed as part of it.
      for (const id of enemySet(sector)) {
        const def = getEnemy(id)
        if (def.weapon.kind === 'none') continue
        expect(def.weapon.windupTicks, `${id} in ${sector.id}`).toBeGreaterThanOrEqual(15)
        expect(def.weapon.firstDelayTicks, `${id} in ${sector.id}`).toBeGreaterThan(0)
      }
    })

    it('holds no elite back until the pilot cannot see it coming', () => {
      // An elite is a set piece and needs room. Dropping one into the first
      // seconds of a sector makes it an ambush instead.
      for (const wave of sector.waves) {
        for (const formation of wave.formations) {
          if (getEnemy(formation.enemyId).elite !== true) continue
          expect(wave.atSeconds, `${formation.enemyId} at ${wave.atSeconds}s`).toBeGreaterThan(30)
        }
      }
    })
  },
)

describe('every sector has a distinct enemy grammar', () => {
  /**
   * THE ASSERTION THIS FILE EXISTS FOR.
   *
   * DESIGN.md: "Five sectors, each with a distinct enemy grammar so the run has
   * texture rather than escalating sameness." The cheapest way to author sector
   * N+1 is to copy sector N and raise the counts, and the result passes every
   * other test in this project — it has a rising curve, valid ids, fair
   * projectiles, and no texture whatsoever.
   */
  const sets = SECTORS.map((sector) => ({ id: sector.id, enemies: enemySet(sector) }))

  it('draws no two sectors from the same roster', () => {
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const a = sets[i] as { id: string; enemies: Set<string> }
        const b = sets[j] as { id: string; enemies: Set<string> }
        const identical =
          a.enemies.size === b.enemies.size && [...a.enemies].every((id) => b.enemies.has(id))
        expect(identical, `${a.id} and ${b.id} draw from the same roster`).toBe(false)
      }
    }
  })

  it('gives every sector at least one enemy that appears nowhere else', () => {
    // Stronger than "the sets differ", which a single extra enemy would satisfy
    // while leaving two sectors that play identically. A sector with nothing of
    // its own is a difficulty setting, not a place.
    for (const { id, enemies } of sets) {
      const exclusive = [...enemies].filter((enemyId) =>
        sets.every((other) => other.id === id || !other.enemies.has(enemyId)),
      )
      expect(exclusive.length, `${id} has no enemy of its own`).toBeGreaterThan(0)
    }
  })

  it('keeps any two sectors from overlapping by more than half their rosters', () => {
    // The Deep Manifest deliberately reuses sector 1's hardware, so exact-set
    // and unique-enemy checks are not enough on their own: a sector could be
    // 90% borrowed plus one new body and still pass both. Half is the line
    // between "quotes an earlier sector" and "is an earlier sector".
    for (let i = 0; i < sets.length; i++) {
      for (let j = i + 1; j < sets.length; j++) {
        const a = sets[i] as { id: string; enemies: Set<string> }
        const b = sets[j] as { id: string; enemies: Set<string> }
        const shared = [...a.enemies].filter((id) => b.enemies.has(id)).length
        const smaller = Math.min(a.enemies.size, b.enemies.size)
        expect(
          shared / smaller,
          `${a.id} and ${b.id} share ${shared} of ${smaller} enemy types`,
        ).toBeLessThanOrEqual(0.5)
      }
    }
  })

  it('gives every sector a weapon or movement mix no other sector has', () => {
    // Rosters can differ while every sector still poses the same question. The
    // *behaviour* mix is what the player experiences: sector 3 is rings and
    // bursts, sector 4 is fast precise fans, sector 2 is the only place where
    // most of the screen is unarmed. Two sectors with identical mixes would be
    // reskins however different their ids are.
    const signatures = SECTORS.map((sector) => {
      const kinds = new Set<string>()
      for (const id of enemySet(sector)) {
        const def = getEnemy(id)
        kinds.add(`${def.movement}:${def.weapon.kind}`)
        if (def.deathBurst !== undefined) kinds.add(`${def.movement}:burst`)
      }
      return { id: sector.id, signature: [...kinds].sort().join(',') }
    })
    const seen = new Map<string, string>()
    for (const { id, signature } of signatures) {
      const previous = seen.get(signature)
      expect(previous, `${id} behaves exactly like ${previous}`).toBeUndefined()
      seen.set(signature, id)
    }
  })

  it('uses every movement and weapon kind the sim implements somewhere', () => {
    // Not decoration. A kind the sim interprets and no content selects is dead
    // code that nothing exercises, and `strafe` was exactly that until sector 2.
    const movements = new Set<string>()
    const weapons = new Set<string>()
    for (const sector of SECTORS) {
      for (const id of enemySet(sector)) {
        movements.add(getEnemy(id).movement)
        weapons.add(getEnemy(id).weapon.kind)
      }
    }
    for (const kind of ['drift', 'sine', 'swoop', 'hover', 'strafe'] as const) {
      expect(movements.has(kind), `movement ${kind} is never used`).toBe(true)
    }
    for (const kind of ['none', 'aimed', 'spread', 'ring', 'tracker'] as const) {
      expect(weapons.has(kind), `weapon ${kind} is never used`).toBe(true)
    }
  })
})

describe('hazards', () => {
  const hazardEntries = Object.entries(HAZARDS)

  it('keys match the id on each definition', () => {
    for (const [key, def] of hazardEntries) expect(def.id).toBe(key)
  })

  it('gives every hazard a name and a readable cadence', () => {
    for (const [key, def] of hazardEntries) {
      expect(def.name.length, key).toBeGreaterThan(0)
      expect(def.damage, key).toBeGreaterThanOrEqual(0)
      // Anything under half a second is a continuous effect wearing a hazard's
      // clothes: it cannot be reacted to individually, so the player experiences
      // a damage rate rather than an event.
      expect(def.intervalTicks, key).toBeGreaterThanOrEqual(TICK_HZ / 2)
    }
  })

  it('states the trade-off in plain language, with its real numbers', () => {
    /**
     * These strings are read on the world map at the moment a route is chosen,
     * so they are the same class of text as an item's `mechanism` (UI.md rule
     * 4). The assertion is mechanical on purpose: a hazard whose numbers are
     * retuned and whose description is not is a lie told to the player at the
     * exact moment they are making a decision, and no other test in the project
     * can see it.
     */
    for (const [key, def] of hazardEntries) {
      // A cadence a player cannot count in whole seconds is a cadence the card cannot
      // state honestly, so content has to choose periods that land on one. This is
      // newly checkable: `intervalTicks` only became the full period in the
      // `HazardField` fix, and before it a card saying "every 5 seconds" fired every 8
      // while passing this test, because the text agreed with the field and only the
      // field was wrong.
      expect(def.intervalTicks % TICK_HZ, `${key} is not a whole number of seconds`).toBe(0)
      const seconds = def.intervalTicks / TICK_HZ
      expect(def.description, `${key} does not state its cadence`).toContain(`${seconds} second`)
      if (def.damage > 0) {
        expect(def.description, `${key} does not state its damage`).toMatch(
          new RegExp(`\\b${def.damage}\\b`),
        )
      } else {
        expect(def.description.toLowerCase(), `${key} does not say it is harmless`).toContain(
          'no damage',
        )
      }
      // Two clauses: what it costs, and what buys you out of it. One sentence
      // states a cost; a trade-off needs the other half.
      const sentences = def.description.split('. ').filter((part) => part.trim().length > 0)
      expect(sentences.length, `${key} states a cost but no trade-off`).toBeGreaterThanOrEqual(2)
      expect(def.description.length, `${key} is too long for a route card`).toBeLessThanOrEqual(190)
    }
  })

  it('names a real hazard in every awaiting-mechanics entry', () => {
    // The same guard `tests/hulls.test.ts` puts on HULLS_AWAITING_MECHANICS. A list of
    // missing mechanics is only useful if it still points at something; an entry for a
    // hazard that has been renamed or deleted reads as a known gap nobody will find.
    for (const entry of HAZARDS_AWAITING_MECHANICS) {
      expect(Object.hasOwn(HAZARDS, entry.id), `unknown hazard: ${entry.id}`).toBe(true)
      expect(entry.needs.length, entry.id).toBeGreaterThan(40)
    }
    // Stated as a fixed list so that implementing one of these hooks forces this test
    // to be revisited rather than silently leaving a pessimistic card in place.
    expect(HAZARDS_AWAITING_MECHANICS.map((entry) => entry.id).sort()).toEqual([
      'convoy-wake',
      'grid-sweep',
      'hold-rot',
      'spore-bloom',
    ])
  })

  it('resolves by id and throws on an unknown one', () => {
    for (const [key] of hazardEntries) expect(getHazard(key).id).toBe(key)
    expect(() => getHazard('no-such-hazard')).toThrow(/no-such-hazard/)
    // Object literal: a naive lookup would resolve these to Object.prototype.
    expect(() => getHazard('constructor')).toThrow()
  })

  it('is used by at least one stage', () => {
    // An unassigned hazard is authored content the player can never meet, which
    // reads in a diff exactly like content that ships.
    const assigned = new Set(RUN_STAGES.flatMap((stage) => stage.hazardIds))
    for (const [key] of hazardEntries) {
      expect(assigned.has(key), `hazard ${key} is assigned to no stage`).toBe(true)
    }
  })
})

describe('the standard run', () => {
  it('is the five sectors in order', () => {
    expect(STANDARD_RUN.stages).toBe(RUN_STAGES)
    expect(RUN_STAGES.map((stage) => stage.sectorId)).toEqual(SECTORS.map((sector) => sector.id))
  })

  it('names only sectors that exist', () => {
    for (const stage of RUN_STAGES) {
      expect(() => getSector(stage.sectorId)).not.toThrow()
    }
  })

  it('names only hazards that exist', () => {
    for (const stage of RUN_STAGES) {
      for (const hazardId of stage.hazardIds) {
        expect(Object.hasOwn(HAZARDS, hazardId), `unknown hazard: ${hazardId}`).toBe(true)
        expect(() => getHazard(hazardId)).not.toThrow()
      }
    }
  })

  it('leaves the teaching sector unhazarded and escalates hazard count', () => {
    // The Debris Shelf's thesis is that every death is legible as a mistake. A
    // field effect the pilot cannot shoot is the wrong first lesson, so sector 1
    // carries none and the finale carries two.
    expect(RUN_STAGES[0]?.hazardIds).toEqual([])
    for (const stage of RUN_STAGES.slice(1)) {
      expect(stage.hazardIds.length, stage.sectorId).toBeGreaterThan(0)
    }
    expect((RUN_STAGES[RUN_STAGES.length - 1]?.hazardIds.length as number)).toBeGreaterThan(1)
  })

  it('does not silently claim a boss that no table can be checked against', () => {
    // `RUN_STAGES` still names no boss, and that is deliberate: bosses live in a file
    // this one does not import, so an id written here could not be verified from here.
    //
    // The pairing is made in `src/content/runs.ts`, where both tables are in scope and
    // a typo throws at module load — which it has already done once, catching
    // `grid-swep` for `grid-sweep` on its first run. That is the assertion below.
    for (const stage of RUN_STAGES) {
      expect(stage.bossId, `${stage.sectorId} names a boss but nothing verifies it`).toBeNull()
    }
  })

  it('is assembled into a run where every stage has a real boss', () => {
    // The other half of the promise above. `STAGES` is the resolved run the game
    // actually flies; `RUN_STAGES` is the half of it this file can be responsible for.
    expect(STAGES).toHaveLength(RUN_STAGES.length)
    for (let i = 0; i < STAGES.length; i++) {
      const stage = STAGES[i]
      expect(stage?.sectorId, `stage ${i}`).toBe(RUN_STAGES[i]?.sectorId)
      expect(stage?.hazardIds, `stage ${i}`).toEqual(RUN_STAGES[i]?.hazardIds)
      expect(stage?.bossId, `stage ${i}`).not.toBeNull()
      expect(BOSSES[stage?.bossId as string], `stage ${i}`).toBeDefined()
    }
    // Distinct bosses: pairing two sectors to one fight would pass every check above
    // and quietly halve the milestone's content.
    expect(new Set(STAGES.map((s) => s.bossId)).size).toBe(STAGES.length)
  })
})
