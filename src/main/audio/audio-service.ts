import { EventEmitter } from 'node:events'
import { sanitizeAudioFrame, type AudioAnalysisFrame, type AudioStatus } from '@shared/audio-frame'
import type { AudioSource, WorkerReply, WorkerRequest } from './worker-protocol'

/** The parts of a worker_threads Worker the service uses (a fake in tests). */
export interface AudioWorker {
  postMessage(msg: WorkerRequest): void
  on(event: 'message', fn: (msg: WorkerReply) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
  on(event: 'exit', fn: (code: number) => void): unknown
  terminate(): Promise<number>
}

export interface AudioServiceDeps {
  createWorker(source: AudioSource): AudioWorker
  log(message: string): void
}

interface AudioServiceEvents {
  frame: [AudioAnalysisFrame]
  status: [AudioStatus]
}

/** Capture keeps running this long after the last consumer leaves (the lyrics screen reopening, say). */
export const STOP_DELAY_MS = 4000
/** A worker that does not exit after a stop request is terminated after this. */
const STOP_GRACE_MS = 2500
const RESTART_MIN_MS = 1000
const RESTART_MAX_MS = 30_000

/**
 * Starts live audio analysis while something wants it (fullscreen lighting, edge lighting) and
 * stops it when nothing does. One worker serves every consumer. A crashed worker or helper is
 * restarted with backoff; failures never reach the lyrics.
 */
export class AudioService extends EventEmitter<AudioServiceEvents> {
  private worker: AudioWorker | null = null
  private wanted = false
  private source: AudioSource = 'system'
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private restartDelay = RESTART_MIN_MS
  private current: AudioStatus = { state: 'stopped', mode: null, message: '' }
  private disposed = false
  /** Frames forwarded and their level sums (diagnostics: `--perf-after` reports averages). */
  framesSeen = 0
  rejected = 0
  readonly levels = { frames: 0, silent: 0, bass: 0, mids: 0, treble: 0, intensity: 0, beats: 0 }
  private lastPulse = 0

  constructor(private readonly deps: AudioServiceDeps) {
    super()
  }

  get status(): AudioStatus {
    return this.current
  }

  get running(): boolean {
    return this.worker !== null
  }

  /** Something needs (or no longer needs) live audio. */
  setWanted(wanted: boolean): void {
    if (this.disposed || wanted === this.wanted) return
    this.wanted = wanted
    if (wanted) {
      this.clearStopTimer()
      if (!this.worker && !this.restartTimer) this.start()
      return
    }
    this.clearStopTimer()
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null
      if (!this.wanted) this.stop('no longer needed')
    }, STOP_DELAY_MS)
  }

  setSource(source: AudioSource): void {
    if (source === this.source) return
    this.source = source
    if (this.worker) {
      this.stop('capture source changed')
      if (this.wanted) this.start()
    }
  }

  dispose(): void {
    this.disposed = true
    this.wanted = false
    this.clearStopTimer()
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.stop('quitting')
  }

  private start(): void {
    this.setStatus({ state: 'starting', mode: null, message: 'Starting audio capture' })
    let worker: AudioWorker
    try {
      worker = this.deps.createWorker(this.source)
    } catch (err) {
      this.deps.log(`audio: cannot start the analysis worker (${String(err)})`)
      this.scheduleRestart()
      return
    }
    this.worker = worker
    this.deps.log(`audio: capture started (source ${this.source})`)
    worker.on('message', (msg) => this.onMessage(worker, msg))
    worker.on('error', (err) => this.deps.log(`audio: worker error (${err.message})`))
    worker.on('exit', () => this.onExit(worker, 'worker exited'))
  }

  private stop(why: string): void {
    const worker = this.worker
    if (!worker) {
      if (this.current.state !== 'stopped') this.setStatus({ state: 'stopped', mode: null, message: '' })
      return
    }
    this.worker = null
    this.deps.log(`audio: capture stopped (${why})`)
    try {
      worker.postMessage({ type: 'stop' })
    } catch {
      // Already gone.
    }
    const force = setTimeout(() => void worker.terminate(), STOP_GRACE_MS)
    worker.on('exit', () => clearTimeout(force))
    this.setStatus({ state: 'stopped', mode: null, message: '' })
  }

  private onMessage(worker: AudioWorker, msg: WorkerReply): void {
    if (worker !== this.worker) return
    switch (msg.type) {
      case 'frame': {
        const frame = sanitizeAudioFrame(msg.frame)
        if (!frame) {
          this.rejected++
          return
        }
        this.framesSeen++
        this.tally(frame)
        this.restartDelay = RESTART_MIN_MS
        this.emit('frame', frame)
        break
      }
      case 'status':
        this.setStatus({ state: msg.status.state, mode: msg.status.mode, message: msg.status.message })
        break
      case 'log':
        if (msg.message) this.deps.log(`audio helper: ${msg.message}`)
        break
      case 'exit':
        this.onExit(worker, msg.error ? `helper exited: ${msg.error}` : `helper exited with code ${msg.code ?? 'null'}`)
        break
    }
  }

  private onExit(worker: AudioWorker, why: string): void {
    if (worker !== this.worker) return
    this.worker = null
    void worker.terminate()
    this.deps.log(`audio: ${why}`)
    this.setStatus({ state: 'error', mode: null, message: 'Audio capture stopped unexpectedly, retrying' })
    if (this.wanted) this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.disposed || this.restartTimer) return
    const delay = this.restartDelay
    this.restartDelay = Math.min(RESTART_MAX_MS, this.restartDelay * 2)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.wanted && !this.worker) this.start()
    }, delay)
  }

  /** Clears the level sums. */
  resetLevels(): void {
    for (const key of Object.keys(this.levels) as (keyof typeof this.levels)[]) this.levels[key] = 0
  }

  private tally(frame: AudioAnalysisFrame): void {
    const l = this.levels
    l.frames++
    if (frame.isSilent) l.silent++
    l.bass += frame.bass
    l.mids += frame.mids
    l.treble += frame.treble
    l.intensity += frame.intensity
    if (frame.beatPulse > this.lastPulse + 0.2) l.beats++
    this.lastPulse = frame.beatPulse
  }

  private clearStopTimer(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer)
    this.stopTimer = null
  }

  private setStatus(status: AudioStatus): void {
    const c = this.current
    if (c.state === status.state && c.mode === status.mode && c.message === status.message) return
    this.current = status
    this.emit('status', status)
  }
}
