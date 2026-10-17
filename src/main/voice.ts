/**
 * 语音搜索输入（macOS 桌面版）：渲染进程录音（getUserMedia → 16 kHz mono WAV），字节经 IPC
 * 送到这里，写进临时文件后交给 vixel-speech 辅助程序（SpeechAnalyzer，系统级离线听写）转写。
 * 语音永远走 语音 → 文字 → 正常文字搜索：直接拿语音向量去搜实测不可靠
 * （top-1 4/6 vs 文字 5/6，中文失败、门槛余弦差只有 0.035，无法分辨"没有匹配"）。
 *
 * 为什么用系统听写而不是自带 ASR 模型：候选过的 Embed2ASR（EmbeddingGemma 2 音频塔 + 小 reader，
 * Apache-2.0）需要音频塔 pooling 之前的 hidden states（1536 维 / 25 fps），LiteRT-LM 的 C API
 * 只给池化后的 768 维向量，我们的推理栈跑不了；上游只有 torch + transformers、无 ONNX 导出，
 * 公布的中文 CER 15.6% 也到不了检索可用线。系统听写实测（20 条合成短查询 + 噪声样本，2026-10-18）
 * zh CER 6.4% / en WER 0%，单条转写 < 0.5 s。
 *
 * 隐私：模型是 macOS 的系统组件（与系统听写共享），全程本机运行；文件输入不需要语音识别授权
 * （SpeechAnalyzer 的设计），录音文件用完即删。语音模型未下载时**不代下载**（应用零出站请求），
 * 界面指引用户去 系统设置 → 键盘 → 听写。Windows / 网页版暂不提供：离线引擎未达质量线（见 PR 说明）。
 */
import { execFile } from 'child_process'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { systemPreferences } from 'electron'
import { locale } from '../shared/i18n'
import type { VoiceStatus, VoiceTranscribeResult } from '../shared/types'

/** 界面语言 → 听写语言。混说英文词的中文查询 zh-CN 听写也认得，反之亦然的能力弱一些 */
const speechLocale = (): string => (locale === 'zh-CN' ? 'zh-CN' : 'en-US')

/** 打包后在 <resources>/speech，开发时是 scripts/build-speech-helper.mjs 的产物目录 */
function helperPath(): string {
  const prod = join(process.resourcesPath ?? '', 'speech', 'vixel-speech')
  if (process.resourcesPath && existsSync(prod)) return prod
  return join(process.cwd(), 'resources', 'speech', 'vixel-speech')
}

function runHelper(args: string[], timeout: number): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(helperPath(), args, { timeout }, (err, stdout) => {
      if (err && typeof (err as NodeJS.ErrnoException).code !== 'number') return reject(err) // spawn 失败 / 超时
      resolve({ code: err ? ((err as NodeJS.ErrnoException).code as unknown as number) : 0, stdout: String(stdout) })
    })
  })
}

export async function voiceStatus(): Promise<VoiceStatus> {
  if (process.platform !== 'darwin') return { available: false, reason: 'platform' }
  if (!existsSync(helperPath())) return { available: false, reason: 'helper' }
  try {
    const { code, stdout } = await runHelper(['check', speechLocale()], 10_000)
    if (code !== 0) return { available: false, reason: 'platform' } // exit 4 = 系统太旧 / 语言不支持
    const state = stdout.trim()
    if (state === 'installed') return { available: true }
    if (state === 'downloadable') return { available: false, reason: 'asset' }
    return { available: false, reason: 'platform' }
  } catch {
    // spawn 不起来（更老的 macOS 加载不了部署目标 26 的二进制）与超时同判
    return { available: false, reason: 'platform' }
  }
}

/** 第一次点麦克风时请求系统麦克风权限（弹一次系统窗；拒绝过的直接 false，由界面指引去系统设置） */
export async function requestMicAccess(): Promise<boolean> {
  if (process.platform !== 'darwin') return false
  try {
    return await systemPreferences.askForMediaAccess('microphone')
  } catch {
    return false
  }
}

export async function voiceTranscribe(wav: Uint8Array): Promise<VoiceTranscribeResult> {
  if (process.platform !== 'darwin' || !existsSync(helperPath())) return { error: 'unavailable' }
  if (!wav || wav.byteLength === 0) return { error: 'failed' }
  const dir = await mkdtemp(join(tmpdir(), 'vixel-voice-'))
  try {
    const p = join(dir, 'q.wav')
    await writeFile(p, Buffer.isBuffer(wav) ? wav : Buffer.from(wav))
    // 转写实测 < 0.5 s；30 s 是模型冷加载的余量
    const { code, stdout } = await runHelper(['transcribe', speechLocale(), p], 30_000)
    if (code === 3) return { error: 'asset-missing' }
    if (code !== 0) return { error: 'failed' }
    return { text: stdout.trim() }
  } catch (err) {
    console.warn('[voice] transcribe failed:', err)
    return { error: 'failed' }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
