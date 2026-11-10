import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow, ipcMain, nativeImage } from 'electron'
import { DEMO_LRC, DEMO_MOMENTS, DEMO_TRACK } from '@shared/demo-song'
import { IPC, type StageState } from '@shared/ipc'
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
  /** Also render the LUMINA player (with art, without art, and with nothing playing). Default true. */
  player?: boolean
}

const SNAPSHOT_PLAYER: PlayerConfig = {
  ambient: true,
  brightness: 0.7,
  animation: 'medium',
  reducedMotion: false,
  lyricScale: 1,
  gpu: true
}

const DEMO_ART_SIZE = 600

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
    config: { style, mode: opts.mode ?? 'lock', palette, offsetMs: 0, layout, player: SNAPSHOT_PLAYER, frameRateCap: 0 }
  })

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
        await shoot(`player-${i + 1}`, songMs, 3_000 + i * 2_300)
      }

      // No album art: the card falls back to a gradient and the light to the lyric colours.
      win.webContents.send(IPC.stageArtwork, null)
      win.webContents.send(IPC.stageState, baseState('ship', 'player'))
      await shoot('player-no-art', DEMO_MOMENTS[1]!, 6_000)

      // Nothing playing (Spotify closed).
      win.webContents.send(IPC.stageState, { ...baseState('ship', 'player'), track: null, lyrics: null, lyricsStatus: 'idle' })
      await shoot('player-idle', 0, 6_000)
    }
  } finally {
    win.destroy()
  }
  return written
}
