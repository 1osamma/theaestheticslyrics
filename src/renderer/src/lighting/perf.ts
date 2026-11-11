/**
 * Frame timing counters a page keeps about itself, read by the main process in debug runs
 * (`--perf-after`) through `window.__luminaPerf`. Bounded ring buffers: nothing grows over time.
 */
const CAPACITY = 8192

class Ring {
  private readonly data = new Float64Array(CAPACITY)
  private count = 0
  private next = 0

  push(v: number): void {
    this.data[this.next] = v
    this.next = (this.next + 1) % CAPACITY
    this.count = Math.min(CAPACITY, this.count + 1)
  }

  clear(): void {
    this.count = 0
    this.next = 0
  }

  stats(): { n: number; mean: number; p50: number; p95: number; p99: number; max: number } | null {
    if (!this.count) return null
    const values = Array.from(this.data.subarray(0, this.count)).sort((a, b) => a - b)
    const at = (q: number): number => values[Math.min(values.length - 1, Math.floor(q * values.length))]!
    const round = (v: number): number => Math.round(v * 100) / 100
    return {
      n: values.length,
      mean: round(values.reduce((a, b) => a + b, 0) / values.length),
      p50: round(at(0.5)),
      p95: round(at(0.95)),
      p99: round(at(0.99)),
      max: round(values[values.length - 1]!)
    }
  }
}

/** The light levels drawn in one frame (the engine's output), for responsiveness checks. */
export interface LightLevels {
  atmosphere: number
  bloom: number
  edge: number
}

export interface PerfCounters {
  /** A frame was drawn at `at` (rAF time) taking `workMs` of script time. */
  frame(at: number, workMs: number): void
  /** Light was drawn this frame (the light can run below the page's frame rate), with its levels. */
  light(at: number, levels?: LightLevels): void
  audioLatency(ms: number): void
  setRenderer(kind: string): void
}

export function installPerf(page: string): PerfCounters {
  const intervals = new Ring()
  const lightIntervals = new Ring()
  const atmosphere = new Ring()
  const bloom = new Ring()
  const edge = new Ring()
  const work = new Ring()
  const latency = new Ring()
  let lastFrame: number | null = null
  let lastLight: number | null = null
  let started = performance.now()
  let frames = 0
  let lights = 0
  let longTasks = 0
  let longTaskMs = 0
  let renderer = 'none'

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks++
        longTaskMs += entry.duration
      }
    }).observe({ entryTypes: ['longtask'] })
  } catch {
    // Long-task timing is unavailable; the other counters still work.
  }

  const reset = (): void => {
    intervals.clear()
    lightIntervals.clear()
    atmosphere.clear()
    bloom.clear()
    edge.clear()
    work.clear()
    latency.clear()
    lastFrame = lastLight = null
    frames = lights = longTasks = longTaskMs = 0
    started = performance.now()
  }

  ;(window as unknown as { __luminaPerf: unknown }).__luminaPerf = {
    reset,
    read: () => {
      const seconds = (performance.now() - started) / 1000
      return {
        page,
        renderer,
        seconds: Math.round(seconds * 10) / 10,
        fps: Math.round((frames / seconds) * 10) / 10,
        lightFps: Math.round((lights / seconds) * 10) / 10,
        frameIntervalMs: intervals.stats(),
        lightIntervalMs: lightIntervals.stats(),
        lightLevels: { atmosphere: atmosphere.stats(), bloom: bloom.stats(), edge: edge.stats() },
        scriptMsPerFrame: work.stats(),
        longTasks: { count: longTasks, totalMs: Math.round(longTaskMs) },
        audioDeliveryLatencyMs: latency.stats(),
        devicePixelRatio: window.devicePixelRatio,
        viewport: `${window.innerWidth}x${window.innerHeight}`
      }
    }
  }

  return {
    frame(at, workMs) {
      frames++
      if (lastFrame !== null) intervals.push(at - lastFrame)
      lastFrame = at
      work.push(workMs)
    },
    light(at, levels) {
      if (levels) {
        atmosphere.push(levels.atmosphere)
        bloom.push(levels.bloom)
        edge.push(levels.edge)
      }
      lights++
      if (lastLight !== null) lightIntervals.push(at - lastLight)
      lastLight = at
    },
    audioLatency(ms) {
      if (ms >= 0 && ms < 5000) latency.push(ms)
    },
    setRenderer(kind) {
      renderer = kind
    }
  }
}
