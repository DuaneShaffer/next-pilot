import { describe, expect, it } from 'vitest'
import { FixedLoop, TICK_HZ, TICK_MS, runHeadless } from '../src/core/loop'

/** A loop that just counts, driven by a synthetic clock. */
function counterLoop(): { loop: FixedLoop; ticks: () => number; alphas: number[] } {
  let ticks = 0
  const alphas: number[] = []
  const loop = new FixedLoop({
    tick: () => {
      ticks++
    },
    render: (alpha) => {
      alphas.push(alpha)
    },
  })
  return { loop, ticks: () => ticks, alphas }
}

describe('FixedLoop', () => {
  it('runs no ticks on the first advance', () => {
    // The first call only establishes the clock baseline; ticking here would make
    // the very first frame's duration depend on page load timing.
    const { loop, ticks } = counterLoop()
    loop.advance(1000)
    expect(ticks()).toBe(0)
  })

  it('runs one tick per tick-length of elapsed time', () => {
    // TICK_MS is 16.666…, so floating-point accumulation can leave a tick a
    // fraction short and defer it to the next advance. That is correct — the
    // remainder stays in the accumulator — so the tolerance is one tick.
    const { loop, ticks } = counterLoop()
    loop.advance(0)
    for (let i = 1; i <= TICK_HZ; i++) loop.advance(i * TICK_MS)
    expect(ticks()).toBeGreaterThanOrEqual(TICK_HZ - 1)
    expect(ticks()).toBeLessThanOrEqual(TICK_HZ)
  })

  it('does not drift over a long run', () => {
    // The property that actually matters: deferred ticks must be paid back, not
    // dropped. Ten simulated seconds must produce ~600 ticks, not 590.
    const { loop, ticks } = counterLoop()
    loop.advance(0)
    const totalTicks = TICK_HZ * 10
    for (let i = 1; i <= totalTicks; i++) loop.advance(i * TICK_MS)
    expect(Math.abs(ticks() - totalTicks)).toBeLessThanOrEqual(1)
    expect(loop.getStats().droppedTicks).toBe(0)
  })

  it('accumulates sub-tick time instead of losing it', () => {
    const { loop, ticks } = counterLoop()
    loop.advance(0)
    // Four advances of a third of a tick each: 1.33 ticks' worth of time.
    for (let i = 1; i <= 4; i++) loop.advance((i * TICK_MS) / 3)
    expect(ticks()).toBe(1)
  })

  it('renders once per advance regardless of tick count', () => {
    const { loop, alphas } = counterLoop()
    loop.advance(0)
    loop.advance(TICK_MS * 2.5)
    loop.advance(TICK_MS * 3)
    expect(alphas).toHaveLength(3)
  })

  it('reports alpha inside [0, 1)', () => {
    const { loop, alphas } = counterLoop()
    loop.advance(0)
    for (let i = 1; i <= 40; i++) loop.advance(i * TICK_MS * 0.37)
    for (const alpha of alphas) {
      expect(alpha).toBeGreaterThanOrEqual(0)
      expect(alpha).toBeLessThan(1)
    }
  })

  it('drops ticks rather than spiralling after a long stall', () => {
    // A backgrounded tab can return with seconds of elapsed time. Catching all of
    // it up would freeze the frame and make things worse.
    const { loop, ticks } = counterLoop()
    loop.advance(0)
    loop.advance(5000)
    expect(ticks()).toBe(5)
    expect(loop.getStats().droppedTicks).toBeGreaterThan(200)
  })

  it('ignores a clock that moves backwards', () => {
    const { loop, ticks } = counterLoop()
    loop.advance(1000)
    loop.advance(900)
    expect(ticks()).toBe(0)
    expect(() => loop.advance(1000)).not.toThrow()
  })

  it('does not sprint to catch up after resetClock', () => {
    const { loop, ticks } = counterLoop()
    loop.advance(0)
    loop.advance(TICK_MS * 0.9)
    loop.resetClock()
    loop.advance(10_000)
    expect(ticks()).toBe(0)
  })

  it('counts frames and ticks separately', () => {
    const { loop } = counterLoop()
    loop.advance(0)
    loop.advance(TICK_MS)
    loop.advance(TICK_MS * 2)
    const stats = loop.getStats()
    expect(stats.frames).toBe(3)
    expect(stats.ticks).toBe(2)
  })
})

describe('runHeadless', () => {
  it('runs an exact number of ticks with no clock', () => {
    let ticks = 0
    runHeadless(() => {
      ticks++
    }, 10_000)
    expect(ticks).toBe(10_000)
  })
})
