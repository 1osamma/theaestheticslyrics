import { approach } from '../ambient/drive'
import { activeWordIndex, type LyricsModel } from '../stage/model'
import { setStyle } from '../stage/style-cache'
import type { AnimationIntensity } from '@shared/types'
import { lineOpacity, lyricFocus, segmentLine, wordFill } from './lines'

/** The focused line's top sits this far down the lyrics column. */
const ANCHOR = 0.34
/** Scroll smoothing time constant per animation setting (ms). */
const SCROLL_TAU: Record<AnimationIntensity, number> = { low: 170, medium: 130, high: 105 }
/** Lines around the focused one recede slightly. */
const RECEDE_SCALE = 0.965

interface LineView {
  el: HTMLDivElement
  /** One span per timed word, in order. */
  words: HTMLSpanElement[]
  /** Text between words, each tagged with the word before it (-1 = before the first word). */
  gaps: { el: HTMLSpanElement; after: number }[]
  /** True once every word is drawn in full; avoids touching resting lines every frame. */
  full: boolean
}

export interface LyricLinesOptions {
  animation: AnimationIntensity
  reducedMotion: boolean
  /** Font size multiplier. */
  scale: number
}

export interface LyricLinesFrame {
  songMs: number
  wallMs: number
  playing: boolean
  settle: boolean
}

/**
 * Line-by-line synced lyrics for the LUMINA player. Every word is its own span whose fill
 * (`--p`) follows its real or estimated timing, so the sung part sweeps across the word.
 * Only the word being sung changes each frame; lines change opacity and scale through CSS
 * transitions, and the column scrolls with one transform.
 */
export function createLyricLines() {
  let root: HTMLDivElement | null = null
  let track: HTMLDivElement | null = null
  let dots: HTMLDivElement | null = null
  let model: LyricsModel | null = null
  let views: LineView[] = []
  let tops: number[] = []
  let heights: number[] = []
  let measuredFor = ''
  let options: LyricLinesOptions = { animation: 'medium', reducedMotion: false, scale: 1 }
  let y: number | null = null
  let lastWall: number | null = null

  function build(): void {
    if (!track) return
    track.replaceChildren()
    views = []
    measuredFor = ''
    y = null
    for (const line of model?.lines ?? []) {
      const el = document.createElement('div')
      el.className = 'lm-line'
      const view: LineView = { el, words: [], gaps: [], full: false }
      for (const seg of segmentLine(line)) {
        const span = document.createElement('span')
        span.textContent = seg.text
        if (seg.word === null) {
          span.className = 'lm-gap'
          view.gaps.push({ el: span, after: view.words.length - 1 })
        } else {
          span.className = 'lm-word'
          view.words.push(span)
        }
        el.append(span)
      }
      track.append(el)
      views.push(view)
    }
    dots = document.createElement('div')
    dots.className = 'lm-interlude'
    dots.append(...[0, 1, 2].map(() => document.createElement('i')))
    track.append(dots)
  }

  function measure(key: string): void {
    if (measuredFor === key) return
    measuredFor = key
    tops = views.map((v) => v.el.offsetTop)
    heights = views.map((v) => v.el.offsetHeight)
  }

  /** Draws every word of a line in full (lines that are not being sung). */
  function fillLine(view: LineView): void {
    if (view.full) return
    view.full = true
    for (const w of view.words) {
      setStyle(w, '--p', '1')
      w.classList.remove('is-active')
    }
    for (const g of view.gaps) g.el.classList.add('is-sung')
  }

  return {
    mount(parent: HTMLElement): void {
      root = document.createElement('div')
      root.className = 'lm-lyrics'
      track = document.createElement('div')
      track.className = 'lm-lyrics-track'
      root.append(track)
      parent.append(root)
      build()
    },

    setLyrics(next: LyricsModel | null): void {
      model = next
      build()
    },

    setOptions(next: LyricLinesOptions): void {
      if (next.scale !== options.scale) measuredFor = ''
      options = next
      root?.style.setProperty('--lm-lyric-scale', String(next.scale))
    },

    /** Returns true while it needs full-rate frames (scrolling, or a word filling during playback). */
    frame({ songMs: t, wallMs, playing, settle }: LyricLinesFrame): boolean {
      if (!root || !track || !model || !views.length) return false
      const H = root.clientHeight
      measure(`${root.clientWidth}x${H}x${options.scale}`)

      const focus = lyricFocus(model, t)
      // Before the first line, line 0 waits at the anchor as "up next".
      const anchorLine = Math.max(0, focus.line)
      const dotsHeight = dots?.offsetHeight ?? 0
      const interludeShift = focus.interlude && focus.line >= 0 ? dotsHeight : 0

      // Lines: opacity and scale by distance from the focused line (CSS transitions animate them).
      views.forEach((view, i) => {
        const distance = focus.line < 0 ? i + 1 : i - focus.line
        const recede = distance !== 0 && !options.reducedMotion ? RECEDE_SCALE : 1
        const shift = distance > 0 ? interludeShift : 0
        setStyle(view.el, 'opacity', lineOpacity(distance, focus.interlude).toFixed(3))
        setStyle(view.el, 'transform', `translateY(${shift.toFixed(1)}px) scale(${recede})`)
        if (distance !== 0 || focus.interlude) fillLine(view)
      })

      // Words of the line being sung.
      let filling = false
      const current = focus.line >= 0 && !focus.interlude ? views[focus.line] : undefined
      if (current) {
        current.full = false
        const line = model.lines[focus.line]!
        const active = activeWordIndex(model, t)
        const fills = line.words.map((w) => wordFill(w, t))
        current.words.forEach((span, i) => {
          const fill = fills[i]!
          setStyle(span, '--p', fill >= 1 ? '1' : fill <= 0 ? '0' : fill.toFixed(3))
          const isActive = model!.words[active]?.line === focus.line && model!.words[active]?.indexInLine === i && fill < 1
          span.classList.toggle('is-active', isActive)
          if (isActive && fill > 0) filling = true
        })
        for (const g of current.gaps) g.el.classList.toggle('is-sung', g.after >= 0 && fills[g.after]! >= 1)
      }

      // Interlude dots sit just under the last sung line and breathe with the break's progress.
      if (dots) {
        const showDots = focus.interlude && focus.line >= 0
        const top = showDots ? tops[focus.line]! + heights[focus.line]! : 0
        setStyle(dots, 'top', `${top.toFixed(1)}px`)
        setStyle(dots, 'opacity', showDots ? '1' : '0')
        dots.classList.toggle('is-on', showDots)
      }

      // Scroll: the focused line (or the dots during an interlude) rests at the anchor.
      const anchorY = H * ANCHOR
      const target = anchorY - (tops[anchorLine] ?? 0) - (interludeShift ? heights[anchorLine]! * 0.5 : 0)
      const dt = lastWall === null ? Number.POSITIVE_INFINITY : wallMs - lastWall
      lastWall = wallMs
      if (y === null || settle || options.reducedMotion || Math.abs(target - y) > H) y = target
      else y = approach(y, target, dt, SCROLL_TAU[options.animation])
      if (Math.abs(target - y) < 0.3) y = target
      setStyle(track, 'transform', `translate3d(0, ${y.toFixed(2)}px, 0)`)

      return y !== target || (playing && filling)
    },

    destroy(): void {
      root?.remove()
      root = null
      track = null
      dots = null
      views = []
    }
  }
}

export type LyricLines = ReturnType<typeof createLyricLines>
