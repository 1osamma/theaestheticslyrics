import type { LightFrame } from '@shared/lighting'

/** Whether two light frames would draw the same picture (skips redundant GPU work). */
export function sameLight(a: LightFrame | null, b: LightFrame): boolean {
  if (!a || a.active !== b.active) return false
  if (!b.active) return true
  return (
    a.atmosphere === b.atmosphere &&
    a.bloom === b.bloom &&
    a.shimmer === b.shimmer &&
    a.phase === b.phase &&
    a.edge === b.edge &&
    a.bloomRadius === b.bloomRadius &&
    a.colors.every((c, i) => c[0] === b.colors[i]![0] && c[1] === b.colors[i]![1] && c[2] === b.colors[i]![2])
  )
}

/** A copy that later engine samples cannot change. */
export const copyLight = (f: LightFrame): LightFrame => ({ ...f, colors: f.colors.map((c) => [c[0], c[1], c[2]]) })
