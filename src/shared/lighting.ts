/**
 * Ambient lighting contract shared by the main process (which derives colours) and the
 * renderer (which draws light). See docs/lumina/architecture.md for the full plan.
 *
 *  - album:  colours from the album art, slow drift (Phase 1, implemented)
 *  - audio:  colours fixed, intensity and motion follow captured audio energy (planned)
 *  - hybrid: colours from the album art, intensity and motion from audio (planned)
 *  - static: one user-chosen colour and brightness (planned)
 */
export type LightingMode = 'album' | 'audio' | 'hybrid' | 'static'

export const IMPLEMENTED_LIGHTING_MODES: readonly LightingMode[] = ['album']

/** Two to four `#rrggbb` colours, strongest first, already tuned to glow on a black screen. */
export interface AmbientPalette {
  colors: string[]
  /** `album` when taken from the cover, `palette` when derived from the lyric colours (no art). */
  source: 'album' | 'palette'
}

/**
 * Smoothed audio levels, each 0–1. Produced by a future capture module (WASAPI loopback in
 * the main process, analysed off the UI thread); nothing produces them in Phase 1.
 */
export interface AudioBands {
  energy: number
  bass: number
  mid: number
  treble: number
}

/** What drives the light for one frame, whatever the mode. */
export interface LightingDrive {
  /** Overall light strength multiplier, 0–1. */
  intensity: number
  /** How lively the movement is, 0 (still) – 1. */
  motion: number
}
