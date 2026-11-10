/**
 * Audio analysis worker thread. Owns the lumina-helper capture process, so raw PCM never touches
 * Electron's main thread: helper stdout → packet reader → FFT analysis → compact frames posted up.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { parentPort, workerData } from 'node:worker_threads'
import { AudioAnalyzer } from './analysis'
import { PacketReader, parseHelperStatus } from './packets'
import type { WorkerData, WorkerReply, WorkerRequest } from './worker-protocol'

const data = workerData as WorkerData
const port = parentPort!
const post = (reply: WorkerReply): void => port.postMessage(reply)

let analyzer: AudioAnalyzer | null = null
let child: ChildProcess | null = null
let killTimer: ReturnType<typeof setTimeout> | null = null
const reader = new PacketReader()

function start(): void {
  try {
    child = spawn(data.helperPath, ['capture', '--source', data.source, '--parent', String(data.parentPid)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (err) {
    post({ type: 'exit', code: null, error: `cannot start the audio helper (${String(err)})` })
    return
  }
  child.stdout!.on('data', (chunk: Buffer) =>
    reader.push(chunk, (packet) => {
      if (packet.kind === 'pcm') {
        // Frames carry the wall-clock time they were analysed, so consumers can measure delivery latency.
        analyzer?.push(packet.samples, (frame) => post({ type: 'frame', frame: { ...frame, timestamp: Date.now() } }))
        return
      }
      const status = parseHelperStatus(packet.message)
      if (!status) return
      if (status.sampleRate && status.sampleRate !== analyzer?.sampleRate) analyzer = new AudioAnalyzer(status.sampleRate)
      post({ type: 'status', status })
    })
  )
  child.stderr!.on('data', (chunk: Buffer) => post({ type: 'log', message: chunk.toString('utf8').trim().slice(0, 300) }))
  child.on('error', (err) => post({ type: 'exit', code: null, error: err.message }))
  child.on('exit', (code) => {
    if (killTimer) clearTimeout(killTimer)
    child = null
    post({ type: 'exit', code, error: reader.corrupt ? `${reader.corrupt} corrupt packets` : undefined })
  })
}

port.on('message', (msg: WorkerRequest) => {
  if (msg.type !== 'stop' || !child) return
  // Closing stdin asks the helper to release its audio client and exit; kill it if it does not.
  child.stdin?.end()
  const proc = child
  killTimer = setTimeout(() => proc.kill(), 1500)
})

start()
