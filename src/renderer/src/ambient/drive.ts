import type { LightingDrive } from '@shared/lighting'
import type { AnimationIntensity } from '@shared/types'

/** How lively the drift is at each animation setting. */
export const MOTION: Record<AnimationIntensity, number> = { low: 0.45, medium: 0.75, high: 1 }

export interface AlbumDriveInput {
  playing: boolean
  animation: AnimationIntensity
  /** Reduced motion, or no GPU compositing: the light holds still. */
  still: boolean
}

/**
 * Album Art Ambient (Phase 1): the light breathes slowly while music plays and settles,
 * dimmer and calmer, when it pauses. Audio-reactive modes will produce the same shape
 * from smoothed audio bands instead.
 */
export function albumDrive({ playing, animation, still }: AlbumDriveInput): LightingDrive {
  const motion = still ? 0 : MOTION[animation] * (playing ? 1 : 0.35)
  return { intensity: playing ? 1 : 0.72, motion }
}

/**
 * Frame-rate independent exponential approach of `current` toward `target`: after `tauMs`
 * about 63% of the way there. Used so drive changes (pause, resume) glide instead of jumping.
 */
export function approach(current: number, target: number, dtMs: number, tauMs: number): number {
  if (!(dtMs > 0)) return current
  if (tauMs <= 0) return target
  return target + (current - target) * Math.exp(-dtMs / tauMs)
}
