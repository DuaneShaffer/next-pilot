/**
 * Entry point. Wires input, simulation, and rendering together.
 *
 * Milestone 0 proves the whole pipeline end to end: seeded run, fixed-timestep
 * sim, interpolated rendering, instrument panel, and a live deploy. There is
 * nothing to shoot at yet — that is Milestone 1.
 */

import { FixedLoop } from './core/loop'
import { Keyboard, NEUTRAL_INPUT } from './core/input'
import { generateSeed, isValidSeed, normalizeSeed } from './core/seed'
import { VIRTUAL_H, VIRTUAL_W } from './core/space'
import { Viewport } from './render/layout'
import { drawPanel, type PanelState } from './render/panel'
import { drawScene } from './render/scene'
import { Starfield } from './render/starfield'
import { SHOTS_PER_SECOND, World } from './sim/world'
import { drawTitleScreen } from './ui/titleScreen'

const VERSION = 'v0.0.1 · m0'
const SAVE_KEY = 'next-pilot/save/v1'

type Screen = 'title' | 'sortie'

interface Save {
  version: 1
  /** How many pilots the company has burned through. */
  pilotNumber: number
}

function loadSave(): Save {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return { version: 1, pilotNumber: 1 }
    const parsed = JSON.parse(raw) as Partial<Save>
    // Defensive: a save written by a future build must never crash this one.
    if (parsed.version !== 1 || typeof parsed.pilotNumber !== 'number') {
      return { version: 1, pilotNumber: 1 }
    }
    return { version: 1, pilotNumber: Math.max(1, Math.floor(parsed.pilotNumber)) }
  } catch {
    // Private browsing can throw on localStorage access. Play anyway.
    return { version: 1, pilotNumber: 1 }
  }
}

function persistSave(save: Save): void {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save))
  } catch {
    // Non-fatal: the run still works, progress just won't survive a reload.
  }
}

/**
 * Read startup options from the URL.
 *
 * `?seed=` and `?screen=` exist so screenshot tests and bot playtests can put the
 * game into an exact state without clicking through menus. They are part of the
 * verification harness, not debug leftovers.
 */
function readUrlOptions(): { seed: string; screen: Screen } {
  const params = new URLSearchParams(location.search)
  const rawSeed = params.get('seed')
  const seed = rawSeed && isValidSeed(rawSeed) ? normalizeSeed(rawSeed) : generateSeed()
  const screen: Screen = params.get('screen') === 'sortie' ? 'sortie' : 'title'
  return { seed, screen }
}

function main(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')
  if (!canvas) throw new Error('Missing #game canvas element.')

  const options = readUrlOptions()
  const save = loadSave()
  const viewport = new Viewport(canvas)
  const keyboard = new Keyboard()
  keyboard.attach()

  let screen: Screen = options.screen
  let seed = options.seed
  let world = new World(seed)
  let sceneStars = new Starfield(seed)
  const titleStars = new Starfield(`${seed}:title`, VIRTUAL_W, VIRTUAL_H)
  let titleTick = 0

  const panelState: PanelState = {
    pilotNumber: save.pilotNumber,
    hullName: 'Lien',
    weaponName: 'Twin Pulse',
    // Derived from the sim, never hand-written, so the HUD cannot lie about it.
    fireRate: SHOTS_PER_SECOND,
    scrap: 0,
    sector: 1,
    sectorCount: 5,
  }

  function fitToWindow(): void {
    // Leave a small margin so the canvas never touches the window edge.
    const availableW = window.innerWidth - 24
    const availableH = window.innerHeight - 24
    viewport.resize(availableW, availableH, window.devicePixelRatio)
  }

  function beginSortie(): void {
    seed = generateSeed()
    world = new World(seed)
    sceneStars = new Starfield(seed)
    screen = 'sortie'
    panelState.pilotNumber = save.pilotNumber
    loop.resetClock()
  }

  const loop = new FixedLoop({
    tick(): void {
      if (screen === 'title') {
        titleTick++
        titleStars.update(0.35)
        if (keyboard.consumePressed('confirm')) beginSortie()
        return
      }

      const input = document.hasFocus() ? keyboard.snapshot() : NEUTRAL_INPUT
      sceneStars.update()
      world.tick(input)
    },

    render(alpha): void {
      const ctx = viewport.ctx
      if (screen === 'title') {
        drawTitleScreen(ctx, titleStars, {
          seed,
          pilotNumber: save.pilotNumber,
          tick: titleTick,
          version: VERSION,
        })
        return
      }
      drawScene(ctx, world, sceneStars, alpha)
      drawPanel(ctx, world, panelState)
    },
  })

  fitToWindow()
  window.addEventListener('resize', fitToWindow)

  // Expose state for the verification harness (Playwright screenshots and perf
  // assertions). Read-only by convention; nothing in the game reads it back.
  Object.defineProperty(window, '__nextPilot', {
    value: {
      version: VERSION,
      get screen() {
        return screen
      },
      get seed() {
        return seed
      },
      get stats() {
        return { ...world.stats, ...loop.getStats() }
      },
    },
  })

  let rafHandle = 0
  const frame = (nowMs: number): void => {
    loop.advance(nowMs)
    rafHandle = requestAnimationFrame(frame)
  }
  rafHandle = requestAnimationFrame(frame)

  // Vite HMR would otherwise stack a second loop on every edit.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      cancelAnimationFrame(rafHandle)
      keyboard.dispose()
    })
  }

  persistSave(save)
  document.body.dataset.ready = 'true'
}

main()
