/**
 * 深链接（vixel://open?…）：把库里的一条内容变成可以贴进笔记 / 文档的链接，
 * 点击后回到 Vixel 并定位到它（音视频跳到时间点）。构建（渲染进程"拷贝链接"、
 * MCP 工具）和解析（主进程 open-url / second-instance）共用这一个模块，纯函数、无依赖。
 *
 * 形态（host 固定为 open，与内部资源协议 vixel://thumb|image|media|sprite|face 不冲突 ——
 * 那些只在渲染进程内由 protocol.handle 响应，OS 转交的外部链接走 open-url / argv，两条路互不相见）：
 *
 *   vixel://open?hash=<fileHash>&id=<photoId>            图片
 *   vixel://open?hash=<fileHash>&video=<videoId>&t=<秒>   视频 / 音频（t 可省略）
 *
 * hash 是内容哈希（xxHash64）：清库重建、移动文件、换文件夹后 id 都会变，hash 只随内容变 ——
 * 解析时 hash 优先，id 只作内容已变 / 旧版链接的兜底，所以链接能活过重建索引。
 *
 * 网页链接用同一套参数：http://<主机>:<端口>/open?hash=…&video=…&t=… —— 网页版（NAS / 桌面"本地接口"）
 * 打开 /open 时按同样规则定位，链接同样活过重建索引；能在手机、网页笔记等装不了 Vixel 的地方点开。
 */
import type { Photo } from './types'

export const DEEPLINK_SCHEME = 'vixel'
export const DEEPLINK_HOST = 'open'

/** 解析出的目标（都可缺省；resolve 方按 hash → video → id 的顺序找） */
export interface DeepLinkTarget {
  /** 内容哈希（优先；重建索引后依然有效） */
  hash?: string
  /** photos.id（图片） */
  photoId?: number
  /** videos.id（视频 / 音频） */
  videoId?: number
  /** 跳到的时间点（毫秒；仅音视频有意义） */
  timeMs?: number
}

const posInt = (v: string | null): number | undefined => {
  if (!v) return undefined
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

/** 内容哈希：xxHash64 的 16 位十六进制（别把任意字符串塞进 SQL 查询参数） */
const isHash = (v: string): boolean => /^[0-9a-f]{8,64}$/i.test(v)

/** 定位参数（vixel://open 和网页 /open 共用）；timeMs 只在有 videoId 时写入（取整到秒，链接可读） */
function linkParams(target: DeepLinkTarget): URLSearchParams {
  const params = new URLSearchParams()
  if (target.hash) params.set('hash', target.hash)
  if (target.videoId != null) {
    params.set('video', String(target.videoId))
    if (target.timeMs != null && target.timeMs > 0) params.set('t', String(Math.round(target.timeMs / 1000)))
  } else if (target.photoId != null) {
    params.set('id', String(target.photoId))
  }
  return params
}

/** 构建 vixel://open 链接 */
export function buildDeepLink(target: DeepLinkTarget): string {
  return `${DEEPLINK_SCHEME}://${DEEPLINK_HOST}?${linkParams(target).toString()}`
}

/** 构建网页链接 <base>/open?…（base 如 http://192.168.1.15:41721，末尾斜杠可有可无） */
export function buildHttpLink(base: string, target: DeepLinkTarget): string {
  return `${base.replace(/\/+$/, '')}/open?${linkParams(target).toString()}`
}

/** 结果项 → 定位目标：媒体（videoId 非空）带时间点，图片不带 */
export function linkTargetForItem(photo: Pick<Photo, 'id' | 'fileHash' | 'videoId'>, timeMs?: number | null): DeepLinkTarget {
  return photo.videoId != null
    ? { hash: photo.fileHash || undefined, videoId: photo.videoId, timeMs: timeMs ?? undefined }
    : { hash: photo.fileHash || undefined, photoId: photo.id }
}

/** 结果项 → vixel:// 链接 */
export function deepLinkForItem(photo: Pick<Photo, 'id' | 'fileHash' | 'videoId'>, timeMs?: number | null): string {
  return buildDeepLink(linkTargetForItem(photo, timeMs))
}

/** 结果项 → 网页链接 */
export function httpLinkForItem(base: string, photo: Pick<Photo, 'id' | 'fileHash' | 'videoId'>, timeMs?: number | null): string {
  return buildHttpLink(base, linkTargetForItem(photo, timeMs))
}

/** 按内容哈希取缩略图的网页地址（Markdown 内嵌预览用；同样活过重建索引） */
export function thumbUrlForHash(base: string, hash: string): string {
  return `${base.replace(/\/+$/, '')}/media/thumbh/${hash}`
}

/**
 * 解析 vixel://open 链接；不是本形态（其他 host、缺所有定位参数、数值非法）返回 null。
 * t 接受小数秒（"42" / "42.5"），内部统一毫秒。
 */
export function parseDeepLink(url: string): DeepLinkTarget | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.protocol !== `${DEEPLINK_SCHEME}:` || u.host !== DEEPLINK_HOST) return null
  return parseLinkParams(u.searchParams)
}

/** 解析定位参数（网页 /open 的 location.search 也走这里）；缺所有定位参数、数值非法返回 null */
export function parseLinkParams(params: URLSearchParams): DeepLinkTarget | null {
  const target: DeepLinkTarget = {}
  const hash = params.get('hash')
  if (hash && isHash(hash)) target.hash = hash.toLowerCase()
  const photoId = posInt(params.get('id'))
  if (photoId) target.photoId = photoId
  const videoId = posInt(params.get('video'))
  if (videoId) target.videoId = videoId
  if (!target.hash && !target.photoId && !target.videoId) return null
  const t = params.get('t')
  if (t) {
    const sec = Number(t)
    if (Number.isFinite(sec) && sec >= 0) target.timeMs = Math.round(sec * 1000)
  }
  return target
}

/** 0:42、1:02:03（Markdown 链接文字里的时间点） */
export function formatLinkTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** Markdown 链接文字：文件名（[ ] 和反斜杠转义，别破坏 Markdown 结构）+ 时间点 */
function linkLabel(fileName: string, timeMs?: number | null): string {
  return `${fileName.replace(/([[\]\\])/g, '\\$1')}${timeMs != null && timeMs > 0 ? ` @ ${formatLinkTime(timeMs)}` : ''}`
}

/** `[文件名 @ 0:42](vixel://open?…)` */
export function markdownLinkForItem(fileName: string, url: string, timeMs?: number | null): string {
  return `[${linkLabel(fileName, timeMs)}](${url})`
}

/** 带缩略图的 Markdown：`[![文件名 @ 0:42](缩略图)](链接)` —— 笔记里直接显示预览，点击打开 */
export function markdownThumbLinkForItem(fileName: string, url: string, thumbUrl: string, timeMs?: number | null): string {
  return `[![${linkLabel(fileName, timeMs)}](${thumbUrl})](${url})`
}
