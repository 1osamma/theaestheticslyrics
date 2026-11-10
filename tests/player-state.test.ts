import { describe, expect, it } from 'vitest'
import { albumDrive, approach } from '../src/renderer/src/ambient/drive'
import { CHROME_HIDE_MS, ChromeFader } from '../src/renderer/src/player/chrome-fader'
import { formatTime, progressOf, sourceLabel, splitTitle } from '../src/renderer/src/player/format'
import { frameDue, targetFps } from '../src/renderer/src/stage/frame-gate'

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

  it('skips display refreshes that come too soon for the target rate', () => {
    // 240 Hz refreshes every ~4.17 ms; a 120 FPS limit draws every other one.
    expect(frameDue(0, 4.17, 120)).toBe(false)
    expect(frameDue(0, 8.33, 120)).toBe(true)
    // 60 FPS on 240 Hz draws every fourth refresh.
    expect(frameDue(0, 12.5, 60)).toBe(false)
    expect(frameDue(0, 16.67, 60)).toBe(true)
    // A refresh that arrives a hair early still counts.
    expect(frameDue(0, 16.2, 60)).toBe(true)
    expect(frameDue(0, 0.1, Number.POSITIVE_INFINITY)).toBe(true)
  })
})

describe('album ambient drive', () => {
  it('dims and calms the light when the music pauses', () => {
    const playing = albumDrive({ playing: true, animation: 'medium', still: false })
    const paused = albumDrive({ playing: false, animation: 'medium', still: false })
    expect(paused.intensity).toBeLessThan(playing.intensity)
    expect(paused.motion).toBeLessThan(playing.motion)
  })

  it('scales motion with the animation setting and stops it for reduced motion', () => {
    const low = albumDrive({ playing: true, animation: 'low', still: false })
    const high = albumDrive({ playing: true, animation: 'high', still: false })
    expect(high.motion).toBeGreaterThan(low.motion)
    expect(albumDrive({ playing: true, animation: 'high', still: true }).motion).toBe(0)
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
