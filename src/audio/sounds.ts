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
 *   alarm   1.00   you must act on this now. Never masked.
 *   threat  0.95   something is about to hurt you. Enemy fire and telegraphs.
 *   impact  0.62   your damage landing. Confirmation, not warning.
 *   ui      0.60   your own menu input, and run structure.
 *   pickup  0.50   reward. Pleasant, ignorable.
 *   weapon  0.26   your gun. Deliberately the quietest thing in the game.
 *
 * The weapon number is the load-bearing one. See `weapon.shot` below.
 *
 * THESE NUMBERS ARE NOW MEASURED, not asserted. `npm run audio` renders every cue
 * through the real backend and reports its loudness in LUFS, and the ordering
 * above is checked against what comes out rather than against itself. Two things
 * that broke silently before that instrument existed, and that anyone editing this
 * file needs to know:
 *
 *  1. A recipe's *layer* gains are a second gain stage. `category × gain` sets the
 *     intent; the layers decide what actually leaves the voice. A recipe whose
 *     layers sum to 0.5 will be 10dB below one whose layers sum to 1.6 at the same
 *     nominal gain. Retune `gain` against a measured render, never by eye.
 *  2. `VOICE_PEAK_CEILING` used to be applied as a clamp, which pinned six of the
 *     loudest sounds to the identical value and flattened the top half of this
 *     hierarchy into a straight line. It is now a scale factor. See `Mixer.play`.
 */

import { layer, type Layer } from './backend'

export type SoundCategory = 'weapon' | 'impact' | 'threat' | 'alarm' | 'pickup' | 'ui'

export type SoundId =
  | 'weapon.shot'
  | 'impact.hit'
  | 'impact.kill'
  | 'impact.killElite'
  | 'impact.bossKilled'
  | 'threat.enemyShot'
  | 'threat.telegraph'
  | 'threat.bossSpawn'
  | 'threat.bossPhase'
  | 'threat.hazardFired'
  | 'alarm.hazardWarning'
  | 'alarm.shieldAbsorb'
  | 'alarm.shieldBroken'
  | 'alarm.hullHit'
  | 'alarm.hullLost'
  | 'pickup.scrap'
  | 'ui.confirm'
  | 'ui.cancel'
  | 'ui.waveRelease'
  | 'ui.stageCleared'

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

  /**
   * Decompression: a vent closing, with a low thud under it.
   *
   * Retuned against the render. It had 90% of its energy below 150 Hz — a laptop
   * heard almost none of it — and its brightness sat 0.70 octaves from
   * `alarm.hullHit`, which is the one pair in the game a player must never
   * confuse: "I killed something" against "something hit me". The vent is now
   * brighter and longer and the hull hit is darker and shorter, so the two
   * separate on both axes at once.
   */
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
        hold: 0.035,
        release: 0.26,
        filter: 'lowpass',
        filterFreq: 2600,
        filterFreqEnd: 520,
        filterQ: 0.9,
      }),
      layer({ source: 'sine', freq: 150, freqEnd: 60, gain: 0.5, attack: 0.003, hold: 0.02, release: 0.18 }),
      layer({
        source: 'square',
        freq: 300,
        freqEnd: 120,
        gain: 0.3,
        hold: 0.012,
        release: 0.09,
        filter: 'bandpass',
        filterFreq: 900,
        filterQ: 1.8,
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
   * A boss dying. The largest single event in the game and the only one allowed
   * to be: structure coming apart over 830ms, a secondary detonation at 220ms,
   * and one last relay letting go at 550ms. `impact.killElite` with the brakes
   * off — same vocabulary, twice the scale, so it reads as "that, but the big one"
   * rather than as an unrelated sound.
   */
  'impact.bossKilled': {
    category: 'impact',
    priority: 66,
    gain: 1,
    minGapSec: 0.5,
    maxVoices: 1,
    pitchRotation: NO_ROTATION,
    gainRotation: NO_ROTATION,
    layers: [
      layer({
        source: 'noise',
        gain: 0.85,
        attack: 0.004,
        hold: 0.09,
        release: 0.6,
        filter: 'lowpass',
        filterFreq: 3200,
        filterFreqEnd: 110,
        filterQ: 0.8,
      }),
      layer({ source: 'sine', freq: 70, freqEnd: 22, gain: 0.75, attack: 0.005, hold: 0.08, release: 0.62 }),
      layer({
        source: 'sawtooth',
        freq: 130,
        freqEnd: 34,
        gain: 0.32,
        attack: 0.012,
        hold: 0.09,
        release: 0.55,
        filter: 'lowpass',
        filterFreq: 800,
        filterFreqEnd: 120,
        filterQ: 1.2,
      }),
      layer({
        source: 'noise',
        gain: 0.36,
        delay: 0.22,
        attack: 0.003,
        hold: 0.03,
        release: 0.22,
        filter: 'lowpass',
        filterFreq: 2400,
        filterFreqEnd: 300,
        filterQ: 0.8,
      }),
      layer({
        source: 'square',
        freq: 220,
        freqEnd: 70,
        gain: 0.22,
        delay: 0.55,
        attack: 0.003,
        hold: 0.04,
        release: 0.24,
        filter: 'bandpass',
        filterFreq: 600,
        filterQ: 3,
      }),
    ],
  },

  /**
   * Incoming fire. Lower and hollower than the player's shot, with a resonant
   * bandpass ring so it is unmistakably *not* yours. This is one of the four
   * sounds that must always cut through, so it lives in `threat`.
   *
   * THIS RECIPE WAS THE WORST BUG THE AUDIO HARNESS FOUND. It measured -46.6
   * LUFS against the player's weapon at -43.3 — enemy fire was three decibels
   * *quieter* than the player's own gun, which fires twenty times a second. The
   * category number said 0.95 against the weapon's 0.26 and every test agreed,
   * because every test read the category number. What the tests could not see is
   * that a Q of 6 on a 1150 Hz bandpass throws away most of a 300 Hz square's
   * energy: the recipe was giving back four times what the mix had granted it.
   *
   * Q is now 3.2 and the layers are hotter. The ring is still there — that is
   * what makes it *theirs* — it just no longer costs 12 dB to have. The gap is
   * asserted in `tools/audio.ts` against the render, not against these numbers.
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
        gain: 0.98,
        attack: 0.001,
        hold: 0.016,
        release: 0.085,
        filter: 'bandpass',
        filterFreq: 1150,
        filterFreqEnd: 700,
        filterQ: 3.2,
      }),
      layer({
        source: 'noise',
        gain: 0.66,
        attack: 0.001,
        hold: 0.007,
        release: 0.035,
        filter: 'bandpass',
        filterFreq: 900,
        filterQ: 1,
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

  /**
   * A boss arriving. Something very large spinning up: a slow sawtooth swell
   * under moving air, then one clank at 900ms as it locks into place.
   *
   * Deliberately *not* a sting. docs/DESIGN.md's tone rule is deadpan
   * institutional — this is heavy plant coming online, and the drama is that it
   * takes over a second to do it while the player can already see what it is.
   */
  'threat.bossSpawn': {
    category: 'threat',
    priority: 82,
    gain: 1,
    minGapSec: 1,
    maxVoices: 1,
    pitchRotation: NO_ROTATION,
    gainRotation: NO_ROTATION,
    layers: [
      layer({
        source: 'sawtooth',
        freq: 55,
        freqEnd: 38,
        gain: 0.5,
        attack: 0.4,
        hold: 0.4,
        release: 0.45,
        filter: 'lowpass',
        filterFreq: 400,
        filterFreqEnd: 180,
        filterQ: 1,
      }),
      layer({
        source: 'noise',
        gain: 0.5,
        attack: 0.5,
        hold: 0.3,
        release: 0.4,
        filter: 'bandpass',
        filterFreq: 400,
        filterFreqEnd: 1600,
        filterQ: 1.1,
      }),
      layer({
        source: 'square',
        freq: 240,
        freqEnd: 165,
        gain: 0.44,
        delay: 0.9,
        attack: 0.005,
        hold: 0.06,
        release: 0.3,
        filter: 'bandpass',
        filterFreq: 500,
        filterQ: 3,
      }),
    ],
  },

  /**
   * A boss changing phase. Two relays stepping *up* — the opposite motion to
   * `alarm.shieldBroken`, which steps down — over a short low swell. Rising means
   * "it just got worse" without needing a word for it.
   */
  'threat.bossPhase': {
    category: 'threat',
    priority: 84,
    gain: 1,
    minGapSec: 0.35,
    maxVoices: 1,
    pitchRotation: NO_ROTATION,
    gainRotation: NO_ROTATION,
    layers: [
      layer({
        source: 'square',
        freq: 300,
        freqEnd: 460,
        gain: 0.46,
        attack: 0.004,
        hold: 0.05,
        release: 0.1,
        filter: 'bandpass',
        filterFreq: 900,
        filterFreqEnd: 1400,
        filterQ: 4,
      }),
      layer({
        source: 'square',
        freq: 420,
        freqEnd: 640,
        gain: 0.5,
        delay: 0.14,
        attack: 0.004,
        hold: 0.05,
        release: 0.12,
        filter: 'bandpass',
        filterFreq: 1200,
        filterFreqEnd: 1900,
        filterQ: 4,
      }),
      layer({ source: 'sine', freq: 90, freqEnd: 70, gain: 0.44, attack: 0.006, hold: 0.08, release: 0.3 }),
      // Banded rather than high-passed. As a highpass this layer carried the cue's
      // brightness up to 4.6 kHz and parked it on top of `alarm.shieldAbsorb`,
      // which means the opposite thing.
      layer({
        source: 'noise',
        gain: 0.26,
        attack: 0.002,
        hold: 0.01,
        release: 0.12,
        filter: 'bandpass',
        filterFreq: 2600,
        filterQ: 1,
      }),
    ],
  },

  /**
   * The hazard discharging — the thing the warning was warning about. A hard
   * downward sweep: broadband at the top, collapsing to a thud. It is loud
   * because it is the confirmation that the reaction window closed, and a player
   * who dodged needs to hear that they dodged something real.
   */
  'threat.hazardFired': {
    category: 'threat',
    priority: 78,
    gain: 1,
    minGapSec: 0.25,
    maxVoices: 2,
    pitchRotation: [1, 0.97],
    gainRotation: NO_ROTATION,
    layers: [
      layer({
        source: 'noise',
        gain: 0.72,
        attack: 0.006,
        hold: 0.05,
        release: 0.4,
        filter: 'bandpass',
        filterFreq: 4000,
        filterFreqEnd: 400,
        filterQ: 1.2,
      }),
      layer({
        source: 'sawtooth',
        freq: 900,
        freqEnd: 110,
        gain: 0.42,
        attack: 0.004,
        hold: 0.04,
        release: 0.36,
        filter: 'lowpass',
        filterFreq: 2600,
        filterFreqEnd: 300,
        filterQ: 1.4,
      }),
      layer({ source: 'sine', freq: 140, freqEnd: 45, gain: 0.46, attack: 0.004, hold: 0.05, release: 0.34 }),
    ],
  },

  /**
   * THE MOST IMPORTANT SOUND IN THE GAME.
   *
   * A hazard telegraph is a one-second reaction window. If a player misses it
   * they take damage they had every chance to avoid, which is the single worst
   * thing an action game can do to someone. So this cue is designed against
   * *masking* rather than for character, and every choice below is a masking
   * choice, verified by `npm run audio` rather than asserted:
   *
   *  1. THREE PULSES, not one tone. A rhythm is the only structure in this
   *     library — nothing else in the game repeats — so it is identifiable from
   *     its pattern before its timbre is even resolved. It also defeats masking
   *     outright: masking is near-instantaneous, and combat transients are
   *     sparse, so three separated pulses cannot all land under one.
   *  2. 3.1–3.8 kHz, narrow and resonant. That is both the ear's most sensitive
   *     region and the one place ordinary combat is quiet: the weapon sits under
   *     3 kHz, enemy fire around 700–1200 Hz, impacts below 2 kHz. The harness
   *     measures the margin in exactly these bands against a real combat bed.
   *  3. RISING in pitch and level across the three pulses, so it reads as a
   *     countdown running out rather than as a state that is merely true.
   *  4. Ends at 974ms — the pulse train finishes as the hazard fires, so the
   *     silence after the third pulse is itself information.
   *  5. `maxVoices: 1` and the highest priority below the run ending. Two
   *     overlapping warnings would destroy the rhythm that carries the meaning.
   */
  'alarm.hazardWarning': {
    category: 'alarm',
    priority: 96,
    gain: 1,
    minGapSec: 0.8,
    maxVoices: 1,
    pitchRotation: NO_ROTATION,
    gainRotation: NO_ROTATION,
    layers: [
      layer({
        source: 'square',
        freq: 3150,
        gain: 0.5,
        attack: 0.004,
        hold: 0.12,
        release: 0.07,
        filter: 'bandpass',
        filterFreq: 3150,
        filterQ: 7,
      }),
      layer({
        source: 'noise',
        gain: 0.18,
        attack: 0.001,
        hold: 0.004,
        release: 0.02,
        filter: 'highpass',
        filterFreq: 3000,
        filterQ: 0.7,
      }),
      layer({
        source: 'square',
        freq: 3150,
        gain: 0.55,
        delay: 0.33,
        attack: 0.004,
        hold: 0.12,
        release: 0.07,
        filter: 'bandpass',
        filterFreq: 3150,
        filterQ: 7,
      }),
      layer({
        source: 'noise',
        gain: 0.18,
        delay: 0.33,
        attack: 0.001,
        hold: 0.004,
        release: 0.02,
        filter: 'highpass',
        filterFreq: 3000,
        filterQ: 0.7,
      }),
      layer({
        source: 'square',
        freq: 3750,
        gain: 0.62,
        delay: 0.66,
        attack: 0.004,
        hold: 0.17,
        release: 0.14,
        filter: 'bandpass',
        filterFreq: 3750,
        filterQ: 7,
      }),
      layer({
        source: 'noise',
        gain: 0.2,
        delay: 0.66,
        attack: 0.001,
        hold: 0.005,
        release: 0.025,
        filter: 'highpass',
        filterFreq: 3400,
        filterQ: 0.7,
      }),
    ],
  },

  /**
   * Held by the shield: bright, glassy, and rising — nothing got through.
   *
   * THE MOST-MOVED RECIPE IN THE LIBRARY, and worth explaining because the moves
   * were not taste. It measured -35.7 LUFS and 39ms originally, which made the
   * quietest, shortest cue in the game out of the one that means "you are fine".
   * Level and length were fixed first. Then `src/audio/meaning.ts` classified it
   * as the game's ONLY `stand-down` cue — the only sound whose message is the
   * opposite of a warning — and the harness measured it against all seven `evade`
   * cues *through a bed of real combat*. Five of the seven failed. The
   * information distinguishing "shield held" from "shield gone" was standing
   * 0.6 dB above ordinary combat: separable in a quiet room, inaudible in a fight.
   *
   * The cause was that it lived at 3–4 kHz, which is (a) crowded and (b) the band
   * deliberately reserved for `alarm.hazardWarning`. Putting the "you are fine"
   * cue inside the "you have one second" band is exactly backwards.
   *
   * So it moved up to a narrow glass ring at 5.8–7.6 kHz: clear of the warning's
   * reserve, clear of every impact, and — the part that matters — in a region
   * ordinary combat barely occupies, so the ring pokes through broadband gunfire
   * instead of hiding in it. It stays SHORT (~115ms) on purpose: brevity is what
   * separates it from the warning, the telegraph and a boss arriving, all of which
   * are long. A quiet 1.5 kHz partial keeps it from being a whistle on a phone.
   */
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
        gain: 0.5,
        attack: 0.001,
        hold: 0.006,
        release: 0.05,
        filter: 'bandpass',
        filterFreq: 6200,
        filterQ: 1.5,
      }),
      // The ring, rising: nothing got through.
      layer({ source: 'triangle', freq: 5800, freqEnd: 6600, gain: 0.52, hold: 0.014, release: 0.1 }),
      // An inharmonic partial. Glass, not a tuned note.
      layer({ source: 'triangle', freq: 7600, freqEnd: 8400, gain: 0.3, hold: 0.01, release: 0.07 }),
      layer({
        source: 'square',
        freq: 1500,
        freqEnd: 1750,
        gain: 0.22,
        attack: 0.001,
        hold: 0.01,
        release: 0.05,
        filter: 'bandpass',
        filterFreq: 2400,
        filterQ: 2,
      }),
    ],
  },

  /**
   * Two descending relays 90ms apart plus a crack — a system dropping offline.
   * The only two-stroke sound in the mix, so it cannot be confused with a hit.
   * `maxVoices: 1`: a doubled shield-break is a lie about what happened.
   *
   * DARKENED AND LENGTHENED, from a 6.5 kHz centroid down to the low mids. It was
   * *brighter than `alarm.shieldAbsorb`*, which inverted the library's grammar:
   * everywhere else, damage taken is dark and heavy (`alarm.hullHit`,
   * `alarm.hullLost`) while deflections and rewards are bright. A failure that
   * sounds lighter than the save is a legibility bug of the same kind as using the
   * danger colour for something harmless — see docs/UI.md rule 3. Moving it down
   * also opened 1.5 octaves between it and the cue it means the opposite of.
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
        gain: 0.6,
        attack: 0.001,
        hold: 0.01,
        release: 0.08,
        filter: 'bandpass',
        filterFreq: 1300,
        filterFreqEnd: 800,
        filterQ: 1,
      }),
      layer({
        source: 'square',
        freq: 700,
        gain: 0.46,
        attack: 0.002,
        hold: 0.045,
        release: 0.06,
        filter: 'bandpass',
        filterFreq: 1100,
        filterQ: 2,
      }),
      layer({
        source: 'square',
        freq: 480,
        gain: 0.46,
        delay: 0.09,
        attack: 0.002,
        hold: 0.05,
        release: 0.12,
        filter: 'bandpass',
        filterFreq: 850,
        filterQ: 2,
      }),
      layer({ source: 'sine', freq: 150, freqEnd: 85, gain: 0.44, attack: 0.004, hold: 0.04, release: 0.26 }),
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
        freq: 190,
        freqEnd: 78,
        gain: 0.7,
        attack: 0.001,
        hold: 0.02,
        release: 0.12,
        filter: 'lowpass',
        filterFreq: 1100,
        filterFreqEnd: 320,
        filterQ: 1,
      }),
      layer({
        source: 'noise',
        gain: 0.55,
        attack: 0.001,
        hold: 0.01,
        release: 0.08,
        filter: 'lowpass',
        filterFreq: 1200,
        filterFreqEnd: 440,
        filterQ: 0.8,
      }),
      layer({ source: 'triangle', freq: 380, freqEnd: 270, gain: 0.3, hold: 0.006, release: 0.06 }),
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
        filterFreqEnd: 170,
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
        freqEnd: 130,
        gain: 0.46,
        delay: 0.46,
        attack: 0.002,
        hold: 0.04,
        release: 0.16,
        filter: 'bandpass',
        filterFreq: 700,
        filterFreqEnd: 420,
        filterQ: 2,
      }),
    ],
  },

  /**
   * A tally mark. Two short pips through a narrow bandpass — a mechanical
   * counter incrementing, which is exactly what collecting scrap is to the
   * Salvage Division. The rotation climbs five semitones and resets, so a stream
   * of pickups reads as a total going up rather than as one sound repeating.
   *
   * "Pleasant, ignorable" turned out to mean "inaudible": it measured -46.2
   * LUFS, the quietest thing in the library, three decibels below the weapon it
   * is supposed to sit above. Same narrow-bandpass insertion loss as
   * `threat.enemyShot`. Hotter layers and a gentler Q; still the second-quietest
   * category, which is where it belongs.
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
        gain: 0.62,
        attack: 0.001,
        hold: 0.012,
        release: 0.045,
        filter: 'bandpass',
        filterFreq: 2200,
        filterQ: 2.2,
      }),
      layer({
        source: 'square',
        freq: 2080,
        gain: 0.5,
        delay: 0.028,
        attack: 0.001,
        hold: 0.01,
        release: 0.04,
        filter: 'bandpass',
        filterFreq: 2600,
        filterQ: 2.2,
      }),
    ],
  },

  /**
   * A form being stamped: click, contact, and a low thunk landing under it.
   *
   * The thunk was doing 87% of the work and lives at 130 Hz, which a laptop
   * speaker does not have. Rebalanced towards the contact so the cue still
   * exists on the device most people will play on; the thunk is still there for
   * anyone with headphones.
   */
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
        gain: 0.52,
        attack: 0.001,
        hold: 0.018,
        release: 0.05,
        filter: 'bandpass',
        filterFreq: 1600,
        filterQ: 2,
      }),
      layer({ source: 'sine', freq: 210, freqEnd: 165, gain: 0.38, delay: 0.02, hold: 0.02, release: 0.09 }),
    ],
  },

  /**
   * The same mechanism run backwards: down instead of up, no stamp.
   *
   * 94% of its energy was below 150 Hz, so on a laptop it was close to nothing.
   * The relay carries it now and the settle sits an octave up.
   */
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
        gain: 0.6,
        attack: 0.002,
        hold: 0.028,
        release: 0.07,
        filter: 'bandpass',
        filterFreq: 800,
        filterQ: 1.8,
      }),
      layer({ source: 'sine', freq: 210, freqEnd: 150, gain: 0.34, delay: 0.01, hold: 0.02, release: 0.08 }),
    ],
  },

  /**
   * A wave releasing: a distant door opening somewhere in the wreck. Low,
   * unhurried, and quiet enough to sit underneath combat — it is context, not a
   * cue to react to, so it must never compete with `threat`.
   *
   * It was 99% sub-150 Hz, which is another way of saying it did not exist on a
   * laptop. "Distant" is a spectral shape, not an absence of midrange: the door
   * now has a body you can hear on a small speaker while staying the darkest
   * thing in the mix.
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
      layer({ source: 'sine', freq: 156, freqEnd: 104, gain: 0.5, attack: 0.004, hold: 0.06, release: 0.22 }),
      layer({
        source: 'noise',
        gain: 0.42,
        attack: 0.02,
        hold: 0.05,
        release: 0.2,
        filter: 'lowpass',
        filterFreq: 1500,
        filterFreqEnd: 500,
        filterQ: 0.8,
      }),
      layer({
        source: 'square',
        freq: 320,
        freqEnd: 230,
        gain: 0.4,
        delay: 0.05,
        attack: 0.002,
        hold: 0.03,
        release: 0.14,
        filter: 'bandpass',
        filterFreq: 780,
        filterQ: 2,
      }),
    ],
  },

  /**
   * A stage cleared. Two relays stepping *down* onto a low settle — a docket
   * closing, not a fanfare.
   *
   * The temptation here is a triumphant chord, and it is the wrong instinct twice
   * over: the tone is institutional (docs/DESIGN.md — the company does not
   * celebrate), and a bright rising cue would compete with `alarm.hazardWarning`
   * for the one spectral region that has been reserved for it. Descending, dark
   * and unhurried keeps that region clear.
   */
  'ui.stageCleared': {
    category: 'ui',
    priority: 46,
    gain: 1,
    minGapSec: 0.5,
    maxVoices: 1,
    pitchRotation: NO_ROTATION,
    gainRotation: NO_ROTATION,
    layers: [
      layer({
        source: 'square',
        freq: 620,
        freqEnd: 560,
        gain: 0.34,
        attack: 0.004,
        hold: 0.07,
        release: 0.12,
        filter: 'bandpass',
        filterFreq: 1200,
        filterQ: 3,
      }),
      layer({
        source: 'square',
        freq: 460,
        freqEnd: 420,
        gain: 0.34,
        delay: 0.18,
        attack: 0.004,
        hold: 0.08,
        release: 0.16,
        filter: 'bandpass',
        filterFreq: 950,
        filterQ: 3,
      }),
      layer({ source: 'sine', freq: 196, freqEnd: 168, gain: 0.42, delay: 0.32, attack: 0.008, hold: 0.12, release: 0.34 }),
      layer({
        source: 'noise',
        gain: 0.24,
        attack: 0.002,
        hold: 0.006,
        release: 0.05,
        filter: 'highpass',
        filterFreq: 2200,
        filterQ: 0.7,
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

/**
 * Default master level.
 *
 * Raised from 0.55 on measured evidence, not on taste. At 0.55 the worst mix the
 * simulation can legitimately produce — a 256-event tick landing inside ordinary
 * combat — rendered at -6.3 dBTP, so a third of the output range was permanently
 * unused and the game was quiet enough that a player would raise their system
 * volume, which is precisely how a hazard warning becomes painful. At 0.7 that
 * same worst case measures around -4 dBTP and every solo cue still clears the
 * -1 dBTP delivery ceiling. `npm run audio` asserts both, so this number cannot
 * drift upward unnoticed.
 */
export const DEFAULT_MASTER_VOLUME = 0.7
