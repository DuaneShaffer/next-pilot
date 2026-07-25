/**
 * Entry point. Wires input, simulation, presentation, and persistence together.
 *
 * This is the only module allowed to know about all the layers at once. It reads
 * the keyboard, advances a World, drains that World's events, and hands a
 * WorldView to the renderers — which is why the sim can stay headless and every
 * screen can be drawn from a view alone. Keep game logic out of here.
 */

import { FixedLoop } from './core/loop'
import { Keyboard, type InputSnapshot } from './core/input'
import { generateSeed, isValidSeed, normalizeSeed } from './core/seed'
import { VIRTUAL_H, VIRTUAL_W } from './core/space'
import { ENEMIES } from './content/enemies'
import { SECTOR_ONE, SECTORS } from './content/sectors'
import { createAudioDirector } from './audio'
import { adoptLegacySave, loadSave, persistSave, type Save, type Settings } from './meta/save'
import { Viewport } from './render/layout'
import { createFeelState, feelTick, resetFeelState } from './render/feel'
import { drawPanel, type PanelState } from './render/panel'
import { drawScene } from './render/scene'
import { Starfield } from './render/starfield'
import { BOTS, isBotName, type BotPolicy } from './sim/bots'
import { SHOTS_PER_SECOND, World } from './sim/world'
import { drawIncidentReport } from './ui/incidentReport'
import {
  PAUSE_ITEMS,
  adjustSetting,
  drawPauseMenu,
  movePauseSelection,
} from './ui/pauseMenu'
import { drawTitleScreen } from './ui/titleScreen'

const VERSION = 'v0.2.0 · m2'

type Screen = 'title' | 'sortie' | 'paused' | 'incident'

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
 * `autopilot` and `ff` exist for the verification harness: reaching a late wave
 * by holding a key for ninety real seconds is not viable in a capture pass, and
 * hand-driving it would not be reproducible. See docs/VERIFICATION.md.
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

function readUrlOptions(fallbackSeed: string): UrlOptions {
  const params = new URLSearchParams(location.search)

  const rawSeed = params.get('seed')
  const seed = rawSeed && isValidSeed(rawSeed) ? normalizeSeed(rawSeed) : fallbackSeed

  const rawAutopilot = params.get('autopilot')
  const autopilot = rawAutopilot && isBotName(rawAutopilot) ? BOTS[rawAutopilot].create(seed) : null

  const rawFf = Number(params.get('ff') ?? '1')
  const fastForward = Number.isFinite(rawFf)
    ? Math.max(1, Math.min(MAX_FAST_FORWARD, Math.floor(rawFf)))
    : 1

  return {
    seed,
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
  // Adopt the v1 storage key before a normal load, so a returning player's pilot
  // count survives. See the note in meta/save.ts about versioned keys.
  const save: Save = adoptLegacySave() ?? loadSave()

  const viewport = new Viewport(canvas)
  const keyboard = new Keyboard()
  keyboard.attach()
  const audio = createAudioDirector()
  const feel = createFeelState()

  let screen: Screen = options.screen
  let seed = options.seed
  let world = new World(seed)
  let sceneStars = new Starfield(seed)
  const titleStars = new Starfield(`${seed}:title`, VIRTUAL_W, VIRTUAL_H)
  let menuTick = 0
  let pauseSelection = 0

  const panelState: PanelState = {
    pilotNumber: save.pilotNumber,
    hullName: 'Lien',
    weaponName: 'Twin Pulse',
    // Derived from the sim, never hand-written, so the HUD cannot lie about it.
    fireRate: SHOTS_PER_SECOND,
    sector: 1,
    // Sectors that exist, not sectors that are planned. See SECTORS.
    sectorCount: SECTORS.length,
    waveCount: SECTOR_ONE.waves.length,
  }

  function applyAudioSettings(settings: Settings): void {
    audio.setMasterVolume(settings.masterVolume)
    audio.setMuted(settings.muted)
  }
  applyAudioSettings(save.settings)

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
    resetFeelState(feel)
    screen = 'sortie'
    menuTick = 0
    loop.resetClock()
  }

  /**
   * Enter or leave the pause menu.
   *
   * Pause is app state, never simulation state: while paused the loop simply does
   * not advance the sim, so no ticks happen and nothing enters the input log. A
   * replay of a paused run is byte-identical to one played straight through.
   *
   * resetClock() on resume is load-bearing. The loop accumulates wall-clock time,
   * so without it every second spent paused is a second the simulation tries to
   * catch up on the instant play resumes — a burst of ticks the player never
   * asked for, and in a bullet-hell that means dying to a frame they never saw.
   */
  function setPaused(paused: boolean): void {
    if (paused && screen === 'sortie') {
      screen = 'paused'
      menuTick = 0
      pauseSelection = 0
      audio.stopAll()
      return
    }
    if (!paused && screen === 'paused') {
      screen = 'sortie'
      loop.resetClock()
      keyboard.clearPressed()
    }
  }

  function abandonSortie(): void {
    screen = 'title'
    menuTick = 0
    audio.stopAll()
    keyboard.clearPressed()
    loop.resetClock()
  }

  /** One simulation step. Separated so fast-forward can run it many times. */
  function stepSim(): void {
    const input: InputSnapshot = options.autopilot ? options.autopilot(world) : keyboard.snapshot()

    sceneStars.update()
    world.tick(input)

    // Drain per TICK, never per frame. A frame spans several ticks in normal play
    // and up to 32 under ?ff=, and the sim clears its event list every tick — so a
    // per-frame drain would silently discard all but the last tick's events and
    // show up as audio and damage numbers dropping out under load.
    audio.observe(world)
    feelTick(feel, world.events, world.stats.tick)

    // The run ending is the sim's decision; this only follows it.
    if (world.runState !== 'active') {
      screen = 'incident'
      menuTick = 0
      // Drain any held key so the death-screen prompt can't be consumed by the
      // same press that was firing when the pilot died.
      keyboard.clearPressed()
    }
  }

  function updatePauseMenu(): void {
    menuTick++
    if (keyboard.consumePressed('up')) pauseSelection = movePauseSelection(pauseSelection, -1)
    if (keyboard.consumePressed('down')) pauseSelection = movePauseSelection(pauseSelection, 1)

    const item = PAUSE_ITEMS[pauseSelection]
    if (!item) return

    let changed = false
    if (keyboard.consumePressed('left')) {
      save.settings = adjustSetting(save.settings, item.id, -1)
      changed = true
    }
    if (keyboard.consumePressed('right')) {
      save.settings = adjustSetting(save.settings, item.id, 1)
      changed = true
    }
    if (changed) {
      applyAudioSettings(save.settings)
      persistSave(save)
      audio.confirm()
    }

    if (keyboard.consumePressed('confirm')) {
      if (item.id === 'resume') {
        audio.confirm()
        setPaused(false)
      } else if (item.id === 'abandon') {
        audio.cancel()
        abandonSortie()
      }
    }
    if (keyboard.consumePressed('pause')) setPaused(false)
  }

  const loop = new FixedLoop({
    tick(): void {
      if (screen === 'title') {
        menuTick++
        titleStars.update(0.35)
        if (keyboard.consumePressed('confirm')) {
          audio.confirm()
          beginSortie()
        }
        return
      }

      if (screen === 'paused') {
        updatePauseMenu()
        return
      }

      if (screen === 'incident') {
        menuTick++
        // UI rule 6: one input from death to the next sortie.
        if (keyboard.consumePressed('confirm')) {
          audio.confirm()
          beginSortie()
        }
        return
      }

      if (keyboard.consumePressed('pause')) {
        setPaused(true)
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

      // Paused and dead both freeze the playfield, so interpolation must not keep
      // sliding entities toward a tick that will never be simulated.
      const frozen = screen === 'incident' || screen === 'paused'
      drawScene(ctx, world, sceneStars, frozen ? 0 : alpha, {
        feel,
        shakeScale: save.settings.shake,
      })

      // The panel is deliberately NOT drawn under the incident report: its scrim
      // is translucent by design, and translucency over live readouts left panel
      // text legibly ghosting through the right margin. Faint wreckage behind
      // paperwork is atmosphere; faint numbers are noise. The pause menu is a
      // smaller card, so the panel stays visible behind it.
      if (screen !== 'incident') drawPanel(ctx, world, panelState)

      if (screen === 'paused') {
        drawPauseMenu(ctx, {
          selected: pauseSelection,
          settings: save.settings,
          tick: menuTick,
          waveIndex: world.stats.waveIndex,
          waveCount: SECTOR_ONE.waves.length,
          seed,
        })
        return
      }

      if (screen === 'incident') {
        // Spread the cause conditionally: under exactOptionalPropertyTypes an
        // explicit `undefined` is not the same as an absent optional property, and
        // the report treats absence as "format the id yourself".
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

  /**
   * Unlock audio on the first real gesture.
   *
   * iOS refuses to play a WebAudio graph created before a user gesture, and
   * `resume()` alone is not always enough — so this is the single point where the
   * context is actually constructed. A one-shot listener rather than a per-tick
   * poll, because "has the user interacted" is a browser fact, not game state.
   */
  const unlockAudio = (): void => {
    audio.unlock()
    window.removeEventListener('keydown', unlockAudio)
    window.removeEventListener('pointerdown', unlockAudio)
    window.removeEventListener('touchstart', unlockAudio)
  }
  window.addEventListener('keydown', unlockAudio)
  window.addEventListener('pointerdown', unlockAudio)
  window.addEventListener('touchstart', unlockAudio)

  /**
   * Auto-pause when the window loses focus.
   *
   * Without this, an unfocused-but-visible window keeps simulating while the
   * keyboard reports nothing — so alt-tabbing during a run parks the ship and
   * lets it be shot. In a permadeath game that silently destroys a run the player
   * was in the middle of, which is about the worst thing an interface can do.
   *
   * Suppressed under autopilot so an unattended capture or perf pass is not
   * paused by the harness taking focus.
   */
  if (!options.autopilot) {
    window.addEventListener('blur', () => setPaused(true))
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) setPaused(true)
    })
  }

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
