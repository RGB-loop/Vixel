import { describe, it, expect } from 'vitest'
import { resampleTo16k, encodeWavPcm16, rmsLevel } from './pcm'

describe('resampleTo16k', () => {
  it('16 kHz 输入原样拼接', () => {
    const out = resampleTo16k([new Float32Array([0.1, 0.2]), new Float32Array([0.3])], 16000)
    expect([...out].map((x) => x.toFixed(1))).toEqual(['0.1', '0.2', '0.3'])
  })

  it('48 kHz → 16 kHz：长度按 1/3，值取线性插值', () => {
    const src = new Float32Array(48000).map((_, i) => Math.sin((i / 48000) * 2 * Math.PI * 440))
    const out = resampleTo16k([src], 48000)
    expect(out.length).toBe(16000)
    // 相位应与原信号一致：第 4000 个 16k 采样 = 0.25s 处，sin(2π·440·0.25) = 0
    expect(Math.abs(out[4000])).toBeLessThan(0.01)
  })

  it('空输入 → 空输出', () => {
    expect(resampleTo16k([], 48000).length).toBe(0)
  })
})

describe('encodeWavPcm16', () => {
  it('头部字段与数据长度正确，采样饱和截断', () => {
    const wav = encodeWavPcm16(new Float32Array([0, 1, -1, 2]), 16000)
    expect(wav.length).toBe(44 + 8)
    const dv = new DataView(wav.buffer)
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE')
    expect(dv.getUint32(24, true)).toBe(16000) // 采样率
    expect(dv.getUint16(22, true)).toBe(1)     // 单声道
    expect(dv.getInt16(44, true)).toBe(0)
    expect(dv.getInt16(46, true)).toBe(32767)
    expect(dv.getInt16(48, true)).toBe(-32767)
    expect(dv.getInt16(50, true)).toBe(32767)  // 超界饱和
  })
})

describe('rmsLevel', () => {
  it('静音为 0，满幅方波为 1', () => {
    expect(rmsLevel(new Float32Array(100))).toBe(0)
    expect(rmsLevel(new Float32Array(100).fill(1))).toBeCloseTo(1)
    expect(rmsLevel(new Float32Array(0))).toBe(0)
  })
})
