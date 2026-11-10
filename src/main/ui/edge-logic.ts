import type { EdgeDisplays } from '@shared/lighting'
import type { FullscreenInfo, ScreenRect } from './fullscreen-watcher'

export interface DisplayLike {
  id: number
  /** DIP bounds. */
  bounds: ScreenRect
  /** Physical-pixel bounds (Windows): what the full-screen helper reports. */
  physical: ScreenRect
}

/** The displays that get edge lighting for a setting; unknown ids fall back to the primary display. */
export function edgeTargets(setting: EdgeDisplays, displays: DisplayLike[], primaryId: number): DisplayLike[] {
  if (setting === 'all') return displays
  const wanted = setting === 'primary' ? primaryId : setting
  const match = displays.find((d) => d.id === wanted) ?? displays.find((d) => d.id === primaryId)
  return match ? [match] : []
}

/** Whether a full-screen app covers this display (compared in physical pixels, centre inside). */
export function coveredByFullscreen(display: DisplayLike, fs: FullscreenInfo): boolean {
  if (!fs.active) return false
  if (!fs.monitor) return true // exclusive full screen without a rect: hold every display
  const cx = fs.monitor.x + fs.monitor.width / 2
  const cy = fs.monitor.y + fs.monitor.height / 2
  const p = display.physical
  return cx >= p.x && cx < p.x + p.width && cy >= p.y && cy < p.y + p.height
}

/** Edge lighting rests after this long without playback, so an idle OLED is not lit for hours. */
export const EDGE_IDLE_HIDE_MS = 60_000

export interface EdgeFacts {
  enabled: boolean
  modeOff: boolean
  paused: boolean
  suppressed: boolean
  lyricsScreenOpen: boolean
  /** Milliseconds since music last played (0 while playing, Infinity when nothing has). */
  idleMs: number
}

/** Why edge lighting is held although enabled, or null when it should show. */
export function edgeHold(f: EdgeFacts): string | null {
  if (!f.enabled) return 'Edge lighting is off'
  if (f.modeOff) return 'Lighting mode is Off'
  if (f.paused) return 'Lighting is paused'
  if (f.suppressed) return 'Not started with Windows (turn it on from the tray)'
  if (f.lyricsScreenOpen) return 'The fullscreen player is open'
  if (f.idleMs > EDGE_IDLE_HIDE_MS) return 'Resting: no music for a minute'
  return null
}
