import { describe, expect, it } from 'vitest'
import type { RawSession } from '../src/main/media/protocol'
import { AnchorTracker } from '../src/main/media/timeline'
import { buildTimedLyrics } from '../src/main/lyrics/word-timing'
import { lyricFocus, stillSinging, wordFill } from '../src/renderer/src/player/lines'
import { FEATHER_EM, MOTION, sweepFeather, wordAnimations } from '../src/renderer/src/player/lyric-timeline'
import { compareLineTiming, looseAlignment, shiftLyrics } from '../src/main/lyrics/align'
import { SongClock } from '../src/renderer/src/stage/clock'
import { activeWordIndex, buildModel } from '../src/renderer/src/stage/model'
import type { TimedLyrics } from '../src/shared/types'

/**
 * Phase 4 regression tests. The media timelines below are real Spotify samples recorded on
 * 2026-11-11 (Windows media session, polled every 50 ms; epoch ms shortened by 1794431000000):
 * Spotify publishes its position about every 4.5 s, each sample consistent with the last to a few
 * ms; a pause is stamped ~600 ms after it took effect; a seek first reports the target position at
 * the seek moment, then corrects ~121 ms back once audio resumes.
 */
const T0 = 1794431000000
const spotify = (t: number, pos: number, updated: number, status: 'Playing' | 'Paused' = 'Playing'): [RawSession, number] => [
  { app: 'Spotify.exe', status, title: 'Lilith', artist: 'A', album: 'B', pos, start: 0, end: 240, updated: T0 + updated, rate: 1 },
  T0 + t
]

/** Feeds samples through the app's anchor tracker into the stage clock (perf time = epoch here). */
function play(samples: [RawSession, number][]) {
  const tracker = new AnchorTracker()
  const clock = new SongClock()
  for (const [s, t] of samples) clock.setAnchor(tracker.update(s, t), t, t)
  return { tracker, clock, at: (t: number) => clock.now(T0 + t, T0 + t) }
}

describe('Spotify position interpolation (recorded timelines)', () => {
  it('steady playback: each new position agrees with the running clock (no visible correction)', () => {
    const tracker = new AnchorTracker()
    const clock = new SongClock()
    const samples = [spotify(21839, 50.317, 18096), spotify(24269, 54.83, 22606), spotify(28342, 59.346, 27121)]
    for (const [s, t] of samples) {
      const before = clock.hasAnchor ? clock.now(t, t) : null
      const anchor = tracker.update(s, t)
      const truth = anchor.positionMs + (t - anchor.atEpochMs)
      if (before !== null) expect(Math.abs(before - truth)).toBeLessThan(20)
      clock.setAnchor(anchor, t, t)
    }
  })

  it('pause: holds exactly at the paused position, even though Spotify stamps it late', () => {
    const { at } = play([spotify(28342, 59.346, 27121), spotify(29718, 61.285, 29659, 'Paused')])
    expect(at(29718)).toBe(61285)
    expect(at(33000)).toBe(61285)
  })

  it('resume: continues from the resume stamp and agrees with the next update', () => {
    const { clock, at } = play([spotify(36151, 61.285, 36148, 'Paused'), spotify(38428, 61.722, 37610)])
    expect(at(38428)).toBe(61722 + 818)
    const tracker = new AnchorTracker()
    const next = tracker.update(spotify(40866, 64.937, 40809)[0], T0 + 40866)
    expect(Math.abs(clock.now(T0 + 40866, T0 + 40866) - (next.positionMs + 57))).toBeLessThan(20)
  })

  it('seek: jumps to the new position, then glides the buffering correction without a step', () => {
    const tracker = new AnchorTracker()
    const clock = new SongClock()
    const feed = (sample: [RawSession, number]): void => clock.setAnchor(tracker.update(...sample), sample[1], sample[1])
    feed(spotify(46487, 69.449, 45321))
    feed(spotify(49416, 60.0, 49387))
    const t = T0 + 49416
    expect(clock.now(t, t)).toBe(60029)
    const before = clock.now(T0 + 49901, T0 + 49901)
    feed(spotify(49901, 60.016, 49524))
    // Same moment, after the corrected sample: no visible jump (the 121 ms glides away).
    expect(Math.abs(clock.now(T0 + 49901, T0 + 49901) - before)).toBeLessThanOrEqual(1)
    // 300 ms later the clock shows Spotify's corrected position exactly.
    const later = T0 + 50250
    expect(clock.now(later, later)).toBe(60016 + (50250 - 49524))
  })

  it('track change: the new song starts from its own position with no carried correction', () => {
    const tracker = new AnchorTracker()
    const clock = new SongClock()
    const a = spotify(28342, 59.346, 27121)
    clock.setAnchor(tracker.update(...a), a[1], a[1])
    const next: RawSession = { ...a[0], title: 'Next song', pos: 0.4, updated: T0 + 30000 }
    clock.setAnchor(tracker.update(next, T0 + 30010), T0 + 30010, T0 + 30010)
    expect(clock.now(T0 + 30010, T0 + 30010)).toBe(410)
    expect(clock.trackKey).toContain('Next song')
  })
})

// Two back-to-back lines as NetEase times them: the last word ends exactly when the next line starts.
const contiguous: TimedLyrics = {
  wordTiming: 'native',
  lines: [
    {
      text: 'hold the night',
      start: 1000,
      end: 3000,
      words: [
        { text: 'hold', start: 1000, end: 1300 },
        { text: 'the', start: 1300, end: 1400 },
        { text: 'night', start: 1400, end: 3000 }
      ]
    },
    {
      text: 'run run run',
      start: 3000,
      end: 3300,
      words: [
        { text: 'run', start: 3000, end: 3090 },
        { text: 'run', start: 3090, end: 3180 },
        { text: 'run', start: 3180, end: 3300 }
      ]
    },
    { text: 'slowly', start: 9000, end: 11000, words: [{ text: 'slowly', start: 9000, end: 11000 }] }
  ]
}

describe('line handover (the last word is never cut short)', () => {
  const model = buildModel(contiguous)
  const lead = MOTION.balanced.leadMs

  it('keeps the outgoing line singing while the view already leads to the next line', () => {
    const t = 3000 - 120 // inside the lead: the view focuses line 1, "night" is still being sung
    const focus = lyricFocus(model, t + lead)
    expect(focus.line).toBe(1)
    expect(stillSinging(model, t, focus.line)).toBe(0)
    expect(wordFill(contiguous.lines[0]!.words[2]!, t)).toBeLessThan(1)
  })

  it('releases it exactly when its last word ends', () => {
    expect(stillSinging(model, 3000, lyricFocus(model, 3000 + lead).line)).toBe(-1)
  })

  it('does not hold a line whose words ended before the handover (slow transition)', () => {
    const t = 9000 - 100
    expect(stillSinging(model, t, lyricFocus(model, t + lead).line)).toBe(-1)
  })

  it('after a seek far ahead or back, nothing is held over', () => {
    expect(stillSinging(model, 10_000, lyricFocus(model, 10_000 + lead).line)).toBe(-1)
    expect(stillSinging(model, 500, lyricFocus(model, 500 + lead).line)).toBe(-1)
  })
})

describe('fast and slow words keep their timestamps', () => {
  it('very fast native words stay exact and in order through the timing builder', () => {
    const built = buildTimedLyrics([{ start: 3000, end: 3300, text: 'run run run', words: contiguous.lines[1]!.words }])!
    expect(built.lines[0]!.words.map((w) => [w.start, w.end])).toEqual([
      [3000, 3090],
      [3090, 3180],
      [3180, 3300]
    ])
  })

  it('every effect starts each fast word on its own timestamp and finishes the sweep by its end', () => {
    for (const w of contiguous.lines[1]!.words) {
      const specs = wordAnimations('fill', { start: w.start, end: w.end, travel: 100, intensity: 0.6, motion: MOTION.balanced })
      for (const s of specs) expect(s.start).toBe(w.start)
      expect(specs.find((s) => s.part === 'clip')!.duration).toBe(w.end - w.start)
    }
  })

  it('the text-only styles pick the word being sung at any moment, fast or slow', () => {
    const model = buildModel(contiguous)
    expect(model.words[activeWordIndex(model, 3089)]!.start).toBe(3000)
    expect(model.words[activeWordIndex(model, 3090)]!.start).toBe(3090)
    expect(model.words[activeWordIndex(model, 2999)]!.text).toBe('night')
    expect(model.words[activeWordIndex(model, 9500)]!.text).toBe('slowly')
  })

  it('an estimated slow line before a long instrumental is not stretched across the gap', () => {
    const built = buildTimedLyrics([
      { start: 0, text: 'one two three four' },
      { start: 2000, text: 'five six seven eight' },
      { start: 30_000, text: 'nine ten' }
    ])!
    const second = built.lines[1]!
    expect(second.words.at(-1)!.end).toBeLessThan(10_000)
  })
})

describe('sweep edge on short words (fast vocals)', () => {
  it('keeps the full soft edge on ordinary words', () => {
    expect(sweepFeather(2)).toBe(FEATHER_EM)
    expect(sweepFeather(0.9)).toBe(FEATHER_EM)
  })

  it('lights the first letter of any word within the first third of its time', () => {
    // The solid light reaches the word after feather / (word + feather) of the word's duration.
    for (const wordEm of [0.28, 0.4, 0.6, 1, 2, 4]) {
      const feather = sweepFeather(wordEm)
      expect(feather / (wordEm + feather)).toBeLessThanOrEqual(0.34)
    }
  })

  it('used to lag on short words with the fixed edge (the bug this guards)', () => {
    const fixed = FEATHER_EM / (0.3 + FEATHER_EM)
    expect(fixed).toBeGreaterThan(0.55)
  })
})

describe('line timing agreement between two sources', () => {
  const word = (offsets: number[]): TimedLyrics => ({
    wordTiming: 'native',
    lines: offsets.map((o, i) => ({ text: `line ${i} words`, start: i * 4000 + o, end: i * 4000 + o + 2000, words: [{ text: 'line', start: i * 4000 + o, end: i * 4000 + o + 2000 }] }))
  })
  const reference = Array.from({ length: 8 }, (_, i) => ({ start: i * 4000, text: `Line ${i}, words!` }))

  it('agrees for the same recording with a steady offset', () => {
    expect(compareLineTiming(word([120, 90, 150, 110, 130, 100, 140, 120]), reference)).toMatchObject({ agrees: true, matched: 8 })
  })

  it('disagrees for another edit (later lines shifted by seconds)', () => {
    expect(compareLineTiming(word([0, 0, 0, 3500, 3600, 3400, 3500, 3550]), reference).agrees).toBe(false)
  })

  it('disagrees when too few lines can be compared', () => {
    expect(compareLineTiming(word([0, 0, 0]), reference.slice(0, 3)).agrees).toBe(false)
  })
})

describe('aligning a longer recording onto the player recording', () => {
  it('shifts a steady offset (extra intro) onto the reference lines', () => {
    const decision = looseAlignment({ matched: 33, medianOffsetMs: 1143, spreadMs: 272, agrees: false }, 3000)
    expect(decision).toEqual({ use: true, shiftMs: -1143 })
    const shifted = shiftLyrics(contiguous, decision.shiftMs)
    expect(shifted.lines[0]!.words[0]!.start).toBe(0)
    expect(shifted.lines[2]!.words[0]!.start).toBe(9000 - 1143)
  })

  it('applies no shift for small offsets between two hand-made syncs', () => {
    expect(looseAlignment({ matched: 31, medianOffsetMs: -90, spreadMs: 80, agrees: true }, 3000)).toEqual({ use: true, shiftMs: 0 })
  })

  it('rejects scattered offsets or offsets larger than the length difference allows', () => {
    expect(looseAlignment({ matched: 20, medianOffsetMs: 300, spreadMs: 900, agrees: false }, 3000).use).toBe(false)
    expect(looseAlignment({ matched: 20, medianOffsetMs: 5200, spreadMs: 100, agrees: false }, 3000).use).toBe(false)
    expect(looseAlignment({ matched: 3, medianOffsetMs: 0, spreadMs: 0, agrees: false }, 3000).use).toBe(false)
  })
})
