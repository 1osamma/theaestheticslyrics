import type { LyricEffect, LyricTransition } from '@shared/lyrics-style'

/**
 * The lyric timeline: turns word timestamps into keyframe plans the compositor plays on its own,
 * and moves lines with a critically damped spring. Pure functions, unit-tested.
 *
 * Every plan uses only `transform` and `opacity`, so Chromium runs it on the compositor thread at
 * the display's refresh rate, with exact song-time starts and durations, and main-thread hitches
 * cannot make a word stutter.
 */

// ---------- Line motion ----------

export interface Motion {
  /** Spring stiffness (rad/s) for line scrolling; critically damped, so it never overshoots. */
  omega: number
  /** A line moves into place this long before its first word, as a singer breathes in. */
  leadMs: number
  /** Lines further from the focus follow a little later, so the column flows like a wave. */
  cascadeMs: number
  /** Line opacity and size transitions. */
  lineMs: number
  /** A word's lift and glow ease back out over this long after it is sung. */
  releaseMs: number
}

export const MOTION: Record<LyricTransition, Motion> = {
  relaxed: { omega: 9, leadMs: 260, cascadeMs: 34, lineMs: 760, releaseMs: 460 },
  balanced: { omega: 12, leadMs: 200, cascadeMs: 24, lineMs: 600, releaseMs: 360 },
  snappy: { omega: 17, leadMs: 140, cascadeMs: 14, lineMs: 440, releaseMs: 260 }
}

export interface Spring {
  x: number
  v: number
}

/**
 * Exact step of a critically damped spring toward `target` over `dtMs` (frame-rate independent:
 * one 32 ms step equals two 16 ms steps). Velocity carries across target changes, so a line that
 * is already moving glides into the next move instead of restarting.
 */
export function springStep(s: Spring, target: number, dtMs: number, omega: number): Spring {
  if (!(dtMs > 0)) return s
  const t = Math.min(dtMs, 250) / 1000
  const x0 = s.x - target
  const decay = Math.exp(-omega * t)
  const c = s.v + omega * x0
  return { x: target + (x0 + c * t) * decay, v: (s.v - omega * c * t) * decay }
}

/** True when a spring is close enough to its target to stop animating. */
export const springSettled = (s: Spring, target: number): boolean => Math.abs(s.x - target) < 0.25 && Math.abs(s.v) < 5

/** Extra delay for a line `distance` lines from the focus (the cascade), capped so far lines don't lag. */
export const cascadeDelay = (distance: number, motion: Motion): number => Math.min(Math.abs(distance), 6) * motion.cascadeMs

// ---------- Word animation plans ----------

/** The animated parts of a word overlay (see `lyric-lines.ts`). */
export type WordPart = 'clip' | 'sung' | 'lift' | 'glow'

export interface WordKeyframe {
  offset: number
  transform?: string
  opacity?: number
  easing?: string
}

/** One compositor animation: `part` is animated from song time `start` for `duration` ms. */
export interface AnimSpec {
  part: WordPart
  start: number
  duration: number
  keyframes: WordKeyframe[]
  easing: string
}

export interface WordPlanInput {
  start: number
  end: number
  /** How far the fill window travels (px): the word plus its feather. */
  travel: number
  intensity: number
  motion: Motion
}

/** The sweep's soft leading edge (em) for words wide enough to carry it. */
export const FEATHER_EM = 0.45
const MIN_FEATHER_EM = 0.12

/**
 * Width of the sweep's soft edge for a word `wordEm` wide. The window starts with its soft edge
 * just touching the word, so the solid light reaches the first letter after
 * feather / (word + feather) of the word's time. A fixed 0.45 em edge made short words ("I", "a",
 * "to") light up only after up to 60% of their time, which reads as lagging on fast vocals; capped
 * at half the word's width, that is always within the first third.
 */
export function sweepFeather(wordEm: number): number {
  return Math.min(FEATHER_EM, Math.max(MIN_FEATHER_EM, wordEm * 0.5))
}

const EASE_OUT = 'cubic-bezier(0.22, 1, 0.36, 1)'
const EASE_SOFT = 'cubic-bezier(0.33, 0, 0.2, 1)'
/** Long held words ease in their swell instead of looking frozen. */
const HELD_MS = 1200

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
const f3 = (v: number): string => v.toFixed(3)

/** The sweep: the window slides across the word in exactly the word's time; its text counter-slides. */
function sweep(w: WordPlanInput, duration: number): AnimSpec[] {
  const t = w.travel.toFixed(1)
  return [
    { part: 'clip', start: w.start, duration, easing: 'linear', keyframes: [{ offset: 0, transform: `translateX(-${t}px)` }, { offset: 1, transform: 'translateX(0px)' }] },
    { part: 'sung', start: w.start, duration, easing: 'linear', keyframes: [{ offset: 0, transform: `translateX(${t}px)` }, { offset: 1, transform: 'translateX(0px)' }] }
  ]
}

/** Opacity of the white copy over the word's time (Fade, Minimal): the window stays open. */
function brighten(w: WordPlanInput, duration: number, easing: string): AnimSpec {
  return { part: 'sung', start: w.start, duration, easing, keyframes: [{ offset: 0, opacity: 0 }, { offset: 1, opacity: 1 }] }
}

/**
 * A rise (and optional swell) that holds while the word is sung and eases back afterwards.
 * `rise` is in em; `swell` is extra scale reached by the end of a held word.
 */
function lift(w: WordPlanInput, rise: number, swell: number, pop = 0): AnimSpec | null {
  if (rise <= 0 && swell <= 0 && pop <= 0) return null
  const sung = Math.max(1, w.end - w.start)
  const total = sung + w.motion.releaseMs
  const attack = Math.min(140, sung * 0.5) / total
  const held = clamp01(sung / HELD_MS)
  const peak = 1 + swell * held
  const at = (y: number, s: number): string => `translateY(${f3(-y)}em) scale(${f3(s)})`
  const frames: WordKeyframe[] = [{ offset: 0, transform: at(0, 1), easing: EASE_OUT }]
  if (pop > 0) frames.push({ offset: attack * 0.6, transform: at(rise, 1 + pop * 1.25), easing: EASE_SOFT })
  frames.push({ offset: attack, transform: at(rise, 1 + pop), easing: EASE_SOFT })
  frames.push({ offset: sung / total, transform: at(rise, Math.max(peak, 1 + pop)), easing: EASE_OUT })
  frames.push({ offset: 1, transform: at(0, 1) })
  return { part: 'lift', start: w.start, duration: total, easing: 'linear', keyframes: frames }
}

/** Glow that fades in as the word starts, holds (growing on held notes) and fades after it. */
function glow(w: WordPlanInput, strength: number): AnimSpec | null {
  if (strength <= 0) return null
  const sung = Math.max(1, w.end - w.start)
  const release = w.motion.releaseMs * 1.4
  const total = sung + release
  const attack = Math.min(160, sung * 0.6) / total
  const held = clamp01(sung / HELD_MS)
  const peak = Math.min(1, strength * (0.8 + 0.2 * held))
  return {
    part: 'glow',
    start: w.start,
    duration: total,
    easing: 'linear',
    keyframes: [
      { offset: 0, opacity: 0, easing: EASE_OUT },
      { offset: attack, opacity: strength * 0.85 },
      { offset: sung / total, opacity: peak, easing: EASE_SOFT },
      { offset: 1, opacity: 0 }
    ]
  }
}

/**
 * The compositor animations for one word in one effect. Intensity (0–1) scales every movement; it
 * never changes timing, so all effects stay locked to the word's timestamps.
 */
export function wordAnimations(effect: LyricEffect, w: WordPlanInput): AnimSpec[] {
  const k = clamp01(w.intensity)
  const sung = Math.max(1, w.end - w.start)
  const specs: (AnimSpec | null)[] = []
  switch (effect) {
    case 'fill':
      specs.push(...sweep(w, sung), lift(w, 0.03 * k, 0), glow(w, 0.55 * k))
      break
    case 'fade':
      specs.push(brighten(w, sung, EASE_SOFT), lift(w, 0.02 * k, 0), glow(w, 0.4 * k))
      break
    case 'glow':
      specs.push(...sweep(w, sung), lift(w, 0.02 * k, 0.03 * k), glow(w, 0.4 + 0.5 * k))
      break
    case 'scale':
      specs.push(...sweep(w, sung), lift(w, 0.015 * k, 0.02 * k, 0.07 * k), glow(w, 0.35 * k))
      break
    case 'expressive':
      specs.push(...sweep(w, sung), lift(w, 0.065 * k, 0.06 * k, 0.03 * k), glow(w, 0.3 + 0.45 * k))
      break
    case 'minimal':
      // Reduced animation: the word simply turns white as it is sung; no movement, no glow.
      specs.push(brighten(w, Math.min(90, sung), 'linear'))
      break
  }
  return specs.filter((s): s is AnimSpec => s !== null)
}

/** Whether an effect sweeps (uses the moving clip window) or keeps the window open. */
export const sweeps = (effect: LyricEffect): boolean => effect !== 'fade' && effect !== 'minimal'

/**
 * Expressive only: when a line comes up next, its words rise into place one after another.
 * Returns per-word delays (ms) and the rise distance (em).
 */
export function entrance(wordCount: number, intensity: number, motion: Motion): { delays: number[]; rise: number; duration: number } {
  const step = Math.max(10, motion.cascadeMs * 0.9)
  return {
    delays: Array.from({ length: wordCount }, (_, i) => Math.min(i, 12) * step),
    rise: 0.22 * clamp01(intensity),
    duration: motion.lineMs * 0.8
  }
}
