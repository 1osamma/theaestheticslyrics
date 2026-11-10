import type { FrameRateCap, ShowOn } from '@shared/types'

/**
 * Frames per second: full rate only while a word is popping in; the slow ambient drift
 * looks the same at a lower rate and costs a fraction of the power. The desktop overlay
 * is capped lower because Windows composites transparent full-screen windows expensively.
 * Infinity means "every display refresh".
 */
const FRAME_RATE: Record<ShowOn, { busy: number; idle: number }> = {
  lock: { busy: Number.POSITIVE_INFINITY, idle: 24 },
  always: { busy: 30, idle: 15 }
}

/** The frame rate to draw at next, after the user's frame-rate limit (0 = none). */
export function targetFps(mode: ShowOn, busy: boolean, cap: FrameRateCap): number {
  const fps = FRAME_RATE[mode][busy ? 'busy' : 'idle']
  return cap > 0 ? Math.min(fps, cap) : fps
}

/**
 * Below this interval the loop skips display refreshes instead of sleeping, so capped frames
 * stay aligned to vsync (a timer would land between refreshes and judder).
 */
export const VSYNC_GATE_MAX_MS = 20

/**
 * Whether a display refresh at `now` should draw, given the last drawn frame and the target
 * rate. A small tolerance lets a refresh that arrives a hair early still count.
 */
export function frameDue(lastFrame: number, now: number, fps: number): boolean {
  if (!Number.isFinite(fps)) return true
  const interval = 1000 / fps
  return now - lastFrame >= interval - Math.min(2, interval * 0.15)
}
