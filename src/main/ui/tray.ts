import { Menu, Tray, nativeImage, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import { STYLE_IDS, STYLE_LABELS, type ColorRole, type LyricsStatus, type Palette, type ShowOn, type StyleId, type TrackInfo } from '@shared/types'
import type { AudioStatus } from '@shared/audio-frame'
import { LIGHTING_MODES, LIGHTING_MODE_LABELS, type LightingSettings } from '@shared/lighting'
import {
  ANIMATION_CHOICES,
  FRAME_RATE_CHOICES,
  LYRIC_SCALE_CHOICES,
  type IdleMinutes,
  type Settings
} from '../settings'
import { swatchBitmap } from './swatch'

export interface TrayModel {
  track: TrackInfo | null
  lyricsStatus: LyricsStatus
  health: { ok: boolean; message?: string }
  settings: Settings
  palette: Palette
  displays: { id: number; label: string }[]
  canLaunchAtLogin: boolean
  hotkeyOk: boolean
  lighting: {
    paused: boolean
    audio: AudioStatus
    edgeShowing: number
    edgeHeldBy: string | null
  }
}

/** Settings the Player submenu and Full-Screen View change. */
export type PlayerSettings = Pick<Settings, 'layout' | 'animation' | 'reducedMotion' | 'lyricScale' | 'frameRateCap'>

export interface TrayActions {
  setStyle(style: StyleId): void
  setShowOn(showOn: ShowOn): void
  setDisplay(id: number | null): void
  setAutoSync(on: boolean): void
  editColors(role: ColorRole): void
  resetColors(): void
  showNow(): void
  setLockOnReturn(on: boolean): void
  setOffset(ms: number): void
  setWordLevel(on: boolean): void
  setIdle(minutes: IdleMinutes): void
  setAllPlayers(on: boolean): void
  openLyricsFolder(): void
  setLaunchAtLogin(on: boolean): void
  setPlayer(patch: Partial<PlayerSettings>): void
  setLighting(patch: Partial<LightingSettings>): void
  setLightingPaused(paused: boolean): void
  openLightingSettings(): void
  quit(): void
}

const OFFSETS: { ms: number; label: string }[] = [
  { ms: -500, label: 'Words 0.5 s Earlier' },
  { ms: -250, label: 'Words 0.25 s Earlier' },
  { ms: 0, label: 'In Sync' },
  { ms: 250, label: 'Words 0.25 s Later' },
  { ms: 500, label: 'Words 0.5 s Later' },
  { ms: 750, label: 'Words 0.75 s Later (Bluetooth)' }
]

const LIGHT_BRIGHTNESS: { value: number; label: string }[] = [
  { value: 0.2, label: '20%' },
  { value: 0.3, label: '30%' },
  { value: 0.45, label: '45% (Default)' },
  { value: 0.65, label: '65%' },
  { value: 0.85, label: '85%' }
]

/** What the tray says audio capture is doing. Never claims Spotify-only capture in system mode. */
export function audioLine(audio: AudioStatus): string | null {
  if (audio.state === 'stopped') return null
  if (audio.state === 'starting') return 'Audio: starting…'
  if (audio.state === 'error') return 'Audio: unavailable, retrying'
  if (audio.state === 'waiting') return `Audio: ${audio.message || 'waiting'}`
  return audio.mode === 'process' ? 'Audio: Spotify only (experimental)' : 'Audio: all desktop audio (not Spotify only)'
}
const ANIMATION_LABELS: Record<Settings['animation'], string> = { low: 'Subtle', medium: 'Standard', high: 'Expressive' }
const LYRIC_SCALE_LABELS = ['Small', 'Default', 'Large', 'Extra Large']
const frameRateLabel = (fps: number): string => (fps === 0 ? 'Match Display' : `${fps} FPS`)

const IDLE: { minutes: IdleMinutes; label: string }[] = [
  { minutes: 0, label: 'Never' },
  { minutes: 1, label: 'After 1 Minute' },
  { minutes: 2, label: 'After 2 Minutes' },
  { minutes: 5, label: 'After 5 Minutes' }
]

/** Windows menus treat "&" as a shortcut marker; titles like "Simon & Garfunkel" need it doubled. */
const menuText = (s: string, max = 48): string => {
  const cut = s.length > max ? `${s.slice(0, max - 1)}…` : s
  return cut.replace(/&/g, '&&')
}

export function statusLine(m: Pick<TrayModel, 'track' | 'lyricsStatus' | 'health'>): string {
  if (!m.health.ok) return '⚠ Cannot read what is playing'
  const t = m.track
  if (!t || !t.title) return 'Nothing playing'
  const song = t.artist ? `${t.title} — ${t.artist}` : t.title
  switch (m.lyricsStatus) {
    case 'searching':
      return `Finding lyrics… ${song}`
    case 'found':
      return `♪ ${song}`
    case 'instrumental':
      return `${song} (instrumental)`
    case 'error':
      return `Lyrics service busy, retrying… ${song}`
    case 'not-found':
      return `No synced lyrics for ${song}`
    default:
      return song
  }
}

/** The theaestheticslyrics tray icon and its menu (Windows' counterpart to Verci's menu bar dropdown). */
export class TrayMenu {
  private readonly tray: Tray
  private model: TrayModel | null = null
  private pending: NodeJS.Timeout | null = null
  private readonly swatches = new Map<string, NativeImage>()

  constructor(
    iconPath: string,
    private readonly actions: TrayActions
  ) {
    this.tray = new Tray(iconPath)
    this.tray.setToolTip('LUMINA')
    this.tray.on('click', () => this.tray.popUpContextMenu())
  }

  update(model: TrayModel): void {
    this.model = model
    if (this.pending) return
    this.pending = setTimeout(() => {
      this.pending = null
      this.rebuild()
    }, 60)
  }

  balloon(title: string, content: string): void {
    this.tray.displayBalloon({ title, content, iconType: 'info', noSound: true })
  }

  popUp(): void {
    this.tray.popUpContextMenu()
  }

  destroy(): void {
    if (this.pending) clearTimeout(this.pending)
    this.tray.destroy()
  }

  private swatch(hex: string): NativeImage {
    let img = this.swatches.get(hex)
    if (!img) {
      img = nativeImage.createFromBitmap(swatchBitmap(hex, 16), { width: 16, height: 16, scaleFactor: 1 })
      const hi = nativeImage.createFromBitmap(swatchBitmap(hex, 32), { width: 32, height: 32, scaleFactor: 1 })
      img.addRepresentation({ scaleFactor: 2, width: 32, height: 32, dataURL: hi.toDataURL() })
      this.swatches.set(hex, img)
    }
    return img
  }

  /** The LUMINA Lighting submenu. */
  private lightingMenu(m: TrayModel): MenuItemConstructorOptions {
    const s = m.settings
    const a = this.actions
    const l = m.lighting
    const radio = (label: string, checked: boolean, click: () => void): MenuItemConstructorOptions => ({ label, type: 'radio', checked, click })
    const status = audioLine(l.audio)
    const edgeLine = s.edgeLighting
      ? l.edgeShowing > 0
        ? `Edge lighting on ${l.edgeShowing} display${l.edgeShowing > 1 ? 's' : ''}`
        : `Edge lighting held: ${l.edgeHeldBy ?? 'starting'}`
      : null
    return {
      label: 'LUMINA Lighting',
      submenu: [
        ...(status ? [{ label: status, enabled: false }] : []),
        ...(edgeLine ? [{ label: menuText(edgeLine, 60), enabled: false }] : []),
        {
          label: 'Enable Desktop Lighting',
          type: 'checkbox',
          checked: s.edgeLighting,
          click: (item) => a.setLighting({ edgeLighting: item.checked })
        },
        {
          label: 'Fullscreen Player Lighting',
          type: 'checkbox',
          checked: s.fullscreenLighting,
          click: (item) => a.setLighting({ fullscreenLighting: item.checked })
        },
        { label: 'Lighting Mode', submenu: LIGHTING_MODES.map((mode) => radio(LIGHTING_MODE_LABELS[mode], s.lightingMode === mode, () => a.setLighting({ lightingMode: mode }))) },
        {
          label: 'Brightness',
          submenu: LIGHT_BRIGHTNESS.map((b) =>
            radio(b.label, Math.abs(s.lightingBrightness - b.value) < 0.001, () => a.setLighting({ lightingBrightness: b.value }))
          )
        },
        {
          label: 'Select Monitor',
          submenu: [
            radio('Primary Display', s.edgeDisplays === 'primary', () => a.setLighting({ edgeDisplays: 'primary' })),
            radio('All Displays', s.edgeDisplays === 'all', () => a.setLighting({ edgeDisplays: 'all' })),
            ...m.displays.map((d) => radio(menuText(d.label), s.edgeDisplays === d.id, () => a.setLighting({ edgeDisplays: d.id })))
          ]
        },
        { type: 'separator' },
        {
          // Emergency off: hides every edge window and stops capture at once, until resumed.
          label: 'Pause Lighting',
          type: 'checkbox',
          checked: l.paused,
          click: (item) => a.setLightingPaused(item.checked)
        },
        { label: 'Lighting Settings…', click: () => a.openLightingSettings() }
      ]
    }
  }

  private rebuild(): void {
    const m = this.model
    if (!m) return
    const s = m.settings
    const a = this.actions
    const radio = (label: string, checked: boolean, click: () => void): MenuItemConstructorOptions => ({
      label,
      type: 'radio',
      checked,
      click
    })

    const template: MenuItemConstructorOptions[] = [
      { label: 'LUMINA', enabled: false },
      { label: menuText(statusLine(m), 60), enabled: false },
      { type: 'separator' },
      {
        label: 'Display',
        submenu: [
          radio('Primary Display', s.displayId === null, () => a.setDisplay(null)),
          ...m.displays.map((d) => radio(menuText(d.label), s.displayId === d.id, () => a.setDisplay(d.id)))
        ]
      },
      {
        label: 'Full-Screen View',
        submenu: [
          radio('LUMINA Player', s.layout === 'player', () => a.setPlayer({ layout: 'player' })),
          radio(`Lyrics Only (${STYLE_LABELS[s.style]})`, s.layout === 'lyrics', () => a.setPlayer({ layout: 'lyrics' }))
        ]
      },
      {
        label: 'Style',
        submenu: STYLE_IDS.map((id) => radio(STYLE_LABELS[id], s.style === id, () => a.setStyle(id)))
      },
      {
        label: 'Player',
        submenu: [
          {
            label: 'Animation',
            submenu: ANIMATION_CHOICES.map((v) =>
              radio(ANIMATION_LABELS[v], s.animation === v, () => a.setPlayer({ animation: v }))
            )
          },
          {
            label: 'Lyric Size',
            submenu: LYRIC_SCALE_CHOICES.map((v, i) =>
              radio(LYRIC_SCALE_LABELS[i] ?? String(v), s.lyricScale === v, () => a.setPlayer({ lyricScale: v }))
            )
          },
          {
            label: 'Reduce Motion',
            type: 'checkbox',
            checked: s.reducedMotion,
            click: (item) => a.setPlayer({ reducedMotion: item.checked })
          }
        ]
      },
      {
        label: 'Show Lyrics',
        submenu: [
          radio('On the Lock Screen', s.showOn === 'lock', () => a.setShowOn('lock')),
          radio('Always', s.showOn === 'always', () => a.setShowOn('always'))
        ]
      },
      {
        label: s.lockOnReturn ? 'Lock with Lyrics' : 'Show Lyrics Screen (Esc closes)',
        accelerator: m.hotkeyOk ? 'CommandOrControl+Alt+L' : undefined,
        registerAccelerator: false,
        click: () => a.showNow()
      },
      {
        label: 'Lock Windows When I Come Back',
        type: 'checkbox',
        checked: s.lockOnReturn,
        click: (item) => a.setLockOnReturn(item.checked)
      },
      { type: 'separator' },
      { label: 'Color', enabled: false },
      { label: 'Auto Sync', type: 'checkbox', checked: s.autoSync, click: (item) => a.setAutoSync(item.checked) },
      { label: 'Lyric Text…', icon: this.swatch(m.palette.lyric), click: () => a.editColors('lyric') },
      { label: 'Highlight…', icon: this.swatch(m.palette.highlight), click: () => a.editColors('highlight') },
      { label: 'Secondary Text…', icon: this.swatch(m.palette.secondary), click: () => a.editColors('secondary') },
      { label: 'Reset Colors', click: () => a.resetColors() },
      { type: 'separator' },
      { label: 'Timing', submenu: OFFSETS.map((o) => radio(o.label, s.offsetMs === o.ms, () => a.setOffset(o.ms))) },
      {
        label: 'Precise Word Timing (NetEase)',
        type: 'checkbox',
        checked: s.wordLevel,
        click: (item) => a.setWordLevel(item.checked)
      },
      this.lightingMenu(m),
      {
        label: 'Frame Rate Limit',
        submenu: FRAME_RATE_CHOICES.map((v) =>
          radio(frameRateLabel(v), s.frameRateCap === v, () => a.setPlayer({ frameRateCap: v }))
        )
      },
      {
        label: 'Lyrics Screen When Idle',
        submenu: IDLE.map((o) => radio(o.label, s.idleMinutes === o.minutes, () => a.setIdle(o.minutes)))
      },
      {
        label: 'Players',
        submenu: [
          radio('Spotify and Apple Music', !s.allPlayers, () => a.setAllPlayers(false)),
          radio('All Media Apps (browsers too)', s.allPlayers, () => a.setAllPlayers(true))
        ]
      },
      { type: 'separator' },
      { label: 'Open Lyrics Folder', click: () => a.openLyricsFolder() },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: s.launchAtLogin,
        enabled: m.canLaunchAtLogin,
        click: (item) => a.setLaunchAtLogin(item.checked)
      },
      { type: 'separator' },
      { label: 'Quit LUMINA', click: () => a.quit() }
    ]

    this.tray.setContextMenu(Menu.buildFromTemplate(template))
    const tip = m.track?.title ? `LUMINA — ${m.track.title}${m.track.artist ? ` · ${m.track.artist}` : ''}` : 'LUMINA'
    this.tray.setToolTip(tip.length > 120 ? `${tip.slice(0, 119)}…` : tip)
  }
}
