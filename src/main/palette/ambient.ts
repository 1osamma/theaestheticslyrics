import type { AmbientPalette } from '@shared/lighting'
import type { Palette } from '@shared/types'
import { hexToRgb, hueDistance, oklabToOklch, oklchToHex, rgbToOklab, type Oklch } from './color'
import { clusterArt, type ArtColour } from './extract'

const MAX_COLOURS = 4
/** Clusters smaller than this share of the cover are speckle, not lighting. */
const MIN_SHARE = 0.04
/** Below this OKLCH chroma a colour reads as grey. */
const GREY_CHROMA = 0.035
/** Light on black: bright enough to glow, never so bright it washes the screen out. */
const MIN_L = 0.56
const MAX_L = 0.74
const MAX_C = 0.2
/** Grey light washes an OLED screen out evenly, so a greyscale cover lights dimly. */
const GREY_MIN_L = 0.3
const GREY_MAX_L = 0.42

/** Re-tunes one colour to glow on a black screen, keeping its hue. */
function glow({ L, C, h }: Oklch): string {
  if (C < GREY_CHROMA) return oklchToHex(Math.min(GREY_MAX_L, Math.max(GREY_MIN_L, L)), C, h)
  return oklchToHex(Math.min(MAX_L, Math.max(MIN_L, L)), Math.min(MAX_C, Math.max(0.08, C * 1.15)), h)
}

const isGrey = (c: Oklch): boolean => c.C < GREY_CHROMA

/** Two colours too close to light differently (same hue family, or both grey and similar). */
function similar(a: Oklch, b: Oklch): boolean {
  if (isGrey(a) && isGrey(b)) return Math.abs(a.L - b.L) < 0.12
  if (isGrey(a) !== isGrey(b)) return false
  return hueDistance(a.h, b.h) < 22
}

/** Pads a single colour with two hue-shifted companions, so the light always has some depth. */
function complete(picked: Oklch[]): Oklch[] {
  if (picked.length >= 2) return picked
  const base = picked[0]!
  return [
    base,
    { L: base.L - 0.08, C: base.C, h: (base.h + 28) % 360 },
    { L: base.L - 0.04, C: base.C, h: (base.h + 326) % 360 }
  ]
}

/** Picks distinct ambient colours, the most striking first. Greyscale covers give soft greys. */
export function ambientFromColours(colours: ArtColour[]): AmbientPalette | null {
  const usable = colours.filter((c) => c.share >= MIN_SHARE && c.L > 0.08)
  if (!usable.length) return null
  // Colour beats grey and a big area beats a speckle; very dark and very light clusters count less.
  const presence = (c: ArtColour): number =>
    (Math.max(c.C, 0.01) + 0.02) * Math.sqrt(c.share) * (c.L < 0.18 || c.L > 0.95 ? 0.4 : 1)
  const ranked = [...usable].sort((p, q) => presence(q) - presence(p))
  const picked: Oklch[] = []
  for (const c of ranked) {
    if (picked.length >= MAX_COLOURS) break
    if (picked.some((p) => similar(p, c))) continue
    picked.push(c)
  }
  return { colors: complete(picked).slice(0, MAX_COLOURS).map(glow), source: 'album' }
}

/** Album art (BGRA bitmap, see `extractPalette`) → ambient lighting colours, or null. */
export function extractAmbient(bgra: Uint8Array, width: number, height: number): AmbientPalette | null {
  const colours = clusterArt(bgra, width, height)
  return colours ? ambientFromColours(colours) : null
}

/** Ambient lighting when there is no album art: the lyric colours, tuned to glow. */
export function ambientFromPalette(palette: Palette): AmbientPalette {
  const toOklch = (hex: string): Oklch => oklabToOklch(rgbToOklab(hexToRgb(hex)))
  const colours = [palette.lyric, palette.highlight, palette.secondary].map(toOklch)
  return { colors: colours.map(glow), source: 'palette' }
}
