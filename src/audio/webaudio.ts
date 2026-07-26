/**
 * The live WebAudio backend: an `AudioContext`, a master chain, and a voice per
 * `start()`.
 *
 * The synthesis itself lives in `src/audio/synth.ts`, shared with the offline
 * renderer the verification harness uses — so what `tools/audio.ts` measures is
 * literally what this backend plays, not a reimplementation of it.
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
import type { AudioBackend, BackendState, VoiceHandle, VoiceRequest } from './backend'
import { buildMasterChain, buildVoice, makeNoiseBuffer, SILENCE } from './synth'

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
        const chain = buildMasterChain(this.ctx, this.masterGainValue)
        this.master = chain.master
        this.bus = chain.bus
        this.noise = makeNoiseBuffer(this.ctx, Rng.fromSeed('audio', 'noise-buffer'))
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

    const built = buildVoice(
      ctx,
      request,
      ctx.currentTime + START_LOOKAHEAD,
      bus,
      this.noise,
      this.rng,
    )
    if (built === null) return null

    // Tear the voice's subgraph down when the last-ending layer stops, so a
    // 20-shots-per-second weapon does not accumulate dead nodes for a whole run.
    if (built.last !== null) {
      built.last.onended = () => {
        try {
          built.gain.disconnect()
          built.output.disconnect()
        } catch {
          // Already disconnected by a steal. Harmless.
        }
      }
    }

    return new WebAudioVoice(ctx, { gain: built.gain, sources: built.sources })
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
}
