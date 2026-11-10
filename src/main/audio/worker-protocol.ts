import type { AudioAnalysisFrame } from '@shared/audio-frame'
import type { AudioSource } from '@shared/lighting'
import type { HelperStatus } from './packets'

export type { AudioSource }

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
