/**
 * The seam between "what a sound is" and "how it gets made".
 *
 * Every sound in this game is a short list of `Layer`s — declarative data, not
 * code that touches WebAudio. That split exists for two reasons:
 *
 *  1. `AudioContext` does not exist in Node, so anything that constructs one
 *     directly cannot be imported by a test. The recipes, the event mapping and
 *     the voice limiter are the parts with logic worth testing, and none of them
 *     need a browser to be exercised against this interface.
 *  2. There are no binary assets in this repo (CLAUDE.md). A recipe *is* the
 *     asset, and keeping it as plain data means it can be inspected, diffed and
 *     asserted on rather than listened to and guessed at.
 *
 * A backend receives fully-mixed `VoiceRequest`s: gain, pitch, pan and time
 * scaling are already resolved by the mixer. Backends do no policy — no voice
 * limiting, no category gains, no muting decisions. That way the silent backend
 * and the real one cannot disagree about what would have been audible.
 */

import type { SoundCategory, SoundId } from './sounds'

export type LayerSource = 'sine' | 'triangle' | 'square' | 'sawtooth' | 'noise'

export type FilterKind = 'none' | 'lowpass' | 'highpass' | 'bandpass'

/**
 * One synthesised element of a sound.
 *
 * Deliberately flat and fully specified: a sweep is `freq` → `freqEnd`, an
 * envelope is attack/hold/release, and a filter is one biquad. That is enough
 * for relays, vents, and structural failure, and refusing anything richer keeps
 * the whole audio layer inside a few KB of the bundle.
 *
 * Every field is required so a recipe can never accidentally inherit a default
 * that changes underneath it — use `layer()` to write them concisely.
 */
export interface Layer {
  readonly source: LayerSource
  /** Start frequency in Hz. Ignored for `noise`. */
  readonly freq: number
  /** End frequency in Hz, reached at the end of the release. Equal to `freq` means no sweep. */
  readonly freqEnd: number
  /** Peak amplitude of this layer, relative to the voice. */
  readonly gain: number
  /** Seconds after the voice starts before this layer begins. */
  readonly delay: number
  readonly attack: number
  /** Seconds held at peak after the attack. */
  readonly hold: number
  readonly release: number
  readonly filter: FilterKind
  readonly filterFreq: number
  /** Filter cutoff at the end of the layer. Equal to `filterFreq` means static. */
  readonly filterFreqEnd: number
  readonly filterQ: number
}

const LAYER_DEFAULTS: Layer = {
  source: 'sine',
  freq: 440,
  freqEnd: 440,
  gain: 1,
  delay: 0,
  attack: 0.002,
  hold: 0.01,
  release: 0.05,
  filter: 'none',
  filterFreq: 1000,
  filterFreqEnd: 1000,
  filterQ: 1,
}

/**
 * Build a layer, defaulting anything unstated.
 *
 * `freqEnd` and `filterFreqEnd` default to their start values rather than to a
 * constant, so "no sweep" is what you get by omitting them.
 */
export function layer(overrides: Partial<Layer>): Layer {
  const freq = overrides.freq ?? LAYER_DEFAULTS.freq
  const filterFreq = overrides.filterFreq ?? LAYER_DEFAULTS.filterFreq
  return {
    source: overrides.source ?? LAYER_DEFAULTS.source,
    freq,
    freqEnd: overrides.freqEnd ?? freq,
    gain: overrides.gain ?? LAYER_DEFAULTS.gain,
    delay: overrides.delay ?? LAYER_DEFAULTS.delay,
    attack: overrides.attack ?? LAYER_DEFAULTS.attack,
    hold: overrides.hold ?? LAYER_DEFAULTS.hold,
    release: overrides.release ?? LAYER_DEFAULTS.release,
    filter: overrides.filter ?? LAYER_DEFAULTS.filter,
    filterFreq,
    filterFreqEnd: overrides.filterFreqEnd ?? filterFreq,
    filterQ: overrides.filterQ ?? LAYER_DEFAULTS.filterQ,
  }
}

/** Wall-clock length of a layer, including its delay. */
export function layerDuration(l: Layer): number {
  return l.delay + l.attack + l.hold + l.release
}

/** Wall-clock length of the longest layer — how long the voice occupies a slot. */
export function layersDuration(layers: readonly Layer[]): number {
  let longest = 0
  for (const l of layers) longest = Math.max(longest, layerDuration(l))
  return longest
}

/** A single sound instance, fully mixed and ready to be made audible. */
export interface VoiceRequest {
  readonly id: SoundId
  readonly category: SoundCategory
  readonly layers: readonly Layer[]
  /** Final voice amplitude: category × recipe × event scaling × variation, clamped. */
  readonly gain: number
  /** Multiplier applied to every layer frequency. */
  readonly pitch: number
  /** Multiplier applied to every layer time. Lets one recipe stretch to fit a windup. */
  readonly timeScale: number
  /** -1 (left) .. 1 (right). Derived from playfield x so threats are locatable. */
  readonly pan: number
  /** `timeScale`-adjusted length, so the mixer knows when the slot frees up. */
  readonly duration: number
}

/**
 * `unavailable` means this backend can never produce sound (no AudioContext at
 * all). `suspended` means it exists but is waiting for a user gesture — the iOS
 * state, and the reason `unlock()` is part of the interface.
 */
export type BackendState = 'unavailable' | 'suspended' | 'running' | 'closed'

export interface VoiceHandle {
  /** Cut this voice short. Must be safe to call more than once. */
  stop(): void
}

export interface AudioBackend {
  /** False when no sound can ever be produced, whatever the caller does. */
  readonly available: boolean
  state(): BackendState
  /** Monotonic seconds on the audio clock. The mixer's only source of time. */
  now(): number
  /**
   * Move towards `running`, creating whatever the platform needs. Must be
   * idempotent, must be safe when already running, and must not throw when
   * there is nothing to unlock.
   */
  unlock(): void
  /** Post-mix output level, 0..1. Applied to voices already sounding. */
  setMasterGain(gain: number): void
  /** Start a voice, or return null if it cannot be started right now. */
  start(request: VoiceRequest): VoiceHandle | null
  close(): void
}
