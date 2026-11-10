import type { LightFrame } from '@shared/lighting'
import { createAmbientLayer } from '../ambient/ambient-layer'
import { setStyle } from '../stage/style-cache'
import { rgbToHex, type LightRenderer, type LightView } from './light-renderer'

/**
 * Fallback for the player without WebGL2: the Phase 1 CSS gradient layers, driven by the same
 * light frames (atmosphere and bloom set their strength, drift follows the motion).
 */
export function createCssPlayerRenderer(): LightRenderer {
  const ambient = createAmbientLayer()
  let host: HTMLDivElement | null = null
  return {
    kind: 'css',
    mount(parent) {
      host = document.createElement('div')
      host.className = 'lm-light-css'
      parent.append(host)
      ambient.mount(host)
      ambient.setBrightness(1)
    },
    render(frame: LightFrame, view: LightView) {
      ambient.setEnabled(frame.active)
      if (!frame.active) return
      ambient.setColors(frame.colors.map(rgbToHex))
      ambient.frame(
        view.wallMs,
        { intensity: Math.min(1, frame.atmosphere * 1.5 + frame.bloom * 0.6), motion: frame.phase > 0 ? 0.6 : 0 },
        { width: view.width, height: view.height }
      )
    },
    destroy() {
      ambient.destroy()
      host?.remove()
      host = null
    }
  }
}

/** Fallback edge light: four gradient strips whose opacity follows the light. */
export function createCssEdgeRenderer(): LightRenderer {
  let host: HTMLDivElement | null = null
  const strips: HTMLDivElement[] = []
  const SIDES = ['left', 'right', 'top', 'bottom'] as const
  return {
    kind: 'css',
    mount(parent) {
      host = document.createElement('div')
      host.className = 'lm-edge-css'
      for (const side of SIDES) {
        const strip = document.createElement('div')
        strip.className = `lm-edge-strip lm-edge-${side}`
        host.append(strip)
        strips.push(strip)
      }
      parent.append(host)
    },
    render(frame: LightFrame, view: LightView) {
      const depth = `${(3 + view.edgeShape[0] * 21).toFixed(1)}vh`
      SIDES.forEach((side, i) => {
        const strip = strips[i]!
        const color = rgbToHex(frame.colors[[0, 1, 3, 2][i]!]!)
        const dir = { left: 'to right', right: 'to left', top: 'to bottom', bottom: 'to top' }[side]
        setStyle(strip, 'background-image', `linear-gradient(${dir}, ${color}, transparent)`)
        setStyle(strip, side === 'left' || side === 'right' ? 'width' : 'height', depth)
        setStyle(strip, 'opacity', frame.active ? (frame.edge * view.edges[i]!).toFixed(3) : '0')
      })
    },
    destroy() {
      host?.remove()
      host = null
      strips.length = 0
    }
  }
}
