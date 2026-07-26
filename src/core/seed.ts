/**
 * Human-shareable run seeds.
 *
 * Seeds are typed by hand and read aloud, so the alphabet excludes characters
 * people confuse: I, L, O, U, 0, 1. Formatting is cosmetic — normalise() is the
 * single source of truth for what a seed string actually means, so "k7f2-9xqm"
 * and "K7F29XQM" are the same run.
 */

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ'
const GROUP_SIZE = 4
const GROUP_COUNT = 3

export const SEED_LENGTH = GROUP_SIZE * GROUP_COUNT

/**
 * Strip formatting and case so a seed round-trips through copy/paste and voice.
 *
 * ## WARNING: this is a repair function, not a parser
 *
 * The folding is deliberately aggressive because a seed gets read aloud, retyped off
 * a screenshot, and OCR'd — `O` really does mean `Q` in those contexts. The cost is
 * that it will happily manufacture a seed out of anything:
 *
 *   normalizeSeed('not a seed at all')  ->  'NQTASEEDATAJ'   // a VALID seed
 *   normalizeSeed('https://example...') ->  12 chars of hostname
 *
 * Both are valid-looking seeds for entirely the wrong run, and both were reachable
 * from a paste box before this was documented. So:
 *
 *   - Use `looksLikeSeed` BEFORE normalising anything a user or a URL supplied.
 *   - Never normalise a whole pasted string that might be a link; parse the link
 *     first and normalise only the seed parameter.
 *
 * Repairing what is plainly a seed is helpful. Repairing arbitrary prose into a seed
 * is a silent wrong answer.
 */
export function normalizeSeed(input: string): string {
  const cleaned = input
    .toUpperCase()
    // Fold the ambiguous characters onto what the user almost certainly meant.
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V')
    .replace(/[^0-9A-Z]/g, '')
    // 0 and 1 aren't in the alphabet; map them to their visual neighbours.
    .replace(/0/g, 'Q')
    .replace(/1/g, 'J')
  return cleaned.slice(0, SEED_LENGTH)
}

/** Insert dashes for display: K7F2-9XQM-3RTV. */
export function formatSeed(seed: string): string {
  const normalized = normalizeSeed(seed)
  const groups: string[] = []
  for (let i = 0; i < normalized.length; i += GROUP_SIZE) {
    groups.push(normalized.slice(i, i + GROUP_SIZE))
  }
  return groups.join('-')
}

/**
 * Whether `input` is plausibly someone trying to give us a seed at all.
 *
 * Checked BEFORE normalising, which is the point: `normalizeSeed` repairs, and
 * repairing prose produces a confidently wrong run. This rejects the things a seed
 * never contains — whitespace, punctuation beyond grouping dashes, a URL scheme — and
 * requires roughly the right amount of usable material.
 *
 * Deliberately not the same as `isValidSeed`, which answers "is this a seed" about
 * an already-normalised string. This answers "was this meant to be one".
 */
export function looksLikeSeed(input: string): boolean {
  const trimmed = input.trim()
  if (trimmed.length === 0) return false
  // A link is a link. Parse it as one rather than mining characters out of it.
  if (/[:/?#=&]/.test(trimmed)) return false
  // Spaces mean prose. A seed is one token, optionally dash-grouped.
  if (/\s/.test(trimmed)) return false
  if (!/^[0-9A-Za-z-]+$/.test(trimmed)) return false

  const bare = trimmed.replace(/-/g, '')
  // Enough material to be a seed, and not so much that it is something else that
  // happens to be alphanumeric.
  return bare.length >= SEED_LENGTH - 2 && bare.length <= SEED_LENGTH + 2
}

export function isValidSeed(input: string): boolean {
  const normalized = normalizeSeed(input)
  if (normalized.length !== SEED_LENGTH) return false
  for (const ch of normalized) {
    if (!ALPHABET.includes(ch)) return false
  }
  return true
}

/**
 * Generate a fresh random seed.
 *
 * Uses crypto when available. This is the one place unseeded randomness is
 * correct — we are choosing which run to play, not simulating it. Simulation
 * code must never call this.
 */
export function generateSeed(): string {
  const bytes = new Uint8Array(SEED_LENGTH)
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  let out = ''
  for (let i = 0; i < SEED_LENGTH; i++) {
    out += ALPHABET[(bytes[i] as number) % ALPHABET.length]
  }
  return out
}

/**
 * The seed for a given calendar day's shared run.
 *
 * Derived from the UTC date so every player worldwide gets the same daily
 * contract, and so it can be computed offline with no server.
 */
export function dailySeed(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  // Hash the date rather than using it literally, so consecutive days don't
  // produce near-identical runs.
  let h = 2166136261
  const key = `next-pilot/daily/${y}-${m}-${d}`
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let out = ''
  let state = h >>> 0
  for (let i = 0; i < SEED_LENGTH; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    out += ALPHABET[state % ALPHABET.length]
  }
  return out
}
