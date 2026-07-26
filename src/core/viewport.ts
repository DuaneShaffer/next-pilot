/**
 * Viewport fitting: how the frozen virtual space lands on a real screen.
 *
 * THE FROZEN CONSTRAINT (docs/DESIGN.md, pinned by `tests/integration.test.ts`):
 * the playfield is 448x720 virtual units on every device, forever. A wider
 * playfield makes dodging easier and a narrower one makes it harder, so a
 * per-device play area would quietly void seeded runs, daily contracts and shared
 * replays. Everything in this file therefore computes a *uniform* scale and a
 * letterbox. Nothing here may ever produce a different scale on x than on y, and
 * `tests/viewport.test.ts` sweeps for exactly that.
 *
 * What *is* responsive is the panel's placement: a right-hand column in landscape,
 * a bottom bar in portrait. That changes the size of the composed virtual canvas
 * (640x720 vs 448x840) without touching the playfield inside it.
 *
 * This module is pure arithmetic and holds no DOM. `src/render/layout.ts` owns the
 * canvas mutation; this owns the numbers, so the numbers can be tested headless and
 * the same fit can be reused for hit-testing touches back into virtual units.
 */

import { PANEL_W, PLAYFIELD_H, PLAYFIELD_W, VIRTUAL_H, VIRTUAL_W } from './space'

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/**
 * Where the instrument panel sits. Not a rendering preference — it decides the
 * composed virtual size, which decides the scale.
 */
export type LayoutMode = 'landscape' | 'portrait'

/**
 * Height of the portrait panel bar, in virtual units.
 *
 * 120 is derived from the target device rather than chosen for roundness. On a
 * 390x844 CSS-pixel phone the width-limited scale is 390/448 = 0.8705, so 120
 * virtual units is 104 CSS pixels of panel and the composed 448x840 canvas uses
 * 731 of the 844 available. That is the arrangement docs/DESIGN.md commits to.
 *
 * WHAT IT COSTS, stated because it is a real loss and not a free win: the
 * landscape panel is 192x720 = 138,240 square units. This bar is 448x120 = 53,760
 * — **39% of the area**. Portrait cannot show the same panel content at the same
 * type size. That is a panel-authoring problem (UI rule 7 sets a hard 11px floor,
 * so shrinking the text is not an escape), not a viewport problem, and it is the
 * open question recorded in docs/MOBILE.md.
 */
export const PORTRAIT_PANEL_H = 120

export const PORTRAIT_VIRTUAL_W = PLAYFIELD_W
export const PORTRAIT_VIRTUAL_H = PLAYFIELD_H + PORTRAIT_PANEL_H

/**
 * Ceiling on the device-pixel ratio used for the backing store.
 *
 * Fill cost is quadratic in this number and the additive glow pass (`'lighter'`)
 * pays it twice. A 3x phone costs 2.25x the fill of a 2x one for a difference
 * almost nobody can resolve on a 5-inch screen, and docs/ROADMAP.md names glow at
 * 3x DPR as M7's specific performance risk. Capping is the cheap half of that fix.
 *
 * NOT YET APPLIED to the shipping renderer: `src/render/layout.ts` still uses the
 * raw ratio. Adopting this changes what the game looks like on high-DPI displays
 * and therefore needs a reviewed screenshot, per CLAUDE.md's definition of done.
 */
export const MAX_DPR = 2

/**
 * Hard backstop on total backing-store pixels.
 *
 * The DPR cap alone does not bound this: a maximised window on a 4K display is
 * ~1920x2160 CSS pixels, which at 2x is 16.6 megapixels of canvas — an order of
 * magnitude past anything the frame budget was measured against. 2.4 megapixels is
 * roughly a 2x-scaled 1100x1100 window, comfortably above any realistic phone.
 */
export const MAX_BACKING_PIXELS = 2_400_000

export interface Insets {
  readonly top: number
  readonly right: number
  readonly bottom: number
  readonly left: number
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 }

export interface FitInput {
  /** Container size in CSS pixels. */
  readonly containerW: number
  readonly containerH: number
  /** `window.devicePixelRatio`. Clamped to at least 1 and at most MAX_DPR. */
  readonly dpr?: number
  /**
   * Safe-area insets in CSS pixels — notch, rounded corners, home indicator.
   * Read from `env(safe-area-inset-*)`; this module never touches the DOM.
   */
  readonly insets?: Insets
  /** Uniform breathing room inside the safe area, in CSS pixels. */
  readonly margin?: number
  /**
   * The mode currently in use, if any. Supplying it applies hysteresis so a
   * near-square container cannot flip layouts on every resize event.
   */
  readonly preferred?: LayoutMode
}

/**
 * How much better the other mode must be before a rotation actually switches.
 *
 * A container close to the crossover would otherwise thrash between a right-hand
 * column and a bottom bar as a desktop window is dragged, or as a tablet is held
 * near 45 degrees. 6% is below what anyone would notice as wasted space and well
 * above resize jitter.
 */
export const MODE_HYSTERESIS = 1.06

export interface ViewportFit {
  readonly mode: LayoutMode
  /** Virtual-units-to-CSS-pixels factor. The SAME on both axes, always. */
  readonly scale: number
  /** Composed virtual canvas for this mode. The playfield inside it never changes. */
  readonly virtualW: number
  readonly virtualH: number
  /** Canvas size and position within the container, in CSS pixels. */
  readonly cssW: number
  readonly cssH: number
  readonly offsetX: number
  readonly offsetY: number
  /** Effective device-pixel ratio after the cap and the pixel budget. */
  readonly dpr: number
  /** Backing-store size in device pixels. Integers — a canvas cannot be fractional. */
  readonly backingW: number
  readonly backingH: number
  /** Playfield and panel in virtual units, for this mode. */
  readonly playfield: Rect
  readonly panel: Rect
}

function virtualSize(mode: LayoutMode): { w: number; h: number } {
  return mode === 'portrait'
    ? { w: PORTRAIT_VIRTUAL_W, h: PORTRAIT_VIRTUAL_H }
    : { w: VIRTUAL_W, h: VIRTUAL_H }
}

/** The playfield rect never changes shape — only where the panel is put around it. */
export function playfieldRect(): Rect {
  return { x: 0, y: 0, w: PLAYFIELD_W, h: PLAYFIELD_H }
}

export function panelRect(mode: LayoutMode): Rect {
  return mode === 'portrait'
    ? { x: 0, y: PLAYFIELD_H, w: PORTRAIT_VIRTUAL_W, h: PORTRAIT_PANEL_H }
    : { x: PLAYFIELD_W, y: 0, w: PANEL_W, h: VIRTUAL_H }
}

function safeNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Fit the virtual space into a container, choosing the panel placement that gives
 * the larger playfield and letterboxing the remainder.
 *
 * Picking the mode by measured scale rather than by an orientation query is
 * deliberate: it does the right thing for a phone in portrait, a phone in
 * landscape, a tablet, a desktop window of any shape, and a split-screen pane,
 * without any of them being special-cased.
 */
export function fitViewport(input: FitInput): ViewportFit {
  const insets = input.insets ?? NO_INSETS
  const margin = Math.max(0, safeNumber(input.margin, 0))

  // A container smaller than nothing is not a crash; it is a 1x1 canvas nobody
  // sees, because a resize can legitimately fire at zero during layout.
  const availW = Math.max(
    1,
    safeNumber(input.containerW, 1) - insets.left - insets.right - margin * 2,
  )
  const availH = Math.max(
    1,
    safeNumber(input.containerH, 1) - insets.top - insets.bottom - margin * 2,
  )

  const landscape = virtualSize('landscape')
  const portrait = virtualSize('portrait')
  const landscapeScale = Math.min(availW / landscape.w, availH / landscape.h)
  const portraitScale = Math.min(availW / portrait.w, availH / portrait.h)

  let mode: LayoutMode
  if (input.preferred === 'portrait') {
    mode = landscapeScale > portraitScale * MODE_HYSTERESIS ? 'landscape' : 'portrait'
  } else if (input.preferred === 'landscape') {
    mode = portraitScale > landscapeScale * MODE_HYSTERESIS ? 'portrait' : 'landscape'
  } else {
    // Ties to landscape: it is the arrangement the panel was authored for.
    mode = portraitScale > landscapeScale ? 'portrait' : 'landscape'
  }

  const size = virtualSize(mode)
  const scale = mode === 'portrait' ? portraitScale : landscapeScale

  // Deliberately NOT rounded. Rounding css dimensions independently is how a
  // uniform scale turns into two slightly different scales, which is the one thing
  // the frozen-aspect constraint forbids. Fractional CSS pixels are legal.
  const cssW = size.w * scale
  const cssH = size.h * scale

  const offsetX = insets.left + margin + (availW - cssW) / 2
  const offsetY = insets.top + margin + (availH - cssH) / 2

  const requested = Math.max(1, safeNumber(input.dpr, 1))
  let dpr = Math.min(requested, MAX_DPR)
  const budgeted = Math.sqrt(MAX_BACKING_PIXELS / Math.max(1, cssW * cssH))
  if (budgeted < dpr) dpr = Math.max(1, budgeted)

  return {
    mode,
    scale,
    virtualW: size.w,
    virtualH: size.h,
    cssW,
    cssH,
    offsetX,
    offsetY,
    dpr,
    backingW: Math.max(1, Math.round(cssW * dpr)),
    backingH: Math.max(1, Math.round(cssH * dpr)),
    playfield: playfieldRect(),
    panel: panelRect(mode),
  }
}

/**
 * Map a client-space point (a pointer event's `clientX`/`clientY`) into virtual
 * units.
 *
 * `originX`/`originY` are the container's own client-space origin — pass the
 * container's bounding rect when it is not the whole window. Results are NOT
 * clamped: a point in the letterbox legitimately reads as negative or past the
 * virtual size, and callers hit-test against `playfieldRect()` rather than
 * receiving a silently clamped lie.
 */
export function toVirtual(
  fit: ViewportFit,
  clientX: number,
  clientY: number,
  originX = 0,
  originY = 0,
): { x: number; y: number } {
  return {
    x: (clientX - originX - fit.offsetX) / fit.scale,
    y: (clientY - originY - fit.offsetY) / fit.scale,
  }
}

export function containsPoint(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h
}

/** The playfield's position on screen, in CSS pixels relative to the container. */
export function playfieldCssRect(fit: ViewportFit): Rect {
  const pf = fit.playfield
  return {
    x: fit.offsetX + pf.x * fit.scale,
    y: fit.offsetY + pf.y * fit.scale,
    w: pf.w * fit.scale,
    h: pf.h * fit.scale,
  }
}
