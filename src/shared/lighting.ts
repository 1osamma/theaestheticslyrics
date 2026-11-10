/**
 * LUMINA lighting contract, shared by the main process (settings, colours, audio) and the
 * renderers (fullscreen player background, desktop edge lighting). See docs/lumina/architecture.md.
 *
 *  - off:     no lighting
 *  - static:  album colours, still
 *  - ambient: album colours, slow drift, no audio
 *  - bass:    album colours, steady atmosphere, bloom pulses with the bass
 *  - hybrid:  album colours; live audio drives brightness, bloom, movement and shimmer (default)
 */
export type LightingMode = 'off' | 'static' | 'ambient' | 'bass' | 'hybrid'

export const LIGHTING_MODES: readonly LightingMode[] = ['off', 'static', 'ambient', 'bass', 'hybrid']

export const LIGHTING_MODE_LABELS: Record<LightingMode, string> = {
  off: 'Off',
  static: 'Static Album Colors',
  ambient: 'Ambient',
  bass: 'Bass Reactive',
  hybrid: 'Hybrid'
}

/** Modes that need live audio analysis. */
export const usesAudio = (mode: LightingMode): boolean => mode === 'bass' || mode === 'hybrid'

/** Lighting render rate targets. 240 is experimental. */
export type LightingFps = 30 | 60 | 120 | 240
export const LIGHTING_FPS: readonly LightingFps[] = [30, 60, 120, 240]

export interface EdgeSides {
  left: boolean
  right: boolean
  top: boolean
  bottom: boolean
}

/** Two to four `#rrggbb` colours, strongest first, already tuned to glow on a black screen. */
export interface AmbientPalette {
  colors: string[]
  /** `album` when taken from the cover, `palette` when derived from the lyric colours (no art). */
  source: 'album' | 'palette'
}

/** What a lighting window needs to draw, besides the palette and live audio. All levels 0–1. */
export interface LightingConfig {
  mode: LightingMode
  brightness: number
  /** How strongly audio moves the light. */
  sensitivity: number
  bassStrength: number
  /** Higher = slower, calmer response. */
  smoothing: number
  /** Fullscreen bloom size. */
  glowRadius: number
  /** Edge glow depth into the screen. */
  edgeThickness: number
  /** How far along each edge the glow reaches (0 = centred pools, 1 = the full edge). */
  edgeSpread: number
  /** Edge glow falloff (0 = crisp, 1 = very soft). */
  edgeSoftness: number
  edges: EdgeSides
  /** Edge illumination inside the fullscreen player too. */
  playerEdgeGlow: boolean
  fps: LightingFps
  reducedMotion: boolean
  /** False without GPU compositing: renderers use their lightweight path. */
  gpu: boolean
}

/** One rendered moment of light, the engine's output. Colours are sRGB 0–1; levels 0–1. */
export interface LightFrame {
  active: boolean
  colors: [number, number, number][]
  /** Base album-colour atmosphere. */
  atmosphere: number
  /** Bass-reactive bloom. */
  bloom: number
  /** Bloom radius, 0–1 of its range. */
  bloomRadius: number
  /** High-frequency shimmer accents. */
  shimmer: number
  /** Drift phase in "seconds of motion": advances faster with more movement, never jumps. */
  phase: number
  /** Edge illumination strength. */
  edge: number
}

/**
 * Which audio drives the light. `system` (the default) is WASAPI loopback of the default output
 * device: all desktop audio, not only Spotify. `spotify` is process loopback of Spotify's process
 * tree; it is experimental because it delivers only silence on the development PC.
 */
export type AudioSource = 'system' | 'spotify'

export const AUDIO_SOURCE_LABELS: Record<AudioSource, string> = {
  system: 'All desktop audio (system loopback, not Spotify only)',
  spotify: 'Spotify only (experimental, process loopback)'
}

/** Which monitors get desktop edge lighting: the primary one, every one, or one Electron display id. */
export type EdgeDisplays = 'primary' | 'all' | number

/** The LUMINA Lighting section of the settings file. */
export interface LightingSettings {
  lightingMode: LightingMode
  /** Lighting behind the fullscreen player. */
  fullscreenLighting: boolean
  /** The desktop edge-lighting overlay. Off until explicitly enabled. */
  edgeLighting: boolean
  /** 0.05 to 1. */
  lightingBrightness: number
  audioSensitivity: number
  bassStrength: number
  lightingSmoothing: number
  glowRadius: number
  edgeThickness: number
  edgeSpread: number
  edgeSoftness: number
  edgeSides: EdgeSides
  /** Edge illumination inside the fullscreen player as well. */
  playerEdgeGlow: boolean
  lightingFps: LightingFps
  audioSource: AudioSource
  edgeDisplays: EdgeDisplays
  /** Hide edge lighting while another app fills that monitor (games, video). */
  pauseInFullscreen: boolean
  /** When the app starts with Windows, edge lighting starts too (if it is enabled). */
  edgeAtStartup: boolean
}

export const LIGHTING_SETTING_KEYS: readonly (keyof LightingSettings)[] = [
  'lightingMode',
  'fullscreenLighting',
  'edgeLighting',
  'lightingBrightness',
  'audioSensitivity',
  'bassStrength',
  'lightingSmoothing',
  'glowRadius',
  'edgeThickness',
  'edgeSpread',
  'edgeSoftness',
  'edgeSides',
  'playerEdgeGlow',
  'lightingFps',
  'audioSource',
  'edgeDisplays',
  'pauseInFullscreen',
  'edgeAtStartup'
]

/** Keeps only lighting keys from an untrusted patch (values are validated by the settings store). */
export function pickLightingPatch(raw: unknown): Partial<LightingSettings> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const r = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of LIGHTING_SETTING_KEYS) if (key in r) out[key] = r[key]
  return out as Partial<LightingSettings>
}

/** Kept for the CSS fallback renderer: overall strength and liveliness, 0–1. */
export interface LightingDrive {
  intensity: number
  motion: number
}
