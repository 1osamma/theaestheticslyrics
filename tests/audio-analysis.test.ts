import { describe, expect, it } from 'vitest'
import { AudioAnalyzer, Envelope, LevelNormalizer } from '../src/main/audio/analysis'
import { Fft } from '../src/main/audio/fft'
import type { AudioAnalysisFrame } from '../src/shared/audio-frame'

const RATE = 48_000

/** Synthetic signal: `fn(t)` sampled for `seconds`. */
function signal(seconds: number, fn: (t: number) => number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) out[i] = fn(i / RATE)
  return out
}

const sine = (hz: number, amp: number) => (t: number) => amp * Math.sin(2 * Math.PI * hz * t)
/** Deterministic pseudo-random noise in [-1, 1]. */
function noise(seed = 1): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0xffffffff - 0.5
  }
}

/** Runs the analyser and returns every frame. Chunks are odd-sized to exercise hop bookkeeping. */
function analyse(analyzer: AudioAnalyzer, samples: Float32Array): AudioAnalysisFrame[] {
  const frames: AudioAnalysisFrame[] = []
  for (let i = 0; i < samples.length; i += 997) analyzer.push(samples.subarray(i, i + 997), (f) => frames.push(f))
  return frames
}

const last = (frames: AudioAnalysisFrame[]): AudioAnalysisFrame => frames.at(-1)!

describe('Fft', () => {
  it('puts a pure tone in its bin', () => {
    const fft = new Fft(1024)
    const re = new Float64Array(1024)
    const im = new Float64Array(1024)
    for (let i = 0; i < 1024; i++) re[i] = Math.sin((2 * Math.PI * 37 * i) / 1024)
    fft.transform(re, im)
    const mags = Array.from({ length: 512 }, (_, k) => Math.hypot(re[k]!, im[k]!))
    expect(mags.indexOf(Math.max(...mags))).toBe(37)
    expect(mags[37]).toBeCloseTo(512, 3)
  })

  it('rejects sizes that are not powers of two', () => {
    expect(() => new Fft(1000)).toThrow()
  })
})

describe('AudioAnalyzer bands', () => {
  it('produces about 60 frames per second of audio', () => {
    const frames = analyse(new AudioAnalyzer(RATE), signal(2, sine(440, 0.3)))
    expect(frames.length).toBeGreaterThanOrEqual(119)
    expect(frames.length).toBeLessThanOrEqual(121)
  })

  it('reads a 60 Hz tone as bass, not mids or treble', () => {
    const f = last(analyse(new AudioAnalyzer(RATE), signal(2, sine(60, 0.3))))
    expect(f.bass).toBeGreaterThan(0.8)
    expect(f.mids).toBeLessThan(0.2)
    expect(f.treble).toBeLessThan(0.05)
    expect(f.isSilent).toBe(false)
  })

  it('reads a 1 kHz tone as mids', () => {
    const f = last(analyse(new AudioAnalyzer(RATE), signal(2, sine(1000, 0.3))))
    expect(f.mids).toBeGreaterThan(0.8)
    expect(f.bass).toBeLessThan(0.2)
    expect(f.treble).toBeLessThan(0.2)
  })

  it('reads an 8 kHz tone as treble', () => {
    const f = last(analyse(new AudioAnalyzer(RATE), signal(2, sine(8000, 0.3))))
    expect(f.treble).toBeGreaterThan(0.8)
    expect(f.bass).toBeLessThan(0.05)
  })

  it('works at 44.1 kHz too', () => {
    const analyzer = new AudioAnalyzer(44_100)
    const samples = new Float32Array(44_100 * 2)
    for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 80 * i) / 44_100)
    expect(last(analyse(analyzer, samples)).bass).toBeGreaterThan(0.8)
  })
})

describe('AudioAnalyzer silence and bounds', () => {
  it('reports silence for digital silence and keeps every level at zero', () => {
    const frames = analyse(new AudioAnalyzer(RATE), new Float32Array(RATE))
    const f = last(frames)
    expect(f.isSilent).toBe(true)
    for (const k of ['rms', 'bass', 'mids', 'treble', 'transient', 'beatPulse', 'intensity'] as const) expect(f[k]).toBe(0)
  })

  it('treats a very quiet noise floor as silence', () => {
    const rnd = noise(7)
    const f = last(analyse(new AudioAnalyzer(RATE), signal(1, () => rnd() * 0.0005)))
    expect(f.isSilent).toBe(true)
    expect(f.intensity).toBeLessThan(0.05)
  })

  it('goes silent shortly after the music stops, and back when it returns', () => {
    const analyzer = new AudioAnalyzer(RATE)
    const playing = analyse(analyzer, signal(1, sine(100, 0.3)))
    expect(last(playing).isSilent).toBe(false)
    const stopped = analyse(analyzer, new Float32Array(Math.round(RATE * 0.5)))
    const silentAt = stopped.findIndex((f) => f.isSilent)
    expect(silentAt).toBeGreaterThan(0)
    expect(silentAt * (1000 / 60)).toBeLessThan(400) // 250 ms hold + window length
    expect(last(analyse(analyzer, signal(0.5, sine(100, 0.3)))).isSilent).toBe(false)
  })

  it('keeps every value in 0–1 even for clipping, NaN or infinite input', () => {
    const rnd = noise(3)
    const wild = signal(1, (t) => (t < 0.3 ? 5 * rnd() : t < 0.5 ? Number.NaN : t < 0.6 ? Number.POSITIVE_INFINITY : rnd()))
    for (const f of analyse(new AudioAnalyzer(RATE), wild)) {
      for (const k of ['rms', 'bass', 'mids', 'treble', 'transient', 'beatPulse', 'intensity'] as const) {
        expect(f[k]).toBeGreaterThanOrEqual(0)
        expect(f[k]).toBeLessThanOrEqual(1)
        expect(Number.isFinite(f[k])).toBe(true)
      }
    }
  })
})

describe('AudioAnalyzer normalisation', () => {
  it('adapts to the song’s loudness: a quiet but steady track still reads strongly', () => {
    const quiet = last(analyse(new AudioAnalyzer(RATE), signal(3, sine(80, 0.01)))) // -40 dBFS
    expect(quiet.bass).toBeGreaterThan(0.6)
  })

  it('never overshoots on a sudden jump in volume', () => {
    const analyzer = new AudioAnalyzer(RATE)
    analyse(analyzer, signal(2, sine(80, 0.02)))
    const jump = analyse(analyzer, signal(1, sine(80, 0.6)))
    for (const f of jump) expect(f.bass).toBeLessThanOrEqual(1)
    expect(last(jump).bass).toBeGreaterThan(0.8)
  })

  it('reads a sudden quiet passage darker, then slowly adapts', () => {
    const analyzer = new AudioAnalyzer(RATE)
    analyse(analyzer, signal(2, sine(80, 0.5)))
    const drop = analyse(analyzer, signal(8, sine(80, 0.05))) // 20 dB quieter
    const early = drop[30]! // half a second in
    expect(early.bass).toBeLessThan(0.55)
    expect(last(drop).bass).toBeGreaterThan(early.bass + 0.2)
  })
})

describe('AudioAnalyzer transients and beats', () => {
  /** A kick (decaying 55 Hz burst) every `period` seconds over quiet pad noise. */
  function kicks(seconds: number, period: number): Float32Array {
    const rnd = noise(11)
    return signal(seconds, (t) => {
      const since = t % period
      const kick = since < 0.12 ? Math.sin(2 * Math.PI * 55 * since) * Math.exp(-since * 30) * 0.8 : 0
      return kick + rnd() * 0.01 + 0.02 * Math.sin(2 * Math.PI * 600 * t)
    })
  }

  it('fires one beat-like pulse per kick and lets it decay in between', () => {
    const frames = analyse(new AudioAnalyzer(RATE), kicks(6, 0.5))
    // Count rising edges of beatPulse after a one-second warm-up.
    let beats = 0
    for (let i = 61; i < frames.length; i++) if (frames[i]!.beatPulse > frames[i - 1]!.beatPulse + 0.2) beats++
    expect(beats).toBeGreaterThanOrEqual(8)
    expect(beats).toBeLessThanOrEqual(11)
    const between = frames.filter((_, i) => i > 60 && (i % 30 === 24)) // just before each next kick
    for (const f of between) expect(f.beatPulse).toBeLessThan(0.35)
  })

  it('reports transients at onsets and little during a steady tone', () => {
    const steady = analyse(new AudioAnalyzer(RATE), signal(3, sine(300, 0.3)))
    expect(Math.max(...steady.slice(60).map((f) => f.transient))).toBeLessThan(0.2)
    const onsets = analyse(new AudioAnalyzer(RATE), kicks(3, 0.5))
    expect(Math.max(...onsets.slice(60).map((f) => f.transient))).toBeGreaterThan(0.5)
  })

  it('never fires beats during silence', () => {
    const frames = analyse(new AudioAnalyzer(RATE), new Float32Array(RATE * 2))
    expect(Math.max(...frames.map((f) => f.beatPulse))).toBe(0)
  })
})

describe('Envelope', () => {
  it('rises faster than it falls', () => {
    const e = new Envelope(20, 200)
    e.step(1, 20)
    const up = e.value
    const down = new Envelope(20, 200)
    down.value = 1
    down.step(0, 20)
    expect(up).toBeGreaterThan(1 - down.value)
  })

  it('is independent of the step rate', () => {
    const coarse = new Envelope(30, 300)
    coarse.step(1, 100)
    const fine = new Envelope(30, 300)
    for (let i = 0; i < 10; i++) fine.step(1, 10)
    expect(fine.value).toBeCloseTo(coarse.value, 6)
  })
})

describe('LevelNormalizer', () => {
  it('maps the recent peak to 1 and the noise floor to 0', () => {
    const n = new LevelNormalizer(-70, 30)
    expect(n.normalize(-10, 16)).toBe(1)
    expect(n.normalize(-40, 16)).toBeCloseTo(0, 1)
    expect(n.normalize(-80, 16)).toBe(0)
  })
})
