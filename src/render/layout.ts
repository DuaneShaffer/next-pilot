/**
 * Panel geometry, spacing scale, and the window-fitting viewport.
 *
 * The virtual space itself is defined in core/space.ts, because the simulation
 * needs the playfield bounds and must not depend on rendering.
 */

import { PANEL_W, PLAYFIELD_W, VIRTUAL_H, VIRTUAL_W } from '../core/space'

export { VIRTUAL_W, VIRTUAL_H, PANEL_W, PLAYFIELD_W, Playfield } from '../core/space'

/** Instrument panel bounds in virtual coordinates. */
export const Panel = {
  x: PLAYFIELD_W,
  y: 0,
  w: PANEL_W,
  h: VIRTUAL_H,
  /** Inner content inset, so nothing touches the bezel. */
  pad: 14,
  get contentX(): number {
    return PLAYFIELD_W + 14
  },
  get contentW(): number {
    return PANEL_W - 28
  },
} as const

/** Consistent spacing scale. Every gap in the UI is one of these values. */
export const Space = {
  xs: 4,
  sm: 8,
  md: 14,
  lg: 22,
  xl: 34,
} as const

/**
 * Scales the virtual space to the window and hands back a context whose
 * coordinates are virtual units.
 */
export class Viewport {
  readonly ctx: CanvasRenderingContext2D
  /** Virtual-units-to-CSS-pixels factor. */
  scale = 1

  constructor(readonly canvas: HTMLCanvasElement) {
    // alpha:false lets the compositor skip blending the canvas over the page.
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('This browser cannot provide a 2D canvas context.')
    this.ctx = ctx
  }

  /**
   * Size the canvas to fit the container, preserving aspect ratio.
   *
   * The backing store is sized in device pixels so text and hairlines stay crisp
   * on high-DPI displays — a canvas sized only in CSS pixels is the usual reason
   * browser games look soft.
   */
  resize(containerW: number, containerH: number, devicePixelRatio = 1): void {
    this.scale = Math.min(containerW / VIRTUAL_W, containerH / VIRTUAL_H)

    const cssW = Math.round(VIRTUAL_W * this.scale)
    const cssH = Math.round(VIRTUAL_H * this.scale)
    const dpr = Math.max(1, devicePixelRatio)

    this.canvas.style.width = `${cssW}px`
    this.canvas.style.height = `${cssH}px`
    this.canvas.width = Math.round(cssW * dpr)
    this.canvas.height = Math.round(cssH * dpr)

    // After this, all drawing uses virtual units and forgets DPR exists.
    const unit = this.scale * dpr
    this.ctx.setTransform(unit, 0, 0, unit, 0, 0)
  }
}
