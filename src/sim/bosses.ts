/**
 * Boss fights, built entirely out of the enemy machinery that already exists.
 *
 * The whole design of this module is a refusal. A boss could have been a new entity
 * kind with its own update path — and then every movement kind, every weapon kind,
 * every telegraph rule and collision case would have to be implemented a second
 * time, and the two copies would drift. Instead:
 *
 *   a boss is an EnemyInstance whose `defId` is swapped when its health crosses a
 *   threshold.
 *
 * Each phase is compiled to an ordinary `EnemyDef` under a synthetic id, so movement
 * and weapons are interpreted by exactly the same code that runs a skiff. Authoring
 * a boss adds no simulation code, which is the same contract content/types.ts states
 * for enemies.
 *
 * Nothing here touches an Rng except `pickVariant`, which is called once per fight
 * from the caller's stream.
 */

import { PLAYFIELD_H } from '../core/space'
import type { BossDef, BossPhaseDef, EnemyDef } from '../content/types'
import type { Rng } from '../core/rng'
import type { BossRuntime, EnemyInstance } from './entities'
import { createEnemy } from './enemies'

/**
 * How long a phase callout stays on screen: 2 seconds.
 *
 * Long enough to read a short line under pressure, short enough that it is gone
 * before the pattern it announced becomes the thing you need to be watching.
 */
export const BOSS_CALLOUT_TICKS = 120

/**
 * Separator in a derived phase's def id.
 *
 * `#` is not legal in an authored content id (asserted in the content tests), so a
 * derived def can never collide with a real enemy or be referenced by a wave.
 */
const PHASE_SEPARATOR = '#'

export function bossPhaseDefId(bossId: string, phaseIndex: number): string {
  return `${bossId}${PHASE_SEPARATOR}${phaseIndex}`
}

/** The phase set a run actually fights: the base form, or one seeded variant. */
export interface BossForm {
  variantId: string | null
  /** Display name. A variant may rename the boss; most do not. */
  name: string
  phases: readonly BossPhaseDef[]
}

/**
 * Choose which form of the boss this run faces.
 *
 * Uniform across the base form and every variant, so a boss with two variants is
 * three-way. Drawn from the caller's stream at the moment the boss spawns — which is
 * a fixed point in the sector script, never a reaction to anything the player did.
 */
export function pickVariant(boss: BossDef, rng: Rng): BossForm {
  const base: BossForm = { variantId: null, name: boss.name, phases: boss.phases }
  const variants = boss.variants ?? []
  if (variants.length === 0) return base

  const forms: BossForm[] = [
    base,
    ...variants.map((v) => ({ variantId: v.id, name: v.name, phases: v.phases })),
  ]
  return rng.weighted(forms, () => 1)
}

/**
 * Compile a form's phases into ordinary enemy defs.
 *
 * Everything that is a property of the *ship* rather than of the *phase* — hp,
 * radius, contact damage, scrap, shape — is identical across every derived def. That
 * is not tidiness: `radius` is the hitbox and `shape` is the silhouette, so a phase
 * that changed either would teleport the boss's hurtbox or swap the model
 * mid-sentence.
 */
export function deriveBossDefs(boss: BossDef, form: BossForm): EnemyDef[] {
  return form.phases.map((phase, index) => ({
    id: bossPhaseDefId(boss.id, index),
    name: form.name,
    hp: boss.hp,
    radius: boss.radius,
    contactDamage: boss.contactDamage,
    scrap: boss.scrap,
    movement: phase.movement,
    movementParams: phase.movementParams,
    weapon: phase.weapon,
    ...(phase.secondary ? { secondaryWeapon: phase.secondary } : {}),
    shape: boss.shape,
    elite: true,
  }))
}

/**
 * Spawn the boss at the top of the playfield.
 *
 * `defs` must already contain this form's derived defs — the caller registers them
 * so the rest of the sim can look the boss up by `defId` like any other enemy.
 */
export function createBoss(
  boss: BossDef,
  form: BossForm,
  defs: Readonly<Record<string, EnemyDef>>,
  uid: number,
  x: number,
): EnemyInstance {
  const first = defs[bossPhaseDefId(boss.id, 0)]
  if (first === undefined) {
    throw new Error(`Boss "${boss.id}" phase defs were not registered before spawning`)
  }

  const instance = createEnemy(first, x, -(boss.radius + 24), uid)
  const runtime: BossRuntime = {
    bossId: boss.id,
    name: form.name,
    variantId: form.variantId,
    phaseIndex: 0,
    phaseDefIds: form.phases.map((_, index) => bossPhaseDefId(boss.id, index)),
    thresholds: form.phases.map((phase) => phase.fromHealthFraction),
    callouts: form.phases.map((phase) => phase.callout),
    calloutTicks: BOSS_CALLOUT_TICKS,
  }
  instance.boss = runtime
  return instance
}

/**
 * Advance the boss into the phase its health now warrants, if any.
 *
 * Returns the phase index it moved to, or null if nothing changed. Skips *through*
 * phases rather than one per call: a burst that takes the boss from 80% to 20% in
 * one tick lands it in the phase 20% deserves, not the one after 80%.
 */
export function advanceBossPhase(
  e: EnemyInstance,
  defs: Readonly<Record<string, EnemyDef>>,
): number | null {
  const boss = e.boss
  if (boss === undefined) return null
  if (!e.alive) return null

  const fraction = e.maxHp > 0 ? e.hp / e.maxHp : 0
  let target = boss.phaseIndex
  while (target + 1 < boss.thresholds.length && fraction <= (boss.thresholds[target + 1] ?? -1)) {
    target++
  }
  if (target === boss.phaseIndex) return null

  const nextId = boss.phaseDefIds[target]
  const def = nextId === undefined ? undefined : defs[nextId]
  // A missing derived def would silently freeze the boss in its old pattern while
  // the health bar said otherwise. Staying put is the safer failure, but it must not
  // be a silent one, so the phase index does not advance either.
  if (def === undefined) return null

  boss.phaseIndex = target
  boss.calloutTicks = BOSS_CALLOUT_TICKS
  e.defId = def.id
  e.movement = def.movement
  restartMovement(e, def)
  return target
}

/**
 * Reset the movement script for a new phase.
 *
 * Declared as a helper on the module rather than inline because the `holdY` rule is
 * the subtle part: the new phase's hold height is clamped so it can never be ABOVE
 * where the boss already is. `updateEnemyMovement` snaps y to holdY on arrival, so an
 * unclamped higher hold would teleport the boss upward the instant the phase changed
 * — a hitbox jumping across the screen mid-fight, which is exactly the kind of
 * unexplainable death this project keeps trying not to ship.
 */
function restartMovement(e: EnemyInstance, def: EnemyDef): void {
  const fraction = def.movementParams.holdYFraction
  if (fraction !== undefined) {
    e.holdY = Math.max(fraction * PLAYFIELD_H, e.y)
  }
  e.originX = e.x
  e.age = 0
  e.phase = 'entering'
  e.fireCooldown = def.weapon.firstDelayTicks
  e.telegraphTicks = 0
  e.telegraphTotal = 0
  if (def.secondaryWeapon) {
    e.secondary = { cooldown: def.secondaryWeapon.firstDelayTicks, windup: 0, windupTotal: 0 }
  } else {
    delete e.secondary
  }
}

/**
 * Keep a boss in play, and age its callout.
 *
 * A boss must never be culled for leaving the playfield: a `swoop` phase dives past
 * the bottom edge, and the ordinary cull rule would end the fight by letting the
 * boss escape — a win condition nobody chose and nothing explains. Instead it comes
 * back around from the top, which reads as an attack run and costs no new content
 * vocabulary.
 */
export function keepBossInPlay(e: EnemyInstance): void {
  const boss = e.boss
  if (boss === undefined) return
  if (boss.calloutTicks > 0) boss.calloutTicks--

  if (e.y > PLAYFIELD_H + e.radius) {
    e.y = -e.radius
    // prevY too, or the renderer interpolates across the whole playfield and draws
    // the boss as a streak through everything the player is dodging.
    e.prevY = e.y
    e.age = 0
    e.phase = 'entering'
  }
}
