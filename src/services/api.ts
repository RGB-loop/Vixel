/**
 * 传输无关的应用服务层：原来写在 src/main/index.ts 各 IPC handler 里的逻辑移到这里，
 * 桌面（Electron IPC）和服务器（HTTP/WebSocket，src/server）调用同一套函数。
 *
 * `api` 的方法名 / 参数 / 返回值与 preload 暴露的 window.api 一一对应（嵌套组同形）；
 * 服务器的 HTTP 分发表直接由这个对象扁平化生成（见 src/server/api.ts），
 * 覆盖面由 src/server/apiSurface.ts + 契约测试锁定，新增 IPC 方法漏接会在 tsc / vitest 里失败。
 *
 * 桌面专属能力（原生对话框 / 菜单 / shell / 快速面板 / 收集箱导入等）不在这里，
 * 留在 src/main/*（见 apiSurface.ts 的 DESKTOP_ONLY_METHODS）。
 */
import { join } from 'path'
import { accessSync, constants as fsConstants, existsSync } from 'fs'
import { unlink, rm } from 'fs/promises'
import type { DatabaseInstance } from '../core/db'
import type { FileWatcher } from '../core/watcher'
import type { Indexer } from '../core/indexer'
import type { SearchEngine, SearchOptions } from '../core/search'
import { getEmbeddingService, isLiteRtInstalled, semanticCpuUnsupported } from '../core/embedding'
import { suggestMerges } from '../core/face/cluster'
import { searchByImage } from '../core/imageSearch'
import { parsePaletteJson } from '../core/color/palette'
import { isFfmpegAvailable, probeMedia } from '../core/video/extract'
import { TagStore } from '../core/tagStore'
import { CleanupStore } from '../core/cleanupStore'
import { CollectStore } from '../core/collectStore'
import { resolveLocale, setLocale, type LocaleSetting } from '../shared/i18n'
import type { MediaFilters, ThemeMode, EmbeddingConfig, PersonSuggestion, PersonFace, ImageQueryInput, ImageSearchResponse, SearchResult } from '../shared/types'
import type { DeepLinkTarget } from '../shared/deeplink'
import type { DupScanProgress } from '../shared/cleanup'
import type { ServiceEvents } from './events'
import { BackupService } from './backup'
import { createAutoTagService, type AutoTagService } from './autotags'
import { createMediaResolvers, type MediaResolvers } from './media'

const META_KEY_THEME = 'ui.theme'
const META_KEY_LOCALE = 'ui.locale'
/** 设置："电池供电时也索引"（默认开）。关掉后电池供电时回填等待，少量新文件仍即时索引 */
export const META_KEY_INDEX_ON_BATTERY = 'power.index_on_battery'

export interface ServiceHooks {
  /** 桌面：applyTheme（nativeTheme.themeSource）；服务器不需要 */
  onThemeChanged?: (mode: ThemeMode) => void
  /** 桌面：applyLocale + 重建菜单 + reload 所有窗口；服务器只 setLocale */
  onLocaleChanged?: (setting: LocaleSetting) => void
  /** 桌面：电源控制器 refresh；服务器没有电池 */
  onIndexOnBatteryChanged?: () => void
}

export interface ServiceContext {
  db: DatabaseInstance
  watcher: FileWatcher
  indexer: Indexer
  searchEngine: SearchEngine
  /** userData（桌面）/ VIXEL_DATA_DIR（服务器）：library.db、thumbnails、face_thumbs、backups 都在这里 */
  dataDir: string
  /** 打包模型目录（resources/models） */
  modelsDir: string
  events: ServiceEvents
  hooks?: ServiceHooks
  /** 系统偏好语言（桌面来自 app.getPreferredSystemLanguages()；服务器为 []） */
  preferredLanguages?: string[]
}

export interface VixelServices {
  api: ReturnType<typeof buildApi>
  events: ServiceEvents
  /** 跨模块复用的内部句柄（桌面菜单 / 服务器媒体路由等） */
  tagStore: TagStore
  cleanupStore: CleanupStore
  collectStore: CollectStore
  backup: BackupService
  autoTags: AutoTagService
  media: MediaResolvers
  loadTheme(): ThemeMode
  loadLocaleSetting(): LocaleSetting
}

function buildApi(ctx: ServiceContext, deps: {
  tagStore: TagStore
  cleanupStore: CleanupStore
  collectStore: CollectStore
  backup: BackupService
  autoTags: AutoTagService
}) {
  const { db, watcher, indexer, searchEngine, dataDir, modelsDir, events, hooks } = ctx
  const { tagStore, cleanupStore, collectStore, backup, autoTags } = deps
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((h): h is string => typeof h === 'string') : [])

  return {
    // ─── 搜索 ───────────────────────────────────────────────
    // limit / options 可能以 null 到达（网页版 JSON 没有 undefined，中间参数的 undefined 发成 null）：
    // null 会绕过引擎的默认值（limit ?? 50 不会生效，LIMIT NULL 直接 SQLITE_MISMATCH），这里归一化
    search: async (query: string, limit?: number | null, options?: SearchOptions | null): Promise<SearchResult[]> => {
      return searchEngine.search(query, limit ?? undefined, options ?? undefined)
    },

    findSimilar: async (photoId: number, limit?: number): Promise<SearchResult[]> => {
      const photo = db.getPhoto(photoId)
      if (!photo?.fileHash) return []
      return searchEngine.findSimilar(photo.fileHash, limit || 12)
    },

    // 以图搜图：拖入 / 粘贴的查询图只在内存和临时文件里处理，不进资料库（见 core/imageSearch.ts）
    searchByImage: async (input: ImageQueryInput, limit?: number | null, options?: MediaFilters | null): Promise<ImageSearchResponse> => {
      return searchByImage(db, searchEngine, input, limit ?? undefined, options ?? undefined)
    },

    getPhotosWithGPS: async () => db.getPhotosWithGPS(),

    // ─── 文件夹 ─────────────────────────────────────────────
    addFolder: async (folderPath: string) => {
      const folder = db.addFolder(folderPath)
      watcher.watchFolder(folder.id, folder.path)
      events.emit('library-changed')
      return folder
    },

    removeFolder: async (folderId: number) => {
      const folder = db.getFolder(folderId)
      if (folder) {
        watcher.unwatchFolder(folderId)
        const orphanedHashes = db.deletePhotosByFolder(folderId)
        const thumbnailsDir = join(dataDir, 'thumbnails')
        for (const hash of orphanedHashes) {
          const thumbnailPath = join(thumbnailsDir, `${hash}.webp`)
          try {
            if (existsSync(thumbnailPath)) {
              await unlink(thumbnailPath)
            }
          } catch (e) {
            console.warn(`Failed to delete thumbnail: ${thumbnailPath}`, e)
          }
        }
        // 视频的代表帧 photo 也挂在该文件夹下，上面已一并删掉；这里清视频本体 + 片段 + 抽帧目录
        const videoHashes = db.deleteVideosByFolder(folderId)
        for (const hash of videoHashes) {
          await rm(indexer.getVideoFramesDir(hash), { recursive: true, force: true }).catch(() => {})
        }
        db.removeFolder(folderId)
        events.emit('library-changed')
        events.emit('tags-changed')
      }
      return true
    },

    // 顺带检查能不能读：读不了的（权限 / 外接盘已拔）界面上要说清楚，而不是显示"0 项"
    getFolders: async () => db.getFoldersWithStats().map((f) => (folderReadable(f.path) ? f : { ...f, unreadable: true })),
    getLibraryCounts: async () => db.getLibraryCounts(),
    getFolderStats: async (folderId: number) => db.getFolderStats(folderId),

    // ─── 外观 / 语言 ─────────────────────────────────────────
    getTheme: async (): Promise<ThemeMode> => {
      const v = db.getMetaState(META_KEY_THEME)
      return v === 'light' || v === 'dark' ? v : 'system'
    },

    setTheme: async (mode: ThemeMode): Promise<ThemeMode> => {
      const next: ThemeMode = mode === 'light' || mode === 'dark' ? mode : 'system'
      db.setMetaState(META_KEY_THEME, next)
      hooks?.onThemeChanged?.(next)
      return next
    },

    getLocaleSetting: async (): Promise<LocaleSetting> => {
      const v = db.getMetaState(META_KEY_LOCALE)
      return v === 'zh-CN' || v === 'en' ? v : 'system'
    },

    setLocaleSetting: async (setting: LocaleSetting): Promise<LocaleSetting> => {
      const next: LocaleSetting = setting === 'zh-CN' || setting === 'en' ? setting : 'system'
      db.setMetaState(META_KEY_LOCALE, next)
      if (hooks?.onLocaleChanged) hooks.onLocaleChanged(next)
      else setLocale(resolveLocale(next, ctx.preferredLanguages ?? []))
      return next
    },

    // ─── 索引 / 任务 ─────────────────────────────────────────
    getIndexPaused: async () => indexer.isPaused(),

    setIndexPaused: async (paused: boolean) => {
      indexer.setPaused(paused)
      return indexer.isPaused()
    },

    getIndexOnBattery: async () => db.getMetaState(META_KEY_INDEX_ON_BATTERY) !== '0',

    setIndexOnBattery: async (on: boolean) => {
      db.setMetaState(META_KEY_INDEX_ON_BATTERY, on ? '1' : '0')
      hooks?.onIndexOnBatteryChanged?.()
      return db.getMetaState(META_KEY_INDEX_ON_BATTERY) !== '0'
    },

    getSkippedFolders: async (folderId?: number) => {
      return db.listSkippedFolders(typeof folderId === 'number' ? folderId : undefined)
    },

    setSkippedFolderOverride: async (path: string, override: boolean) => {
      const row = db.listSkippedFolders().find((r) => r.path === path)
      if (!row) return false
      db.setSkippedFolderOverride(path, !!override)
      // "仍然索引"：整夹重扫把该目录补进索引（未变化的文件对账开销很小）
      if (override) watcher.rescanAfterOverride(row.folderId)
      return true
    },

    getTaskOverview: async () => db.getTaskOverview(),

    retryFailedTasks: async (ids?: number[]) => {
      const n = db.retryFailedTasks(ids)
      if (n > 0) indexer.processNext()
      indexer.emitProgressPublic()
      return n
    },

    clearFailedTasks: async () => {
      const n = db.clearFailedTasks()
      indexer.emitProgressPublic()
      return n
    },

    // ─── 照片 / 媒体详情 ─────────────────────────────────────
    /**
     * 链接（vixel://open 深链接 / 网页 /open）→ 结果：hash（内容哈希，清库重建 / 移动文件后仍有效）优先，
     * video / photo id 兜底。时间点尽量落到包含它的已索引片段（详情页时间轴整段高亮），
     * 不在任何片段里就按原时间点 seek。找不到返回 null。
     */
    resolveLink: async (target: DeepLinkTarget): Promise<SearchResult | null> => {
      if (!target || typeof target !== 'object') return null
      let photo = target.hash ? db.getRepresentativeByHash(target.hash) : undefined
      if (!photo && target.videoId != null) {
        // 链接里的 hash 是代表图（首帧 / 封面）的，不是视频文件的 —— 按视频 id 找它的代表图行
        const frame = db.getFramePhotosByVideo(target.videoId)[0]
        if (frame?.fileHash) photo = db.getRepresentativeByHash(frame.fileHash)
      }
      if (!photo && target.photoId != null) photo = db.getPhoto(target.photoId)
      if (!photo) return null
      const result: SearchResult = { photo, score: 1 }
      if (target.timeMs != null && photo.videoId != null) {
        const ms = target.timeMs
        // 正好是某个已索引片段的起点（"拷贝链接"产出的就是）→ 用整段，详情页时间轴能整段高亮；
        // 任意时间点 → 起点保持精确（播放器按 startMs seek），终点借所在片段的
        const seg = db.getMediaDetail(photo.videoId)?.segments.find((s) => ms >= s.startMs && ms < s.endMs)
        result.segment = seg && seg.startMs === ms ? seg : { startMs: ms, endMs: Math.max(ms, seg?.endMs ?? ms) }
      }
      return result
    },

    getMediaDetail: async (videoId: number) => {
      const detail = db.getMediaDetail(videoId)
      // 老版本索引的视频没记分辨率：第一次打开时探一下补上（ffmpeg -i 只读文件头，几十毫秒）
      if (detail && detail.kind === 'video' && detail.width == null && existsSync(detail.filePath) && isFfmpegAvailable()) {
        const probe = await probeMedia(detail.filePath).catch(() => null)
        if (probe?.width && probe.height) {
          db.updateVideoMeta(videoId, { width: probe.width, height: probe.height })
          return { ...detail, width: probe.width, height: probe.height }
        }
      }
      return detail ?? null
    },

    getPhotoDetail: async (photoId: number) => {
      const detail = db.getPhotoDetail(photoId)
      if (!detail?.fileHash) return detail
      // 色板（按内容 hash）：缩略图时提取，老内容由后台回填；空数组不往外传
      const colors = db.getItemColors(detail.fileHash)
      const palette = parsePaletteJson(colors?.palette)
      return palette.length > 0 ? { ...detail, palette } : detail
    },

    getThumbnail: async (photoId: number) => {
      const photo = db.getPhoto(photoId)
      if (!photo?.fileHash) return null
      return indexer.getThumbnailPath(photo.fileHash)
    },

    getPhotoLocations: async (photoId: number) => {
      const photo = db.getPhoto(photoId)
      if (!photo?.fileHash) return []
      return db.getPhotoLocations(photo.fileHash)
    },

    setFavorite: async (fileHashes: string[], on: boolean) => {
      db.setFavorite(strings(fileHashes), !!on)
      return !!on
    },

    updateCaption: async (photoId: number, text: string) => {
      try {
        const photo = db.getPhoto(photoId)
        if (!photo?.fileHash) return { success: false, error: 'Photo not found' }
        db.saveCaption(photo.fileHash, text)
        return { success: true }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },

    // ─── 智能相册 ────────────────────────────────────────────
    getSmartAlbums: async () => db.getSmartAlbums(),

    createSmartAlbum: async (album: { name: string; query: string; filters: MediaFilters }) => {
      const created = db.createSmartAlbum({ name: String(album?.name ?? ''), query: String(album?.query ?? ''), filters: album?.filters ?? {} })
      events.emit('smart-albums-changed')
      return created
    },

    updateSmartAlbum: async (id: number, patch: { name?: string; query?: string; filters?: MediaFilters }) => {
      const updated = db.updateSmartAlbum(id, patch ?? {})
      events.emit('smart-albums-changed')
      return updated ?? null
    },

    deleteSmartAlbum: async (id: number) => {
      db.deleteSmartAlbum(id)
      events.emit('smart-albums-changed')
    },

    reorderSmartAlbums: async (ids: number[]) => {
      db.reorderSmartAlbums(Array.isArray(ids) ? ids.filter((x) => typeof x === 'number') : [])
      events.emit('smart-albums-changed')
    },

    // ─── 系统 / 模型 ─────────────────────────────────────────
    getAppPath: async () => dataDir,

    getModelStatus: async () => {
      const embeddingService = getEmbeddingService()
      return {
        modelsDir,
        localModelExists: isLiteRtInstalled(),
        embeddingReady: embeddingService.isReady(),
        activeBackend: embeddingService.getActiveBackend(),
        backend: embeddingService.getConfig().backend ?? 'auto',
        initError: embeddingService.getInitError(),
        cpuUnsupported: semanticCpuUnsupported(),
      }
    },

    getEmbeddingConfig: async () => ({ backend: getEmbeddingService().getConfig().backend ?? 'auto' }),

    // 改后端会丢弃已加载的 provider，下次 encode 时重新加载。CPU / GPU 后端向量一致，不用重建索引。
    setEmbeddingConfig: async (patch: EmbeddingConfig) => {
      try {
        const svc = getEmbeddingService()
        svc.setConfig(patch)
        await svc.init()
        return { success: true, ready: svc.isReady() }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },

    // ─── OCR / 人脸 ──────────────────────────────────────────
    startOcrScan: async () => {
      try {
        return await indexer.startOcrScan()
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },

    startFaceScan: async () => {
      try {
        return await indexer.startFaceScan()
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },

    getPeople: async () => db.getPeople(),

    getPersonPhotos: async (personId: number, limit?: number) => {
      const photos = db.getPersonPhotos(personId, limit || 50)
      return photos.map((p) => ({ photo: p, score: 1.0 }))
    },

    setPersonName: async (personId: number, name: string) => {
      db.updatePersonName(personId, name)
      return { success: true }
    },

    mergePeople: async (targetId: number, sourceIds: number[]) => {
      db.mergePeople(targetId, sourceIds)
      return { success: true }
    },

    getPersonSuggestions: async (): Promise<PersonSuggestion[]> => {
      const people = new Map(db.getPeople().filter((p) => !p.hidden).map((p) => [p.id, p]))
      const centroids = db.getPersonCentroids().filter((c) => people.has(c.id))
      return suggestMerges(centroids, db.getDismissedPairs(), 10).map((s) => ({
        a: people.get(s.a)!, b: people.get(s.b)!, similarity: s.similarity,
      }))
    },

    dismissPersonSuggestion: async (a: number, b: number) => {
      db.dismissPersonPair(a, b)
      return { success: true }
    },

    getPersonFaces: async (personId: number, limit?: number): Promise<PersonFace[]> => {
      return db.getPersonFaces(personId, limit).map((f) => ({ id: f.id, quality: f.quality, assignedBy: f.assignedBy as PersonFace['assignedBy'] }))
    },

    rejectFace: async (faceId: number) => {
      db.rejectFaceFromPerson(faceId)
      return { success: true }
    },

    assignFace: async (faceId: number, personId: number) => {
      db.assignFaceManually(faceId, personId)
      return { success: true }
    },

    setPersonHidden: async (personId: number, hidden: boolean) => {
      db.setPersonHidden(personId, hidden)
      return { success: true }
    },

    getPhotoFaces: async (photoId: number) => {
      const photo = db.getPhoto(photoId)
      if (!photo?.fileHash) return []
      return db.getFacesByHash(photo.fileHash)
    },

    // ─── 备份 ────────────────────────────────────────────────
    triggerBackup: async () => {
      try {
        const result = await backup.run()
        return { success: true, ...result }
      } catch (error) {
        return { success: false, error: String(error) }
      }
    },

    getBackupStatus: async () => backup.status(),

    // ─── 标签（按内容 hash）──────────────────────────────────
    tags: {
      list: async () => tagStore.list(),
      forHashes: async (hashes: string[]) => tagStore.forHashes(strings(hashes)),
      add: async (hashes: string[], name: string) => {
        if (typeof name !== 'string' || !name.trim()) return null
        const id = tagStore.add(strings(hashes), name)
        events.emit('tags-changed')
        return id
      },
      remove: async (hashes: string[], tagId: number) => {
        if (typeof tagId !== 'number') return
        tagStore.remove(strings(hashes), tagId)
        events.emit('tags-changed')
      },
      // 自动标签的 ✓：变成用户标签
      confirmAuto: async (hashes: string[], tagId: number) => {
        if (typeof tagId !== 'number') return
        tagStore.confirmAuto(strings(hashes), tagId)
        events.emit('tags-changed')
      },
      rename: async (tagId: number, name: string) => {
        if (typeof tagId !== 'number' || typeof name !== 'string') return null
        const id = tagStore.rename(tagId, name)
        events.emit('tags-changed')
        return id
      },
    },

    // ─── 清理相似照片（近重复）────────────────────────────────
    cleanup: {
      scan: async () => {
        let last = 0
        return cleanupStore.scan((done, total) => {
          const now = Date.now()
          if (now - last < 200 && done < total) return
          last = now
          events.emit('cleanup-progress', { done, total } satisfies DupScanProgress)
        })
      },
      hide: async (hashes: string[]) => {
        cleanupStore.hide(strings(hashes))
        events.emit('library-changed')
      },
      unhide: async (hashes: string[]) => {
        cleanupStore.unhide(strings(hashes))
        events.emit('library-changed')
      },
      listHidden: async () => cleanupStore.listHidden(),
      dismiss: async (groupIds: string[]) => {
        cleanupStore.dismiss(strings(groupIds))
      },
    },

    // ─── 自动标签 ────────────────────────────────────────────
    autoTags: {
      status: async () => autoTags.status(),
      setEnabled: async (on: boolean) => autoTags.setEnabled(!!on),
      rerun: async () => autoTags.rerun(),
    },

    // ─── 收集箱（服务器只有只读的来源查询；导入 / 扩展是桌面专属）──
    collect: {
      getSource: async (fileHash: string) => (typeof fileHash === 'string' ? collectStore.getSource(fileHash) : null),
    },
  }
}

/** 目录能否列出（R + X）；读不了返回 false。按调用即时判断，权限改好后刷新即恢复 */
export function folderReadable(path: string): boolean {
  try {
    accessSync(path, fsConstants.R_OK | fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export function createServices(ctx: ServiceContext): VixelServices {
  const tagStore = new TagStore(ctx.db.raw)
  const cleanupStore = new CleanupStore(ctx.db.raw)
  const collectStore = new CollectStore(ctx.db.raw)
  const backup = new BackupService(ctx.db, ctx.dataDir)
  const autoTags = createAutoTagService(ctx.db, ctx.events, () => ctx.events.emit('tags-changed'))
  const media = createMediaResolvers(ctx.db, ctx.indexer, ctx.dataDir)
  const api = buildApi(ctx, { tagStore, cleanupStore, collectStore, backup, autoTags })
  return {
    api,
    events: ctx.events,
    tagStore,
    cleanupStore,
    collectStore,
    backup,
    autoTags,
    media,
    loadTheme: () => {
      const v = ctx.db.getMetaState(META_KEY_THEME)
      return v === 'light' || v === 'dark' ? v : 'system'
    },
    loadLocaleSetting: () => {
      const v = ctx.db.getMetaState(META_KEY_LOCALE)
      return v === 'zh-CN' || v === 'en' ? v : 'system'
    },
  }
}

export type VixelApi = VixelServices['api']
