import type { AudioAnalysisFrame } from './audio-frame'
import type { LightFrame, LightingConfig } from './lighting'

/** Album colours crossfade over this long when the track changes. */
export const PALETTE_FADE_MS = 1600
/** Audio older than this is stale (paused, capture stopped): the light settles as if silent. */
export const AUDIO_STALE_MS = 400

type Rgb = [number, number, number]

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const n = Number.parseInt(m[1]!, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Exactly four colours: shorter palettes repeat, so every layer always has one. */
export function fourColors(hexes: readonly string[]): Rgb[] {
  const list = hexes.length ? hexes : ['#6f6f7a']
  return [0, 1, 2, 3].map((i) => hexToRgb(list[i % list.length]!))
}

/** Frame-rate independent attack/release follower. */
class Follower {
  value = 0
  step(target: number, dtMs: number, attackMs: number, releaseMs: number): number {
    const tau = target > this.value ? attackMs : releaseMs
    this.value += (target - this.value) * (1 - Math.exp(-dtMs / Math.max(1, tau)))
    return this.value
  }
}

/**
 * Applies the user's sensitivity: a contrast curve plus gain, so typical music does not sit at a
 * constant high level and quiet passages stay dark. 0.6 is the default.
 */
export function applySensitivity(level: number, sensitivity: number): number {
  const gamma = 1.9 - sensitivity
  const gain = 0.55 + 0.9 * sensitivity
  return clamp01(clamp01(level) ** gamma * gain)
}

/**
 * The hybrid lighting engine. The album palette is the colour source; live audio frames are the
 * motion source. `sample(now)` turns both into a `LightFrame` for any renderer, interpolating
 * between analysis frames so the render rate is independent of the audio rate. Pure and
 * allocation-light, so the fullscreen player and the edge overlay can each run one per frame.
 */
export class LightingEngine {
  private config: LightingConfig
  private from: Rgb[] = fourColors([])
  private to: Rgb[] = fourColors([])
  private fadeStart = Number.NEGATIVE_INFINITY
  private hasPalette = false
  private audio: AudioAnalysisFrame | null = null
  private audioAt = Number.NEGATIVE_INFINITY
  private last: number | null = null
  private phase = 0
  private readonly f = {
    bass: new Follower(),
    mids: new Follower(),
    treble: new Follower(),
    intensity: new Follower(),
    pulse: new Follower(),
    transient: new Follower(),
    motion: new Follower()
  }
  private readonly out: LightFrame = {
    active: false,
    colors: [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0]
    ],
    atmosphere: 0,
    bloom: 0,
    bloomRadius: 0.5,
    shimmer: 0,
    phase: 0,
    edge: 0
  }

  constructor(config: LightingConfig) {
    this.config = config
  }

  setConfig(config: LightingConfig): void {
    this.config = config
  }

  /** New album colours. The first palette (or `instant`) applies at once; later ones crossfade. */
  setPalette(hexes: readonly string[], now: number, instant = false): void {
    const next = fourColors(hexes)
    if (!this.hasPalette || instant) {
      this.from = next
      this.to = next
      this.fadeStart = Number.NEGATIVE_INFINITY
      this.hasPalette = true
      return
    }
    if (next.every((c, i) => c.every((v, j) => v === this.to[i]![j]))) return
    // Start the fade from whatever is on screen now, so quick skips never jump.
    this.from = this.currentColors(now).map((c) => [...c] as Rgb)
    this.to = next
    this.fadeStart = now
  }

  pushAudio(frame: AudioAnalysisFrame, now: number): void {
    this.audio = frame
    this.audioAt = now
  }

  /** The light at `now` (ms, monotonic). Returns the same object every call (copy it to keep it). */
  sample(now: number): LightFrame {
    const c = this.config
    const dt = this.last === null ? 16 : Math.min(250, Math.max(0, now - this.last))
    this.last = now
    const out = this.out
    const colors = this.currentColors(now)
    for (let i = 0; i < 4; i++) {
      const target = out.colors[i]!
      target[0] = colors[i]![0]
      target[1] = colors[i]![1]
      target[2] = colors[i]![2]
    }
    out.active = c.mode !== 'off' && c.brightness > 0
    if (!out.active) {
      out.atmosphere = out.bloom = out.shimmer = out.edge = 0
      out.phase = this.phase
      return out
    }

    // Audio targets (zero when stale or silent), then the user's smoothing.
    const fresh = this.audio && now - this.audioAt <= AUDIO_STALE_MS && !this.audio.isSilent ? this.audio : null
    const s = c.sensitivity
    const attack = 20 + 120 * c.smoothing
    const release = 80 + 520 * c.smoothing
    const calm = c.reducedMotion ? 3 : 1
    const bass = this.f.bass.step(fresh ? applySensitivity(fresh.bass, s) : 0, dt, attack, release * calm)
    const mids = this.f.mids.step(fresh ? applySensitivity(fresh.mids, s) : 0, dt, attack * 2, release * 1.5 * calm)
    const treble = this.f.treble.step(fresh ? applySensitivity(fresh.treble, s) : 0, dt, attack, release * calm)
    const intensity = this.f.intensity.step(fresh ? applySensitivity(fresh.intensity, s) : 0, dt, attack * 2, release * 2 * calm)
    const pulse = this.f.pulse.step(fresh ? fresh.beatPulse : 0, dt, 15 + 40 * c.smoothing, (120 + 300 * c.smoothing) * calm)
    const transient = this.f.transient.step(fresh ? fresh.transient : 0, dt, 15, 150 + 250 * c.smoothing)

    let atmosphere = c.brightness
    let bloom = 0
    let shimmer = 0
    let motionTarget = 0
    let radius = c.glowRadius
    switch (c.mode) {
      case 'static':
        break
      case 'ambient':
        atmosphere = c.brightness * 0.9
        motionTarget = 0.55
        // A slow breath keeps an ambient screen alive without any audio.
        bloom = 0.18 * (0.5 + 0.5 * Math.sin(this.phase * 0.35))
        break
      case 'bass':
        atmosphere = c.brightness * 0.6
        motionTarget = 0.25
        bloom = c.bassStrength * (0.4 * bass + 0.8 * pulse)
        break
      case 'hybrid':
        // Quiet passages darken toward 35% of the chosen brightness; loud ones reach it.
        atmosphere = c.brightness * (0.35 + 0.65 * intensity)
        motionTarget = 0.3 + 0.9 * mids
        bloom = c.bassStrength * (0.35 * bass + 0.7 * pulse) + 0.12 * transient
        shimmer = 0.4 * treble * s
        radius = c.glowRadius * (0.85 + 0.3 * intensity)
        break
    }
    if (c.reducedMotion) {
      motionTarget = 0
      bloom = Math.min(bloom, 0.35)
      shimmer = 0
    }
    const motion = this.f.motion.step(motionTarget, dt, 600, 1200)
    this.phase += (dt / 1000) * motion

    // Bloom never outshines the chosen brightness by much: OLED-friendly peaks.
    out.atmosphere = clamp01(atmosphere)
    out.bloom = clamp01(bloom * (0.35 + c.brightness))
    out.bloomRadius = clamp01(radius)
    out.shimmer = clamp01(shimmer)
    out.phase = this.phase
    out.edge = clamp01(out.atmosphere * 0.9 + out.bloom * 0.7)
    return out
  }

  private currentColors(now: number): Rgb[] {
    const t = easeInOut(clamp01((now - this.fadeStart) / PALETTE_FADE_MS))
    if (t >= 1) return this.to
    return this.to.map((to, i) => {
      const from = this.from[i]!
      return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t] as Rgb
    })
  }
}
