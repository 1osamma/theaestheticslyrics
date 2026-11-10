/**
 * An original, procedurally drawn cover for the demo song (no real album art is stored in this
 * repository): a deep violet field, a warm sun low on the right and a cool teal haze on the left.
 * Returns BGRA, the layout `nativeImage.createFromBitmap` expects on Windows.
 */
export function demoArtBitmap(size: number): Buffer {
  const out = Buffer.alloc(size * size * 4)
  const mix = (a: number, b: number, t: number): number => a + (b - a) * Math.min(1, Math.max(0, t))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size
      const v = y / size
      // Diagonal base: indigo at the top left to deep magenta at the bottom right.
      let r = mix(28, 92, (u + v) / 2)
      let g = mix(18, 20, (u + v) / 2)
      let b = mix(74, 96, (u + v) / 2)
      // Warm sun.
      const sun = Math.max(0, 1 - Math.hypot(u - 0.68, v - 0.62) / 0.26)
      r = mix(r, 255, sun ** 1.6)
      g = mix(g, 150, sun ** 1.6)
      b = mix(b, 88, sun ** 1.6)
      // Teal haze.
      const haze = Math.max(0, 1 - Math.hypot(u - 0.18, v - 0.3) / 0.42)
      r = mix(r, 40, haze ** 2 * 0.8)
      g = mix(g, 190, haze ** 2 * 0.8)
      b = mix(b, 200, haze ** 2 * 0.8)
      // Horizon line.
      if (Math.abs(v - 0.78) < 0.004) {
        r = mix(r, 255, 0.5)
        g = mix(g, 210, 0.5)
        b = mix(b, 190, 0.5)
      }
      const i = (y * size + x) * 4
      out[i] = Math.round(b)
      out[i + 1] = Math.round(g)
      out[i + 2] = Math.round(r)
      out[i + 3] = 255
    }
  }
  return out
}
