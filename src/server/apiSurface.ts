/**
 * 网页版 API 覆盖面的唯一清单：preload 的 `Api`（window.api）每个方法必须出现在
 * 下面四个列表之一，缺了谁 / 多了谁都会在类型层面报错（见 apiSurface.contract.test.ts），
 * HTTP 分发表与 IMPLEMENTED_METHODS 的一致性再由运行时测试锁住。
 *
 * 嵌套组（tags / cleanup / autoTags / collect / quickpanel）用点号展开：`tags.list`。
 */

/** 服务器实现（POST /api/<name>，JSON 参数数组 → JSON 返回值；由 services.api 扁平化生成分发表） */
export const IMPLEMENTED_METHODS = [
  'search',
  'findSimilar',
  'searchByImage',
  'getPhotosWithGPS',
  'addFolder',
  'removeFolder',
  'getFolders',
  'getLibraryCounts',
  'getFolderStats',
  'getSmartAlbums',
  'createSmartAlbum',
  'updateSmartAlbum',
  'deleteSmartAlbum',
  'reorderSmartAlbums',
  'getPhotoDetail',
  'getThumbnail',
  'getPhotoLocations',
  'setFavorite',
  'getLocaleSetting',
  'setLocaleSetting',
  'getTheme',
  'setTheme',
  'getIndexPaused',
  'setIndexPaused',
  'getIndexOnBattery',
  'setIndexOnBattery',
  'getSkippedFolders',
  'setSkippedFolderOverride',
  'getTaskOverview',
  'retryFailedTasks',
  'clearFailedTasks',
  'getMediaDetail',
  'getAppPath',
  'getModelStatus',
  'getEmbeddingConfig',
  'setEmbeddingConfig',
  'updateCaption',
  'startOcrScan',
  'triggerBackup',
  'getBackupStatus',
  'startFaceScan',
  'getPeople',
  'getPersonPhotos',
  'setPersonName',
  'mergePeople',
  'getPhotoFaces',
  'getPersonSuggestions',
  'dismissPersonSuggestion',
  'getPersonFaces',
  'rejectFace',
  'assignFace',
  'setPersonHidden',
  'tags.list',
  'tags.forHashes',
  'tags.add',
  'tags.remove',
  'tags.confirmAuto',
  'tags.rename',
  'cleanup.scan',
  'cleanup.hide',
  'cleanup.unhide',
  'cleanup.listHidden',
  'cleanup.dismiss',
  'autoTags.status',
  'autoTags.setEnabled',
  'autoTags.rerun',
  'collect.getSource',
] as const

/**
 * 桌面专属：依赖原生对话框 / 菜单 / shell / 全局快捷键 / 托盘 / 文件剪贴板 / 本地路径拖放 /
 * 浏览器扩展本地服务 / 移到废纸篓。服务器对这些返回明确错误（HTTP 501 desktop-only），
 * 网页前端（阶段 2）隐藏或降级为"下载"。
 */
export const DESKTOP_ONLY_METHODS = [
  'getPathForFile',          // webUtils.getPathForFile（渲染进程里的本地 File 对象）
  'voice.status',            // 语音搜索输入：macOS 系统级离线听写（服务器 / 网页没有离线引擎，见 src/main/voice.ts）
  'voice.requestMic',
  'voice.transcribe',
  'selectFolder',            // 原生目录选择对话框
  'openSettings',            // 设置是独立窗口；网页版是路由
  'showItemMenu',            // 原生右键菜单
  'showSmartAlbumMenu',      // 原生右键菜单
  'showInFinder',            // 在访达 / 资源管理器中显示
  'openSourceVideo',         // 系统默认播放器
  'quickpanel.getSettings',  // 快速搜索面板（全局快捷键 + 常驻窗口 + 托盘）
  'quickpanel.setEnabled',
  'quickpanel.setShortcut',
  'quickpanel.hide',
  'quickpanel.resize',
  'quickpanel.openResult',
  'quickpanel.openQuery',
  'quickpanel.openExternal',
  'quickpanel.copyFiles',    // 文件引用进系统剪贴板
  'quickpanel.previewFile',  // macOS Quick Look
  'quickpanel.startDrag',    // 原生文件拖放
  'quickpanel.getPending',
  'collect.getInbox',        // 收集箱导入（拖入 / 粘贴 / 浏览器扩展）整体是桌面专属（阶段 1 非目标）
  'collect.chooseInbox',
  'collect.openInbox',
  'collect.pathForFile',
  'collect.importPaths',
  'collect.importBytes',
  'collect.importUrl',
  'collect.undo',
  'collect.openSource',      // shell.openExternal
  'collect.serverStatus',    // 浏览器扩展的本地回环服务
  'collect.setServer',
  'collect.newToken',
  'cleanup.trash',           // shell.trashItem + 原生确认框；服务器上原文件以 :ro 挂载
  'tags.showMenu',           // 原生右键菜单
  'localApi.status',         // 本地接口（桌面在设置里开的那个 HTTP/MCP 服务）：服务器版本身就是这个服务
  'localApi.set',
  'localApi.newToken',
] as const

/**
 * 事件订阅（window.api.on*）：服务器经 WebSocket 推送，频道名见 services/events.ts。
 * 桌面专属事件（菜单命令 / 快速面板 / 收集完成）服务器上永远不会发。
 */
export const EVENT_METHODS = [
  'onLibraryChanged',        // ws channel: library-changed
  'onSmartAlbumsChanged',    // ws channel: smart-albums-changed
  'onIndexProgress',         // ws channel: index-progress
  'onPeopleChanged',         // ws channel: people-changed
  'tags.onChanged',          // ws channel: tags-changed
  'autoTags.onChanged',      // ws channel: autotags-changed
  'cleanup.onProgress',      // ws channel: cleanup-progress
  'onMenuCommand',           // 桌面专属（原生菜单），服务器不发
  'quickpanel.onShown',      // 桌面专属
  'quickpanel.onShowResult', // 桌面专属
  'quickpanel.onRunSearch',  // 桌面专属
  'collect.onCollected',     // 桌面专属
] as const

/** 非方法属性：当前语言（网页版登录后由 /api/getLocaleSetting 解析）、运行平台（desktop / web） */
export const SPECIAL_PROPS = ['locale', 'platform'] as const

export type ImplementedMethod = (typeof IMPLEMENTED_METHODS)[number]
export type DesktopOnlyMethod = (typeof DESKTOP_ONLY_METHODS)[number]

const implementedSet = new Set<string>(IMPLEMENTED_METHODS)
const desktopOnlySet = new Set<string>(DESKTOP_ONLY_METHODS)
export const isImplementedMethod = (name: string): name is ImplementedMethod => implementedSet.has(name)
export const isDesktopOnlyMethod = (name: string): name is DesktopOnlyMethod => desktopOnlySet.has(name)
