/**
 * Voice allocation, the gain structure, and mute. All of the audio layer's
 * policy lives here; the backends only obey.
 *
 * WHY A LIMITER IS MANDATORY, not a nicety: this game emits events in bursts by
 * design. One tick can contain a dozen kills, a dozen hits and a hull hit, and
 * `?ff=` replays several ticks inside one frame. An audio layer that starts a
 * voice per event allocates unboundedly under exactly the conditions where the
 * player most needs to hear one specific thing. So every start passes three
 * gates in order:
 *
 *  1. a per-sound retrigger gap  — collapses duplicates within one tick
 *  2. a per-sound and per-category concurrency cap — stops one thing dominating
 *  3. a global cap with priority-based stealing — the hard bound
 *
 * When the global cap is reached, the *least important* sounding voice is
 * sacrificed, and only if the incoming sound outranks it. The player's own
 * weapon is the lowest priority in the game, so a screen-clearing explosion
 * makes the gun disappear rather than making the explosion disappear.
 */

import {
  layersDuration,
  type AudioBackend,
  type VoiceHandle,
  type VoiceRequest,
} from './backend'
import {
  CATEGORY_VOICE_CAPS,
  DEFAULT_CATEGORY_VOLUMES,
  DEFAULT_MASTER_VOLUME,
  MAX_VOICES,
  SOUNDS,
  VOICE_PEAK_CEILING,
  type SoundCategory,
  type SoundDef,
  type SoundId,
} from './sounds'

/** Per-play overrides from a `SoundCue`. All optional, all clamped. */
export interface PlayOptions {
  gain?: number
  pitch?: number
  pan?: number
  timeScale?: number
}

interface ActiveVoice {
  readonly id: SoundId
  readonly category: SoundCategory
  readonly priority: number
  /** Backend-clock time this voice stops occupying a slot. */
  readonly endsAt: number
  readonly handle: VoiceHandle
}

/**
 * Slack added to a voice's lifetime before its slot is reused.
 *
 * Envelope releases are exponential and never mathematically reach zero, so a
 * slot freed at exactly `attack+hold+release` can be stolen while the previous
 * voice is still faintly audible — which is heard as a click, not as a saving.
 */
const VOICE_TAIL_MARGIN = 0.02

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/**
 * Coerce anything a caller might pass into a usable volume.
 *
 * Volumes arrive from settings, save files and (eventually) a slider. `NaN`
 * assigned to a WebAudio `AudioParam` throws, and a value above 1 silently
 * clips the output stage, so both are corrected here rather than trusted.
 */
function sanitizeVolume(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return clamp(value, 0, 1)
}

function sanitizeScale(value: number | undefined, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return 1
  return clamp(value, min, max)
}

export class Mixer {
  private readonly backend: AudioBackend
  private readonly voices: ActiveVoice[] = []
  /** Round-robin position per sound, so variation cycles rather than repeats. */
  private readonly rotation = new Map<SoundId, number>()
  private readonly lastStart = new Map<SoundId, number>()
  private readonly categoryVolumes: Record<SoundCategory, number>
  private masterVolumeValue = DEFAULT_MASTER_VOLUME
  private mutedValue = false

  constructor(backend: AudioBackend) {
    this.backend = backend
    this.categoryVolumes = { ...DEFAULT_CATEGORY_VOLUMES }
    this.backend.setMasterGain(this.masterVolumeValue)
  }

  get muted(): boolean {
    return this.mutedValue
  }

  /**
   * Mute belt *and* braces: the master gain goes to zero so voices already
   * ringing stop, and `play()` refuses to start new ones so a muted game does no
   * synthesis work at all. Either alone would be a bug — a gain-only mute leaves
   * a hidden 16-voice graph running on a phone, and a play-only mute lets a long
   * explosion keep sounding after the player hits mute.
   */
  setMuted(muted: boolean): void {
    if (muted === this.mutedValue) return
    this.mutedValue = muted
    if (muted) {
      this.stopAll()
      this.backend.setMasterGain(0)
    } else {
      this.backend.setMasterGain(this.masterVolumeValue)
    }
  }

  get masterVolume(): number {
    return this.masterVolumeValue
  }

  setMasterVolume(volume: number): void {
    this.masterVolumeValue = sanitizeVolume(volume, DEFAULT_MASTER_VOLUME)
    if (!this.mutedValue) this.backend.setMasterGain(this.masterVolumeValue)
  }

  categoryVolume(category: SoundCategory): number {
    return this.categoryVolumes[category]
  }

  setCategoryVolume(category: SoundCategory, volume: number): void {
    this.categoryVolumes[category] = sanitizeVolume(volume, DEFAULT_CATEGORY_VOLUMES[category])
  }

  /** Concurrent voices, after retiring any that have finished. */
  get activeVoices(): number {
    this.reap(this.backend.now())
    return this.voices.length
  }

  /**
   * Try to play a sound. Returns whether a voice was actually started.
   *
   * A `false` return is normal and expected — it is the limiter working, not an
   * error — which is why nothing here throws or logs.
   */
  play(id: SoundId, options?: PlayOptions): boolean {
    if (this.mutedValue) return false
    // Before the first user gesture there is nothing to play into. Bail out here
    // rather than in the backend so rotations and retrigger timers are not
    // advanced by events nobody could hear.
    if (this.backend.state() !== 'running') return false

    const def = SOUNDS[id]
    const now = this.backend.now()
    this.reap(now)

    const previous = this.lastStart.get(id)
    if (previous !== undefined && now - previous < def.minGapSec) return false

    if (!this.makeRoom(id, def)) return false

    const step = this.rotation.get(id) ?? 0
    const pitchRotation = pick(def.pitchRotation, step)
    const gainRotation = pick(def.gainRotation, step)

    const timeScale = sanitizeScale(options?.timeScale, 0.25, 4)
    /**
     * Headroom is applied as a SCALE, not a clamp, and the difference is the
     * whole mix.
     *
     * This used to be `clamp(category × gain × …, 0, VOICE_PEAK_CEILING)`. With a
     * ceiling of 0.7 that pinned six of the loudest fourteen sounds — every alarm,
     * both threats — to the identical value 0.700, so a shield absorbing a hit, an
     * enemy taking a shot at you and losing the hull all left the mixer at exactly
     * the same level. The hierarchy in src/audio/sounds.ts was being enforced on
     * the constants and destroyed on the way out, and no test could see it because
     * every test read the constants too. `npm run audio` measures the rendered
     * output, which is how it was found.
     *
     * Scaling instead preserves every ratio the hierarchy specifies and still
     * guarantees the same absolute ceiling, because the scaled term is clamped to
     * 1 first.
     */
    const nominal = clamp(
      this.categoryVolumes[def.category] * def.gain * sanitizeScale(options?.gain, 0, 2) * gainRotation,
      0,
      1,
    )
    const gain = nominal * VOICE_PEAK_CEILING
    // A gain that rounds to nothing is still a full voice graph. Refuse it.
    if (gain <= 0.0005) return false

    const request: VoiceRequest = {
      id,
      category: def.category,
      layers: def.layers,
      gain,
      pitch: clamp(pitchRotation * sanitizeScale(options?.pitch, 0.25, 4), 0.25, 4),
      timeScale,
      pan: clamp(options?.pan ?? 0, -1, 1),
      duration: layersDuration(def.layers) * timeScale + VOICE_TAIL_MARGIN,
    }

    const handle = this.backend.start(request)
    if (handle === null) return false

    this.voices.push({
      id,
      category: def.category,
      priority: def.priority,
      endsAt: now + request.duration,
      handle,
    })
    this.lastStart.set(id, now)
    this.rotation.set(id, step + 1)
    return true
  }

  /**
   * Stop sounding voices below a priority threshold.
   *
   * Used on mute, and on the run ending: `alarm.hullLost` cuts everything
   * quieter than itself, because a shot fired half a second before death has
   * stopped being information.
   */
  stopAll(belowPriority = Number.POSITIVE_INFINITY): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const voice = this.voices[i]
      if (voice === undefined) continue
      if (voice.priority >= belowPriority) continue
      voice.handle.stop()
      this.voices.splice(i, 1)
    }
  }

  /** Retire voices whose envelopes have finished. */
  private reap(now: number): void {
    for (let i = this.voices.length - 1; i >= 0; i--) {
      const voice = this.voices[i]
      if (voice !== undefined && voice.endsAt > now) continue
      this.voices.splice(i, 1)
    }
  }

  /**
   * Enforce the three concurrency caps, stealing where allowed.
   *
   * Returns false when the incoming sound is not important enough to displace
   * anything — the one case where an event produces no sound at all.
   */
  private makeRoom(id: SoundId, def: SoundDef): boolean {
    // Same sound at its own cap: replace its oldest instance. A ninth overlapping
    // copy of one explosion is indistinguishable from the eighth.
    if (this.countBy((v) => v.id === id) >= def.maxVoices) {
      const oldest = this.weakest((v) => v.id === id)
      if (oldest === null) return false
      this.steal(oldest)
    }

    const categoryCap = CATEGORY_VOICE_CAPS[def.category]
    if (this.countBy((v) => v.category === def.category) >= categoryCap) {
      const victim = this.weakest((v) => v.category === def.category)
      if (victim === null || victim.priority > def.priority) return false
      this.steal(victim)
    }

    if (this.voices.length >= MAX_VOICES) {
      const victim = this.weakest(() => true)
      if (victim === null || victim.priority > def.priority) return false
      this.steal(victim)
    }

    return true
  }

  private countBy(predicate: (voice: ActiveVoice) => boolean): number {
    let count = 0
    for (const voice of this.voices) if (predicate(voice)) count++
    return count
  }

  /**
   * The most expendable matching voice: lowest priority, then closest to
   * finishing. Stealing the nearly-finished one of a tie is the least audible
   * possible interruption.
   */
  private weakest(predicate: (voice: ActiveVoice) => boolean): ActiveVoice | null {
    let best: ActiveVoice | null = null
    for (const voice of this.voices) {
      if (!predicate(voice)) continue
      if (
        best === null ||
        voice.priority < best.priority ||
        (voice.priority === best.priority && voice.endsAt < best.endsAt)
      ) {
        best = voice
      }
    }
    return best
  }

  private steal(voice: ActiveVoice): void {
    const index = this.voices.indexOf(voice)
    if (index >= 0) this.voices.splice(index, 1)
    voice.handle.stop()
  }
}

/** Cycle position in a rotation table. Empty tables mean "no variation". */
function pick(table: readonly number[], step: number): number {
  if (table.length === 0) return 1
  return table[step % table.length] ?? 1
}
