import { describe, expect, it } from 'vitest'
import { MOTION, cascadeDelay, entrance, springSettled, springStep, sweeps, wordAnimations, type AnimSpec, type Spring } from '../src/renderer/src/player/lyric-timeline'
import { LYRIC_EFFECTS } from '../src/shared/lyrics-style'

const word = { start: 10_000, end: 10_480, travel: 220, intensity: 0.6, motion: MOTION.balanced }

describe('springStep', () => {
  it('settles on the target without overshooting (critically damped)', () => {
    let s: Spring = { x: 0, v: 0 }
    let max = 0
    for (let i = 0; i < 300; i++) {
      s = springStep(s, 100, 1000 / 240, MOTION.balanced.omega)
      max = Math.max(max, s.x)
    }
    expect(max).toBeLessThanOrEqual(100 + 1e-9)
    expect(springSettled(s, 100)).toBe(true)
  })

  it('is independent of the frame rate', () => {
    let a: Spring = { x: 0, v: 0 }
    let b: Spring = { x: 0, v: 0 }
    a = springStep(a, 50, 32, 12)
    for (let i = 0; i < 8; i++) b = springStep(b, 50, 4, 12)
    expect(b.x).toBeCloseTo(a.x, 6)
    expect(b.v).toBeCloseTo(a.v, 6)
  })

  it('carries velocity into a new target instead of restarting', () => {
    let s: Spring = { x: 0, v: 0 }
    for (let i = 0; i < 10; i++) s = springStep(s, 100, 16, 12)
    expect(s.v).toBeGreaterThan(0)
    const next = springStep(s, 200, 16, 12)
    expect(next.x).toBeGreaterThan(s.x)
  })

  it('settles faster for snappier transitions', () => {
    const settleTime = (omega: number): number => {
      let s: Spring = { x: 0, v: 0 }
      for (let t = 0; t < 3000; t += 4) {
        s = springStep(s, 100, 4, omega)
        if (springSettled(s, 100)) return t
      }
      return Number.POSITIVE_INFINITY
    }
    expect(settleTime(MOTION.snappy.omega)).toBeLessThan(settleTime(MOTION.balanced.omega))
    expect(settleTime(MOTION.balanced.omega)).toBeLessThan(settleTime(MOTION.relaxed.omega))
    expect(settleTime(MOTION.relaxed.omega)).toBeLessThan(1200)
  })
})

describe('motion presets', () => {
  it('cascade later lines a little, capped', () => {
    expect(cascadeDelay(0, MOTION.balanced)).toBe(0)
    expect(cascadeDelay(-2, MOTION.balanced)).toBe(cascadeDelay(2, MOTION.balanced))
    expect(cascadeDelay(40, MOTION.balanced)).toBe(cascadeDelay(6, MOTION.balanced))
  })

  it('lead lines in before their first word, more for relaxed motion', () => {
    expect(MOTION.relaxed.leadMs).toBeGreaterThan(MOTION.balanced.leadMs)
    expect(MOTION.balanced.leadMs).toBeGreaterThan(MOTION.snappy.leadMs)
  })
})

const byPart = (specs: AnimSpec[], part: AnimSpec['part']): AnimSpec | undefined => specs.find((s) => s.part === part)

describe('wordAnimations', () => {
  it('locks every effect to the word timestamps', () => {
    for (const effect of LYRIC_EFFECTS) {
      for (const spec of wordAnimations(effect, word)) {
        expect(spec.start).toBe(word.start)
        expect(spec.duration).toBeGreaterThan(0)
      }
    }
  })

  it('sweeps the fill window across the word in exactly the word duration', () => {
    const specs = wordAnimations('fill', word)
    const clip = byPart(specs, 'clip')!
    const sung = byPart(specs, 'sung')!
    expect(clip.duration).toBe(480)
    expect(clip.easing).toBe('linear')
    expect(clip.keyframes[0]!.transform).toBe('translateX(-220.0px)')
    expect(clip.keyframes.at(-1)!.transform).toBe('translateX(0px)')
    expect(sung.keyframes[0]!.transform).toBe('translateX(220.0px)')
  })

  it('fades instead of sweeping for Fade and Minimal', () => {
    for (const effect of ['fade', 'minimal'] as const) {
      expect(sweeps(effect)).toBe(false)
      const specs = wordAnimations(effect, word)
      expect(byPart(specs, 'clip')).toBeUndefined()
      expect(byPart(specs, 'sung')!.keyframes.map((k) => k.opacity)).toEqual([0, 1])
    }
  })

  it('keeps Minimal free of movement and glow (the reduced-animation option)', () => {
    const specs = wordAnimations('minimal', word)
    expect(specs.map((s) => s.part)).toEqual(['sung'])
    expect(specs[0]!.duration).toBeLessThanOrEqual(90)
  })

  it('eases a word back out after it is sung, never cutting it off', () => {
    const lift = byPart(wordAnimations('expressive', word), 'lift')!
    expect(lift.duration).toBe(480 + MOTION.balanced.releaseMs)
    expect(lift.keyframes.at(-1)!.transform).toBe('translateY(0.000em) scale(1.000)')
  })

  it('scales movement and glow with intensity, and removes them at zero', () => {
    const calm = wordAnimations('expressive', { ...word, intensity: 0.2 })
    const bold = wordAnimations('expressive', { ...word, intensity: 1 })
    const peakGlow = (s: AnimSpec[]): number => Math.max(...byPart(s, 'glow')!.keyframes.map((k) => k.opacity ?? 0))
    expect(peakGlow(bold)).toBeGreaterThan(peakGlow(calm))
    const none = wordAnimations('fill', { ...word, intensity: 0 })
    expect(byPart(none, 'lift')).toBeUndefined()
    expect(byPart(none, 'glow')).toBeUndefined()
    expect(byPart(none, 'clip')).toBeDefined()
  })

  it('keeps glow restrained for readability', () => {
    for (const effect of LYRIC_EFFECTS) {
      const g = byPart(wordAnimations(effect, { ...word, intensity: 1, end: word.start + 3000 }), 'glow')
      if (g) for (const k of g.keyframes) expect(k.opacity ?? 0).toBeLessThanOrEqual(1)
    }
  })

  it('produces valid keyframe offsets (0 → 1, never decreasing) even for very short words', () => {
    for (const effect of LYRIC_EFFECTS) {
      for (const end of [word.start + 1, word.start + 40, word.start + 5000]) {
        for (const spec of wordAnimations(effect, { ...word, end })) {
          const offsets = spec.keyframes.map((k) => k.offset)
          expect(offsets[0]).toBe(0)
          expect(offsets.at(-1)).toBe(1)
          for (let i = 1; i < offsets.length; i++) expect(offsets[i]!).toBeGreaterThanOrEqual(offsets[i - 1]!)
        }
      }
    }
  })
})

describe('entrance', () => {
  it('staggers words of the next line and scales the rise with intensity', () => {
    const e = entrance(5, 0.5, MOTION.balanced)
    expect(e.delays).toHaveLength(5)
    expect(e.delays[0]).toBe(0)
    expect(e.delays[4]!).toBeGreaterThan(e.delays[1]!)
    expect(entrance(5, 1, MOTION.balanced).rise).toBeGreaterThan(e.rise)
  })
})
