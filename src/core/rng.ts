/**
 * Seeded, deterministic random number generation.
 *
 * THE CONTRACT: `Math.random()` must never appear in simulation code. Every
 * random decision in a run comes from an Rng derived from the run's seed, so the
 * same seed plus the same inputs always produces the same run — on any machine,
 * in any browser, in a headless test.
 *
 * Uses only integer ops (Math.imul, |0, >>>) so results are bit-identical
 * everywhere. Floats are derived from u32 by division, which is exact.
 */

/** cyrb128 — hashes a string into four 32-bit values for seeding. */
function hashSeed(str: string): [number, number, number, number] {
  let h1 = 1779033703
  let h2 = 3144134277
  let h3 = 1013904242
  let h4 = 2773480762
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i)
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067)
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233)
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213)
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179)
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067)
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233)
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213)
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179)
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0]
}

/** Serialisable RNG state — four u32s. Lets us snapshot mid-run for replays. */
export type RngState = readonly [number, number, number, number]

export class Rng {
  private a: number
  private b: number
  private c: number
  private d: number

  private constructor(state: RngState) {
    this.a = state[0] | 0
    this.b = state[1] | 0
    this.c = state[2] | 0
    this.d = state[3] | 0
  }

  /**
   * Create an Rng for a named stream of a seed.
   *
   * Streams matter: spawn decisions, loot rolls, and cosmetic particles must
   * each draw from their own stream. Otherwise adding a visual effect silently
   * changes which items drop, and every recorded replay breaks.
   */
  static fromSeed(seed: string, stream = 'root'): Rng {
    return new Rng(hashSeed(`${seed}::${stream}`))
  }

  static fromState(state: RngState): Rng {
    return new Rng(state)
  }

  state(): RngState {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0]
  }

  /** sfc32 — small, fast, passes PractRand, trivially portable. */
  nextU32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0
    this.d = (this.d + 1) | 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) | 0
    this.c = (this.c << 21) | (this.c >>> 11)
    this.c = (this.c + t) | 0
    return t >>> 0
  }

  /** Uniform in [0, 1). */
  float(): number {
    return this.nextU32() / 4294967296
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.float() * (max - min)
  }

  /** Uniform integer in [0, maxExclusive). Unbiased via rejection sampling. */
  int(maxExclusive: number): number {
    if (maxExclusive <= 0) throw new Error(`Rng.int requires a positive bound, got ${maxExclusive}`)
    // Reject the ragged tail so every value is equally likely. Without this,
    // low values are very slightly favoured — which shows up as bias in loot
    // tables over thousands of simulated runs.
    const limit = 4294967296 - (4294967296 % maxExclusive)
    let x = this.nextU32()
    while (x >= limit) x = this.nextU32()
    return x % maxExclusive
  }

  /** Integer in [min, max], inclusive on both ends. */
  intBetween(min: number, max: number): number {
    return min + this.int(max - min + 1)
  }

  chance(probability: number): boolean {
    return this.float() < probability
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick called on an empty array')
    return items[this.int(items.length)] as T
  }

  /** Fisher-Yates on a copy. Never mutates the input. */
  shuffled<T>(items: readonly T[]): T[] {
    const out = items.slice()
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      const a = out[i] as T
      const b = out[j] as T
      out[i] = b
      out[j] = a
    }
    return out
  }

  /** Pick `count` distinct items. Returns fewer only if the pool is smaller. */
  sample<T>(items: readonly T[], count: number): T[] {
    return this.shuffled(items).slice(0, count)
  }

  /** Weighted pick. Weights must be non-negative; at least one must be > 0. */
  weighted<T>(items: readonly T[], weightOf: (item: T) => number): T {
    if (items.length === 0) throw new Error('Rng.weighted called on an empty array')
    let total = 0
    for (const item of items) {
      const w = weightOf(item)
      if (w < 0) throw new Error(`Rng.weighted got a negative weight: ${w}`)
      total += w
    }
    if (total <= 0) throw new Error('Rng.weighted requires at least one positive weight')
    let roll = this.float() * total
    for (const item of items) {
      roll -= weightOf(item)
      if (roll < 0) return item
    }
    return items[items.length - 1] as T
  }
}
