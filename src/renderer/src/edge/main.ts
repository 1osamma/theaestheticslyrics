import '../css/edge.css'
import type { AudioAnalysisFrame } from '@shared/audio-frame'
import type { EdgeState } from '@shared/ipc'
import type { LightFrame, LightingConfig } from '@shared/lighting'
import { LightingEngine } from '@shared/lighting-engine'
import { edgeWeights } from '../lighting/edge-weights'
import { copyLight, sameLight } from '../lighting/frame-utils'
import { createLightLayer } from '../lighting/light-layer'
import { installPerf } from '../lighting/perf'
import { FrameGate } from '../stage/frame-gate'

/**
 * Desktop edge lighting page: transparent, never interactive. Draws the shared lighting engine's
 * output as glow along the screen edges at the chosen frame rate, and stops drawing entirely while
 * hidden or while nothing changes.
 */
const api = window.lyricsApp.edge
const perf = installPerf('edge')
const layer = createLightLayer(true, (m) => console.info(m))
layer.mount(document.getElementById('edge')!)

let config: LightingConfig | null = null
let engine: LightingEngine | null = null
let lastAudio: AudioAnalysisFrame | null = null
let drawn: LightFrame | null = null
const gate = new FrameGate()
let unchanged = 0
let running = false
let snapshotMode = false
let settleClock = 0

/** Still light (static, off) stops the loop after this many identical frames, until something changes. */
const IDLE_FRAMES_BEFORE_STOP = 30

function draw(now: number, frame: LightFrame): void {
  if (!config) return
  layer.render(frame, {
    width: window.innerWidth,
    height: window.innerHeight,
    overlay: true,
    focus: [0.5, 0.5],
    edges: edgeWeights(config.edges),
    edgeShape: [config.edgeThickness, config.edgeSoftness, config.edgeSpread],
    wallMs: now
  })
  perf.light(now, frame)
}

function loop(at: number): void {
  if (!config || !engine || document.hidden || snapshotMode) {
    running = false
    return
  }
  if (gate.due(at, config.fps)) {
    const started = performance.now()
    const frame = engine.sample(started)
    if (sameLight(drawn, frame)) {
      unchanged++
    } else {
      unchanged = 0
      draw(started, frame)
      drawn = copyLight(frame)
    }
    perf.frame(at, performance.now() - started)
    const still = config.mode === 'off' || config.mode === 'static'
    if (still && unchanged > IDLE_FRAMES_BEFORE_STOP) {
      running = false
      return
    }
  }
  requestAnimationFrame(loop)
}

function start(): void {
  if (running || !config || document.hidden || snapshotMode) return
  running = true
  unchanged = 0
  requestAnimationFrame(loop)
}

api.onState((state: EdgeState) => {
  const now = performance.now()
  config = state.lighting
  if (!engine) {
    engine = new LightingEngine(config)
    engine.setPalette(state.ambient.colors, now, true)
  } else {
    engine.setConfig(config)
    engine.setPalette(state.ambient.colors, now)
  }
  layer.setPreferCss(!config.gpu)
  perf.setRenderer(layer.kind)
  drawn = null
  start()
})

api.onAudio((frame) => {
  lastAudio = frame
  engine?.pushAudio(frame, performance.now())
  perf.audioLatency(Date.now() - frame.timestamp)
  start()
})

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    drawn = null
    start()
  }
})

// Snapshot mode (npm run snapshot): settle on the latest audio, draw once, acknowledge.
window.lyricsApp.stage.onSnapshot((req) => {
  snapshotMode = true
  if (!engine || !config) {
    window.lyricsApp.stage.snapshotDone(req.id)
    return
  }
  for (let i = 0; i < 150; i++) {
    settleClock += 16
    if (lastAudio) engine.pushAudio(lastAudio, settleClock)
    engine.sample(settleClock)
  }
  draw(req.wallMs, engine.sample(settleClock))
  requestAnimationFrame(() => requestAnimationFrame(() => window.lyricsApp.stage.snapshotDone(req.id)))
})
