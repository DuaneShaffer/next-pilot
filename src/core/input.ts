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

const BINDINGS = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  fire: ['Space', 'KeyZ', 'KeyJ'],
  special: ['KeyX', 'KeyK', 'ShiftLeft', 'ShiftRight'],
  focus: ['ControlLeft', 'ControlRight', 'KeyC'],
  confirm: ['Enter', 'NumpadEnter', 'Space'],
  /**
   * `P` as well as Escape, because Escape is what browsers and OSes grab for
   * fullscreen and overlays — a player who has lost Escape still needs to pause a
   * permadeath run.
   */
  pause: ['Escape', 'KeyP'],
  cancel: ['Escape'],
} as const

/** Keys we swallow so the page never scrolls out from under the game. */
const SWALLOWED = new Set<string>([
  ...BINDINGS.left,
  ...BINDINGS.right,
  ...BINDINGS.up,
  ...BINDINGS.down,
  ...BINDINGS.fire,
  ...BINDINGS.focus,
])

export class Keyboard {
  private readonly held = new Set<string>()
  /** Codes pressed since the last consumePressed() — for menus, not the sim. */
  private readonly pressed = new Set<string>()
  private detach: (() => void) | null = null

  attach(target: Window | HTMLElement = window): void {
    const onDown = (event: Event) => {
      const e = event as KeyboardEvent
      if (e.repeat) return
      if (SWALLOWED.has(e.code)) e.preventDefault()
      this.held.add(e.code)
      this.pressed.add(e.code)
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
  }

  private anyHeld(codes: readonly string[]): boolean {
    return codes.some((code) => this.held.has(code))
  }

  snapshot(): InputSnapshot {
    const left = this.anyHeld(BINDINGS.left)
    const right = this.anyHeld(BINDINGS.right)
    const up = this.anyHeld(BINDINGS.up)
    const down = this.anyHeld(BINDINGS.down)
    return {
      moveX: (left && right ? 0 : left ? -1 : right ? 1 : 0) as Axis,
      moveY: (up && down ? 0 : up ? -1 : down ? 1 : 0) as Axis,
      fire: this.anyHeld(BINDINGS.fire),
      special: this.anyHeld(BINDINGS.special),
      focus: this.anyHeld(BINDINGS.focus),
    }
  }

  /** True once per physical press. Drains the buffer. */
  consumePressed(action: keyof typeof BINDINGS): boolean {
    const codes = BINDINGS[action]
    let hit = false
    for (const code of codes) {
      if (this.pressed.delete(code)) hit = true
    }
    return hit
  }

  clearPressed(): void {
    this.pressed.clear()
  }
}
