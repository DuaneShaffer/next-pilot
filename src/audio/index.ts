/**
 * The audio layer's public face. This is what the app layer talks to.
 *
 * WHERE THIS SITS: audio is a *host* concern, like rendering. It is driven by
 * `SimEvent`s and a `WorldView` and it never appears in `src/sim/**` — that is
 * CLAUDE.md contract 2, and `npm run contracts` checks it statically, because a
 * single import from the sim into here would stop the sim running headless and
 * silently break bot playtests and the replay corpus at the same time.
 *
 * Typical wiring in the app layer:
 *
 *     const audio = createAudioDirector()
 *     // ...from any real input handler, every time. It is idempotent:
 *     audio.unlock()
 *     // ...once per SIMULATION TICK, not once per rendered frame:
 *     audio.observe(world.view())
 *     // ...menus:
 *     audio.confirm()
 *
 * The per-tick rule is the one that bites. `SimEvent`s are cleared every tick and
 * a frame can span several (many under `?ff=`), so draining per frame discards
 * all but the last tick's events — which is heard as audio dropping out exactly
 * when the screen is busiest.
 */

import { TICK_HZ } from '../core/loop'
import type { EnemyInstance, SimEvent, WorldView } from '../sim/entities'
import { layersDuration, type AudioBackend } from './backend'
import { cueForEvent, panForX } from './events'
import { Mixer, type PlayOptions } from './mixer'
import { SOUNDS, type SoundCategory, type SoundId } from './sounds'
import { SilentBackend } from './silent'
import { WebAudioBackend, webAudioAvailable } from './webaudio'

/**
 * Voices quieter than this are cut when the hull is lost.
 *
 * A shot fired 300ms before death has stopped being information, and the
 * power-down needs the whole output to itself to read as final. The threshold
 * keeps the alarm tier (the hit that killed you, a shield failing) and drops
 * everything else — weapon, impacts, pickups, telegraphs.
 */
const DEATH_CUT_PRIORITY = 88

/** Length the telegraph recipe was written for; windups stretch around it. */
const TELEGRAPH_BASE_SECONDS = layersDuration(SOUNDS['threat.telegraph'].layers)

export class AudioDirector {
  private readonly backend: AudioBackend
  private readonly mixer: Mixer
  /**
   * Enemies whose windup cue has already been fired.
   *
   * `EnemyInstance` has no id, so identity is the only stable key — which is
   * fine, and survives the sim pooling instances, because a recycled instance
   * arrives with `telegraphTicks` back at 0 and gets dropped from the set on the
   * first tick it is seen idle. Weak so it can never keep a dead enemy alive.
   */
  private readonly winding = new WeakSet<EnemyInstance>()
  /** Last tick drained by `observe`, so a double call cannot replay a tick. */
  private lastObservedTick = -1

  constructor(backend: AudioBackend) {
    this.backend = backend
    this.mixer = new Mixer(backend)
  }

  /** True when this environment could ever produce sound. False in Node. */
  get available(): boolean {
    return this.backend.available
  }

  /**
   * Whether audio is actually playable right now.
   *
   * Exposed so the HUD can eventually show an "audio locked, press anything"
   * hint — the M6 settings screen is not this milestone's problem, but the state
   * it needs has to be observable from the start.
   */
  get unlocked(): boolean {
    return this.backend.state() === 'running'
  }

  /**
   * Call from the first real user gesture (keydown, pointerdown, touchend), and
   * from every one after that if you like — it is idempotent and safe when
   * already running. iOS will not play audio from a context created at page
   * load, so nothing is constructed until this is called.
   */
  unlock(): void {
    this.backend.unlock()
  }

  /**
   * Everything an observer needs to do for one tick: drain the tick's events and
   * pick up state-derived cues (the enemy telegraph, which is not an event).
   *
   * Guarded against being called twice for the same tick — the events array is
   * still populated between ticks, so a per-frame caller would otherwise hear
   * the same volley several times.
   */
  observe(view: WorldView): void {
    const tick = view.stats.tick
    if (tick === this.lastObservedTick) return
    this.lastObservedTick = tick
    this.handleEvents(view.events)
    this.observeTelegraphs(view.enemies)
  }

  /** Drain one tick's events. Order is preserved; the mixer decides what survives. */
  handleEvents(events: readonly SimEvent[]): void {
    for (const event of events) {
      const cue = cueForEvent(event)
      this.mixer.play(cue.sound, {
        gain: cue.gain,
        pitch: cue.pitch,
        pan: cue.pan,
        timeScale: cue.timeScale,
      })
      if (event.kind === 'hull-lost') this.mixer.stopAll(DEATH_CUT_PRIORITY)
    }
  }

  /**
   * Fire the windup cue on the rising edge of `telegraphTicks`.
   *
   * The telegraph is the one cue that is worth deriving from state rather than
   * waiting for an event, because it is the case where the player is most likely
   * to be looking somewhere else: a sound is often *how* you notice an attack
   * starting. The cue is stretched to the enemy's actual windup so it finishes
   * as the shot leaves, which makes it a countdown rather than a label.
   */
  private observeTelegraphs(enemies: readonly EnemyInstance[]): void {
    for (const enemy of enemies) {
      if (enemy.telegraphTicks > 0) {
        if (this.winding.has(enemy)) continue
        this.winding.add(enemy)
        const windupSeconds = Math.max(enemy.telegraphTotal, enemy.telegraphTicks) / TICK_HZ
        this.mixer.play('threat.telegraph', {
          // Same panning as the shot that follows, so the windup and the volley
          // come from the same place.
          pan: panForX(enemy.x),
          timeScale: windupSeconds / TELEGRAPH_BASE_SECONDS,
          // Elites get a slightly lower charge note. Same cue, bigger machine.
          pitch: enemy.elite ? 0.88 : 1,
        })
      } else if (this.winding.has(enemy)) {
        this.winding.delete(enemy)
      }
    }
  }

  /** Menu accept. The one UI sound the sim has no event for. */
  confirm(): void {
    this.mixer.play('ui.confirm')
  }

  /** Menu back/decline. */
  cancel(): void {
    this.mixer.play('ui.cancel')
  }

  /** Escape hatch for a one-off cue. Returns whether a voice was started. */
  play(id: SoundId, options?: PlayOptions): boolean {
    return this.mixer.play(id, options)
  }

  get muted(): boolean {
    return this.mixer.muted
  }

  setMuted(muted: boolean): void {
    this.mixer.setMuted(muted)
  }

  get masterVolume(): number {
    return this.mixer.masterVolume
  }

  setMasterVolume(volume: number): void {
    this.mixer.setMasterVolume(volume)
  }

  categoryVolume(category: SoundCategory): number {
    return this.mixer.categoryVolume(category)
  }

  setCategoryVolume(category: SoundCategory, volume: number): void {
    this.mixer.setCategoryVolume(category, volume)
  }

  /** Concurrent voices. Bounded by `MAX_VOICES` — see src/audio/mixer.ts. */
  get activeVoices(): number {
    return this.mixer.activeVoices
  }

  /** Cut everything, e.g. on leaving a sortie. */
  stopAll(): void {
    this.mixer.stopAll()
  }
}

/**
 * Build a director with the best backend this environment supports.
 *
 * The silent path is a supported mode, not an error: in Node (tests, bot
 * playtests) and in a browser with WebAudio blocked, the game runs identically
 * and simply makes no sound.
 */
export function createAudioDirector(): AudioDirector {
  return new AudioDirector(webAudioAvailable() ? new WebAudioBackend() : new SilentBackend())
}

export { SilentBackend } from './silent'
export { WebAudioBackend, webAudioAvailable } from './webaudio'
export { Mixer } from './mixer'
export { cueForEvent, panForX, SIM_EVENT_KINDS, type SoundCue } from './events'
export {
  CATEGORY_VOICE_CAPS,
  DEFAULT_CATEGORY_VOLUMES,
  DEFAULT_MASTER_VOLUME,
  MAX_VOICES,
  SOUNDS,
  SOUND_IDS,
  VOICE_PEAK_CEILING,
  type SoundCategory,
  type SoundDef,
  type SoundId,
} from './sounds'
export {
  layer,
  layerDuration,
  layersDuration,
  peakLayerGain,
  type AudioBackend,
  type BackendState,
  type Layer,
  type VoiceHandle,
  type VoiceRequest,
} from './backend'
export type { PlayOptions } from './mixer'
