import type { LightFrame } from '@shared/lighting'
import { createCssEdgeRenderer, createCssPlayerRenderer } from './css-renderer'
import type { LightRenderer, LightView } from './light-renderer'
import { createWebglRenderer } from './webgl-renderer'

export interface LightLayer {
  readonly kind: 'webgl' | 'css' | 'none'
  mount(parent: HTMLElement): void
  /** Uses the CSS fallback even if WebGL works (no GPU compositing). */
  setPreferCss(prefer: boolean): void
  render(frame: LightFrame, view: LightView): void
  destroy(): void
}

/**
 * Picks the light renderer: WebGL2 when it works, the CSS fallback otherwise. A lost GPU context
 * switches to CSS until the context comes back, so the light never just disappears.
 */
export function createLightLayer(overlay: boolean, log: (message: string) => void = () => undefined): LightLayer {
  let host: HTMLDivElement | null = null
  let active: LightRenderer | null = null
  let webgl: LightRenderer | null = null
  let fallback: LightRenderer | null = null
  let preferCss = false
  let contextLost = false

  const makeFallback = (): LightRenderer => (overlay ? createCssEdgeRenderer() : createCssPlayerRenderer())

  function use(next: LightRenderer): void {
    if (active === next || !host) return
    if (active && active !== webgl) active.destroy() // the WebGL renderer is kept for when its context returns
    if (active === webgl && webgl) host.querySelector('canvas')?.setAttribute('hidden', '')
    active = next
    if (next === webgl) host.querySelector('canvas')?.removeAttribute('hidden')
    else next.mount(host)
    log(`lighting: ${next.kind} renderer`)
  }

  function choose(): void {
    if (!host) return
    if (!preferCss && !contextLost && webgl) {
      if (fallback && active === fallback) fallback = null
      use(webgl)
      return
    }
    fallback ??= makeFallback()
    use(fallback)
  }

  return {
    get kind() {
      return active?.kind ?? 'none'
    },

    mount(parent) {
      host = document.createElement('div')
      host.className = overlay ? 'lm-light lm-light-overlay' : 'lm-light'
      parent.append(host)
      webgl = createWebglRenderer({
        onLost: () => {
          contextLost = true
          log('lighting: GPU context lost, using the CSS fallback')
          choose()
        },
        onRestored: () => {
          contextLost = false
          log('lighting: GPU context restored')
          choose()
        }
      })
      if (webgl) webgl.mount(host)
      else log('lighting: WebGL2 unavailable, using the CSS fallback')
      choose()
    },

    setPreferCss(prefer) {
      if (prefer === preferCss) return
      preferCss = prefer
      choose()
    },

    render(frame, view) {
      active?.render(frame, view)
    },

    destroy() {
      if (fallback) fallback.destroy()
      webgl?.destroy()
      host?.remove()
      host = null
      active = webgl = fallback = null
    }
  }
}
