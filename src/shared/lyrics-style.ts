/**
 * LUMINA Lyrics: how the fullscreen player animates and sets its lyrics. Shared by the settings
 * (main process), the tray, the settings panel and the renderer.
 */

/** Word animation styles. `fill` is the default; `minimal` is the reduced-animation option. */
export type LyricEffect = 'fill' | 'fade' | 'glow' | 'scale' | 'expressive' | 'minimal'

export const LYRIC_EFFECTS: readonly LyricEffect[] = ['fill', 'fade', 'glow', 'scale', 'expressive', 'minimal']

export const LYRIC_EFFECT_LABELS: Record<LyricEffect, string> = {
  fill: 'Smooth Fill',
  fade: 'Fade',
  glow: 'Glow',
  scale: 'Scale',
  expressive: 'Expressive',
  minimal: 'Minimal (reduced animation)'
}

/** How quickly lines move between each other. */
export type LyricTransition = 'relaxed' | 'balanced' | 'snappy'
export const LYRIC_TRANSITIONS: readonly LyricTransition[] = ['relaxed', 'balanced', 'snappy']

/** Bundled typefaces (all redistributable: Inter, Manrope and Fraunces are SIL OFL 1.1). */
export type LyricFont = 'inter' | 'manrope' | 'fraunces'
export const LYRIC_FONTS: readonly LyricFont[] = ['inter', 'manrope', 'fraunces']
export const LYRIC_FONT_LABELS: Record<LyricFont, string> = {
  inter: 'Inter (clean sans)',
  manrope: 'Manrope (geometric sans)',
  fraunces: 'Fraunces (expressive serif)'
}

export type LyricWeight = 600 | 700 | 800
export const LYRIC_WEIGHTS: readonly LyricWeight[] = [600, 700, 800]

export type LyricAlign = 'left' | 'center'
export type LyricSpacing = 'compact' | 'normal' | 'airy'
export const LYRIC_SPACINGS: readonly LyricSpacing[] = ['compact', 'normal', 'airy']

/** White text with an album-coloured glow, or text tinted toward the album colours. */
export type LyricColor = 'white' | 'album'

export interface LyricsConfig {
  effect: LyricEffect
  /** 0–1: how far words lift, scale and glow. */
  intensity: number
  transition: LyricTransition
  font: LyricFont
  weight: LyricWeight
  align: LyricAlign
  spacing: LyricSpacing
  color: LyricColor
}

export const DEFAULT_LYRICS: Readonly<LyricsConfig> = Object.freeze({
  effect: 'fill',
  intensity: 0.6,
  transition: 'balanced',
  font: 'inter',
  weight: 700,
  align: 'left',
  spacing: 'normal',
  color: 'white'
})

/** The LUMINA Lyrics fields as they are stored in the settings file (flat, one per control). */
export interface LyricsSettings {
  lyricEffect: LyricEffect
  lyricIntensity: number
  lyricTransition: LyricTransition
  lyricFont: LyricFont
  lyricWeight: LyricWeight
  lyricAlign: LyricAlign
  lyricSpacing: LyricSpacing
  lyricColor: LyricColor
}

export const LYRICS_SETTING_KEYS: readonly (keyof LyricsSettings)[] = [
  'lyricEffect',
  'lyricIntensity',
  'lyricTransition',
  'lyricFont',
  'lyricWeight',
  'lyricAlign',
  'lyricSpacing',
  'lyricColor'
]

export const DEFAULT_LYRICS_SETTINGS: Readonly<LyricsSettings> = Object.freeze({
  lyricEffect: DEFAULT_LYRICS.effect,
  lyricIntensity: DEFAULT_LYRICS.intensity,
  lyricTransition: DEFAULT_LYRICS.transition,
  lyricFont: DEFAULT_LYRICS.font,
  lyricWeight: DEFAULT_LYRICS.weight,
  lyricAlign: DEFAULT_LYRICS.align,
  lyricSpacing: DEFAULT_LYRICS.spacing,
  lyricColor: DEFAULT_LYRICS.color
})

/** The old three-step "Animation" setting (before LUMINA Lyrics) as an intensity. */
const LEGACY_ANIMATION: Record<string, number> = { low: 0.35, medium: 0.6, high: 0.9 }

const choose = <T>(v: unknown, choices: readonly T[], fallback: T): T => (choices.includes(v as T) ? (v as T) : fallback)

/**
 * Validates the lyrics fields one by one (a bad value never resets the others). A file written
 * before LUMINA Lyrics has `animation` instead of `lyricIntensity`; its level carries over.
 */
export function sanitizeLyricsSettings(r: Record<string, unknown>): LyricsSettings {
  const d = DEFAULT_LYRICS_SETTINGS
  const raw = r.lyricIntensity
  const intensity =
    typeof raw === 'number' && Number.isFinite(raw)
      ? Math.round(Math.min(1, Math.max(0, raw)) * 100) / 100
      : (LEGACY_ANIMATION[String(r.animation)] ?? d.lyricIntensity)
  return {
    lyricEffect: choose(r.lyricEffect, LYRIC_EFFECTS, d.lyricEffect),
    lyricIntensity: intensity,
    lyricTransition: choose(r.lyricTransition, LYRIC_TRANSITIONS, d.lyricTransition),
    lyricFont: choose(r.lyricFont, LYRIC_FONTS, d.lyricFont),
    lyricWeight: choose(r.lyricWeight, LYRIC_WEIGHTS, d.lyricWeight),
    lyricAlign: choose(r.lyricAlign, ['left', 'center'] as const, d.lyricAlign),
    lyricSpacing: choose(r.lyricSpacing, LYRIC_SPACINGS, d.lyricSpacing),
    lyricColor: choose(r.lyricColor, ['white', 'album'] as const, d.lyricColor)
  }
}

/** The renderer's view of the stored fields. */
export const lyricsConfigOf = (s: LyricsSettings): LyricsConfig => ({
  effect: s.lyricEffect,
  intensity: s.lyricIntensity,
  transition: s.lyricTransition,
  font: s.lyricFont,
  weight: s.lyricWeight,
  align: s.lyricAlign,
  spacing: s.lyricSpacing,
  color: s.lyricColor
})

/** Keeps only the LUMINA Lyrics keys of an untrusted patch (from the settings panel). */
export function pickLyricsPatch(raw: unknown): Partial<LyricsSettings> {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, unknown> = {}
  for (const key of LYRICS_SETTING_KEYS) if (key in raw) out[key] = (raw as Record<string, unknown>)[key]
  return out as Partial<LyricsSettings>
}
