import '../css/player.css'
import type { PanelSettings } from '@shared/ipc'
import {
  LYRIC_EFFECTS,
  LYRIC_EFFECT_LABELS,
  LYRIC_FONTS,
  LYRIC_SPACINGS,
  LYRIC_TRANSITIONS,
  LYRIC_WEIGHTS,
  lyricsConfigOf,
  type LyricEffect,
  type LyricFont
} from '@shared/lyrics-style'
import type { TimedLyrics } from '@shared/types'
import { createLyricLines } from '../player/lyric-lines'
import { buildModel } from '../stage/model'

/**
 * The Lyrics tab of the LUMINA settings window: a live preview that plays a short demo verse with
 * the real lyric renderer, and every LUMINA Lyrics control.
 */

export interface PanelSection {
  nodes: HTMLElement[]
  render(settings: PanelSettings, gpu: boolean): void
  /** The preview animates only while its tab is showing. */
  setActive(active: boolean): void
}

interface Helpers {
  send(key: keyof PanelSettings, patch: Partial<PanelSettings>, final?: boolean): void
  /** The intensity slider (the panel's shared slider control). */
  level(label: string, hint?: string): HTMLElement
  /** The Reduce animations switch (the panel's shared toggle control). */
  toggle(label: string, hint?: string): HTMLElement
  section(title: string, ...children: HTMLElement[]): HTMLElement
}

const EFFECT_HINTS: Record<LyricEffect, string> = {
  fill: 'Light sweeps through each word exactly as it is sung.',
  fade: 'Each word brightens softly in place, without a sweep.',
  glow: 'The sweep with a stronger halo that blooms on held notes.',
  scale: 'Words pop forward as they start, then settle back.',
  expressive: 'Lines rise in word by word; sung words lift and swell.',
  minimal: 'Words simply turn white. No movement or glow.'
}

const SHORT_EFFECT: Record<LyricEffect, string> = { ...LYRIC_EFFECT_LABELS, minimal: 'Minimal' }
const FONT_NAMES: Record<LyricFont, string> = { inter: 'Inter', manrope: 'Manrope', fraunces: 'Fraunces' }
const FONT_STACKS: Record<LyricFont, string> = {
  inter: "'Inter Variable', 'Segoe UI Variable', sans-serif",
  manrope: "'Manrope Variable', 'Segoe UI Variable', sans-serif",
  fraunces: "'Fraunces Variable', Georgia, serif"
}

/** A three-line demo verse (original text) with word timings; it loops every LOOP_MS. */
const LOOP_MS = 9600
function demoVerse(): TimedLyrics {
  const line = (start: number, words: [string, number][]): TimedLyrics['lines'][number] => {
    let t = start
    // A trailing space in the demo text separates words; the timed words themselves carry none.
    const timed = words.map(([text, ms]) => {
      const w = { text: text.trim(), start: t, end: t + ms }
      t += ms
      return w
    })
    return { text: words.map(([w]) => w).join(''), start, end: t, words: timed }
  }
  return {
    wordTiming: 'native',
    lines: [
      line(500, [['Paper ', 380], ['lanterns ', 520], ['rise ', 360], ['to', 260], ['night', 980]]),
      line(3500, [['Every ', 360], ['light ', 420], ['a ', 200], ['little ', 380], ['wish', 900]]),
      line(6300, [['Carry ', 380], ['me ', 260], ['where ', 340], ['rivers ', 460], ['glow', 1300]])
    ]
  }
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A row of mutually exclusive buttons (a segmented control). */
function segmented<T extends string | number>(label: string, options: { value: T; text: string }[], onPick: (v: T) => void) {
  const row = el('div', 'lp-row lp-seg-row')
  const group = el('div', 'lp-modes lp-seg')
  group.style.gridTemplateColumns = `repeat(${options.length}, 1fr)`
  const buttons = options.map((o) => {
    const b = el('button', 'lp-mode', o.text)
    b.type = 'button'
    b.addEventListener('click', () => onPick(o.value))
    group.append(b)
    return { value: o.value, b }
  })
  row.append(el('span', 'lp-label', label), group)
  return {
    row,
    set(v: T) {
      for (const { value, b } of buttons) b.classList.toggle('is-on', value === v)
    }
  }
}

export function createLyricsSection(h: Helpers): PanelSection {
  // ---------- Live preview ----------
  const preview = el('div', 'lp-preview')
  const stage = el('div', 'lp-preview-stage')
  preview.append(stage, el('div', 'lp-preview-tag', 'Preview'))
  const lines = createLyricLines()
  lines.mount(stage)
  lines.setLyrics(buildModel(demoVerse()))

  let active = false
  let raf = 0
  let t0 = performance.now()
  let lastSong = Number.POSITIVE_INFINITY
  const tick = (now: number): void => {
    raf = 0
    if (!active) return
    const song = (now - t0) % LOOP_MS
    lines.frame({ songMs: song, wallMs: now, playing: true, settle: song < lastSong })
    lastSong = song
    raf = requestAnimationFrame(tick)
  }
  const run = (): void => {
    if (active && !raf && !document.hidden) raf = requestAnimationFrame(tick)
  }
  document.addEventListener('visibilitychange', () => {
    lastSong = Number.POSITIVE_INFINITY
    run()
  })

  // ---------- Effect ----------
  const effects = el('div', 'lp-modes lp-effects')
  const effectButtons = LYRIC_EFFECTS.map((effect) => {
    const b = el('button', 'lp-mode', SHORT_EFFECT[effect])
    b.type = 'button'
    b.addEventListener('click', () => h.send('lyricEffect', { lyricEffect: effect }, true))
    effects.append(b)
    return { effect, b }
  })
  const effectHint = el('p', 'lp-hint')

  // ---------- Motion ----------
  const transition = segmented(
    'Transition Speed',
    LYRIC_TRANSITIONS.map((v) => ({ value: v, text: v[0]!.toUpperCase() + v.slice(1) })),
    (v) => h.send('lyricTransition', { lyricTransition: v }, true)
  )

  // ---------- Typography ----------
  const fonts = el('div', 'lp-fonts')
  const fontButtons = LYRIC_FONTS.map((font) => {
    const b = el('button', 'lp-font')
    b.type = 'button'
    const sample = el('span', 'lp-font-sample', 'Aa')
    sample.style.fontFamily = FONT_STACKS[font]
    b.append(sample, el('span', 'lp-font-name', FONT_NAMES[font]))
    b.addEventListener('click', () => h.send('lyricFont', { lyricFont: font }, true))
    fonts.append(b)
    return { font, b, sample }
  })
  const weight = segmented(
    'Weight',
    LYRIC_WEIGHTS.map((v) => ({ value: v, text: v === 600 ? 'Semibold' : v === 700 ? 'Bold' : 'Extra Bold' })),
    (v) => h.send('lyricWeight', { lyricWeight: v }, true)
  )
  const align = segmented(
    'Alignment',
    [
      { value: 'left' as const, text: 'Left' },
      { value: 'center' as const, text: 'Centre' }
    ],
    (v) => h.send('lyricAlign', { lyricAlign: v }, true)
  )
  const spacing = segmented(
    'Line Spacing',
    LYRIC_SPACINGS.map((v) => ({ value: v, text: v[0]!.toUpperCase() + v.slice(1) })),
    (v) => h.send('lyricSpacing', { lyricSpacing: v }, true)
  )
  const color = segmented(
    'Colour',
    [
      { value: 'white' as const, text: 'White' },
      { value: 'album' as const, text: 'Album Tinted' }
    ],
    (v) => h.send('lyricColor', { lyricColor: v }, true)
  )

  const nodes = [
    preview,
    h.section('Effect', effects, effectHint),
    h.section(
      'Motion',
      h.level('Intensity', 'How far words lift, scale and glow'),
      transition.row,
      h.toggle('Reduce Animations', 'Words simply brighten; lines move without drifting')
    ),
    h.section('Typography', fonts, weight.row, align.row, spacing.row, color.row)
  ]

  return {
    nodes,
    render(s, gpu) {
      const reduced = s.reducedMotion
      for (const { effect, b } of effectButtons) {
        b.classList.toggle('is-on', s.lyricEffect === effect)
        b.disabled = reduced && effect !== 'minimal'
      }
      effectHint.textContent = reduced
        ? 'Reduce Animations is on: every effect plays as Minimal.'
        : EFFECT_HINTS[s.lyricEffect]
      transition.set(s.lyricTransition)
      for (const { font, b, sample } of fontButtons) {
        b.classList.toggle('is-on', s.lyricFont === font)
        sample.style.fontWeight = String(s.lyricWeight)
      }
      weight.set(s.lyricWeight)
      align.set(s.lyricAlign)
      spacing.set(s.lyricSpacing)
      color.set(s.lyricColor)
      preview.dataset.color = s.lyricColor
      lines.setOptions({ lyrics: lyricsConfigOf(s), reducedMotion: reduced, lite: !gpu, scale: 1 })
      lastSong = Number.POSITIVE_INFINITY
    },
    setActive(next) {
      active = next
      if (next) {
        t0 = performance.now()
        lastSong = Number.POSITIVE_INFINITY
        run()
      }
    }
  }
}
