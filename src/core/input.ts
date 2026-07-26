/**
 * Input capture.
 *
 * THE CONTRACT: the simulation never reads the keyboard. It receives an
 * immutable InputSnapshot per tick. That indirection is what makes replays
 * possible — a recorded run is nothing but a seed plus the sequence of these
 * snapshots, and playing it back drives the same sim through the same states.
 *
 * Movement is digital (-1/0/1) rather than analogue so snapshots stay tiny and
 * compare exactly.
 *
 * REMAPPING LIVES HERE AND NOWHERE ELSE. `InputSnapshot` is frozen; what a player
 * can change is the *mapping from physical keys onto it*. So the whole feature is
 * contained in this file plus the store in `src/meta/keybinds.ts`, the sim is
 * untouched, and a replay recorded on a remapped keyboard plays back identically
 * on a default one — the recorded bytes are snapshots, not keys.
 *
 * THE LOCKOUT TRAP, AND HOW IT IS SOLVED. A binding screen that can take away the
 * keys used to reach the binding screen is a trap, and "clear your localStorage" is
 * not an answer you can give a player mid-run. Three rules, in order of strength:
 *
 *   1. **Menus and the sortie resolve through different tables.** `snapshot()` —
 *      the sortie — reads user bindings only. `consumePressed()` — every menu —
 *      reads `MENU_FLOOR` *unioned with* user bindings. The floor is a compile-time
 *      constant, is never persisted, and no code path can edit it, so
 *      arrows/Enter/Escape navigate every menu in the game whatever is bound.
 *   2. **Pause, confirm and cancel are not remappable at all.** They are the way
 *      back to the screen that fixes a mistake, and an escape hatch you can move is
 *      an escape hatch you can lose. `SYSTEM_CODES` are also refused as gameplay
 *      bindings, so Escape can never both pause and fire.
 *   3. Restore-defaults is one action on the settings screen, reachable using only
 *      floor keys.
 *
 * Codes are `event.code`, never `event.key`: `code` is the physical position, so a
 * player on AZERTY or Dvorak gets the same *place* rather than the same letter, and
 * a bound key does not silently change meaning when the OS layout does.
 */

export type Axis = -1 | 0 | 1

export interface InputSnapshot {
  readonly moveX: Axis
  readonly moveY: Axis
  readonly fire: boolean
  readonly special: boolean
  /** Held to move precisely at reduced speed for threading dense patterns. */
  readonly focus: boolean
}

export const NEUTRAL_INPUT: InputSnapshot = {
  moveX: 0,
  moveY: 0,
  fire: false,
  special: false,
  focus: false,
}

/** Pack a snapshot into one byte, for compact replay storage. */
export function packInput(input: InputSnapshot): number {
  return (
    (input.moveX + 1) |
    ((input.moveY + 1) << 2) |
    (input.fire ? 1 << 4 : 0) |
    (input.special ? 1 << 5 : 0) |
    (input.focus ? 1 << 6 : 0)
  )
}

export function unpackInput(byte: number): InputSnapshot {
  return {
    moveX: ((byte & 0b11) - 1) as Axis,
    moveY: (((byte >> 2) & 0b11) - 1) as Axis,
    fire: (byte & (1 << 4)) !== 0,
    special: (byte & (1 << 5)) !== 0,
    focus: (byte & (1 << 6)) !== 0,
  }
}

/**
 * What the player is looking at.
 *
 * Deliberately the same vocabulary as `TouchContext` in `src/core/touch.ts`, and
 * for the same reason: auto-fire must not be asserted while a reward card is open,
 * because `updateCursor` in `src/sim/progression.ts` confirms a card from a *held*
 * trigger after a dwell. Assert fire unconditionally and every card auto-takes
 * option 0. The two types are structurally identical, so one call in the app layer
 * can drive both controllers.
 */
export type InputContext = 'sortie' | 'choice' | 'menu'

/** Actions a player may rebind. Exactly the ones that reach `InputSnapshot`. */
export const SORTIE_ACTIONS = ['left', 'right', 'up', 'down', 'fire', 'special', 'focus'] as const
export type SortieAction = (typeof SORTIE_ACTIONS)[number]

/**
 * Actions that operate menus, deliberately NOT remappable.
 *
 * `pause` is here as well as `cancel` because pause is how a player leaves a run
 * that is hurting them, and because `P` exists alongside Escape: browsers and OSes
 * routinely grab Escape for fullscreen and overlays, and a pilot who has lost
 * Escape still needs to pause a permadeath run.
 */
export const MENU_ACTIONS = ['confirm', 'cancel', 'pause'] as const
export type MenuAction = (typeof MENU_ACTIONS)[number]

export type Action = SortieAction | MenuAction

export type Bindings = Readonly<Record<SortieAction, readonly string[]>>

/**
 * Shipped bindings.
 *
 * WASD *and* the arrows simultaneously, not one or the other: they are the two
 * conventions players arrive with, and offering both by default means the majority
 * never has to visit the binding screen at all. A feature reached only by
 * remapping is, in practice, reached by nobody.
 */
export const DEFAULT_BINDINGS: Bindings = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  fire: ['Space', 'KeyZ', 'KeyJ'],
  special: ['KeyX', 'KeyK', 'ShiftLeft', 'ShiftRight'],
  focus: ['ControlLeft', 'ControlRight', 'KeyC'],
}

/**
 * The keys that always work in a menu, whatever is bound.
 *
 * Rule 1 of the lockout fix. Not persisted, not editable, not merged into
 * `Bindings` — a separate table that `consumePressed` unions in. The sortie
 * (`snapshot()`) deliberately does NOT consult it, so a player who unbinds the
 * arrows really does free them for something else while still being able to
 * navigate back here and change their mind.
 */
export const MENU_FLOOR: Readonly<Record<Action, readonly string[]>> = {
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  fire: [],
  special: [],
  focus: [],
  confirm: ['Enter', 'NumpadEnter', 'Space'],
  cancel: ['Escape', 'Backspace'],
  pause: ['Escape', 'KeyP'],
}

/**
 * Codes that may never be assigned to a gameplay action.
 *
 * Escape and Enter carry the floor, so binding `fire` to Escape would fire every
 * time the player tried to pause. The rest belong to the browser: rebinding them
 * produces a control that works on one machine and does nothing on the next, which
 * is worse than refusing.
 */
export const SYSTEM_CODES: ReadonlySet<string> = new Set([
  'Escape',
  'Enter',
  'NumpadEnter',
  'Tab',
  'F5',
  'F11',
  'F12',
  'ContextMenu',
  'MetaLeft',
  'MetaRight',
])

/**
 * Codes whose browser default is suppressed so the page never scrolls out from
 * under the game.
 *
 * Recomputed whenever bindings change: a player who moves `fire` to `PageDown` and
 * then watches the page scroll every time they shoot has been handed a control
 * that does not work.
 */
function swallowedCodes(bindings: Bindings): ReadonlySet<string> {
  const codes = new Set<string>()
  for (const action of SORTIE_ACTIONS) {
    for (const code of bindings[action]) codes.add(code)
  }
  for (const action of ['left', 'right', 'up', 'down'] as const) {
    for (const code of MENU_FLOOR[action]) codes.add(code)
  }
  codes.add('Space')
  // Never suppressed: the browser's own escape hatches must keep working even when
  // a player has bound something next to them.
  for (const code of ['Tab', 'Escape', 'F5', 'F11', 'F12']) codes.delete(code)
  return codes
}

export class Keyboard {
  private readonly held = new Set<string>()
  /** Codes pressed since the last consumePressed() — for menus, not the sim. */
  private readonly pressed = new Set<string>()
  private detach: (() => void) | null = null
  private bindings: Bindings = DEFAULT_BINDINGS
  private swallowed: ReadonlySet<string> = swallowedCodes(DEFAULT_BINDINGS)
  private ctx: InputContext = 'menu'
  private autoFire = false
  /**
   * Raw taps, for the binding screen only.
   *
   * A rebind must capture the *physical key*, which by definition is not an action
   * yet — resolving it through the binding tables first is exactly the circularity
   * that makes rebinding impossible once you have made a mistake.
   */
  private captureSink: ((code: string) => void) | null = null

  attach(target: Window | HTMLElement = window): void {
    const onDown = (event: Event) => {
      const e = event as KeyboardEvent
      /*
       * `preventDefault` BEFORE the autorepeat guard, and the order is the whole bug.
       *
       * It used to `return` on `e.repeat` first, so only the FIRST keydown of a hold
       * was swallowed and every autorepeat afterwards reached the browser. Hold
       * ArrowDown, ArrowUp or Space during a sortie and the page scrolls out from under
       * the canvas — which is the single thing `swallowedCodes` exists to stop, failing
       * in exactly the case a shmup spends all its time in.
       *
       * Everything below the guard still needs it: `pressed` is edge-triggered, so an
       * autorepeat must not re-enter it, and the rebind capture must not fire twice for
       * one physical press.
       */
      if (this.swallowed.has(e.code)) e.preventDefault()
      if (e.repeat) return
      this.held.add(e.code)
      this.pressed.add(e.code)
      const sink = this.captureSink
      if (sink) {
        // The press is consumed: the key being bound must not also act while the
        // capture prompt is open, or assigning `fire` to Enter also confirms.
        this.pressed.delete(e.code)
        this.captureSink = null
        sink(e.code)
      }
    }
    const onUp = (event: Event) => {
      const e = event as KeyboardEvent
      this.held.delete(e.code)
    }
    // Losing focus mid-hold would otherwise leave the ship drifting forever.
    const onBlur = () => this.held.clear()

    target.addEventListener('keydown', onDown)
    target.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    this.detach = () => {
      target.removeEventListener('keydown', onDown)
      target.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }

  dispose(): void {
    this.detach?.()
    this.detach = null
    this.held.clear()
    this.pressed.clear()
    this.captureSink = null
  }

  setBindings(bindings: Bindings): void {
    this.bindings = bindings
    this.swallowed = swallowedCodes(bindings)
    // A key held while its meaning changed would otherwise stay "held" as the new
    // action until released — the ship starting to fire because the player was
    // still holding the key they just assigned to fire.
    this.held.clear()
  }

  getBindings(): Bindings {
    return this.bindings
  }

  /**
   * Set what the player is looking at. Only `'sortie'` asserts auto-fire.
   *
   * Mirrors `TouchControls.setContext`, including why: see `InputContext`.
   */
  setContext(context: InputContext): void {
    this.ctx = context
  }

  get context(): InputContext {
    return this.ctx
  }

  /**
   * Hold the trigger for the player.
   *
   * A shmup asks for a key to be held down for three minutes at a time, which is a
   * real barrier for anyone with a motor impairment or RSI — and holding it is what
   * every competent player does anyway, so this removes an obstacle without changing
   * what a good run looks like. Replay-safe: a snapshot is a snapshot however it was
   * produced, and nothing about it reaches the sim differently.
   */
  setAutoFire(enabled: boolean): void {
    this.autoFire = enabled
  }

  /**
   * Route the next raw keypress to `sink` instead of through the action tables.
   *
   * Returns a function that stops capturing. Escape is delivered as `'Escape'` and
   * is refused as a binding by `SYSTEM_CODES`, so the capture prompt can always be
   * dismissed with a key that is guaranteed to exist and guaranteed to be safe.
   */
  captureNextCode(sink: (code: string) => void): () => void {
    this.captureSink = sink
    return () => {
      this.captureSink = null
    }
  }

  get capturing(): boolean {
    return this.captureSink !== null
  }

  /** Test seam: feed a code as though the player had pressed it. */
  pressForTest(code: string): void {
    const sink = this.captureSink
    if (sink) {
      this.captureSink = null
      sink(code)
      return
    }
    this.held.add(code)
    this.pressed.add(code)
  }

  /** Test seam: release a code. */
  releaseForTest(code: string): void {
    this.held.delete(code)
  }

  private anyHeld(codes: readonly string[]): boolean {
    return codes.some((code) => this.held.has(code))
  }

  snapshot(): InputSnapshot {
    const left = this.anyHeld(this.bindings.left)
    const right = this.anyHeld(this.bindings.right)
    const up = this.anyHeld(this.bindings.up)
    const down = this.anyHeld(this.bindings.down)
    return {
      moveX: (left && right ? 0 : left ? -1 : right ? 1 : 0) as Axis,
      moveY: (up && down ? 0 : up ? -1 : down ? 1 : 0) as Axis,
      // Auto-fire ONLY in a sortie. This one condition is what stops every reward
      // card from confirming option 0 by itself after HELD_CONFIRM_DWELL_TICKS.
      fire: this.anyHeld(this.bindings.fire) || (this.autoFire && this.ctx === 'sortie'),
      special: this.anyHeld(this.bindings.special),
      focus: this.anyHeld(this.bindings.focus),
    }
  }

  /**
   * Every code that currently triggers `action` outside a sortie.
   *
   * The floor comes first so the list reads as what it is: a guarantee, with the
   * player's choices added on top rather than replacing it.
   */
  codesFor(action: Action): readonly string[] {
    const out = [...MENU_FLOOR[action]]
    if (isSortieAction(action)) {
      for (const code of this.bindings[action]) if (!out.includes(code)) out.push(code)
    }
    return out
  }

  /** True once per physical press. Drains the buffer. */
  consumePressed(action: Action): boolean {
    let hit = false
    for (const code of this.codesFor(action)) {
      if (this.pressed.delete(code)) hit = true
    }
    return hit
  }

  clearPressed(): void {
    this.pressed.clear()
  }
}

export function isSortieAction(action: string): action is SortieAction {
  return (SORTIE_ACTIONS as readonly string[]).includes(action)
}
