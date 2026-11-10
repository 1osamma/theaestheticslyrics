import { describe, expect, it } from 'vitest'
import { SILENT_FRAME, sanitizeAudioFrame, type AudioAnalysisFrame } from '../src/shared/audio-frame'
import type { LightingConfig } from '../src/shared/lighting'
import { AUDIO_STALE_MS, LightingEngine, PALETTE_FADE_MS, applySensitivity, fourColors, hexToRgb } from '../src/shared/lighting-engine'

const config = (over: Partial<LightingConfig> = {}): LightingConfig => ({
  mode: 'hybrid',
  brightness: 0.45,
  sensitivity: 0.6,
  bassStrength: 0.55,
  smoothing: 0.7,
  glowRadius: 0.5,
  edgeThickness: 0.35,
  edgeSpread: 0.6,
  edgeSoftness: 0.7,
  edges: { left: true, right: true, top: false, bottom: true },
  playerEdgeGlow: false,
  fps: 60,
  reducedMotion: false,
  gpu: true,
  ...over
})

const frame = (over: Partial<AudioAnalysisFrame>): AudioAnalysisFrame => ({ ...SILENT_FRAME, isSilent: false, timestamp: 1, ...over })

/** Feeds the same audio for `ms` at 60 Hz and samples at 120 Hz; returns the last light frame (copied). */
function run(engine: LightingEngine, start: number, ms: number, audio: AudioAnalysisFrame | null) {
  let last = engine.sample(start)
  for (let t = start; t <= start + ms; t += 1000 / 120) {
    if (audio && Math.round(t) % 16 < 9) engine.pushAudio(audio, t)
    last = engine.sample(t)
  }
  return { ...last, colors: last.colors.map((c) => [...c]) }
}

describe('palette', () => {
  it('parses colours and always yields four', () => {
    expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0])
    expect(fourColors(['#ff0000', '#00ff00'])).toHaveLength(4)
    expect(fourColors([])).toHaveLength(4)
  })

  it('applies the first palette at once and crossfades later ones smoothly', () => {
    const e = new LightingEngine(config({ mode: 'static' }))
    e.setPalette(['#ff0000'], 0)
    expect(e.sample(0).colors[0]).toEqual([1, 0, 0])
    e.setPalette(['#0000ff'], 1000)
    const mid = e.sample(1000 + PALETTE_FADE_MS / 2).colors[0]!
    expect(mid[0]).toBeGreaterThan(0.2)
    expect(mid[2]).toBeGreaterThan(0.2)
    expect(e.sample(1000 + PALETTE_FADE_MS + 1).colors[0]).toEqual([0, 0, 1])
  })

  it('never jumps when the track changes again mid-fade', () => {
    const e = new LightingEngine(config({ mode: 'static' }))
    e.setPalette(['#ff0000'], 0)
    e.setPalette(['#0000ff'], 0)
    const before = [...e.sample(400).colors[0]!]
    e.setPalette(['#00ff00'], 400)
    const after = e.sample(400).colors[0]!
    for (let i = 0; i < 3; i++) expect(Math.abs(after[i]! - before[i]!)).toBeLessThan(0.02)
  })

  it('does not change colour with every audio frame', () => {
    const e = new LightingEngine(config())
    e.setPalette(['#336699', '#993366'], 0)
    const quiet = run(e, 0, 500, frame({ bass: 0.1 }))
    const loud = run(e, 600, 500, frame({ bass: 1, beatPulse: 1, intensity: 1 }))
    expect(loud.colors).toEqual(quiet.colors)
  })
})

describe('hybrid response', () => {
  it('reacts to real audio: loud music is brighter and blooms more than silence', () => {
    const silent = run(new LightingEngine(config()), 0, 3000, null)
    const loud = run(new LightingEngine(config()), 0, 3000, frame({ bass: 0.9, mids: 0.7, treble: 0.5, intensity: 0.9, beatPulse: 0.8 }))
    expect(loud.atmosphere).toBeGreaterThan(silent.atmosphere + 0.1)
    expect(loud.bloom).toBeGreaterThan(silent.bloom + 0.1)
    expect(loud.shimmer).toBeGreaterThan(0)
  })

  it('keeps quiet passages darker but never black', () => {
    const quiet = run(new LightingEngine(config()), 0, 3000, frame({ intensity: 0.05, bass: 0.05 }))
    expect(quiet.atmosphere).toBeGreaterThan(0.1)
    expect(quiet.atmosphere).toBeLessThan(0.45 * 0.5)
  })

  it('pulses smoothly on a beat instead of flashing', () => {
    const e = new LightingEngine(config())
    run(e, 0, 2000, frame({ intensity: 0.6, bass: 0.4 }))
    const before = e.sample(2000).bloom
    e.pushAudio(frame({ intensity: 0.6, bass: 0.9, beatPulse: 1 }), 2001)
    const first = e.sample(2008).bloom // one 120 Hz frame later
    const later = run(e, 2016, 150, frame({ intensity: 0.6, bass: 0.9, beatPulse: 1 })).bloom
    expect(first - before).toBeLessThan(0.15) // no single-frame jump
    expect(later).toBeGreaterThan(before + 0.1)
  })

  it('settles as if silent when audio goes stale (paused, capture stopped)', () => {
    const e = new LightingEngine(config())
    const playing = run(e, 0, 2000, frame({ intensity: 1, bass: 1, beatPulse: 1 }))
    const stale = run(e, 2000 + AUDIO_STALE_MS, 4000, null)
    expect(stale.bloom).toBeLessThan(playing.bloom * 0.3)
    expect(stale.atmosphere).toBeLessThan(playing.atmosphere)
  })

  it('responds more with higher sensitivity and more slowly with more smoothing', () => {
    expect(applySensitivity(0.6, 1)).toBeGreaterThan(applySensitivity(0.6, 0.2))
    const audio = frame({ intensity: 1, bass: 1, beatPulse: 1 })
    const fast = run(new LightingEngine(config({ smoothing: 0 })), 0, 120, audio)
    const slow = run(new LightingEngine(config({ smoothing: 1 })), 0, 120, audio)
    expect(fast.bloom).toBeGreaterThan(slow.bloom)
  })

  it('keeps every output in 0–1 whatever the input', () => {
    const e = new LightingEngine(config({ brightness: 1, bassStrength: 1, sensitivity: 1 }))
    const wild = sanitizeAudioFrame({ timestamp: 1, rms: 9, bass: Number.NaN, mids: -3, treble: Infinity, transient: 5, beatPulse: 2, intensity: 7 })!
    const out = run(e, 0, 1000, wild)
    for (const v of [out.atmosphere, out.bloom, out.bloomRadius, out.shimmer, out.edge]) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('modes', () => {
  const loud = frame({ bass: 1, mids: 1, treble: 1, intensity: 1, beatPulse: 1, transient: 1 })

  it('turns off completely', () => {
    const out = run(new LightingEngine(config({ mode: 'off' })), 0, 500, loud)
    expect(out.active).toBe(false)
    expect(out.atmosphere + out.bloom + out.edge).toBe(0)
  })

  it('static ignores audio and does not move', () => {
    const out = run(new LightingEngine(config({ mode: 'static' })), 0, 2000, loud)
    expect(out.atmosphere).toBeCloseTo(0.45)
    expect(out.bloom).toBe(0)
    expect(out.phase).toBe(0)
  })

  it('ambient drifts without audio', () => {
    const out = run(new LightingEngine(config({ mode: 'ambient' })), 0, 3000, null)
    expect(out.phase).toBeGreaterThan(0)
    expect(out.shimmer).toBe(0)
  })

  it('bass reactive blooms with the bass only', () => {
    const quiet = run(new LightingEngine(config({ mode: 'bass' })), 0, 2000, frame({ mids: 1, treble: 1 }))
    const bassy = run(new LightingEngine(config({ mode: 'bass' })), 0, 2000, frame({ bass: 1, beatPulse: 1 }))
    expect(bassy.bloom).toBeGreaterThan(quiet.bloom + 0.2)
    expect(bassy.shimmer).toBe(0)
  })

  it('reduced motion stops drift and shimmer and caps the bloom', () => {
    const out = run(new LightingEngine(config({ reducedMotion: true })), 0, 3000, loud)
    expect(out.phase).toBeLessThan(0.01)
    expect(out.shimmer).toBe(0)
    expect(out.bloom).toBeLessThanOrEqual(0.35 * (0.35 + 0.45) + 1e-9)
  })
})

describe('sanitizeAudioFrame', () => {
  it('rejects malformed frames and clamps levels', () => {
    expect(sanitizeAudioFrame(null)).toBeNull()
    expect(sanitizeAudioFrame({ bass: 1 })).toBeNull()
    expect(sanitizeAudioFrame({ timestamp: Number.NaN })).toBeNull()
    const f = sanitizeAudioFrame({ timestamp: 5, bass: 3, mids: -1, isSilent: 'yes' })!
    expect(f.bass).toBe(1)
    expect(f.mids).toBe(0)
    expect(f.isSilent).toBe(false)
  })
})
