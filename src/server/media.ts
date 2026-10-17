/**
 * /media 路由：与桌面 vixel:// 协议一一对应（同一套 services/media.ts 解析器）。
 *
 *   GET /media/thumb/<photoId>    缩略图（webp，immutable 缓存）
 *   GET /media/image/<photoId>    原图
 *   GET /media/media/<videoId>    音视频源文件（Range 支持，<video>/<audio> seek）
 *   GET /media/sprite/<videoId>   拖动预览 sprite
 *   GET /media/face/<faceId>      人脸裁剪
 *
 * 路径安全（纵深防御第二层，路由本身只收数字 id）：解析出的文件必须 realpath 落在
 * 某个监视文件夹或数据目录之内，否则 403 —— 库里登记了库外路径（比如符号链接逃逸）也读不到。
 */
import type { ServerResponse } from 'http'
import { extname } from 'path'
import { stat } from 'fs/promises'
import { createReadStream } from 'fs'
import type { VixelServices } from '../services/api'
import { serveMediaFile } from '../core/media/serve'
import { mediaMimeType } from '../core/media/range'
import { resolveInsideRoots } from './pathSafety'
import { sendWebResponse, sendJson } from './http'

const IMAGE_MIME: Record<string, string> = {
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.svg': 'image/svg+xml',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

function imageMime(path: string): string {
  return IMAGE_MIME[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

async function streamFile(res: ServerResponse, path: string, opts: { immutable: boolean }): Promise<void> {
  const { size } = await stat(path)
  res.writeHead(200, {
    'Content-Type': imageMime(path),
    'Content-Length': size,
    // 缩略图 / 人脸裁剪 / sprite 按内容寻址，不会变
    'Cache-Control': opts.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  })
  const stream = createReadStream(path)
  stream.pipe(res)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
}

export interface MediaRouteDeps {
  services: VixelServices
  /** 允许读取的根：数据目录（生成产物）+ 所有监视文件夹（每次请求现取，folders 可变） */
  allowedRoots(): string[]
}

/**
 * 处理 GET /media/<kind>/<id>，以及按内容哈希的缩略图 GET /media/thumbh/<hash>（网页链接里内嵌的预览，
 * 活过重建索引）。返回 true 表示本函数已经响应（无论成败）。
 */
export async function handleMediaRequest(pathname: string, res: ServerResponse, rangeHeader: string | null, deps: MediaRouteDeps): Promise<boolean> {
  const byHash = /^\/media\/thumbh\/([0-9a-f]{8,64})$/i.exec(pathname)
  const m = byHash ? null : /^\/media\/(thumb|image|media|sprite|face)\/(\d+)$/.exec(pathname)
  if (!byHash && !m) return false
  const kind = byHash ? 'thumbh' : m![1]
  const id = m ? parseInt(m[2], 10) : 0
  const { services } = deps

  try {
    let path: string | null = null
    switch (kind) {
      case 'thumbh': path = services.media.thumbPathByHash(byHash![1]); break
      case 'thumb': path = services.media.thumbPath(id); break
      case 'image': path = services.media.imagePath(id); break
      case 'media': path = services.media.mediaPath(id); break
      case 'sprite': path = await services.media.spritePath(id); break
      case 'face': path = await services.media.facePath(id); break
    }
    if (!path) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return true
    }

    // 路径安全：realpath 必须落在监视文件夹 / 数据目录之内（拒绝符号链接逃逸等）
    const safe = await resolveInsideRoots(path, deps.allowedRoots())
    if (!safe) {
      sendJson(res, 403, { ok: false, error: 'file is outside the configured library and data directories' })
      return true
    }

    if (kind === 'media') {
      // 音视频：Range 支持交给与桌面相同的 serveMediaFile（200 / 206 / 416）
      await sendWebResponse(res, await serveMediaFile(safe, rangeHeader))
      return true
    }
    await streamFile(res, safe, { immutable: kind !== 'image' })
    return true
  } catch (err) {
    console.error(`[media] ${kind}/${id} failed:`, err)
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(err) })
    else res.destroy()
    return true
  }
}
