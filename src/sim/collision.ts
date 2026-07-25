/**
 * Overlap tests.
 *
 * Every helper here takes and returns primitives. Collision is the hottest loop
 * in the sim — worst case it is (live projectiles x live enemies) tests per tick,
 * tens of thousands per second — so a helper that allocated a vector or a result
 * object per call would hand the GC a sawtooth that shows up as dropped frames.
 * Nothing in this file allocates.
 *
 * Circles only. See docs/ARCHITECTURE.md: nothing in this game needs a
 * rigid-body solver, and a physics library would add nondeterminism risk for no
 * benefit.
 */

/** True when two circles touch or overlap. Squared compare, so no sqrt. */
export function circlesOverlap(
  ax: number,
  ay: number,
  ar: number,
  bx: number,
  by: number,
  br: number,
): boolean {
  const dx = ax - bx
  const dy = ay - by
  const r = ar + br
  return dx * dx + dy * dy <= r * r
}

export function pointInCircle(px: number, py: number, cx: number, cy: number, r: number): boolean {
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= r * r
}

/**
 * True when the swept path (x0,y0)->(x1,y1) passes within `r` of (cx,cy).
 *
 * Used for player bullets, which travel ~10 virtual units per tick. A point test
 * at the end of the step lets a fast bullet skip clean through a small enemy on
 * alternating frames, which reads as the gun randomly not working. Testing the
 * segment the bullet actually travelled removes that entirely, and costs one
 * extra dot product.
 */
export function segmentHitsCircle(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  cx: number,
  cy: number,
  r: number,
): boolean {
  const dx = x1 - x0
  const dy = y1 - y0
  const fx = cx - x0
  const fy = cy - y0
  const lengthSq = dx * dx + dy * dy
  // Degenerate step (a stationary projectile) collapses to a point test.
  if (lengthSq <= 0) return fx * fx + fy * fy <= r * r

  // Project the circle centre onto the segment, clamped to its ends, then
  // measure from the closest point rather than from either endpoint.
  let t = (fx * dx + fy * dy) / lengthSq
  if (t < 0) t = 0
  else if (t > 1) t = 1

  const nx = fx - t * dx
  const ny = fy - t * dy
  return nx * nx + ny * ny <= r * r
}
