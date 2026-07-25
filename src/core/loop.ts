/**
 * Fixed-timestep simulation loop.
 *
 * THE CONTRACT: the simulation advances in whole ticks of exactly TICK_MS, and
 * never sees a variable delta. Rendering happens at whatever rate the display
 * offers and interpolates between ticks. This is what makes a run reproducible:
 * dt-scaled movement would make outcomes depend on framerate, and no replay or
 * seeded challenge would ever match.
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

export interface LoopStats {
  /** Sim ticks executed since the loop started. */
  ticks: number
  /** Frames drawn since the loop started. */
  frames: number
  /**
   * Ticks dropped because the loop fell too far behind (tab backgrounded, or a
   * genuine performance problem). Non-zero here in a perf test is a failure.
   */
  droppedTicks: number
}

/**
 * Drives a simulation at a fixed rate against a real clock.
 *
 * Deliberately has no knowledge of requestAnimationFrame or performance.now —
 * the caller supplies time. That keeps it testable: a test can feed a synthetic
 * clock and assert exact tick counts.
 */
export class FixedLoop {
  private accumulator = 0
  private lastTimeMs: number | null = null
  private readonly stats: LoopStats = { ticks: 0, frames: 0, droppedTicks: 0 }

  constructor(private readonly hooks: FixedLoopHooks) {}

  getStats(): Readonly<LoopStats> {
    return this.stats
  }

  /** Forget accumulated time — call after a pause so the sim doesn't sprint to catch up. */
  resetClock(): void {
    this.lastTimeMs = null
    this.accumulator = 0
  }

  /** Advance to `nowMs`, running whole ticks and then one render. */
  advance(nowMs: number): void {
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
        this.stats.droppedTicks += dropped
        this.accumulator = 0
        break
      }
      this.accumulator -= TICK_MS
      this.hooks.tick()
      this.stats.ticks++
      ticksThisFrame++
    }

    this.stats.frames++
    this.hooks.render(this.accumulator / TICK_MS)
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
