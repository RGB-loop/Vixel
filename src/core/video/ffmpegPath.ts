/**
 * ffmpeg 二进制路径（ffmpeg-static 在 install 时下载到包目录，require() 返回路径或 null）。
 *
 * 打包后的应用里 require 解析到 `…/app.asar/node_modules/ffmpeg-static/ffmpeg`：Electron 的 fs 和
 * execFile 能透明处理 asar 路径，但 child_process.spawn 不能 —— 直接 spawn 报 ENOTDIR（asar 是文件不是目录），
 * 所有视频 / 音频索引都失败。二进制本身在 electron-builder 的 asarUnpack 里（app.asar.unpacked），
 * 所以这里把路径改指向 unpacked。开发环境 / 服务器（没有 asar）原样返回。
 */
import { existsSync } from 'fs'

/** `…/app.asar/…` → `…/app.asar.unpacked/…`（导出给测试） */
export function unpackedAsarPath(p: string): string {
  return p.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2')
}

let cached: string | null | undefined

export function getFfmpegPath(): string | null {
  if (cached === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const p = (require('ffmpeg-static') as string | null) || null
      const unpacked = p ? unpackedAsarPath(p) : null
      cached = unpacked && unpacked !== p && existsSync(unpacked) ? unpacked : p
    } catch {
      cached = null
    }
  }
  return cached
}
