import { app, globalShortcut, nativeImage, screen, shell, type NativeImage } from 'electron'
import type { ColorsState } from '@shared/ipc'
import type { AmbientPalette } from '@shared/lighting'
import { DEFAULT_COLORS } from '@shared/palette-defaults'
import type { LyricsStatus, Palette, PlaybackAnchor, PlayerConfig, TimedLyrics, TrackInfo } from '@shared/types'
import { lockWorkstation } from './lock'
import type { Log } from './logger'
import { LyricsCache } from './lyrics/cache'
import { LocalLyrics } from './lyrics/local'
import { LrclibClient } from './lyrics/lrclib'
import { NeteaseClient } from './lyrics/netease'
import { LyricsService, type LyricsResult } from './lyrics/service'
import { MediaWatcher, type ArtworkEvent } from './media/watcher'
import { ambientFromPalette, extractAmbient } from './palette/ambient'
import { extractPalette, paletteFromColors } from './palette/extract'
import type { AppPaths } from './paths'
import { PowerKeeper } from './power'
import { SettingsStore, type Settings } from './settings'
import { ColorsWindow } from './ui/colors-window'
import { StageController } from './ui/stage-controller'
import { TrayMenu, type PlayerSettings, type TrayActions } from './ui/tray'

export const HOTKEY = 'CommandOrControl+Alt+L'
/** LRCLIB asks every client to name itself and link to its homepage. */
const HOMEPAGE = 'https://github.com/darshanseenivasakumar/theaestheticslyrics'
/** Players publish title/artist/album in steps; wait for them to settle before looking up lyrics. */
const TRACK_SETTLE_MS = 350
const ERROR_RETRY_MS = 2 * 60 * 1000
/** The player shows art at up to ~40% of a 1440p screen; larger covers are scaled down to this. */
const ARTWORK_MAX_SIDE = 1024

export interface LaunchOptions {
  /** Opened by the user (desktop icon, Start menu): show the lyrics right away. */
  showLyricsOnLaunch?: boolean
}

export interface DebugOptions {
  captureAfterMs?: number
  captureFile?: string
  openLockAfterMs?: number
  returnAfterMs?: number
  colorsCaptureFile?: string
  quitAfterMs?: number
}

/** Wires media → lyrics → palette → stage/tray/power. One instance per app run. */
export class AppController {
  private settings!: SettingsStore
  private watcher!: MediaWatcher
  private lyrics!: LyricsService
  private local!: LocalLyrics
  private stage!: StageController
  private tray!: TrayMenu
  private colors!: ColorsWindow
  private power!: PowerKeeper
  private track: TrackInfo | null = null
  private anchor: PlaybackAnchor | null = null
  private timed: TimedLyrics | null = null
  private status: LyricsStatus = 'idle'
  private albumPalette: Palette | null = null
  private albumAmbient: AmbientPalette | null = null
  /** Chromium composites on the GPU; without it the player drops its costlier effects. */
  private gpu = true
  private health: { ok: boolean; message?: string } = { ok: true }
  private hotkeyOk = false
  private lookupToken = 0
  private loginItemApplied: boolean | null = null
  private lastWordLevel = true
  private readonly timers = new Set<NodeJS.Timeout>()

  constructor(
    private readonly paths: AppPaths,
    private readonly log: Log,
    private readonly debug: DebugOptions = {},
    private readonly launch: LaunchOptions = {}
  ) {}

  async start(): Promise<void> {
    this.settings = new SettingsStore(this.paths.settingsFile)
    this.local = new LocalLyrics(this.paths.lyricsDir)
    // Startup never waits on the folder: lookups simply find no files until it exists.
    void this.local.ensureDir().catch((err: unknown) => this.log(`lyrics: cannot create folder (${String(err)})`))
    this.lyrics = new LyricsService({
      local: this.local,
      cache: new LyricsCache(this.paths.cacheDir),
      client: new LrclibClient({ userAgent: `theaestheticslyrics/${app.getVersion()} (${HOMEPAGE})` }),
      log: this.log,
      wordLevel: { client: new NeteaseClient(), enabled: () => this.settings.get().wordLevel }
    })
    this.lastWordLevel = this.settings.get().wordLevel
    const compositing = app.getGPUFeatureStatus().gpu_compositing ?? ''
    this.gpu = compositing.startsWith('enabled')
    if (!this.gpu) this.log(`gpu: compositing is ${compositing || 'unknown'}, the player uses its lightweight look`)
    this.power = new PowerKeeper(this.log)
    this.stage = new StageController({
      log: this.log,
      settings: () => this.settings.get(),
      lockWorkstation: () => lockWorkstation(this.log)
    })
    this.colors = new ColorsWindow({
      log: this.log,
      iconPath: this.paths.appIcon,
      state: () => this.colorsState(),
      setColor: (role, hex) => this.settings.update({ autoSync: false, colors: { ...this.settings.get().colors, [role]: hex } }),
      setAutoSync: (autoSync) => this.settings.update({ autoSync }),
      reset: () => this.settings.update({ colors: { ...DEFAULT_COLORS } })
    })
    this.tray = new TrayMenu(this.paths.trayIcon, this.trayActions())

    this.hotkeyOk = globalShortcut.register(HOTKEY, () => void this.stage.openLock('hotkey'))
    if (!this.hotkeyOk) this.log(`hotkey: ${HOTKEY} is already used by another app`)

    this.watcher = new MediaWatcher({
      scriptPath: this.paths.bridgeScript,
      log: this.log,
      allPlayers: () => this.settings.get().allPlayers
    })
    this.watcher.on('track', (t) => this.onTrack(t))
    this.watcher.on('anchor', (a) => this.onAnchor(a))
    this.watcher.on('artwork', (art) => this.onArtwork(art))
    this.watcher.on('health', (h) => {
      this.health = h
      this.refreshTray()
    })
    this.settings.onChange((s) => this.onSettings(s))
    screen.on('display-added', this.onDisplays)
    screen.on('display-removed', this.onDisplays)

    this.applyLoginItem(this.settings.get())
    this.watcher.start()
    this.refresh()
    this.log(`app: started ${app.getVersion()} (data: ${this.paths.userData})`)

    // Opened from the desktop icon: show the lyrics now (they fill in as soon as they are found).
    // Otherwise, load the lyrics screen in the background so Ctrl+Alt+L opens it instantly.
    if (this.launch.showLyricsOnLaunch) void this.stage.showLyrics()
    else this.stage.prewarm()

    if (!this.settings.get().welcomed) {
      this.tray.balloon(
        'LUMINA is running',
        'Play something in Spotify or Apple Music, then press Ctrl+Alt+L for full-screen lyrics (Esc closes). All settings are in the tray icon.'
      )
      this.settings.update({ welcomed: true })
    }
    this.scheduleDebug()
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    screen.removeListener('display-added', this.onDisplays)
    screen.removeListener('display-removed', this.onDisplays)
    globalShortcut.unregisterAll()
    this.watcher?.stop()
    this.stage?.dispose()
    this.power?.dispose()
    this.colors?.destroy()
    this.tray?.destroy()
  }

  /** theaestheticslyrics was opened again (e.g. its desktop icon) while already running: show the lyrics. */
  showLyrics(): void {
    void this.stage?.showLyrics()
  }

  private later(ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      this.timers.delete(t)
      fn()
    }, ms)
    this.timers.add(t)
  }

  private onTrack(track: TrackInfo | null): void {
    this.track = track
    this.timed = null
    this.albumPalette = null
    this.albumAmbient = null
    this.anchor = null
    this.stage.setArtwork(null)
    const token = ++this.lookupToken
    this.status = track?.title ? 'searching' : 'idle'
    this.log(
      track
        ? `track: "${track.title}" by ${track.artist || 'unknown'} [${track.app}] ${Math.round(track.durationMs / 1000)}s`
        : 'track: none'
    )
    if (track?.title) {
      this.later(TRACK_SETTLE_MS, () => void this.lookup(track, token))
      const art = this.watcher.artworkFor(track.key)
      if (art) this.onArtwork(art)
    }
    this.refresh()
  }

  private async lookup(track: TrackInfo, token: number): Promise<void> {
    if (token !== this.lookupToken) return
    let result: LyricsResult
    try {
      result = await this.lyrics.get({
        title: track.title,
        artist: track.artist,
        album: track.album,
        durationMs: track.durationMs
      })
    } catch (err) {
      this.log(`lyrics: lookup failed (${String(err)})`)
      result = { status: 'error', lyrics: null }
    }
    if (token !== this.lookupToken) return
    this.status = result.status
    this.timed = result.lyrics
    const detail = result.lyrics ? `, ${result.lyrics.lines.length} lines, ${result.lyrics.wordTiming} word timing` : ''
    this.log(`lyrics: ${result.status}${result.source ? ` (${result.source})` : ''}${detail}`)
    if (result.status === 'error') this.later(ERROR_RETRY_MS, () => void this.lookup(track, token))
    this.refresh()
  }

  private onAnchor(anchor: PlaybackAnchor): void {
    const changedPlaying = this.anchor?.playing !== anchor.playing
    this.anchor = anchor
    this.stage.updateAnchor(anchor)
    if (changedPlaying) this.refresh()
  }

  private onArtwork(art: ArtworkEvent): void {
    if (!this.track || art.key !== this.track.key) return
    try {
      const image = nativeImage.createFromBuffer(art.data)
      if (image.isEmpty()) {
        this.log(`artwork: could not decode ${art.mime} (${art.data.length} bytes)`)
        return
      }
      const { width: artWidth, height: artHeight } = image.getSize()
      this.log(`artwork: ${artWidth}×${artHeight} ${art.mime}`)
      const small = image.resize({ width: 64, height: 64, quality: 'good' })
      const { width, height } = small.getSize()
      const bitmap = small.toBitmap()
      this.albumPalette = extractPalette(bitmap, width, height)
      this.albumAmbient = extractAmbient(bitmap, width, height)
      this.stage.setArtwork({ trackKey: art.key, dataUrl: artworkDataUrl(image) })
    } catch (err) {
      this.log(`palette: could not read album art (${String(err)})`)
      return
    }
    // The player's ambient light follows the new art even when the lyric colours do not.
    this.refresh()
  }

  private onSettings(s: Settings): void {
    this.applyLoginItem(s)
    this.watcher.refreshPolicy()
    this.stage.settingsChanged()
    if (s.wordLevel !== this.lastWordLevel) {
      this.lastWordLevel = s.wordLevel
      // Switching the word-timing source re-fetches the current song's lyrics.
      if (this.track?.title) {
        this.status = 'searching'
        void this.lookup(this.track, ++this.lookupToken)
      }
    }
    this.refresh()
  }

  private readonly onDisplays = (): void => this.refreshTray()

  private palette(): Palette {
    const s = this.settings.get()
    return s.autoSync && this.albumPalette ? this.albumPalette : paletteFromColors(s.colors)
  }

  private playerConfig(): PlayerConfig {
    const s = this.settings.get()
    return {
      ambient: s.ambient,
      brightness: s.ambientBrightness,
      animation: s.animation,
      reducedMotion: s.reducedMotion,
      lyricScale: s.lyricScale,
      gpu: this.gpu
    }
  }

  private colorsState(): ColorsState {
    const s = this.settings.get()
    return { autoSync: s.autoSync, colors: { ...s.colors }, effective: this.palette() }
  }

  private refresh(): void {
    const s = this.settings.get()
    const playing = this.anchor?.playing ?? false
    const hasLyrics = this.status === 'found' && this.timed !== null
    const palette = this.palette()
    this.stage.update(
      {
        track: this.track,
        lyrics: hasLyrics ? this.timed : null,
        lyricsStatus: this.status,
        ambient: this.albumAmbient ?? ambientFromPalette(palette),
        style: s.style,
        palette,
        offsetMs: s.offsetMs,
        layout: s.layout,
        player: this.playerConfig(),
        frameRateCap: s.frameRateCap
      },
      { playing, hasLyrics }
    )
    this.power.update(playing && hasLyrics)
    this.colors.push(this.colorsState())
    this.refreshTray()
  }

  private refreshTray(): void {
    this.tray.update({
      track: this.track,
      lyricsStatus: this.status,
      health: this.health,
      settings: this.settings.get(),
      palette: this.palette(),
      displays: screen.getAllDisplays().map((d, i) => ({
        id: d.id,
        label: `${d.label || `Display ${i + 1}`} (${d.size.width}×${d.size.height})`
      })),
      canLaunchAtLogin: app.isPackaged,
      hotkeyOk: this.hotkeyOk
    })
  }

  private applyLoginItem(s: Settings): void {
    if (!app.isPackaged || this.loginItemApplied === s.launchAtLogin) return
    // --autostart: starting with Windows stays quietly in the tray instead of opening the lyrics.
    app.setLoginItemSettings({ openAtLogin: s.launchAtLogin, path: process.execPath, args: ['--autostart'] })
    this.loginItemApplied = s.launchAtLogin
    this.log(`app: start with Windows ${s.launchAtLogin ? 'on' : 'off'}`)
  }

  private trayActions(): TrayActions {
    return {
      setStyle: (style) => this.settings.update({ style }),
      setShowOn: (showOn) => this.settings.update({ showOn }),
      setDisplay: (displayId) => this.settings.update({ displayId }),
      setAutoSync: (autoSync) => this.settings.update({ autoSync }),
      editColors: () => this.colors.open(),
      resetColors: () => this.settings.update({ colors: { ...DEFAULT_COLORS } }),
      showNow: () => void this.stage.openLock('hotkey'),
      setLockOnReturn: (lockOnReturn) => this.settings.update({ lockOnReturn }),
      setOffset: (offsetMs) => this.settings.update({ offsetMs }),
      setWordLevel: (wordLevel) => this.settings.update({ wordLevel }),
      setIdle: (idleMinutes) => this.settings.update({ idleMinutes }),
      setAllPlayers: (allPlayers) => this.settings.update({ allPlayers }),
      openLyricsFolder: () => {
        void this.local.ensureDir().then(() => shell.openPath(this.paths.lyricsDir))
      },
      setLaunchAtLogin: (launchAtLogin) => this.settings.update({ launchAtLogin }),
      setPlayer: (patch: Partial<PlayerSettings>) => this.settings.update(patch),
      quit: () => app.quit()
    }
  }

  private scheduleDebug(): void {
    const d = this.debug
    if (d.openLockAfterMs !== undefined) this.later(d.openLockAfterMs, () => void this.stage.openLock('hotkey'))
    if (d.captureAfterMs !== undefined && d.captureFile) {
      const file = d.captureFile
      this.later(d.captureAfterMs, () => {
        void this.stage.capture(file).then((ok) => this.log(ok ? `capture: saved ${file}` : 'capture: no stage window visible'))
      })
    }
    if (d.colorsCaptureFile) {
      const file = d.colorsCaptureFile
      this.later(1000, () => this.colors.open())
      this.later(3000, () => {
        void this.colors.capture(file).then((ok) => this.log(ok ? `capture: saved ${file}` : 'capture: colors window not visible'))
      })
    }
    if (d.returnAfterMs !== undefined) {
      this.later(d.returnAfterMs, () => {
        void this.stage.simulateReturn().then((sent) => this.log(`debug: simulated return ${sent ? 'sent' : 'skipped (no lock screen)'}`))
      })
    }
    if (d.quitAfterMs !== undefined) this.later(d.quitAfterMs, () => app.quit())
  }
}

/** Re-encodes album art for the player page: no larger than it is ever shown, as a JPEG data URL. */
function artworkDataUrl(image: NativeImage): string {
  const { width, height } = image.getSize()
  const scale = Math.min(1, ARTWORK_MAX_SIDE / Math.max(width, height))
  const sized =
    scale < 1 ? image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'best' }) : image
  return `data:image/jpeg;base64,${sized.toJPEG(92).toString('base64')}`
}
