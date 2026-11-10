// Opt-in: absolute octave-band levels (dBFS) of Spotify-only and all desktop audio, captured at the
// same moment. Shows whether one stream is missing a frequency range. Prints levels only.
//   npx vitest run --config vitest.live.config.ts tests-live/spectrum.live.test.ts
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Fft, hann } from '../src/main/audio/fft'
import { PacketReader, parseHelperStatus } from '../src/main/audio/packets'

const helper = join(__dirname, '..', 'resources', 'lumina-helper.exe')
const N = 4096
const OCTAVES = [63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

function spectrum(source: 'spotify' | 'system', seconds: number): Promise<{ rate: number; levels: number[] }> {
  return new Promise((resolve) => {
    const child = spawn(helper, ['capture', '--source', source, '--parent', String(process.pid)], { stdio: ['pipe', 'pipe', 'inherit'] })
    const reader = new PacketReader()
    const fft = new Fft(N)
    const win = hann(N)
    const winSum = win.reduce((a, b) => a + b, 0)
    const power = new Float64Array(N / 2)
    const block = new Float64Array(N)
    let filled = 0
    let blocks = 0
    let rate = 48000
    child.stdout.on('data', (chunk: Buffer) =>
      reader.push(chunk, (p) => {
        if (p.kind === 'json') {
          const s = parseHelperStatus(p.message)
          if (s?.sampleRate) rate = s.sampleRate
          return
        }
        for (const v of p.samples) {
          block[filled++] = v
          if (filled === N) {
            const re = Float64Array.from(block, (x, i) => x * win[i]!)
            const im = new Float64Array(N)
            fft.transform(re, im)
            for (let k = 1; k < N / 2; k++) power[k] = power[k]! + ((re[k]! ** 2 + im[k]! ** 2) * 4) / (winSum * winSum)
            blocks++
            filled = 0
          }
        }
      })
    )
    setTimeout(() => {
      child.stdin.end()
      setTimeout(() => child.kill(), 1500)
      const levels = OCTAVES.map((centre) => {
        const lo = Math.max(1, Math.floor(((centre / Math.SQRT2) * N) / rate))
        const hi = Math.min(N / 2 - 1, Math.ceil(((centre * Math.SQRT2) * N) / rate))
        let e = 0
        for (let k = lo; k <= hi; k++) e += power[k]! / Math.max(1, blocks)
        return 10 * Math.log10(e / 2 + 1e-14)
      })
      resolve({ rate, levels })
    }, seconds * 1000)
  })
}

describe.skipIf(!existsSync(helper))('live: octave-band spectrum of both sources', () => {
  it('prints absolute band levels for Spotify-only and desktop audio', async () => {
    const [spotify, system] = await Promise.all([spectrum('spotify', 6), spectrum('system', 6)])
    const row = (name: string, r: { rate: number; levels: number[] }): string =>
      `${name.padEnd(8)} ${r.rate} Hz  ` + r.levels.map((l, i) => `${OCTAVES[i]! >= 1000 ? `${OCTAVES[i]! / 1000}k` : OCTAVES[i]}:${l.toFixed(0)}`).join('  ')
    console.log(row('spotify', spotify))
    console.log(row('system', system))
    expect(spotify.levels).toHaveLength(OCTAVES.length)
  }, 30_000)
})
