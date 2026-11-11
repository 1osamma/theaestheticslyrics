import type { AudioAnalysisFrame, AudioStatus } from './audio-frame'
import type { AmbientPalette, LightingConfig, LightingSettings } from './lighting'
import type { LyricsSettings } from './lyrics-style'
import type {
  Artwork,
  ColorRole,
  FrameRateCap,
  FullscreenLayout,
  LyricsStatus,
  Palette,
  PlaybackAnchor,
  PlayerConfig,
  ShowOn,
  StyleId,
  TimedLyrics,
  TrackInfo
} from './types'

export const IPC = {
  stageState: 'stage:state',
  stageAnchor: 'stage:anchor',
  stageArtwork: 'stage:artwork',
  stageDismiss: 'stage:dismiss',
  stageSession: 'stage:session',
  stageSnapshot: 'stage:snapshot',
  stageSnapshotDone: 'stage:snapshot-done',
  lightingAudio: 'lighting:audio',
  edgeState: 'edge:state',
  lightingGet: 'lighting:get',
  lightingSet: 'lighting:set',
  lightingState: 'lighting:state',
  lightingPause: 'lighting:pause',
  colorsGet: 'colors:get',
  colorsSet: 'colors:set',
  colorsAutoSync: 'colors:auto-sync',
  colorsReset: 'colors:reset',
  colorsState: 'colors:state'
} as const

export interface StageConfig {
  style: StyleId
  mode: ShowOn
  palette: Palette
  offsetMs: number
  /** Only the lock-style screen uses the player; the overlay always draws `style`. */
  layout: FullscreenLayout
  player: PlayerConfig
  frameRateCap: FrameRateCap
  /** Player lighting; `mode` is 'off' when fullscreen lighting is turned off. */
  lighting: LightingConfig
}

/** Everything the stage needs besides the moving playback clock. */
export interface StageState {
  track: TrackInfo | null
  lyrics: TimedLyrics | null
  lyricsStatus: LyricsStatus
  ambient: AmbientPalette
  config: StageConfig
}

/** Snapshot mode: render exactly this moment, then acknowledge with the same id. */
export interface SnapshotRequest {
  id: number
  songMs: number
  wallMs: number
}

/** Input on the lyrics screen: Esc always means "close"; anything else only closes some sessions. */
export interface DismissRequest {
  kind: 'escape' | 'input'
  /** What happened, for the log. */
  detail: string
}

/** Sent when the lyrics screen opens. */
export interface StageSessionInfo {
  /** A short on-screen tip (e.g. "Press Esc to close"), or null. */
  hint: string | null
  /** Stray input is ignored (only Esc closes), so the screen may show the cursor and chrome on mouse moves. */
  watchOnly: boolean
}

/** What a desktop edge-lighting window draws. */
export interface EdgeState {
  lighting: LightingConfig
  ambient: AmbientPalette
}

/** The LUMINA Lighting settings window. */
/** What the LUMINA settings window shows and may change: lighting, lyrics and Reduce animations. */
export type PanelSettings = LightingSettings & LyricsSettings & { reducedMotion: boolean }

export interface LightingPanelState {
  settings: PanelSettings
  displays: { id: number; label: string }[]
  audio: AudioStatus
  /** Edge lighting windows currently showing. */
  edgeShowing: number
  /** Why edge lighting is not showing although enabled, or null. */
  edgeHeldBy: string | null
  paused: boolean
  gpu: boolean
  /** The tab the window was last opened on (from the tray); `seq` changes on every open. */
  open?: { tab: 'lyrics' | 'lighting'; seq: number }
}

export interface ColorsState {
  autoSync: boolean
  colors: Record<ColorRole, string>
  /** What the stage is drawing right now (album palette when Auto Sync is on). */
  effective: Palette
}

export interface StageApi {
  onState(cb: (state: StageState) => void): () => void
  onAnchor(cb: (anchor: PlaybackAnchor) => void): () => void
  /** Album art for the current track, or null when there is none. Sent only when it changes. */
  onArtwork(cb: (artwork: Artwork | null) => void): () => void
  onSnapshot(cb: (req: SnapshotRequest) => void): () => void
  onSession(cb: (info: StageSessionInfo) => void): () => void
  /** Live audio analysis for the player lighting (~60 Hz while it is needed). */
  onAudio(cb: (frame: AudioAnalysisFrame) => void): () => void
  snapshotDone(id: number): void
  /** Input on the lyrics screen; the main process decides whether it closes the screen. */
  dismiss(request: DismissRequest): void
}

export interface ColorsApi {
  get(): Promise<ColorsState>
  set(role: ColorRole, hex: string): void
  setAutoSync(on: boolean): void
  reset(): void
  onState(cb: (state: ColorsState) => void): () => void
}

export interface EdgeApi {
  onState(cb: (state: EdgeState) => void): () => void
  onAudio(cb: (frame: AudioAnalysisFrame) => void): () => void
}

export interface LightingApi {
  get(): Promise<LightingPanelState>
  /** Only lighting, lyrics and Reduce animations keys are accepted; the main process validates every value. */
  set(patch: Partial<PanelSettings>): void
  setPaused(paused: boolean): void
  onState(cb: (state: LightingPanelState) => void): () => void
}

export interface LyricsAppApi {
  stage: StageApi
  colors: ColorsApi
  edge: EdgeApi
  lighting: LightingApi
}
