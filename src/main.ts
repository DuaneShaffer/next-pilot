/**
 * Entry point. Wires input, simulation, presentation, and persistence together.
 *
 * This is the only module allowed to know about all the layers at once. It reads
 * the keyboard, advances a World, drains that World's events, and hands a
 * WorldView to the renderers — which is why the sim can stay headless and every
 * screen can be drawn from a view alone. Keep game logic out of here.
 */

import { FixedLoop } from './core/loop'
import { Keyboard, NEUTRAL_INPUT, type InputSnapshot } from './core/input'
import { generateSeed, isValidSeed, normalizeSeed } from './core/seed'
import { VIRTUAL_H, VIRTUAL_W } from './core/space'
import { ENEMIES } from './content/enemies'
import { SECTOR_ONE, SECTORS } from './content/sectors'
import { ITEMS } from './content/items'
import { INTERACTIONS } from './content/interactions'
import { createAudioDirector } from './audio'
import { adoptLegacySave, loadSave, persistSave, type Save, type Settings } from './meta/save'
import { Viewport } from './render/layout'
import { createFeelState, feelTick, resetFeelState } from './render/feel'
import { drawPanel, type PanelState } from './render/panel'
import { drawScene } from './render/scene'
import { Starfield } from './render/starfield'
import { BOTS, isBotName, type BotPolicy } from './sim/bots'
import { World, type RunContent } from './sim/world'
import { BASE_POOL, CERTIFICATIONS, getCertification } from './content/certifications'
import { fileRun, poolFor, summariseRun, unlockedSet } from './meta/certifications'
import {
  appendPersonnelRecord,
  buildPersonnelRecord,
  newestFirst,
} from './meta/personnel'
import { fingerprintPool } from './meta/purist'
import { drawChoiceScreen } from './ui/choiceScreen'
import { drawHangar, moveHangarSelection } from './ui/hangar'
import {
  drawPersonnelScreen,
  movePersonnelSelection,
  personnelScrollFor,
} from './ui/personnel'
import { drawIncidentReport } from './ui/incidentReport'
import {
  PAUSE_ITEMS,
  adjustSetting,
  drawPauseMenu,
  movePauseSelection,
} from './ui/pauseMenu'
import { drawTitleScreen } from './ui/titleScreen'

const VERSION = 'v0.2.0 · m2'

type Screen = 'title' | 'sortie' | 'paused' | 'incident' | 'hangar' | 'personnel'

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
  /**
   * Stop the autopilot from resolving a reward choice, so the card stays open.
   *
   * A capture affordance. A bot resolves a choice in about six ticks, which at any
   * useful fast-forward is ~25ms — shorter than the harness's polling interval, so
   * the reward screen was literally unobservable and its captures silently
   * photographed whatever state the run had reached instead.
   */
  holdChoice: boolean
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
    holdChoice: params.get('holdchoice') === '1',
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
  // The real content tables. World defaults to empty so sim tests can fabricate
  // items; the app is what supplies the shipping set.
  const content: RunContent = { items: ITEMS, interactions: INTERACTIONS }
  let world = new World(seed, content)
  let sceneStars = new Starfield(seed)
  const titleStars = new Starfield(`${seed}:title`, VIRTUAL_W, VIRTUAL_H)
  let menuTick = 0
  let pauseSelection = 0
  let hangarSelection = 0
  let personnelSelection = 0
  let personnelScroll = 0
  /** Guards double-filing: the run-ended transition can be reached more than once. */
  let filed = false
  let newlyCertified: readonly string[] = []

  /**
   * The pool this run draws from, fixed at the start of the sortie.
   *
   * Captured once rather than recomputed, so certifying something mid-run cannot
   * change the run in progress — and so the fingerprint filed in the personnel record
   * describes the pool that was actually played.
   */
  let runPool = poolFor(unlockedSet(save.certifications.unlocked))

  const panelState: PanelState = {
    pilotNumber: save.pilotNumber,
    hullName: 'Lien',
    weaponName: 'Twin Pulse',
    // Read from the run, never hand-written: items change this constantly and the
    // HUD advertising a rate the weapon does not have has already shipped once.
    fireRate: world.shotsPerSecond,
    sector: 1,
    // Sectors that exist, not sectors that are planned. See SECTORS.
    sectorCount: SECTORS.length,
    waveCount: SECTOR_ONE.waves.length,
    // Without the table the build readout formats ids instead of authored names.
    items: ITEMS,
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

  /**
   * File a finished run: certifications earned, and the pilot's record.
   *
   * Called exactly once per run, at the transition out of 'active', because both
   * stores are append-only and filing twice would double-count a death. Both read the
   * same `RunSummary` so a certification and the history can never disagree about what
   * happened.
   */
  function fileCompletedRun(): void {
    if (filed) return
    filed = true

    const summary = summariseRun(world, SECTOR_ONE.waves.length)
    const result = fileRun(summary, save.certifications)
    save.certifications = result.state
    newlyCertified = result.newlyUnlocked.map((id) => getCertification(id)?.name ?? id)

    const appended = appendPersonnelRecord(
      save.personnel,
      buildPersonnelRecord(world, {
        pilotNumber: save.pilotNumber,
        hullId: panelState.hullName.toLowerCase(),
        sectorId: SECTOR_ONE.id,
        poolFingerprint: fingerprintPool(runPool),
      }),
    )
    save.personnel = appended.history

    // The company calls the next pilot. Advancing here rather than at launch is what
    // makes the first pilot #001, and what makes the filed record carry the number of
    // the pilot it is actually about.
    save.pilotNumber += 1
    persistSave(save)
  }

  function beginSortie(): void {
    // NOTE: the pilot number is NOT incremented here. It advances when a pilot is
    // lost, in fileCompletedRun — incrementing on launch meant a brand-new player's
    // first sortie was pilot 002 and #001 never existed at all. The number names the
    // pilot currently flying, so it can only change once that pilot is finished with.
    panelState.pilotNumber = save.pilotNumber

    seed = generateSeed()
    runPool = poolFor(unlockedSet(save.certifications.unlocked))
    world = new World(seed, { ...content, workOrders: runPool.workOrders })
    sceneStars = new Starfield(seed)
    resetFeelState(feel)
    filed = false
    newlyCertified = []
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
    // Held choices get neutral input so nothing confirms and the card stays up for
    // the capture. Everything else still runs, so the frame is a real one.
    const holding = options.holdChoice && world.pendingChoice !== null
    const input: InputSnapshot = holding
      ? NEUTRAL_INPUT
      : options.autopilot
        ? options.autopilot(world)
        : keyboard.snapshot()

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
      fileCompletedRun()
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
        // Left and right off the title reach the two record screens. Deliberately not
        // a menu: the title's one primary action stays "fly", and these are somewhere
        // to go rather than something to get past (UI rule 6's spirit).
        if (keyboard.consumePressed('left')) {
          audio.confirm()
          hangarSelection = 0
          screen = 'hangar'
        }
        if (keyboard.consumePressed('right')) {
          audio.confirm()
          personnelSelection = 0
          personnelScroll = 0
          screen = 'personnel'
        }
        return
      }

      if (screen === 'paused') {
        updatePauseMenu()
        return
      }

      if (screen === 'hangar') {
        menuTick++
        if (keyboard.consumePressed('up')) {
          hangarSelection = moveHangarSelection(hangarSelection, -1, CERTIFICATIONS.length)
        }
        if (keyboard.consumePressed('down')) {
          hangarSelection = moveHangarSelection(hangarSelection, 1, CERTIFICATIONS.length)
        }
        if (keyboard.consumePressed('cancel') || keyboard.consumePressed('pause')) {
          audio.cancel()
          screen = 'title'
        }
        return
      }

      if (screen === 'personnel') {
        menuTick++
        const count = save.personnel.length
        if (keyboard.consumePressed('up')) {
          personnelSelection = movePersonnelSelection(personnelSelection, -1, count)
        }
        if (keyboard.consumePressed('down')) {
          personnelSelection = movePersonnelSelection(personnelSelection, 1, count)
        }
        personnelScroll = personnelScrollFor(personnelSelection, personnelScroll, count)
        if (keyboard.consumePressed('cancel') || keyboard.consumePressed('pause')) {
          audio.cancel()
          screen = 'title'
        }
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

      if (screen === 'hangar') {
        drawHangar(ctx, {
          unlocked: unlockedSet(save.certifications.unlocked),
          progress: save.certifications.progress,
          waveCount: SECTOR_ONE.waves.length,
          selected: hangarSelection,
          tick: menuTick,
        })
        return
      }

      if (screen === 'personnel') {
        drawPersonnelScreen(ctx, {
          // Newest first for reading; the store is oldest-first so appends are cheap.
          records: newestFirst(save.personnel),
          selected: personnelSelection,
          scroll: personnelScroll,
          view: 'list',
          tick: menuTick,
          basePool: BASE_POOL,
          names: {
            items: Object.fromEntries(Object.values(ITEMS).map((i) => [i.id, i.name])),
            enemies: Object.fromEntries(Object.values(ENEMIES).map((e) => [e.id, e.name])),
            sectors: { [SECTOR_ONE.id]: SECTOR_ONE.name },
          },
          skipped: 0,
          dropped: 0,
        })
        return
      }

      // Paused and dead both freeze the playfield, so interpolation must not keep
      // sliding entities toward a tick that will never be simulated.
      const frozen = screen === 'incident' || screen === 'paused'
      // Refreshed every frame from the run: an item taken mid-sortie changes this,
      // and a stale copy is precisely the HUD-lies-about-the-weapon bug again.
      panelState.fireRate = world.shotsPerSecond
      drawScene(ctx, world, sceneStars, frozen ? 0 : alpha, {
        feel,
        shakeScale: save.settings.shake,
      })

      // Not drawn under a choice card either: the card spans nearly the full width
      // over a heavy scrim, and a thin strip of live panel ghosting past its edge
      // reads as a rendering bug — the same finding as the incident report.
      const choosing = world.pendingChoice !== null

      // The panel is deliberately NOT drawn under the incident report: its scrim
      // is translucent by design, and translucency over live readouts left panel
      // text legibly ghosting through the right margin. Faint wreckage behind
      // paperwork is atmosphere; faint numbers are noise. The pause menu is a
      // smaller card, so the panel stays visible behind it.
      if (screen !== 'incident' && !choosing) drawPanel(ctx, world, panelState)

      if (choosing) {
        drawChoiceScreen(ctx, world, {
          // The simulation owns the cursor so a recorded run reproduces its picks;
          // this screen renders that selection rather than holding one.
          selected: world.choiceSelection,
          tick: world.stats.tick,
          items: ITEMS,
          awaitingRelease: world.choiceAwaitingRelease,
        })
        return
      }


      if (choosing) {
        drawChoiceScreen(ctx, world, {
          // The simulation owns the cursor so a recorded run reproduces its picks;
          // this screen renders that selection rather than holding one.
          selected: world.choiceSelection,
          tick: world.stats.tick,
          items: ITEMS,
          awaitingRelease: world.choiceAwaitingRelease,
        })
        return
      }

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
          ...(newlyCertified.length > 0 ? { certifications: newlyCertified } : {}),
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
      /** Null unless a reward card is open. Lets a capture wait on the real state. */
      get choiceKind() {
        return world.pendingChoice?.kind ?? null
      },
      get heldItems() {
        return world.inventory.length
      },
      /** Certifications filed. Lets a capture prove a fresh save really is fresh. */
      get certifiedCount() {
        return save.certifications.unlocked.length
      },
      get filedRuns() {
        return save.personnel.length
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
