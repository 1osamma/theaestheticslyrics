import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type LyricsAppApi } from '@shared/ipc'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: LyricsAppApi = {
  stage: {
    onState: (cb) => subscribe(IPC.stageState, cb),
    onAnchor: (cb) => subscribe(IPC.stageAnchor, cb),
    onArtwork: (cb) => subscribe(IPC.stageArtwork, cb),
    onSnapshot: (cb) => subscribe(IPC.stageSnapshot, cb),
    onSession: (cb) => subscribe(IPC.stageSession, cb),
    onAudio: (cb) => subscribe(IPC.lightingAudio, cb),
    snapshotDone: (id) => ipcRenderer.send(IPC.stageSnapshotDone, id),
    dismiss: (request) =>
      ipcRenderer.send(IPC.stageDismiss, {
        kind: request.kind === 'escape' ? 'escape' : 'input',
        detail: String(request.detail).slice(0, 200)
      })
  },
  colors: {
    get: () => ipcRenderer.invoke(IPC.colorsGet),
    set: (role, hex) => ipcRenderer.send(IPC.colorsSet, role, hex),
    setAutoSync: (on) => ipcRenderer.send(IPC.colorsAutoSync, on),
    reset: () => ipcRenderer.send(IPC.colorsReset),
    onState: (cb) => subscribe(IPC.colorsState, cb)
  },
  edge: {
    onState: (cb) => subscribe(IPC.edgeState, cb),
    onAudio: (cb) => subscribe(IPC.lightingAudio, cb)
  },
  lighting: {
    get: () => ipcRenderer.invoke(IPC.lightingGet),
    set: (patch) => ipcRenderer.send(IPC.lightingSet, patch),
    setPaused: (paused) => ipcRenderer.send(IPC.lightingPause, paused === true),
    onState: (cb) => subscribe(IPC.lightingState, cb)
  }
}

contextBridge.exposeInMainWorld('lyricsApp', api)
