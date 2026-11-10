import '../css/tokens.css'
import '../css/lighting.css'
import type { LightingPanelState } from '@shared/ipc'
import {
  AUDIO_SOURCE_LABELS,
  LIGHTING_MODES,
  LIGHTING_MODE_LABELS,
  type AudioSource,
  type EdgeSides,
  type LightingFps,
  type LightingSettings
} from '@shared/lighting'

const api = window.lyricsApp.lighting
const root = document.getElementById('lighting')!

type LevelKey = 'lightingBrightness' | 'audioSensitivity' | 'bassStrength' | 'lightingSmoothing' | 'glowRadius' | 'edgeThickness' | 'edgeSpread' | 'edgeSoftness'
type ToggleKey = 'fullscreenLighting' | 'edgeLighting' | 'playerEdgeGlow' | 'pauseInFullscreen' | 'edgeAtStartup'

const FPS_LABELS: Record<LightingFps, string> = {
  30: '30 FPS · Power saving',
  60: '60 FPS · Default',
  120: '120 FPS · High smoothness',
  240: '240 FPS · Experimental'
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

let state: LightingPanelState | null = null
const sendTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Sends a change at most every 80 ms per control while dragging, and always the final value. */
function send(key: keyof LightingSettings, patch: Partial<LightingSettings>, final = false): void {
  const pending = sendTimers.get(key)
  if (pending && !final) return
  if (pending) clearTimeout(pending)
  api.set(patch)
  if (!final) sendTimers.set(key, setTimeout(() => sendTimers.delete(key), 80))
  else sendTimers.delete(key)
}

function section(title: string, ...children: HTMLElement[]): HTMLElement {
  const s = el('section', 'lp-section')
  s.append(el('h2', undefined, title), ...children)
  return s
}

const levelControls = new Map<LevelKey, { input: HTMLInputElement; value: HTMLElement }>()
function level(key: LevelKey, label: string, hint?: string, min = 0): HTMLElement {
  const row = el('label', 'lp-row lp-slider')
  const text = el('span', 'lp-label', label)
  if (hint) text.append(el('small', undefined, hint))
  const value = el('output', 'lp-value')
  const input = el('input')
  input.type = 'range'
  input.min = String(Math.round(min * 100))
  input.max = '100'
  input.step = '1'
  input.addEventListener('input', () => {
    value.textContent = `${input.value}%`
    send(key, { [key]: Number(input.value) / 100 })
  })
  input.addEventListener('change', () => send(key, { [key]: Number(input.value) / 100 }, true))
  row.append(text, value, input)
  levelControls.set(key, { input, value })
  return row
}

const toggleControls = new Map<ToggleKey, HTMLInputElement>()
function toggle(key: ToggleKey, label: string, hint?: string): HTMLElement {
  const row = el('label', 'lp-row lp-toggle')
  const text = el('span', 'lp-label', label)
  if (hint) text.append(el('small', undefined, hint))
  const input = el('input')
  input.type = 'checkbox'
  input.addEventListener('change', () => send(key, { [key]: input.checked }, true))
  const track = el('span', 'lp-switch')
  row.append(text, input, track)
  toggleControls.set(key, input)
  return row
}

function select<T extends string | number>(label: string, options: { value: T; text: string }[], onChange: (v: T) => void, hint?: string) {
  const row = el('label', 'lp-row lp-select')
  const text = el('span', 'lp-label', label)
  if (hint) text.append(el('small', undefined, hint))
  const input = el('select')
  const fill = (opts: { value: T; text: string }[]): void => {
    input.replaceChildren(
      ...opts.map((o) => {
        const option = el('option')
        option.value = String(o.value)
        option.textContent = o.text
        return option
      })
    )
  }
  fill(options)
  input.addEventListener('change', () => {
    const match = [...input.options].findIndex((o) => o.selected)
    const chosen = currentOptions[match]
    if (chosen) onChange(chosen.value)
  })
  let currentOptions = options
  row.append(text, input)
  return {
    row,
    input,
    setOptions(opts: { value: T; text: string }[]) {
      currentOptions = opts
      fill(opts)
    }
  }
}

// ---------- Header and status ----------
const header = el('header', 'lp-header')
const titles = el('div')
titles.append(el('div', 'lp-eyebrow', 'LUMINA'), el('h1', undefined, 'Lighting'))
const pause = el('button', 'lp-pause', 'Pause Lighting')
pause.type = 'button'
pause.addEventListener('click', () => api.setPaused(!state?.paused))
header.append(titles, pause)

const status = el('div', 'lp-status')
const audioLine = el('div', 'lp-status-line')
const edgeLine = el('div', 'lp-status-line')
const gpuLine = el('div', 'lp-status-line')
status.append(audioLine, edgeLine, gpuLine)

// ---------- Mode ----------
const modeGroup = el('div', 'lp-modes')
const modeButtons = LIGHTING_MODES.map((mode) => {
  const b = el('button', 'lp-mode', LIGHTING_MODE_LABELS[mode])
  b.type = 'button'
  b.addEventListener('click', () => send('lightingMode', { lightingMode: mode }, true))
  modeGroup.append(b)
  return { mode, b }
})

// ---------- Edges ----------
const sides = el('div', 'lp-sides')
const sideInputs: Record<keyof EdgeSides, HTMLInputElement> = {} as Record<keyof EdgeSides, HTMLInputElement>
for (const side of ['left', 'right', 'top', 'bottom'] as const) {
  const label = el('label', 'lp-side')
  const input = el('input')
  input.type = 'checkbox'
  input.addEventListener('change', () => {
    if (!state) return
    send('edgeSides', { edgeSides: { ...state.settings.edgeSides, [side]: input.checked } }, true)
  })
  label.append(input, el('span', undefined, side[0]!.toUpperCase() + side.slice(1)))
  sides.append(label)
  sideInputs[side] = input
}

const monitor = select<string>('Monitor', [], (v) => send('edgeDisplays', { edgeDisplays: v === 'primary' || v === 'all' ? v : Number(v) }, true))
const fps = select<LightingFps>(
  'Render FPS',
  ([30, 60, 120, 240] as LightingFps[]).map((v) => ({ value: v, text: FPS_LABELS[v] })),
  (v) => send('lightingFps', { lightingFps: v }, true),
  'Higher rates cost more GPU time. 240 is experimental.'
)
const source = select<AudioSource>(
  'Audio Capture Source',
  (['system', 'spotify'] as AudioSource[]).map((v) => ({ value: v, text: AUDIO_SOURCE_LABELS[v] })),
  (v) => send('audioSource', { audioSource: v }, true),
  'All desktop audio reacts to everything playing on this PC, not only Spotify. Spotify only ignores other apps.'
)

root.append(
  header,
  status,
  section('Mode', modeGroup),
  section(
    'Where',
    toggle('fullscreenLighting', 'Fullscreen Player Lighting'),
    toggle('edgeLighting', 'Desktop Edge Lighting', 'Soft light around your screen edges, click-through'),
    toggle('playerEdgeGlow', 'Edge Glow in the Player')
  ),
  section(
    'Light',
    level('lightingBrightness', 'Brightness', undefined, 0.05),
    level('audioSensitivity', 'Audio Sensitivity'),
    level('bassStrength', 'Bass Strength'),
    level('lightingSmoothing', 'Smoothing', 'Higher is calmer'),
    level('glowRadius', 'Glow Radius', 'Fullscreen bloom size')
  ),
  section(
    'Edges',
    sides,
    level('edgeThickness', 'Thickness', undefined, 0.05),
    level('edgeSpread', 'Spread', 'How far along each edge'),
    level('edgeSoftness', 'Softness'),
    monitor.row
  ),
  section(
    'Performance & capture',
    fps.row,
    source.row,
    toggle('pauseInFullscreen', 'Pause During Fullscreen Games', 'Hides edge lighting while an app fills that monitor'),
    toggle('edgeAtStartup', 'Start Edge Lighting with Windows')
  )
)

function render(next: LightingPanelState): void {
  state = next
  const s = next.settings
  pause.textContent = next.paused ? 'Resume Lighting' : 'Pause Lighting'
  pause.classList.toggle('is-paused', next.paused)
  document.body.classList.toggle('is-paused', next.paused)

  const a = next.audio
  audioLine.textContent =
    a.state === 'capturing'
      ? a.mode === 'process'
        ? 'Audio · Spotify only (process loopback)'
        : 'Audio · All desktop audio (not Spotify only)'
      : a.state === 'stopped'
        ? 'Audio · Idle (starts when lighting needs it)'
        : a.state === 'waiting'
          ? `Audio · ${a.message || 'Waiting'}`
          : a.state === 'starting'
            ? 'Audio · Starting…'
            : 'Audio · Unavailable, retrying'
  audioLine.dataset.tone = a.state === 'capturing' ? (a.mode === 'process' ? 'good' : 'warn') : a.state === 'error' ? 'bad' : 'idle'
  edgeLine.textContent = s.edgeLighting
    ? next.edgeShowing > 0
      ? `Edges · Lighting ${next.edgeShowing} display${next.edgeShowing > 1 ? 's' : ''}`
      : `Edges · Held: ${next.edgeHeldBy ?? 'starting'}`
    : 'Edges · Off'
  gpuLine.textContent = next.gpu ? 'Renderer · GPU (WebGL2)' : 'Renderer · Lightweight (no GPU compositing)'

  for (const { mode, b } of modeButtons) b.classList.toggle('is-on', s.lightingMode === mode)
  for (const [key, c] of levelControls) {
    const v = Math.round(s[key] * 100)
    if (document.activeElement !== c.input) c.input.value = String(v)
    c.value.textContent = `${v}%`
  }
  for (const [key, input] of toggleControls) input.checked = s[key]
  for (const side of Object.keys(sideInputs) as (keyof EdgeSides)[]) sideInputs[side].checked = s.edgeSides[side]

  monitor.setOptions([
    { value: 'primary', text: 'Primary Display' },
    { value: 'all', text: 'All Displays' },
    ...next.displays.map((d) => ({ value: String(d.id), text: d.label }))
  ])
  monitor.input.value = String(s.edgeDisplays)
  fps.input.value = String(s.lightingFps)
  source.input.value = s.audioSource
}

void api.get().then((initial) => {
  if (initial) render(initial)
})
api.onState(render)
