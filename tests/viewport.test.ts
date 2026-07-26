/**
 * Viewport fitting tests.
 *
 * The load-bearing one is `the playfield aspect never changes`. It sweeps a few
 * hundred real device sizes, insets and pixel ratios and asserts the playfield
 * lands on screen at exactly 448:720 every single time. That is the frozen
 * constraint from docs/DESIGN.md, already pinned in virtual units by
 * `tests/integration.test.ts`; this pins it in *screen* units, which is where
 * someone trying to "use the whole screen" would actually break it.
 */

import { describe, expect, it } from 'vitest'

import { PANEL_W, PLAYFIELD_H, PLAYFIELD_W, VIRTUAL_H, VIRTUAL_W } from '../src/core/space'
import {
  MAX_BACKING_PIXELS,
  MAX_DPR,
  MODE_HYSTERESIS,
  NO_INSETS,
  PORTRAIT_PANEL_H,
  PORTRAIT_VIRTUAL_H,
  PORTRAIT_VIRTUAL_W,
  containsPoint,
  fitViewport,
  panelRect,
  playfieldCssRect,
  playfieldRect,
  toVirtual,
  type Insets,
} from '../src/core/viewport'

const FROZEN_ASPECT = PLAYFIELD_W / PLAYFIELD_H

/** CSS-pixel viewports, real devices plus a few deliberate awkward ones. */
const CONTAINERS: readonly (readonly [number, number, string])[] = [
  [390, 844, 'iPhone 14/15 portrait'],
  [844, 390, 'iPhone 14/15 landscape'],
  [430, 932, 'iPhone 15 Pro Max portrait'],
  [375, 667, 'iPhone SE portrait'],
  [360, 640, 'small Android portrait'],
  [412, 915, 'Pixel 7 portrait'],
  [820, 1180, 'iPad Air portrait'],
  [1180, 820, 'iPad Air landscape'],
  [1280, 720, 'laptop'],
  [1920, 1080, 'desktop'],
  [3840, 2160, '4K'],
  [700, 700, 'square'],
  [320, 480, 'tiny'],
  [1, 1, 'degenerate'],
  [0, 0, 'zero, as a resize can legitimately report'],
]

const INSETS: readonly (readonly [Insets, string])[] = [
  [NO_INSETS, 'none'],
  [{ top: 47, right: 0, bottom: 34, left: 0 }, 'notch + home indicator, portrait'],
  [{ top: 0, right: 47, bottom: 21, left: 47 }, 'notch, landscape'],
  [{ top: 24, right: 12, bottom: 12, left: 12 }, 'status bar plus rounded corners'],
]

const RATIOS = [1, 1.5, 2, 2.625, 3, 4]

describe('the playfield aspect never changes', () => {
  it('lands at exactly 448:720 on every container, inset and pixel ratio', () => {
    for (const [containerW, containerH, label] of CONTAINERS) {
      for (const [insets, insetLabel] of INSETS) {
        for (const dpr of RATIOS) {
          const fit = fitViewport({ containerW, containerH, dpr, insets })
          const rect = playfieldCssRect(fit)
          const where = `${label} / ${insetLabel} / dpr ${dpr}`

          expect(rect.w / rect.h, where).toBeCloseTo(FROZEN_ASPECT, 10)
          // The virtual playfield itself is untouched in either mode.
          expect(fit.playfield.w, where).toBe(448)
          expect(fit.playfield.h, where).toBe(720)
        }
      }
    }
  })

  it('scales x and y by the same factor, which is the only way that stays true', () => {
    for (const [containerW, containerH] of CONTAINERS) {
      const fit = fitViewport({ containerW, containerH })
      const rect = playfieldCssRect(fit)
      expect(rect.w / PLAYFIELD_W).toBeCloseTo(fit.scale, 12)
      expect(rect.h / PLAYFIELD_H).toBeCloseTo(fit.scale, 12)
    }
  })

  it('gives a phone in portrait exactly the same playfield as a desktop', () => {
    const phone = fitViewport({ containerW: 390, containerH: 844 })
    const desktop = fitViewport({ containerW: 1920, containerH: 1080 })
    expect(phone.mode).toBe('portrait')
    expect(desktop.mode).toBe('landscape')
    expect(phone.playfield).toEqual(desktop.playfield)
    expect(playfieldCssRect(phone).w / playfieldCssRect(phone).h).toBeCloseTo(
      playfieldCssRect(desktop).w / playfieldCssRect(desktop).h,
      10,
    )
  })
})

describe('layout mode', () => {
  it('picks the placement that gives the bigger playfield', () => {
    expect(fitViewport({ containerW: 390, containerH: 844 }).mode).toBe('portrait')
    expect(fitViewport({ containerW: 844, containerH: 390 }).mode).toBe('landscape')
    expect(fitViewport({ containerW: 1280, containerH: 720 }).mode).toBe('landscape')
    expect(fitViewport({ containerW: 412, containerH: 915 }).mode).toBe('portrait')
  })

  it('matches the arrangement docs/DESIGN.md commits to on a 390x844 phone', () => {
    const fit = fitViewport({ containerW: 390, containerH: 844 })
    expect(fit.mode).toBe('portrait')
    // Width-limited: the playfield fills the screen edge to edge.
    expect(fit.scale).toBeCloseTo(390 / 448, 6)
    expect(playfieldCssRect(fit).w).toBeCloseTo(390, 6)
    expect(playfieldCssRect(fit).h).toBeCloseTo(627, 0)
    // ~104 CSS pixels of panel bar beneath it, 731 of 844 pixels used.
    expect(fit.cssH - playfieldCssRect(fit).h).toBeCloseTo(104, 0)
    expect(fit.cssH).toBeCloseTo(731, 0)
  })

  it('does not flip modes on a nudge, once a mode is in use', () => {
    // A container near the crossover would otherwise thrash between a right-hand
    // column and a bottom bar on every resize event.
    // Holding the mode a container already has must never change it.
    for (const [w, h] of CONTAINERS) {
      const free = fitViewport({ containerW: w, containerH: h })
      const sticky = fitViewport({ containerW: w, containerH: h, preferred: free.mode })
      expect(sticky.mode).toBe(free.mode)
    }

    // 560x720 sits inside the band: landscape scores 0.875 and portrait 0.857, a
    // 2.1% difference, so whichever mode is already in use keeps it.
    expect(fitViewport({ containerW: 560, containerH: 720 }).mode).toBe('landscape')
    expect(fitViewport({ containerW: 560, containerH: 720, preferred: 'portrait' }).mode).toBe(
      'portrait',
    )
    const band =
      fitViewport({ containerW: 560, containerH: 720 }).scale /
      fitViewport({ containerW: 560, containerH: 720, preferred: 'portrait' }).scale
    expect(band).toBeLessThan(MODE_HYSTERESIS)
  })

  it('still rotates when the other mode is genuinely much better', () => {
    // Hysteresis must not become stickiness: turning a phone from landscape to
    // portrait is a 43% improvement and has to be honoured.
    expect(fitViewport({ containerW: 390, containerH: 844, preferred: 'landscape' }).mode).toBe(
      'portrait',
    )
    expect(fitViewport({ containerW: 844, containerH: 390, preferred: 'portrait' }).mode).toBe(
      'landscape',
    )
  })

  it('places the panel beside the playfield in landscape and beneath it in portrait', () => {
    expect(panelRect('landscape')).toEqual({ x: PLAYFIELD_W, y: 0, w: PANEL_W, h: VIRTUAL_H })
    expect(panelRect('portrait')).toEqual({
      x: 0,
      y: PLAYFIELD_H,
      w: PORTRAIT_VIRTUAL_W,
      h: PORTRAIT_PANEL_H,
    })
  })

  it('never overlaps the panel with the playfield, in either mode', () => {
    // UI rule 1: nothing that conveys persistent state is drawn over the play area.
    // The bottom bar is the placement most likely to get that wrong.
    for (const mode of ['landscape', 'portrait'] as const) {
      const pf = playfieldRect()
      const panel = panelRect(mode)
      const overlapX = Math.min(pf.x + pf.w, panel.x + panel.w) - Math.max(pf.x, panel.x)
      const overlapY = Math.min(pf.y + pf.h, panel.y + panel.h) - Math.max(pf.y, panel.y)
      expect(Math.min(overlapX, overlapY), mode).toBeLessThanOrEqual(0)
    }
  })

  it('accounts for the whole composed canvas in both modes', () => {
    expect(PLAYFIELD_W + PANEL_W).toBe(VIRTUAL_W)
    expect(PORTRAIT_VIRTUAL_W).toBe(PLAYFIELD_W)
    expect(PORTRAIT_VIRTUAL_H).toBe(PLAYFIELD_H + PORTRAIT_PANEL_H)
  })

  it('records the cost of the portrait bar rather than hiding it', () => {
    // The bottom bar has 39% of the landscape column's area. Portrait cannot show
    // the same panel content at the same type size, and UI rule 7's 11px floor
    // means shrinking the text is not an escape. See docs/MOBILE.md.
    const landscapeArea = PANEL_W * VIRTUAL_H
    const portraitArea = PORTRAIT_VIRTUAL_W * PORTRAIT_PANEL_H
    expect(portraitArea / landscapeArea).toBeLessThan(0.45)
    expect(portraitArea / landscapeArea).toBeGreaterThan(0.3)
  })
})

describe('safe areas', () => {
  it('keeps the whole canvas inside the safe rect', () => {
    for (const [containerW, containerH, label] of CONTAINERS) {
      for (const [insets, insetLabel] of INSETS) {
        if (containerW <= 1 || containerH <= 1) continue
        const fit = fitViewport({ containerW, containerH, insets })
        const where = `${label} / ${insetLabel}`
        const availW = containerW - insets.left - insets.right
        const availH = containerH - insets.top - insets.bottom
        if (availW <= 0 || availH <= 0) continue

        expect(fit.offsetX, where).toBeGreaterThanOrEqual(insets.left - 1e-9)
        expect(fit.offsetY, where).toBeGreaterThanOrEqual(insets.top - 1e-9)
        expect(fit.offsetX + fit.cssW, where).toBeLessThanOrEqual(containerW - insets.right + 1e-9)
        expect(fit.offsetY + fit.cssH, where).toBeLessThanOrEqual(
          containerH - insets.bottom + 1e-9,
        )
      }
    }
  })

  it('shrinks rather than shifts when an inset appears', () => {
    // A home indicator must not push the playfield off the bottom of the screen.
    const plain = fitViewport({ containerW: 390, containerH: 844 })
    const inset = fitViewport({
      containerW: 390,
      containerH: 844,
      insets: { top: 47, right: 0, bottom: 34, left: 0 },
    })
    expect(inset.cssH).toBeLessThanOrEqual(plain.cssH)
    expect(inset.offsetY).toBeGreaterThanOrEqual(47)
  })

  it('honours a margin on top of the insets', () => {
    const fit = fitViewport({ containerW: 1280, containerH: 720, margin: 12 })
    expect(fit.offsetX).toBeGreaterThanOrEqual(12)
    expect(fit.offsetX + fit.cssW).toBeLessThanOrEqual(1280 - 12 + 1e-9)
  })
})

describe('device pixel ratio', () => {
  it('caps the ratio so the additive glow pass stays affordable', () => {
    for (const [containerW, containerH] of CONTAINERS) {
      for (const dpr of RATIOS) {
        const fit = fitViewport({ containerW, containerH, dpr })
        expect(fit.dpr).toBeLessThanOrEqual(MAX_DPR + 1e-9)
        expect(fit.dpr).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('caps total backing pixels even when the ratio is already legal', () => {
    // A maximised window on a 1080p display at 2x is 2.07 megapixels of canvas
    // before the cap; the budget pulls the ratio down rather than the resolution.
    const fit = fitViewport({ containerW: 1920, containerH: 1080, dpr: 2 })
    expect(fit.dpr).toBeLessThan(2)
    expect(fit.backingW * fit.backingH).toBeLessThanOrEqual(MAX_BACKING_PIXELS * 1.01)
  })

  it('never reduces below one device pixel per CSS pixel', () => {
    // A 4K window is 4.1 megapixels of canvas at 1x and the budget cannot be met.
    // Rendering below CSS resolution to meet it would be a visibly soft canvas
    // traded for a frame budget — the wrong side of UI rule 7.
    const fit = fitViewport({ containerW: 3840, containerH: 2160, dpr: 3 })
    expect(fit.dpr).toBe(1)
    expect(fit.backingW).toBe(Math.round(fit.cssW))
  })

  it('does not upscale a 1x display', () => {
    const fit = fitViewport({ containerW: 1280, containerH: 720, dpr: 1 })
    expect(fit.dpr).toBe(1)
    expect(fit.backingW).toBe(Math.round(fit.cssW))
  })

  it('never asks for a zero-sized backing store', () => {
    for (const [containerW, containerH] of CONTAINERS) {
      const fit = fitViewport({ containerW, containerH, dpr: 3 })
      expect(fit.backingW).toBeGreaterThanOrEqual(1)
      expect(fit.backingH).toBeGreaterThanOrEqual(1)
      expect(Number.isInteger(fit.backingW)).toBe(true)
      expect(Number.isInteger(fit.backingH)).toBe(true)
    }
  })
})

describe('mapping a touch back into virtual units', () => {
  it('round-trips the playfield corners', () => {
    const fit = fitViewport({
      containerW: 390,
      containerH: 844,
      insets: { top: 47, right: 0, bottom: 34, left: 0 },
    })
    const rect = playfieldCssRect(fit)

    const topLeft = toVirtual(fit, rect.x, rect.y)
    expect(topLeft.x).toBeCloseTo(0, 6)
    expect(topLeft.y).toBeCloseTo(0, 6)

    const bottomRight = toVirtual(fit, rect.x + rect.w, rect.y + rect.h)
    expect(bottomRight.x).toBeCloseTo(PLAYFIELD_W, 6)
    expect(bottomRight.y).toBeCloseTo(PLAYFIELD_H, 6)
  })

  it('respects a container that is not the whole window', () => {
    const fit = fitViewport({ containerW: 800, containerH: 600 })
    const inside = toVirtual(fit, 120 + fit.offsetX + 40, 60 + fit.offsetY + 40, 120, 60)
    expect(inside.x).toBeCloseTo(40 / fit.scale, 6)
    expect(inside.y).toBeCloseTo(40 / fit.scale, 6)
  })

  it('reports letterbox touches as outside the playfield rather than clamping', () => {
    // Clamping would make a thumb resting on the bezel read as a thumb on the edge
    // of the play area, which in relative drag is a phantom finger that steers.
    const fit = fitViewport({ containerW: 1280, containerH: 720 })
    const point = toVirtual(fit, 2, 360)
    expect(point.x).toBeLessThan(0)
    expect(containsPoint(playfieldRect(), point.x, point.y)).toBe(false)
  })

  it('separates a panel touch from a playfield touch in portrait', () => {
    const fit = fitViewport({ containerW: 390, containerH: 844 })
    const rect = playfieldCssRect(fit)
    const onPanel = toVirtual(fit, rect.x + rect.w / 2, rect.y + rect.h + 30)
    expect(containsPoint(playfieldRect(), onPanel.x, onPanel.y)).toBe(false)
    expect(containsPoint(panelRect('portrait'), onPanel.x, onPanel.y)).toBe(true)
  })
})

describe('degenerate input', () => {
  it('survives a zero-sized, NaN, or negative container', () => {
    for (const [w, h] of [
      [0, 0],
      [-10, -10],
      [Number.NaN, 400],
      [400, Number.NaN],
      [Number.POSITIVE_INFINITY, 400],
    ] as const) {
      const fit = fitViewport({ containerW: w, containerH: h, dpr: Number.NaN })
      expect(Number.isFinite(fit.scale)).toBe(true)
      expect(fit.scale).toBeGreaterThan(0)
      expect(fit.backingW).toBeGreaterThanOrEqual(1)
    }
  })

  it('survives insets larger than the container', () => {
    const fit = fitViewport({
      containerW: 100,
      containerH: 100,
      insets: { top: 200, right: 200, bottom: 200, left: 200 },
    })
    expect(Number.isFinite(fit.scale)).toBe(true)
    expect(fit.scale).toBeGreaterThan(0)
  })
})
