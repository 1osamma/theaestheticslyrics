import type { TimedLine, TimedWord } from '@shared/types'
import { activeLineIndex, type LyricsModel } from '../stage/model'

/** A run of a lyric line's original text: a timed word, or the spaces and punctuation between words. */
export interface Segment {
  text: string
  /** Index into the line's `words`, or null for the text between words. */
  word: number | null
}

/**
 * Splits a line's original text into timed words and the text around them, so the player keeps
 * the punctuation the word tokens drop ("city," stays "city,"). A word the text does not contain
 * (a source that respelled it) is still shown, as its own segment.
 */
export function segmentLine(line: Pick<TimedLine, 'text' | 'words'>): Segment[] {
  const segments: Segment[] = []
  const text = line.text
  let cursor = 0
  line.words.forEach((word: TimedWord, i) => {
    const at = word.text ? text.indexOf(word.text, cursor) : -1
    if (at < 0) {
      if (segments.length && segments.at(-1)!.word !== null) segments.push({ text: ' ', word: null })
      segments.push({ text: word.text, word: i })
      return
    }
    if (at > cursor) segments.push({ text: text.slice(cursor, at), word: null })
    segments.push({ text: word.text, word: i })
    cursor = at + word.text.length
  })
  if (cursor < text.length && line.words.length) segments.push({ text: text.slice(cursor), word: null })
  if (!line.words.length) segments.push({ text: text.trim() || '♪', word: null })
  return segments
}

/** After a line ends, a gap longer than this before the next one is an interlude. */
export const INTERLUDE_MIN_MS = 4000
/** A line still counts as being sung this long after its last word. */
const LINE_LINGER_MS = 900

export interface LyricFocus {
  /** The line to centre: the one being sung, or the last one sung during an interlude; -1 before the first. */
  line: number
  /** True while no line is being sung: an intro or an instrumental break of at least INTERLUDE_MIN_MS. */
  interlude: boolean
  /** 0–1 through the interlude (for its breathing dots), 0 otherwise. */
  interludeProgress: number
}

export function lyricFocus(model: LyricsModel, t: number): LyricFocus {
  const lines = model.lines
  if (!lines.length) return { line: -1, interlude: false, interludeProgress: 0 }
  const line = activeLineIndex(model, t)
  const gapEnd = lines[line + 1]?.start ?? Number.POSITIVE_INFINITY
  const gapStart = line < 0 ? 0 : lines[line]!.end + LINE_LINGER_MS
  const interlude = t >= gapStart && gapEnd - gapStart >= INTERLUDE_MIN_MS && t < gapEnd
  const interludeProgress =
    interlude && Number.isFinite(gapEnd) ? Math.min(1, Math.max(0, (t - gapStart) / (gapEnd - gapStart))) : 0
  return { line, interlude, interludeProgress }
}

/** How far through a word the singing is, 0–1. */
export function wordFill(word: Pick<TimedWord, 'start' | 'end'>, t: number): number {
  if (t <= word.start) return 0
  if (t >= word.end) return 1
  return (t - word.start) / Math.max(1, word.end - word.start)
}

/** Opacity of a line by its distance from the focused one (negative = already sung). */
export function lineOpacity(distance: number, interlude: boolean): number {
  if (distance === 0) return interlude ? 0.3 : 1
  if (distance < 0) return Math.max(0.08, 0.22 + 0.05 * (distance + 1))
  return Math.max(0.1, 0.38 - 0.08 * (distance - 1))
}
