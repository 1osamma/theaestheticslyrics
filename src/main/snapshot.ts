import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, nativeImage } from 'electron'
import { SILENT_FRAME, type AudioAnalysisFrame } from '@shared/audio-frame'
import { DEMO_LRC, DEMO_MOMENTS, DEMO_TRACK } from '@shared/demo-song'
import { IPC, type EdgeState, type StageState } from '@shared/ipc'
import type { LightingConfig } from '@shared/lighting'
import { DEFAULT_LYRICS, LYRIC_EFFECTS, type LyricsConfig } from '@shared/lyrics-style'
import { DEFAULT_PALETTE } from '@shared/palette-defaults'
import { STYLE_IDS, type Artwork, type Palette, type PlayerConfig, type ShowOn, type StyleId } from '@shared/types'
import { demoArtBitmap } from './demo-art'
import { makeDirSync } from './dirs'
import { ambientFromPalette, extractAmbient } from './palette/ambient'
import { parseLrc } from './lyrics/lrc'
import { buildTimedLyrics } from './lyrics/word-timing'
import { harden, loadPage, secureWebPreferences } from './ui/windows'

export interface SnapshotOptions {
  outDir: string
  width?: number
  height?: number
  styles?: readonly StyleId[]
  mode?: ShowOn
  palette?: Palette
  /** Also render the LUMINA player (with art, without art, nothing playing) and edge lighting. Default true. */
  player?: boolean
}

const SNAPSHOT_PLAYER: PlayerConfig = {
  lyrics: { ...DEFAULT_LYRICS },
  reducedMotion: false,
  lyricScale: 1,
  gpu: true
}

const DEMO_ART_SIZE = 600

/** The default LUMINA Lighting settings. */
const SNAPSHOT_LIGHTING: LightingConfig = {
  mode: 'hybrid',
  brightness: 0.45,
  sensitivity: 0.6,
  bassStrength: 0.55,
  smoothing: 0.7,
  glowRadius: 0.5,
  edgeThickness: 0.35,
  edgeSpread: 0.6,
  edgeSoftness: 0.7,
  edges: { left: true, right: true, top: false, bottom: true },
  playerEdgeGlow: false,
  fps: 60,
  reducedMotion: false,
  gpu: true
}

/** Synthetic analysis frames (no real audio in snapshot mode): a loud beat and a quiet passage. */
const LOUD_BEAT: AudioAnalysisFrame = {
  ...SILENT_FRAME,
  isSilent: false,
  rms: 0.85,
  bass: 0.95,
  mids: 0.7,
  treble: 0.55,
  transient: 0.8,
  beatPulse: 1,
  intensity: 0.9
}
const QUIET: AudioAnalysisFrame = { ...SILENT_FRAME, isSilent: false, rms: 0.15, bass: 0.1, mids: 0.2, treble: 0.1, intensity: 0.12 }

/**
 * Renders the demo song in every style (and the LUMINA player) offscreen and saves PNGs. Nothing appears on
 * screen, so it is safe to run while someone is using the PC.
 */
export async function runSnapshots(opts: SnapshotOptions): Promise<string[]> {
  const width = opts.width ?? 1536
  const height = opts.height ?? 864
  const lyrics = buildTimedLyrics(parseLrc(DEMO_LRC), DEMO_TRACK.durationMs)
  if (!lyrics) throw new Error('demo lyrics failed to parse')
  makeDirSync(opts.outDir)

  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    webPreferences: secureWebPreferences({ offscreen: true })
  })
  harden(win)
  win.webContents.setFrameRate(30)
  await loadPage(win, 'stage')

  const written: string[] = []
  let nextId = 1
  const waitDone = (id: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener(IPC.stageSnapshotDone, onDone)
        reject(new Error(`snapshot ${id} timed out`))
      }, 10_000)
      const onDone = (_e: unknown, doneId: number): void => {
        if (doneId !== id) return
        clearTimeout(timer)
        ipcMain.removeListener(IPC.stageSnapshotDone, onDone)
        resolve()
      }
      ipcMain.on(IPC.stageSnapshotDone, onDone)
    })

  const palette = opts.palette ?? { ...DEFAULT_PALETTE }
  const baseState = (style: StyleId, layout: StageState['config']['layout']): StageState => ({
    track: DEMO_TRACK,
    lyrics,
    lyricsStatus: 'found',
    ambient: ambientFromPalette(palette),
    config: {
      style,
      mode: opts.mode ?? 'lock',
      palette,
      offsetMs: 0,
      layout,
      player: SNAPSHOT_PLAYER,
      frameRateCap: 0,
      lighting: SNAPSHOT_LIGHTING
    }
  })
  const audio = (frame: AudioAnalysisFrame): void => win.webContents.send(IPC.lightingAudio, { ...frame, timestamp: Date.now() })

  const shoot = async (name: string, songMs: number, wallMs: number): Promise<void> => {
    const id = nextId++
    const done = waitDone(id)
    win.webContents.send(IPC.stageSnapshot, { id, songMs, wallMs })
    await done
    const image = await win.webContents.capturePage()
    const file = join(opts.outDir, `${name}.png`)
    writeFileSync(file, image.toPNG())
    written.push(file)
  }

  try {
    for (const style of opts.styles ?? STYLE_IDS) {
      win.webContents.send(IPC.stageState, baseState(style, 'lyrics'))
      for (const [i, songMs] of DEMO_MOMENTS.entries()) await shoot(`${style}-${i + 1}`, songMs, 3_000 + i * 2_300)
    }

    if (opts.player ?? true) {
      const artBitmap = demoArtBitmap(DEMO_ART_SIZE)
      const art = nativeImage.createFromBitmap(artBitmap, { width: DEMO_ART_SIZE, height: DEMO_ART_SIZE })
      const artwork: Artwork = { trackKey: DEMO_TRACK.key, dataUrl: `data:image/jpeg;base64,${art.toJPEG(92).toString('base64')}` }
      const ambient = extractAmbient(artBitmap, DEMO_ART_SIZE, DEMO_ART_SIZE) ?? ambientFromPalette(palette)
      const playing = (songMs: number): void =>
        win.webContents.send(IPC.stageAnchor, {
          trackKey: DEMO_TRACK.key,
          positionMs: songMs,
          atEpochMs: Date.now(),
          playing: true,
          rate: 1
        })

      win.webContents.send(IPC.stageArtwork, artwork)
      win.webContents.send(IPC.stageState, { ...baseState('ship', 'player'), ambient })
      for (const [i, songMs] of DEMO_MOMENTS.entries()) {
        playing(songMs)
        audio(i === 0 ? QUIET : LOUD_BEAT)
        await shoot(`player-${i + 1}`, songMs, 3_000 + i * 2_300)
      }
      // Hybrid lighting extremes: a quiet passage, and a kick drum with edge glow in the player.
      audio(QUIET)
      await shoot('player-quiet', DEMO_MOMENTS[1]!, 9_000)
      win.webContents.send(IPC.stageState, {
        ...baseState('ship', 'player'),
        ambient,
        config: { ...baseState('ship', 'player').config, lighting: { ...SNAPSHOT_LIGHTING, playerEdgeGlow: true } }
      })
      audio(LOUD_BEAT)
      await shoot('player-beat-edges', DEMO_MOMENTS[1]!, 10_000)
      win.webContents.send(IPC.stageState, { ...baseState('ship', 'player'), ambient })

      // LUMINA Lyrics: every word effect mid-line, then the alternative typography.
      const withLyrics = (lyrics: Partial<LyricsConfig>): StageState => {
        const base = baseState('ship', 'player')
        return { ...base, ambient, config: { ...base.config, player: { ...SNAPSHOT_PLAYER, lyrics: { ...DEFAULT_LYRICS, ...lyrics } } } }
      }
      audio(QUIET)
      for (const effect of LYRIC_EFFECTS) {
        win.webContents.send(IPC.stageState, withLyrics({ effect }))
        await shoot(`lyrics-${effect}`, DEMO_MOMENTS[1]! + 420, 12_000)
      }
      win.webContents.send(IPC.stageState, withLyrics({ align: 'center' }))
      await shoot('lyrics-centre', DEMO_MOMENTS[1]! + 420, 12_000)
      win.webContents.send(IPC.stageState, withLyrics({ font: 'fraunces' }))
      await shoot('lyrics-fraunces', DEMO_MOMENTS[1]! + 420, 12_000)
      win.webContents.send(IPC.stageState, withLyrics({ font: 'fraunces', align: 'center', color: 'album', spacing: 'airy' }))
      await shoot('lyrics-fraunces-centre-album', DEMO_MOMENTS[1]! + 420, 12_000)
      win.webContents.send(IPC.stageState, withLyrics({ font: 'manrope', weight: 800, intensity: 1, effect: 'expressive' }))
      await shoot('lyrics-manrope-expressive-max', DEMO_MOMENTS[1]! + 420, 12_000)
      win.webContents.send(IPC.stageState, { ...baseState('ship', 'player'), ambient })

      // No album art: the card falls back to a gradient and the light to the lyric colours.
      win.webContents.send(IPC.stageArtwork, null)
      win.webContents.send(IPC.stageState, baseState('ship', 'player'))
      await shoot('player-no-art', DEMO_MOMENTS[1]!, 6_000)

      // Nothing playing (Spotify closed).
      win.webContents.send(IPC.stageState, { ...baseState('ship', 'player'), track: null, lyrics: null, lyricsStatus: 'idle' })
      await shoot('player-idle', 0, 6_000)

      written.push(...(await snapshotEdge(opts.outDir, width, height, ambient.colors)))
    }
  } finally {
    win.destroy()
  }
  return written
}

/** Renders the transparent desktop edge lighting offscreen (PNG with alpha) at a loud beat. */
async function snapshotEdge(outDir: string, width: number, height: number, colors: string[]): Promise<string[]> {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: secureWebPreferences({ offscreen: true })
  })
  harden(win)
  try {
    await loadPage(win, 'edge')
    const state: EdgeState = { lighting: { ...SNAPSHOT_LIGHTING, brightness: 0.65 }, ambient: { colors, source: 'album' } }
    win.webContents.send(IPC.edgeState, state)
    win.webContents.send(IPC.lightingAudio, { ...LOUD_BEAT, timestamp: Date.now() })
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('edge snapshot timed out')), 10_000)
      ipcMain.once(IPC.stageSnapshotDone, () => {
        clearTimeout(timer)
        resolve()
      })
    })
    win.webContents.send(IPC.stageSnapshot, { id: 1, songMs: 0, wallMs: 4_000 })
    await done
    const file = join(outDir, 'edge-lighting.png')
    writeFileSync(file, (await win.webContents.capturePage()).toPNG())
    // The same light over a dark desktop, blended by Chromium as Windows will: an easy-to-view preview.
    await win.webContents.executeJavaScript("document.body.style.background = '#14161c'")
    await new Promise((r) => setTimeout(r, 200))
    const preview = join(outDir, 'edge-lighting-preview.png')
    writeFileSync(preview, (await win.webContents.capturePage()).toPNG())
    return [file, preview]
  } finally {
    win.destroy()
  }
}
