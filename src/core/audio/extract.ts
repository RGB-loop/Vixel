/**
 * 音频解码 —— 从视频/音频文件提取 mono 16kHz Float32Array
 *
 * 用 ffmpeg-static 提供的 ffmpeg 二进制，直出 f32le 格式到 stdout。
 * 输出格式匹配 EmbeddingGemma 2 audio encoder 的要求：
 *   - 单声道 (mono)
 *   - 16 kHz 采样率
 *   - 小端 float32
 *
 * 使用场景：
 *   - 视频片段 / 纯音频片段：抽取对应时间段的音轨（startSec + durationSec）
 *   - 纯音频代表图：extractCoverOrWaveform（内嵌封面或波形）
 */

import { spawn } from 'child_process'
import { FFMPEG_THREADS, lowerPriority } from '../video/extract'
import { getFfmpegPath } from '../video/ffmpegPath'

export function isFfmpegAvailable(): boolean {
  return getFfmpegPath() !== null
}

export interface ExtractAudioOptions {
  /** 起始时间（秒），省略则从头开始 */
  startSec?: number
  /** 持续时长（秒），省略则提取到文件末尾 */
  durationSec?: number
}

/**
 * 提取音频为 mono 16kHz Float32Array。
 *
 * 出错 / 找不到 ffmpeg → 抛错。
 * 视频无音轨 → 返回长度为 0 的 Float32Array（不抛错，允许静音视频）。
 */
export async function extractAudioTrack(
  filePath: string,
  options: ExtractAudioOptions = {}
): Promise<Float32Array> {
  const ffmpeg = getFfmpegPath()
  if (!ffmpeg) {
    throw new Error('ffmpeg binary not available (ffmpeg-static package missing or unsupported platform)')
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-threads', String(FFMPEG_THREADS)]

  // 起始时间（-ss 放在 -i 前，seek 更快）
  if (options.startSec !== undefined && options.startSec > 0) {
    args.push('-ss', String(options.startSec))
  }

  args.push('-i', filePath)

  // 持续时长
  if (options.durationSec !== undefined && options.durationSec > 0) {
    args.push('-t', String(options.durationSec))
  }

  // -vn: 禁视频流
  // -ac 1: 单声道
  // -ar 16000: 16kHz 采样率
  // -f f32le: 小端 float32 PCM
  // -: 输出到 stdout
  args.push('-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', '-')

  const { buffer, exitCode, stderr } = await runFfmpegToBuffer(ffmpeg, args)

  // 无音轨：-vn 之后没有任何流可输出，ffmpeg 以非 0 退出（"does not contain any stream"）
  if (exitCode !== 0 && /does not contain any stream/i.test(stderr)) return new Float32Array(0)
  if (exitCode !== 0) {
    throw new Error(`ffmpeg exited ${exitCode}: ${stderr.slice(0, 500) || 'no stderr'}`)
  }

  // buffer 是 raw f32le bytes，4 字节一个 float32
  if (buffer.length === 0) {
    // 视频无音轨 / 静音 → 返回空数组，不算错误
    return new Float32Array(0)
  }

  // Buffer → Float32Array。小输出可能来自 Buffer 池，byteOffset 不一定 4 字节对齐，
  // 不对齐时 Float32Array 视图会抛 RangeError，只能拷一份
  const floatCount = Math.floor(buffer.byteLength / 4)
  if (buffer.byteOffset % 4 === 0) {
    return new Float32Array(buffer.buffer, buffer.byteOffset, floatCount)
  }
  const copy = new Uint8Array(floatCount * 4)
  copy.set(buffer.subarray(0, floatCount * 4))
  return new Float32Array(copy.buffer)
}

export interface AudioArtwork {
  /** JPEG 字节 */
  buffer: Buffer
  /** cover = 文件内嵌封面；waveform = 没有封面时生成的波形图 */
  source: 'cover' | 'waveform'
}

const WAVEFORM_SIZE = '1024x512'
// 与 UI 的 surface-1 / accent 同色，缩略图在网格里不突兀
const WAVEFORM_BG = '0x141414'
const WAVEFORM_FG = '0xd4a574'

/**
 * 音频文件的代表图：优先内嵌封面（mp3 APIC / m4a covr，ffmpeg 里是 attached_pic 视频流），
 * 没有则画整首波形。输出 JPEG，交给 indexer 落成代表 photo 走常规缩略图流程。
 */
export async function extractCoverOrWaveform(filePath: string): Promise<AudioArtwork> {
  const ffmpeg = getFfmpegPath()
  if (!ffmpeg) {
    throw new Error('ffmpeg binary not available (ffmpeg-static package missing or unsupported platform)')
  }
  const base = ['-hide_banner', '-loglevel', 'error', '-threads', String(FFMPEG_THREADS), '-i', filePath]

  // 没有视频流时 `0:v:0?` 匹配为空，ffmpeg 报 "no streams" 非 0 退出 → 走波形
  const cover = await runFfmpegToBuffer(ffmpeg, [
    ...base,
    '-an', '-map', '0:v:0?', '-frames:v', '1',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', '-',
  ])
  if (cover.exitCode === 0 && cover.buffer.length > 0) {
    return { buffer: cover.buffer, source: 'cover' }
  }

  const graph =
    `color=c=${WAVEFORM_BG}:s=${WAVEFORM_SIZE}[bg];` +
    `[0:a:0]aformat=channel_layouts=mono,showwavespic=s=${WAVEFORM_SIZE}:colors=${WAVEFORM_FG}:scale=sqrt[w];` +
    `[bg][w]overlay=format=auto`
  const wave = await runFfmpegToBuffer(ffmpeg, [
    ...base,
    '-filter_complex', graph, '-frames:v', '1',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '3', '-',
  ])
  if (wave.exitCode !== 0 || wave.buffer.length === 0) {
    throw new Error(`waveform render failed (ffmpeg exited ${wave.exitCode}): ${wave.stderr.slice(0, 500) || 'no stderr'}`)
  }
  return { buffer: wave.buffer, source: 'waveform' }
}

// 5 分钟硬上限（复用 video/extract.ts 的策略）
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000

interface FfmpegResult {
  buffer: Buffer
  exitCode: number
  stderr: string
}

function runFfmpegToBuffer(bin: string, args: string[]): Promise<FfmpegResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    lowerPriority(child.pid)
    const chunks: Buffer[] = []
    let stderr = ''
    let timedOut = false

    const killTimer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* already dead */ }
    }, FFMPEG_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    child.on('error', (err) => {
      clearTimeout(killTimer)
      reject(err)
    })

    child.on('close', (code) => {
      clearTimeout(killTimer)
      if (timedOut) {
        reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000}s`))
      } else {
        resolve({
          buffer: Buffer.concat(chunks),
          exitCode: code ?? -1,
          stderr: stderr.trim(),
        })
      }
    })
  })
}
