/**
 * 语音搜索输入的录音编排（SearchBar 的麦克风按钮用）。
 *
 * 流程：getUserMedia → AudioContext + ScriptProcessor 采 Float32 PCM（顺带算电平）→
 * 停止后重采样到 16 kHz、编成 WAV（lib/pcm.ts，纯函数）→ window.api.voice.transcribe →
 * 文字回调（交给正常的文字搜索）。≤ 15 s 自动停止；Esc 取消（丢弃录音）。
 *
 * 隐私：音频只进内存和主进程的临时文件，转写用 macOS 系统离线听写（见 src/main/voice.ts），
 * 不碰浏览器的 Web Speech API（Chrome 会把音频送到 Google）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { t } from '../../../shared/i18n'
import type { VoiceStatus } from '../../../shared/types'
import { resampleTo16k, encodeWavPcm16, rmsLevel } from './pcm'

/** 最长录音时长：搜索查询都是短句，15 s 足够，也限住 IPC 字节量（15 s × 16 kHz × 2 B ≈ 470 KB） */
const MAX_RECORD_MS = 15_000

export type VoiceUiState = 'idle' | 'recording' | 'transcribing'

interface Session {
  stream: MediaStream
  ctx: AudioContext
  source: MediaStreamAudioSourceNode
  proc: ScriptProcessorNode
  chunks: Float32Array[]
  sampleRate: number
  timer: ReturnType<typeof setTimeout>
}

export interface VoiceCapture {
  /** null = 状态还没取到 / 平台没有语音输入 → 不渲染麦克风 */
  status: VoiceStatus | null
  state: VoiceUiState
  /** 录音电平（RMS，0–1 量级），电平表用 */
  level: number
  /** 错误 / 指引文案（已本地化）；点击或下一次操作时清掉 */
  notice: string | null
  clearNotice: () => void
  /** idle → 录音；recording → 停止并转写 */
  toggle: () => void
}

export function useVoiceCapture(onText: (text: string) => void): VoiceCapture {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [state, setState] = useState<VoiceUiState>('idle')
  const [level, setLevel] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const session = useRef<Session | null>(null)
  const onTextRef = useRef(onText)
  onTextRef.current = onText

  useEffect(() => {
    let mounted = true
    window.api.voice.status().then((s) => { if (mounted) setStatus(s) }).catch(() => {})
    return () => { mounted = false }
  }, [])

  const teardown = useCallback(() => {
    const s = session.current
    session.current = null
    if (!s) return
    clearTimeout(s.timer)
    s.proc.onaudioprocess = null
    try { s.source.disconnect(); s.proc.disconnect() } catch { /* 已断开 */ }
    s.stream.getTracks().forEach((track) => track.stop())
    void s.ctx.close().catch(() => {})
  }, [])

  const cancel = useCallback(() => {
    teardown()
    setState('idle')
    setLevel(0)
  }, [teardown])

  /** 停止录音 → 16 kHz WAV → 主进程转写 → 文字回调 */
  const finish = useCallback(async () => {
    const s = session.current
    if (!s) return
    const { chunks, sampleRate } = s
    teardown()
    setState('transcribing')
    try {
      const wav = encodeWavPcm16(resampleTo16k(chunks, sampleRate))
      const r = await window.api.voice.transcribe(wav)
      if (r.error === 'asset-missing') setNotice(t.voice.assetMissing)
      else if (r.error) setNotice(t.voice.failed)
      else if (!r.text) setNotice(t.voice.noSpeech)
      else onTextRef.current(r.text)
    } catch {
      setNotice(t.voice.failed)
    } finally {
      setState('idle')
      setLevel(0)
    }
  }, [teardown])

  const start = useCallback(async () => {
    setNotice(null)
    // 模型未下载：按钮保留（可发现性），点击给指引而不是静默没反应
    if (status?.reason === 'asset') { setNotice(t.voice.assetMissing); return }
    if (!status?.available) return
    const allowed = await window.api.voice.requestMic().catch(() => false)
    if (!allowed) { setNotice(t.voice.permissionDenied); return }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setNotice(t.voice.permissionDenied)
      return
    }
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    // ScriptProcessor 要接到 destination 才会被驱动；不往 outputBuffer 写就是静音，不会外放
    const proc = ctx.createScriptProcessor(4096, 1, 1)
    const chunks: Float32Array[] = []
    proc.onaudioprocess = (e): void => {
      const data = e.inputBuffer.getChannelData(0)
      chunks.push(new Float32Array(data))
      setLevel(rmsLevel(data))
    }
    source.connect(proc)
    proc.connect(ctx.destination)
    const timer = setTimeout(() => { void finish() }, MAX_RECORD_MS)
    session.current = { stream, ctx, source, proc, chunks, sampleRate: ctx.sampleRate, timer }
    setState('recording')
  }, [status, finish])

  const toggle = useCallback(() => {
    if (state === 'recording') void finish()
    else if (state === 'idle') void start()
  }, [state, start, finish])

  // 录音中按 Esc 取消（捕获阶段拦住，不让它顺带清掉查询 / 关掉浮层）
  useEffect(() => {
    if (state !== 'recording') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [state, cancel])

  // 卸载时收拾干净（关麦克风指示灯）
  useEffect(() => teardown, [teardown])

  const clearNotice = useCallback(() => setNotice(null), [])
  return { status, state, level, notice, clearNotice, toggle }
}
