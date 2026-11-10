import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AudioService, STOP_DELAY_MS, type AudioWorker } from '../src/main/audio/audio-service'
import { MAX_PACKET_BYTES, PACKET_JSON, PACKET_PCM, PacketReader, parseHelperStatus, type HelperPacket } from '../src/main/audio/packets'
import type { AudioSource, WorkerReply, WorkerRequest } from '../src/main/audio/worker-protocol'

function packet(type: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(5)
  head[0] = type
  head.writeUInt32LE(payload.length, 1)
  return Buffer.concat([head, payload])
}
const pcm = (values: number[]): Buffer => packet(PACKET_PCM, Buffer.from(new Float32Array(values).buffer))
const json = (value: unknown): Buffer => packet(PACKET_JSON, Buffer.from(JSON.stringify(value)))

describe('PacketReader', () => {
  it('reassembles packets split across arbitrary chunks', () => {
    const stream = Buffer.concat([json({ type: 'status', state: 'capturing', mode: 'process', sampleRate: 48000 }), pcm([0.5, -0.25, 1])])
    const got: HelperPacket[] = []
    const reader = new PacketReader()
    for (let i = 0; i < stream.length; i += 3) reader.push(stream.subarray(i, i + 3), (p) => got.push(p))
    expect(got).toHaveLength(2)
    expect(got[0]).toMatchObject({ kind: 'json' })
    expect(got[1]!.kind === 'pcm' && Array.from(got[1]!.samples)).toEqual([0.5, -0.25, 1])
  })

  it('resets instead of buffering forever on a corrupt length or type', () => {
    const reader = new PacketReader()
    const huge = Buffer.alloc(5)
    huge[0] = PACKET_PCM
    huge.writeUInt32LE(MAX_PACKET_BYTES + 4, 1)
    const got: HelperPacket[] = []
    reader.push(huge, (p) => got.push(p))
    expect(reader.corrupt).toBe(1)
    reader.push(Buffer.from([9, 1, 0, 0, 0, 0]), (p) => got.push(p))
    expect(reader.corrupt).toBe(2)
    // It recovers on the next well-formed packet.
    reader.push(pcm([0.1]), (p) => got.push(p))
    expect(got).toHaveLength(1)
  })

  it('skips JSON it cannot parse', () => {
    const reader = new PacketReader()
    const got: HelperPacket[] = []
    reader.push(Buffer.concat([packet(PACKET_JSON, Buffer.from('{oops')), pcm([0])]), (p) => got.push(p))
    expect(got.map((p) => p.kind)).toEqual(['pcm'])
  })
})

describe('parseHelperStatus', () => {
  it('accepts well-formed status and rejects anything else', () => {
    expect(parseHelperStatus({ type: 'status', state: 'capturing', mode: 'system', sampleRate: 44100, message: 'ok' })).toEqual({
      state: 'capturing',
      mode: 'system',
      sampleRate: 44100,
      message: 'ok'
    })
    expect(parseHelperStatus({ type: 'status', state: 'hacked', mode: 'system' })).toBeNull()
    expect(parseHelperStatus({ type: 'status', state: 'capturing', mode: 'everything' })).toBeNull()
    expect(parseHelperStatus({ type: 'status', state: 'waiting', mode: 'process', sampleRate: 5 })?.sampleRate).toBe(0)
    expect(parseHelperStatus('status')).toBeNull()
  })
})

class FakeWorker extends EventEmitter implements AudioWorker {
  posted: WorkerRequest[] = []
  terminated = false
  constructor(readonly source: AudioSource) {
    super()
  }
  postMessage(msg: WorkerRequest): void {
    this.posted.push(msg)
  }
  terminate(): Promise<number> {
    this.terminated = true
    return Promise.resolve(0)
  }
  reply(msg: WorkerReply): void {
    this.emit('message', msg)
  }
}

describe('AudioService lifecycle', () => {
  let workers: FakeWorker[]
  let service: AudioService
  beforeEach(() => {
    vi.useFakeTimers()
    workers = []
    service = new AudioService({
      createWorker: (source) => {
        const w = new FakeWorker(source)
        workers.push(w)
        return w
      },
      log: () => {}
    })
  })
  afterEach(() => {
    service.dispose()
    vi.useRealTimers()
  })

  it('starts one worker for any number of wants and stops it after the last consumer leaves', () => {
    service.setWanted(true)
    service.setWanted(true)
    expect(workers).toHaveLength(1)
    service.setWanted(false)
    vi.advanceTimersByTime(STOP_DELAY_MS - 1)
    expect(workers[0]!.posted).toEqual([])
    vi.advanceTimersByTime(1)
    expect(workers[0]!.posted).toEqual([{ type: 'stop' }])
    expect(service.running).toBe(false)
    expect(service.status.state).toBe('stopped')
  })

  it('keeps capturing when a consumer returns within the stop delay', () => {
    service.setWanted(true)
    service.setWanted(false)
    vi.advanceTimersByTime(STOP_DELAY_MS / 2)
    service.setWanted(true)
    vi.advanceTimersByTime(STOP_DELAY_MS * 2)
    expect(workers).toHaveLength(1)
    expect(workers[0]!.posted).toEqual([])
  })

  it('forwards validated frames and drops malformed ones', () => {
    const frames: unknown[] = []
    service.on('frame', (f) => frames.push(f))
    service.setWanted(true)
    workers[0]!.reply({ type: 'frame', frame: { timestamp: 1, rms: 0.5, bass: 2, mids: 0, treble: 0, transient: 0, beatPulse: 0, intensity: 0, isSilent: false } })
    workers[0]!.reply({ type: 'frame', frame: { bogus: true } as never })
    expect(frames).toHaveLength(1)
    expect((frames[0] as { bass: number }).bass).toBe(1)
    expect(service.rejected).toBe(1)
  })

  it('reports the capture mode so the UI never claims Spotify-only capture in system mode', () => {
    const statuses: string[] = []
    service.on('status', (s) => statuses.push(`${s.state}/${s.mode}`))
    service.setWanted(true)
    workers[0]!.reply({ type: 'status', status: { state: 'capturing', mode: 'system', sampleRate: 48000, message: 'Capturing all system audio' } })
    expect(service.status).toMatchObject({ state: 'capturing', mode: 'system' })
    expect(statuses).toContain('capturing/system')
  })

  it('restarts a crashed helper with growing backoff while still wanted', () => {
    service.setWanted(true)
    workers[0]!.reply({ type: 'exit', code: 1 })
    expect(workers[0]!.terminated).toBe(true)
    expect(service.status.state).toBe('error')
    vi.advanceTimersByTime(1000)
    expect(workers).toHaveLength(2)
    workers[1]!.reply({ type: 'exit', code: 1 })
    vi.advanceTimersByTime(1000)
    expect(workers).toHaveLength(2) // backoff doubled to 2 s
    vi.advanceTimersByTime(1000)
    expect(workers).toHaveLength(3)
  })

  it('does not restart after a crash once nothing wants audio', () => {
    service.setWanted(true)
    service.setWanted(false)
    workers[0]!.emit('exit', 1)
    vi.advanceTimersByTime(60_000)
    expect(workers).toHaveLength(1)
  })

  it('restarts with the new source when the capture source changes', () => {
    service.setWanted(true)
    service.setSource('spotify')
    expect(workers).toHaveLength(2)
    expect(workers[0]!.posted).toEqual([{ type: 'stop' }])
    expect(workers[1]!.source).toBe('spotify')
  })

  it('terminates a worker that ignores the stop request', () => {
    service.setWanted(true)
    service.dispose()
    expect(workers[0]!.terminated).toBe(false)
    vi.advanceTimersByTime(3000)
    expect(workers[0]!.terminated).toBe(true)
  })

  it('survives a worker factory that throws', () => {
    let calls = 0
    const flaky = new AudioService({
      createWorker: (source) => {
        calls++
        if (calls === 1) throw new Error('no worker')
        return new FakeWorker(source)
      },
      log: () => {}
    })
    flaky.setWanted(true)
    expect(flaky.running).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(flaky.running).toBe(true)
    flaky.dispose()
  })
})
