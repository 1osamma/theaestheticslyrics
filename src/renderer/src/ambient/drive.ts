/**
 * Frame-rate independent exponential approach of `current` toward `target`: after `tauMs`
 * about 63% of the way there. Used so drive changes (pause, resume) glide instead of jumping.
 */
export function approach(current: number, target: number, dtMs: number, tauMs: number): number {
  if (!(dtMs > 0)) return current
  if (tauMs <= 0) return target
  return target + (current - target) * Math.exp(-dtMs / tauMs)
}
