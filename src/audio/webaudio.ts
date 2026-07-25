/**
 * The WebAudio backend: turns `Layer` recipes into nodes.
 *
 * This is the only file in the project that touches `AudioContext`, and nothing
 * in `src/sim/**` may reach it (CLAUDE.md contract 2 — the sim runs headless).
 *
 * THE iOS TRAP, recorded in docs/DESIGN.md and handled here rather than
 * rediscovered: an `AudioContext` constructed at page load starts `suspended`,
 * and on iPhone it stays effectively muted even after `resume()` unless a real
 * user gesture has occurred. So this backend constructs *nothing* until
 * `unlock()` is called, which the app layer must call from inside a genuine
 * input handler. Before that it reports `suspended` and refuses to start voices,
 * which is both honest and free.
 *
 * The second half of the trap is that `resume()` alone is not always enough on
 * iOS: the context also needs a source node to have actually run inside the
 * gesture. `kick()` plays one silent sample to satisfy that.
 */

import { Rng } from '../core/rng'
import type { AudioBackend, BackendState, Layer, VoiceHandle, VoiceRequest } from './backend'

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext

/** Safari shipped `webkitAudioContext` for years and some versions still only have it. */
function findAudioContextCtor(): AudioContextCtor | null {
  const host = globalThis as {
    AudioContext?: AudioContextCtor
    webkitAudioContext?: AudioContextCtor
  }
  return host.AudioContext ?? host.webkitAudioContext ?? null
}

/** True when this environment could ever play WebAudio. False in Node. */
export function webAudioAvailable(): boolean {
  return findAudioContextCtor() !== null
}

/**
 * Voices are scheduled a few milliseconds ahead rather than at `currentTime`.
 *
 * Starting a node at exactly `currentTime` races the audio thread: part of the
 * attack can land in a buffer that has already been rendered, which is heard as
 * a click. 5ms is inaudible as latency and reliably avoids it.
 */
const START_LOOKAHEAD = 0.005

/** Seconds of white noise generated once and reused by every noise layer. */
const NOISE_SECONDS = 2

/** Floor for exponential ramps — they cannot legally reach zero. */
const SILENCE = 0.0001

/** Fade applied when a voice is stolen, so stealing is inaudible. */
const STEAL_FADE = 0.008

interface VoiceNodes {
  readonly gain: GainNode
  readonly sources: readonly AudioScheduledSourceNode[]
}

class WebAudioVoice implements VoiceHandle {
  private stopped = false

  constructor(
    private readonly ctx: AudioContext,
    private readonly nodes: VoiceNodes,
  ) {}

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    const now = this.ctx.currentTime
    try {
      const gain = this.nodes.gain.gain
      gain.cancelScheduledValues(now)
      // Ramp rather than cut: a hard stop on a sounding voice is a click, which
      // is louder and more noticeable than the voice being stolen was.
      gain.setValueAtTime(Math.max(SILENCE, gain.value), now)
      gain.exponentialRampToValueAtTime(SILENCE, now + STEAL_FADE)
    } catch {
      // An AudioParam that has already been disconnected is not worth a crash.
    }
    for (const source of this.nodes.sources) {
      try {
        source.stop(now + STEAL_FADE)
      } catch {
        // Throws if the source was never started. Nothing to stop, then.
      }
    }
  }
}

export class WebAudioBackend implements AudioBackend {
  private readonly ctor: AudioContextCtor | null
  private ctx: AudioContext | null = null
  private bus: GainNode | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private masterGainValue = 1
  private closed = false
  /**
   * Noise start offsets come from a seeded stream, not `Math.random()` — which is
   * banned repo-wide and checked by `npm run contracts`. Audio has no business
   * being deterministic, but it has no business being the reason the checker gets
   * an exemption either.
   */
  private readonly rng = Rng.fromSeed('audio', 'noise-offset')

  constructor() {
    this.ctor = findAudioContextCtor()
  }

  get available(): boolean {
    return this.ctor !== null
  }

  state(): BackendState {
    if (this.closed) return 'closed'
    if (this.ctor === null) return 'unavailable'
    if (this.ctx === null) return 'suspended'
    // Older Safari can report states outside the current enum; anything we do not
    // recognise is treated as not-yet-playable rather than assumed good.
    const state = this.ctx.state
    if (state === 'running' || state === 'suspended' || state === 'closed') return state
    return 'suspended'
  }

  now(): number {
    return this.ctx?.currentTime ?? 0
  }

  /**
   * Create the context if needed and move it to `running`. Idempotent, safe when
   * already running, and safe when there is no WebAudio at all — the app layer
   * calls this from every plausible first gesture and must not have to check.
   */
  unlock(): void {
    if (this.closed || this.ctor === null) return
    if (this.ctx === null) {
      try {
        this.ctx = new this.ctor({ latencyHint: 'interactive' })
        this.buildGraph(this.ctx)
      } catch {
        // Construction can fail under strict autoplay policies or when the device
        // has no output. Fall back to permanently silent rather than breaking the
        // input handler that called us.
        this.ctx = null
        this.closed = true
        return
      }
    }
    if (this.ctx.state !== 'running') {
      // `resume()` rejects if the gesture requirement is not satisfied. Swallow
      // it: the next gesture will call unlock() again.
      void this.ctx.resume().catch(() => {})
    }
    this.kick(this.ctx)
  }

  setMasterGain(gain: number): void {
    this.masterGainValue = gain
    const master = this.master
    if (master === null || this.ctx === null) return
    const now = this.ctx.currentTime
    // Short ramp instead of an assignment: stepping a gain node mid-voice is a
    // click, and mute is exactly the case where that would happen.
    master.gain.cancelScheduledValues(now)
    master.gain.setTargetAtTime(gain, now, 0.01)
  }

  start(request: VoiceRequest): VoiceHandle | null {
    const ctx = this.ctx
    const bus = this.bus
    if (ctx === null || bus === null || ctx.state !== 'running') return null

    const t0 = ctx.currentTime + START_LOOKAHEAD
    const voiceGain = ctx.createGain()
    voiceGain.gain.value = request.gain

    let output: AudioNode = voiceGain
    if (request.pan !== 0 && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner()
      panner.pan.value = request.pan
      voiceGain.connect(panner)
      output = panner
    }
    output.connect(bus)

    const sources: AudioScheduledSourceNode[] = []
    let longest: AudioScheduledSourceNode | null = null
    let longestEnd = -1
    for (const layer of request.layers) {
      const built = this.buildLayer(ctx, layer, request, t0, voiceGain)
      if (built === null) continue
      sources.push(built.source)
      if (built.end > longestEnd) {
        longestEnd = built.end
        longest = built.source
      }
    }

    if (sources.length === 0) {
      voiceGain.disconnect()
      return null
    }

    // Tear the voice's subgraph down when the *last-ending* layer stops, so a
    // 20-shots-per-second weapon does not accumulate dead nodes for a whole run.
    //
    // Which source that is matters: a recipe with a delayed layer (the secondary
    // detonation in `impact.killElite`) does not end in recipe order, and hanging
    // this off the wrong one would disconnect the voice while it is still
    // sounding — silence, not a leak, and far harder to spot.
    if (longest !== null) {
      longest.onended = () => {
        try {
          voiceGain.disconnect()
          output.disconnect()
        } catch {
          // Already disconnected by a steal. Harmless.
        }
      }
    }

    return new WebAudioVoice(ctx, { gain: voiceGain, sources })
  }

  close(): void {
    this.closed = true
    const ctx = this.ctx
    this.ctx = null
    this.bus = null
    this.master = null
    this.noise = null
    if (ctx !== null) void ctx.close().catch(() => {})
  }

  /**
   * bus → compressor → master → destination.
   *
   * The compressor is a safety limiter, not a mix decision: sixteen voices with
   * independent envelopes can sum past full scale on a bad tick, and digital
   * clipping is a far worse artefact than 2dB of gain reduction. It also happens
   * to be exactly the right texture for this game (docs/DESIGN.md: compressors
   * and load-bearing machinery).
   */
  private buildGraph(ctx: AudioContext): void {
    const master = ctx.createGain()
    master.gain.value = this.masterGainValue
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

    this.master = master
    this.bus = bus
    this.noise = makeNoiseBuffer(ctx)
  }

  /**
   * Run one silent sample inside the unlocking gesture.
   *
   * iOS needs a source node to have actually played before it treats the context
   * as user-activated; `resume()` on its own leaves some versions silently muted.
   * Cheap, idempotent enough to run on every unlock attempt, and inaudible.
   */
  private kick(ctx: AudioContext): void {
    try {
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate)
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.start(0)
    } catch {
      // Not fatal — a context that refuses a one-sample buffer will fail loudly
      // enough elsewhere, and the game does not depend on sound.
    }
  }

  /**
   * Build one layer's source → filter → envelope chain.
   *
   * Returns the source and the absolute time it stops, so the caller can hang
   * cleanup off whichever layer actually finishes last.
   */
  private buildLayer(
    ctx: AudioContext,
    layer: Layer,
    request: VoiceRequest,
    t0: number,
    destination: AudioNode,
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
      const buffer = this.noise
      if (buffer === null) return null
      const noise = ctx.createBufferSource()
      noise.buffer = buffer
      noise.loop = true
      noise.connect(tail)
      // A different offset each time, so repeated bursts are not the same sample
      // played twice — the artefact that makes synthesised noise sound canned.
      noise.start(start, this.rng.range(0, NOISE_SECONDS - 0.5))
      noise.stop(end + 0.01)
      source = noise
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
}

/**
 * White noise, generated once per context.
 *
 * Every impact, vent and relay contact in the game is built on this buffer, so
 * it is worth the one-off ~350KB of float data — and it is why there is no `.wav`
 * anywhere in the repo.
 */
function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * NOISE_SECONDS)
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate)
  const data = buffer.getChannelData(0)
  const rng = Rng.fromSeed('audio', 'noise-buffer')
  for (let i = 0; i < length; i++) data[i] = rng.range(-1, 1)
  return buffer
}
