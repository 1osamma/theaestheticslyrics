import type { AudioAnalysisFrame } from '@shared/audio-frame'
import type { HelperStatus } from './packets'

/** Which audio to capture: Spotify only when possible (`auto`), Spotify only always, or everything. */
export type AudioSource = 'auto' | 'spotify' | 'system'

export interface WorkerData {
  helperPath: string
  source: AudioSource
  parentPid: number
}

export type WorkerRequest = { type: 'stop' }

export type WorkerReply =
  | { type: 'frame'; frame: AudioAnalysisFrame }
  | { type: 'status'; status: HelperStatus }
  | { type: 'log'; message: string }
  | { type: 'exit'; code: number | null; error?: string }
