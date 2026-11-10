import { existsSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { app, globalShortcut, nativeImage, screen, shell, type NativeImage } from 'electron'
import type { AudioAnalysisFrame, AudioStatus } from '@shared/audio-frame'
import type { ColorsState, EdgeState, LightingPanelState } from '@shared/ipc'
import { usesAudio, type AmbientPalette, type LightingConfig, type LightingSettings } from '@shared/lighting'
import { DEFAULT_COLORS } from '@shared/palette-defaults'
import type { LyricsStatus, Palette, PlaybackAnchor, PlayerConfig, TimedLyrics, TrackInfo } from '@shared/types'
import { AudioService } from './audio/audio-service'
import { createAudioWorker } from './audio/create-worker'
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
import { EdgeController } from './ui/edge-controller'
import { EDGE_IDLE_HIDE_MS, edgeHold } from './ui/edge-logic'
import { FullscreenWatcher } from './ui/fullscreen-watcher'
import { LightingWindow } from './ui/lighting-window'
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
  /** Started with Windows (--autostart). */
  autostart?: boolean
}

export interface DebugOptions {
  captureAfterMs?: number
  captureFile?: string
  openLockAfterMs?: number
  returnAfterMs?: number
  colorsCaptureFile?: string
  quitAfterMs?: number
  /** Saves the LUMINA Lighting window. */
  lightingCaptureFile?: string
  /** Logs edge window handles and bounds (for style and click-through probes). */
  edgeProbeAfterMs?: number
  /** Writes renderer and process performance numbers gathered over `perfWindowMs`. */
  perfAfterMs?: number
  perfWindowMs?: number
  perfFile?: string
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
  private audio!: AudioService
  private edge!: EdgeController
  private fullscreen!: FullscreenWatcher
  private lightingWin!: LightingWindow
  /** Tray → Pause Lighting: everything stops until resumed (not saved). */
  private lightingPaused = false
  /** Started with Windows while "Start Edge Lighting with Windows" is off. */
  private edgeSuppressed = false
  private lastPlayedAt = Number.NEGATIVE_INFINITY
  private edgeIdleTimer: NodeJS.Timeout | null = null
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
    const features = app.getGPUFeatureStatus()
    this.log(`gpu: compositing ${compositing || 'unknown'}, webgl2 ${features.webgl2 ?? 'unknown'}, rasterization ${features.rasterization ?? 'unknown'}`)
    if (!this.gpu) this.log('gpu: no GPU compositing, the player and edge lighting use their lightweight look')
    this.edgeSuppressed = !!this.launch.autostart && !this.settings.get().edgeAtStartup
    this.power = new PowerKeeper(this.log)
    this.stage = new StageController({
      log: this.log,
      settings: () => this.settings.get(),
      lockWorkstation: () => lockWorkstation(this.log),
      onLockChange: () => this.refreshLighting()
    })
    const helperOk = existsSync(this.paths.helperExe)
    if (!helperOk) this.log(`audio: helper not found at ${this.paths.helperExe} (run "npm run build:helper"); lighting runs without audio`)
    this.audio = new AudioService({
      createWorker: (source) => {
        if (!helperOk) throw new Error('lumina-helper.exe is missing')
        return createAudioWorker(this.paths.helperExe, source)
      },
      log: this.log
    })
    this.audio.setSource(this.settings.get().audioSource)
    this.audio.on('frame', (frame) => this.onAudioFrame(frame))
    this.audio.on('status', (status) => this.onAudioStatus(status))
    this.edge = new EdgeController({ log: this.log, onShowingChange: () => this.onEdgeShowing() })
    this.fullscreen = new FullscreenWatcher(this.paths.helperExe, this.log)
    this.fullscreen.on('change', (info) => {
      this.log(`fullscreen: ${info.active ? `another app fills a monitor${info.monitor ? ` (${info.monitor.width}×${info.monitor.height} at ${info.monitor.x},${info.monitor.y})` : ''}` : 'none'}`)
      this.edge.setFullscreen(info)
      this.pushLighting()
    })
    this.lightingWin = new LightingWindow({
      log: this.log,
      iconPath: this.paths.appIcon,
      state: () => this.lightingState(),
      update: (patch) => this.updateLighting(patch),
      setPaused: (paused) => this.setLightingPaused(paused)
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
    if (this.edgeIdleTimer) clearTimeout(this.edgeIdleTimer)
    this.audio?.dispose()
    this.fullscreen?.dispose()
    this.edge?.dispose()
    this.lightingWin?.destroy()
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
    if (anchor.playing || changedPlaying) this.lastPlayedAt = Date.now()
    this.stage.updateAnchor(anchor)
    if (changedPlaying) this.refresh()
  }

  // ---------- LUMINA Lighting ----------

  private onAudioFrame(frame: AudioAnalysisFrame): void {
    this.stage.sendAudio(frame)
    this.edge.sendAudio(frame)
  }

  private onAudioStatus(status: AudioStatus): void {
    this.log(`audio: ${status.state}${status.mode ? ` (${status.mode === 'process' ? 'Spotify only' : 'all system audio'})` : ''}${status.message ? `: ${status.message}` : ''}`)
    this.pushLighting()
  }

  private onEdgeShowing(): void {
    this.updateAudioWanted()
    this.pushLighting()
  }

  /** The lighting config windows draw with (mode 'off' while paused). */
  private lightingConfig(s: Settings = this.settings.get()): LightingConfig {
    return {
      mode: this.lightingPaused ? 'off' : s.lightingMode,
      brightness: s.lightingBrightness,
      sensitivity: s.audioSensitivity,
      bassStrength: s.bassStrength,
      smoothing: s.lightingSmoothing,
      glowRadius: s.glowRadius,
      edgeThickness: s.edgeThickness,
      edgeSpread: s.edgeSpread,
      edgeSoftness: s.edgeSoftness,
      edges: { ...s.edgeSides },
      playerEdgeGlow: s.playerEdgeGlow,
      fps: s.lightingFps,
      reducedMotion: s.reducedMotion,
      gpu: this.gpu
    }
  }

  private edgeIdleMs(): number {
    if (this.anchor?.playing) return 0
    return Number.isFinite(this.lastPlayedAt) ? Date.now() - this.lastPlayedAt : Number.POSITIVE_INFINITY
  }

  private edgeHeldBy(s: Settings = this.settings.get()): string | null {
    return edgeHold({
      enabled: s.edgeLighting,
      modeOff: s.lightingMode === 'off',
      paused: this.lightingPaused,
      suppressed: this.edgeSuppressed,
      lyricsScreenOpen: this.stage.lockOpen,
      idleMs: this.edgeIdleMs()
    })
  }

  /** Re-evaluates edge windows, the full-screen watcher and audio capture. */
  private refreshLighting(): void {
    const s = this.settings.get()
    const held = this.edgeHeldBy(s)
    const state: EdgeState = { lighting: this.lightingConfig(s), ambient: this.ambient() }
    this.edge.update(held === null, s.edgeDisplays, state)
    this.fullscreen.setEnabled(s.edgeLighting && s.pauseInFullscreen && !this.lightingPaused && held === null)
    if (!s.pauseInFullscreen) this.edge.setFullscreen({ active: false, monitor: null })
    // While paused, look again once the idle limit passes so edge lighting rests on time.
    if (this.edgeIdleTimer) clearTimeout(this.edgeIdleTimer)
    this.edgeIdleTimer = null
    if (held === null && !this.anchor?.playing) {
      const due = Math.max(1000, EDGE_IDLE_HIDE_MS - this.edgeIdleMs() + 500)
      this.edgeIdleTimer = setTimeout(() => this.refreshLighting(), due)
    }
    this.updateAudioWanted()
    this.pushLighting()
  }

  /** Audio runs only while a visible consumer needs it and music plays (or just paused). */
  private updateAudioWanted(): void {
    const s = this.settings.get()
    const audible = usesAudio(s.lightingMode) && !this.lightingPaused
    const player = this.stage.lockOpen && s.layout === 'player' && s.fullscreenLighting
    const edge = this.edge.showingCount > 0
    const recent = this.edgeIdleMs() < 15_000
    this.audio.setWanted(audible && (player || edge) && recent)
  }

  private updateLighting(patch: Partial<LightingSettings>): void {
    // Turning edge lighting on by hand overrides "not started with Windows".
    if (patch.edgeLighting) this.edgeSuppressed = false
    this.settings.update(patch)
  }

  private setLightingPaused(paused: boolean): void {
    if (paused === this.lightingPaused) return
    this.lightingPaused = paused
    this.log(`lighting: ${paused ? 'paused' : 'resumed'}`)
    if (paused) this.edge.hideAll()
    this.refresh()
  }

  private lightingState(): LightingPanelState {
    const s = this.settings.get()
    const picked = {} as Record<string, unknown>
    for (const key of Object.keys(s) as (keyof Settings)[]) picked[key] = s[key]
    return {
      settings: picked as unknown as LightingSettings,
      displays: this.displayChoices(),
      audio: this.audio.status,
      edgeShowing: this.edge.showingCount,
      edgeHeldBy: this.edgeHeldBy(s),
      paused: this.lightingPaused,
      gpu: this.gpu
    }
  }

  private pushLighting(): void {
    this.lightingWin.push(this.lightingState())
    this.refreshTray()
  }

  private displayChoices(): { id: number; label: string }[] {
    return screen.getAllDisplays().map((d, i) => ({
      id: d.id,
      label: `${d.label || `Display ${i + 1}`} (${d.size.width}×${d.size.height})`
    }))
  }

  private ambient(): AmbientPalette {
    return this.albumAmbient ?? ambientFromPalette(this.palette())
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
    this.audio.setSource(s.audioSource)
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

  private readonly onDisplays = (): void => this.pushLighting()

  private palette(): Palette {
    const s = this.settings.get()
    return s.autoSync && this.albumPalette ? this.albumPalette : paletteFromColors(s.colors)
  }

  private playerConfig(): PlayerConfig {
    const s = this.settings.get()
    return {
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
        frameRateCap: s.frameRateCap,
        lighting: { ...this.lightingConfig(s), mode: s.fullscreenLighting && !this.lightingPaused ? s.lightingMode : 'off' }
      },
      { playing, hasLyrics }
    )
    this.power.update(playing && hasLyrics)
    this.colors.push(this.colorsState())
    this.refreshLighting()
  }

  private refreshTray(): void {
    this.tray.update({
      track: this.track,
      lyricsStatus: this.status,
      health: this.health,
      settings: this.settings.get(),
      palette: this.palette(),
      displays: this.displayChoices(),
      canLaunchAtLogin: app.isPackaged,
      hotkeyOk: this.hotkeyOk,
      lighting: {
        paused: this.lightingPaused,
        audio: this.audio.status,
        edgeShowing: this.edge.showingCount,
        edgeHeldBy: this.edgeHeldBy()
      }
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
      setLighting: (patch) => this.updateLighting(patch),
      setLightingPaused: (paused) => this.setLightingPaused(paused),
      openLightingSettings: () => this.lightingWin.open(),
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
    if (d.lightingCaptureFile) {
      const file = d.lightingCaptureFile
      this.later(1000, () => this.lightingWin.open())
      this.later(3000, () => {
        void this.lightingWin.capture(file).then((ok) => this.log(ok ? `capture: saved ${file}` : 'capture: lighting window not visible'))
      })
    }
    if (d.edgeProbeAfterMs !== undefined) {
      this.later(d.edgeProbeAfterMs, () => {
        for (const h of this.edge.handles()) this.log(`edge-probe: display ${h.displayId} hwnd ${h.hwnd} bounds ${JSON.stringify(h.bounds)}`)
      })
    }
    if (d.perfAfterMs !== undefined && d.perfFile) {
      const file = d.perfFile
      const windowMs = d.perfWindowMs ?? 20_000
      this.later(d.perfAfterMs, () => void this.measure(windowMs, file))
    }
    if (d.quitAfterMs !== undefined) this.later(d.quitAfterMs, () => app.quit())
  }

  /**
   * Debug: measures the running app for `windowMs` and writes JSON — renderer frame timing (from
   * the pages' own counters), main-thread event-loop delay, per-process CPU and memory.
   */
  private async measure(windowMs: number, file: string): Promise<void> {
    const loop = monitorEventLoopDelay({ resolution: 10 })
    loop.enable()
    const frames0 = this.audio.framesSeen
    await this.stage.perfReset()
    await this.edge.perfReset()
    const samples: Electron.ProcessMetric[][] = []
    const tick = setInterval(() => samples.push(app.getAppMetrics()), 1000)
    await new Promise((r) => setTimeout(r, windowMs))
    clearInterval(tick)
    loop.disable()
    const ms = (ns: number): number => Math.round((ns / 1e6) * 100) / 100
    const byType = new Map<string, { cpu: number[]; mem: number[] }>()
    for (const sample of samples.slice(1)) {
      const sums = new Map<string, { cpu: number; mem: number }>()
      for (const m of sample) {
        const s = sums.get(m.type) ?? { cpu: 0, mem: 0 }
        s.cpu += m.cpu.percentCPUUsage
        s.mem += m.memory.workingSetSize / 1024
        sums.set(m.type, s)
      }
      for (const [type, s] of sums) {
        const entry = byType.get(type) ?? { cpu: [], mem: [] }
        entry.cpu.push(s.cpu)
        entry.mem.push(s.mem)
        byType.set(type, entry)
      }
    }
    const avg = (a: number[]): number => Math.round((a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)) * 100) / 100
    const report = {
      windowMs,
      audio: { status: this.audio.status, framesPerSecond: Math.round(((this.audio.framesSeen - frames0) / windowMs) * 10000) / 10 },
      mainEventLoopDelayMs: { mean: ms(loop.mean), p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) },
      processes: Object.fromEntries([...byType].map(([type, v]) => [type, { cpuPercent: avg(v.cpu), workingSetMB: avg(v.mem) }])),
      stage: await this.stage.perfRead(),
      edge: await this.edge.perfRead(),
      gpu: app.getGPUFeatureStatus()
    }
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, JSON.stringify(report, null, 2))
    this.log(`perf: saved ${file}`)
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
