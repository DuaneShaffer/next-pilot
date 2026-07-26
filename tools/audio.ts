/**
 * Audio verification harness.
 *
 *   npm run audio
 *
 * Renders every cue and every realistic mix through the game's real audio code,
 * measures the result, asserts what a listener would notice, and writes WAV files
 * to `audio/` so a human can check the numbers against their ears on the next
 * pass. See docs/VERIFICATION.md §5 — this is the instrument that section used to
 * describe as missing.
 *
 * WHY A BROWSER AND NOT NODE. The obvious cheaper option is to reimplement the
 * synthesis in Node: oscillators, biquads and envelopes are not hard to write. It
 * would also be worthless. What the game plays is decided by Chromium's WebAudio —
 * its biquad coefficients, its exponential ramp semantics, its
 * `DynamicsCompressor` — and a Node model would measure my *idea* of that graph.
 * The first time the two disagreed, the harness would confidently certify a mix
 * nobody had produced. So this drives an `OfflineAudioContext` inside real
 * Chromium (already a dev dependency for the screenshot tool) against the same
 * `src/audio/synth.ts` the live backend calls, through the same `Mixer`, from the
 * same `SimEvent`s. Faster than real time, and the output is the output.
 *
 * Structure follows tools/screenshot.mjs, for the reasons its header records:
 *
 *  1. Source is served from an in-process `node:http` server that transpiles TS
 *     on demand. No bundle step, no child process, nothing to leak or misparse —
 *     and the page imports the same files the app does, so this cannot drift from
 *     what ships.
 *  2. Everything is under a hard watchdog. A verification tool that can hang
 *     silently is worse than no tool when work happens unattended.
 *  3. Failures are loud and specific. Every assertion prints the measured number
 *     and the threshold it missed, because "audio check failed" is not actionable
 *     at 2am.
 */

import { createServer, type Server } from 'node:http'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { chromium } from 'playwright'
import ts from 'typescript'

import {
  discriminationMargin,
  fingerprint,
  loudnessLufs,
  maskingMargin,
  measure,
  separation,
  shortTermLoudness,
  slicePcm,
  type Measurement,
  type Pcm,
} from '../src/audio/analysis'
import {
  floorFor,
  opposedPairs,
  tierFor,
  OPPOSED_DISCRIMINATION_DB,
  OPPOSED_DISCRIMINATION_MEAN_DB,
} from '../src/audio/meaning'
import { MASKING_WARNING_AT } from '../src/audio/offline'
import { encodeWav } from '../src/audio/wav'
import { SOUNDS, type SoundCategory, type SoundId } from '../src/audio/sounds'

const OUT_DIR = 'audio'
const WATCHDOG_MS = 300_000

// ---------------------------------------------------------------------------
// thresholds — every one of these is a claim about what a player would notice
// ---------------------------------------------------------------------------

/** True peak ceiling for a solo cue. -1 dBTP is the standard delivery headroom. */
const CUE_TRUE_PEAK_DB = -1

/** True peak ceiling for a mix. Above 0 dBTP a converter clips; that is the line. */
const MIX_TRUE_PEAK_DB = -0.3

/**
 * Absolute loudness ceiling for any 400ms of any scene. Past this it is a wall.
 *
 * -6 LUFS over 400ms is already extremely loud for a game; anything beyond it is
 * not emphasis, it is the output stage running out of room.
 */
const SCENE_LOUDNESS_CEILING_LUFS = -6

/**
 * How much louder a pile-up may be than the single loudest cue in the library.
 *
 * Zero, and that is the point. 256 simultaneous events must not be louder than
 * one alarm — if they are, the mixer is summing rather than prioritising, and the
 * player's reward for a screen-clearing hit is that they can no longer hear the
 * thing about to kill them. An absolute ceiling would go stale the moment the
 * master level changed; this one cannot.
 */
const PILEUP_HEADROOM_LU = 0

/** Window used for every short-term loudness comparison. */
const WINDOW_SEC = 0.4

/** No cue may outstay this. Every one of these is an event, not a piece of music. */
const MAX_CUE_SECONDS = 1.5

/** Below this a cue is not a sound, it is a rounding error. */
const MIN_CUE_PEAK = 0.01

/** Anything above this is a headroom thief and a speaker rattle. */
const MAX_DC_OFFSET = 0.003

/**
 * How much loudness a cue may lose when the bass is removed.
 *
 * Most players are on a laptop or a phone, neither of which reproduces anything
 * below ~150 Hz. A cue that loses more than this is carried by frequencies those
 * players do not have, which means it is not a cue for them — it is silence with
 * a comment above it. Nothing in the full-range measurements reveals this, and
 * it was true of four of the twenty sounds before this check existed.
 */
const MAX_SMALL_SPEAKER_LOSS_LU = 9

/** The hazard warning must stand this far above combat in its own bands. */
const WARNING_MEAN_MARGIN_DB = 9
const WARNING_WORST_MARGIN_DB = 6

/** And it must visibly lift the level of the mix when it arrives. */
const WARNING_LOUDNESS_RISE_LU = 3

/**
 * Pairs a player must be able to tell apart without looking.
 *
 * Not every pair in the library — some cues are deliberately related (an elite
 * kill is a bigger kill). These are the ones where confusing the two would cause
 * a wrong decision.
 *
 * The FLOOR each pair has to clear is not written here. It comes from
 * `src/audio/meaning.ts`, which classifies every cue by what it tells the player
 * to do and derives a higher requirement for pairs that mean opposite things. The
 * opposed pairs are added to this list automatically, so a cue added later cannot
 * escape the check by not appearing here.
 */
const MUST_DIFFER: readonly (readonly [SoundId, SoundId])[] = [
  // The big one: did I hurt something, or did something hurt me?
  ['impact.hit', 'alarm.hullHit'],
  ['impact.kill', 'alarm.hullHit'],
  ['impact.kill', 'alarm.shieldAbsorb'],
  // Deflected versus taken. Different decisions follow.
  ['alarm.shieldAbsorb', 'alarm.hullHit'],
  ['alarm.shieldAbsorb', 'alarm.shieldBroken'],
  // Mine or theirs.
  ['weapon.shot', 'threat.enemyShot'],
  // A reward is not a threat.
  ['pickup.scrap', 'impact.hit'],
  ['pickup.scrap', 'alarm.shieldAbsorb'],
  // Windup versus the shot itself.
  ['threat.telegraph', 'threat.enemyShot'],
  // Related, but must still be separable — one means an elite is gone.
  ['impact.kill', 'impact.killElite'],
  ['impact.killElite', 'impact.bossKilled'],
  // Menu polarity.
  ['ui.confirm', 'ui.cancel'],
  // The run ending versus the boss ending.
  ['alarm.hullLost', 'impact.bossKilled'],
  // Boss arriving versus boss escalating.
  ['threat.bossSpawn', 'threat.bossPhase'],
  // Structure versus input.
  ['ui.stageCleared', 'ui.confirm'],
  // The warning versus the thing it warned about.
  ['alarm.hazardWarning', 'threat.hazardFired'],
  // The buffer gone versus integrity gone. Both mean evade, but not by the same
  // amount and not with the same consequence.
  ['alarm.shieldBroken', 'alarm.hullHit'],
]

/** The curated list plus every derived opposed pair, deduplicated. */
function pairsToCheck(): readonly (readonly [SoundId, SoundId])[] {
  const seen = new Set<string>()
  const out: (readonly [SoundId, SoundId])[] = []
  for (const pair of [...MUST_DIFFER, ...opposedPairs()]) {
    const [a, b] = pair
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(pair)
  }
  return out
}

/**
 * Loudness relationships the mix hierarchy claims, checked against the render.
 *
 * `by` is the minimum gap in LU. These are the differences that make the mix a
 * legibility system rather than a set of numbers in a file.
 */
const MUST_BE_LOUDER: readonly { louder: SoundId; quieter: SoundId; by: number; why: string }[] = [
  { louder: 'alarm.hullLost', quieter: 'pickup.scrap', by: 6, why: 'losing the run outranks a tally mark' },
  { louder: 'alarm.hullHit', quieter: 'pickup.scrap', by: 6, why: 'taking damage outranks a pickup' },
  { louder: 'alarm.hullHit', quieter: 'weapon.shot', by: 8, why: 'the hit that costs you the run outranks your trigger' },
  { louder: 'threat.enemyShot', quieter: 'weapon.shot', by: 6, why: 'incoming fire outranks outgoing' },
  { louder: 'alarm.hazardWarning', quieter: 'impact.kill', by: 3, why: 'a one-second reaction window outranks your own explosion' },
  { louder: 'alarm.hazardWarning', quieter: 'weapon.shot', by: 10, why: 'the warning must beat the sound playing 20 times a second' },
  { louder: 'alarm.shieldBroken', quieter: 'impact.hit', by: 3, why: 'a system dropping offline outranks a hit landing' },
]

// ---------------------------------------------------------------------------
// serving the source
// ---------------------------------------------------------------------------

const PAGE = `<!doctype html><meta charset="utf-8"><title>audio harness</title><body data-ready="true">`

/**
 * Serve `src/**` as ES modules, type-stripped on demand.
 *
 * `transpileModule` is a pure syntactic transform, so it cannot fail on a type
 * error and cannot disagree with the bundler about semantics — the only thing it
 * removes is types. `verbatimModuleSyntax` keeps every value import exactly as
 * written so nothing gets elided on a guess.
 */
async function serveSource(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    void (async () => {
      const path = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/')
      if (path === '/' || path === '/index.html') {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        response.end(PAGE)
        return
      }

      const safe = normalize(path).replace(/^(\.\.[/\\])+/, '').replace(/^\/+/, '')
      for (const candidate of [safe, `${safe}.ts`, `${safe}/index.ts`]) {
        try {
          const source = await readFile(join(process.cwd(), candidate), 'utf8')
          const output = candidate.endsWith('.ts')
            ? ts.transpileModule(source, {
                fileName: candidate,
                compilerOptions: {
                  target: ts.ScriptTarget.ES2022,
                  module: ts.ModuleKind.ESNext,
                  verbatimModuleSyntax: true,
                  useDefineForClassFields: true,
                },
              }).outputText
            : source
          response.writeHead(200, {
            'Content-Type': 'text/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
          })
          response.end(output)
          return
        } catch {
          // Try the next candidate.
        }
      }
      response.writeHead(404, { 'Content-Type': 'text/plain' })
      response.end(`not found: ${path}`)
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return { server, origin: `http://127.0.0.1:${port}` }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

interface RawRender {
  readonly name: string
  readonly what: string
  readonly sampleRate: number
  readonly frames: number
  readonly channels: number
  /** Interleaved float32, base64. JSON-encoding 300k numbers per scene is not viable. */
  readonly data: string
  readonly starts: readonly { id: string; at: number; gain: number; stoppedAt: number | null }[]
}

interface Rendered {
  readonly name: string
  readonly what: string
  readonly pcm: Pcm
  readonly starts: readonly { id: string; at: number; gain: number; stoppedAt: number | null }[]
}

function decode(raw: RawRender): Rendered {
  const bytes = Buffer.from(raw.data, 'base64')
  const interleaved = new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  )
  const channels: Float32Array[] = []
  for (let c = 0; c < raw.channels; c++) {
    const channel = new Float32Array(raw.frames)
    for (let i = 0; i < raw.frames; i++) channel[i] = interleaved[i * raw.channels + c] ?? 0
    channels.push(channel)
  }
  return {
    name: raw.name,
    what: raw.what,
    pcm: { sampleRate: raw.sampleRate, channels },
    starts: raw.starts,
  }
}

/** Runs in the page. Renders one scene and hands back interleaved float32 as base64. */
async function renderInPage(name: string): Promise<RawRender> {
  const module = await import('/src/audio/offline.ts')
  const scene = module.allScenes().find((candidate: { name: string }) => candidate.name === name)
  if (scene === undefined) throw new Error(`no scene named ${name}`)
  const { pcm, starts } = await module.renderScene(scene)

  const frames = pcm.channels[0]?.length ?? 0
  const channels = pcm.channels.length
  const interleaved = new Float32Array(frames * channels)
  for (let c = 0; c < channels; c++) {
    const source = pcm.channels[c]
    for (let i = 0; i < frames; i++) interleaved[i * channels + c] = source[i]
  }

  const bytes = new Uint8Array(interleaved.buffer)
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)))
  }

  return {
    name: scene.name,
    what: scene.what,
    sampleRate: pcm.sampleRate,
    frames,
    channels,
    data: btoa(binary),
    starts: starts.map((voice: { id: string; at: number; gain: number; stoppedAt: number | null }) => ({
      id: voice.id,
      at: voice.at,
      gain: voice.gain,
      stoppedAt: voice.stoppedAt,
    })),
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : ' '.repeat(width - text.length) + text
}

function n(value: number, places = 1): string {
  if (!Number.isFinite(value)) return '  -inf'
  return value.toFixed(places)
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

async function run(): Promise<string[]> {
  const problems: string[] = []
  await rm(OUT_DIR, { recursive: true, force: true })
  await mkdir(OUT_DIR, { recursive: true })

  const { server, origin } = await serveSource()
  const browser = await chromium.launch()
  const rendered = new Map<string, Rendered>()

  try {
    const page = await browser.newPage()
    page.on('pageerror', (error) => problems.push(`page error: ${error.message}`))
    page.on('console', (message) => {
      if (message.type() === 'error') problems.push(`console error: ${message.text()}`)
    })
    await page.goto(origin, { waitUntil: 'load' })

    const names: string[] = await page.evaluate(async () => {
      const module = await import('/src/audio/offline.ts')
      return module.allScenes().map((scene: { name: string }) => scene.name)
    })

    for (const name of names) {
      const raw: RawRender = await page.evaluate(renderInPage, name)
      const take = decode(raw)
      rendered.set(name, take)
      await writeFile(join(OUT_DIR, `${name}.wav`), encodeWav(take.pcm))
    }
  } finally {
    await browser.close()
    server.close()
  }

  // -- per-cue measurements -------------------------------------------------

  const cueMeasurements = new Map<SoundId, Measurement>()
  const cueFingerprints = new Map<SoundId, ReturnType<typeof fingerprint>>()

  const ids = Object.keys(SOUNDS) as SoundId[]
  for (const id of ids) {
    const take = rendered.get(`cue--${id}`)
    if (take === undefined) {
      problems.push(`${id}: never rendered — the scene catalogue and the sound library disagree`)
      continue
    }
    const m = measure(take.pcm)
    cueMeasurements.set(id, m)
    cueFingerprints.set(id, fingerprint(take.pcm))

    if (m.peak < MIN_CUE_PEAK) {
      problems.push(`${id}: peak ${m.peak.toFixed(4)} — effectively silent, and nothing else would have noticed`)
    }
    if (m.truePeakDb > CUE_TRUE_PEAK_DB) {
      problems.push(`${id}: true peak ${n(m.truePeakDb, 2)} dBTP exceeds ${CUE_TRUE_PEAK_DB} dBTP — this clips`)
    }
    if (m.durationSec > MAX_CUE_SECONDS) {
      problems.push(`${id}: ${n(m.durationSec, 2)}s audible, over the ${MAX_CUE_SECONDS}s cue ceiling`)
    }
    if (m.dcOffset > MAX_DC_OFFSET) {
      problems.push(`${id}: DC offset ${m.dcOffset.toFixed(4)} over ${MAX_DC_OFFSET}`)
    }
    if (m.smallSpeakerLossLu > MAX_SMALL_SPEAKER_LOSS_LU) {
      problems.push(
        `${id}: loses ${n(m.smallSpeakerLossLu)} LU on a laptop speaker (limit ${MAX_SMALL_SPEAKER_LOSS_LU}) — ` +
          `${Math.round(m.subFraction * 100)}% of its energy is below ${'150'} Hz, so most players will barely hear it`,
      )
    }
  }

  console.log('\nCUES — solo, through the real mixer at shipped levels')
  console.log(
    `${pad('sound', 22)}${pad('cat', 8)}${padLeft('LUFS', 8)}${padLeft('laptop', 8)}${padLeft('loss', 7)}` +
      `${padLeft('dBTP', 8)}${padLeft('dur s', 8)}${padLeft('centroid', 10)}${padLeft('<150Hz', 8)}${padLeft('DC', 9)}`,
  )
  for (const id of ids) {
    const m = cueMeasurements.get(id)
    if (m === undefined) continue
    console.log(
      `${pad(id, 22)}${pad(SOUNDS[id].category, 8)}${padLeft(n(m.lufs), 8)}${padLeft(n(m.smallSpeakerLufs), 8)}` +
        `${padLeft(n(m.smallSpeakerLossLu), 7)}${padLeft(n(m.truePeakDb, 2), 8)}${padLeft(n(m.durationSec, 3), 8)}` +
        `${padLeft(`${Math.round(m.centroidHz)}Hz`, 10)}${padLeft(`${Math.round(m.subFraction * 100)}%`, 8)}` +
        `${padLeft(m.dcOffset.toFixed(5), 9)}`,
    )
  }

  // -- the mix hierarchy, as measured --------------------------------------

  console.log('\nMIX HIERARCHY — measured loudness per category')
  const byCategory = new Map<SoundCategory, number[]>()
  for (const id of ids) {
    const m = cueMeasurements.get(id)
    if (m === undefined || !Number.isFinite(m.lufs)) continue
    const list = byCategory.get(SOUNDS[id].category) ?? []
    list.push(m.lufs)
    byCategory.set(SOUNDS[id].category, list)
  }
  const categoryMeans = new Map<SoundCategory, number>()
  for (const [category, values] of byCategory) {
    categoryMeans.set(category, values.reduce((a, b) => a + b, 0) / values.length)
  }
  const orderedCategories = [...categoryMeans.entries()].sort((a, b) => b[1] - a[1])
  for (const [category, mean] of orderedCategories) {
    console.log(`  ${pad(category, 10)}${padLeft(n(mean), 8)} LUFS  (${byCategory.get(category)?.length ?? 0} cues)`)
  }

  const quietest = [...cueMeasurements.entries()].sort((a, b) => a[1].lufs - b[1].lufs)[0]
  if (quietest !== undefined && quietest[0] !== 'weapon.shot') {
    problems.push(
      `the quietest cue is ${quietest[0]} at ${n(quietest[1].lufs)} LUFS, not weapon.shot ` +
        `(${n(cueMeasurements.get('weapon.shot')?.lufs ?? Number.NaN)}) — the gun fires 20 times a second and must be the floor`,
    )
  }

  const weaponMean = categoryMeans.get('weapon') ?? 0
  for (const [category, mean] of categoryMeans) {
    if (category === 'weapon') continue
    if (mean <= weaponMean) {
      problems.push(`category ${category} (${n(mean)} LUFS) is not above weapon (${n(weaponMean)} LUFS)`)
    }
  }
  // The same hierarchy, on a laptop. A mix that is only legible with subwoofers
  // is not legible.
  const smallMeans = new Map<SoundCategory, number>()
  {
    const grouped = new Map<SoundCategory, number[]>()
    for (const id of ids) {
      const m = cueMeasurements.get(id)
      if (m === undefined || !Number.isFinite(m.smallSpeakerLufs)) continue
      const list = grouped.get(SOUNDS[id].category) ?? []
      list.push(m.smallSpeakerLufs)
      grouped.set(SOUNDS[id].category, list)
    }
    for (const [category, values] of grouped) {
      smallMeans.set(category, values.reduce((a, b) => a + b, 0) / values.length)
    }
  }
  const smallWeapon = smallMeans.get('weapon') ?? 0
  for (const [category, mean] of smallMeans) {
    if (category === 'weapon') continue
    if (mean <= smallWeapon) {
      problems.push(
        `on a laptop speaker, category ${category} (${n(mean)} LUFS) is not above weapon ` +
          `(${n(smallWeapon)} LUFS) — the hierarchy collapses without bass`,
      )
    }
  }
  const smallImpact = smallMeans.get('impact') ?? 0
  for (const above of ['alarm', 'threat'] as const) {
    const mean = smallMeans.get(above) ?? 0
    if (mean <= smallImpact) {
      problems.push(
        `on a laptop speaker, category ${above} (${n(mean)} LUFS) is not above impact (${n(smallImpact)} LUFS)`,
      )
    }
  }

  const impactMean = categoryMeans.get('impact') ?? 0
  for (const above of ['alarm', 'threat'] as const) {
    const mean = categoryMeans.get(above) ?? 0
    if (mean <= impactMean) {
      problems.push(
        `category ${above} (${n(mean)} LUFS) is not above impact (${n(impactMean)} LUFS) — ` +
          `the things you must react to are not louder than the things you cause`,
      )
    }
  }

  console.log('\nMIX HIERARCHY — required gaps')
  for (const rule of MUST_BE_LOUDER) {
    const louder = cueMeasurements.get(rule.louder)
    const quieter = cueMeasurements.get(rule.quieter)
    if (louder === undefined || quieter === undefined) continue
    const gap = louder.lufs - quieter.lufs
    const ok = gap >= rule.by
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} ${pad(`${rule.louder} > ${rule.quieter}`, 46)}` +
        `${padLeft(`${n(gap)} LU`, 10)}  (need ${rule.by})  ${rule.why}`,
    )
    if (!ok) {
      problems.push(
        `${rule.louder} is only ${n(gap)} LU above ${rule.quieter}, needs ${rule.by} — ${rule.why}`,
      )
    }
  }

  // -- distinguishability ---------------------------------------------------

  console.log('\nDISTINGUISHABILITY — floor is 1.0, or 2.0 where the two cues mean opposite things')
  console.log(
    `${pad('pair', 46)}${padLeft('tier', 10)}${padLeft('score', 7)}${padLeft('need', 6)}` +
      `${padLeft('oct', 6)}${padLeft('len', 6)}${padLeft('spec', 6)}${padLeft('env', 6)}${padLeft('combat', 9)}`,
  )
  const bedForCombat = rendered.get('combat-bed')
  for (const [a, b] of pairsToCheck()) {
    const fa = cueFingerprints.get(a)
    const fb = cueFingerprints.get(b)
    const takeA = rendered.get(`cue--${a}`)
    const takeB = rendered.get(`cue--${b}`)
    if (fa === undefined || fb === undefined || takeA === undefined || takeB === undefined) continue
    const s = separation(fa, fb)
    const tier = tierFor(a, b)
    const floor = floorFor(a, b)

    // In-combat discrimination: does the difference between these two survive
    // being shot at? Measured for opposed pairs, where it decides a run.
    let combat = Number.NaN
    let combatBand = 0
    let combatMean = Number.NaN
    if (tier === 'opposed' && bedForCombat !== undefined) {
      // From 0.4s in, past the bed's first shot, so the window is genuinely busy.
      const bedSlice = slicePcm(bedForCombat.pcm, 0.4, 2.9)
      const report = discriminationMargin(takeA.pcm, takeB.pcm, bedSlice)
      combat = report.bestMarginDb
      combatBand = report.bestBandHz
      combatMean = report.meanMarginDb
    }

    const combatOk =
      Number.isNaN(combat) ||
      (combat >= OPPOSED_DISCRIMINATION_DB && combatMean >= OPPOSED_DISCRIMINATION_MEAN_DB)
    const ok = s.score >= floor && combatOk
    console.log(
      `${pad(`${a} / ${b}`, 46)}${padLeft(tier, 10)}${padLeft(n(s.score, 2), 7)}${padLeft(n(floor, 1), 6)}` +
        `${padLeft(n(s.centroidOctaves, 2), 6)}${padLeft(n(s.durationOctaves, 2), 6)}` +
        `${padLeft(n(s.spectralDistance, 2), 6)}${padLeft(n(s.envelopeDistance, 2), 6)}` +
        `${padLeft(Number.isNaN(combat) ? '-' : `${n(combat)}dB`, 9)}` +
        `${Number.isNaN(combat) ? '' : `  @${Math.round(combatBand)}Hz, mean ${n(combatMean)}dB`}${ok ? '' : '   FAIL'}`,
    )
    if (s.score < floor) {
      problems.push(
        `${a} and ${b} are too similar: separation ${n(s.score, 2)} < ${n(floor, 1)} for a ${tier} pair ` +
          `(${n(s.centroidOctaves, 2)} oct, ${n(s.durationOctaves, 2)} len, ${n(s.spectralDistance, 2)} spec, ${n(s.envelopeDistance, 2)} env)`,
      )
    }
    if (!Number.isNaN(combat) && combat < OPPOSED_DISCRIMINATION_DB) {
      problems.push(
        `${a} and ${b} mean opposite things, and what best tells them apart is only ${n(combat)} dB above ` +
          `ordinary combat at ${Math.round(combatBand)}Hz (need ${OPPOSED_DISCRIMINATION_DB}) — ` +
          `separable in silence, not while being shot at`,
      )
    }
    if (!Number.isNaN(combatMean) && combatMean < OPPOSED_DISCRIMINATION_MEAN_DB) {
      problems.push(
        `${a} and ${b} mean opposite things, and averaged over the bands that distinguish them the ` +
          `difference sits ${n(combatMean)} dB against combat (need ${OPPOSED_DISCRIMINATION_MEAN_DB}) — ` +
          `the distinction survives in one band only`,
      )
    }
  }

  // The warning is compared against everything, not just its designated pair:
  // it is the one cue that must never be mistaken for anything at all.
  const warningPrint = cueFingerprints.get('alarm.hazardWarning')
  if (warningPrint !== undefined) {
    let worst = Number.POSITIVE_INFINITY
    let worstAgainst = ''
    for (const id of ids) {
      if (id === 'alarm.hazardWarning') continue
      const other = cueFingerprints.get(id)
      if (other === undefined) continue
      const score = separation(warningPrint, other).score
      if (score < worst) {
        worst = score
        worstAgainst = id
      }
    }
    console.log(`\n  hazard warning vs every other cue: worst separation ${n(worst, 2)} (against ${worstAgainst})`)
    if (worst < 1.5) {
      problems.push(
        `the hazard warning is only ${n(worst, 2)} apart from ${worstAgainst}; the most important ` +
          `sound in the game needs a wider margin than the ordinary 1.5`,
      )
    }
  }

  // -- pile-ups -------------------------------------------------------------

  console.log('\nMIXES')
  console.log(
    `${pad('scene', 30)}${padLeft('LUFS', 8)}${padLeft('peak dB', 9)}${padLeft('dBTP', 8)}${padLeft('voices', 8)}  what`,
  )
  for (const [name, take] of rendered) {
    if (name.startsWith('cue--')) continue
    const m = measure(take.pcm)
    console.log(
      `${pad(name, 30)}${padLeft(n(m.lufs), 8)}${padLeft(n(m.peakDb), 9)}${padLeft(n(m.truePeakDb, 2), 8)}` +
        `${padLeft(String(take.starts.length), 8)}  ${take.what}`,
    )
    if (m.truePeakDb > MIX_TRUE_PEAK_DB) {
      problems.push(`${name}: true peak ${n(m.truePeakDb, 2)} dBTP exceeds ${MIX_TRUE_PEAK_DB} — the mix clips`)
    }
  }

  // Loudest 400ms window, not the whole-scene average: a pile-up that is a wall
  // of noise for a third of a second averages out to something reasonable.
  const loudestWindow = (take: Rendered): number => {
    let loudest = Number.NEGATIVE_INFINITY
    for (const window of shortTermLoudness(take.pcm, WINDOW_SEC, 0.05)) {
      loudest = Math.max(loudest, window.lufs)
    }
    return loudest
  }

  let loudestCue = Number.NEGATIVE_INFINITY
  let loudestCueId = ''
  for (const id of ids) {
    const take = rendered.get(`cue--${id}`)
    if (take === undefined) continue
    const level = loudestWindow(take)
    if (level > loudestCue) {
      loudestCue = level
      loudestCueId = id
    }
  }
  console.log(`\n  loudest single cue over ${WINDOW_SEC * 1000}ms: ${loudestCueId} at ${n(loudestCue)} LUFS`)

  for (const [name, take] of rendered) {
    if (name.startsWith('cue--')) continue
    const level = loudestWindow(take)
    if (level > SCENE_LOUDNESS_CEILING_LUFS) {
      problems.push(
        `${name}: loudest ${WINDOW_SEC * 1000}ms window is ${n(level)} LUFS, over the ` +
          `${SCENE_LOUDNESS_CEILING_LUFS} ceiling — that is a wall of noise, not a mix`,
      )
    }
  }

  for (const name of ['pileup-screen-clear', 'pileup-worst-tick', 'pileup-bed']) {
    const take = rendered.get(name)
    if (take === undefined) continue
    const level = loudestWindow(take)
    const ceiling = loudestCue + PILEUP_HEADROOM_LU
    console.log(
      `  ${pad(name, 30)} loudest window ${n(level)} LUFS (must not exceed ${loudestCueId} at ${n(ceiling)})`,
    )
    if (level > ceiling) {
      problems.push(
        `${name}: ${n(level)} LUFS over ${WINDOW_SEC * 1000}ms is louder than the loudest single cue ` +
          `(${loudestCueId}, ${n(loudestCue)}) — summation is winning over prioritisation`,
      )
    }
  }

  // -- masking: the measurement the hazard warning lives or dies by ---------

  const solo = rendered.get('hazard-warning-solo')
  const bed = rendered.get('combat-bed')
  const combined = rendered.get('hazard-warning-in-combat')
  const inPileup = rendered.get('hazard-warning-in-pileup')

  if (solo !== undefined && bed !== undefined && combined !== undefined) {
    const from = MASKING_WARNING_AT
    const to = from + 1.05
    const report = maskingMargin(slicePcm(solo.pcm, from, to), slicePcm(bed.pcm, from, to))

    console.log('\nHAZARD WARNING — audibility against ordinary combat')
    console.log(`  mean margin over its own bands  ${n(report.meanMarginDb)} dB  (need ${WARNING_MEAN_MARGIN_DB})`)
    console.log(
      `  worst of its three loudest bands ${n(report.worstMarginDb)} dB at ${Math.round(report.worstBandHz)}Hz` +
        `  (need ${WARNING_WORST_MARGIN_DB})`,
    )
    if (report.meanMarginDb < WARNING_MEAN_MARGIN_DB) {
      problems.push(
        `the hazard warning sits only ${n(report.meanMarginDb)} dB above combat in its own bands ` +
          `(need ${WARNING_MEAN_MARGIN_DB}) — it is maskable, and it is the sound that must never be`,
      )
    }
    if (report.worstMarginDb < WARNING_WORST_MARGIN_DB) {
      problems.push(
        `the hazard warning's ${Math.round(report.worstBandHz)}Hz band is only ${n(report.worstMarginDb)} dB ` +
          `above combat (need ${WARNING_WORST_MARGIN_DB})`,
      )
    }

    // Second, independent check: does the level of the actual mix visibly move
    // when the warning arrives? A spectral margin says it *can* be heard; this
    // says it *changes what is playing*.
    const before = loudnessLufs(slicePcm(combined.pcm, from - 0.6, from - 0.05))
    const during = loudnessLufs(slicePcm(combined.pcm, from, to))
    const rise = during - before
    console.log(`  loudness rise on arrival          ${n(rise)} LU  (need ${WARNING_LOUDNESS_RISE_LU})`)
    if (rise < WARNING_LOUDNESS_RISE_LU) {
      problems.push(
        `the hazard warning only lifts the mix by ${n(rise)} LU when it fires (need ${WARNING_LOUDNESS_RISE_LU}) — ` +
          `it disappears into combat`,
      )
    }

    if (inPileup !== undefined) {
      const started = inPileup.starts.filter((voice) => voice.id === 'alarm.hazardWarning')
      const survived = started.filter((voice) => voice.stoppedAt === null)
      console.log(`  survives a 256-event tick         ${survived.length > 0 ? 'yes' : 'NO'}`)
      if (survived.length === 0) {
        problems.push(
          `the hazard warning was ${started.length === 0 ? 'never started' : 'stolen'} during a screen clear — ` +
            `the voice limiter can silence the reaction window`,
        )
      }
      const pileupBed = rendered.get('pileup-bed')
      if (pileupBed !== undefined) {
        const pileupReport = maskingMargin(slicePcm(solo.pcm, from, to), slicePcm(pileupBed.pcm, from, to))
        console.log(
          `  margin during a screen clear      ${n(pileupReport.meanMarginDb)} dB` +
            ` (worst ${n(pileupReport.worstMarginDb)} dB at ${Math.round(pileupReport.worstBandHz)}Hz)`,
        )
        if (pileupReport.worstMarginDb < WARNING_WORST_MARGIN_DB) {
          problems.push(
            `during a screen clear the hazard warning's ${Math.round(pileupReport.worstBandHz)}Hz band is only ` +
              `${n(pileupReport.worstMarginDb)} dB above the noise (need ${WARNING_WORST_MARGIN_DB})`,
          )
        }
      }
    }
  } else {
    problems.push('the masking scenes did not render; the hazard warning is unverified')
  }

  console.log(`\nWrote ${rendered.size} WAV files to ${OUT_DIR}/ — 32-bit float, listen to them.`)
  return problems
}

const watchdog = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error(`Watchdog: audio render exceeded ${WATCHDOG_MS / 1000}s`)), WATCHDOG_MS).unref(),
)

try {
  const problems = await Promise.race([run(), watchdog])
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log('\nAudio checks passed.')
  process.exit(0)
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
