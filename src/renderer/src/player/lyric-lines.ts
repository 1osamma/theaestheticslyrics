import { approach } from '../ambient/drive'
import { activeWordIndex, type LyricsModel } from '../stage/model'
import { setStyle } from '../stage/style-cache'
import type { AnimationIntensity } from '@shared/types'
import { groupUnits, lineOpacity, lyricFocus, segmentLine, wordFill } from './lines'

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
  /**
   * What the line's words currently show, as `${activeWord}:${done}`, or 'full' for a line drawn
   * entirely sung. Word classes change only when this changes, never per frame.
   */
  state: string
}

/**
 * The word being sung, drawn by one overlay placed over it inside its line: a dimmed copy, a
 * pre-rasterised glow, and a white copy inside a clip window with a feathered edge. Each frame only
 * moves the clip window and counter-moves its text (two transforms the compositor applies), so the
 * sweep never repaints text, re-runs a filter or touches layout.
 */
interface FillView {
  root: HTMLDivElement
  base: HTMLSpanElement
  glow: HTMLSpanElement
  clip: HTMLSpanElement
  sung: HTMLSpanElement
  /** Line and word index it covers, and the layout it was measured for. */
  key: string
  /**
   * How far the clip window travels (px): the word plus its feather. The window is also 0.5em wider
   * on the left for the glow, which must not shift the sweep edge.
   */
  travel: number
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
 * Line-by-line synced lyrics for the LUMINA player. Every word is its own span; the word being
 * sung is swept by a compositor-only overlay (see `FillView`) following its real or estimated
 * timing. Lines change opacity and scale through CSS transitions, and the column scrolls with
 * one transform, so a frame repaints nothing.
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
  let fill: FillView | null = null

  function createFill(): FillView {
    const root = document.createElement('div')
    root.className = 'lm-fill'
    const lift = document.createElement('div')
    lift.className = 'lm-fill-lift'
    const glow = document.createElement('span')
    glow.className = 'lm-fill-glow'
    const base = document.createElement('span')
    base.className = 'lm-fill-base'
    const clip = document.createElement('span')
    clip.className = 'lm-fill-clip'
    const sung = document.createElement('span')
    sung.className = 'lm-fill-sung'
    clip.append(sung)
    lift.append(glow, base, clip)
    root.append(lift)
    return { root, base, glow, clip, sung, key: '', travel: 0 }
  }

  /** Places the overlay over word `index` of `view` (layout is read once per word, never per frame). */
  function placeFill(view: LineView, lineIndex: number, index: number): FillView | null {
    const word = view.words[index]
    if (!word) return null
    fill ??= createFill()
    const f = fill
    const key = `${lineIndex}:${index}:${measuredFor}`
    if (f.key === key) return f
    f.key = key
    if (f.root.parentElement !== view.el) view.el.append(f.root)
    const text = word.textContent ?? ''
    f.base.textContent = text
    f.glow.textContent = text
    f.sung.textContent = text
    f.root.style.transform = `translate(${word.offsetLeft}px, ${word.offsetTop}px)`
    // Restart the lift and glow for the new word.
    f.root.classList.remove('is-on')
    // The window is word + 0.95em wide (0.5em glow room on the left, 0.45em feather on the right).
    const width = f.clip.offsetWidth
    f.travel = width - (width - word.offsetWidth) * (0.5 / 0.95)
    f.root.classList.add('is-on')
    return f
  }

  function hideFill(): void {
    if (!fill || !fill.key) return
    fill.key = ''
    fill.root.classList.remove('is-on')
    fill.root.remove()
  }

  /** Word classes for a line: sung words white, upcoming ones dimmed, the one being sung hidden under the overlay. */
  function paintLine(view: LineView, active: number, done: boolean): void {
    const state = `${active}:${done}`
    if (view.state === state) return
    view.state = state
    view.words.forEach((w, i) => {
      w.classList.toggle('is-ahead', i > active)
      w.classList.toggle('is-held', i === active && !done)
    })
    for (const g of view.gaps) g.el.classList.toggle('is-sung', g.after >= 0 && (g.after < active || (g.after === active && done)))
  }

  function build(): void {
    if (!track) return
    track.replaceChildren()
    views = []
    measuredFor = ''
    y = null
    fill = null
    for (const line of model?.lines ?? []) {
      const el = document.createElement('div')
      el.className = 'lm-line'
      const view: LineView = { el, words: [], gaps: [], state: '' }
      for (const unit of groupUnits(segmentLine(line))) {
        if (unit.kind === 'space') {
          el.append(' ')
          continue
        }
        const group = document.createElement('span')
        group.className = 'lm-unit'
        for (const seg of unit.segments) {
          const span = document.createElement('span')
          span.textContent = seg.text
          if (seg.word === null) {
            span.className = 'lm-gap'
            view.gaps.push({ el: span, after: view.words.length - 1 })
          } else {
            span.className = 'lm-word'
            view.words.push(span)
          }
          group.append(span)
        }
        el.append(group)
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
    if (view.state === 'full') return
    view.state = 'full'
    for (const w of view.words) w.classList.remove('is-ahead', 'is-held')
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

      // Words of the line being sung: classes change once per word, the sweep is two transforms.
      let filling = false
      const current = focus.line >= 0 && !focus.interlude ? views[focus.line] : undefined
      if (current) {
        const line = model.lines[focus.line]!
        const global = model.words[activeWordIndex(model, t)]
        const active = global?.line === focus.line ? global.indexInLine : -1
        const progress = active >= 0 ? wordFill(line.words[active]!, t) : 0
        const done = active < 0 || progress >= 1
        paintLine(current, active, done)
        const f = done ? null : placeFill(current, focus.line, active)
        if (f) {
          // The edge lands where the old gradient put it: progress × (word + feather) − feather.
          const offset = (1 - progress) * f.travel
          setStyle(f.clip, 'transform', `translate3d(${(-offset).toFixed(1)}px, 0, 0)`)
          setStyle(f.sung, 'transform', `translate3d(${offset.toFixed(1)}px, 0, 0)`)
          filling = progress > 0
        } else {
          hideFill()
        }
      } else {
        hideFill()
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
      fill = null
      views = []
    }
  }
}

export type LyricLines = ReturnType<typeof createLyricLines>
