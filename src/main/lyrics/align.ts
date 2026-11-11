import type { TimedLyrics } from '@shared/types'
import type { ParsedLine } from './lrc'

/**
 * Do two independent lyric sources time the same recording? Lines are matched by their text
 * (within a few seconds of each other) and the start offsets compared. The same recording gives
 * a small, steady offset; another edit (a verse cut, a longer intro) gives large or scattered
 * ones. Used to accept NetEase word timing when its reported length differs from the player's.
 */
export interface LineAgreement {
  matched: number
  /** Median of (word-timed start − reference start), ms. */
  medianOffsetMs: number
  /** Median absolute deviation of those offsets, ms. */
  spreadMs: number
  agrees: boolean
}

const MATCH_WINDOW_MS = 5000
const MIN_MATCHED = 5
const MAX_MEDIAN_OFFSET_MS = 750
const MAX_SPREAD_MS = 400

/** Offsets smaller than this are noise between two hand-made syncs; no shift is applied. */
const SHIFT_MIN_MS = 250

/**
 * Decides whether word timing from a recording whose length differs by `gapMs` can be used,
 * and by how much to shift it. The same recording with a longer intro or outro shows a steady
 * offset no larger than the length difference: the word timing is shifted onto the reference
 * (which was matched to the player's own recording). Scattered offsets mean another edit.
 */
export function looseAlignment(a: LineAgreement, gapMs: number): { use: boolean; shiftMs: number } {
  const steady = a.matched >= MIN_MATCHED && a.spreadMs <= MAX_SPREAD_MS
  if (!steady || Math.abs(a.medianOffsetMs) > Math.abs(gapMs) + MAX_MEDIAN_OFFSET_MS) return { use: false, shiftMs: 0 }
  return { use: true, shiftMs: Math.abs(a.medianOffsetMs) >= SHIFT_MIN_MS ? -a.medianOffsetMs : 0 }
}

/** Moves every line and word by `ms` (never before 0). */
export function shiftLyrics(lyrics: TimedLyrics, ms: number): TimedLyrics {
  if (!ms) return lyrics
  const at = (t: number): number => Math.max(0, Math.round(t + ms))
  return {
    ...lyrics,
    lines: lyrics.lines.map((l) => ({
      ...l,
      start: at(l.start),
      end: at(l.end),
      words: l.words.map((w) => ({ ...w, start: at(w.start), end: at(w.end) }))
    }))
  }
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]/gu, '')

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export function compareLineTiming(word: TimedLyrics, reference: ParsedLine[]): LineAgreement {
  const pool = reference.map((l) => ({ key: norm(l.text), start: l.start, used: false })).filter((p) => p.key)
  const offsets: number[] = []
  for (const line of word.lines) {
    const key = norm(line.text)
    if (!key) continue
    let best: (typeof pool)[number] | null = null
    for (const p of pool) {
      if (p.used || p.key !== key || Math.abs(p.start - line.start) > MATCH_WINDOW_MS) continue
      if (!best || Math.abs(p.start - line.start) < Math.abs(best.start - line.start)) best = p
    }
    if (best) {
      best.used = true
      offsets.push(line.start - best.start)
    }
  }
  if (!offsets.length) return { matched: 0, medianOffsetMs: 0, spreadMs: 0, agrees: false }
  const m = median(offsets)
  const spread = median(offsets.map((o) => Math.abs(o - m)))
  return {
    matched: offsets.length,
    medianOffsetMs: Math.round(m),
    spreadMs: Math.round(spread),
    agrees: offsets.length >= MIN_MATCHED && Math.abs(m) <= MAX_MEDIAN_OFFSET_MS && spread <= MAX_SPREAD_MS
  }
}
