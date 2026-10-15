/**
 * 视频抽帧 —— 用 ffmpeg-static 提供的 ffmpeg 二进制按固定间隔取关键帧。
 *
 * 设计取舍：
 *   - 用临时目录 + image2 输出文件而非 image2pipe 管道。管道方案要自己
 *     按 SOI/EOI 切 JPEG 流，对一个个人相册产品不值得。
 *   - 抽帧间隔固定（indexer 按 32s 片段每 4s 抽一帧），不做 scene detection。
 *     scene detection 对静态长视频会返回 0 帧；固定间隔行为可预测。
 *   - 时长用 probeDurationMs 解析 `ffmpeg -i` 的 stderr，不依赖 ffprobe。
 *
 * 失败模式：找不到 ffmpeg 二进制 / ffmpeg 退出非 0 → 抛错；indexer
 * 把该任务标记 error，跳过该视频。
 */

import { spawn } from 'child_process'
import { mkdtemp, readFile, readdir, rm } from 'fs/promises'
import { setPriority, tmpdir } from 'os'
import { join } from 'path'
import type { ExtractedFrame, ExtractOptions } from './types'
import { getFfmpegPath } from './ffmpegPath'

export type { ExtractedFrame, ExtractOptions } from './types'

export function isFfmpegAvailable(): boolean {
  return getFfmpegPath() !== null
}

/**
 * 对单个视频文件抽取关键帧。
 *
 * 返回按时间升序的帧数组。出错 / 找不到 ffmpeg → 抛错。
 */
export async function extractKeyframes(
  videoPath: string,
  options: ExtractOptions = {}
): Promise<ExtractedFrame[]> {
  const ffmpeg = getFfmpegPath()
  if (!ffmpeg) {
    throw new Error('ffmpeg binary not available (ffmpeg-static package missing or unsupported platform)')
  }

  const intervalSec = options.intervalSec ?? 5
  const maxFrames = options.maxFrames ?? 20
  const maxSide = options.maxSide ?? 512
  const startSec = options.startSec ?? 0
  const durationSec = options.durationSec

  const dir = await mkdtemp(join(tmpdir(), 'vixel-frames-'))
  try {
    // -ss: seek to start position (before -i for fast seek)
    // -t: duration to process (if specified)
    // -vf 解释：
    //   fps=1/N  -- 每 N 秒输出一帧。不能用 select='not(mod(t,N))'：29.97/59.94fps
    //              的帧时间戳几乎不会落在整秒上，-ss seek 后连 t=0 都没有，会抽到 0 帧
    //   scale=W:H:force_original_aspect_ratio=decrease -- 长边 W，等比缩小，不放大
    const vf = `fps=1/${intervalSec},scale='min(${maxSide},iw)':'min(${maxSide},ih)':force_original_aspect_ratio=decrease`

    const buildArgs = (hwaccel: boolean): string[] => {
      const args = [
        '-hide_banner',
        '-loglevel', 'error',
        '-threads', String(FFMPEG_THREADS),
      ]
      if (hwaccel) {
        // 不设 -hwaccel_output_format：解出的帧自动拷回内存，后面的 fps/scale 滤镜照常用
        args.push('-hwaccel', 'videotoolbox')
      }
      if (startSec > 0) {
        args.push('-ss', String(startSec))
      }
      args.push('-i', videoPath)
      if (durationSec !== undefined) {
        args.push('-t', String(durationSec))
      }
      args.push(
        '-vf', vf,
        '-frames:v', String(maxFrames),
        '-f', 'image2',
        join(dir, 'f_%04d.jpg')
      )
      return args
    }

    // macOS 优先 VideoToolbox 硬解：4K HEVC 32s 片段实测 22.8s → 2.8s，CPU 时间 37s → 1.3s。
    // 硬解失败（编码格式不支持 / 会话数用尽）回退软解
    if (USE_VIDEOTOOLBOX) {
      try {
        await runFfmpeg(ffmpeg, buildArgs(true))
      } catch (hwError) {
        console.warn(`VideoToolbox decode failed for ${videoPath}, falling back to software:`, hwError)
        await clearDir(dir)
        await runFfmpeg(ffmpeg, buildArgs(false))
      }
    } else {
      await runFfmpeg(ffmpeg, buildArgs(false))
    }

    const files = (await readdir(dir))
      .filter((f) => f.startsWith('f_') && f.endsWith('.jpg'))
      .sort()

    const frames: ExtractedFrame[] = []
    for (let i = 0; i < files.length; i++) {
      const buffer = await readFile(join(dir, files[i]))
      frames.push({
        buffer,
        // 帧 i 对应片段内的 (i * intervalSec) 秒（fps 过滤器等间隔输出）。
        // 片段模式下加上 startSec 偏移，使时间戳相对整个视频。
        timestampMs: Math.round((startSec + i * intervalSec) * 1000),
      })
    }
    return frames
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * 读视频时长（毫秒）。ffmpeg-static 不带 ffprobe，所以用 `ffmpeg -i <file>`
 * 不给输出 —— ffmpeg 会以非 0 退出，但 stderr 里有 "Duration: HH:MM:SS.xx"。
 *
 * 读不到时长（直播流 / 损坏文件 / "Duration: N/A"）→ 返回 null。
 */
export async function probeDurationMs(videoPath: string): Promise<number | null> {
  return (await probeMedia(videoPath)).durationMs
}

/**
 * ffmpeg -i 的头信息：时长 + 首个视频流的显示尺寸（考虑旋转元数据，竖拍视频宽高对调）。
 * 纯音频 / 读不到时对应字段为 null。
 */
export async function probeMedia(videoPath: string): Promise<{ durationMs: number | null; width: number | null; height: number | null }> {
  const ffmpeg = getFfmpegPath()
  if (!ffmpeg) {
    throw new Error('ffmpeg binary not available (ffmpeg-static package missing or unsupported platform)')
  }
  const stderr = await new Promise<string>((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-i', videoPath], { stdio: ['ignore', 'ignore', 'pipe'] })
    let buf = ''
    const killTimer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already dead */ }
    }, 30_000)
    child.stderr.on('data', (chunk: Buffer) => { buf += chunk.toString() })
    child.on('error', (err) => { clearTimeout(killTimer); reject(err) })
    child.on('close', () => { clearTimeout(killTimer); resolve(buf) })
  })
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(stderr)
  const ms = m ? Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000) : 0
  // "Stream #0:0[0x1](und): Video: hevc (Main 10) (hvc1 / 0x31637668), yuv420p10le(tv, bt2020nc), 3840x2160, ..."
  const v = /Stream #\d+:\d+.*?: Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr)
  let width = v ? Number(v[1]) : null
  let height = v ? Number(v[2]) : null
  const rot = /rotation of (-?\d+(?:\.\d+)?) degrees|rotate\s*:\s*(-?\d+)/.exec(stderr)
  const deg = rot ? Math.abs(Number(rot[1] ?? rot[2])) % 180 : 0
  if (deg === 90 && width && height) [width, height] = [height, width]
  return { durationMs: ms > 0 ? ms : null, width, height }
}

const USE_VIDEOTOOLBOX = process.platform === 'darwin'

async function clearDir(dir: string): Promise<void> {
  for (const f of await readdir(dir)) {
    await rm(join(dir, f), { force: true })
  }
}

// 4K HEVC 软解默认吃满所有核；后台索引限 2 线程 + nice 10，让出 CPU 给前台
export const FFMPEG_THREADS = 2
export const FFMPEG_NICE = 10

export function lowerPriority(pid: number | undefined): void {
  if (pid === undefined) return
  try { setPriority(pid, FFMPEG_NICE) } catch { /* 进程已退出 / 无权限：不影响正确性 */ }
}

// 5 分钟硬上限：单片段在 4K H.265 上通常远低于此，
// 但卡住的视频（损坏 / 编解码 deadlock）必须给 indexer 一个逃生窗口
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000

function runFfmpeg(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    lowerPriority(child.pid)
    let stderr = ''
    let timedOut = false
    const killTimer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* already dead */ }
    }, FFMPEG_TIMEOUT_MS)
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', (err) => {
      clearTimeout(killTimer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(killTimer)
      if (timedOut) {
        reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS / 1000}s`))
      } else if (code === 0) {
        resolve()
      } else {
        reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 500) || 'no stderr'}`))
      }
    })
  })
}
