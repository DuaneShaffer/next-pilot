/**
 * The shield's per-sector recovery reserve, as the panel shows it.
 *
 * The reserve is what bounds shield recovery and therefore what makes it balanceable
 * (see `shieldReservePerSector` in src/sim/stats.ts for the measurement table). It is
 * also the number the mechanic turns on: "is breaking contact worth it right now" is a
 * question about the reserve, and it shipped as pure simulation state that nothing
 * drew. This file is the guard on the fix.
 *
 * THE THING THIS SUITE ACTUALLY HAS TO PROVE is not that something is drawn. It is
 * that the three states a player must never confuse — recovering, suppressed, spent —
 * are distinguishable **without colour**. `caution` and `danger` cannot be separated
 * by protanopes or deuteranopes on this palette and no recolouring fixes it
 * (tests/palette.test.ts), so every assertion below that separates two states does it
 * on text or on geometry, and the colour-blind assertions strip `fillStyle` out of the
 * comparison entirely rather than trusting that a hue happened to differ.
 */

import { describe, expect, it } from 'vitest'
import { PANEL_W, PLAYFIELD_W, VIRTUAL_H, VIRTUAL_W } from '../src/core/space'
import { TICK_HZ } from '../src/core/loop'
import { STATS } from '../src/sim/stats'
import type { Hull, StageView, WorldView } from '../src/sim/entities'
import { drawPanel, shieldRecovery, STAT_MIN_GAP, type PanelState } from '../src/render/panel'
import { Palette } from '../src/render/palette'
import { PULSE_HZ } from '../src/render/intensity'

// ---------------------------------------------------------------------------
// a recording context, deliberately the same shape as tests/render.test.ts's
// ---------------------------------------------------------------------------

interface Recorded {
  readonly name: string
  readonly args: readonly unknown[]
  readonly fillStyle: string
  readonly globalAlpha: number
}

function makeStub(): { ctx: CanvasRenderingContext2D; calls: Recorded[] } {
  const calls: Recorded[] = []
  const state = {
    fillStyle: '#000000',
    strokeStyle: '#000000',
    globalAlpha: 1,
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
  }
  const target: Record<string, unknown> = {
    // 7 units per character: the stub metric the rest of the render suite lays out
    // against, so a width assertion here means the same thing as one there.
    measureText: (text: string) => ({ width: String(text).length * 7 }),
    createLinearGradient: () => ({ addColorStop: (): void => {} }),
    createRadialGradient: () => ({ addColorStop: (): void => {} }),
  }
  for (const name of [
    'fillRect',
    'strokeRect',
    'beginPath',
    'moveTo',
    'lineTo',
    'closePath',
    'fill',
    'stroke',
    'save',
    'restore',
    'arc',
    'rect',
    'clip',
    'translate',
    'fillText',
  ]) {
    target[name] = (...args: unknown[]): void => {
      calls.push({
        name,
        args,
        fillStyle: String(state.fillStyle),
        globalAlpha: state.globalAlpha,
      })
    }
  }
  for (const key of Object.keys(state) as (keyof typeof state)[]) {
    Object.defineProperty(target, key, {
      get: () => state[key],
      set: (value: never) => {
        state[key] = value
      },
    })
  }
  return { ctx: target as unknown as CanvasRenderingContext2D, calls }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const STAGE: StageView = {
  index: 1,
  count: 3,
  sectorId: 'tally',
  sectorName: 'The Tally',
  bossName: null,
}

interface ShieldSetup {
  shield?: number
  maxShield?: number
  reserve?: number
  blocked?: number
  tick?: number
  /** Resolved stats, so a curse that switches recovery off can be expressed. */
  stats?: Record<string, number>
}

function hullOf(setup: ShieldSetup): Hull {
  return {
    x: 224,
    y: 610,
    prevX: 223,
    prevY: 611,
    integrity: 70,
    maxIntegrity: 100,
    shield: setup.shield ?? 10,
    maxShield: setup.maxShield ?? 40,
    shieldRegenProgress: 0,
    shieldRegenBlockedTicks: setup.blocked ?? 0,
    shieldReserve: setup.reserve ?? 15,
    invulnTicks: 0,
    radius: 5,
  }
}

function view(setup: ShieldSetup = {}): WorldView {
  return {
    seed: 'TEST-SEED',
    runState: 'active',
    choiceResolve: null,
    choiceSelection: -1,
    hull: hullOf(setup),
    playerBullets: [],
    enemyBullets: [],
    enemies: [],
    explosions: [],
    stats: {
      tick: setup.tick ?? 600,
      shotsFired: 300,
      hits: 180,
      kills: 12,
      scrap: 55,
      damageTaken: 40,
      waveIndex: 6,
      peakProjectiles: 40,
      bulletsCulled: 20,
    },
    incident: null,
    events: [],
    cosmetic: { shake: 0 },
    inventory: [],
    activeInteractions: [],
    resolvedStats: {
      projectileDamage: 6,
      shieldRegenPerSecond: STATS.shieldRegenPerSecond.base,
      shieldReservePerSector: STATS.shieldReservePerSector.base,
      ...setup.stats,
    },
    pendingChoice: null,
    freezeTicks: 0,
    freezeLockoutTicks: 0,
    stage: STAGE,
    hullName: 'Lien',
    hullId: 'lien',
    boss: null,
    hazards: [],
  }
}

const PANEL: PanelState = {
  pilotNumber: 12,
  hullName: 'Lien',
  weaponName: 'Twin Pulse',
  fireRate: 6.4,
  waveCount: 9,
}

function draw(setup: ShieldSetup = {}, panel: Partial<PanelState> = {}): Recorded[] {
  const { ctx, calls } = makeStub()
  drawPanel(ctx, view(setup), { ...PANEL, ...panel })
  return calls
}

/** Every string the panel drew, in order, space-separated. */
function textOf(calls: readonly Recorded[]): string {
  return calls
    .filter((call) => call.name === 'fillText')
    .map((call) => String(call.args[0]))
    .join(' ')
}

/**
 * Did the panel say this?
 *
 * Tracked text is emitted one glyph per `fillText` — that is how `drawText` applies
 * letter spacing identically in every browser and in a headless capture — so a label
 * arrives as ten calls, not one. Checking both forms is the difference between a test
 * that reads the panel and one that reads whichever half of it happens to be
 * untracked.
 */
function says(calls: readonly Recorded[], text: string): boolean {
  const stream = textOf(calls)
  return stream.includes(text) || stream.includes([...text].join(' '))
}

/** `rgba(...)` fills in the shield's own colour: the recovery headroom segments. */
function ghostRects(calls: readonly Recorded[]): Recorded[] {
  return calls.filter(
    (call) => call.name === 'fillRect' && /^rgba\(92, 224, 240,/.test(call.fillStyle),
  )
}

function alphaOf(call: Recorded): number {
  return Number(/rgba\([^)]*?,\s*([\d.]+)\s*\)/.exec(call.fillStyle)?.[1] ?? 0)
}

// The four states the panel must tell apart, as setups.
const RECOVERING: ShieldSetup = { shield: 10, reserve: 12, blocked: 0 }
const SUPPRESSED: ShieldSetup = { shield: 10, reserve: 12, blocked: 90 }
const SPENT: ShieldSetup = { shield: 10, reserve: 0, blocked: 0 }
const READY: ShieldSetup = { shield: 40, reserve: 12, blocked: 0 }

// ---------------------------------------------------------------------------
// the state machine
// ---------------------------------------------------------------------------

describe('shieldRecovery reads the state off the hull', () => {
  it('is recovering when the delay has elapsed and the reserve holds something', () => {
    const recovery = shieldRecovery(view(RECOVERING))
    expect(recovery.state).toBe('recovering')
    expect(recovery.reserve).toBe(12)
    expect(recovery.waitTicks).toBe(0)
  })

  it('is suppressed while the post-hit delay is still running', () => {
    const recovery = shieldRecovery(view(SUPPRESSED))
    expect(recovery.state).toBe('suppressed')
    // The countdown is carried through, because it is what the row prints.
    expect(recovery.waitTicks).toBe(90)
  })

  it('is spent when the sector has nothing left to give', () => {
    expect(shieldRecovery(view(SPENT)).state).toBe('spent')
  })

  it('is ready — not suppressed — at a full shield, however recently hit', () => {
    expect(shieldRecovery(view(READY)).state).toBe('ready')
    // The distinction that keeps the row from crying wolf after every graze.
    expect(shieldRecovery(view({ ...READY, blocked: 120 })).state).toBe('ready')
  })

  it('is off when a curse has zeroed the rate or the budget', () => {
    expect(shieldRecovery(view({ ...RECOVERING, stats: { shieldRegenPerSecond: 0 } })).state).toBe(
      'off',
    )
    expect(
      shieldRecovery(view({ ...RECOVERING, stats: { shieldReservePerSector: 0 } })).state,
    ).toBe('off')
    // And "off" is not "spent": a build that can never recover is a different fact
    // from a sector that has already been spent, and only one of them changes later.
    expect(shieldRecovery(view(SPENT)).state).not.toBe('off')
  })

  it('says nothing at all for a hull that carries no shield', () => {
    expect(shieldRecovery(view({ maxShield: 0, shield: 0, reserve: 0 })).state).toBe('none')
  })

  it('clamps the recovery ceiling to the pool it can actually fill', () => {
    // 30 in reserve against a 40 pool holding 20 can only reach 40, not 50.
    expect(shieldRecovery(view({ shield: 20, maxShield: 40, reserve: 30 })).ceiling).toBe(40)
    expect(shieldRecovery(view({ shield: 20, maxShield: 40, reserve: 5 })).ceiling).toBe(25)
  })
})

// ---------------------------------------------------------------------------
// question 1 — how much recovery is left this sector
// ---------------------------------------------------------------------------

describe('the panel answers "how much recovery is left"', () => {
  it('prints the reserve with a unit and a direction', () => {
    // UI.md rule 2: no bare numbers. "12" alone could be seconds, points or a percent.
    expect(says(draw(RECOVERING), 'sp left')).toBe(true)
    expect(says(draw(RECOVERING), '12')).toBe(true)
  })

  it('draws the reserve on the shield bar, in the bar’s own units', () => {
    // The strongest form of the answer: the ghost segments show where the shield
    // will come back TO, so the player never converts between two scales under fire.
    const wide = ghostRects(draw({ shield: 5, maxShield: 40, reserve: 30 })).length
    const narrow = ghostRects(draw({ shield: 5, maxShield: 40, reserve: 5 })).length
    expect(wide).toBeGreaterThan(narrow)
    expect(narrow).toBeGreaterThan(0)
  })

  it('lights a segment for a reserve too small to round up to one', () => {
    // 1 point of an 8-segment 40sp bar is a sixth of a segment. Rounding alone would
    // erase it — at the exact moment the player most needs to know it is nearly gone.
    expect(ghostRects(draw({ shield: 20, maxShield: 40, reserve: 1 })).length).toBe(1)
  })

  it('never claims headroom past the top of the bar', () => {
    // 8 segments, 4 of them already full: at most 4 can be ghosted however large the
    // reserve is. A ninth rect would be drawing outside the meter.
    expect(ghostRects(draw({ shield: 20, maxShield: 40, reserve: 400 })).length).toBe(4)
    expect(ghostRects(draw({ shield: 40, maxShield: 40, reserve: 400 })).length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// question 2 — recovering, or suppressed?
// ---------------------------------------------------------------------------

describe('recovering and suppressed are told apart without colour', () => {
  it('names each state in words', () => {
    expect(says(draw(RECOVERING), 'RECOVERING')).toBe(true)
    expect(says(draw(SUPPRESSED), 'SUPPRESSED')).toBe(true)
    expect(says(draw(RECOVERING), 'SUPPRESSED')).toBe(false)
  })

  it('prints when recovery resumes, in seconds, while suppressed', () => {
    // 90 ticks is 1.5 s. Ticks are a simulation detail; the pilot is timing a gap.
    const calls = draw({ ...SUPPRESSED, blocked: 90 })
    expect(says(calls, '1.5')).toBe(true)
    expect(says(calls, 's')).toBe(true)
    expect(says(calls, '90')).toBe(false)
  })

  it('gives the two states different silhouettes in the bar', () => {
    // Motion is one channel and SHAPE is the other: recovery fills the segment,
    // suppression collapses to a floor line. Height survives greyscale and survives
    // being photographed off a screen, which no pair of hues on this palette does.
    const flowing = ghostRects(draw(RECOVERING))
    const held = ghostRects(draw(SUPPRESSED))
    expect(flowing.length).toBe(held.length)
    const flowingH = new Set(flowing.map((call) => Number(call.args[3])))
    const heldH = new Set(held.map((call) => Number(call.args[3])))
    expect(flowingH.size).toBe(1)
    expect(heldH.size).toBe(1)
    expect(Math.min(...heldH)).toBeLessThan(Math.min(...flowingH))
  })

  it('stays distinguishable with every colour in the panel erased', () => {
    // The real test. Strip fillStyle out of the comparison entirely — this is what a
    // deuteranope who cannot separate two of our tokens is left with — and the two
    // states must still be different frames.
    const shapeOf = (setup: ShieldSetup): string =>
      draw(setup)
        .map((call) => `${call.name}(${call.args.map((a) => String(a)).join(',')})`)
        .join('|')
    expect(shapeOf(RECOVERING)).not.toEqual(shapeOf(SUPPRESSED))
    expect(shapeOf(RECOVERING)).not.toEqual(shapeOf(SPENT))
    expect(shapeOf(SUPPRESSED)).not.toEqual(shapeOf(SPENT))
    expect(shapeOf(READY)).not.toEqual(shapeOf(RECOVERING))
  })

  it('keeps the reserve readable through suppression', () => {
    // The countdown takes the number slot while suppressed, so the ghost segments are
    // the only thing left carrying "how much". They must not vanish with the pulse.
    expect(ghostRects(draw(SUPPRESSED)).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// question 3 — is the reserve spent?
// ---------------------------------------------------------------------------

describe('a spent reserve is a distinct, final state', () => {
  it('says so, and draws no headroom at all', () => {
    const calls = draw(SPENT)
    expect(says(calls, 'SPENT')).toBe(true)
    // No ghost is the encoding: the empty segments are simply empty, because nothing
    // is coming back this sector. Absence is the third silhouette.
    expect(ghostRects(calls)).toHaveLength(0)
  })

  it('still prints a number with a unit rather than a bare word', () => {
    expect(says(draw(SPENT), 'sp left')).toBe(true)
    expect(says(draw(SPENT), '0')).toBe(true)
  })

  it('shows no headroom for a build whose recovery is switched off', () => {
    // A curse can zero the RATE while leaving a reserve sitting on the hull. Drawing
    // the ghost from the reserve alone would promise a ceiling that will never be
    // reached — worse than showing nothing, because the player would plan a disengage
    // around it.
    const off = draw({ ...RECOVERING, stats: { shieldRegenPerSecond: 0 } })
    expect(ghostRects(off)).toHaveLength(0)
    expect(says(off, 'NO RECOVERY')).toBe(true)
  })

  it('is not the same readout as a build that never had recovery', () => {
    const spent = draw(SPENT)
    const off = draw({ ...SPENT, stats: { shieldReservePerSector: 0 } })
    expect(says(off, 'NO RECOVERY')).toBe(true)
    expect(textOf(spent)).not.toEqual(textOf(off))
  })
})

// ---------------------------------------------------------------------------
// the row behaves like the rest of the panel
// ---------------------------------------------------------------------------

describe('the reserve row obeys the panel’s rules', () => {
  const SETUPS: ReadonlyArray<readonly [string, ShieldSetup]> = [
    ['recovering', RECOVERING],
    ['suppressed', SUPPRESSED],
    ['spent', SPENT],
    ['ready', READY],
    ['off', { ...RECOVERING, stats: { shieldReservePerSector: 0 } }],
    ['no shield', { maxShield: 0, shield: 0, reserve: 0 }],
  ]

  for (const [name, setup] of SETUPS) {
    it(`stays inside the instrument column (${name})`, () => {
      for (const call of draw(setup)) {
        if (call.name === 'fillText') {
          const x = Number(call.args[1])
          expect(x).toBeGreaterThanOrEqual(PLAYFIELD_W)
          // Real ink, not the anchor: the far edge of the string too.
          expect(x + String(call.args[0]).length * 7).toBeLessThanOrEqual(VIRTUAL_W)
        }
        if (call.name === 'fillRect') {
          const x = Number(call.args[0])
          expect(x).toBeGreaterThanOrEqual(PLAYFIELD_W)
          expect(x + Number(call.args[2])).toBeLessThanOrEqual(VIRTUAL_W)
          const y = Number(call.args[1])
          expect(y + Number(call.args[3])).toBeLessThanOrEqual(VIRTUAL_H)
        }
      }
    })
  }

  it('never collides the state word with its number, across the whole stat range', () => {
    // The reserve is capped at 400 by STATS, "RECOVERING" is a wide word, and the
    // column is 164 units. The row measures and degrades its unit rather than
    // trusting a character count — the same discipline drawStatLine was built with,
    // and for the same reason: a long label running into a right-aligned value is
    // unreadable, and unreadable is a P0.
    for (const reserve of [1, 9, 12, 15, 99, 100, 250, STATS.shieldReservePerSector.max]) {
      const calls = draw({ shield: 5, maxShield: 999, reserve })
      const texts = calls.filter((c) => c.name === 'fillText')
      // The unit is drawn untracked as one string, and `sp` on its own appears
      // nowhere else in the column — the meter's own unit arrives inside `/ 999 sp`.
      const unit = texts.find((c) => c.args[0] === 'sp left' || c.args[0] === 'sp')
      expect(unit, `reserve ${reserve}: the row printed no unit`).toBeTruthy()
      if (!unit) continue
      const rowY = Number(unit.args[2])
      const onRow = texts.filter((c) => Number(c.args[2]) === rowY)
      const ink = onRow.map((c) => {
        const x = Number(c.args[1])
        return { x, end: x + String(c.args[0]).length * 7, text: String(c.args[0]) }
      })
      const valueStart = Math.min(...ink.filter((i) => i.text !== 'sp left' && i.text !== 'sp' && /[\d.]/.test(i.text)).map((i) => i.x))
      const wordEnd = Math.max(...ink.filter((i) => /[A-Z]/.test(i.text)).map((i) => i.end))
      // The panel's OWN minimum, not a fresh number: a row that merely fails to
      // overlap is still unreadable, and 7 units of air between "RECOVERING" and
      // "400" reads as one string. This is the assertion the unit degrade exists to
      // satisfy — without it the row clears an overlap check and still looks wrong.
      expect(
        valueStart,
        `reserve ${reserve}: the state word crowds its own number`,
      ).toBeGreaterThanOrEqual(wordEnd + STAT_MIN_GAP)
      // And nothing on the row leaves the column.
      expect(Math.max(...ink.map((i) => i.end))).toBeLessThanOrEqual(VIRTUAL_W)
    }
  })

  it('emits no NaN when the hull it is handed is broken', () => {
    const broken = view(RECOVERING)
    const hull = broken.hull as { shieldReserve: number; shieldRegenBlockedTicks: number }
    hull.shieldReserve = Number.NaN
    hull.shieldRegenBlockedTicks = Number.NaN
    const { ctx, calls } = makeStub()
    expect(() => drawPanel(ctx, broken, PANEL)).not.toThrow()
    for (const call of calls) {
      for (const arg of call.args) {
        if (typeof arg === 'number') expect(Number.isFinite(arg)).toBe(true)
        if (typeof arg === 'string') expect(arg).not.toContain('NaN')
      }
      expect(call.fillStyle).not.toContain('NaN')
    }
  })

  it('never paints the headroom in danger, even at an empty shield', () => {
    // The meter goes critical at zero and its filled segments turn `danger`. The
    // headroom must not follow: rule 3 reserves that token for things that can hurt
    // you this instant, and being able to recover is the opposite of one.
    const calls = draw({ shield: 0, maxShield: 40, reserve: 12 })
    const ghosts = ghostRects(calls)
    expect(ghosts.length).toBeGreaterThan(0)
    for (const call of calls) {
      if (call.name !== 'fillRect') continue
      expect(call.fillStyle).not.toContain('255, 74, 56')
      expect(call.fillStyle.toUpperCase()).not.toBe(Palette.danger)
    }
  })
})

// ---------------------------------------------------------------------------
// rule 10 — the headroom breathes, it does not blink
// ---------------------------------------------------------------------------

describe('UI rule 10: the recovery headroom', () => {
  const TICKS = 600

  /** Peaks per second in a sampled waveform, at 60 samples per second. */
  function measuredHz(samples: readonly number[]): number {
    const peaks: number[] = []
    for (let i = 1; i < samples.length - 1; i++) {
      const prev = samples[i - 1] ?? 0
      const here = samples[i] ?? 0
      const next = samples[i + 1] ?? 0
      if (here > prev && here >= next) peaks.push(i)
    }
    if (peaks.length < 2) return 0
    const first = peaks[0] ?? 0
    const last = peaks[peaks.length - 1] ?? 0
    const period = (last - first) / (peaks.length - 1)
    return period > 0 ? TICK_HZ / period : 0
  }

  /**
   * ALPHA is the axis this effect varies, so alpha is what is measured.
   *
   * The lesson recorded in tests/render.test.ts is the opposite case — an effect that
   * held alpha constant and modulated area, which an alpha-only harness reported as
   * "does not animate". The ghost's geometry is a pure function of the reserve and
   * never of the tick (asserted below), so the two halves of that lesson are both
   * covered: this samples the channel that moves, and the next test pins the channel
   * that must not.
   */
  it('breathes below 1Hz, measured from the alpha it actually emits', () => {
    const samples: number[] = []
    for (let tick = 0; tick < TICKS; tick++) {
      const ghosts = ghostRects(draw({ ...RECOVERING, tick }))
      expect(ghosts.length).toBeGreaterThan(0)
      samples.push(ghosts.reduce((total, call) => total + alphaOf(call), 0))
    }
    const hz = measuredHz(samples)
    expect(hz, `measured at ${hz.toFixed(2)}Hz`).toBeGreaterThan(0)
    expect(hz).toBeLessThanOrEqual(1.05)
    expect(hz).toBeCloseTo(PULSE_HZ, 1)
  })

  it('breathes rather than blinks: the headroom never reaches zero', () => {
    for (let tick = 0; tick < TICKS; tick++) {
      for (const call of ghostRects(draw({ ...RECOVERING, tick }))) {
        expect(alphaOf(call)).toBeGreaterThan(0.1)
      }
    }
  })

  it('modulates alpha and nothing else, so its area is constant', () => {
    // The engine-plume defect in reverse. If a later change makes the ghost grow and
    // shrink instead of fade, this fails and the author has to think about rule 10
    // rather than discovering it in a capture.
    const geometry = (tick: number): string =>
      ghostRects(draw({ ...RECOVERING, tick }))
        .map((call) => call.args.join(','))
        .join('|')
    const first = geometry(0)
    for (const tick of [7, 31, 90, 211, 599]) expect(geometry(tick)).toBe(first)
  })

  it('holds still while suppressed, which is half of what tells the two apart', () => {
    const alphas = new Set(
      [0, 17, 60, 140, 300].flatMap((tick) =>
        ghostRects(draw({ ...SUPPRESSED, tick })).map(alphaOf),
      ),
    )
    expect(alphas.size).toBe(1)
  })

  it('attenuates under reduceFlashes without disappearing', () => {
    const peak = (reduceFlashes: boolean): number => {
      let best = 0
      for (let tick = 0; tick < TICKS; tick++) {
        for (const call of ghostRects(draw({ ...RECOVERING, tick }, { reduceFlashes }))) {
          best = Math.max(best, alphaOf(call))
        }
      }
      return best
    }
    const normal = peak(false)
    const reduced = peak(true)
    expect(reduced).toBeLessThan(normal)
    expect(reduced).toBeGreaterThan(0.1)
  })
})

// ---------------------------------------------------------------------------
// what the row costs
// ---------------------------------------------------------------------------

describe('the reserve costs the panel what it should', () => {
  it('draws a bounded number of rects however large the reserve', () => {
    // Per SEGMENT, not per point. A reserve of 400 drawn one tick per point would be
    // 400 rects a frame in the middle of a bullet-hell frame budget.
    const ceiling = ghostRects(draw({ shield: 0, maxShield: 999, reserve: 999 })).length
    expect(ceiling).toBeLessThanOrEqual(8)
  })

  it('adds no drawing at all when there is nothing to recover', () => {
    const spentCalls = draw(SPENT).length
    const recoveringCalls = draw(RECOVERING).length
    expect(recoveringCalls).toBeGreaterThan(spentCalls)
    // And the gap is the ghost segments plus their fill-style writes, not a redraw
    // of the whole meter.
    expect(recoveringCalls - spentCalls).toBeLessThanOrEqual(16)
  })

  it('leaves the panel column where it was', () => {
    // The row is paid for out of the flexible region, not out of the panel's width.
    expect(PANEL_W).toBe(VIRTUAL_W - PLAYFIELD_W)
  })
})
