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
 *    regression hash.** Explosions, hit flashes, the shake impulse, and the event
 *    stream all exist for presentation. Hitstop and telegraph countdowns do NOT —
 *    they spend real ticks and gate real attacks, so they are in the regression
 *    hash with the rest of the gameplay state. If the cosmetic half fed the main
 *    hash, retuning an explosion's lifetime or a shake impulse would fail
 *    every replay fixture for no reason, and the corpus would get re-recorded
 *    reflexively until it stopped meaning anything. The cosmetic digest is still
 *    computed and reported, so a divergence there is visible rather than hidden.
 *
 * ## THE TEST FOR "DOES THIS FIELD BELONG IN THE REGRESSION HASH"
 *
 * Not "is it visible" — *does the next tick read it*. Two states that differ only
 * in a field nothing reads produce the same future, and failing a fixture over one
 * is the noise that gets a corpus rubber-stamped. Two states that differ in a field
 * something reads produce different futures, and a digest that cannot tell them
 * apart is worse than no digest: the corpus goes green while the game diverges.
 *
 * Applied to what M5 added:
 *
 *   - `EnemyInstance.boss.phaseIndex` / `variantId` — IN. The phase decides the
 *     pattern, and `bossPhaseDefId` does not encode the variant, so two runs
 *     fighting different forms of the same boss carry the *same* `defId` at the
 *     same phase. Without `variantId` the digest cannot separate them at all.
 *   - `EnemyInstance.secondary.cooldown` / `.windup` — IN. A second barrel's
 *     cadence decides when a volley leaves, exactly like the primary's.
 *   - `EnemyInstance.uid` — IN. `entities.ts` already documents it as hashed and it
 *     was not; piercing reads it to decide what a round may still hit.
 *   - `stage`, `hazards`, `pendingChoice`, `inventory`, `hullName` — IN. Which
 *     sector is being flown, when a hazard fires, whether the run is paused on a
 *     card, and what the pilot is carrying all steer the next tick, and a run that
 *     diverged on any of them would otherwise compare equal.
 *   - `secondary.windupTotal`, `boss.calloutTicks`, `HazardView.progress` —
 *     COSMETIC. Each is a denominator or a display countdown that nothing branches
 *     on, the same call `telegraphTotal` already gets.
 *   - `resolvedStats` and `activeInteractions` — NEITHER, deliberately. Both are
 *     pure functions of the hull and the inventory, which are hashed. Hashing a
 *     derived value means renaming a stat key fails every fixture without any
 *     behaviour having changed.
 */

import type {
  Bullet,
  EnemyBullet,
  EnemyInstance,
  Hull,
  RunStats,
  SimEvent,
  WorldView,
} from '../sim/entities'

/**
 * Tags for optional sub-objects.
 *
 * Present and absent must hash differently, and the tag has to be a value the
 * following field could not itself produce — otherwise an enemy with no second
 * barrel and an enemy whose barrel is on cooldown 0 collide.
 */
const ABSENT = 0xfeedface
const PRESENT = 0x00000002

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
    h.num(e.uid)
      .str(e.defId)
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
      // The telegraph countdown is gameplay: it is the player's reaction window,
      // and a windup that fired a tick early is a difficulty change, not a visual
      // one. entities.ts is explicit that this is sim state and not an animation.
      .num(e.telegraphTicks)

    // Second barrel. Its cadence decides when a volley leaves the enemy exactly as
    // the primary's does, so a run whose secondary is one tick out of step is a run
    // that diverges. `windupTotal` is the display denominator and stays cosmetic,
    // matching the call already made for `telegraphTotal`.
    const secondary = e.secondary
    if (secondary === undefined) h.u32(ABSENT)
    else h.u32(PRESENT).num(secondary.cooldown).num(secondary.windup)

    // Boss phase script. `defId` already moves when a phase advances, but it is
    // NOT sufficient on its own: `bossPhaseDefId` is `${bossId}#${index}` with no
    // variant in it, so the base form and every variant share ids phase for phase.
    // Without `variantId` two runs fighting genuinely different patterns hash the
    // same, which is precisely the failure this digest exists to make impossible.
    const boss = e.boss
    if (boss === undefined) h.u32(ABSENT)
    else h.u32(PRESENT).str(boss.bossId).strOrNull(boss.variantId).num(boss.phaseIndex)

    // hitFlashTicks, telegraphTotal, secondary.windupTotal and boss.calloutTicks are
    // deliberately omitted — each is a flash or a progress denominator that nothing
    // branches on, so they belong in the cosmetic digest, not this one.
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

/**
 * Whole-run gameplay state: the outcome, the incident report, the hitstop clock,
 * which sector is being flown, what is armed, what is held, and what the run is
 * waiting on.
 *
 * `freezeTicks` is play-affecting — a freeze spends real ticks, so a run that
 * froze differently diverges from that point on — and so it must be in the
 * regression hash rather than in the cosmetic digest.
 *
 * EVERYTHING RIDES IN THIS ONE COMPONENT rather than getting one each, because
 * `tools/playtest.ts` enumerates component names by hand when it writes a fixture.
 * A component that tool does not know about would be silently absent from every
 * recorded fixture, which is a worse outcome than a slightly less precise diff. So
 * the M5 run state joins the existing three here instead of becoming `stage`,
 * `hazards` and `choice` components that no fixture would carry.
 */
function hashRun(view: WorldView): string {
  const h = new Hasher()
  h.str(view.runState).num(view.freezeTicks)
  const incident = view.incident
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

  // Which leg of the run. Wave numbering restarts per sector, so `stats.waveIndex`
  // alone cannot tell wave 4 of the Debris Shelf from wave 4 of the Deep Manifest —
  // two states that share a wave index and differ by four sectors would otherwise
  // be indistinguishable to the corpus. `sectorName` and `bossName` are display
  // strings derived from the id and are left out.
  h.num(view.stage.index).num(view.stage.count).str(view.stage.sectorId)

  // Armed hazards. `ticksToChange` is the countdown to the next warning or hit, so
  // it decides when the player takes damage; `progress` is the arc's numerator and
  // is cosmetic.
  h.u32(view.hazards.length)
  for (const hazard of view.hazards) {
    h.str(hazard.id).str(hazard.phase).num(hazard.ticksToChange)
  }

  // The hull issued, and what is fitted. Acquisition order is hook dispatch order,
  // so the array order is state and not presentation. `resolvedStats` and
  // `activeInteractions` are pure functions of these two and are not hashed —
  // see the header.
  h.str(view.hullName)
  h.u32(view.inventory.length)
  for (const item of view.inventory) {
    h.str(item.defId).num(item.acquiredAtTick).num(item.count)
  }

  // A card being open pauses the simulation, and *which* card decides what the next
  // confirm does. A run stopped on a route card and a run flying free are different
  // futures from identical entity lists.
  const choice = view.pendingChoice
  if (choice === null) {
    h.u32(0xffffffff)
  } else {
    h.u32(0x00000001).str(choice.kind)
    h.u32(choice.offers.length)
    // `interactionText` is derived copy, so only the identity and price of an offer
    // are hashed.
    for (const offer of choice.offers) h.str(offer.defId).str(offer.tier)
    h.u32(choice.costs.length)
    for (const cost of choice.costs) h.num(cost)
    h.u32(choice.workOrders.length)
    for (const kind of choice.workOrders) h.str(kind)
    h.u32(choice.routes.length)
    for (const route of choice.routes) {
      h.num(route.stageIndex).str(route.reward.kind)
      // The payout is what the sim credits on arrival, so it is state; the
      // `rewardText` that states it is derived from it.
      h.num(route.reward.kind === 'scrap' || route.reward.kind === 'repair' ? route.reward.amount : 0)
      h.u32(route.hazardIds.length)
      for (const id of route.hazardIds) h.str(id)
    }
  }
  return h.digest()
}

/**
 * Presentation state: explosions, flashes, the shake impulse, and this tick's
 * events.
 *
 * All of it is sim-owned so playback looks identical, and all of it is kept out of
 * the regression hash so that retuning an explosion, an impulse, or which events
 * fire does not fail every fixture and get the corpus re-recorded reflexively.
 * Hashed and reported all the same, so a divergence here is visible rather than
 * invisible.
 *
 * Events are included because "which events fired, in what order, carrying what"
 * is real sim output that nothing else in the digest would catch — an event
 * emitted twice, or at the wrong position, is a bug the cosmetic digest can see.
 */
function hashCosmetic(view: WorldView): string {
  const h = new Hasher()
  h.u32(view.explosions.length)
  for (const e of view.explosions) {
    h.num(e.x).num(e.y).num(e.age).num(e.lifetime).num(e.radius).str(e.kind)
  }
  h.u32(view.enemies.length)
  for (const e of view.enemies) {
    // -1 for absent: a real countdown is never negative, so the sentinel cannot be
    // confused with a barrel that happens to be idle.
    h.num(e.hitFlashTicks)
      .num(e.telegraphTotal)
      .num(e.secondary?.windupTotal ?? -1)
      .num(e.boss?.calloutTicks ?? -1)
  }
  h.u32(view.hazards.length)
  for (const hazard of view.hazards) h.num(hazard.progress)
  h.num(view.cosmetic.shake)
  h.u32(view.events.length)
  for (const event of view.events) hashEvent(h, event)
  return h.digest()
}

/**
 * Hash one event, field by field rather than through JSON.
 *
 * The switch is exhaustive on purpose: adding a variant to `SimEvent` without
 * hashing it should fail the typecheck here, not pass silently and leave the new
 * event outside the only thing that would notice it changing.
 *
 * IT DID NOT ENFORCE THAT until M5, and the six events bosses and hazards added
 * arrived unhashed and unnoticed. A switch with no default is not exhaustive
 * checking; the `never` assignment below is what makes the comment above true.
 */
function hashEvent(h: Hasher, event: SimEvent): void {
  h.str(event.kind)
  switch (event.kind) {
    case 'player-shot':
      h.num(event.x).num(event.y)
      return
    case 'enemy-hit':
      h.num(event.x).num(event.y).num(event.damage).str(event.defId).bool(event.lethal)
      return
    case 'enemy-killed':
      h.num(event.x).num(event.y).str(event.defId).num(event.scrap).bool(event.elite)
      return
    case 'enemy-shot':
      h.num(event.x).num(event.y).str(event.defId)
      return
    case 'hull-hit':
      h.num(event.x).num(event.y).num(event.damage).bool(event.absorbedByShield)
      return
    case 'shield-broken':
    case 'hull-lost':
      h.num(event.x).num(event.y)
      return
    case 'scrap-collected':
      h.num(event.x).num(event.y).num(event.amount)
      return
    case 'wave-released':
      h.num(event.index)
      return
    case 'boss-spawned':
      h.str(event.bossId).str(event.name)
      return
    case 'boss-phase':
      h.str(event.bossId).num(event.phaseIndex).str(event.callout)
      return
    case 'boss-killed':
      h.num(event.x).num(event.y).str(event.bossId)
      return
    case 'hazard-warning':
    case 'hazard-fired':
      h.str(event.hazardId)
      return
    case 'stage-cleared':
      h.num(event.stageIndex)
      return
    default: {
      // Unreachable while the switch covers every variant. When it stops covering
      // them this line stops compiling, which is the whole point.
      const unhandled: never = event
      throw new Error(`unhashed SimEvent: ${JSON.stringify(unhandled)}`)
    }
  }
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
  /**
   * runState, the incident report, the hitstop clock, the stage, armed hazards, the
   * hull and inventory, and any card the run is paused on.
   */
  readonly run: string
  /**
   * Explosions, hit flashes, telegraph and callout countdowns, hazard progress
   * arcs, the shake impulse, and this tick's events. Reported, but not part of
   * `hash`.
   */
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
    run: hashRun(view),
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
    cosmetic: hashCosmetic(view),
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
