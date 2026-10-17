/**
 * 媒体寻址（vixel:// 协议与服务器 /media 路由共用）：按 DB id 解析到磁盘文件路径。
 * 只做"查库 → 路径"的解析与按需生成（sprite / 人脸裁剪），不做响应封装 ——
 * 桌面侧由 protocol.handle 用 net.fetch(file://) 回，服务器侧由 HTTP 层加路径安全检查后流式回。
 */
import { join } from 'path'
import { existsSync } from 'fs'
import { mkdir, writeFile } from 'fs/promises'
import { createHash } from 'crypto'
import type { DatabaseInstance } from '../core/db'
import type { Indexer } from '../core/indexer'
import { getFaceThumbnail } from '../core/face'
import { ensureSprite, SPRITE_MIN_DURATION_MS } from '../core/video/sprite'
import { isFfmpegAvailable } from '../core/video/extract'
import type { FaceBbox } from '../shared/types'

export interface MediaResolvers {
  /** vixel://thumb/<photoId> → <dataDir>/thumbnails/<hash>.webp；没生成好时 null（调用方 404，卡片会重试） */
  thumbPath(photoId: number): string | null
  /** 按内容哈希取缩略图（网页链接 / Markdown 内嵌预览用，活过重建索引）；不在库里或没生成时 null */
  thumbPathByHash(hash: string): string | null
  /** vixel://image/<photoId> → 原图路径 */
  imagePath(photoId: number): string | null
  /** vixel://media/<videoId> → 音视频源文件路径（调用方负责 Range） */
  mediaPath(videoId: number): string | null
  /** vixel://sprite/<videoId> → 拖动预览 sprite；老视频没有时按需生成 */
  spritePath(videoId: number): Promise<string | null>
  /** vixel://face/<faceId> → 人脸裁剪（磁盘缓存 <dataDir>/face_thumbs） */
  facePath(faceId: number): Promise<string | null>
}

export function createMediaResolvers(db: DatabaseInstance, indexer: Indexer, dataDir: string): MediaResolvers {
  /**
   * 人脸裁剪缓存：<dataDir>/face_thumbs/<hash>-<bbox摘要>.jpg。
   * 键用内容 hash + bbox 而不是 faceId：重扫后 id 可能复用，内容键不会串。
   */
  const faceThumbInflight = new Map<string, Promise<string | null>>()

  async function ensureFaceThumb(faceId: number): Promise<string | null> {
    const info = db.getFaceCoverInfo(faceId)
    if (!info) return null
    const key = `${info.fileHash}-${createHash('sha1').update(info.bbox).digest('hex').slice(0, 12)}`
    const dest = join(dataDir, 'face_thumbs', `${key}.jpg`)
    if (existsSync(dest)) return dest
    let p = faceThumbInflight.get(key)
    if (!p) {
      p = (async () => {
        const photo = db.getRepresentativeByHash(info.fileHash)
        if (!photo) return null
        // 与检测同源：视频取全分辨率帧，照片取原图
        const crop = await getFaceThumbnail(await indexer.analysisImage(photo), JSON.parse(info.bbox) as FaceBbox)
        await mkdir(join(dataDir, 'face_thumbs'), { recursive: true })
        await writeFile(dest, crop)
        return dest
      })().finally(() => faceThumbInflight.delete(key))
      faceThumbInflight.set(key, p)
    }
    return p
  }

  return {
    thumbPath(photoId) {
      const photo = db.getPhoto(photoId)
      if (!photo?.fileHash) return null
      const thumbPath = indexer.getThumbnailPath(photo.fileHash)
      return existsSync(thumbPath) ? thumbPath : null
    },

    thumbPathByHash(hash) {
      if (!/^[0-9a-f]{8,64}$/i.test(hash) || !db.getRepresentativeByHash(hash.toLowerCase())) return null
      const thumbPath = indexer.getThumbnailPath(hash.toLowerCase())
      return existsSync(thumbPath) ? thumbPath : null
    },

    imagePath(photoId) {
      const photo = db.getPhoto(photoId)
      if (!photo || !existsSync(photo.filePath)) return null
      return photo.filePath
    },

    mediaPath(videoId) {
      const video = db.getVideoById(videoId)
      if (!video || !existsSync(video.filePath)) return null
      return video.filePath
    },

    async spritePath(videoId) {
      const video = db.getVideoById(videoId)
      if (!video || video.mediaKind !== 'video') return null
      const spritePath = indexer.getSpritePath(video.fileHash)
      if (!existsSync(spritePath)) {
        // 还没抽过帧（时长未知）的视频交给索引任务，这里不抢
        if (!video.durationMs || video.durationMs < SPRITE_MIN_DURATION_MS || !existsSync(video.filePath) || !isFfmpegAvailable()) {
          return null
        }
        await ensureSprite(video.filePath, video.durationMs, spritePath)
      }
      return spritePath
    },

    facePath: ensureFaceThumb,
  }
}
