/**
 * Parallax starfield.
 *
 * Purely cosmetic, and drawn from its own RNG stream so that changing the star
 * layout can never perturb gameplay randomness.
 */

import { TICK_SECONDS } from '../core/loop'
import { Rng } from '../core/rng'
import { PLAYFIELD_H, PLAYFIELD_W } from '../core/space'
import { StarLayers } from './palette'

interface Star {
  x: number
  y: number
  layer: number
  /** Per-star phase so twinkling isn't synchronised across the field. */
  phase: number
}

export class Starfield {
  private readonly stars: Star[] = []

  /**
   * Width/height default to the playfield, but the title screen draws full-bleed
   * across the whole virtual space, so both are parameterised.
   */
  constructor(
    seed: string,
    private readonly width = PLAYFIELD_W,
    private readonly height = PLAYFIELD_H,
  ) {
    const rng = Rng.fromSeed(seed, 'cosmetic:starfield')
    StarLayers.forEach((layer, index) => {
      for (let i = 0; i < layer.count; i++) {
        this.stars.push({
          x: rng.range(0, width),
          y: rng.range(0, height),
          layer: index,
          phase: rng.range(0, Math.PI * 2),
        })
      }
    })
  }

  /** Advance one tick. Scroll speed multiplier lets menus drift slowly. */
  update(speedScale = 1): void {
    for (const star of this.stars) {
      const layer = StarLayers[star.layer]
      if (!layer) continue
      star.y += layer.speed * speedScale * TICK_SECONDS
      if (star.y > this.height) {
        star.y -= this.height
        // Re-randomising x on wrap would need the RNG every frame; a fixed
        // horizontal drift keeps it deterministic and cheap, and reads the same.
        star.x = (star.x * 1.618 + 37) % this.width
      }
      star.phase += 0.02
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    for (const star of this.stars) {
      const layer = StarLayers[star.layer]
      if (!layer) continue
      ctx.fillStyle = layer.color
      // Only the nearest layer twinkles; twinkling everything looks like noise.
      const size =
        star.layer === StarLayers.length - 1
          ? layer.size * (0.75 + 0.25 * Math.sin(star.phase))
          : layer.size
      ctx.fillRect(star.x, star.y, size, size)
    }
  }
}
