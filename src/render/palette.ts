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
  textFaint: '#707F94',

  /** The player, focus rings, selected state, player projectiles. */
  self: '#5CE0F0',
  /** Caution: low resources, timers running out, risky routes. */
  caution: '#F5B942',
  /**
   * DANGER: things that can damage you *this instant* — enemy projectiles,
   * hazard fields, incoming damage, death. Never anything else.
   *
   * Note this is narrower than "the enemy". Enemy bodies use `hostile` below,
   * because if every hostile thing were danger-red, the projectile the player
   * must actually dodge would stop standing out — the exact failure the colour
   * rule exists to prevent.
   */
  danger: '#FF4A38',
  /**
   * `danger` when it is TEXT rather than a mark. Never interchangeable with it.
   *
   * `#FF4A38` is 3.78:1 on the panel and 4.10:1 on the void — both below WCAG AA,
   * which UI.md rule 7 claims all text meets. It had been used for the incident
   * report's cause line, personnel's LOST, and hazard callouts, so the rule was false
   * for exactly the text a player most needs to read.
   *
   * Two tokens rather than one brightened token, because the two uses want opposite
   * things: brightening the *mark* would cost it the little separation it has left
   * from `caution` (they differ only along the L–M axis, which protanopes and
   * deuteranopes lack), and darkening the *text* is what broke AA in the first place.
   * 5.22:1 on the panel, 5.66:1 on the void.
   */
  dangerText: '#FF7059',
  /** Enemy hulls and structures. Cold steel: present, readable, not screaming. */
  hostile: '#7A8498',
  /** Enemy hull fill, dark enough that the outline carries the silhouette. */
  hostileFill: '#1B2430',
  /** Elite//reinforced enemy accent. */
  hostileElite: '#4C7BFF',
  /** Confirmation, healing, gains, successful extraction. */
  good: '#EAFFC0',
  /** Rare/relic tier highlight. */
  relic: '#C86BF0',

  /** Additive glow layers are drawn in these, always with 'lighter' compositing. */
  glowSelf: 'rgba(92, 224, 240, 0.55)',
  /**
   * Dimmer than `glowSelf` on purpose: a screen full of projectiles must not
   * out-glow the single ship the player needs to track.
   */
  glowProjectile: 'rgba(92, 224, 240, 0.30)',
  glowDanger: 'rgba(255, 74, 56, 0.5)',
  glowWarm: 'rgba(245, 185, 66, 0.45)',
  /** Explosion core. Drawn additively over a short lifetime. */
  glowExplosion: 'rgba(255, 176, 92, 0.55)',
} as const

/**
 * A palette token at a given opacity.
 *
 * Exists because the alternative kept happening: a translucent wash would be written
 * as a literal `rgba(255, 74, 56, 0.2)`, which is `danger` today and *nothing* the day
 * `danger` is retuned — the fill silently keeps the old hue while every other use of
 * the token moves, and the two reds are then subtly different for no reason anyone can
 * discover. tests/palette.test.ts exists to measure these tokens and recommends
 * changing several of them, which is exactly the day this bites.
 *
 * Takes the `#RRGGBB` form the tokens above are written in.
 */
export function withAlpha(hex: string, alpha: number): string {
  const value = parseInt(hex.slice(1), 16)
  const a = alpha < 0 ? 0 : alpha > 1 ? 1 : Number.isFinite(alpha) ? alpha : 0
  return `rgba(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}, ${a.toFixed(3)})`
}

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
  /**
   * Smallest size we will ever render, in *virtual* units.
   *
   * Note the limitation this does not solve: the viewport scales the whole
   * virtual space to the window, so at a window smaller than the virtual height
   * the effective size is lower than this. 12 here yields ~11 effective px at
   * the smallest supported window. See UI.md rule 7.
   */
  minSizePx: 12,
} as const

export function font(sizePx: number, weight: 400 | 600 | 700 = 400): string {
  return `${weight} ${Math.max(sizePx, Font.minSizePx)}px ${Font.stack}`
}
