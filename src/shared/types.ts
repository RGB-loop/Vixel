// ============================================
// Shared Types - 主进程和渲染进程共用的类型定义
// ============================================

/** 'image' 是普通照片；'video' / 'audio' 的 Photo 是该媒体的代表图（首帧 / 封面 / 波形） */
export type MediaKind = 'image' | 'video' | 'audio'

/** 索引任务来源：'live'（watcher 实时事件 / 收集箱）在电源策略挡住回填时仍然放行 */
export type TaskOrigin = 'live' | 'backfill'

/** 回填等待的原因（电源策略，见 core/powerPolicy.ts）；和手动暂停分开展示 */
export type PowerWaitReason = 'battery' | 'low-power' | 'thermal'

/** 被跳过的"疑似数据集"目录（core/skipRules.ts；设置 › 文件夹 可"仍然索引"） */
export interface SkippedFolder {
  path: string
  folderId: number
  reason: string
  fileCount: number
  /** 用户点过"仍然索引" */
  override: boolean
  createdAt: string
}

/** 原生菜单发给渲染进程的命令；每个快捷键都挂在菜单上，渲染进程不自己监听 ⌘ 组合键 */
export type MenuCommand =
  | 'source:all' | 'source:image' | 'source:video' | 'source:audio' | 'source:map' | 'source:people'
  | 'find' | 'toggle-sidebar' | 'zoom-in' | 'zoom-out' | 'activity' | 'add-folder' | 'toggle-density'
  | 'toggle-inspector' | 'reveal' | 'quick-look' | 'open-item' | 'select-all' | 'toggle-favorite' | 'add-tag'
  | 'source:cleanup'

/** 网格右键菜单（原生 Menu.popup）里用户选中的动作 */
export type ItemMenuAction = 'open' | 'quick-look' | 'reveal' | 'copy-path' | 'copy-link' | 'copy-md-link' | 'copy-web-link' | 'copy-web-md' | 'search-by-image' | 'open-external' | 'toggle-favorite'

/** 画面方向：全景 = 长宽比 ≥ 2:1（横竖都算），方形 = 长短边相差 10% 以内 */
export type Orientation = 'landscape' | 'portrait' | 'square' | 'panorama'

/**
 * 浏览 / 搜索的过滤条件（无搜索词时走 SQL，有搜索词时对融合结果逐条过滤）。
 * 时长条件只对音视频有意义：设了就排除图片。
 */
export interface MediaFilters {
  dateFrom?: string
  dateTo?: string
  /** 只返回某种媒体；省略 = 全部 */
  kind?: MediaKind
  /** 只返回出现在该监视文件夹里的内容 */
  folderId?: number
  orientation?: Orientation
  /** 像素数下限 / 上限（宽 × 高） */
  minPixels?: number
  maxPixels?: number
  durationMin?: number
  durationMax?: number
  personId?: number
  favorite?: boolean
  /** 同时带有这些标签（AND） */
  tagIds?: number[]
  /** 色板里以足够占比出现该色桶（见 shared/colors.ts 的桶名与阈值） */
  color?: string
  /** 只看截图（photos.is_screenshot = 1，见 core/screenshot.ts） */
  screenshot?: boolean
}

/** 智能相册：保存下来的"查询 + 筛选"，打开时重新搜索，所以内容总是最新的 */
export interface SmartAlbum {
  id: number
  name: string
  /** 搜索词，可为空（纯筛选相册） */
  query: string
  /** 含日期、类型、文件夹在内的全部条件 */
  filters: MediaFilters
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type SmartAlbumMenuAction = 'rename' | 'update' | 'delete'

/** 资料库计数（侧边栏）；all = 三类之和 */
export type LibraryCounts = Record<MediaKind | 'all' | 'favorites', number>

export interface Photo {
  id: number
  folderId: number
  filePath: string
  fileName: string
  fileSize: number
  fileMtime: number
  fileHash: string
  width?: number
  height?: number
  takenAt?: string
  lat?: number
  lng?: number
  caption?: string
  embedStatus: 'pending' | 'done' | 'error'
  faceStatus?: 'pending' | 'done' | 'error'
  faceCount?: number
  duplicateCount?: number
  /** 若是视频抽出的帧：来源视频在 videos 表里的 id */
  videoId?: number | null
  /** 若是视频抽出的帧：该帧对应的视频时间戳（毫秒） */
  frameTimeMs?: number | null
  /** 设计格式（PDF / AI）：页数（解析得到时才有） */
  pages?: number | null
  /** 截图标记：1 = 截图，0 = 判过不是，null = 还没判（见 core/screenshot.ts） */
  isScreenshot?: number | null
  /** 媒体类型（LEFT JOIN videos 得出；部分旧查询不带此字段时按 image 处理） */
  mediaKind?: MediaKind
  /** 视频/音频时长（毫秒） */
  durationMs?: number | null
  /** 已收藏（按内容 hash；SQLite 返回 0 / 1，只做真假判断） */
  favorite?: boolean | number
  deletedAt?: string
  createdAt: string
  updatedAt: string
}

export interface VideoRecord {
  id: number
  folderId: number
  filePath: string
  fileName: string
  fileSize: number
  fileMtime: number
  fileHash: string
  durationMs?: number
  width?: number
  height?: number
  frameCount?: number
  mediaKind: 'video' | 'audio'
  deletedAt?: string
  createdAt: string
}

export interface PhotoLocation {
  filePath: string
  folderPath: string
  folderName: string
  folderId: number
}

export interface WatchedFolder {
  id: number
  path: string
  lastScanAt?: string
  recursive: boolean
  createdAt: string
  photoCount?: number // 该文件夹中的照片数量
  /** 收集箱（拖入 / 粘贴 / 浏览器扩展收来的内容存这里）；侧栏置顶显示 */
  isInbox?: boolean
  /** 当前进程读不了这个目录（权限不足 / 已卸载）；群晖上常见于容器身份不在共享文件夹的授权组里 */
  unreadable?: boolean
}

/** 命中通道：visual 图片向量 / segment 音视频片段向量 / text 图内文字 / filename 文件名或路径 */
export type MatchChannel = 'visual' | 'segment' | 'text' | 'filename' | 'tag'

export interface SearchResult {
  photo: Photo
  score: number
  /** 经片段通道命中的视频/音频：最佳片段的时间区间 */
  segment?: { startMs: number; endMs: number }
  /** 有搜索词时：这条结果是被哪些通道召回的（UI 用来解释"为什么命中"） */
  matchedBy?: MatchChannel[]
  /** 没有任何结果明显相关时给出的"最接近"结果：界面据此提示"没有明确匹配" */
  lowConfidence?: boolean
  /** 较弱的匹配：融合分不到最高分的一半。界面折叠到"较弱的匹配"下（lowConfidence 时不标，整组已说明） */
  weak?: boolean
  thumbnailPath?: string
}

/**
 * 以图搜图的查询：三选一 —— 本地文件路径（Finder 拖入）、图片字节（粘贴 / 浏览器拖入）、
 * 库内内容 hash（右键"以此图搜索"，直接用已存的向量，不再过模型）。text 一并给出时走多模态编码。
 */
export interface ImageQueryInput {
  path?: string
  bytes?: Uint8Array
  fileHash?: string
  text?: string
}

export interface ImageSearchResponse {
  results: SearchResult[]
  /** 查询图本身就在库里（同内容 hash），已从结果中排除 */
  queryInLibrary: boolean
  /** 查询图小缩略图（data URL），搜索框里的查询图芯片用；解码失败时没有 */
  queryThumb?: string
  /** 解码失败 / 模型未就绪：结果为空并说明原因 */
  error?: 'decode-failed' | 'model-not-ready'
}

/**
 * 语音输入（搜索框麦克风，macOS 桌面版）：能否离线转写。说"不可用"的原因：
 *   platform = 不是 macOS 26+（系统离线听写 API 不存在）
 *   helper   = 转写辅助程序缺失（打包 / 构建问题）
 *   asset    = 这个语言的系统语音模型还没下载（系统设置 → 键盘 → 听写）
 */
export interface VoiceStatus {
  available: boolean
  reason?: 'platform' | 'helper' | 'asset'
}

export interface VoiceTranscribeResult {
  text?: string
  /** asset-missing 单列：界面要给"去系统设置下载语音模型"的指引，而不是笼统的失败 */
  error?: 'unavailable' | 'asset-missing' | 'failed'
}

export interface CurrentTask {
  taskType: TaskType
  kind: MediaKind
  name: string
  /** 音视频：已完成片段数 / 总片段数；图片任务为 0/1 */
  segDone: number
  segTotal: number
  startedAt: number
  /** 最近一个片段耗时（ms），供前端估算剩余时间 */
  lastSegMs?: number
}

export interface MediaDetail {
  id: number
  kind: 'video' | 'audio'
  filePath: string
  fileName: string
  fileSize: number
  durationMs: number | null
  width: number | null
  height: number | null
  segments: Array<{ startMs: number; endMs: number }>
}

export interface TaskRow {
  id: number
  taskType: TaskType
  status: 'pending' | 'processing' | 'done' | 'error'
  name: string | null
  kind: MediaKind
  errorMsg: string | null
  retryCount: number
  createdAt: string
}

export interface TaskOverview {
  /** task_type → status → count */
  counts: Record<string, Partial<Record<TaskRow['status'], number>>>
  pending: TaskRow[]
  errors: TaskRow[]
  media: {
    video: { total: number; done: number }
    audio: { total: number; done: number }
    segmentsDone: number
    segmentsExpected: number
  }
  photos: { total: number; thumbnailed: number; indexed: number }
}

export interface IndexProgress {
  // 照片统计（基于实际照片数，不是任务数）
  totalPhotos: number           // 总照片数
  thumbnailedPhotos: number     // 已生成缩略图的照片数
  indexedPhotos: number         // 已完成 embedding 的照片数

  // 当前状态
  stage: 'idle' | 'indexing' | 'ocr' | 'detecting_faces'
  currentFile?: string
  // OCR 进度
  ocrPhotos?: number
  // 用户手动暂停了后台索引
  paused?: boolean
  // 电源策略在等（电池 / 低电量模式 / 温度）：回填暂缓，少量新文件仍即时索引。
  // 只在确有待办任务时带上；与 paused 互斥展示（手动暂停优先）
  waitReason?: PowerWaitReason
  // 正在处理的任务（音视频按片段推进）
  current?: CurrentTask
  // 队列概况
  queue?: { pending: number; error: number }

  // AI 模型状态
  aiModelReady: boolean
}

/** 色板项（item_colors.palette 的 JSON 元素；bucket 见 shared/colors.ts） */
export interface PaletteColor {
  hex: string
  /** 占比 0–1 */
  p: number
  bucket: string
}

export interface PhotoDetail extends Photo {
  exif?: ExifData
  caption?: string
  /** PaddleOCR 识别出的图内文字（多行用 \n 分隔），无则不设 */
  ocrText?: string
  /** 主色板（缩略图时提取；老内容由后台回填），无则不设 */
  palette?: PaletteColor[]
}

export interface ExifData {
  make?: string
  model?: string
  exposureTime?: string
  fNumber?: number
  iso?: number
  focalLength?: number
  dateTime?: string
  gps?: {
    latitude: number
    longitude: number
  }
}

// IPC 通道名称常量
export const IPC_CHANNELS = {
  // 搜索
  SEARCH: 'search',

  // 文件夹管理
  ADD_FOLDER: 'add-folder',
  REMOVE_FOLDER: 'remove-folder',
  GET_FOLDERS: 'get-folders',
  SELECT_FOLDER: 'select-folder',
  GET_FOLDER_STATS: 'get-folder-stats',
  GET_LIBRARY_COUNTS: 'get-library-counts',

  // 原生菜单 → 渲染进程（main 发，renderer 听）
  MENU_COMMAND: 'menu-command',
  OPEN_SETTINGS: 'open-settings',
  LIBRARY_CHANGED: 'library-changed',
  SHOW_ITEM_MENU: 'show-item-menu',
  SET_FAVORITE: 'set-favorite',

  // 智能相册
  GET_SMART_ALBUMS: 'get-smart-albums',
  CREATE_SMART_ALBUM: 'create-smart-album',
  UPDATE_SMART_ALBUM: 'update-smart-album',
  DELETE_SMART_ALBUM: 'delete-smart-album',
  REORDER_SMART_ALBUMS: 'reorder-smart-albums',
  SHOW_SMART_ALBUM_MENU: 'show-smart-album-menu',
  SMART_ALBUMS_CHANGED: 'smart-albums-changed',

  // 照片
  GET_PHOTO_DETAIL: 'get-photo-detail',
  GET_THUMBNAIL: 'get-thumbnail',
  SHOW_IN_FINDER: 'show-in-finder',
  GET_PHOTO_LOCATIONS: 'get-photo-locations',

  // 进度
  INDEX_PROGRESS: 'index-progress',
  GET_INDEX_PAUSED: 'get-index-paused',
  SET_INDEX_PAUSED: 'set-index-paused',
  GET_TASK_OVERVIEW: 'get-task-overview',
  RETRY_FAILED_TASKS: 'retry-failed-tasks',
  CLEAR_FAILED_TASKS: 'clear-failed-tasks',
  GET_MEDIA_DETAIL: 'get-media-detail',
  RESOLVE_LINK: 'resolve-link',

  // 电源策略（设置 › 通用："电池供电时也索引"）
  GET_INDEX_ON_BATTERY: 'get-index-on-battery',
  SET_INDEX_ON_BATTERY: 'set-index-on-battery',

  // 跳过的数据集目录（设置 › 文件夹）
  GET_SKIPPED_FOLDERS: 'get-skipped-folders',
  SET_SKIPPED_FOLDER_OVERRIDE: 'set-skipped-folder-override',

  // 外观
  GET_THEME: 'get-theme',
  SET_THEME: 'set-theme',
  GET_LOCALE_SYNC: 'get-locale-sync',
  GET_LOCALE_SETTING: 'get-locale-setting',
  SET_LOCALE_SETTING: 'set-locale-setting',

  // 系统
  GET_APP_PATH: 'get-app-path',
  GET_MODEL_STATUS: 'get-model-status',

  // Embedding（EmbeddingGemma 2 via LiteRT，纯本地；可选推理后端）
  GET_EMBEDDING_CONFIG: 'get-embedding-config',
  SET_EMBEDDING_CONFIG: 'set-embedding-config',

  // Caption（仅手动编辑，不参与搜索）
  UPDATE_CAPTION: 'update-caption',

  // 相似照片
  FIND_SIMILAR: 'find-similar',

  // 以图搜图（拖入 / 粘贴 / 右键"以此图搜索"）
  SEARCH_BY_IMAGE: 'search-by-image',

  // 语音输入（macOS：系统级离线听写，见 src/main/voice.ts）
  VOICE_STATUS: 'voice-status',
  VOICE_REQUEST_MIC: 'voice-request-mic',
  VOICE_TRANSCRIBE: 'voice-transcribe',

  // 地图
  GET_PHOTOS_WITH_GPS: 'get-photos-with-gps',

  // OCR
  START_OCR_SCAN: 'start-ocr-scan',

  // 视频源文件
  OPEN_SOURCE_VIDEO: 'open-source-video',

  // 备份
  TRIGGER_BACKUP: 'trigger-backup',
  GET_BACKUP_STATUS: 'get-backup-status',

  // 人脸识别
  START_FACE_SCAN: 'start-face-scan',
  GET_PEOPLE: 'get-people',
  GET_PERSON_PHOTOS: 'get-person-photos',
  SET_PERSON_NAME: 'set-person-name',
  MERGE_PEOPLE: 'merge-people',
  GET_PHOTO_FACES: 'get-photo-faces',
  GET_PERSON_SUGGESTIONS: 'get-person-suggestions',
  DISMISS_PERSON_SUGGESTION: 'dismiss-person-suggestion',
  GET_PERSON_FACES: 'get-person-faces',
  REJECT_FACE: 'reject-face',
  ASSIGN_FACE: 'assign-face',
  SET_PERSON_HIDDEN: 'set-person-hidden',
  /** 主 → 渲染：自动聚类改动了人物 */
  PEOPLE_CHANGED: 'people-changed',
} as const

export interface ModelStatus {
  modelsDir: string
  /** LiteRT 运行时 + EmbeddingGemma 2 模型文件是否都在 */
  localModelExists: boolean
  embeddingReady: boolean
  /** 实际在用的推理后端：gpu / cpu；未初始化为 null */
  activeBackend: string | null
  /** 后端偏好 */
  backend: 'auto' | 'gpu' | 'cpu'
  initError: string | null
  /** CPU 没有 AVX，语义模型跑不了（服务器版 / Linux x64），见 semanticCpuUnsupported */
  cpuUnsupported: boolean
}

export interface EmbeddingConfig {
  backend: 'auto' | 'gpu' | 'cpu'
}

export interface BackupStatus {
  lastBackupAt: number | null    // epoch ms
  intervalMs: number             // 自动备份周期
  keepCount: number              // 滚动保留份数
  currentCount: number           // 当前磁盘上的备份数量
  inProgress: boolean
  backupsDir: string
}

// 人脸检测
export interface FaceBbox {
  x: number  // 归一化 0-1
  y: number
  w: number
  h: number
}

export interface FaceRecord {
  id: number
  fileHash: string
  faceIndex: number
  bbox: FaceBbox
  confidence: number
  personId: number | null
  personName?: string | null
}

export interface Person {
  id: number
  name: string | null
  coverFaceId: number | null
  faceCount: number
  photoCount?: number
  hidden?: boolean
  createdAt: string
}

/** "是同一个人吗？"：a 优先是已命名的那个 */
export interface PersonSuggestion {
  a: Person
  b: Person
  similarity: number
}

export interface PersonFace {
  id: number
  quality: number
  assignedBy: 'auto' | 'user' | null
}

export type ProcessingStatus = 'pending' | 'done' | 'error'
export type TaskType = 'thumbnail' | 'embed' | 'face' | 'ocr' | 'extract_frames'

/** 外观：跟随系统 / 浅色 / 深色 */
export type ThemeMode = 'system' | 'light' | 'dark'
