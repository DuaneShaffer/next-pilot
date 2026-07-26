/**
 * Projectile lifetime: spawn, integrate, cull.
 *
 * Shared by both sides. Player bullets and enemy bullets differ in what they
 * collide with and how they are drawn, not in how they move, so the movement and
 * culling code exists once.
 *
 * Lists are compacted with backwards-iterating swap-remove: O(1) removal, no
 * allocation, and no index skipping when an element disappears mid-loop.
 */

import { TICK_SECONDS } from '../core/loop'
import { isOutOfPlay } from '../core/space'
import type { Bullet, DeathCauseKind, EnemyBullet, EnemyBulletKind } from './entities'

/**
 * Hard ceilings on live projectiles.
 *
 * These are load-bearing, not paranoia. The frame budget in
 * docs/ARCHITECTURE.md is written against "low thousands of sprites", and a
 * ring-firing formation stacked with a death burst can generate projectiles far
 * faster than they leave the playfield. Refusing to spawn past the cap degrades
 * a pathological pattern into a thinner one instead of into a stalled frame.
 */
export const MAX_PLAYER_BULLETS = 768
export const MAX_ENEMY_BULLETS = 1024

/**
 * An enemy bullet that remembers who fired it.
 *
 * The incident report has to name what killed the pilot, and `EnemyBullet` in the
 * fixed entity contract carries no origin. Widening the interface here — rather
 * than keeping a parallel array of def ids in lockstep with swap-remove, or a
 * side table keyed by object identity — means attribution cannot desynchronise
 * from the projectile it describes. `AttributedEnemyBullet[]` is assignable to
 * `readonly EnemyBullet[]`, so `WorldView` consumers never see the difference.
 */
export interface AttributedEnemyBullet extends EnemyBullet {
  readonly sourceDefId: string
  /**
   * How the incident report should describe a death to this projectile.
   *
   * Carried on the bullet rather than inferred at the collision, because by then the
   * only thing left is a string id and "was `corrosive-fall` an enemy?" is not a
   * question the damage path should be guessing at.
   */
  readonly causeKind: DeathCauseKind
}

/** The shape both projectile kinds share. Internal to this module. */
interface Moving {
  x: number
  y: number
  prevX: number
  prevY: number
  vx: number
  vy: number
  alive: boolean
}

/** Returns false when the cap refused the spawn, so callers can skip stat bumps. */
export function spawnPlayerBullet(
  list: Bullet[],
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  radius: number,
): boolean {
  if (list.length >= MAX_PLAYER_BULLETS) return false
  list.push({ x, y, prevX: x, prevY: y, vx, vy, damage, radius, alive: true })
  return true
}

export function spawnEnemyBullet(
  list: AttributedEnemyBullet[],
  sourceDefId: string,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  radius: number,
  kind: EnemyBulletKind,
): boolean {
  return pushEnemyBullet(list, sourceDefId, 'enemy-fire', x, y, vx, vy, damage, radius, kind)
}

/**
 * A projectile thrown by the environment rather than by a ship.
 *
 * Identical in every way a projectile behaves, and different in exactly one way that
 * matters after the fact: the incident report must say the pilot was killed by a
 * hazard, not by an enemy that does not exist.
 */
export function spawnHazardBullet(
  list: AttributedEnemyBullet[],
  hazardId: string,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  radius: number,
  kind: EnemyBulletKind,
): boolean {
  return pushEnemyBullet(list, hazardId, 'hazard', x, y, vx, vy, damage, radius, kind)
}

function pushEnemyBullet(
  list: AttributedEnemyBullet[],
  sourceDefId: string,
  causeKind: DeathCauseKind,
  x: number,
  y: number,
  vx: number,
  vy: number,
  damage: number,
  radius: number,
  kind: EnemyBulletKind,
): boolean {
  if (list.length >= MAX_ENEMY_BULLETS) return false
  list.push({
    x,
    y,
    prevX: x,
    prevY: y,
    vx,
    vy,
    damage,
    radius,
    alive: true,
    kind,
    sourceDefId,
    causeKind,
  })
  return true
}

/**
 * Integrate one fixed tick and drop anything that left play or was marked dead.
 * Returns how many were removed, for `stats.bulletsCulled`.
 *
 * Velocities are in virtual units per second and scaled by TICK_SECONDS — a
 * fixed constant, never a frame delta. See docs/ARCHITECTURE.md.
 */
export function advanceProjectiles<T extends Moving>(list: T[]): number {
  let culled = 0
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i] as T
    p.prevX = p.x
    p.prevY = p.y
    p.x += p.vx * TICK_SECONDS
    p.y += p.vy * TICK_SECONDS

    if (!p.alive || isOutOfPlay(p.x, p.y)) {
      list[i] = list[list.length - 1] as T
      list.pop()
      culled++
    }
  }
  return culled
}

/**
 * Remove projectiles that died this tick, without integrating.
 *
 * Called immediately after collision resolution so a spent bullet is gone before
 * anything else can look at it — a bullet that lingered a tick after connecting
 * would be drawn inside the thing it already hit.
 */
export function cullDead<T extends { alive: boolean }>(list: T[]): number {
  let culled = 0
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i] as T
    if (!p.alive) {
      list[i] = list[list.length - 1] as T
      list.pop()
      culled++
    }
  }
  return culled
}
