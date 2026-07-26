/**
 * Tests for the measurement instrument itself.
 *
 * `src/audio/analysis.ts` is hand-written DSP — an FFT, K-weighting filters, a
 * sinc interpolator — because this project has no dependencies. That is fine
 * right up until the moment its numbers are used to make decisions about the
 * game, which is exactly what `npm run audio` does. A wrong FFT would not throw;
 * it would quietly certify a mix, or condemn a good one, and nothing downstream
 * could tell.
 *
 * So everything here checks against an answer known in closed form: a sine's RMS
 * is A/√2, a sine's spectral centroid is its own frequency, an FFT agrees with a
 * naive DFT, K-weighting discounts bass and lifts presence by amounts the
 * standard specifies. None of these tests know anything about the game.
 */

import { describe, expect, it } from 'vitest'
import {
  BAND_CENTRES,
  effectiveDuration,
  dcOffset,
  energyFractionBelow,
  fft,
  fingerprint,
  loudnessLufs,
  LOUDNESS_SAMPLE_RATE,
  discriminationMargin,
  maskingMargin,
  measure,
  mono,
  onsetTime,
  peak,
  powerSpectrum,
  rms,
  separation,
  smallSpeaker,
  smallSpeakerLufs,
  spectralCentroid,
  toDb,
  truePeak,
  type Pcm,
} from '../src/audio/analysis'
import { encodeWav } from '../src/audio/wav'

const RATE = LOUDNESS_SAMPLE_RATE

function sine(hz: number, amplitude = 1, seconds = 1, phase = 0, channels = 2): Pcm {
  const n = Math.round(seconds * RATE)
  const data = new Float32Array(n)
  for (let i = 0; i < n; i++) data[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE + phase)
  return { sampleRate: RATE, channels: Array.from({ length: channels }, () => data.slice()) }
}

function silence(seconds: number, channels = 2): Pcm {
  const n = Math.round(seconds * RATE)
  return { sampleRate: RATE, channels: Array.from({ length: channels }, () => new Float32Array(n)) }
}

/** A deterministic noise burst placed inside a longer buffer. */
function burst(startSec: number, lengthSec: number, totalSec: number, amplitude = 0.5): Pcm {
  const n = Math.round(totalSec * RATE)
  const data = new Float32Array(n)
  const from = Math.round(startSec * RATE)
  const to = Math.min(n, from + Math.round(lengthSec * RATE))
  // A fixed LCG rather than Math.random: a flaky measurement test is worse than
  // no measurement test.
  let state = 12345
  for (let i = from; i < to; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    data[i] = ((state / 0xffffffff) * 2 - 1) * amplitude
  }
  return { sampleRate: RATE, channels: [data, data.slice()] }
}

describe('levels', () => {
  it('measures the peak of a sine as its amplitude', () => {
    expect(peak(sine(1000, 0.5))).toBeCloseTo(0.5, 3)
    expect(peak(silence(0.1))).toBe(0)
  })

  it('measures RMS as A over root two', () => {
    expect(rms(sine(1000, 1))).toBeCloseTo(Math.SQRT1_2, 3)
    expect(rms(sine(1000, 0.25))).toBeCloseTo(0.25 * Math.SQRT1_2, 3)
  })

  it('finds inter-sample peaks that the sample peak misses', () => {
    // A 12 kHz sine at 48 kHz lands four samples per cycle. Shifted an eighth of
    // a cycle, every sample sits at cos(45°) = 0.707 of the amplitude and the
    // real crest falls between two of them. Sample peak says 0.707; a converter
    // reconstructs 1.0, and that is the difference between "loud" and "clipped".
    const tricky = sine(12000, 1, 0.05, Math.PI / 4)
    expect(peak(tricky)).toBeCloseTo(Math.SQRT1_2, 2)
    const true_ = truePeak(tricky)
    expect(true_).toBeGreaterThan(0.95)
    expect(true_).toBeLessThan(1.05)
  })

  it('never reports a true peak below the sample peak', () => {
    for (const hz of [80, 440, 3000, 9000]) {
      const pcm = sine(hz, 0.6, 0.05)
      expect(truePeak(pcm)).toBeGreaterThanOrEqual(peak(pcm) - 1e-6)
    }
  })

  it('measures DC offset, and reports none for a sine', () => {
    const n = RATE
    const flat = new Float32Array(n).fill(0.25)
    expect(dcOffset({ sampleRate: RATE, channels: [flat] })).toBeCloseTo(0.25, 4)
    expect(dcOffset(sine(1000, 1))).toBeLessThan(1e-4)
  })

  it('converts to dB with a floor rather than negative infinity', () => {
    expect(toDb(1)).toBeCloseTo(0, 6)
    expect(toDb(0.5)).toBeCloseTo(-6.02, 1)
    expect(Number.isFinite(toDb(0))).toBe(true)
  })

  it('downmixes by averaging, so a centred cue keeps its level', () => {
    const pcm = sine(1000, 0.5)
    expect(peak({ sampleRate: RATE, channels: [mono(pcm)] })).toBeCloseTo(0.5, 3)
  })
})

describe('loudness', () => {
  it('refuses a sample rate its coefficients are not valid for', () => {
    expect(() => loudnessLufs({ sampleRate: 44100, channels: [new Float32Array(10)] })).toThrow()
  })

  it('anchors a full-scale 1 kHz sine near 0 LUFS', () => {
    // The BS.1770 calibration point. K-weighting is close to flat at 1 kHz, so a
    // stereo full-scale tone lands within a decibel of zero.
    expect(loudnessLufs(sine(1000, 1))).toBeGreaterThan(-1.5)
    expect(loudnessLufs(sine(1000, 1))).toBeLessThan(1.5)
  })

  it('tracks amplitude at 6 dB per doubling', () => {
    const loud = loudnessLufs(sine(1000, 0.5))
    const quiet = loudnessLufs(sine(1000, 0.25))
    expect(loud - quiet).toBeCloseTo(6.02, 1)
  })

  it('discounts bass and lifts presence, which is the whole point of K-weighting', () => {
    const low = loudnessLufs(sine(60, 0.5))
    const mid = loudnessLufs(sine(1000, 0.5))
    const high = loudnessLufs(sine(3000, 0.5))
    // A 60 Hz tone at the same amplitude is substantially less loud to a listener.
    expect(mid - low).toBeGreaterThan(3)
    // And the shelf lifts the presence region where the ear is most sensitive.
    expect(high - mid).toBeGreaterThan(1)
  })

  it('counts both channels, so a stereo cue is louder than a one-sided one', () => {
    const stereo = sine(1000, 0.5)
    const oneSided: Pcm = {
      sampleRate: RATE,
      channels: [stereo.channels[0] ?? new Float32Array(0), new Float32Array(RATE)],
    }
    expect(loudnessLufs(stereo) - loudnessLufs(oneSided)).toBeCloseTo(3.01, 1)
  })
})

describe('the small-speaker model', () => {
  it('removes what a laptop cannot reproduce and keeps what it can', () => {
    const sub = sine(50, 0.5)
    const mid = sine(2000, 0.5)
    expect(loudnessLufs(sub) - smallSpeakerLufs(sub)).toBeGreaterThan(20)
    expect(loudnessLufs(mid) - smallSpeakerLufs(mid)).toBeLessThan(1)
  })

  it('leaves the buffer shape alone', () => {
    const pcm = sine(1000, 0.5, 0.1)
    const filtered = smallSpeaker(pcm)
    expect(filtered.sampleRate).toBe(pcm.sampleRate)
    expect(filtered.channels.length).toBe(pcm.channels.length)
    expect(filtered.channels[0]?.length).toBe(pcm.channels[0]?.length)
  })
})

describe('timing', () => {
  it('measures the audible span, not the buffer length', () => {
    expect(effectiveDuration(burst(0.3, 0.2, 1))).toBeCloseTo(0.2, 1)
    expect(effectiveDuration(silence(1))).toBe(0)
  })

  it('finds when a cue starts', () => {
    expect(onsetTime(burst(0.3, 0.2, 1))).toBeCloseTo(0.3, 1)
    expect(onsetTime(burst(0, 0.2, 1))).toBeCloseTo(0, 2)
  })
})

describe('spectrum', () => {
  it('agrees with a naive DFT', () => {
    const n = 64
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    let state = 999
    const input: number[] = []
    for (let i = 0; i < n; i++) {
      state = (state * 1103515245 + 12345) >>> 0
      const v = (state / 0xffffffff) * 2 - 1
      input.push(v)
      re[i] = v
    }
    fft(re, im)

    for (let k = 0; k < n; k++) {
      let sumRe = 0
      let sumIm = 0
      for (let i = 0; i < n; i++) {
        const angle = (-2 * Math.PI * k * i) / n
        sumRe += (input[i] ?? 0) * Math.cos(angle)
        sumIm += (input[i] ?? 0) * Math.sin(angle)
      }
      expect(re[k] ?? 0).toBeCloseTo(sumRe, 6)
      expect(im[k] ?? 0).toBeCloseTo(sumIm, 6)
    }
  })

  it('puts a pure tone’s spectral centroid at its own frequency', () => {
    // Exact, not approximate. This tolerance is why the centroid is weighted by
    // power rather than magnitude — see the note on `spectralCentroid`.
    for (const hz of [300, 500, 1000, 4000, 8000]) {
      const centroid = spectralCentroid(powerSpectrum(sine(hz, 0.5, 0.3)), RATE)
      expect(Math.abs(Math.log2(centroid / hz)), `${hz}Hz`).toBeLessThan(0.02)
    }
  })

  it('places a tone in the third-octave band it belongs to', () => {
    const spectrum = powerSpectrum(sine(1000, 0.5, 0.3))
    const fraction = energyFractionBelow(spectrum, RATE, 900)
    expect(fraction).toBeLessThan(0.1)
    expect(energyFractionBelow(spectrum, RATE, 1200)).toBeGreaterThan(0.9)
    expect(BAND_CENTRES.length).toBeGreaterThan(20)
  })

  it('reports sub-bass content as sub-bass content', () => {
    expect(energyFractionBelow(powerSpectrum(sine(50, 0.5, 0.3)), RATE, 150)).toBeGreaterThan(0.9)
    expect(energyFractionBelow(powerSpectrum(sine(2000, 0.5, 0.3)), RATE, 150)).toBeLessThan(0.05)
  })
})

describe('distinguishability', () => {
  it('scores a cue against itself as zero', () => {
    const print = fingerprint(burst(0.05, 0.2, 0.5))
    const s = separation(print, print)
    expect(s.score).toBeCloseTo(0, 6)
    expect(s.centroidOctaves).toBeCloseTo(0, 6)
  })

  it('measures brightness difference in octaves', () => {
    const s = separation(fingerprint(sine(500, 0.5, 0.2)), fingerprint(sine(4000, 0.5, 0.2)))
    expect(s.centroidOctaves).toBeCloseTo(3, 0)
    expect(s.score).toBeGreaterThan(1)
  })

  it('measures length difference in doublings', () => {
    const short = fingerprint(burst(0.05, 0.05, 0.6))
    const long = fingerprint(burst(0.05, 0.4, 0.6))
    expect(long.durationSec).toBeGreaterThan(short.durationSec)
    expect(separation(short, long).durationOctaves).toBeCloseTo(3, 0)
  })

  it('takes the maximum across axes, not the average', () => {
    // Two cues identical in every way but length must still score on length
    // alone — a sum would dilute an obvious difference into a mediocre number.
    const a = fingerprint(burst(0.05, 0.05, 0.6))
    const b = fingerprint(burst(0.05, 0.4, 0.6))
    const s = separation(a, b)
    expect(s.score).toBeGreaterThanOrEqual(s.durationOctaves)
    expect(s.spectralDistance).toBeLessThan(0.15)
  })
})

describe('masking', () => {
  it('reports the level a signal stands above a bed in its own bands', () => {
    const signal = sine(4000, 0.5, 0.3)
    const bed = sine(4000, 0.05, 0.3)
    // A tenth of the amplitude is 20 dB down, in the same band.
    expect(maskingMargin(signal, bed).meanMarginDb).toBeCloseTo(20, 0)
  })

  it('gives a large margin when the bed sits somewhere else entirely', () => {
    const signal = sine(4000, 0.3, 0.3)
    const bed = sine(300, 0.6, 0.3)
    expect(maskingMargin(signal, bed).meanMarginDb).toBeGreaterThan(30)
  })

  it('reports a negative margin when the signal is buried', () => {
    const signal = sine(4000, 0.05, 0.3)
    const bed = sine(4000, 0.5, 0.3)
    expect(maskingMargin(signal, bed).meanMarginDb).toBeLessThan(-15)
  })

  it('names the band where the margin is worst', () => {
    const report = maskingMargin(sine(4000, 0.3, 0.3), sine(4000, 0.3, 0.3))
    expect(report.worstBandHz).toBeGreaterThan(3000)
    expect(report.worstBandHz).toBeLessThan(5500)
  })
})

describe('in-combat discrimination', () => {
  /**
   * `separation` asks whether two cues differ. This asks whether the difference
   * is still there when something else is playing — which is the question that
   * matters for a pair like "shield held" against "shield gone".
   */
  const bed = (hz: number, amplitude: number): Pcm => sine(hz, amplitude, 2)

  it('reports nothing to hear when the two cues are identical', () => {
    const cue = burst(0.05, 0.1, 0.5, 0.3)
    expect(discriminationMargin(cue, cue, bed(1000, 0.2)).bestMarginDb).toBeLessThan(0)
  })

  it('finds a large margin when the difference sits where the bed is quiet', () => {
    // A differs from B only at 6 kHz; the bed is all at 300 Hz.
    const a = sine(6000, 0.4, 0.3)
    const b = silence(0.3)
    const report = discriminationMargin(a, b, bed(300, 0.5))
    expect(report.bestMarginDb).toBeGreaterThan(20)
    expect(report.bestBandHz).toBeGreaterThan(4500)
  })

  it('finds a small margin when the bed covers the difference', () => {
    const a = sine(6000, 0.1, 0.3)
    const b = silence(0.3)
    expect(discriminationMargin(a, b, bed(6000, 0.6)).bestMarginDb).toBeLessThan(0)
  })

  it('will not credit a difference a real speaker cannot reproduce', () => {
    // The two cues differ hugely — at 50 Hz, where no laptop or phone reproduces
    // anything. That is not a difference the player can use.
    const a = sine(50, 0.8, 0.3)
    const b = silence(0.3)
    const report = discriminationMargin(a, b, bed(300, 0.02))
    expect(report.bestBandHz === 0 || report.bestBandHz >= 150).toBe(true)
  })

  it('does not depend on where the bed happens to be cut', () => {
    // The bed is averaged over its whole length and scaled, so a longer or
    // shorter bed of the same character gives the same answer. An instrument
    // whose verdict moves with an arbitrary slice point is not an instrument.
    const a = sine(6000, 0.4, 0.3)
    const b = silence(0.3)
    const short = discriminationMargin(a, b, bed(1000, 0.3)).bestMarginDb
    const long = discriminationMargin(a, b, sine(1000, 0.3, 4)).bestMarginDb
    expect(Math.abs(short - long)).toBeLessThan(1)
  })
})

describe('the summary a report prints', () => {
  it('fills in every field for a real-looking cue', () => {
    const m = measure(burst(0.05, 0.15, 0.6, 0.3))
    expect(m.peak).toBeGreaterThan(0)
    expect(m.peakDb).toBeLessThan(0)
    expect(m.truePeakDb).toBeGreaterThanOrEqual(m.peakDb - 1e-6)
    expect(Number.isFinite(m.lufs)).toBe(true)
    expect(m.durationSec).toBeCloseTo(0.15, 1)
    expect(m.centroidHz).toBeGreaterThan(0)
    expect(m.smallSpeakerLossLu).toBeGreaterThanOrEqual(-0.5)
  })
})

describe('the WAV encoder', () => {
  it('writes a header a player will accept', () => {
    const pcm = sine(1000, 0.5, 0.01)
    const bytes = encodeWav(pcm)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const tag = (at: number): string => String.fromCharCode(...bytes.subarray(at, at + 4))

    expect(tag(0)).toBe('RIFF')
    expect(tag(8)).toBe('WAVE')
    expect(tag(12)).toBe('fmt ')
    expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8)
    // 18, not 16: cbSize is mandatory for any format tag other than integer PCM,
    // and players that check reject the file without it.
    expect(view.getUint32(16, true)).toBe(18)
    expect(view.getUint16(20, true)).toBe(3) // IEEE float
    expect(view.getUint16(22, true)).toBe(2) // stereo
    expect(view.getUint32(24, true)).toBe(RATE)
    expect(view.getUint16(34, true)).toBe(32)
    expect(tag(38)).toBe('data')
  })

  it('round-trips samples exactly, including values past full scale', () => {
    // The reason for float rather than 16-bit: a clipped mix must arrive on disk
    // still clipped, or the file disagrees with the number printed beside it.
    const channel = Float32Array.from([0, 0.5, -0.5, 1.75, -1.75])
    const bytes = encodeWav({ sampleRate: RATE, channels: [channel] })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const dataAt = 12 + 8 + 18 + 8
    for (let i = 0; i < channel.length; i++) {
      expect(view.getFloat32(dataAt + i * 4, true)).toBeCloseTo(channel[i] ?? 0, 6)
    }
  })

  it('interleaves channels', () => {
    const left = Float32Array.from([1, 3])
    const right = Float32Array.from([2, 4])
    const bytes = encodeWav({ sampleRate: RATE, channels: [left, right] })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const dataAt = 12 + 8 + 18 + 8
    expect([0, 1, 2, 3].map((i) => view.getFloat32(dataAt + i * 4, true))).toEqual([1, 2, 3, 4])
  })
})
