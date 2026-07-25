import { describe, expect, it } from 'vitest'
import { Rng } from '../src/core/rng'

/** Draw n u32s, for comparing sequences. */
function draw(rng: Rng, n: number): number[] {
  return Array.from({ length: n }, () => rng.nextU32())
}

describe('Rng determinism', () => {
  it('produces an identical sequence for the same seed and stream', () => {
    const a = draw(Rng.fromSeed('K7F29XQM3RTV', 'spawn'), 64)
    const b = draw(Rng.fromSeed('K7F29XQM3RTV', 'spawn'), 64)
    expect(a).toEqual(b)
  })

  it('produces a different sequence for a different seed', () => {
    const a = draw(Rng.fromSeed('K7F29XQM3RTV', 'spawn'), 32)
    const b = draw(Rng.fromSeed('K7F29XQM3RTW', 'spawn'), 32)
    expect(a).not.toEqual(b)
  })

  it('gives each named stream an independent sequence', () => {
    const spawn = draw(Rng.fromSeed('SEEDSEEDSEED', 'spawn'), 32)
    const loot = draw(Rng.fromSeed('SEEDSEEDSEED', 'loot'), 32)
    expect(spawn).not.toEqual(loot)
  })

  it('keeps streams independent when one is drained heavily', () => {
    // This is the property that lets us add visual effects without breaking
    // recorded replays: consuming cosmetic randomness must not shift loot.
    const lootAlone = draw(Rng.fromSeed('SEEDSEEDSEED', 'loot'), 8)

    const cosmetic = Rng.fromSeed('SEEDSEEDSEED', 'cosmetic')
    draw(cosmetic, 10_000)
    const lootAfter = draw(Rng.fromSeed('SEEDSEEDSEED', 'loot'), 8)

    expect(lootAfter).toEqual(lootAlone)
  })

  it('round-trips through serialised state', () => {
    const rng = Rng.fromSeed('STATESTATE12', 'spawn')
    draw(rng, 17)
    const snapshot = rng.state()
    const expected = draw(rng, 16)

    const restored = Rng.fromState(snapshot)
    expect(draw(restored, 16)).toEqual(expected)
  })
})

describe('Rng distributions', () => {
  it('keeps float() in [0, 1)', () => {
    const rng = Rng.fromSeed('FLOATFLOAT22')
    for (let i = 0; i < 20_000; i++) {
      const value = rng.float()
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  it('keeps int() in [0, max)', () => {
    const rng = Rng.fromSeed('INTINTINT234')
    for (let i = 0; i < 20_000; i++) {
      const value = rng.int(7)
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(7)
    }
  })

  it('distributes int() without visible bias', () => {
    const rng = Rng.fromSeed('BIASBIAS2345')
    const buckets = new Array<number>(6).fill(0)
    const samples = 120_000
    for (let i = 0; i < samples; i++) {
      const bucket = rng.int(6)
      buckets[bucket] = (buckets[bucket] ?? 0) + 1
    }
    const expected = samples / 6
    for (const count of buckets) {
      // Within 5% of uniform. Loose enough not to be flaky, tight enough to
      // catch the modulo bias that rejection sampling exists to prevent.
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.05)
    }
  })

  it('rejects a non-positive int() bound', () => {
    const rng = Rng.fromSeed('BOUNDBOUND23')
    expect(() => rng.int(0)).toThrow()
    expect(() => rng.int(-3)).toThrow()
  })

  it('respects weights', () => {
    const rng = Rng.fromSeed('WEIGHTWEIGH2')
    const items = [
      { id: 'common', weight: 90 },
      { id: 'rare', weight: 10 },
    ]
    let rareCount = 0
    const samples = 40_000
    for (let i = 0; i < samples; i++) {
      if (rng.weighted(items, (item) => item.weight).id === 'rare') rareCount++
    }
    expect(rareCount / samples).toBeGreaterThan(0.085)
    expect(rareCount / samples).toBeLessThan(0.115)
  })

  it('never picks a zero-weight item', () => {
    const rng = Rng.fromSeed('ZEROZEROZER2')
    const items = [
      { id: 'yes', weight: 1 },
      { id: 'never', weight: 0 },
    ]
    for (let i = 0; i < 5_000; i++) {
      expect(rng.weighted(items, (item) => item.weight).id).toBe('yes')
    }
  })
})

describe('Rng collections', () => {
  it('shuffles into a permutation without mutating the input', () => {
    const rng = Rng.fromSeed('SHUFFLESHUF2')
    const source = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    const shuffled = rng.shuffled(source)
    expect(shuffled).toHaveLength(source.length)
    expect([...shuffled].sort((a, b) => a - b)).toEqual([...source])
    expect(source).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })

  it('samples distinct items', () => {
    const rng = Rng.fromSeed('SAMPLESAMPL2')
    const picked = rng.sample(['a', 'b', 'c', 'd', 'e'], 3)
    expect(picked).toHaveLength(3)
    expect(new Set(picked).size).toBe(3)
  })

  it('caps sample() at the pool size', () => {
    const rng = Rng.fromSeed('CAPCAPCAP234')
    expect(rng.sample(['a', 'b'], 5)).toHaveLength(2)
  })

  it('throws when picking from an empty pool', () => {
    const rng = Rng.fromSeed('EMPTYEMPTY23')
    expect(() => rng.pick([])).toThrow()
  })
})
