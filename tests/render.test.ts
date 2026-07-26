/**
 * Boss, hazard, and accessibility rendering, tested headless.
 *
 * These are the interface rules that a screenshot review is bad at. A human looking at
 * a frame can see that the boss bar is ugly; they cannot see that its warning band
 * pulses at 4Hz, that a panel element is two units inside the playfield, or that
 * `reduceFlashes` quietly stopped attenuating one effect out of nine. Every assertion
 * here is written against a value the renderer actually computes — the layout
 * constants are imported rather than restated, and the pulse frequency is *measured*
 * from the emitted waveform rather than compared to a comment.
 *
 * The stub context records both calls and state changes, so an effect's brightness can
 * be reconstructed from what it drew instead of from what it says it does.
 */

import { beforeAll, describe, expect, it } from 'vitest'
import { PLAYFIELD_H, PLAYFIELD_W, VIRTUAL_H, VIRTUAL_W } from '../src/core/space'
import { Panel } from '../src/render/layout'
import { TICK_HZ } from '../src/core/loop'
import type {
  Bullet,
  EnemyBullet,
  EnemyInstance,
  HazardView,
  Hull,
  StageView,
  WorldView,
} from '../src/sim/entities'
import { BOSSES } from '../src/content/bosses'
import {
  BOSS_NAME_SIZE,
  bossBarBlocks,
  bossNameLines,
  bossThresholdMarks,
  CALLOUT_BOTTOM,
  CALLOUT_TOP,
  calloutOpacity,
  drawBossCallout,
  drawBossHealthBar,
  drawBossHull,
} from '../src/render/boss'
import {
  blackoutDepth,
  drawBlackout,
  drawHazardBlock,
  hazardStatus,
} from '../src/render/hazards'
import {
  drawExplosions,
  drawHitFlash,
  drawHitSpark,
  drawInvulnRing,
  drawTelegraph,
  hitFlashStrength,
} from '../src/render/effects'
import {
  createFeelState,
  drawFeelShells,
  drawMuzzleGlow,
  feelTick,
  MAX_SHELLS,
  SHELL_LIFETIME,
  type Shell,
} from '../src/render/feel'
import { drawHull, drawLowIntegrityRim, drawScene } from '../src/render/scene'
import { drawPanel, type PanelState } from '../src/render/panel'
import { PULSE_HZ, PULSE_RATE, pulse, REDUCED_FLASH_SCALE } from '../src/render/intensity'
import { Palette } from '../src/render/palette'
import { formatSeconds, type Measure } from '../src/render/text'
import { Starfield } from '../src/render/starfield'

// ---------------------------------------------------------------------------
// a recording 2D context
// ---------------------------------------------------------------------------

interface Recorded {
  readonly name: string
  readonly args: readonly unknown[]
  readonly fillStyle: string
  readonly strokeStyle: string
  readonly globalAlpha: number
}

interface Stub {
  ctx: CanvasRenderingContext2D
  calls: Recorded[]
}

const METHODS = [
  'fillRect',
  'strokeRect',
  'clearRect',
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
  'scale',
  'drawImage',
  'fillText',
  'strokeText',
] as const

function makeStub(): Stub {
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
  const gradient = { addColorStop: (): void => {} }
  const target: Record<string, unknown> = {
    measureText: (text: string) => ({ width: String(text).length * 7 }),
    createRadialGradient: (...args: unknown[]) => {
      calls.push({ name: 'createRadialGradient', args, ...snapshot() })
      return gradient
    },
    createLinearGradient: (...args: unknown[]) => {
      calls.push({ name: 'createLinearGradient', args, ...snapshot() })
      return gradient
    },
  }

  function snapshot(): Pick<Recorded, 'fillStyle' | 'strokeStyle' | 'globalAlpha'> {
    return {
      fillStyle: String(state.fillStyle),
      strokeStyle: String(state.strokeStyle),
      globalAlpha: state.globalAlpha,
    }
  }

  for (const name of METHODS) {
    target[name] = (...args: unknown[]): void => {
      calls.push({ name, args, ...snapshot() })
    }
  }

  // Property writes are recorded too: a pulse lives in `globalAlpha` and in the alpha
  // channel of a colour string, never in an argument list.
  for (const key of Object.keys(state) as (keyof typeof state)[]) {
    Object.defineProperty(target, key, {
      get: () => state[key],
      set: (value: never) => {
        state[key] = value
        calls.push({ name: `set:${key}`, args: [value], ...snapshot() })
      },
    })
  }

  return { ctx: target as unknown as CanvasRenderingContext2D, calls }
}

/**
 * `document`, so the pre-baked glow sprites exist and `blitGlow` records real alphas.
 *
 * Without it every additive effect silently no-ops, and a test that measures glow
 * brightness would pass by measuring nothing at all.
 */
beforeAll(() => {
  const canvasLike = {
    width: 0,
    height: 0,
    getContext: () => ({
      createRadialGradient: () => ({ addColorStop: (): void => {} }),
      fillRect: (): void => {},
      fillStyle: '',
    }),
  }
  ;(globalThis as { document?: unknown }).document = {
    createElement: () => canvasLike,
  }
})

/** Alpha carried by a call: `globalAlpha`, plus the alpha of any rgba colour in use. */
function alphaOf(call: Recorded): number[] {
  const out = [call.globalAlpha]
  for (const style of [call.fillStyle, call.strokeStyle]) {
    const match = /rgba?\([^)]*?,\s*([\d.]+)\s*\)/.exec(style)
    if (match?.[1]) out.push(Number(match[1]))
  }
  // drawImage is the glow blit; its brightness is the globalAlpha at the time.
  return out.filter((value) => Number.isFinite(value))
}

/** Everything an effect emitted that a photosensitive player would perceive. */
function intensitySignature(calls: readonly Recorded[]): number[] {
  const out: number[] = []
  for (const call of calls) {
    if (call.name.startsWith('set:') && call.name !== 'set:globalAlpha') continue
    for (const value of alphaOf(call)) out.push(Number(value.toFixed(5)))
  }
  // Geometry counts as light too — see emittingGeometry.
  for (const value of emittingGeometry(calls)) out.push(value)
  return out
}

/**
 * Coordinates of anything drawn additively, so a modulated *area* registers as light.
 *
 * THE HOLE THIS FILLS, and it is the reason a real strobe shipped. Everything above
 * measures alpha, and alpha is only half of how much light an additive layer emits:
 * the other half is how big it is. The player's engine plume held its alpha perfectly
 * constant and modulated its LENGTH between 8.8 and 22 units at 8.59 Hz — squarely in
 * the photosensitive band, on the object a player stares at for a whole run — and this
 * suite would have returned "does not appear to animate at all" if the plume had been
 * on its list, because not one alpha in it ever moved.
 *
 * So a rule-10 harness that only watches alpha does not enforce rule 10. It enforces a
 * proxy for it, and the difference is a seizure risk.
 *
 * Only `'lighter'` calls are included. Under `source-over` a moving coordinate is
 * usually an entity travelling, which is motion rather than flashing; under `lighter`
 * a changing extent is strictly more emitted light.
 */
function emittingGeometry(calls: readonly Recorded[]): number[] {
  const out: number[] = []
  let additive = false
  for (const call of calls) {
    if (call.name === 'set:globalCompositeOperation') {
      additive = String(call.args[0]) === 'lighter'
      continue
    }
    if (!additive) continue
    for (const arg of call.args) {
      if (typeof arg === 'number' && Number.isFinite(arg)) out.push(Number(arg.toFixed(4)))
    }
  }
  return out
}

/**
 * The brightness of every additive glow blit, in order.
 *
 * This is the sharp end of the `reduceFlashes` check. Comparing whole signatures only
 * proves that *something* about an effect changed, which a composite effect can pass
 * while one of its layers quietly ignores the setting — verified by mutation: deleting
 * the attenuation from the explosion's flash stab alone still changed the signature,
 * because the body and core layers were still honouring it. Every glow the renderer
 * emits is light and nothing else, so every one of them must dim.
 */
function glowAlphas(calls: readonly Recorded[]): number[] {
  return calls
    .filter((call) => call.name === 'drawImage')
    .map((call) => Number(call.globalAlpha.toFixed(5)))
}

function assertNoNaN(calls: readonly Recorded[]): void {
  for (const call of calls) {
    for (const arg of call.args) {
      if (typeof arg === 'number') {
        expect(Number.isFinite(arg), `${call.name} received ${String(arg)}`).toBe(true)
      }
      if (typeof arg === 'string') {
        expect(arg, `${call.name} emitted NaN in a string`).not.toContain('NaN')
      }
    }
  }
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const THRESHOLDS = [1, 0.62, 0.28] as const

function bossEnemy(overrides: Partial<EnemyInstance> = {}, hp = 900): EnemyInstance {
  return {
    uid: 7,
    defId: 'auditor#0',
    hp,
    maxHp: 1200,
    radius: 46,
    shape: 'hauler',
    movement: 'sine',
    elite: true,
    x: 224,
    y: 170,
    prevX: 222,
    prevY: 168,
    vx: 0,
    vy: 0,
    age: 120,
    phase: 'holding',
    fireCooldown: 12,
    contactDamage: 22,
    scrap: 40,
    alive: true,
    hitFlashTicks: 0,
    telegraphTicks: 0,
    telegraphTotal: 0,
    originX: 224,
    holdY: 170,
    boss: {
      bossId: 'auditor',
      name: 'Sledge Auditor',
      variantId: null,
      phaseIndex: 1,
      phaseDefIds: ['auditor#0', 'auditor#1', 'auditor#2'],
      thresholds: [...THRESHOLDS],
      callouts: ['Ledger open.', 'Recount. It brings the drills out.', 'Final demand.'],
      calloutTicks: 0,
    },
    ...overrides,
  }
}

function hazard(overrides: Partial<HazardView> = {}): HazardView {
  return {
    id: 'debris-fall',
    name: 'Debris Fall',
    hazardKind: 'debris',
    description: 'Wreckage drops in five lanes.',
    phase: 'idle',
    ticksToChange: 240,
    progress: 0.3,
    ...overrides,
  }
}

const STAGE: StageView = {
  index: 1,
  count: 3,
  sectorId: 'tally',
  sectorName: 'The Tally',
  bossName: 'Sledge Auditor',
}

function bullet(x: number, y: number): Bullet {
  return { x, y, prevX: x, prevY: y + 10, vx: 0, vy: -620, damage: 4, radius: 2.5, alive: true }
}

function enemyBullet(x: number, y: number, kind: EnemyBullet['kind']): EnemyBullet {
  return { x, y, prevX: x, prevY: y - 2, vx: 0, vy: 120, damage: 6, radius: 3, alive: true, kind }
}

function worldFixture(overrides: Partial<WorldView> = {}): WorldView {
  const hull: Hull = {
    x: 224,
    y: 610,
    prevX: 223,
    prevY: 611,
    integrity: 70,
    maxIntegrity: 100,
    shield: 20,
    maxShield: 40,
    invulnTicks: 0,
    radius: 5,
  }
  return {
    seed: 'TEST-SEED',
    runState: 'active',
    choiceResolve: null,
    hull,
    playerBullets: [bullet(224, 420)],
    enemyBullets: [
      enemyBullet(200, 300, 'pellet'),
      enemyBullet(240, 340, 'shard'),
      enemyBullet(260, 380, 'tracker'),
    ],
    enemies: [],
    explosions: [],
    stats: {
      tick: 600,
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
    resolvedStats: { projectileDamage: 6 },
    pendingChoice: null,
    freezeTicks: 0,
    stage: STAGE,
    hullName: 'Lien',
    boss: null,
    hazards: [],
    ...overrides,
  }
}

function panelState(overrides: Partial<PanelState> = {}): PanelState {
  return {
    pilotNumber: 12,
    hullName: 'Fallback Hull',
    weaponName: 'Twin Pulse',
    fireRate: 6.4,
    waveCount: 9,
    ...overrides,
  }
}

/**
 * Every x a call put ink at, INCLUDING the far edge of a string.
 *
 * Measuring the anchor alone is how a text overflow hides from a test: the panel's
 * boss hp readout was drawn left-aligned from the column's right edge, so its anchor
 * was legally inside the panel while the glyphs ran off the screen. A capture showed
 * it in a second; this now shows it too. The 7-units-per-character figure is the stub
 * `measureText`, i.e. exactly what the renderer laid out against.
 */
function inkX(call: Recorded): number[] {
  const [a, b] = call.args as [unknown, unknown]
  const x = typeof a === 'number' ? a : null
  switch (call.name) {
    case 'fillRect':
    case 'strokeRect':
    case 'rect': {
      const w = call.args[2]
      return x !== null && typeof w === 'number' ? [x, x + w] : []
    }
    case 'arc': {
      const r = call.args[2]
      return x !== null && typeof r === 'number' ? [x - r, x + r] : []
    }
    case 'fillText':
    case 'strokeText':
      return typeof b === 'number' ? [b, b + String(a).length * 7] : []
    case 'moveTo':
    case 'lineTo':
    case 'translate':
      return x !== null ? [x] : []
    default:
      return []
  }
}

function inkY(call: Recorded): number[] {
  switch (call.name) {
    case 'fillRect':
    case 'strokeRect':
    case 'rect': {
      const y = call.args[1]
      const h = call.args[3]
      return typeof y === 'number' && typeof h === 'number' ? [y, y + h] : []
    }
    case 'arc': {
      const y = call.args[1]
      const r = call.args[2]
      return typeof y === 'number' && typeof r === 'number' ? [y - r, y + r] : []
    }
    case 'fillText':
    case 'strokeText': {
      const y = call.args[2]
      return typeof y === 'number' ? [y] : []
    }
    case 'moveTo':
    case 'lineTo':
      return typeof call.args[1] === 'number' ? [call.args[1] as number] : []
    default:
      return []
  }
}

// ---------------------------------------------------------------------------
// rule 1 — the HUD never overlaps the playfield
// ---------------------------------------------------------------------------

describe('UI rule 1: nothing the panel draws lands in the playfield', () => {
  const cases: ReadonlyArray<readonly [string, WorldView]> = [
    ['quiet panel', worldFixture()],
    [
      'boss and two hazards',
      worldFixture({
        boss: bossEnemy(),
        enemies: [bossEnemy()],
        hazards: [
          hazard({ phase: 'warning', ticksToChange: 42, progress: 0.3 }),
          hazard({
            id: 'blackout',
            name: 'Grid Failure',
            hazardKind: 'blackout',
            description: 'The sector lighting drops for two seconds at a time.',
            phase: 'active',
            ticksToChange: 90,
            progress: 0.4,
          }),
        ],
        inventory: [
          { defId: 'coin-op-cannon', acquiredAtTick: 10, count: 2 },
          { defId: 'ablative-plating', acquiredAtTick: 40, count: 1 },
          { defId: 'long-barrel', acquiredAtTick: 90, count: 1 },
        ],
        activeInteractions: [{ defId: 'x', text: 'y' }],
      }),
    ],
  ]

  for (const [name, view] of cases) {
    it(`draws entirely inside the instrument column (${name})`, () => {
      const { ctx, calls } = makeStub()
      drawPanel(ctx, view, panelState())

      expect(calls.length).toBeGreaterThan(0)
      assertNoNaN(calls)

      // The bound is the real one: the panel column starts where the playfield ends.
      for (const call of calls) {
        for (const x of inkX(call)) {
          expect(x, `${call.name} drew at x=${x}, inside the playfield`).toBeGreaterThanOrEqual(
            PLAYFIELD_W,
          )
          expect(x, `${call.name} drew at x=${x}, past the window`).toBeLessThanOrEqual(VIRTUAL_W)
        }
        for (const y of inkY(call)) {
          expect(y).toBeGreaterThanOrEqual(-1)
          expect(y).toBeLessThanOrEqual(VIRTUAL_H + 1)
        }
      }
    })
  }

  it('agrees with the layout module about where the column is', () => {
    expect(Panel.x).toBe(PLAYFIELD_W)
    expect(Panel.contentX).toBeGreaterThanOrEqual(PLAYFIELD_W)
    expect(Panel.contentX + Panel.contentW).toBeLessThanOrEqual(VIRTUAL_W)
  })

  /**
   * Find a tracked heading, which `drawText` emits one glyph per call.
   *
   * Returns the call index where the run starts and the y it was drawn at, so a test
   * can say "everything drawn before this heading must be above it".
   */
  function findGlyphRun(
    calls: readonly Recorded[],
    text: string,
  ): { index: number; y: number } | null {
    const glyphs = [...text]
    const textCalls: Array<{ index: number; glyph: string; y: number }> = []
    calls.forEach((call, index) => {
      if (call.name === 'fillText') {
        textCalls.push({ index, glyph: String(call.args[0]), y: Number(call.args[2]) })
      }
    })
    for (let i = 0; i + glyphs.length <= textCalls.length; i++) {
      if (glyphs.every((glyph, offset) => textCalls[i + offset]?.glyph === glyph)) {
        const first = textCalls[i]
        if (first) return { index: first.index, y: first.y }
      }
    }
    return null
  }

  /**
   * The flexible region must never spill into the fixed block beneath it.
   *
   * This is the defect a screenshot caught and no test did: with one hazard and a live
   * boss, the build readout's damage line, overflow count and synergy row together ran
   * through the sortie-log heading. The panel draws strictly top-down, so everything
   * emitted *before* the log heading belongs above it — which makes the check a
   * one-liner over call order rather than a guess at coordinates.
   */
  const CROWDED: ReadonlyArray<readonly [string, WorldView]> = [
    ['boss only', worldFixture({ boss: bossEnemy() })],
    [
      'boss and one hazard and a full build',
      worldFixture({
        boss: bossEnemy(),
        hazards: [hazard({ phase: 'warning', ticksToChange: 36 })],
        inventory: [
          { defId: 'coin-op-cannon', acquiredAtTick: 1, count: 2 },
          { defId: 'ablative-plating', acquiredAtTick: 2, count: 1 },
          { defId: 'long-barrel', acquiredAtTick: 3, count: 1 },
          { defId: 'spare-cells', acquiredAtTick: 4, count: 1 },
          { defId: 'gyro', acquiredAtTick: 5, count: 3 },
        ],
        activeInteractions: [{ defId: 'x', text: 'y' }],
      }),
    ],
    [
      'boss and two hazards and a full build',
      worldFixture({
        boss: bossEnemy(),
        hazards: [
          hazard({ phase: 'warning', ticksToChange: 36 }),
          hazard({ id: 'b', name: 'Grid Failure', hazardKind: 'blackout', phase: 'active' }),
        ],
        inventory: [
          { defId: 'coin-op-cannon', acquiredAtTick: 1, count: 2 },
          { defId: 'ablative-plating', acquiredAtTick: 2, count: 1 },
          { defId: 'gyro', acquiredAtTick: 5, count: 3 },
        ],
        activeInteractions: [{ defId: 'x', text: 'y' }],
      }),
    ],
    ['nothing fitted', worldFixture({ hazards: [hazard()] })],
  ]

  for (const [name, view] of CROWDED) {
    it(`never spills the flexible region into the sortie log (${name})`, () => {
      const { ctx, calls } = makeStub()
      drawPanel(ctx, view, panelState())

      const log = findGlyphRun(calls, 'SORTIE LOG')
      expect(log, 'sortie log heading not found').toBeTruthy()
      if (!log) return

      for (const call of calls.slice(0, log.index)) {
        if (call.name !== 'fillText') continue
        const y = Number(call.args[2])
        expect(
          y,
          `"${String(call.args[0])}" drew at y=${y}, at or below the sortie log at y=${log.y}`,
        ).toBeLessThan(log.y - 4)
      }
    })
  }

  it('keeps the hazard and boss blocks clear of the sortie log below them', () => {
    const { ctx, calls } = makeStub()
    drawPanel(
      ctx,
      worldFixture({
        boss: bossEnemy(),
        hazards: [hazard({ phase: 'warning', ticksToChange: 30 })],
        inventory: [{ defId: 'coin-op-cannon', acquiredAtTick: 1, count: 1 }],
      }),
      panelState(),
    )

    // The sortie log is anchored up from the panel footer and is the first fixed
    // thing below the flexible region. Its Kills row carries the unit "confirmed",
    // which is drawn untracked and so arrives as one string.
    const logRow = calls.find((c) => c.name === 'fillText' && c.args[0] === 'confirmed')
    expect(logRow, 'sortie log not found').toBeTruthy()
    const logY = Number(logRow?.args[2])

    // The boss health bar is the only 9-unit-tall full-width rect in the panel.
    const barBottoms = calls
      .filter((c) => c.name === 'fillRect' && c.args[3] === 9)
      .map((c) => Number(c.args[1]) + 9)
    expect(barBottoms.length).toBeGreaterThan(0)
    expect(Math.max(...barBottoms)).toBeLessThan(logY)
  })
})

// ---------------------------------------------------------------------------
// the phase callout
// ---------------------------------------------------------------------------

describe('boss phase callout', () => {
  it('never reaches the lower two-thirds of the playfield', () => {
    // The rule this encodes: the player flies in the bottom of the field, so an
    // announcement drawn over it is an announcement drawn over the fight.
    expect(CALLOUT_BOTTOM).toBeLessThan(PLAYFIELD_H / 3)

    const long =
      'Recount. It brings the drills out and starts working from the far side of the ledger.'
    const boss = bossEnemy().boss
    expect(boss).toBeTruthy()
    if (!boss) return

    for (const text of [long, 'Ledger open.', '']) {
      const { ctx, calls } = makeStub()
      drawBossCallout(ctx, { ...boss, calloutTicks: 120, callouts: [text, text, text] })
      assertNoNaN(calls)
      for (const call of calls) {
        for (const y of inkY(call)) {
          expect(y, `callout drew at y=${y}`).toBeGreaterThanOrEqual(0)
          expect(y, `callout drew at y=${y}`).toBeLessThan(PLAYFIELD_H / 3)
        }
        for (const x of inkX(call)) {
          expect(x).toBeGreaterThanOrEqual(0)
          expect(x).toBeLessThanOrEqual(PLAYFIELD_W)
        }
      }
    }
  })

  it('is above the boss station rather than over it', () => {
    // A boss holds around y=130-220. The callout must finish before that.
    expect(CALLOUT_TOP).toBeGreaterThan(0)
    expect(CALLOUT_BOTTOM).toBeLessThan(130)
  })

  it('fades out monotonically and vanishes when the sim says it is over', () => {
    let previous = 0
    for (let remaining = 0; remaining <= 120; remaining++) {
      const value = calloutOpacity(remaining)
      expect(value).toBeGreaterThanOrEqual(previous - 1e-9)
      expect(value).toBeLessThanOrEqual(1)
      previous = value
    }
    expect(calloutOpacity(0)).toBe(0)
    expect(calloutOpacity(-5)).toBe(0)
    expect(calloutOpacity(Number.NaN)).toBe(0)

    const boss = bossEnemy().boss
    if (!boss) return
    const { ctx, calls } = makeStub()
    drawBossCallout(ctx, { ...boss, calloutTicks: 0 })
    expect(calls.filter((c) => c.name === 'fillText')).toHaveLength(0)
  })

  it('announces in caution, never in danger', () => {
    const boss = bossEnemy().boss
    if (!boss) return
    const { ctx, calls } = makeStub()
    drawBossCallout(ctx, { ...boss, calloutTicks: 120 })
    const styles = calls.map((c) => c.fillStyle)
    expect(styles).toContain(Palette.caution)
    expect(styles).not.toContain(Palette.danger)
  })
})

// ---------------------------------------------------------------------------
// boss health bar geometry
// ---------------------------------------------------------------------------

describe('boss health bar', () => {
  it('puts each phase threshold at its own fraction of the bar', () => {
    expect(bossThresholdMarks([...THRESHOLDS])).toEqual([0.62, 0.28])

    const { ctx, calls } = makeStub()
    const x = 100
    const w = 200
    drawBossHealthBar(ctx, {
      x,
      y: 10,
      w,
      h: 9,
      thresholds: [...THRESHOLDS],
      fraction: 0.8,
      phaseIndex: 0,
    })

    // The marks are the 1-unit ticks below the bar.
    const marks = calls
      .filter((c) => c.name === 'fillRect' && c.args[2] === 1)
      .map((c) => Number(c.args[0]) + 0.5)
    expect(marks).toEqual([x + 0.62 * w, x + 0.28 * w])
  })

  it('fills the current phase block in proportion to health within that phase', () => {
    // Thresholds [1, 0.5]: at 75% health the opening block is exactly half spent.
    const blocks = bossBarBlocks([1, 0.5], 0.75)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ from: 0.5, to: 1 })
    expect(blocks[0]?.fill).toBeCloseTo(0.5, 6)
    // Later phases are still untouched, not empty.
    expect(blocks[1]).toMatchObject({ from: 0, to: 0.5, fill: 1 })
  })

  it('renders full and empty health without drawing outside the bar', () => {
    for (const fraction of [1, 0.999, 0.5, 0.0001, 0, -3, 42, Number.NaN]) {
      for (const thresholds of [
        [...THRESHOLDS],
        [1],
        [],
        [Number.NaN, 0.5],
        [0.3, 0.9, 0.6],
        [1, 1, 1],
      ]) {
        // The geometry contract first, so a lost clamp fails here rather than being
        // caught downstream by the drawing code's own bounds check. The two guards are
        // deliberately redundant; asserting only the drawn result would let either one
        // be deleted silently.
        for (const block of bossBarBlocks(thresholds, fraction)) {
          expect(block.fill).toBeGreaterThanOrEqual(0)
          expect(block.fill).toBeLessThanOrEqual(1)
          expect(block.from).toBeGreaterThanOrEqual(0)
          expect(block.to).toBeLessThanOrEqual(1)
          expect(block.from).toBeLessThanOrEqual(block.to)
        }

        const { ctx, calls } = makeStub()
        const x = 60
        const w = 164
        drawBossHealthBar(ctx, { x, y: 20, w, h: 9, thresholds, fraction, phaseIndex: 1 })
        assertNoNaN(calls)
        for (const call of calls) {
          if (call.name !== 'fillRect') continue
          const left = Number(call.args[0])
          const width = Number(call.args[2])
          expect(left).toBeGreaterThanOrEqual(x - 0.51)
          expect(left + width).toBeLessThanOrEqual(x + w + 0.01)
          expect(width).toBeGreaterThanOrEqual(0)
        }
      }
    }
  })

  /**
   * Every authored boss and variant name, against the real table.
   *
   * A capture caught `The Repossessor` rendering as `THE REPOSSESS…`, which the
   * fixtures in this file were too short to expose — the whole reason this walks
   * `src/content/bosses.ts` instead. The name is the label a player uses to talk about
   * the fight; truncating it is not a cosmetic loss.
   *
   * Measured at 0.62em per character, deliberately wider than any font in the stack,
   * so a name that passes here has margin in the real renderer. Same trick, and the
   * same reasoning, as tests/textFits.test.ts.
   */
  const WIDE_EM = 0.62
  const wideMeasure: Measure = (text, size, _weight = 400, tracking = 0) =>
    text.length * size * WIDE_EM + Math.max(0, text.length - 1) * tracking

  const BOSS_NAMES: ReadonlyArray<readonly [string, string]> = Object.values(BOSSES).flatMap(
    (boss) => [
      [boss.id, boss.name] as const,
      ...(boss.variants ?? []).map((variant) => [`${boss.id}/${variant.id}`, variant.name] as const),
    ],
  )

  it('has real boss names to check', () => {
    // Guards the guard: an empty table would make every assertion below vacuous.
    expect(BOSS_NAMES.length).toBeGreaterThanOrEqual(9)
    expect(BOSS_NAMES.map(([, name]) => name)).toContain('The Repossessor')
    expect(Math.max(...BOSS_NAMES.map(([, name]) => name.length))).toBeGreaterThanOrEqual(27)
  })

  for (const [id, name] of BOSS_NAMES) {
    it(`renders "${name}" in full (${id})`, () => {
      const lines = bossNameLines(name, Panel.contentW, wideMeasure)

      // Nothing dropped, nothing elided: the lines put back together are the name.
      expect(lines.join(' ')).toBe(name.replace(/\s+/g, ' ').trim())
      expect(lines.join('')).not.toContain('…')

      // Every line fits the column at the size the panel draws it.
      for (const line of lines) {
        expect(
          wideMeasure(line, BOSS_NAME_SIZE, 700),
          `"${line}" is wider than the panel column`,
        ).toBeLessThanOrEqual(Panel.contentW)
      }

      // Two lines is the height the panel's flexible region is budgeted for. A longer
      // name is not forbidden — it will render in full on three lines — but it costs
      // the build readout a row, so it should be a decision rather than a surprise.
      expect(lines.length, `"${name}" needs ${lines.length} lines`).toBeLessThanOrEqual(2)
    })
  }

  it('draws the full name through the panel, with no ellipsis anywhere', () => {
    for (const [, name] of BOSS_NAMES) {
      const enemy = bossEnemy()
      if (enemy.boss) enemy.boss.name = name
      const { ctx, calls } = makeStub()
      drawPanel(ctx, worldFixture({ boss: enemy }), panelState())

      const drawn = calls
        .filter((c) => c.name === 'fillText')
        .map((c) => String(c.args[0]))
        .join('')
      expect(drawn, `"${name}" was elided in the panel`).not.toContain('…')
      // Every word of the name reached the canvas.
      for (const word of name.split(/\s+/)) {
        expect(drawn, `"${word}" of "${name}" is missing from the panel`).toContain(word)
      }
    }
  })

  it('colours the phase being fought differently from the phases still to come', () => {
    const { ctx, calls } = makeStub()
    drawBossHealthBar(ctx, {
      x: 0,
      y: 0,
      w: 100,
      h: 9,
      thresholds: [...THRESHOLDS],
      fraction: 0.5,
      phaseIndex: 1,
    })
    const fills = calls.filter((c) => c.name === 'fillRect').map((c) => c.fillStyle)
    expect(fills).toContain(Palette.hostileElite)
    expect(fills).toContain(Palette.hostile)
    // A boss losing health is not a thing that can hurt you this instant (rule 3).
    expect(fills).not.toContain(Palette.danger)
  })

  it('draws the boss hull without a NaN at any health or phase', () => {
    for (const hp of [1200, 700, 1, 0]) {
      for (const phaseIndex of [0, 1, 2, 9]) {
        const { ctx, calls } = makeStub()
        const enemy = bossEnemy({}, hp)
        if (enemy.boss) enemy.boss.phaseIndex = phaseIndex
        drawBossHull(ctx, enemy, 200, 160, { tick: 300 })
        assertNoNaN(calls)
        expect(calls.length).toBeGreaterThan(0)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// hazards in the panel
// ---------------------------------------------------------------------------

describe('hazard readout', () => {
  it('counts down in seconds, with the unit drawn', () => {
    expect(formatSeconds(90)).toBe('1.5')
    expect(formatSeconds(60)).toBe('1.0')
    expect(formatSeconds(600)).toBe('10')
    expect(formatSeconds(-5)).toBe('0.0')
    expect(formatSeconds(Number.NaN)).toBe('0.0')

    const { ctx, calls } = makeStub()
    drawHazardBlock(ctx, {
      x: Panel.contentX,
      y: 400,
      w: Panel.contentW,
      hazards: [hazard({ phase: 'warning', ticksToChange: 45 })],
      tick: 0,
      available: 120,
    })
    const texts = calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]))
    expect(texts).toContain('0.8')
    expect(texts).toContain('s')
  })

  it('reserves danger for the reaction window', () => {
    const styles = (phase: HazardView['phase']): string[] => {
      const { ctx, calls } = makeStub()
      drawHazardBlock(ctx, {
        x: Panel.contentX,
        y: 400,
        w: Panel.contentW,
        hazards: [hazard({ phase, ticksToChange: 40 })],
        tick: 0,
        available: 120,
      })
      return calls.flatMap((c) => [c.fillStyle, c.strokeStyle])
    }

    /**
     * The danger ROLE, not one specific hex.
     *
     * `danger` and `dangerText` are two tokens for one role: the mark stays at
     * #FF4A38 because brightening it costs the little separation it has from
     * `caution`, and the text uses the lighter #FF7059 because #FF4A38 is 3.78:1 on
     * the panel and UI.md rule 7 requires AA. A test pinned to one hex would have
     * failed on that split while the screen was getting *more* correct — so this
     * asks the question it actually means.
     */
    const usesDangerRole = (phase: HazardView['phase']): boolean =>
      styles(phase).some((style) => style.includes(Palette.danger) || style.includes(Palette.dangerText))

    expect(usesDangerRole('warning')).toBe(true)
    // An idle hazard cannot hurt anyone, and an active one has either already done its
    // damage or does none. Painting either red trains the threat reflex on a timer.
    expect(usesDangerRole('idle')).toBe(false)
    expect(usesDangerRole('active')).toBe(false)
    expect(hazardStatus(hazard({ phase: 'warning' })).urgent).toBe(true)
    expect(hazardStatus(hazard({ phase: 'active' })).urgent).toBe(false)
    expect(hazardStatus(hazard({ phase: 'idle' })).urgent).toBe(false)
  })

  it('gives each phase a marker shape as well as a colour', () => {
    const shapes = (phase: HazardView['phase']): string => {
      const { ctx, calls } = makeStub()
      drawHazardBlock(ctx, {
        x: Panel.contentX,
        y: 400,
        w: Panel.contentW,
        hazards: [hazard({ phase })],
        tick: 0,
        available: 120,
      })
      return calls
        .map((c) => c.name)
        .filter((n) => n === 'arc' || n === 'closePath')
        .join(',')
    }
    // Hollow dot (arc) for idle, triangle (closePath) for warning, plain rect for active.
    expect(shapes('idle')).toContain('arc')
    expect(shapes('warning')).toContain('closePath')
    expect(shapes('active')).not.toContain('arc')
  })

  it('drops prose before it drops a countdown', () => {
    const rows = (available: number, phase: HazardView['phase'] = 'idle'): string => {
      const { ctx, calls } = makeStub()
      drawHazardBlock(ctx, {
        x: Panel.contentX,
        y: 400,
        w: Panel.contentW,
        hazards: [hazard({ phase }), hazard({ id: 'b', name: 'Corrosive Wash', phase })],
        tick: 0,
        available,
      })
      // Joined twice: tracked text is drawn one glyph per call, so a tracked word
      // only appears in the unseparated form.
      const glyphs = calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]))
      return `${glyphs.join(' ')} ${glyphs.join('')}`
    }

    // Room: an idle hazard explains itself, a warning states the window instead —
    // the player has read the description by then and needs the state word.
    expect(rows(200)).toContain('Wreckage')
    expect(rows(200, 'warning')).toContain('INBOUND')

    // No room: the prose goes, and every hazard still counts down. A hidden countdown
    // is the failure this whole block exists to prevent.
    const tight = rows(70)
    expect(tight).not.toContain('Wreckage')
    expect(tight).toContain('DEBRIS FALL')
    expect(tight).toContain('CORROSIVE WASH')
    expect(tight).toContain('s')
  })
})

// ---------------------------------------------------------------------------
// stage identity
// ---------------------------------------------------------------------------

describe('stage identity comes from the run', () => {
  it('shows the simulation’s stage, not a planned count', () => {
    const { ctx, calls } = makeStub()
    // The deprecated fields deliberately disagree with the run: this is the exact
    // shape of the shipped defect, where the panel read "SECTOR 1 / 5" all game.
    drawPanel(ctx, worldFixture(), panelState({ sector: 1, sectorCount: 5 }))
    const texts = calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]))
    expect(texts).toContain('2 / 3')
    expect(texts).not.toContain('1 / 5')
    expect(texts.join(' ')).toContain('The Tally')
  })

  it('names the hull the run issued, not the one the caller remembers', () => {
    const { ctx, calls } = makeStub()
    drawPanel(ctx, worldFixture({ hullName: 'Ledger' }), panelState())
    const glyphs = calls
      .filter((c) => c.name === 'fillText')
      .map((c) => String(c.args[0]))
      .join('')
    expect(glyphs).toContain('LEDGER')
    expect(glyphs).not.toContain('FALLBACK')
  })

  it('survives a view with no stage at all', () => {
    const view = worldFixture()
    const broken = { ...view, stage: undefined } as unknown as WorldView
    const { ctx, calls } = makeStub()
    expect(() => drawPanel(ctx, broken, panelState())).not.toThrow()
    assertNoNaN(calls)
  })
})

// ---------------------------------------------------------------------------
// rule 10 — measured, not asserted by comment
// ---------------------------------------------------------------------------

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

describe('UI rule 10: nothing pulses faster than ~1Hz', () => {
  const TICKS = 600

  it('measures the shared pulse at its declared frequency', () => {
    const samples = Array.from({ length: TICKS }, (_, t) => pulse(t, 0.5))
    const hz = measuredHz(samples)
    expect(hz).toBeGreaterThan(0)
    expect(hz).toBeLessThanOrEqual(1)
    expect(hz).toBeCloseTo(PULSE_HZ, 1)
    // And the constant the drawing code actually uses matches the measurement.
    expect((PULSE_RATE * TICK_HZ) / (Math.PI * 2)).toBeCloseTo(hz, 1)
  })

  it('never lets a pulse reach zero, so it breathes instead of blinking', () => {
    for (const depth of [0.2, 0.4, 0.55, 0.9]) {
      const samples = Array.from({ length: TICKS }, (_, t) => pulse(t, depth))
      expect(Math.min(...samples)).toBeGreaterThan(0)
      expect(Math.max(...samples)).toBeLessThanOrEqual(1 + 1e-9)
    }
  })

  const pulsingEffects: ReadonlyArray<readonly [string, (ctx: CanvasRenderingContext2D, tick: number) => void]> = [
    [
      'hazard warning band',
      (ctx, tick) => {
        drawHazardBlock(ctx, {
          x: Panel.contentX,
          y: 400,
          w: Panel.contentW,
          hazards: [hazard({ phase: 'warning', ticksToChange: 40 })],
          tick,
          available: 120,
        })
      },
    ],
    [
      'low-integrity rim',
      (ctx, tick) => {
        drawLowIntegrityRim(
          ctx,
          { ...worldFixture().hull, integrity: 12 },
          tick,
        )
      },
    ],
    [
      'invulnerability ring',
      (ctx, tick) => {
        drawInvulnRing(ctx, 200, 600, 22, tick, 30)
      },
    ],
    [
      'boss core',
      (ctx, tick) => {
        drawBossHull(ctx, bossEnemy(), 200, 160, { tick })
      },
    ],
    [
      // REGRESSION. This shipped at 8.59 Hz — 0.9 rad/tick — modulating an additive
      // plume between 8.8 and 22 units of emitting area, on the one object a player
      // looks at continuously for a whole run. The rule-10 suite existed and did not
      // catch it, because `drawHull` was not exported and this list only ever held
      // exported effects. Enumerating the public surface is not the same as covering
      // the screen.
      'player engine plume',
      (ctx, tick) => {
        drawHull(ctx, worldFixture().hull, 1, tick, 0, false)
      },
    ],
  ]

  for (const [name, draw] of pulsingEffects) {
    it(`${name} modulates below 1Hz, measured from what it draws`, () => {
      const samples: number[] = []
      for (let tick = 0; tick < TICKS; tick++) {
        const { ctx, calls } = makeStub()
        draw(ctx, tick)
        // Total light emitted this tick. The sum rather than the peak: most effects
        // hold something at full opacity throughout, so a maximum is a constant and
        // would report that nothing animates. If any channel is modulated at 4Hz this
        // series says so.
        samples.push(intensitySignature(calls).reduce((total, value) => total + value, 0))
      }
      const hz = measuredHz(samples)
      expect(hz, `${name} measured at ${hz.toFixed(2)}Hz`).toBeLessThanOrEqual(1.05)
      expect(hz, `${name} does not appear to animate at all`).toBeGreaterThan(0)
    })
  }
})

// ---------------------------------------------------------------------------
// reduceFlashes
// ---------------------------------------------------------------------------

/**
 * Every effect that claims to honour `Settings.reduceFlashes`.
 *
 * Adding a bright effect without wiring the setting means adding a row here and
 * watching it fail — which is the point. A setting that silently stops covering half
 * the renderer is worse than one that never existed, because the player believes it.
 */
const ATTENUATED: ReadonlyArray<
  readonly [string, (ctx: CanvasRenderingContext2D, reduce: boolean) => void]
> = [
  [
    'explosions',
    (ctx, reduce) =>
      drawExplosions(
        ctx,
        [
          { x: 100, y: 200, age: 0, lifetime: 24, radius: 28, kind: 'enemy' },
          { x: 300, y: 400, age: 6, lifetime: 24, radius: 34, kind: 'mine' },
        ],
        0.5,
        reduce,
      ),
  ],
  ['enemy hit flash', (ctx, reduce) => drawHitFlash(ctx, 100, 100, 12, hitFlashStrength(4, reduce))],
  ['hit spark', (ctx, reduce) => drawHitSpark(ctx, 100, 100, 0.3, 0.8, 3, reduce)],
  ['muzzle glow', (ctx, reduce) => drawMuzzleGlow(ctx, 224, 600, 0.9, reduce)],
  ['invulnerability ring', (ctx, reduce) => drawInvulnRing(ctx, 224, 600, 22, 12, 40, reduce)],
  ['attack telegraph glow', (ctx, reduce) => drawTelegraph(ctx, 200, 200, 14, 4, 30, reduce)],
  [
    'low-integrity rim',
    (ctx, reduce) =>
      drawLowIntegrityRim(ctx, { ...worldFixture().hull, integrity: 8 }, 12, reduce),
  ],
  [
    'hazard warning band',
    (ctx, reduce) =>
      drawHazardBlock(ctx, {
        x: Panel.contentX,
        y: 400,
        w: Panel.contentW,
        hazards: [hazard({ phase: 'warning', ticksToChange: 30 })],
        tick: 12,
        available: 120,
        reduceFlashes: reduce,
      }),
  ],
  [
    'blackout scrim',
    (ctx, reduce) =>
      drawBlackout(
        ctx,
        blackoutDepth(
          [hazard({ hazardKind: 'blackout', phase: 'active', progress: 0.5 })],
          reduce,
        ),
      ),
  ],
  [
    'boss core',
    (ctx, reduce) => drawBossHull(ctx, bossEnemy(), 200, 160, { tick: 12, reduceFlashes: reduce }),
  ],
]

describe('Settings.reduceFlashes', () => {
  for (const [name, draw] of ATTENUATED) {
    it(`measurably attenuates ${name}`, () => {
      const normal = makeStub()
      draw(normal.ctx, false)
      const reduced = makeStub()
      draw(reduced.ctx, true)

      const a = intensitySignature(normal.calls)
      const b = intensitySignature(reduced.calls)
      expect(a.length, `${name} drew nothing`).toBeGreaterThan(0)
      expect(b, `${name} ignores reduceFlashes`).not.toEqual(a)
      // Attenuates: the reduced pass is never brighter at its peak.
      expect(Math.max(...b)).toBeLessThanOrEqual(Math.max(...a) + 1e-9)

      // And every additive glow layer inside it dims, not just the effect overall.
      const litNormal = glowAlphas(normal.calls)
      const litReduced = glowAlphas(reduced.calls)
      if (litNormal.length > 0) {
        if (litNormal.length === litReduced.length) {
          for (let i = 0; i < litNormal.length; i++) {
            const before = litNormal[i] ?? 0
            const after = litReduced[i] ?? 0
            // A layer already at zero has nothing to give up; everything else must.
            if (before <= 0.005) continue
            expect(
              after,
              `${name}: glow layer ${i} drew at ${after} with reduceFlashes on and ${before} with it off`,
            ).toBeLessThan(before)
          }
        } else {
          // Fewer blits is also attenuation: a layer dimmed below the blit threshold.
          expect(litReduced.length).toBeLessThan(litNormal.length)
        }
      }
    })
  }

  it('reduces rather than removes, so the effect still carries its meaning', () => {
    expect(REDUCED_FLASH_SCALE).toBeGreaterThan(0.15)
    expect(REDUCED_FLASH_SCALE).toBeLessThan(0.6)
    expect(hitFlashStrength(5, true)).toBeCloseTo(REDUCED_FLASH_SCALE, 6)
    expect(hitFlashStrength(5, false)).toBe(1)
    expect(hitFlashStrength(0, true)).toBe(0)
  })

  it('leaves the telegraph arc — the information — at full strength', () => {
    // Only the muzzle glow dims. The arc is how long the player has to react, and an
    // accessibility setting must not cost reaction time.
    const arcs = (reduce: boolean): unknown[][] => {
      const { ctx, calls } = makeStub()
      drawTelegraph(ctx, 200, 200, 14, 4, 30, reduce)
      return calls.filter((c) => c.name === 'arc').map((c) => [...c.args, c.globalAlpha])
    }
    expect(arcs(true)).toEqual(arcs(false))
  })
})

// ---------------------------------------------------------------------------
// blackout
// ---------------------------------------------------------------------------

describe('blackout', () => {
  const blackoutView = (progress: number): WorldView =>
    worldFixture({
      hazards: [
        hazard({
          id: 'grid-failure',
          name: 'Grid Failure',
          hazardKind: 'blackout',
          phase: 'active',
          progress,
          ticksToChange: 60,
        }),
      ],
    })

  it('only dims while a blackout is actually in force', () => {
    expect(blackoutDepth([])).toBe(0)
    expect(blackoutDepth([hazard({ hazardKind: 'blackout', phase: 'idle' })])).toBe(0)
    expect(blackoutDepth([hazard({ hazardKind: 'blackout', phase: 'warning' })])).toBe(0)
    expect(blackoutDepth([hazard({ hazardKind: 'debris', phase: 'active' })])).toBe(0)
    expect(blackoutDepth([hazard({ hazardKind: 'blackout', phase: 'active', progress: 0.5 })]))
      .toBeGreaterThan(0.5)
  })

  it('ramps in and out instead of stepping', () => {
    const at = (progress: number): number =>
      blackoutDepth([hazard({ hazardKind: 'blackout', phase: 'active', progress })])
    expect(at(0)).toBe(0)
    expect(at(0.02)).toBeLessThan(at(0.1))
    expect(at(0.5)).toBeGreaterThan(at(0.95))
    expect(at(1)).toBe(0)
  })

  it('leaves enemy projectiles at full contrast', () => {
    // The bullet pass must be bit-identical with the lights on and off. Anything else
    // means the scrim is sitting on top of the one thing the player must be able to
    // read, which is a difficulty made of missing information.
    const bulletPass = (view: WorldView): string => {
      const { ctx, calls } = makeStub()
      drawScene(ctx, view, new Starfield('TEST-SEED'), 0.5)
      return JSON.stringify(
        calls
          .filter(
            (c) =>
              c.fillStyle === Palette.danger ||
              c.strokeStyle === Palette.danger ||
              c.fillStyle === '#FFF1EC' ||
              c.fillStyle === 'rgba(4, 6, 10, 0.82)',
          )
          .map((c) => [c.name, c.args, c.globalAlpha]),
      )
    }

    const lit = bulletPass(worldFixture())
    const dark = bulletPass(blackoutView(0.5))
    expect(dark).toBe(lit)
    expect(dark.length).toBeGreaterThan(10)
  })

  it('draws the scrim before the enemy projectiles and never after', () => {
    const { ctx, calls } = makeStub()
    drawScene(ctx, blackoutView(0.5), new Starfield('TEST-SEED'), 0.5)

    const scrim = calls.findIndex(
      (c) =>
        c.name === 'fillRect' &&
        c.args[2] === PLAYFIELD_W &&
        c.args[3] === PLAYFIELD_H &&
        String(c.fillStyle).startsWith('rgba(2, 3, 6'),
    )
    const firstBullet = calls.findIndex((c) => c.fillStyle === Palette.danger)
    expect(scrim).toBeGreaterThan(-1)
    expect(firstBullet).toBeGreaterThan(-1)
    expect(scrim).toBeLessThan(firstBullet)
    // Exactly one scrim: a second pass later would undo the ordering above.
    expect(
      calls.filter(
        (c) => c.name === 'fillRect' && String(c.fillStyle).startsWith('rgba(2, 3, 6'),
      ),
    ).toHaveLength(1)
  })

  it('does not dim the player hull', () => {
    // The hull is drawn after the scrim, so its cockpit highlight is untouched.
    const { ctx, calls } = makeStub()
    drawScene(ctx, blackoutView(0.5), new Starfield('TEST-SEED'), 0.5)
    const cockpit = calls.findIndex((c) => c.name === 'fillRect' && c.fillStyle === '#EAFDFF')
    const scrim = calls.findIndex((c) => String(c.fillStyle).startsWith('rgba(2, 3, 6'))
    expect(cockpit).toBeGreaterThan(scrim)
  })
})

// ---------------------------------------------------------------------------
// shell ejection
// ---------------------------------------------------------------------------

describe('shell ejection', () => {
  it('ejects one case per shot, alternating sides, from the event and nothing else', () => {
    const state = createFeelState()
    const live = (): Shell[] => state.shells.filter((s) => s.age < SHELL_LIFETIME)

    expect(live()).toHaveLength(0)
    feelTick(state, [{ kind: 'player-shot', x: 224, y: 600 }], 1)
    expect(live()).toHaveLength(1)
    const first = live()[0]
    feelTick(state, [{ kind: 'player-shot', x: 224, y: 600 }], 2)
    expect(live()).toHaveLength(2)
    const second = live().find((s) => s !== first)
    // Alternating, matching the muzzles the sim alternates between.
    expect(Math.sign(first?.vx ?? 0)).toBe(-Math.sign(second?.vx ?? 0))

    // Nothing else in the event stream throws brass.
    const quiet = createFeelState()
    feelTick(quiet, [{ kind: 'enemy-shot', x: 10, y: 10, defId: 'skiff' }], 1)
    feelTick(quiet, [{ kind: 'hull-hit', x: 10, y: 10, damage: 3, absorbedByShield: false }], 2)
    expect(quiet.shells.filter((s) => s.age < SHELL_LIFETIME)).toHaveLength(0)
  })

  it('is bounded: a long burst never grows the pool or leaves cases behind', () => {
    const state = createFeelState()
    for (let tick = 0; tick < 400; tick++) {
      feelTick(state, tick % 3 === 0 ? [{ kind: 'player-shot', x: 224, y: 600 }] : [], tick)
      expect(state.shells).toHaveLength(MAX_SHELLS)
    }
    for (let tick = 400; tick < 400 + SHELL_LIFETIME + 1; tick++) feelTick(state, [], tick)
    expect(state.shells.filter((s) => s.age < SHELL_LIFETIME)).toHaveLength(0)
  })

  it('stays inside the playfield and never emits a NaN', () => {
    const state = createFeelState()
    // Fired from the very edge, which is where a clamp failure would show.
    for (let tick = 0; tick < 40; tick++) {
      feelTick(state, [{ kind: 'player-shot', x: tick % 2 ? 4 : PLAYFIELD_W - 4, y: 700 }], tick)
    }
    for (const alpha of [0, 0.5, 1]) {
      const { ctx, calls } = makeStub()
      drawFeelShells(ctx, state, alpha)
      assertNoNaN(calls)
      expect(calls.filter((c) => c.name === 'fillRect').length).toBeGreaterThan(0)
      for (const call of calls) {
        if (call.name !== 'translate') continue
        const [x, y] = call.args as [number, number]
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(PLAYFIELD_W)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(PLAYFIELD_H)
      }
    }
  })

  it('stays quieter than enemy fire', () => {
    // Rule 3 in spirit: brass is decoration, so it must never approach the contrast of
    // the one thing on screen that can kill you.
    const state = createFeelState()
    feelTick(state, [{ kind: 'player-shot', x: 224, y: 600 }], 1)
    const { ctx, calls } = makeStub()
    drawFeelShells(ctx, state, 0)
    const alphas = calls
      .filter((c) => c.name === 'fillRect')
      .flatMap((c) => alphaOf(c))
      .filter((value) => value < 1)
    expect(alphas.length).toBeGreaterThan(0)
    expect(Math.max(...alphas)).toBeLessThanOrEqual(0.5)
  })
})

// ---------------------------------------------------------------------------
// the renderer reads the world and never writes it
// ---------------------------------------------------------------------------

describe('the renderer never mutates the world', () => {
  it('draws a full boss frame from a deeply frozen view', () => {
    // A renderer that writes to sim state desynchronises every replay. Modules are
    // strict mode, so any assignment to a frozen object throws rather than passing
    // silently — which makes this a real check and not a hopeful one.
    const boss = bossEnemy()
    if (boss.boss) boss.boss.calloutTicks = 90
    const view = worldFixture({
      boss,
      enemies: [boss],
      hazards: [
        hazard({ phase: 'warning', ticksToChange: 20 }),
        hazard({ id: 'g', hazardKind: 'blackout', phase: 'active', progress: 0.5 }),
      ],
      explosions: [{ x: 200, y: 300, age: 2, lifetime: 24, radius: 30, kind: 'enemy' }],
    })

    const freeze = (value: unknown): void => {
      if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
      Object.freeze(value)
      for (const child of Object.values(value)) freeze(child)
    }
    freeze(view)

    const { ctx } = makeStub()
    expect(() =>
      drawScene(ctx, view, new Starfield('TEST-SEED'), 0.5, { reduceFlashes: false }),
    ).not.toThrow()
    const panel = makeStub()
    expect(() => drawPanel(panel.ctx, view, panelState())).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// the whole frame
// ---------------------------------------------------------------------------

describe('a boss frame end to end', () => {
  it('draws boss, hazards, callout and blackout without a single NaN', () => {
    const boss = bossEnemy()
    if (boss.boss) boss.boss.calloutTicks = 90
    for (const alpha of [0, 0.5, 1]) {
      for (const reduceFlashes of [false, true]) {
        const { ctx, calls } = makeStub()
        drawScene(
          ctx,
          worldFixture({
            boss,
            enemies: [boss],
            hazards: [
              hazard({ phase: 'warning', ticksToChange: 20 }),
              hazard({
                id: 'grid',
                hazardKind: 'blackout',
                name: 'Grid Failure',
                phase: 'active',
                progress: 0.5,
              }),
            ],
            explosions: [{ x: 200, y: 300, age: 2, lifetime: 24, radius: 30, kind: 'enemy' }],
          }),
          new Starfield('TEST-SEED'),
          alpha,
          { reduceFlashes },
        )
        assertNoNaN(calls)
        expect(calls.length).toBeGreaterThan(20)
      }
    }
  })

  it('draws nothing outside the playfield while the panel is not involved', () => {
    const boss = bossEnemy()
    if (boss.boss) boss.boss.calloutTicks = 120
    const { ctx, calls } = makeStub()
    drawScene(ctx, worldFixture({ boss, enemies: [boss] }), new Starfield('TEST-SEED'), 0.5)
    for (const call of calls) {
      // Shapes translate to their own origin, so only absolute primitives are checked.
      if (call.name !== 'fillText' && call.name !== 'fillRect') continue
      for (const x of inkX(call)) {
        expect(x).toBeLessThanOrEqual(PLAYFIELD_W + 0.01)
      }
    }
  })
})
