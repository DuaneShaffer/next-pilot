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
 *
 *      `confirm` now reaches `InputSnapshot` as well, because a selection screen must
 *      not accept on the fire key. That makes rule 2 stronger rather than weaker: the
 *      key that accepts a permadeath choice cannot be moved onto the trigger, since
 *      `CONFIRM_CODES` is a constant and Enter is refused as a gameplay binding.
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
  /**
   * Accept the highlighted option on a selection screen. NOT a sortie action.
   *
   * REPORTED FROM PLAY: "the selection screens must not use the fire key to accept
   * responses." Confirming used to be a rising `fire` edge, and in a shmup the trigger
   * is held permanently — so the accept key was, in practice, a key the player was
   * already pressing. Every consequence of that was ugly: a card could not be
   * confirmed at all until the trigger was released (a soft freeze a tester hit), the
   * mitigation was a 48-tick dwell that confirmed option 0 *for* the player, and touch
   * had to suppress its own auto-fire on every card or pick option 0 every time.
   *
   * A separate action deletes the whole class. It is never held during play, so a card
   * that opens under a held trigger is simply a card waiting for its own key.
   *
   * Deliberately NOT remappable and deliberately NOT the fire binding's codes — see
   * `CONFIRM_CODES`, and rule 2 in the header.
   */
  readonly confirm: boolean
}

export const NEUTRAL_INPUT: InputSnapshot = {
  moveX: 0,
  moveY: 0,
  fire: false,
  special: false,
  focus: false,
  confirm: false,
}

/**
 * Pack a snapshot into one byte, for compact replay storage.
 *
 * THE BYTE IS NOW FULL: movement takes bits 0-3, then fire, special, focus, confirm.
 * A ninth action cannot be added without widening the encoding, which changes
 * `REPLAY_FORMAT_VERSION` and every recorded fixture — see the note on `special` in
 * `src/sim/progression.ts` for the one action that will eventually want it.
 */
export function packInput(input: InputSnapshot): number {
  return (
    (input.moveX + 1) |
    ((input.moveY + 1) << 2) |
    (input.fire ? 1 << 4 : 0) |
    (input.special ? 1 << 5 : 0) |
    (input.focus ? 1 << 6 : 0) |
    (input.confirm ? 1 << 7 : 0)
  )
}

export function unpackInput(byte: number): InputSnapshot {
  return {
    moveX: ((byte & 0b11) - 1) as Axis,
    moveY: (((byte >> 2) & 0b11) - 1) as Axis,
    fire: (byte & (1 << 4)) !== 0,
    special: (byte & (1 << 5)) !== 0,
    focus: (byte & (1 << 6)) !== 0,
    confirm: (byte & (1 << 7)) !== 0,
  }
}

/**
 * What the player is looking at.
 *
 * Deliberately the same vocabulary as `TouchContext` in `src/core/touch.ts`. The two
 * types are structurally identical, so one call in the app layer can drive both
 * controllers.
 *
 * IT USED TO BE LOAD-BEARING FOR CORRECTNESS and is now only tidy. Cards were
 * confirmed by a rising `fire` edge, so asserting auto-fire outside a sortie made every
 * card take option 0 by itself; `'choice'` existing is what stopped that. `confirm` is
 * its own action now, so a card ignores the trigger entirely and this distinction is
 * back to being what it looks like — don't restore the old reasoning if you see the
 * gate and wonder what it is for.
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
/**
 * The codes that ACCEPT a selection, in a menu and on a card alike.
 *
 * SPACE IS ABSENT ON PURPOSE, and it is the whole point of the constant. Space is a
 * default `fire` binding, and a player who is holding it to shoot must not be holding
 * the key that accepts a permadeath choice — that equivalence is what produced the soft
 * freeze, the auto-confirming dwell, and "the selection screens must not use the fire
 * key to accept responses". `MENU_FLOOR.confirm` adds Space back for menus only, where
 * nothing is being shot at and a press is edge-triggered through `consumePressed`.
 *
 * Enter carries this instead, and `SYSTEM_CODES` refuses Enter as a gameplay binding,
 * so a player cannot re-create the overlap from the binding screen.
 */
export const CONFIRM_CODES: readonly string[] = ['Enter', 'NumpadEnter']

export const MENU_FLOOR: Readonly<Record<Action, readonly string[]>> = {
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  fire: [],
  special: [],
  focus: [],
  // Space is a MENU convenience only, never in `CONFIRM_CODES` — see there.
  confirm: [...CONFIRM_CODES, 'Space'],
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
      // Auto-fire ONLY in a sortie. Once load-bearing (a held trigger used to confirm
      // cards), now just correct: nothing off a sortie should be shooting.
      fire: this.anyHeld(this.bindings.fire) || (this.autoFire && this.ctx === 'sortie'),
      special: this.anyHeld(this.bindings.special),
      focus: this.anyHeld(this.bindings.focus),
      // Level-triggered here, edge-detected by the sim's cursor, which is what keeps a
      // replay's byte the whole truth about a tick. Read off `CONFIRM_CODES` rather than
      // any binding: confirm is not remappable, and it is deliberately not the fire key.
      confirm: this.anyHeld(CONFIRM_CODES),
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
