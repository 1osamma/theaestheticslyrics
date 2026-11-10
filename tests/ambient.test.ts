import { describe, expect, it } from 'vitest'
import { demoArtBitmap } from '../src/main/demo-art'
import { ambientFromColours, ambientFromPalette, extractAmbient } from '../src/main/palette/ambient'
import { hexToRgb, oklabToOklch, rgbToOklab } from '../src/main/palette/color'
import { DEFAULT_PALETTE } from '../src/shared/palette-defaults'

const oklch = (hex: string) => oklabToOklch(rgbToOklab(hexToRgb(hex)))
const HEX = /^#[0-9a-f]{6}$/

/** BGRA bitmap from a per-pixel colour function. */
function bitmap(size: number, color: (x: number, y: number) => [number, number, number]): Uint8Array {
  const out = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const [r, g, b] = color(x, y)
      const i = (y * size + x) * 4
      out.set([b, g, r, 255], i)
    }
  }
  return out
}

describe('extractAmbient', () => {
  it('lights with the cover’s distinct colours, tuned to glow on black', () => {
    // Left half deep blue, right half orange.
    const art = bitmap(32, (x) => (x < 16 ? [20, 40, 160] : [230, 120, 30]))
    const ambient = extractAmbient(art, 32, 32)!
    expect(ambient.source).toBe('album')
    expect(ambient.colors.length).toBeGreaterThanOrEqual(2)
    expect(ambient.colors.length).toBeLessThanOrEqual(4)
    for (const c of ambient.colors) {
      expect(c).toMatch(HEX)
      expect(oklch(c).L).toBeGreaterThanOrEqual(0.5)
      expect(oklch(c).L).toBeLessThanOrEqual(0.78)
    }
    const hues = ambient.colors.map((c) => oklch(c).h)
    expect(hues.some((h) => h > 220 && h < 300)).toBe(true) // blue
    expect(hues.some((h) => h > 30 && h < 90)).toBe(true) // orange
  })

  it('pads a single-colour cover with companions so the light has depth', () => {
    const ambient = extractAmbient(bitmap(16, () => [200, 30, 60]), 16, 16)!
    expect(ambient.colors.length).toBe(3)
    expect(new Set(ambient.colors).size).toBe(3)
  })

  it('gives soft greys for a greyscale cover', () => {
    const ambient = extractAmbient(bitmap(16, (x) => (x < 8 ? [40, 40, 40] : [200, 200, 200])), 16, 16)!
    for (const c of ambient.colors) {
      expect(oklch(c).C).toBeLessThan(0.05)
      // Dimmer than colourful light, so a black-and-white cover keeps the OLED screen dark.
      expect(oklch(c).L).toBeLessThanOrEqual(0.43)
    }
  })

  it('returns null for unusable art', () => {
    expect(extractAmbient(new Uint8Array(4 * 4), 2, 2)).toBeNull()
    expect(ambientFromColours([])).toBeNull()
  })

  it('reads the demo cover (teal, violet and a warm sun)', () => {
    const size = 64
    const ambient = extractAmbient(demoArtBitmap(size), size, size)!
    expect(ambient.colors.length).toBeGreaterThanOrEqual(2)
  })
})

describe('ambientFromPalette', () => {
  it('derives light from the lyric colours when there is no album art', () => {
    const ambient = ambientFromPalette(DEFAULT_PALETTE)
    expect(ambient.source).toBe('palette')
    expect(ambient.colors).toHaveLength(3)
    for (const c of ambient.colors) expect(c).toMatch(HEX)
  })
})

describe('demoArtBitmap', () => {
  it('is an opaque BGRA square', () => {
    const art = demoArtBitmap(8)
    expect(art.length).toBe(8 * 8 * 4)
    for (let i = 3; i < art.length; i += 4) expect(art[i]).toBe(255)
  })
})
