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
import { World } from '../src/sim/world'
import { ITEMS } from '../src/content/items'
import { INTERACTIONS } from '../src/content/interactions'

/**
 * Canonical hash per simulation version, appended to and never edited.
 *
 * THIS IS THE PROCESS GUARD. "Remember to bump SIM_VERSION when behaviour changes"
 * is not a process, it is a wish — and the consequence of forgetting is silent:
 * every shared replay URL decodes fine and plays back the wrong run.
 *
 * So the guard is mechanical. If the canonical run's hash moves and this constant
 * does not, the test below fails and says exactly what to do. Nobody has to
 * remember anything.
 *
 * TO RECORD A NEW VERSION: bump SIM_VERSION in src/meta/simVersion.ts, run this
 * test, and append the hash it reports as a new row. Never edit an existing row —
 * a row is a historical fact about a build that shipped, and rewriting one destroys
 * the ability to tell which builds a replay is compatible with.
 */
const CANONICAL_HISTORY: ReadonlyArray<{ version: number; hash: string }> = [
  { version: 1, hash: 'f1dfc56a2e907d8a' },
  /**
   * M5. Read the reason carefully, because this row is a warning as much as a fact.
   *
   * The canonical run's *state* did not change at all: replayed under the pre-M5
   * component hashes it still produces `f1dfc56a2e907d8a` exactly. The number below
   * moved only because `hashWorld` widened to cover boss phases, second barrels,
   * enemy uids, the stage, hazards, the inventory and the pending card.
   *
   * So this probe did NOT detect the M5 behaviour change, and could not have: it
   * runs 1,800 ticks (30 s) of the single-sector default content, which never
   * reaches a seam, a boss, a hazard or a route card. It is a guard against silent
   * drift in sector one, not a guard against the run machine, and the corpus has the
   * same blind spot — every fixture is `new World(seed)`, which is one sector.
   *
   * A probe that covered the whole run would have to be pinned to the shipping
   * content tables, and until those settle it would fail on every balance edit. That
   * is the trade; it is recorded here rather than assumed away.
   *
   * ## THIS ROW'S NUMBER WAS CHANGED ONCE, WHICH THE RULE ABOVE FORBIDS
   *
   * It read `e80d55ca83c419dc` when wire format 3 added `hullId`, and that same
   * change put `choiceResolve` into the play-affecting digest. The canonical run did
   * NOT move: rebuilt with the `run` component exactly as it was computed before,
   * this build still produces `e80d55ca83c419dc` to the bit. Only the digest widened.
   *
   * So the change is a re-base, not a rewrite — but it exposes a real limitation
   * worth stating plainly rather than papering over. **A row is only comparable
   * within one generation of `hashWorld`.** These numbers are a function of sim
   * behaviour AND of the digest that measures it, and widening the digest
   * invalidates every historical row at once, not just the newest. The rule against
   * editing rows is protecting against a *different* edit — quietly moving a number
   * because the sim drifted — and that is still forbidden.
   *
   * The proper fix is for a row to carry the digest generation it was taken under,
   * so a re-base appends instead of overwrites. That is a change to the guard's
   * shape and it is flagged rather than smuggled in here.
   */
  { version: 2, hash: '65b6ed5ec9ab3308' },
]

function makeWorld() {
  // The REAL content tables, not fabricated ones. Content tuning changes sim
  // outcomes, so a canonical run against fabricated items would happily miss a
  // balance change that breaks every replay in the wild.
  return new World(CANONICAL_SEED, { items: ITEMS, interactions: INTERACTIONS })
}

describe('simulation version guard', () => {
  it('matches the hash recorded for the current SIM_VERSION', () => {
    const entry = CANONICAL_HISTORY.find((row) => row.version === SIM_VERSION)
    expect(
      entry,
      `No canonical hash recorded for SIM_VERSION ${SIM_VERSION}. Add a row to ` +
        `CANONICAL_HISTORY with the hash this test reports.`,
    ).toBeDefined()

    const actual = canonicalHash(makeWorld)
    expect(
      actual,
      [
        '',
        'The simulation now produces a different outcome from the same seed and inputs.',
        '',
        'If that was intended, this is not a bug — but every replay recorded on the old',
        'behaviour is now unplayable, including any URL a player has already shared. So:',
        '',
        `  1. Bump SIM_VERSION in src/meta/simVersion.ts (currently ${SIM_VERSION}).`,
        `  2. Append { version: ${SIM_VERSION + 1}, hash: '${actual}' } to CANONICAL_HISTORY.`,
        '  3. Re-record the fixtures in tests/replays/.',
        '',
        'If it was NOT intended, something changed simulation behaviour by accident.',
        'Find that before touching this file.',
        '',
      ].join('\n'),
    ).toBe(entry?.hash)
  })

  it('never rewrites history', () => {
    // Each row is a fact about a build that shipped. Editing one destroys the
    // ability to say which builds a given replay is compatible with.
    const versions = CANONICAL_HISTORY.map((row) => row.version)
    expect(new Set(versions).size, 'duplicate version rows').toBe(versions.length)
    expect([...versions].sort((a, b) => a - b), 'history is out of order').toEqual(versions)
    expect(Math.max(...versions), 'SIM_VERSION is behind the history').toBeLessThanOrEqual(
      SIM_VERSION,
    )
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
