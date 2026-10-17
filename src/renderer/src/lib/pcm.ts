/**
 * 语音录音的纯转换：浏览器 AudioContext 采到的 Float32 PCM → 16 kHz mono 16-bit WAV 字节。
 * 不碰 DOM / 音频 API，方便单测（vitest，node 环境）；录音编排在 lib/voiceCapture.ts。
 */

/** 线性插值重采样（语音转写用，不追求音质；fromRate === 16000 时原样拼接） */
export function resampleTo16k(chunks: Float32Array[], fromRate: number): Float32Array {
  let total = 0
  for (const c of chunks) total += c.length
  const joined = new Float32Array(total)
  let off = 0
  for (const c of chunks) { joined.set(c, off); off += c.length }
  if (fromRate === 16000 || joined.length === 0) return joined
  const ratio = fromRate / 16000
  const out = new Float32Array(Math.floor(joined.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio
    const i0 = Math.floor(pos)
    const i1 = Math.min(i0 + 1, joined.length - 1)
    out[i] = joined[i0] + (joined[i1] - joined[i0]) * (pos - i0)
  }
  return out
}

/** mono Float32 [-1,1] → 16-bit PCM WAV（与 litertProvider.toWav 同格式，这里要在浏览器里跑） */
export function encodeWavPcm16(samples: Float32Array, sampleRate = 16000): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const dv = new DataView(out.buffer)
  const ascii = (off: number, s: string): void => { for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i) }
  ascii(0, 'RIFF'); dv.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE')
  ascii(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true)
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true)
  ascii(36, 'data'); dv.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    dv.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true)
  }
  return out
}

/** 一段采样的 RMS（电平表用；0–1 左右的量级） */
export function rmsLevel(chunk: Float32Array): number {
  if (chunk.length === 0) return 0
  let sum = 0
  for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i]
  return Math.sqrt(sum / chunk.length)
}
