import { describe, expect, it } from 'vitest'
import {
  SEED_LENGTH,
  dailySeed,
  formatSeed,
  generateSeed,
  isValidSeed,
  looksLikeSeed,
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

describe('telling a seed from prose', () => {
  /**
   * REGRESSION. `normalizeSeed` is a repair function and repairs too well: it turned
   * "not a seed at all" into NQTASEEDATAJ, a perfectly valid seed for entirely the
   * wrong run. Pasting a *share link* into a seed box would likewise have mined
   * twelve characters out of the hostname.
   *
   * Both produce a confidently wrong answer with no error, which is the worst failure
   * a parser can have. `looksLikeSeed` is the gate that has to be passed first.
   */
  it('rejects prose that normalises into a valid-looking seed', () => {
    expect(isValidSeed(normalizeSeed('not a seed at all'))).toBe(true)
    // ...which is exactly why the gate exists.
    expect(looksLikeSeed('not a seed at all')).toBe(false)
  })

  it('rejects a URL rather than mining characters out of it', () => {
    for (const url of [
      'https://duaneshaffer.github.io/next-pilot/?seed=K7F2-9XQM-3RTV',
      'duaneshaffer.github.io/next-pilot',
      '?seed=K7F29XQM3RTV',
    ]) {
      expect(looksLikeSeed(url), url).toBe(false)
    }
  })

  it('accepts what a person would actually paste', () => {
    for (const text of ['K7F29XQM3RTV', 'K7F2-9XQM-3RTV', '  k7f2-9xqm-3rtv  ', 'K7F29XQM3RTU']) {
      expect(looksLikeSeed(text), text).toBe(true)
    }
  })

  it('rejects material of the wrong length', () => {
    expect(looksLikeSeed('K7F2')).toBe(false)
    expect(looksLikeSeed('K7F29XQM3RTVK7F29XQM3RTV')).toBe(false)
  })

  it('still repairs a seed that genuinely passed the gate', () => {
    // The gate must not break the ambiguity folding it protects.
    expect(looksLikeSeed('K7F2-9XQO-3RTL')).toBe(true)
    expect(isValidSeed(normalizeSeed('K7F2-9XQO-3RTL'))).toBe(true)
  })
})
