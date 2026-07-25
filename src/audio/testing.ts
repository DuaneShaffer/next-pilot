/**
 * A backend that records instead of sounding.
 *
 * This exists because the interesting parts of the audio layer — the event
 * mapping, the gain structure, the voice limiter — are logic, and logic that can
 * only be checked by listening cannot be checked in CI at all. With this backend
 * every one of them is a plain assertion about a list of `VoiceRequest`s.
 *
 * It also has a hand-cranked clock, which the real one cannot have: voice
 * limiting is entirely a question of what overlaps in time, and a test that had
 * to wait 500ms of wall clock to find out would not be run.
 *
 * Not part of the shipped bundle — nothing the app imports reaches this file.
 */

import type { AudioBackend, BackendState, VoiceHandle, VoiceRequest } from './backend'

export interface RecordedVoice {
  readonly request: VoiceRequest
  readonly startedAt: number
  /** Backend time this voice was cut short, or null if it was left to finish. */
  stoppedAt: number | null
}

export interface RecordingBackendOptions {
  /** Initial state. Use 'suspended' to model the pre-gesture iOS case. */
  state?: BackendState
  available?: boolean
}

export class RecordingBackend implements AudioBackend {
  readonly available: boolean
  readonly started: RecordedVoice[] = []
  readonly masterGains: number[] = []
  unlockCalls = 0
  private stateValue: BackendState
  private clock = 0

  constructor(options?: RecordingBackendOptions) {
    this.stateValue = options?.state ?? 'running'
    this.available = options?.available ?? true
  }

  state(): BackendState {
    return this.stateValue
  }

  now(): number {
    return this.clock
  }

  /** Move the audio clock forward. Voices retire on their own schedule. */
  advance(seconds: number): void {
    this.clock += seconds
  }

  unlock(): void {
    this.unlockCalls++
    // Mirrors the real backend: an unlock from `suspended` succeeds, and an
    // unlock while already `running` is a no-op rather than a reset.
    if (this.stateValue === 'suspended') this.stateValue = 'running'
  }

  setMasterGain(gain: number): void {
    this.masterGains.push(gain)
  }

  get masterGain(): number {
    return this.masterGains[this.masterGains.length - 1] ?? 1
  }

  start(request: VoiceRequest): VoiceHandle | null {
    if (this.stateValue !== 'running') return null
    const record: RecordedVoice = { request, startedAt: this.clock, stoppedAt: null }
    this.started.push(record)
    return {
      stop: () => {
        if (record.stoppedAt === null) record.stoppedAt = this.clock
      },
    }
  }

  close(): void {
    this.stateValue = 'closed'
  }

  /** Voices started for one sound id. */
  startsOf(id: VoiceRequest['id']): RecordedVoice[] {
    return this.started.filter((voice) => voice.request.id === id)
  }

  /** Voices started in one category. */
  startsIn(category: VoiceRequest['category']): RecordedVoice[] {
    return this.started.filter((voice) => voice.request.category === category)
  }

  reset(): void {
    this.started.length = 0
    this.masterGains.length = 0
    this.clock = 0
    this.unlockCalls = 0
  }
}
