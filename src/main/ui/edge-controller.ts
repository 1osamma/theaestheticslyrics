import { BrowserWindow, screen, type Display } from 'electron'
import type { AudioAnalysisFrame } from '@shared/audio-frame'
import { IPC, type EdgeState } from '@shared/ipc'
import type { EdgeDisplays } from '@shared/lighting'
import type { Log } from '../logger'
import { coveredByFullscreen, edgeTargets, type DisplayLike } from './edge-logic'
import { NOT_FULLSCREEN, type FullscreenInfo } from './fullscreen-watcher'
import { harden, loadPage, secureWebPreferences } from './windows'

interface EdgeWindow {
  displayId: number
  win: BrowserWindow
  ready: boolean
}

export interface EdgeControllerDeps {
  log: Log
  /** Number of edge windows showing changed (audio capture follows it). */
  onShowingChange(count: number): void
}

function toDisplayLike(d: Display): DisplayLike {
  // Windows reports full-screen monitors in physical pixels; Electron's bounds are DIPs.
  const physical = process.platform === 'win32' ? screen.dipToScreenRect(null, d.bounds) : d.bounds
  return { id: d.id, bounds: d.bounds, physical }
}

/**
 * Desktop edge lighting: one transparent, click-through, non-activating tool window per selected
 * monitor, separate from the lyrics overlay and the fullscreen player. Windows are created on
 * demand, hidden (never destroyed) while held, and destroyed when their monitor goes away.
 */
export class EdgeController {
  private readonly windows = new Map<number, EdgeWindow>()
  private wanted = false
  private setting: EdgeDisplays = 'primary'
  private fullscreen: FullscreenInfo = NOT_FULLSCREEN
  private state: EdgeState | null = null
  private showing = 0
  private disposed = false

  constructor(private readonly deps: EdgeControllerDeps) {
    screen.on('display-added', this.onDisplays)
    screen.on('display-removed', this.onDisplays)
    screen.on('display-metrics-changed', this.onDisplays)
  }

  get showingCount(): number {
    return this.showing
  }

  update(wanted: boolean, setting: EdgeDisplays, state: EdgeState): void {
    this.wanted = wanted
    this.setting = setting
    this.state = state
    for (const ew of this.windows.values()) this.sendState(ew)
    this.reconcile()
  }

  setFullscreen(info: FullscreenInfo): void {
    this.fullscreen = info
    this.reconcile()
  }

  sendAudio(frame: AudioAnalysisFrame): void {
    for (const ew of this.windows.values()) {
      if (ew.ready && !ew.win.isDestroyed() && ew.win.isVisible()) ew.win.webContents.send(IPC.lightingAudio, frame)
    }
  }

  /** Emergency off: hide every edge window at once. */
  hideAll(): void {
    for (const ew of this.windows.values()) if (!ew.win.isDestroyed()) ew.win.hide()
    this.setShowing(0)
  }

  /** Debug: resets the page's frame counters (window.__luminaPerf, kept by the page itself). */
  async perfReset(): Promise<void> {
    for (const ew of this.windows.values()) {
      if (!ew.win.isDestroyed()) await ew.win.webContents.executeJavaScript('window.__luminaPerf?.reset()').catch(() => undefined)
    }
  }

  /** Debug: reads every visible edge window's frame counters. */
  async perfRead(): Promise<unknown[]> {
    const out: unknown[] = []
    for (const ew of this.windows.values()) {
      if (ew.win.isDestroyed() || !ew.win.isVisible()) continue
      out.push(await ew.win.webContents.executeJavaScript('window.__luminaPerf?.read() ?? null').catch(() => null))
    }
    return out
  }

  /** Native window handles, for tests that probe the window styles. */
  handles(): { displayId: number; hwnd: bigint; bounds: Electron.Rectangle }[] {
    return [...this.windows.values()]
      .filter((ew) => !ew.win.isDestroyed())
      .map((ew) => ({ displayId: ew.displayId, hwnd: ew.win.getNativeWindowHandle().readBigUInt64LE(0), bounds: ew.win.getBounds() }))
  }

  dispose(): void {
    this.disposed = true
    screen.removeListener('display-added', this.onDisplays)
    screen.removeListener('display-removed', this.onDisplays)
    screen.removeListener('display-metrics-changed', this.onDisplays)
    for (const ew of this.windows.values()) if (!ew.win.isDestroyed()) ew.win.destroy()
    this.windows.clear()
  }

  private readonly onDisplays = (): void => this.reconcile()

  private reconcile(): void {
    if (this.disposed) return
    const displays = screen.getAllDisplays().map(toDisplayLike)
    const targets = edgeTargets(this.setting, displays, screen.getPrimaryDisplay().id)
    const targetIds = new Set(targets.map((d) => d.id))

    // Monitors that went away or are no longer selected.
    for (const [id, ew] of this.windows) {
      if (targetIds.has(id) && this.wanted) continue
      if (!displays.some((d) => d.id === id)) {
        if (!ew.win.isDestroyed()) ew.win.destroy()
        this.windows.delete(id)
      } else if (!ew.win.isDestroyed() && ew.win.isVisible()) {
        ew.win.hide()
      }
    }

    let showing = 0
    if (this.wanted) {
      for (const display of targets) {
        if (coveredByFullscreen(display, this.fullscreen)) {
          const held = this.windows.get(display.id)
          if (held && !held.win.isDestroyed() && held.win.isVisible()) held.win.hide()
          continue
        }
        const ew = this.ensure(display)
        if (!ew.win.isDestroyed()) {
          const b = ew.win.getBounds()
          const t = display.bounds
          if (b.x !== t.x || b.y !== t.y || b.width !== t.width || b.height !== t.height) ew.win.setBounds(t)
          if (ew.ready && !ew.win.isVisible()) ew.win.showInactive()
          if (ew.ready) showing++
        }
      }
    }
    this.setShowing(showing)
  }

  private ensure(display: DisplayLike): EdgeWindow {
    const existing = this.windows.get(display.id)
    if (existing && !existing.win.isDestroyed()) return existing
    const win = new BrowserWindow({
      ...display.bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      // A tool window: never in the taskbar or Alt+Tab.
      type: 'toolbar',
      focusable: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      roundedCorners: false,
      thickFrame: false,
      accentColor: false,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      title: 'LUMINA Edge Lighting',
      webPreferences: secureWebPreferences()
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    // Every click and the wheel go straight through to whatever is underneath.
    win.setIgnoreMouseEvents(true)
    win.setVisibleOnAllWorkspaces(true)
    harden(win)
    win.on('close', (e) => {
      if (this.disposed) return
      e.preventDefault()
      win.hide()
    })
    const ew: EdgeWindow = { displayId: display.id, win, ready: false }
    win.webContents.on('render-process-gone', (_e, details) => {
      this.deps.log(`edge: renderer gone (${details.reason}), recreating`)
      if (!win.isDestroyed()) win.destroy()
      this.windows.delete(display.id)
      setTimeout(() => this.reconcile(), 1000)
    })
    loadPage(win, 'edge').then(
      () => {
        ew.ready = true
        this.sendState(ew)
        this.deps.log(`edge: lighting window ready on display ${display.id}`)
        this.reconcile()
      },
      (err: unknown) => this.deps.log(`edge: failed to load (${String(err)})`)
    )
    this.windows.set(display.id, ew)
    return ew
  }

  private sendState(ew: EdgeWindow): void {
    if (this.state && ew.ready && !ew.win.isDestroyed()) ew.win.webContents.send(IPC.edgeState, this.state)
  }

  private setShowing(count: number): void {
    if (count === this.showing) return
    this.showing = count
    this.deps.onShowingChange(count)
  }
}
