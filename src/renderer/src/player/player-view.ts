import type { AmbientPalette } from '@shared/lighting'
import type { Artwork, LyricsStatus, PlayerConfig, TimedLyrics, TrackInfo } from '@shared/types'
import { albumDrive } from '../ambient/drive'
import { createAmbientLayer } from '../ambient/ambient-layer'
import type { LyricsModel } from '../stage/model'
import { setStyle } from '../stage/style-cache'
import type { FrameInfo, StageStyle } from '../stage/styles/types'
import { ChromeFader } from './chrome-fader'
import { formatTime, progressOf, sourceLabel, splitTitle } from './format'
import { createLyricLines } from './lyric-lines'

/** Without art for this long after a track change, the card shows its fallback. */
const ART_WAIT_MS = 1200
const ART_SLOTS = 2

const STATUS_TEXT: Partial<Record<LyricsStatus, string>> = {
  searching: 'Finding lyrics…',
  'not-found': 'No synced lyrics for this song',
  instrumental: 'Instrumental',
  error: 'Lyrics are unavailable right now'
}

/** Per animation setting: how far the sung word lifts and how wide its glow is. */
const EMPHASIS = {
  low: { lift: '0em', glow: '0em' },
  medium: { lift: '-0.03em', glow: '0.26em' },
  high: { lift: '-0.05em', glow: '0.4em' }
} as const

const clockFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** An original placeholder for missing album art: two overlapping rings (no third-party artwork). */
const FALLBACK_SVG = `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="26" cy="32" r="14" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="38" cy="32" r="14" fill="none" stroke="currentColor" stroke-width="2.2" opacity="0.55"/></svg>`

export interface PlayerView extends StageStyle {
  setTrack(track: TrackInfo | null, status: LyricsStatus, lyrics: TimedLyrics | null): void
  setArtwork(artwork: Artwork | null): void
  setAmbient(ambient: AmbientPalette): void
  setConfig(config: PlayerConfig, systemReducedMotion: boolean): void
  setPlaying(playing: boolean): void
  /** Watch-only sessions show the cursor and the top bar while the mouse moves. */
  setWatchOnly(watchOnly: boolean): void
  /** Mouse moved over the screen. */
  poke(now: number): void
}

/**
 * The LUMINA full-screen player: album-art ambient light, the cover, track info, progress
 * and line-synced lyrics with word fill. Drawn by the stage loop like any lyric style.
 */
export function createPlayerView(): PlayerView {
  const ambient = createAmbientLayer()
  const lines = createLyricLines()
  const chrome = new ChromeFader()

  const root = el('div', 'lm-player')
  const ambientHost = el('div', 'lm-ambient-host')
  const grain = el('div', 'lm-grain')
  const vignette = el('div', 'lm-vignette')

  const top = el('div', 'lm-chrome')
  const brand = el('div', 'lm-brand', 'LUMINA')
  const source = el('div', 'lm-source')
  const escHint = el('div', 'lm-esc', 'Esc to close')
  top.append(brand, source, escHint)
  const clock = el('div', 'lm-clock')

  const stage = el('div', 'lm-stage')
  const side = el('div', 'lm-side')
  const art = el('div', 'lm-art')
  const fallback = el('div', 'lm-art-fallback')
  fallback.innerHTML = FALLBACK_SVG
  const slots = Array.from({ length: ART_SLOTS }, () => {
    const img = el('img', 'lm-art-img')
    img.alt = ''
    img.decoding = 'async'
    img.draggable = false
    return img
  })
  art.append(fallback, ...slots)

  const meta = el('div', 'lm-meta')
  const title = el('div', 'lm-title')
  const artist = el('div', 'lm-artist')
  meta.append(title, artist)

  const progress = el('div', 'lm-progress')
  const bar = el('div', 'lm-bar')
  const fill = el('div', 'lm-bar-fill')
  bar.append(fill)
  const times = el('div', 'lm-times')
  const elapsed = el('span', 'lm-time')
  const paused = el('span', 'lm-pill', 'Paused')
  const remaining = el('span', 'lm-time')
  times.append(elapsed, paused, remaining)
  progress.append(bar, times)

  const badge = el('div', 'lm-badge')
  side.append(art, meta, progress, badge)

  const main = el('div', 'lm-main')
  const message = el('div', 'lm-message')
  stage.append(side, main)

  const idle = el('div', 'lm-idle')
  idle.append(
    el('div', 'lm-idle-mark', 'LUMINA'),
    el('div', 'lm-idle-title', 'Waiting for music'),
    el('div', 'lm-idle-hint', 'Play a song in Spotify or Apple Music and it appears here.')
  )

  let track: TrackInfo | null = null
  let status: LyricsStatus = 'idle'
  let hasLyrics = false
  let playing = false
  let watchOnly = false
  let config: PlayerConfig | null = null
  let reducedMotion = false
  let latestArt: Artwork | null = null
  let shownSlot = -1
  let artToken = 0
  let artWaitTimer: ReturnType<typeof setTimeout> | null = null
  let artPending: Promise<void> = Promise.resolve()
  let shownMinute = -1
  let shownElapsed = ''
  let shownRemaining = ''

  function showFallback(): void {
    for (const img of slots) img.classList.remove('is-shown')
    fallback.classList.add('is-shown')
    shownSlot = -1
  }

  function showArt(artwork: Artwork): void {
    const token = ++artToken
    const next = (shownSlot + 1) % ART_SLOTS
    const img = slots[next]!
    img.src = artwork.dataUrl
    artPending = img.decode().then(
      () => {
        if (token !== artToken) return
        img.classList.add('is-shown')
        for (const other of slots) if (other !== img) other.classList.remove('is-shown')
        fallback.classList.remove('is-shown')
        shownSlot = next
      },
      () => {
        if (token === artToken) showFallback()
      }
    )
  }

  function clearArtWait(): void {
    if (artWaitTimer) clearTimeout(artWaitTimer)
    artWaitTimer = null
  }

  /** Shows the art for the current track, or waits briefly for it before falling back. */
  function syncArt(): void {
    clearArtWait()
    if (track && latestArt?.trackKey === track.key) {
      showArt(latestArt)
      return
    }
    artToken++
    if (!track) {
      showFallback()
      return
    }
    artWaitTimer = setTimeout(() => {
      artWaitTimer = null
      showFallback()
    }, ART_WAIT_MS)
  }

  /** Replays the rise-in animation on the track info and lyrics (track changes). */
  function replayRise(): void {
    for (const node of [meta, main]) {
      node.classList.remove('lm-rise')
      void node.offsetWidth
      node.classList.add('lm-rise')
    }
  }

  function applyMotion(): void {
    root.dataset.motion = reducedMotion ? 'reduced' : 'full'
    root.dataset.lite = config && !config.gpu ? 'true' : 'false'
    const emphasis = EMPHASIS[config?.animation ?? 'medium']
    root.style.setProperty('--lm-lift', reducedMotion ? '0em' : emphasis.lift)
    root.style.setProperty('--lm-glow', reducedMotion || (config && !config.gpu) ? '0em' : emphasis.glow)
    lines.setOptions({
      animation: config?.animation ?? 'medium',
      reducedMotion,
      scale: config?.lyricScale ?? 1
    })
  }

  function updateMessage(): void {
    const text = hasLyrics ? '' : (STATUS_TEXT[status] ?? '')
    message.textContent = text
    message.hidden = !text
  }

  return {
    mount(parent) {
      root.append(ambientHost, vignette, grain, top, clock, stage, idle)
      ambient.mount(ambientHost)
      lines.mount(main)
      main.append(message)
      parent.append(root)
      root.dataset.state = 'idle'
      root.dataset.playing = 'false'
      applyMotion()
      updateMessage()
      chrome.poke(performance.now())
    },

    setLyrics(model: LyricsModel | null) {
      hasLyrics = !!model
      lines.setLyrics(model)
      updateMessage()
    },

    setTrack(next, nextStatus, lyrics) {
      const changed = next?.key !== track?.key
      track = next
      status = nextStatus
      root.dataset.state = next ? 'track' : 'idle'
      if (changed) {
        const { main: name, extra } = splitTitle(next?.title || 'Unknown title')
        title.textContent = name
        if (extra) title.append(' ', el('span', 'lm-title-extra', extra))
        artist.textContent = next ? [next.artist, next.album].filter(Boolean).join(' — ') : ''
        source.textContent = next ? sourceLabel(next.app) : ''
        shownElapsed = ''
        shownRemaining = ''
        syncArt()
        if (next) replayRise()
      }
      badge.textContent = lyrics ? (lyrics.wordTiming === 'native' ? 'Word-synced' : 'Line-synced') : ''
      badge.hidden = !lyrics
      progress.hidden = !next || !(next.durationMs > 0)
      updateMessage()
    },

    setArtwork(artwork) {
      latestArt = artwork
      if (artwork && track && artwork.trackKey === track.key) {
        clearArtWait()
        showArt(artwork)
      } else if (!artwork && track) {
        clearArtWait()
        showFallback()
      }
    },

    setAmbient(next) {
      ambient.setColors(next.colors)
      const s = root.style
      const accents = ['--lm-accent', '--lm-accent-2', '--lm-accent-3', '--lm-accent-4']
      accents.forEach((name, i) => s.setProperty(name, next.colors[i % next.colors.length] ?? '#b98cff'))
    },

    setConfig(next, systemReducedMotion) {
      config = next
      reducedMotion = next.reducedMotion || systemReducedMotion
      ambient.setEnabled(next.ambient)
      ambient.setBrightness(next.brightness)
      applyMotion()
    },

    setPlaying(next) {
      playing = next
      root.dataset.playing = String(next)
    },

    setWatchOnly(next) {
      watchOnly = next
      if (next) chrome.poke(performance.now())
      else chrome.hide()
    },

    poke(now) {
      if (watchOnly) chrome.poke(now)
    },

    setPalette() {
      // The player draws in white tiers and album-derived accents; lyric colours belong to the styles.
    },

    setMode() {
      // The player only runs on the full-screen lyrics screen.
    },

    frame({ songMs, wallMs, width, height, settle }: FrameInfo): boolean {
      if (settle && artWaitTimer) {
        clearArtWait()
        showFallback()
      }

      ambient.frame(
        wallMs,
        albumDrive({ playing, animation: config?.animation ?? 'medium', still: reducedMotion || !(config?.gpu ?? true) }),
        { width, height },
        settle
      )

      const chromeOn = watchOnly && chrome.visible(wallMs)
      root.classList.toggle('is-chrome', chromeOn)
      document.body.classList.toggle('lm-cursor', chromeOn)

      const epoch = Date.now()
      const minute = Math.floor(epoch / 60_000)
      if (minute !== shownMinute) {
        shownMinute = minute
        clock.textContent = clockFormat
          .formatToParts(new Date(epoch))
          .filter((part) => part.type !== 'dayPeriod')
          .map((part) => part.value)
          .join('')
          .trim()
      }

      if (!track) return false

      const duration = track.durationMs
      if (duration > 0) {
        const p = progressOf(songMs, duration)
        setStyle(fill, 'transform', `scaleX(${p.toFixed(4)})`)
        const e = formatTime(Math.min(songMs, duration))
        const r = `-${formatTime(duration - Math.min(songMs, duration))}`
        if (e !== shownElapsed) elapsed.textContent = shownElapsed = e
        if (r !== shownRemaining) remaining.textContent = shownRemaining = r
      }

      return lines.frame({ songMs, wallMs, playing, settle: !!settle })
    },

    async ready() {
      await artPending
    },

    destroy() {
      clearArtWait()
      artToken++
      ambient.destroy()
      lines.destroy()
      document.body.classList.remove('lm-cursor')
      root.remove()
    }
  }
}
