import { describe, expect, it } from 'vitest'
import {
  BOSSES,
  BOSS_CALLOUT_MAX_CHARS,
  BOSS_ORDER,
  BOSS_TTK_BAND,
  MAX_WEAVE_AMPLITUDE,
  MIN_PHASE_SECONDS,
  SECTOR_PLAYER_DPS,
  bossTimeToKillSeconds,
  getBoss,
} from '../src/content/bosses'
import { SECTOR_ONE_MAX_CONTACT_DAMAGE, maxParkedY } from '../src/content/enemies'
import { CERTIFICATIONS } from '../src/content/certifications'
import { PLAYFIELD_H } from '../src/core/space'
import { TICK_HZ } from '../src/core/loop'
import type { BossDef, BossPhaseDef, EnemyWeaponDef, MovementKind } from '../src/content/types'

/**
 * Boss content integrity.
 *
 * A boss is an enemy with phases, so it inherits every fairness rule `enemies.ts` is
 * held to — telegraphs, parked clearance, contact damage ceilings — and adds two of
 * its own that only exist because phases exist: the phase ladder has to cover the
 * whole health range in order, and every step of it has to be announced.
 *
 * The failures these tests are written against, all of which typecheck cleanly:
 *
 * - A phase ladder with a gap or an inversion. The boss reaches 40% health and enters
 *   no phase at all, or re-enters one it already left, and it looks like a stuck AI.
 * - A phase with no callout. The pattern changes without warning, which is unfair
 *   rather than difficult — the player is asked to relearn a fight with no signal
 *   that there is anything to relearn.
 * - A zero windup. The shot arrives before the tell, so the reaction window the
 *   design promises does not exist.
 * - A boss whose HP makes the fight two minutes long, or ten seconds. Neither is
 *   visible in a diff; both are one division away from being obvious.
 * - A variant that is a different boss wearing the same name, or one that is
 *   identical to the base and therefore does nothing at all.
 * - A movement kind that walks the boss off the playfield. `drift`, `swoop` and
 *   `strafe` all do, and each reads perfectly reasonably in the data.
 *
 * MUTATION-VERIFIED. Each of these was confirmed to fail against a deliberate break,
 * and the content reverted:
 *
 *   "orders phases by descending health fraction, from 1 down towards 0"
 *        — swapping the Bailiff's second and third phases fails it.
 *   "gives every boss weapon a telegraph the player can react to"
 *        — zeroing the Repossessor's opening windup fails it.
 *   "kills inside the stated band at the output expected in its sector"
 *        — raising the Deep Manifest to 30000 HP fails it.
 *   "gives every phase long enough to be read"
 *        — moving the Deep Manifest's last threshold from 0.25 to 0.02 fails it.
 *   "differs from the base form in at least one phase"
 *        — pointing the Warden variant at the base phase list fails it.
 *   "keeps every parked boss above the forward-play line"
 *        — pushing the Tenant's holdYFraction to 0.30 fails it.
 */

const bossEntries: [string, BossDef][] = Object.entries(BOSSES)

/**
 * Movement kinds a boss phase may use, and the one it may not.
 *
 * Read out of `src/sim/enemies.ts` and `src/sim/bosses.ts` rather than assumed.
 * `keepBossInPlay` wraps a boss that leaves the *bottom* of the playfield back to the
 * top, which is what makes `drift` and `swoop` legal — a dive past the bottom edge is
 * an attack run rather than an escape. Nothing wraps x, so `strafe` crosses the lane,
 * keeps going, and ends the fight by walking out of it. The lane-crossing feel comes
 * from `sine` at zero speed instead.
 */
const BOSS_MOVEMENTS: readonly MovementKind[] = ['hover', 'sine', 'swoop', 'drift']

/**
 * Independently restated time-to-kill for each boss, in seconds.
 *
 * Deliberate duplication, and the duplication is the value — the same trick
 * `items.test.ts` uses for interaction totals. The content states its arithmetic in a
 * comment; this states the answer. A change to an HP number that does not also change
 * the intended fight length fails here, which forces the author to say out loud
 * whether the fight got longer on purpose.
 *
 * NO LONGER "at full uptime". `SECTOR_PLAYER_DPS` was re-derived from
 * `boss hp / measured median time-to-kill` over 300 aggressor runs on each of two base
 * seeds, so these are realised seconds and are directly comparable with the `ttk med`
 * column `tools/playtest.ts` prints. Each sits at the floor its own shortest phase
 * allows under `MIN_PHASE_SECONDS`, or at the band's 20 s floor, whichever binds.
 */
const INTENDED_TTK_SECONDS: Record<string, number> = {
  repossessor: 17,
  auditor: 17.49,
  tenant: 18,
  bailiff: 18.5,
  'deep-manifest': 22,
}

function weaponsOf(phase: BossPhaseDef): EnemyWeaponDef[] {
  return phase.secondary === undefined ? [phase.weapon] : [phase.weapon, phase.secondary]
}

/** Every phase list a boss can present: its base form and each variant. */
function phaseSetsOf(def: BossDef): { label: string; phases: readonly BossPhaseDef[] }[] {
  return [
    { label: `${def.id} (base)`, phases: def.phases },
    ...(def.variants ?? []).map((variant) => ({
      label: `${def.id}/${variant.id}`,
      phases: variant.phases,
    })),
  ]
}

describe('boss registry', () => {
  it('ships one boss per sector, ordered', () => {
    // `docs/ROADMAP.md` M5: a boss per sector. The order is also the mapping into
    // SECTOR_PLAYER_DPS, so a missing entry silently divides a boss's HP by the wrong
    // sector's output and every time-to-kill below it is measured against a fiction.
    expect(BOSS_ORDER.length).toBe(5)
    expect(SECTOR_PLAYER_DPS.length).toBe(5)
    expect([...BOSS_ORDER].sort()).toEqual(bossEntries.map(([key]) => key).sort())
    expect(new Set(BOSS_ORDER).size).toBe(BOSS_ORDER.length)
  })

  it('keys match the id on each definition', () => {
    for (const [key, def] of bossEntries) expect(def.id, key).toBe(key)
  })

  it('escalates health and payout with depth', () => {
    // Not a balance claim — a sanity one. HP that dips in sector 4 means two bosses
    // were authored from different assumptions about the run.
    let previousHp = 0
    for (const id of BOSS_ORDER) {
      const def = getBoss(id)
      expect(def.hp, id).toBeGreaterThan(previousHp)
      previousHp = def.hp
    }
  })

  it('pays more than the richest ordinary enemy', () => {
    // The Heavy Turret elite pays 30. A boss that paid less would make the elite the
    // better use of the same time, which inverts what a boss is for.
    for (const [key, def] of bossEntries) expect(def.scrap, key).toBeGreaterThan(30)
  })

  it('keeps the first boss inside sector 1 fairness', () => {
    // `SECTOR_ONE_MAX_CONTACT_DAMAGE` is a quarter of a baseline hull, and it exists
    // so a first-sector mistake is survivable four times over. The first boss the
    // player ever meets is the last place to break that.
    const first = getBoss(BOSS_ORDER[0] ?? '')
    expect(first.contactDamage).toBeLessThanOrEqual(SECTOR_ONE_MAX_CONTACT_DAMAGE)
  })

  it('gives every boss a body worth aiming at', () => {
    for (const [key, def] of bossEntries) {
      // Larger than the biggest ordinary enemy (radius 22) — a boss the player can
      // miss is a boss whose time-to-kill arithmetic is meaningless.
      expect(def.radius, key).toBeGreaterThan(22)
      expect(def.contactDamage, key).toBeGreaterThan(0)
      expect(def.name.length, key).toBeGreaterThan(0)
    }
  })
})

describe('phase ladders', () => {
  it('opens at full health and descends towards zero', () => {
    // "Covers the range from 1 down to 0": the first phase must start at 1 or the
    // boss spawns in no phase, and the last must start above 0 or the final phase is
    // unreachable. Everything between is covered by construction once the ladder is
    // ordered, because a phase runs until the next one begins.
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        expect(phases.length, label).toBeGreaterThanOrEqual(3)
        expect(phases[0]?.fromHealthFraction, `${label} does not open at full health`).toBe(1)
        const last = phases[phases.length - 1]?.fromHealthFraction ?? 0
        expect(last, `${label} final phase begins at ${last}`).toBeGreaterThan(0)
      }
    }
  })

  it('orders phases by descending health fraction, from 1 down towards 0', () => {
    // An out-of-order ladder is not a crash, it is a boss that appears to re-enter a
    // phase it already left. Strictly descending, because two phases sharing a
    // threshold means one of them can never be entered.
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        for (let i = 1; i < phases.length; i++) {
          const previous = phases[i - 1]?.fromHealthFraction ?? 0
          const current = phases[i]?.fromHealthFraction ?? 0
          expect(current, `${label} phase ${i}`).toBeLessThan(previous)
          expect(current, `${label} phase ${i}`).toBeGreaterThan(0)
          expect(current, `${label} phase ${i}`).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('announces every phase with a callout that fits on screen', () => {
    // An unannounced phase shift is unfair rather than difficult. A callout that
    // clips is an announcement the player did not read, which is the same thing with
    // extra steps — hence the width check as well as the presence check.
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        for (const [index, phase] of phases.entries()) {
          const callout = phase.callout.trim()
          expect(callout.length, `${label} phase ${index} has no callout`).toBeGreaterThan(0)
          expect(callout.length, `${label} phase ${index}: "${callout}"`).toBeLessThanOrEqual(
            BOSS_CALLOUT_MAX_CHARS,
          )
          expect(callout[0], `${label} phase ${index}`).toBe(callout[0]?.toUpperCase())
        }
        // Two phases with the same callout means the player is told the fight
        // changed and shown the same sentence, which reads as a rendering bug.
        const callouts = phases.map((phase) => phase.callout)
        expect(new Set(callouts).size, `${label} repeats a callout`).toBe(callouts.length)
      }
    }
  })

  it('gives every phase long enough to be read', () => {
    // The span between one threshold and the next, converted to seconds at the
    // sector's expected output. A three-second phase is a pattern the player never
    // identifies, so the callout announces something they experience as noise.
    for (const [index, id] of BOSS_ORDER.entries()) {
      const def = getBoss(id)
      const dps = SECTOR_PLAYER_DPS[index] ?? 0
      for (const { label, phases } of phaseSetsOf(def)) {
        for (const [i, phase] of phases.entries()) {
          const nextFrom = phases[i + 1]?.fromHealthFraction ?? 0
          const span = phase.fromHealthFraction - nextFrom
          const seconds = (def.hp * span) / dps
          expect(seconds, `${label} phase ${i} lasts ${seconds.toFixed(1)} s`).toBeGreaterThanOrEqual(
            MIN_PHASE_SECONDS,
          )
        }
      }
    }
  })
})

describe('time to kill', () => {
  it('kills inside the stated band at the output expected in its sector', () => {
    // The primary balance guard, and it is arithmetic rather than judgement: HP over
    // the sector's dps. Under 20 s and the phases cannot each get their six seconds;
    // over 40 s and one fight eats a quarter of a 15-20 minute run.
    for (const id of BOSS_ORDER) {
      const seconds = bossTimeToKillSeconds(id)
      expect(seconds, `${id} takes ${seconds.toFixed(1)} s`).toBeGreaterThanOrEqual(
        BOSS_TTK_BAND.minSeconds,
      )
      expect(seconds, `${id} takes ${seconds.toFixed(1)} s`).toBeLessThanOrEqual(
        BOSS_TTK_BAND.maxSeconds,
      )
    }
  })

  it('matches the fight length each boss was authored for', () => {
    // The independent restatement. The band above allows a twenty-second swing; this
    // pins each boss to the number its own comment does the arithmetic for, so an HP
    // change cannot slide a fight from 26 seconds to 39 while still "passing".
    expect(Object.keys(INTENDED_TTK_SECONDS).sort()).toEqual([...BOSS_ORDER].sort())
    for (const id of BOSS_ORDER) {
      expect(bossTimeToKillSeconds(id), id).toBeCloseTo(INTENDED_TTK_SECONDS[id] ?? 0, 1)
    }
  })

  it('gets longer as the run goes on', () => {
    // Each boss should be a bigger commitment than the last even after the player's
    // growing output is divided out. Rising HP alone does not guarantee that — a
    // sector-5 boss with sector-3 HP is a shorter fight despite a bigger number.
    let previous = 0
    for (const id of BOSS_ORDER) {
      const seconds = bossTimeToKillSeconds(id)
      expect(seconds, id).toBeGreaterThan(previous)
      previous = seconds
    }
  })

  it('throws for a boss that is not in the sector order', () => {
    expect(() => bossTimeToKillSeconds('no-such-boss')).toThrow(/BOSS_ORDER/)
  })
})

describe('weapons and telegraphs', () => {
  it('gives every boss weapon a telegraph the player can react to', () => {
    // `windupTicks` is real simulation time, not an animation played alongside the
    // shot. Zero means the attack arrives unannounced, which is noise rather than
    // difficulty. The floor of 20 ticks is the shortest tell in the game (the skiff's
    // single pellet), and nothing a boss fires is that small.
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        for (const [index, phase] of phases.entries()) {
          for (const weapon of weaponsOf(phase)) {
            const at = `${label} phase ${index} ${weapon.kind}`
            expect(weapon.windupTicks, at).toBeGreaterThanOrEqual(20)
          }
        }
      }
    }
  })

  it('keeps every windup under half its own interval', () => {
    // The windup budget from `enemies.ts`, applied unchanged. A tell that fills most
    // of the interval means the enemy is always winding up, and a warning light that
    // is never off is not a warning.
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        for (const [index, phase] of phases.entries()) {
          for (const weapon of weaponsOf(phase)) {
            const at = `${label} phase ${index} ${weapon.kind}: ${weapon.windupTicks} of ${weapon.intervalTicks}`
            expect(weapon.windupTicks * 2, at).toBeLessThan(weapon.intervalTicks)
          }
        }
      }
    }
  })

  it('waits before the first volley of every phase', () => {
    // `firstDelayTicks` is measured from the enemy's age, which a phase change resets
    // (see the header of `bosses.ts`). A short delay means the new pattern opens on
    // top of its own callout, so the player reads the announcement while already
    // being shot — the announcement might as well not exist.
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        for (const [index, phase] of phases.entries()) {
          for (const weapon of weaponsOf(phase)) {
            const at = `${label} phase ${index} ${weapon.kind}`
            expect(weapon.firstDelayTicks, at).toBeGreaterThanOrEqual(TICK_HZ)
          }
        }
      }
    }
  })

  it('always shoots', () => {
    // A phase whose primary weapon is `none` is a free phase: the player parks and
    // holds the trigger. If a boss should stop firing, that is a pause inside a
    // phase, not a phase.
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        for (const [index, phase] of phases.entries()) {
          expect(phase.weapon.kind, `${label} phase ${index}`).not.toBe('none')
          expect(phase.secondary?.kind, `${label} phase ${index} secondary`).not.toBe('none')
        }
      }
    }
  })

  it('supplies the params each weapon kind cannot run without', () => {
    // `EnemyWeaponDef` shares one optional bag across kinds, so a `spread` with no
    // `count` typechecks and then fires the sim's default of three — a pattern nobody
    // authored, in a fight tuned around the one they thought they wrote.
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        for (const [index, phase] of phases.entries()) {
          for (const weapon of weaponsOf(phase)) {
            const at = `${label} phase ${index} ${weapon.kind}`
            expect(weapon.damage, at).toBeGreaterThan(0)
            expect(weapon.bulletSpeed, at).toBeGreaterThan(0)
            expect(weapon.intervalTicks, at).toBeGreaterThan(0)
            if (weapon.kind === 'spread' || weapon.kind === 'ring') {
              expect(weapon.count, `${at} needs a count`).toBeDefined()
              expect(weapon.count ?? 0, at).toBeGreaterThan(2)
            }
            if (weapon.kind === 'spread') {
              expect(weapon.spreadDegrees, `${at} needs a spread`).toBeDefined()
              expect(weapon.spreadDegrees ?? 0, at).toBeGreaterThan(0)
              expect(weapon.spreadDegrees ?? 0, at).toBeLessThan(180)
              // Odd counts only. An even fan straddles the aim line, so standing
              // still becomes correct — measured on the sector-1 turret and reverted.
              expect((weapon.count ?? 0) % 2, `${at} has an even fan`).toBe(1)
            }
          }
        }
      }
    }
  })

  it('never fires faster than the hull can leave', () => {
    // The hull moves at 210 u/s. A boss projectile faster than that cannot be
    // out-run, only pre-dodged, and nothing in this roster is meant to be
    // unavoidable. 160 u/s on the Liquidator's aimed shot is the fastest, which is
    // still three quarters of the hull's speed.
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        for (const [index, phase] of phases.entries()) {
          for (const weapon of weaponsOf(phase)) {
            expect(weapon.bulletSpeed, `${label} phase ${index} ${weapon.kind}`).toBeLessThan(210)
          }
        }
      }
    }
  })
})

describe('movement stays on the playfield', () => {
  it('uses only movement kinds that keep a boss in the fight', () => {
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        for (const [index, phase] of phases.entries()) {
          expect(BOSS_MOVEMENTS, `${label} phase ${index}`).toContain(phase.movement)
        }
      }
    }
  })

  it('opens on a hover phase so the boss actually enters', () => {
    // `sine` at zero speed never descends. A boss whose first phase weaves would sit
    // above the top of the playfield, unreachable and unreached.
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        expect(phases[0]?.movement, label).toBe('hover')
      }
    }
  })

  it('keeps every parked boss above the forward-play line', () => {
    // The rule `enemies.ts` applies to every parked enemy, checked against its own
    // `maxParkedY` rather than a copied number: a pilot pushing forward flies around
    // y = 230, and anything parked below that minus its own radius delivers its
    // telegraph after the collision instead of before it. It covers a `swoop`'s pause
    // height too — that pause IS the telegraph, so delivering it inside contact range
    // is the exact defect the sector-1 Lancer shipped with and had to be moved for.
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        for (const [index, phase] of phases.entries()) {
          const fraction = phase.movementParams.holdYFraction
          if (fraction === undefined) continue
          const y = fraction * PLAYFIELD_H
          expect(y, `${label} phase ${index} parks at y=${y}`).toBeLessThanOrEqual(
            maxParkedY(def.radius),
          )
        }
      }
    }
  })

  it('holds every phase of a boss at one height', () => {
    // `restartMovement` clamps a new phase's hold height so it can never be above
    // where the boss already is, so a later phase asking to park higher is silently
    // ignored — the safe failure, but still a phase that does not do what its data
    // says. One height per boss makes a phase change read as a change of behaviour
    // rather than as a rendering glitch or a value nobody notices was dropped.
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        const heights = new Set(
          phases
            .map((phase) => phase.movementParams.holdYFraction)
            .filter((fraction) => fraction !== undefined),
        )
        expect(heights.size, `${label} holds at ${heights.size} different heights`).toBe(1)
      }
    }
  })

  it('sets holdTicks only where it means a dive telegraph', () => {
    // The same field means opposite things on the two movement kinds that read it. On
    // `hover` it is "eventually leave", which on a boss is the fight walking away
    // mid-phase. On `swoop` it is the pause before the dive — the telegraph itself —
    // so a swoop without one commits instantly and cannot be reacted to.
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        for (const [index, phase] of phases.entries()) {
          const at = `${label} phase ${index}`
          if (phase.movement === 'swoop') {
            // 45 ticks is 0.75 s, the Lancer's telegraph rounded down. A boss is
            // larger and commits harder, so it never gets less warning than that.
            expect(phase.movementParams.holdTicks ?? 0, `${at} dives unannounced`).toBeGreaterThanOrEqual(45)
            expect(phase.movementParams.diveMultiplier ?? 0, at).toBeGreaterThan(1)
          } else {
            expect(phase.movementParams.holdTicks, at).toBeUndefined()
          }
        }
      }
    }
  })

  it('weaves at zero descent, inside the playfield', () => {
    // A `sine` phase with any downward speed walks the boss off the bottom, slowly
    // enough that it looks like intended behaviour right up until the fight
    // disappears. The amplitude check assumes a centred spawn, which is stated as an
    // assumption on `MAX_WEAVE_AMPLITUDE`.
    for (const [, def] of bossEntries) {
      for (const { label, phases } of phaseSetsOf(def)) {
        for (const [index, phase] of phases.entries()) {
          if (phase.movement !== 'sine') continue
          const at = `${label} phase ${index}`
          expect(phase.movementParams.speed, `${at} descends while weaving`).toBe(0)
          const amplitude = phase.movementParams.amplitude ?? 0
          expect(amplitude, at).toBeGreaterThan(0)
          expect(amplitude + def.radius, `${at} weaves off the edge`).toBeLessThanOrEqual(
            MAX_WEAVE_AMPLITUDE,
          )
          expect(phase.movementParams.frequency ?? 0, at).toBeGreaterThan(0)
        }
      }
    }
  })
})

describe('seeded variants', () => {
  const withVariants = bossEntries.filter(([, def]) => (def.variants?.length ?? 0) > 0)

  it('covers the later bosses', () => {
    // Sectors 3, 4 and 5. The first two bosses have one form each on purpose: they
    // are where the grammar of a boss fight is taught, and a teaching fight that
    // changes shape is indistinguishable from the player having misread it.
    const varied = withVariants.map(([key]) => key)
    expect(varied.sort()).toEqual(['bailiff', 'deep-manifest', 'tenant'])
  })

  it('gives every variant a unique id and a name', () => {
    // Variant ids go into the certification pool, so a collision would make one
    // unlock silently grant the other.
    const ids = bossEntries.flatMap(([, def]) => (def.variants ?? []).map((v) => v.id))
    expect(new Set(ids).size).toBe(ids.length)
    for (const [key, def] of bossEntries) {
      for (const variant of def.variants ?? []) {
        expect(variant.id.length, key).toBeGreaterThan(0)
        expect(variant.name.length, `${key}/${variant.id}`).toBeGreaterThan(0)
      }
    }
  })

  it('differs from the base form in at least one phase', () => {
    // A variant identical to the base is a certification that unlocks nothing and a
    // seeded roll with one outcome. Compared by value rather than by reference so a
    // copy-pasted duplicate fails too.
    for (const [key, def] of withVariants) {
      for (const variant of def.variants ?? []) {
        const differs = variant.phases.some(
          (phase, index) => JSON.stringify(phase) !== JSON.stringify(def.phases[index]),
        )
        expect(differs, `${key}/${variant.id} is identical to the base form`).toBe(true)
      }
    }
  })

  it('keeps the boss identity: same shape, same health, same opening', () => {
    // "Same boss, a different middle phase." Shape and HP live on the BossDef so they
    // are shared by construction — the check that matters is the opening, because a
    // variant that starts differently is a different fight rather than the same one
    // developing differently, and the player has no way to know which they are in
    // until they have already committed.
    for (const [key, def] of withVariants) {
      for (const variant of def.variants ?? []) {
        expect(variant.phases.length, `${key}/${variant.id}`).toBe(def.phases.length)
        expect(
          JSON.stringify(variant.phases[0]),
          `${key}/${variant.id} opens differently`,
        ).toBe(JSON.stringify(def.phases[0]))
        // And it ends the same way: the last act is the fight's signature.
        expect(
          JSON.stringify(variant.phases[variant.phases.length - 1]),
          `${key}/${variant.id} ends differently`,
        ).toBe(JSON.stringify(def.phases[def.phases.length - 1]))
      }
    }
  })

  it('varies a middle phase, not the whole script', () => {
    // At most one phase changes. A variant that rewrites two acts stops being the
    // same boss read differently and becomes a second boss sharing a name, which is
    // exactly what the "same shape, same HP" rule is trying to prevent.
    for (const [key, def] of withVariants) {
      for (const variant of def.variants ?? []) {
        const changed = variant.phases.filter(
          (phase, index) => JSON.stringify(phase) !== JSON.stringify(def.phases[index]),
        )
        expect(changed.length, `${key}/${variant.id} changes ${changed.length} phases`).toBe(1)
      }
    }
  })

  it('resolves every certification boss-variant grant', () => {
    // `src/content/certifications.ts` grants `manifest-warden` by id from the
    // Extraction Certificate and describes it to the player. A renamed variant leaves
    // a shipped unlock pointing at nothing, which typechecks and shows up in the
    // hangar as a promise the game cannot keep.
    const known = new Set(bossEntries.flatMap(([, def]) => (def.variants ?? []).map((v) => v.id)))
    for (const cert of CERTIFICATIONS) {
      for (const grant of cert.grants) {
        if (grant.slice !== 'bossVariants') continue
        expect(known.has(grant.id), `${cert.id} grants unknown variant ${grant.id}`).toBe(true)
      }
    }
  })
})

describe('getBoss', () => {
  it('returns the definition for a known id', () => {
    expect(getBoss('bailiff').id).toBe('bailiff')
  })

  it('throws on an unknown id', () => {
    expect(() => getBoss('no-such-boss')).toThrow(/no-such-boss/)
  })

  it('throws on inherited Object.prototype keys', () => {
    for (const id of ['constructor', '__proto__', 'toString', 'valueOf']) {
      expect(() => getBoss(id), id).toThrow(/Unknown boss id/)
    }
  })
})
