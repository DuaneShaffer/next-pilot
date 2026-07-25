import { describe, expect, it } from 'vitest'
import {
  SEED_LENGTH,
  dailySeed,
  formatSeed,
  generateSeed,
  isValidSeed,
  normalizeSeed,
} from '../src/core/seed'

describe('seed normalisation', () => {
  it('accepts a formatted seed as equivalent to a bare one', () => {
    expect(normalizeSeed('K7F2-9XQM-3RTV')).toBe('K7F29XQM3RTV')
  })

  it('ignores case and stray whitespace', () => {
    expect(normalizeSeed(' k7f2 9xqm 3rtv ')).toBe('K7F29XQM3RTV')
  })

  it('folds visually ambiguous characters', () => {
    // Someone reading a seed aloud or off a screenshot will confuse these; the
    // game should land on the same run either way rather than reject the input.
    expect(normalizeSeed('IIII')).toBe('JJJJ')
    expect(normalizeSeed('LLLL')).toBe('JJJJ')
    expect(normalizeSeed('OOOO')).toBe('QQQQ')
    expect(normalizeSeed('UUUU')).toBe('VVVV')
    expect(normalizeSeed('0000')).toBe('QQQQ')
    expect(normalizeSeed('1111')).toBe('JJJJ')
  })

  it('truncates overlong input', () => {
    expect(normalizeSeed('K7F29XQM3RTVEXTRAJUNK')).toHaveLength(SEED_LENGTH)
  })
})

describe('seed formatting', () => {
  it('groups into readable blocks', () => {
    expect(formatSeed('K7F29XQM3RTV')).toBe('K7F2-9XQM-3RTV')
  })

  it('round-trips through formatting', () => {
    const seed = generateSeed()
    expect(normalizeSeed(formatSeed(seed))).toBe(seed)
  })
})

describe('seed validation', () => {
  it('accepts generated seeds', () => {
    for (let i = 0; i < 500; i++) {
      const seed = generateSeed()
      expect(seed).toHaveLength(SEED_LENGTH)
      expect(isValidSeed(seed)).toBe(true)
      expect(isValidSeed(formatSeed(seed))).toBe(true)
    }
  })

  it('rejects the wrong length', () => {
    expect(isValidSeed('K7F2')).toBe(false)
    expect(isValidSeed('')).toBe(false)
  })
})

describe('daily seed', () => {
  it('is stable for a given UTC date', () => {
    const a = dailySeed(new Date('2026-07-25T00:00:01Z'))
    const b = dailySeed(new Date('2026-07-25T23:59:59Z'))
    expect(a).toBe(b)
  })

  it('differs between consecutive days', () => {
    const a = dailySeed(new Date('2026-07-25T12:00:00Z'))
    const b = dailySeed(new Date('2026-07-26T12:00:00Z'))
    expect(a).not.toBe(b)
  })

  it('produces a valid seed', () => {
    // Sample a year of dates: every daily contract must be playable.
    for (let day = 0; day < 365; day++) {
      const date = new Date(Date.UTC(2026, 0, 1 + day))
      expect(isValidSeed(dailySeed(date))).toBe(true)
    }
  })
})
