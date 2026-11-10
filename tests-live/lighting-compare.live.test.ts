// Opt-in: captures Spotify-only and all desktop audio at the same moment, analyses both, and runs the
// Spotify frames through the hybrid lighting engine. Prints levels only: nothing is recorded or saved.
//   npx vitest run --config vitest.live.config.ts tests-live/lighting-compare.live.test.ts
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AudioAnalyzer } from '../src/main/audio/analysis'
import { PacketReader, parseHelperStatus } from '../src/main/audio/packets'
import type { AudioAnalysisFrame } from '../src/shared/audio-frame'
import type { LightingConfig } from '../src/shared/lighting'
import { LightingEngine } from '../src/shared/lighting-engine'

const helper = join(__dirname, '..', 'resources', 'lumina-helper.exe')
const SECONDS = Number(process.env.LUMINA_AUDIO_SECONDS ?? 8)

/** Starts a capture; resolves with its frames (wall-clock stamped) after SECONDS. */
function capture(source: 'spotify' | 'system'): Promise<{ frames: (AudioAnalysisFrame & { at: number })[]; mode: string }> {
  return new Promise((resolve) => {
    const child = spawn(helper, ['capture', '--source', source, '--parent', String(process.pid)], { stdio: ['pipe', 'pipe', 'inherit'] })
    const reader = new PacketReader()
    const frames: (AudioAnalysisFrame & { at: number })[] = []
    let analyzer: AudioAnalyzer | null = null
    let mode = ''
    child.stdout.on('data', (chunk: Buffer) =>
      reader.push(chunk, (p) => {
        if (p.kind === 'json') {
          const s = parseHelperStatus(p.message)
          if (s?.sampleRate) analyzer = new AudioAnalyzer(s.sampleRate)
          if (s) mode = `${s.state}/${s.mode}`
        } else {
          analyzer?.push(p.samples, (f) => frames.push({ ...f, at: performance.now() }))
        }
      })
    )
    setTimeout(() => {
      child.stdin.end()
      setTimeout(() => child.kill(), 1500)
      resolve({ frames, mode })
    }, SECONDS * 1000)
  })
}

const avg = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
const pct = (xs: number[], q: number): number => [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))] ?? 0
const f2 = (v: number): string => v.toFixed(2)

function bands(frames: AudioAnalysisFrame[]): string {
  const beats = frames.filter((f, i) => i > 0 && f.beatPulse > frames[i - 1]!.beatPulse + 0.2).length
  return `bass ${f2(avg(frames.map((f) => f.bass)))} · mids ${f2(avg(frames.map((f) => f.mids)))} · treble ${f2(avg(frames.map((f) => f.treble)))} · intensity ${f2(avg(frames.map((f) => f.intensity)))} · ${beats} beats · ${frames.filter((f) => f.isSilent).length} silent of ${frames.length}`
}

const DEFAULTS: LightingConfig = {
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
  gpu: true
}

describe.skipIf(!existsSync(helper))('live: Spotify-only vs desktop audio, and lighting response', () => {
  it('compares both sources on the same moment and drives the hybrid engine', async () => {
    const [spotify, system] = await Promise.all([capture('spotify'), capture('system')])
    console.log(`spotify (${spotify.mode}): ${bands(spotify.frames)}`)
    console.log(`system  (${system.mode}): ${bands(system.frames)}`)

    // Hybrid engine at the default settings, sampled at 120 Hz over the Spotify frames.
    const engine = new LightingEngine(DEFAULTS)
    engine.setPalette(['#6f8bff', '#ff8fb1', '#6fd6d0', '#b98cff'], 0, true)
    const frames = spotify.frames
    const t0 = frames[0]?.at ?? 0
    const atmos: number[] = []
    const bloom: number[] = []
    let i = 0
    for (let t = t0; t <= (frames.at(-1)?.at ?? t0); t += 1000 / 120) {
      while (i < frames.length && frames[i]!.at <= t) engine.pushAudio(frames[i++]!, t)
      const out = engine.sample(t)
      atmos.push(out.atmosphere)
      bloom.push(out.bloom)
    }
    console.log(
      `lighting (hybrid, defaults): atmosphere ${f2(pct(atmos, 0.05))}–${f2(pct(atmos, 0.95))} (mean ${f2(avg(atmos))}) · bloom ${f2(pct(bloom, 0.05))}–${f2(pct(bloom, 0.95))} (mean ${f2(avg(bloom))})`
    )
    expect(spotify.frames.length).toBeGreaterThan(SECONDS * 50)
    expect(system.frames.length).toBeGreaterThan(SECONDS * 50)
  }, 30_000)
})
