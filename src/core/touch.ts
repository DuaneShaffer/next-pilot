/**
 * Touch input.
 *
 * THE CONTRACT IS UNCHANGED: the simulation still only sees an `InputSnapshot`
 * (see `src/core/input.ts`), so touch costs the sim nothing, risks determinism
 * nothing, and a replay recorded on a phone plays back on a desktop. Everything
 * hard about touch is therefore contained in this file.
 *
 * The scheme is **relative drag** (docs/DESIGN.md, decided early): the ship moves
 * by the finger's *movement*, never to the finger's *position*, so the thumb is
 * never on top of the ship it is trying to see, and lifting and re-planting the
 * thumb is free. Rationale and the alternatives it was chosen over are in
 * docs/MOBILE.md.
 *
 * TWO THINGS IN HERE ARE LOAD-BEARING AND EASY TO BREAK.
 *
 * 1. **The displacement debt.** `InputSnapshot` movement is digital (-1/0/1), so a
 *    "gain factor" cannot scale a velocity — there is no velocity to scale. Instead
 *    the finger's delta is banked, in virtual units, as displacement the ship still
 *    owes; each tick the controller emits an axis only if the debt is worth at
 *    least half a tick of travel, and subtracts what the ship will move. The result
 *    is *position* control, not velocity control, which is the whole reason this
 *    beats a virtual stick against a 5.5-unit hitbox: a position error does not
 *    integrate. Stop moving the thumb and the ship stops within half a tick's
 *    travel of where the mapping said, every time.
 *
 * 2. **Auto-fire is contextual, and it must stay that way.** A shmup trigger is
 *    held permanently, so touch fires by itself — but `updateCursor` in
 *    `src/sim/progression.ts` confirms a reward card from a *held* trigger after
 *    `HELD_CONFIRM_DWELL_TICKS`. Assert fire unconditionally and every card on
 *    mobile auto-takes option 0 after 0.8 seconds, forever. That is why `context`
 *    exists and why `'sortie'` is the only value that fires. See docs/MOBILE.md;
 *    this is the single most important thing in this module.
 */

import { NEUTRAL_INPUT, type Axis, type InputSnapshot } from './input'
import { TICK_SECONDS } from './loop'
import { PLAYFIELD_H, PLAYFIELD_W, clamp } from './space'
import type { Rect } from './viewport'

/**
 * What the player is looking at. Decides whether the trigger is asserted.
 *
 * `'choice'` and `'menu'` behave identically for input; they are separate so the
 * app layer's intent is readable at the call site and so a future divergence
 * (a choice card wanting a different gesture set) does not need a new enum.
 */
export type TouchContext = 'sortie' | 'choice' | 'menu'

/**
 * Base hull travel per tick, in virtual units: 210 units/s at 60Hz = 3.5.
 *
 * Duplicated rather than imported because `core` must not import `sim`
 * (CLAUDE.md's dependency arrow). `tests/touch.test.ts` imports both and asserts
 * they agree, so the duplicate cannot drift silently.
 */
export const BASE_UNITS_PER_TICK = 210 * TICK_SECONDS

/** Mirrors `STATS.focusFactor.base`. Same duplication, same test. */
export const FOCUS_FACTOR = 0.45

/**
 * Ship travel per unit of finger travel, on screen.
 *
 * 2.0 is a precision-versus-reach trade and both sides of it are measurable.
 *
 * REACH: crossing the 448-unit playfield takes 224 units of finger travel. On a
 * 390x844 phone the scale is 0.87, so that is 195 CSS pixels — about 32mm, at the
 * top of one comfortable thumb sweep and re-plantable for free.
 *
 * PRECISION: the hitbox is a 5.5-unit radius, so at this gain the ship crosses its
 * own hitbox radius in 2.75 units of finger travel — about 2.4 CSS pixels, which is
 * inside the jitter of a dragging thumb. Full-speed dragging is therefore NOT
 * precise enough to thread a dense pattern, and that is not a flaw to tune away: it
 * is exactly what focus is for. At focus the effective gain is 2.0 x 0.45 = 0.9, so
 * a hitbox radius costs 6.1 units of finger travel — 2.2x the room, and past the
 * jitter floor.
 *
 * Raising this buys reach and directly costs dodging. Do not raise it without
 * redoing the arithmetic above.
 */
export const DEFAULT_GAIN = 2.0

/**
 * Finger travel, in virtual units, before a touch counts as a drag rather than a
 * tap. Movement inside the slop is DISCARDED, not banked.
 *
 * Banking it and releasing on crossing would preserve a perfect 1:1 mapping, but it
 * would deliver the whole slop at once as a jump of `slop x gain` units — at these
 * numbers, 6 units, more than a hitbox diameter. A 3-unit dead start is invisible;
 * a 6-unit teleport is a death.
 */
export const DEFAULT_TAP_SLOP = 3

/**
 * Ceiling on banked debt, in ticks of travel.
 *
 * Without it a fast flick is a catastrophe: 200 CSS pixels in 100ms at gain 2 banks
 * ~460 units of debt, which drains at 3.5 units/tick and flies the ship for another
 * 2.2 seconds after the thumb has stopped. Capping at 4 ticks means the ship is
 * never more than 67ms behind the finger.
 *
 * The honest consequence: a flick faster than the hull can fly under-delivers. The
 * hull has a speed limit and no input scheme can spend past it — the same is true
 * on a keyboard, where holding right for 100ms also moves you 350 units short of
 * wherever you wanted to be.
 */
export const DEFAULT_MAX_DEBT_TICKS = 4

export interface TouchOptions {
  gain: number
  focusFactor: number
  tapSlopUnits: number
  maxDebtTicks: number
  /**
   * Hull travel per tick, virtual units. The app should keep this in step with the
   * run's resolved `hullSpeed` — a mobility item makes the ship faster, and a debt
   * that drains at the old rate over-delivers by exactly that ratio.
   */
  unitsPerTick: number
  /** Touches starting outside this steer nothing. Defaults to the playfield. */
  bounds: Rect
  /**
   * Where a second finger must land to mean focus. Undefined means anywhere.
   * See docs/MOBILE.md for why the default is "anywhere".
   */
  focusZone: Rect | null
  /** Whether `'sortie'` asserts the trigger with no finger down. */
  autoFire: boolean
}

const DEFAULT_BOUNDS: Rect = { x: 0, y: 0, w: PLAYFIELD_W, h: PLAYFIELD_H }

export const DEFAULT_TOUCH_OPTIONS: TouchOptions = {
  gain: DEFAULT_GAIN,
  focusFactor: FOCUS_FACTOR,
  tapSlopUnits: DEFAULT_TAP_SLOP,
  maxDebtTicks: DEFAULT_MAX_DEBT_TICKS,
  unitsPerTick: BASE_UNITS_PER_TICK,
  bounds: DEFAULT_BOUNDS,
  focusZone: null,
  autoFire: true,
}

/** A live finger. `x`/`y` are virtual units and are the position last reported. */
interface LiveTouch {
  x: number
  y: number
  /** True once this touch has travelled past the tap slop. */
  dragging: boolean
  /** Distance travelled so far, for the slop test. */
  travelled: number
  /** Eligible to steer: it started inside `bounds`. */
  steerable: boolean
  /** Eligible to mean focus: it started inside `focusZone` (or anywhere). */
  focusable: boolean
}

function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
}

function sign(value: number): Axis {
  return value > 0 ? 1 : value < 0 ? -1 : 0
}

/**
 * Relative-drag touch controls producing an `InputSnapshot` per tick.
 *
 * Coordinates in and out are VIRTUAL UNITS. Converting from client pixels is
 * `toVirtual()` in `src/core/viewport.ts`; keeping that out of here is what lets
 * every rule below be tested without a DOM.
 */
export class TouchControls {
  private readonly options: TouchOptions
  /** Insertion-ordered: the oldest steerable entry is the one that steers. */
  private readonly touches = new Map<number, LiveTouch>()
  private steerId: number | null = null
  private debtX = 0
  private debtY = 0
  private ctx: TouchContext = 'menu'
  /** Queued snapshots that pre-empt live input. See `scriptSelect`. */
  private script: InputSnapshot[] = []

  constructor(options: Partial<TouchOptions> = {}) {
    this.options = { ...DEFAULT_TOUCH_OPTIONS, ...options }
  }

  get context(): TouchContext {
    return this.ctx
  }

  /** Debt still owed to the ship, in virtual units. Diagnostics and tests only. */
  get pendingX(): number {
    return this.debtX
  }

  get pendingY(): number {
    return this.debtY
  }

  get scriptLength(): number {
    return this.script.length
  }

  /** True while a finger is steering. */
  get steering(): boolean {
    return this.steerId !== null
  }

  /**
   * Set what the player is looking at.
   *
   * Leaving a choice drops any queued script: the card it was driving is gone, and
   * replaying its remaining pulses would move a cursor that no longer exists or,
   * worse, confirm a card that has just opened behind it.
   */
  setContext(context: TouchContext): void {
    if (context === this.ctx) return
    this.ctx = context
    if (context === 'sortie') this.script = []
    // Debt earned while flying must not be delivered after a card closes.
    this.debtX = 0
    this.debtY = 0
  }

  /** Keep the debt draining at the rate the ship actually moves. */
  setUnitsPerTick(unitsPerTick: number): void {
    if (Number.isFinite(unitsPerTick) && unitsPerTick > 0) {
      this.options.unitsPerTick = unitsPerTick
    }
  }

  down(id: number, x: number, y: number): void {
    if (this.touches.has(id)) this.touches.delete(id)
    const zone = this.options.focusZone
    const touch: LiveTouch = {
      x,
      y,
      dragging: false,
      travelled: 0,
      steerable: contains(this.options.bounds, x, y),
      focusable: zone === null ? contains(this.options.bounds, x, y) : contains(zone, x, y),
    }
    this.touches.set(id, touch)
    if (this.steerId === null && touch.steerable) this.steerId = id
  }

  /**
   * Report a moved finger.
   *
   * Only the steering touch contributes movement. A second finger is a modifier,
   * so landing one — anywhere, however far from the first — adds nothing to the
   * debt and the ship does not jump.
   */
  move(id: number, x: number, y: number): void {
    const touch = this.touches.get(id)
    if (!touch) return

    const dx = x - touch.x
    const dy = y - touch.y
    touch.x = x
    touch.y = y

    // The fraction of this delta that counts. Everything before the slop is spent,
    // not banked (see DEFAULT_TAP_SLOP) — but only the slop itself, never the whole
    // event that happened to cross it, so the dead start is the same 3 units
    // whether the browser delivers one coarse move or twenty fine ones.
    let fraction = 1
    if (!touch.dragging) {
      const length = Math.hypot(dx, dy)
      touch.travelled += length
      if (touch.travelled < this.options.tapSlopUnits) return
      touch.dragging = true
      fraction = length > 0 ? Math.min(1, (touch.travelled - this.options.tapSlopUnits) / length) : 0
    }

    if (id !== this.steerId || fraction === 0) return

    const gain = this.options.gain * (this.focusHeld() ? this.options.focusFactor : 1) * fraction
    this.debtX += dx * gain
    this.debtY += dy * gain
  }

  /**
   * Report a lifted or cancelled finger.
   *
   * Lifting the steering finger zeroes the debt, so the ship STOPS rather than
   * coasting out the last vector — a frozen vector in a bullet-hell flies the ship
   * into whatever the player just lifted their thumb to avoid.
   *
   * If another finger is still down it is promoted, with its *current* position as
   * the new origin. Relative drag makes that free: the promoted finger's next delta
   * is measured from where it already is, so promotion can never teleport the ship.
   */
  up(id: number): void {
    if (!this.touches.delete(id)) return
    if (id !== this.steerId) return

    this.steerId = null
    this.debtX = 0
    this.debtY = 0

    for (const [candidateId, touch] of this.touches) {
      if (touch.steerable) {
        this.steerId = candidateId
        // Promotion starts a fresh drag: the slop is re-armed so a finger that was
        // resting as a focus modifier does not immediately steer on sensor noise.
        touch.dragging = false
        touch.travelled = 0
        break
      }
    }
  }

  /** Drop everything. Call on blur, visibility loss, and pointercancel storms. */
  reset(): void {
    this.touches.clear()
    this.steerId = null
    this.debtX = 0
    this.debtY = 0
    this.script = []
  }

  /** Focus is held while a second eligible finger is down. */
  focusHeld(): boolean {
    if (this.steerId === null) return false
    for (const [id, touch] of this.touches) {
      if (id !== this.steerId && touch.focusable) return true
    }
    return false
  }

  /**
   * Queue the inputs that walk the sim's choice cursor to `to` and confirm it.
   *
   * The cursor lives in the simulation (`updateCursor`), which is right — a
   * recorded run must reproduce its picks — but it means an absolute tap on the
   * third card cannot select the third card directly. So a tap is translated into
   * the discrete pulses a keyboard would have produced, taking the shorter way
   * round the wrap.
   *
   * The pulse shape is dictated by `updateCursor`, which acts on RISING edges and
   * starts every card with every button considered already-held. Hence the leading
   * neutral tick, and the neutral tick between every pulse. At 60Hz the longest
   * walk on a three-option card is 5 ticks — 83ms, under a single rendered frame's
   * worth of perceptible delay.
   */
  scriptSelect(from: number, to: number, optionCount: number): void {
    this.script = []
    if (optionCount <= 0) return

    const target = ((to % optionCount) + optionCount) % optionCount
    const start = ((from % optionCount) + optionCount) % optionCount
    let steps = target - start
    // Take the short way round: on a 3-card screen, 0 -> 2 is one press left.
    if (steps > optionCount / 2) steps -= optionCount
    if (steps < -optionCount / 2) steps += optionCount

    const direction: Axis = steps > 0 ? 1 : -1
    for (let i = 0; i < Math.abs(steps); i++) {
      this.script.push(NEUTRAL_INPUT)
      this.script.push({ ...NEUTRAL_INPUT, moveX: direction })
    }
    this.script.push(NEUTRAL_INPUT)
    this.script.push({ ...NEUTRAL_INPUT, fire: true })
    this.script.push(NEUTRAL_INPUT)
  }

  /** Queue a decline. `updateCursor` skips on a rising `special` edge. */
  scriptSkip(): void {
    this.script = [NEUTRAL_INPUT, { ...NEUTRAL_INPUT, special: true }, NEUTRAL_INPUT]
  }

  /**
   * The snapshot for this tick. **Consumes state — call exactly once per tick.**
   *
   * Calling it twice in a tick drains the debt twice and the ship moves at half the
   * commanded distance; not calling it at all lets the debt sit. The app layer's
   * `stepSim()` is the one caller.
   */
  snapshot(): InputSnapshot {
    const scripted = this.script.shift()
    if (scripted) return scripted

    // Nothing but a sortie fires. This one line is what stops every reward card on
    // mobile from auto-confirming option 0 after HELD_CONFIRM_DWELL_TICKS.
    if (this.ctx !== 'sortie') return NEUTRAL_INPUT

    const focus = this.focusHeld()
    const step = this.options.unitsPerTick * (focus ? this.options.focusFactor : 1)
    const maxDebt = step * this.options.maxDebtTicks
    this.debtX = clamp(this.debtX, -maxDebt, maxDebt)
    this.debtY = clamp(this.debtY, -maxDebt, maxDebt)

    // Half a step: below that, emitting the axis would overshoot by more than
    // holding still undershoots, and the ship would dither on the spot.
    const threshold = step / 2
    const moveX: Axis = Math.abs(this.debtX) >= threshold ? sign(this.debtX) : 0
    const moveY: Axis = Math.abs(this.debtY) >= threshold ? sign(this.debtY) : 0

    // The sim normalises diagonals (world.ts moveHull), so a diagonal tick moves
    // each axis by step/sqrt(2). Draining the full step here would over-deliver a
    // diagonal drag by 41%.
    const perAxis = moveX !== 0 && moveY !== 0 ? step * Math.SQRT1_2 : step
    if (moveX !== 0) this.debtX -= moveX * perAxis
    if (moveY !== 0) this.debtY -= moveY * perAxis

    return {
      moveX,
      moveY,
      fire: this.options.autoFire,
      special: false,
      focus,
    }
  }
}

/**
 * Converts client-space pointer coordinates into virtual units.
 *
 * Supplied by the caller rather than computed here so this module stays free of
 * both the DOM and the viewport's layout state. Return null for a point outside
 * the canvas and the event is ignored.
 */
export type PointerToVirtual = (clientX: number, clientY: number) => { x: number; y: number } | null

/**
 * Wire a `TouchControls` to real pointer events. Returns a detach function.
 *
 * UNVERIFIED BY THIS PROJECT'S INSTRUMENTS. Everything above is pure logic with
 * tests; this function is a translator that needs a real touchscreen to exercise,
 * and docs/MOBILE.md lists it as such rather than pretending otherwise.
 *
 * Move and release are bound to the window, not the canvas: a relative drag
 * routinely wanders off the canvas and off the letterbox, and a pointerup the
 * canvas never hears leaves a ghost finger steering forever.
 */
export function attachTouch(
  controls: TouchControls,
  target: EventTarget,
  toVirtual: PointerToVirtual,
  root: (Window & typeof globalThis) | null = typeof window === 'undefined' ? null : window,
): () => void {
  const isTouchLike = (event: PointerEvent): boolean => event.pointerType !== 'mouse'

  const onDown = (raw: Event): void => {
    const event = raw as PointerEvent
    if (!isTouchLike(event)) return
    const point = toVirtual(event.clientX, event.clientY)
    if (!point) return
    // Without this iOS still runs its own gesture recognisers over the canvas.
    // `touch-action: none` on the canvas is the other half and lives in index.html.
    event.preventDefault()
    controls.down(event.pointerId, point.x, point.y)
  }

  const onMove = (raw: Event): void => {
    const event = raw as PointerEvent
    if (!isTouchLike(event)) return
    const point = toVirtual(event.clientX, event.clientY)
    if (!point) return
    controls.move(event.pointerId, point.x, point.y)
  }

  const onUp = (raw: Event): void => {
    const event = raw as PointerEvent
    if (!isTouchLike(event)) return
    controls.up(event.pointerId)
  }

  const onLost = (): void => controls.reset()

  target.addEventListener('pointerdown', onDown, { passive: false })
  root?.addEventListener('pointermove', onMove)
  root?.addEventListener('pointerup', onUp)
  root?.addEventListener('pointercancel', onUp)
  root?.addEventListener('blur', onLost)

  return () => {
    target.removeEventListener('pointerdown', onDown)
    root?.removeEventListener('pointermove', onMove)
    root?.removeEventListener('pointerup', onUp)
    root?.removeEventListener('pointercancel', onUp)
    root?.removeEventListener('blur', onLost)
  }
}
