import type { LightFrame } from '@shared/lighting'
import type { LightRenderer, LightView } from './light-renderer'

/**
 * Light is soft, so it is rendered at half resolution and stretched by the compositor: a quarter
 * of the pixels to shade at 1440p, with no visible difference.
 */
export const RENDER_SCALE = 0.5

const VERTEX = `#version 300 es
// One triangle that covers the screen, generated from the vertex id: no vertex buffers at all.
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 u_res;
uniform float u_phase;
uniform vec3 u_colors[4];
uniform float u_atmos;
uniform float u_bloom;
uniform float u_radius;
uniform float u_shimmer;
uniform float u_edge;
uniform vec4 u_edges;
uniform vec3 u_edgeShape;
uniform vec2 u_focus;
uniform float u_overlay;
uniform float u_frame;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

float glow(vec2 d, float r) {
  return exp(-dot(d, d) / (r * r));
}

// Layers 1–2: album-colour atmosphere, four lights drifting slowly with the phase.
vec3 atmosphere(vec2 p, float aspect) {
  float t = u_phase;
  vec2 c0 = vec2(aspect * (0.24 + 0.06 * sin(t * 0.21)), 0.56 + 0.07 * cos(t * 0.17));
  vec2 c1 = vec2(aspect * (0.80 + 0.05 * sin(t * 0.16 + 1.9)), 0.80 + 0.06 * cos(t * 0.19 + 0.7));
  vec2 c2 = vec2(aspect * (0.70 + 0.07 * cos(t * 0.13 + 3.6)), 0.14 + 0.05 * sin(t * 0.23 + 2.2));
  vec2 c3 = vec2(aspect * (0.12 + 0.05 * sin(t * 0.11 + 5.1)), 0.10 + 0.06 * cos(t * 0.15 + 4.0));
  return u_colors[0] * glow(p - c0, 0.62) * 0.62 + u_colors[1] * glow(p - c1, 0.55) * 0.45 +
         u_colors[2] * glow(p - c2, 0.60) * 0.42 + u_colors[3] * glow(p - c3, 0.50) * 0.34;
}

// Layer 5: light pooling in from one edge. d = distance from the edge (screen heights),
// along = position along it (0–1).
float edgeFalloff(float d, float along) {
  float depth = mix(0.03, 0.24, u_edgeShape.x);
  float hardness = mix(2.6, 1.0, u_edgeShape.y);
  float f = exp(-pow(max(d, 0.0) / depth, hardness) * 2.0);
  float fromCentre = abs(along - 0.5) * 2.0;
  float spread = mix(1.0 - smoothstep(0.15, 1.0, fromCentre), 1.0 - 0.3 * fromCentre * fromCentre, u_edgeShape.z);
  return f * spread;
}

vec3 edgeLight(vec2 uv, float aspect) {
  float t = u_phase * 0.15;
  vec3 left = mix(u_colors[0], u_colors[1], 0.5 + 0.5 * sin(uv.y * 3.0 + t));
  vec3 right = mix(u_colors[1], u_colors[0], 0.5 + 0.5 * sin(uv.y * 3.0 - t + 1.3));
  vec3 bottom = mix(u_colors[2], u_colors[0], uv.x);
  vec3 top = mix(u_colors[3], u_colors[1], uv.x);
  return left * edgeFalloff(uv.x * aspect, uv.y) * u_edges.x +
         right * edgeFalloff((1.0 - uv.x) * aspect, uv.y) * u_edges.y +
         top * edgeFalloff(1.0 - uv.y, uv.x) * u_edges.z +
         bottom * edgeFalloff(uv.y, uv.x) * u_edges.w;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_res;
  float aspect = u_res.x / u_res.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  vec3 light = vec3(0.0);
  if (u_overlay < 0.5) {
    light = atmosphere(p, aspect) * u_atmos;
    // Layer 3: bass bloom behind the album art, wider and hotter with each pulse.
    vec2 f = vec2(u_focus.x * aspect, u_focus.y);
    float r = mix(0.28, 0.75, u_radius) * (1.0 + 0.18 * u_bloom);
    vec3 bc = mix(u_colors[0], u_colors[1], 0.35);
    light += bc * (glow(p - f, r) * 0.55 + glow(p - f, r * 0.45) * 0.2) * u_bloom;
    // Readability guard: the lyrics column (right side) gets up to 35% less light.
    float column = smoothstep(0.40, 0.58, uv.x) * (1.0 - smoothstep(0.93, 1.0, uv.x)) * smoothstep(0.08, 0.3, uv.y) * (1.0 - smoothstep(0.75, 0.95, uv.y));
    light *= 1.0 - 0.35 * column;
  }
  light += edgeLight(uv, aspect) * u_edge;
  // Layer 4: treble shimmer, a fine moving texture that only modulates light already there.
  if (u_shimmer > 0.001) {
    float n = noise(p * 9.0 + vec2(u_phase * 1.7, -u_phase * 1.3)) * noise(p * 23.0 - vec2(u_phase * 2.3, u_phase));
    light *= 1.0 + (n - 0.25) * u_shimmer * 0.9;
  }
  // Soft shoulder instead of clipping: peaks stay restrained on an OLED panel.
  light = max(light, vec3(0.0));
  light = light / (1.0 + light * 0.35);
  float dither = (hash(gl_FragCoord.xy + fract(u_frame * 0.618) * 97.0) - 0.5) / 255.0;
  if (u_overlay < 0.5) {
    outColor = vec4(vec3(0.0196, 0.0196, 0.0275) + light + dither, 1.0);
  } else {
    // Premultiplied: unlit pixels are exactly transparent, so the desktop stays untouched (true black stays black).
    // The last few code values of the tail fade out smoothly; a hard cut there showed as a faint rectangle.
    float a = max(light.r, max(light.g, light.b));
    float lit = smoothstep(0.5 / 255.0, 4.0 / 255.0, a);
    light = clamp((light + dither) * lit, 0.0, 1.0);
    outColor = vec4(light, max(light.r, max(light.g, light.b)));
  }
}`

const UNIFORMS = [
  'u_res',
  'u_phase',
  'u_colors',
  'u_atmos',
  'u_bloom',
  'u_radius',
  'u_shimmer',
  'u_edge',
  'u_edges',
  'u_edgeShape',
  'u_focus',
  'u_overlay',
  'u_frame'
] as const

type Uniforms = Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>

export interface WebglCallbacks {
  /** The GPU context was lost (driver reset, GPU process crash): draw with the fallback meanwhile. */
  onLost(): void
  onRestored(): void
}

/**
 * WebGL2 light renderer. One program, one empty vertex array and no textures, created once and
 * reused every frame; the only per-frame work is uniform uploads and one draw call. Returns null
 * when WebGL2 is unavailable (no GPU acceleration).
 */
export function createWebglRenderer(callbacks: WebglCallbacks): LightRenderer | null {
  const canvas = document.createElement('canvas')
  canvas.className = 'lm-light-canvas'
  const attrs: WebGLContextAttributes = {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: 'low-power'
  }
  let gl = canvas.getContext('webgl2', attrs)
  if (!gl) return null

  let program: WebGLProgram | null = null
  let vao: WebGLVertexArrayObject | null = null
  let u: Uniforms | null = null
  let lost = false
  let frameCount = 0
  let cleared = false
  const colorBuffer = new Float32Array(12)

  function compile(type: number, source: string): WebGLShader | null {
    const shader = gl!.createShader(type)
    if (!shader) return null
    gl!.shaderSource(shader, source)
    gl!.compileShader(shader)
    if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) {
      console.error('lighting shader:', gl!.getShaderInfoLog(shader))
      gl!.deleteShader(shader)
      return null
    }
    return shader
  }

  function init(): boolean {
    if (!gl) return false
    const vs = compile(gl.VERTEX_SHADER, VERTEX)
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT)
    if (!vs || !fs) return false
    program = gl.createProgram()
    if (!program) return false
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error('lighting program:', gl.getProgramInfoLog(program))
      return false
    }
    vao = gl.createVertexArray()
    const p = program
    u = Object.fromEntries(UNIFORMS.map((name) => [name, gl!.getUniformLocation(p, name)])) as Uniforms
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    return true
  }

  if (!init()) return null

  const onLost = (event: Event): void => {
    event.preventDefault() // allows the context to be restored
    lost = true
    program = null
    vao = null
    u = null
    callbacks.onLost()
  }
  const onRestored = (): void => {
    gl = canvas.getContext('webgl2', attrs)
    lost = !init()
    cleared = false
    if (!lost) callbacks.onRestored()
  }
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  return {
    kind: 'webgl',

    mount(parent) {
      parent.append(canvas)
    },

    render(frame: LightFrame, view: LightView) {
      if (lost || !gl || !program || !u) return
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, Math.round(view.width * dpr * RENDER_SCALE))
      const h = Math.max(1, Math.round(view.height * dpr * RENDER_SCALE))
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        cleared = false
      }
      gl.viewport(0, 0, w, h)
      if (!frame.active) {
        // Nothing to light: clear once and stop drawing until the light returns.
        if (!cleared) {
          gl.clearColor(0, 0, 0, view.overlay ? 0 : 1)
          gl.clear(gl.COLOR_BUFFER_BIT)
          cleared = true
        }
        return
      }
      cleared = false
      gl.useProgram(program)
      gl.bindVertexArray(vao)
      frame.colors.forEach((c, i) => colorBuffer.set(c, i * 3))
      gl.uniform2f(u.u_res, w, h)
      gl.uniform1f(u.u_phase, frame.phase)
      gl.uniform3fv(u.u_colors, colorBuffer)
      gl.uniform1f(u.u_atmos, frame.atmosphere)
      gl.uniform1f(u.u_bloom, frame.bloom)
      gl.uniform1f(u.u_radius, frame.bloomRadius)
      gl.uniform1f(u.u_shimmer, frame.shimmer)
      gl.uniform1f(u.u_edge, frame.edge)
      gl.uniform4f(u.u_edges, ...view.edges)
      gl.uniform3f(u.u_edgeShape, ...view.edgeShape)
      gl.uniform2f(u.u_focus, view.focus[0], 1 - view.focus[1])
      gl.uniform1f(u.u_overlay, view.overlay ? 1 : 0)
      gl.uniform1f(u.u_frame, frameCount++ % 1024)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },

    destroy() {
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      if (gl && !lost) {
        if (program) gl.deleteProgram(program)
        if (vao) gl.deleteVertexArray(vao)
        // Hand the GPU context back now instead of waiting for garbage collection.
        gl.getExtension('WEBGL_lose_context')?.loseContext()
      }
      canvas.remove()
      gl = null
    }
  }
}
