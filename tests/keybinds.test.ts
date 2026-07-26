/**
 * Key bindings.
 *
 * The load-bearing property is not "a rebind works". It is that **no sequence of
 * rebinds can leave the player unable to reach the screen that undoes them.** Most
 * of this file is about that, because it is the failure a player cannot recover
 * from without being told to open devtools.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BINDINGS,
  Keyboard,
  MENU_FLOOR,
  SORTIE_ACTIONS,
  SYSTEM_CODES,
  isSortieAction,
  type Bindings,
  type SortieAction,
} from '../src/core/input'
import {
  MAX_CODES_PER_ACTION,
  assignBinding,
  checkBindings,
  clearBinding,
  clearStoredBindings,
  coerceBindings,
  defaultBindings,
  describeBinding,
  describeCode,
  explainRejection,
  loadBindings,
  ownerOf,
  ownersOf,
  persistBindings,
  replaceBinding,
  restoreAction,
} from '../src/meta/keybinds'

/** A localStorage stand-in. Vitest runs in Node; there is no real one. */
function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed))
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

describe('defaults', () => {
  it('ships WASD and the arrows at the same time', () => {
    // Not one or the other. These are the two conventions players arrive with, and
    // a control scheme reached only by remapping is reached by nobody.
    expect(DEFAULT_BINDINGS.left).toContain('KeyA')
    expect(DEFAULT_BINDINGS.left).toContain('ArrowLeft')
    expect(DEFAULT_BINDINGS.up).toContain('KeyW')
    expect(DEFAULT_BINDINGS.up).toContain('ArrowUp')
  })

  it('binds every action to at least one key', () => {
    for (const action of SORTIE_ACTIONS) {
      expect(DEFAULT_BINDINGS[action].length, action).toBeGreaterThan(0)
    }
  })

  it('uses physical key codes, never characters', () => {
    // `event.key` on AZERTY reports 'q' for the key where QWERTY has 'a', so a
    // key-based default would ship a control scheme that is wrong by design for a
    // large part of Europe. Every default must look like a `code`.
    for (const action of SORTIE_ACTIONS) {
      for (const code of DEFAULT_BINDINGS[action]) {
        expect(code, `${action}: ${code}`).toMatch(
          /^(Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Space|Shift(Left|Right)|Control(Left|Right)|Alt(Left|Right)|Numpad.*|[A-Z][A-Za-z]+)$/,
        )
        expect(code.length, `${action}: ${code}`).toBeGreaterThan(1)
      }
    }
  })

  it('never claims a code that operates a menu', () => {
    for (const action of SORTIE_ACTIONS) {
      for (const code of DEFAULT_BINDINGS[action]) {
        expect(SYSTEM_CODES.has(code), `${action} claims the reserved ${code}`).toBe(false)
      }
    }
  })

  it('does not double-book a code across two actions', () => {
    const health = checkBindings(DEFAULT_BINDINGS)
    expect(health.duplicated).toEqual([])
    expect(health.unbound).toEqual([])
    expect(health.reserved).toEqual([])
  })

  it('stays inside the per-action cap', () => {
    for (const action of SORTIE_ACTIONS) {
      expect(DEFAULT_BINDINGS[action].length).toBeLessThanOrEqual(MAX_CODES_PER_ACTION)
    }
  })
})

describe('the lockout trap', () => {
  /**
   * The scenario: a player rebinds everything to keys they cannot press, or to one
   * key, or to nothing they can find. They must still be able to reach the settings
   * screen and press "restore defaults".
   */
  const HOSTILE: Bindings = {
    left: ['F13'],
    right: ['F14'],
    up: ['F15'],
    down: ['F16'],
    fire: ['F17'],
    special: ['F18'],
    focus: ['F19'],
  }

  it('navigates menus with the arrows after every movement key is rebound away', () => {
    const keyboard = new Keyboard()
    keyboard.setBindings(HOSTILE)

    for (const [action, code] of [
      ['up', 'ArrowUp'],
      ['down', 'ArrowDown'],
      ['left', 'ArrowLeft'],
      ['right', 'ArrowRight'],
    ] as const) {
      keyboard.pressForTest(code)
      expect(keyboard.consumePressed(action), `${code} must still drive ${action}`).toBe(true)
    }
  })

  it('confirms and cancels after every key is rebound away', () => {
    const keyboard = new Keyboard()
    keyboard.setBindings(HOSTILE)

    keyboard.pressForTest('Enter')
    expect(keyboard.consumePressed('confirm')).toBe(true)
    keyboard.pressForTest('Escape')
    expect(keyboard.consumePressed('cancel')).toBe(true)
    keyboard.pressForTest('Escape')
    expect(keyboard.consumePressed('pause')).toBe(true)
  })

  it('keeps the floor working even when bindings are structurally broken', () => {
    // Not merely "hostile" — actually empty. Nothing can be rebound to repair this
    // except from a menu, so the menu has to work.
    const empty = Object.fromEntries(
      SORTIE_ACTIONS.map((a) => [a, [] as readonly string[]]),
    ) as unknown as Bindings
    const keyboard = new Keyboard()
    keyboard.setBindings(empty)
    for (const code of ['ArrowUp', 'ArrowDown', 'Enter', 'Escape']) {
      keyboard.pressForTest(code)
    }
    expect(keyboard.consumePressed('up')).toBe(true)
    expect(keyboard.consumePressed('down')).toBe(true)
    expect(keyboard.consumePressed('confirm')).toBe(true)
    expect(keyboard.consumePressed('cancel')).toBe(true)
  })

  it('gives every menu action a non-empty floor', () => {
    // The guarantee, asserted directly rather than inferred from the tests above.
    for (const action of ['up', 'down', 'left', 'right', 'confirm', 'cancel', 'pause'] as const) {
      expect(MENU_FLOOR[action].length, action).toBeGreaterThan(0)
    }
  })

  it('refuses to bind a gameplay action to a menu key', () => {
    for (const code of ['Escape', 'Enter', 'NumpadEnter', 'Tab']) {
      const result = assignBinding(DEFAULT_BINDINGS, 'fire', code)
      expect(result.ok, code).toBe(false)
      expect(result.rejection).toBe('reserved')
      expect(result.bindings).toBe(DEFAULT_BINDINGS)
    }
  })

  it('does not let the sortie inherit the menu floor', () => {
    // The other half of the split. If `snapshot()` silently fell back to the floor,
    // "I freed the arrows for something else" would be a lie, and the two tables
    // would be one table with extra steps.
    const keyboard = new Keyboard()
    keyboard.setBindings({ ...DEFAULT_BINDINGS, up: ['KeyW'] })
    keyboard.pressForTest('ArrowUp')
    expect(keyboard.snapshot().moveY).toBe(0)
    keyboard.pressForTest('KeyW')
    expect(keyboard.snapshot().moveY).toBe(-1)
  })

  it('restores defaults from any state at all', () => {
    expect(defaultBindings()).toEqual(DEFAULT_BINDINGS)
    expect(checkBindings(defaultBindings()).unbound).toEqual([])
  })
})

describe('the conflict rule', () => {
  it('moves a key from its previous owner', () => {
    const result = assignBinding(DEFAULT_BINDINGS, 'focus', 'KeyZ')
    expect(result.ok).toBe(true)
    expect(result.evictedFrom).toBe('fire')
    expect(result.bindings.fire).not.toContain('KeyZ')
    expect(result.bindings.focus).toContain('KeyZ')
  })

  it('refuses when the eviction would leave the other action unbound', () => {
    // The case that matters. Silently disarming `fire` to grant a second `focus`
    // key is a failure the player discovers mid-run, in a permadeath game.
    const tight: Bindings = { ...DEFAULT_BINDINGS, fire: ['KeyZ'] }
    const result = assignBinding(tight, 'focus', 'KeyZ')
    expect(result.ok).toBe(false)
    expect(result.rejection).toBe('would-unbind')
    expect(result.bindings).toBe(tight)
    expect(result.bindings.fire).toEqual(['KeyZ'])
  })

  it('treats rebinding a key to the action that already has it as a no-op success', () => {
    const result = assignBinding(DEFAULT_BINDINGS, 'fire', 'KeyZ')
    expect(result.ok).toBe(true)
    expect(result.bindings).toBe(DEFAULT_BINDINGS)
  })

  it('drops the oldest key once an action is full', () => {
    let bindings: Bindings = { ...DEFAULT_BINDINGS, focus: ['KeyC'] }
    for (const code of ['KeyV', 'KeyB', 'KeyN', 'KeyM']) {
      const result = assignBinding(bindings, 'focus', code)
      expect(result.ok, code).toBe(true)
      bindings = result.bindings
    }
    expect(bindings.focus.length).toBe(MAX_CODES_PER_ACTION)
    expect(bindings.focus).not.toContain('KeyC')
    expect(bindings.focus).toContain('KeyM')
  })

  it('replaces the whole list when asked to replace', () => {
    const result = replaceBinding(DEFAULT_BINDINGS, 'fire', 'KeyQ')
    expect(result.ok).toBe(true)
    expect(result.bindings.fire).toEqual(['KeyQ'])
  })

  it('applies the same refusal to a replace', () => {
    const tight: Bindings = { ...DEFAULT_BINDINGS, special: ['KeyX'] }
    const result = replaceBinding(tight, 'fire', 'KeyX')
    expect(result.ok).toBe(false)
    expect(result.rejection).toBe('would-unbind')
  })

  it('lets an action replace itself with one of its own keys', () => {
    const result = replaceBinding(DEFAULT_BINDINGS, 'fire', 'KeyJ')
    expect(result.ok).toBe(true)
    expect(result.bindings.fire).toEqual(['KeyJ'])
    expect(result.evictedFrom).toBeUndefined()
  })

  it('never leaves an action unbound, whatever the sequence', () => {
    // Property-ish: hammer the primitives with a deterministic pseudo-random walk
    // and assert the invariant after every step. No RNG import — the sequence has
    // to be the same on every machine or a failure here is not reproducible.
    let bindings = defaultBindings()
    let seed = 0x2f6e2b1
    const next = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff)
    const codes = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'Escape', 'Enter', 'ArrowUp', 'Space']

    for (let step = 0; step < 3000; step++) {
      const action = SORTIE_ACTIONS[next() % SORTIE_ACTIONS.length] as SortieAction
      const code = codes[next() % codes.length] as string
      const mode = next() % 3
      const result =
        mode === 0
          ? assignBinding(bindings, action, code)
          : mode === 1
            ? replaceBinding(bindings, action, code)
            : clearBinding(bindings, action, code)
      if (result.ok) bindings = result.bindings

      const health = checkBindings(bindings)
      expect(health.unbound, `step ${step}`).toEqual([])
      expect(health.reserved, `step ${step}`).toEqual([])
      expect(health.duplicated, `step ${step}`).toEqual([])
    }
  })
})

describe('unbinding', () => {
  it('removes a spare key', () => {
    const result = clearBinding(DEFAULT_BINDINGS, 'fire', 'KeyJ')
    expect(result.ok).toBe(true)
    expect(result.bindings.fire).not.toContain('KeyJ')
    expect(result.bindings.fire.length).toBe(DEFAULT_BINDINGS.fire.length - 1)
  })

  it('refuses to remove the last key', () => {
    const tight: Bindings = { ...DEFAULT_BINDINGS, focus: ['KeyC'] }
    const result = clearBinding(tight, 'focus', 'KeyC')
    expect(result.ok).toBe(false)
    expect(result.rejection).toBe('last-key')
    expect(result.bindings.focus).toEqual(['KeyC'])
  })

  it('is a no-op for a key the action does not have', () => {
    const result = clearBinding(DEFAULT_BINDINGS, 'fire', 'KeyQ')
    expect(result.ok).toBe(true)
    expect(result.bindings).toBe(DEFAULT_BINDINGS)
  })

  it('restores one action without emptying another', () => {
    const moved = replaceBinding(DEFAULT_BINDINGS, 'focus', 'KeyW').bindings
    expect(moved.up).not.toContain('KeyW')
    const back = restoreAction(moved, 'up')
    expect(back.up).toEqual(DEFAULT_BINDINGS.up)
    expect(checkBindings(back).unbound).toEqual([])
  })
})

describe('purity', () => {
  it('never mutates the bindings it is given', () => {
    const frozen = Object.freeze({
      ...DEFAULT_BINDINGS,
      fire: Object.freeze([...DEFAULT_BINDINGS.fire]),
    }) as Bindings
    expect(() => assignBinding(frozen, 'focus', 'KeyZ')).not.toThrow()
    expect(() => replaceBinding(frozen, 'fire', 'KeyQ')).not.toThrow()
    expect(() => clearBinding(frozen, 'fire', 'KeyJ')).not.toThrow()
    expect(frozen.fire).toEqual(DEFAULT_BINDINGS.fire)
  })
})

describe('storage', () => {
  it('round-trips', () => {
    const storage = fakeStorage()
    const custom = replaceBinding(DEFAULT_BINDINGS, 'fire', 'KeyQ').bindings
    persistBindings(custom, storage)
    expect(loadBindings(storage)).toEqual(custom)
  })

  it('returns defaults when nothing is stored', () => {
    expect(loadBindings(fakeStorage())).toEqual(DEFAULT_BINDINGS)
  })

  it('returns defaults when storage is unavailable', () => {
    // Private browsing throws on access, not just on write. A player in an
    // incognito window gets a playable game, not an exception at startup.
    expect(loadBindings(null)).toEqual(DEFAULT_BINDINGS)
    expect(() => persistBindings(DEFAULT_BINDINGS, null)).not.toThrow()
    expect(() => clearStoredBindings(null)).not.toThrow()
  })

  it('survives every kind of corruption without throwing', () => {
    for (const payload of [
      'not json',
      '{}',
      'null',
      '[]',
      '{"version":1}',
      '{"version":1,"bindings":null}',
      '{"version":1,"bindings":{"fire":"KeyZ"}}',
      '{"version":1,"bindings":{"fire":[1,2,3]}}',
      '{"version":1,"bindings":{"fire":[]}}',
      '{"version":1,"bindings":{"fire":["Escape","Enter"]}}',
      '{"version":999,"bindings":{"fire":["KeyQ"]}}',
    ]) {
      const storage = fakeStorage({ 'next-pilot/keybinds': payload })
      const loaded = loadBindings(storage)
      const health = checkBindings(loaded)
      expect(health.unbound, payload).toEqual([])
      expect(health.reserved, payload).toEqual([])
    }
  })

  it('falls back per action rather than wholesale', () => {
    // One garbage action should not cost the player the six they got right.
    const storage = fakeStorage({
      'next-pilot/keybinds': JSON.stringify({
        version: 1,
        bindings: { fire: ['KeyQ'], left: 'nonsense' },
      }),
    })
    const loaded = loadBindings(storage)
    expect(loaded.fire).toEqual(['KeyQ'])
    expect(loaded.left).toEqual(DEFAULT_BINDINGS.left)
  })

  it('drops reserved codes and duplicates on the way in', () => {
    const coerced = coerceBindings({
      fire: ['KeyQ', 'Escape', 'KeyQ', 'Enter'],
      focus: ['KeyQ'],
    })
    expect(coerced.fire).toEqual(['KeyQ'])
    // `focus` lost its only entry to the earlier claim, so it falls back rather
    // than arriving empty.
    expect(coerced.focus).toEqual(DEFAULT_BINDINGS.focus)
    expect(checkBindings(coerced).duplicated).toEqual([])
  })

  it('caps a hand-edited list', () => {
    const coerced = coerceBindings({
      fire: ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU'],
    })
    expect(coerced.fire.length).toBe(MAX_CODES_PER_ACTION)
  })

  it('keeps bindings out of the save key', () => {
    // The whole argument for a separate store: a corrupt keymap must not be able
    // to cost a player their pilot history.
    const storage = fakeStorage()
    persistBindings(DEFAULT_BINDINGS, storage)
    expect(storage.getItem('next-pilot/save')).toBeNull()
    expect(storage.getItem('next-pilot/keybinds')).not.toBeNull()
  })
})

describe('naming keys for humans', () => {
  it('never shows a raw code', () => {
    for (const code of [
      'KeyA',
      'Digit4',
      'ArrowLeft',
      'ShiftLeft',
      'ControlRight',
      'Space',
      'Numpad7',
      'Semicolon',
      'F7',
      'AudioVolumeUp',
    ]) {
      const name = describeCode(code)
      expect(name.length, code).toBeGreaterThan(0)
      // "KeyZ" on a settings screen makes it read like a debug panel.
      expect(name.startsWith('Key'), code).toBe(false)
      expect(name.startsWith('Digit'), code).toBe(false)
    }
  })

  it('keeps left and right modifiers distinct', () => {
    expect(describeCode('ShiftLeft')).not.toBe(describeCode('ShiftRight'))
    expect(describeCode('ControlLeft')).not.toBe(describeCode('ControlRight'))
  })

  it('never returns something too long for a row', () => {
    for (const code of ['BrowserFavorites', 'LaunchMediaPlayer', 'AudioVolumeMute']) {
      expect(describeCode(code).length, code).toBeLessThanOrEqual(12)
    }
  })

  it('describes an action as the keys a player would press', () => {
    expect(describeBinding(DEFAULT_BINDINGS, 'up')).toBe('Up / W')
    const empty = { ...DEFAULT_BINDINGS, focus: [] } as Bindings
    expect(describeBinding(empty, 'focus')).toBe('Unbound')
  })

  it('explains every refusal in plain language, with no code leaking through', () => {
    for (const rejection of ['reserved', 'would-unbind', 'last-key'] as const) {
      const text = explainRejection(rejection, 'KeyZ')
      expect(text.length).toBeGreaterThan(20)
      expect(text).not.toContain('KeyZ')
      expect(text.endsWith('.')).toBe(true)
    }
  })
})

describe('the keyboard resolves through the bindings it is given', () => {
  it('drives the snapshot from a custom map', () => {
    const keyboard = new Keyboard()
    keyboard.setBindings({
      left: ['KeyH'],
      right: ['KeyL'],
      up: ['KeyK'],
      down: ['KeyJ'],
      fire: ['KeyF'],
      special: ['KeyG'],
      focus: ['KeyD'],
    })
    keyboard.pressForTest('KeyL')
    keyboard.pressForTest('KeyK')
    keyboard.pressForTest('KeyF')
    const snapshot = keyboard.snapshot()
    expect(snapshot).toEqual({
      moveX: 1,
      moveY: -1,
      fire: true,
      special: false,
      focus: false,
      confirm: false,
    })
  })

  it('cancels opposing directions rather than picking one', () => {
    const keyboard = new Keyboard()
    keyboard.pressForTest('KeyA')
    keyboard.pressForTest('KeyD')
    expect(keyboard.snapshot().moveX).toBe(0)
  })

  it('drops held keys when the map changes underneath them', () => {
    // Otherwise the key the player was holding while they bound it stays "held" as
    // the new action until they let go — the ship starting to fire on its own.
    const keyboard = new Keyboard()
    keyboard.pressForTest('KeyW')
    expect(keyboard.snapshot().moveY).toBe(-1)
    keyboard.setBindings({ ...DEFAULT_BINDINGS, fire: ['KeyW'] })
    expect(keyboard.snapshot()).toEqual({
      moveX: 0,
      moveY: 0,
      fire: false,
      special: false,
      focus: false,
      confirm: false,
    })
  })

  it('unions the floor into menu presses without touching the sortie', () => {
    const keyboard = new Keyboard()
    keyboard.setBindings({ ...DEFAULT_BINDINGS, up: ['KeyI'] })
    expect(keyboard.codesFor('up')).toEqual(['ArrowUp', 'KeyI'])
    expect(keyboard.codesFor('confirm')).toEqual(MENU_FLOOR.confirm)
  })
})

describe('auto-fire', () => {
  it('holds the trigger during a sortie', () => {
    const keyboard = new Keyboard()
    keyboard.setAutoFire(true)
    keyboard.setContext('sortie')
    expect(keyboard.snapshot().fire).toBe(true)
  })

  it('does NOT hold it while a reward card is open', () => {
    // `updateCursor` in src/sim/progression.ts confirms a card from a held trigger
    // after a dwell. Assert fire unconditionally and every card on every run
    // auto-takes option 0 after 0.8 seconds, forever. This one assertion is the
    // reason `InputContext` exists, and it mirrors the same rule in touch.ts.
    const keyboard = new Keyboard()
    keyboard.setAutoFire(true)
    for (const context of ['choice', 'menu'] as const) {
      keyboard.setContext(context)
      expect(keyboard.snapshot().fire, context).toBe(false)
    }
  })

  it('does not interfere with a real press', () => {
    const keyboard = new Keyboard()
    keyboard.setAutoFire(false)
    keyboard.setContext('sortie')
    expect(keyboard.snapshot().fire).toBe(false)
    keyboard.pressForTest('Space')
    expect(keyboard.snapshot().fire).toBe(true)
  })
})

describe('capture', () => {
  it('routes the next raw code to the sink instead of to an action', () => {
    const keyboard = new Keyboard()
    const seen: string[] = []
    keyboard.captureNextCode((code) => seen.push(code))
    keyboard.pressForTest('KeyQ')
    expect(seen).toEqual(['KeyQ'])
    // The press was consumed: it must not also confirm the row it was typed on.
    expect(keyboard.consumePressed('confirm')).toBe(false)
  })

  it('stops capturing after one key', () => {
    const keyboard = new Keyboard()
    const seen: string[] = []
    keyboard.captureNextCode((code) => seen.push(code))
    keyboard.pressForTest('KeyQ')
    keyboard.pressForTest('KeyW')
    expect(seen).toEqual(['KeyQ'])
    expect(keyboard.capturing).toBe(false)
  })

  it('delivers Escape rather than swallowing it', () => {
    // The prompt has to be dismissable by a key that always exists. Escape is also
    // refused as a binding, so delivering it can only ever mean "cancel".
    const keyboard = new Keyboard()
    let got: string | null = null
    keyboard.captureNextCode((code) => (got = code))
    keyboard.pressForTest('Escape')
    expect(got).toBe('Escape')
    expect(assignBinding(DEFAULT_BINDINGS, 'fire', 'Escape').ok).toBe(false)
  })

  it('can be cancelled by the caller', () => {
    const keyboard = new Keyboard()
    const seen: string[] = []
    const stop = keyboard.captureNextCode((code) => seen.push(code))
    stop()
    keyboard.pressForTest('KeyQ')
    expect(seen).toEqual([])
    expect(keyboard.capturing).toBe(false)
  })
})

/**
 * Two actions owning one key.
 *
 * `restoreAction` chooses a shared key over an unbound action, on purpose, so the
 * state is reachable and `checkBindings` reports it. What was not honest was
 * `ownerOf`: it answered with the first owner, and the mutating paths used that answer
 * to decide who loses the key — so an assignment stripped one owner, left the other
 * holding the code, and reported a clean reassignment for a key that now fired two
 * controls. The conflict rule this file opens with ("last claim wins, and the loser
 * loses only that one key") was not being applied to the second loser at all.
 *
 * MUTATION-VERIFIED, by restoring `const owner = ownerOf(...)` and the single-owner
 * branches in `assignBinding`/`replaceBinding`:
 *   - "reports every owner of a shared key" fails (ownersOf missing).
 *   - "takes a shared key from ALL of its owners" fails: KeyW stays on `focus`.
 *   - "refuses when the SECOND owner is the one that would be emptied" fails: the
 *     assignment is accepted and leaves a duplicate.
 */
describe('a key owned by two actions', () => {
  /**
   * `up` and `focus` both holding KeyW, built only from public operations.
   *
   * Exactly what a player does: move KeyW to focus, then restore up's defaults.
   */
  function shared(): Bindings {
    const moved = replaceBinding(DEFAULT_BINDINGS, 'focus', 'KeyW')
    expect(moved.ok).toBe(true)
    expect(moved.bindings.focus).toEqual(['KeyW'])
    const restored = restoreAction(moved.bindings, 'up')
    // The premise. If this ever stops holding, the tests below stop meaning anything.
    expect(restored.up).toContain('KeyW')
    expect(restored.focus).toContain('KeyW')
    expect(checkBindings(restored).duplicated).toEqual(['KeyW'])
    return restored
  }

  it('reports every owner of a shared key', () => {
    const bindings = shared()
    expect(ownersOf(bindings, 'KeyW')).toEqual(['up', 'focus'])
    // `ownerOf` keeps its one-action answer for copy, and it is the first in
    // canonical order rather than an arbitrary one.
    expect(ownerOf(bindings, 'KeyW')).toBe('up')
    expect(ownersOf(bindings, 'KeyQ')).toEqual([])
  })

  it('takes a shared key from ALL of its owners', () => {
    // Both owners have a spare, so the claim is allowed and must clear the duplicate.
    const bindings = assignBinding(shared(), 'focus', 'KeyQ').bindings
    expect(bindings.focus).toEqual(['KeyW', 'KeyQ'])

    const result = assignBinding(bindings, 'fire', 'KeyW')
    expect(result.ok).toBe(true)
    expect(result.bindings.fire).toContain('KeyW')
    expect(result.bindings.up).not.toContain('KeyW')
    expect(result.bindings.focus).not.toContain('KeyW')
    expect(checkBindings(result.bindings).duplicated).toEqual([])
    expect(checkBindings(result.bindings).unbound).toEqual([])
    // The notice names one action, and it is a real loser rather than a guess.
    expect(result.evictedFrom).toBe('up')
  })

  it('refuses when the SECOND owner is the one that would be emptied', () => {
    // `up` has a spare, `focus` does not. Looking at the first owner only, this reads
    // as a legal reassignment; it is the exception the conflict rule exists for.
    const result = assignBinding(shared(), 'fire', 'KeyW')
    expect(result.ok).toBe(false)
    expect(result.rejection).toBe('would-unbind')
    expect(result.bindings.focus).toEqual(['KeyW'])
    expect(result.bindings.up).toContain('KeyW')
  })

  it('replaces from all owners too, and refuses on the same exception', () => {
    const refused = replaceBinding(shared(), 'fire', 'KeyW')
    expect(refused.ok).toBe(false)
    expect(refused.rejection).toBe('would-unbind')

    const loose = assignBinding(shared(), 'focus', 'KeyQ').bindings
    const done = replaceBinding(loose, 'fire', 'KeyW')
    expect(done.ok).toBe(true)
    expect(done.bindings.fire).toEqual(['KeyW'])
    expect(done.bindings.up).not.toContain('KeyW')
    expect(done.bindings.focus).not.toContain('KeyW')
    expect(checkBindings(done.bindings).duplicated).toEqual([])
  })

  it('never lets one action hold the same code twice', () => {
    // The healing path can reach an action that already owns the code, which is the
    // one way `assignBinding` could have appended a duplicate inside a single row.
    const bindings = assignBinding(shared(), 'focus', 'KeyQ').bindings
    const result = assignBinding(bindings, 'up', 'KeyW')
    expect(result.ok).toBe(true)
    expect(result.bindings.up.filter((c) => c === 'KeyW').length).toBe(1)
    expect(result.bindings.focus).not.toContain('KeyW')
  })
})

describe('helpers', () => {
  it('finds which action owns a code', () => {
    expect(ownerOf(DEFAULT_BINDINGS, 'KeyW')).toBe('up')
    expect(ownerOf(DEFAULT_BINDINGS, 'KeyQ')).toBeNull()
    // One owner is the normal case, and `ownersOf` agrees with `ownerOf` there.
    for (const action of SORTIE_ACTIONS) {
      for (const code of DEFAULT_BINDINGS[action]) {
        expect(ownersOf(DEFAULT_BINDINGS, code), code).toEqual([action])
      }
    }
  })

  it('recognises exactly the remappable actions', () => {
    for (const action of SORTIE_ACTIONS) expect(isSortieAction(action)).toBe(true)
    for (const action of ['confirm', 'cancel', 'pause', 'nonsense']) {
      expect(isSortieAction(action), action).toBe(false)
    }
  })
})
