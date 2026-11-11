import type { LyricsConfig } from './lyrics-style'

/** The four display styles, mirroring Verci's menu. */
export type StyleId = 'ship' | 'fisheye' | 'fisheye-visual' | 'visual'

/** Where the words show: the lock-style screen, or an always-on overlay. */
export type ShowOn = 'lock' | 'always'

export type ColorRole = 'lyric' | 'highlight' | 'secondary'

/** All colours are lowercase `#rrggbb`. */
export interface Palette {
  lyric: string
  highlight: string
  /** Text drawn on top of the highlight box. */
  highlightText: string
  secondary: string
}

/** Times are integer milliseconds of song time. */
export interface TimedWord {
  text: string
  start: number
  end: number
}

export interface TimedLine {
  text: string
  start: number
  end: number
  words: TimedWord[]
}

export interface TimedLyrics {
  lines: TimedLine[]
  /** `native` when the source carried per-word tags, `estimated` otherwise. */
  wordTiming: 'native' | 'estimated'
}

export interface TrackInfo {
  /** Stable identity of the track within one player session. */
  key: string
  app: string
  title: string
  artist: string
  album: string
  /** 0 when the player does not report a duration. */
  durationMs: number
}

/**
 * Song position `positionMs` was true at wall-clock `atEpochMs`.
 * While `playing`, the current position is extrapolated from that anchor.
 */
export interface PlaybackAnchor {
  trackKey: string
  positionMs: number
  atEpochMs: number
  playing: boolean
  rate: number
}

export type LyricsStatus = 'idle' | 'searching' | 'found' | 'not-found' | 'instrumental' | 'error'

export const STYLE_IDS: readonly StyleId[] = ['ship', 'fisheye', 'fisheye-visual', 'visual']

export const STYLE_LABELS: Record<StyleId, string> = {
  ship: 'Ship',
  fisheye: 'Fisheye',
  'fisheye-visual': 'Fisheye Visual',
  visual: 'Visual'
}

/** What the full-screen lyrics screen shows: the LUMINA player, or the classic lyric style on its own. */
export type FullscreenLayout = 'player' | 'lyrics'

/** Highest frame rate the lyrics screen draws at; 0 follows the display's refresh rate. */
export type FrameRateCap = 0 | 30 | 60 | 120

/** How the LUMINA player looks. Only settings that work today live here. */
export interface PlayerConfig {
  /** How the lyrics animate and are set (effect, intensity, transition speed, typography). */
  lyrics: LyricsConfig
  /** Reduce animations: words simply brighten, lines don't drift or glow (also follows Windows' own setting). */
  reducedMotion: boolean
  /** Multiplies the player's lyric font size. */
  lyricScale: number
  /** False when Chromium runs without GPU compositing: the player drops its costlier effects. */
  gpu: boolean
}

/** Album art for the player, re-encoded by the main process. */
export interface Artwork {
  trackKey: string
  dataUrl: string
}
