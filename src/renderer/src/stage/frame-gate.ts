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
 * Decides which display refreshes draw, for a target frame rate. Frames follow a schedule (not
 * "time since the last frame"), so the average rate matches the target even when it does not
 * divide the refresh rate: 120 FPS on a 180 Hz panel alternates one- and two-refresh steps
 * instead of falling to 90. A refresh that arrives a hair early still counts, and after a stall
 * the schedule restarts rather than bursting to catch up.
 */
export class FrameGate {
  private next = Number.NEGATIVE_INFINITY

  due(now: number, fps: number): boolean {
    if (!Number.isFinite(fps) || fps <= 0) {
      this.next = Number.NEGATIVE_INFINITY
      return true
    }
    const interval = 1000 / fps
    const tolerance = Math.min(2, interval * 0.15)
    if (now < this.next - tolerance) return false
    this.next = now - this.next > interval ? now + interval : this.next + interval
    return true
  }

  reset(): void {
    this.next = Number.NEGATIVE_INFINITY
  }
}
