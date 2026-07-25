/**
 * Colour tokens.
 *
 * THE RULE: colour is information, never decoration. `DANGER` means something
 * can hurt you right now, and appears nowhere else — which is what lets a player
 * read a screen full of bullets at a glance. If a new UI element needs a colour
 * and none of these fit, that's a signal the design is unclear, not that the
 * palette is short.
 */

export const Palette = {
  /** Deep space. The default void. */
  void: '#05070B',
  /** Slightly raised surfaces: the instrument panel, dialog bodies. */
  panel: '#0D131B',
  /** Raised again: rows, wells, input fields. */
  panelRaised: '#151E29',
  /** Hairlines, dividers, panel bezels. */
  line: '#22303F',

  /** Primary reading text. */
  text: '#C9D7E6',
  /** Secondary text: labels, units, hints. Still WCAG AA on `void`. */
  textDim: '#7C8CA1',
  /** Tertiary: disabled, placeholder. Use sparingly — it is near-illegible by design. */
  textFaint: '#4A5768',

  /** The player, focus rings, selected state, player projectiles. */
  self: '#5CE0F0',
  /** Caution: low resources, timers running out, risky routes. */
  caution: '#F5B942',
  /** DANGER ONLY. Enemy fire, incoming damage, lethal hazards, death. */
  danger: '#FF4A38',
  /** Confirmation, healing, gains, successful extraction. */
  good: '#4ADE9B',
  /** Rare/relic tier highlight. */
  relic: '#C084FC',

  /** Additive glow layers are drawn in these, always with 'lighter' compositing. */
  glowSelf: 'rgba(92, 224, 240, 0.55)',
  glowDanger: 'rgba(255, 74, 56, 0.5)',
  glowWarm: 'rgba(245, 185, 66, 0.45)',
} as const

/** Starfield layers, back to front: dimmer and slower behind. */
export const StarLayers = [
  { count: 70, speed: 6, size: 1, color: '#2A3A4D' },
  { count: 45, speed: 16, size: 1.4, color: '#4A5F79' },
  { count: 22, speed: 34, size: 2, color: '#8AA0BA' },
] as const

/**
 * Type stack.
 *
 * Monospace throughout, and deliberately so: this is an instrument panel, the
 * numbers are meant to be scanned, and tabular figures stop values from jittering
 * as they change. It also means zero font loading and zero binary assets.
 */
export const Font = {
  stack: `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`,
  /** Smallest size we will ever render. Below this, text stops being readable. */
  minSizePx: 11,
} as const

export function font(sizePx: number, weight: 400 | 600 | 700 = 400): string {
  return `${weight} ${Math.max(sizePx, Font.minSizePx)}px ${Font.stack}`
}
