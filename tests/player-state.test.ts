import { describe, expect, it } from 'vitest'
import { approach } from '../src/renderer/src/ambient/drive'
import { CHROME_HIDE_MS, ChromeFader } from '../src/renderer/src/player/chrome-fader'
import { formatTime, progressOf, sourceLabel, splitTitle } from '../src/renderer/src/player/format'
import { FrameGate, targetFps } from '../src/renderer/src/stage/frame-gate'

describe('formatTime', () => {
  it('formats song time like a player', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(9_400)).toBe('0:09')
    expect(formatTime(187_000)).toBe('3:07')
    expect(formatTime(3_725_000)).toBe('1:02:05')
  })

  it('shows 0:00 for negative or unknown times', () => {
    expect(formatTime(-500)).toBe('0:00')
    expect(formatTime(Number.NaN)).toBe('0:00')
  })
})

describe('progressOf', () => {
  it('is clamped to 0–1 and 0 without a duration', () => {
    expect(progressOf(30_000, 120_000)).toBe(0.25)
    expect(progressOf(-10, 120_000)).toBe(0)
    expect(progressOf(130_000, 120_000)).toBe(1)
    expect(progressOf(30_000, 0)).toBe(0)
  })
})

describe('sourceLabel', () => {
  it('names Spotify and Apple Music and nothing else', () => {
    expect(sourceLabel('Spotify.exe')).toBe('Spotify')
    expect(sourceLabel('SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify')).toBe('Spotify')
    expect(sourceLabel('AppleInc.AppleMusicWin_nzyj5cx40ttqa!App')).toBe('Apple Music')
    expect(sourceLabel('chrome')).toBe('')
  })
})

describe('splitTitle', () => {
  it('moves featured artists and version suffixes into a quieter part', () => {
    expect(splitTitle('Paper Lanterns (feat. Lantern Choir)')).toEqual({ main: 'Paper Lanterns', extra: '(feat. Lantern Choir)' })
    expect(splitTitle('Paper Lanterns [with The Test Band]')).toEqual({ main: 'Paper Lanterns', extra: '[with The Test Band]' })
    expect(splitTitle('Paper Lanterns - Remastered 2011')).toEqual({ main: 'Paper Lanterns', extra: '- Remastered 2011' })
    expect(splitTitle('Paper Lanterns - Live at the Harbor')).toEqual({ main: 'Paper Lanterns', extra: '- Live at the Harbor' })
  })

  it('leaves ordinary titles, including ones with brackets or dashes, alone', () => {
    expect(splitTitle('Paper Lanterns')).toEqual({ main: 'Paper Lanterns', extra: '' })
    expect(splitTitle('Lanterns (Interlude)')).toEqual({ main: 'Lanterns (Interlude)', extra: '' })
    expect(splitTitle('Lanterns - Part Two')).toEqual({ main: 'Lanterns - Part Two', extra: '' })
    expect(splitTitle('(feat. Nobody)')).toEqual({ main: '(feat. Nobody)', extra: '' })
  })
})

describe('ChromeFader', () => {
  it('is hidden until the mouse moves, then hides again after a rest', () => {
    const fader = new ChromeFader()
    expect(fader.visible(1000)).toBe(false)
    fader.poke(1000)
    expect(fader.visible(1000 + CHROME_HIDE_MS - 1)).toBe(true)
    expect(fader.visible(1000 + CHROME_HIDE_MS)).toBe(false)
  })

  it('can be hidden at once', () => {
    const fader = new ChromeFader(500)
    fader.poke(0)
    fader.hide()
    expect(fader.visible(1)).toBe(false)
  })
})

describe('frame rate policy', () => {
  it('draws the lyrics screen at full rate only while busy, unless limited', () => {
    expect(targetFps('lock', true, 0)).toBe(Number.POSITIVE_INFINITY)
    expect(targetFps('lock', false, 0)).toBe(24)
    expect(targetFps('lock', true, 60)).toBe(60)
    expect(targetFps('lock', false, 120)).toBe(24)
  })

  it('keeps the overlay at its lower rates, and a limit can lower them further', () => {
    expect(targetFps('always', true, 0)).toBe(30)
    expect(targetFps('always', true, 120)).toBe(30)
    expect(targetFps('always', true, 30)).toBe(30)
    expect(targetFps('always', false, 30)).toBe(15)
  })

  /** Frames drawn in one second of display refreshes at `hz` for a target `fps`. */
  function framesPerSecond(hz: number, fps: number): number {
    const gate = new FrameGate()
    let drawn = 0
    for (let t = 0; t < 1000; t += 1000 / hz) if (gate.due(t, fps)) drawn++
    return drawn
  }

  it('hits the target rate on average, even when it does not divide the refresh rate', () => {
    // ±1: the first refresh at t = 0 always draws.
    const near = (hz: number, fps: number, expected: number): void =>
      expect(Math.abs(framesPerSecond(hz, fps) - expected)).toBeLessThanOrEqual(1)
    near(240, 120, 120)
    near(240, 60, 60)
    near(240, 30, 30)
    near(179.9, 120, 120) // a 180 Hz panel: not 90
    near(179.9, 60, 60)
    near(144, 240, 144) // never more than the display can show
    near(60, Number.POSITIVE_INFINITY, 60)
  })

  it('restarts its schedule after a stall instead of bursting to catch up', () => {
    const gate = new FrameGate()
    expect(gate.due(0, 60)).toBe(true)
    expect(gate.due(500, 60)).toBe(true) // a 500 ms stall
    expect(gate.due(504, 60)).toBe(false)
    expect(gate.due(516.7, 60)).toBe(true)
  })
})

describe('approach', () => {
  it('moves toward the target independently of frame rate', () => {
    const oneStep = approach(0, 1, 100, 100)
    const tenSteps = Array.from({ length: 10 }).reduce<number>((v) => approach(v, 1, 10, 100), 0)
    expect(oneStep).toBeCloseTo(1 - Math.exp(-1))
    expect(tenSteps).toBeCloseTo(oneStep)
  })

  it('jumps on the first frame and holds when no time passed', () => {
    expect(approach(0, 1, Number.POSITIVE_INFINITY, 100)).toBe(1)
    expect(approach(0.3, 1, 0, 100)).toBe(0.3)
  })
})
