import type { LightFrame } from '@shared/lighting'

/** Where and how a light frame is drawn. */
export interface LightView {
  /** CSS pixels. */
  width: number
  height: number
  /** True for the transparent desktop edge overlay (no background, no atmosphere). */
  overlay: boolean
  /** Bloom centre in 0–1 screen coordinates, origin top left. */
  focus: [number, number]
  /** Left, right, top, bottom edge weights (0 when the edge is off). */
  edges: [number, number, number, number]
  /** Edge thickness, softness, spread (0–1). */
  edgeShape: [number, number, number]
  /** Monotonic ms, for fallbacks that animate on their own clock. */
  wallMs: number
}

/** Draws light frames. WebGL2 normally; a CSS fallback without a GPU or after a lost context. */
export interface LightRenderer {
  readonly kind: 'webgl' | 'css'
  mount(parent: HTMLElement): void
  render(frame: LightFrame, view: LightView): void
  destroy(): void
}

const channel = (v: number): string =>
  Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, '0')

export const rgbToHex = (c: readonly number[]): string => `#${channel(c[0]!)}${channel(c[1]!)}${channel(c[2]!)}`
