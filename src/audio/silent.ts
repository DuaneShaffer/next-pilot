/**
 * The no-audio backend. A real supported mode, not a failure state.
 *
 * It is what runs in Node (no `AudioContext`), in a browser that has blocked
 * audio outright, and in every unit test that is not specifically about
 * synthesis. Reporting `unavailable` rather than throwing is deliberate: the
 * game is fully playable without sound, so a missing AudioContext must never be
 * able to take the run with it.
 *
 * It reports `available: false` and returns no voice handles, so the mixer's
 * bookkeeping stays empty and `activeVoices` is honestly zero — nothing is
 * pretending to sound.
 */

import type { AudioBackend, BackendState, VoiceHandle, VoiceRequest } from './backend'

export class SilentBackend implements AudioBackend {
  readonly available = false

  state(): BackendState {
    return 'unavailable'
  }

  now(): number {
    return 0
  }

  unlock(): void {
    // Nothing to unlock, and nothing to complain about. The app layer calls this
    // on every first gesture without knowing which backend it got.
  }

  setMasterGain(_gain: number): void {}

  start(_request: VoiceRequest): VoiceHandle | null {
    return null
  }

  close(): void {}
}
