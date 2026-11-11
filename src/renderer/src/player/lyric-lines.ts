import { DEFAULT_LYRICS, type LyricsConfig } from '@shared/lyrics-style'
import { type LyricsModel } from '../stage/model'
import { setStyle } from '../stage/style-cache'
import { groupUnits, lineOpacity, lyricFocus, segmentLine } from './lines'
import { MOTION, cascadeDelay, entrance, springSettled, springStep, sweeps, wordAnimations, type Spring, type WordPart } from './lyric-timeline'

/** The focused line's top sits this far down the lyrics column. */
const ANCHOR = 0.34
/** Lines around the focused one recede slightly. */
const RECEDE_SCALE = 0.965
/** The column re-pins its animations to the song clock when they drift further than this (ms). */
const RESYNC_MS = 15
/** The feathered edge of the fill window, in em (matches `.lm-fill-clip` in player.css). */
const FEATHER_EM = 0.45
const GLOW_ROOM_EM = 0.5

const FONT_FAMILY: Record<LyricsConfig['font'], string> = {
  inter: "'Inter Variable', 'Segoe UI Variable Display', 'Segoe UI', sans-serif",
  manrope: "'Manrope Variable', 'Inter Variable', 'Segoe UI', sans-serif",
  fraunces: "'Fraunces Variable', Georgia, 'Times New Roman', serif"
}
const LEADING: Record<LyricsConfig['spacing'], { line: string; gap: string }> = {
  compact: { line: '1.12', gap: '0.14em' },
  normal: { line: '1.2', gap: '0.22em' },
  airy: { line: '1.28', gap: '0.34em' }
}

interface LineView {
  el: HTMLDivElement
  /** One span per timed word, in order. */
  words: HTMLSpanElement[]
  /** Text between words, each tagged with the word before it (-1 = before the first word). */
  gaps: { el: HTMLSpanElement; after: number }[]
  /** Expressive: the line has already risen in as "up next". */
  entered: boolean
}

/** One word of the active line, drawn over its hidden glyphs (see `.lm-fill*` in player.css). */
interface WordOverlay {
  root: HTMLDivElement
  parts: Record<WordPart, HTMLElement>
}

/** The line whose words are animating, and the compositor animations scheduled for it. */
interface ActiveLine {
  index: number
  /** Song time the animations count from (their `currentTime` is song time minus this). */
  origin: number
  /** What it was built for; a change of effect, size or layout rebuilds it. */
  key: string
  overlays: WordOverlay[]
  anims: Animation[]
}

export interface LyricLinesOptions {
  lyrics: LyricsConfig
  /** Windows' or the user's reduced motion: Minimal words and no line movement. */
  reducedMotion: boolean
  /** No GPU compositing: text glow (a blurred shadow) is dropped, the animations stay. */
  lite?: boolean
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
 * Line-by-line synced lyrics for the LUMINA player.
 *
 * Word animations run on the compositor: when a line comes into focus (a little before its first
 * word), each word gets an overlay and its keyframe animations are scheduled with exact song-time
 * delays, so every word starts on the right display refresh without any per-frame script. The
 * main thread only re-pins the animations to the song clock on seeks, pauses and drift, and moves
 * lines with a critically damped spring.
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
  let options: LyricLinesOptions = { lyrics: { ...DEFAULT_LYRICS }, reducedMotion: false, scale: 1 }
  let spring: Spring | null = null
  let lastWall: number | null = null
  let active: ActiveLine | null = null
  /** Where the song clock was when the animations were last pinned to it. */
  let sync: { song: number; wall: number; playing: boolean } | null = null
  let lastFocus = -2
  /** A newly chosen typeface is loading: overlays wait for it, or they would be placed for the old glyphs. */
  let fontsPending = false
  let fontReady: Promise<void> = Promise.resolve()

  const effect = (): LyricsConfig['effect'] => (options.reducedMotion ? 'minimal' : options.lyrics.effect)
  const motion = () => MOTION[options.lyrics.transition]

  function build(): void {
    if (!track) return
    teardown()
    track.replaceChildren()
    views = []
    measuredFor = ''
    spring = null
    lastFocus = -2
    for (const line of model?.lines ?? []) {
      const el = document.createElement('div')
      el.className = 'lm-line'
      const view: LineView = { el, words: [], gaps: [], entered: false }
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

  function applyTypography(): void {
    if (!root) return
    const l = options.lyrics
    const s = root.style
    s.setProperty('--lm-lyric-scale', String(options.scale))
    s.setProperty('--lm-lyric-font', FONT_FAMILY[l.font])
    s.setProperty('--lm-lyric-weight', String(l.weight))
    s.setProperty('--lm-lyric-leading', LEADING[l.spacing].line)
    s.setProperty('--lm-lyric-gap', LEADING[l.spacing].gap)
    s.setProperty('--lm-line-ms', `${options.reducedMotion ? 160 : motion().lineMs}ms`)
    // The sung copy's glow follows intensity; Minimal and zero intensity switch it off entirely.
    const glowOn = effect() !== 'minimal' && l.intensity > 0.02 && !options.lite
    s.setProperty('--lm-glow', `${(0.08 + 0.26 * l.intensity).toFixed(3)}em`)
    s.setProperty('--lm-glow-mix', `${effect() === 'glow' ? 92 : effect() === 'expressive' ? 85 : 70}%`)
    root.dataset.glow = glowOn ? 'on' : 'off'
    root.dataset.align = l.align
    root.dataset.color = l.color
  }

  // ---------- The active line ----------

  function createOverlay(text: string, sweep: boolean): WordOverlay {
    const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] => {
      const node = document.createElement(tag)
      node.className = className
      return node
    }
    const overlay = make('div', sweep ? 'lm-fill' : 'lm-fill no-sweep')
    const lift = make('div', 'lm-fill-lift')
    const glow = make('span', 'lm-fill-glow')
    const base = make('span', 'lm-fill-base')
    const clip = make('span', 'lm-fill-clip')
    const sung = make('span', 'lm-fill-sung')
    glow.textContent = base.textContent = sung.textContent = text
    clip.append(sung)
    lift.append(glow, base, clip)
    overlay.append(lift)
    return { root: overlay, parts: { lift, glow, clip, sung } }
  }

  /** Cancels the active line's animations and returns its words to plain text. */
  function teardown(): void {
    if (!active) return
    for (const a of active.anims) a.cancel()
    for (const o of active.overlays) o.root.remove()
    const view = views[active.index]
    if (view) {
      for (const w of view.words) w.classList.remove('is-held')
      for (const g of view.gaps) g.el.classList.remove('is-live')
    }
    active = null
    sync = null
  }

  /** Builds overlays and schedules every word of line `index` on the compositor, from song time `t`. */
  function schedule(index: number, t: number, key: string): void {
    teardown()
    const view = views[index]
    const line = model?.lines[index]
    if (!view || !line) return
    const fx = effect()
    const m = motion()
    const sweep = sweeps(fx)
    // One layout read for the whole line: every word's position, before anything is written.
    const boxes = view.words.map((w) => ({ x: w.offsetLeft, y: w.offsetTop, w: w.offsetWidth }))
    const overlays = view.words.map((w, i) => {
      const o = createOverlay(w.textContent ?? '', sweep)
      o.root.style.transform = `translate(${boxes[i]!.x}px, ${boxes[i]!.y}px)`
      view.el.append(o.root)
      return o
    })
    for (const w of view.words) w.classList.add('is-held')
    const anims: Animation[] = []
    line.words.forEach((word, i) => {
      const o = overlays[i]
      const box = boxes[i]
      if (!o || !box) return
      // The window is word + glow room + feather wide; it travels word + feather (see player.css).
      const em = (o.parts.clip.offsetWidth - box.w) / (GLOW_ROOM_EM + FEATHER_EM)
      const travel = box.w + FEATHER_EM * em
      for (const spec of wordAnimations(fx, { start: word.start, end: word.end, travel, intensity: options.lyrics.intensity, motion: m })) {
        anims.push(
          o.parts[spec.part].animate(spec.keyframes as Keyframe[], {
            delay: spec.start - t,
            duration: spec.duration,
            easing: spec.easing,
            fill: 'both'
          })
        )
      }
    })
    // Punctuation brightens when the word before it has been sung.
    for (const g of view.gaps) {
      g.el.classList.add('is-live')
      const after = g.after >= 0 ? line.words[g.after] : undefined
      const at = after ? after.end : (line.words[0]?.start ?? t)
      anims.push(g.el.animate([{ opacity: 0.44 }, { opacity: 1 }], { delay: at - t, duration: 80, fill: 'both' }))
    }
    active = { index, origin: t, key, overlays, anims }
    sync = null
  }

  /** Pins every scheduled animation to song time `t` (seek, pause, resume, drift). */
  function pin(t: number, wallMs: number, playing: boolean): void {
    if (!active) return
    const at = t - active.origin
    for (const a of active.anims) {
      a.currentTime = at
      if (playing) a.play()
      else a.pause()
    }
    sync = { song: t, wall: wallMs, playing }
  }

  /** Expressive: when a line comes up next, its words rise in one after another. */
  function enter(view: LineView): void {
    if (view.entered) return
    view.entered = true
    const e = entrance(view.words.length, options.lyrics.intensity, motion())
    if (e.rise <= 0) return
    view.words.forEach((w, i) => {
      w.animate(
        [
          { transform: `translateY(${e.rise.toFixed(3)}em)`, opacity: 0 },
          { transform: 'translateY(0)', opacity: 1 }
        ],
        { delay: e.delays[i] ?? 0, duration: e.duration, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'backwards' }
      )
    })
  }

  return {
    mount(parent: HTMLElement): void {
      root = document.createElement('div')
      root.className = 'lm-lyrics'
      track = document.createElement('div')
      track.className = 'lm-lyrics-track'
      root.append(track)
      parent.append(root)
      applyTypography()
      build()
    },

    setLyrics(next: LyricsModel | null): void {
      model = next
      build()
    },

    setOptions(next: LyricLinesOptions): void {
      const l = next.lyrics
      const p = options.lyrics
      const layoutChanged =
        next.scale !== options.scale || l.font !== p.font || l.weight !== p.weight || l.spacing !== p.spacing || l.align !== p.align
      const changed =
        layoutChanged ||
        next.reducedMotion !== options.reducedMotion ||
        next.lite !== options.lite ||
        l.effect !== p.effect ||
        l.intensity !== p.intensity ||
        l.transition !== p.transition ||
        l.color !== p.color
      options = next
      if (!changed) return
      applyTypography()
      if (layoutChanged) {
        measuredFor = ''
        // Overlays are placed for the old layout; drop them now and rebuild once the new font is ready.
        teardown()
        fontsPending = true
        const done = (): void => {
          fontsPending = false
          measuredFor = ''
          if (active) active.key = ''
        }
        fontReady = document.fonts.load(`${l.weight} 64px ${FONT_FAMILY[l.font]}`).then(done, done)
      }
      if (active) active.key = '' // rebuilt on the next frame with the new effect or layout
      for (const v of views) v.entered = false
    },

    /** Returns true while it needs full-rate frames (only while lines are moving). */
    frame({ songMs: t, wallMs, playing, settle }: LyricLinesFrame): boolean {
      if (!root || !track || !model || !views.length) return false
      const H = root.clientHeight
      measure(`${root.clientWidth}x${H}x${options.scale}`)
      const m = motion()
      const reduced = options.reducedMotion

      // Lines move a little ahead of the music; words stay locked to their own timestamps.
      const focus = lyricFocus(model, t + (reduced ? 0 : m.leadMs))
      const anchorLine = Math.max(0, focus.line)
      const dotsHeight = dots?.offsetHeight ?? 0
      const interludeShift = focus.interlude && focus.line >= 0 ? dotsHeight : 0

      // Line opacity and size: CSS transitions, cascading outward from the focused line.
      const focusChanged = focus.line !== lastFocus
      lastFocus = focus.line
      views.forEach((view, i) => {
        const distance = focus.line < 0 ? i + 1 : i - focus.line
        const recede = distance !== 0 && !reduced ? RECEDE_SCALE : 1
        const shift = distance > 0 ? interludeShift : 0
        if (focusChanged) setStyle(view.el, 'transition-delay', `${reduced ? 0 : cascadeDelay(distance, m)}ms`)
        setStyle(view.el, 'opacity', lineOpacity(distance, focus.interlude).toFixed(3))
        setStyle(view.el, 'transform', `translateY(${shift.toFixed(1)}px) scale(${recede})`)
        if (distance === 1 && effect() === 'expressive' && !settle) enter(view)
        if (distance < 0) view.entered = false
      })

      // Schedule the focused line's words on the compositor (once per line, effect or layout).
      const lineIndex = focus.line >= 0 && !focus.interlude ? focus.line : -1
      const key = `${lineIndex}|${effect()}|${options.lyrics.intensity}|${options.lyrics.transition}|${measuredFor}`
      if (lineIndex < 0) teardown()
      else if (!fontsPending && (!active || active.key !== key)) {
        schedule(lineIndex, t, key)
        pin(t, wallMs, playing && !settle)
      }
      // Re-pin on pause, resume, seek or drift between the song clock and the compositor.
      if (active && sync) {
        const expected = sync.playing ? sync.song + (wallMs - sync.wall) : sync.song
        if (settle || playing !== sync.playing || Math.abs(t - expected) > RESYNC_MS) pin(t, wallMs, playing && !settle)
      }

      // Interlude dots sit just under the last sung line and breathe with the break's progress.
      if (dots) {
        const showDots = focus.interlude && focus.line >= 0
        const top = showDots ? tops[focus.line]! + heights[focus.line]! : 0
        setStyle(dots, 'top', `${top.toFixed(1)}px`)
        setStyle(dots, 'opacity', showDots ? '1' : '0')
        dots.classList.toggle('is-on', showDots)
      }

      // Scroll: a critically damped spring brings the focused line to the anchor. A long jump
      // (seek, new song) crossfades instead of scrolling through many lines.
      const target = H * ANCHOR - (tops[anchorLine] ?? 0) - (interludeShift ? heights[anchorLine]! * 0.5 : 0)
      const dt = lastWall === null ? 0 : wallMs - lastWall
      lastWall = wallMs
      const far = spring !== null && Math.abs(target - spring.x) > H * 0.9
      if (!spring || settle || reduced || far) {
        if (far && !settle && !reduced) track.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' })
        spring = { x: target, v: 0 }
      } else {
        spring = springStep(spring, target, dt, m.omega)
        if (springSettled(spring, target)) spring = { x: target, v: 0 }
      }
      setStyle(track, 'transform', `translate3d(0, ${spring.x.toFixed(2)}px, 0)`)

      return spring.x !== target
    },

    /** Resolves once the chosen typeface has loaded (snapshots wait for it). */
    ready(): Promise<void> {
      return fontReady
    },

    destroy(): void {
      teardown()
      root?.remove()
      root = null
      track = null
      dots = null
      views = []
    }
  }
}

export type LyricLines = ReturnType<typeof createLyricLines>
