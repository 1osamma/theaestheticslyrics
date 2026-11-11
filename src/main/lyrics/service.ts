import type { TimedLyrics } from '@shared/types'
import { LyricsCache, cacheKey, type CacheEntry } from './cache'
import type { LocalLyrics } from './local'
import { parseLrc } from './lrc'
import type { LrclibClient } from './lrclib'
import { parseLyricsfile } from './lyricsfile'
import type { LrclibRecord, TrackQuery } from './match'
import type { NeteaseClient, NeteaseResult } from './netease'
import { buildTimedLyrics } from './word-timing'
import { parseYrc } from './yrc'
import { compareLineTiming, looseAlignment, shiftLyrics } from './align'

/**
 * Bumped when the NetEase lookup finds more songs, so songs cached as "no word timing" by an
 * older version are asked once more. 2: recordings up to 8 s longer or shorter, confirmed by
 * line timing.
 */
export const WORD_LOOKUP_VERSION = 2

export interface LyricsResult {
  status: 'found' | 'not-found' | 'instrumental' | 'error'
  lyrics: TimedLyrics | null
  source?: 'local' | 'cache' | 'lrclib' | 'netease'
}

const durationOrUndefined = (ms: number): number | undefined => (ms > 0 ? ms : undefined)

/** Prefers the `lyricsfile` (it may carry real line ends or word timing), then LRC. */
export function recordToTimedLyrics(r: LrclibRecord, durationMs: number): TimedLyrics | null {
  const duration = durationMs > 0 ? durationMs : r.duration > 0 ? Math.round(r.duration * 1000) : undefined
  if (r.lyricsfile) {
    const lines = parseLyricsfile(r.lyricsfile)
    const timed = lines && buildTimedLyrics(lines, duration)
    if (timed) return timed
  }
  return r.syncedLyrics ? buildTimedLyrics(parseLrc(r.syncedLyrics), duration) : null
}

export function yrcToTimedLyrics(yrc: string, durationMs: number): TimedLyrics | null {
  const lines = parseYrc(yrc)
  return lines ? buildTimedLyrics(lines, durationOrUndefined(durationMs)) : null
}

export interface LyricsServiceDeps {
  local: LocalLyrics
  cache: LyricsCache
  client: LrclibClient
  log: (message: string) => void
  now?: () => number
  /** Optional source of real per-word timing (NetEase), consulted alongside LRCLIB. */
  wordLevel?: { client: Pick<NeteaseClient, 'find'>; enabled: () => boolean }
}

/**
 * Local `.lrc` → disk cache → network. On the network, LRCLIB (line timing) and NetEase
 * (word timing, when enabled) are asked in parallel and real word timing wins.
 * Errors are never cached, so the next play retries.
 */
export class LyricsService {
  private readonly now: () => number

  constructor(private readonly deps: LyricsServiceDeps) {
    this.now = deps.now ?? Date.now
  }

  async get(q: TrackQuery): Promise<LyricsResult> {
    const local = await this.fromLocal(q)
    if (local) return local

    const useWords = this.deps.wordLevel?.enabled() ?? false
    const key = cacheKey(q)
    const cached = await this.deps.cache.get(key)
    if (cached) {
      if (useWords && !cached.yrc && (!cached.wordChecked || (cached.wordVersion ?? 1) < WORD_LOOKUP_VERSION)) {
        // Cached before word timing was available (or NetEase failed last time): ask once.
        const upgraded = await this.askWordLevel(q, key, cached)
        if (upgraded) return upgraded
      }
      return this.fromEntry(cached, q, 'cache', useWords)
    }

    const [line, word] = await Promise.all([
      this.deps.client.find(q),
      useWords ? this.findWords(q) : Promise.resolve<NeteaseResult | null>(null)
    ])

    const timing = this.wordTiming(word, q, line.status === 'found' ? line.record : undefined)
    const wordChecked = word !== null && word.status !== 'error'

    if (timing && word?.status === 'found') {
      const entry: CacheEntry = {
        status: 'found',
        ...(line.status === 'found' ? { record: line.record } : {}),
        yrc: word.yrc,
        ...(timing.shiftMs ? { yrcShiftMs: timing.shiftMs } : {}),
        wordChecked: true,
        wordVersion: WORD_LOOKUP_VERSION,
        fetchedAt: this.now()
      }
      await this.save(key, entry)
      return { status: 'found', lyrics: timing.lyrics, source: 'netease' }
    }

    if (line.status === 'error') {
      this.deps.log(`lyrics: lrclib error (${line.message})`)
      return { status: 'error', lyrics: null }
    }

    let entry: CacheEntry
    const wordVersion = WORD_LOOKUP_VERSION
    if (line.status === 'not-found') entry = { status: 'not-found', wordChecked, wordVersion, fetchedAt: this.now() }
    else if (line.record.instrumental) entry = { status: 'instrumental', record: line.record, wordChecked, wordVersion, fetchedAt: this.now() }
    else if (!recordToTimedLyrics(line.record, q.durationMs)) entry = { status: 'not-found', wordChecked, wordVersion, fetchedAt: this.now() }
    else entry = { status: 'found', record: line.record, wordChecked, wordVersion, fetchedAt: this.now() }

    await this.save(key, entry)
    return this.fromEntry(entry, q, 'lrclib', useWords)
  }

  private async findWords(q: TrackQuery): Promise<NeteaseResult> {
    try {
      const result = await this.deps.wordLevel!.client.find(q)
      if (result.status === 'error') this.deps.log(`lyrics: netease unavailable (${result.message})`)
      return result
    } catch (err) {
      this.deps.log(`lyrics: netease failed (${String(err)})`)
      return { status: 'error', message: String(err) }
    }
  }

  private async askWordLevel(q: TrackQuery, key: string, cached: CacheEntry): Promise<LyricsResult | null> {
    const word = await this.findWords(q)
    if (word.status === 'error') return null
    const timing = this.wordTiming(word, q, cached.record)
    if (timing && word.status === 'found') {
      const shift = timing.shiftMs ? { yrcShiftMs: timing.shiftMs } : {}
      await this.save(key, { ...cached, status: 'found', yrc: word.yrc, ...shift, wordChecked: true, wordVersion: WORD_LOOKUP_VERSION })
      return { status: 'found', lyrics: timing.lyrics, source: 'netease' }
    }
    await this.save(key, { ...cached, wordChecked: true, wordVersion: WORD_LOOKUP_VERSION })
    return null
  }

  /**
   * NetEase word timing for the song, or null. A recording whose length differs by more than a few
   * seconds is only used when its line timing agrees with the line-timed lyrics (`reference`).
   */
  private wordTiming(
    word: NeteaseResult | null,
    q: TrackQuery,
    reference: LrclibRecord | undefined
  ): { lyrics: TimedLyrics; shiftMs: number } | null {
    if (!word) return null
    if (word.status === 'not-found') {
      this.deps.log('lyrics: netease has no word timing for this recording')
      return null
    }
    if (word.status !== 'found') return null
    const lyrics = yrcToTimedLyrics(word.yrc, q.durationMs)
    if (!lyrics) return null
    if (!word.loose) return { lyrics, shiftMs: 0 }
    const gap = Math.round(word.song.durationSec - q.durationMs / 1000)
    const lines = reference?.syncedLyrics ? parseLrc(reference.syncedLyrics) : []
    const check = compareLineTiming(lyrics, lines)
    const decision = looseAlignment(check, (word.song.durationSec * 1000 - q.durationMs))
    this.deps.log(
      `lyrics: netease recording is ${gap > 0 ? '+' : ''}${gap} s from the player's length; line timing ` +
        `${decision.use ? (decision.shiftMs ? `is steady, aligned by ${decision.shiftMs} ms` : 'agrees') : 'does not agree'} ` +
        `(${check.matched} lines, median ${check.medianOffsetMs} ms, spread ${check.spreadMs} ms)`
    )
    return decision.use ? { lyrics: shiftLyrics(lyrics, decision.shiftMs), shiftMs: decision.shiftMs } : null
  }

  private async save(key: string, entry: CacheEntry): Promise<void> {
    await this.deps.cache.set(key, entry).catch((err: unknown) => this.deps.log(`lyrics: cache write failed (${String(err)})`))
  }

  private async fromLocal(q: TrackQuery): Promise<LyricsResult | null> {
    try {
      const text = await this.deps.local.find(q)
      if (!text) return null
      const lyrics = buildTimedLyrics(parseLrc(text), durationOrUndefined(q.durationMs))
      if (lyrics) return { status: 'found', lyrics, source: 'local' }
      this.deps.log('lyrics: local file had no timed lines, ignoring it')
    } catch (err) {
      this.deps.log(`lyrics: local lookup failed (${String(err)})`)
    }
    return null
  }

  private fromEntry(entry: CacheEntry, q: TrackQuery, source: 'cache' | 'lrclib', useWords: boolean): LyricsResult {
    if (useWords && entry.yrc) {
      const lyrics = yrcToTimedLyrics(entry.yrc, q.durationMs)
      if (lyrics) return { status: 'found', lyrics: shiftLyrics(lyrics, entry.yrcShiftMs ?? 0), source }
    }
    if (entry.status === 'instrumental') return { status: 'instrumental', lyrics: null, source }
    const lyrics = entry.status === 'found' && entry.record ? recordToTimedLyrics(entry.record, q.durationMs) : null
    return lyrics ? { status: 'found', lyrics, source } : { status: 'not-found', lyrics: null, source }
  }
}
