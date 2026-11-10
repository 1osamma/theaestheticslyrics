import type { AudioAnalysisFrame } from '@shared/audio-frame'
import { Fft, hann } from './fft'

export interface AnalyzerOptions {
  /** FFT window in samples (power of two). ~43 ms at 48 kHz. */
  fftSize?: number
  /** Analysis frames per second. */
  frameRate?: number
  /** Band levels below this (dBFS) count as nothing. */
  noiseFloorDb?: number
  /** RMS below this (dBFS) for `silenceHoldMs` is silence. */
  silenceDb?: number
  /** Loudness range mapped onto 0–1 below the recent peak. */
  dynamicRangeDb?: number
}

/** Perceptually useful bands (Hz), chosen against real mixes: kick/bass, vocals/instruments, air. */
export const BANDS = {
  bass: [30, 150],
  mids: [250, 2000],
  treble: [4000, 12000]
} as const

const SILENCE_HOLD_MS = 250
/** Recent peaks fall this fast (dB per second), so quiet passages read darker before the scale adapts. */
const PEAK_DECAY_DB_PER_S = 3
/** Beat-like onsets closer than this are one onset (≈ 250 BPM ceiling). */
const MIN_BEAT_GAP_MS = 240
const BEAT_DECAY_MS = 170
const FLUX_EMA_MS = 1500
const BASS_FLUX_EMA_MS = 1000
/** Compression for log-magnitude spectral flux. */
const FLUX_GAMMA = 100

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
const toDb = (amplitude: number): number => (amplitude > 0 ? 20 * Math.log10(amplitude) : Number.NEGATIVE_INFINITY)
/** Weight of the new sample in an exponential moving average after `dtMs`. */
const emaAlpha = (dtMs: number, tauMs: number): number => 1 - Math.exp(-dtMs / tauMs)

/** Attack/release smoothing: rises over `attackMs`, falls over `releaseMs`, independent of frame rate. */
export class Envelope {
  value = 0
  constructor(
    private readonly attackMs: number,
    private readonly releaseMs: number
  ) {}

  step(target: number, dtMs: number): number {
    const tau = target > this.value ? this.attackMs : this.releaseMs
    this.value += (target - this.value) * emaAlpha(dtMs, tau)
    return this.value
  }
}

/**
 * Adaptive loudness normaliser in dB: the recent peak maps to 1 and `rangeDb` below it to 0. A
 * louder passage raises the peak at once (no overshoot past 1); a quieter one reads darker while the
 * peak falls slowly, so sudden volume changes never flash and the scale still follows the song.
 */
export class LevelNormalizer {
  private peakDb = Number.NEGATIVE_INFINITY
  constructor(
    private readonly floorDb: number,
    private readonly rangeDb: number
  ) {}

  normalize(levelDb: number, dtMs: number): number {
    const decayed = this.peakDb - (PEAK_DECAY_DB_PER_S * dtMs) / 1000
    // The scale never stretches noise to full brightness: the peak stays at least `rangeDb` above the floor.
    this.peakDb = Math.max(levelDb, decayed, this.floorDb + this.rangeDb)
    if (!(levelDb > this.floorDb)) return 0
    return clamp01((levelDb - (this.peakDb - this.rangeDb)) / this.rangeDb)
  }
}

/** Running mean and deviation (exponential), for adaptive onset thresholds. */
class RunningStats {
  mean = 0
  variance = 0
  private primed = false
  constructor(private readonly tauMs: number) {}

  push(v: number, dtMs: number): void {
    if (!this.primed) {
      this.mean = v
      this.primed = true
      return
    }
    const a = emaAlpha(dtMs, this.tauMs)
    const diff = v - this.mean
    this.mean += a * diff
    this.variance = (1 - a) * (this.variance + a * diff * diff)
  }

  get std(): number {
    return Math.sqrt(this.variance)
  }
}

/**
 * Real-time music analysis: mono PCM in, compact `AudioAnalysisFrame`s out at `frameRate`.
 * Hann-windowed FFT → band levels (dB) → adaptive normalisation → attack/release smoothing, plus
 * spectral-flux transients and a beat-like pulse from bass onsets. Allocation-free per frame.
 */
export class AudioAnalyzer {
  readonly sampleRate: number
  readonly fftSize: number
  readonly hop: number
  private readonly fft: Fft
  private readonly window: Float64Array
  private readonly windowSum: number
  private readonly ring: Float32Array
  private ringPos = 0
  private sinceHop = 0
  private samplesSeen = 0
  private readonly re: Float64Array
  private readonly im: Float64Array
  private readonly compressed: Float64Array
  private readonly bins: Record<keyof typeof BANDS, [number, number]>
  private readonly fluxTop: number
  private readonly noiseFloorDb: number
  private readonly silenceDb: number
  private readonly norm: Record<'rms' | keyof typeof BANDS, LevelNormalizer>
  private readonly env = {
    bass: new Envelope(18, 150),
    mids: new Envelope(30, 220),
    treble: new Envelope(15, 120),
    rms: new Envelope(25, 200),
    intensity: new Envelope(60, 380),
    transient: new Envelope(5, 110)
  }
  private readonly flux = new RunningStats(FLUX_EMA_MS)
  private readonly bassFlux = new RunningStats(BASS_FLUX_EMA_MS)
  private quietMs = Number.POSITIVE_INFINITY
  private lastBeatMs = Number.NEGATIVE_INFINITY
  private beat = 0
  private primed = false

  constructor(sampleRate: number, opts: AnalyzerOptions = {}) {
    if (!(sampleRate >= 8000 && sampleRate <= 384000)) throw new Error(`unsupported sample rate ${sampleRate}`)
    this.sampleRate = sampleRate
    this.fftSize = opts.fftSize ?? 2048
    this.hop = Math.max(1, Math.round(sampleRate / (opts.frameRate ?? 60)))
    this.fft = new Fft(this.fftSize)
    this.window = hann(this.fftSize)
    this.windowSum = this.window.reduce((a, b) => a + b, 0)
    this.ring = new Float32Array(this.fftSize)
    this.re = new Float64Array(this.fftSize)
    this.im = new Float64Array(this.fftSize)
    const half = this.fftSize / 2
    this.compressed = new Float64Array(half)
    const bin = (hz: number): number => Math.min(half - 1, Math.max(1, Math.round((hz * this.fftSize) / sampleRate)))
    this.bins = {
      bass: [bin(BANDS.bass[0]), bin(BANDS.bass[1])],
      mids: [bin(BANDS.mids[0]), bin(BANDS.mids[1])],
      treble: [bin(BANDS.treble[0]), bin(BANDS.treble[1])]
    }
    this.fluxTop = bin(10_000)
    this.noiseFloorDb = opts.noiseFloorDb ?? -72
    this.silenceDb = opts.silenceDb ?? -60
    const range = opts.dynamicRangeDb ?? 30
    this.norm = {
      rms: new LevelNormalizer(this.silenceDb, range),
      bass: new LevelNormalizer(this.noiseFloorDb, range),
      mids: new LevelNormalizer(this.noiseFloorDb, range),
      treble: new LevelNormalizer(this.noiseFloorDb, range)
    }
  }

  /** Milliseconds of audio between frames. */
  get frameMs(): number {
    return (this.hop / this.sampleRate) * 1000
  }

  /** Feeds samples; calls `onFrame` for every completed analysis step. */
  push(samples: Float32Array, onFrame: (frame: AudioAnalysisFrame) => void): void {
    for (let i = 0; i < samples.length; i++) {
      const v = samples[i]!
      this.ring[this.ringPos] = Number.isFinite(v) ? v : 0
      this.ringPos = (this.ringPos + 1) % this.fftSize
      this.samplesSeen++
      if (++this.sinceHop >= this.hop) {
        this.sinceHop = 0
        onFrame(this.analyse())
      }
    }
  }

  private analyse(): AudioAnalysisFrame {
    const n = this.fftSize
    const dt = this.frameMs
    const now = (this.samplesSeen / this.sampleRate) * 1000

    // Oldest-to-newest copy of the ring, windowed; RMS over the newest half window.
    let sumSq = 0
    for (let i = 0; i < n; i++) {
      const s = this.ring[(this.ringPos + i) % n]!
      if (i >= n / 2) sumSq += s * s
      this.re[i] = s * this.window[i]!
      this.im[i] = 0
    }
    const rmsDb = toDb(Math.sqrt(sumSq / (n / 2)))
    this.fft.transform(this.re, this.im)

    // Amplitude spectrum scaled so a full-scale sine reads ~1; band level = RMS amplitude of its bins.
    const scale = 2 / this.windowSum
    const half = n / 2
    let flux = 0
    let bassFlux = 0
    for (let k = 1; k < half; k++) {
      const amp = Math.hypot(this.re[k]!, this.im[k]!) * scale
      this.re[k] = amp
      const c = Math.log1p(FLUX_GAMMA * amp)
      const rise = c - this.compressed[k]!
      if (this.primed && rise > 0) {
        if (k <= this.fluxTop) flux += rise
        if (k >= this.bins.bass[0] && k <= this.bins.bass[1]) bassFlux += rise
      }
      this.compressed[k] = c
    }
    this.primed = true
    const bandDb = (key: keyof typeof BANDS): number => {
      const [lo, hi] = this.bins[key]
      let energy = 0
      for (let k = lo; k <= hi; k++) energy += this.re[k]! * this.re[k]!
      return toDb(Math.sqrt(energy / 2))
    }

    this.quietMs = rmsDb < this.silenceDb ? this.quietMs + dt : 0
    const isSilent = this.quietMs >= SILENCE_HOLD_MS

    const bass = this.env.bass.step(this.norm.bass.normalize(bandDb('bass'), dt), dt)
    const mids = this.env.mids.step(this.norm.mids.normalize(bandDb('mids'), dt), dt)
    const treble = this.env.treble.step(this.norm.treble.normalize(bandDb('treble'), dt), dt)
    const rms = this.env.rms.step(this.norm.rms.normalize(rmsDb, dt), dt)

    // Transients: spectral flux relative to its own recent average.
    const fluxMean = this.flux.mean
    this.flux.push(flux, dt)
    const transientRaw = isSilent ? 0 : clamp01((flux / (fluxMean + 1e-6) - 1) / 2)
    const transient = this.env.transient.step(transientRaw, dt)

    // Beat-like pulse: a bass onset well above its recent spread, at most every MIN_BEAT_GAP_MS.
    const { mean: bassMean, std: bassStd } = this.bassFlux
    this.bassFlux.push(bassFlux, dt)
    this.beat *= Math.exp(-dt / BEAT_DECAY_MS)
    const threshold = bassMean + 1.6 * bassStd
    if (!isSilent && bass > 0.2 && bassFlux > threshold && bassFlux > 0.05 && now - this.lastBeatMs >= MIN_BEAT_GAP_MS) {
      this.lastBeatMs = now
      const strength = clamp01(0.55 + (0.45 * (bassFlux - threshold)) / (3 * bassStd + 1e-6))
      this.beat = Math.max(this.beat, strength)
    }

    const loud = 0.45 * bass + 0.3 * mids + 0.15 * treble + 0.1 * rms
    const intensity = this.env.intensity.step(isSilent ? 0 : loud, dt)

    return {
      timestamp: now,
      rms: clamp01(rms),
      bass: clamp01(bass),
      mids: clamp01(mids),
      treble: clamp01(treble),
      transient: clamp01(transient),
      beatPulse: clamp01(this.beat),
      intensity: clamp01(intensity),
      isSilent
    }
  }
}
