import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface } from 'node:readline'
import type { Log } from '../logger'

/** A monitor rectangle in physical screen pixels, as Windows reports it. */
export interface ScreenRect {
  x: number
  y: number
  width: number
  height: number
}

export interface FullscreenInfo {
  /** Another app fills a monitor (borderless or exclusive full screen). LUMINA's own windows never count. */
  active: boolean
  monitor: ScreenRect | null
}

export const NOT_FULLSCREEN: FullscreenInfo = Object.freeze({ active: false, monitor: null })

const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) < 1e6 ? v : null)

/** Validates one line from `lumina-helper fullscreen`. */
export function parseFullscreenLine(line: string): FullscreenInfo | null {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const m = v as Record<string, unknown>
  if (m.type !== 'fullscreen' || typeof m.active !== 'boolean') return null
  let monitor: ScreenRect | null = null
  if (m.active && typeof m.monitor === 'object' && m.monitor !== null) {
    const r = m.monitor as Record<string, unknown>
    const [x, y, width, height] = [int(r.x), int(r.y), int(r.width), int(r.height)]
    if (x !== null && y !== null && width !== null && height !== null && width > 0 && height > 0) monitor = { x, y, width, height }
  }
  return { active: m.active, monitor }
}

const MAX_RESTART_MS = 30_000

/**
 * Runs `lumina-helper fullscreen` while edge lighting wants to pause for full-screen apps, and
 * reports changes. Failing to run it simply means edge lighting is never paused for games.
 */
export class FullscreenWatcher extends EventEmitter<{ change: [FullscreenInfo] }> {
  private child: ChildProcess | null = null
  private enabled = false
  private info: FullscreenInfo = NOT_FULLSCREEN
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartDelay = 1000

  constructor(
    private readonly helperPath: string,
    private readonly log: Log
  ) {
    super()
  }

  get state(): FullscreenInfo {
    return this.info
  }

  setEnabled(on: boolean): void {
    if (on === this.enabled) return
    this.enabled = on
    if (on) this.start()
    else this.stop()
  }

  dispose(): void {
    this.enabled = false
    this.stop()
  }

  private start(): void {
    if (this.child || !this.enabled) return
    let child: ChildProcess
    try {
      child = spawn(this.helperPath, ['fullscreen', '--exclude', String(process.pid), '--parent', String(process.pid)], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore']
      })
    } catch (err) {
      this.log(`fullscreen: cannot start the helper (${String(err)})`)
      this.scheduleRestart()
      return
    }
    this.child = child
    createInterface({ input: child.stdout!, crlfDelay: Number.POSITIVE_INFINITY }).on('line', (line) => {
      const next = parseFullscreenLine(line)
      if (!next) return
      this.restartDelay = 1000
      const changed = next.active !== this.info.active || JSON.stringify(next.monitor) !== JSON.stringify(this.info.monitor)
      this.info = next
      if (changed) this.emit('change', next)
    })
    child.once('error', (err) => this.log(`fullscreen: helper error (${err.message})`))
    child.once('exit', () => {
      if (this.child === child) this.child = null
      if (this.enabled) this.scheduleRestart()
    })
  }

  private stop(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const child = this.child
    this.child = null
    if (child) {
      child.stdin?.end()
      setTimeout(() => child.kill(), 1000).unref()
    }
    if (this.info.active) {
      this.info = NOT_FULLSCREEN
      this.emit('change', this.info)
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer || !this.enabled) return
    const delay = this.restartDelay
    this.restartDelay = Math.min(MAX_RESTART_MS, delay * 2)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start()
    }, delay)
  }
}
