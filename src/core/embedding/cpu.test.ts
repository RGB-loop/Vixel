import { describe, it, expect } from 'vitest'
import { missingCpuFlags, cpuEngineCreationFailed } from './index'

const X64_OK = 'processor\t: 0\nflags\t\t: fpu mmx sse sse2 pni pclmulqdq ssse3 cx16 sse4_1 sse4_2 popcnt aes avx avx2 fma\n'

describe('missingCpuFlags', () => {
  it('modern x86 (AVX2) has everything', () => {
    expect(missingCpuFlags(X64_OK, 'x64')).toEqual([])
  })
  it('J4125 / Denverton style x86 (sse4_2, no avx) is missing avx', () => {
    expect(missingCpuFlags(X64_OK.replace(' avx avx2 fma', ''), 'x64')).toEqual(['avx'])
  })
  it('avx_vnni / avx512 substrings do not count as avx', () => {
    expect(missingCpuFlags(X64_OK.replace(' avx avx2 fma', ' avx_vnni avx512f'), 'x64')).toEqual(['avx'])
  })
  it('Cortex-A53 (ARMv8.0, RTD1296) lacks dotprod / fp16 / lse', () => {
    const a53 = 'processor\t: 0\nFeatures\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 cpuid\n'
    expect(missingCpuFlags(a53, 'arm64')).toEqual(['asimddp', 'fphp', 'asimdhp', 'atomics', 'lrcpc', 'asimdrdm'])
  })
  it('Cortex-A55 (ARMv8.2, RTD1619B) is fine', () => {
    const a55 = 'Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm lrcpc dcpop asimddp\n'
    expect(missingCpuFlags(a55, 'arm64')).toEqual([])
  })
  it('unknown format or arch never disables', () => {
    expect(missingCpuFlags('model name : something\n', 'x64')).toEqual([])
    expect(missingCpuFlags(X64_OK, 'ia32')).toEqual([])
  })
})

describe('cpuEngineCreationFailed', () => {
  it('matches the cpu-backend failure from native.ts, in all its wrappings', () => {
    expect(cpuEngineCreationFailed(new Error('LiteRT: failed to create cpu engine'))).toBe(true)
    // 经 transport 转发后是字符串："Error: LiteRT: failed to create cpu engine"
    expect(cpuEngineCreationFailed('Error: LiteRT: failed to create cpu engine')).toBe(true)
  })
  it('does not match gpu-only failures or other init errors', () => {
    expect(cpuEngineCreationFailed(new Error('LiteRT: failed to create gpu engine'))).toBe(false)
    expect(cpuEngineCreationFailed(new Error('LiteRT: cannot open model /x/y.litertlm'))).toBe(false)
    expect(cpuEngineCreationFailed(new Error('LiteRT runtime missing: …'))).toBe(false)
  })
})
