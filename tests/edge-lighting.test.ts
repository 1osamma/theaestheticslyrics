import { describe, expect, it } from 'vitest'
import { EDGE_IDLE_HIDE_MS, coveredByFullscreen, edgeHold, edgeTargets, type DisplayLike, type EdgeFacts } from '../src/main/ui/edge-logic'
import { NOT_FULLSCREEN, parseFullscreenLine } from '../src/main/ui/fullscreen-watcher'
import { audioLine } from '../src/main/ui/tray'
import { edgeWeights } from '../src/renderer/src/lighting/edge-weights'
import { pickLightingPatch } from '../src/shared/lighting'

// Two monitors: a 2560×1440 primary at 150% scaling and a 1920×1080 one to its right at 100%.
const primary: DisplayLike = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1707, height: 960 },
  physical: { x: 0, y: 0, width: 2560, height: 1440 }
}
const second: DisplayLike = {
  id: 2,
  bounds: { x: 1707, y: 0, width: 1920, height: 1080 },
  physical: { x: 2560, y: 0, width: 1920, height: 1080 }
}
const displays = [primary, second]

describe('edgeTargets', () => {
  it('lights the primary display, all displays, or one chosen display', () => {
    expect(edgeTargets('primary', displays, 1)).toEqual([primary])
    expect(edgeTargets('all', displays, 1)).toEqual(displays)
    expect(edgeTargets(2, displays, 1)).toEqual([second])
  })

  it('falls back to the primary display when the chosen one is disconnected', () => {
    expect(edgeTargets(99, displays, 1)).toEqual([primary])
    expect(edgeTargets('primary', [], 1)).toEqual([])
  })
})

describe('coveredByFullscreen', () => {
  it('holds only the monitor the full-screen app is on (physical pixels, high DPI)', () => {
    const game = { active: true, monitor: { x: 2560, y: 0, width: 1920, height: 1080 } }
    expect(coveredByFullscreen(second, game)).toBe(true)
    expect(coveredByFullscreen(primary, game)).toBe(false)
  })

  it('holds every monitor for exclusive full screen without a rectangle, none when nothing is full screen', () => {
    expect(coveredByFullscreen(primary, { active: true, monitor: null })).toBe(true)
    expect(coveredByFullscreen(primary, NOT_FULLSCREEN)).toBe(false)
  })
})

describe('edgeHold', () => {
  const showing: EdgeFacts = { enabled: true, modeOff: false, paused: false, suppressed: false, lyricsScreenOpen: false, idleMs: 0 }

  it('shows when enabled and music is playing', () => {
    expect(edgeHold(showing)).toBeNull()
  })

  it('names why it is held', () => {
    expect(edgeHold({ ...showing, enabled: false })).toMatch(/off/i)
    expect(edgeHold({ ...showing, modeOff: true })).toMatch(/mode is off/i)
    expect(edgeHold({ ...showing, paused: true })).toMatch(/paused/i)
    expect(edgeHold({ ...showing, suppressed: true })).toMatch(/windows/i)
    expect(edgeHold({ ...showing, lyricsScreenOpen: true })).toMatch(/player is open/i)
  })

  it('rests an idle OLED screen a minute after the music stops', () => {
    expect(edgeHold({ ...showing, idleMs: EDGE_IDLE_HIDE_MS - 1 })).toBeNull()
    expect(edgeHold({ ...showing, idleMs: EDGE_IDLE_HIDE_MS + 1 })).toMatch(/resting/i)
    expect(edgeHold({ ...showing, idleMs: Number.POSITIVE_INFINITY })).toMatch(/resting/i)
  })
})

describe('parseFullscreenLine', () => {
  it('reads valid helper output', () => {
    expect(parseFullscreenLine('{"type":"fullscreen","active":true,"quns":5,"pid":42,"monitor":{"x":0,"y":0,"width":2560,"height":1440}}')).toEqual({
      active: true,
      monitor: { x: 0, y: 0, width: 2560, height: 1440 }
    })
    expect(parseFullscreenLine('{"type":"fullscreen","active":false,"quns":5,"pid":1,"monitor":null}')).toEqual(NOT_FULLSCREEN)
  })

  it('rejects anything malformed', () => {
    expect(parseFullscreenLine('not json')).toBeNull()
    expect(parseFullscreenLine('{"type":"status","active":true}')).toBeNull()
    expect(parseFullscreenLine('{"type":"fullscreen","active":"yes"}')).toBeNull()
    expect(parseFullscreenLine('{"type":"fullscreen","active":true,"monitor":{"x":0,"y":0,"width":-5,"height":9}}')).toEqual({
      active: true,
      monitor: null
    })
  })
})

describe('pickLightingPatch', () => {
  it('keeps only lighting settings from an untrusted patch', () => {
    expect(pickLightingPatch({ lightingMode: 'bass', launchAtLogin: true, colors: {}, __proto__: { x: 1 } })).toEqual({ lightingMode: 'bass' })
    expect(pickLightingPatch(null)).toEqual({})
    expect(pickLightingPatch([1, 2])).toEqual({})
  })
})

describe('audioLine', () => {
  it('never claims Spotify-only capture when capturing all system audio', () => {
    expect(audioLine({ state: 'capturing', mode: 'process', message: '' })).toBe('Audio: Spotify only')
    expect(audioLine({ state: 'capturing', mode: 'system', message: '' })).toMatch(/all desktop audio/i)
    expect(audioLine({ state: 'capturing', mode: 'system', message: '' })).toMatch(/not Spotify only/i)
    expect(audioLine({ state: 'stopped', mode: null, message: '' })).toBeNull()
  })
})

describe('edgeWeights', () => {
  it('gives the side edges the primary glow, bottom secondary and top subtle', () => {
    expect(edgeWeights({ left: true, right: true, top: true, bottom: true })).toEqual([1, 1, 0.45, 0.7])
    expect(edgeWeights({ left: false, right: true, top: false, bottom: false })).toEqual([0, 1, 0, 0])
  })
})
