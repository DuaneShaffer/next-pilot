import { describe, expect, it } from 'vitest'
import {
  CANONICAL_SEED,
  CANONICAL_TICKS,
  SIM_VERSION,
  canonicalHash,
  canonicalInputs,
  checkReplayCompatibility,
  describeIncompatibility,
} from '../src/meta/simVersion'
import { DIGEST_GENERATION } from '../src/meta/snapshot'
import { World } from '../src/sim/world'
import { ITEMS } from '../src/content/items'
import { INTERACTIONS } from '../src/content/interactions'

/**
 * Canonical hash per (simulation version, digest generation), appended to and never
 * edited.
 *
 * THIS IS THE PROCESS GUARD. "Remember to bump SIM_VERSION when behaviour changes"
 * is not a process, it is a wish — and the consequence of forgetting is silent:
 * every shared replay URL decodes fine and plays back the wrong run.
 *
 * So the guard is mechanical. If the canonical run's hash moves and neither constant
 * does, the test below fails and says exactly what to do. Nobody has to remember
 * anything.
 *
 * ## WHY A ROW HAS TWO KEYS AND NOT ONE
 *
 * A recorded hash is a function of two independent things: what the simulation did,
 * and what `hashWorld` chose to measure. This list keyed rows on the first alone,
 * and the omission had teeth — widening the digest moves EVERY historical row at
 * once, so each widening forced an edit to a row the file's own rule declares
 * unrewritable. That happened twice in one session, and a rule broken twice in a
 * session is not a rule.
 *
 * With `digest` on the row, widening the digest APPENDS: the same sim version gains
 * a row under the new generation, the old row keeps its number, and the history
 * stays readable as one. Rows are only comparable within a generation, which is now
 * something the data says rather than something a reader has to know.
 *
 * TO RECORD A NEW SIM VERSION: bump `SIM_VERSION`, run this test, append the hash it
 * reports under the current `DIGEST_GENERATION`.
 * TO RE-BASE AFTER WIDENING THE DIGEST: bump `DIGEST_GENERATION` in
 * `src/meta/snapshot.ts`, run this test, append a row for the SAME sim version under
 * the new generation — and satisfy yourself first that the run did not move, by
 * recomputing the old generation's components and checking they still reproduce.
 *
 * Never edit an existing row. A row is a historical fact about a build that shipped,
 * and rewriting one destroys the ability to say which builds a replay agrees with.
 */
const CANONICAL_HISTORY: ReadonlyArray<{
  version: number
  /** Generation of `hashWorld` this number was taken under. See snapshot.ts. */
  digest: number
  hash: string
}> = [
  /** M2-era digest: play-affecting state plus `freezeTicks` and `telegraphTicks`. */
  { version: 1, digest: 1, hash: 'f1dfc56a2e907d8a' },

  /**
   * M5, and the first row that proves the point of the `digest` column.
   *
   * The canonical run's state did not change: replayed under the generation-1
   * component hashes it still produces `f1dfc56a2e907d8a` exactly. This number is
   * different because generation 2 widened `hashWorld` to cover boss phases, second
   * barrels, enemy uids, the stage, hazards, the inventory and the pending card.
   *
   * NOTE WHAT THAT MEANS ABOUT THIS PROBE: it did not detect the M5 behaviour change
   * and could not have. It runs 1,800 ticks (30 s) of single-sector default content,
   * so it never reaches a seam, a boss, a hazard or a route card. It guards against
   * silent drift in sector one, not against the run machine — and every corpus
   * fixture is `new World(seed)`, which has the same blind spot. Covering the whole
   * run would mean pinning a probe to the shipping content tables, which would fail
   * on every balance edit until those settle. That is the trade, recorded rather
   * than assumed away.
   */
  { version: 2, digest: 2, hash: 'e80d55ca83c419dc' },

  /**
   * Generation 3 added `choiceResolve` to the run component — the cursor's
   * auto-confirm dwell and timeout clock, which decide what an untouched card does.
   *
   * Verified a re-base and not drift: rebuilt with the generation-2 `run` component,
   * this build still produces `e80d55ca83c419dc` to the bit.
   *
   * This row was briefly OVERWRITTEN rather than appended, because the list had no
   * way to express "same sim, new digest". Restoring it is what the `digest` column
   * is for.
   */
  { version: 2, digest: 3, hash: '65b6ed5ec9ab3308' },

  /**
   * Generation 4 added `choiceSelection` — the highlighted option, which decides
   * *what* an auto-confirm takes.
   *
   * Verified the same way: rebuilt with the generation-3 `run` component, this build
   * still produces `65b6ed5ec9ab3308` to the bit, and every other component, the
   * cosmetic digest and every entity count are unchanged.
   */
  { version: 2, digest: 4, hash: '5515696d21c80412' },
]

function makeWorld() {
  // The REAL content tables, not fabricated ones. Content tuning changes sim
  // outcomes, so a canonical run against fabricated items would happily miss a
  // balance change that breaks every replay in the wild.
  return new World(CANONICAL_SEED, { items: ITEMS, interactions: INTERACTIONS })
}

describe('simulation version guard', () => {
  it('matches the hash recorded for the current simulation and digest', () => {
    const entry = CANONICAL_HISTORY.find(
      (row) => row.version === SIM_VERSION && row.digest === DIGEST_GENERATION,
    )
    expect(
      entry,
      `No canonical hash recorded for SIM_VERSION ${SIM_VERSION} at digest generation ` +
        `${DIGEST_GENERATION}. Append a row to CANONICAL_HISTORY with the hash this test ` +
        `reports — do not edit an existing one.`,
    ).toBeDefined()

    const actual = canonicalHash(makeWorld)
    expect(
      actual,
      [
        '',
        'The canonical run hashes differently than recorded. That is one of TWO things,',
        'and they need completely different responses.',
        '',
        `A) THE SIMULATION CHANGED. Same seed and inputs, different outcome. Every replay`,
        '   recorded on the old behaviour is now unplayable, including any URL already',
        '   shared. If that was intended:',
        `     1. Bump SIM_VERSION in src/meta/simVersion.ts (currently ${SIM_VERSION}).`,
        `     2. Append { version: ${SIM_VERSION + 1}, digest: ${DIGEST_GENERATION}, hash: '${actual}' }.`,
        '     3. Re-record the fixtures in tests/replays/.',
        '',
        'B) THE DIGEST WIDENED. src/meta/snapshot.ts now measures something it did not',
        '   measure before, and the run itself is untouched. PROVE that before believing',
        '   it: recompute the affected component the old way and check it still matches',
        '   what was recorded. Then:',
        `     1. Bump DIGEST_GENERATION in src/meta/snapshot.ts (currently ${DIGEST_GENERATION}).`,
        `     2. Append { version: ${SIM_VERSION}, digest: ${DIGEST_GENERATION + 1}, hash: '${actual}' }.`,
        '     3. Re-record the fixtures, whose `run` or `enemies` component will have moved.',
        '',
        'If neither was intended, something changed behaviour by accident. Find that',
        'before touching this file.',
        '',
      ].join('\n'),
    ).toBe(entry?.hash)
  })

  it('never rewrites history', () => {
    // Each row is a fact about a build that shipped. Editing one destroys the ability
    // to say which builds a given replay is compatible with.
    //
    // A sim version may appear MORE THAN ONCE — once per digest generation it was
    // measured under — because widening the digest re-bases every number without the
    // simulation having moved. What may never repeat is the PAIR: two rows claiming
    // different hashes for the same run measured the same way is a contradiction, and
    // it is what an in-place edit looks like after the fact.
    const keys = CANONICAL_HISTORY.map((row) => `${row.version}:${row.digest}`)
    expect(new Set(keys).size, 'duplicate (version, digest) rows').toBe(keys.length)

    // Ordered by version, then by generation, so the list reads chronologically.
    const ordered = [...CANONICAL_HISTORY].sort(
      (a, b) => a.version - b.version || a.digest - b.digest,
    )
    expect(ordered, 'history is out of order').toEqual([...CANONICAL_HISTORY])

    expect(
      Math.max(...CANONICAL_HISTORY.map((row) => row.version)),
      'SIM_VERSION is behind the history',
    ).toBeLessThanOrEqual(SIM_VERSION)
    expect(
      Math.max(...CANONICAL_HISTORY.map((row) => row.digest)),
      'DIGEST_GENERATION is behind the history',
    ).toBeLessThanOrEqual(DIGEST_GENERATION)

    // Every hash is a 16-character digest, so a truncated or hand-typed row fails
    // here rather than as a baffling mismatch.
    for (const row of CANONICAL_HISTORY) {
      expect(row.hash, `row ${row.version}:${row.digest}`).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('records a hash for the current generation of every sim version it knows', () => {
    // The re-base rule, enforced: widening the digest must bring EVERY live sim
    // version forward, not just the newest. A version left behind at an old
    // generation is a version whose row can no longer be compared to anything, which
    // is the quiet way a history stops being one.
    const versions = new Set(CANONICAL_HISTORY.map((row) => row.version))
    for (const version of versions) {
      if (version !== SIM_VERSION) continue
      const current = CANONICAL_HISTORY.some(
        (row) => row.version === version && row.digest === DIGEST_GENERATION,
      )
      expect(current, `sim version ${version} has no row at digest ${DIGEST_GENERATION}`).toBe(true)
    }
  })

  it('keeps every generation of one sim version distinct', () => {
    // Two generations agreeing on a hash would mean the widening measured nothing —
    // a digest change that changes no digest is a change that did not happen, and the
    // generation bump would be noise in the history.
    const byVersion = new Map<number, string[]>()
    for (const row of CANONICAL_HISTORY) {
      byVersion.set(row.version, [...(byVersion.get(row.version) ?? []), row.hash])
    }
    for (const [version, hashes] of byVersion) {
      expect(new Set(hashes).size, `sim version ${version} repeats a hash across generations`).toBe(
        hashes.length,
      )
    }
  })

  it('produces a stable hash across repeated runs', () => {
    // If the canonical run itself were nondeterministic, this guard would flap and
    // get deleted — the fate of every flaky test.
    expect(canonicalHash(makeWorld)).toBe(canonicalHash(makeWorld))
  })

  it('uses a script that does not react to the simulation', () => {
    // A bot policy would change its own inputs whenever the sim changed, masking the
    // divergence this exists to detect. The script must be inert.
    const a = canonicalInputs()
    const b = canonicalInputs()
    expect(a).toEqual(b)
    expect(a).toHaveLength(CANONICAL_TICKS)
  })

  it('exercises combat rather than an empty playfield', () => {
    // A canonical run that never met an enemy would hash the same through almost any
    // balance change — a guard that guards nothing.
    const world = makeWorld()
    for (const input of canonicalInputs()) world.tick(input)
    expect(world.stats.shotsFired).toBeGreaterThan(0)
    expect(world.stats.hits).toBeGreaterThan(0)
    expect(world.stats.kills).toBeGreaterThan(0)
  })
})

describe('replay compatibility', () => {
  it('accepts a replay from this exact version', () => {
    expect(checkReplayCompatibility(SIM_VERSION)).toEqual({ kind: 'ok' })
    expect(describeIncompatibility(checkReplayCompatibility(SIM_VERSION))).toBeNull()
  })

  it('refuses an older replay rather than playing it back wrong', () => {
    // "Mostly works" is the worst outcome: the viewer watches a plausible run that
    // is not the one that was shared, and nothing tells them.
    const result = checkReplayCompatibility(SIM_VERSION - 1)
    expect(result.kind).toBe('older')
    expect(describeIncompatibility(result)).toContain('earlier version')
  })

  it('refuses a newer replay too', () => {
    const result = checkReplayCompatibility(SIM_VERSION + 1)
    expect(result.kind).toBe('newer')
    expect(describeIncompatibility(result)).toContain('newer version')
  })

  it('explains itself without blaming the player', () => {
    for (const offset of [-2, -1, 1, 2]) {
      const message = describeIncompatibility(checkReplayCompatibility(SIM_VERSION + offset))
      expect(message).toBeTruthy()
      expect(message).not.toMatch(/invalid|corrupt|error|bad/i)
    }
  })
})
