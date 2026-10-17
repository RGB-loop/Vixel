/**
 * MCP 工具集（只读）：AI 客户端用自然语言查本地媒体库。
 * 三个宿主共用：桌面"本地接口"（Electron 主进程里的 HTTP /mcp）、服务器版 Docker 的 /mcp、
 * CLI 的 `vixel mcp`（stdio）—— 所以只依赖 core（db / search / tagStore），不碰服务层。
 *
 * 全部工具只读：不提供任何写库 / 写文件 / 执行类工具，连接的 AI 客户端最多看到库的元数据。
 * 返回里带 vixel:// 深链接（shared/deeplink.ts，可贴进笔记）和可选的 http 媒体链接
 * （宿主给出基址时；浏览器里打开仍需登录会话）。
 */
import type { DatabaseInstance } from '../db'
import type { SearchEngine } from '../search'
import { TagStore } from '../tagStore'
import { deepLinkForItem, httpLinkForItem } from '../../shared/deeplink'
import type { MediaKind, Photo, SearchResult } from '../../shared/types'

export interface McpToolContext {
  db: DatabaseInstance
  searchEngine: SearchEngine
  tagStore: TagStore
}

/** 单次调用的环境：http 媒体链接的基址（desktop/服务器给，stdio 没有） */
export interface McpCallExtra {
  httpBase?: string | null
}

/** MCP tools/list 返回的工具定义（inputSchema 是 JSON Schema） */
export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const SEARCH_LIMIT_DEFAULT = 20
const SEARCH_LIMIT_MAX = 100

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'search_media',
    description:
      'Search the local photo/video/audio library with a natural-language query (Chinese and English both work). ' +
      'Combines semantic vectors, text found inside images (OCR), filenames and tags. ' +
      'Returns matching items with scores, the matched video/audio time range, a vixel:// deep link ' +
      '(opens the item in the Vixel app, jumping to the timestamp for media) and, when available, an http link to the media.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, e.g. "海边的日落" or "waterfall"' },
        kind: { type: 'string', enum: ['image', 'video', 'audio'], description: 'Only return this media type' },
        limit: { type: 'number', description: `Max results (default ${SEARCH_LIMIT_DEFAULT}, max ${SEARCH_LIMIT_MAX})` },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_media',
    description:
      'Full details of one library item by photo id, video id or content hash: file path, dimensions, duration, ' +
      'capture date, caption, text recognized inside the image (OCR), tags, people, favorite flag and links.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Photo id (from search_media results)' },
        video: { type: 'number', description: 'Video/audio id (from search_media results, field videoId)' },
        hash: { type: 'string', description: 'Content hash (field hash in results); survives re-indexing' },
      },
    },
  },
  {
    name: 'find_similar',
    description: 'Find items visually similar to a library photo (by photo id). Returns the same shape as search_media.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'Photo id to find similar items for' },
        limit: { type: 'number', description: `Max results (default 12, max ${SEARCH_LIMIT_MAX})` },
      },
      required: ['id'],
    },
  },
]

class ToolInputError extends Error {}

const clampLimit = (v: unknown, def: number): number => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.floor(n), SEARCH_LIMIT_MAX)
}

const posInt = (v: unknown): number | undefined => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/**
 * http 链接（有本地接口 / 服务器地址时才带）：
 *   httpUrl  —— 网页查看页 /open?…（按内容 hash 定位，活过重建索引；音视频跳到时间点），给人点、贴进笔记
 *   mediaUrl —— 原文件（图片原图 / 音视频源文件，支持 Range），给要下载 / 处理文件的 Agent
 * 浏览器里打开仍需登录（有口令时）
 */
function httpLinks(photo: Photo, base: string | null | undefined, timeMs?: number | null): Record<string, string> {
  if (!base) return {}
  const root = base.replace(/\/$/, '')
  return {
    httpUrl: httpLinkForItem(root, photo, timeMs),
    mediaUrl: photo.videoId != null ? `${root}/media/media/${photo.videoId}` : `${root}/media/image/${photo.id}`,
  }
}

function resultItem(ctx: McpToolContext, r: SearchResult, extra: McpCallExtra): Record<string, unknown> {
  const p = r.photo
  // 音视频的 photo 行是代表图（抽帧 / 封面）：路径要给源文件的
  const source = p.videoId != null ? ctx.db.getVideoById(p.videoId) : undefined
  return {
    id: p.id,
    ...(p.videoId != null ? { videoId: p.videoId } : {}),
    name: source?.fileName ?? p.fileName,
    path: source?.filePath ?? p.filePath,
    type: p.mediaKind ?? 'image',
    hash: p.fileHash,
    score: Math.round(r.score * 1000) / 1000,
    ...(r.matchedBy ? { matchedBy: r.matchedBy } : {}),
    ...(r.lowConfidence ? { lowConfidence: true } : {}),
    ...(r.segment ? { timeRange: { startSec: r.segment.startMs / 1000, endSec: r.segment.endMs / 1000 } } : {}),
    ...(p.takenAt ? { takenAt: p.takenAt } : {}),
    link: deepLinkForItem(p, r.segment?.startMs),
    ...httpLinks(p, extra.httpBase, r.segment?.startMs),
  }
}

async function searchMedia(ctx: McpToolContext, args: Record<string, unknown>, extra: McpCallExtra): Promise<unknown> {
  const query = typeof args.query === 'string' ? args.query.trim() : ''
  if (!query) throw new ToolInputError('query is required')
  const kind = args.kind === 'image' || args.kind === 'video' || args.kind === 'audio' ? (args.kind as MediaKind) : undefined
  const limit = clampLimit(args.limit, SEARCH_LIMIT_DEFAULT)
  const results = await ctx.searchEngine.search(query, limit, kind ? { kind } : undefined)
  return {
    query,
    count: results.length,
    // 整组低置信 = 库里没有明显相关的内容，这些只是"最接近"的
    ...(results.length > 0 && results.every((r) => r.lowConfidence) ? { noConfidentMatch: true } : {}),
    items: results.map((r) => resultItem(ctx, r, extra)),
  }
}

function getMedia(ctx: McpToolContext, args: Record<string, unknown>, extra: McpCallExtra): unknown {
  const { db, tagStore } = ctx
  let photo: Photo | undefined
  const hash = typeof args.hash === 'string' && /^[0-9a-f]{8,64}$/i.test(args.hash) ? args.hash.toLowerCase() : undefined
  if (hash) photo = db.getRepresentativeByHash(hash)
  const videoId = posInt(args.video)
  if (!photo && videoId) {
    const video = db.getVideoById(videoId)
    if (video) photo = db.getRepresentativeByHash(video.fileHash)
  }
  const photoId = posInt(args.id)
  if (!photo && photoId) photo = db.getPhoto(photoId)
  if (!photo) {
    if (!hash && !videoId && !photoId) throw new ToolInputError('pass one of: id (photo), video (video/audio id) or hash')
    return { found: false }
  }

  const detail = db.getPhotoDetail(photo.id)
  const media = photo.videoId != null ? db.getMediaDetail(photo.videoId) : undefined
  const tags = tagStore.forHashes([photo.fileHash]).all.map((t) => t.name)
  const people = [...new Set(db.getFacesByHash(photo.fileHash).map((f) => f.personName).filter((n): n is string => !!n))]
  return {
    found: true,
    id: photo.id,
    ...(photo.videoId != null ? { videoId: photo.videoId } : {}),
    name: media?.fileName ?? photo.fileName,
    path: media?.filePath ?? photo.filePath,
    type: photo.mediaKind ?? 'image',
    hash: photo.fileHash,
    sizeBytes: media?.fileSize ?? photo.fileSize,
    ...(photo.width && photo.height ? { width: photo.width, height: photo.height } : {}),
    ...(media?.durationMs ? { durationMs: media.durationMs } : {}),
    ...(photo.takenAt ? { takenAt: photo.takenAt } : {}),
    ...(detail?.caption ? { caption: detail.caption } : {}),
    ...(detail?.ocrText ? { ocrText: detail.ocrText } : {}),
    tags,
    people,
    favorite: !!photo.favorite,
    ...(media ? { segments: media.segments.map((s) => ({ startSec: s.startMs / 1000, endSec: s.endMs / 1000 })) } : {}),
    link: deepLinkForItem(photo),
    ...httpLinks(photo, extra.httpBase),
  }
}

function findSimilar(ctx: McpToolContext, args: Record<string, unknown>, extra: McpCallExtra): unknown {
  const photoId = posInt(args.id)
  if (!photoId) throw new ToolInputError('id (photo id) is required')
  const photo = ctx.db.getPhoto(photoId)
  if (!photo?.fileHash) return { found: false, items: [] }
  const limit = clampLimit(args.limit, 12)
  const results = ctx.searchEngine.findSimilar(photo.fileHash, limit)
  return { found: true, count: results.length, items: results.map((r) => resultItem(ctx, r, extra)) }
}

export interface McpToolOutcome {
  /** 给纯文本客户端的 JSON 文本 + 给新客户端的结构化结果 */
  result?: unknown
  /** 入参不合法（JSON-RPC Invalid params，而不是工具执行失败） */
  invalidParams?: string
}

/** 执行一个工具；未知工具名返回 null（调用方回 JSON-RPC 错误） */
export async function callTool(
  ctx: McpToolContext,
  name: string,
  args: Record<string, unknown>,
  extra: McpCallExtra = {}
): Promise<McpToolOutcome | null> {
  try {
    switch (name) {
      case 'search_media': return { result: await searchMedia(ctx, args, extra) }
      case 'get_media': return { result: getMedia(ctx, args, extra) }
      case 'find_similar': return { result: findSimilar(ctx, args, extra) }
      default: return null
    }
  } catch (err) {
    if (err instanceof ToolInputError) return { invalidParams: err.message }
    throw err
  }
}

/** 宿主只有 db 时的便捷构造（CLI / 服务器复用现成实例时不走这里） */
export function createToolContext(db: DatabaseInstance, searchEngine: SearchEngine): McpToolContext {
  return { db, searchEngine, tagStore: new TagStore(db.raw) }
}
