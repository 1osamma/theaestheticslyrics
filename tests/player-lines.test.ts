import { describe, expect, it } from 'vitest'
import { INTERLUDE_MIN_MS, lineOpacity, lyricFocus, segmentLine, wordFill } from '../src/renderer/src/player/lines'
import { buildModel } from '../src/renderer/src/stage/model'
import type { TimedLyrics } from '../src/shared/types'

const lyrics: TimedLyrics = {
  wordTiming: 'native',
  lines: [
    {
      text: 'Lanterns drift, slowly',
      start: 6000,
      end: 8000,
      words: [
        { text: 'Lanterns', start: 6000, end: 6800 },
        { text: 'drift', start: 6800, end: 7400 },
        { text: 'slowly', start: 7400, end: 8000 }
      ]
    },
    {
      text: 'over paper water',
      start: 8200,
      end: 10_000,
      words: [
        { text: 'over', start: 8200, end: 8700 },
        { text: 'paper', start: 8700, end: 9300 },
        { text: 'water', start: 9300, end: 10_000 }
      ]
    },
    {
      text: 'home again',
      start: 20_000,
      end: 21_500,
      words: [
        { text: 'home', start: 20_000, end: 20_700 },
        { text: 'again', start: 20_700, end: 21_500 }
      ]
    }
  ]
}
const model = buildModel(lyrics)

describe('segmentLine', () => {
  it('keeps punctuation and spaces between the timed words', () => {
    const segments = segmentLine(lyrics.lines[0]!)
    expect(segments.map((s) => s.text).join('')).toBe('Lanterns drift, slowly')
    expect(segments.filter((s) => s.word !== null).map((s) => s.word)).toEqual([0, 1, 2])
    expect(segments.find((s) => s.text === ', ')?.word).toBeNull()
  })

  it('handles CJK lines that have no spaces', () => {
    const segments = segmentLine({
      text: '紙の灯',
      words: [
        { text: '紙', start: 0, end: 1 },
        { text: 'の', start: 1, end: 2 },
        { text: '灯', start: 2, end: 3 }
      ]
    })
    expect(segments).toEqual([
      { text: '紙', word: 0 },
      { text: 'の', word: 1 },
      { text: '灯', word: 2 }
    ])
  })

  it('still shows a word the line text spells differently', () => {
    const segments = segmentLine({
      text: 'hello there',
      words: [
        { text: 'hello', start: 0, end: 1 },
        { text: 'thar', start: 1, end: 2 }
      ]
    })
    expect(segments.filter((s) => s.word !== null).map((s) => s.text)).toEqual(['hello', 'thar'])
  })

  it('shows a note for a line without words', () => {
    expect(segmentLine({ text: '  ', words: [] })).toEqual([{ text: '♪', word: null }])
  })
})

describe('lyricFocus', () => {
  it('treats a long intro as an interlude before the first line', () => {
    expect(lyricFocus(model, 1000)).toMatchObject({ line: -1, interlude: true })
  })

  it('focuses the line being sung', () => {
    expect(lyricFocus(model, 7000)).toEqual({ line: 0, interlude: false, interludeProgress: 0 })
    expect(lyricFocus(model, 9000)).toMatchObject({ line: 1, interlude: false })
  })

  it('does not call a short gap between lines an interlude', () => {
    expect(lyricFocus(model, 8100).interlude).toBe(false)
  })

  it('detects an instrumental break and how far through it the song is', () => {
    const during = lyricFocus(model, 15_000)
    expect(during.line).toBe(1)
    expect(during.interlude).toBe(true)
    expect(during.interludeProgress).toBeGreaterThan(0)
    expect(during.interludeProgress).toBeLessThan(1)
    expect(20_000 - 10_000).toBeGreaterThanOrEqual(INTERLUDE_MIN_MS)
  })

  it('returns to the next line once it starts', () => {
    expect(lyricFocus(model, 20_100)).toMatchObject({ line: 2, interlude: false })
  })

  it('handles lyrics with no lines', () => {
    expect(lyricFocus(buildModel({ wordTiming: 'estimated', lines: [] }), 5000).line).toBe(-1)
  })
})

describe('wordFill', () => {
  const word = { start: 1000, end: 2000 }
  it('runs from 0 to 1 across the word', () => {
    expect(wordFill(word, 500)).toBe(0)
    expect(wordFill(word, 1500)).toBeCloseTo(0.5)
    expect(wordFill(word, 2500)).toBe(1)
  })

  it('survives a zero-length word', () => {
    expect(wordFill({ start: 1000, end: 1000 }, 1000)).toBe(0)
    expect(wordFill({ start: 1000, end: 1000 }, 1001)).toBe(1)
  })
})

describe('lineOpacity', () => {
  it('makes the sung line brightest, upcoming lines next, sung lines dimmest', () => {
    expect(lineOpacity(0, false)).toBe(1)
    expect(lineOpacity(1, false)).toBeGreaterThan(lineOpacity(-1, false))
    expect(lineOpacity(2, false)).toBeLessThan(lineOpacity(1, false))
    expect(lineOpacity(-3, false)).toBeLessThan(lineOpacity(-1, false))
  })

  it('dims the last line during an interlude and never fades a line out completely', () => {
    expect(lineOpacity(0, true)).toBeLessThan(1)
    expect(lineOpacity(-40, false)).toBeGreaterThan(0)
    expect(lineOpacity(40, false)).toBeGreaterThan(0)
  })
})
