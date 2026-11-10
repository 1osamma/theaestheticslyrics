import createAnalysisWorker from './worker?nodeWorker'
import type { AudioWorker } from './audio-service'
import type { AudioSource, WorkerData } from './worker-protocol'

/** Starts the analysis worker thread (bundled separately by electron-vite). */
export function createAudioWorker(helperPath: string, source: AudioSource): AudioWorker {
  const workerData: WorkerData = { helperPath, source, parentPid: process.pid }
  return createAnalysisWorker({ workerData }) as unknown as AudioWorker
}
