/**
 * Game feel: screen shake, hit sparks, and the floating labels near the ship.
 *
 * Three ideas hold this file together.
 *
 * **The simulation owns the impulse, this file owns the presentation.**
 * `cosmetic.shake` is a 0..1 energy the sim decays; the pixel offset is computed
 * here from `(tick, energy)` alone. Nothing is sampled from `Math.random()` and
 * nothing is integrated across frames, so a screenshot of tick N always shakes by
 * the same amount and a replay looks identical to the run that recorded it.
 *
 * **Everything here is aged per *tick*, never per frame.** `feelTick()` is called
 * once per simulation tick, which is the only way it can work: `SimEvent`s are
 * cleared every tick, and `?ff=32` runs 32 ticks inside one rendered frame. A
 * per-frame drain would throw away 31 ticks of events, and per-frame ageing would
 * make labels live 32× longer under fast-forward.
 *
 * **Legibility beats completeness.** The player fires 20 shots/second. Twenty
 * damage numbers a second is not information, it is a texture, and it sits on top
 * of the exact pixels UI.md rule 1 protects. So damage is *aggregated per target*
 * — repeated hits on one enemy update a single running total that follows it —
 * the live count is hard-capped, and low-value events are dropped rather than
 * queued. See `MAX_LABELS` and `mergeInto()`.
 *
 * Rule 10 governs the timing of every effect in here: nothing switches on and off
 * faster than about 1Hz, no effect covers the screen, and the muzzle glow is a
 * smoothed level rather than a flash per shot (a 20Hz flash is the exact hazard
 * the rule exists to prevent).
 */

import { PLAYFIELD_H, PLAYFIELD_W } from '../core/space'
import type { SimEvent } from '../sim/entities'
import { blitGlow, drawHitSpark, hash01 } from './effects'
import { flashScale } from './intensity'
import { Palette } from './palette'
import { drawText, measureText } from './text'

// --- shake ------------------------------------------------------------------

/**
 * Hard cap on shake displacement, in virtual units, for *any* input.
 *
 * The cap is the whole point of the feature. Uncapped shake is the standard way
 * this effect ruins a shooter: it peaks at the instant a wave dies, which is also
 * the instant the screen is fullest of bullets, so the effect blinds the player
 * exactly when they most need to read the playfield. 6 units is ~1.3% of the
 * 448-unit playfield width and about a quarter of the player hull's width —
 * clearly felt, never enough to move a bullet out from under the eye tracking it.
 *
 * `shakeOffset()` guarantees `|x| <= cap`, `|y| <= cap`, and `hypot(x, y) <= cap`
 * for every finite input, including out-of-range energy and multiplier values.
 */
export const MAX_SHAKE_UNITS = 6

/**
 * Rattle frequencies in radians per tick: ~11Hz and ~8Hz at 60Hz.
 *
 * Deliberately incommensurate, so the offset traces a Lissajous scribble instead
 * of sliding along one diagonal. Deliberately *not* faster: a per-tick random
 * offset is a 60Hz oscillation, which is unpleasant, vestibularly hostile, and
 * far outside the spirit of rule 10 even though rule 10 is written about
 * luminance.
 */
const SHAKE_X_FREQ = 1.15
const SHAKE_Y_FREQ = 0.83

export interface ShakeOffset {
  readonly x: number
  readonly y: number
}

function clamp01(value: number): number {
  // NaN in, zero out. A NaN offset propagates into a translate() and silently
  // blanks the entire playfield, which is far worse than no shake.
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * Convert shake energy into a pixel offset.
 *
 * `multiplier` is the reduced-motion control and is clamped to 0..1, so no caller
 * can lift the amplitude above the cap — including a settings screen that lands
 * later and passes something silly. 0 returns exactly `{0, 0}`.
 *
 * Depends only on `(tick, energy)`, so two renders of the same tick agree. That
 * also means the shake steps at the tick rate rather than the frame rate, which
 * is correct: interpolating it would smooth the rattle back into a drift.
 */
export function shakeOffset(tick: number, energy: number, multiplier = 1): ShakeOffset {
  const m = clamp01(multiplier)
  const e = clamp01(energy)
  if (m === 0 || e === 0) return { x: 0, y: 0 }

  const t = Number.isFinite(tick) ? tick : 0
  const amp = MAX_SHAKE_UNITS * e * m

  // Two thirds smooth oscillation, one third hashed jitter: the sine carries the
  // kick, the jitter keeps it from reading as a pendulum. Both terms are bounded
  // by their weights, so |w| <= 1 before normalisation.
  let wx = 0.66 * Math.sin(t * SHAKE_X_FREQ + 0.7) + 0.34 * (hash01(t, 17.3) * 2 - 1)
  let wy = 0.66 * Math.sin(t * SHAKE_Y_FREQ + 2.3) + 0.34 * (hash01(t, 91.7) * 2 - 1)

  // Normalise the *vector*, not each axis, so the documented cap is a real
  // distance rather than a per-axis bound that a diagonal can exceed by 41%.
  const len2 = wx * wx + wy * wy
  if (len2 > 1) {
    const inv = 1 / Math.sqrt(len2)
    wx *= inv
    wy *= inv
  }

  return { x: amp * wx, y: amp * wy }
}

// --- floating labels --------------------------------------------------------

/**
 * `damage` and `scrap` aggregate; `hull` and `alert` are about the player and are
 * never dropped in favour of a damage number.
 */
export type LabelKind = 'damage' | 'scrap' | 'hull' | 'alert'

/**
 * Hard cap on live labels.
 *
 * 14 is roughly the most a person can read at a glance over a 448×720 field, and
 * the failure mode at the cap is "the least important number is missing", which
 * is strictly better than "the screen is full of numbers".
 */
export const MAX_LABELS = 14

/** Ticks a label lives after its last update. ~0.7s at 60Hz. */
const LABEL_LIFETIME = 42
/** Ticks a hull/alert label lives. Longer, because it is about the player. */
const PLAYER_LABEL_LIFETIME = 54

/**
 * How close a new event must be to an existing label of the same kind to merge
 * into it, in virtual units. Wider than an enemy, so a target that drifts a few
 * units between hits still updates one number instead of spawning a second.
 */
const MERGE_RADIUS = 24

/**
 * Which label survives when the pool is full. Higher wins.
 *
 * Damage numbers are the most numerous and the least urgent — the player can see
 * the enemy dying. Damage to the *hull* is the one thing that must never be
 * crowded out.
 */
const LABEL_PRIORITY: Record<LabelKind, number> = {
  damage: 1,
  scrap: 2,
  alert: 3,
  hull: 4,
}

export interface FloatingLabel {
  kind: LabelKind
  text: string
  /** Running total, for the kinds that aggregate. */
  value: number
  x: number
  y: number
  age: number
  lifetime: number
  /** Deterministic sideways drift, so two labels never rise in lockstep. */
  driftX: number
  /** Tick this label was last written. Used to de-duplicate within one tick. */
  lastTick: number
}

/**
 * A hit spark: a non-lethal impact.
 *
 * Pooled rather than allocated. Sparks are the most frequent effect in the game
 * (up to 20/second), and a fixed pool means a long run does zero allocation here
 * and cannot grow past the cap however dense the fight gets. `age >= LIFETIME`
 * marks a slot free.
 */
export interface HitSpark {
  x: number
  y: number
  age: number
  /** 0..1, from the damage that caused it. Scales size, not brightness. */
  power: number
  /** Deterministic scatter seed. */
  seed: number
}

/** Cap on simultaneous sparks. A wave being shredded degrades by dropping sparks. */
export const MAX_SPARKS = 28
/** Ticks a spark lives. ~120ms: an impact, not an event. */
export const SPARK_LIFETIME = 7

/**
 * One ejected case.
 *
 * Purely cosmetic, and deliberately built so it *cannot* be anything else: it is
 * spawned from the `player-shot` event, lives in render state, and the simulation
 * neither knows nor can be affected by it. That is the whole reason it was deferred
 * from M2 — an eject effect that reached into the sim would be a decoration with the
 * power to desynchronise a replay.
 *
 * Pooled like sparks, and for the same reason: at 20 shots/second an allocating
 * effect is 1,200 objects a minute.
 */
export interface Shell {
  x: number
  y: number
  /** Per-TICK velocity, never per second. The sim's timestep is the only clock here. */
  vx: number
  vy: number
  age: number
  /** Radians, advanced per tick. Rotation is what makes a 2-unit chip read as brass. */
  spin: number
  spinRate: number
}

export const MAX_SHELLS = 18
/** Ticks a case is visible. ~0.4s: long enough to see leave, short enough not to litter. */
export const SHELL_LIFETIME = 26
/** Per-tick downward acceleration. */
const SHELL_GRAVITY = 0.055
/** Sideways speed out of the muzzle, in units per tick. */
const SHELL_EJECT_VX = 0.5
/** Initial upward drift, so a case arcs rather than dropping. */
const SHELL_EJECT_VY = -0.22

export interface FeelState {
  labels: FloatingLabel[]
  /** Fixed-size pool; a slot with `age >= SPARK_LIFETIME` is free. */
  readonly sparks: HitSpark[]
  /** Fixed-size pool; a slot with `age >= SHELL_LIFETIME` is free. */
  readonly shells: Shell[]
  /** Which side the next case ejects from. Alternates, matching the alternating muzzles. */
  shellSide: number
  /** Rotating cursor into the shell pool. */
  shellCursor: number
  /**
   * Smoothed 0..1 firing level for the muzzle glow.
   *
   * A *level*, not a per-shot flash. At 20 shots/second a per-shot flash is a
   * 20Hz strobe on a bright local element — rule 10's exact hazard — and it also
   * reads as noise rather than as gunfire. This reaches full brightness over ~20
   * ticks and fades over ~60, so the muzzle brightens while the trigger is held
   * and dims when it is released: one transition per trigger pull, and no step
   * bigger than 0.11 (asserted in tests/feel.test.ts).
   */
  muzzleHeat: number
  /**
   * Ticks left in which the weapon still counts as firing.
   *
   * Longer than the 3-tick fire interval, so sustained fire holds the target at 1
   * continuously instead of rippling at the cadence of the gun.
   */
  shotHold: number
  /** Rotating cursor into the spark pool, so overwrites spread out. */
  sparkCursor: number
}

export function createFeelState(): FeelState {
  const sparks: HitSpark[] = []
  for (let i = 0; i < MAX_SPARKS; i++) {
    sparks.push({ x: 0, y: 0, age: SPARK_LIFETIME, power: 0, seed: i })
  }
  const shells: Shell[] = []
  for (let i = 0; i < MAX_SHELLS; i++) {
    shells.push({ x: 0, y: 0, vx: 0, vy: 0, age: SHELL_LIFETIME, spin: 0, spinRate: 0 })
  }
  return {
    labels: [],
    sparks,
    shells,
    shellSide: 1,
    shellCursor: 0,
    muzzleHeat: 0,
    shotHold: 0,
    sparkCursor: 0,
  }
}

/** Drop everything. Called when a new sortie starts, so the last death's numbers don't survive it. */
export function resetFeelState(state: FeelState): void {
  state.labels.length = 0
  for (const spark of state.sparks) spark.age = SPARK_LIFETIME
  for (const shell of state.shells) shell.age = SHELL_LIFETIME
  state.shellSide = 1
  state.muzzleHeat = 0
  state.shotHold = 0
}

/** Ticks a player-shot event keeps the muzzle lit. */
const SHOT_HOLD_TICKS = 7
/** Per-tick approach rate of `muzzleHeat` toward its target. */
const HEAT_RISE = 0.11
const HEAT_FALL = 0.05

function labelLifetime(kind: LabelKind): number {
  return kind === 'hull' || kind === 'alert' ? PLAYER_LABEL_LIFETIME : LABEL_LIFETIME
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * Keep a label inside the playfield.
 *
 * Rule 1 is absolute about the panel column: a damage number that drifts over the
 * instrument panel is state drawn on the HUD, and the panel is drawn after the
 * scene so it would half-cover the number anyway.
 */
function clampX(x: number): number {
  return Math.max(30, Math.min(PLAYFIELD_W - 30, finite(x, PLAYFIELD_W / 2)))
}

function clampY(y: number): number {
  return Math.max(20, Math.min(PLAYFIELD_H - 12, finite(y, PLAYFIELD_H / 2)))
}

/**
 * Sanitise an aggregate value.
 *
 * Non-finite and negative inputs are clamped rather than trusted. A `NaN` damage
 * value would render as the literal text "-NaN", and the 9999 ceiling keeps a
 * pathological total from growing a label wider than the playfield.
 */
function safeValue(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(9999, Math.max(0, value))
}

function formatLabel(kind: LabelKind, value: number, text: string): string {
  if (kind === 'damage') return `-${Math.round(safeValue(value))}`
  if (kind === 'scrap') return `+${Math.round(safeValue(value))} scrap`
  return text
}

/** Find a mergeable label of the same kind near `(x, y)`, or undefined. */
function findMergeTarget(
  state: FeelState,
  kind: LabelKind,
  x: number,
  y: number,
): FloatingLabel | undefined {
  for (const label of state.labels) {
    if (label.kind !== kind) continue
    if (Math.abs(label.x - x) > MERGE_RADIUS) continue
    if (Math.abs(label.y - y) > MERGE_RADIUS) continue
    return label
  }
  return undefined
}

/**
 * Fold an event into an existing label.
 *
 * The total keeps rising and the label re-follows the target, so a player holding
 * the trigger on one enemy sees one number climbing rather than twenty numbers
 * fighting for the same 20 pixels. Ageing restarts, which means the label lives
 * as long as the player keeps hitting that target and disappears ~0.7s after they
 * stop — still transient, still attached to the action, still inside rule 1's
 * permitted exception.
 */
function mergeInto(label: FloatingLabel, value: number, x: number, y: number, tick: number): void {
  label.value = safeValue(label.value + safeValue(value))
  label.text = formatLabel(label.kind, label.value, label.text)
  // Follow the target, but only part of the way: snapping to each impact point
  // makes the number twitch, which is harder to read than a slight lag.
  label.x = clampX(label.x + (x - label.x) * 0.5)
  label.y = clampY(label.y + (y - label.y) * 0.5)
  label.age = 0
  label.lastTick = tick
}

function pushLabel(
  state: FeelState,
  kind: LabelKind,
  value: number,
  text: string,
  x: number,
  y: number,
  tick: number,
): void {
  if (state.labels.length >= MAX_LABELS) {
    // Evict the lowest-priority, then oldest, label — and only if the newcomer is
    // at least as important. At the cap the right failure is to keep showing what
    // matters, not to replace a hull-damage number with a damage tick.
    let victim = -1
    let victimPriority = Number.POSITIVE_INFINITY
    let victimAge = -1
    for (let i = 0; i < state.labels.length; i++) {
      const candidate = state.labels[i]
      if (!candidate) continue
      const priority = LABEL_PRIORITY[candidate.kind]
      if (priority < victimPriority || (priority === victimPriority && candidate.age > victimAge)) {
        victim = i
        victimPriority = priority
        victimAge = candidate.age
      }
    }
    if (victim < 0 || victimPriority > LABEL_PRIORITY[kind]) return
    const last = state.labels.pop()
    if (last && victim < state.labels.length) state.labels[victim] = last
  }

  const px = clampX(x)
  const py = clampY(y)
  const safe = safeValue(value)
  state.labels.push({
    kind,
    value: safe,
    text: formatLabel(kind, safe, text),
    x: px,
    y: py,
    age: 0,
    lifetime: labelLifetime(kind),
    // Hashed from the spawn position: stable, and neighbouring labels get
    // different drifts so a cluster fans out instead of stacking.
    driftX: hash01(px, py) * 2 - 1,
    lastTick: tick,
  })
}

/**
 * Eject one case from the muzzle.
 *
 * Everything about it is derived from `(x, y, side)` through `hash01`, so two renders
 * of the same tick throw the same brass and a screenshot of tick N is reproducible —
 * the same property every other effect in this file holds, and the reason none of them
 * calls `Math.random()`.
 */
function spawnShell(state: FeelState, x: number, y: number): void {
  const side = state.shellSide
  state.shellSide = -side

  let slot = -1
  for (let i = 0; i < MAX_SHELLS; i++) {
    const index = (state.shellCursor + i) % MAX_SHELLS
    const shell = state.shells[index]
    if (shell && shell.age >= SHELL_LIFETIME) {
      slot = index
      break
    }
  }
  if (slot < 0) slot = state.shellCursor
  state.shellCursor = (slot + 1) % MAX_SHELLS

  const shell = state.shells[slot]
  if (!shell) return
  const scatter = hash01(x + side * 3.1, y - side * 7.7)
  shell.x = finite(x) + side * 5
  shell.y = finite(y)
  shell.vx = side * SHELL_EJECT_VX * (0.7 + 0.6 * scatter)
  shell.vy = SHELL_EJECT_VY * (0.6 + 0.8 * scatter)
  shell.spin = scatter * Math.PI
  shell.spinRate = (side < 0 ? -1 : 1) * (0.12 + 0.1 * scatter)
  shell.age = 0
}

function spawnSpark(state: FeelState, x: number, y: number, power: number): void {
  // Merge nearby fresh sparks instead of stacking them. A stream of hits on one
  // target then reads as a continuous shimmer at the impact point rather than a
  // burst blinking on and off at the fire rate, which is both prettier and the
  // safer reading of rule 10.
  for (const spark of state.sparks) {
    if (spark.age >= SPARK_LIFETIME) continue
    if (spark.age > 2) continue
    if (Math.abs(spark.x - x) > 12 || Math.abs(spark.y - y) > 12) continue
    spark.power = Math.min(1, spark.power + power * 0.5)
    spark.age = 0
    return
  }

  let slot = -1
  for (let i = 0; i < MAX_SPARKS; i++) {
    const index = (state.sparkCursor + i) % MAX_SPARKS
    const spark = state.sparks[index]
    if (spark && spark.age >= SPARK_LIFETIME) {
      slot = index
      break
    }
  }
  // Pool full: overwrite at the cursor. The newest impact is the one worth seeing.
  if (slot < 0) slot = state.sparkCursor
  state.sparkCursor = (slot + 1) % MAX_SPARKS

  const spark = state.sparks[slot]
  if (!spark) return
  spark.x = finite(x)
  spark.y = finite(y)
  spark.age = 0
  spark.power = clamp01(power)
  spark.seed = slot + 1
}

/**
 * Ingest one tick's events and age everything by one tick.
 *
 * Call this exactly once per simulation tick, immediately after `world.tick()`,
 * *before* the events are cleared. Never once per rendered frame — see the file
 * header.
 */
export function feelTick(state: FeelState, events: readonly SimEvent[], tick: number): void {
  for (const event of events) {
    switch (event.kind) {
      case 'player-shot':
        state.shotHold = SHOT_HOLD_TICKS
        // Brass. Cosmetic only, and driven off the event rather than off the weapon
        // state so it cannot get out of step with what the sim actually fired.
        spawnShell(state, event.x, event.y)
        break

      case 'enemy-hit': {
        // A lethal hit gets no number. The kill already produces an explosion and
        // a scrap label at the same point, and stacking a damage number on top of
        // those is three announcements of one event.
        if (event.lethal) break
        spawnSpark(state, event.x, event.y, Math.min(1, event.damage / 12))
        const existing = findMergeTarget(state, 'damage', event.x, event.y)
        if (existing) mergeInto(existing, event.damage, event.x, event.y, tick)
        else pushLabel(state, 'damage', event.damage, '', event.x, event.y, tick)
        break
      }

      case 'enemy-killed': {
        if (event.scrap <= 0) break
        const existing = findMergeTarget(state, 'scrap', event.x, event.y)
        // Same-tick de-duplication: a kill and a `scrap-collected` for the same
        // scrap can both land in one tick. Summing them would print a number that
        // is simply wrong, which is worse than printing it once.
        if (existing && existing.lastTick === tick) break
        if (existing) mergeInto(existing, event.scrap, event.x, event.y, tick)
        else pushLabel(state, 'scrap', event.scrap, '', event.x, event.y, tick)
        break
      }

      case 'scrap-collected': {
        if (event.amount <= 0) break
        const existing = findMergeTarget(state, 'scrap', event.x, event.y)
        if (existing && existing.lastTick === tick) break
        if (existing) mergeInto(existing, event.amount, event.x, event.y, tick)
        else pushLabel(state, 'scrap', event.amount, '', event.x, event.y, tick)
        break
      }

      case 'hull-hit': {
        // Rule 9: the panel's integrity meter dropping is a change nobody sees
        // mid-firefight. The number appears on the ship, with a unit, and says
        // which pool absorbed it — losing shield and losing integrity are
        // different outcomes and must not look the same.
        const unit = event.absorbedByShield ? 'shield' : 'hp'
        const damage = Math.max(1, Math.round(safeValue(event.damage)))
        pushLabel(state, 'hull', damage, `-${damage} ${unit}`, event.x, event.y - 22, tick)
        break
      }

      case 'shield-broken':
        pushLabel(state, 'alert', 0, 'SHIELD DOWN', event.x, event.y - 34, tick)
        break

      // enemy-shot is the telegraph's business and is drawn on the enemy;
      // hull-lost and wave-released are announced by a whole screen changing.
      default:
        break
    }
  }

  // Ageing. Per tick, unconditionally — this is what makes the effect lifetimes
  // identical at 60fps, 144fps, and under ?ff=32.
  const labels = state.labels
  for (let i = labels.length - 1; i >= 0; i--) {
    const label = labels[i]
    if (!label) continue
    label.age++
    if (label.age < label.lifetime) continue
    const last = labels.pop()
    if (last && i < labels.length) labels[i] = last
  }

  for (const spark of state.sparks) {
    if (spark.age < SPARK_LIFETIME) spark.age++
  }

  // Cases integrate per tick, like everything else here, so they fall at the same
  // speed at 60fps, at 144fps, and under ?ff=32.
  for (const shell of state.shells) {
    if (shell.age >= SHELL_LIFETIME) continue
    shell.age++
    shell.x += shell.vx
    shell.y += shell.vy
    shell.vy += SHELL_GRAVITY
    shell.spin += shell.spinRate
  }

  if (state.shotHold > 0) state.shotHold--
  const target = state.shotHold > 0 ? 1 : 0
  const rate = target > state.muzzleHeat ? HEAT_RISE : HEAT_FALL
  state.muzzleHeat += (target - state.muzzleHeat) * rate
  if (state.muzzleHeat < 0.003) state.muzzleHeat = 0
}

// --- drawing ----------------------------------------------------------------

/**
 * Where a label draws, given the render interpolation.
 *
 * Exported so a test can assert no finite input produces a NaN coordinate. A NaN
 * passed to `fillText` draws nothing, silently, which is the kind of bug that
 * survives a screenshot review.
 */
export function labelPosition(label: FloatingLabel, alpha: number): { x: number; y: number } {
  const a = Number.isFinite(alpha) ? alpha : 0
  const t = clamp01((finite(label.age) + a) / Math.max(1, finite(label.lifetime, 1)))
  const rise = 1 - (1 - t) * (1 - t)
  return {
    x: clampX(finite(label.x) + finite(label.driftX) * 7 * rise),
    y: clampY(finite(label.y) - 16 * rise),
  }
}

/**
 * Label opacity over its life: rise, hold, fall.
 *
 * Monotone in each phase and slower than 1Hz end to end, so there is no blink
 * anywhere in it (rule 10). It does reach zero — that is a fade to removal, not a
 * pulse, and the distinction rule 10 draws is about *repetition*.
 */
export function labelOpacity(t: number): number {
  const clamped = clamp01(t)
  // ~2 ticks of fade-in from 0.35, so a number never appears at full brightness
  // out of nowhere; then a flat hold; then a long fade to removal.
  if (clamped < 0.1) return 0.35 + 0.65 * (clamped / 0.1)
  if (clamped < 0.62) return 1
  return Math.max(0, 1 - (clamped - 0.62) / 0.38)
}

const LABEL_COLOR: Record<LabelKind, string> = {
  // Neutral, not `hostile`: this is a readout about a target, and it must stay
  // quieter than the enemy fire it is drawn among.
  damage: Palette.text,
  scrap: Palette.good,
  // Incoming damage is one of the sanctioned uses of `danger` (rule 3).
  hull: Palette.danger,
  // A shield break is a resource state change, not something that can hurt you
  // this instant, so it is `caution` and never `danger`.
  alert: Palette.caution,
}

const LABEL_SIZE: Record<LabelKind, number> = {
  damage: 12,
  scrap: 12,
  hull: 14,
  alert: 12,
}

/** Near-black backing, so a number stays legible over an explosion. */
const LABEL_SHADOW = 'rgba(3, 5, 9, 0.9)'

/**
 * Draw the floating labels.
 *
 * Deliberately *not* inside the screen-shake transform. Shaking text is the
 * fastest way to make it unreadable, the offset is at most 6 units, and shake
 * lasts a fraction of a label's life — so the labels hold still and the world
 * rattles behind them.
 */
export function drawFeelLabels(
  ctx: CanvasRenderingContext2D,
  state: FeelState,
  alpha: number,
): void {
  for (const label of state.labels) {
    const t = clamp01((label.age + (Number.isFinite(alpha) ? alpha : 0)) / label.lifetime)
    const opacity = labelOpacity(t)
    if (opacity <= 0.02) continue
    const { x: rawX, y } = labelPosition(label, alpha)
    const size = LABEL_SIZE[label.kind]
    const weight = label.kind === 'damage' ? 400 : 600
    const tracking = label.kind === 'alert' ? 1.2 : 0

    // Keep the *whole* label inside the playfield, not just its anchor. Centred
    // text is half its width wider than its position, and `SHIELD DOWN` is ~90
    // units wide — enough to reach into the instrument panel from a legal anchor,
    // which rule 1 does not allow for any reason.
    const half = measureText(ctx, label.text, { size, weight, tracking }) / 2 + 4
    const x = Math.max(half, Math.min(PLAYFIELD_W - half, rawX))

    ctx.globalAlpha = opacity
    drawText(ctx, label.text, x + 1, y + 1, {
      size,
      weight,
      tracking,
      color: LABEL_SHADOW,
      align: 'center',
    })
    drawText(ctx, label.text, x, y, {
      size,
      weight,
      tracking,
      color: LABEL_COLOR[label.kind],
      align: 'center',
    })
    ctx.globalAlpha = 1
  }
}

/** Draw the live hit sparks in one additive pass. */
export function drawFeelSparks(
  ctx: CanvasRenderingContext2D,
  state: FeelState,
  alpha: number,
  reduceFlashes = false,
): void {
  const a = Number.isFinite(alpha) ? alpha : 0
  ctx.globalCompositeOperation = 'lighter'
  for (const spark of state.sparks) {
    if (spark.age >= SPARK_LIFETIME) continue
    const t = clamp01((spark.age + a) / SPARK_LIFETIME)
    drawHitSpark(ctx, spark.x, spark.y, t, spark.power, spark.seed, reduceFlashes)
  }
  ctx.globalCompositeOperation = 'source-over'
}

/**
 * Ejected cases.
 *
 * Deliberately quiet. A dull warm grey rather than a saturated brass, never above half
 * alpha, two units across, and drawn *under* the hull so the ship is never obscured by
 * its own litter. UI.md rule 3 says colour is information: a bright amber chip would
 * read as `caution`, and twenty of them a second would be the loudest thing on a screen
 * whose loudest thing must always be the bullets.
 *
 * Not additive. Brass is not light.
 */
const SHELL_COLOR = '154, 138, 110'

export function drawFeelShells(
  ctx: CanvasRenderingContext2D,
  state: FeelState,
  alpha: number,
): void {
  const a = Number.isFinite(alpha) ? alpha : 0
  for (const shell of state.shells) {
    if (shell.age >= SHELL_LIFETIME) continue
    const t = clamp01((shell.age + a) / SHELL_LIFETIME)
    const fade = (1 - t) * (1 - t)
    if (fade <= 0.02) continue

    // Extrapolated by the render alpha rather than snapped to the tick, so a case
    // arcs smoothly on a 144Hz display like every other moving thing.
    const x = clampX(finite(shell.x) + finite(shell.vx) * a)
    const y = clampY(finite(shell.y) + finite(shell.vy) * a)

    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(finite(shell.spin) + finite(shell.spinRate) * a)
    ctx.fillStyle = `rgba(${SHELL_COLOR}, ${(0.5 * fade).toFixed(3)})`
    ctx.fillRect(-1, -1.9, 2, 3.8)
    ctx.restore()
  }
}

/**
 * The muzzle glow, from the smoothed firing level.
 *
 * Both muzzles get the same brightness even though the sim alternates them: a
 * left/right alternation at 10Hz each is a strobe with extra steps.
 */
export function drawMuzzleGlow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  heat: number,
  reduceFlashes = false,
): void {
  const h = clamp01(heat)
  if (h <= 0.01) return
  const glare = flashScale(reduceFlashes)
  ctx.globalCompositeOperation = 'lighter'
  for (const side of [-4.5, 4.5]) {
    blitGlow(ctx, 'self', x + side, y, 4 + 5 * h, (0.1 + 0.3 * h) * glare)
  }
  // A single small hot bar across both muzzles reads as a barrel glowing under
  // sustained fire, which is the thing 20 shots/second should look like.
  blitGlow(ctx, 'hot', x, y + 1, 3 + 3 * h, (0.06 + 0.18 * h) * glare)
  ctx.globalCompositeOperation = 'source-over'
}
