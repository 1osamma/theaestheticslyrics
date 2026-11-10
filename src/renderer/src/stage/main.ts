import '../css/tokens.css'
import '../css/stage.css'
import '../css/player.css'
import { DEFAULT_PALETTE } from '@shared/palette-defaults'
import type { StageState } from '@shared/ipc'
import type { Artwork, FrameRateCap, Palette, ShowOn, StyleId } from '@shared/types'
import { installPerf } from '../lighting/perf'
import { createPlayerView, type PlayerView } from '../player/player-view'
import { SongClock } from './clock'
import { FrameGate, VSYNC_GATE_MAX_MS, targetFps } from './frame-gate'
import { LockClock } from './lock-clock'
import { buildModel, msUntilNextWord, type LyricsModel } from './model'
import { createStyle } from './styles/registry'
import type { StageStyle } from './styles/types'

const api = window.lyricsApp.stage
const root = document.getElementById('stage')!
const clock = new SongClock()
const lockClock = new LockClock(document.body)

/** What is drawn: one of the lyric styles, or the LUMINA player on the full-screen lyrics screen. */
let view: StageStyle | null = null
let viewKey: StyleId | 'player' | null = null
let player: PlayerView | null = null
let latestArtwork: Artwork | null = null
let watchOnly = false
let lastState: StageState | null = null
let frameCap: FrameRateCap = 0
const gate = new FrameGate()
let model: LyricsModel | null = null
let lyricsSignature = ''
let palette: Palette = { ...DEFAULT_PALETTE }
let mode: ShowOn = 'lock'
let snapshotMode = false
let loopRunning = false
let pendingState: StageState | null = null
const systemReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const perf = installPerf('stage')

// Text is measured on a canvas, so the bundled font must be ready before the first layout.
const fontsReady = Promise.all([
  document.fonts.load('700 100px "Inter Variable"'),
  document.fonts.load('600 100px "Inter Variable"')
]).then(
  () => undefined,
  () => undefined
)

function signature(state: StageState): string {
  const l = state.lyrics
  if (!l) return `${state.track?.key ?? ''}|none`
  const last = l.lines.at(-1)
  return `${state.track?.key ?? ''}|${l.lines.length}|${l.lines[0]?.start ?? 0}|${last?.end ?? 0}|${l.wordTiming}`
}

function applyPaletteVars(p: Palette): void {
  const s = document.documentElement.style
  s.setProperty('--lyric', p.lyric)
  s.setProperty('--highlight', p.highlight)
  s.setProperty('--highlight-text', p.highlightText)
  s.setProperty('--secondary', p.secondary)
}

function applyState(state: StageState): void {
  lastState = state
  mode = state.config.mode
  document.body.dataset.mode = mode
  frameCap = state.config.frameRateCap
  // The overlay always draws the chosen style; only the full-screen lyrics screen hosts the player.
  const usePlayer = mode === 'lock' && state.config.layout === 'player'
  lockClock.setVisible(mode === 'lock' && !usePlayer)
  palette = state.config.palette
  applyPaletteVars(palette)
  clock.setOffset(state.config.offsetMs)

  const sig = signature(state)
  const lyricsChanged = sig !== lyricsSignature
  if (lyricsChanged) {
    lyricsSignature = sig
    model = state.lyrics ? buildModel(state.lyrics) : null
  }

  const key = usePlayer ? 'player' : state.config.style
  if (key !== viewKey || !view) {
    view?.destroy()
    player = usePlayer ? createPlayerView() : null
    view = player ?? createStyle(state.config.style)
    viewKey = key
    view.mount(root)
    view.setLyrics(model)
    player?.setArtwork(latestArtwork)
    player?.setWatchOnly(watchOnly)
    player?.setPerf(perf)
  } else if (lyricsChanged) {
    view.setLyrics(model)
  }
  view.setMode(mode)
  view.setPalette(palette)
  if (player) {
    player.setConfig(state.config.player, systemReducedMotion.matches)
    player.setLighting(state.config.lighting, systemReducedMotion.matches)
    player.setAmbient(state.ambient)
    player.setTrack(state.track, state.lyricsStatus, state.lyrics)
    player.setPlaying(clock.playing)
  }
  startLoop()
}

function render(songMs: number, wallMs: number, settle = false): boolean {
  const busy = view?.frame({ songMs, wallMs, width: window.innerWidth, height: window.innerHeight, settle }) ?? false
  if (mode === 'lock' && !player) lockClock.update(Date.now())
  return busy
}

/** The loop stops in snapshot mode and while the window is hidden (e.g. the prewarmed lyrics screen). */
const loopShouldStop = (): boolean => snapshotMode || document.hidden

function loop(frameAt: number): void {
  if (loopShouldStop()) {
    loopRunning = false
    return
  }
  const started = performance.now()
  const songMs = clock.now(started, Date.now())
  const busy = render(songMs, started)
  perf.frame(frameAt, performance.now() - started)
  let fps = targetFps(mode, busy, frameCap)
  // Moving light keeps its own rate even while the lyrics rest (still within the frame-rate limit).
  const wanted = view?.wantsFps?.() ?? 0
  if (wanted > fps) fps = frameCap > 0 ? Math.min(wanted, frameCap) : wanted
  if (1000 / fps <= VSYNC_GATE_MAX_MS) {
    // Full rate, or a frame-rate limit: draw on display refreshes, skipping the ones that come too soon.
    const check = (at: number): void => {
      if (loopShouldStop()) {
        loopRunning = false
        return
      }
      if (gate.due(at, fps)) loop(at)
      else requestAnimationFrame(check)
    }
    requestAnimationFrame(check)
    return
  }
  // Wait out most of the frame budget, then align the next frame to vsync — but never
  // sleep through the start of the next word, or it would light up a frame late.
  let wait = 1000 / fps - (performance.now() - started) - 8
  if (model && clock.playing) wait = Math.min(wait, msUntilNextWord(model, songMs) - 12)
  setTimeout(() => requestAnimationFrame(loop), Math.max(0, wait))
}

function startLoop(): void {
  if (loopRunning || loopShouldStop()) return
  loopRunning = true
  requestAnimationFrame(loop)
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) startLoop()
})

// Windows' animation-effects switch calms the player down without a restart.
systemReducedMotion.addEventListener('change', () => {
  if (!player || !lastState) return
  player.setConfig(lastState.config.player, systemReducedMotion.matches)
  player.setLighting(lastState.config.lighting, systemReducedMotion.matches)
})

api.onAudio((frame) => player?.pushAudio(frame))

const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()))

api.onState((state) => {
  pendingState = state
  void fontsReady.then(() => {
    if (!pendingState) return
    const s = pendingState
    pendingState = null
    applyState(s)
  })
})

api.onAnchor((anchor) => {
  clock.setAnchor(anchor, performance.now(), Date.now())
  player?.setPlaying(anchor.playing)
  startLoop()
})

api.onArtwork((artwork) => {
  latestArtwork = artwork
  player?.setArtwork(artwork)
})

api.onSnapshot((req) => {
  snapshotMode = true
  document.body.dataset.snapshot = 'true'
  void fontsReady.then(async () => {
    if (pendingState) {
      applyState(pendingState)
      pendingState = null
    }
    await view?.ready?.()
    render(req.songMs, req.wallMs, true)
    await nextFrame()
    await nextFrame()
    api.snapshotDone(req.id)
  })
})

// Lock mode: any real input closes the screen (the main process applies a grace period).
let travelled = 0
let lastMove: { x: number; y: number; at: number } | null = null
window.addEventListener('mousemove', (e) => {
  if (mode !== 'lock') return
  player?.poke(performance.now())
  const from = lastMove
  if (from && e.timeStamp - from.at < 600) travelled += Math.hypot(e.screenX - from.x, e.screenY - from.y)
  else travelled = 0
  lastMove = { x: e.screenX, y: e.screenY, at: e.timeStamp }
  if (travelled > 12) {
    api.dismiss({
      kind: 'input',
      detail: `mousemove ${Math.round(travelled)}px (${from?.x},${from?.y})→(${e.screenX},${e.screenY}) trusted=${e.isTrusted}`
    })
    travelled = 0
  }
})
window.addEventListener('keydown', (e) => {
  if (mode !== 'lock') return
  if (e.key === 'Escape') api.dismiss({ kind: 'escape', detail: 'Esc' })
  else api.dismiss({ kind: 'input', detail: `keydown key=${e.key} repeat=${e.repeat} trusted=${e.isTrusted}` })
})
for (const type of ['mousedown', 'wheel', 'touchstart'] as const) {
  window.addEventListener(
    type,
    (e) => {
      if (mode === 'lock') api.dismiss({ kind: 'input', detail: `${type} trusted=${e.isTrusted}` })
    },
    { passive: true }
  )
}

// "Press Esc to close" fades in and out when a lyrics screen opens that only Esc closes.
const hint = document.createElement('div')
hint.className = 'stage-hint'
document.body.append(hint)
api.onSession(({ hint: text, watchOnly: watching }) => {
  watchOnly = watching
  player?.setWatchOnly(watching)
  hint.classList.remove('show')
  if (!text) return
  hint.textContent = text
  void hint.offsetWidth // restart the fade animation
  hint.classList.add('show')
})
