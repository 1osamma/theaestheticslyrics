import type { LightingDrive } from '@shared/lighting'
import { setStyle } from '../stage/style-cache'
import { clamp } from '../stage/util'
import { approach } from './drive'

/**
 * Draws ambient light. Phase 1 has one implementation (CSS gradients on GPU layers); a WebGL2
 * renderer or the desktop edge-glow overlay can implement the same interface later.
 */
export interface AmbientRenderer {
  mount(parent: HTMLElement): void
  /** Crossfades to new colours (strongest first). `instant` skips the fade (snapshots, first paint). */
  setColors(colors: readonly string[], instant?: boolean): void
  /** 0–1. */
  setBrightness(brightness: number): void
  setEnabled(on: boolean): void
  /**
   * Moves the light for this frame. Ambient motion is slow enough to look the same at the
   * stage's idle frame rate, so it never asks for full-rate frames itself.
   */
  frame(wallMs: number, drive: LightingDrive, size: { width: number; height: number }, settle?: boolean): void
  destroy(): void
}

interface Orbit {
  /** Resting centre, as a fraction of the screen. */
  x: number
  y: number
  /** Drift radius, as a fraction of the screen. */
  rx: number
  ry: number
  periodMs: number
  phase: number
  /** Peak alpha of the colour at the centre. */
  alpha: number
}

/** One light per palette colour; the first (strongest) sits behind the album art. */
const ORBITS: readonly Orbit[] = [
  { x: 0.24, y: 0.42, rx: 0.07, ry: 0.06, periodMs: 47_000, phase: 0, alpha: 0.64 },
  { x: 0.8, y: 0.2, rx: 0.06, ry: 0.08, periodMs: 61_000, phase: 1.9, alpha: 0.5 },
  { x: 0.7, y: 0.86, rx: 0.08, ry: 0.05, periodMs: 53_000, phase: 3.6, alpha: 0.46 },
  { x: 0.12, y: 0.92, rx: 0.05, ry: 0.06, periodMs: 71_000, phase: 5.1, alpha: 0.38 }
]

const SCENE_FADE_MS = 1400
/** Drive changes (pause/resume) glide over about this long. */
const DRIVE_TAU_MS = 600

const hexToRgb = (hex: string): string => {
  const n = Number.parseInt(hex.slice(1), 16)
  return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`
}

function gradient(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex)
  return `radial-gradient(closest-side, rgba(${rgb}, ${alpha}) 0%, rgba(${rgb}, ${(alpha * 0.45).toFixed(3)}) 42%, rgba(${rgb}, 0) 100%)`
}

/**
 * Album-art ambient light as a few huge radial gradients, each on its own compositor layer.
 * Gradients are rasterised once per colour change; frames only move layers (transform) and
 * fade them (opacity), which the GPU does without repainting. Colour changes crossfade a new
 * scene over the old one with a CSS opacity transition, also on the compositor.
 */
export function createAmbientLayer(): AmbientRenderer {
  let root: HTMLDivElement | null = null
  let colors: readonly string[] = []
  let brightness = 0.7
  let enabled = true
  let intensity = 1
  let motion = 0
  let lastWall: number | null = null
  const scenes: { el: HTMLDivElement; blobs: HTMLDivElement[]; born: number }[] = []
  const timers = new Set<ReturnType<typeof setTimeout>>()

  function buildScene(instant: boolean): void {
    if (!root || !colors.length) return
    const el = document.createElement('div')
    el.className = 'lm-ambient-scene'
    const blobs = ORBITS.map((orbit, i) => {
      const blob = document.createElement('div')
      blob.className = 'lm-ambient-blob'
      blob.style.backgroundImage = gradient(colors[i % colors.length]!, orbit.alpha)
      el.append(blob)
      return blob
    })
    if (!instant) el.style.opacity = '0'
    root.append(el)
    const scene = { el, blobs, born: performance.now() }
    scenes.push(scene)
    if (instant) {
      for (const old of scenes.splice(0, scenes.length - 1)) old.el.remove()
      return
    }
    void el.offsetWidth // commit opacity 0 so the transition runs
    el.style.opacity = '1'
    const timer = setTimeout(() => {
      timers.delete(timer)
      const index = scenes.indexOf(scene)
      for (const old of scenes.splice(0, Math.max(0, index))) old.el.remove()
    }, SCENE_FADE_MS + 100)
    timers.add(timer)
  }

  return {
    mount(parent) {
      root = document.createElement('div')
      root.className = 'lm-ambient'
      parent.append(root)
      if (colors.length) buildScene(true)
    },

    setColors(next, instant = false) {
      if (next.length === colors.length && next.every((c, i) => c === colors[i])) return
      const first = !colors.length
      colors = [...next]
      buildScene(instant || first)
    },

    setBrightness(next) {
      brightness = clamp(next)
    },

    setEnabled(on) {
      enabled = on
      if (root) root.hidden = !on
    },

    frame(wallMs, drive, { width: W, height: H }, settle = false) {
      if (!root || !enabled) return
      const dt = lastWall === null || settle ? Number.POSITIVE_INFINITY : wallMs - lastWall
      lastWall = wallMs
      intensity = approach(intensity, drive.intensity, dt, DRIVE_TAU_MS)
      motion = approach(motion, drive.motion, dt, DRIVE_TAU_MS)
      setStyle(root, 'opacity', (brightness * intensity).toFixed(3))

      ORBITS.forEach((o, i) => {
        const a = (wallMs / o.periodMs) * Math.PI * 2 + o.phase
        const x = (o.x + Math.sin(a) * o.rx * motion) * W
        const y = (o.y + Math.cos(a * 0.83) * o.ry * motion) * H
        const scale = 1 + Math.sin(a * 1.37) * 0.06 * motion
        const transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${scale.toFixed(4)})`
        for (const scene of scenes) setStyle(scene.blobs[i]!, 'transform', transform)
      })
    },

    destroy() {
      for (const t of timers) clearTimeout(t)
      timers.clear()
      scenes.length = 0
      root?.remove()
      root = null
    }
  }
}
