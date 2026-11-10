import type { AudioCaptureMode } from '@shared/audio-frame'

/** lumina-helper capture output: [type:u8][length:u32 LE][payload]. */
export const PACKET_PCM = 1
export const PACKET_JSON = 2
/** No legitimate packet is larger (the helper writes ~10 ms per packet); anything bigger means a broken stream. */
export const MAX_PACKET_BYTES = 1 << 20

export type HelperPacket = { kind: 'pcm'; samples: Float32Array } | { kind: 'json'; message: unknown }

/**
 * Reassembles helper packets from arbitrary stdout chunks. Holds at most one packet's worth of
 * bytes; a corrupt length resets the stream instead of buffering without bound.
 */
export class PacketReader {
  private buffer: Buffer = Buffer.alloc(0)
  corrupt = 0

  push(chunk: Buffer, onPacket: (packet: HelperPacket) => void): void {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    let offset = 0
    while (this.buffer.length - offset >= 5) {
      const type = this.buffer[offset]!
      const length = this.buffer.readUInt32LE(offset + 1)
      if ((type !== PACKET_PCM && type !== PACKET_JSON) || length > MAX_PACKET_BYTES || (type === PACKET_PCM && length % 4)) {
        this.corrupt++
        this.buffer = Buffer.alloc(0)
        return
      }
      if (this.buffer.length - offset - 5 < length) break
      const payload = this.buffer.subarray(offset + 5, offset + 5 + length)
      offset += 5 + length
      if (type === PACKET_PCM) {
        // Copy into an aligned buffer: Float32Array views need 4-byte alignment.
        const samples = new Float32Array(length / 4)
        new Uint8Array(samples.buffer).set(payload)
        onPacket({ kind: 'pcm', samples })
      } else {
        let message: unknown = null
        try {
          message = JSON.parse(payload.toString('utf8'))
        } catch {
          this.corrupt++
          continue
        }
        onPacket({ kind: 'json', message })
      }
    }
    this.buffer = offset ? this.buffer.subarray(offset) : this.buffer
  }
}

export interface HelperStatus {
  state: 'capturing' | 'waiting' | 'error'
  mode: AudioCaptureMode
  sampleRate: number
  message: string
}

/** Validates a helper status message. */
export function parseHelperStatus(message: unknown): HelperStatus | null {
  if (typeof message !== 'object' || message === null) return null
  const m = message as Record<string, unknown>
  if (m.type !== 'status') return null
  const state = m.state === 'capturing' || m.state === 'waiting' || m.state === 'error' ? m.state : null
  const mode = m.mode === 'process' || m.mode === 'system' ? m.mode : null
  if (!state || !mode) return null
  const rate = typeof m.sampleRate === 'number' && Number.isInteger(m.sampleRate) ? m.sampleRate : 0
  return {
    state,
    mode,
    sampleRate: rate >= 8000 && rate <= 384000 ? rate : 0,
    message: typeof m.message === 'string' ? m.message.slice(0, 200) : ''
  }
}
