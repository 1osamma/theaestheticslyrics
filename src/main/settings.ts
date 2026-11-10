import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { LIGHTING_FPS, LIGHTING_MODES, type AudioSource, type EdgeDisplays, type LightingSettings } from '@shared/lighting'
import { DEFAULT_COLORS, HEX_COLOR } from '@shared/palette-defaults'
import {
  STYLE_IDS,
  type AnimationIntensity,
  type ColorRole,
  type FrameRateCap,
  type FullscreenLayout,
  type ShowOn,
  type StyleId
} from '@shared/types'
import { makeDirSync } from './dirs'

export type IdleMinutes = 0 | 1 | 2 | 5

export type { EdgeDisplays }

export interface Settings extends LightingSettings {
  /** 2 since LUMINA lighting (Phase 2); version-1 files are migrated on load. */
  version: 2
  style: StyleId
  showOn: ShowOn
  /** Electron display id; `null` follows the primary display. */
  displayId: number | null
  autoSync: boolean
  colors: Record<ColorRole, string>
  /** Positive shows words later (compensates Bluetooth / output latency). */
  offsetMs: number
  /** Minutes of no input before the lyrics screen opens during playback; 0 = off. */
  idleMinutes: IdleMinutes
  /** Follow every media app, not just Spotify and Apple Music. */
  allPlayers: boolean
  launchAtLogin: boolean
  /** The first-run "theaestheticslyrics is running" notice has been shown. */
  welcomed: boolean
  /**
   * Ctrl+Alt+L locks Windows when you come back (any input closes the lyrics screen).
   * Off: the lyrics screen stays up until Esc (or Ctrl+Alt+L again) and nothing is locked.
   */
  lockOnReturn: boolean
  /** Also ask NetEase (unofficial) for real per-word timing; LRCLIB stays the fallback. */
  wordLevel: boolean
  /** Full-screen view: the LUMINA player, or the classic lyric style alone. */
  layout: FullscreenLayout
  animation: AnimationIntensity
  /** Calmer player: no drift, scrolling, lift or glow. Windows' own setting also turns this on. */
  reducedMotion: boolean
  /** Player lyric size multiplier, one of LYRIC_SCALE_CHOICES. */
  lyricScale: number
  frameRateCap: FrameRateCap
  // The LUMINA Lighting fields come from LightingSettings (src/shared/lighting.ts).
}

export const IDLE_CHOICES: readonly IdleMinutes[] = [0, 1, 2, 5]
export const OFFSET_LIMIT_MS = 1000
export const AUDIO_SOURCES: readonly AudioSource[] = ['system', 'spotify']
export const LYRIC_SCALE_CHOICES: readonly number[] = [0.85, 1, 1.15, 1.3]
export const ANIMATION_CHOICES: readonly AnimationIntensity[] = ['low', 'medium', 'high']
export const FRAME_RATE_CHOICES: readonly FrameRateCap[] = [0, 120, 60, 30]

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  version: 2,
  style: 'ship',
  showOn: 'lock',
  displayId: null,
  autoSync: false,
  colors: Object.freeze({ ...DEFAULT_COLORS }),
  offsetMs: 0,
  idleMinutes: 2,
  allPlayers: false,
  launchAtLogin: false,
  welcomed: false,
  lockOnReturn: false,
  wordLevel: true,
  layout: 'player',
  animation: 'medium',
  reducedMotion: false,
  lyricScale: 1,
  frameRateCap: 0,
  lightingMode: 'hybrid',
  fullscreenLighting: true,
  edgeLighting: false,
  lightingBrightness: 0.45,
  audioSensitivity: 0.6,
  bassStrength: 0.55,
  lightingSmoothing: 0.7,
  glowRadius: 0.5,
  edgeThickness: 0.35,
  edgeSpread: 0.6,
  edgeSoftness: 0.7,
  edgeSides: Object.freeze({ left: true, right: true, top: false, bottom: true }),
  playerEdgeGlow: false,
  lightingFps: 60,
  audioSource: 'system',
  edgeDisplays: 'primary',
  pauseInFullscreen: true,
  edgeAtStartup: true
}) as Readonly<Settings>

/** Phase 1 ambient brightness choices to lighting brightness (Medium, the old default, becomes 45%). */
const V1_BRIGHTNESS: Record<string, number> = { '0.4': 0.3, '0.7': 0.45, '1': 0.65 }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const pickChoice = <T>(v: unknown, choices: readonly T[], fallback: T): T =>
  choices.includes(v as T) ? (v as T) : fallback

const pickBool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

/** A 0-1 level (or min-1), rounded to whole percent; anything else falls back. */
const pickLevel = (v: unknown, fallback: number, min = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(1, Math.max(min, v)) * 100) / 100 : fallback

const pickColor = (v: unknown, fallback: string): string =>
  typeof v === 'string' && HEX_COLOR.test(v) ? v.toLowerCase() : fallback

/** Validates every field independently, so one bad value never resets the rest. */
export function sanitizeSettings(raw: unknown): Settings {
  const r = isRecord(raw) ? raw : {}
  const colors = isRecord(r.colors) ? r.colors : {}
  const offset = typeof r.offsetMs === 'number' && Number.isFinite(r.offsetMs) ? Math.round(r.offsetMs) : 0
  const sides = isRecord(r.edgeSides) ? r.edgeSides : {}
  const d = DEFAULT_SETTINGS
  // Version-1 files (Phase 1) kept ambient on/off and a 3-step brightness; carry both over.
  const v1 = r.version !== 2
  const brightness = v1
    ? (V1_BRIGHTNESS[String(r.ambientBrightness)] ?? d.lightingBrightness)
    : pickLevel(r.lightingBrightness, d.lightingBrightness, 0.05)
  const fullscreenLighting = v1 ? r.ambient !== false : pickBool(r.fullscreenLighting, d.fullscreenLighting)
  const edgeDisplays: EdgeDisplays =
    r.edgeDisplays === 'all' || r.edgeDisplays === 'primary'
      ? r.edgeDisplays
      : typeof r.edgeDisplays === 'number' && Number.isInteger(r.edgeDisplays)
        ? r.edgeDisplays
        : d.edgeDisplays

  return {
    version: 2,
    style: STYLE_IDS.includes(r.style as StyleId) ? (r.style as StyleId) : DEFAULT_SETTINGS.style,
    showOn: r.showOn === 'always' || r.showOn === 'lock' ? r.showOn : DEFAULT_SETTINGS.showOn,
    displayId: typeof r.displayId === 'number' && Number.isInteger(r.displayId) ? r.displayId : null,
    autoSync: typeof r.autoSync === 'boolean' ? r.autoSync : DEFAULT_SETTINGS.autoSync,
    colors: {
      lyric: pickColor(colors.lyric, DEFAULT_COLORS.lyric),
      highlight: pickColor(colors.highlight, DEFAULT_COLORS.highlight),
      secondary: pickColor(colors.secondary, DEFAULT_COLORS.secondary)
    },
    offsetMs: Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, offset)),
    idleMinutes: IDLE_CHOICES.includes(r.idleMinutes as IdleMinutes)
      ? (r.idleMinutes as IdleMinutes)
      : DEFAULT_SETTINGS.idleMinutes,
    allPlayers: typeof r.allPlayers === 'boolean' ? r.allPlayers : DEFAULT_SETTINGS.allPlayers,
    launchAtLogin: typeof r.launchAtLogin === 'boolean' ? r.launchAtLogin : DEFAULT_SETTINGS.launchAtLogin,
    welcomed: typeof r.welcomed === 'boolean' ? r.welcomed : DEFAULT_SETTINGS.welcomed,
    lockOnReturn: typeof r.lockOnReturn === 'boolean' ? r.lockOnReturn : DEFAULT_SETTINGS.lockOnReturn,
    wordLevel: typeof r.wordLevel === 'boolean' ? r.wordLevel : DEFAULT_SETTINGS.wordLevel,
    layout: r.layout === 'player' || r.layout === 'lyrics' ? r.layout : DEFAULT_SETTINGS.layout,
    animation: pickChoice(r.animation, ANIMATION_CHOICES, DEFAULT_SETTINGS.animation),
    reducedMotion: typeof r.reducedMotion === 'boolean' ? r.reducedMotion : DEFAULT_SETTINGS.reducedMotion,
    lyricScale: pickChoice(r.lyricScale, LYRIC_SCALE_CHOICES, DEFAULT_SETTINGS.lyricScale),
    frameRateCap: pickChoice(r.frameRateCap, FRAME_RATE_CHOICES, DEFAULT_SETTINGS.frameRateCap),
    lightingMode: pickChoice(r.lightingMode, LIGHTING_MODES, d.lightingMode),
    fullscreenLighting,
    edgeLighting: pickBool(r.edgeLighting, d.edgeLighting),
    lightingBrightness: brightness,
    audioSensitivity: pickLevel(r.audioSensitivity, d.audioSensitivity),
    bassStrength: pickLevel(r.bassStrength, d.bassStrength),
    lightingSmoothing: pickLevel(r.lightingSmoothing, d.lightingSmoothing),
    glowRadius: pickLevel(r.glowRadius, d.glowRadius),
    edgeThickness: pickLevel(r.edgeThickness, d.edgeThickness, 0.05),
    edgeSpread: pickLevel(r.edgeSpread, d.edgeSpread),
    edgeSoftness: pickLevel(r.edgeSoftness, d.edgeSoftness),
    edgeSides: {
      left: pickBool(sides.left, d.edgeSides.left),
      right: pickBool(sides.right, d.edgeSides.right),
      top: pickBool(sides.top, d.edgeSides.top),
      bottom: pickBool(sides.bottom, d.edgeSides.bottom)
    },
    playerEdgeGlow: pickBool(r.playerEdgeGlow, d.playerEdgeGlow),
    lightingFps: pickChoice(r.lightingFps, LIGHTING_FPS, d.lightingFps),
    audioSource: pickChoice(r.audioSource, AUDIO_SOURCES, d.audioSource),
    edgeDisplays,
    pauseInFullscreen: pickBool(r.pauseInFullscreen, d.pauseInFullscreen),
    edgeAtStartup: pickBool(r.edgeAtStartup, d.edgeAtStartup)
  }
}

const freeze = (s: Settings): Settings =>
  Object.freeze({ ...s, colors: Object.freeze({ ...s.colors }), edgeSides: Object.freeze({ ...s.edgeSides }) }) as Settings

export class SettingsStore {
  private current: Settings
  private readonly listeners = new Set<(s: Settings) => void>()

  constructor(private readonly file: string) {
    this.current = freeze(this.load())
  }

  get(): Settings {
    return this.current
  }

  update(patch: Partial<Settings>): Settings {
    this.current = freeze(
      sanitizeSettings({
        ...this.current,
        ...patch,
        colors: { ...this.current.colors, ...patch.colors },
        edgeSides: { ...this.current.edgeSides, ...patch.edgeSides }
      })
    )
    this.persist()
    for (const listener of this.listeners) listener(this.current)
    return this.current
  }

  onChange(cb: (s: Settings) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private load(): Settings {
    try {
      return sanitizeSettings(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return sanitizeSettings(undefined)
    }
  }

  private persist(): void {
    const json = JSON.stringify(this.current, null, 2)
    makeDirSync(dirname(this.file))
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, json, 'utf8')
      renameSync(tmp, this.file)
    } catch {
      // A virus scanner can briefly hold the target open; a direct write is the fallback.
      writeFileSync(this.file, json, 'utf8')
    }
  }
}
