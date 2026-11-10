// Opt-in check of real audio capture on this PC: `npm run check:audio` (play something in Spotify first).
// Runs resources/lumina-helper.exe exactly as the app does, through the same packet reader and
// analyser, and prints levels only. Nothing is recorded or saved.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AudioAnalyzer } from '../src/main/audio/analysis'
import { PacketReader, parseHelperStatus, type HelperStatus } from '../src/main/audio/packets'
import type { AudioAnalysisFrame } from '../src/shared/audio-frame'

const helper = join(__dirname, '..', 'resources', 'lumina-helper.exe')
const SECONDS = Number(process.env.LUMINA_AUDIO_SECONDS ?? 6)

async function capture(source: 'auto' | 'spotify' | 'system'): Promise<{ statuses: HelperStatus[]; frames: AudioAnalysisFrame[]; samples: number }> {
  const child = spawn(helper, ['capture', '--source', source, '--parent', String(process.pid)], { stdio: ['pipe', 'pipe', 'inherit'] })
  const reader = new PacketReader()
  const statuses: HelperStatus[] = []
  const frames: AudioAnalysisFrame[] = []
  let analyzer: AudioAnalyzer | null = null
  let samples = 0
  child.stdout.on('data', (chunk: Buffer) =>
    reader.push(chunk, (p) => {
      if (p.kind === 'json') {
        const s = parseHelperStatus(p.message)
        if (s) {
          statuses.push(s)
          if (s.sampleRate) analyzer = new AudioAnalyzer(s.sampleRate)
        }
      } else {
        samples += p.samples.length
        analyzer?.push(p.samples, (f) => frames.push(f))
      }
    })
  )
  await new Promise((r) => setTimeout(r, SECONDS * 1000))
  const exited = new Promise<number | null>((r) => child.once('exit', r))
  child.stdin.end()
  const code = await Promise.race([exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 3000))])
  if (code === 'timeout') child.kill()
  expect(code).toBe(0)
  return { statuses, frames, samples }
}

function summary(frames: AudioAnalysisFrame[]): string {
  const avg = (k: keyof AudioAnalysisFrame): string =>
    (frames.reduce((a, f) => a + (f[k] as number), 0) / Math.max(1, frames.length)).toFixed(3)
  const max = (k: keyof AudioAnalysisFrame): string => Math.max(0, ...frames.map((f) => f[k] as number)).toFixed(3)
  const beats = frames.filter((f, i) => i > 0 && f.beatPulse > frames[i - 1]!.beatPulse + 0.2).length
  const silent = frames.filter((f) => f.isSilent).length
  return `${frames.length} frames · bass avg ${avg('bass')} max ${max('bass')} · mids avg ${avg('mids')} · treble avg ${avg('treble')} · intensity avg ${avg('intensity')} · ${beats} beat pulses · ${silent} silent frames`
}

describe.skipIf(!existsSync(helper))('live audio capture', () => {
  it('captures through the experimental Spotify-only source (reports levels; may be silent)', async () => {
    const { statuses, frames, samples } = await capture('spotify')
    console.log(`spotify: ${statuses.map((x) => `${x.state}/${x.mode} "${x.message}"`).join(' → ')}`)
    console.log(`spotify: ${samples} samples · ${summary(frames)}`)
    expect(statuses.length).toBeGreaterThan(0)
  }, 20_000)

  it('captures all desktop audio (the default source)', async () => {
    const { statuses, frames } = await capture('system')
    console.log(`system: ${statuses.map((x) => `${x.state}/${x.mode}`).join(' → ')} · ${summary(frames)}`)
    expect(statuses.some((x) => x.state === 'capturing' && x.mode === 'system')).toBe(true)
    expect(frames.length).toBeGreaterThan(SECONDS * 50)
  }, 20_000)
})
