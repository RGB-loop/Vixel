import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC_CHANNELS, type MediaFilters, type SmartAlbum, type SmartAlbumMenuAction, type SearchResult, type WatchedFolder, type PhotoDetail, type PhotoLocation, type IndexProgress, type ModelStatus, type EmbeddingConfig, type Person, type FaceRecord, type BackupStatus, type MediaKind, type TaskOverview, type MediaDetail, type LibraryCounts, type MenuCommand, type ItemMenuAction, type ThemeMode, type PersonSuggestion, type PersonFace, type ImageQueryInput, type ImageSearchResponse, type SkippedFolder, type VoiceStatus, type VoiceTranscribeResult } from '../shared/types'
import type { Locale, LocaleSetting } from '../shared/i18n'
import { CLEANUP_CHANNELS, type DupScanResult, type DupScanProgress, type HiddenItem, type TrashResult } from '../shared/cleanup'
import { COLLECT_CHANNELS, type CollectResult, type CollectServerStatus, type InboxInfo, type ItemSource } from '../shared/collect'
import { TAG_CHANNELS, type Tag, type TagMenuAction, type TagsForSelection } from '../shared/tags'
import { AUTOTAG_CHANNELS, type AutoTagStatus } from '../shared/autotags'
import { QUICKPANEL_CHANNELS, type QuickPanelSettings } from '../shared/quickpanel'
import { LOCALAPI_CHANNELS, type LocalApiPatch, type LocalApiStatus } from '../shared/localapi'

/** 面板 ↩ / ⌘O 时主窗口还没加载完的暂存动作（App 挂载后拉取） */
export type QuickPanelPendingAction = { type: 'result'; result: SearchResult } | { type: 'query'; query: string }

const api = {
  // 搜索
  search: (query: string, limit?: number, options?: { dateFrom?: string; dateTo?: string; kind?: MediaKind; folderId?: number }): Promise<SearchResult[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SEARCH, query, limit, options)
  },
  findSimilar: (photoId: number, limit?: number): Promise<SearchResult[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.FIND_SIMILAR, photoId, limit)
  },
  /** 以图搜图：路径（Finder 拖入）/ 字节（粘贴、浏览器拖入）/ 库内 hash（右键"以此图搜索"）三选一 */
  searchByImage: (input: ImageQueryInput, limit?: number, options?: MediaFilters): Promise<ImageSearchResponse> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SEARCH_BY_IMAGE, input, limit, options)
  },
  /** 拖入的 File 对应的本地路径；浏览器拖来的没有路径时返回空串（改传字节） */
  getPathForFile: (file: File): string => {
    try { return webUtils.getPathForFile(file) } catch { return '' }
  },

  // 语音搜索输入（macOS 系统级离线听写；其它平台 status.available 恒为 false，界面隐藏麦克风）
  voice: {
    status: (): Promise<VoiceStatus> => ipcRenderer.invoke(IPC_CHANNELS.VOICE_STATUS),
    /** 第一次录音前请求系统麦克风权限（弹一次系统窗；被拒过返回 false） */
    requestMic: (): Promise<boolean> => ipcRenderer.invoke(IPC_CHANNELS.VOICE_REQUEST_MIC),
    /** wav：渲染进程录好的 16 kHz mono 16-bit WAV 字节；录音只在本机转写，用完即删 */
    transcribe: (wav: Uint8Array): Promise<VoiceTranscribeResult> => ipcRenderer.invoke(IPC_CHANNELS.VOICE_TRANSCRIBE, wav),
  },
  getPhotosWithGPS: (): Promise<import('../shared/types').Photo[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PHOTOS_WITH_GPS)
  },

  // 文件夹管理
  selectFolder: (): Promise<string | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SELECT_FOLDER)
  },
  addFolder: (path: string): Promise<WatchedFolder> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ADD_FOLDER, path)
  },
  removeFolder: (id: number): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.REMOVE_FOLDER, id)
  },
  getFolders: (): Promise<WatchedFolder[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_FOLDERS)
  },
  getLibraryCounts: (): Promise<LibraryCounts> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_LIBRARY_COUNTS)
  },
  /** 原生菜单命令（快捷键都挂在菜单上） */
  openSettings: (): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OPEN_SETTINGS)
  },
  /** 文件夹增删（任意窗口发起）后主进程广播 */
  onLibraryChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(IPC_CHANNELS.LIBRARY_CHANGED, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.LIBRARY_CHANGED, handler)
    }
  },
  onMenuCommand: (callback: (cmd: MenuCommand) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, cmd: MenuCommand): void => callback(cmd)
    ipcRenderer.on(IPC_CHANNELS.MENU_COMMAND, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.MENU_COMMAND, handler)
    }
  },
  /** 弹出原生右键菜单，resolve 为选中的动作；菜单关闭未选则为 null */
  showItemMenu: (opts: { count: number; isMedia: boolean; favorite: boolean; canImageSearch: boolean }): Promise<ItemMenuAction | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SHOW_ITEM_MENU, opts)
  },
  /** 收藏 / 取消收藏（按内容 hash，同内容的副本一起变） */
  setFavorite: (fileHashes: string[], on: boolean): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SET_FAVORITE, fileHashes, on)
  },
  // 智能相册
  getSmartAlbums: (): Promise<SmartAlbum[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_SMART_ALBUMS)
  },
  createSmartAlbum: (album: { name: string; query: string; filters: MediaFilters }): Promise<SmartAlbum> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CREATE_SMART_ALBUM, album)
  },
  updateSmartAlbum: (id: number, patch: { name?: string; query?: string; filters?: MediaFilters }): Promise<SmartAlbum | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UPDATE_SMART_ALBUM, id, patch)
  },
  deleteSmartAlbum: (id: number): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DELETE_SMART_ALBUM, id)
  },
  reorderSmartAlbums: (ids: number[]): Promise<void> => {
    return ipcRenderer.invoke(IPC_CHANNELS.REORDER_SMART_ALBUMS, ids)
  },
  /** 右键菜单；选"删除"时主进程已确认过 */
  showSmartAlbumMenu: (name: string): Promise<SmartAlbumMenuAction | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SHOW_SMART_ALBUM_MENU, name)
  },
  onSmartAlbumsChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(IPC_CHANNELS.SMART_ALBUMS_CHANGED, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.SMART_ALBUMS_CHANGED, handler)
    }
  },
  getFolderStats: (id: number): Promise<{ photoCount: number; photoIds: number[] }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_FOLDER_STATS, id)
  },

  // 照片
  getPhotoDetail: (id: number): Promise<PhotoDetail> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PHOTO_DETAIL, id)
  },
  getThumbnail: (id: number): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_THUMBNAIL, id)
  },
  showInFinder: (filePath: string): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SHOW_IN_FINDER, filePath)
  },
  getPhotoLocations: (photoId: number): Promise<PhotoLocation[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PHOTO_LOCATIONS, photoId)
  },

  // 进度
  onIndexProgress: (callback: (progress: IndexProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: IndexProgress): void => {
      callback(progress)
    }
    ipcRenderer.on(IPC_CHANNELS.INDEX_PROGRESS, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.INDEX_PROGRESS, handler)
    }
  },

  /** 当前界面语言（已按设置 / 系统解析），渲染前同步取 */
  locale: ipcRenderer.sendSync(IPC_CHANNELS.GET_LOCALE_SYNC) as Locale,
  /** 运行平台：桌面（Electron + IPC）或网页（服务器版，src/web/api.ts 注入同签名实现） */
  platform: 'desktop' as 'desktop' | 'web',
  getLocaleSetting: (): Promise<LocaleSetting> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_LOCALE_SETTING)
  },
  /** 保存后主进程会 reload 所有窗口 */
  setLocaleSetting: (setting: LocaleSetting): Promise<LocaleSetting> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SET_LOCALE_SETTING, setting)
  },

  getTheme: (): Promise<ThemeMode> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_THEME)
  },
  setTheme: (mode: ThemeMode): Promise<ThemeMode> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SET_THEME, mode)
  },

  getIndexPaused: (): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_INDEX_PAUSED)
  },
  setIndexPaused: (paused: boolean): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SET_INDEX_PAUSED, paused)
  },
  /** 设置："电池供电时也索引"（默认开；关掉后电池供电时大批量索引等待，少量新文件照常） */
  getIndexOnBattery: (): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_INDEX_ON_BATTERY)
  },
  setIndexOnBattery: (on: boolean): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SET_INDEX_ON_BATTERY, on)
  },
  /** 被跳过的"疑似数据集"目录（设置 › 文件夹）；传 folderId 只取该文件夹下的 */
  getSkippedFolders: (folderId?: number): Promise<SkippedFolder[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_SKIPPED_FOLDERS, folderId)
  },
  /** "仍然索引"某个被跳过的目录（override=true 会触发整夹重扫） */
  setSkippedFolderOverride: (path: string, override: boolean): Promise<boolean> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SET_SKIPPED_FOLDER_OVERRIDE, path, override)
  },
  getTaskOverview: (): Promise<TaskOverview> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_TASK_OVERVIEW)
  },
  retryFailedTasks: (ids?: number[]): Promise<number> => {
    return ipcRenderer.invoke(IPC_CHANNELS.RETRY_FAILED_TASKS, ids)
  },
  clearFailedTasks: (): Promise<number> => {
    return ipcRenderer.invoke(IPC_CHANNELS.CLEAR_FAILED_TASKS)
  },
  getMediaDetail: (videoId: number): Promise<MediaDetail | null> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_MEDIA_DETAIL, videoId)
  },

  // 系统 / 模型状态
  getAppPath: (): Promise<string> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_APP_PATH)
  },
  getModelStatus: (): Promise<ModelStatus> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_MODEL_STATUS)
  },

  // Embedding 配置（EmbeddingGemma 2 量化档位 / 推理设备）
  getEmbeddingConfig: (): Promise<EmbeddingConfig> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_EMBEDDING_CONFIG)
  },
  /** 改量化档位；provider 会在下次 encode 时按新档位重新加载 */
  setEmbeddingConfig: (config: EmbeddingConfig): Promise<{ success: boolean; ready?: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SET_EMBEDDING_CONFIG, config)
  },

  // Caption（手动编辑）
  updateCaption: (photoId: number, text: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CAPTION, photoId, text)
  },

  // OCR
  startOcrScan: (): Promise<{ queued?: number; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.START_OCR_SCAN)
  },

  // 打开视频源
  openSourceVideo: (videoId: number): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.OPEN_SOURCE_VIDEO, videoId)
  },

  // 备份
  triggerBackup: (): Promise<{ success: boolean; path?: string; sizeBytes?: number; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_BACKUP)
  },
  getBackupStatus: (): Promise<BackupStatus> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_BACKUP_STATUS)
  },

  // 人脸识别
  startFaceScan: (): Promise<{ queued?: number; error?: string }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.START_FACE_SCAN)
  },
  getPeople: (): Promise<Person[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PEOPLE)
  },
  getPersonPhotos: (personId: number, limit?: number): Promise<SearchResult[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PERSON_PHOTOS, personId, limit)
  },
  setPersonName: (personId: number, name: string): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SET_PERSON_NAME, personId, name)
  },
  mergePeople: (targetId: number, sourceIds: number[]): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.MERGE_PEOPLE, targetId, sourceIds)
  },
  getPhotoFaces: (photoId: number): Promise<FaceRecord[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PHOTO_FACES, photoId)
  },
  getPersonSuggestions: (): Promise<PersonSuggestion[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PERSON_SUGGESTIONS)
  },
  dismissPersonSuggestion: (a: number, b: number): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.DISMISS_PERSON_SUGGESTION, a, b)
  },
  getPersonFaces: (personId: number, limit?: number): Promise<PersonFace[]> => {
    return ipcRenderer.invoke(IPC_CHANNELS.GET_PERSON_FACES, personId, limit)
  },
  rejectFace: (faceId: number): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.REJECT_FACE, faceId)
  },
  assignFace: (faceId: number, personId: number): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.ASSIGN_FACE, faceId, personId)
  },
  setPersonHidden: (personId: number, hidden: boolean): Promise<{ success: boolean }> => {
    return ipcRenderer.invoke(IPC_CHANNELS.SET_PERSON_HIDDEN, personId, hidden)
  },
  onPeopleChanged: (callback: () => void): (() => void) => {
    const handler = (): void => callback()
    ipcRenderer.on(IPC_CHANNELS.PEOPLE_CHANGED, handler)
    return () => { ipcRenderer.removeListener(IPC_CHANNELS.PEOPLE_CHANGED, handler) }
  },

  // 快速搜索面板（全局快捷键呼出；设置页也用这里的 getSettings / setShortcut）
  quickpanel: {
    getSettings: (): Promise<QuickPanelSettings> => ipcRenderer.invoke(QUICKPANEL_CHANNELS.GET_SETTINGS),
    setEnabled: (on: boolean): Promise<QuickPanelSettings> => ipcRenderer.invoke(QUICKPANEL_CHANNELS.SET_ENABLED, on),
    /** 换快捷键：主进程真的注册一次验证；被占用 / 无效时不落库 */
    setShortcut: (acc: string): Promise<{ ok: boolean; reason?: 'invalid' | 'in-use'; settings: QuickPanelSettings }> =>
      ipcRenderer.invoke(QUICKPANEL_CHANNELS.SET_SHORTCUT, acc),
    hide: (): Promise<void> => ipcRenderer.invoke(QUICKPANEL_CHANNELS.HIDE),
    /** 面板窗口高度跟随内容（顶边不动） */
    resize: (height: number): Promise<void> => ipcRenderer.invoke(QUICKPANEL_CHANNELS.RESIZE, height),
    /** ↩：在主窗口打开这条结果（视频 / 音频会落到命中片段的详情） */
    openResult: (result: SearchResult): Promise<void> => ipcRenderer.invoke(QUICKPANEL_CHANNELS.OPEN_RESULT, result),
    /** ⌘O：把当前查询带去主窗口 */
    openQuery: (query: string): Promise<void> => ipcRenderer.invoke(QUICKPANEL_CHANNELS.OPEN_QUERY, query),
    /** ⌥↩：系统默认应用打开（主进程按 id 查库取路径，不信渲染端的路径） */
    openExternal: (photoId: number, videoId?: number | null): Promise<boolean> =>
      ipcRenderer.invoke(QUICKPANEL_CHANNELS.OPEN_EXTERNAL, photoId, videoId),
    /** ⌘C：文件引用进剪贴板；返回实际写入的形态（file = 可粘贴成文件，path = 退回路径文字） */
    copyFiles: (items: Array<{ photoId: number; videoId?: number | null }>): Promise<'file' | 'path' | null> =>
      ipcRenderer.invoke(QUICKPANEL_CHANNELS.COPY_FILES, items),
    /** Space：macOS 原生 Quick Look；返回 false 表示本平台没有（渲染端用内置 QuickLook） */
    previewFile: (photoId: number, videoId: number | null | undefined, displayName?: string): Promise<boolean> =>
      ipcRenderer.invoke(QUICKPANEL_CHANNELS.PREVIEW_FILE, photoId, videoId, displayName),
    /** 拖出面板：原生文件拖放（dragstart 里同步 send，不能用 invoke） */
    startDrag: (photoId: number, videoId?: number | null): void => {
      ipcRenderer.send(QUICKPANEL_CHANNELS.START_DRAG, photoId, videoId)
    },
    /** 主窗口挂载后拉取暂存动作（↩ 时主窗口可能是刚建的） */
    getPending: (): Promise<QuickPanelPendingAction | null> => ipcRenderer.invoke(QUICKPANEL_CHANNELS.GET_PENDING),
    /** 面板每次显示（聚焦输入框、全选上次查询） */
    onShown: (callback: () => void): (() => void) => {
      const handler = (): void => callback()
      ipcRenderer.on(QUICKPANEL_CHANNELS.SHOWN, handler)
      return () => { ipcRenderer.removeListener(QUICKPANEL_CHANNELS.SHOWN, handler) }
    },
    /** 主窗口：面板 ↩ 送来的结果 */
    onShowResult: (callback: (r: SearchResult) => void): (() => void) => {
      const handler = (_: unknown, r: SearchResult): void => callback(r)
      ipcRenderer.on(QUICKPANEL_CHANNELS.SHOW_RESULT, handler)
      return () => { ipcRenderer.removeListener(QUICKPANEL_CHANNELS.SHOW_RESULT, handler) }
    },
    /** 主窗口：面板 ⌘O 送来的查询 */
    onRunSearch: (callback: (q: string) => void): (() => void) => {
      const handler = (_: unknown, q: string): void => callback(q)
      ipcRenderer.on(QUICKPANEL_CHANNELS.RUN_SEARCH, handler)
      return () => { ipcRenderer.removeListener(QUICKPANEL_CHANNELS.RUN_SEARCH, handler) }
    },
  },

  // 收集箱：拖入 / 粘贴 / 浏览器扩展
  collect: {
    getInbox: (): Promise<InboxInfo> => ipcRenderer.invoke(COLLECT_CHANNELS.GET_INBOX),
    chooseInbox: (): Promise<InboxInfo> => ipcRenderer.invoke(COLLECT_CHANNELS.CHOOSE_INBOX),
    openInbox: (): Promise<void> => ipcRenderer.invoke(COLLECT_CHANNELS.OPEN_INBOX),
    /** 拖入的 File 对应的本地路径（Electron 32 起 File.path 没了，要走 webUtils）；不是本地文件时为 '' */
    pathForFile: (file: File): string => {
      try { return webUtils.getPathForFile(file) } catch { return '' }
    },
    importPaths: (paths: string[]): Promise<CollectResult> => ipcRenderer.invoke(COLLECT_CHANNELS.IMPORT_PATHS, paths),
    importBytes: (data: Uint8Array, name: string, via: 'paste' | 'drop'): Promise<CollectResult> => ipcRenderer.invoke(COLLECT_CHANNELS.IMPORT_BYTES, data, name, via),
    importUrl: (url: string, pageUrl?: string): Promise<CollectResult> => ipcRenderer.invoke(COLLECT_CHANNELS.IMPORT_URL, url, pageUrl),
    undo: (paths: string[]): Promise<number> => ipcRenderer.invoke(COLLECT_CHANNELS.UNDO, paths),
    getSource: (fileHash: string): Promise<ItemSource | null> => ipcRenderer.invoke(COLLECT_CHANNELS.GET_SOURCE, fileHash),
    openSource: (url: string): Promise<void> => ipcRenderer.invoke(COLLECT_CHANNELS.OPEN_SOURCE, url),
    serverStatus: (): Promise<CollectServerStatus> => ipcRenderer.invoke(COLLECT_CHANNELS.SERVER_STATUS),
    setServer: (patch: Partial<Pick<CollectServerStatus, 'enabled' | 'port' | 'extensionId'>>): Promise<CollectServerStatus> => ipcRenderer.invoke(COLLECT_CHANNELS.SERVER_SET, patch),
    newToken: (): Promise<CollectServerStatus> => ipcRenderer.invoke(COLLECT_CHANNELS.SERVER_NEW_TOKEN),
    onCollected: (callback: (r: CollectResult) => void): (() => void) => {
      const handler = (_: unknown, r: CollectResult): void => callback(r)
      ipcRenderer.on(COLLECT_CHANNELS.COLLECTED, handler)
      return () => { ipcRenderer.removeListener(COLLECT_CHANNELS.COLLECTED, handler) }
    },
  },

  // 本地接口（HTTP API + 网页界面 + /mcp；设置 › 通用，桌面专属）
  localApi: {
    status: (): Promise<LocalApiStatus> => ipcRenderer.invoke(LOCALAPI_CHANNELS.STATUS),
    set: (patch: LocalApiPatch): Promise<LocalApiStatus> => ipcRenderer.invoke(LOCALAPI_CHANNELS.SET, patch),
    /** 重新生成 /mcp 的 bearer 令牌（旧令牌立即失效） */
    newToken: (): Promise<LocalApiStatus> => ipcRenderer.invoke(LOCALAPI_CHANNELS.NEW_TOKEN),
  },

  // 清理相似照片（近重复）
  cleanup: {
    scan: (): Promise<DupScanResult> => ipcRenderer.invoke(CLEANUP_CHANNELS.SCAN),
    onProgress: (callback: (p: DupScanProgress) => void): (() => void) => {
      const handler = (_: unknown, p: DupScanProgress): void => callback(p)
      ipcRenderer.on(CLEANUP_CHANNELS.PROGRESS, handler)
      return () => { ipcRenderer.removeListener(CLEANUP_CHANNELS.PROGRESS, handler) }
    },
    hide: (hashes: string[]): Promise<void> => ipcRenderer.invoke(CLEANUP_CHANNELS.HIDE, hashes),
    unhide: (hashes: string[]): Promise<void> => ipcRenderer.invoke(CLEANUP_CHANNELS.UNHIDE, hashes),
    listHidden: (): Promise<HiddenItem[]> => ipcRenderer.invoke(CLEANUP_CHANNELS.LIST_HIDDEN),
    /** 记住"不是重复"：之后扫描不再列出这些组 */
    dismiss: (groupIds: string[]): Promise<void> => ipcRenderer.invoke(CLEANUP_CHANNELS.DISMISS, groupIds),
    /** 主进程会先弹原生确认框；用户取消时 cancelled = true */
    trash: (hashes: string[]): Promise<TrashResult> => ipcRenderer.invoke(CLEANUP_CHANNELS.TRASH, hashes),
  },

  // 自动标签（离线，按词表）
  autoTags: {
    status: (): Promise<AutoTagStatus> => ipcRenderer.invoke(AUTOTAG_CHANNELS.STATUS),
    setEnabled: (on: boolean): Promise<AutoTagStatus> => ipcRenderer.invoke(AUTOTAG_CHANNELS.SET_ENABLED, on),
    /** 清掉未确认的自动标签，全部重新判定 */
    rerun: (): Promise<AutoTagStatus> => ipcRenderer.invoke(AUTOTAG_CHANNELS.RERUN),
    onChanged: (callback: (s: AutoTagStatus) => void): (() => void) => {
      const handler = (_: unknown, s: AutoTagStatus): void => callback(s)
      ipcRenderer.on(AUTOTAG_CHANNELS.CHANGED, handler)
      return () => { ipcRenderer.removeListener(AUTOTAG_CHANNELS.CHANGED, handler) }
    },
  },

  // 标签（按内容 hash）
  tags: {
    list: (): Promise<Tag[]> => ipcRenderer.invoke(TAG_CHANNELS.LIST),
    forHashes: (hashes: string[]): Promise<TagsForSelection> => ipcRenderer.invoke(TAG_CHANNELS.FOR_HASHES, hashes),
    /** 名字不存在就新建；返回标签 id */
    add: (hashes: string[], name: string): Promise<number | null> => ipcRenderer.invoke(TAG_CHANNELS.ADD, hashes, name),
    remove: (hashes: string[], tagId: number): Promise<void> => ipcRenderer.invoke(TAG_CHANNELS.REMOVE, hashes, tagId),
    /** 自动标签的 ✓：变成用户标签 */
    confirmAuto: (hashes: string[], tagId: number): Promise<void> => ipcRenderer.invoke(TAG_CHANNELS.CONFIRM_AUTO, hashes, tagId),
    /** 和已有标签重名就合并过去；返回最终的标签 id */
    rename: (tagId: number, name: string): Promise<number | null> => ipcRenderer.invoke(TAG_CHANNELS.RENAME, tagId, name),
    /** 侧栏右键菜单：合并 / 删除在主进程执行完才返回；'rename' 由调用方进入行内编辑 */
    showMenu: (tagId: number): Promise<TagMenuAction | null> => ipcRenderer.invoke(TAG_CHANNELS.SHOW_MENU, tagId),
    onChanged: (callback: () => void): (() => void) => {
      const handler = (): void => callback()
      ipcRenderer.on(TAG_CHANNELS.CHANGED, handler)
      return () => { ipcRenderer.removeListener(TAG_CHANNELS.CHANGED, handler) }
    },
  },
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
