/**
 * Layer recipes → WebAudio nodes. The synthesis itself, with no opinion about
 * *when* it runs.
 *
 * This was extracted out of `webaudio.ts` for one reason: the audio verification
 * harness (`tools/audio.ts`) renders the game's cues through an
 * `OfflineAudioContext` and measures the result. If that harness built its own
 * graph, it would measure a *model* of the synthesis rather than the synthesis,
 * and the measurement would be worthless the first time the two drifted. So the
 * live backend and the offline renderer call the same three functions here, and
 * anything the measurement proves is a fact about what players hear.
 *
 * The one thing this file will not do is decide a start time. The live backend
 * schedules a few milliseconds ahead of `currentTime`; the offline renderer
 * schedules against a virtual clock. Every function here takes an absolute time.
 */

import type { Rng } from '../core/rng'
import type { Layer, VoiceRequest } from './backend'

/** Seconds of white noise generated once per context and reused by every noise layer. */
export const NOISE_SECONDS = 2

/** Floor for exponential ramps — they cannot legally reach zero. */
export const SILENCE = 0.0001

/**
 * White noise, generated once per context.
 *
 * Every impact, vent and relay contact in the game is built on this buffer, so
 * it is worth the one-off ~350KB of float data — and it is why there is no `.wav`
 * anywhere in the repo.
 */
export function makeNoiseBuffer(ctx: BaseAudioContext, rng: Rng): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * NOISE_SECONDS)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  for (let i = 0; i < length; i++) data[i] = rng.range(-1, 1)
  return buffer
}

export interface MasterChain {
  /** Where voices connect. */
  readonly bus: GainNode
  /** Post-limiter output level. */
  readonly master: GainNode
  readonly limiter: DynamicsCompressorNode
}

/**
 * bus → compressor → master → destination.
 *
 * The compressor is a safety limiter, not a mix decision: sixteen voices with
 * independent envelopes can sum past full scale on a bad tick, and digital
 * clipping is a far worse artefact than 2dB of gain reduction. It also happens
 * to be exactly the right texture for this game (docs/DESIGN.md: compressors and
 * load-bearing machinery).
 */
export function buildMasterChain(ctx: BaseAudioContext, masterGain: number): MasterChain {
  const master = ctx.createGain()
  master.gain.value = masterGain
  master.connect(ctx.destination)

  const limiter = ctx.createDynamicsCompressor()
  limiter.threshold.value = -12
  limiter.knee.value = 6
  limiter.ratio.value = 6
  limiter.attack.value = 0.003
  limiter.release.value = 0.12
  limiter.connect(master)

  const bus = ctx.createGain()
  bus.gain.value = 1
  bus.connect(limiter)

  return { bus, master, limiter }
}

export interface BuiltVoice {
  readonly gain: GainNode
  /** The node actually connected to the bus — the gain, or a panner after it. */
  readonly output: AudioNode
  readonly sources: readonly AudioScheduledSourceNode[]
  /**
   * The source that finishes last.
   *
   * Which one that is matters: a recipe with a delayed layer (the secondary
   * detonation in `impact.killElite`) does not end in recipe order, so hanging
   * teardown off the wrong source disconnects the voice while it is still
   * sounding — silence, not a leak, and far harder to spot.
   */
  readonly last: AudioScheduledSourceNode | null
  /** Absolute time the voice is finished. */
  readonly end: number
}

/**
 * Build one voice's whole subgraph, scheduled to begin at `startAt`.
 *
 * Returns null when the recipe produced nothing playable, which the caller must
 * treat as "no voice started" rather than as an error.
 */
export function buildVoice(
  ctx: BaseAudioContext,
  request: VoiceRequest,
  startAt: number,
  destination: AudioNode,
  noise: AudioBuffer | null,
  rng: Rng,
): BuiltVoice | null {
  const voiceGain = ctx.createGain()
  voiceGain.gain.value = request.gain

  let output: AudioNode = voiceGain
  if (request.pan !== 0 && typeof ctx.createStereoPanner === 'function') {
    const panner = ctx.createStereoPanner()
    panner.pan.value = request.pan
    voiceGain.connect(panner)
    output = panner
  }
  output.connect(destination)

  const sources: AudioScheduledSourceNode[] = []
  let last: AudioScheduledSourceNode | null = null
  let end = startAt
  for (const layer of request.layers) {
    const built = buildLayer(ctx, layer, request, startAt, voiceGain, noise, rng)
    if (built === null) continue
    sources.push(built.source)
    if (built.end > end) {
      end = built.end
      last = built.source
    }
  }

  if (sources.length === 0) {
    voiceGain.disconnect()
    return null
  }

  return { gain: voiceGain, output, sources, last, end }
}

/** One layer's source → filter → envelope chain, and the time it stops. */
function buildLayer(
  ctx: BaseAudioContext,
  layer: Layer,
  request: VoiceRequest,
  t0: number,
  destination: AudioNode,
  noise: AudioBuffer | null,
  rng: Rng,
): { source: AudioScheduledSourceNode; end: number } | null {
  const scale = request.timeScale
  const attack = Math.max(0.0005, layer.attack * scale)
  const hold = Math.max(0, layer.hold * scale)
  const release = Math.max(0.005, layer.release * scale)
  const start = t0 + layer.delay * scale
  const end = start + attack + hold + release

  const envelope = ctx.createGain()
  const peak = Math.max(SILENCE, layer.gain)
  envelope.gain.setValueAtTime(SILENCE, start)
  envelope.gain.linearRampToValueAtTime(peak, start + attack)
  envelope.gain.setValueAtTime(peak, start + attack + hold)
  envelope.gain.exponentialRampToValueAtTime(SILENCE, end)

  let tail: AudioNode = envelope
  envelope.connect(destination)

  if (layer.filter !== 'none') {
    const filter = ctx.createBiquadFilter()
    filter.type = layer.filter
    filter.Q.value = layer.filterQ
    const from = Math.max(20, layer.filterFreq * request.pitch)
    const to = Math.max(20, layer.filterFreqEnd * request.pitch)
    filter.frequency.setValueAtTime(from, start)
    if (to !== from) filter.frequency.exponentialRampToValueAtTime(to, end)
    filter.connect(envelope)
    tail = filter
  }

  let source: AudioScheduledSourceNode
  if (layer.source === 'noise') {
    if (noise === null) return null
    const player = ctx.createBufferSource()
    player.buffer = noise
    player.loop = true
    player.connect(tail)
    // A different offset each time, so repeated bursts are not the same sample
    // played twice — the artefact that makes synthesised noise sound canned.
    player.start(start, rng.range(0, NOISE_SECONDS - 0.5))
    player.stop(end + 0.01)
    source = player
  } else {
    const osc = ctx.createOscillator()
    osc.type = layer.source
    const from = Math.max(1, layer.freq * request.pitch)
    const to = Math.max(1, layer.freqEnd * request.pitch)
    osc.frequency.setValueAtTime(from, start)
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(to, end)
    osc.connect(tail)
    osc.start(start)
    osc.stop(end + 0.01)
    source = osc
  }
  return { source, end: end + 0.01 }
}
