import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { IPC, type LightingPanelState } from '@shared/ipc'
import { pickLightingPatch, type LightingSettings } from '@shared/lighting'
import type { Log } from '../logger'
import { harden, loadPage, secureWebPreferences } from './windows'

const WIDTH = 460
const HEIGHT = 720

export interface LightingWindowDeps {
  log: Log
  iconPath: string
  state: () => LightingPanelState
  /** Already restricted to lighting keys; the settings store validates every value. */
  update: (patch: Partial<LightingSettings>) => void
  setPaused: (paused: boolean) => void
}

/** The LUMINA Lighting settings window (tray → LUMINA Lighting → Lighting Settings…). */
export class LightingWindow {
  private win: BrowserWindow | null = null

  constructor(private readonly deps: LightingWindowDeps) {
    ipcMain.handle(IPC.lightingGet, (e: IpcMainInvokeEvent) => (this.fromOwn(e) ? deps.state() : null))
    ipcMain.on(IPC.lightingSet, (e: IpcMainEvent, patch: unknown) => {
      if (!this.fromOwn(e)) return
      const picked = pickLightingPatch(patch)
      if (Object.keys(picked).length) deps.update(picked)
    })
    ipcMain.on(IPC.lightingPause, (e: IpcMainEvent, paused: unknown) => {
      if (this.fromOwn(e) && typeof paused === 'boolean') deps.setPaused(paused)
    })
  }

  open(): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore()
      this.win.show()
      this.win.focus()
      return
    }
    const area = screen.getPrimaryDisplay().workArea
    const height = Math.min(HEIGHT, area.height - 48)
    const win = new BrowserWindow({
      width: WIDTH,
      height,
      useContentSize: true,
      x: area.x + area.width - WIDTH - 24,
      y: Math.max(area.y + 24, area.y + area.height - height - 64),
      show: false,
      resizable: false,
      maximizable: false,
      minimizable: true,
      fullscreenable: false,
      title: 'LUMINA Lighting',
      icon: this.deps.iconPath,
      backgroundColor: '#0b0b0f',
      autoHideMenuBar: true,
      webPreferences: secureWebPreferences()
    })
    win.removeMenu()
    harden(win)
    win.once('ready-to-show', () => win.show())
    win.on('closed', () => {
      if (this.win === win) this.win = null
    })
    this.win = win
    loadPage(win, 'lighting').catch((err: unknown) => this.deps.log(`lighting: settings window failed to load (${String(err)})`))
  }

  push(state: LightingPanelState): void {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(IPC.lightingState, state)
  }

  /** Debug/E2E helper: saves what the window shows. */
  async capture(file: string): Promise<boolean> {
    if (!this.win || this.win.isDestroyed() || !this.win.isVisible()) return false
    const image = await this.win.webContents.capturePage()
    const { writeFileSync } = await import('node:fs')
    writeFileSync(file, image.toPNG())
    return true
  }

  destroy(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

  private fromOwn(e: IpcMainEvent | IpcMainInvokeEvent): boolean {
    return !!this.win && !this.win.isDestroyed() && e.sender === this.win.webContents
  }
}
