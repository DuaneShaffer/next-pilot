/**
 * Game-feel logic, tested headless.
 *
 * None of this needs a canvas: the shake offset, the label pool, and the ageing
 * are pure functions over numbers, which is exactly why they are separable from
 * drawing. The properties asserted here are the ones whose failure is either an
 * accessibility problem (an uncapped or non-suppressible shake) or an invisible
 * one (a NaN coordinate draws nothing, silently, and a screenshot review will not
 * catch it).
 */

import { describe, expect, it } from 'vitest'
import type {
  Bullet,
  EnemyBullet,
  EnemyInstance,
  Hull,
  SimEvent,
  WorldView,
} from '../src/sim/entities'
import { drawScene } from '../src/render/scene'
import { Starfield } from '../src/render/starfield'
import {
  createFeelState,
  feelTick,
  labelOpacity,
  labelPosition,
  MAX_LABELS,
  MAX_SHAKE_UNITS,
  MAX_SPARKS,
  resetFeelState,
  shakeOffset,
  type FeelState,
} from '../src/render/feel'
import { PLAYFIELD_H, PLAYFIELD_W } from '../src/core/space'

function hit(x = 100, y = 200, damage = 4, lethal = false): SimEvent {
  return { kind: 'enemy-hit', x, y, damage, defId: 'skiff', lethal }
}

function killed(x = 100, y = 200, scrap = 3): SimEvent {
  return { kind: 'enemy-killed', x, y, defId: 'skiff', scrap, elite: false }
}

/** Run `ticks` empty ticks, which is what ageing looks like with nothing happening. */
function idle(state: FeelState, ticks: number, startTick = 0): void {
  for (let i = 0; i < ticks; i++) feelTick(state, [], startTick + i)
}

/**
 * A recording stand-in for a 2D context.
 *
 * Enough of the surface for `drawScene` to run headless, and it asserts on the way
 * through that no coordinate is NaN. This is the one class of rendering bug a
 * screenshot review cannot catch: `fillRect(NaN, y, w, h)` draws nothing at all
 * and looks exactly like an effect that was never wired up.
 *
 * `document` does not exist here, so the pre-baked glow sprites are unavailable
 * and `blitGlow` no-ops — the geometry, text, and state-change paths still run.
 */
interface RecordedCall {
  readonly name: string
  readonly args: readonly unknown[]
}

function stubContext(): { ctx: CanvasRenderingContext2D; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const gradient = { addColorStop: (): void => {} }
  const methods = [
    'fillRect',
    'beginPath',
    'arc',
    'moveTo',
    'lineTo',
    'closePath',
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
  ]

  const target: Record<string, unknown> = {
    createRadialGradient: (...args: unknown[]) => {
      calls.push({ name: 'createRadialGradient', args })
      return gradient
    },
    createLinearGradient: (...args: unknown[]) => {
      calls.push({ name: 'createLinearGradient', args })
      return gradient
    },
    measureText: (text: string) => ({ width: String(text).length * 7 }),
  }
  for (const name of methods) {
    target[name] = (...args: unknown[]): void => {
      calls.push({ name, args })
    }
  }

  return { ctx: target as unknown as CanvasRenderingContext2D, calls }
}

function assertNoNaN(calls: readonly RecordedCall[]): void {
  for (const call of calls) {
    for (const arg of call.args) {
      if (typeof arg === 'number') {
        expect(Number.isFinite(arg), `${call.name} received ${String(arg)}`).toBe(true)
      }
      if (typeof arg === 'string') {
        expect(arg, `${call.name} received a NaN in a colour string`).not.toContain('NaN')
      }
    }
  }
}

function bullet(x: number, y: number, vy: number): Bullet {
  return { x, y, prevX: x, prevY: y - vy / 60, vx: 0, vy, damage: 4, radius: 2.5, alive: true }
}

function enemyBullet(x: number, y: number, kind: EnemyBullet['kind']): EnemyBullet {
  return { x, y, prevX: x, prevY: y - 2, vx: 0, vy: 120, damage: 6, radius: 3, alive: true, kind }
}

function enemy(overrides: Partial<EnemyInstance> = {}): EnemyInstance {
  return {
    uid: 1,
    defId: 'skiff',
    hp: 6,
    maxHp: 30,
    radius: 11,
    shape: 'skiff',
    movement: 'sine',
    elite: false,
    x: 120,
    y: 180,
    prevX: 119,
    prevY: 176,
    vx: 0,
    vy: 40,
    age: 30,
    phase: 'holding',
    fireCooldown: 4,
    contactDamage: 8,
    scrap: 3,
    alive: true,
    hitFlashTicks: 3,
    telegraphTicks: 8,
    telegraphTotal: 24,
    originX: 120,
    holdY: 180,
    ...overrides,
  }
}

function worldFixture(shake: number, freezeTicks: number): WorldView {
  const hull: Hull = {
    x: 224,
    y: 610,
    prevX: 222,
    prevY: 611,
    integrity: 18,
    maxIntegrity: 100,
    shield: 12,
    maxShield: 40,
    invulnTicks: 20,
    radius: 5,
  }
  return {
    seed: 'TEST-SEED',
    runState: 'active',
    // M5 view fields. Fixtures state them explicitly rather than spreading a shared
    // default, so adding a WorldView field fails here and someone decides what the
    // fixture should say instead of inheriting a silent placeholder.
    stage: { index: 0, count: 1, sectorId: 'debris-shelf', sectorName: 'Debris Shelf', bossName: null },
    hullName: 'Lien',
    hullId: 'lien',
    boss: null,
    hazards: [],
    choiceResolve: null,
    choiceSelection: -1,
    inventory: [],
    activeInteractions: [],
    resolvedStats: {},
    pendingChoice: null,
    hull,
    playerBullets: [bullet(224, 400, -620), bullet(219, 300, -620), bullet(228, 120, -620)],
    enemyBullets: [
      enemyBullet(200, 300, 'pellet'),
      enemyBullet(240, 340, 'shard'),
      enemyBullet(260, 380, 'tracker'),
    ],
    enemies: [
      enemy(),
      enemy({ shape: 'mine', elite: true, x: 300, y: -60, telegraphTicks: 1, telegraphTotal: 30 }),
      enemy({ shape: 'turret', telegraphTicks: 0, telegraphTotal: 0, hitFlashTicks: 0 }),
    ],
    explosions: [
      { x: 150, y: 200, age: 0, lifetime: 24, radius: 26, kind: 'enemy' },
      { x: 350, y: 500, age: 12, lifetime: 24, radius: 30, kind: 'mine' },
      { x: 224, y: 610, age: 40, lifetime: 48, radius: 34, kind: 'hull' },
    ],
    stats: {
      tick: 137,
      shotsFired: 400,
      hits: 220,
      kills: 14,
      scrap: 40,
      damageTaken: 82,
      waveIndex: 9,
      peakProjectiles: 300,
      bulletsCulled: 60,
    },
    incident: null,
    events: [],
    cosmetic: { shake },
    freezeTicks,
  }
}

describe('scene drawing', () => {
  it('draws a dense frame without producing a single NaN coordinate', () => {
    const state = createFeelState()
    feelTick(
      state,
      [
        hit(120, 180, 4),
        killed(350, 500, 3),
        { kind: 'hull-hit', x: 224, y: 610, damage: 7, absorbedByShield: false },
        { kind: 'shield-broken', x: 224, y: 610 },
        { kind: 'player-shot', x: 224, y: 596 },
      ],
      137,
    )

    for (const shake of [0, 0.4, 1]) {
      for (const freeze of [0, 3]) {
        for (const alpha of [0, 0.5, 1]) {
          const { ctx, calls } = stubContext()
          drawScene(ctx, worldFixture(shake, freeze), new Starfield('TEST-SEED'), alpha, {
            feel: state,
            shakeScale: 1,
          })
          expect(calls.length).toBeGreaterThan(0)
          assertNoNaN(calls)
        }
      }
    }
  })

  it('never draws a label glyph over the instrument panel column', () => {
    // The rule-1 edge case: a legal anchor near the right edge plus a wide label
    // ("SHIELD DOWN" is ~90 units) reaches into the panel unless the *text width*
    // is accounted for.
    const state = createFeelState()
    feelTick(
      state,
      [
        { kind: 'shield-broken', x: PLAYFIELD_W - 4, y: 300 },
        { kind: 'hull-hit', x: 2, y: 700, damage: 12, absorbedByShield: true },
      ],
      1,
    )
    const { ctx, calls } = stubContext()
    drawScene(ctx, worldFixture(0, 0), new Starfield('TEST-SEED'), 0.5, { feel: state })
    const glyphs = calls.filter((c) => c.name === 'fillText')
    expect(glyphs.length).toBeGreaterThan(0)
    for (const glyph of glyphs) {
      const x = glyph.args[1]
      expect(typeof x).toBe('number')
      expect(x as number).toBeGreaterThanOrEqual(0)
      expect(x as number).toBeLessThanOrEqual(PLAYFIELD_W)
    }
  })

  it('clips the playfield before shaking it, so the instrument panel cannot move', () => {
    const { ctx, calls } = stubContext()
    drawScene(ctx, worldFixture(1, 0), new Starfield('TEST-SEED'), 0.5, { shakeScale: 1 })

    const clipIndex = calls.findIndex((c) => c.name === 'clip')
    const translateIndex = calls.findIndex((c) => c.name === 'translate')
    expect(clipIndex).toBeGreaterThanOrEqual(0)
    expect(translateIndex).toBeGreaterThan(clipIndex)
    // The clip is the playfield rect and nothing wider: the panel column is the
    // one thing shake may never touch (UI rule 1 plus a readable HUD).
    const rectCall = calls[clipIndex - 1]
    expect(rectCall?.name).toBe('rect')
    expect(rectCall?.args).toEqual([0, 0, PLAYFIELD_W, PLAYFIELD_H])
  })

  it('does not touch the transform at all when shake is disabled', () => {
    const { calls } = (() => {
      const stub = stubContext()
      drawScene(stub.ctx, worldFixture(1, 0), new Starfield('TEST-SEED'), 0.5, { shakeScale: 0 })
      return stub
    })()
    // `clip` is unique to the shake path (enemy silhouettes translate on their own
    // account), so its absence is the check that reduced motion really is a
    // no-op rather than a very small shake.
    expect(calls.some((c) => c.name === 'clip')).toBe(false)
    const shaken = stubContext()
    drawScene(shaken.ctx, worldFixture(1, 0), new Starfield('TEST-SEED'), 0.5, { shakeScale: 1 })
    expect(shaken.calls.some((c) => c.name === 'clip')).toBe(true)
  })

  it('holds the frame during hitstop instead of interpolating past it', () => {
    // Frozen sim, so the two frames of one tick must be byte-identical: alpha is
    // pinned, which is what makes hitstop read as contact.
    const first = stubContext()
    drawScene(first.ctx, worldFixture(0, 4), new Starfield('TEST-SEED'), 0.1, {})
    const second = stubContext()
    drawScene(second.ctx, worldFixture(0, 4), new Starfield('TEST-SEED'), 0.9, {})
    expect(JSON.stringify(second.calls)).toBe(JSON.stringify(first.calls))
  })

  it('interpolates normally when the sim is not frozen', () => {
    const first = stubContext()
    drawScene(first.ctx, worldFixture(0, 0), new Starfield('TEST-SEED'), 0.1, {})
    const second = stubContext()
    drawScene(second.ctx, worldFixture(0, 0), new Starfield('TEST-SEED'), 0.9, {})
    expect(JSON.stringify(second.calls)).not.toBe(JSON.stringify(first.calls))
  })
})

describe('screen shake', () => {
  it('never exceeds the cap for any energy in 0..1', () => {
    for (let tick = 0; tick < 400; tick++) {
      for (let step = 0; step <= 40; step++) {
        const { x, y } = shakeOffset(tick, step / 40)
        expect(Math.abs(x)).toBeLessThanOrEqual(MAX_SHAKE_UNITS + 1e-9)
        expect(Math.abs(y)).toBeLessThanOrEqual(MAX_SHAKE_UNITS + 1e-9)
        // The cap is a real distance, not a per-axis bound a diagonal can beat.
        expect(Math.hypot(x, y)).toBeLessThanOrEqual(MAX_SHAKE_UNITS + 1e-9)
      }
    }
  })

  it('never exceeds the cap for out-of-range or hostile inputs', () => {
    const inputs = [-5, -1, -0.0001, 0, 1.0001, 2, 1e6, Number.POSITIVE_INFINITY, Number.NaN]
    for (const energy of inputs) {
      for (const multiplier of inputs) {
        for (const tick of [0, 1, 37, 1e9, Number.NaN, Number.POSITIVE_INFINITY]) {
          const { x, y } = shakeOffset(tick, energy, multiplier)
          expect(Number.isFinite(x)).toBe(true)
          expect(Number.isFinite(y)).toBe(true)
          expect(Math.hypot(x, y)).toBeLessThanOrEqual(MAX_SHAKE_UNITS + 1e-9)
        }
      }
    }
  })

  it('is exactly zero at a zero multiplier, at any energy', () => {
    for (let tick = 0; tick < 120; tick++) {
      for (const energy of [0, 0.25, 0.5, 1, 5, Number.NaN]) {
        expect(shakeOffset(tick, energy, 0)).toEqual({ x: 0, y: 0 })
      }
    }
  })

  it('is exactly zero at zero energy, so a quiet sim never nudges the playfield', () => {
    for (let tick = 0; tick < 120; tick++) {
      expect(shakeOffset(tick, 0)).toEqual({ x: 0, y: 0 })
    }
  })

  it('scales with the multiplier without changing direction', () => {
    const full = shakeOffset(41, 1, 1)
    const half = shakeOffset(41, 1, 0.5)
    expect(half.x).toBeCloseTo(full.x / 2, 10)
    expect(half.y).toBeCloseTo(full.y / 2, 10)
  })

  it('is deterministic for the same tick and energy', () => {
    // The property screenshots and replays depend on: no Math.random(), no
    // accumulated state, no frame counter.
    for (let tick = 0; tick < 200; tick += 7) {
      const first = shakeOffset(tick, 0.63, 0.8)
      const second = shakeOffset(tick, 0.63, 0.8)
      expect(second).toEqual(first)
    }
  })

  it('actually moves the playfield at full energy', () => {
    // A capped shake that is always ~0 would pass every other test in here.
    let peak = 0
    for (let tick = 0; tick < 60; tick++) {
      const { x, y } = shakeOffset(tick, 1)
      peak = Math.max(peak, Math.hypot(x, y))
    }
    expect(peak).toBeGreaterThan(MAX_SHAKE_UNITS * 0.6)
  })

  it('does not oscillate faster than half the tick rate on either axis', () => {
    // Rule 10 is written about luminance, but a 30Hz positional jitter is its own
    // accessibility problem. Count sign changes of the x offset over a second.
    let changes = 0
    let previous = shakeOffset(0, 1).x
    for (let tick = 1; tick < 60; tick++) {
      const current = shakeOffset(tick, 1).x
      if (Math.sign(current) !== Math.sign(previous) && current !== 0) changes++
      previous = current
    }
    // Measured: 21 sign changes per second, i.e. ~10.5Hz. Two sign changes per
    // cycle, so this bound keeps the rattle under 15Hz and nowhere near the
    // per-tick jitter (60Hz) that an offset sampled from noise would produce.
    expect(changes).toBeLessThan(30)
  })
})

describe('label pool', () => {
  it('never exceeds its cap when fed hundreds of events in one tick', () => {
    const state = createFeelState()
    const events: SimEvent[] = []
    for (let i = 0; i < 400; i++) {
      // Spread far enough apart that nothing merges — the worst case for the cap.
      events.push(hit((i * 37) % PLAYFIELD_W, (i * 53) % PLAYFIELD_H, 3 + (i % 5)))
    }
    feelTick(state, events, 1)
    expect(state.labels.length).toBeLessThanOrEqual(MAX_LABELS)
  })

  it('never exceeds its cap across a long dense fight', () => {
    const state = createFeelState()
    for (let tick = 0; tick < 600; tick++) {
      const events: SimEvent[] = [
        hit((tick * 17) % PLAYFIELD_W, (tick * 31) % PLAYFIELD_H, 4),
        killed((tick * 13) % PLAYFIELD_W, (tick * 7) % PLAYFIELD_H, 2),
        { kind: 'hull-hit', x: 200, y: 600, damage: 6, absorbedByShield: tick % 2 === 0 },
        { kind: 'player-shot', x: 200, y: 590 },
      ]
      feelTick(state, events, tick)
      expect(state.labels.length).toBeLessThanOrEqual(MAX_LABELS)
      expect(state.sparks.length).toBe(MAX_SPARKS)
    }
  })

  it('keeps hull damage when the pool is full of damage numbers', () => {
    const state = createFeelState()
    const flood: SimEvent[] = []
    for (let i = 0; i < 200; i++) {
      flood.push(hit((i * 37) % PLAYFIELD_W, (i * 53) % PLAYFIELD_H, 3))
    }
    feelTick(state, flood, 1)
    feelTick(state, [{ kind: 'hull-hit', x: 220, y: 610, damage: 9, absorbedByShield: false }], 2)
    expect(state.labels.some((l) => l.kind === 'hull')).toBe(true)
    expect(state.labels.length).toBeLessThanOrEqual(MAX_LABELS)
  })

  it('aggregates repeated hits on one target into a single running total', () => {
    const state = createFeelState()
    // 20 shots/second on one enemy must not be 20 numbers. This is the whole
    // legibility argument for the feature.
    for (let tick = 0; tick < 30; tick += 3) {
      feelTick(state, [hit(120, 240 + (tick % 4), 4)], tick)
    }
    const damageLabels = state.labels.filter((l) => l.kind === 'damage')
    expect(damageLabels.length).toBe(1)
    expect(damageLabels[0]?.value).toBe(40)
    expect(damageLabels[0]?.text).toBe('-40')
  })

  it('does not print a damage number for the killing blow', () => {
    // The explosion and the scrap label already announce it; a third readout in
    // the same 20 pixels is noise.
    const state = createFeelState()
    feelTick(state, [hit(120, 240, 7, true), killed(120, 240, 5)], 1)
    expect(state.labels.filter((l) => l.kind === 'damage').length).toBe(0)
    expect(state.labels.filter((l) => l.kind === 'scrap').length).toBe(1)
  })

  it('reports scrap once when a kill and a collection land on the same tick', () => {
    const state = createFeelState()
    feelTick(
      state,
      [killed(100, 300, 4), { kind: 'scrap-collected', x: 100, y: 300, amount: 4 }],
      1,
    )
    const scrap = state.labels.filter((l) => l.kind === 'scrap')
    expect(scrap.length).toBe(1)
    expect(scrap[0]?.value).toBe(4)
  })

  it('labels hull damage with the pool that absorbed it', () => {
    const state = createFeelState()
    feelTick(state, [{ kind: 'hull-hit', x: 200, y: 600, damage: 8, absorbedByShield: true }], 1)
    feelTick(state, [{ kind: 'hull-hit', x: 200, y: 600, damage: 5, absorbedByShield: false }], 2)
    const texts = state.labels.filter((l) => l.kind === 'hull').map((l) => l.text)
    expect(texts).toContain('-8 shield')
    expect(texts).toContain('-5 hp')
  })
})

describe('ageing', () => {
  it('removes labels after their lifetime, per tick', () => {
    const state = createFeelState()
    feelTick(state, [hit()], 1)
    expect(state.labels.length).toBe(1)
    idle(state, 200, 2)
    expect(state.labels.length).toBe(0)
  })

  it('ages by tick count, not by how many frames were drawn', () => {
    // The bug this guards: draining events or ageing inside the render callback.
    // Under ?ff=32 that stretches every effect 32× and drops 31 ticks of events.
    const perTick = createFeelState()
    feelTick(perTick, [hit()], 1)
    idle(perTick, 20, 2)

    const fastForwarded = createFeelState()
    feelTick(fastForwarded, [hit()], 1)
    // Same 20 ticks, but delivered as if many ticks ran inside one frame: the
    // state must be identical, because feelTick knows nothing about frames.
    for (let i = 0; i < 4; i++) idle(fastForwarded, 5, 2 + i * 5)

    expect(fastForwarded.labels[0]?.age).toBe(perTick.labels[0]?.age)
    // 21, not 20: a label ages on the tick it was created, since feelTick ingests
    // and then ages. What matters is that both paths agree exactly.
    expect(fastForwarded.labels[0]?.age).toBe(21)
  })

  it('frees spark slots without growing the pool', () => {
    const state = createFeelState()
    for (let i = 0; i < 300; i++) {
      feelTick(state, [hit((i * 41) % PLAYFIELD_W, (i * 29) % PLAYFIELD_H, 5)], i)
      expect(state.sparks.length).toBe(MAX_SPARKS)
    }
    idle(state, 40, 300)
    expect(state.sparks.every((s) => s.age >= 7)).toBe(true)
  })

  it('settles muzzle heat smoothly and releases it', () => {
    const state = createFeelState()
    // Sustained fire: one shot every three ticks, the real cadence.
    let previous = 0
    let maxJump = 0
    for (let tick = 0; tick < 90; tick++) {
      const events: SimEvent[] = tick % 3 === 0 ? [{ kind: 'player-shot', x: 10, y: 10 }] : []
      feelTick(state, events, tick)
      maxJump = Math.max(maxJump, Math.abs(state.muzzleHeat - previous))
      previous = state.muzzleHeat
    }
    expect(state.muzzleHeat).toBeGreaterThan(0.9)
    // No step big enough to read as a flash: this is what stops 20 shots/second
    // from becoming a 20Hz strobe on the muzzle (UI rule 10).
    expect(maxJump).toBeLessThan(0.15)

    idle(state, 200, 90)
    expect(state.muzzleHeat).toBe(0)
  })

  it('resets to empty for a new sortie', () => {
    const state = createFeelState()
    feelTick(state, [hit(), killed()], 1)
    resetFeelState(state)
    expect(state.labels.length).toBe(0)
    expect(state.muzzleHeat).toBe(0)
    expect(state.sparks.every((s) => s.age >= 7)).toBe(true)
  })
})

describe('no NaN reaches the canvas', () => {
  it('keeps label positions finite and inside the playfield', () => {
    const state = createFeelState()
    const nasty: SimEvent[] = [
      hit(Number.NaN, Number.NaN, Number.NaN),
      hit(Number.POSITIVE_INFINITY, -1e9, 1e9),
      hit(-500, 5000, -3),
      killed(Number.NaN, 0, Number.POSITIVE_INFINITY),
      { kind: 'hull-hit', x: Number.NaN, y: Number.NaN, damage: Number.NaN, absorbedByShield: false },
      { kind: 'shield-broken', x: Number.NaN, y: Number.NaN },
    ]
    feelTick(state, nasty, 1)

    for (let tick = 0; tick < 60; tick++) {
      for (const alpha of [0, 0.5, 1, Number.NaN]) {
        for (const label of state.labels) {
          const { x, y } = labelPosition(label, alpha)
          expect(Number.isFinite(x)).toBe(true)
          expect(Number.isFinite(y)).toBe(true)
          // Rule 1: never over the instrument panel column.
          expect(x).toBeGreaterThanOrEqual(0)
          expect(x).toBeLessThanOrEqual(PLAYFIELD_W)
          expect(y).toBeGreaterThanOrEqual(0)
          expect(y).toBeLessThanOrEqual(PLAYFIELD_H)
        }
      }
      feelTick(state, [], tick + 2)
    }
  })

  it('keeps label text free of NaN', () => {
    const state = createFeelState()
    feelTick(state, [hit(50, 50, Number.NaN), killed(300, 300, Number.NaN)], 1)
    for (const label of state.labels) expect(label.text).not.toContain('NaN')
  })

  it('keeps opacity in 0..1 and monotone at the ends', () => {
    for (const t of [-1, 0, 0.05, 0.3, 0.7, 1, 2, Number.NaN]) {
      const value = labelOpacity(t)
      expect(Number.isFinite(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
    expect(labelOpacity(1)).toBe(0)
    // Fades in rather than appearing at full brightness.
    expect(labelOpacity(0)).toBeLessThan(1)
    expect(labelOpacity(0.3)).toBe(1)
  })
})
