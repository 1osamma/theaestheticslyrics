/**
 * One step of live audio analysis, sent from the main process to lighting windows at ~60 Hz.
 * Every level is normalised to 0–1 against the recent loudness of the music (not absolute volume).
 */
export interface AudioAnalysisFrame {
  /** `performance.now()`-style milliseconds in the analysing process; only differences matter. */
  timestamp: number
  rms: number
  /** ~30–150 Hz: kick drum and bass. */
  bass: number
  /** ~250–2000 Hz: vocals and most instruments. */
  mids: number
  /** ~4–12 kHz: cymbals, air, sibilance. */
  treble: number
  /** Spectral flux onset strength. */
  transient: number
  /** A pulse that jumps on beat-like bass onsets and decays smoothly. Not BPM detection. */
  beatPulse: number
  /** Overall smoothed loudness, weighted toward the low end. */
  intensity: number
  isSilent: boolean
}

/** Which audio the helper is listening to. */
export type AudioCaptureMode = 'process' | 'system'

export interface AudioStatus {
  state: 'stopped' | 'starting' | 'capturing' | 'waiting' | 'error'
  /** `process` = Spotify only (process loopback); `system` = everything playing on the output device. */
  mode: AudioCaptureMode | null
  message: string
}

const unit = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

/** Validates a frame from another process or window: every level clamped to 0–1, anything else rejected. */
export function sanitizeAudioFrame(raw: unknown): AudioAnalysisFrame | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.timestamp !== 'number' || !Number.isFinite(r.timestamp)) return null
  return {
    timestamp: r.timestamp,
    rms: unit(r.rms),
    bass: unit(r.bass),
    mids: unit(r.mids),
    treble: unit(r.treble),
    transient: unit(r.transient),
    beatPulse: unit(r.beatPulse),
    intensity: unit(r.intensity),
    isSilent: r.isSilent === true
  }
}

export const SILENT_FRAME: Readonly<AudioAnalysisFrame> = Object.freeze({
  timestamp: 0,
  rms: 0,
  bass: 0,
  mids: 0,
  treble: 0,
  transient: 0,
  beatPulse: 0,
  intensity: 0,
  isSilent: true
})
