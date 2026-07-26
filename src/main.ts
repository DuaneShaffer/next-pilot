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
import {
  adoptLegacySave,
  loadSave,
  loadSaveWithReport,
  persistSave,
  type Save,
  type Settings,
} from './meta/save'
import { Viewport } from './render/layout'
import { createFeelState, feelTick, resetFeelState } from './render/feel'
import { drawPanel, type PanelState } from './render/panel'
import { drawScene } from './render/scene'
import { Starfield } from './render/starfield'
import { BOTS, isBotName, isRouteStyle, type BotPolicy } from './sim/bots'
import { World, type RunContent } from './sim/world'
import type { PendingChoiceKind } from './sim/entities'
import { BASE_POOL, CERTIFICATIONS, getCertification } from './content/certifications'
import { fileRun, poolForRun, summariseRun, unlockedSet } from './meta/certifications'
import {
  appendPersonnelRecord,
  buildPersonnelRecord,
  newestFirst,
} from './meta/personnel'
import { fingerprintPool } from './meta/purist'
import {
  certificationsForMode,
  claimSortieMode,
  dailyContract,
  resolveRunMode,
  shareReplay,
  type RunMode,
} from './meta/seedModes'
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
import { describeSaveLoss, type SaveNotice } from './ui/saveNotice'
import { loadBindings, persistBindings } from './meta/keybinds'
import {
  createSettingsState,
  drawSettingsScreen,
  markSaved,
  settingsReduce,
  type SettingsState,
} from './ui/settings'

const VERSION = 'v0.2.0 · m2'

type Screen =
  | 'title'
  | 'settings'
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
   * Which kind of card the autopilot may not resolve, so it stays open to be captured.
   *
   * A capture affordance. A bot resolves a choice in about six ticks, which at any
   * useful fast-forward is ~25ms — shorter than the harness's polling interval, so a
   * reward screen was literally unobservable and its captures silently photographed
   * whatever state the run had reached instead.
   *
   * KIND-AWARE rather than a boolean, and that was not a refinement — as a boolean it
   * made every LATE card unreachable by construction. Holding *any* card meant the
   * run's first item card (tick 2358) stayed open forever, the ship stopped flying,
   * and the run died in sector one — three seams short of the route card the capture
   * was for. A capture that cannot reach its state is not flaky, it is impossible.
   *
   * `'any'` keeps the old behaviour for the item and shop captures, which want the
   * first card they see.
   */
  holdChoice: PendingChoiceKind | 'any' | null
}

/**
 * Parse `?holdchoice=`. Unknown values are refused rather than coerced.
 *
 * `1` means "any", for the captures written before this was kind-aware.
 */
function readHoldChoice(raw: string | null): PendingChoiceKind | 'any' | null {
  if (raw === null) return null
  if (raw === '1' || raw === 'any') return 'any'
  const kinds: readonly PendingChoiceKind[] = ['item', 'shop', 'work-order', 'route']
  return kinds.find((kind) => kind === raw) ?? null
}

/** Ceiling on fast-forward, so a typo can't wedge the page in a long loop. */
const MAX_FAST_FORWARD = 32

function readUrlOptions(fallbackSeed: string): UrlOptions {
  const params = new URLSearchParams(location.search)

  const rawSeed = params.get('seed')
  const seed = rawSeed && isValidSeed(rawSeed) ? normalizeSeed(rawSeed) : fallbackSeed

  const rawAutopilot = params.get('autopilot')
  /**
   * `?route=` selects the policy's route style.
   *
   * Needed because the hazard captures drove `aggressor`, which is pinned to
   * `routeStyle: 'direct'` on purpose — it is the clear-rate benchmark, so the number
   * the exit criterion is read off must not also measure optional risk-taking. That
   * made it the one policy that can never meet a hazard, and the two hazard captures
   * were therefore waiting for a state their own pilot had declined.
   *
   * A bot accepting a hazard route is a legal choice a player can make, so this is a
   * capture affordance rather than a cheat — unlike a god-mode flag, which would
   * change the run it is meant to photograph.
   */
  const rawRoute = params.get('route')
  const routeStyle = rawRoute !== null && isRouteStyle(rawRoute) ? rawRoute : undefined
  const autopilot =
    rawAutopilot && isBotName(rawAutopilot)
      ? BOTS[rawAutopilot].create(seed, routeStyle ? { routeStyle } : undefined)
      : null

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
    holdChoice: readHoldChoice(params.get('holdchoice')),
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
  const adopted = adoptLegacySave()
  /**
   * THE REPORTING LOAD, not `loadSave()`.
   *
   * `loadSave` throws the report away, which its own header says is only for callers
   * with nowhere to show it. This one has somewhere: the title screen. Before this,
   * every field of `SaveLoadReport` was computed and discarded, so a save that could
   * not be read silently became a fresh game — a pilot with thirty sorties behind them
   * opened the game at #001 with an empty hangar and nothing said why.
   *
   * Read after adoption on purpose: `adoptLegacySave` writes the migrated v1 payload
   * under the current key, so this sees it and reports it as the clean load it is.
   */
  const loaded = loadSaveWithReport()
  const save: Save = adopted ?? loaded.save

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
  /**
   * What loading the save cost, until the player acknowledges it.
   *
   * SESSION-LOCAL, and deliberately not persisted. "I have seen this" is not part of a
   * player's progress, and adding a field to the save to hold it would mean a new
   * numbered interface, a migration and a fixture test (CLAUDE.md) to record a fact
   * that stops mattering the moment the notice is dismissed.
   *
   * The honest consequence: reload without flying, with the same unreadable bytes still
   * in storage, and it is reported again — because it is still true. Flying one sortie
   * calls `persistSave` and writes a readable file, after which there is nothing to
   * report. What must not happen, and does not, is it coming back inside a session
   * after being dismissed.
   */
  let saveNotice: SaveNotice | null = describeSaveLoss(loaded.report)
  /**
   * Personnel entries this session lost, for the personnel screen's own footer notice.
   *
   * `drawPersonnelScreen` has taken `skipped` and `dropped` since it was written, and
   * this file passed literal zeroes — so `personnelSkippedText` and
   * `personnelDroppedText` could never appear on the screen a player goes to in order
   * to look at the history the loss is about. The title notice says it happened; this
   * says it about the list itself. Seeded from the load, and added to when a filing
   * evicts an older file mid-session.
   */
  const personnelSkipped = loaded.report.personnelSkipped
  let personnelDropped = loaded.report.personnelDropped.length
  /**
   * Key bindings, in their own store.
   *
   * Separate from the save on purpose: bindings are a property of the keyboard in
   * front of you rather than of your progress, a corrupt keymap must not cost a
   * player their pilot history (`loadSave` falls back to defaults on any corruption),
   * and "reset my keys" must not sit next to "reset my progress".
   */
  let bindings = loadBindings()
  keyboard.setBindings(bindings)
  keyboard.setAutoFire(save.settings.autoFire)
  let settingsState: SettingsState | null = null
  /** Where ESC from the settings screen returns to. */
  let settingsReturn: Screen = 'title'

  function openSettings(from: Screen): void {
    settingsReturn = from
    settingsState = createSettingsState(save.settings, bindings)
    screen = 'settings'
    keyboard.clearPressed()
  }

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
   * The mode the URL asked for, waiting to be flown — consumed by the first sortie.
   *
   * REGRESSION THIS FIXES, and it was M4's headline feature: a `?seed=`, `?daily=1`
   * or `?replay=` link resolved correctly, the title screen displayed it, and then the
   * first keypress threw it away. `beginSortie()` is called from the title with no
   * argument, `seed = withSeed ?? generateSeed()` rolled a fresh one, and
   * `launchSortie` unconditionally overwrote `runMode` with `{ kind: 'free' }`. Share
   * links carry only `seed`/`r`/`daily` and never `screen=sortie`, so **every** shared
   * seed, daily contract and replay landed on the title and was discarded.
   *
   * Landing on the title rather than launching straight in is deliberate and stays:
   * the title already names the contract, and a daily should be read before it is
   * flown. What was missing is that confirming there has to fly the thing it named.
   *
   * Consumed once, then null: a daily contract is one attempt, and the run after a
   * death is a fresh free run. That is also what makes `save.daily` meaningful.
   */
  let pendingMode: RunMode | null = resolved.mode.kind === 'free' ? null : resolved.mode

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
   * The pool this run draws from, fixed at the start of the sortie, and the exact
   * certifications that produced it.
   *
   * Captured once rather than recomputed, so certifying something mid-run cannot
   * change the run in progress — and so the fingerprint filed in the personnel record
   * describes the pool that was actually played.
   *
   * THE MODE DECIDES WHICH IDS APPLY, not the save alone. A daily contract and a
   * `?purist=1` link fly the base pool whatever this pilot has certified, and a replay
   * flies the pool it was recorded with. That decision is `certificationsForMode`, a
   * pure function in seedModes.ts, because it lived here as "read the save" for a
   * whole milestone and nothing in the suite could see it: two pilots were handed
   * different hulls on the same daily contract and the share card said PURIST over a
   * run that was not.
   */
  let runCertified = poolForRun(certificationsForMode(runMode, save.certifications.unlocked))
  let runPool = runCertified.pool

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
    // `appendPersonnelRecord` returns what the cap forced out precisely so the caller
    // can say so, and this discarded it. The screen already has a line for it.
    personnelDropped += appended.dropped.length

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

    // Precedence lives in `claimSortieMode`, a pure function in seedModes.ts, because
    // this decision going wrong inside untestable app wiring is exactly how M4's
    // headline feature shipped broken. See that function's header.
    const claim = claimSortieMode(pendingMode, withSeed, generateSeed)
    pendingMode = claim.nextPending
    const claimed = claim.mode
    seed = claimed.seed
    runCertified = poolForRun(certificationsForMode(claimed, save.certifications.unlocked))
    runPool = runCertified.pool

    // Its own named stream off the run seed, so the same seed always offers the same
    // hulls and adding this draw cannot shift any other roll in the run.
    hullOffer = offerHulls(Rng.fromSeed(seed, HULL_OFFER_STREAM), runPool.hulls ?? [])
    hullSelection = 0

    // Skipped when the pool holds nothing but the Lien. A card whose only action is
    // "continue" teaches the player that stopping is pointless — the mistake the
    // unbuyable wave-8 shop and the inert work-order card both already made — and it
    // would put a third input in the death-to-next-run path that UI.md rule 6 caps
    // at two.
    // A REPLAY HAS NO CHOICE TO MAKE. The hull is part of the recording — see
    // `Replay.hullId` — so offering a selection would let the player pick a ship the
    // input log was not flown in, which diverges immediately. Everything else about
    // playback is already fixed by the recording; the hull is too.
    if (claimed?.kind === 'replay') {
      launchSortie(claimed.replay.hullId || LIEN_ID, claimed)
      return
    }

    if (!shouldShowHullSelect(hullOffer)) {
      launchSortie(hullOffer[0] ?? LIEN_ID, claimed)
      return
    }
    pendingHullMode = claimed
    screen = 'hull-select'
    menuTick = 0
    keyboard.clearPressed()
  }

  /**
   * The mode being carried across the hull-selection screen.
   *
   * `beginSortie` consumes `pendingMode` before the screen opens, so without somewhere
   * to park it a shared seed would survive the seed roll and then be dropped one
   * screen later — the same bug one step further along.
   */
  let pendingHullMode: RunMode = resolved.mode

  /**
   * Build the run. Split out of `beginSortie` so a hull can be chosen in between.
   */
  function launchSortie(hullId: string, mode: RunMode): void {
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
    //
    // The POOL is recorded with it, and for the same reason one layer up: `World` is
    // handed `runPool.workOrders`, so a replay shared by a certified pilot and opened
    // by someone with a different unlock set was a different run wearing the same
    // link. `runCertified.certifications` is the set this pool was built from, so what
    // is recorded and what was flown cannot drift apart.
    recorder = new ReplayRecorder(seed, currentHullId, runCertified.certifications)
    // Whatever `claimSortieMode` decided, unmodified. This used to be a hardcoded
    // `{ kind: 'free', seed, purist: false }`, which is what discarded every daily,
    // shared seed and replay — and hardcoding `purist: false` is separately what made
    // `?seed=X&purist=1` mean nothing.
    runMode = mode
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
    /**
     * ABANDONING A DAILY CONSUMES THE ATTEMPT.
     *
     * `save.daily` was written only in `fileCompletedRun`, which is reached only once
     * `runState !== 'active'` — so pause → abandon → restart let a player re-roll the
     * contract until wave 1 looked survivable. That is precisely what the `abandoned`
     * outcome was added to prevent, and it was never written anywhere in `src/`, which
     * also left the "`active` is treated as `lost`" branch in meta/personnel.ts dead.
     *
     * No incident is filed and the pilot number does not advance: the pilot was not
     * lost, they stopped. What is spent is the contract, which is the only thing the
     * re-roll was cheating.
     */
    if (runMode.kind === 'daily' && world.runState === 'active') {
      save.daily = {
        date: runMode.date,
        ticks: world.stats.tick,
        waveIndex: world.stats.waveIndex,
        scrap: world.stats.scrap,
        outcome: 'abandoned',
      }
      persistSave(save)
    }
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
    const held = options.holdChoice
    const holding =
      held !== null &&
      world.pendingChoice !== null &&
      (held === 'any' || world.pendingChoice.kind === held)
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
      } else if (item.id === 'settings') {
        audio.confirm()
        openSettings('paused')
      } else if (item.id === 'abandon') {
        audio.cancel()
        abandonSortie()
      }
    }
    if (keyboard.consumePressed('pause')) setPaused(false)
  }

  const loop = new FixedLoop({
    tick(): void {
      /*
       * The input context, set before anything reads the keyboard.
       *
       * Auto-fire is gated on this. It used to be load-bearing for a much larger
       * reason — a held trigger confirmed reward cards, so auto-fire on a card took
       * option 0 by itself — and accepting is its own action now, so the gate is back
       * to meaning what it says: nothing off a sortie shoots. `src/core/touch.ts`
       * makes the identical distinction.
       */
      keyboard.setContext(
        screen === 'sortie' ? (world.pendingChoice !== null ? 'choice' : 'sortie') : 'menu',
      )

      if (screen === 'title') {
        menuTick++
        titleStars.update(0.35)
        // ESC acknowledges the save-loss notice, and only when one is up — the
        // short-circuit matters, or an idle Escape on the title would play a cancel
        // sound for nothing. Nothing else on this screen uses cancel.
        if (saveNotice !== null && keyboard.consumePressed('cancel')) {
          audio.cancel()
          saveNotice = null
        }
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
        // Down is the only free direction: up is seed entry, left the hangar, right
        // personnel. Settings must be reachable BEFORE a run — otherwise configuring
        // your keys means launching a permadeath sortie with the keys you were trying
        // to change.
        if (keyboard.consumePressed('down')) {
          audio.confirm()
          openSettings('title')
        }
        // Leaving the title acknowledges it too: whichever way they went, they read it
        // or chose to get on with the game, and a notice that returns after a trip to
        // the hangar is a notice that has stopped being information.
        if (screen !== 'title') saveNotice = null
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

      if (screen === 'settings' && settingsState) {
        let next = settingsReduce(settingsState, { kind: 'tick' })

        if (next.capturing !== null) {
          /*
           * Raw codes bypass the action tables entirely while capturing, and that
           * circularity is the whole point: reading the binding you are trying to
           * change is what makes a bad keymap unrepairable.
           */
          if (!keyboard.capturing) {
            keyboard.captureNextCode((code) => {
              if (settingsState) settingsState = settingsReduce(settingsState, { kind: 'code', code })
            })
          }
        } else {
          if (keyboard.consumePressed('up')) next = settingsReduce(next, { kind: 'move', delta: -1 })
          if (keyboard.consumePressed('down')) next = settingsReduce(next, { kind: 'move', delta: 1 })
          if (keyboard.consumePressed('left')) next = settingsReduce(next, { kind: 'adjust', delta: -1 })
          if (keyboard.consumePressed('right')) next = settingsReduce(next, { kind: 'adjust', delta: 1 })
          if (keyboard.consumePressed('confirm')) next = settingsReduce(next, { kind: 'confirm' })
          if (keyboard.consumePressed('cancel') || keyboard.consumePressed('pause')) {
            next = settingsReduce(next, { kind: 'cancel' })
          }
        }

        if (next.dirty) {
          save.settings = next.settings
          bindings = next.bindings
          keyboard.setBindings(bindings)
          keyboard.setAutoFire(next.settings.autoFire)
          applyAudioSettings(save.settings)
          persistSave(save)
          persistBindings(bindings)
          audio.confirm()
          next = markSaved(next)
        }

        if (next.exit) {
          audio.cancel()
          settingsState = null
          screen = settingsReturn
          menuTick = 0
          keyboard.clearPressed()
          loop.resetClock()
          return
        }

        settingsState = next
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
          launchSortie(hullOffer[hullSelection] ?? LIEN_ID, pendingHullMode)
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
        // Frozen for a capture. See `__nextPilot.freeze`.
        if (captureFrozen) break
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
          notice: saveNotice,
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

      if (screen === 'settings' && settingsState) {
        drawSettingsScreen(ctx, settingsState)
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
          skipped: personnelSkipped,
          dropped: personnelDropped,
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
      // The HUD names the kind of run. `describeRunMode` was documented as "what the
      // HUD says about this run" and only the share card had ever called it, so a daily
      // contract looked pixel-identical to a free run — and a *replay* looked identical
      // to a live one, which is worse: input is coming from the log, so a player who
      // does not know that concludes the game has stopped responding.
      panelState.runMode = runMode
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

      /**
       * A card draws, and then PAUSE DRAWS OVER IT.
       *
       * This used to `return` here, so pressing pause while a reward card was open
       * left the run paused with no pause menu on screen: input was being routed to
       * `updatePauseMenu`, the card was still the only thing drawn, and every key the
       * player tried did something invisible. Reported from play, and the ordering was
       * the cause — not the duplicate copy of this block that sat directly below it,
       * which was unreachable and harmless.
       *
       * Pause is the one screen that must always be on top: it is where a player goes
       * when they want the game to stop doing something.
       */
      if (choosing) {
        drawChoiceScreen(ctx, world, {
          // The simulation owns the cursor so a recorded run reproduces its picks;
          // this screen renders that selection rather than holding one.
          selected: world.choiceSelection,
          tick: world.stats.tick,
          items: ITEMS,
        })
        if (screen !== 'paused') return
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

  /**
   * Stop advancing the simulation, for a screenshot.
   *
   * WHY THIS EXISTS. `page.screenshot()` takes tens of milliseconds. A hazard warning
   * is 60 ticks — one simulated second, which at `ff=20` is FIFTY milliseconds of wall
   * clock. So the harness would assert the state it wanted, open the shutter, and file
   * an image of the state after it: the `hazard-warning` capture passed its check and
   * photographed an *idle* hazard. That is the "capture does not show what it claims"
   * failure the harness was built to prevent, arriving through the one gap it could not
   * see — between its own assertion and its own shutter.
   *
   * Freezing makes the shutter atomic. It is honest in a way a god-mode flag is not: it
   * changes nothing about the run, it only stops time. The sim is tick-based, so a
   * frozen run resumes bit-identically — and rendering keeps going, so what is captured
   * is a real frame of a real state. `holdchoice` is already the same kind of
   * affordance, and a more invasive one, since it substitutes input.
   *
   * Never reachable from a keypress; only from the probe below.
   */
  let captureFrozen = false

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
      /**
       * Freeze or resume the simulation. Capture affordance — see `captureFrozen`.
       *
       * A function rather than a settable property so it cannot be tripped by the
       * generic `{ ...api }` snapshot the harness takes of this object.
       */
      freeze(on = true): void {
        captureFrozen = on === true
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
