/**
 * Measurement, so that "does this sound right?" stops being unanswerable.
 *
 * Rendering a cue to PCM is only half an instrument — a WAV file nobody analyses
 * is the same blind spot with more steps. This module is the other half: it turns
 * a rendered buffer into numbers a test can assert on, and every number here was
 * chosen because a *listener* would notice the thing it measures.
 *
 *   peak / true peak      clipping. The difference between punchy and broken.
 *   LUFS                  perceived loudness, so the mix hierarchy in
 *                         src/audio/sounds.ts can be checked against what is
 *                         actually heard rather than against its own constants.
 *   effective duration    how long a cue occupies the ear, not how long its
 *                         envelope is on paper. An exponential release never
 *                         reaches zero; the audible tail is shorter than the
 *                         arithmetic one.
 *   spectral centroid     brightness. The single strongest cue for "that is a
 *                         different sound", ahead of level or length.
 *   band profile          where the energy actually sits, which is what decides
 *                         whether two cues mask each other.
 *   DC offset             inaudible on its own and a headroom thief in a mix.
 *
 * NO DEPENDENCIES, on purpose (CLAUDE.md). The FFT, the K-weighting filters and
 * the oversampling interpolator are all here, all short, and all unit-tested in
 * tests/audioAnalysis.test.ts against signals whose answers are known in closed
 * form — which is the only reason to trust a hand-rolled DSP at all.
 *
 * Not part of the shipped bundle: nothing `src/main.ts` imports reaches this file.
 */

/** Interleaved-free PCM: one Float32Array per channel, all the same length. */
export interface Pcm {
  readonly sampleRate: number
  readonly channels: readonly Float32Array[]
}

/** Amplitude below which a sample is treated as silence when timing a cue. */
const SILENCE_FLOOR = 1e-7

export function toDb(amplitude: number): number {
  return 20 * Math.log10(Math.max(amplitude, SILENCE_FLOOR))
}

export function frameCount(pcm: Pcm): number {
  return pcm.channels[0]?.length ?? 0
}

/** Mono downmix. Averaged, not summed, so a centred cue keeps its level. */
export function mono(pcm: Pcm): Float32Array {
  const n = frameCount(pcm)
  const out = new Float32Array(n)
  const channels = pcm.channels.length
  if (channels === 0) return out
  for (const channel of pcm.channels) {
    for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) + (channel[i] ?? 0)
  }
  for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) / channels
  return out
}

/** Largest absolute *sample* value, across every channel. */
export function peak(pcm: Pcm): number {
  let max = 0
  for (const channel of pcm.channels) {
    for (let i = 0; i < channel.length; i++) {
      const v = Math.abs(channel[i] ?? 0)
      if (v > max) max = v
    }
  }
  return max
}

/**
 * Half-length of the interpolation kernel used for true peak. 16 taps either
 * side is well past the point where more taps change the answer.
 */
const TRUE_PEAK_TAPS = 16

/**
 * Inter-sample peak, via 4× windowed-sinc oversampling (the BS.1770-4 method,
 * at its minimum recommended factor).
 *
 * WHY IT IS NOT THE SAME AS `peak`: a signal can sit at 0.99 at every sample and
 * still swing past 1.0 *between* them. That reconstruction overshoot is what a
 * DAC and every lossy encoder actually produce, so a cue that passes a sample
 * peak check can still be the one that crackles on the player's machine.
 */
export function truePeak(pcm: Pcm, oversample = 4): number {
  let max = 0
  // Precompute one kernel per sub-phase; the phase-0 kernel is the identity.
  const kernels: Float64Array[] = []
  for (let phase = 0; phase < oversample; phase++) {
    const kernel = new Float64Array(TRUE_PEAK_TAPS * 2)
    const offset = phase / oversample
    for (let k = 0; k < kernel.length; k++) {
      const x = k - TRUE_PEAK_TAPS + 1 - offset
      kernel[k] = sinc(x) * blackman(k / (kernel.length - 1))
    }
    kernels.push(kernel)
  }

  for (const channel of pcm.channels) {
    for (let i = 0; i < channel.length; i++) {
      const here = Math.abs(channel[i] ?? 0)
      if (here > max) max = here
      for (let phase = 1; phase < oversample; phase++) {
        const kernel = kernels[phase]
        if (kernel === undefined) continue
        let sum = 0
        for (let k = 0; k < kernel.length; k++) {
          const index = i + k - TRUE_PEAK_TAPS + 1
          if (index < 0 || index >= channel.length) continue
          sum += (channel[index] ?? 0) * (kernel[k] ?? 0)
        }
        const v = Math.abs(sum)
        if (v > max) max = v
      }
    }
  }
  return max
}

function sinc(x: number): number {
  if (Math.abs(x) < 1e-9) return 1
  const pix = Math.PI * x
  return Math.sin(pix) / pix
}

function blackman(t: number): number {
  return 0.42 - 0.5 * Math.cos(2 * Math.PI * t) + 0.08 * Math.cos(4 * Math.PI * t)
}

/** Root-mean-square over the whole buffer, averaged across channels. */
export function rms(pcm: Pcm): number {
  const n = frameCount(pcm)
  if (n === 0 || pcm.channels.length === 0) return 0
  let total = 0
  for (const channel of pcm.channels) {
    let sum = 0
    for (let i = 0; i < n; i++) {
      const v = channel[i] ?? 0
      sum += v * v
    }
    total += sum / n
  }
  return Math.sqrt(total / pcm.channels.length)
}

/** Mean sample value per channel; the largest magnitude is what is returned. */
export function dcOffset(pcm: Pcm): number {
  const n = frameCount(pcm)
  if (n === 0) return 0
  let worst = 0
  for (const channel of pcm.channels) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += channel[i] ?? 0
    worst = Math.max(worst, Math.abs(sum / n))
  }
  return worst
}

// ---------------------------------------------------------------------------
// loudness
// ---------------------------------------------------------------------------

/**
 * ITU-R BS.1770-4 K-weighting, at 48 kHz.
 *
 * Two biquads: a high-shelf approximating the acoustic effect of a head, then a
 * high-pass that discounts the sub-bass a small speaker will never reproduce.
 * The coefficients are only exact at 48 kHz, which is why `loudnessLufs`
 * refuses any other rate rather than silently reporting a wrong number.
 */
const K_SHELF = {
  b: [1.53512485958697, -2.69169618940638, 1.19839281085285],
  a: [1, -1.69065929318241, 0.73248077421585],
} as const

const K_HIGHPASS = {
  b: [1.0, -2.0, 1.0],
  a: [1, -1.99004745483398, 0.99007225036621],
} as const

export const LOUDNESS_SAMPLE_RATE = 48000

function biquad(input: Float32Array, b: readonly number[], a: readonly number[]): Float32Array {
  const out = new Float32Array(input.length)
  const b0 = b[0] ?? 0
  const b1 = b[1] ?? 0
  const b2 = b[2] ?? 0
  const a1 = a[1] ?? 0
  const a2 = a[2] ?? 0
  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i] ?? 0
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    out[i] = y0
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
  }
  return out
}

/**
 * Loudness in LUFS over the whole buffer — ungated.
 *
 * The gating in the broadcast standard exists to stop silence between programme
 * material dragging an album's average down. Every measurement here is a single
 * short cue whose silence is *part of the cue*, so gating would measure a
 * different thing for a 25ms click than for a 900ms power-down and make the two
 * incomparable. Ungated over a stated window is the honest form of the question
 * "how loud is this cue in the mix".
 */
export function loudnessLufs(pcm: Pcm): number {
  if (pcm.sampleRate !== LOUDNESS_SAMPLE_RATE) {
    throw new Error(
      `loudnessLufs needs ${LOUDNESS_SAMPLE_RATE}Hz (K-weighting coefficients are rate-specific), got ${pcm.sampleRate}`,
    )
  }
  const n = frameCount(pcm)
  if (n === 0) return Number.NEGATIVE_INFINITY
  let sum = 0
  for (const channel of pcm.channels) {
    const weighted = biquad(biquad(channel, K_SHELF.b, K_SHELF.a), K_HIGHPASS.b, K_HIGHPASS.a)
    let ms = 0
    for (let i = 0; i < n; i++) {
      const v = weighted[i] ?? 0
      ms += v * v
    }
    // Channel weight G = 1.0 for left and right (BS.1770 only raises it for surrounds).
    sum += ms / n
  }
  if (sum <= 0) return Number.NEGATIVE_INFINITY
  return -0.691 + 10 * Math.log10(sum)
}

/**
 * Where a laptop speaker gives up. Phones are worse; 150 Hz is the generous end.
 */
export const SMALL_SPEAKER_HZ = 150

/**
 * The cue as a laptop speaker would reproduce it: everything below 150 Hz gone.
 *
 * A crude model — two cascaded Butterworth sections, 24 dB/octave, no cabinet
 * resonance and no distortion — and crude is enough for the question being
 * asked, which is not "how does this sound on a MacBook" but "is there anything
 * left of this cue when the bass is removed". A recipe carried entirely by a
 * 78 Hz sine is inaudible on the device most players will use, and no amount of
 * full-range measurement reveals that.
 */
export function smallSpeaker(pcm: Pcm, hz = SMALL_SPEAKER_HZ): Pcm {
  const w0 = (2 * Math.PI * hz) / pcm.sampleRate
  const cos = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  const b = [(1 + cos) / 2 / a0, (-(1 + cos)) / a0, (1 + cos) / 2 / a0]
  const a = [1, (-2 * cos) / a0, (1 - alpha) / a0]
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((channel) => biquad(biquad(channel, b, a), b, a)),
  }
}

/** Loudness of what survives a small speaker. */
export function smallSpeakerLufs(pcm: Pcm): number {
  return loudnessLufs(smallSpeaker(pcm))
}

/**
 * Loudness measured in sliding windows — the shape of the level over time.
 *
 * Used to prove that a warning *arrives*: an average over a whole scene hides a
 * cue that is buried at the moment it plays.
 */
export function shortTermLoudness(pcm: Pcm, windowSec = 0.1, hopSec = 0.02): { time: number; lufs: number }[] {
  const window = Math.max(1, Math.round(windowSec * pcm.sampleRate))
  const hop = Math.max(1, Math.round(hopSec * pcm.sampleRate))
  const n = frameCount(pcm)
  const out: { time: number; lufs: number }[] = []
  for (let start = 0; start + window <= n; start += hop) {
    const slice: Float32Array[] = pcm.channels.map((channel) => channel.slice(start, start + window))
    out.push({
      time: start / pcm.sampleRate,
      lufs: loudnessLufs({ sampleRate: pcm.sampleRate, channels: slice }),
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// timing
// ---------------------------------------------------------------------------

/**
 * How long the cue is actually audible for, in seconds.
 *
 * Measured from a short-window RMS envelope down to `floorDb` below the cue's
 * own loudest window, because that is where a listener stops hearing it. The
 * arithmetic length of an exponential release is always longer, and using it
 * would report a 25ms click as a 40ms one.
 */
export function effectiveDuration(pcm: Pcm, floorDb = -45): number {
  const envelope = rmsEnvelope(pcm, 0.003)
  let loudest = 0
  for (const v of envelope) loudest = Math.max(loudest, v)
  if (loudest <= SILENCE_FLOOR) return 0
  const threshold = loudest * Math.pow(10, floorDb / 20)
  let first = -1
  let last = -1
  for (let i = 0; i < envelope.length; i++) {
    if ((envelope[i] ?? 0) < threshold) continue
    if (first < 0) first = i
    last = i
  }
  if (first < 0) return 0
  return ((last - first + 1) * 0.003 * pcm.sampleRate) / pcm.sampleRate
}

/** Seconds from the start of the buffer to the first audible sample. */
export function onsetTime(pcm: Pcm, floorDb = -45): number {
  const envelope = rmsEnvelope(pcm, 0.003)
  let loudest = 0
  for (const v of envelope) loudest = Math.max(loudest, v)
  if (loudest <= SILENCE_FLOOR) return 0
  const threshold = loudest * Math.pow(10, floorDb / 20)
  for (let i = 0; i < envelope.length; i++) if ((envelope[i] ?? 0) >= threshold) return i * 0.003
  return 0
}

/** RMS in consecutive non-overlapping windows of `windowSec`. */
export function rmsEnvelope(pcm: Pcm, windowSec: number): Float64Array {
  const window = Math.max(1, Math.round(windowSec * pcm.sampleRate))
  const n = frameCount(pcm)
  const count = Math.max(1, Math.ceil(n / window))
  const out = new Float64Array(count)
  const signal = mono(pcm)
  for (let w = 0; w < count; w++) {
    let sum = 0
    let taken = 0
    for (let i = w * window; i < Math.min(n, (w + 1) * window); i++) {
      const v = signal[i] ?? 0
      sum += v * v
      taken++
    }
    out[w] = taken === 0 ? 0 : Math.sqrt(sum / taken)
  }
  return out
}

// ---------------------------------------------------------------------------
// spectrum
// ---------------------------------------------------------------------------

const FFT_SIZE = 1024

/**
 * Energy-weighted average power spectrum over the whole buffer.
 *
 * Frames are summed rather than averaged so that loud moments dominate, which
 * is what the ear does — the brightness of a cue is the brightness of its
 * transient, not of its tail.
 */
export function powerSpectrum(pcm: Pcm): Float64Array {
  const signal = mono(pcm)
  const bins = FFT_SIZE / 2
  const out = new Float64Array(bins)
  const hop = FFT_SIZE / 2
  const window = hann(FFT_SIZE)
  const re = new Float64Array(FFT_SIZE)
  const im = new Float64Array(FFT_SIZE)

  /**
   * ONLY WHOLE FRAMES. The obvious loop runs to `signal.length` and zero-fills
   * whatever hangs off the end, and that is a bug with a very quiet failure mode:
   * a part-filled frame is a step discontinuity, a step discontinuity is
   * broadband, and the splatter lands in the several hundred high bins where the
   * frequency weighting in `spectralCentroid` is largest. It read a pure 500 Hz
   * tone as 564 Hz — a 0.17-octave error on an instrument whose job is to assert
   * half-octave differences, and it made two cues that genuinely collide look
   * comfortably distinct. The Hann window already tapers each real frame to zero
   * at both edges, so a full frame needs no such handling.
   */
  const last = signal.length - FFT_SIZE
  for (let start = 0; start <= last; start += hop) {
    re.fill(0)
    im.fill(0)
    let energy = 0
    for (let i = 0; i < FFT_SIZE; i++) {
      const v = (signal[start + i] ?? 0) * (window[i] ?? 0)
      re[i] = v
      energy += v * v
    }
    if (energy <= 0) continue
    fft(re, im)
    for (let k = 0; k < bins; k++) {
      const a = re[k] ?? 0
      const b = im[k] ?? 0
      out[k] = (out[k] ?? 0) + a * a + b * b
    }
  }
  return out
}

function hann(size: number): Float64Array {
  const out = new Float64Array(size)
  for (let i = 0; i < size; i++) out[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1))
  return out
}

/** In-place iterative radix-2 Cooley-Tukey. `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i] ?? 0
      re[i] = re[j] ?? 0
      re[j] = tr
      const ti = im[i] ?? 0
      im[i] = im[j] ?? 0
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wr = Math.cos(angle)
    const wi = Math.sin(angle)
    for (let i = 0; i < n; i += len) {
      let curR = 1
      let curI = 0
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k] ?? 0
        const ai = im[i + k] ?? 0
        const br = re[i + k + len / 2] ?? 0
        const bi = im[i + k + len / 2] ?? 0
        const tr = br * curR - bi * curI
        const ti = br * curI + bi * curR
        re[i + k] = ar + tr
        im[i + k] = ai + ti
        re[i + k + len / 2] = ar - tr
        im[i + k + len / 2] = ai - ti
        const nextR = curR * wr - curI * wi
        curI = curR * wi + curI * wr
        curR = nextR
      }
    }
  }
}

/**
 * Spectral centroid in Hz — the energy-weighted mean frequency.
 *
 * Weighted by MAGNITUDE, the standard definition, and it has to be: power
 * weighting is dominated by whichever single partial is loudest, so a cue with a
 * strong 250 Hz body and an audible 4 kHz transient reads as 250 Hz — which is
 * not what a listener means by brightness.
 *
 * That choice is only safe because `powerSpectrum` frames cleanly; magnitude
 * weighting gives any broadband analysis artefact a square-root-scale vote, and
 * a truncated final frame used to bias a pure 500 Hz tone to 564 Hz. See the note
 * there. `tests/audioAnalysis.test.ts` pins this to within 0.02 octaves against
 * pure tones from 300 Hz to 8 kHz.
 *
 * Restricted to 30 Hz–18 kHz: DC and ultrasonics are not brightness, they are
 * measurement artefacts.
 */
export function spectralCentroid(spectrum: Float64Array, sampleRate: number): number {
  const binHz = sampleRate / FFT_SIZE
  let weighted = 0
  let total = 0
  for (let k = 1; k < spectrum.length; k++) {
    const hz = k * binHz
    if (hz < 30 || hz > 18000) continue
    const magnitude = Math.sqrt(spectrum[k] ?? 0)
    weighted += hz * magnitude
    total += magnitude
  }
  return total <= 0 ? 0 : weighted / total
}

/** Third-octave band centres, 31.5 Hz to 16 kHz. */
export const BAND_CENTRES: readonly number[] = (() => {
  const out: number[] = []
  for (let i = 0; i < 28; i++) out.push(31.5 * Math.pow(2, i / 3))
  return out
})()

/** Energy per third-octave band, in the same units as `powerSpectrum`. */
export function bandEnergies(spectrum: Float64Array, sampleRate: number): Float64Array {
  const binHz = sampleRate / FFT_SIZE
  const out = new Float64Array(BAND_CENTRES.length)
  for (let k = 1; k < spectrum.length; k++) {
    const hz = k * binHz
    const band = nearestBand(hz)
    if (band < 0) continue
    out[band] = (out[band] ?? 0) + (spectrum[k] ?? 0)
  }
  return out
}

function nearestBand(hz: number): number {
  const lowest = BAND_CENTRES[0] ?? 31.5
  const index = Math.round(Math.log2(hz / lowest) * 3)
  return index < 0 || index >= BAND_CENTRES.length ? -1 : index
}

/**
 * Fraction of a cue's energy below `hz`.
 *
 * A laptop speaker reproduces nothing below roughly 150 Hz and a phone nothing
 * below 400 Hz. Energy down there is not bass, it is headroom being spent on
 * something most players cannot hear — which is a mix problem, not a taste one.
 */
export function energyFractionBelow(spectrum: Float64Array, sampleRate: number, hz: number): number {
  const binHz = sampleRate / FFT_SIZE
  let below = 0
  let total = 0
  for (let k = 1; k < spectrum.length; k++) {
    const f = k * binHz
    if (f > 18000) break
    const power = spectrum[k] ?? 0
    total += power
    if (f < hz) below += power
  }
  return total <= 0 ? 0 : below / total
}

// ---------------------------------------------------------------------------
// distinguishability
// ---------------------------------------------------------------------------

/** Everything needed to compare two cues, with the raw buffer discarded. */
export interface Fingerprint {
  readonly centroidHz: number
  readonly durationSec: number
  /** Third-octave profile in dB relative to the cue's own loudest band, floored at -50. */
  readonly profile: Float64Array
  /** 16-point RMS envelope over the audible span, normalised to a peak of 1. */
  readonly envelope: Float64Array
}

const PROFILE_FLOOR_DB = -50
const ENVELOPE_POINTS = 16

export function fingerprint(pcm: Pcm): Fingerprint {
  const spectrum = powerSpectrum(pcm)
  const bands = bandEnergies(spectrum, pcm.sampleRate)
  let loudest = 0
  for (const v of bands) loudest = Math.max(loudest, v)
  const profile = new Float64Array(bands.length)
  for (let i = 0; i < bands.length; i++) {
    const db = loudest <= 0 ? PROFILE_FLOOR_DB : 10 * Math.log10(Math.max((bands[i] ?? 0) / loudest, 1e-12))
    profile[i] = Math.max(db, PROFILE_FLOOR_DB) / -PROFILE_FLOOR_DB
  }
  return {
    centroidHz: spectralCentroid(spectrum, pcm.sampleRate),
    durationSec: effectiveDuration(pcm),
    profile,
    envelope: shapeEnvelope(pcm),
  }
}

/** The cue's audible span resampled to a fixed number of points, peak-normalised. */
function shapeEnvelope(pcm: Pcm): Float64Array {
  const signal = mono(pcm)
  const start = Math.round(onsetTime(pcm) * pcm.sampleRate)
  const span = Math.max(1, Math.round(effectiveDuration(pcm) * pcm.sampleRate))
  const out = new Float64Array(ENVELOPE_POINTS)
  let loudest = 0
  for (let p = 0; p < ENVELOPE_POINTS; p++) {
    const from = start + Math.floor((span * p) / ENVELOPE_POINTS)
    const to = start + Math.floor((span * (p + 1)) / ENVELOPE_POINTS)
    let sum = 0
    let taken = 0
    for (let i = from; i < Math.min(to, signal.length); i++) {
      const v = signal[i] ?? 0
      sum += v * v
      taken++
    }
    const value = taken === 0 ? 0 : Math.sqrt(sum / taken)
    out[p] = value
    loudest = Math.max(loudest, value)
  }
  if (loudest > 0) for (let p = 0; p < ENVELOPE_POINTS; p++) out[p] = (out[p] ?? 0) / loudest
  return out
}

/**
 * How far apart two cues are, on each axis a listener uses and in total.
 *
 * The score is a MAXIMUM, not a sum, and that is the design decision worth
 * stating: two sounds are told apart by their most obvious difference, not by an
 * average of every difference. A 25ms click and a 900ms power-down are trivially
 * distinguishable on length alone even if their spectra were identical, and a
 * sum would dilute that into a mediocre-looking number.
 *
 * Each axis is divided by the amount that would be sufficient *on its own*, so a
 * score of 1.0 means "just separable", and the axis that produced it is visible
 * in the breakdown.
 */
export interface Separation {
  /** Brightness difference, in octaves. */
  readonly centroidOctaves: number
  /** Length difference, in doublings. */
  readonly durationOctaves: number
  /** Third-octave profile distance, 0..1. */
  readonly spectralDistance: number
  /** Envelope-shape distance, 0..1. */
  readonly envelopeDistance: number
  /** Max of the four axes, each normalised by its own sufficiency threshold. */
  readonly score: number
}

/** Amount of a single axis that suffices to tell two cues apart on that axis alone. */
const SUFFICIENT = {
  centroidOctaves: 0.5,
  durationOctaves: 1,
  spectralDistance: 0.25,
  envelopeDistance: 0.3,
} as const

export function separation(a: Fingerprint, b: Fingerprint): Separation {
  const centroidOctaves =
    a.centroidHz > 0 && b.centroidHz > 0 ? Math.abs(Math.log2(a.centroidHz / b.centroidHz)) : 0
  const durationOctaves =
    a.durationSec > 0 && b.durationSec > 0 ? Math.abs(Math.log2(a.durationSec / b.durationSec)) : 0
  const spectralDistance = normalisedDistance(a.profile, b.profile)
  const envelopeDistance = normalisedDistance(a.envelope, b.envelope)
  const score = Math.max(
    centroidOctaves / SUFFICIENT.centroidOctaves,
    durationOctaves / SUFFICIENT.durationOctaves,
    spectralDistance / SUFFICIENT.spectralDistance,
    envelopeDistance / SUFFICIENT.envelopeDistance,
  )
  return { centroidOctaves, durationOctaves, spectralDistance, envelopeDistance, score }
}

/** RMS difference between two equal-length vectors. Scale-free in the vector length. */
function normalisedDistance(a: Float64Array, b: Float64Array): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    sum += d * d
  }
  return Math.sqrt(sum / n)
}

// ---------------------------------------------------------------------------
// masking
// ---------------------------------------------------------------------------

export interface MaskingReport {
  /** Energy-weighted mean margin over the signal's own bands, in dB. */
  readonly meanMarginDb: number
  /** Worst margin among the three bands carrying most of the signal, in dB. */
  readonly worstMarginDb: number
  /** Band centre, in Hz, where the margin is worst. */
  readonly worstBandHz: number
  /** Best margin over any band carrying a meaningful share of the signal, in dB. */
  readonly bestMarginDb: number
  /** Band centre, in Hz, where the margin is best. */
  readonly bestBandHz: number
}

/**
 * How far a signal stands above a competing bed, band by band.
 *
 * This is the measurement that decides whether the hazard warning survives
 * ordinary combat. It is deliberately restricted to the bands the *signal*
 * occupies: a warning is not made audible by the fact that the bed is quiet at
 * 12 kHz, it is made audible by being louder than the bed where the warning
 * itself lives.
 *
 * Not a full psychoacoustic masking model — there is no spreading function and
 * no temporal masking here. It is a per-band signal-to-masker ratio, which is
 * the conservative half of the story: real spreading only ever makes masking
 * worse, so a comfortable margin here is necessary rather than sufficient.
 */
const NOTHING_THERE: MaskingReport = {
  meanMarginDb: Number.NEGATIVE_INFINITY,
  worstMarginDb: Number.NEGATIVE_INFINITY,
  worstBandHz: 0,
  bestMarginDb: Number.NEGATIVE_INFINITY,
  bestBandHz: 0,
}

export function maskingMargin(signal: Pcm, bed: Pcm): MaskingReport {
  const signalBands = bandEnergies(powerSpectrum(signal), signal.sampleRate)
  const bedBands = bandEnergies(powerSpectrum(bed), bed.sampleRate)

  let totalSignal = 0
  for (const v of signalBands) totalSignal += v
  if (totalSignal <= 0) return NOTHING_THERE
  // Restricted to the signal's own bands — everything carrying at least 3% of its
  // energy. A warning is not made audible by the bed being quiet at 12 kHz.
  return marginOver(signalBands, bedBands)
}

/**
 * How far the DIFFERENCE between two cues stands above a competing bed.
 *
 * `separation` answers "are these two cues distinguishable", and answers it in
 * silence. That is the wrong room. Two cues can differ clearly in a band that
 * ordinary combat fills completely, in which case the difference exists in the
 * file and not in the player's ear — and the consequence of getting it wrong is
 * not aesthetic. `alarm.shieldAbsorb` means "you are fine, keep flying"; the cue
 * it is most similar to means "your buffer is gone and the next hit is
 * permanent". A player resolves those while dodging, not in a quiet room.
 *
 * So: per third-octave band, take the magnitude of the difference between the two
 * cues, and measure *that* against the bed. Restricted to the bands carrying the
 * difference, for the same reason `maskingMargin` restricts to a signal's own
 * bands — the pair is not told apart by a region where neither of them has any
 * energy.
 *
 * Both cues are measured over one common window so their energies are
 * commensurable, and the bed is scaled to the same window length.
 *
 * WHICH STATISTIC TO JUDGE ON. For a single signal against a bed (`maskingMargin`)
 * the strict reading is right: a warning has to survive in every band it relies
 * on. For a *difference* it is not. Telling two sounds apart needs one salient
 * audible feature, not all of them — a player distinguishes a glass ring from a
 * relay by the ring, and does not also require the 300 Hz difference between them
 * to be audible. So `bestMarginDb` is the one to assert on, with `meanMarginDb`
 * as the sanity check that the difference is not otherwise buried. Both are
 * reported; nothing here decides which the caller uses.
 *
 * Same conservative caveats as `maskingMargin`: no spreading function, no
 * temporal masking.
 */
export function discriminationMargin(a: Pcm, b: Pcm, bed: Pcm): MaskingReport {
  const window = Math.max(
    0.15,
    onsetTime(a) + effectiveDuration(a),
    onsetTime(b) + effectiveDuration(b),
  )
  const aBands = bandEnergies(powerSpectrum(slicePcm(a, 0, window)), a.sampleRate)
  const bBands = bandEnergies(powerSpectrum(slicePcm(b, 0, window)), b.sampleRate)

  /**
   * The bed is measured over its WHOLE length and scaled down to the comparison
   * window, rather than sliced to one window of the right size.
   *
   * Combat is bursty. A single 165ms slice lands either on a volley or between
   * two, and the answer swings by several decibels depending on which — an
   * instrument whose verdict depends on where you happened to cut is not an
   * instrument. Scaling the average density is stable and is the honest reading
   * of "ordinary combat".
   */
  const bedSeconds = frameCount(bed) / bed.sampleRate
  const bedScale = bedSeconds > 0 ? window / bedSeconds : 1
  const bedBands = bandEnergies(powerSpectrum(bed), bed.sampleRate)
  for (let i = 0; i < bedBands.length; i++) bedBands[i] = (bedBands[i] ?? 0) * bedScale

  const difference = new Float64Array(aBands.length)
  let total = 0
  for (let i = 0; i < difference.length; i++) {
    const d = Math.abs((aBands[i] ?? 0) - (bBands[i] ?? 0))
    difference[i] = d
    total += d
  }
  if (total <= 0) return NOTHING_THERE
  return marginOver(difference, bedBands)
}

/**
 * Shared tail of `maskingMargin` and `discriminationMargin`.
 *
 * BANDS BELOW `SMALL_SPEAKER_HZ` ARE NOT ELIGIBLE. A band can only carry
 * information if the player's hardware reproduces it, and the first version of
 * this reported that two cues were told apart at 50 Hz — true of the samples, and
 * false of every laptop and phone in existence. The same module already refuses to
 * count sub-150 Hz energy towards a cue's loudness; refusing to count it as a
 * discriminator is the same rule applied to the same fact.
 */
function marginOver(signalBands: Float64Array, bedBands: Float64Array): MaskingReport {
  let totalSignal = 0
  for (let i = 0; i < signalBands.length; i++) {
    if ((BAND_CENTRES[i] ?? 0) < SMALL_SPEAKER_HZ) continue
    totalSignal += signalBands[i] ?? 0
  }
  if (totalSignal <= 0) return NOTHING_THERE

  const own: number[] = []
  for (let i = 0; i < signalBands.length; i++) {
    if ((BAND_CENTRES[i] ?? 0) < SMALL_SPEAKER_HZ) continue
    if ((signalBands[i] ?? 0) / totalSignal >= 0.03) own.push(i)
  }
  if (own.length === 0) own.push(indexOfMax(signalBands))

  let weighted = 0
  let weight = 0
  for (const i of own) {
    const s = signalBands[i] ?? 0
    const m = Math.max(bedBands[i] ?? 0, 1e-18)
    weighted += 10 * Math.log10(s / m) * s
    weight += s
  }

  const strongest = [...own].sort((x, y) => (signalBands[y] ?? 0) - (signalBands[x] ?? 0)).slice(0, 3)
  let worst = Number.POSITIVE_INFINITY
  let worstBand = 0
  for (const i of strongest) {
    const margin = 10 * Math.log10((signalBands[i] ?? 0) / Math.max(bedBands[i] ?? 0, 1e-18))
    if (margin < worst) {
      worst = margin
      worstBand = BAND_CENTRES[i] ?? 0
    }
  }

  let best = Number.NEGATIVE_INFINITY
  let bestBand = 0
  for (const i of own) {
    const margin = 10 * Math.log10((signalBands[i] ?? 0) / Math.max(bedBands[i] ?? 0, 1e-18))
    if (margin > best) {
      best = margin
      bestBand = BAND_CENTRES[i] ?? 0
    }
  }

  return {
    meanMarginDb: weight <= 0 ? Number.NEGATIVE_INFINITY : weighted / weight,
    worstMarginDb: worst,
    worstBandHz: worstBand,
    bestMarginDb: best,
    bestBandHz: bestBand,
  }
}

/** A time range of a buffer, in seconds. Clamped to what exists. */
export function slicePcm(pcm: Pcm, fromSec: number, toSec: number): Pcm {
  const from = Math.max(0, Math.round(fromSec * pcm.sampleRate))
  const to = Math.min(frameCount(pcm), Math.round(toSec * pcm.sampleRate))
  return {
    sampleRate: pcm.sampleRate,
    channels: pcm.channels.map((channel) => channel.slice(from, Math.max(from, to))),
  }
}

function indexOfMax(values: Float64Array): number {
  let best = 0
  for (let i = 1; i < values.length; i++) if ((values[i] ?? 0) > (values[best] ?? 0)) best = i
  return best
}

// ---------------------------------------------------------------------------
// the summary a report prints
// ---------------------------------------------------------------------------

export interface Measurement {
  readonly peak: number
  readonly peakDb: number
  readonly truePeakDb: number
  readonly rmsDb: number
  readonly lufs: number
  readonly durationSec: number
  readonly centroidHz: number
  readonly dcOffset: number
  /** Fraction of energy below 150 Hz — a laptop speaker's floor. */
  readonly subFraction: number
  /** Loudness of what survives a laptop speaker. */
  readonly smallSpeakerLufs: number
  /** How much loudness the cue loses on a laptop speaker, in LU. */
  readonly smallSpeakerLossLu: number
}

export function measure(pcm: Pcm): Measurement {
  const spectrum = powerSpectrum(pcm)
  const p = peak(pcm)
  const lufs = loudnessLufs(pcm)
  const small = smallSpeakerLufs(pcm)
  return {
    peak: p,
    peakDb: toDb(p),
    truePeakDb: toDb(truePeak(pcm)),
    rmsDb: toDb(rms(pcm)),
    lufs,
    durationSec: effectiveDuration(pcm),
    centroidHz: spectralCentroid(spectrum, pcm.sampleRate),
    dcOffset: dcOffset(pcm),
    subFraction: energyFractionBelow(spectrum, pcm.sampleRate, 150),
    smallSpeakerLufs: small,
    smallSpeakerLossLu: lufs - small,
  }
}
