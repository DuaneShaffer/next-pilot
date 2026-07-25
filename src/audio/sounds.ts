/**
 * The sound library: what each cue actually is, and how loud it is allowed to be
 * relative to everything else.
 *
 * TONE (docs/DESIGN.md — deadpan institutional): relays, contactors, vents,
 * compressors, load-bearing metal. Nothing is musical, nothing is cute, nothing
 * resolves. Pitched layers exist to give a sound a *body*, not a note, which is
 * why they nearly all sweep — a steady tone reads as music, a sliding one reads
 * as machinery under load.
 *
 * MIXING IS LEGIBILITY, NOT TASTE. `docs/UI.md` rule 3 says colour is
 * information: `danger` means "can hurt you this instant" and nothing else may
 * use it. This file applies the same rule to loudness. The things a player must
 * react to — incoming fire, a windup, a shield failing, a hull hit — sit at the
 * top of the mix, and the thing that happens twenty times a second sits at the
 * bottom. The categories *are* that hierarchy:
 *
 *   alarm   1.00   something just went wrong to you. Never masked.
 *   threat  0.95   something is about to. Enemy fire and telegraphs.
 *   impact  0.62   your damage landing. Confirmation, not warning.
 *   ui      0.60   your own menu input, only outside a sortie.
 *   pickup  0.50   reward. Pleasant, ignorable.
 *   weapon  0.26   your gun. Deliberately the quietest thing in the game.
 *
 * The weapon number is the load-bearing one. See `weapon.shot` below.
 */

import { layer, type Layer } from './backend'

export type SoundCategory = 'weapon' | 'impact' | 'threat' | 'alarm' | 'pickup' | 'ui'

export type SoundId =
  | 'weapon.shot'
  | 'impact.hit'
  | 'impact.kill'
  | 'impact.killElite'
  | 'threat.enemyShot'
  | 'threat.telegraph'
  | 'alarm.shieldAbsorb'
  | 'alarm.shieldBroken'
  | 'alarm.hullHit'
  | 'alarm.hullLost'
  | 'pickup.scrap'
  | 'ui.confirm'
  | 'ui.cancel'
  | 'ui.waveRelease'

export interface SoundDef {
  readonly category: SoundCategory
  /**
   * Survival rank when voices are scarce. Higher wins.
   *
   * This is the mix hierarchy again, expressed as *what gets dropped* rather
   * than what gets turned down. Under a screen-clearing explosion the player's
   * own gun is the first thing to go and a hull hit is the last.
   */
  readonly priority: number
  /** Peak amplitude within its category, 0..1. */
  readonly gain: number
  /**
   * Minimum seconds between two starts of this same sound.
   *
   * The real defence against event storms. One tick can legitimately contain
   * thirty `enemy-killed` events; thirty simultaneous explosions is not thirty
   * times the information, it is mud plus a clipped output stage.
   */
  readonly minGapSec: number
  /** Hard cap on concurrent instances of this one sound. */
  readonly maxVoices: number
  /**
   * Pitch multipliers cycled through on successive plays.
   *
   * Repetition is what makes a game sound cheap; identical repetition is what
   * makes it unbearable. A rotation is used rather than a random draw because
   * random detune occasionally repeats the same value twice in a row, which is
   * exactly the artefact being avoided.
   */
  readonly pitchRotation: readonly number[]
  /** Amplitude multipliers cycled through on successive plays. */
  readonly gainRotation: readonly number[]
  readonly layers: readonly Layer[]
}

const NO_ROTATION: readonly number[] = [1]

export const SOUNDS: Record<SoundId, SoundDef> = {
  /**
   * THE 20-SHOTS-PER-SECOND PROBLEM.
   *
   * `SHOTS_PER_SECOND` is 20 (60Hz / 3-tick interval), and the weapon is
   * always firing. A full-volume click twenty times a second is torture inside
   * ten seconds, so this recipe is attacked from five directions at once:
   *
   *  1. It is the quietest category in the game (0.26). The gun is feedback
   *     that the trigger is down, and the player already knows that.
   *  2. It is 25ms long and mostly a filtered noise transient. Broadband clicks
   *     fatigue far less than pitched blips, which stack into a buzzing drone at
   *     20Hz repetition.
   *  3. A 4-step pitch rotation (±6%) plus a 4-step amplitude rotation means the
   *     ear hears a mechanism cycling rather than one sample retriggering.
   *  4. `maxVoices: 3` — at 50ms between shots and a 25ms tail, three is already
   *     more overlap than can happen in practice; it is the guard against a
   *     future fire-rate item, not against the base weapon.
   *  5. Priority 10, the lowest in the game. When anything at all is competing
   *     for a voice slot, the gun loses.
   */
  'weapon.shot': {
    category: 'weapon',
    priority: 10,
    gain: 1,
    minGapSec: 0.028,
    maxVoices: 3,
    pitchRotation: [1, 1.06, 0.965, 1.03],
    gainRotation: [1, 0.86, 0.94, 0.8],
    layers: [
      // Contact click: the relay closing, not the shot leaving.
      layer({
        source: 'noise',
        gain: 0.5,
        attack: 0.0005,
        hold: 0.002,
        release: 0.012,
        filter: 'highpass',
        filterFreq: 2600,
        filterQ: 0.7,
      }),
      layer({
        source: 'square',
        freq: 520,
        freqEnd: 190,
        gain: 0.5,
        attack: 0.001,
        hold: 0.004,
        release: 0.02,
        filter: 'bandpass',
        filterFreq: 1400,
        filterFreqEnd: 600,
        filterQ: 3.5,
      }),
    ],
  },

  /** Your round connecting. Dry and short — the kill carries the weight. */
  'impact.hit': {
    category: 'impact',
    priority: 30,
    gain: 0.7,
    minGapSec: 0.03,
    maxVoices: 4,
    pitchRotation: [1, 1.04, 0.97],
    gainRotation: [1, 0.9],
    layers: [
      layer({
        source: 'noise',
        gain: 0.6,
        attack: 0.001,
        hold: 0.004,
        release: 0.03,
        filter: 'bandpass',
        filterFreq: 1100,
        filterFreqEnd: 800,
        filterQ: 1.6,
      }),
      layer({
        source: 'triangle',
        freq: 240,
        freqEnd: 150,
        gain: 0.4,
        hold: 0.008,
        release: 0.05,
      }),
    ],
  },

  /** Decompression: a vent closing over 240ms, with a low thud under it. */
  'impact.kill': {
    category: 'impact',
    priority: 50,
    gain: 0.9,
    minGapSec: 0.05,
    maxVoices: 4,
    pitchRotation: [1, 1.05, 0.93, 0.98],
    gainRotation: [1, 0.88],
    layers: [
      layer({
        source: 'noise',
        gain: 0.8,
        attack: 0.002,
        hold: 0.03,
        release: 0.21,
        filter: 'lowpass',
        filterFreq: 1900,
        filterFreqEnd: 220,
        filterQ: 0.9,
      }),
      layer({ source: 'sine', freq: 95, freqEnd: 38, gain: 0.7, attack: 0.003, hold: 0.02, release: 0.18 }),
      layer({
        source: 'square',
        freq: 300,
        freqEnd: 120,
        gain: 0.16,
        hold: 0.008,
        release: 0.05,
        filter: 'bandpass',
        filterFreq: 900,
        filterQ: 2.5,
      }),
    ],
  },

  /**
   * An elite is a structure failing, not a hull popping: longer, lower, with a
   * sawtooth groan and a secondary detonation 160ms in. Louder and higher
   * priority so it is never the voice that gets stolen during a big clear.
   */
  'impact.killElite': {
    category: 'impact',
    priority: 62,
    gain: 1,
    minGapSec: 0.06,
    maxVoices: 2,
    pitchRotation: [1, 0.96],
    gainRotation: NO_ROTATION,
    layers: [
      layer({
        source: 'noise',
        gain: 0.85,
        attack: 0.003,
        hold: 0.05,
        release: 0.36,
        filter: 'lowpass',
        filterFreq: 2800,
        filterFreqEnd: 140,
        filterQ: 0.8,
      }),
      layer({ source: 'sine', freq: 80, freqEnd: 26, gain: 0.75, attack: 0.004, hold: 0.04, release: 0.34 }),
      layer({
        source: 'sawtooth',
        freq: 150,
        freqEnd: 45,
        gain: 0.3,
        attack: 0.01,
        hold: 0.04,
        release: 0.3,
        filter: 'lowpass',
        filterFreq: 900,
        filterFreqEnd: 160,
        filterQ: 1.2,
      }),
      layer({
        source: 'noise',
        gain: 0.35,
        delay: 0.16,
        attack: 0.002,
        hold: 0.01,
        release: 0.09,
        filter: 'highpass',
        filterFreq: 1800,
        filterQ: 0.7,
      }),
    ],
  },

  /**
   * Incoming fire. Lower and hollower than the player's shot, with a resonant
   * bandpass ring so it is unmistakably *not* yours even at four times the
   * player weapon's level. This is one of the four sounds that must always cut
   * through, so it lives in `threat`.
   */
  'threat.enemyShot': {
    category: 'threat',
    priority: 74,
    gain: 0.75,
    minGapSec: 0.02,
    maxVoices: 4,
    pitchRotation: [1, 1.05, 0.95, 1.02],
    gainRotation: [1, 0.9, 0.95],
    layers: [
      layer({
        source: 'square',
        freq: 300,
        freqEnd: 130,
        gain: 0.5,
        attack: 0.001,
        hold: 0.008,
        release: 0.05,
        filter: 'bandpass',
        filterFreq: 1150,
        filterFreqEnd: 700,
        filterQ: 6,
      }),
      layer({
        source: 'noise',
        gain: 0.3,
        attack: 0.001,
        hold: 0.003,
        release: 0.02,
        filter: 'bandpass',
        filterFreq: 900,
        filterQ: 1.2,
      }),
    ],
  },

  /**
   * The windup. A capacitor charging: the only *rising, sustained* sound in the
   * game, which is what makes it identifiable while the player is looking
   * somewhere else — which is the entire point of an audio telegraph.
   *
   * Written for a 0.4s windup (defs use 22–30 ticks) and stretched per enemy via
   * `timeScale`, so the sound ends exactly when the shot arrives.
   */
  'threat.telegraph': {
    category: 'threat',
    priority: 80,
    gain: 0.8,
    minGapSec: 0.05,
    maxVoices: 3,
    pitchRotation: [1, 1.03, 0.97],
    gainRotation: [1, 0.94],
    layers: [
      layer({ source: 'sine', freq: 190, freqEnd: 560, gain: 0.5, attack: 0.12, hold: 0.16, release: 0.07 }),
      layer({
        source: 'noise',
        gain: 0.28,
        attack: 0.18,
        hold: 0.1,
        release: 0.06,
        filter: 'bandpass',
        filterFreq: 1500,
        filterFreqEnd: 3200,
        filterQ: 4,
      }),
    ],
  },

  /** Held by the shield: bright, glassy, and rising — nothing got through. */
  'alarm.shieldAbsorb': {
    category: 'alarm',
    priority: 70,
    gain: 0.8,
    minGapSec: 0.03,
    maxVoices: 3,
    pitchRotation: [1, 1.04, 0.98],
    gainRotation: [1, 0.92],
    layers: [
      layer({
        source: 'noise',
        gain: 0.6,
        attack: 0.001,
        hold: 0.006,
        release: 0.05,
        filter: 'bandpass',
        filterFreq: 3000,
        filterFreqEnd: 2200,
        filterQ: 2.5,
      }),
      layer({ source: 'triangle', freq: 760, freqEnd: 900, gain: 0.28, hold: 0.006, release: 0.04 }),
    ],
  },

  /**
   * Two descending relays 90ms apart plus a crack — a system dropping offline.
   * The only two-stroke sound in the mix, so it cannot be confused with a hit.
   * `maxVoices: 1`: a doubled shield-break is a lie about what happened.
   */
  'alarm.shieldBroken': {
    category: 'alarm',
    priority: 88,
    gain: 1,
    minGapSec: 0.12,
    maxVoices: 1,
    pitchRotation: NO_ROTATION,
    gainRotation: NO_ROTATION,
    layers: [
      layer({
        source: 'noise',
        gain: 0.55,
        attack: 0.001,
        hold: 0.008,
        release: 0.06,
        filter: 'highpass',
        filterFreq: 2400,
        filterQ: 0.8,
      }),
      layer({
        source: 'square',
        freq: 880,
        gain: 0.42,
        attack: 0.002,
        hold: 0.04,
        release: 0.04,
        filter: 'bandpass',
        filterFreq: 1800,
        filterQ: 2,
      }),
      layer({
        source: 'square',
        freq: 620,
        gain: 0.42,
        delay: 0.09,
        attack: 0.002,
        hold: 0.04,
        release: 0.05,
        filter: 'bandpass',
        filterFreq: 1500,
        filterQ: 2,
      }),
      layer({ source: 'sine', freq: 120, freqEnd: 70, gain: 0.32, attack: 0.004, hold: 0.03, release: 0.18 }),
    ],
  },

  /**
   * Integrity gone, not deflected. The loudest single event in the game: a low
   * square slammed through a closing lowpass, with broadband noise and a metal
   * overtone. Priority 90 — above everything except the run ending.
   */
  'alarm.hullHit': {
    category: 'alarm',
    priority: 90,
    gain: 1,
    minGapSec: 0.04,
    maxVoices: 3,
    pitchRotation: [1, 0.97, 1.03],
    gainRotation: [1, 0.95],
    layers: [
      layer({
        source: 'square',
        freq: 150,
        freqEnd: 60,
        gain: 0.7,
        attack: 0.001,
        hold: 0.02,
        release: 0.13,
        filter: 'lowpass',
        filterFreq: 1200,
        filterFreqEnd: 300,
        filterQ: 1,
      }),
      layer({
        source: 'noise',
        gain: 0.55,
        attack: 0.001,
        hold: 0.01,
        release: 0.09,
        filter: 'lowpass',
        filterFreq: 900,
        filterQ: 0.8,
      }),
      layer({ source: 'triangle', freq: 420, freqEnd: 300, gain: 0.22, hold: 0.004, release: 0.06 }),
    ],
  },

  /**
   * The run ending. A 900ms power-down: sawtooth falling two octaves through a
   * closing filter, a sub under it, and one final relay clunk at 460ms — the
   * company logging the incident. Top priority, and the director cuts everything
   * quieter when it plays, because nothing else matters at that point.
   */
  'alarm.hullLost': {
    category: 'alarm',
    priority: 100,
    gain: 1,
    minGapSec: 0.5,
    maxVoices: 1,
    pitchRotation: NO_ROTATION,
    gainRotation: NO_ROTATION,
    layers: [
      layer({
        source: 'sawtooth',
        freq: 230,
        freqEnd: 30,
        gain: 0.55,
        attack: 0.01,
        hold: 0.18,
        release: 0.6,
        filter: 'lowpass',
        filterFreq: 1700,
        filterFreqEnd: 90,
        filterQ: 0.9,
      }),
      layer({
        source: 'noise',
        gain: 0.5,
        attack: 0.004,
        hold: 0.1,
        release: 0.5,
        filter: 'lowpass',
        filterFreq: 1400,
        filterFreqEnd: 120,
        filterQ: 0.8,
      }),
      layer({ source: 'sine', freq: 60, freqEnd: 24, gain: 0.45, attack: 0.01, hold: 0.3, release: 0.5 }),
      layer({
        source: 'square',
        freq: 300,
        freqEnd: 90,
        gain: 0.28,
        delay: 0.46,
        attack: 0.002,
        hold: 0.03,
        release: 0.12,
        filter: 'bandpass',
        filterFreq: 700,
        filterQ: 3,
      }),
    ],
  },

  /**
   * A tally mark. Two short pips through a narrow bandpass — a mechanical
   * counter incrementing, which is exactly what collecting scrap is to the
   * Salvage Division. The rotation climbs five semitones and resets, so a stream
   * of pickups reads as a total going up rather than as one sound repeating.
   */
  'pickup.scrap': {
    category: 'pickup',
    priority: 40,
    gain: 0.6,
    minGapSec: 0.035,
    maxVoices: 3,
    pitchRotation: [1, 1.059, 1.122, 1.189, 1.26],
    gainRotation: [1, 0.93],
    layers: [
      layer({
        source: 'square',
        freq: 1560,
        gain: 0.32,
        attack: 0.001,
        hold: 0.008,
        release: 0.03,
        filter: 'bandpass',
        filterFreq: 2200,
        filterQ: 4,
      }),
      layer({
        source: 'square',
        freq: 2080,
        gain: 0.24,
        delay: 0.028,
        attack: 0.001,
        hold: 0.006,
        release: 0.025,
        filter: 'bandpass',
        filterFreq: 2600,
        filterQ: 4,
      }),
    ],
  },

  /** A form being stamped: click, contact, and a low thunk landing under it. */
  'ui.confirm': {
    category: 'ui',
    priority: 85,
    gain: 0.8,
    minGapSec: 0.06,
    maxVoices: 2,
    pitchRotation: NO_ROTATION,
    gainRotation: NO_ROTATION,
    layers: [
      layer({
        source: 'noise',
        gain: 0.4,
        attack: 0.0005,
        hold: 0.002,
        release: 0.012,
        filter: 'highpass',
        filterFreq: 1800,
        filterQ: 0.7,
      }),
      layer({
        source: 'square',
        freq: 900,
        gain: 0.32,
        attack: 0.001,
        hold: 0.012,
        release: 0.03,
        filter: 'bandpass',
        filterFreq: 1600,
        filterQ: 3,
      }),
      layer({ source: 'sine', freq: 130, freqEnd: 110, gain: 0.42, delay: 0.02, hold: 0.02, release: 0.09 }),
    ],
  },

  /** The same mechanism run backwards: down instead of up, no stamp. */
  'ui.cancel': {
    category: 'ui',
    priority: 84,
    gain: 0.7,
    minGapSec: 0.06,
    maxVoices: 2,
    pitchRotation: NO_ROTATION,
    gainRotation: NO_ROTATION,
    layers: [
      layer({
        source: 'square',
        freq: 420,
        freqEnd: 300,
        gain: 0.32,
        attack: 0.002,
        hold: 0.02,
        release: 0.05,
        filter: 'bandpass',
        filterFreq: 900,
        filterQ: 3,
      }),
      layer({ source: 'sine', freq: 110, freqEnd: 80, gain: 0.38, delay: 0.01, hold: 0.02, release: 0.08 }),
    ],
  },

  /**
   * A wave releasing: a distant door opening somewhere in the wreck. Low,
   * unhurried, and quiet enough to sit underneath combat — it is context, not a
   * cue to react to, so it must never compete with `threat`.
   */
  'ui.waveRelease': {
    category: 'ui',
    priority: 45,
    gain: 0.65,
    minGapSec: 0.2,
    maxVoices: 1,
    pitchRotation: [1, 0.98, 1.02],
    gainRotation: NO_ROTATION,
    layers: [
      layer({ source: 'sine', freq: 78, freqEnd: 52, gain: 0.6, attack: 0.004, hold: 0.06, release: 0.22 }),
      layer({
        source: 'noise',
        gain: 0.28,
        attack: 0.02,
        hold: 0.05,
        release: 0.2,
        filter: 'lowpass',
        filterFreq: 700,
        filterFreqEnd: 260,
        filterQ: 0.8,
      }),
      layer({
        source: 'square',
        freq: 210,
        freqEnd: 150,
        gain: 0.16,
        delay: 0.05,
        attack: 0.002,
        hold: 0.02,
        release: 0.1,
        filter: 'bandpass',
        filterFreq: 600,
        filterQ: 4,
      }),
    ],
  },
}

/** Every sound id, iterable at runtime. Total by construction — see `SOUNDS`. */
export const SOUND_IDS = Object.keys(SOUNDS) as readonly SoundId[]

/**
 * Default category levels. This is the mix hierarchy in one object — see the
 * file header for why each number is where it is.
 */
export const DEFAULT_CATEGORY_VOLUMES: Record<SoundCategory, number> = {
  alarm: 1,
  threat: 0.95,
  impact: 0.62,
  ui: 0.6,
  pickup: 0.5,
  weapon: 0.26,
}

/**
 * Per-category concurrency caps, checked before the global cap.
 *
 * Without these, one category can starve the rest even while respecting the
 * global limit: eight simultaneous explosions would occupy half the voices and
 * the hull hit that killed you would be competing for what was left.
 */
export const CATEGORY_VOICE_CAPS: Record<SoundCategory, number> = {
  weapon: 3,
  impact: 5,
  threat: 5,
  alarm: 4,
  pickup: 3,
  ui: 2,
}

/**
 * Global concurrent voice cap.
 *
 * 16 is chosen against the worst real case rather than a round number: a
 * screen-clearing hit can produce ~12 kills, ~12 hits and a hull hit in one
 * tick, and the cap has to make that legible rather than reproduce it. Voice
 * allocation must be bounded — audio that allocates per event is a memory leak
 * with a soundtrack.
 */
export const MAX_VOICES = 16

/**
 * Hard ceiling on any single voice's gain, before the master level.
 *
 * With up to 16 voices summing into one output, per-voice headroom is the
 * difference between loud and clipped. The master chain also compresses, but a
 * limiter is a safety net, not a mix decision.
 */
export const VOICE_PEAK_CEILING = 0.7

/** Default master level. Low on purpose: 16 voices can sum. */
export const DEFAULT_MASTER_VOLUME = 0.55
