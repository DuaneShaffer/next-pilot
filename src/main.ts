/**
 * Entry point. Wires input, simulation, and rendering together.
 *
 * This is the only module that may know about all three layers at once. It reads
 * the keyboard, advances a World, and hands a WorldView to the renderers — which
 * is why the sim can stay headless and every screen can be drawn from a view
 * alone. Keep game logic out of here.
 */

import { FixedLoop } from './core/loop'
import { Keyboard, NEUTRAL_INPUT, type InputSnapshot } from './core/input'
import { generateSeed, isValidSeed, normalizeSeed } from './core/seed'
import { VIRTUAL_H, VIRTUAL_W } from './core/space'
import { ENEMIES } from './content/enemies'
import { SECTOR_ONE } from './content/sectors'
import { Viewport } from './render/layout'
import { drawPanel, type PanelState } from './render/panel'
import { drawScene } from './render/scene'
import { Starfield } from './render/starfield'
import { BOTS, isBotName, type BotPolicy } from './sim/bots'
import { SHOTS_PER_SECOND, World } from './sim/world'
import { drawIncidentReport } from './ui/incidentReport'
import { drawTitleScreen } from './ui/titleScreen'

const VERSION = 'v0.1.0 · m1'
const SAVE_KEY = 'next-pilot/save/v1'

type Screen = 'title' | 'sortie' | 'incident'

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
 * Turn an enemy def id into something a person would say.
 *
 * The incident report deliberately does not import the content tables, so the
 * lookup happens here — the app layer is allowed to know about both.
 */
function causeNameFor(defId: string | null): string | undefined {
  if (!defId) return undefined
  return Object.hasOwn(ENEMIES, defId) ? ENEMIES[defId]?.name : undefined
}

/**
 * Startup options read from the URL.
 *
 * `seed` and `screen` let a person or a test jump straight to an exact state.
 * `autopilot` and `ff` exist for the screenshot harness: reaching a late wave by
 * holding a key for ninety real seconds is not viable in a capture pass, and
 * hand-driving it would not be reproducible. They are verification affordances,
 * not debug leftovers — see docs/VERIFICATION.md.
 */
interface UrlOptions {
  seed: string
  screen: Screen
  autopilot: BotPolicy | null
  /** Extra simulation ticks per rendered frame. 1 is real time. */
  fastForward: number
}

/** Ceiling on fast-forward, so a typo can't wedge the page in a long loop. */
const MAX_FAST_FORWARD = 32

function readUrlOptions(seed: string): UrlOptions {
  const params = new URLSearchParams(location.search)

  const rawSeed = params.get('seed')
  const resolvedSeed = rawSeed && isValidSeed(rawSeed) ? normalizeSeed(rawSeed) : seed

  const rawAutopilot = params.get('autopilot')
  const autopilot =
    rawAutopilot && isBotName(rawAutopilot) ? BOTS[rawAutopilot].create(resolvedSeed) : null

  const rawFf = Number(params.get('ff') ?? '1')
  const fastForward = Number.isFinite(rawFf)
    ? Math.max(1, Math.min(MAX_FAST_FORWARD, Math.floor(rawFf)))
    : 1

  return {
    seed: resolvedSeed,
    // An autopilot with nothing to fly is pointless, so it implies a sortie.
    screen: params.get('screen') === 'sortie' || autopilot ? 'sortie' : 'title',
    autopilot,
    fastForward,
  }
}

function main(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')
  if (!canvas) throw new Error('Missing #game canvas element.')

  const options = readUrlOptions(generateSeed())
  const save = loadSave()
  const viewport = new Viewport(canvas)
  const keyboard = new Keyboard()
  keyboard.attach()

  let screen: Screen = options.screen
  let seed = options.seed
  let world = new World(seed)
  let sceneStars = new Starfield(seed)
  const titleStars = new Starfield(`${seed}:title`, VIRTUAL_W, VIRTUAL_H)
  let menuTick = 0

  const panelState: PanelState = {
    pilotNumber: save.pilotNumber,
    hullName: 'Lien',
    weaponName: 'Twin Pulse',
    // Derived from the sim, never hand-written, so the HUD cannot lie about it.
    fireRate: SHOTS_PER_SECOND,
    sector: 1,
    sectorCount: 5,
    waveCount: SECTOR_ONE.waves.length,
  }

  function fitToWindow(): void {
    // Leave a small margin so the canvas never touches the window edge.
    viewport.resize(window.innerWidth - 24, window.innerHeight - 24, window.devicePixelRatio)
  }

  function beginSortie(): void {
    // A fresh pilot each run — the company's headcount is the meta-progression.
    save.pilotNumber += 1
    persistSave(save)
    panelState.pilotNumber = save.pilotNumber

    seed = generateSeed()
    world = new World(seed)
    sceneStars = new Starfield(seed)
    screen = 'sortie'
    menuTick = 0
    loop.resetClock()
  }

  /** One simulation step. Separated so fast-forward can run it many times. */
  function stepSim(): void {
    const input: InputSnapshot = options.autopilot
      ? options.autopilot(world)
      : document.hasFocus()
        ? keyboard.snapshot()
        : NEUTRAL_INPUT

    sceneStars.update()
    world.tick(input)

    // The run ending is the sim's decision, not the UI's; this only follows it.
    if (world.runState !== 'active') {
      screen = 'incident'
      menuTick = 0
      // Drain any key already held, so the death-screen prompt can't be consumed
      // by the same press that was firing when the pilot died.
      keyboard.clearPressed()
    }
  }

  const loop = new FixedLoop({
    tick(): void {
      if (screen === 'title') {
        menuTick++
        titleStars.update(0.35)
        if (keyboard.consumePressed('confirm')) beginSortie()
        return
      }

      if (screen === 'incident') {
        menuTick++
        // UI rule 6: one input from death to the next sortie.
        if (keyboard.consumePressed('confirm')) beginSortie()
        return
      }

      for (let i = 0; i < options.fastForward; i++) {
        if (screen !== 'sortie') break
        stepSim()
      }
    },

    render(alpha): void {
      const ctx = viewport.ctx

      if (screen === 'title') {
        drawTitleScreen(ctx, titleStars, {
          seed,
          pilotNumber: save.pilotNumber,
          tick: menuTick,
          version: VERSION,
        })
        return
      }

      // The incident report is drawn over the frozen playfield, so the wreck of
      // the last frame stays visible behind the paperwork.
      drawScene(ctx, world, sceneStars, screen === 'incident' ? 1 : alpha)

      // The panel is deliberately NOT drawn under the report. Its scrim is
      // translucent by design — the wreck showing through is the point — but
      // translucency over a column of live readouts left panel text legibly
      // ghosting through the right margin, which read as a rendering bug.
      // Faint wreckage behind paperwork is atmosphere; faint numbers are noise.
      if (screen !== 'incident') drawPanel(ctx, world, panelState)

      if (screen === 'incident') {
        // Spread the cause conditionally: under exactOptionalPropertyTypes an
        // explicit `undefined` is not the same as an absent optional property,
        // and the report treats absence as "format the id yourself".
        const causeName = causeNameFor(world.incident?.causeEnemyId ?? null)
        drawIncidentReport(ctx, world, {
          pilotNumber: save.pilotNumber,
          hullName: panelState.hullName,
          tick: menuTick,
          ...(causeName ? { causeName } : {}),
          sectorName: SECTOR_ONE.name,
          sector: panelState.sector,
          sectorCount: panelState.sectorCount,
          waveCount: SECTOR_ONE.waves.length,
        })
      }
    },
  })

  fitToWindow()
  window.addEventListener('resize', fitToWindow)

  // State for the verification harness (screenshot captures and perf checks).
  // Read-only by convention; nothing in the game reads it back.
  Object.defineProperty(window, '__nextPilot', {
    value: {
      version: VERSION,
      get screen() {
        return screen
      },
      get seed() {
        return seed
      },
      get runState() {
        return world.runState
      },
      get enemyCount() {
        return world.enemies.length
      },
      get integrity() {
        return world.hull.integrity
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

  document.body.dataset.ready = 'true'
}

main()
