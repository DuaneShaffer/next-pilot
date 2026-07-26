import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import type { Axis, InputSnapshot } from '../src/core/input'
import { NEUTRAL_INPUT, packInput, unpackInput } from '../src/core/input'
import { Rng } from '../src/core/rng'
import type {
  Bullet,
  EnemyBullet,
  EnemyInstance,
  Explosion,
  Hull,
  Incident,
  RunStats,
  WorldView,
} from '../src/sim/entities'
import type { BotName } from '../src/sim/bots'
import { BOTS, BOT_NAMES } from '../src/sim/bots'
import { World } from '../src/sim/world'
import { HULLS } from '../src/content/hulls'
import { diffDigests, digestWorld, Hasher, hashWorld } from '../src/meta/snapshot'
import {
  checkReplayCompatibility,
  describeIncompatibility,
  SIM_VERSION,
} from '../src/meta/simVersion'
import { RUN_PARAM, resolveRunMode } from '../src/meta/seedModes'
import type { Replay, TickableWorld } from '../src/meta/replay'
import {
  decodeReplay,
  encodeReplay,
  inputAt,
  playback,
  ReplayError,
  ReplayRecorder,
  REPLAY_FORMAT_VERSION,
  toSnapshots,
} from '../src/meta/replay'

// ---------------------------------------------------------------------------
// synthetic worlds
//
// The hashing tests build WorldView objects by hand rather than running the sim.
// That is deliberate: hashing is the foundation the whole replay corpus stands
// on, and its tests must keep working (and keep failing honestly) regardless of
// what state the simulation is in.
// ---------------------------------------------------------------------------

function hull(overrides: Partial<Hull> = {}): Hull {
  return {
    x: 224,
    y: 610,
    prevX: 224,
    prevY: 610,
    integrity: 100,
    maxIntegrity: 100,
    shield: 40,
    maxShield: 40,
    invulnTicks: 0,
    radius: 7,
    ...overrides,
  }
}

function bullet(overrides: Partial<Bullet> = {}): Bullet {
  return { x: 100, y: 200, prevX: 100, prevY: 210, vx: 0, vy: -620, damage: 4, radius: 2, alive: true, ...overrides }
}

function enemyBullet(overrides: Partial<EnemyBullet> = {}): EnemyBullet {
  return {
    x: 150,
    y: 300,
    prevX: 150,
    prevY: 295,
    vx: 10,
    vy: 180,
    damage: 8,
    radius: 3,
    alive: true,
    kind: 'pellet',
    ...overrides,
  }
}

function enemy(overrides: Partial<EnemyInstance> = {}): EnemyInstance {
  return {
    x: 200,
    y: 120,
    prevX: 200,
    prevY: 118,
    uid: 1,
    defId: 'skiff',
    hp: 12,
    maxHp: 12,
    radius: 10,
    shape: 'skiff',
    movement: 'sine',
    elite: false,
    vx: 0,
    vy: 40,
    age: 30,
    telegraphTicks: 0,
    telegraphTotal: 0,
    phase: 'holding',
    fireCooldown: 12,
    contactDamage: 10,
    scrap: 3,
    alive: true,
    hitFlashTicks: 0,
    originX: 200,
    holdY: 180,
    ...overrides,
  }
}

function explosion(overrides: Partial<Explosion> = {}): Explosion {
  return { x: 90, y: 90, age: 2, lifetime: 18, radius: 14, kind: 'enemy', ...overrides }
}

function stats(overrides: Partial<RunStats> = {}): RunStats {
  return {
    tick: 900,
    shotsFired: 300,
    hits: 210,
    kills: 14,
    scrap: 42,
    damageTaken: 18,
    waveIndex: 3,
    peakProjectiles: 96,
    bulletsCulled: 88,
    ...overrides,
  }
}

function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    causeKind: 'enemy-fire',
    causeEnemyId: 'lancer',
    tick: 900,
    secondsSurvived: 15,
    waveIndex: 3,
    scrap: 42,
    kills: 14,
    ...overrides,
  }
}

function worldView(overrides: Partial<WorldView> = {}): WorldView {
  return {
    seed: 'K7F29XQM3RTV',
    runState: 'active',
    // M5 view fields. Fixtures state them explicitly rather than spreading a shared
    // default, so adding a WorldView field fails here and someone decides what the
    // fixture should say instead of inheriting a silent placeholder.
    stage: { index: 0, count: 1, sectorId: 'debris-shelf', sectorName: 'Debris Shelf', bossName: null },
    hullName: 'Lien',
    boss: null,
    hazards: [],
    choiceResolve: null,
    choiceSelection: -1,
    hull: hull(),
    playerBullets: [bullet(), bullet({ x: 130, damage: 6 })],
    enemyBullets: [enemyBullet(), enemyBullet({ kind: 'tracker', vx: -30 })],
    enemies: [enemy(), enemy({ defId: 'lancer', elite: true, x: 300 })],
    explosions: [explosion()],
    stats: stats(),
    incident: null,
    events: [],
    cosmetic: { shake: 0 },
    freezeTicks: 0,
    inventory: [],
    activeInteractions: [],
    resolvedStats: {},
    pendingChoice: null,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// snapshot hashing
// ---------------------------------------------------------------------------

describe('state hashing', () => {
  it('is stable across calls and independent instances', () => {
    expect(hashWorld(worldView())).toBe(hashWorld(worldView()))
  })

  /**
   * A golden constant, not a self-comparison.
   *
   * This is the only test that can catch the hash function itself drifting —
   * a different Node version, a different platform's endianness, or someone
   * "simplifying" the float encoding would all still pass every other test in
   * this file while silently invalidating the entire replay corpus. If this
   * fails and the hasher was not deliberately changed, do not update the
   * constant; find out why the arithmetic moved.
   */
  /**
   * Re-recorded twice, and the bar each time was the same: name the play-affecting
   * field that was added or removed. "The test went red" is not a reason.
   *
   *   - M2 (`a84510e42a86be74` -> `14e21cacdce8283e`): `freezeTicks` and
   *     `telegraphTicks` entered the regression hash. Hitstop consumes real ticks
   *     and a telegraph is real reaction time.
   *   - M5, digest generation 2 (`14e21cacdce8283e` -> `6975de91b40a3194`):
   *     `EnemyInstance.uid`,
   *     `.secondary` and `.boss` entered the enemies component, and the stage,
   *     armed hazards, the hull, the inventory and the pending card entered the run
   *     component. Every one of them steers the next tick; see the header of
   *     `src/meta/snapshot.ts` for the field-by-field argument.
   *   - Digest generation 3 (`6975de91b40a3194` -> `d686a388a1795250`):
   *     `choiceResolve` entered the run component. It is the digest's only view of
   *     the choice cursor, which decides whether an untouched card auto-confirms or
   *     times out.
   *   - Digest generation 4 (`d686a388a1795250` -> `68587bac3c17901f`):
   *     `choiceSelection` entered it too — the highlighted option, which decides
   *     *what* an auto-confirm takes.
   *   - Digest generation 5 (`68587bac3c17901f` -> the constant below):
   *     `Bullet.pierceRemaining` and `.hitUids` entered `playerBullets`. Review
   *     finding R3: both are read by the next tick's hit resolution.
   *
   * The generation numbers are `DIGEST_GENERATION` in `src/meta/snapshot.ts`, and
   * `tests/simVersion.test.ts` explains why a digest change and a sim change have to
   * be counted separately.
   */
  it('matches a recorded digest for a known world', () => {
    expect(hashWorld(worldView())).toBe('9d27a50ec0d1a237')
  })

  it('includes the M2 timing state that hitstop and telegraphs introduced', () => {
    // Guards the re-record above: if either field silently stopped being hashed,
    // the constant would still match and every fixture would go blind to a whole
    // class of divergence.
    const base = hashWorld(worldView())
    expect(hashWorld(worldView({ freezeTicks: 3 }))).not.toBe(base)
    expect(
      hashWorld(
        worldView({
          enemies: [
            enemy({ telegraphTicks: 12, telegraphTotal: 22 }),
            enemy({ defId: 'lancer', elite: true, x: 300 }),
          ],
        }),
      ),
    ).not.toBe(base)
  })

  it('gives every play-affecting field its own influence', () => {
    const base = hashWorld(worldView())
    const mutations: Array<[string, WorldView]> = [
      ['seed', worldView({ seed: 'K7F29XQM3RTW' })],
      ['runState', worldView({ runState: 'lost' })],
      ['hull.x', worldView({ hull: hull({ x: 224.0001 }) })],
      ['hull.integrity', worldView({ hull: hull({ integrity: 99 }) })],
      ['hull.invulnTicks', worldView({ hull: hull({ invulnTicks: 1 }) })],
      ['playerBullets.length', worldView({ playerBullets: [bullet()] })],
      ['playerBullets[0].vy', worldView({ playerBullets: [bullet({ vy: -619 }), bullet({ x: 130, damage: 6 })] })],
      ['enemyBullets[0].kind', worldView({ enemyBullets: [enemyBullet({ kind: 'shard' }), enemyBullet({ kind: 'tracker', vx: -30 })] })],
      ['enemies[0].hp', worldView({ enemies: [enemy({ hp: 11 }), enemy({ defId: 'lancer', elite: true, x: 300 })] })],
      ['enemies[0].phase', worldView({ enemies: [enemy({ phase: 'committed' }), enemy({ defId: 'lancer', elite: true, x: 300 })] })],
      ['enemies[0].elite', worldView({ enemies: [enemy({ elite: true }), enemy({ defId: 'lancer', elite: true, x: 300 })] })],
      ['stats.kills', worldView({ stats: stats({ kills: 15 }) })],
      ['stats.waveIndex', worldView({ stats: stats({ waveIndex: 4 }) })],
      ['incident', worldView({ runState: 'lost', incident: incident() })],
    ]
    for (const [label, mutated] of mutations) {
      expect(hashWorld(mutated), `${label} did not change the hash`).not.toBe(base)
    }
  })

  it('separates a null incident from an attributed one', () => {
    const unattributed = worldView({ runState: 'lost', incident: incident({ causeEnemyId: null }) })
    const attributed = worldView({ runState: 'lost', incident: incident({ causeEnemyId: 'hauler' }) })
    expect(hashWorld(unattributed)).not.toBe(hashWorld(attributed))
  })

  it('treats array order as state', () => {
    const forward = worldView({ playerBullets: [bullet({ x: 1 }), bullet({ x: 2 })] })
    const reversed = worldView({ playerBullets: [bullet({ x: 2 }), bullet({ x: 1 })] })
    // Swap-remove means array order encodes removal history; two sims that cull
    // in a different order will diverge later even when the sets match now.
    expect(hashWorld(forward)).not.toBe(hashWorld(reversed))
  })

  it('excludes cosmetic state from the regression hash but still reports it', () => {
    const base = worldView()
    const moreVfx = worldView({
      explosions: [explosion(), explosion({ x: 10, kind: 'hull' })],
      enemies: [enemy({ hitFlashTicks: 4 }), enemy({ defId: 'lancer', elite: true, x: 300 })],
    })
    expect(hashWorld(moreVfx)).toBe(hashWorld(base))
    expect(digestWorld(moreVfx).cosmetic).not.toBe(digestWorld(base).cosmetic)
    expect(diffDigests(digestWorld(base), digestWorld(moreVfx))).toEqual(['cosmetic'])
  })

  it('names only the components that actually differ', () => {
    const a = digestWorld(worldView())
    const b = digestWorld(worldView({ stats: stats({ kills: 99 }) }))
    expect(diffDigests(a, b)).toEqual(['stats'])
    expect(diffDigests(a, a)).toEqual([])
  })

  it('folds -0 onto 0 and every NaN onto one pattern', () => {
    // -0 plays identically to 0, so failing a fixture over it would be noise.
    expect(new Hasher().num(-0).digest()).toBe(new Hasher().num(0).digest())
    // A NaN sim is broken, so it must hash differently from 0 — but which NaN
    // it produced is not information worth distinguishing.
    const nan = new Hasher().num(Number.NaN).digest()
    expect(nan).not.toBe(new Hasher().num(0).digest())
    expect(nan).toBe(new Hasher().num(Number.NaN * 2).digest())
  })

  it('distinguishes floats a decimal rounding would merge', () => {
    const a = new Hasher().num(0.1 + 0.2).digest()
    const b = new Hasher().num(0.3).digest()
    // 0.1+0.2 !== 0.3 in IEEE-754, and a sim that produced one where it used to
    // produce the other has changed. Hashing formatted strings would hide it.
    expect(a).not.toBe(b)
  })

  it('length-prefixes strings so concatenations cannot collide', () => {
    expect(new Hasher().str('ab').str('c').digest()).not.toBe(new Hasher().str('a').str('bc').digest())
  })
})

// ---------------------------------------------------------------------------
// replay encoding
// ---------------------------------------------------------------------------

/** A stub sim: records exactly the bytes it was ticked with. */
class InputLogWorld implements TickableWorld {
  readonly log: number[] = []
  constructor(readonly seed: string) {}
  tick(input: InputSnapshot): void {
    this.log.push(packInput(input))
  }
}

function randomInputs(seed: string, ticks: number, changeEvery = 9): InputSnapshot[] {
  const rng = Rng.fromSeed(seed, 'test:replay-inputs')
  const out: InputSnapshot[] = []
  let current: InputSnapshot = NEUTRAL_INPUT
  for (let i = 0; i < ticks; i++) {
    if (i % changeEvery === 0) {
      current = {
        moveX: (rng.int(3) - 1) as Axis,
        moveY: (rng.int(3) - 1) as Axis,
        fire: rng.chance(0.8),
        special: rng.chance(0.1),
        focus: rng.chance(0.2),
      }
    }
    out.push(current)
  }
  return out
}

function recordOf(seed: string, inputs: readonly InputSnapshot[]): ReplayRecorder {
  const recorder = new ReplayRecorder(seed)
  for (const input of inputs) recorder.record(input)
  return recorder
}

/** As `recordOf`, with a hull id — the format-3 field. */
function recordOf2(seed: string, hullId: string, inputs: readonly InputSnapshot[]): ReplayRecorder {
  const recorder = new ReplayRecorder(seed, hullId)
  for (const input of inputs) recorder.record(input)
  return recorder
}

/**
 * An independent base64url + FNV implementation, used only to forge byte-level
 * corruption cases.
 *
 * Duplicating the encoder in the test is intentional. Reaching into the module's
 * internals would make these tests pass whenever the module is self-consistent,
 * including when it is self-consistently wrong; an independent implementation
 * cross-checks the real one.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

function localBase64Url(bytes: readonly number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0
    const b1 = bytes[i + 1]
    const b2 = bytes[i + 2]
    const n = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0)
    out += B64.charAt((n >>> 18) & 63) + B64.charAt((n >>> 12) & 63)
    if (b1 !== undefined) out += B64.charAt((n >>> 6) & 63)
    if (b2 !== undefined) out += B64.charAt(n & 63)
  }
  return out
}

function localChecksum(bytes: readonly number[]): number {
  let h = 0x811c9dc5 | 0
  for (const byte of bytes) h = Math.imul(h ^ byte, 16777619)
  return h >>> 0
}

/** Build a replay blob by hand, optionally with a deliberately wrong field. */
function forgeReplay(options: {
  magic?: readonly number[]
  version?: number
  /** Simulation version byte. Defaults to this build's, like a real recording. */
  simVersion?: number
  seed?: string
  /** Hull id. Defaults to empty — "this run did not choose a hull". */
  hullId?: string
  /** Overrides the hull length byte without changing the bytes that follow it. */
  hullLength?: number
  tickCount?: number
  runs?: ReadonlyArray<[number, number]>
  breakChecksum?: boolean
  extraTrailing?: readonly number[]
}): string {
  const magic = options.magic ?? [0x4e, 0x50, 0x52]
  const version = options.version ?? REPLAY_FORMAT_VERSION
  const simVersion = options.simVersion ?? SIM_VERSION
  const seed = options.seed ?? 'ABCD'
  const hullId = options.hullId ?? ''
  const runs = options.runs ?? [[packInput(NEUTRAL_INPUT), 4]]
  const tickCount = options.tickCount ?? runs.reduce((sum, [, count]) => sum + count, 0)

  // simVersion sits between the format version and the seed length — the byte that
  // lets a future build refuse a replay rather than play it back wrong.
  const bytes: number[] = [...magic, version, simVersion, seed.length]
  for (let i = 0; i < seed.length; i++) bytes.push(seed.charCodeAt(i))
  // The hull id, added at format 3. A length byte then that many printable bytes,
  // so a zero here is a complete and legal field rather than an absent one.
  bytes.push(options.hullLength ?? hullId.length)
  for (let i = 0; i < hullId.length; i++) bytes.push(hullId.charCodeAt(i))
  const varint = (value: number): void => {
    let v = value
    while (v >= 0x80) {
      bytes.push((v & 0x7f) | 0x80)
      v = Math.floor(v / 128)
    }
    bytes.push(v & 0x7f)
  }
  varint(tickCount)
  for (const [byte, count] of runs) {
    bytes.push(byte)
    varint(count)
  }
  if (options.extraTrailing) bytes.push(...options.extraTrailing)
  const sum = localChecksum(bytes) ^ (options.breakChecksum === true ? 0xff : 0)
  bytes.push(sum & 0xff, (sum >>> 8) & 0xff, (sum >>> 16) & 0xff, (sum >>> 24) & 0xff)
  return localBase64Url(bytes)
}

describe('replay encoding', () => {
  it('round-trips an arbitrary input sequence losslessly', () => {
    const inputs = randomInputs('ROUNDTR1P234', 4_000)
    const decoded = decodeReplay(recordOf('K7F29XQM3RTV', inputs).encode())
    expect(decoded.version).toBe(REPLAY_FORMAT_VERSION)
    expect(decoded.seed).toBe('K7F29XQM3RTV')
    expect(decoded.inputs.length).toBe(inputs.length)
    expect(toSnapshots(decoded)).toEqual(inputs)
  })

  it('round-trips every reachable input byte', () => {
    // 3 x 3 x 2 x 2 x 2 = 72 distinct snapshots. Exhaustive is cheap here, and
    // a packing bug in one rare combination is exactly the kind of thing a
    // random sample misses.
    const all: InputSnapshot[] = []
    for (const moveX of [-1, 0, 1] as const) {
      for (const moveY of [-1, 0, 1] as const) {
        for (const fire of [false, true]) {
          for (const special of [false, true]) {
            for (const focus of [false, true]) {
              all.push({ moveX, moveY, fire, special, focus })
            }
          }
        }
      }
    }
    const decoded = decodeReplay(recordOf('ABCD', all).encode())
    expect(toSnapshots(decoded)).toEqual(all)
  })

  it('round-trips a zero-tick replay', () => {
    const decoded = decodeReplay(new ReplayRecorder('ABCD').encode())
    expect(decoded.inputs.length).toBe(0)
    expect(decoded.seed).toBe('ABCD')
  })

  it('agrees with an independently written encoder', () => {
    const recorder = recordOf('ABCD', [NEUTRAL_INPUT, NEUTRAL_INPUT, NEUTRAL_INPUT, NEUTRAL_INPUT])
    expect(recorder.encode()).toBe(forgeReplay({ seed: 'ABCD', runs: [[packInput(NEUTRAL_INPUT), 4]] }))
  })

  it('reads back individual ticks', () => {
    const inputs = randomInputs('TICKAT234567', 200)
    const replay = decodeReplay(recordOf('ABCD', inputs).encode())
    expect(inputAt(replay, 0)).toEqual(inputs[0])
    expect(inputAt(replay, 199)).toEqual(inputs[199])
    expect(() => inputAt(replay, 200)).toThrow(ReplayError)
  })
})

describe('replay compression', () => {
  const HELD: InputSnapshot = { moveX: 1, moveY: 0, fire: true, special: false, focus: false }

  it('collapses a twenty-minute held run to a few hundred bytes', () => {
    // 20 minutes at 60Hz. Uncompressed this is 72KB, ~96KB base64'd, which is
    // far past what a URL carries. Held inputs dominate real play, so RLE is the
    // difference between a shareable link and a file upload.
    const ticks = 20 * 60 * 60
    const encoded = recordOf('K7F29XQM3RTV', new Array<InputSnapshot>(ticks).fill(HELD)).encode()
    expect(encoded.length).toBeLessThan(400)
    expect(decodeReplay(encoded).inputs.length).toBe(ticks)
  })

  it('scales with input changes rather than with ticks', () => {
    const held = recordOf('ABCD', new Array<InputSnapshot>(10_000).fill(HELD)).encode()
    const alternating: InputSnapshot[] = []
    for (let i = 0; i < 10_000; i++) alternating.push(i % 2 === 0 ? HELD : NEUTRAL_INPUT)
    const churned = recordOf('ABCD', alternating).encode()
    expect(churned.length).toBeGreaterThan(held.length * 100)
    // Even worst-case churn must stay under the raw byte-per-tick cost, or RLE
    // would be a pessimisation on frantic play.
    expect(churned.length).toBeLessThan(10_000 * 3)
  })

  it('keeps a realistic bot-shaped run small enough for a URL', () => {
    // A direction change every ~9 ticks is far twitchier than anyone plays, so
    // this is a pessimistic three-minute run: it measures ~3.1KB, against 10.8KB
    // raw and 14.4KB base64'd. Browsers and CDNs handle URLs of ~8KB, so the
    // bound is set there rather than at the measured figure — this test guards
    // "still fits in a link", not "the encoder never changes by a byte".
    const encoded = recordOf('ABCD', randomInputs('REAL1ST1C234', 3 * 60 * 60)).encode()
    expect(encoded.length).toBeLessThan(8_000)
  })
})

describe('replay corruption is rejected, never guessed at', () => {
  const valid = recordOf('K7F29XQM3RTV', randomInputs('CORRUPT23456', 1_200)).encode()

  it('accepts the unmodified string', () => {
    expect(decodeReplay(valid).inputs.length).toBe(1_200)
  })

  it('rejects an empty string', () => {
    expect(() => decodeReplay('')).toThrow(ReplayError)
  })

  it('rejects a truncated string rather than replaying a prefix', () => {
    // The failure this prevents: a decoder that silently plays 800 of 1,200
    // ticks reports a reproduction mismatch and sends someone hunting a sim bug.
    for (const cut of [1, 4, 8, 40, 200]) {
      const truncated = valid.slice(0, valid.length - cut)
      expect(() => decodeReplay(truncated), `cut ${cut}`).toThrow(ReplayError)
    }
  })

  it('rejects a single flipped character anywhere in the payload', () => {
    for (const index of [6, 12, 30, Math.floor(valid.length / 2), valid.length - 2]) {
      const original = valid.charAt(index)
      const replacement = original === 'A' ? 'B' : 'A'
      const mangled = valid.slice(0, index) + replacement + valid.slice(index + 1)
      expect(() => decodeReplay(mangled), `index ${index}`).toThrow(ReplayError)
    }
  })

  it('rejects characters that are not base64url', () => {
    expect(() => decodeReplay(`${valid.slice(0, 10)}!${valid.slice(11)}`)).toThrow(/not-base64url/)
    expect(() => decodeReplay('###')).toThrow(/not-base64url/)
  })

  it('rejects something that is not a replay at all', () => {
    expect(() => decodeReplay(forgeReplay({ magic: [0x41, 0x42, 0x43] }))).toThrow(/bad-magic/)
    expect(() => decodeReplay('aGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSByZXBsYXk')).toThrow(ReplayError)
  })

  it('rejects a short string that cannot hold a header', () => {
    expect(() => decodeReplay('AAAA')).toThrow(/too-short/)
  })

  it('rejects a broken checksum', () => {
    expect(() => decodeReplay(forgeReplay({ breakChecksum: true }))).toThrow(/checksum-mismatch/)
  })

  it('rejects a run table that disagrees with the declared tick count', () => {
    expect(() => decodeReplay(forgeReplay({ tickCount: 9, runs: [[0b0101, 4]] }))).toThrow(
      /tick-count-mismatch/,
    )
    expect(() => decodeReplay(forgeReplay({ tickCount: 2, runs: [[0b0101, 4]] }))).toThrow(
      /tick-count-mismatch/,
    )
  })

  it('rejects a zero-length run', () => {
    expect(() => decodeReplay(forgeReplay({ runs: [[0b0101, 0]], tickCount: 0 }))).toThrow(
      /bad-run-count/,
    )
  })

  it('rejects an input byte the packer could never produce', () => {
    // 0b11 in an axis field and anything in bit 7 are unreachable from
    // packInput, which makes them a free corruption check.
    expect(() => decodeReplay(forgeReplay({ runs: [[0b0011, 2]] }))).toThrow(/bad-input-byte/)
    expect(() => decodeReplay(forgeReplay({ runs: [[0b1100, 2]] }))).toThrow(/bad-input-byte/)
    expect(() => decodeReplay(forgeReplay({ runs: [[0b10000000, 2]] }))).toThrow(/bad-input-byte/)
  })

  it('rejects an implausible seed', () => {
    expect(() => decodeReplay(forgeReplay({ seed: '' }))).toThrow(/bad-seed/)
    expect(() => decodeReplay(forgeReplay({ seed: 'AB CD' }))).toThrow(/bad-seed/)
  })
})

describe('replay format versioning', () => {
  it('stamps the current version', () => {
    expect(decodeReplay(new ReplayRecorder('ABCD').encode()).version).toBe(REPLAY_FORMAT_VERSION)
  })

  it('refuses a future version instead of misreading it', () => {
    // Without this the next format change would read old replays as plausible
    // nonsense and blame the simulation for the mismatch.
    expect(() => decodeReplay(forgeReplay({ version: REPLAY_FORMAT_VERSION + 1 }))).toThrow(
      /version-mismatch/,
    )
    expect(() => decodeReplay(forgeReplay({ version: 0 }))).toThrow(/version-mismatch/)
  })

  it('reports the version it found and the version it wanted', () => {
    expect(() => decodeReplay(forgeReplay({ version: 7 }))).toThrow(
      new RegExp(`version 7.*reads ${REPLAY_FORMAT_VERSION}`),
    )
  })

  it('refuses to encode a replay claiming another version', () => {
    const wrong: Replay = {
      version: 99,
      simVersion: SIM_VERSION,
      hullId: '',
      seed: 'ABCD',
      inputs: new Uint8Array([0b0101]),
    }
    expect(() => encodeReplay(wrong)).toThrow(/version-mismatch/)
  })
})

describe('the hull is part of the recorded run', () => {
  /**
   * WHY THE FIELD EXISTS. A replay was seed plus inputs, and that was lossless only
   * by accident: every run flew a Lien because nothing chose a hull. With hull
   * selection, a Collateral run — 30 shots/second, no shield — replayed as a Lien at
   * 20 shots/second diverges within a few ticks, and the share card hands the link
   * out without complaint.
   */
  it('round-trips a hull id', () => {
    const decoded = decodeReplay(recordOf2('K7F29XQM3RTV', 'collateral', randomInputs('HULL12345678', 200)).encode())
    expect(decoded.hullId).toBe('collateral')
    expect(decoded.seed).toBe('K7F29XQM3RTV')
    expect(decoded.inputs.length).toBe(200)
  })

  it('round-trips an empty hull id as empty, never as a default', () => {
    // "No hull was chosen" is a FACT ABOUT THE RECORDING and it has to survive. A
    // decoder that helpfully substituted 'lien' would turn "we do not know" into a
    // confident claim, which is the same class of error as playing back an
    // incompatible replay: plausible, unverifiable, and wrong.
    expect(decodeReplay(new ReplayRecorder('ABCD').encode()).hullId).toBe('')
    expect(new ReplayRecorder('ABCD').hullId).toBe('')
    expect(decodeReplay(recordOf2('ABCD', '', [NEUTRAL_INPUT]).encode()).hullId).toBe('')
  })

  it('carries the id verbatim, whatever the roster calls it', () => {
    // Not validated against `HULLS` on purpose: the decoder's job is to reproduce the
    // bytes, and a replay naming a hull this build has dropped must decode so the
    // caller can say "that hull no longer exists" rather than "that link is corrupt".
    for (const id of ['lien', 'arrears', 'surety', 'probate', 'collateral', 'a', 'x'.repeat(32)]) {
      expect(decodeReplay(recordOf2('ABCD', id, [NEUTRAL_INPUT]).encode()).hullId, id).toBe(id)
    }
  })

  it('refuses a hull id longer than the cap, on the way in and on the way out', () => {
    expect(() => recordOf2('ABCD', 'x'.repeat(33), [NEUTRAL_INPUT]).encode()).toThrow(/bad-hull/)
    expect(() => decodeReplay(forgeReplay({ hullId: 'x'.repeat(33) }))).toThrow(/bad-hull/)
    // A length byte that overruns the payload is the corruption case, not an
    // authoring one: it would otherwise read the tick count as hull characters.
    expect(() => decodeReplay(forgeReplay({ hullId: 'lien', hullLength: 200 }))).toThrow(/bad-hull/)
  })

  it('refuses a hull id that is not printable ASCII', () => {
    expect(() => recordOf2('ABCD', 'li en', [NEUTRAL_INPUT]).encode()).toThrow(/bad-hull/)
    expect(() => recordOf2('ABCD', 'li en', [NEUTRAL_INPUT]).encode()).toThrow(/bad-hull/)
    expect(() => recordOf2('ABCD', 'liĕn', [NEUTRAL_INPUT]).encode()).toThrow(/bad-hull/)
    expect(() => decodeReplay(forgeReplay({ hullId: 'li en' }))).toThrow(/bad-hull/)
  })

  it('says the hull is wrong, not that the seed is', () => {
    // These codes exist so a caller can tell failures apart. Reporting a hull
    // problem as `bad-seed` sends the next person to the one field that was fine.
    try {
      decodeReplay(forgeReplay({ hullId: 'x'.repeat(33) }))
      throw new Error('expected a rejection')
    } catch (error) {
      expect(error).toBeInstanceOf(ReplayError)
      expect((error as ReplayError).reason).toBe('bad-hull')
      expect((error as ReplayError).message).toContain('hull id')
    }
  })

  it('changes the payload, so a mangled hull id fails the checksum', () => {
    // The field is inside the checksummed body rather than bolted on after it. A
    // hull id altered in transit has to be caught by the same mechanism that catches
    // an altered input log.
    const encoded = recordOf2('K7F29XQM3RTV', 'collateral', randomInputs('CKSUM1234567', 100)).encode()
    for (const index of [8, 12, 16]) {
      const original = encoded.charAt(index)
      const mangled = encoded.slice(0, index) + (original === 'A' ? 'B' : 'A') + encoded.slice(index + 1)
      if (mangled === encoded) continue
      expect(() => decodeReplay(mangled), `index ${index}`).toThrow(ReplayError)
    }
  })

  /**
   * THE FACT THAT JUSTIFIES THE GUARD EXISTING.
   *
   * Deliberately does NOT go through `playback`, so it cannot be satisfied by the
   * check that `playback` now performs. Two `World`s, one seed, one input log, two
   * hulls: if these agreed, the whole field would be unnecessary. Asserting the size
   * of the mistake rather than assuming it is small is the point — this is what a
   * shared Collateral link would have shown its recipient.
   */
  it('a run flown in the wrong hull is a different run', () => {
    const inputs = randomInputs('D1VERGEHULL1', 900)
    const collateral = HULLS['collateral']
    expect(collateral, 'this test is meaningless without the hull').toBeDefined()

    const flown = new World('K7F29XQM3RTV', { items: {}, interactions: [], ...(collateral ? { hull: collateral } : {}) })
    const lien = new World('K7F29XQM3RTV')
    for (const input of inputs) {
      flown.tick(input)
      lien.tick(input)
    }

    expect(hashWorld(flown)).not.toBe(hashWorld(lien))
    // And concretely, not merely as a hash: Collateral strips the shield generator
    // and opens the feed to 30 shots a second.
    expect(flown.hull.maxShield).toBe(0)
    expect(lien.hull.maxShield).toBe(40)
    expect(flown.stats.shotsFired).toBeGreaterThan(lien.stats.shotsFired)
  })

  /**
   * AND THE GUARD, which turns that divergence from a thing that happens silently
   * into a thing that cannot happen.
   *
   * `playback` cannot build a world — it knows nothing about content tables — so the
   * only move available to it is to check that the caller honoured the hull it was
   * handed. A factory that ignores the argument is now a loud failure at tick zero
   * instead of a plausible run that is wrong from the first shot.
   */
  it('refuses to play a replay in a hull the caller substituted', () => {
    const replay = decodeReplay(recordOf2('K7F29XQM3RTV', 'collateral', randomInputs('GUARDHULL123', 120)).encode())

    let thrown: unknown = null
    try {
      playback(replay, (seed) => new World(seed))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ReplayError)
    expect((thrown as ReplayError).reason).toBe('bad-hull')
    // The message has to name both ships, or the reader cannot tell which side is
    // wrong — the link, or the code that opened it.
    expect((thrown as ReplayError).message).toContain('collateral')
    expect((thrown as ReplayError).message).toContain('Lien')
  })

  it('plays when the caller honours the hull the replay names', () => {
    const replay = decodeReplay(recordOf2('K7F29XQM3RTV', 'collateral', randomInputs('GUARDHULL123', 120)).encode())
    const { world, ticks } = playback(replay, (seed, hullId) => {
      const hull = HULLS[hullId]
      return new World(seed, { items: {}, interactions: [], ...(hull ? { hull } : {}) })
    })
    expect(ticks).toBe(120)
    expect(world.hullName).toBe('Collateral')
    expect(world.hull.maxShield).toBe(0)
  })

  it('matches a hull by id or by display name, and ignores case', () => {
    // The replay stores an id, the world reports a display name, and neither side
    // should have to know which convention the other picked. What matters is that
    // they are not two *different* ships.
    const replay = decodeReplay(recordOf2('ABCD', 'Collateral', [NEUTRAL_INPUT]).encode())
    expect(() =>
      playback(replay, (seed) => new World(seed, { items: {}, interactions: [], hull: HULLS['collateral'] as never })),
    ).not.toThrow()
  })

  it('says nothing when either side does not know its hull', () => {
    // Both skips are deliberate and both are load-bearing. An empty `hullId` means
    // "this run chose no hull", which is every fixture in the corpus. A world that
    // does not report a hull is a fabricated test world, and a determinism harness
    // must not be forced to model hulls to replay an input log.
    const noHull = decodeReplay(recordOf('ABCD', [NEUTRAL_INPUT, NEUTRAL_INPUT]).encode())
    expect(noHull.hullId).toBe('')
    expect(() => playback(noHull, (seed) => new World(seed))).not.toThrow()

    const named = decodeReplay(recordOf2('ABCD', 'collateral', [NEUTRAL_INPUT]).encode())
    expect(() => playback(named, (seed) => new InputLogWorld(seed))).not.toThrow()
  })
})

describe('a replay from an older simulation is refused, not played back wrong', () => {
  /**
   * THE M5 CASE, PINNED.
   *
   * M4 recorded single-sector runs. This build flies five sectors, restarts wave
   * numbering per sector, and rolls three new streams. An M4 replay is therefore a
   * valid input log for a completely different game — and every layer below this
   * one is *happy* with it, which is exactly what makes it dangerous.
   */
  const OLD_SIM_VERSION = SIM_VERSION - 1

  it('is a different failure from an old wire format, and that is the whole point', () => {
    // TWO KINDS OF "OLD", AND THEY MUST NOT BE CONFLATED — this is the subject of
    // src/meta/simVersion.ts, made concrete now that both exist at once.
    //
    // An old FORMAT is refused by the decoder: the bytes cannot be read, the error
    // names the version it found, and nothing plays. Safe and legible.
    expect(() => decodeReplay(forgeReplay({ version: 2 }))).toThrow(/version-mismatch/)
    expect(() => decodeReplay(forgeReplay({ version: 2 }))).toThrow(/format version 2/)

    // An old SIMULATION is not refused by the decoder at all. The bytes are current
    // and perfectly well formed; only their meaning has moved. Nothing below the
    // compatibility check can see the problem, which is why that check exists.
    const decoded = decodeReplay(forgeReplay({ simVersion: OLD_SIM_VERSION }))
    expect(decoded.version).toBe(REPLAY_FORMAT_VERSION)
    expect(checkReplayCompatibility(decoded.simVersion).kind).toBe('older')
  })

  it('decodes an old replay without complaint — the format layer cannot catch this', () => {
    // Stated as an assertion rather than a comment because it is the whole premise:
    // if decoding threw, no version guard would be needed. It does not throw. The
    // bytes are perfectly well formed; only their *meaning* has changed.
    const decoded = decodeReplay(forgeReplay({ simVersion: OLD_SIM_VERSION, seed: 'K7F29XQM3RTV' }))
    expect(decoded.version).toBe(REPLAY_FORMAT_VERSION)
    expect(decoded.simVersion).toBe(OLD_SIM_VERSION)
    expect(decoded.seed).toBe('K7F29XQM3RTV')
    expect(decoded.inputs.length).toBeGreaterThan(0)
  })

  it('refuses it at the compatibility check, and says so honestly', () => {
    const decoded = decodeReplay(forgeReplay({ simVersion: OLD_SIM_VERSION }))
    const verdict = checkReplayCompatibility(decoded.simVersion)
    expect(verdict).toEqual({ kind: 'older', recorded: OLD_SIM_VERSION, current: SIM_VERSION })

    const message = describeIncompatibility(verdict)
    expect(message).toBeTruthy()
    // The honest sentence: the rules changed, so it would not play back the run it
    // recorded. Not "corrupt", which would send the recipient hunting a bad link.
    expect(message).toContain('earlier version')
    expect(message).toContain('rules have changed')
    expect(message).not.toMatch(/invalid|corrupt|error|damaged/i)
  })

  it('refuses it end to end, and keeps the seed so the link is still worth something', () => {
    const params = new URLSearchParams()
    params.set(RUN_PARAM.replay, forgeReplay({ simVersion: OLD_SIM_VERSION, seed: 'K7F29XQM3RTV' }))
    const resolved = resolveRunMode({
      params,
      now: new Date('2026-07-25T12:00:00Z'),
      dailyRecord: null,
      randomSeed: () => 'FALLBACK2345',
    })

    // NOT a replay run. The one outcome that must never happen is `kind: 'replay'`
    // here, because that is the silently divergent playback.
    expect(resolved.mode.kind).not.toBe('replay')
    expect(resolved.rejections).toContain('replay-incompatible')
    expect(resolved.notice).toContain('earlier version')
    // The starting conditions survive even when the run does not.
    expect(resolved.mode.seed).toBe('K7F29XQM3RTV')
  })

  it('stamps this build s version on everything it records', () => {
    // The other half of the guard: a replay recorded now has to carry v2, or the
    // next bump has nothing to compare against.
    expect(new ReplayRecorder('ABCD').toReplay().simVersion).toBe(SIM_VERSION)
    expect(decodeReplay(new ReplayRecorder('ABCD').encode()).simVersion).toBe(SIM_VERSION)
  })

  it('accepts a replay recorded by this build', () => {
    const encoded = recordOf('K7F29XQM3RTV', randomInputs('C0MPAT12345X', 300)).encode()
    const decoded = decodeReplay(encoded)
    expect(checkReplayCompatibility(decoded.simVersion)).toEqual({ kind: 'ok' })
    expect(describeIncompatibility(checkReplayCompatibility(decoded.simVersion))).toBeNull()
  })

})

describe('replay playback', () => {
  it('drives a world with exactly the recorded inputs, in order', () => {
    const inputs = randomInputs('PLAYBACK2345', 500)
    const replay = decodeReplay(recordOf('SEEDSEEDSEED', inputs).encode())
    const { world, ticks, stoppedEarly } = playback(replay, (seed) => new InputLogWorld(seed))
    expect(world.seed).toBe('SEEDSEEDSEED')
    expect(ticks).toBe(500)
    expect(stoppedEarly).toBe(false)
    expect(world.log).toEqual(inputs.map(packInput))
  })

  it('stops early when asked, and says so', () => {
    const replay = decodeReplay(recordOf('ABCD', randomInputs('STOPEARLY234', 500)).encode())
    const result = playback(replay, (seed) => new InputLogWorld(seed), {
      stopWhen: (_world, tick) => tick === 100,
    })
    expect(result.ticks).toBe(100)
    expect(result.stoppedEarly).toBe(true)
  })

  it('replays identically every time', () => {
    const replay = decodeReplay(recordOf('ABCD', randomInputs('TW1CETW1CE23', 700)).encode())
    const first = playback(replay, (seed) => new InputLogWorld(seed)).world.log
    const second = playback(replay, (seed) => new InputLogWorld(seed)).world.log
    expect(first).toEqual(second)
  })

  it('unpacks what the recorder packed', () => {
    const inputs = randomInputs('PACKUNPACK23', 64)
    const replay = decodeReplay(recordOf('ABCD', inputs).encode())
    for (let i = 0; i < inputs.length; i++) {
      expect(unpackInput(replay.inputs[i] ?? 0)).toEqual(inputs[i])
    }
  })
})

// ---------------------------------------------------------------------------
// bots
// ---------------------------------------------------------------------------

/** Play a policy against a fresh World and return the recorder plus the digest. */
function runPolicy(name: BotName, seed: string, maxTicks: number): { recorder: ReplayRecorder; hash: string } {
  const world = new World(seed)
  const view: WorldView = world
  const policy = BOTS[name].create(seed)
  const recorder = new ReplayRecorder(seed)
  let ticks = 0
  while (view.runState === 'active' && ticks < maxTicks) {
    const input = policy(view)
    recorder.record(input)
    world.tick(input)
    ticks++
  }
  return { recorder, hash: hashWorld(view) }
}

describe('bot policies', () => {
  it.each(BOT_NAMES)('%s produces an identical run from the same seed', (name) => {
    // Without this, every number the playtest sweep prints is unreproducible,
    // and a balance finding that cannot be reproduced cannot be acted on.
    const first = runPolicy(name, 'B0TSEED23456', 1_800)
    const second = runPolicy(name, 'B0TSEED23456', 1_800)
    expect(second.hash).toBe(first.hash)
    expect(second.recorder.encode()).toBe(first.recorder.encode())
  })

  it.each(BOT_NAMES)('%s diverges on a different seed', (name) => {
    const a = runPolicy(name, 'B0TSEED23456', 1_800)
    const b = runPolicy(name, 'B0TSEED23457', 1_800)
    expect(b.hash).not.toBe(a.hash)
  })

  it.each(BOT_NAMES)('a recorded %s run replays to the same state', (name) => {
    // The live check that the static fixtures cannot make: recording and
    // replaying agree *right now*, on a run recorded in this process.
    const live = runPolicy(name, 'REC0RD234567', 2_400)
    const replay = decodeReplay(live.recorder.encode())
    const { world } = playback(replay, (seed) => new World(seed))
    expect(hashWorld(world)).toBe(live.hash)
  })

  it('each policy behaves differently from the others', () => {
    // Four probes that all played the same run would be one probe with three
    // extra rows in the report.
    const hashes = BOT_NAMES.map((name) => runPolicy(name, 'D1STINCT2345', 1_800).hash)
    expect(new Set(hashes).size).toBe(BOT_NAMES.length)
  })
})

// ---------------------------------------------------------------------------
// the regression corpus
// ---------------------------------------------------------------------------

interface Fixture {
  file: string
  fixtureVersion: number
  name: string
  policy: string
  seed: string
  ticks: number
  replay: string
  expected: {
    runState: string
    hash: string
    components: Record<string, string>
    counts: Record<string, number>
    stats: Record<string, number>
  }
}

const FIXTURE_DIR = fileURLToPath(new URL('./replays', import.meta.url))
const FIXTURE_FORMAT_VERSION = 1

function loadFixtures(): Fixture[] {
  if (!existsSync(FIXTURE_DIR)) return []
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((file) => {
      const parsed = JSON.parse(readFileSync(`${FIXTURE_DIR}/${file}`, 'utf8')) as Omit<Fixture, 'file'>
      return { ...parsed, file }
    })
}

const fixtures = loadFixtures()

/**
 * THE REGRESSION CORPUS (docs/VERIFICATION.md §1).
 *
 * Each fixture is a seed, a recorded input log, and the state hash the run ends
 * on. Replaying it must reproduce that hash bit-exactly. When this fails it is
 * usually a caught bug; when the change was an intended balance change, re-record
 * with `npm run playtest -- --record-fixture=NAME --policy=P --seed=S` and let the
 * diff in the commit show exactly what moved.
 *
 * Do not "fix" a failure by regenerating the fixture without reading the diff.
 * That converts the highest-value instrument in this project into a rubber stamp.
 */
describe('recorded run regression', () => {
  if (fixtures.length === 0) {
    // Deliberately a visible skip rather than a silent pass. An empty corpus
    // means this instrument is not running at all, which is the single most
    // load-bearing fact about the current state of verification.
    it.skip('CORPUS IS EMPTY — record one with: npm run playtest -- --record-fixture=NAME', () => {})
    return
  }

  it.each(fixtures)('$file reproduces its recorded final state', (fixture) => {
    expect(fixture.fixtureVersion).toBe(FIXTURE_FORMAT_VERSION)

    const replay = decodeReplay(fixture.replay)
    expect(replay.seed).toBe(fixture.seed)
    expect(replay.inputs.length).toBe(fixture.ticks)

    const { world } = playback(replay, (seed) => new World(seed))
    const view: WorldView = world
    const digest = digestWorld(view)

    // Component-level assertions first: "enemies and stats moved, hull didn't"
    // localises a regression in one line, where a single mismatched aggregate
    // hash localises nothing.
    for (const [component, expected] of Object.entries(fixture.expected.components)) {
      expect(digest[component as keyof typeof digest], `component ${component}`).toBe(expected)
    }
    expect(view.runState).toBe(fixture.expected.runState)
    expect(view.stats.kills).toBe(fixture.expected.stats['kills'])
    expect(view.stats.waveIndex).toBe(fixture.expected.stats['waveIndex'])
    expect(digest.hash).toBe(fixture.expected.hash)
  })

  it.each(fixtures)('$file is stamped with this simulation version', (fixture) => {
    // A fixture carrying an older sim version is asserting a hash that the current
    // rules did not produce. Re-recording has to re-stamp, or the corpus quietly
    // becomes a museum of what some previous build did.
    expect(decodeReplay(fixture.replay).simVersion).toBe(SIM_VERSION)
  })

  it.each(fixtures)('$file replays identically twice in a row', (fixture) => {
    const replay = decodeReplay(fixture.replay)
    const once = hashWorld(playback(replay, (seed) => new World(seed)).world)
    const twice = hashWorld(playback(replay, (seed) => new World(seed)).world)
    expect(once).toBe(twice)
  })
})
