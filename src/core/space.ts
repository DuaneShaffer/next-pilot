/**
 * The virtual coordinate space, shared by simulation and rendering.
 *
 * This lives in core rather than render because the playfield is a *simulation*
 * boundary — it decides where a ship may fly and when a bullet leaves play — and
 * the sim must never import rendering code. Fixed virtual units also mean window
 * size can't change difficulty, and screenshots always compare like with like.
 */

export const VIRTUAL_W = 640
export const VIRTUAL_H = 720

/** The instrument panel column on the right. See docs/UI.md. */
export const PANEL_W = 192

export const PLAYFIELD_W = VIRTUAL_W - PANEL_W // 448
export const PLAYFIELD_H = VIRTUAL_H

export const Playfield = {
  x: 0,
  y: 0,
  w: PLAYFIELD_W,
  h: PLAYFIELD_H,
  right: PLAYFIELD_W,
  bottom: PLAYFIELD_H,
  centerX: PLAYFIELD_W / 2,
} as const

/** How far off-screen an entity travels before it is culled from the sim. */
export const CULL_MARGIN = 48

export function isOutOfPlay(x: number, y: number): boolean {
  return (
    x < -CULL_MARGIN ||
    x > PLAYFIELD_W + CULL_MARGIN ||
    y < -CULL_MARGIN ||
    y > PLAYFIELD_H + CULL_MARGIN
  )
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}
