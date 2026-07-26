/**
 * A WAV encoder, in about sixty lines, because this project has no dependencies
 * and a RIFF header is not a reason to acquire one (CLAUDE.md).
 *
 * WHY 32-BIT FLOAT rather than the usual 16-bit PCM: these files exist so a human
 * can listen to the thing the analysis just measured, and the most important
 * thing to be able to hear is *clipping*. Converting to 16-bit would clamp
 * anything past full scale on the way out, so an overloaded mix would arrive on
 * disk sounding merely loud, and the file would quietly disagree with the peak
 * number printed next to it. Float32 keeps overs intact and is read by every
 * player worth using.
 *
 * The files are build output, not assets — `audio/` is gitignored, and the
 * "no binary assets" rule is about what ships, not about what a tool writes for
 * a human to check.
 */

import type { Pcm } from './analysis'

/** IEEE 754 float samples. Format tag 1 is integer PCM; 3 is float. */
const FORMAT_IEEE_FLOAT = 3
const BITS_PER_SAMPLE = 32
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8

export function encodeWav(pcm: Pcm): Uint8Array {
  const channels = pcm.channels.length
  const frames = pcm.channels[0]?.length ?? 0
  const dataBytes = frames * channels * BYTES_PER_SAMPLE
  // 'fmt ' is 16 bytes for integer PCM but 18 for every other format tag: the
  // cbSize field is mandatory outside WAVE_FORMAT_PCM, and players that check
  // reject the file without it.
  const fmtBytes = 18
  const buffer = new ArrayBuffer(12 + (8 + fmtBytes) + 8 + dataBytes)
  const view = new DataView(buffer)

  let offset = 0
  const ascii = (text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
    offset += text.length
  }
  const u32 = (value: number): void => {
    view.setUint32(offset, value, true)
    offset += 4
  }
  const u16 = (value: number): void => {
    view.setUint16(offset, value, true)
    offset += 2
  }

  ascii('RIFF')
  u32(buffer.byteLength - 8)
  ascii('WAVE')

  ascii('fmt ')
  u32(fmtBytes)
  u16(FORMAT_IEEE_FLOAT)
  u16(channels)
  u32(pcm.sampleRate)
  u32(pcm.sampleRate * channels * BYTES_PER_SAMPLE)
  u16(channels * BYTES_PER_SAMPLE)
  u16(BITS_PER_SAMPLE)
  u16(0)

  ascii('data')
  u32(dataBytes)

  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      view.setFloat32(offset, pcm.channels[channel]?.[frame] ?? 0, true)
      offset += 4
    }
  }

  return new Uint8Array(buffer)
}
