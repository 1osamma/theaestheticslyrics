import type { FetchLike } from './lrclib'
import { MIN_SCORE, scoreMatch, type TrackQuery } from './match'
import { cleanTitle, primaryArtist } from './normalize'

export interface NeteaseSong {
  id: number
  title: string
  artist: string
  album: string
  durationSec: number
}

export type NeteaseResult =
  /**
   * `loose`: the recording's length differs from the player's by more than STRICT_GAP_S, so its
   * timing must be confirmed against the song's line-timed lyrics before use (service.ts).
   */
  | { status: 'found'; yrc: string; song: NeteaseSong; loose: boolean }
  | { status: 'not-found' }
  | { status: 'error'; message: string }

/** Word timings only fit the exact recording: within this length gap it is taken as the same one. */
export const STRICT_GAP_S = 3
/**
 * Up to this gap a recording is still considered, but only used when its line timing agrees with
 * the song's line-timed lyrics. Spotify's media session often reports a length 3–4 s shorter than
 * the real track, which used to reject the right recording.
 */
const LOOSE_GAP_S = 8
const MAX_CANDIDATES = 3
const MIN_TIMED_LINES = 3
const TIMED_LINE = /^\[\d+,\d+\]/gm
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36'

type Reply = { kind: 'ok'; body: Record<string, unknown> } | { kind: 'error'; message: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function toSongs(body: Record<string, unknown>): NeteaseSong[] {
  const songs = isRecord(body.result) && Array.isArray(body.result.songs) ? body.result.songs : []
  return songs.flatMap((s: unknown) => {
    if (!isRecord(s) || typeof s.id !== 'number' || typeof s.name !== 'string') return []
    const artists = Array.isArray(s.ar) ? s.ar.map((a: unknown) => (isRecord(a) && typeof a.name === 'string' ? a.name : '')) : []
    return [
      {
        id: s.id,
        title: s.name,
        artist: artists.filter(Boolean).join(', '),
        album: isRecord(s.al) && typeof s.al.name === 'string' ? s.al.name : '',
        durationSec: typeof s.dt === 'number' ? s.dt / 1000 : 0
      }
    ]
  })
}

const readYrc = (body: Record<string, unknown>): string | null =>
  isRecord(body.yrc) && typeof body.yrc.lyric === 'string' ? body.yrc.lyric : null

/**
 * NetEase Cloud Music (unofficial web API): many songs carry real per-word timing ("YRC").
 * Used alongside LRCLIB; any failure here simply falls back to LRCLIB's line timing.
 */
export class NeteaseClient {
  private readonly fetch: FetchLike
  private readonly timeoutMs: number
  private readonly baseUrl: string

  constructor(opts: { fetch?: FetchLike; timeoutMs?: number; baseUrl?: string } = {}) {
    this.fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init))
    this.timeoutMs = opts.timeoutMs ?? 6000
    this.baseUrl = (opts.baseUrl ?? 'https://music.163.com').replace(/\/$/, '')
  }

  async find(q: TrackQuery): Promise<NeteaseResult> {
    const terms = [cleanTitle(q.title), q.artist.trim() ? primaryArtist(q.artist) : q.album.trim()].filter(Boolean).join(' ')
    const search = await this.get(`/api/cloudsearch/pc?${new URLSearchParams({ s: terms, type: '1', offset: '0', limit: '10' })}`)
    if (search.kind === 'error') return { status: 'error', message: search.message }

    const gapOf = (song: NeteaseSong): number =>
      q.durationMs > 0 && song.durationSec > 0 ? Math.abs(q.durationMs / 1000 - song.durationSec) : 0
    const candidates = toSongs(search.body)
      .map((song) => ({
        song,
        loose: gapOf(song) > STRICT_GAP_S,
        score: scoreMatch(q, { title: song.title, artist: song.artist, album: song.album, durationSec: song.durationSec }, LOOSE_GAP_S)
      }))
      .filter((c) => c.score >= MIN_SCORE)
      // Recordings whose length agrees outright come first.
      .sort((a, b) => Number(a.loose) - Number(b.loose) || b.score - a.score)
      .slice(0, MAX_CANDIDATES)

    let failure: string | null = null
    let answered = false
    for (const { song, loose } of candidates) {
      const params = new URLSearchParams({ id: String(song.id), lv: '-1', kv: '-1', tv: '-1', rv: '-1', yv: '-1', ytv: '-1', yrv: '-1' })
      const lyric = await this.get(`/api/song/lyric/v1?${params}`)
      if (lyric.kind === 'error') {
        failure = lyric.message
        continue
      }
      answered = true
      const yrc = readYrc(lyric.body)
      if (yrc && (yrc.match(TIMED_LINE)?.length ?? 0) >= MIN_TIMED_LINES) return { status: 'found', yrc, song, loose }
    }
    // Only "every request failed" is an error; an answer without word timing means not found.
    return failure && !answered ? { status: 'error', message: failure } : { status: 'not-found' }
  }

  private async get(path: string): Promise<Reply> {
    try {
      const res = await this.fetch(`${this.baseUrl}${path}`, {
        headers: { 'User-Agent': BROWSER_UA, Referer: 'https://music.163.com/', Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs)
      })
      if (!res.ok) return { kind: 'error', message: `HTTP ${res.status}` }
      const body = await res.json().catch(() => null)
      if (!isRecord(body)) return { kind: 'error', message: 'unreadable reply' }
      if (body.code !== 200) return { kind: 'error', message: `service code ${String(body.code)}` }
      return { kind: 'ok', body }
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
    }
  }
}
