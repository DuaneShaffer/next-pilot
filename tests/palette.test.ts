/**
 * The palette, measured rather than admired.
 *
 * WHY THIS FILE EXISTS. `docs/UI.md` rule 3 says colour is information: `danger`
 * means "can hurt you this instant", `hostile` means an enemy hull, `caution` means
 * a resource running out. If two of those roles are the same colour to a
 * deuteranope then for roughly one man in twelve that information is simply not
 * there — and nothing in the codebase would ever say so. A palette is exactly the
 * kind of thing that looks fine to whoever chose it, forever.
 *
 * So this is an instrument, not an opinion:
 *
 *   - Protanopia, deuteranopia and tritanopia are simulated with the Viénot, Mollon
 *     & Le Gargasson (1999) LMS projection, implemented here because this project
 *     has zero runtime dependencies and is not getting one for a 3x3 matrix.
 *   - Distance is CIEDE2000, implemented here and verified against twelve rows of
 *     the Sharma, Wu & Dalal (2005) reference table in `the metric itself` below. A
 *     colour-difference formula that has not been checked against published data is
 *     a random number generator with opinions.
 *   - The pairs that must be told apart are **named explicitly**, with the screen
 *     they share. Every unordered pair of signal roles must appear in exactly one of
 *     `MUST_DISTINGUISH` or `MAY_MATCH`, so adding a palette role that nobody has
 *     classified fails this file rather than slipping through.
 *
 * ON THE VIÉNOT APPROXIMATION. For protanopia and deuteranopia the single-plane
 * projection is very close to Brettel's two half-planes, because the confusion
 * lines and the two anchor stimuli are near-coplanar there. For **tritanopia it is
 * the weaker model** and is known to misplace some saturated blues. Tritanopia is
 * also the rarest of the three (~1 in 10,000, and not sex-linked, against ~5% of
 * men for the red-green deficiencies). Both facts are stated rather than hidden:
 * treat a tritan number here as indicative and a protan/deutan number as load
 * bearing.
 *
 * WHAT IT CURRENTLY REPORTS. Real failures, deliberately left failing. See the
 * block comment above `MIN_DELTA_E`.
 */

import { describe, expect, it } from 'vitest'
import { Palette } from '../src/render/palette'

// --- colour maths ------------------------------------------------------------

type Rgb = readonly [number, number, number]
type Lab = readonly [number, number, number]
type Matrix = readonly [Rgb, Rgb, Rgb]

export type Vision = 'normal' | 'protanopia' | 'deuteranopia' | 'tritanopia'

const VISIONS: readonly Vision[] = ['normal', 'protanopia', 'deuteranopia', 'tritanopia']

function parseHex(hex: string): Rgb {
  const value = Number.parseInt(hex.slice(1), 16)
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255]
}

/** sRGB transfer function, inverted. Physically-linear light is what LMS wants. */
function toLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function toGamma(channel: number): number {
  const c = Math.min(1, Math.max(0, channel))
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055
}

function apply(m: Matrix, v: Rgb): Rgb {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ]
}

/** Hunt–Pointer–Estévez cone fundamentals, as used by Viénot et al. */
const RGB_TO_LMS: Matrix = [
  [17.8824, 43.5161, 4.11935],
  [3.45565, 27.1554, 3.86714],
  [0.0299566, 0.184309, 1.46709],
]

const LMS_TO_RGB: Matrix = [
  [0.080944448, -0.13050441, 0.11672107],
  [-0.010248534, 0.054019327, -0.11361471],
  [-0.00036529694, -0.0041216147, 0.6935114],
]

/**
 * The projection each dichromacy performs in LMS space.
 *
 * Protanopes lack L cones, so L is reconstructed from the M and S they do have;
 * deuteranopes lack M; tritanopes lack S. Each matrix collapses the missing axis
 * onto the plane the remaining two can still span.
 */
const PROJECTION: Readonly<Record<Exclude<Vision, 'normal'>, Matrix>> = {
  protanopia: [
    [0, 2.02344, -2.52581],
    [0, 1, 0],
    [0, 0, 1],
  ],
  deuteranopia: [
    [1, 0, 0],
    [0.494207, 0, 1.24827],
    [0, 0, 1],
  ],
  tritanopia: [
    [1, 0, 0],
    [0, 1, 0],
    [-0.395913, 0.801109, 0],
  ],
}

export function simulate(rgb: Rgb, vision: Vision): Rgb {
  if (vision === 'normal') return rgb
  const linear: Rgb = [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])]
  const projected = apply(PROJECTION[vision], apply(RGB_TO_LMS, linear))
  const back = apply(LMS_TO_RGB, projected)
  return [toGamma(back[0]), toGamma(back[1]), toGamma(back[2])]
}

const RGB_TO_XYZ: Matrix = [
  [0.4123908, 0.3575843, 0.1804808],
  [0.213639, 0.7151687, 0.0721923],
  [0.0193308, 0.1191948, 0.9505322],
]
/** D65, the white point sRGB is defined against. */
const WHITE: Rgb = [0.9504559, 1.0, 1.0890578]

export function toLab(rgb: Rgb): Lab {
  const xyz = apply(RGB_TO_XYZ, [toLinear(rgb[0]), toLinear(rgb[1]), toLinear(rgb[2])])
  const f = (t: number): number =>
    t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116
  const fx = f(xyz[0] / WHITE[0])
  const fy = f(xyz[1] / WHITE[1])
  const fz = f(xyz[2] / WHITE[2])
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180
const toDegrees = (radians: number): number => (radians * 180) / Math.PI

/**
 * CIEDE2000, with kL = kC = kH = 1.
 *
 * CIE76 (a plain Euclidean distance in Lab) was considered and rejected: it
 * overstates differences in the blue region by a factor of two or more, and blue is
 * exactly where `self`, `relic` and the panel surfaces live. Using it here would
 * have reported this palette as healthier than it is, which is the one failure mode
 * a verification instrument may not have.
 */
export function deltaE2000(one: Lab, two: Lab): number {
  const [l1, a1, b1] = one
  const [l2, a2, b2] = two

  const c1 = Math.hypot(a1, b1)
  const c2 = Math.hypot(a2, b2)
  const cBar = (c1 + c2) / 2
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)))

  const a1p = (1 + g) * a1
  const a2p = (1 + g) * a2
  const c1p = Math.hypot(a1p, b1)
  const c2p = Math.hypot(a2p, b2)
  const h1p = c1p === 0 ? 0 : (toDegrees(Math.atan2(b1, a1p)) + 360) % 360
  const h2p = c2p === 0 ? 0 : (toDegrees(Math.atan2(b2, a2p)) + 360) % 360

  const dLp = l2 - l1
  const dCp = c2p - c1p
  let dhp = 0
  if (c1p * c2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(c1p * c2p) * Math.sin(toRadians(dhp) / 2)

  const lBar = (l1 + l2) / 2
  const cBarP = (c1p + c2p) / 2
  let hBarP: number
  if (c1p * c2p === 0) hBarP = h1p + h2p
  else if (Math.abs(h1p - h2p) <= 180) hBarP = (h1p + h2p) / 2
  else if (h1p + h2p < 360) hBarP = (h1p + h2p + 360) / 2
  else hBarP = (h1p + h2p - 360) / 2

  const t =
    1 -
    0.17 * Math.cos(toRadians(hBarP - 30)) +
    0.24 * Math.cos(toRadians(2 * hBarP)) +
    0.32 * Math.cos(toRadians(3 * hBarP + 6)) -
    0.2 * Math.cos(toRadians(4 * hBarP - 63))

  const dTheta = 30 * Math.exp(-(((hBarP - 275) / 25) ** 2))
  const rC = 2 * Math.sqrt(cBarP ** 7 / (cBarP ** 7 + 25 ** 7))
  const sL = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2)
  const sC = 1 + 0.045 * cBarP
  const sH = 1 + 0.015 * cBarP * t
  const rT = -Math.sin(toRadians(2 * dTheta)) * rC

  return Math.sqrt(
    (dLp / sL) ** 2 + (dCp / sC) ** 2 + (dHp / sH) ** 2 + rT * (dCp / sC) * (dHp / sH),
  )
}

function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * toLinear(rgb[0]) + 0.7152 * toLinear(rgb[1]) + 0.0722 * toLinear(rgb[2])
  )
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// --- measurement helpers -----------------------------------------------------

const labCache = new Map<string, readonly Lab[]>()

function labsFor(hex: string): readonly Lab[] {
  const cached = labCache.get(hex)
  if (cached) return cached
  const rgb = parseHex(hex)
  const labs = VISIONS.map((vision) => toLab(simulate(rgb, vision)))
  labCache.set(hex, labs)
  return labs
}

/** Distance between two colours under every vision, in `VISIONS` order. */
export function distances(a: string, b: string): readonly number[] {
  const la = labsFor(a)
  const lb = labsFor(b)
  return la.map((lab, index) => deltaE2000(lab, lb[index] ?? lab))
}

export function worstDistance(a: string, b: string): number {
  return Math.min(...distances(a, b))
}

export function worstContrast(fg: string, bg: string): number {
  return Math.min(
    ...VISIONS.map((vision) =>
      contrastRatio(simulate(parseHex(fg), vision), simulate(parseHex(bg), vision)),
    ),
  )
}

/** Formats a row of measurements for a failure message that is actually useful. */
function report(a: string, b: string): string {
  const ds = distances(a, b)
  return VISIONS.map((vision, index) => `${vision} ${(ds[index] ?? 0).toFixed(1)}`).join(', ')
}

// --- what every palette entry is for -----------------------------------------

/**
 * How each token participates.
 *
 *   signal  — carries meaning by colour. Must be told apart from other signals.
 *   text    — drawn as glyphs. Judged on contrast, not on distance.
 *   surface — a background. Judged on what sits on it.
 *   glow    — an additive layer over one of the above. Distance is not meaningful
 *             because the result depends entirely on what is underneath; a glow
 *             inherits the role of the thing it is glowing.
 *
 * Typed as an exhaustive `Record<keyof typeof Palette, …>`, so adding a token to
 * `src/render/palette.ts` without classifying it here is a **compile error**, and
 * the pair-coverage test below turns that classification into an obligation to say
 * which existing roles the new one must be told apart from.
 */
type RoleClass = 'signal' | 'text' | 'surface' | 'glow'

const ROLE_CLASS: Readonly<Record<keyof typeof Palette, RoleClass>> = {
  void: 'surface',
  panel: 'surface',
  panelRaised: 'surface',
  line: 'surface',
  hostileFill: 'surface',
  text: 'text',
  textDim: 'text',
  textFaint: 'text',
  self: 'signal',
  caution: 'signal',
  danger: 'signal',
  dangerText: 'text',
  hostile: 'signal',
  hostileElite: 'signal',
  good: 'signal',
  relic: 'signal',
  glowSelf: 'glow',
  glowProjectile: 'glow',
  glowDanger: 'glow',
  glowWarm: 'glow',
  glowExplosion: 'glow',
}

type PaletteKey = keyof typeof Palette
type SignalKey = Extract<
  PaletteKey,
  'self' | 'caution' | 'danger' | 'hostile' | 'hostileElite' | 'good' | 'relic'
>

const SIGNALS = (Object.keys(ROLE_CLASS) as PaletteKey[]).filter(
  (key) => ROLE_CLASS[key] === 'signal',
) as SignalKey[]

interface Pair {
  a: SignalKey
  b: SignalKey
  /** Where both appear at once. A pair with no answer here does not belong. */
  where: string
}

/**
 * Pairs that must be distinguishable, and the screen that makes it necessary.
 *
 * Every entry names a real co-occurrence found in the rendering code, not a
 * hypothetical one. That matters in both directions: it stops the list being
 * padded, and it means a failure here is a screen a player is actually looking at.
 */
const MUST_DISTINGUISH: readonly Pair[] = [
  { a: 'self', b: 'danger', where: 'playfield: your hull against enemy fire' },
  { a: 'self', b: 'hostile', where: 'playfield: your hull against enemy hulls' },
  { a: 'self', b: 'hostileElite', where: 'playfield: your hull against an elite' },
  { a: 'self', b: 'good', where: 'playfield: your bullets against gain labels (feel.ts)' },
  { a: 'self', b: 'caution', where: 'playfield: your bullets against alert labels (feel.ts)' },
  { a: 'self', b: 'relic', where: 'hangar: selected row accent beside a relic grant tag' },
  { a: 'danger', b: 'hostile', where: 'playfield: rule 3’s own split, fire against hulls' },
  { a: 'danger', b: 'hostileElite', where: 'playfield: enemy fire against an elite hull accent' },
  { a: 'danger', b: 'good', where: 'incident report: LOST against EXTRACTED' },
  { a: 'hostile', b: 'hostileElite', where: 'playfield: which of these enemies is the elite' },
  { a: 'hostile', b: 'good', where: 'playfield: an enemy hull against a pickup label' },
  { a: 'hostile', b: 'caution', where: 'playfield: an enemy hull against an alert label' },
  { a: 'caution', b: 'good', where: 'panel and seed entry: adjacent status rows' },
  { a: 'caution', b: 'hostileElite', where: 'panel: the scrap readout against the elite callout' },
  { a: 'caution', b: 'relic', where: 'choice screen: a CURSED tag beside a relic tier chip' },
  { a: 'good', b: 'hostileElite', where: 'panel: a synergy count against the elite callout' },
  { a: 'good', b: 'relic', where: 'hangar: an unlocked accent beside a relic grant tag' },
]

/**
 * Pairs deliberately allowed to look alike, with the reason.
 *
 * `relic` is a UI-tier token. It appears on paused cards — the hangar, the choice
 * screen — and never in the playfield or the instrument panel, so it cannot be
 * confused with anything that only lives there. Every exemption has to be this
 * specific; "they are different enough in practice" is not a reason.
 */
/**
 * Pairs that colour alone cannot separate, and that carry their meaning in a second
 * channel instead.
 *
 * A tier rather than an exemption. Landing a pair here is a claim that something
 * OTHER than hue distinguishes them — shape, position, a word — and the claim names
 * where, so it can be checked by looking at a screenshot.
 *
 * `danger`/`caution` is here because it is structurally unfixable: red and amber
 * differ almost entirely along the L–M axis, which is exactly the axis protanopes and
 * deuteranopes lack, and both read as yellow to a tritanope. A constrained search over
 * the palette reached ΔE 12.8 at best, and only by costing `caution` its separation
 * from `good`. So the integrity meter now cuts notches into its filled segments when
 * it goes critical — geometry, which survives greyscale and all three simulations.
 */
const REDUNDANT_CHANNEL: readonly Pair[] = [
  {
    a: 'danger',
    b: 'caution',
    where: 'panel: a critical integrity meter, separated by notched segments (panel.ts drawMeter)',
  },
]

const MAY_MATCH: readonly Pair[] = [
  { a: 'danger', b: 'relic', where: 'never co-drawn: relic is a paused-card tier chip' },
  { a: 'hostile', b: 'relic', where: 'never co-drawn: hostile is a playfield hull colour' },
  { a: 'hostileElite', b: 'relic', where: 'never co-drawn: elite accents are playfield only' },
]

const key = (a: string, b: string): string => [a, b].sort().join('|')

// --- the thresholds ----------------------------------------------------------

/**
 * The bar, and why it is this number.
 *
 * ΔE2000 of about 2.3 is the just-noticeable difference for two large adjacent
 * patches, viewed steadily, under controlled light. Nothing in this game is any of
 * those things: the marks are a few virtual units across, they are moving, they are
 * separated by a screenful of other marks, and the player is under time pressure.
 * 15 is roughly where two such marks stop being "the same colour, maybe" — it is a
 * working figure rather than a derived constant, and it is stated here so that
 * moving it is a visible decision rather than a quiet one.
 *
 * **This threshold has not been lowered to make the palette pass, and it must not
 * be.** As shipped, nine of the eighteen pairs below fail. Those failures are the
 * output of this file, not a bug in it. The two that survive even the recommended
 * replacements are called out in `RECOMMENDED` — `danger`/`caution` is not fixable
 * by choosing better colours at all and needs a second channel.
 */
const MIN_DELTA_E = 15

/** WCAG AA for text below 18.66px bold / 24px regular, which is all of it here. */
const MIN_CONTRAST_AA = 4.5

// --- the tests ---------------------------------------------------------------

describe('the metric itself', () => {
  /**
   * Guards the guard. Every assertion in this file is worthless if the maths is
   * wrong, and a colour-difference formula is very easy to get subtly wrong in a
   * way that still returns plausible numbers.
   *
   * Rows from Sharma, Wu & Dalal (2005), "The CIEDE2000 color-difference formula:
   * implementation notes, supplementary test data and mathematical observations".
   */
  const REFERENCE: readonly (readonly [Lab, Lab, number])[] = [
    [[50, 2.6772, -79.7751], [50, 0, -82.7485], 2.0425],
    [[50, 3.1571, -77.2803], [50, 0, -82.7485], 2.8615],
    [[50, 2.8361, -74.02], [50, 0, -82.7485], 3.4412],
    [[50, -1.3802, -84.2814], [50, 0, -82.7485], 1.0],
    [[50, 0, 0], [50, -1, 2], 2.3669],
    [[50, 2.49, -0.001], [50, -2.49, 0.0009], 7.1792],
    [[50, 2.5, 0], [73, 25, -18], 27.1492],
    [[50, 2.5, 0], [50, 3.1736, 0.5854], 1.0],
    [[60.2574, -34.0099, 36.2677], [60.4626, -34.1751, 39.4387], 1.2644],
    [[63.0109, -31.0961, -5.8663], [62.8187, -29.7946, -4.0864], 1.263],
    [[22.7233, 20.0904, -46.694], [23.0331, 14.973, -42.5619], 2.0373],
    [[36.4612, 47.858, 18.3852], [36.2715, 50.5065, 21.2231], 1.4146],
  ]

  it.each(REFERENCE)('matches the published ΔE00 for %j / %j', (one, two, expected) => {
    expect(deltaE2000(one, two)).toBeCloseTo(expected, 3)
  })

  it('is symmetric', () => {
    expect(deltaE2000([50, 2.5, 0], [73, 25, -18])).toBeCloseTo(
      deltaE2000([73, 25, -18], [50, 2.5, 0]),
      10,
    )
  })

  it('reports zero for a colour against itself', () => {
    for (const value of Object.values(Palette)) {
      if (!value.startsWith('#')) continue
      expect(worstDistance(value, value)).toBeCloseTo(0, 10)
    }
  })
})

describe('the colour-vision simulation', () => {
  it('leaves normal vision untouched', () => {
    const rgb = parseHex(Palette.danger)
    expect(simulate(rgb, 'normal')).toEqual(rgb)
  })

  it('leaves neutral greys where they are', () => {
    // Every dichromacy preserves the achromatic axis. If a grey moved, the LMS
    // round trip would be wrong and every number in this file with it.
    for (const grey of ['#000000', '#404040', '#808080', '#C0C0C0', '#FFFFFF']) {
      for (const vision of VISIONS) {
        const out = simulate(parseHex(grey), vision)
        const target = parseHex(grey)
        expect(out[0]).toBeCloseTo(target[0], 2)
        expect(out[1]).toBeCloseTo(target[1], 2)
        expect(out[2]).toBeCloseTo(target[2], 2)
      }
    }
  })

  it('collapses the textbook red/green pair for protanopes and deuteranopes', () => {
    // Pure red against pure green: obviously different to normal vision, close to
    // indistinguishable without L or M cones. A simulation that does not show this
    // is not simulating anything.
    const normal = deltaE2000(toLab(parseHex('#FF0000')), toLab(parseHex('#00FF00')))
    expect(normal).toBeGreaterThan(80)
    for (const vision of ['protanopia', 'deuteranopia'] as const) {
      const shifted = deltaE2000(
        toLab(simulate(parseHex('#FF0000'), vision)),
        toLab(simulate(parseHex('#00FF00'), vision)),
      )
      // 86.6 normal, 45.8 protan, 19.8 deutan. A protanope retains more of it than
      // is intuitive — which is itself worth encoding, because a bar set at
      // "halves" would have been tuned to deuteranopia and quietly wrong.
      expect(shifted).toBeLessThan(normal * 0.6)
    }
  })

  it('collapses a blue/green pair for tritanopes and leaves red/green alone', () => {
    const blueGreen = deltaE2000(
      toLab(simulate(parseHex('#00B0FF'), 'tritanopia')),
      toLab(simulate(parseHex('#00E0A0'), 'tritanopia')),
    )
    const redGreen = deltaE2000(
      toLab(simulate(parseHex('#FF0000'), 'tritanopia')),
      toLab(simulate(parseHex('#00FF00'), 'tritanopia')),
    )
    // 10.8 and 58.0. The point is the direction: tritanopia costs the blue–yellow
    // axis and leaves red–green alone, which is the opposite of the other two.
    expect(blueGreen).toBeLessThan(15)
    expect(redGreen).toBeGreaterThan(50)
  })
})

describe('the pair list covers the palette', () => {
  it('classifies every palette token', () => {
    // The Record type already makes an unclassified token a compile error. This
    // asserts the other direction: a token deleted from the palette but left here
    // would otherwise sit around describing something that no longer exists.
    expect(Object.keys(ROLE_CLASS).sort()).toEqual(Object.keys(Palette).sort())
  })

  it('names every pair of signal roles exactly once', () => {
    // THIS is what stops a new role slipping through. Add `hostileBoss` to the
    // palette, classify it as a signal, and this fails until somebody has decided,
    // for each existing signal, whether the two must be told apart and where.
    const listed = new Map<string, number>()
    for (const pair of [...MUST_DISTINGUISH, ...REDUNDANT_CHANNEL, ...MAY_MATCH]) {
      const id = key(pair.a, pair.b)
      listed.set(id, (listed.get(id) ?? 0) + 1)
    }

    const missing: string[] = []
    for (let i = 0; i < SIGNALS.length; i++) {
      for (let j = i + 1; j < SIGNALS.length; j++) {
        const a = SIGNALS[i]
        const b = SIGNALS[j]
        if (a === undefined || b === undefined) continue
        const id = key(a, b)
        if (!listed.has(id)) missing.push(`${a} / ${b}`)
      }
    }

    expect(missing, 'unclassified signal pairs — decide and add them to MUST_DISTINGUISH or MAY_MATCH').toEqual([])
    for (const [id, count] of listed) {
      expect(count, `${id} is listed ${count} times`).toBe(1)
    }
  })

  it('gives every pair a stated reason', () => {
    for (const pair of [...MUST_DISTINGUISH, ...MAY_MATCH]) {
      expect(pair.where.length, `${pair.a}/${pair.b} has no reason`).toBeGreaterThan(12)
    }
  })
})

describe('signal roles are distinguishable under every vision', () => {
  it.each(MUST_DISTINGUISH.map((p) => [p.a, p.b, p.where] as const))(
    '%s and %s (%s)',
    (a, b, where) => {
      const worst = worstDistance(Palette[a], Palette[b])
      expect(
        worst,
        `${a} (${Palette[a]}) vs ${b} (${Palette[b]}) — ${where}\n      ${report(Palette[a], Palette[b])}`,
      ).toBeGreaterThanOrEqual(MIN_DELTA_E)
    },
  )

  it('never assigns two roles the same hex', () => {
    // The cheapest possible failure, and one this palette actually has: two roles
    // whose meanings rule 3 distinguishes, written as the same six characters. No
    // simulation is needed to see it, which is exactly why nobody had.
    const seen = new Map<string, SignalKey>()
    const clashes: string[] = []
    for (const role of SIGNALS) {
      const hex = Palette[role]
      const owner = seen.get(hex)
      if (owner) clashes.push(`${owner} and ${role} are both ${hex}`)
      else seen.set(hex, role)
    }
    expect(clashes).toEqual([])
  })
})

describe('signals are legible against the surfaces they are drawn on', () => {
  // A role can be perfectly distinct from every other role and still be invisible.
  const SURFACES: readonly PaletteKey[] = ['void', 'panel']

  it.each(SIGNALS.flatMap((role) => SURFACES.map((surface) => [role, surface] as const)))(
    '%s reads against %s',
    (role, surface) => {
      expect(
        worstDistance(Palette[role], Palette[surface]),
        `${role} on ${surface}: ${report(Palette[role], Palette[surface])}`,
      ).toBeGreaterThanOrEqual(MIN_DELTA_E)
    },
  )
})

describe('text meets WCAG AA on the surfaces it is actually drawn on', () => {
  /**
   * Every foreground/background combination the renderer really produces.
   *
   * Written out rather than generated as a cross product, because a combination
   * that never happens is not a bug, and a test full of imaginary failures gets
   * muted. Each entry cites where it happens.
   */
  const PLACEMENTS: readonly (readonly [PaletteKey, PaletteKey, string])[] = [
    ['text', 'void', 'title screen, incident report body'],
    ['text', 'panel', 'pause menu rows, settings rows, instrument panel'],
    ['text', 'panelRaised', 'seed entry cells, list rows'],
    ['textDim', 'void', 'title screen captions'],
    ['textDim', 'panel', 'labels, units, unselected rows'],
    ['textDim', 'panelRaised', 'row subtitles'],
    ['textFaint', 'void', 'reserved for genuinely non-essential text (rule 7)'],
    ['textFaint', 'panel', 'pause menu controls footer, choice screen hints'],
    ['self', 'panel', 'selected values, seed readout'],
    ['caution', 'panel', 'scrap readout, CURSED tag, daily contract'],
    ['dangerText', 'panel', 'personnel LOST, incident report cause'],
    ['dangerText', 'void', 'hazard INBOUND callout over the playfield'],
    ['good', 'panel', 'synergy count, EXTRACTED, hangar unlocked status'],
    ['relic', 'panel', 'tier chips, hangar grant tags'],
    ['hostile', 'panel', 'world map boss name'],
  ]

  it.each(PLACEMENTS)('%s on %s (%s)', (fg, bg, where) => {
    const ratio = worstContrast(Palette[fg], Palette[bg])
    expect(
      ratio,
      `${fg} (${Palette[fg]}) on ${bg} (${Palette[bg]}) — ${where}: ${ratio.toFixed(2)}:1, AA needs ${MIN_CONTRAST_AA}:1`,
    ).toBeGreaterThanOrEqual(MIN_CONTRAST_AA)
  })

  it('keeps the text ramp monotone', () => {
    // text brighter than textDim brighter than textFaint. A ramp that crosses over
    // means "dimmer" has stopped meaning "less important".
    const onVoid = (fg: PaletteKey): number => worstContrast(Palette[fg], Palette.void)
    expect(onVoid('text')).toBeGreaterThan(onVoid('textDim'))
    expect(onVoid('textDim')).toBeGreaterThan(onVoid('textFaint'))
  })
})

/**
 * The replacements this file recommends, and the numbers they achieve.
 *
 * Kept as a test rather than as prose in a report, because a recommendation nobody
 * can re-run is a recommendation nobody can check. Applying these to
 * `src/render/palette.ts` takes the failing pairs above from nine to one.
 *
 * The survivor is `danger` / `caution`, and it is not a colour-choosing problem:
 * red and amber differ only along the L–M axis, which is the axis a protanope and a
 * deuteranope do not have, and both read as yellow to a tritanope. The best
 * achievable while `danger` stays a saturated red and `caution` stays amber is
 * about ΔE 13 — and buying that costs `caution` its distance from `good`. The fix
 * is a second channel wherever the two carry information alone, which today is the
 * integrity meter recolouring in place at `src/render/panel.ts:94`.
 */
describe('the recommended replacements', () => {
  const RECOMMENDED: Readonly<Partial<Record<SignalKey, string>>> = {
    /** Was #F5B942 — byte-identical to `caution`. Blue is the free hue here. */
    hostileElite: '#4C7BFF',
    /** Was #93A1B5. Darkened ~11 L* to separate it from `self` for a deuteranope. */
    hostile: '#7A8498',
    /**
     * Was #4ADE9B. A cyan-green collapses onto `self` for a tritanope (ΔE 1.5);
     * pushing it to a pale yellow-green trades that for lightness separation,
     * which is the only axis all three deficiencies keep.
     */
    good: '#EAFFC0',
    /** Was #C084FC. Slightly deeper, to clear `self` under deuteranopia. */
    relic: '#C86BF0',
  }

  const patched = (role: SignalKey): string => RECOMMENDED[role] ?? Palette[role]

  /** Worst-case ΔE00 across the four visions. Comments give the full row. */
  const EXPECTED_WORST: Readonly<Record<string, number>> = {
    'danger|self': 45.8, //          [58.4, 45.8, 50.0, 61.8]
    'hostile|self': 17.2, //         [30.6, 23.8, 21.6, 17.2]  was 7.8
    'hostileElite|self': 21.6, //    [36.5, 30.1, 26.3, 21.6]
    'good|self': 23.4, //            [31.4, 33.9, 40.1, 23.4]  was 1.5
    'caution|self': 41.8, //         [44.1, 41.8, 50.3, 63.5]
    'relic|self': 16.9, //           [43.3, 28.9, 16.9, 60.4]  was 14.6
    'danger|hostile': 33.4, //       [36.2, 33.4, 41.2, 56.2]
    'danger|hostileElite': 46.7, //  [46.7, 58.7, 70.3, 78.3]  was 6.3
    'danger|good': 25.6, //          [56.2, 37.8, 25.6, 38.0]
    'caution|danger': 6.3, //        [36.8, 26.3, 13.1,  6.3]  UNCHANGED — see below
    'hostile|hostileElite': 15.7, // [16.2, 20.4, 20.4, 15.7]
    'good|hostile': 33.1, //         [43.3, 44.3, 44.3, 33.1]  was 7.3
    'caution|hostile': 41.5, //      [41.5, 43.5, 47.0, 59.3]
    'caution|good': 16.8, //         [26.3, 17.6, 16.8, 37.1]  was 12.0
    'caution|hostileElite': 62.5, // [62.5, 71.7, 75.8, 81.6]  was 0.0
    'caution|relic': 15.1, //        [63.3, 69.1, 66.0, 15.1]
    'good|hostileElite': 41.8, //    [61.0, 64.8, 65.1, 41.8]  was 12.0
    'good|relic': 40.6, //           [69.1, 62.8, 55.8, 40.6]
  }

  it.each(MUST_DISTINGUISH.map((p) => [p.a, p.b] as const))(
    'still measures what it claims for %s / %s',
    (a, b) => {
      // Pins the recommendation: if someone edits a hex above, the claimed number
      // has to be re-measured rather than quietly becoming a fiction.
      const worst = worstDistance(patched(a), patched(b))
      expect(worst).toBeCloseTo(EXPECTED_WORST[key(a, b)] ?? -1, 0)
    },
  )

  it('leaves no must-distinguish pair failing', () => {
    // Nine pairs failed when this file was written. All nine are fixed by colour
    // except `danger`/`caution`, which colour cannot fix at all — it has moved to
    // REDUNDANT_CHANNEL and is separated by geometry instead. So the list is empty,
    // and if a future palette edit reintroduces a failure it names it here.
    const failing = MUST_DISTINGUISH.filter(
      (p) => worstDistance(patched(p.a), patched(p.b)) < MIN_DELTA_E,
    ).map((p) => `${p.a}/${p.b}`)
    expect(failing).toEqual([])
  })

  it('still cannot separate the redundant-channel pair by colour, which is the point', () => {
    // If this ever STARTS passing on colour alone, the second channel has become
    // belt-and-braces rather than load-bearing — worth knowing, and worth someone
    // deciding deliberately rather than discovering by accident.
    for (const pair of REDUNDANT_CHANNEL) {
      expect(
        worstDistance(patched(pair.a), patched(pair.b)),
        `${pair.a}/${pair.b} — ${pair.where}`,
      ).toBeLessThan(MIN_DELTA_E)
    }
  })

  it('keeps every recommended colour legible on the void', () => {
    // Measured as distance, not as a WCAG ratio: these are filled marks and
    // outlines, not glyphs, and 4.5:1 is a legibility rule for text. `danger` is
    // 4.10:1 and that is fine for a bullet — it is *not* fine when the same token
    // is used for text, which is what the AA block above catches separately.
    for (const role of SIGNALS) {
      expect(worstDistance(patched(role), Palette.void), role).toBeGreaterThanOrEqual(
        MIN_DELTA_E,
      )
    }
  })

  /**
   * Text tokens the measurements above show are not AA, with replacements.
   *
   * `textFaint` is the interesting one: at #4A5768 it is 2.71:1 on the void, which
   * fails AA *and* fails the 3:1 large-text floor, while `docs/UI.md` rule 7 states
   * that all text meets AA and names textFaint as the floor. That claim is not
   * true today.
   *
   * #707F94 is the lowest value that clears AA on both `void` (4.89:1) and `panel`
   * (4.54:1) — and note the honest consequence: it lands ΔE 4.7 from `textDim`, so
   * a three-step text ramp cannot survive AA on a dark panel. The real answer is
   * two steps plus size and weight, which is a design decision rather than a
   * measurement, so it is flagged here rather than made here.
   *
   * `danger` at #FF4A38 is 3.78:1 on the panel. It is left alone as a *mark* colour
   * — brightening it costs the little separation it has from `caution` — and the
   * places it is used as *text* should use a lighter variant. #FF7059 gets 5.22:1.
   */
  /**
   * APPLIED, not recommended. This block used to stage two proposals and assert the
   * *current* value failed; both have shipped, so it now asserts the shipped value
   * passes. A test that still describes the old palette is a test that will go green
   * if someone reverts the fix.
   */
  const TEXT_ROLES: readonly (readonly [PaletteKey, PaletteKey])[] = [
    ['textFaint', 'panel'],
    ['textFaint', 'void'],
    ['dangerText', 'panel'],
    ['dangerText', 'void'],
  ]

  it.each(TEXT_ROLES)('%s clears AA on %s', (role, surface) => {
    expect(worstContrast(Palette[role], Palette[surface])).toBeGreaterThanOrEqual(
      MIN_CONTRAST_AA,
    )
  })

  it('keeps danger and dangerText as separate tokens', () => {
    // They want opposite things. Brightening the MARK costs it the little separation
    // it has from `caution`; darkening the TEXT is what broke AA. Collapsing them
    // back into one token re-breaks whichever use loses.
    expect(Palette.danger).not.toBe(Palette.dangerText)
    // And the mark deliberately does NOT meet text AA — it is not text.
    expect(worstContrast(Palette.danger, Palette.panel)).toBeLessThan(MIN_CONTRAST_AA)
  })
})

/**
 * Proof that the instrument works.
 *
 * A test that only ever passes on the input it was written against is decoration.
 * These mutate the palette and assert the checks notice — so if someone later
 * refactors the maths into something that returns 100 for everything, this file
 * fails instead of going quietly green.
 */
describe('mutation: the checks fail when the palette is worse', () => {
  const check = (a: string, b: string): boolean => worstDistance(a, b) >= MIN_DELTA_E

  it('rejects two roles set to the same colour', () => {
    expect(check(Palette.self, Palette.self)).toBe(false)
    expect(check(Palette.danger, Palette.danger)).toBe(false)
  })

  it('rejects a role nudged to within a few units of another', () => {
    // #5CE0F0 vs a barely-shifted copy. Passes a naive "are the strings equal"
    // check and fails this one, which is the whole point of measuring.
    expect(check('#5CE0F0', '#5EE2F2')).toBe(false)
    expect(worstDistance('#5CE0F0', '#5EE2F2')).toBeLessThan(2)
  })

  it('rejects a pair that only collapses under one simulation', () => {
    // Cyan and spring green: obviously different to normal vision and to both
    // red-green deficiencies, indistinguishable to a tritanope. A checker that
    // measured normal vision alone would pass this, and it is the exact failure
    // this palette has today between `self` and `good`.
    expect(deltaE2000(toLab(parseHex('#5CE0F0')), toLab(parseHex('#4ADE9B')))).toBeGreaterThan(20)
    expect(check('#5CE0F0', '#4ADE9B')).toBe(false)
  })

  it('rejects text that misses AA', () => {
    expect(worstContrast('#4A5768', Palette.panel)).toBeLessThan(MIN_CONTRAST_AA)
    expect(worstContrast('#C9D7E6', Palette.panel)).toBeGreaterThanOrEqual(MIN_CONTRAST_AA)
  })

  it('would notice if the simulation stopped simulating', () => {
    // If `simulate` were accidentally turned into the identity function, every
    // dichromatic column would equal the normal one and the file would lose most
    // of its value while still passing. This is what catches that.
    const shifted = distances('#FF0000', '#00FF00')
    expect(shifted[0]).not.toBeCloseTo(shifted[2] ?? 0, 1)
  })
})
