import { describe, expect, it } from 'vitest'
import { DEFAULT_LYRICS, DEFAULT_LYRICS_SETTINGS, lyricsConfigOf, pickLyricsPatch } from '../src/shared/lyrics-style'

describe('LUMINA Lyrics settings helpers', () => {
  it('maps the stored fields onto the renderer config', () => {
    expect(lyricsConfigOf(DEFAULT_LYRICS_SETTINGS)).toEqual(DEFAULT_LYRICS)
    expect(lyricsConfigOf({ ...DEFAULT_LYRICS_SETTINGS, lyricEffect: 'scale', lyricFont: 'fraunces' })).toMatchObject({
      effect: 'scale',
      font: 'fraunces'
    })
  })

  it('accepts only lyrics keys from the settings window', () => {
    expect(pickLyricsPatch({ lyricEffect: 'glow', lyricIntensity: 0.3, style: 'visual', offsetMs: 900, lockOnReturn: true })).toEqual({
      lyricEffect: 'glow',
      lyricIntensity: 0.3
    })
    expect(pickLyricsPatch(null)).toEqual({})
    expect(pickLyricsPatch('lyricEffect')).toEqual({})
  })
})
