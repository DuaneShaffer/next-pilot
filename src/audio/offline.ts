/**
 * Rendering the game's audio to PCM, so it can be measured and listened to.
 *
 * This is the missing instrument described in docs/VERIFICATION.md §5. It runs
 * inside a real browser against an `OfflineAudioContext`, driving the *shipped*
 * path end to end:
 *
 *     SimEvent → cueForEvent → Mixer (gain structure, limiter, voice stealing)
 *             → synth.buildVoice → biquads and oscillators → master compressor
 *             → Float32 samples
 *
 * Nothing here reimplements any of that. `OfflineBackend` is an `AudioBackend`
 * like the live one, differing only in where its clock comes from: real time in
 * the browser, a virtual cursor here. That is the whole trick, and it is why the
 * numbers `tools/audio.ts` prints are facts about the game rather than facts
 * about a simulation of the game.
 *
 * Not part of the shipped bundle — nothing `src/main.ts` imports reaches this
 * file, and it cannot even be constructed in Node.
 */

import { TICK_HZ } from '../core/loop'
import { Rng } from '../core/rng'
import type { SimEvent } from '../sim/entities'
import type { Pcm } from './analysis'
import { layersDuration, type AudioBackend, type BackendState, type VoiceHandle, type VoiceRequest } from './backend'
import { AudioDirector } from './index'
import type { PlayOptions } from './mixer'
import { SOUND_IDS, SOUNDS, type SoundId } from './sounds'
import { buildMasterChain, buildVoice, makeNoiseBuffer, SILENCE } from './synth'

/** 48 kHz because the loudness measurement's K-weighting is only exact there. */
export const RENDER_SAMPLE_RATE = 48000

/** Stereo, because pan is part of the mix and a mono render would hide it. */
const RENDER_CHANNELS = 2

/** Matches the live backend, so a stolen voice sounds the same in both. */
const STEAL_FADE = 0.008

export interface StartedVoice {
  readonly id: SoundId
  readonly gain: number
  readonly at: number
  stoppedAt: number | null
}

/**
 * An `AudioBackend` whose clock is a cursor the caller moves.
 *
 * The mixer's voice limiting is entirely a question of what overlaps in time, so
 * it can only be exercised offline if "now" is under the harness's control. Every
 * other behaviour — category gains, retrigger gaps, priority stealing — then runs
 * exactly as it does live.
 */
export class OfflineBackend implements AudioBackend {
  readonly available = true
  readonly started: StartedVoice[] = []
  private readonly ctx: BaseAudioContext
  private readonly bus: GainNode
  private readonly master: GainNode
  private readonly noise: AudioBuffer
  private readonly rng = Rng.fromSeed('audio', 'noise-offset')
  private clock = 0

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx
    const chain = buildMasterChain(ctx, 1)
    this.bus = chain.bus
    this.master = chain.master
    this.noise = makeNoiseBuffer(ctx, Rng.fromSeed('audio', 'noise-buffer'))
  }

  state(): BackendState {
    return 'running'
  }

  now(): number {
    return this.clock
  }

  /** Move the cursor to an absolute time in the render. */
  seek(seconds: number): void {
    this.clock = Math.max(this.clock, seconds)
  }

  unlock(): void {}

  setMasterGain(gain: number): void {
    // Stepped, not ramped. The live backend ramps to avoid a click mid-voice;
    // offline the level is set before anything sounds, and a 10ms ramp at t=0
    // would quietly attenuate the first cue of every render.
    this.master.gain.setValueAtTime(gain, this.clock)
  }

  start(request: VoiceRequest): VoiceHandle | null {
    const built = buildVoice(this.ctx, request, this.clock, this.bus, this.noise, this.rng)
    if (built === null) return null
    const record: StartedVoice = { id: request.id, gain: request.gain, at: this.clock, stoppedAt: null }
    this.started.push(record)
    return {
      stop: () => {
        if (record.stoppedAt !== null) return
        record.stoppedAt = this.clock
        const at = this.clock
        try {
          built.gain.gain.cancelScheduledValues(at)
          built.gain.gain.setValueAtTime(request.gain, at)
          built.gain.gain.exponentialRampToValueAtTime(SILENCE, at + STEAL_FADE)
        } catch {
          // Matches the live backend: a param that has already run is not a crash.
        }
        for (const source of built.sources) {
          try {
            source.stop(at + STEAL_FADE)
          } catch {
            // Already stopped, or scheduled to stop earlier. Nothing to do.
          }
        }
      },
    }
  }

  close(): void {}
}

// ---------------------------------------------------------------------------
// scenes
// ---------------------------------------------------------------------------

/** One thing that happens at one moment in a render. */
export type Action =
  | { readonly at: number; readonly kind: 'event'; readonly event: SimEvent }
  | { readonly at: number; readonly kind: 'cue'; readonly sound: SoundId; readonly options: PlayOptions }

export interface Scene {
  readonly name: string
  /** One line, printed in the report next to the numbers. */
  readonly what: string
  readonly durationSec: number
  readonly actions: readonly Action[]
}

export interface RenderResult {
  readonly pcm: Pcm
  readonly starts: readonly StartedVoice[]
}

/**
 * Render one scene.
 *
 * Actions are applied in time order with the backend cursor moved to each
 * action's timestamp first, which is what makes retrigger gaps and voice
 * stealing behave as they would in a live run.
 */
export async function renderScene(scene: Scene): Promise<RenderResult> {
  const frames = Math.ceil(scene.durationSec * RENDER_SAMPLE_RATE)
  const ctx = new OfflineAudioContext(RENDER_CHANNELS, frames, RENDER_SAMPLE_RATE)
  const backend = new OfflineBackend(ctx)
  const director = new AudioDirector(backend)

  const ordered = [...scene.actions].sort((a, b) => a.at - b.at)
  for (const action of ordered) {
    backend.seek(action.at)
    if (action.kind === 'event') director.handleEvents([action.event])
    else director.play(action.sound, action.options)
  }

  const rendered = await ctx.startRendering()
  const channels: Float32Array[] = []
  for (let c = 0; c < rendered.numberOfChannels; c++) channels.push(rendered.getChannelData(c))
  return {
    pcm: { sampleRate: rendered.sampleRate, channels },
    starts: backend.started,
  }
}

// ---------------------------------------------------------------------------
// the catalogue
// ---------------------------------------------------------------------------

/** Silence before a cue, so its attack is not clipped by the buffer edge. */
const LEAD_IN = 0.05

/** Silence after a cue, so an exponential tail is measured rather than truncated. */
const TAIL = 0.4

/** One take per sound, played through the real mixer at shipped levels. */
export function cueScenes(): Scene[] {
  return SOUND_IDS.map((id) => ({
    name: `cue--${id}`,
    what: `${id}, solo, centred, at the shipped mix level`,
    durationSec: LEAD_IN + layersDuration(SOUNDS[id].layers) + TAIL,
    actions: [{ at: LEAD_IN, kind: 'cue' as const, sound: id, options: {} }],
  }))
}

const TICK = 1 / TICK_HZ

/**
 * A believable stretch of combat: the player firing at 20 shots/second, enemies
 * returning fire, hits landing, the occasional kill and pickup.
 *
 * This is the bed everything else has to be audible *over*, so it is built from
 * the same `SimEvent`s the game emits rather than from a guess about density.
 */
function combatBed(seconds: number, offset = 0): Action[] {
  const actions: Action[] = []
  const shotInterval = 3 * TICK
  for (let t = 0; t < seconds; t += shotInterval) {
    actions.push({ at: offset + t, kind: 'event', event: { kind: 'player-shot', x: 224, y: 600 } })
  }
  for (let t = 0.12; t < seconds; t += 0.17) {
    actions.push({
      at: offset + t,
      kind: 'event',
      event: { kind: 'enemy-hit', x: 140 + ((t * 700) % 300), y: 200, damage: 4, defId: 'skiff', lethal: false },
    })
  }
  for (let t = 0.2; t < seconds; t += 0.31) {
    actions.push({ at: offset + t, kind: 'event', event: { kind: 'enemy-shot', x: 90 + ((t * 900) % 320), y: 180, defId: 'turret' } })
  }
  for (let t = 0.45; t < seconds; t += 0.62) {
    actions.push({
      at: offset + t,
      kind: 'event',
      event: { kind: 'enemy-killed', x: 120 + ((t * 500) % 300), y: 220, defId: 'skiff', scrap: 3, elite: false },
    })
  }
  for (let t = 0.7; t < seconds; t += 0.55) {
    actions.push({ at: offset + t, kind: 'event', event: { kind: 'scrap-collected', x: 224, y: 400, amount: 2 } })
  }
  return actions
}

/**
 * The worst tick the simulation can legitimately produce.
 *
 * `src/sim/world.ts` caps events at 256 per tick and drops the rest, so 256
 * simultaneous events is not a stress test invented for this harness — it is the
 * contractual maximum the mixer must survive without the output turning to mud.
 * Uncontrolled summation is the classic failure of event-driven synthesis, and
 * until this scene existed nothing here measured it.
 */
const MAX_EVENTS_PER_TICK = 256

function worstTick(): Action[] {
  const actions: Action[] = []
  const at = LEAD_IN
  for (let i = 0; i < MAX_EVENTS_PER_TICK; i++) {
    const x = 20 + ((i * 37) % 400)
    const slot = i % 8
    if (slot === 0 || slot === 1 || slot === 2) {
      actions.push({ at, kind: 'event', event: { kind: 'enemy-killed', x, y: 200, defId: 'skiff', scrap: 3, elite: i % 24 === 0 } })
    } else if (slot === 3 || slot === 4) {
      actions.push({ at, kind: 'event', event: { kind: 'enemy-hit', x, y: 200, damage: 5, defId: 'skiff', lethal: true } })
    } else if (slot === 5) {
      actions.push({ at, kind: 'event', event: { kind: 'scrap-collected', x, y: 300, amount: 2 } })
    } else if (slot === 6) {
      actions.push({ at, kind: 'event', event: { kind: 'enemy-shot', x, y: 150, defId: 'turret' } })
    } else {
      actions.push({ at, kind: 'event', event: { kind: 'player-shot', x: 224, y: 600 } })
    }
  }
  actions.push({ at, kind: 'event', event: { kind: 'hull-hit', x: 224, y: 640, damage: 12, absorbedByShield: false } })
  return actions
}

/** Length of the combat bed used for the masking measurement. */
export const MASKING_SCENE_SECONDS = 3

/** When the hazard warning fires inside the masking scenes. */
export const MASKING_WARNING_AT = 1.2

export function situationScenes(): Scene[] {
  const hazardWarning: Action = {
    at: MASKING_WARNING_AT,
    kind: 'event',
    event: { kind: 'hazard-warning', hazardId: 'sweep' },
  }

  return [
    {
      name: 'pileup-screen-clear',
      what: 'a bomb going off: 12 kills, 12 lethal hits and a hull hit in one tick',
      durationSec: 2,
      actions: (() => {
        const actions: Action[] = []
        for (let i = 0; i < 12; i++) {
          const x = 40 + i * 32
          actions.push({ at: LEAD_IN, kind: 'event', event: { kind: 'enemy-killed', x, y: 200, defId: 'skiff', scrap: 3, elite: i % 6 === 0 } })
          actions.push({ at: LEAD_IN, kind: 'event', event: { kind: 'enemy-hit', x, y: 200, damage: 6, defId: 'skiff', lethal: true } })
        }
        actions.push({ at: LEAD_IN, kind: 'event', event: { kind: 'hull-hit', x: 224, y: 640, damage: 9, absorbedByShield: false } })
        return actions
      })(),
    },
    {
      name: 'pileup-worst-tick',
      what: `the contractual worst case: all ${MAX_EVENTS_PER_TICK} events of one tick at once`,
      durationSec: 2,
      actions: worstTick(),
    },
    {
      name: 'combat-bed',
      what: 'three seconds of ordinary combat — the noise every warning must beat',
      durationSec: MASKING_SCENE_SECONDS,
      actions: combatBed(MASKING_SCENE_SECONDS),
    },
    {
      name: 'hazard-warning-solo',
      what: 'the hazard warning alone, positioned as it is in the combat scene',
      durationSec: MASKING_SCENE_SECONDS,
      actions: [hazardWarning],
    },
    {
      name: 'hazard-warning-in-combat',
      what: 'the hazard warning during ordinary combat — the reaction window, as heard',
      durationSec: MASKING_SCENE_SECONDS,
      actions: [...combatBed(MASKING_SCENE_SECONDS), hazardWarning],
    },
    {
      // The masker for the pile-up case. Identical to the scene below minus the
      // warning itself — measuring a warning against a bed that contains the
      // warning reports the margin as zero and looks like a catastrophe.
      name: 'pileup-bed',
      what: 'combat plus a screen clear, with no warning — the masker for the worst case',
      durationSec: MASKING_SCENE_SECONDS,
      actions: [
        ...combatBed(MASKING_SCENE_SECONDS),
        ...worstTick().map((action) => ({ ...action, at: MASKING_WARNING_AT - 0.05 })),
      ],
    },
    {
      name: 'hazard-warning-in-pileup',
      what: 'the hazard warning arriving in the middle of a screen clear',
      durationSec: MASKING_SCENE_SECONDS,
      actions: [
        ...combatBed(MASKING_SCENE_SECONDS),
        ...worstTick().map((action) => ({ ...action, at: MASKING_WARNING_AT - 0.05 })),
        hazardWarning,
      ],
    },
    {
      name: 'weapon-sustained',
      what: 'four seconds of held trigger at 20 shots/second, nothing else',
      durationSec: 4,
      actions: (() => {
        const actions: Action[] = []
        for (let t = 0; t < 4; t += 3 * TICK) {
          actions.push({ at: t, kind: 'event', event: { kind: 'player-shot', x: 224, y: 600 } })
        }
        return actions
      })(),
    },
    {
      name: 'death',
      what: 'two hull hits, a shield failing, then the run ending',
      durationSec: 3,
      actions: [
        { at: 0.1, kind: 'event', event: { kind: 'hull-hit', x: 200, y: 640, damage: 6, absorbedByShield: true } },
        { at: 0.45, kind: 'event', event: { kind: 'shield-broken', x: 224, y: 640 } },
        { at: 0.9, kind: 'event', event: { kind: 'hull-hit', x: 240, y: 640, damage: 14, absorbedByShield: false } },
        { at: 1.3, kind: 'event', event: { kind: 'hull-lost', x: 224, y: 640 } },
      ],
    },
    {
      name: 'boss',
      what: 'a boss arriving, changing phase, and dying',
      durationSec: 5,
      actions: [
        { at: 0.1, kind: 'event', event: { kind: 'boss-spawned', bossId: 'auditor', name: 'The Auditor' } },
        ...combatBed(1.6, 1.6),
        { at: 2.0, kind: 'event', event: { kind: 'boss-phase', bossId: 'auditor', phaseIndex: 1, callout: 'ESCALATING' } },
        { at: 3.4, kind: 'event', event: { kind: 'boss-killed', x: 224, y: 180, bossId: 'auditor' } },
      ],
    },
    {
      name: 'stage-clear',
      what: 'the last hazard firing, then the stage clearing',
      durationSec: 3.5,
      actions: [
        { at: 0.1, kind: 'event', event: { kind: 'hazard-warning', hazardId: 'sweep' } },
        { at: 1.1, kind: 'event', event: { kind: 'hazard-fired', hazardId: 'sweep' } },
        { at: 1.9, kind: 'event', event: { kind: 'stage-cleared', stageIndex: 0 } },
      ],
    },
  ]
}

export function allScenes(): Scene[] {
  return [...cueScenes(), ...situationScenes()]
}
