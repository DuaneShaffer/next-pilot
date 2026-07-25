/**
 * Deterministic state hashing.
 *
 * THE JOB: turn a whole run's state into a short string such that two worlds
 * that differ in any way that affects play hash differently, on every platform
 * and every Node version, forever. Everything in `docs/VERIFICATION.md` §1 rests
 * on this — a replay fixture is a seed, an input log, and one of these hashes.
 *
 * Three decisions worth knowing about:
 *
 * 1. **Integer arithmetic only.** Accumulation uses `Math.imul`, `^`, `>>>`, so
 *    the result is bit-identical everywhere. No float accumulation, which would
 *    be at the mercy of FMA and rounding-mode differences.
 *
 * 2. **Floats are hashed as their raw IEEE-754 bits**, read through a DataView
 *    with an *explicit* little-endian flag. Hashing `String(value)` would have
 *    been shorter and is a trap: number-to-string is engine-adjacent, has changed
 *    across V8 versions for edge cases, and anything involving `toFixed` or
 *    `toLocaleString` varies by locale. Raw bits are exact and cannot drift. The
 *    explicit endianness flag matters because typed-array views follow platform
 *    byte order, which would give a big-endian machine a different hash.
 *
 * 3. **Cosmetic state is hashed into its own component and left out of the
 *    regression hash.** Explosions and hit flashes exist for the renderer. If
 *    they fed the main hash, retuning an explosion's lifetime in M2 would fail
 *    every replay fixture for no reason, and the corpus would get re-recorded
 *    reflexively until it stopped meaning anything. The cosmetic digest is still
 *    computed and reported, so a divergence there is visible rather than hidden.
 */

import type {
  Bullet,
  EnemyBullet,
  EnemyInstance,
  Explosion,
  Hull,
  Incident,
  RunStats,
  WorldView,
} from '../sim/entities'

/**
 * One reused 8-byte scratch buffer. Allocating per call would make hashing a
 * 2,000-projectile world allocate ~20k buffers, which turns a determinism test
 * into a GC benchmark.
 */
const FLOAT_BITS = new DataView(new ArrayBuffer(8))

/** Canonical quiet-NaN bits. Every NaN folds onto this one pattern. */
const CANONICAL_NAN_HI = 0x7ff80000
const CANONICAL_NAN_LO = 0x00000000

function rotl32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) | 0
}

/** Final avalanche (murmur3 fmix32) so a one-bit input change moves every output bit. */
function fmix32(h: number): number {
  let x = h | 0
  x ^= x >>> 16
  x = Math.imul(x, 2246822507)
  x ^= x >>> 13
  x = Math.imul(x, 3266489909)
  x ^= x >>> 16
  return x >>> 0
}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0')
}

/**
 * A streaming 64-bit hash built from two independent 32-bit lanes.
 *
 * Two lanes rather than one because the replay corpus only grows, and a 32-bit
 * digest starts having a realistic collision chance in the low tens of
 * thousands of entries. Sixty-four bits costs one extra `imul` per word and
 * removes the question entirely.
 *
 * The lanes use different primes and one of them rotates, so they cannot move in
 * lockstep and a value swapped between two fields still changes the digest.
 */
export class Hasher {
  private a = 0x811c9dc5 | 0
  private b = 0x9e3779b9 | 0

  /** The primitive. Everything else funnels through here. */
  u32(value: number): this {
    const x = value >>> 0
    this.a = Math.imul(this.a ^ x, 16777619)
    this.b = Math.imul(rotl32(this.b ^ x, 13), 2246822519)
    return this
  }

  /**
   * Hash any JS number exactly, via its IEEE-754 bits.
   *
   * `-0` folds onto `0`: a sim that produced `-0` where it used to produce `0`
   * plays identically, and failing a fixture over it would be noise. NaN folds
   * onto one canonical pattern: a sim producing NaN is broken and must hash
   * differently from `0`, but *which* NaN it produced is not information.
   */
  num(value: number): this {
    if (Number.isNaN(value)) return this.u32(CANONICAL_NAN_HI).u32(CANONICAL_NAN_LO)
    FLOAT_BITS.setFloat64(0, value === 0 ? 0 : value, true)
    return this.u32(FLOAT_BITS.getUint32(0, true)).u32(FLOAT_BITS.getUint32(4, true))
  }

  bool(value: boolean): this {
    // Two unrelated constants rather than 0/1, so a bool field cannot be
    // confused with an adjacent small integer field.
    return this.u32(value ? 0x9e3779b9 : 0x85ebca6b)
  }

  /** Length-prefixed so `['ab','c']` cannot hash the same as `['a','bc']`. */
  str(value: string): this {
    this.u32(value.length)
    for (let i = 0; i < value.length; i++) this.u32(value.charCodeAt(i))
    return this
  }

  /** `null` is a real state for `Incident.causeEnemyId`, distinct from `''`. */
  strOrNull(value: string | null): this {
    if (value === null) return this.u32(0xdeadbeef)
    return this.u32(0x00000001).str(value)
  }

  /** 16 lowercase hex characters. */
  digest(): string {
    return hex8(fmix32(this.a)) + hex8(fmix32(this.b))
  }
}

function hashInterpolated(h: Hasher, e: { x: number; y: number; prevX: number; prevY: number }): void {
  // prevX/prevY are included even though only the renderer reads them: they are
  // pure sim output, and a change to when they are latched is a real behaviour
  // change worth catching.
  h.num(e.x).num(e.y).num(e.prevX).num(e.prevY)
}

function hashHull(hull: Readonly<Hull>): string {
  const h = new Hasher()
  hashInterpolated(h, hull)
  h.num(hull.integrity)
    .num(hull.maxIntegrity)
    .num(hull.shield)
    .num(hull.maxShield)
    .num(hull.invulnTicks)
    .num(hull.radius)
  return h.digest()
}

function hashPlayerBullets(bullets: readonly Bullet[]): string {
  const h = new Hasher()
  // Array order is part of the state: swap-remove means order encodes the
  // removal history, and two sims that cull in a different order will diverge
  // later even if the current sets match.
  h.u32(bullets.length)
  for (const b of bullets) {
    hashInterpolated(h, b)
    h.num(b.vx).num(b.vy).num(b.damage).num(b.radius).bool(b.alive)
  }
  return h.digest()
}

function hashEnemyBullets(bullets: readonly EnemyBullet[]): string {
  const h = new Hasher()
  h.u32(bullets.length)
  for (const b of bullets) {
    hashInterpolated(h, b)
    h.num(b.vx).num(b.vy).num(b.damage).num(b.radius).bool(b.alive).str(b.kind)
  }
  return h.digest()
}

function hashEnemies(enemies: readonly EnemyInstance[]): string {
  const h = new Hasher()
  h.u32(enemies.length)
  for (const e of enemies) {
    hashInterpolated(h, e)
    h.str(e.defId)
      .num(e.hp)
      .num(e.maxHp)
      .num(e.radius)
      .str(e.shape)
      .str(e.movement)
      .bool(e.elite)
      .num(e.vx)
      .num(e.vy)
      .num(e.age)
      .str(e.phase)
      .num(e.fireCooldown)
      .num(e.contactDamage)
      .num(e.scrap)
      .bool(e.alive)
      .num(e.originX)
      .num(e.holdY)
    // hitFlashTicks deliberately omitted — entities.ts documents it as a
    // render-only concern, so it belongs in the cosmetic digest, not this one.
  }
  return h.digest()
}

function hashStats(stats: Readonly<RunStats>): string {
  const h = new Hasher()
  h.num(stats.tick)
    .num(stats.shotsFired)
    .num(stats.hits)
    .num(stats.kills)
    .num(stats.scrap)
    .num(stats.damageTaken)
    .num(stats.waveIndex)
    .num(stats.peakProjectiles)
    .num(stats.bulletsCulled)
  return h.digest()
}

function hashRun(runState: string, incident: Readonly<Incident> | null): string {
  const h = new Hasher()
  h.str(runState)
  if (incident === null) {
    h.u32(0xffffffff)
  } else {
    h.u32(0x00000001)
      .str(incident.causeKind)
      .strOrNull(incident.causeEnemyId)
      .num(incident.tick)
      .num(incident.secondsSurvived)
      .num(incident.waveIndex)
      .num(incident.scrap)
      .num(incident.kills)
  }
  return h.digest()
}

function hashCosmetic(
  explosions: readonly Explosion[],
  enemies: readonly EnemyInstance[],
): string {
  const h = new Hasher()
  h.u32(explosions.length)
  for (const e of explosions) {
    h.num(e.x).num(e.y).num(e.age).num(e.lifetime).num(e.radius).str(e.kind)
  }
  h.u32(enemies.length)
  for (const e of enemies) h.num(e.hitFlashTicks)
  return h.digest()
}

export interface EntityCounts {
  readonly playerBullets: number
  readonly enemyBullets: number
  readonly enemies: number
  readonly explosions: number
}

/**
 * Per-subsystem digests plus the combined regression hash.
 *
 * The components exist for failure diagnosis. When a fixture breaks, "enemies
 * and stats moved, hull and projectiles didn't" points at the enemy update in
 * one line, where a single opaque mismatched hash points nowhere.
 */
export interface WorldDigest {
  /** The regression hash. Play-affecting state only; excludes `cosmetic`. */
  readonly hash: string
  readonly hull: string
  readonly playerBullets: string
  readonly enemyBullets: string
  readonly enemies: string
  readonly stats: string
  /** runState plus the incident report. */
  readonly run: string
  /** Explosions and hit flashes. Reported, but not part of `hash`. */
  readonly cosmetic: string
  readonly counts: EntityCounts
}

/** The component digests that make up `hash`, in the order they are combined. */
export const HASHED_COMPONENTS = [
  'hull',
  'playerBullets',
  'enemyBullets',
  'enemies',
  'stats',
  'run',
] as const

export type HashedComponent = (typeof HASHED_COMPONENTS)[number]

export function digestWorld(view: WorldView): WorldDigest {
  const components = {
    hull: hashHull(view.hull),
    playerBullets: hashPlayerBullets(view.playerBullets),
    enemyBullets: hashEnemyBullets(view.enemyBullets),
    enemies: hashEnemies(view.enemies),
    stats: hashStats(view.stats),
    run: hashRun(view.runState, view.incident),
  }

  // The seed is folded in so two runs that happen to reach identical state from
  // different seeds still hash differently — a fixture asserts a specific run,
  // not a coincidence.
  const combined = new Hasher()
  combined.str(view.seed)
  for (const name of HASHED_COMPONENTS) combined.str(components[name])

  return {
    hash: combined.digest(),
    ...components,
    cosmetic: hashCosmetic(view.explosions, view.enemies),
    counts: {
      playerBullets: view.playerBullets.length,
      enemyBullets: view.enemyBullets.length,
      enemies: view.enemies.length,
      explosions: view.explosions.length,
    },
  }
}

/** The one number a replay fixture asserts on. */
export function hashWorld(view: WorldView): string {
  return digestWorld(view).hash
}

/**
 * Name the components that differ between two digests.
 *
 * Returns an empty array when the play-affecting state matches. `cosmetic` is
 * reported when it differs but never affects `hash`.
 */
export function diffDigests(a: WorldDigest, b: WorldDigest): string[] {
  const differing: string[] = []
  for (const name of HASHED_COMPONENTS) {
    if (a[name] !== b[name]) differing.push(name)
  }
  if (a.cosmetic !== b.cosmetic) differing.push('cosmetic')
  return differing
}
