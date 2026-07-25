/**
 * Fixed-timestep simulation loop.
 *
 * THE CONTRACT: the simulation advances in whole ticks of exactly TICK_MS, and
 * never sees a variable delta. Rendering happens at whatever rate the display
 * offers and interpolates between ticks. This is what makes a run reproducible:
 * dt-scaled movement would make outcomes depend on framerate, and no replay or
 * seeded challenge would ever match.
 *
 * This file also carries the loop's timing instrumentation, because it is the one
 * place that knows where a tick begins and ends. The measurements it records are
 * observations only — nothing in the tick-scheduling arithmetic below reads a
 * duration, so turning instrumentation on or off cannot change how many ticks run
 * or in what order. If that ever stops being true, the determinism contract is
 * broken and every recorded replay is void.
 */

export const TICK_HZ = 60
export const TICK_MS = 1000 / TICK_HZ
export const TICK_SECONDS = 1 / TICK_HZ

/** Never simulate more than this many ticks in one frame. */
const MAX_CATCHUP_TICKS = 5

export interface FixedLoopHooks {
  /** Advance the simulation exactly one tick. */
  tick(): void
  /**
   * Draw the current state. `alpha` is how far we are between the last tick and
   * the next (0..1), for interpolating positions so motion looks smooth even
   * though the sim runs at 60Hz on a 144Hz display.
   */
  render(alpha: number): void
}

// ---------------------------------------------------------------------------
// timing instrumentation
// ---------------------------------------------------------------------------

/**
 * How many samples each ring keeps.
 *
 * Sized so a p99 is drawn from enough samples to mean something: 2,048 ticks is
 * ~34 seconds of play, and the 99th percentile of 2,048 samples is the 21st worst
 * rather than a single outlier. Frames get half as many because a frame is the
 * coarser measurement and there are fewer of them per second under `?ff=`.
 *
 * The buffers are allocated once, at construction. Nothing in the hot path
 * allocates, grows, or sorts — `push` is a store and two integer bumps — because
 * an instrument that costs a measurable amount of the thing it measures reports
 * its own overhead as a performance problem. `tools/screenshot.mjs` made exactly
 * that mistake with dropped ticks; `tests/perf.test.ts` asserts this one has not.
 */
const TICK_SAMPLES = 2048
const FRAME_SAMPLES = 1024

export interface TimingSummary {
  /** Samples currently in the ring, i.e. how many the percentiles are over. */
  count: number
  /** Samples recorded since the loop started, including ones the ring has dropped. */
  total: number
  /** Milliseconds. */
  p50: number
  p99: number
  max: number
  mean: number
}

export interface LoopTiming {
  /**
   * One `hooks.tick()` call.
   *
   * Normally that is one simulation tick, and it is the figure the "sim tick <
   * 2ms" budget is written against. **It is not, under fast-forward.**
   * `src/main.ts` implements `?ff=N` by running N simulation steps inside a single
   * `hooks.tick()`, so at ff=12 each of these samples is twelve sim steps and
   * comparing it to the budget overstates the cost by roughly 12x. Dividing a p99
   * by N does not fix that — a percentile of sums is not a sum of percentiles.
   * `tools/perf.mjs` refuses to make budget claims at ff != 1 for this reason.
   */
  tick: TimingSummary
  /** One `advance()` call: every tick it ran, plus the render. The frame budget. */
  frame: TimingSummary
  /** The `hooks.render()` call alone, so a slow frame can be attributed. */
  render: TimingSummary
}

const EMPTY_SUMMARY: TimingSummary = { count: 0, total: 0, p50: 0, p99: 0, max: 0, mean: 0 }

/**
 * Fixed-capacity ring of durations with percentile readout.
 *
 * Percentiles are nearest-rank with no interpolation, matching
 * `tools/playtest.ts`: an interpolated p99 is a number no frame actually took,
 * and every figure this project reports should be traceable to a real event.
 */
class Ring {
  private readonly samples: Float64Array
  /** Sort buffer, allocated on first read and reused. Never touched while ticking. */
  private scratch: Float64Array | null = null
  private write = 0
  private count = 0
  private total = 0
  private sum = 0

  constructor(capacity: number) {
    this.samples = new Float64Array(capacity)
  }

  /** The hot path. Must stay allocation-free and branch-light. */
  push(ms: number): void {
    this.samples[this.write] = ms
    this.write++
    if (this.write === this.samples.length) this.write = 0
    if (this.count < this.samples.length) this.count++
    this.total++
    this.sum += ms
  }

  reset(): void {
    this.write = 0
    this.count = 0
    this.total = 0
    this.sum = 0
  }

  summary(): TimingSummary {
    const n = this.count
    if (n === 0) return { ...EMPTY_SUMMARY }

    let scratch = this.scratch
    if (scratch === null) {
      scratch = new Float64Array(this.samples.length)
      this.scratch = scratch
    }
    // Copy only the filled prefix. Before the ring wraps, the live samples are
    // [0, count); after it wraps, count === length, so this is the whole buffer.
    for (let i = 0; i < n; i++) scratch[i] = this.samples[i] ?? 0
    const view = scratch.subarray(0, n)
    view.sort()

    return {
      count: n,
      total: this.total,
      p50: rank(view, 0.5),
      p99: rank(view, 0.99),
      max: view[n - 1] ?? 0,
      // Mean over every sample ever pushed, not just the ring, so it does not
      // quietly become "mean of the last 34 seconds" without saying so.
      mean: this.total === 0 ? 0 : this.sum / this.total,
    }
  }
}

function rank(sorted: Float64Array, fraction: number): number {
  const n = sorted.length
  if (n === 0) return 0
  const index = Math.min(n - 1, Math.max(0, Math.ceil(fraction * n) - 1))
  return sorted[index] ?? 0
}

/** Monotonic millisecond clock, or null when no usable one exists. */
function defaultClock(): (() => number) | null {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance
  if (perf !== undefined && typeof perf.now === 'function') return () => perf.now?.() ?? 0
  return null
}

export interface FixedLoopOptions {
  /**
   * Record per-tick and per-frame durations. **On by default**, deliberately.
   *
   * The alternative was opt-in, and opt-in does not work here: `src/main.ts`
   * constructs the loop with no arguments and the browser harness
   * (`tools/perf.mjs`) reaches the game only through `window.__nextPilot.stats`.
   * An instrument that the deployed build cannot be asked to switch on is an
   * instrument that never measures the thing that ships.
   *
   * The cost is two clock reads per tick and two per frame — around 250 reads a
   * second at 60Hz, into preallocated buffers. `tests/perf.test.ts` measures that
   * overhead rather than asserting it is fine.
   */
  instrument?: boolean
  /**
   * Clock used for the measurements only, never for scheduling — `advance()`
   * takes the frame time from its caller and always will.
   *
   * Injectable so a test can feed known durations and check the percentile
   * arithmetic instead of hoping the machine cooperates.
   */
  now?: () => number
}

export interface LoopStats {
  /** Sim ticks executed since the loop started. */
  ticks: number
  /** Frames drawn since the loop started. */
  frames: number
  /**
   * Ticks dropped because the loop fell too far behind (tab backgrounded, or a
   * genuine performance problem). Non-zero here in a perf test is a failure.
   *
   * CAUTION: this counter is only a performance signal when nothing external is
   * stalling the renderer. Anything that blocks the main thread — a
   * `page.screenshot()`, a devtools pause, a breakpoint — shows up here as
   * dropped ticks that the game did not cause. See the note in
   * `tools/screenshot.mjs`.
   */
  droppedTicks: number
  /** Timing percentiles, or null when instrumentation is off. */
  timing: LoopTiming | null
}

/**
 * Drives a simulation at a fixed rate against a real clock.
 *
 * Deliberately has no knowledge of requestAnimationFrame — the caller supplies
 * the frame time. That keeps it testable: a test can feed a synthetic clock and
 * assert exact tick counts.
 */
export class FixedLoop {
  private accumulator = 0
  private lastTimeMs: number | null = null
  private ticks = 0
  private frames = 0
  private droppedTicks = 0

  /** All null together, or all set together. Null means instrumentation is off. */
  private readonly now: (() => number) | null
  private readonly tickRing: Ring | null
  private readonly frameRing: Ring | null
  private readonly renderRing: Ring | null

  constructor(
    private readonly hooks: FixedLoopHooks,
    options: FixedLoopOptions = {},
  ) {
    const wanted = options.instrument ?? true
    const clock = options.now ?? defaultClock()
    // No clock available means no instrumentation, rather than a crash. The game
    // must still run somewhere without `performance`.
    const on = wanted && clock !== null
    this.now = on ? clock : null
    this.tickRing = on ? new Ring(TICK_SAMPLES) : null
    this.frameRing = on ? new Ring(FRAME_SAMPLES) : null
    this.renderRing = on ? new Ring(FRAME_SAMPLES) : null
  }

  /**
   * Counters plus timing percentiles.
   *
   * Returns a fresh object because computing percentiles means sorting, which
   * must not happen while ticking. Call it when you want to read, not per frame.
   */
  getStats(): Readonly<LoopStats> {
    return {
      ticks: this.ticks,
      frames: this.frames,
      droppedTicks: this.droppedTicks,
      timing: this.getTiming(),
    }
  }

  /** Timing percentiles alone, or null when instrumentation is off. */
  getTiming(): LoopTiming | null {
    const tickRing = this.tickRing
    const frameRing = this.frameRing
    const renderRing = this.renderRing
    if (tickRing === null || frameRing === null || renderRing === null) return null
    return { tick: tickRing.summary(), frame: frameRing.summary(), render: renderRing.summary() }
  }

  /**
   * Discard collected timings, keeping the counters.
   *
   * The frames right after a navigation are not steady state — script compile,
   * first paint and font work all land there — and folding them into a p99 makes
   * the loop look slow at exactly the moment nothing is happening. A harness
   * warms up, calls this, then measures.
   */
  resetTimings(): void {
    this.tickRing?.reset()
    this.frameRing?.reset()
    this.renderRing?.reset()
  }

  /** Forget accumulated time — call after a pause so the sim doesn't sprint to catch up. */
  resetClock(): void {
    this.lastTimeMs = null
    this.accumulator = 0
  }

  /** Advance to `nowMs`, running whole ticks and then one render. */
  advance(nowMs: number): void {
    // Hoisted so the instrumented and uninstrumented paths differ by one null
    // check per frame rather than by a property load per tick.
    const clock = this.now
    const frameStart = clock === null ? 0 : clock()

    if (this.lastTimeMs === null) {
      this.lastTimeMs = nowMs
    }

    const elapsed = nowMs - this.lastTimeMs
    this.lastTimeMs = nowMs
    // Guard against a backwards or absurd clock (system sleep, clock skew).
    this.accumulator += elapsed > 0 ? elapsed : 0

    let ticksThisFrame = 0
    while (this.accumulator >= TICK_MS) {
      if (ticksThisFrame >= MAX_CATCHUP_TICKS) {
        // Bail out rather than spiralling: doing more work makes us later still.
        const dropped = Math.floor(this.accumulator / TICK_MS)
        this.droppedTicks += dropped
        this.accumulator = 0
        break
      }
      this.accumulator -= TICK_MS
      if (clock === null) {
        this.hooks.tick()
      } else {
        const start = clock()
        this.hooks.tick()
        this.tickRing?.push(clock() - start)
      }
      this.ticks++
      ticksThisFrame++
    }

    this.frames++
    if (clock === null) {
      this.hooks.render(this.accumulator / TICK_MS)
    } else {
      const renderStart = clock()
      this.hooks.render(this.accumulator / TICK_MS)
      const end = clock()
      this.renderRing?.push(end - renderStart)
      this.frameRing?.push(end - frameStart)
    }
  }
}

/**
 * Run a simulation for an exact number of ticks with no clock and no rendering.
 *
 * This is the headless driver used by tests and by bot playtests. Being able to
 * simulate thousands of full runs in seconds is how the game gets balanced
 * without a human playing it.
 */
export function runHeadless(tick: () => void, ticks: number): void {
  for (let i = 0; i < ticks; i++) tick()
}
