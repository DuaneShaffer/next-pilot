/**
 * Purist mode.
 *
 * The whole feature is one claim: **a run's purist status is derived from evidence,
 * never asserted by the run.** Every test here is an attempt to break that claim
 * from a different direction — by setting a flag, by shuffling a pool, by editing a
 * stored record, by round-tripping through JSON, by arriving from a build whose
 * rules differ.
 *
 * The thing these tests protect is not code, it is the meaning of a daily-contract
 * score. If a non-purist run can be labelled purist, the label is decoration and
 * the comparison it exists to enable is worthless.
 */

import { describe, expect, it } from 'vitest'
import {
  EMPTY_POOL,
  POOL_CATEGORIES,
  canonicalPoolText,
  describePuristVerdict,
  fingerprintPool,
  isPoolFingerprint,
  isPurist,
  makePool,
  puristBadge,
  verifyPurist,
  type PuristSubject,
  type RunPool,
} from '../src/meta/purist'
import { SIM_VERSION } from '../src/meta/simVersion'

/** The base pool an unmodified build would offer. Small on purpose. */
const BASE_POOL: RunPool = makePool({
  hulls: ['lien'],
  items: ['machined-slugs', 'thrust-trim', 'plating-shim'],
  enemies: ['skiff', 'turret'],
  workOrders: ['supply-run'],
})

/** The same build with a certification unlocked: one more hull, one more item. */
const CERTIFIED_POOL: RunPool = makePool({
  hulls: ['lien', 'arrears'],
  items: ['machined-slugs', 'thrust-trim', 'plating-shim', 'coin-op-cannon'],
  enemies: ['skiff', 'turret'],
  workOrders: ['supply-run'],
})

function subject(overrides: Partial<PuristSubject> = {}): PuristSubject {
  return {
    poolFingerprint: fingerprintPool(BASE_POOL),
    simVersion: SIM_VERSION,
    stateDigest: '0123456789abcdef',
    ...overrides,
  }
}

describe('the pool fingerprint', () => {
  it('is 16 lowercase hex characters', () => {
    const fingerprint = fingerprintPool(BASE_POOL)
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/)
    expect(isPoolFingerprint(fingerprint)).toBe(true)
  })

  it('does not depend on declaration order or duplicates', () => {
    // A pool is a SET. If the order the content tables happen to be declared in
    // could change a fingerprint, then reordering `ITEMS` would silently strip the
    // purist badge off every stored record — a cosmetic edit invalidating history.
    const shuffled = makePool({
      workOrders: ['supply-run'],
      enemies: ['turret', 'skiff', 'turret'],
      items: ['plating-shim', 'machined-slugs', 'thrust-trim', 'machined-slugs'],
      hulls: ['lien'],
    })
    expect(fingerprintPool(shuffled)).toBe(fingerprintPool(BASE_POOL))
  })

  it('changes when a single id is added', () => {
    expect(fingerprintPool(CERTIFIED_POOL)).not.toBe(fingerprintPool(BASE_POOL))
  })

  it('distinguishes the same id in different categories', () => {
    // Without the category prefix an enemy named `turret` and an item named
    // `turret` would be the same pool member, and a certification that added one
    // could hide behind the other.
    const asItem = makePool({ items: ['turret'] })
    const asEnemy = makePool({ enemies: ['turret'] })
    expect(fingerprintPool(asItem)).not.toBe(fingerprintPool(asEnemy))
  })

  it('ignores empty and blank ids rather than hashing them', () => {
    const withBlanks = makePool({
      ...BASE_POOL,
      items: [...BASE_POOL.items, ''],
    })
    expect(fingerprintPool(withBlanks)).toBe(fingerprintPool(BASE_POOL))
  })

  it('carries a format tag, so a future canonicalisation cannot collide', () => {
    expect(canonicalPoolText(EMPTY_POOL).split('\n')[0]).toMatch(/^NPPOOL/)
  })

  it('names every id it hashed, so a mismatch is debuggable', () => {
    // Two hex strings say nothing about WHICH item was extra. The canonical text is
    // the only thing that turns a mismatch into an answer.
    const text = canonicalPoolText(CERTIFIED_POOL)
    expect(text).toContain('items:coin-op-cannon')
    expect(text).toContain('hulls:arrears')
    for (const category of POOL_CATEGORIES) {
      for (const id of CERTIFIED_POOL[category]) {
        expect(text).toContain(`${category}:${id}`)
      }
    }
  })
})

describe('purist status is derived, not asserted', () => {
  it('passes a run that drew from the base pool', () => {
    const verdict = verifyPurist(subject(), BASE_POOL)
    expect(verdict.kind).toBe('purist')
    expect(isPurist(subject(), BASE_POOL)).toBe(true)
  })

  it('cannot be granted by a flag on the record', () => {
    // The forgery a boolean toggle would have allowed: claim purist while the
    // fingerprint shows a certified pool. There is no field to read, so the lie has
    // nowhere to live — the extra properties below are ignored entirely.
    const forged = {
      ...subject({ poolFingerprint: fingerprintPool(CERTIFIED_POOL) }),
      purist: true,
      isPurist: true,
      verified: true,
    } as unknown as PuristSubject
    const verdict = verifyPurist(forged, BASE_POOL)
    expect(verdict.kind).toBe('expanded')
    expect(isPurist(forged, BASE_POOL)).toBe(false)
  })

  it('refuses a run flown on a certified pool', () => {
    const verdict = verifyPurist(
      subject({ poolFingerprint: fingerprintPool(CERTIFIED_POOL) }),
      BASE_POOL,
    )
    expect(verdict.kind).toBe('expanded')
    if (verdict.kind !== 'expanded') throw new Error('unreachable')
    // Both fingerprints are reported, so a player can see it was compared and not
    // merely rejected.
    expect(verdict.expected).toBe(fingerprintPool(BASE_POOL))
    expect(verdict.found).toBe(fingerprintPool(CERTIFIED_POOL))
  })

  it('takes its reference pool from the verifier, never from the record', () => {
    // A cheat who edits their own content tables so their expanded pool IS their
    // base pool is self-consistently "purist" on their own machine. The check is
    // against the pool the *asking* build knows about, so the forgery fails at the
    // moment the run is compared with someone else's — the only moment that counts.
    const cheatsRun = subject({ poolFingerprint: fingerprintPool(CERTIFIED_POOL) })
    expect(verifyPurist(cheatsRun, CERTIFIED_POOL).kind).toBe('purist')
    expect(verifyPurist(cheatsRun, BASE_POOL).kind).toBe('expanded')
  })

  it('is stable across a save/load round trip', () => {
    // Records go through JSON into localStorage. A verdict that changed on reload
    // would mean the badge depended on object identity or field order.
    const before = subject()
    const after = JSON.parse(JSON.stringify(before)) as PuristSubject
    expect(after).toEqual(before)
    expect(verifyPurist(after, BASE_POOL)).toEqual(verifyPurist(before, BASE_POOL))
    expect(isPurist(after, BASE_POOL)).toBe(true)

    // And the same for a run that must NOT be purist: the round trip must not
    // launder it.
    const expanded = subject({ poolFingerprint: fingerprintPool(CERTIFIED_POOL) })
    const reloaded = JSON.parse(JSON.stringify(expanded)) as PuristSubject
    expect(verifyPurist(reloaded, BASE_POOL).kind).toBe('expanded')
  })
})

describe('what cannot be compared is reported as such, not as cheating', () => {
  it('declines to judge a run from a different sim version', () => {
    // This build does not know what an older build's base pool contained, so a
    // mismatch is ambiguous between "they had certifications" and "the base pool
    // gained an item since". Calling that cheating would be a false accusation.
    const verdict = verifyPurist(subject({ simVersion: SIM_VERSION + 1 }), BASE_POOL)
    expect(verdict.kind).toBe('unverifiable')
    if (verdict.kind !== 'unverifiable') throw new Error('unreachable')
    expect(verdict.reason).toBe('sim-version')
    expect(verdict.recordedSimVersion).toBe(SIM_VERSION + 1)
    expect(verdict.currentSimVersion).toBe(SIM_VERSION)
  })

  it('declines a run with no fingerprint, even when the pool would have matched', () => {
    for (const missing of ['', 'not-a-fingerprint', 'ABCDEF0123456789']) {
      const verdict = verifyPurist(subject({ poolFingerprint: missing }), BASE_POOL)
      expect(verdict.kind, `fingerprint ${JSON.stringify(missing)}`).toBe('unverifiable')
    }
  })

  it('says nothing on a row it cannot judge', () => {
    // A list that shouts UNVERIFIED at every pre-update run reads as an error state
    // rather than as history.
    const verdict = verifyPurist(subject({ simVersion: SIM_VERSION + 1 }), BASE_POOL)
    expect(puristBadge(verdict)).toBeNull()
    expect(describePuristVerdict(verdict)).toContain('cannot be compared')
  })
})

describe('tier 2: agreement with a replay', () => {
  it('reports a reproduced run differently from an unchecked one', () => {
    const record = subject({ stateDigest: 'aaaaaaaabbbbbbbb' })
    const unchecked = verifyPurist(record, BASE_POOL)
    expect(unchecked).toEqual({ kind: 'purist', reproduced: false })

    const reproduced = verifyPurist(record, BASE_POOL, { observedDigest: 'aaaaaaaabbbbbbbb' })
    expect(reproduced).toEqual({ kind: 'purist', reproduced: true })
    // The distinction has to survive into what the player is shown, or the weaker
    // claim gets presented as the stronger one.
    expect(puristBadge(unchecked)).not.toBe(puristBadge(reproduced))
  })

  it('refutes a run whose recorded state a base-pool replay does not reproduce', () => {
    const record = subject({ stateDigest: 'aaaaaaaabbbbbbbb' })
    const verdict = verifyPurist(record, BASE_POOL, { observedDigest: 'ccccccccdddddddd' })
    expect(verdict.kind).toBe('refuted')
    if (verdict.kind !== 'refuted') throw new Error('unreachable')
    expect(verdict.claimed).toBe('aaaaaaaabbbbbbbb')
    expect(verdict.observed).toBe('ccccccccdddddddd')
  })

  it('does not blame the replay when the pool already disagreed', () => {
    // A divergent replay on a run that drew from a different pool is EXPLAINED by
    // the pool. Reporting `refuted` there would point the player at the wrong thing.
    const verdict = verifyPurist(
      subject({ poolFingerprint: fingerprintPool(CERTIFIED_POOL) }),
      BASE_POOL,
      { observedDigest: 'ccccccccdddddddd' },
    )
    expect(verdict.kind).toBe('expanded')
  })

  it('does not upgrade a missing digest to a reproduction', () => {
    const verdict = verifyPurist(subject({ stateDigest: null }), BASE_POOL, {
      observedDigest: 'aaaaaaaabbbbbbbb',
    })
    expect(verdict).toEqual({ kind: 'purist', reproduced: false })
  })
})

describe('what the player is told', () => {
  it('has a sentence for every verdict, and none of them is a joke', () => {
    const verdicts = [
      verifyPurist(subject(), BASE_POOL),
      verifyPurist(subject(), BASE_POOL, { observedDigest: '0123456789abcdef' }),
      verifyPurist(subject({ poolFingerprint: fingerprintPool(CERTIFIED_POOL) }), BASE_POOL),
      verifyPurist(subject(), BASE_POOL, { observedDigest: 'ffffffffffffffff' }),
      verifyPurist(subject({ simVersion: SIM_VERSION + 1 }), BASE_POOL),
      verifyPurist(subject({ poolFingerprint: '' }), BASE_POOL),
    ]
    for (const verdict of verdicts) {
      const sentence = describePuristVerdict(verdict)
      // Functional text: a player reading this is asking whether their score counts.
      expect(sentence.length).toBeGreaterThan(20)
      expect(sentence.endsWith('.')).toBe(true)
    }
  })

  it('never claims comparability for a verdict that is not a pass', () => {
    const expanded = verifyPurist(
      subject({ poolFingerprint: fingerprintPool(CERTIFIED_POOL) }),
      BASE_POOL,
    )
    expect(describePuristVerdict(expanded)).toContain('not comparable')
    expect(puristBadge(expanded)).not.toContain('PURIST')
  })
})

describe('the empty pool', () => {
  it('is a valid pool and is not the same as any populated one', () => {
    // An empty pool is what a caller gets if it forgets to pass one. It must
    // fingerprint to something stable and distinct, so "no pool" reads as
    // `expanded` rather than accidentally matching a base pool.
    expect(isPoolFingerprint(fingerprintPool(EMPTY_POOL))).toBe(true)
    expect(fingerprintPool(EMPTY_POOL)).not.toBe(fingerprintPool(BASE_POOL))
    expect(verifyPurist(subject(), EMPTY_POOL).kind).toBe('expanded')
  })

  it('is not mutated by makePool', () => {
    makePool({ items: ['injected'] })
    expect(EMPTY_POOL.items).toEqual([])
  })
})
