/**
 * Replay recording, encoding, and playback.
 *
 * A run is a seed plus one `InputSnapshot` per tick — that is the whole point of
 * the input indirection in `src/core/input.ts`. `packInput` already squeezes a
 * snapshot into a byte, so a run is a seed and a byte array, and a recorded run
 * is an executable specification of the simulation's behaviour.
 *
 * ## Why run-length encoding
 *
 * Real play is held inputs. A pilot holds fire for the entire sortie and holds a
 * direction for tens of ticks at a time, so the byte stream is long constant
 * runs. Twenty minutes is 72,000 ticks — 72KB raw, ~96KB once base64'd, which is
 * past what a URL will carry. RLE'd, the same run is a few hundred bytes,
 * because the run count tracks *input changes* (a few thousand at most in a
 * frantic run) rather than ticks. That is the difference between a shareable
 * link and a file upload, and there is no compression library to reach for
 * because this project has no runtime dependencies.
 *
 * ## Wire format (version 3)
 *
 * ```
 *   offset  bytes  field
 *   0       3      magic 'NPR'
 *   3       1      format version
 *   4       1      simulation version          (added at format 2)
 *   5       1      seed length in bytes (1..64)
 *   6       n      seed, printable ASCII
 *   ...     1      hull id length (0..32)      (added at format 3)
 *   ...     m      hull id, printable ASCII; empty means "no hull was chosen"
 *   ...     v      tick count, unsigned LEB128
 *   ...     2v..   runs: [packed input byte, LEB128 repeat count] ...
 *   end-4   4      FNV-1a checksum of everything before it, little-endian
 * ```
 *
 * THE TABLE IS THE SPEC and it has been wrong before: it still described format 1
 * after `simVersion` entered the header, which meant the only written account of
 * the bytes disagreed with the code that wrote them. Every field added here has to
 * be added above.
 *
 * Then base64url with no padding, so it drops into a query string untouched.
 *
 * The version byte is first-class and checked on every decode. Without it a
 * future format change would silently misread old replays into plausible-looking
 * nonsense — a bad replay must announce itself, not quietly produce a different
 * run and blame the sim.
 *
 * The checksum exists for the same reason. Replays travel through URLs, chat
 * clients, and spreadsheets, all of which mangle text. A truncated or mangled
 * replay has to be rejected loudly; a decoder that shrugs and plays back 40,000
 * of the original 72,000 ticks would produce a "reproduction failure" that costs
 * a day to trace.
 *
 * This module deliberately does not import `World`. Playback takes a factory, so
 * the encoding can be tested without a simulation and `src/meta/` stays free of
 * a dependency on sim internals.
 */

import { SIM_VERSION } from './simVersion'
import type { InputSnapshot } from '../core/input'
import { packInput, unpackInput } from '../core/input'

/**
 * Encoding version — how the bytes are laid out.
 *
 * Bumped to 2 when `simVersion` entered the header, and to 3 when `hullId` did.
 * Distinct from SIM_VERSION, which describes what those bytes *mean*: a format
 * mismatch fails to decode and is safe, while a sim mismatch decodes perfectly and
 * plays back the wrong run. See src/meta/simVersion.ts.
 *
 * Which is why `hullId` was a FORMAT bump and not a sim bump. The simulation's
 * rules did not change — `World` given the same content, hull and inputs does the
 * same thing it did yesterday. What changed is that the payload was *incomplete*:
 * it described a run without saying which ship flew it. A format bump makes every
 * format-2 replay fail loudly at the version check, which is the correct and
 * legible outcome, where leaving the format alone would have let those replays
 * decode and be flown in the wrong hull.
 */
export const REPLAY_FORMAT_VERSION = 3

const MAGIC = [0x4e, 0x50, 0x52] as const // 'NPR'
/**
 * Smallest byte count that could hold a header, written as a sum of the fields so
 * it cannot drift out of step with the wire format:
 * magic, format version, sim version, seed length, one seed byte, hull id length,
 * one tick-count varint byte, checksum.
 *
 * The hull length byte was added at format 3. Omitting it here would not have been
 * a hole — every later read is bounds-checked — but a constant that claims to be
 * the header size and is one byte short is a constant that will be trusted by the
 * next person who adds a field.
 */
const HEADER_MIN_BYTES = MAGIC.length + 1 + 1 + 1 + 1 + 1 + 1 + 4
const MAX_SEED_BYTES = 64
/**
 * ~16 hours at 60Hz. Not a design limit on run length — a sanity bound so a
 * corrupted length field allocates a bounded array instead of hanging the tab.
 */
const MAX_TICKS = 3_600_000

export type ReplayErrorReason =
  | 'empty'
  | 'not-base64url'
  | 'too-short'
  | 'bad-magic'
  | 'version-mismatch'
  | 'checksum-mismatch'
  | 'bad-seed'
  /**
   * The hull id field is malformed.
   *
   * Its own reason rather than `bad-seed`, which is what it first reported. These
   * codes exist so a test can pin behaviour and a caller can tell failures apart,
   * and "bad-seed: hull id length 33 out of range" is a message that contradicts
   * its own code — it sends the next person debugging a rejected link to look at
   * the seed, which is the one part of the payload that was fine.
   */
  | 'bad-hull'
  | 'bad-input-byte'
  | 'bad-run-count'
  | 'tick-count-mismatch'
  | 'truncated'
  | 'trailing-bytes'
  | 'tick-count-too-large'

/** Every rejection path throws this, so callers can catch replay problems only. */
export class ReplayError extends Error {
  constructor(
    readonly reason: ReplayErrorReason,
    message: string,
  ) {
    super(`replay ${reason}: ${message}`)
    this.name = 'ReplayError'
  }
}

export interface Replay {
  readonly version: number
  /**
   * Simulation version this run was recorded under.
   *
   * Carried so a shared replay can be refused rather than played back wrong on a
   * build whose rules have changed. See src/meta/simVersion.ts for why decoding
   * successfully is not the same as being playable.
   */
  readonly simVersion: number
  readonly seed: string
  /**
   * The hull the run was flown in.
   *
   * ADDED AT FORMAT 3, and the reason is worth keeping. A replay was seed plus
   * inputs, which was lossless *by accident*: every run flew a Lien because the hull
   * was never chosen. The moment hull selection shipped, a Collateral run — 30
   * shots/second and no shield — would have replayed as a Lien at 20 shots/second,
   * diverging within a few ticks, and the share card would have handed out the link
   * without complaint.
   *
   * A FORMAT bump rather than a sim-version bump, deliberately. See simVersion.ts:
   * a format mismatch fails to decode, which is safe and legible; a sim mismatch
   * decodes perfectly and plays back wrong, which is the dangerous case this field
   * exists to prevent. Old replays are now refused rather than silently mis-flown.
   */
  readonly hullId: string
  /** One packed input byte per tick. Length is the tick count. */
  readonly inputs: Uint8Array
}

/**
 * Ceiling on the encoded hull id, and what a missing one means.
 *
 * The empty string is legal and means "the run did not choose a hull", which is
 * exactly what every replay recorded before hull selection existed meant. It keeps
 * the field honest rather than defaulting to `'lien'` and asserting something the
 * recording never knew.
 */
const MAX_HULL_BYTES = 32

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/** Reverse table for the 7-bit ASCII range; -1 marks a character we reject. */
const B64_VALUES: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64_CHARS.length; i++) table[B64_CHARS.charCodeAt(i)] = i
  return table
})()

function toBase64Url(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out +=
      B64_CHARS.charAt((n >>> 18) & 63) +
      B64_CHARS.charAt((n >>> 12) & 63) +
      B64_CHARS.charAt((n >>> 6) & 63) +
      B64_CHARS.charAt(n & 63)
  }
  const remaining = bytes.length - i
  if (remaining === 1) {
    const n = (bytes[i] ?? 0) << 16
    out += B64_CHARS.charAt((n >>> 18) & 63) + B64_CHARS.charAt((n >>> 12) & 63)
  } else if (remaining === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8)
    out +=
      B64_CHARS.charAt((n >>> 18) & 63) +
      B64_CHARS.charAt((n >>> 12) & 63) +
      B64_CHARS.charAt((n >>> 6) & 63)
  }
  return out
}

function fromBase64Url(text: string): Uint8Array {
  // We never emit '=', but paste round-trips through tools that add it back.
  const trimmed = text.replace(/=+$/, '')
  if (trimmed.length === 0) throw new ReplayError('empty', 'nothing to decode')
  // A 4k+1 length is not reachable from any byte string, so it is corruption.
  if (trimmed.length % 4 === 1) {
    throw new ReplayError('not-base64url', `impossible length ${trimmed.length}`)
  }

  const out = new Uint8Array((trimmed.length * 3) >> 2)
  let acc = 0
  let bits = 0
  let written = 0
  for (let i = 0; i < trimmed.length; i++) {
    const code = trimmed.charCodeAt(i)
    const value = code < 128 ? (B64_VALUES[code] ?? -1) : -1
    if (value < 0) {
      throw new ReplayError('not-base64url', `character ${JSON.stringify(trimmed[i])} at ${i}`)
    }
    acc = ((acc << 6) | value) >>> 0
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[written++] = (acc >>> bits) & 0xff
    }
  }
  // A canonical encoder leaves the tail pad bits zero. Non-zero pad bits mean
  // the final character was altered, which nothing else here would notice.
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    throw new ReplayError('not-base64url', 'non-canonical trailing bits')
  }
  return out.subarray(0, written)
}

// ---------------------------------------------------------------------------
// varint + checksum
// ---------------------------------------------------------------------------

function writeVarint(out: number[], value: number): void {
  let v = value
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v = Math.floor(v / 128)
  }
  out.push(v & 0x7f)
}

interface VarintRead {
  value: number
  next: number
}

function readVarint(bytes: Uint8Array, offset: number, what: string): VarintRead {
  let value = 0
  let shift = 1
  let i = offset
  // Five groups covers any value we allow; more than that is corruption, and
  // bailing out keeps a malformed stream from walking off the end.
  for (let group = 0; group < 5; group++) {
    if (i >= bytes.length) throw new ReplayError('truncated', `${what} ran past the end`)
    const byte = bytes[i] ?? 0
    i++
    value += (byte & 0x7f) * shift
    if ((byte & 0x80) === 0) return { value, next: i }
    shift *= 128
  }
  throw new ReplayError('truncated', `${what} varint is too long`)
}

/** FNV-1a over a byte range. Not cryptographic — this catches mangling, not attacks. */
function checksum(bytes: Uint8Array, end: number): number {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < end; i++) {
    h = Math.imul(h ^ (bytes[i] ?? 0), 16777619)
  }
  return h >>> 0
}

/**
 * A packed input byte only ever uses bits 0-6, and each 2-bit axis field holds
 * 0..2 because the axis is -1/0/1. `0b11` in an axis field and any value in bit
 * 7 are unreachable, which makes them a free corruption check.
 */
function isValidInputByte(byte: number): boolean {
  if (byte < 0 || byte > 0x7f) return false
  if ((byte & 0b11) === 0b11) return false
  if (((byte >> 2) & 0b11) === 0b11) return false
  return true
}

// ---------------------------------------------------------------------------
// encode / decode
// ---------------------------------------------------------------------------

export function encodeReplay(replay: Replay): string {
  if (replay.version !== REPLAY_FORMAT_VERSION) {
    throw new ReplayError(
      'version-mismatch',
      `cannot encode version ${replay.version}; this build writes ${REPLAY_FORMAT_VERSION}`,
    )
  }
  const seedBytes: number[] = []
  for (let i = 0; i < replay.seed.length; i++) {
    const code = replay.seed.charCodeAt(i)
    if (code < 0x21 || code > 0x7e) {
      throw new ReplayError('bad-seed', `seed character ${code} at ${i} is not printable ASCII`)
    }
    seedBytes.push(code)
  }
  if (seedBytes.length === 0 || seedBytes.length > MAX_SEED_BYTES) {
    throw new ReplayError('bad-seed', `seed length ${seedBytes.length} out of range`)
  }
  if (replay.inputs.length > MAX_TICKS) {
    throw new ReplayError('tick-count-too-large', `${replay.inputs.length} ticks`)
  }

  const simVersion = replay.simVersion
  if (!Number.isInteger(simVersion) || simVersion < 0 || simVersion > 255) {
    throw new ReplayError('bad-seed', `simVersion ${simVersion} out of range`)
  }
  const hullBytes: number[] = []
  for (let i = 0; i < replay.hullId.length; i++) {
    const code = replay.hullId.charCodeAt(i)
    if (code < 0x21 || code > 0x7e) {
      throw new ReplayError('bad-hull', `hull id character ${code} at ${i} is not printable ASCII`)
    }
    hullBytes.push(code)
  }
  if (hullBytes.length > MAX_HULL_BYTES) {
    throw new ReplayError('bad-hull', `hull id length ${hullBytes.length} out of range`)
  }

  const bytes: number[] = [
    ...MAGIC,
    REPLAY_FORMAT_VERSION,
    simVersion,
    seedBytes.length,
    ...seedBytes,
    hullBytes.length,
    ...hullBytes,
  ]
  writeVarint(bytes, replay.inputs.length)

  // Run-length pass. One entry per *input change*, which is what makes a
  // twenty-minute run fit in a URL.
  let index = 0
  while (index < replay.inputs.length) {
    const byte = replay.inputs[index] ?? 0
    if (!isValidInputByte(byte)) {
      throw new ReplayError('bad-input-byte', `0x${byte.toString(16)} at tick ${index}`)
    }
    let count = 1
    while (index + count < replay.inputs.length && replay.inputs[index + count] === byte) count++
    bytes.push(byte)
    writeVarint(bytes, count)
    index += count
  }

  const body = Uint8Array.from(bytes)
  const sum = checksum(body, body.length)
  const full = new Uint8Array(body.length + 4)
  full.set(body, 0)
  full[body.length] = sum & 0xff
  full[body.length + 1] = (sum >>> 8) & 0xff
  full[body.length + 2] = (sum >>> 16) & 0xff
  full[body.length + 3] = (sum >>> 24) & 0xff
  return toBase64Url(full)
}

export function decodeReplay(text: string): Replay {
  if (text.length === 0) throw new ReplayError('empty', 'empty string')
  const bytes = fromBase64Url(text)
  if (bytes.length < HEADER_MIN_BYTES) {
    throw new ReplayError('too-short', `${bytes.length} bytes cannot hold a header`)
  }

  for (let i = 0; i < MAGIC.length; i++) {
    if (bytes[i] !== MAGIC[i]) {
      throw new ReplayError('bad-magic', 'this is not a Next Pilot replay')
    }
  }

  // Version is checked before the checksum so a genuine format upgrade reports
  // "version 2, expected 1" instead of the useless "checksum mismatch" it would
  // produce if a future version changed the checksum too.
  const version = bytes[MAGIC.length] ?? 0
  if (version !== REPLAY_FORMAT_VERSION) {
    throw new ReplayError(
      'version-mismatch',
      `replay is format version ${version}, this build reads ${REPLAY_FORMAT_VERSION}`,
    )
  }

  const bodyEnd = bytes.length - 4
  const expected =
    ((bytes[bodyEnd] ?? 0) |
      ((bytes[bodyEnd + 1] ?? 0) << 8) |
      ((bytes[bodyEnd + 2] ?? 0) << 16) |
      ((bytes[bodyEnd + 3] ?? 0) << 24)) >>>
    0
  const actual = checksum(bytes, bodyEnd)
  if (actual !== expected) {
    throw new ReplayError(
      'checksum-mismatch',
      `expected ${expected.toString(16)}, computed ${actual.toString(16)} — the replay was truncated or altered`,
    )
  }

  let offset = MAGIC.length + 1
  // The simulation version sits immediately after the format version. Read, not
  // validated here: decoding is about whether the bytes are well formed, and
  // whether the run is *playable* is a separate question the caller asks with
  // checkReplayCompatibility. Conflating them would make an incompatible replay
  // indistinguishable from a corrupt one.
  const simVersion = bytes[offset] ?? 0
  offset++
  const seedLength = bytes[offset] ?? 0
  offset++
  if (seedLength === 0 || seedLength > MAX_SEED_BYTES || offset + seedLength > bodyEnd) {
    throw new ReplayError('bad-seed', `seed length ${seedLength} out of range`)
  }
  let seed = ''
  for (let i = 0; i < seedLength; i++) {
    const code = bytes[offset + i] ?? 0
    if (code < 0x21 || code > 0x7e) {
      throw new ReplayError('bad-seed', `seed byte ${code} is not printable ASCII`)
    }
    seed += String.fromCharCode(code)
  }
  offset += seedLength

  const hullLength = bytes[offset] ?? 0
  offset++
  if (hullLength > MAX_HULL_BYTES || offset + hullLength > bodyEnd) {
    throw new ReplayError('bad-hull', `hull id length ${hullLength} out of range`)
  }
  let hullId = ''
  for (let i = 0; i < hullLength; i++) {
    const code = bytes[offset + i] ?? 0
    if (code < 0x21 || code > 0x7e) {
      throw new ReplayError('bad-hull', `hull id byte ${code} is not printable ASCII`)
    }
    hullId += String.fromCharCode(code)
  }
  offset += hullLength

  const tickRead = readVarint(bytes, offset, 'tick count')
  offset = tickRead.next
  const tickCount = tickRead.value
  if (tickCount > MAX_TICKS) {
    throw new ReplayError('tick-count-too-large', `${tickCount} ticks exceeds the ${MAX_TICKS} bound`)
  }

  const inputs = new Uint8Array(tickCount)
  let written = 0
  while (offset < bodyEnd) {
    const byte = bytes[offset] ?? 0
    offset++
    if (!isValidInputByte(byte)) {
      throw new ReplayError('bad-input-byte', `0x${byte.toString(16)} at tick ${written}`)
    }
    const countRead = readVarint(bytes, offset, 'run length')
    offset = countRead.next
    if (offset > bodyEnd) throw new ReplayError('truncated', 'run length ran into the checksum')
    const count = countRead.value
    if (count === 0) throw new ReplayError('bad-run-count', `zero-length run at tick ${written}`)
    if (written + count > tickCount) {
      throw new ReplayError(
        'tick-count-mismatch',
        `runs describe more than the declared ${tickCount} ticks`,
      )
    }
    inputs.fill(byte, written, written + count)
    written += count
  }
  if (offset !== bodyEnd) throw new ReplayError('trailing-bytes', 'unconsumed bytes before checksum')
  if (written !== tickCount) {
    throw new ReplayError(
      'tick-count-mismatch',
      `runs describe ${written} ticks, header declares ${tickCount}`,
    )
  }

  return { version, simVersion, seed, hullId, inputs }
}

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------

/**
 * Accumulates one packed byte per tick.
 *
 * Recording is unconditional in normal play: at one byte per tick even a long
 * session is well under a megabyte, and a run that turned out to be worth
 * keeping cannot be recorded retroactively.
 */
export class ReplayRecorder {
  private readonly bytes: number[] = []

  /**
   * `hullId` defaults to empty, which means "this run did not choose a hull".
   *
   * Optional so a sim test recording a run does not have to know hulls exist, and
   * empty rather than `'lien'` because a default that asserts a fact the recorder
   * never knew is how a replay ends up confidently wrong.
   */
  constructor(
    readonly seed: string,
    readonly hullId: string = '',
  ) {}

  record(input: InputSnapshot): void {
    this.bytes.push(packInput(input))
  }

  get tickCount(): number {
    return this.bytes.length
  }

  toReplay(): Replay {
    return {
      version: REPLAY_FORMAT_VERSION,
      // Stamped at recording time, from the build that produced the run. This is
      // what lets a future build refuse it instead of replaying it wrong.
      simVersion: SIM_VERSION,
      seed: this.seed,
      hullId: this.hullId,
      inputs: Uint8Array.from(this.bytes),
    }
  }

  encode(): string {
    return encodeReplay(this.toReplay())
  }
}

export function inputAt(replay: Replay, tick: number): InputSnapshot {
  const byte = replay.inputs[tick]
  if (byte === undefined) {
    throw new ReplayError('truncated', `tick ${tick} is past the end of a ${replay.inputs.length}-tick replay`)
  }
  return unpackInput(byte)
}

/** Every snapshot in order. Handy for tests; allocates, so not for hot paths. */
export function toSnapshots(replay: Replay): InputSnapshot[] {
  const out: InputSnapshot[] = []
  for (let i = 0; i < replay.inputs.length; i++) out.push(unpackInput(replay.inputs[i] ?? 0))
  return out
}

// ---------------------------------------------------------------------------
// playback
// ---------------------------------------------------------------------------

/**
 * The only thing playback needs from a simulation.
 *
 * Taking a factory rather than importing `World` keeps `src/meta/` decoupled from
 * sim internals and lets the encoding be tested against a two-line stub, which
 * matters when the sim is mid-rewrite.
 */
export interface TickableWorld {
  tick(input: InputSnapshot): void
  /**
   * The hull this world was built with, if it knows.
   *
   * Optional so a fabricated test world need not have one, and READ rather than set:
   * `playback` cannot construct a world (it knows nothing about content tables), so
   * the only thing it can do about the hull is check that the caller honoured it.
   */
  readonly hullName?: string
  /**
   * The hull's id, preferred over `hullName` when present.
   *
   * The guard below used to have only the display name to work with, so it compared an
   * id against a name and passed by coincidence — every shipped hull is named its id
   * capitalised. Comparing id to id is exact; the name fold stays as a fallback for a
   * world that only knows its name.
   */
  readonly hullId?: string
}

export interface PlaybackOptions<T extends TickableWorld> {
  /** Called after every tick. Use for per-tick hashing when hunting a divergence. */
  onTick?: (world: T, tick: number) => void
  /** Return true to stop early, e.g. once `runState` leaves 'active'. */
  stopWhen?: (world: T, tick: number) => boolean
}

export interface PlaybackResult<T extends TickableWorld> {
  world: T
  /** Ticks actually executed. Less than the replay length only if stopped early. */
  ticks: number
  stoppedEarly: boolean
}

/**
 * Fold an id or a display name onto one comparable key.
 *
 * `Collateral`, `collateral` and `probe-hull` vs `Probe Hull` are the same hull;
 * `lien` and `collateral` are not. Only used for the playback check — nothing is
 * stored in this form.
 */
function hullKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function playback<T extends TickableWorld>(
  replay: Replay,
  createWorld: (seed: string, hullId: string) => T,
  options: PlaybackOptions<T> = {},
): PlaybackResult<T> {
  const world = createWorld(replay.seed, replay.hullId)

  /**
   * VERIFY that the caller actually used the hull, rather than trusting them to.
   *
   * Decoding `hullId` accomplishes nothing on its own: the world is built by a
   * factory this module cannot see inside, so a caller that ignores the argument
   * flies the wrong ship and diverges exactly as badly as before the field existed —
   * silently, forty seconds in, looking like a determinism bug.
   *
   * Skipped when either side is unknown, because an empty `hullId` legitimately means
   * "this run chose no hull" and a fabricated test world need not model hulls at all.
   *
   * ## IT IS COMPARING AN ID TO A DISPLAY NAME, AND THAT NEEDS SAYING OUT LOUD
   *
   * `replay.hullId` is an id (`collateral`). `TickableWorld.hullName` is what the
   * world calls itself (`Collateral`) — `World` exposes no id at all. Every shipped
   * hull happens to have a display name that is its id capitalised, so a direct
   * comparison passed on all five *by coincidence*, and the first hull whose name was
   * a different word threw `bad-hull` on a completely correct playback.
   *
   * A guard that refuses valid replays is worse than the hole it plugs: the recipient
   * of a good link is told their run cannot be played. So the comparison normalises
   * both sides — lowercase, and separators removed — which makes `probe-hull` and
   * `Probe Hull` the same hull while still separating `lien` from `collateral`.
   *
   * THE RESIDUAL LIMITATION, and the real fix: a hull whose display name is not its
   * id in disguise (`writ` shown as "The Writ") would still be refused. The correct
   * answer is a `hullId` on `WorldView` so this compares id to id, which is a change
   * to `src/sim/entities.ts` rather than to this file. Until then the convention is
   * load-bearing, so it is asserted in `tests/replay.test.ts` against the real roster
   * rather than left as a hope.
   */
  const named = replay.hullId
  // Id to id when the world knows its id — exact. Falling back to the display name
  // means folding both through `hullKey`, which is a convention rather than a fact.
  const flown = world.hullId ?? world.hullName
  if (named !== '' && flown !== undefined) {
    if (hullKey(flown) !== hullKey(named)) {
      throw new ReplayError(
        'bad-hull',
        `replay names hull "${named}" but playback built "${flown}" — the factory ignored replay.hullId`,
      )
    }
  }
  const { onTick, stopWhen } = options
  let ticks = 0
  for (let i = 0; i < replay.inputs.length; i++) {
    world.tick(unpackInput(replay.inputs[i] ?? 0))
    ticks++
    if (onTick) onTick(world, ticks)
    if (stopWhen && stopWhen(world, ticks)) {
      return { world, ticks, stoppedEarly: ticks < replay.inputs.length }
    }
  }
  return { world, ticks, stoppedEarly: false }
}
