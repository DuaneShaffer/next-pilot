/**
 * Entry point. Wires input, simulation, presentation, and persistence together.
 *
 * This is the only module allowed to know about all the layers at once. It reads
 * the keyboard, advances a World, drains that World's events, and hands a
 * WorldView to the renderers — which is why the sim can stay headless and every
 * screen can be drawn from a view alone. Keep game logic out of here.
 */

import { FixedLoop } from './core/loop'
import { Keyboard, NEUTRAL_INPUT, unpackInput, type InputSnapshot } from './core/input'
import { generateSeed, isValidSeed, normalizeSeed } from './core/seed'
import { VIRTUAL_H, VIRTUAL_W } from './core/space'
import { ENEMIES } from './content/enemies'
import { SECTORS, getSector } from './content/sectors'
import { ITEMS } from './content/items'
import { INTERACTIONS } from './content/interactions'
import { BOSSES } from './content/bosses'
import { HAZARDS } from './content/hazards'
import { HULLS, LIEN_ID } from './content/hulls'
import { STANDARD_RUN } from './content/runs'
import { Rng } from './core/rng'
import {
  HULL_OFFER_STREAM,
  drawHullSelect,
  moveHullSelection,
  offerHulls,
  shouldShowHullSelect,
} from './ui/hullSelect'
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
import { dailyContract, resolveRunMode, shareReplay, type RunMode } from './meta/seedModes'
import { ReplayRecorder } from './meta/replay'
import { describeIncompatibility, checkReplayCompatibility } from './meta/simVersion'
import { drawChoiceScreen } from './ui/choiceScreen'
import { drawHangar, moveHangarSelection } from './ui/hangar'
import {
  drawPersonnelScreen,
  movePersonnelSelection,
  personnelScrollFor,
} from './ui/personnel'
import {
  EMPTY_SEED_ENTRY,
  drawSeedEntry,
  drawShareCard,
  moveShareSelection,
  seedEntryReduce,
  validateSeedDraft,
  type SeedEntryState,
  type ShareChoice,
} from './ui/seedEntry'
import { drawIncidentReport } from './ui/incidentReport'
import {
  PAUSE_ITEMS,
  adjustSetting,
  drawPauseMenu,
  movePauseSelection,
} from './ui/pauseMenu'
import { drawTitleScreen } from './ui/titleScreen'

const VERSION = 'v0.2.0 · m2'

type Screen =
  | 'title'
  | 'hull-select'
  | 'sortie'
  | 'paused'
  | 'incident'
  | 'hangar'
  | 'personnel'
  | 'seed-entry'
  | 'share'

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

  /**
   * Screens the URL may jump straight to.
   *
   * Deliberately a whitelist rather than a cast: `?screen=` is reachable from a
   * shared link, and a screen the app cannot render from a cold start would leave a
   * black page. `hull-select` is here so the capture harness can photograph it —
   * without a URL route it is reachable only through a sortie launch, which is a
   * screen nobody could ever review.
   */
  const rawScreen = params.get('screen')
  const jumpable: readonly Screen[] = ['sortie', 'hull-select', 'hangar', 'personnel']
  const requested = jumpable.find((name) => name === rawScreen)

  return {
    seed,
    // An autopilot with nothing to fly is pointless, so it implies a sortie.
    screen: autopilot ? 'sortie' : (requested ?? 'title'),
    autopilot,
    fastForward,
    holdChoice: params.get('holdchoice') === '1',
  }
}

function main(): void {
  const canvas = document.querySelector<HTMLCanvasElement>('#game')
  if (!canvas) throw new Error('Missing #game canvas element.')

  const params = new URLSearchParams(location.search)
  const preliminary = loadSave()
  /**
   * Resolve what kind of run this is BEFORE anything else reads the URL.
   *
   * Precedence is pinned in seedModes (replay > daily > shared > free) so a URL
   * carrying contradictory intent produces one answer and a notice, rather than a run
   * whose label disagrees with what it actually is.
   */
  const resolved = resolveRunMode({
    params,
    now: new Date(),
    dailyRecord: preliminary.daily,
    randomSeed: generateSeed,
  })
  const options = readUrlOptions(resolved.mode.seed)
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
  const content: RunContent = {
    items: ITEMS,
    interactions: INTERACTIONS,
    run: STANDARD_RUN,
    sectors: Object.fromEntries(SECTORS.map((sector) => [sector.id, sector])),
    bosses: BOSSES,
    hazards: HAZARDS,
  }
  let world = new World(seed, content)

  /**
   * Waves in a given sector, for the progress readouts.
   *
   * A function rather than a constant because the denominator is now per-sector: a
   * panel reading "WAVE 4 / 30" against sector one's count while flying sector four
   * is the same class of bug as the "SECTOR 1 / 5" a tester reported.
   */
  function waveCountFor(sectorId: string): number {
    return getSector(sectorId).waves.length
  }
  let sceneStars = new Starfield(seed)
  const titleStars = new Starfield(`${seed}:title`, VIRTUAL_W, VIRTUAL_H)
  let menuTick = 0
  let pauseSelection = 0
  let hangarSelection = 0
  /** The hulls this sortie offers, drawn once from the run seed. */
  let hullOffer: readonly string[] = []
  let hullSelection = 0
  /**
   * The hull issued, kept as an id.
   *
   * Not derived from the display name. `fileCompletedRun` used to lower-case
   * `panelState.hullName` to get an id, which was correct only because every hull was
   * called "Lien" and every id was "lien".
   */
  let currentHullId: string = LIEN_ID
  let personnelSelection = 0
  let personnelScroll = 0
  /** Guards double-filing: the run-ended transition can be reached more than once. */
  let filed = false
  let newlyCertified: readonly string[] = []
  let seedEntry: SeedEntryState = EMPTY_SEED_ENTRY
  let shareSelection: ShareChoice = 'seed'
  let copiedChoice: ShareChoice | null = null

  /**
   * Records the run's inputs so it can be shared afterwards.
   *
   * Recording always, rather than on request: a player only knows a run was worth
   * sharing once it is over, and by then the inputs are gone. One byte per tick is
   * cheap enough that the alternative — asking first — is the wrong trade.
   */
  let recorder = new ReplayRecorder(options.seed, LIEN_ID)

  /**
   * How this run was started. Resolved once, from the URL and the save.
   *
   * The HUD labels the run from this, so a shared seed cannot silently present itself
   * as a daily contract and vice versa.
   */
  let runMode: RunMode = resolved.mode

  /**
   * A replay must be flown in the hull it was recorded in.
   *
   * The startup world is built before `runMode` is known, with no hull — which was
   * harmless only while every run flew a Lien. `Replay` now carries `hullId`, and a
   * Collateral recording played back in a Lien fires 20 shots a second instead of 30
   * and diverges within a few ticks, silently, while the share card advertises it as
   * the same run.
   *
   * Rebuilt rather than made conditional at construction because the run mode is
   * resolved after the world: the alternative is threading replay resolution earlier
   * than the save load, and a second `new World` at startup costs nothing.
   */
  if (runMode.kind === 'replay') {
    const recorded = runMode.replay.hullId
    currentHullId = Object.hasOwn(HULLS, recorded) ? recorded : LIEN_ID
    world = new World(seed, {
      ...content,
      ...(HULLS[currentHullId] ? { hull: HULLS[currentHullId] } : {}),
    })
    // `panelState` is declared below and reads `world.hullName` at construction, so
    // it picks this up without an assignment here.
  }

  /**
   * A sentence to show when the URL was not honoured.
   *
   * Either a rejected parameter combination, or a replay recorded on rules this build
   * no longer has. Both are cases where the player asked for something specific and
   * got something else, so neither may pass silently.
   */
  const startupNotice: string | null =
    resolved.notice ??
    (resolved.mode.kind === 'replay'
      ? describeIncompatibility(checkReplayCompatibility(resolved.mode.replay.simVersion))
      : null)
  if (startupNotice !== null) console.info(`[next-pilot] ${startupNotice}`)

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
    // Every one of these comes off the live run rather than being hand-written.
    // The panel has twice shipped a number the simulation disagreed with — a fire
    // rate off by 2x, and "SECTOR 1 / 5" for the whole game — and both times the
    // cause was the same: the panel describing the plan instead of the run.
    hullName: world.hullName,
    weaponName: 'Twin Pulse',
    fireRate: world.shotsPerSecond,
    sector: world.stage.index + 1,
    sectorCount: world.stage.count,
    waveCount: waveCountFor(world.sectorId),
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
  /**
   * The share offer for the run just finished.
   *
   * Recomputed rather than cached because it depends on the recorded length, and a
   * stale offer would advertise a link the recorder can no longer produce.
   */
  function currentShare(): ReturnType<typeof shareReplay> {
    return shareReplay(location.origin + location.pathname, recorder.toReplay(), runMode.purist)
  }

  /**
   * Copy without assuming the clipboard exists.
   *
   * `navigator.clipboard` is undefined on insecure origins and can reject when the
   * document is not focused. Either way the copy simply does not happen, and the card
   * already shows the URL as text — so a failure costs the player a convenience, not
   * the link.
   */
  function copyToClipboard(text: string): void {
    void globalThis.navigator?.clipboard?.writeText(text).catch(() => {})
  }

  function fileCompletedRun(): void {
    if (filed) return
    filed = true

    const summary = summariseRun(world, waveCountFor(world.sectorId))
    const result = fileRun(summary, save.certifications)
    save.certifications = result.state
    newlyCertified = result.newlyUnlocked.map((id) => getCertification(id)?.name ?? id)

    const appended = appendPersonnelRecord(
      save.personnel,
      buildPersonnelRecord(world, {
        pilotNumber: save.pilotNumber,
        hullId: currentHullId,
        sectorId: world.sectorId,
        poolFingerprint: fingerprintPool(runPool),
      }),
    )
    save.personnel = appended.history

    // A daily contract is recorded so it cannot be re-rolled by quitting until the
    // first wave looks survivable. `abandoned` exists for exactly that reason.
    if (runMode.kind === 'daily') {
      save.daily = {
        date: runMode.date,
        ticks: world.stats.tick,
        waveIndex: world.stats.waveIndex,
        scrap: world.stats.scrap,
        outcome: world.runState === 'extracted' ? 'extracted' : 'lost',
      }
    }

    // The company calls the next pilot. Advancing here rather than at launch is what
    // makes the first pilot #001, and what makes the filed record carry the number of
    // the pilot it is actually about.
    save.pilotNumber += 1
    persistSave(save)
  }

  function beginSortie(withSeed?: string): void {
    // NOTE: the pilot number is NOT incremented here. It advances when a pilot is
    // lost, in fileCompletedRun — incrementing on launch meant a brand-new player's
    // first sortie was pilot 002 and #001 never existed at all. The number names the
    // pilot currently flying, so it can only change once that pilot is finished with.
    panelState.pilotNumber = save.pilotNumber

    seed = withSeed ?? generateSeed()
    runPool = poolFor(unlockedSet(save.certifications.unlocked))

    // Its own named stream off the run seed, so the same seed always offers the same
    // hulls and adding this draw cannot shift any other roll in the run.
    hullOffer = offerHulls(Rng.fromSeed(seed, HULL_OFFER_STREAM), runPool.hulls ?? [])
    hullSelection = 0

    // Skipped when the pool holds nothing but the Lien. A card whose only action is
    // "continue" teaches the player that stopping is pointless — the mistake the
    // unbuyable wave-8 shop and the inert work-order card both already made — and it
    // would put a third input in the death-to-next-run path that UI.md rule 6 caps
    // at two.
    if (!shouldShowHullSelect(hullOffer)) {
      launchSortie(hullOffer[0] ?? LIEN_ID)
      return
    }
    screen = 'hull-select'
    menuTick = 0
    keyboard.clearPressed()
  }

  /**
   * Build the run. Split out of `beginSortie` so a hull can be chosen in between.
   */
  function launchSortie(hullId: string): void {
    currentHullId = Object.hasOwn(HULLS, hullId) ? hullId : LIEN_ID
    world = new World(seed, {
      ...content,
      workOrders: runPool.workOrders,
      ...(HULLS[currentHullId] ? { hull: HULLS[currentHullId] } : {}),
    })
    panelState.hullName = world.hullName
    sceneStars = new Starfield(seed)
    resetFeelState(feel)
    // The hull is recorded WITH the run. A replay was seed + inputs, which was
    // lossless only because every run flew a Lien; a Collateral run played back as a
    // Lien fires 20 shots/second instead of 30 and diverges within a few ticks.
    recorder = new ReplayRecorder(seed, currentHullId)
    runMode = { kind: 'free', seed, purist: false }
    filed = false
    newlyCertified = []
    screen = 'sortie'
    menuTick = 0
    keyboard.clearPressed()
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
    // A replay drives the sim from its recorded log; nothing else may touch input
    // while one is playing, or the run stops being the run that was shared.
    const replayInput =
      runMode.kind === 'replay' && world.stats.tick < runMode.replay.inputs.length
        ? unpackInput(runMode.replay.inputs[world.stats.tick] ?? 0)
        : null

    const input: InputSnapshot = replayInput
      ? replayInput
      : holding
        ? NEUTRAL_INPUT
        : options.autopilot
          ? options.autopilot(world)
          : keyboard.snapshot()

    // Recorded before the tick, so a replay's byte N is the input that produced
    // tick N — the same alignment playback assumes.
    recorder.record(input)
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
        if (keyboard.consumePressed('up')) {
          audio.confirm()
          seedEntry = EMPTY_SEED_ENTRY
          screen = 'seed-entry'
        }
        return
      }

      if (screen === 'paused') {
        updatePauseMenu()
        return
      }

      if (screen === 'seed-entry') {
        menuTick++
        if (keyboard.consumePressed('left')) seedEntry = seedEntryReduce(seedEntry, { kind: 'move', dx: -1, dy: 0 })
        if (keyboard.consumePressed('right')) seedEntry = seedEntryReduce(seedEntry, { kind: 'move', dx: 1, dy: 0 })
        if (keyboard.consumePressed('up')) seedEntry = seedEntryReduce(seedEntry, { kind: 'move', dx: 0, dy: -1 })
        if (keyboard.consumePressed('down')) seedEntry = seedEntryReduce(seedEntry, { kind: 'move', dx: 0, dy: 1 })
        if (keyboard.consumePressed('confirm')) {
          const validation = validateSeedDraft(seedEntry)
          if (validation.status === 'complete' && validation.seed !== null) {
            audio.confirm()
            beginSortie(validation.seed)
          } else {
            seedEntry = seedEntryReduce(seedEntry, { kind: 'commit' })
          }
        }
        if (keyboard.consumePressed('special')) seedEntry = seedEntryReduce(seedEntry, { kind: 'erase' })
        if (keyboard.consumePressed('cancel') || keyboard.consumePressed('pause')) {
          audio.cancel()
          screen = 'title'
        }
        return
      }

      if (screen === 'share') {
        menuTick++
        const share = currentShare()
        if (keyboard.consumePressed('up')) shareSelection = moveShareSelection(shareSelection, -1, share)
        if (keyboard.consumePressed('down')) shareSelection = moveShareSelection(shareSelection, 1, share)
        if (keyboard.consumePressed('confirm')) {
          const url = shareSelection === 'replay' ? share.url : share.seedUrl
          if (url !== null) {
            audio.confirm()
            copyToClipboard(url)
            copiedChoice = shareSelection
          }
        }
        if (keyboard.consumePressed('cancel') || keyboard.consumePressed('pause')) {
          audio.cancel()
          screen = 'incident'
        }
        return
      }

      if (screen === 'hull-select') {
        menuTick++
        if (keyboard.consumePressed('up')) {
          hullSelection = moveHullSelection(hullSelection, -1, hullOffer.length)
        }
        if (keyboard.consumePressed('down')) {
          hullSelection = moveHullSelection(hullSelection, 1, hullOffer.length)
        }
        if (keyboard.consumePressed('confirm')) {
          audio.confirm()
          launchSortie(hullOffer[hullSelection] ?? LIEN_ID)
        }
        if (keyboard.consumePressed('cancel') || keyboard.consumePressed('pause')) {
          audio.cancel()
          screen = 'title'
        }
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
        // UI rule 6: one input from death to the next sortie. Sharing is a second,
        // optional path rather than a step on the way — the loop stays "again".
        if (keyboard.consumePressed('confirm')) {
          audio.confirm()
          beginSortie()
        }
        if (keyboard.consumePressed('up')) {
          audio.confirm()
          shareSelection = 'seed'
          copiedChoice = null
          screen = 'share'
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

      if (screen === 'seed-entry') {
        drawSeedEntry(ctx, {
          entry: seedEntry,
          daily: dailyContract(new Date(), save.daily),
          tick: menuTick,
        })
        return
      }

      if (screen === 'share') {
        drawShareCard(ctx, {
          mode: runMode,
          share: currentShare(),
          selected: shareSelection,
          copied: copiedChoice,
          tick: menuTick,
        })
        return
      }

      if (screen === 'hull-select') {
        drawHullSelect(ctx, {
          offer: hullOffer,
          selected: hullSelection,
          tick: menuTick,
          seed,
          poolCount: runPool.hulls?.length ?? 0,
          reduceFlashes: save.settings.reduceFlashes,
        })
        return
      }

      if (screen === 'hangar') {
        drawHangar(ctx, {
          unlocked: unlockedSet(save.certifications.unlocked),
          progress: save.certifications.progress,
          waveCount: waveCountFor(world.sectorId),
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
            sectors: Object.fromEntries(SECTORS.map((s) => [s.id, s.name])),
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
      panelState.reduceFlashes = save.settings.reduceFlashes
      // Stage identity is refreshed here too, for exactly the same reason. It changes
      // mid-run now, and a copy taken at launch would tell a pilot in sector four
      // that they are in sector one — which is the bug a tester already reported.
      panelState.sector = world.stage.index + 1
      panelState.sectorCount = world.stage.count
      panelState.waveCount = waveCountFor(world.sectorId)
      drawScene(ctx, world, sceneStars, frozen ? 0 : alpha, {
        feel,
        shakeScale: save.settings.shake,
        // `reduceFlashes` shipped in the save schema at v3 and NOTHING consumed it
        // for two milestones: the menu offered it, the save stored it, and it did
        // nothing. A setting that does nothing is worse than a missing one, because
        // a player who needs it believes they have turned it on.
        reduceFlashes: save.settings.reduceFlashes,
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
          waveCount: waveCountFor(world.sectorId),
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
          sectorName: world.stage.sectorName,
          sector: panelState.sector,
          sectorCount: panelState.sectorCount,
          waveCount: waveCountFor(world.sectorId),
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
      /**
       * Which leg of the run is being flown, 0-based.
       *
       * Every M5 capture waits on this rather than on elapsed time. A sector takes
       * three minutes and a whole run takes fifteen, so "wait 400 seconds and hope"
       * is exactly the time-driven capture that once photographed a healthy ship and
       * filed it as the death screen.
       */
      get stageIndex() {
        return world.stage.index
      },
      get stageCount() {
        return world.stage.count
      },
      /** Boss name while one is alive, else null. */
      get bossName() {
        return world.boss?.boss?.name ?? null
      },
      get bossPhase() {
        return world.boss?.boss?.phaseIndex ?? -1
      },
      /** Boss health as a fraction, for waiting on a late phase. */
      get bossHealth() {
        const boss = world.boss
        return boss && boss.maxHp > 0 ? boss.hp / boss.maxHp : -1
      },
      /** The phase of the most urgent hazard: 'active' beats 'warning' beats 'idle'. */
      get hazardPhase() {
        const phases = world.hazards.map((h) => h.phase)
        if (phases.includes('active')) return 'active'
        if (phases.includes('warning')) return 'warning'
        return phases.length > 0 ? 'idle' : null
      },
      get hazardCount() {
        return world.hazards.length
      },
      get stats() {
        return { ...world.stats, ...loop.getStats() }
      },
    },
  })

  /**
   * A URL jumping straight to hull selection still has to go through `beginSortie`.
   *
   * The offer is drawn there, so setting the screen alone would render a selection
   * card with nothing on it. If the pool holds only the Lien this launches a sortie
   * instead — which is correct, and which the capture harness reports as a loud
   * failure rather than photographing the wrong screen.
   */
  if (screen === 'hull-select') beginSortie(seed)

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
