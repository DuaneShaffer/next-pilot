/**
 * The hazard warning, as the player sees it: in the playfield, not in the panel.
 *
 * A hazard's warning phase is the reaction window — the whole reason the phase is
 * simulation state rather than a render effect. It was drawn only by `drawHazardBlock`,
 * which lives in the instrument column, so for two milestones the most time-critical
 * second in the game was announced in the one place UI.md rule 9 says the player is not
 * looking. `drawHazardWarning` is the cue that fixes that, and every claim made for it
 * is asserted here against what it actually draws.
 *
 * Five of these are written to fail loudly if the cue is quietly weakened later:
 *
 *   - the countdown must SHRINK, monotonically, and never reach zero while the window
 *     is open (a cue that vanishes early is worse than none);
 *   - a global hazard must not be given a fake direction;
 *   - severity must survive colour being removed entirely;
 *   - the panel and the playfield must give one hazard ONE severity. They did not: the
 *     panel row spent `dangerText` on every warning while the alarm derived severity
 *     from the kind, so a `grid-sweep` or `manifest-blackout` warning had the two
 *     surfaces contradicting each other about the same hazard in the same frame. The
 *     assertions below ask both surfaces the same question and require the same answer,
 *     for every kind, which is a thing a future kind cannot get half-right;
 *   - geometry must not depend on `tick`, which is what keeps the rule-10 suite's alpha
 *     measurement a measurement of the axis this effect actually varies on. The engine
 *     plume shipped an 8.59 Hz strobe by modulating AREA while that suite watched
 *     ALPHA; the guard against a repeat is to make area constant and say so in a test.
 */

import { describe, expect, it } from 'vitest'
import { PLAYFIELD_H, PLAYFIELD_W } from '../src/core/space'
import type { HazardKind } from '../src/content/types'
import type { HazardView, WorldView } from '../src/sim/entities'
import { HAZARD_WARNING_TICKS } from '../src/sim/hazards'
import { drawHazardBlock, drawHazardWarning, hazardStatus } from '../src/render/hazards'
import { drawScene } from '../src/render/scene'
import { Palette, withAlpha } from '../src/render/palette'
import { Starfield } from '../src/render/starfield'

// ---------------------------------------------------------------------------
// a recording 2D context
// ---------------------------------------------------------------------------

interface Recorded {
  readonly name: string
  readonly args: readonly unknown[]
  /** A gradient is recorded as the literal 'gradient': it has no readable colour. */
  readonly fillStyle: string
  readonly globalAlpha: number
}

interface Stub {
  ctx: CanvasRenderingContext2D
  calls: Recorded[]
}

const METHODS = [
  'fillRect',
  'strokeRect',
  'beginPath',
  'moveTo',
  'lineTo',
  'closePath',
  'arc',
  'rect',
  'clip',
  'fill',
  'stroke',
  'save',
  'restore',
  'translate',
  'rotate',
  'drawImage',
  'fillText',
] as const

function makeStub(): Stub {
  const calls: Recorded[] = []
  const state = {
    fillStyle: '#000000' as unknown,
    strokeStyle: '#000000' as unknown,
    globalAlpha: 1,
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
  }

  const styleOf = (value: unknown): string => (typeof value === 'string' ? value : 'gradient')
  const snapshot = (): Pick<Recorded, 'fillStyle' | 'globalAlpha'> => ({
    fillStyle: styleOf(state.fillStyle),
    globalAlpha: state.globalAlpha,
  })

  const target: Record<string, unknown> = {
    measureText: (text: string) => ({ width: String(text).length * 7 }),
    // Recorded, and so are its stops: the whole point of the invariance test below is
    // that nothing about the wash except `globalAlpha` moves with the tick.
    createLinearGradient: (...args: unknown[]) => {
      calls.push({ name: 'createLinearGradient', args, ...snapshot() })
      return {
        addColorStop: (...stop: unknown[]): void => {
          calls.push({ name: 'addColorStop', args: stop, ...snapshot() })
        },
      }
    },
    createRadialGradient: (...args: unknown[]) => {
      calls.push({ name: 'createRadialGradient', args, ...snapshot() })
      return { addColorStop: (): void => {} }
    },
  }

  for (const name of METHODS) {
    target[name] = (...args: unknown[]): void => {
      calls.push({ name, args, ...snapshot() })
    }
  }
  for (const key of Object.keys(state) as (keyof typeof state)[]) {
    Object.defineProperty(target, key, {
      get: () => state[key],
      set: (value: never) => {
        state[key] = value
        calls.push({ name: `set:${key}`, args: [styleOf(value)], ...snapshot() })
      },
    })
  }

  return { ctx: target as unknown as CanvasRenderingContext2D, calls }
}

// ---------------------------------------------------------------------------
// fixtures and readers
// ---------------------------------------------------------------------------

function hazard(overrides: Partial<HazardView> = {}): HazardView {
  return {
    id: 'convoy-wake',
    name: 'Convoy Wake',
    hazardKind: 'debris',
    description: 'Loose freight falls across the lane.',
    phase: 'warning',
    ticksToChange: HAZARD_WARNING_TICKS,
    progress: 0,
    ...overrides,
  }
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
  fill: string
  alpha: number
}

function rects(calls: readonly Recorded[]): Rect[] {
  const out: Rect[] = []
  for (const call of calls) {
    if (call.name !== 'fillRect') continue
    const [x, y, w, h] = call.args as [number, number, number, number]
    out.push({ x, y, w, h, fill: call.fillStyle, alpha: call.globalAlpha })
  }
  return out
}

/** The lit pips: the countdown itself. Notches are cut in the surface colour. */
function pips(calls: readonly Recorded[], color: string): Rect[] {
  return rects(calls).filter((r) => r.fill === color && r.h === 5 && r.w === 11)
}

function notches(calls: readonly Recorded[]): Rect[] {
  return rects(calls).filter((r) => r.fill === Palette.void)
}

/** The edge washes, identified by being the only gradient-filled rects. */
function washes(calls: readonly Recorded[]): Rect[] {
  return rects(calls).filter((r) => r.fill === 'gradient')
}

/** Everything about a frame except how bright it is. */
function geometry(calls: readonly Recorded[]): string {
  return JSON.stringify(
    calls.filter((c) => c.name !== 'set:globalAlpha').map((c) => [c.name, c.args, c.fillStyle]),
  )
}

/** Every alpha the frame drew anything at. */
function alphas(calls: readonly Recorded[]): number[] {
  return calls
    .filter((c) => c.name === 'fillRect' || c.name === 'fill')
    .map((c) => Number(c.globalAlpha.toFixed(5)))
}

/**
 * The hull, as a plain literal.
 *
 * Deliberately not annotated `Hull`: only `x` and `y` are asserted against here (the
 * cue's claim is that it sits in the same glance as the ship), and pinning a fixture to
 * the full entity shape makes every unrelated field added to the sim contract a
 * failure in this file. `worldFixture` already casts, for the same reason.
 */
const HULL = {
  x: 224,
  y: 610,
  prevX: 224,
  prevY: 610,
  integrity: 90,
  maxIntegrity: 100,
  shield: 20,
  maxShield: 40,
  invulnTicks: 0,
  radius: 5,
}

function worldFixture(hazards: readonly HazardView[]): WorldView {
  return {
    seed: 'TEST-SEED',
    runState: 'active',
    choiceResolve: null,
    choiceSelection: -1,
    hull: HULL,
    playerBullets: [],
    enemyBullets: [],
    enemies: [],
    explosions: [],
    stats: {
      tick: 600,
      shotsFired: 0,
      hits: 0,
      kills: 0,
      scrap: 0,
      damageTaken: 0,
      waveIndex: 1,
      peakProjectiles: 0,
      bulletsCulled: 0,
    },
    incident: null,
    events: [],
    cosmetic: { shake: 0 },
    inventory: [],
    activeInteractions: [],
    resolvedStats: { projectileDamage: 6 },
    pendingChoice: null,
    freezeTicks: 0,
    stage: null,
    hullName: 'Lien',
    hullId: 'lien',
    boss: null,
    hazards: [...hazards],
  } as unknown as WorldView
}

// ---------------------------------------------------------------------------
// it exists only for the reaction window
// ---------------------------------------------------------------------------

describe('the hazard alarm is the reaction window and nothing else', () => {
  it('draws nothing at all outside the warning phase', () => {
    for (const phase of ['idle', 'active'] as const) {
      const { ctx, calls } = makeStub()
      drawHazardWarning(ctx, [hazard({ phase })], 30)
      expect(calls, `drew during ${phase}`).toHaveLength(0)
    }
    const empty = makeStub()
    drawHazardWarning(empty.ctx, [], 30)
    expect(empty.calls).toHaveLength(0)
  })

  it('picks the warning out of a list of quiet hazards', () => {
    const { ctx, calls } = makeStub()
    drawHazardWarning(
      ctx,
      [
        hazard({ id: 'a', phase: 'idle' }),
        hazard({ id: 'b', phase: 'warning' }),
        hazard({ id: 'c', phase: 'active' }),
      ],
      30,
    )
    // One strip: twelve slots, of which the lit ones are the countdown.
    expect(rects(calls).filter((r) => r.h === 5 && r.w === 11)).toHaveLength(12)
  })

  it('never prints a number, because the player is dodging', () => {
    const { ctx, calls } = makeStub()
    drawHazardWarning(ctx, [hazard({ ticksToChange: 37 })], 12)
    expect(calls.filter((c) => c.name === 'fillText')).toHaveLength(0)
  })

  it('caps how much of the screen it can take, whatever content does later', () => {
    const many = Array.from({ length: 5 }, (_, i) => hazard({ id: `h${i}` }))
    const { ctx, calls } = makeStub()
    drawHazardWarning(ctx, many, 12)
    // 12 slots per strip, at most three strips.
    expect(rects(calls).filter((r) => r.h === 5 && r.w === 11)).toHaveLength(36)
  })
})

// ---------------------------------------------------------------------------
// WHEN — a shrinking quantity, in the same glance as the ship
// ---------------------------------------------------------------------------

describe('time to onset is a length, not a figure', () => {
  const litAt = (ticks: number): number => {
    const { ctx, calls } = makeStub()
    drawHazardWarning(ctx, [hazard({ ticksToChange: ticks })], 0)
    return pips(calls, Palette.danger).length
  }

  it('shrinks monotonically across the whole window and never empties early', () => {
    let previous = Number.POSITIVE_INFINITY
    for (let ticks = HAZARD_WARNING_TICKS; ticks >= 1; ticks--) {
      const lit = litAt(ticks)
      expect(lit, `${ticks} ticks left`).toBeLessThanOrEqual(previous)
      // A warning still running must still be on screen. Zero pips a few ticks before
      // the hazard fires would be an alarm that stops during the emergency.
      expect(lit, `${ticks} ticks left`).toBeGreaterThanOrEqual(1)
      previous = lit
    }
    expect(litAt(HAZARD_WARNING_TICKS)).toBe(12)
    expect(litAt(1)).toBeLessThan(litAt(HAZARD_WARNING_TICKS))
  })

  it('keeps the spent slots drawn, so a short bar has something to be short against', () => {
    const { ctx, calls } = makeStub()
    drawHazardWarning(ctx, [hazard({ ticksToChange: 10 })], 0)
    const slots = rects(calls).filter((r) => r.h === 5 && r.w === 11)
    expect(slots).toHaveLength(12)
    expect(pips(calls, Palette.danger).length).toBeLessThan(12)
    expect(slots.filter((r) => r.fill === Palette.line).length).toBeGreaterThan(0)
  })

  it('empties from the outside in, so what is left stays under the hull', () => {
    const centreOf = (ticks: number): number => {
      const { ctx, calls } = makeStub()
      drawHazardWarning(ctx, [hazard({ ticksToChange: ticks })], 0)
      const lit = pips(calls, Palette.danger)
      const first = lit[0]
      const last = lit[lit.length - 1]
      expect(first && last).toBeTruthy()
      return ((first?.x ?? 0) + (last?.x ?? 0) + 11) / 2
    }
    for (const ticks of [60, 40, 20, 6, 1]) {
      // Within half a pip of the hull's column, at every point in the countdown.
      expect(Math.abs(centreOf(ticks) - HULL.x)).toBeLessThan(8)
    }
  })

  it('sits in the same glance as the ship, below it and inside the playfield', () => {
    const { ctx, calls } = makeStub()
    drawHazardWarning(ctx, [hazard(), hazard({ id: 'b', hazardKind: 'blackout' })], 0)
    const slots = rects(calls).filter((r) => r.h === 5 && r.w === 11)
    expect(slots.length).toBeGreaterThan(0)
    for (const r of slots) {
      expect(r.y).toBeGreaterThan(HULL.y)
      // The claim being checked is "without looking away from the ship": a cue 500
      // units up the screen is a second saccade in the second the player has not got.
      expect(r.y - HULL.y).toBeLessThan(100)
      expect(r.y + r.h).toBeLessThanOrEqual(PLAYFIELD_H)
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w).toBeLessThanOrEqual(PLAYFIELD_W)
    }
  })
})

// ---------------------------------------------------------------------------
// WHERE — and no invented locations
// ---------------------------------------------------------------------------

describe('a spatial hazard says where, and a global one does not pretend to', () => {
  const washedSides = (kind: HazardKind): string[] => {
    const { ctx, calls } = makeStub()
    drawHazardWarning(ctx, [hazard({ hazardKind: kind })], 0)
    const out: string[] = []
    for (const r of washes(calls)) {
      if (r.y === 0 && r.w === PLAYFIELD_W) out.push('top')
      else if (r.y > 0 && r.w === PLAYFIELD_W) out.push('bottom')
      else if (r.x === 0) out.push('left')
      else out.push('right')
    }
    return out.sort()
  }

  it('washes only the edge debris falls from', () => {
    // spawnDebris puts the curtain at the top and drops it down the full width, and the
    // per-fall jitter is uniform, so "the whole top edge" is the most specific true
    // statement available. Washing a side as well would send the player dodging
    // sideways from something that arrives from above.
    expect(washedSides('debris')).toEqual(['top'])
  })

  it('washes every edge for a hazard that has no location', () => {
    for (const kind of ['corrosion', 'interdiction', 'blackout'] as const) {
      expect(washedSides(kind), kind).toEqual(['bottom', 'left', 'right', 'top'])
    }
  })

  it('gives the anchored edge a shape as well as a wash', () => {
    // Teeth on the edge, pointing inward: the direction survives greyscale and a
    // photograph, which a red gradient alone does not.
    const { ctx, calls } = makeStub()
    drawHazardWarning(ctx, [hazard({ hazardKind: 'debris' })], 0)
    const teeth = calls.filter((c) => c.name === 'closePath').length
    expect(teeth).toBeGreaterThan(2)
    // Every tooth is on the top edge and points down into the field.
    const ys = calls
      .filter((c) => c.name === 'moveTo' || c.name === 'lineTo')
      .map((c) => Number((c.args as [number, number])[1]))
    expect(Math.min(...ys)).toBe(0)
    expect(Math.max(...ys)).toBeLessThanOrEqual(20)
  })

  it('stays out of the instrument column and inside the playfield', () => {
    const { ctx, calls } = makeStub()
    drawHazardWarning(ctx, [hazard({ hazardKind: 'interdiction' })], 0)
    for (const r of rects(calls)) {
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w).toBeLessThanOrEqual(PLAYFIELD_W)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.y + r.h).toBeLessThanOrEqual(PLAYFIELD_H)
    }
  })
})

// ---------------------------------------------------------------------------
// WHAT — severity on a channel that is not hue
// ---------------------------------------------------------------------------

describe('severity does not depend on telling red from amber', () => {
  const draw = (kind: HazardKind): Recorded[] => {
    const { ctx, calls } = makeStub()
    drawHazardWarning(ctx, [hazard({ hazardKind: kind })], 0)
    return calls
  }

  it('notches the pips of a hazard that takes integrity, and only those', () => {
    for (const kind of ['corrosion', 'debris'] as const) {
      const calls = draw(kind)
      const cut = notches(calls)
      expect(cut.length, kind).toBe(pips(calls, Palette.danger).length)
      // Cut in the surface colour, inside the pip, narrower than it.
      for (const r of cut) expect(r.w).toBeLessThan(11)
    }
    for (const kind of ['interdiction', 'blackout'] as const) {
      expect(notches(draw(kind)), kind).toHaveLength(0)
    }
  })

  it('survives colour being deleted entirely', () => {
    // The real test of a redundant channel: strip every hue out of both frames and they
    // must still be different pictures. `danger` and `caution` are the one pair in the
    // palette that cannot be separated by hue for a protanope or deuteranope, so this
    // is the assertion that matters for ~5% of men.
    const shapesOf = (kind: HazardKind): string =>
      JSON.stringify(rects(draw(kind)).map((r) => [r.x, r.y, r.w, r.h]))
    expect(shapesOf('debris')).not.toBe(shapesOf('interdiction'))
    // And it is the notch doing it, not the wash: same edge geometry, different pips.
    expect(shapesOf('corrosion')).not.toBe(shapesOf('blackout'))
  })

  it('reserves danger for the hazards that can actually take integrity', () => {
    const fills = (kind: HazardKind): string[] => draw(kind).map((c) => c.fillStyle)
    for (const kind of ['corrosion', 'debris'] as const) {
      expect(fills(kind), kind).toContain(Palette.danger)
      expect(fills(kind), kind).not.toContain(Palette.caution)
    }
    // Rule 3 is narrow on purpose: an interdiction field does no damage and a manifest
    // blackout does none either, so spending the danger colour on them is exactly how a
    // threat reflex gets trained on noise.
    for (const kind of ['interdiction', 'blackout'] as const) {
      expect(fills(kind), kind).toContain(Palette.caution)
      expect(fills(kind), kind).not.toContain(Palette.danger)
    }
  })
})

// ---------------------------------------------------------------------------
// one hazard, one severity, whichever surface is asked
// ---------------------------------------------------------------------------

/**
 * The two surfaces are checked against EACH OTHER, not each against a constant.
 *
 * A pair of tests that each pinned its own surface to its own expected colour is
 * exactly what let the contradiction ship: both passed, and neither could see the
 * other. These read the answer out of one surface and require the other to match it.
 */
describe('the panel row and the playfield alarm cannot disagree', () => {
  const KINDS: readonly HazardKind[] = ['debris', 'corrosion', 'interdiction', 'blackout']

  /** The panel row for one hazard, drawn with room for its prose. */
  const panelRow = (kind: HazardKind, phase: HazardView['phase'] = 'warning'): Recorded[] => {
    const { ctx, calls } = makeStub()
    drawHazardBlock(ctx, {
      x: 260,
      y: 400,
      w: 164,
      hazards: [hazard({ hazardKind: kind, phase, ticksToChange: 40 })],
      tick: 0,
      available: 120,
    })
    return calls
  }

  it('colours the alarm strip in whatever the panel row calls the same hazard', () => {
    for (const kind of KINDS) {
      const panel = hazardStatus(hazard({ hazardKind: kind, phase: 'warning' }))
      const { ctx, calls } = makeStub()
      drawHazardWarning(ctx, [hazard({ hazardKind: kind })], 0)
      expect(pips(calls, panel.mark), kind).not.toHaveLength(0)
      // And never in the severity it did NOT claim: agreeing on one colour while also
      // drawing the other one would be the same contradiction with an extra step.
      const other = panel.harmful ? Palette.caution : Palette.danger
      expect(pips(calls, other), kind).toHaveLength(0)
    }
  })

  it('spends danger on the two kinds that take integrity, and caution on the two that do not', () => {
    // world.ts: `corrosion` calls applyHullDamage and `debris` spawns damaging bullets;
    // the `interdiction` and `blackout` arm is a comment and applies nothing. This is the
    // fact both surfaces are now reading, so it is asserted once here in plain terms.
    for (const kind of ['corrosion', 'debris'] as const) {
      const status = hazardStatus(hazard({ hazardKind: kind, phase: 'warning' }))
      expect(status.harmful, kind).toBe(true)
      expect(status.mark, kind).toBe(Palette.danger)
      expect(status.color, kind).toBe(Palette.dangerText)
    }
    for (const kind of ['interdiction', 'blackout'] as const) {
      const status = hazardStatus(hazard({ hazardKind: kind, phase: 'warning' }))
      expect(status.harmful, kind).toBe(false)
      expect(status.mark, kind).toBe(Palette.caution)
      expect(status.color, kind).toBe(Palette.caution)
      // Still the reaction window. Not dangerous is not the same as not urgent, and
      // collapsing the two would cost the player the second they have to move.
      expect(status.urgent, kind).toBe(true)
      expect(status.word, kind).toBe('INBOUND')
    }
  })

  it('never paints a panel row danger-red for a hazard that cannot take integrity', () => {
    for (const kind of ['interdiction', 'blackout'] as const) {
      const styles = panelRow(kind).flatMap((c) => [c.fillStyle, String(c.args[0] ?? '')])
      for (const style of styles) {
        expect(style, `${kind}: ${style}`).not.toContain(Palette.danger)
        expect(style, `${kind}: ${style}`).not.toContain(Palette.dangerText)
      }
    }
  })

  it('bands the row in the severity colour rather than always in danger', () => {
    // The band is the widest rect in the row — it spans the full content width plus the
    // bleed either side, where everything else is a 2-unit edge bar or a glyph.
    const bandFill = (kind: HazardKind): string => {
      const band = rects(panelRow(kind)).reduce((a, b) => (b.w > a.w ? b : a))
      return band.fill
    }
    // withAlpha's alpha rides the pulse, so the assertion is on the hue it derives from.
    const rgbOf = (hex: string): string => withAlpha(hex, 1).replace(/[\d.]+\)$/, '')
    expect(bandFill('debris')).toContain(rgbOf(Palette.danger))
    expect(bandFill('blackout')).toContain(rgbOf(Palette.caution))
    expect(bandFill('blackout')).not.toContain(rgbOf(Palette.danger))
  })

  it('marks panel severity with fill as well as hue, for the ~5% who cannot see the hue', () => {
    // `danger` and `caution` are the one palette pair that cannot be separated by hue for
    // a protanope or deuteranope, so the panel needs the notch's equivalent: a warning
    // triangle that is FILLED when the hazard costs integrity and hollow when it does
    // not. Shape still carries the phase; fill carries the cost.
    const marker = (kind: HazardKind): string =>
      panelRow(kind)
        .map((c) => c.name)
        .filter((n) => n === 'closePath' || n === 'fill' || n === 'stroke')
        .join(',')
    expect(marker('debris')).toBe('closePath,fill')
    expect(marker('corrosion')).toBe('closePath,fill')
    expect(marker('interdiction')).toBe('closePath,stroke')
    expect(marker('blackout')).toBe('closePath,stroke')
  })

  it('leaves idle and active rows alone, whatever the hazard costs', () => {
    // Severity applies to the reaction window. An idle row is not a threat and an active
    // one has already done whatever it does, so both stay off the danger role entirely —
    // and both keep their own marker shape, which is what separates the three phases.
    for (const kind of KINDS) {
      for (const phase of ['idle', 'active'] as const) {
        const status = hazardStatus(hazard({ hazardKind: kind, phase }))
        expect(status.urgent, `${kind}/${phase}`).toBe(false)
        expect(status.harmful, `${kind}/${phase}`).toBe(false)
        expect(status.mark, `${kind}/${phase}`).not.toBe(Palette.danger)
      }
      expect(panelRow(kind, 'idle').map((c) => c.name)).toContain('arc')
      expect(panelRow(kind, 'active').map((c) => c.name)).not.toContain('arc')
    }
  })
})

// ---------------------------------------------------------------------------
// rule 10 — and measuring the axis the effect varies on
// ---------------------------------------------------------------------------

describe('the alarm modulates brightness and nothing else', () => {
  it('draws identical geometry at every tick, so it cannot flash by changing size', () => {
    const hazards = [hazard(), hazard({ id: 'b', hazardKind: 'interdiction' })]
    const first = makeStub()
    drawHazardWarning(first.ctx, hazards, 0)
    const reference = geometry(first.calls)
    for (const tick of [1, 7, 18, 35, 60, 123, 999]) {
      const { ctx, calls } = makeStub()
      drawHazardWarning(ctx, hazards, tick)
      // Includes the gradient stops: if the breath were baked into a colour stop
      // instead of `globalAlpha`, the rule-10 suite could not see it at all.
      expect(geometry(calls), `tick ${tick}`).toBe(reference)
    }
  })

  it('does modulate, so the alarm reads as an alarm', () => {
    const at = (tick: number): number[] => {
      const { ctx, calls } = makeStub()
      drawHazardWarning(ctx, [hazard()], tick)
      return alphas(calls)
    }
    // Quarter of a period apart at 0.85Hz: about 17 ticks.
    expect(at(0)).not.toEqual(at(18))
  })

  it('attenuates under reduceFlashes without going dark', () => {
    const at = (reduce: boolean): number[] => {
      const { ctx, calls } = makeStub()
      drawHazardWarning(ctx, [hazard()], 12, reduce)
      return alphas(calls)
    }
    const normal = at(false)
    const reduced = at(true)
    expect(reduced).not.toEqual(normal)
    expect(Math.max(...reduced)).toBeLessThanOrEqual(Math.max(...normal) + 1e-9)
    // Reduced, never removed: the countdown is information, and an accessibility
    // setting must not cost the player the reaction window.
    expect(Math.min(...reduced)).toBeGreaterThan(0)
    const { ctx, calls } = makeStub()
    drawHazardWarning(ctx, [hazard()], 12, true)
    expect(pips(calls, Palette.danger).length).toBe(12)
  })

  it('emits no NaN from a hostile view', () => {
    const broken: HazardView[] = [
      hazard({ ticksToChange: Number.NaN }),
      hazard({ id: 'b', ticksToChange: Number.POSITIVE_INFINITY, progress: Number.NaN }),
      hazard({ id: 'c', ticksToChange: -40, hazardKind: 'interdiction' }),
    ]
    const { ctx, calls } = makeStub()
    drawHazardWarning(ctx, broken, 40)
    for (const call of calls) {
      for (const arg of call.args) {
        if (typeof arg === 'number') expect(Number.isFinite(arg)).toBe(true)
        if (typeof arg === 'string') expect(arg).not.toContain('NaN')
      }
      expect(Number.isFinite(call.globalAlpha)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// wired into the frame
// ---------------------------------------------------------------------------

describe('the scene draws the alarm', () => {
  const frame = (hazards: readonly HazardView[]): Recorded[] => {
    const { ctx, calls } = makeStub()
    drawScene(ctx, worldFixture(hazards), new Starfield('TEST-SEED'), 0.5)
    return calls
  }

  it('appears during a warning and not while the hazard is quiet', () => {
    const warning = frame([hazard()])
    const idle = frame([hazard({ phase: 'idle' })])
    expect(pips(warning, Palette.danger).length).toBeGreaterThan(0)
    expect(pips(idle, Palette.danger).length).toBe(0)
  })

  it('draws the alarm above the blackout scrim that would otherwise hide it', () => {
    // A blackout warning that the blackout itself dims would be self-defeating, and
    // more generally the alarm must survive the vignette at the edges it uses.
    const calls = frame([
      hazard({ id: 'grid', hazardKind: 'blackout', phase: 'warning' }),
      hazard({ id: 'dark', hazardKind: 'blackout', phase: 'active', progress: 0.5 }),
    ])
    const scrim = calls.findIndex(
      (c) => c.name === 'fillRect' && String(c.fillStyle).startsWith('rgba(2, 3, 6'),
    )
    const alarm = calls.findIndex((c) => c.name === 'fillRect' && c.fillStyle === Palette.caution)
    expect(scrim).toBeGreaterThan(-1)
    expect(alarm).toBeGreaterThan(scrim)
  })

  it('keeps the whole cue out of the instrument column', () => {
    for (const r of rects(frame([hazard({ hazardKind: 'interdiction' })]))) {
      expect(r.x + r.w).toBeLessThanOrEqual(PLAYFIELD_W + 0.01)
    }
  })
})

// ---------------------------------------------------------------------------
// the tracer head is at the bullet
// ---------------------------------------------------------------------------

/**
 * `render/scene.ts` documented the invariant and then broke it three lines later.
 *
 * Both tracer passes anchored their rect 11-14 units *ahead* of the bullet's real
 * position, in the direction of travel — so the stream appeared to reach a target
 * before the simulation's swept collision did. The comment was right and the code was
 * wrong; this is the check that keeps them agreeing.
 */
describe('a player tracer never draws ahead of its bullet', () => {
  const tracerRects = (bulletY: number): Rect[] => {
    const view = worldFixture([])
    const bullets = [
      { x: 224, y: bulletY, prevX: 224, prevY: bulletY + 10, vx: 0, vy: -620, damage: 4, radius: 2.5, alive: true },
    ]
    const { ctx, calls } = makeStub()
    drawScene(
      ctx,
      { ...view, playerBullets: bullets } as unknown as WorldView,
      new Starfield('TEST-SEED'),
      1,
    )
    // Both passes: the additive glow body and the bright core, and nothing else in the
    // frame is a tall thin rect at the bullet's column.
    return rects(calls).filter((r) => r.h > 10 && r.w <= 4 && Math.abs(r.x - 224) < 4)
  }

  it('starts the tracer at the bullet and grows it backwards', () => {
    const drawn = tracerRects(400)
    expect(drawn.length).toBe(2)
    for (const r of drawn) {
      // Leading edge exactly at the bullet: the head is the bullet.
      expect(r.y).toBeCloseTo(400, 6)
      // And the length trails behind it, in the direction the bullet came from.
      expect(r.h).toBeGreaterThan(0)
    }
  })

  it('holds at every interpolation point, not just at the tick boundary', () => {
    for (const y of [80, 240, 640]) {
      for (const r of tracerRects(y)) expect(r.y).toBeCloseTo(y, 6)
    }
  })
})
