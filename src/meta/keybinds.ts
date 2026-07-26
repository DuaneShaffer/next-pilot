/**
 * Key bindings: storage, the conflict rule, and human-readable key names.
 *
 * WHY THIS IS ITS OWN STORE, not a field in `src/meta/save.ts`. Three reasons, and
 * I would make the same call even with save.ts open in front of me:
 *
 *   1. **Different lifetime.** A save is a player's progress — pilots flown,
 *      certifications earned, the daily contract. Bindings are a property of the
 *      *keyboard in front of them*. Someone who exports a save, or one day syncs
 *      one, should not carry a machine's key layout with it.
 *   2. **Different blast radius.** `loadSave` falls back to `DEFAULT_SAVE` on any
 *      corruption. Folding bindings in means one bad binding blob costs a player
 *      their entire pilot history; keeping them apart means a corrupt keymap costs
 *      them a keymap.
 *   3. **Different failure mode.** Bindings are the one setting that can make the
 *      game unplayable, so they need to be resettable *independently* — "reset my
 *      keys" must not be adjacent to "reset my progress".
 *
 * The cost is honest and small: two localStorage keys instead of one, and a player
 * clearing site data loses both anyway.
 *
 * THE CONFLICT RULE: **last claim wins, and the loser loses only that one key.**
 * Assigning a code to an action removes it from whichever action held it. The single
 * exception is the whole point — if the eviction would leave that other action with
 * *no* keys at all, the assignment is REFUSED and reported. Silently disarming
 * `fire` to grant a second `focus` key is a worse outcome than saying no, and it is
 * a failure the player would discover in the middle of a permadeath run.
 */

import {
  DEFAULT_BINDINGS,
  SORTIE_ACTIONS,
  SYSTEM_CODES,
  isSortieAction,
  type Bindings,
  type SortieAction,
} from '../core/input'

const STORAGE_KEY = 'next-pilot/keybinds'
export const KEYBINDS_VERSION = 1

/**
 * Keys per action.
 *
 * Four is two conventions plus two idiosyncrasies. The cap exists so a stuck
 * capture, or hand-edited storage, cannot grow a list the binding row has no room
 * to render — an unrenderable binding is an unremovable one.
 */
export const MAX_CODES_PER_ACTION = 4

interface StoredKeybinds {
  version: number
  bindings: Record<string, unknown>
}

export type BindRejection =
  /** The code belongs to the browser or to the menu floor. */
  | 'reserved'
  /** Taking it would leave another action with nothing bound. */
  | 'would-unbind'
  /** Removing it would leave *this* action with nothing bound. */
  | 'last-key'

export interface BindResult {
  bindings: Bindings
  /** False means nothing changed and `rejection` says why. */
  ok: boolean
  rejection?: BindRejection
  /**
   * The action that lost this code, when one did. For the "reassigned" notice.
   *
   * The FIRST loser in canonical order. More than one is possible only from the
   * duplicate state `restoreAction` can create, and the assignment that produces this
   * result is also what clears it, so the notice names an action rather than a list —
   * one sentence a player can act on beats an exhaustive one they will not read.
   */
  evictedFrom?: SortieAction
  /** The code pushed out because the action was already at the cap. */
  evictedCode?: string
}

export function defaultBindings(): Bindings {
  return cloneBindings(DEFAULT_BINDINGS)
}

function cloneBindings(bindings: Bindings): Bindings {
  const out = {} as Record<SortieAction, readonly string[]>
  for (const action of SORTIE_ACTIONS) out[action] = [...bindings[action]]
  return out
}

/**
 * EVERY action that currently owns `code`, in canonical order.
 *
 * Usually zero or one, and `ownerOf` is the convenience for that case — but "one
 * owner" is not a property this module can promise. `restoreAction` deliberately
 * lets two actions share a key rather than leave one unbound (see its comment), and
 * `checkBindings` reports that state as `duplicated` precisely because it is
 * reachable. The single-owner version of this function was therefore a lie exactly
 * when the answer mattered: `assignBinding` used it to decide who loses the key, so
 * it stripped the code from the FIRST owner, left the second holding it, and
 * reported a clean reassignment for a key that now fired two actions.
 */
export function ownersOf(bindings: Bindings, code: string): readonly SortieAction[] {
  return SORTIE_ACTIONS.filter((action) => bindings[action].includes(code))
}

/**
 * The first action that owns `code`, or null.
 *
 * For copy that names one action. Anything that *changes* bindings must use
 * `ownersOf`, because acting on one of two owners is how a duplicate survives an
 * operation whose whole job was to resolve it.
 */
export function ownerOf(bindings: Bindings, code: string): SortieAction | null {
  return ownersOf(bindings, code)[0] ?? null
}

export function isReservedCode(code: string): boolean {
  return SYSTEM_CODES.has(code)
}

/**
 * Assign `code` to `action`.
 *
 * Pure: returns a new `Bindings` and never mutates the input, so the settings
 * screen can preview a change and the caller decides whether to persist it.
 */
export function assignBinding(bindings: Bindings, action: SortieAction, code: string): BindResult {
  if (!isSortieAction(action)) return { bindings, ok: false, rejection: 'reserved' }
  if (isReservedCode(code)) return { bindings, ok: false, rejection: 'reserved' }

  // Every other owner, because there can be more than one. See `ownersOf`.
  const losers = ownersOf(bindings, code).filter((owner) => owner !== action)

  // Already bound here and nowhere else: a no-op success, so tapping the key you
  // already use reads as "yes, that one" rather than as an error.
  if (losers.length === 0 && bindings[action].includes(code)) return { bindings, ok: true }

  // Refused if ANY loser would be emptied, not just the first one found. Checking one
  // of two owners is how the conflict rule's single exception gets skipped.
  if (losers.some((owner) => bindings[owner].length <= 1)) {
    return { bindings, ok: false, rejection: 'would-unbind' }
  }

  const next = cloneBindings(bindings) as Record<SortieAction, string[]>
  for (const owner of losers) next[owner] = next[owner].filter((c) => c !== code)

  const list = next[action].includes(code) ? [...next[action]] : [...next[action], code]
  // Oldest out rather than refusing at the cap: a player adding a fifth key has
  // clearly decided the first one is not the one they want, and a refusal here
  // would look like the screen had stopped responding.
  const evictedCode = list.length > MAX_CODES_PER_ACTION ? list[0] : undefined
  next[action] = list.slice(Math.max(0, list.length - MAX_CODES_PER_ACTION))

  const evictedFrom = losers[0]
  return {
    bindings: next,
    ok: true,
    ...(evictedFrom !== undefined ? { evictedFrom } : {}),
    ...(evictedCode !== undefined ? { evictedCode } : {}),
  }
}

/**
 * Make `code` the *only* key for `action`.
 *
 * The default gesture on the settings screen, because "press the key you want" is
 * the mental model every game has trained, and a screen where every rebind silently
 * appends grows a list of keys the player did not ask for. Adding a spare is a
 * separate, explicit gesture — see `assignBinding`.
 *
 * Same conflict rule, same refusal: taking another action's last key is rejected
 * rather than performed.
 */
export function replaceBinding(bindings: Bindings, action: SortieAction, code: string): BindResult {
  if (isReservedCode(code)) return { bindings, ok: false, rejection: 'reserved' }

  const losers = ownersOf(bindings, code).filter((owner) => owner !== action)
  if (losers.some((owner) => bindings[owner].length <= 1)) {
    return { bindings, ok: false, rejection: 'would-unbind' }
  }

  const next = cloneBindings(bindings) as Record<SortieAction, string[]>
  for (const owner of losers) next[owner] = next[owner].filter((c) => c !== code)
  next[action] = [code]

  const evictedFrom = losers[0]
  return {
    bindings: next,
    ok: true,
    ...(evictedFrom !== undefined ? { evictedFrom } : {}),
  }
}

/**
 * Remove `code` from `action`.
 *
 * Refuses to remove the last one. An action with nothing bound is not a
 * configuration, it is a broken game the player has to guess how to repair — and
 * the repair screen would look identical either way.
 */
export function clearBinding(bindings: Bindings, action: SortieAction, code: string): BindResult {
  if (!bindings[action].includes(code)) return { bindings, ok: true }
  if (bindings[action].length <= 1) return { bindings, ok: false, rejection: 'last-key' }
  const next = cloneBindings(bindings) as Record<SortieAction, string[]>
  next[action] = next[action].filter((c) => c !== code)
  return { bindings: next, ok: true }
}

/** Reset one action to what it shipped with. */
export function restoreAction(bindings: Bindings, action: SortieAction): Bindings {
  const next = cloneBindings(bindings) as Record<SortieAction, string[]>
  next[action] = [...DEFAULT_BINDINGS[action]]
  // Anything the default reclaims is removed elsewhere, but never to zero: an
  // action that would be emptied keeps its keys and simply shares them, because a
  // duplicate is recoverable and an unbound action is what this file exists to stop.
  //
  // This is the ONLY producer of a shared code, which is why `ownersOf` exists and
  // why `checkBindings` reports `duplicated`: the state is visible to the player, and
  // the next `assignBinding` or `replaceBinding` touching that code clears it.
  for (const other of SORTIE_ACTIONS) {
    if (other === action) continue
    const trimmed = next[other].filter((c) => !next[action].includes(c))
    if (trimmed.length > 0) next[other] = trimmed
  }
  return next
}

/**
 * Everything a `Bindings` must satisfy to be usable.
 *
 * Exported so the settings screen can show the state rather than only refusing
 * transitions into it — storage written by an older build, or by hand, can arrive
 * already broken.
 */
export interface BindingHealth {
  unbound: readonly SortieAction[]
  duplicated: readonly string[]
  reserved: readonly string[]
}

export function checkBindings(bindings: Bindings): BindingHealth {
  const unbound: SortieAction[] = []
  const reserved: string[] = []
  const seen = new Map<string, number>()
  for (const action of SORTIE_ACTIONS) {
    const codes = bindings[action]
    if (codes.length === 0) unbound.push(action)
    for (const code of codes) {
      if (isReservedCode(code)) reserved.push(code)
      seen.set(code, (seen.get(code) ?? 0) + 1)
    }
  }
  const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([code]) => code)
  return { unbound, duplicated, reserved }
}

/**
 * Bring anything at all into a usable `Bindings`.
 *
 * Never throws and never returns an unplayable result: an action with nothing left
 * after filtering falls back to its shipped keys, because the alternative is a
 * player who cannot move and has no way to find out why.
 */
export function coerceBindings(raw: unknown): Bindings {
  const out = {} as Record<SortieAction, string[]>
  const source =
    typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}

  const claimed = new Set<string>()
  for (const action of SORTIE_ACTIONS) {
    const value = source[action]
    const codes: string[] = []
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry !== 'string') continue
        if (entry.length === 0 || entry.length > 32) continue
        if (isReservedCode(entry)) continue
        if (claimed.has(entry) || codes.includes(entry)) continue
        codes.push(entry)
        if (codes.length >= MAX_CODES_PER_ACTION) break
      }
    }
    // Empty after filtering means the stored value was garbage, absent, or entirely
    // reserved codes. Defaults are the only safe answer.
    out[action] = codes.length > 0 ? codes : [...DEFAULT_BINDINGS[action]]
    for (const code of out[action]) claimed.add(code)
  }
  return out
}

export function loadBindings(storage: Storage | null = safeStorage()): Bindings {
  if (!storage) return defaultBindings()
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return defaultBindings()
    const parsed = JSON.parse(raw) as Partial<StoredKeybinds>
    // A payload from a newer build cannot be understood; guessing at it would be
    // guessing at controls. Shipped keys are always playable.
    if (typeof parsed?.version !== 'number' || parsed.version > KEYBINDS_VERSION) {
      return defaultBindings()
    }
    return coerceBindings(parsed.bindings)
  } catch {
    return defaultBindings()
  }
}

export function persistBindings(
  bindings: Bindings,
  storage: Storage | null = safeStorage(),
): void {
  if (!storage) return
  try {
    const payload: StoredKeybinds = {
      version: KEYBINDS_VERSION,
      bindings: Object.fromEntries(SORTIE_ACTIONS.map((a) => [a, [...bindings[a]]])),
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Quota or a locked store. The run still works; the keymap just will not
    // survive a reload, which is strictly better than refusing to rebind.
  }
}

/** Forget the stored keymap entirely. Used by "restore defaults". */
export function clearStoredBindings(storage: Storage | null = safeStorage()): void {
  if (!storage) return
  try {
    storage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing to do */
  }
}

/**
 * localStorage if it is actually usable. Same probe as `src/meta/save.ts`:
 * private browsing can throw on *access*, not only on write.
 */
function safeStorage(): Storage | null {
  try {
    const store = globalThis.localStorage
    const probe = '__np_keys_probe__'
    store.setItem(probe, '1')
    store.removeItem(probe)
    return store
  } catch {
    return null
  }
}

// --- naming ------------------------------------------------------------------

/**
 * Special-case names for codes whose mechanical name is not what is printed on the
 * key, or is unreadably long. Everything else is derived.
 *
 * The left/right distinction is kept ("L Shift", not "Shift") because it is real:
 * a player who bound the left one and presses the right one is owed an explanation,
 * and hiding the difference makes that look like a bug in the game.
 */
const CODE_NAMES: Readonly<Record<string, string>> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Space: 'Space',
  Enter: 'Enter',
  NumpadEnter: 'Num Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Tab: 'Tab',
  ShiftLeft: 'L Shift',
  ShiftRight: 'R Shift',
  ControlLeft: 'L Ctrl',
  ControlRight: 'R Ctrl',
  AltLeft: 'L Alt',
  AltRight: 'R Alt',
  CapsLock: 'Caps',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  PageUp: 'Pg Up',
  PageDown: 'Pg Dn',
  Home: 'Home',
  End: 'End',
  Insert: 'Ins',
  Delete: 'Del',
  NumpadAdd: 'Num +',
  NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *',
  NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .',
}

/**
 * A key's name as a person would say it.
 *
 * Deliberately never shows the raw `code`: "KeyZ" is an implementation detail and
 * putting it on screen makes the settings screen read like a debug panel. Unknown
 * codes fall back to something spelled out rather than to the code itself.
 */
export function describeCode(code: string): string {
  const known = CODE_NAMES[code]
  if (known) return known
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  // Split a camel-cased code into words: "AudioVolumeUp" -> "Audio Volume Up".
  const words = code.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  return words.length <= 12 ? words : `${words.slice(0, 11)}…`
}

/** The keys for one action, joined for a settings row. */
export function describeBinding(bindings: Bindings, action: SortieAction): string {
  const codes = bindings[action]
  if (codes.length === 0) return 'Unbound'
  return codes.map(describeCode).join(' / ')
}

/** Plain-language explanation of a refusal. Shown verbatim; no codes leak through. */
export function explainRejection(rejection: BindRejection, code: string): string {
  switch (rejection) {
    case 'reserved':
      return `${describeCode(code)} is reserved for menus and cannot be reassigned.`
    case 'would-unbind':
      return `${describeCode(code)} is the only key left on another control. Give that one a new key first.`
    case 'last-key':
      return 'Every control keeps at least one key. Add another before removing this one.'
  }
}
