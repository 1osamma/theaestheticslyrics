import type { EdgeSides } from '@shared/lighting'

/**
 * Per-edge strength: the side edges carry the primary glow, the bottom a secondary one and the
 * top a subtle one, like light spilling around a screen.
 */
export function edgeWeights(sides: EdgeSides, scale = 1): [number, number, number, number] {
  return [sides.left ? scale : 0, sides.right ? scale : 0, sides.top ? 0.45 * scale : 0, sides.bottom ? 0.7 * scale : 0]
}
