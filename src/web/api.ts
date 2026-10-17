/**
 * 网页版的 `window.api`：与 preload 完全同签名（`satisfies Api`，tsc 锁定），
 * renderer 一行不改就能跑在浏览器里。
 *
 *   - 普通方法        → POST /api/<name>，body {"args":[...]}（嵌套组同形：tags.list）
 *   - 以图搜图（字节）→ POST /api/searchByImage 原始字节上传（?limit&text&filters）
 *   - 事件订阅 on*    → 一条 WebSocket /events 按 channel 分发（断线指数退避重连）
 *   - 桌面专属        → 菜单 / 选择器类 resolve null（等价"未选择"），动作类 reject 并说明；
 *                       UI 已按 IS_WEB 隐藏，这里只是兜底
 *   - locale          → 构造时（登录后）由 getLocaleSetting + navigator.languages 解析，
 *                       必须在 renderer 模块求值之前完成（见 src/web/main.ts）
 *
 * 任何请求遇到 401 即跳转 /login（会话过期）。所有 POST 带 X-Vixel 头（服务器的 CSRF 要求）。
 */
import type { Api } from '../preload'
import type { ThemeMode, ImageQueryInput, ImageSearchResponse, MediaFilters, IndexProgress, MenuCommand, SearchResult } from '../shared/types'
import { resolveLocale, type Locale, type LocaleSetting } from '../shared/i18n'
import type { DupScanProgress } from '../shared/cleanup'
import type { CollectResult } from '../shared/collect'
import type { AutoTagStatus } from '../shared/autotags'

const POST_HEADERS = { 'content-type': 'application/json', 'x-vixel': '1' } as const

function gotoLogin(): Promise<never> {
  window.location.replace('/login')
  // 页面即将离开：挂起而不是 reject，免得每个调用点都闪一次错误
  return new Promise<never>(() => {})
}

async function handle<T>(method: string, res: Response): Promise<T> {
  if (res.status === 401) return gotoLogin()
  const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown; error?: string } | null
  if (!res.ok || !body?.ok) throw new Error(body?.error ?? `${method} failed (HTTP ${res.status})`)
  return body.result as T
}

/** 尾部 undefined 不发；中间的转 null（JSON 没有 undefined） */
function argsOf(...args: unknown[]): unknown[] {
  let end = args.length
  while (end > 0 && args[end - 1] === undefined) end--
  return args.slice(0, end).map((a) => (a === undefined ? null : a))
}

async function post<T>(method: string, args: unknown[] = []): Promise<T> {
  const res = await fetch(`/api/${method}`, { method: 'POST', headers: POST_HEADERS, body: JSON.stringify({ args }) })
  return handle<T>(method, res)
}

// ─── 事件（WebSocket /events）────────────────────────────────────────────────

type EventChannel =
  | 'library-changed' | 'smart-albums-changed' | 'index-progress' | 'people-changed'
  | 'tags-changed' | 'autotags-changed' | 'cleanup-progress'

const subs = new Map<EventChannel, Set<(payload: unknown) => void>>()
let wsStarted = false
let wsAttempt = 0

function startEvents(): void {
  if (wsStarted) return
  wsStarted = true
  const connect = (): void => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/events`)
    ws.onopen = () => { wsAttempt = 0 }
    ws.onmessage = (e) => {
      try {
        const { channel, payload } = JSON.parse(String(e.data)) as { channel: EventChannel; payload: unknown }
        subs.get(channel)?.forEach((fn) => { try { fn(payload) } catch (err) { console.warn('[events]', channel, err) } })
      } catch { /* 非 JSON 消息忽略 */ }
    }
    // 断线（服务器重启 / 网络抖动 / 会话过期）：指数退避重连，1s → 32s 封顶
    ws.onclose = () => { setTimeout(connect, Math.min(32_000, 1000 * 2 ** Math.min(wsAttempt++, 5))) }
  }
  connect()
}

function onChannel<T>(channel: EventChannel): (cb: (payload: T) => void) => () => void {
  return (cb) => {
    startEvents()
    let set = subs.get(channel)
    if (!set) subs.set(channel, (set = new Set()))
    const fn = cb as (payload: unknown) => void
    set.add(fn)
    return () => { set.delete(fn) }
  }
}

/** 桌面专属事件（原生菜单 / 快速面板 / 收集完成）：网页上永远不会发生 */
const noopEvent = (_cb?: unknown): (() => void) => () => {}

// ─── 桌面专属兜底 ────────────────────────────────────────────────────────────

/** 动作类桌面专属：reject 并说明（UI 已隐藏，走到这里是漏网） */
const desktopOnly = (method: string) => (): Promise<never> =>
  Promise.reject(new Error(`${method} is desktop-only and not available in the web edition`))

/** 菜单 / 选择器类桌面专属：resolve null ≙ "菜单关闭未选 / 用户取消"，调用方语义不破 */
const menuNoop = async (): Promise<null> => null

// ─── 主题（网页版没有 nativeTheme：data-theme 属性驱动 CSS 变量，见 globals.css）──

export function applyWebTheme(mode: ThemeMode): void {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode
  else delete document.documentElement.dataset.theme
}

// ─── 构造 ───────────────────────────────────────────────────────────────────

/**
 * 登录后调用：先取语言设置（401 → 跳转登录页）和外观，再组装出完整的 window.api。
 * renderer 的第一个 import（lib/localeInit.ts）同步读 api.locale，所以这里必须在
 * 应用模块求值之前 await 完成。
 */
export async function createWebApi(): Promise<Api> {
  const [localeSetting, theme] = await Promise.all([
    post<LocaleSetting>('getLocaleSetting'),
    post<ThemeMode>('getTheme'),
  ])
  applyWebTheme(theme)
  const locale: Locale = resolveLocale(localeSetting, navigator.languages)

  const api = {
    // 搜索
    search: (query: string, limit?: number, options?: { dateFrom?: string; dateTo?: string; kind?: import('../shared/types').MediaKind; folderId?: number }) =>
      post<SearchResult[]>('search', argsOf(query, limit, options)),
    findSimilar: (photoId: number, limit?: number) => post<SearchResult[]>('findSimilar', argsOf(photoId, limit)),
    searchByImage: async (input: ImageQueryInput, limit?: number, options?: MediaFilters): Promise<ImageSearchResponse> => {
      if (input.bytes) {
        // 原始字节上传（粘贴 / 拖入 / <input type=file>），参数走 query string
        const params = new URLSearchParams()
        if (limit != null) params.set('limit', String(limit))
        if (input.text) params.set('text', input.text)
        if (options && Object.keys(options).length > 0) params.set('filters', JSON.stringify(options))
        const qs = params.toString()
        const res = await fetch(`/api/searchByImage${qs ? `?${qs}` : ''}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', 'x-vixel': '1' },
          body: input.bytes as BodyInit,
        })
        return handle<ImageSearchResponse>('searchByImage', res)
      }
      if (input.fileHash) {
        return post<ImageSearchResponse>('searchByImage', argsOf({ fileHash: input.fileHash, text: input.text }, limit, options))
      }
      // path 指的是桌面的本地文件系统；浏览器拿不到本地路径（getPathForFile 恒返回 ''）
      return Promise.reject(new Error('searchByImage by local path is not available in the web edition'))
    },
    getPathForFile: (): string => '',
    getPhotosWithGPS: () => post<import('../shared/types').Photo[]>('getPhotosWithGPS'),

    // 文件夹管理（网页版只读展示：addFolder/removeFolder 服务器有实现，但 UI 不提供入口）
    selectFolder: menuNoop,
    addFolder: (path: string) => post<import('../shared/types').WatchedFolder>('addFolder', [path]),
    removeFolder: (id: number) => post<boolean>('removeFolder', [id]),
    getFolders: () => post<import('../shared/types').WatchedFolder[]>('getFolders'),
    getLibraryCounts: () => post<import('../shared/types').LibraryCounts>('getLibraryCounts'),
    /** 网页版设置是路由（#settings），不开新窗口 */
    openSettings: async (): Promise<void> => { window.location.hash = '#settings' },
    onLibraryChanged: onChannel<void>('library-changed'),
    onMenuCommand: noopEvent as (cb: (cmd: MenuCommand) => void) => () => void,
    showItemMenu: menuNoop,
    setFavorite: (fileHashes: string[], on: boolean) => post<boolean>('setFavorite', [fileHashes, on]),

    // 智能相册
    getSmartAlbums: () => post<import('../shared/types').SmartAlbum[]>('getSmartAlbums'),
    createSmartAlbum: (album: { name: string; query: string; filters: MediaFilters }) =>
      post<import('../shared/types').SmartAlbum>('createSmartAlbum', [album]),
    updateSmartAlbum: (id: number, patch: { name?: string; query?: string; filters?: MediaFilters }) =>
      post<import('../shared/types').SmartAlbum | null>('updateSmartAlbum', [id, patch]),
    deleteSmartAlbum: (id: number) => post<void>('deleteSmartAlbum', [id]),
    reorderSmartAlbums: (ids: number[]) => post<void>('reorderSmartAlbums', [ids]),
    showSmartAlbumMenu: menuNoop,
    onSmartAlbumsChanged: onChannel<void>('smart-albums-changed'),
    getFolderStats: (id: number) => post<{ photoCount: number; photoIds: number[] }>('getFolderStats', [id]),

    // 照片
    getPhotoDetail: (id: number) => post<import('../shared/types').PhotoDetail>('getPhotoDetail', [id]),
    getThumbnail: (id: number) => post<string>('getThumbnail', [id]),
    showInFinder: desktopOnly('showInFinder'),
    getPhotoLocations: (photoId: number) => post<import('../shared/types').PhotoLocation[]>('getPhotoLocations', [photoId]),

    // 进度
    onIndexProgress: onChannel<IndexProgress>('index-progress'),

    locale,
    platform: 'web' as const,
    getLocaleSetting: () => post<LocaleSetting>('getLocaleSetting'),
    /** 保存后整页刷新（桌面版主进程 reload 所有窗口，这里等价） */
    setLocaleSetting: async (setting: LocaleSetting): Promise<LocaleSetting> => {
      const saved = await post<LocaleSetting>('setLocaleSetting', [setting])
      window.location.reload()
      return saved
    },

    getTheme: () => post<ThemeMode>('getTheme'),
    setTheme: async (mode: ThemeMode): Promise<ThemeMode> => {
      const saved = await post<ThemeMode>('setTheme', [mode])
      applyWebTheme(saved)
      return saved
    },

    getIndexPaused: () => post<boolean>('getIndexPaused'),
    setIndexPaused: (paused: boolean) => post<boolean>('setIndexPaused', [paused]),
    getIndexOnBattery: () => post<boolean>('getIndexOnBattery'),
    setIndexOnBattery: (on: boolean) => post<boolean>('setIndexOnBattery', [on]),
    getSkippedFolders: (folderId?: number) => post<import('../shared/types').SkippedFolder[]>('getSkippedFolders', argsOf(folderId)),
    setSkippedFolderOverride: (path: string, override: boolean) => post<boolean>('setSkippedFolderOverride', [path, override]),
    getTaskOverview: () => post<import('../shared/types').TaskOverview>('getTaskOverview'),
    retryFailedTasks: (ids?: number[]) => post<number>('retryFailedTasks', argsOf(ids)),
    clearFailedTasks: () => post<number>('clearFailedTasks'),
    getMediaDetail: (videoId: number) => post<import('../shared/types').MediaDetail | null>('getMediaDetail', [videoId]),

    // 系统 / 模型状态
    getAppPath: () => post<string>('getAppPath'),
    getModelStatus: () => post<import('../shared/types').ModelStatus>('getModelStatus'),
    getEmbeddingConfig: () => post<import('../shared/types').EmbeddingConfig>('getEmbeddingConfig'),
    setEmbeddingConfig: (config: import('../shared/types').EmbeddingConfig) =>
      post<{ success: boolean; ready?: boolean; error?: string }>('setEmbeddingConfig', [config]),

    updateCaption: (photoId: number, text: string) => post<{ success: boolean; error?: string }>('updateCaption', [photoId, text]),
    startOcrScan: () => post<{ queued?: number; error?: string }>('startOcrScan'),
    openSourceVideo: desktopOnly('openSourceVideo'),
    triggerBackup: () => post<{ success: boolean; path?: string; sizeBytes?: number; error?: string }>('triggerBackup'),
    getBackupStatus: () => post<import('../shared/types').BackupStatus>('getBackupStatus'),

    // 人脸识别
    startFaceScan: () => post<{ queued?: number; error?: string }>('startFaceScan'),
    getPeople: () => post<import('../shared/types').Person[]>('getPeople'),
    getPersonPhotos: (personId: number, limit?: number) => post<SearchResult[]>('getPersonPhotos', argsOf(personId, limit)),
    setPersonName: (personId: number, name: string) => post<{ success: boolean }>('setPersonName', [personId, name]),
    mergePeople: (targetId: number, sourceIds: number[]) => post<{ success: boolean }>('mergePeople', [targetId, sourceIds]),
    getPhotoFaces: (photoId: number) => post<import('../shared/types').FaceRecord[]>('getPhotoFaces', [photoId]),
    getPersonSuggestions: () => post<import('../shared/types').PersonSuggestion[]>('getPersonSuggestions'),
    dismissPersonSuggestion: (a: number, b: number) => post<{ success: boolean }>('dismissPersonSuggestion', [a, b]),
    getPersonFaces: (personId: number, limit?: number) => post<import('../shared/types').PersonFace[]>('getPersonFaces', argsOf(personId, limit)),
    rejectFace: (faceId: number) => post<{ success: boolean }>('rejectFace', [faceId]),
    assignFace: (faceId: number, personId: number) => post<{ success: boolean }>('assignFace', [faceId, personId]),
    setPersonHidden: (personId: number, hidden: boolean) => post<{ success: boolean }>('setPersonHidden', [personId, hidden]),
    onPeopleChanged: onChannel<void>('people-changed'),

    // 快速搜索面板：整体桌面专属（全局快捷键 + 常驻窗口 + 托盘）
    quickpanel: {
      getSettings: desktopOnly('quickpanel.getSettings'),
      setEnabled: desktopOnly('quickpanel.setEnabled'),
      setShortcut: desktopOnly('quickpanel.setShortcut'),
      hide: desktopOnly('quickpanel.hide'),
      resize: desktopOnly('quickpanel.resize'),
      openResult: desktopOnly('quickpanel.openResult'),
      openQuery: desktopOnly('quickpanel.openQuery'),
      openExternal: desktopOnly('quickpanel.openExternal'),
      copyFiles: desktopOnly('quickpanel.copyFiles'),
      previewFile: desktopOnly('quickpanel.previewFile'),
      startDrag: (): void => {},
      getPending: menuNoop,
      onShown: noopEvent,
      onShowResult: noopEvent as (cb: (r: SearchResult) => void) => () => void,
      onRunSearch: noopEvent as (cb: (q: string) => void) => () => void,
    },

    // 收集箱：拖入 / 粘贴 / 浏览器扩展整体桌面专属（阶段 1 非目标）；来源信息是库数据，可读
    collect: {
      getInbox: desktopOnly('collect.getInbox'),
      chooseInbox: desktopOnly('collect.chooseInbox'),
      openInbox: desktopOnly('collect.openInbox'),
      pathForFile: (): string => '',
      importPaths: desktopOnly('collect.importPaths'),
      importBytes: desktopOnly('collect.importBytes'),
      importUrl: desktopOnly('collect.importUrl'),
      undo: desktopOnly('collect.undo'),
      getSource: (fileHash: string) => post<import('../shared/collect').ItemSource | null>('collect.getSource', [fileHash]),
      openSource: desktopOnly('collect.openSource'),
      serverStatus: desktopOnly('collect.serverStatus'),
      setServer: desktopOnly('collect.setServer'),
      newToken: desktopOnly('collect.newToken'),
      onCollected: noopEvent as (cb: (r: CollectResult) => void) => () => void,
    },

    // 本地接口：桌面在设置里开的 HTTP/MCP 服务 —— 网页版本身就跑在这个服务上，没有可配置的
    localApi: {
      status: desktopOnly('localApi.status'),
      set: desktopOnly('localApi.set'),
      newToken: desktopOnly('localApi.newToken'),
    },

    // 清理相似照片（trash 除外：原文件在服务器上建议只读挂载）
    cleanup: {
      scan: () => post<import('../shared/cleanup').DupScanResult>('cleanup.scan'),
      onProgress: onChannel<DupScanProgress>('cleanup-progress'),
      hide: (hashes: string[]) => post<void>('cleanup.hide', [hashes]),
      unhide: (hashes: string[]) => post<void>('cleanup.unhide', [hashes]),
      listHidden: () => post<import('../shared/cleanup').HiddenItem[]>('cleanup.listHidden'),
      dismiss: (groupIds: string[]) => post<void>('cleanup.dismiss', [groupIds]),
      trash: desktopOnly('cleanup.trash'),
    },

    // 自动标签
    autoTags: {
      status: () => post<AutoTagStatus>('autoTags.status'),
      setEnabled: (on: boolean) => post<AutoTagStatus>('autoTags.setEnabled', [on]),
      rerun: () => post<AutoTagStatus>('autoTags.rerun'),
      onChanged: onChannel<AutoTagStatus>('autotags-changed'),
    },

    // 标签
    tags: {
      list: () => post<import('../shared/tags').Tag[]>('tags.list'),
      forHashes: (hashes: string[]) => post<import('../shared/tags').TagsForSelection>('tags.forHashes', [hashes]),
      add: (hashes: string[], name: string) => post<number | null>('tags.add', [hashes, name]),
      remove: (hashes: string[], tagId: number) => post<void>('tags.remove', [hashes, tagId]),
      confirmAuto: (hashes: string[], tagId: number) => post<void>('tags.confirmAuto', [hashes, tagId]),
      rename: (tagId: number, name: string) => post<number | null>('tags.rename', [tagId, name]),
      showMenu: menuNoop,
      onChanged: onChannel<void>('tags-changed'),
    },
  } satisfies Api

  return api
}

/** 退出登录：清会话 cookie 后回登录页（设置页的"退出登录"用） */
export async function webLogout(): Promise<void> {
  try {
    await fetch('/api/logout', { method: 'POST', headers: POST_HEADERS, body: '{}' })
  } catch { /* 网络错误也照样回登录页 */ }
  window.location.replace('/login')
}
