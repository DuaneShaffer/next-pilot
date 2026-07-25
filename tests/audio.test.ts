/**
 * Audio layer tests. These run in Node, where `AudioContext` does not exist.
 *
 * That is the point. The synthesis itself cannot be verified without a human
 * listening, so everything that *can* be verified is pushed into places that do
 * not need ears: the event mapping is total, the voice count is bounded, mute
 * silences, unlock is idempotent, and no gain can be set to something that
 * clips. A skipped suite because "there's no browser" would leave all of that
 * unchecked, and every one of those is a bug you would only notice mid-run.
 */

import { describe, expect, it } from 'vitest'
import { TICK_HZ } from '../src/core/loop'
import { PLAYFIELD_W } from '../src/core/space'
import type { EnemyInstance, SimEvent, WorldView } from '../src/sim/entities'
import {
  AudioDirector,
  CATEGORY_VOICE_CAPS,
  DEFAULT_CATEGORY_VOLUMES,
  DEFAULT_MASTER_VOLUME,
  MAX_VOICES,
  Mixer,
  SIM_EVENT_KINDS,
  SOUNDS,
  SOUND_IDS,
  SilentBackend,
  VOICE_PEAK_CEILING,
  WebAudioBackend,
  createAudioDirector,
  cueForEvent,
  layersDuration,
  panForX,
  webAudioAvailable,
  type SoundCategory,
  type SoundId,
} from '../src/audio'
import { RecordingBackend } from '../src/audio/testing'

/**
 * One sample event per `SimEvent` variant, keyed by the union.
 *
 * The `Record` is what makes the totality test drift-proof: adding a variant to
 * `SimEvent` without adding it here is a compile error, and the tests below
 * iterate this rather than a hand-written list of kinds that could quietly fall
 * behind the contract.
 */
const SAMPLE_EVENTS: Record<SimEvent['kind'], SimEvent> = {
  'player-shot': { kind: 'player-shot', x: 224, y: 600 },
  'enemy-hit': { kind: 'enemy-hit', x: 100, y: 200, damage: 4, defId: 'skiff', lethal: false },
  'enemy-killed': { kind: 'enemy-killed', x: 100, y: 200, defId: 'skiff', scrap: 3, elite: false },
  'enemy-shot': { kind: 'enemy-shot', x: 300, y: 150, defId: 'turret' },
  'hull-hit': { kind: 'hull-hit', x: 224, y: 640, damage: 6, absorbedByShield: false },
  'shield-broken': { kind: 'shield-broken', x: 224, y: 640 },
  'hull-lost': { kind: 'hull-lost', x: 224, y: 640 },
  'scrap-collected': { kind: 'scrap-collected', x: 180, y: 400, amount: 3 },
  'wave-released': { kind: 'wave-released', index: 4 },
}

function fakeEnemy(overrides: Partial<EnemyInstance> = {}): EnemyInstance {
  return {
    x: 200,
    y: 120,
    prevX: 200,
    prevY: 110,
    defId: 'turret',
    hp: 10,
    maxHp: 10,
    radius: 12,
    shape: 'turret',
    movement: 'hover',
    elite: false,
    vx: 0,
    vy: 0,
    age: 30,
    phase: 'holding',
    fireCooldown: 10,
    contactDamage: 6,
    scrap: 3,
    alive: true,
    hitFlashTicks: 0,
    telegraphTicks: 0,
    telegraphTotal: 0,
    originX: 200,
    holdY: 120,
    ...overrides,
  }
}

/** A WorldView with only the parts the audio layer reads filled in usefully. */
function fakeView(options: {
  tick?: number
  events?: readonly SimEvent[]
  enemies?: readonly EnemyInstance[]
}): WorldView {
  return {
    seed: 'TEST-SEED',
    runState: 'active',
    hull: {
      x: 224,
      y: 640,
      prevX: 224,
      prevY: 640,
      integrity: 100,
      maxIntegrity: 100,
      shield: 20,
      maxShield: 20,
      invulnTicks: 0,
      radius: 8,
    },
    playerBullets: [],
    enemyBullets: [],
    enemies: options.enemies ?? [],
    explosions: [],
    stats: {
      tick: options.tick ?? 1,
      shotsFired: 0,
      hits: 0,
      kills: 0,
      scrap: 0,
      damageTaken: 0,
      waveIndex: 0,
      peakProjectiles: 0,
      bulletsCulled: 0,
    },
    incident: null,
    events: options.events ?? [],
    cosmetic: { shake: 0 },
    freezeTicks: 0,
    inventory: [],
    activeInteractions: [],
    resolvedStats: {},
    pendingChoice: null,
  }
}

function recordingDirector(): { audio: AudioDirector; backend: RecordingBackend } {
  const backend = new RecordingBackend()
  return { audio: new AudioDirector(backend), backend }
}

describe('headless environment', () => {
  it('has no AudioContext, which is the environment these tests exist for', () => {
    expect(webAudioAvailable()).toBe(false)
  })

  it('constructs the real WebAudio backend without throwing and reports unavailable', () => {
    // The class must be importable and constructible in Node. If constructing it
    // touched AudioContext eagerly, importing anything from src/audio would crash
    // every headless test and the bot playtest harness with it.
    const backend = new WebAudioBackend()
    expect(backend.available).toBe(false)
    expect(backend.state()).toBe('unavailable')
    expect(backend.now()).toBe(0)
    expect(() => backend.unlock()).not.toThrow()
    expect(backend.state()).toBe('unavailable')
    expect(
      backend.start({
        id: 'ui.confirm',
        category: 'ui',
        layers: SOUNDS['ui.confirm'].layers,
        gain: 0.5,
        pitch: 1,
        timeScale: 1,
        pan: 0,
        duration: 0.2,
      }),
    ).toBeNull()
    expect(() => backend.close()).not.toThrow()
  })

  it('createAudioDirector falls back to the silent backend and stays fully usable', () => {
    const audio = createAudioDirector()
    expect(audio.available).toBe(false)
    expect(audio.unlocked).toBe(false)

    // The no-audio path is a supported mode: every entry point must work, do
    // nothing, and report honestly.
    expect(audio.play('ui.confirm')).toBe(false)
    expect(audio.activeVoices).toBe(0)
    audio.confirm()
    audio.cancel()
    audio.handleEvents(Object.values(SAMPLE_EVENTS))
    audio.observe(fakeView({ events: Object.values(SAMPLE_EVENTS), enemies: [fakeEnemy({ telegraphTicks: 20, telegraphTotal: 24 })] }))
    audio.setMuted(true)
    audio.setMuted(false)
    audio.setMasterVolume(1)
    audio.setCategoryVolume('weapon', 0.5)
    audio.stopAll()
    expect(audio.activeVoices).toBe(0)
  })

  it('the silent backend answers every interface call', () => {
    const backend = new SilentBackend()
    expect(backend.available).toBe(false)
    expect(backend.state()).toBe('unavailable')
    expect(backend.now()).toBe(0)
    expect(() => backend.unlock()).not.toThrow()
    expect(() => backend.setMasterGain(0.5)).not.toThrow()
    expect(() => backend.close()).not.toThrow()
  })
})

describe('event → sound mapping', () => {
  it('is total over the SimEvent union', () => {
    // Iterates the union (via a Record keyed by it) rather than a list of kinds
    // written out here, so a new variant in src/sim/entities.ts cannot ship
    // without a sound.
    expect(SIM_EVENT_KINDS.length).toBe(Object.keys(SAMPLE_EVENTS).length)

    for (const kind of SIM_EVENT_KINDS) {
      const event = SAMPLE_EVENTS[kind]
      expect(event, `no sample event for ${kind}`).toBeDefined()
      const cue = cueForEvent(event)
      expect(SOUNDS[cue.sound], `${kind} maps to an undefined sound`).toBeDefined()
      expect(Number.isFinite(cue.gain)).toBe(true)
      expect(cue.gain).toBeGreaterThan(0)
      expect(cue.pitch).toBeGreaterThan(0)
      expect(cue.timeScale).toBeGreaterThan(0)
      expect(Math.abs(cue.pan)).toBeLessThanOrEqual(1)
    }
  })

  it('actually starts a voice for every variant, not just resolves one', () => {
    // A mapping can be total and still inaudible if the mixer rejects the result.
    const { audio, backend } = recordingDirector()
    for (const kind of SIM_EVENT_KINDS) {
      const before = backend.started.length
      audio.handleEvents([SAMPLE_EVENTS[kind]])
      expect(backend.started.length, `${kind} produced no voice`).toBe(before + 1)
      // Past every retrigger gap in the library, so no event is blocked by the
      // one before it.
      backend.advance(1)
    }
  })

  it('distinguishes the pairs a player has to tell apart', () => {
    // These four distinctions are the ones that carry information: shielded vs
    // not, elite vs not. If any collapses to the same sound the mix has lost the
    // thing it was supposed to convey.
    const shielded = cueForEvent({ kind: 'hull-hit', x: 0, y: 0, damage: 6, absorbedByShield: true })
    const bare = cueForEvent({ kind: 'hull-hit', x: 0, y: 0, damage: 6, absorbedByShield: false })
    expect(shielded.sound).not.toBe(bare.sound)

    const elite = cueForEvent({ kind: 'enemy-killed', x: 0, y: 0, defId: 'x', scrap: 1, elite: true })
    const grunt = cueForEvent({ kind: 'enemy-killed', x: 0, y: 0, defId: 'x', scrap: 1, elite: false })
    expect(elite.sound).not.toBe(grunt.sound)
    // "Bigger for elites": longer and at least as loud.
    expect(layersDuration(SOUNDS[elite.sound].layers)).toBeGreaterThan(
      layersDuration(SOUNDS[grunt.sound].layers),
    )
    expect(SOUNDS[elite.sound].gain).toBeGreaterThanOrEqual(SOUNDS[grunt.sound].gain)

    // A lethal hit is quieter, because the explosion in the same tick is the
    // feedback. Both still map to a real sound.
    const lethal = cueForEvent({ kind: 'enemy-hit', x: 0, y: 0, damage: 4, defId: 'x', lethal: true })
    const nonLethal = cueForEvent({ kind: 'enemy-hit', x: 0, y: 0, damage: 4, defId: 'x', lethal: false })
    expect(lethal.gain).toBeLessThan(nonLethal.gain)
  })

  it('scales with damage but saturates', () => {
    const small = cueForEvent({ kind: 'hull-hit', x: 0, y: 0, damage: 1, absorbedByShield: false })
    const big = cueForEvent({ kind: 'hull-hit', x: 0, y: 0, damage: 18, absorbedByShield: false })
    const absurd = cueForEvent({ kind: 'hull-hit', x: 0, y: 0, damage: 9999, absorbedByShield: false })
    expect(small.gain).toBeLessThan(big.gain)
    expect(absurd.gain).toBe(big.gain)
    expect(absurd.gain).toBeLessThanOrEqual(1.2)
  })

  it('pans within safe bounds for any x, including nonsense', () => {
    for (const x of [-500, 0, PLAYFIELD_W / 2, PLAYFIELD_W, 9999, Number.NaN, Number.POSITIVE_INFINITY]) {
      const pan = panForX(x)
      expect(Number.isFinite(pan)).toBe(true)
      // Never hard-panned: a fully-left explosion is disorienting and vanishes
      // on a phone speaker.
      expect(Math.abs(pan)).toBeLessThanOrEqual(0.55)
    }
    expect(panForX(PLAYFIELD_W / 2)).toBeCloseTo(0, 6)
    expect(panForX(0)).toBeLessThan(0)
    expect(panForX(PLAYFIELD_W)).toBeGreaterThan(0)
  })
})

describe('voice limiting', () => {
  /**
   * A storm: mixed events, a couple of milliseconds apart, like a screen clear.
   *
   * `hull-lost` is excluded because it deliberately cuts every quieter voice, so
   * repeating it 50 times would suppress the very overlap being measured. A run
   * ends once.
   */
  function storm(count: number): { backend: RecordingBackend; peak: number } {
    const { audio, backend } = recordingDirector()
    const kinds = SIM_EVENT_KINDS.filter((kind) => kind !== 'hull-lost')
    let peak = 0
    for (let i = 0; i < count; i++) {
      const kind = kinds[i % kinds.length]
      if (kind === undefined) continue
      audio.handleEvents([SAMPLE_EVENTS[kind]])
      peak = Math.max(peak, audio.activeVoices)
      expect(audio.activeVoices).toBeLessThanOrEqual(MAX_VOICES)
      backend.advance(0.002)
    }
    return { backend, peak }
  }

  it('never exceeds the cap when fed 500 events', () => {
    const { backend, peak } = storm(500)
    expect(peak).toBeLessThanOrEqual(MAX_VOICES)
    // Voices really are overlapping, so the invariant above is not vacuous. The
    // cap being *reached* is asserted directly in the priority test below.
    expect(peak).toBeGreaterThanOrEqual(6)
    // 500 events did not become 500 voices. Audio that allocates per event is a
    // memory leak with a soundtrack.
    expect(backend.started.length).toBeLessThan(200)
  })

  it('never exceeds the cap when 500 events arrive in a single tick', () => {
    // The other shape of the same problem: one tick, no time passing at all.
    const { audio, backend } = recordingDirector()
    const events: SimEvent[] = []
    for (let i = 0; i < 500; i++) {
      const kind = SIM_EVENT_KINDS[i % SIM_EVENT_KINDS.length]
      if (kind !== undefined) events.push(SAMPLE_EVENTS[kind])
    }
    audio.handleEvents(events)
    expect(audio.activeVoices).toBeLessThanOrEqual(MAX_VOICES)
    // With no time passing, the retrigger gap collapses the duplicates: at most
    // one voice per distinct sound, not five hundred.
    expect(backend.started.length).toBeLessThanOrEqual(SOUND_IDS.length)
  })

  it('respects per-category caps so one category cannot starve the rest', () => {
    const { backend, peak } = storm(400)
    expect(peak).toBeLessThanOrEqual(MAX_VOICES)
    for (const category of Object.keys(CATEGORY_VOICE_CAPS) as SoundCategory[]) {
      const cap = CATEGORY_VOICE_CAPS[category]
      // Count how many of this category's voices were ever simultaneously live.
      const voices = backend.startsIn(category)
      for (const probe of voices) {
        const overlapping = voices.filter(
          (other) =>
            other.startedAt <= probe.startedAt &&
            other.startedAt + other.request.duration > probe.startedAt &&
            (other.stoppedAt === null || other.stoppedAt > probe.startedAt),
        )
        expect(overlapping.length, `${category} exceeded its cap`).toBeLessThanOrEqual(cap)
      }
    }
  })

  it('drops the player weapon before it drops an alarm', () => {
    // The mix hierarchy expressed as survival: saturate the mixer with everything
    // that is not an alarm, then hit the hull. The hull hit must still be heard.
    const backend = new RecordingBackend()
    const mixer = new Mixer(backend)
    const filler: SoundId[] = [
      'impact.kill',
      'threat.enemyShot',
      'threat.telegraph',
      'pickup.scrap',
      'weapon.shot',
      'impact.killElite',
      'ui.confirm',
      'impact.hit',
      'ui.waveRelease',
      'ui.cancel',
    ]
    for (let i = 0; i < 400 && mixer.activeVoices < MAX_VOICES; i++) {
      const id = filler[i % filler.length]
      if (id !== undefined) mixer.play(id)
      backend.advance(0.004)
    }
    expect(mixer.activeVoices).toBe(MAX_VOICES)

    const before = backend.started.length
    expect(mixer.play('alarm.hullHit')).toBe(true)
    expect(backend.started.length).toBe(before + 1)
    expect(mixer.activeVoices).toBeLessThanOrEqual(MAX_VOICES)

    // Something lower-priority was cut to make room, and it was not another alarm.
    const stolen = backend.started.filter((voice) => voice.stoppedAt !== null)
    expect(stolen.length).toBeGreaterThan(0)
    for (const voice of stolen) {
      expect(SOUNDS[voice.request.id].priority).toBeLessThan(SOUNDS['alarm.hullHit'].priority)
    }
  })

  it('cuts lesser voices when the run ends', () => {
    const { audio, backend } = recordingDirector()
    audio.handleEvents([SAMPLE_EVENTS['player-shot']])
    const shot = backend.startsOf('weapon.shot')[0]
    expect(shot).toBeDefined()
    audio.handleEvents([SAMPLE_EVENTS['hull-lost']])
    expect(shot?.stoppedAt).not.toBeNull()
    expect(backend.startsOf('alarm.hullLost').length).toBe(1)
  })
})

describe('the twenty-shots-per-second problem', () => {
  it('keeps the weapon the quietest and most expendable thing in the game', () => {
    // The decision, locked down: the gun is feedback that the trigger is held,
    // and the player already knows that. Changing this should require changing a
    // test, deliberately.
    for (const category of Object.keys(DEFAULT_CATEGORY_VOLUMES) as SoundCategory[]) {
      if (category === 'weapon') continue
      expect(DEFAULT_CATEGORY_VOLUMES.weapon).toBeLessThan(DEFAULT_CATEGORY_VOLUMES[category])
    }
    for (const id of SOUND_IDS) {
      if (id === 'weapon.shot') continue
      expect(SOUNDS['weapon.shot'].priority).toBeLessThan(SOUNDS[id].priority)
    }
    // The four sounds a player must react to sit above everything they cause.
    for (const reactive of ['alarm.hullHit', 'alarm.shieldBroken', 'threat.telegraph', 'threat.enemyShot'] as const) {
      expect(SOUNDS[reactive].priority).toBeGreaterThan(SOUNDS['impact.hit'].priority)
      expect(SOUNDS[reactive].priority).toBeGreaterThan(SOUNDS['weapon.shot'].priority)
    }
  })

  it('varies consecutive shots instead of retriggering one identical click', () => {
    const { audio, backend } = recordingDirector()
    // 20 shots/second is one every three ticks at 60Hz.
    const shotInterval = 3 / TICK_HZ
    for (let i = 0; i < 40; i++) {
      audio.handleEvents([SAMPLE_EVENTS['player-shot']])
      backend.advance(shotInterval)
    }
    const shots = backend.startsOf('weapon.shot')
    // Real fire rate is not being throttled away — the sound is quiet, not absent.
    expect(shots.length).toBe(40)

    const pitches = new Set(shots.map((voice) => voice.request.pitch))
    const gains = new Set(shots.map((voice) => voice.request.gain))
    expect(pitches.size).toBeGreaterThanOrEqual(4)
    expect(gains.size).toBeGreaterThanOrEqual(4)
    // Consecutive shots always differ, which a random draw would not guarantee.
    for (let i = 1; i < shots.length; i++) {
      expect(shots[i]?.request.pitch).not.toBe(shots[i - 1]?.request.pitch)
    }
    // Detune stays subtle: this is a mechanism cycling, not a melody.
    for (const voice of shots) {
      expect(voice.request.pitch).toBeGreaterThan(0.9)
      expect(voice.request.pitch).toBeLessThan(1.1)
    }
  })

  it('caps weapon overlap even at an absurd fire rate', () => {
    const { audio, backend } = recordingDirector()
    for (let i = 0; i < 200; i++) {
      audio.handleEvents([SAMPLE_EVENTS['player-shot']])
      backend.advance(0.001)
      expect(audio.activeVoices).toBeLessThanOrEqual(SOUNDS['weapon.shot'].maxVoices)
    }
  })
})

describe('unlock', () => {
  it('is idempotent and safe when already running', () => {
    const backend = new RecordingBackend({ state: 'suspended' })
    const audio = new AudioDirector(backend)

    // Before a gesture: nothing plays. This is the iOS case — a context created
    // at page load is silently muted, so the audio layer refuses to pretend.
    expect(audio.unlocked).toBe(false)
    expect(audio.play('ui.confirm')).toBe(false)
    expect(backend.started.length).toBe(0)

    audio.unlock()
    expect(audio.unlocked).toBe(true)
    expect(audio.play('ui.confirm')).toBe(true)

    for (let i = 0; i < 10; i++) audio.unlock()
    expect(audio.unlocked).toBe(true)
    expect(backend.unlockCalls).toBe(11)
    // Repeated unlocking must not reset or duplicate anything.
    backend.advance(1)
    expect(audio.play('ui.confirm')).toBe(true)
  })

  it('is safe to call when there is nothing to unlock', () => {
    const audio = createAudioDirector()
    for (let i = 0; i < 5; i++) expect(() => audio.unlock()).not.toThrow()
    expect(audio.unlocked).toBe(false)
  })

  it('does not advance variation or retrigger timers while locked', () => {
    // Otherwise the first audible shot after a gesture would start mid-rotation
    // and, worse, could be blocked by a retrigger gap set while muted.
    const backend = new RecordingBackend({ state: 'suspended' })
    const audio = new AudioDirector(backend)
    for (let i = 0; i < 50; i++) audio.handleEvents([SAMPLE_EVENTS['player-shot']])
    audio.unlock()
    expect(audio.play('weapon.shot')).toBe(true)
    expect(backend.startsOf('weapon.shot')[0]?.request.pitch).toBe(
      SOUNDS['weapon.shot'].pitchRotation[0],
    )
  })
})

describe('mute', () => {
  it('starts no voices at all while muted', () => {
    const { audio, backend } = recordingDirector()
    audio.setMuted(true)
    expect(audio.muted).toBe(true)
    for (let i = 0; i < 200; i++) {
      const kind = SIM_EVENT_KINDS[i % SIM_EVENT_KINDS.length]
      if (kind !== undefined) audio.handleEvents([SAMPLE_EVENTS[kind]])
      backend.advance(0.005)
    }
    audio.confirm()
    audio.observe(fakeView({ tick: 9, enemies: [fakeEnemy({ telegraphTicks: 20, telegraphTotal: 24 })] }))
    expect(backend.started.length).toBe(0)
    expect(audio.activeVoices).toBe(0)
    // Belt and braces: the output is also gained to zero, so anything already
    // ringing when mute was pressed stops too.
    expect(backend.masterGain).toBe(0)
  })

  it('silences voices that were already sounding', () => {
    const { audio, backend } = recordingDirector()
    audio.handleEvents([SAMPLE_EVENTS['enemy-killed']])
    const kill = backend.startsOf('impact.kill')[0]
    expect(kill).toBeDefined()
    audio.setMuted(true)
    expect(kill?.stoppedAt).not.toBeNull()
  })

  it('restores the previous master level on unmute', () => {
    const { audio, backend } = recordingDirector()
    audio.setMasterVolume(0.4)
    audio.setMuted(true)
    expect(backend.masterGain).toBe(0)
    audio.setMuted(false)
    expect(backend.masterGain).toBeCloseTo(0.4, 6)
    expect(audio.play('ui.confirm')).toBe(true)
  })
})

describe('gain structure', () => {
  it('has sane defaults', () => {
    expect(DEFAULT_MASTER_VOLUME).toBeGreaterThan(0)
    expect(DEFAULT_MASTER_VOLUME).toBeLessThanOrEqual(1)
    for (const category of Object.keys(DEFAULT_CATEGORY_VOLUMES) as SoundCategory[]) {
      const volume = DEFAULT_CATEGORY_VOLUMES[category]
      expect(volume).toBeGreaterThan(0)
      expect(volume).toBeLessThanOrEqual(1)
    }
    for (const id of SOUND_IDS) {
      const def = SOUNDS[id]
      expect(def.gain).toBeGreaterThan(0)
      expect(def.gain).toBeLessThanOrEqual(1)
      expect(def.layers.length).toBeGreaterThan(0)
      expect(layersDuration(def.layers)).toBeGreaterThan(0)
      // Under two seconds: every one of these is an event, not a piece of music.
      expect(layersDuration(def.layers)).toBeLessThan(2)
    }
  })

  it('cannot be pushed to a clipping level by any input', () => {
    const backend = new RecordingBackend()
    const mixer = new Mixer(backend)
    const hostile = [5, 100, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e9]

    for (const value of hostile) {
      mixer.setMasterVolume(value)
      expect(mixer.masterVolume).toBeGreaterThanOrEqual(0)
      expect(mixer.masterVolume).toBeLessThanOrEqual(1)
      expect(Number.isFinite(mixer.masterVolume)).toBe(true)

      for (const category of Object.keys(DEFAULT_CATEGORY_VOLUMES) as SoundCategory[]) {
        mixer.setCategoryVolume(category, value)
        const volume = mixer.categoryVolume(category)
        expect(Number.isFinite(volume)).toBe(true)
        expect(volume).toBeGreaterThanOrEqual(0)
        expect(volume).toBeLessThanOrEqual(1)
      }

      for (const id of SOUND_IDS) {
        mixer.play(id, { gain: 1e6, pitch: 1e6, timeScale: 1e6, pan: 1e6 })
        backend.advance(2)
      }
    }

    for (const master of backend.masterGains) {
      expect(Number.isFinite(master)).toBe(true)
      expect(master).toBeGreaterThanOrEqual(0)
      expect(master).toBeLessThanOrEqual(1)
    }
    expect(backend.started.length).toBeGreaterThan(0)
    for (const voice of backend.started) {
      expect(Number.isFinite(voice.request.gain)).toBe(true)
      expect(voice.request.gain).toBeGreaterThan(0)
      expect(voice.request.gain).toBeLessThanOrEqual(VOICE_PEAK_CEILING)
      // Pitch and time scaling are bounded too: an unbounded pitch is an
      // inaudible or eardrum-threatening oscillator, and an unbounded timeScale
      // is a voice that occupies a slot forever.
      expect(voice.request.pitch).toBeLessThanOrEqual(4)
      expect(voice.request.pitch).toBeGreaterThanOrEqual(0.25)
      expect(voice.request.timeScale).toBeLessThanOrEqual(4)
      expect(Math.abs(voice.request.pan)).toBeLessThanOrEqual(1)
      expect(voice.request.duration).toBeGreaterThan(0)
    }
  })

  it('keeps a single voice inside the output range at default levels', () => {
    // Layers sum inside a voice, so a recipe with four loud layers can clip on
    // its own even with a legal voice gain. The master limiter is a safety net,
    // not an excuse.
    for (const id of SOUND_IDS) {
      const sum = SOUNDS[id].layers.reduce((total, layer) => total + layer.gain, 0)
      expect(sum * VOICE_PEAK_CEILING * DEFAULT_MASTER_VOLUME, `${id} sums too hot`).toBeLessThanOrEqual(1)
    }
  })

  it('lets each category be turned down independently', () => {
    const { audio, backend } = recordingDirector()
    audio.setCategoryVolume('weapon', 0)
    audio.handleEvents([SAMPLE_EVENTS['player-shot'], SAMPLE_EVENTS['enemy-shot']])
    expect(backend.startsOf('weapon.shot').length).toBe(0)
    expect(backend.startsOf('threat.enemyShot').length).toBe(1)
    expect(audio.categoryVolume('weapon')).toBe(0)
    expect(audio.categoryVolume('threat')).toBe(DEFAULT_CATEGORY_VOLUMES.threat)
  })
})

describe('telegraph', () => {
  it('fires once on the rising edge of a windup and again on the next one', () => {
    const { audio, backend } = recordingDirector()
    const enemy = fakeEnemy({ telegraphTicks: 24, telegraphTotal: 24 })

    audio.observe(fakeView({ tick: 1, enemies: [enemy] }))
    expect(backend.startsOf('threat.telegraph').length).toBe(1)

    // Counting down through the windup must not retrigger it.
    for (let tick = 2; tick <= 24; tick++) {
      enemy.telegraphTicks = 25 - tick
      backend.advance(1 / TICK_HZ)
      audio.observe(fakeView({ tick, enemies: [enemy] }))
    }
    expect(backend.startsOf('threat.telegraph').length).toBe(1)

    // Windup over, then a new volley starts: that is a second cue.
    enemy.telegraphTicks = 0
    audio.observe(fakeView({ tick: 25, enemies: [enemy] }))
    enemy.telegraphTicks = 24
    backend.advance(1)
    audio.observe(fakeView({ tick: 26, enemies: [enemy] }))
    expect(backend.startsOf('threat.telegraph').length).toBe(2)
  })

  it('stretches the cue to the length of the windup', () => {
    const { audio, backend } = recordingDirector()
    audio.observe(fakeView({ tick: 1, enemies: [fakeEnemy({ telegraphTicks: 60, telegraphTotal: 60 })] }))
    const long = backend.startsOf('threat.telegraph')[0]
    expect(long).toBeDefined()
    // A 60-tick windup is one second, so the cue must end roughly when the shot
    // arrives — a telegraph that finishes early stops being a countdown.
    expect(long?.request.duration).toBeGreaterThan(0.8)
    expect(long?.request.duration).toBeLessThan(1.3)
  })

  it('does nothing for enemies that are not winding up', () => {
    const { audio, backend } = recordingDirector()
    audio.observe(fakeView({ tick: 1, enemies: [fakeEnemy(), fakeEnemy({ x: 300 })] }))
    expect(backend.startsOf('threat.telegraph').length).toBe(0)
  })
})

describe('per-tick draining', () => {
  it('ignores a second observe() for the same tick', () => {
    // SimEvents are cleared per tick but still present between ticks, so a
    // per-frame caller would otherwise hear the same volley several times.
    const { audio, backend } = recordingDirector()
    const view = fakeView({ tick: 7, events: [SAMPLE_EVENTS['enemy-shot']] })
    audio.observe(view)
    backend.advance(1)
    audio.observe(view)
    backend.advance(1)
    audio.observe(view)
    expect(backend.startsOf('threat.enemyShot').length).toBe(1)
  })

  it('plays the events of every tick as ticks advance', () => {
    const { audio, backend } = recordingDirector()
    for (let tick = 1; tick <= 5; tick++) {
      audio.observe(fakeView({ tick, events: [SAMPLE_EVENTS['enemy-shot']] }))
      backend.advance(1)
    }
    expect(backend.startsOf('threat.enemyShot').length).toBe(5)
  })
})
