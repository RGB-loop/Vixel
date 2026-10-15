import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'fs'
import { dirname, join } from 'path'
import * as sqliteVec from 'sqlite-vec'
import type { LibraryCounts, MediaFilters, SmartAlbum,
  Photo, WatchedFolder, PhotoDetail, PhotoLocation, VideoRecord, MediaKind, MediaDetail, TaskOverview, TaskRow,
  TaskOrigin, SkippedFolder,
} from '../shared/types'
import { tokenizeForFtsSync } from './text/tokenize'
import type { ClusterPlan, PendingFace, PersonCentroid } from './face/cluster'
import { instrumentStatements } from './perf'
import { buildFtsQuery } from './text/fts-query'
import { PANORAMA_RATIO, SQUARE_TOLERANCE } from './filters'
import { isColorBucket, maskForColor } from '../shared/colors'

// 向量维度 - EmbeddingGemma 2 (768D，Matryoshka 可截断到 512/256/128)
const EMBEDDING_DIM = 768

// 人脸 embedding 维度 - MobileFaceNet (w600k_mbf) 输出 512D
// 与 src/core/face/embedding.ts 的 ONNX 模型保持一致
const FACE_EMBEDDING_DIM = 512

// 数据库 Schema
const SCHEMA = `
-- 监控文件夹表
CREATE TABLE IF NOT EXISTS watched_folders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  path          TEXT NOT NULL UNIQUE,
  last_scan_at  DATETIME,
  recursive     BOOLEAN DEFAULT 1,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 照片主表（每个文件路径一条记录）
CREATE TABLE IF NOT EXISTS photos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id       INTEGER REFERENCES watched_folders(id),
  file_path       TEXT NOT NULL UNIQUE,
  file_name       TEXT NOT NULL,
  file_size       INTEGER NOT NULL,
  file_mtime      INTEGER NOT NULL,
  file_hash       TEXT,
  width           INTEGER,
  height          INTEGER,
  taken_at        DATETIME,
  lat             REAL,
  lng             REAL,
  embed_status    TEXT DEFAULT 'pending',
  face_status     TEXT DEFAULT 'pending',
  video_id        INTEGER REFERENCES videos(id),  -- 视频代表帧：来源视频
  frame_time_ms   INTEGER,                        -- 视频代表帧：时间戳
  pages           INTEGER,                        -- 设计格式（PDF / AI）：页数
  deleted_at      DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_photos_folder ON photos(folder_id);
CREATE INDEX IF NOT EXISTS idx_photos_status ON photos(embed_status);
CREATE INDEX IF NOT EXISTS idx_photos_video ON photos(video_id);
CREATE INDEX IF NOT EXISTS idx_photos_deleted ON photos(deleted_at);
CREATE INDEX IF NOT EXISTS idx_photos_file_hash ON photos(file_hash);
-- 网格分页：ORDER BY 走索引，LIMIT 提前截断，不再每页全表扫描 + 临时排序
CREATE INDEX IF NOT EXISTS idx_photos_live_created ON photos(created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_photos_live_taken ON photos(taken_at DESC, created_at DESC) WHERE deleted_at IS NULL;
-- 代表行判定 MIN(id) / 重复计数：一次索引查找
CREATE INDEX IF NOT EXISTS idx_photos_live_hash_id ON photos(file_hash, id) WHERE deleted_at IS NULL;

-- 索引任务队列
CREATE TABLE IF NOT EXISTS index_queue (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  photo_id    INTEGER,          -- 多态：extract_frames 任务存 videos.id，其余存 photos.id，所以不加外键
  task_type   TEXT NOT NULL,
  priority    INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  error_msg   TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_queue_status ON index_queue(status, priority DESC);

-- Caption 表（按 file_hash 去重共享）
CREATE TABLE IF NOT EXISTS captions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash   TEXT NOT NULL UNIQUE,
  lang        TEXT DEFAULT 'en',
  text        TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 图像向量映射表（file_hash → rowid 映射，vec0 需要 integer rowid）
CREATE TABLE IF NOT EXISTS image_vec_map (
  rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash   TEXT NOT NULL UNIQUE
);

-- 图像向量表（sqlite-vec ANN 索引）
CREATE VIRTUAL TABLE IF NOT EXISTS image_vecs USING vec0(
  embedding float[${EMBEDDING_DIM}]
);

-- OCR 文本表（按 file_hash 去重共享）
-- 与 captions（用户手写描述，不参与搜索）分离；OCR 是 4-way RRF 的 BM25 通道。
CREATE TABLE IF NOT EXISTS image_ocr (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash   TEXT NOT NULL UNIQUE,
  text        TEXT NOT NULL,
  detected_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE VIRTUAL TABLE IF NOT EXISTS image_ocr_fts USING fts5(
  text,
  tokenize='unicode61'
);

CREATE TRIGGER IF NOT EXISTS image_ocr_ai AFTER INSERT ON image_ocr BEGIN
  INSERT INTO image_ocr_fts(rowid, text) VALUES (new.id, jiebatok(new.text));
END;
CREATE TRIGGER IF NOT EXISTS image_ocr_ad AFTER DELETE ON image_ocr BEGIN
  DELETE FROM image_ocr_fts WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS image_ocr_au AFTER UPDATE ON image_ocr BEGIN
  DELETE FROM image_ocr_fts WHERE rowid = old.id;
  INSERT INTO image_ocr_fts(rowid, text) VALUES (new.id, jiebatok(new.text));
END;

-- 人脸表
CREATE TABLE IF NOT EXISTS faces (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  file_hash   TEXT NOT NULL,
  face_index  INTEGER NOT NULL,
  bbox        TEXT NOT NULL,
  confidence  REAL NOT NULL,
  embedding   BLOB NOT NULL,
  person_id   INTEGER REFERENCES people(id),
  quality     REAL DEFAULT 1,              -- 0–1，见 face/quality.ts
  cluster_state INTEGER DEFAULT 0,         -- 未归属时：0 = 新脸待聚类，1 = 聚类过仍落单
  assigned_by TEXT,                        -- 'auto' | 'user'
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(file_hash, face_index)
);

CREATE INDEX IF NOT EXISTS idx_faces_file_hash ON faces(file_hash);
CREATE INDEX IF NOT EXISTS idx_faces_person ON faces(person_id);

-- 人脸向量 ANN 索引（sqlite-vec），rowid == faces.id
-- 避免 assignFaceToPerson 在每次新脸入库时全表 O(N) JS 余弦扫描。
CREATE VIRTUAL TABLE IF NOT EXISTS face_vecs USING vec0(
  embedding float[${FACE_EMBEDDING_DIM}]
);

-- 人物表
CREATE TABLE IF NOT EXISTS people (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT,
  cover_face_id INTEGER,
  face_count  INTEGER DEFAULT 0,
  centroid    BLOB,                        -- 成员 embedding 均值（L2 归一化），聚类用
  hidden      INTEGER DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- "不是此人"：这张脸永远不会再被自动归到这个人物
CREATE TABLE IF NOT EXISTS face_rejections (
  face_id   INTEGER NOT NULL,
  person_id INTEGER NOT NULL,
  PRIMARY KEY (face_id, person_id)
);

-- 用户驳回的合并建议（a < b）
CREATE TABLE IF NOT EXISTS person_dismissed_pairs (
  a INTEGER NOT NULL,
  b INTEGER NOT NULL,
  PRIMARY KEY (a, b)
);

-- 收藏（按内容 hash：同一张照片在多个文件夹里共享收藏状态；原文件不动）
CREATE TABLE IF NOT EXISTS favorites (
  file_hash  TEXT PRIMARY KEY,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 智能相册：保存的查询 + 筛选条件（JSON），打开时重新搜索
CREATE TABLE IF NOT EXISTS smart_albums (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  query      TEXT NOT NULL DEFAULT '',
  filters    TEXT NOT NULL DEFAULT '{}',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 收集来源（收集箱 / 浏览器扩展 / 从浏览器拖入）：按内容 hash；只记录，不发起任何请求
CREATE TABLE IF NOT EXISTS item_sources (
  file_hash    TEXT PRIMARY KEY,
  url          TEXT,
  page_url     TEXT,
  page_title   TEXT,
  collected_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 内部状态 / 一次性迁移标记
CREATE TABLE IF NOT EXISTS meta_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 音视频文件主表（media_kind 区分 'video' / 'audio'，纯音频复用同一套表）
-- 视频本身不索引；indexer 按 32s 切片，每片的帧序列 + 音轨合成一个向量，
-- 存入 video_segments / video_segment_vecs。缩略图仍走 photos（首帧代表图）。
CREATE TABLE IF NOT EXISTS videos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  folder_id    INTEGER REFERENCES watched_folders(id),
  file_path    TEXT NOT NULL UNIQUE,
  file_name    TEXT NOT NULL,
  file_size    INTEGER NOT NULL,
  file_mtime   INTEGER NOT NULL,
  file_hash    TEXT,
  duration_ms  INTEGER,
  width        INTEGER,
  height       INTEGER,
  frame_count  INTEGER DEFAULT 0,
  media_kind   TEXT NOT NULL DEFAULT 'video',
  deleted_at   DATETIME,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_videos_folder ON videos(folder_id);
CREATE INDEX IF NOT EXISTS idx_videos_hash ON videos(file_hash);

-- 视频片段表（EmbeddingGemma 2 重构新增）
-- 长视频按 32s 分块，每个片段一个向量（帧序列 + 音轨 → 单向量）
-- 替代旧方案：photos.video_id / frame_time_ms（逐帧独立 embed）
CREATE TABLE IF NOT EXISTS video_segments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id     INTEGER NOT NULL REFERENCES videos(id),
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  file_hash    TEXT NOT NULL,  -- 片段内容 hash（dedup 用）
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_video_segments_video ON video_segments(video_id);
CREATE INDEX IF NOT EXISTS idx_video_segments_hash ON video_segments(file_hash);

-- 视频片段向量（vec0 ANN 索引）
CREATE VIRTUAL TABLE IF NOT EXISTS video_segment_vecs USING vec0(
  embedding float[${EMBEDDING_DIM}]
);

-- 片段向量映射表（segment_id → rowid）
CREATE TABLE IF NOT EXISTS video_segment_vec_map (
  rowid       INTEGER PRIMARY KEY AUTOINCREMENT,
  segment_id  INTEGER NOT NULL UNIQUE REFERENCES video_segments(id)
);

-- 在 Vixel 里隐藏的内容（近重复清理的“隐藏多余”）：原文件不动，网格 / 搜索 / 计数 / 地图都排除
CREATE TABLE IF NOT EXISTS hidden_items (
  file_hash   TEXT PRIMARY KEY,
  reason      TEXT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 近重复清理里标为"不是重复"的组（组 id = 成员 hash 排序后的 sha1；成员变了 id 就变，组会重新出现）
CREATE TABLE IF NOT EXISTS dismissed_dup_groups (
  group_id    TEXT PRIMARY KEY,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 标签（名字不分大小写唯一）
CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 内容 ↔ 标签（按内容 hash，同一张照片的多份副本共享）
CREATE TABLE IF NOT EXISTS item_tags (
  file_hash   TEXT NOT NULL,
  tag_id      INTEGER NOT NULL REFERENCES tags(id),
  PRIMARY KEY (file_hash, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_item_tags_tag ON item_tags(tag_id);

-- 自动标签（见 core/autotag）：词表里每个标签的文字向量缓存（词表版本变了就重算）
CREATE TABLE IF NOT EXISTS autotag_labels (
  label_id    TEXT PRIMARY KEY,
  version     TEXT NOT NULL,
  embedding   BLOB NOT NULL
);
-- 已经判定过的内容（按词表版本；重跑 = 清空）
CREATE TABLE IF NOT EXISTS autotag_done (
  file_hash   TEXT PRIMARY KEY,
  version     TEXT NOT NULL
);
-- 用户删掉的自动标签：这张内容以后不再自动打这个标签
CREATE TABLE IF NOT EXISTS autotag_rejections (
  file_hash   TEXT NOT NULL,
  label_id    TEXT NOT NULL,
  PRIMARY KEY (file_hash, label_id)
);

-- 色板（按内容 hash）：palette 是 JSON 数组 [{hex,p,bucket}]；
-- bucket_mask 是 12 个色桶（见 shared/colors.ts）的位掩码，SQL 颜色筛选只查它
CREATE TABLE IF NOT EXISTS item_colors (
  file_hash   TEXT PRIMARY KEY,
  palette     TEXT NOT NULL,
  bucket_mask INTEGER NOT NULL DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 被跳过的"疑似数据集"目录（见 core/skipRules.ts：同类媒体 ≥ N 且名字大多是机器生成）。
-- override = 1 表示用户点了"仍然索引"，watcher 之后不再跳过它
CREATE TABLE IF NOT EXISTS skipped_folders (
  path        TEXT PRIMARY KEY,
  folder_id   INTEGER NOT NULL REFERENCES watched_folders(id),
  reason      TEXT NOT NULL DEFAULT 'dataset',
  file_count  INTEGER NOT NULL DEFAULT 0,
  override    INTEGER NOT NULL DEFAULT 0,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_skipped_folders_folder ON skipped_folders(folder_id);
`

/** 后来加的表（只读打开旧库时用空 TEMP 表顶替，见 initDatabase） */
const LATE_TABLES: Record<string, string> = {
  favorites: 'file_hash TEXT PRIMARY KEY, created_at DATETIME',
  hidden_items: 'file_hash TEXT PRIMARY KEY, reason TEXT, created_at DATETIME',
  dismissed_dup_groups: 'group_id TEXT PRIMARY KEY, created_at DATETIME',
  smart_albums: 'id INTEGER PRIMARY KEY, name TEXT, query TEXT, filters TEXT, sort_order INTEGER, created_at DATETIME, updated_at DATETIME',
  tags: 'id INTEGER PRIMARY KEY, name TEXT, created_at DATETIME, label_id TEXT',
  item_tags: 'file_hash TEXT, tag_id INTEGER, auto_score REAL',
  autotag_labels: 'label_id TEXT PRIMARY KEY, version TEXT, embedding BLOB',
  autotag_done: 'file_hash TEXT PRIMARY KEY, version TEXT',
  autotag_rejections: 'file_hash TEXT, label_id TEXT',
  item_sources: 'file_hash TEXT PRIMARY KEY, url TEXT, page_url TEXT, page_title TEXT, collected_at DATETIME',
  item_colors: 'file_hash TEXT PRIMARY KEY, palette TEXT, bucket_mask INTEGER, created_at DATETIME',
  skipped_folders: 'path TEXT PRIMARY KEY, folder_id INTEGER, reason TEXT, file_count INTEGER, override INTEGER, created_at DATETIME',
}

// 照片查询共用列（表别名 p）。LEFT JOIN videos v 补出媒体类型和时长：
// 视频/音频的代表图（首帧 / 封面 / 波形）也是 photos 行，靠 video_id 关联
const MEDIA_KIND_EXPR = `CASE WHEN p.video_id IS NULL THEN 'image' ELSE COALESCE(v.media_kind, 'video') END`
// fileName 对音视频代表 photo 取源文件名（展示用）；filePath 仍是代表图路径（解码 / 缩略图用）
const PHOTO_COLUMNS = `
  p.id, p.folder_id as folderId, p.file_path as filePath, COALESCE(v.file_name, p.file_name) as fileName,
  p.file_size as fileSize, p.file_mtime as fileMtime, p.file_hash as fileHash,
  p.width, p.height, p.taken_at as takenAt, p.lat, p.lng,
  p.embed_status as embedStatus, p.face_status as faceStatus, p.video_id as videoId, p.frame_time_ms as frameTimeMs,
  p.pages, p.is_screenshot as isScreenshot, p.deleted_at as deletedAt, p.created_at as createdAt, p.updated_at as updatedAt,
  ${MEDIA_KIND_EXPR} as mediaKind, v.duration_ms as durationMs,
  EXISTS (SELECT 1 FROM favorites fav WHERE fav.file_hash = p.file_hash) as favorite`
const MEDIA_JOIN = `LEFT JOIN videos v ON v.id = p.video_id`

/**
 * 过滤条件 → WHERE 片段（以 AND 开头，表别名 p / v）。判定与 filters.ts 的 matchesFilters 一致；
 * 片段只由条件种类决定，值都走参数，调用方按片段缓存预编译语句。
 */
export function filterWhere(f: MediaFilters): { where: string; params: unknown[] } {
  const parts: string[] = []
  const params: unknown[] = []
  if (f.dateFrom) { parts.push('p.taken_at >= ?'); params.push(f.dateFrom) }
  if (f.dateTo) { parts.push('p.taken_at <= ?'); params.push(f.dateTo) }
  if (f.kind) { parts.push(`${MEDIA_KIND_EXPR} = ?`); params.push(f.kind) }
  // 截图：is_screenshot = 1（NULL = 还没判过的不算；见 core/screenshot.ts）
  if (f.screenshot) parts.push('p.is_screenshot = 1')
  if (f.folderId != null) {
    parts.push('EXISTS (SELECT 1 FROM photos p4 WHERE p4.file_hash = p.file_hash AND p4.folder_id = ? AND p4.deleted_at IS NULL)')
    params.push(f.folderId)
  }
  if (f.orientation) {
    const long = 'MAX(p.width, p.height)'
    const short = 'MIN(p.width, p.height)'
    const sized = 'p.width > 0 AND p.height > 0'
    parts.push({
      panorama: `${sized} AND ${long} >= ${PANORAMA_RATIO} * ${short}`,
      square: `${sized} AND ${long} <= ${SQUARE_TOLERANCE} * ${short}`,
      landscape: `${sized} AND p.width > p.height AND ${long} > ${SQUARE_TOLERANCE} * ${short} AND ${long} < ${PANORAMA_RATIO} * ${short}`,
      portrait: `${sized} AND p.height > p.width AND ${long} > ${SQUARE_TOLERANCE} * ${short} AND ${long} < ${PANORAMA_RATIO} * ${short}`,
    }[f.orientation])
  }
  if (f.minPixels) { parts.push('p.width * p.height >= ?'); params.push(f.minPixels) }
  if (f.maxPixels) { parts.push('p.width * p.height > 0 AND p.width * p.height < ?'); params.push(f.maxPixels) }
  if (f.durationMin != null || f.durationMax != null) parts.push('p.video_id IS NOT NULL AND v.duration_ms IS NOT NULL')
  if (f.durationMin != null) { parts.push('v.duration_ms >= ?'); params.push(f.durationMin) }
  if (f.durationMax != null) { parts.push('v.duration_ms < ?'); params.push(f.durationMax) }
  if (f.personId != null) { parts.push('p.file_hash IN (SELECT file_hash FROM faces WHERE person_id = ?)'); params.push(f.personId) }
  if (f.favorite) parts.push('EXISTS (SELECT 1 FROM favorites fav WHERE fav.file_hash = p.file_hash)')
  for (const tagId of f.tagIds ?? []) {
    parts.push('p.file_hash IN (SELECT file_hash FROM item_tags WHERE tag_id = ?)')
    params.push(tagId)
  }
  if (f.color) {
    // bucket_mask 位掩码（shared/colors.ts）；未知颜色名 mask=0 → 永假，不会放大结果
    parts.push('p.file_hash IN (SELECT file_hash FROM item_colors WHERE (bucket_mask & ?) != 0)')
    params.push(maskForColor(f.color))
  }
  return { where: parts.map((x) => `AND (${x})`).join(' '), params }
}

/** 音视频切片长度；indexer 与任务面板的"预期片段数"共用 */
export const SEGMENT_MS = 32_000

const TASK_ROW_SELECT = `
  SELECT q.id, q.task_type as taskType, q.status, q.error_msg as errorMsg,
         q.retry_count as retryCount, q.created_at as createdAt,
         CASE WHEN q.task_type = 'extract_frames' THEN qv.file_name ELSE p.file_name END as name,
         CASE WHEN q.task_type = 'extract_frames' THEN COALESCE(qv.media_kind, 'video')
              ELSE ${MEDIA_KIND_EXPR} END as kind
  FROM index_queue q
  LEFT JOIN videos qv ON q.task_type = 'extract_frames' AND qv.id = q.photo_id
  LEFT JOIN photos p ON q.task_type <> 'extract_frames' AND p.id = q.photo_id
  ${MEDIA_JOIN}`

/**
 * 增量 schema 迁移。SCHEMA 只有 CREATE IF NOT EXISTS，老库里已存在的表不会加新列，
 * 这里按 table_info 检查后补齐，可重复执行。
 */
/**
 * OCR 全文索引的分词版本。text/tokenize.ts 的切词结果一变就加一，旧库启动时自动重建索引。
 * jieba-2：0.3.0 及以前 jieba 实际没生效（@node-rs/jieba 2.x 的 API 变了），中文整段入索引
 */
const FTS_TOKENIZER_VERSION = 'jieba-2'

export function migrateSchema(db: Database.Database): void {
  const hasColumn = (table: string, column: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column)
  if (!hasColumn('videos', 'media_kind')) {
    db.exec(`ALTER TABLE videos ADD COLUMN media_kind TEXT NOT NULL DEFAULT 'video'`)
  }
  const add = (table: string, column: string, def: string): void => {
    if (!hasColumn(table, column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
  }
  add('faces', 'quality', 'REAL DEFAULT 1')
  add('faces', 'cluster_state', 'INTEGER DEFAULT 0')
  add('faces', 'assigned_by', 'TEXT')
  add('people', 'centroid', 'BLOB')
  add('people', 'hidden', 'INTEGER DEFAULT 0')
  // 收集箱：就是一个普通监视文件夹，打个标记（只有 core/collectStore 读它）
  add('watched_folders', 'is_inbox', 'INTEGER DEFAULT 0')
  // 设计格式（PDF / AI）的页数
  add('photos', 'pages', 'INTEGER')
  // 截图标记：NULL = 还没判过（后台回填），0 / 1 = 判过（见 core/screenshot.ts）
  add('photos', 'is_screenshot', 'INTEGER')
  // 任务来源：'live'（watcher 实时事件 / 收集箱）在电源策略挡住回填时仍然放行
  add('index_queue', 'origin', `TEXT NOT NULL DEFAULT 'backfill'`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_faces_unassigned ON faces(cluster_state) WHERE person_id IS NULL`)

  // 自动标签：标签可以对应词表里的一个标签（label_id，界面按语言显示名字）；
  // 内容↔标签的链接带 auto_score 表示是自动打的（NULL = 用户打的 / 已确认）
  add('tags', 'label_id', 'TEXT')
  add('item_tags', 'auto_score', 'REAL')
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_label ON tags(label_id) WHERE label_id IS NOT NULL`)

  // 开发期曾有过的 Eagle 资源库镜像表（未发布即移除）
  db.exec(`DROP TABLE IF EXISTS eagle_items; DROP INDEX IF EXISTS idx_item_tags_origin`)

  // 分词方式变了：用已存的 OCR 原文重建全文索引（只重新切词，不重新识别）
  const tokenizer = (db.prepare(`SELECT value FROM meta_state WHERE key = 'fts.tokenizer'`).get() as { value: string } | undefined)?.value
  if (tokenizer !== FTS_TOKENIZER_VERSION) {
    db.transaction(() => {
      db.exec(`DELETE FROM image_ocr_fts`)
      db.exec(`INSERT INTO image_ocr_fts(rowid, text) SELECT id, jiebatok(text) FROM image_ocr`)
      db.prepare(`INSERT OR REPLACE INTO meta_state (key, value) VALUES ('fts.tokenizer', ?)`).run(FTS_TOKENIZER_VERSION)
    })()
  }

  // 老库的 face_vecs 按 128 维建的，而模型实际输出 512 维 → 写入全被跳过、KNN 全部报错。
  // vec0 不能改列维度，只能重建，再从 faces.embedding 回填。
  const vecSql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'face_vecs'`).get() as { sql: string } | undefined)?.sql
  if (vecSql && !vecSql.includes(`float[${FACE_EMBEDDING_DIM}]`)) {
    db.transaction(() => {
      db.exec(`DROP TABLE face_vecs`)
      db.exec(`CREATE VIRTUAL TABLE face_vecs USING vec0(embedding float[${FACE_EMBEDDING_DIM}])`)
      db.prepare(
        `INSERT INTO face_vecs(rowid, embedding) SELECT id, embedding FROM faces WHERE length(embedding) = ?`
      ).run(FACE_EMBEDDING_DIM * 4)
    })()
  }
}

export interface DatabaseInstance {
  // 文件夹操作
  addFolder: (path: string) => WatchedFolder
  removeFolder: (id: number) => void
  getFolder: (id: number) => WatchedFolder | undefined
  getFolders: () => WatchedFolder[]
  getFoldersWithStats: () => WatchedFolder[]
  updateFolderScanTime: (id: number) => void
  getFolderStats: (id: number) => { photoCount: number; photoIds: number[] }
  /** 文件夹里仍存活的源文件路径（不含视频帧）；启动对账用，一条查询代替逐张 getPhoto */
  getLiveSourcePaths: (folderId: number) => { photos: string[]; videos: string[] }
  deletePhotosByFolder: (folderId: number) => string[] // 返回孤立的 file_hash 列表
  /** 删除文件夹下的视频 + 片段向量 + extract_frames 任务；返回视频 hash（调用方清抽帧目录） */
  deleteVideosByFolder: (folderId: number) => string[]

  // 照片操作
  addPhoto: (
    folderId: number,
    filePath: string,
    fileName: string,
    fileSize: number,
    fileMtime: number,
    fileHash: string,
    /** 视频帧 provenance（可选）—— 若提供，该 photos 行就是该视频在某个时间戳的关键帧 */
    videoCtx?: { videoId: number; frameTimeMs: number }
  ) => number
  getPhoto: (id: number) => Photo | undefined
  getPhotoByPath: (path: string) => Photo | undefined
  getPhotoDetail: (id: number) => PhotoDetail | undefined
  updatePhotoMeta: (
    id: number,
    data: { width?: number; height?: number; takenAt?: string; lat?: number; lng?: number; pages?: number }
  ) => void
  softDeletePhoto: (path: string) => void
  updatePhotoPath: (id: number, newPath: string) => void
  getPhotos: (limit: number, offset?: number) => Photo[]
  getRepresentativePhotos: (limit: number, offset?: number) => Photo[]
  getPhotoLocations: (fileHash: string) => PhotoLocation[]
  markDuplicateProcessed: (photoId: number) => void
  /** 截图标记（0 / 1；NULL = 未判，见 core/screenshot.ts） */
  setPhotoScreenshot: (photoId: number, flag: 0 | 1) => void
  /** 该内容 hash 任一存活副本的截图标记；都没判过返回 null */
  getScreenshotFlagForHash: (fileHash: string) => 0 | 1 | null
  /** 还没判过截图标记的存活图片（不含视频代表帧），启动回填用 */
  photosMissingScreenshotFlag: (limit: number) => Array<{ id: number; filePath: string; fileName: string; fileHash: string }>

  // 跳过的数据集目录（core/skipRules.ts 判定，watcher 写入；设置 › 文件夹 展示）
  listSkippedFolders: (folderId?: number) => SkippedFolder[]
  addSkippedFolder: (folderId: number, path: string, fileCount: number) => void
  /** "仍然索引"：置 override，watcher 之后不再跳过该目录 */
  setSkippedFolderOverride: (path: string, override: boolean) => void

  // 索引队列
  /** origin：'live'（watcher 实时事件 / 收集箱）在电源策略挡住回填时仍然放行；默认 'backfill' */
  addToQueue: (photoId: number, taskType: string, priority?: number, origin?: TaskOrigin) => void
  /** 是否已有排队中 / 进行中的同类任务（避免重复入队） */
  hasOpenTask: (photoId: number, taskType: string) => boolean
  /** 有排队中 / 进行中 / 失败的任务：启动对账据此跳过，失败的留给任务面板重试，不每次启动重跑 */
  hasOpenOrFailedTask: (photoId: number, taskType: string) => boolean
  /** liveOnly：只取 origin='live' 的任务（电源策略挡住回填时用） */
  getNextTask: (liveOnly?: boolean, groupByModel?: boolean) => { id: number; photoId: number; taskType: string; origin: TaskOrigin } | undefined
  /** 排队中的 live 任务数：≤ LIVE_TASK_BURST_MAX 才在回填等待期间放行 */
  countLivePendingTasks: () => number
  peekNextTask: () => { id: number; photoId: number; taskType: string } | undefined
  /** note：任务成功但有可报告的问题（如部分片段失败），写进 error_msg 供任务面板展示 */
  completeTask: (taskId: number, note?: string) => void
  resetTask: (taskId: number) => void
  failTask: (taskId: number, error: string) => void
  recoverStuckTasks: () => number
  requeueMissingEmbeddings: () => number
  getQueueStats: () => { pending: number; processing: number; done: number; error: number }
  getTaskOverview: () => TaskOverview
  /** error → pending；不传 ids 则重试全部失败任务。返回重试条数 */
  retryFailedTasks: (ids?: number[]) => number
  clearFailedTasks: () => number
  /** done 行只是历史，启动时清掉，避免队列表无限增长 */
  pruneDoneTasks: () => number
  /**
   * 人脸流水线版本不符时清空 faces / face_vecs / people 并把图片 face_status 置回 pending。
   * 返回清掉的旧人脸数（0 = 无需重扫）。
   */
  resetFacesIfStale: (version: string) => number
  getMediaDetail: (videoId: number) => MediaDetail | undefined

  // 照片统计
  /** 资料库各类型条数（按代表 photo 计，与网格一致）；侧边栏计数用 */
  getLibraryCounts: () => LibraryCounts
  getPhotoStats: () => { total: number; uniqueTotal: number; thumbnailed: number; indexed: number; ocred: number }

  // 内容操作（按 file_hash 共享）
  hasContentForHash: (fileHash: string) => { hasEmbedding: boolean; hasCaption: boolean; hasOcr: boolean }
  saveImageVec: (fileHash: string, embedding: Float32Array) => void
  updateEmbedStatusByHash: (fileHash: string) => void
  saveCaption: (fileHash: string, text: string) => void
  getCaption: (fileHash: string) => string | undefined
  saveOcrText: (fileHash: string, text: string) => void
  getOcrText: (fileHash: string) => string | undefined
  // 色板（按 file_hash 共享；见 core/color）
  /** palette: JSON 数组字符串；mask: 色桶位掩码 */
  saveItemColors: (fileHash: string, paletteJson: string, mask: number) => void
  getItemColors: (fileHash: string) => { palette: string; mask: number } | undefined
  hasColorsForHash: (fileHash: string) => boolean
  /** 含有掩码中任一色桶的内容 hash（搜索结果的颜色后过滤用） */
  getHashesForColorMask: (mask: number) => Set<string>
  /** 还没算色板的存活内容（去重后的 hash + 任一代表路径），颜色回填用 */
  getHashesMissingColors: (limit: number) => Array<{ fileHash: string }>
  getPendingOcrPhotos: () => Array<{ id: number; fileHash: string; filePath: string }>
  /** 清空全部 OCR 结果（FTS 随触发器清），OCR 流水线升级时用；返回清掉的条数 */
  clearAllOcr: () => number
  deleteContentByHash: (fileHash: string) => void

  // 视频片段（EmbeddingGemma 2：帧序列 + 音轨 → 单向量）
  saveVideoSegment: (
    videoId: number,
    startMs: number,
    endMs: number,
    fileHash: string,
    embedding: Float32Array
  ) => number
  hasVideoSegmentForHash: (fileHash: string) => boolean
  getVideoSegments: (videoId: number) => Array<{
    id: number
    videoId: number
    startMs: number
    endMs: number
    fileHash: string
  }>
  deleteVideoSegments: (videoId: number) => void
  searchVideoSegmentsByVec: (
    queryVec: Float32Array,
    limit: number
  ) => Array<{ segmentId: number; videoId: number; startMs: number; endMs: number; distance: number }>

  /**
   * 随机抽 n 条向量（图片 / 音视频片段），给搜索估计"这个查询和整库的基线相似度"。
   * 返回已 L2 归一化的向量。
   */
  sampleVectors: (kind: 'image' | 'segment', n: number) => Float32Array[]
  /** 两类向量的条数：样本缓存据此判断是否需要刷新 */
  countVectors: () => { image: number; segment: number }

  // 搜索
  searchByVec: (
    queryVec: Float32Array,
    limit: number
  ) => Array<{ fileHash: string; distance: number }>
  searchByFileName: (
    query: string,
    limit: number
  ) => Array<{ fileHash: string }>
  searchByOcr: (
    query: string,
    limit: number
  ) => Array<{ fileHash: string; score: number }>
  getRepresentativeByHash: (fileHash: string) => Photo | undefined
  /** 无搜索词时按过滤条件浏览（拍摄时间倒序） */
  getRepresentativePhotosFiltered: (limit: number, offset: number, filters: MediaFilters) => Photo[]
  /** 收藏 / 取消收藏（按内容 hash） */
  setFavorite: (fileHashes: string[], on: boolean) => void
  getFavoriteHashes: () => Set<string>
  /** 智能相册（按 sort_order） */
  getSmartAlbums: () => SmartAlbum[]
  createSmartAlbum: (album: { name: string; query: string; filters: MediaFilters }) => SmartAlbum
  updateSmartAlbum: (id: number, patch: { name?: string; query?: string; filters?: MediaFilters }) => SmartAlbum | undefined
  deleteSmartAlbum: (id: number) => void
  /** 按给定顺序重排；不在列表里的保持原相对顺序排在后面 */
  reorderSmartAlbums: (ids: number[]) => void
  /** 某人物出现过的内容 hash（人物过滤用） */
  getHashesForPerson: (personId: number) => Set<string>
  /** 某文件夹内出现过的 file_hash（同内容可能多处引用，带搜索词时按 hash 过滤） */
  getHashesInFolder: (folderId: number) => Set<string>
  findSimilar: (
    fileHash: string,
    limit: number
  ) => Array<{ fileHash: string; distance: number }>
  /** 某内容 hash 已存的图片向量（以图搜图"以此图搜索"直接用，不再过模型）；没有则 null */
  getImageVecByHash: (fileHash: string) => Float32Array | null
  getPhotosWithGPS: (limit?: number) => Photo[]

  // 人脸
  saveFace: (fileHash: string, faceIndex: number, bbox: string, confidence: number, embedding: Float32Array, quality?: number) => number
  updateFaceStatusByHash: (fileHash: string) => void
  hasFacesForHash: (fileHash: string) => boolean
  getFacesByHash: (fileHash: string) => Array<{ id: number; faceIndex: number; bbox: string; confidence: number; personId: number | null; personName: string | null }>
  getAllFaceEmbeddings: () => Array<{ id: number; embedding: Float32Array; confidence: number; personId: number | null }>
  /**
   * 在 face_vecs 上跑 vec0 KNN，返回距离 ≤ maxDistance 的最近邻。
   *
   * 与全量 getAllFaceEmbeddings + JS 余弦相比：1k 人脸库 50ms → < 1ms。
   * 失败（如 face_vecs 维度不匹配、未启用 vec0）时返回 []，调用方自行回退。
   */
  searchFaceKnn: (
    queryVec: Float32Array,
    k: number,
    excludeFaceId?: number
  ) => Array<{ faceId: number; personId: number | null; distance: number }>
  setFacePersonId: (faceId: number, personId: number) => void
  createPerson: (coverFaceId: number) => number
  updatePersonFaceCount: (personId: number) => void
  getPeople: () => Array<{ id: number; name: string | null; coverFaceId: number | null; faceCount: number; photoCount: number; hidden: boolean; createdAt: string }>
  getPersonPhotos: (personId: number, limit?: number) => Photo[]
  updatePersonName: (personId: number, name: string) => void
  mergePeople: (targetId: number, sourceIds: number[]) => void

  // 聚类（face/cluster.ts 的输入输出）
  getPersonCentroids: (opts?: { includeHidden?: boolean }) => PersonCentroid[]
  getPendingClusterFaces: () => PendingFace[]
  getDormantFaces: () => PendingFace[]
  getFaceRejections: () => Map<number, Set<number>>
  getDismissedPairs: () => Set<string>
  countPendingClusterFaces: () => number
  /** 库里是否扫出过人脸：老库没有 face.auto 标记时，据此判断用户用过人物功能 */
  hasAnyFaces: () => boolean
  /**
   * 视频代表帧的人脸清掉、face_status 置回 pending，等补扫用全分辨率帧重新检测。
   * 人脸属于命名人物的视频保留不动。返回置回 pending 的帧数。
   */
  resetVideoFramesForFaceRescan: () => number
  applyClusterPlan: (plan: ClusterPlan) => void
  /** 新脸入库时的即时归属：只更新计数 / 封面 / 质心，不全量重算 */
  addFaceToPerson: (faceId: number, personId: number, embedding: Float32Array) => void
  /** 重算人物的计数 / 封面 / 质心；没有脸了就删掉人物 */
  refreshPerson: (personId: number) => void

  // 手动整理
  setPersonHidden: (personId: number, hidden: boolean) => void
  /** "不是此人"：脱离人物并记为约束 */
  rejectFaceFromPerson: (faceId: number) => void
  /** 手动指定（不受聚类阈值限制，也会清掉对该人物的拒绝） */
  assignFaceManually: (faceId: number, personId: number) => void
  dismissPersonPair: (a: number, b: number) => void
  getPersonFaces: (personId: number, limit?: number) => Array<{ id: number; fileHash: string; bbox: string; quality: number; assignedBy: string | null }>
  getPendingFacePhotos: () => Array<{ id: number; fileHash: string; filePath: string }>
  getFaceCoverInfo: (faceId: number) => { fileHash: string; bbox: string } | undefined

  // 视频
  addVideo: (
    folderId: number,
    filePath: string,
    fileName: string,
    fileSize: number,
    fileMtime: number,
    fileHash: string,
    kind?: MediaKind
  ) => number
  getVideoById: (id: number) => VideoRecord | undefined
  getVideoByPath: (path: string) => VideoRecord | undefined
  updateVideoMeta: (
    id: number,
    data: { durationMs?: number; width?: number; height?: number; frameCount?: number }
  ) => void
  softDeleteVideo: (path: string) => void
  getFramePhotosByVideo: (videoId: number) => Photo[]
  /**
   * 用户删了源视频文件后的级联清理：soft-delete video，
   * soft-delete 所有 frame photos，对孤立的 frame hash 做内容 GC。
   * 返回 { fileHash, orphanedFrameHashes }；调用方据此清理 JPG 帧目录。
   */
  cascadeRemoveVideo: (filePath: string) => {
    fileHash: string
    orphanedFrameHashes: string[]
  } | null
  /**
   * 重抽帧前的清理：soft-delete 该 videoId 已有的所有 frame photos，
   * 对孤立 hash 做内容 GC。**不动 videos 表本身**。
   * 返回 orphanedFrameHashes，调用方据此清磁盘 JPG / 缩略图。
   */
  removeFramesForVideo: (videoId: number) => string[]

  // 备份
  /**
   * 用 SQLite online backup API 将 library.db 复制到 destPath。
   * better-sqlite3 的 .backup() 是异步、安全 — 不阻塞读写，WAL 模式兼容。
   */
  backupTo: (destPath: string) => Promise<void>
  /** 读取 meta_state 任一键（备份时间戳等小状态） */
  getMetaState: (key: string) => string | undefined
  /** 写入 meta_state 任一键 */
  setMetaState: (key: string, value: string) => void

  /** 底层连接：只给诊断（vixel doctor / bench）跑 EXPLAIN 和计时用，业务代码别碰 */
  raw: Database.Database

  // 关闭
  close: () => void
}


/**
 * readonly：CLI 的只读命令用。不跑 DDL / 迁移 / checkpoint —— 应用开着时 CLI 也不会去改库结构
 * （迁移可能触发 face_vecs 重建）。库必须已由应用创建并迁移过。
 */
/**
 * sqlite-vec 原生扩展的真实路径。sqlite-vec 自带的 getLoadablePath 只找同级的
 * node_modules/sqlite-vec-<平台>，但打包后平台子包被放在 sqlite-vec/node_modules/ 下，
 * 而且路径落在 app.asar 里（Electron 的 fs 能读，SQLite 的 dlopen 不能）。
 * 这里用 Node 的模块解析从 sqlite-vec 目录找平台子包，再改指向 app.asar.unpacked。
 */
interface SmartAlbumRow { id: number; name: string; query: string; filters: string; sortOrder: number; createdAt: string; updatedAt: string }

/** 智能相册的条件存成 JSON：读写时只保留认识的键和合法类型，旧版本 / 手改的脏数据不会传到搜索里 */
export function sanitizeFilters(raw: unknown): MediaFilters {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: MediaFilters = {}
  const str = (k: 'dateFrom' | 'dateTo'): void => { if (typeof f[k] === 'string' && f[k]) out[k] = f[k] as string }
  const num = (k: 'folderId' | 'minPixels' | 'maxPixels' | 'durationMin' | 'durationMax' | 'personId'): void => {
    if (typeof f[k] === 'number' && Number.isFinite(f[k])) out[k] = f[k] as number
  }
  str('dateFrom'); str('dateTo')
  num('folderId'); num('minPixels'); num('maxPixels'); num('durationMin'); num('durationMax'); num('personId')
  if (f.kind === 'image' || f.kind === 'video' || f.kind === 'audio') out.kind = f.kind
  if (f.orientation === 'landscape' || f.orientation === 'portrait' || f.orientation === 'square' || f.orientation === 'panorama') out.orientation = f.orientation
  if (f.favorite === true) out.favorite = true
  if (f.screenshot === true) out.screenshot = true
  if (isColorBucket(f.color)) out.color = f.color
  if (Array.isArray(f.tagIds)) {
    const ids = f.tagIds.filter((x): x is number => typeof x === 'number' && Number.isInteger(x))
    if (ids.length > 0) out.tagIds = [...new Set(ids)]
  }
  return out
}

function toSmartAlbum(row: SmartAlbumRow): SmartAlbum {
  let filters: MediaFilters = {}
  try { filters = sanitizeFilters(JSON.parse(row.filters)) } catch { /* 坏 JSON 当作无条件 */ }
  return { ...row, filters }
}

function vecExtensionPath(): string {
  const unpacked = (p: string): string => p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
  try {
    return unpacked(sqliteVec.getLoadablePath())
  } catch {
    // 平台子包的 package.json 没有导出，require.resolve 不了；直接检查两种可能的布局
    const os = process.platform === 'win32' ? 'windows' : process.platform
    const ext = process.platform === 'win32' ? 'dll' : process.platform === 'darwin' ? 'dylib' : 'so'
    const pkg = `sqlite-vec-${os}-${process.arch}`
    const base = dirname(require.resolve('sqlite-vec'))
    const found = [join(base, 'node_modules', pkg), join(base, '..', pkg)]
      .map((d) => join(d, `vec0.${ext}`))
      .find((f) => existsSync(f))
    if (!found) throw new Error(`sqlite-vec native extension (${pkg}) not found`)
    return unpacked(found)
  }
}

export function initDatabase(dbPath: string, options?: { runCleanup?: boolean; readonly?: boolean }): DatabaseInstance {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const readonly = options?.readonly === true
  const db = new Database(dbPath, readonly ? { readonly: true, fileMustExist: true } : undefined)
  if (!readonly) db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  // WAL 下 NORMAL 不会损坏库，只是掉电时可能丢最后几笔提交；FULL 会让首次导入的每次写都 fsync
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')
  db.pragma('cache_size = -65536') // 64 MB
  db.pragma('mmap_size = 268435456') // 256 MB，向量表全扫描走 mmap

  // 加载 sqlite-vec 向量搜索扩展
  db.loadExtension(vecExtensionPath())
  console.log('sqlite-vec loaded:', (db.prepare('select vec_version()').get() as Record<string, string>)['vec_version()'])

  // 注册 jiebatok(text) UDF —— FTS5 触发器调用它做 CJK 分词。
  // deterministic: true 允许 SQLite 缓存结果（同一文本只切一次）。
  db.function('jiebatok', { deterministic: true, varargs: false }, (text: unknown): string => {
    if (typeof text !== 'string' || text.length === 0) return ''
    return tokenizeForFtsSync(text)
  })

  if (!readonly) {
    db.exec(SCHEMA)
    migrateSchema(db)
    // WAL checkpoint — 确保其他进程写入的数据对当前连接可见
    db.pragma('wal_checkpoint(PASSIVE)')
  }

  if (readonly) {
    // 应用还没升级过的旧库缺少后加的表：只读连接不能建表，用同名空 TEMP 表顶上，
    // 否则引用它们的语句一 prepare 就失败。只在主库缺表时建（TEMP 会遮住同名主表）
    const has = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).pluck()
    for (const [name, cols] of Object.entries(LATE_TABLES)) {
      if (!has.get(name)) db.exec(`CREATE TEMP TABLE ${name} (${cols})`)
    }
  }

  if (!readonly && options?.runCleanup !== false) {
    cleanupStaleVecMap(db)
  }

  const stmts = {
    addFolder: db.prepare(`
      INSERT INTO watched_folders (path) VALUES (?)
      RETURNING *
    `),
    removeFolder: db.prepare(`DELETE FROM watched_folders WHERE id = ?`),
    getFolder: db.prepare(`SELECT * FROM watched_folders WHERE id = ?`),
    getFolders: db.prepare(`SELECT * FROM watched_folders ORDER BY created_at DESC`),
    getFoldersWithStats: db.prepare(`
      SELECT wf.*, COUNT(p.id) as photoCount
      FROM watched_folders wf
      LEFT JOIN photos p ON wf.id = p.folder_id AND p.deleted_at IS NULL
        AND p.file_hash NOT IN (SELECT file_hash FROM hidden_items)
      GROUP BY wf.id
      ORDER BY wf.created_at DESC
    `),
    updateFolderScanTime: db.prepare(`
      UPDATE watched_folders SET last_scan_at = CURRENT_TIMESTAMP WHERE id = ?
    `),
    getFolderPhotoCount: db.prepare(`
      SELECT COUNT(*) as count FROM photos WHERE folder_id = ? AND deleted_at IS NULL
    `),
    getFolderPhotoIds: db.prepare(`
      SELECT id FROM photos WHERE folder_id = ?
    `),
    // 查找文件夹内照片的 hash 中，没有其他存活副本的（孤立 hash）
    getOrphanedHashes: db.prepare(`
      SELECT DISTINCT p1.file_hash
      FROM photos p1
      WHERE p1.folder_id = ? AND p1.file_hash IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM photos p2
          WHERE p2.file_hash = p1.file_hash
            AND p2.folder_id != ?
            AND p2.deleted_at IS NULL
        )
    `),
    deletePhotosByFolderId: db.prepare(`DELETE FROM photos WHERE folder_id = ?`),
    deleteQueueByPhotoIds: db.prepare(`DELETE FROM index_queue WHERE photo_id IN (SELECT id FROM photos WHERE folder_id = ?)`),
    getVideosByFolder: db.prepare(`SELECT id, file_hash as fileHash FROM videos WHERE folder_id = ?`),
    getLivePhotoPaths: db.prepare(`
      SELECT file_path as p FROM photos WHERE folder_id = ? AND deleted_at IS NULL AND video_id IS NULL
    `).pluck(),
    getLiveVideoPaths: db.prepare(`
      SELECT file_path as p FROM videos WHERE folder_id = ? AND deleted_at IS NULL
    `).pluck(),
    // extract_frames 的 photo_id 存的是 videos.id
    deleteExtractTasksByFolder: db.prepare(`
      DELETE FROM index_queue
      WHERE task_type = 'extract_frames' AND photo_id IN (SELECT id FROM videos WHERE folder_id = ?)
    `),
    deleteVideosByFolderId: db.prepare(`DELETE FROM videos WHERE folder_id = ?`),

    addPhoto: db.prepare(`
      INSERT INTO photos (folder_id, file_path, file_name, file_size, file_mtime, file_hash, video_id, frame_time_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        file_hash = excluded.file_hash,
        -- 直接覆盖：调用方明确知道当前路径是不是视频帧，COALESCE 会导致
        -- 旧的 video_id 在路径转身份（视频帧 → 普通照片）时残留，触发
        -- search.ts 的 dedup-by-video 错误丢弃。
        video_id = excluded.video_id,
        frame_time_ms = excluded.frame_time_ms,
        deleted_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      RETURNING id
    `),

    // 视频表 CRUD
    addVideo: db.prepare(`
      INSERT INTO videos (folder_id, file_path, file_name, file_size, file_mtime, file_hash, media_kind)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        media_kind = excluded.media_kind,
        file_size = excluded.file_size,
        file_mtime = excluded.file_mtime,
        file_hash = excluded.file_hash,
        deleted_at = NULL
      RETURNING id
    `),
    getVideoById: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, file_hash as fileHash,
             duration_ms as durationMs, width, height, frame_count as frameCount,
             media_kind as mediaKind, deleted_at as deletedAt, created_at as createdAt
      FROM videos WHERE id = ?
    `),
    getVideoByPath: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, file_hash as fileHash,
             duration_ms as durationMs, width, height, frame_count as frameCount,
             media_kind as mediaKind, deleted_at as deletedAt, created_at as createdAt
      FROM videos WHERE file_path = ?
    `),
    updateVideoMeta: db.prepare(`
      UPDATE videos SET
        duration_ms = COALESCE(?, duration_ms),
        width       = COALESCE(?, width),
        height      = COALESCE(?, height),
        frame_count = COALESCE(?, frame_count)
      WHERE id = ?
    `),
    softDeleteVideo: db.prepare(`
      UPDATE videos SET deleted_at = CURRENT_TIMESTAMP WHERE file_path = ?
    `),
    getFramePhotosByVideo: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, file_hash as fileHash,
             width, height, taken_at as takenAt, lat, lng,
             embed_status as embedStatus, video_id as videoId, frame_time_ms as frameTimeMs,
             deleted_at as deletedAt, created_at as createdAt, updated_at as updatedAt
      FROM photos
      WHERE video_id = ? AND deleted_at IS NULL
      ORDER BY frame_time_ms ASC
    `),

    // 照片字段映射（复用）
    getPhoto: db.prepare(`
      SELECT ${PHOTO_COLUMNS}
      FROM photos p ${MEDIA_JOIN}
      WHERE p.id = ?
    `),
    getPhotoByPath: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, file_hash as fileHash,
             width, height, taken_at as takenAt, lat, lng,
             embed_status as embedStatus, video_id as videoId, frame_time_ms as frameTimeMs,
             is_screenshot as isScreenshot,
             deleted_at as deletedAt, created_at as createdAt, updated_at as updatedAt
      FROM photos WHERE file_path = ?
    `),
    getPhotos: db.prepare(`
      SELECT id, folder_id as folderId, file_path as filePath, file_name as fileName,
             file_size as fileSize, file_mtime as fileMtime, file_hash as fileHash,
             width, height, taken_at as takenAt, lat, lng,
             embed_status as embedStatus, video_id as videoId, frame_time_ms as frameTimeMs,
             deleted_at as deletedAt, created_at as createdAt, updated_at as updatedAt
      FROM photos
      WHERE deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `),
    // 代表照片：每组 hash 取最早入库的（MIN(id)），带副本计数
    getRepresentativePhotos: db.prepare(`
      SELECT ${PHOTO_COLUMNS},
             (SELECT COUNT(*) FROM photos p2
              WHERE p2.file_hash = p.file_hash AND p2.deleted_at IS NULL) as duplicateCount
      FROM photos p
      ${MEDIA_JOIN}
      WHERE p.deleted_at IS NULL
        AND p.id = (
          SELECT MIN(p3.id) FROM photos p3
          WHERE p3.file_hash = p.file_hash AND p3.deleted_at IS NULL
        )
        AND p.file_hash NOT IN (SELECT file_hash FROM hidden_items)
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `),
    getRepresentativeByHash: db.prepare(`
      SELECT ${PHOTO_COLUMNS},
             (SELECT COUNT(*) FROM photos p2
              WHERE p2.file_hash = p.file_hash AND p2.deleted_at IS NULL) as duplicateCount
      FROM photos p
      ${MEDIA_JOIN}
      WHERE p.file_hash = ? AND p.deleted_at IS NULL
      ORDER BY p.id ASC
      LIMIT 1
    `),
    getPhotoLocations: db.prepare(`
      SELECT p.file_path as filePath, p.folder_id as folderId,
             f.path as folderPath
      FROM photos p
      JOIN watched_folders f ON p.folder_id = f.id
      WHERE p.file_hash = ? AND p.deleted_at IS NULL
      ORDER BY p.id ASC
    `),
    getPhotoWithCaption: db.prepare(`
      SELECT ${PHOTO_COLUMNS},
             c.text as caption,
             o.text as ocrText
      FROM photos p
      ${MEDIA_JOIN}
      LEFT JOIN captions c ON p.file_hash = c.file_hash
      LEFT JOIN image_ocr o ON p.file_hash = o.file_hash
      WHERE p.id = ?
    `),
    updatePhotoMeta: db.prepare(`
      UPDATE photos SET width = ?, height = ?, taken_at = ?, lat = ?, lng = ?, pages = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `),
    softDeletePhoto: db.prepare(`
      UPDATE photos SET deleted_at = CURRENT_TIMESTAMP WHERE file_path = ?
    `),
    updatePhotoPath: db.prepare(`
      UPDATE photos SET file_path = ?, file_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `),
    markDuplicateProcessed: db.prepare(`
      UPDATE photos SET embed_status = 'done', updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `),

    // 截图标记（core/screenshot.ts 判定；NULL = 未判，回填补）
    setPhotoScreenshot: db.prepare(`UPDATE photos SET is_screenshot = ? WHERE id = ?`),
    getScreenshotFlagForHash: db.prepare(`
      SELECT MAX(is_screenshot) as flag FROM photos WHERE file_hash = ? AND deleted_at IS NULL
    `),
    photosMissingScreenshotFlag: db.prepare(`
      SELECT id, file_path as filePath, file_name as fileName, file_hash as fileHash
      FROM photos
      WHERE is_screenshot IS NULL AND deleted_at IS NULL AND video_id IS NULL
      ORDER BY id
      LIMIT ?
    `),

    // 跳过的数据集目录
    listSkippedFolders: db.prepare(`
      SELECT path, folder_id as folderId, reason, file_count as fileCount,
             override, created_at as createdAt
      FROM skipped_folders ORDER BY path
    `),
    listSkippedFoldersByFolder: db.prepare(`
      SELECT path, folder_id as folderId, reason, file_count as fileCount,
             override, created_at as createdAt
      FROM skipped_folders WHERE folder_id = ? ORDER BY path
    `),
    addSkippedFolder: db.prepare(`
      INSERT INTO skipped_folders (path, folder_id, reason, file_count) VALUES (?, ?, 'dataset', ?)
      ON CONFLICT(path) DO UPDATE SET file_count = excluded.file_count
    `),
    setSkippedFolderOverride: db.prepare(`UPDATE skipped_folders SET override = ? WHERE path = ?`),
    deleteSkippedFoldersByFolder: db.prepare(`DELETE FROM skipped_folders WHERE folder_id = ?`),

    addToQueue: db.prepare(`
      INSERT INTO index_queue (photo_id, task_type, priority, origin) VALUES (?, ?, ?, ?)
    `),
    hasOpenTask: db.prepare(`
      SELECT 1 FROM index_queue
      WHERE photo_id = ? AND task_type = ? AND status IN ('pending', 'processing')
      LIMIT 1
    `),
    hasOpenOrFailedTask: db.prepare(`
      SELECT 1 FROM index_queue
      WHERE photo_id = ? AND task_type = ? AND status IN ('pending', 'processing', 'error')
      LIMIT 1
    `),
    getNextTask: db.prepare(`
      SELECT id, photo_id as photoId, task_type as taskType, origin FROM index_queue
      WHERE status = 'pending'
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `),
    /**
     * 低内存模式（服务器）的取任务顺序：先按"模型组"再按优先级 —— 缩略图（不占模型）照旧最先，
     * 然后 embedding 组（embed + extract_frames 都走 EmbeddingGemma），再人脸、最后 OCR。
     * 默认顺序里 face(8) 插在 embed(10) 和 extract_frames(6) 之间，视频多的库每个视频都要
     * 换一次模型组；分组后换组只发生在批与批之间（推理 worker 卸载/重载模型才便宜得起）。
     * 组内仍按 priority DESC, id ASC，与默认顺序一致。
     */
    getNextTaskGrouped: db.prepare(`
      SELECT id, photo_id as photoId, task_type as taskType, origin FROM index_queue
      WHERE status = 'pending'
      ORDER BY CASE task_type
        WHEN 'thumbnail' THEN 0
        WHEN 'embed' THEN 1
        WHEN 'extract_frames' THEN 1
        WHEN 'face' THEN 2
        WHEN 'ocr' THEN 3
        ELSE 0 END ASC,
        priority DESC, id ASC
      LIMIT 1
    `),
    getNextLiveTask: db.prepare(`
      SELECT id, photo_id as photoId, task_type as taskType, origin FROM index_queue
      WHERE status = 'pending' AND origin = 'live'
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `),
    countLivePendingTasks: db.prepare(`
      SELECT COUNT(*) as n FROM index_queue WHERE status = 'pending' AND origin = 'live'
    `),
    peekNextTask: db.prepare(`
      SELECT id, photo_id as photoId, task_type as taskType FROM index_queue
      WHERE status = 'pending'
      ORDER BY priority DESC, id ASC
      LIMIT 1
    `),
    markTaskProcessing: db.prepare(`UPDATE index_queue SET status = 'processing' WHERE id = ?`),
    completeTask: db.prepare(`UPDATE index_queue SET status = 'done', error_msg = ? WHERE id = ?`),
    resetTask: db.prepare(`UPDATE index_queue SET status = 'pending' WHERE id = ?`),
    failTask: db.prepare(`
      UPDATE index_queue SET status = 'error', error_msg = ?, retry_count = retry_count + 1 WHERE id = ?
    `),
    recoverStuckTasks: db.prepare(`
      UPDATE index_queue SET status = 'pending' WHERE status = 'processing'
    `),
    // 时长已知（非损坏）却没有任何片段向量的视频 —— 典型是索引时模型未就绪
    getVideosWithoutSegments: db.prepare(`
      SELECT v.id FROM videos v
      WHERE v.deleted_at IS NULL
        AND v.duration_ms > 0
        -- frame_count 非空 = 扫过了（太短抽不出片段的视频也会写 1）；只补"没扫完"的，避免每次启动重跑
        AND v.frame_count IS NULL
        AND v.id NOT IN (SELECT video_id FROM video_segments)
        AND v.id NOT IN (SELECT photo_id FROM index_queue WHERE task_type = 'extract_frames' AND status IN ('pending', 'processing', 'error'))
    `),
    // ≤0.5.0 打包版 spawn 不了 asar 里的 ffmpeg：探测时长失败，视频被标成"扫过了、读不到"（frame_count=0）。
    // 先把这些视频的标记清掉，下面的"缺片段"补排才会选中它们
    resetSpawnFailedVideos: db.prepare(`
      UPDATE videos SET frame_count = NULL
      WHERE frame_count = 0 AND id IN (
        SELECT photo_id FROM index_queue
        WHERE task_type = 'extract_frames' AND status = 'error'
          AND (error_msg LIKE 'spawn ENOTDIR%' OR error_msg LIKE 'spawn ENOENT%')
      )
    `),
    // 环境原因的失败（模型没就绪、推理进程挂了、≤0.5.0 打包版 spawn 不了 asar 里的 ffmpeg）：
    // 启动时清掉，让下面的"缺向量 / 缺片段"补排重新跑；坏文件的错误留给任务面板
    clearModelNotReadyErrors: db.prepare(`
      DELETE FROM index_queue
      WHERE task_type IN ('embed', 'extract_frames') AND status = 'error'
        AND (error_msg LIKE 'Embedding model not ready%' OR error_msg LIKE 'Inference process exited%'
          OR error_msg LIKE 'spawn ENOTDIR%' OR error_msg LIKE 'spawn ENOENT%')
    `),
    getPhotosWithoutEmbedding: db.prepare(`
      SELECT p.id, p.file_hash FROM photos p
      WHERE p.deleted_at IS NULL
        AND p.file_hash IS NOT NULL
        AND p.file_hash NOT IN (SELECT file_hash FROM image_vec_map)
        AND (p.video_id IS NULL OR p.video_id NOT IN (SELECT id FROM videos WHERE media_kind = 'audio'))
        AND p.id NOT IN (SELECT photo_id FROM index_queue WHERE task_type IN ('embed', 'thumbnail') AND status IN ('pending', 'processing', 'error'))
    `),
    getQueueStats: db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) as processing,
        COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) as done,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as error
      FROM index_queue
    `),
    // 任务面板
    getTaskCounts: db.prepare(`
      SELECT task_type as taskType, status, COUNT(*) as n FROM index_queue GROUP BY task_type, status
    `),
    // extract_frames 的 photo_id 指向 videos.id，其余指向 photos.id
    getActiveTaskRows: db.prepare(`
      ${TASK_ROW_SELECT}
      WHERE q.status IN ('processing', 'pending')
      ORDER BY q.status = 'processing' DESC, q.priority DESC, q.id ASC
      LIMIT ?
    `),
    getErrorTaskRows: db.prepare(`
      ${TASK_ROW_SELECT}
      WHERE q.status = 'error'
      ORDER BY q.id DESC
      LIMIT ?
    `),
    getMediaTotals: db.prepare(`
      SELECT media_kind as kind, COUNT(*) as total,
             SUM(CASE WHEN frame_count > 0 THEN 1 ELSE 0 END) as done,
             SUM(CASE WHEN duration_ms > 0 THEN (duration_ms + ${SEGMENT_MS - 1}) / ${SEGMENT_MS} ELSE 0 END) as expected
      FROM videos WHERE deleted_at IS NULL
      GROUP BY media_kind
    `),
    getSegmentsDone: db.prepare(`
      SELECT COUNT(*) as n FROM video_segments s
      JOIN videos v ON v.id = s.video_id
      WHERE v.deleted_at IS NULL
    `),
    retryFailedTasks: db.prepare(`
      UPDATE index_queue SET status = 'pending', error_msg = NULL
      WHERE status = 'error' AND (? IS NULL OR id IN (SELECT value FROM json_each(?)))
    `),
    clearFailedTasks: db.prepare(`DELETE FROM index_queue WHERE status = 'error'`),
    pruneDoneTasks: db.prepare(`DELETE FROM index_queue WHERE status = 'done'`),
    getLibraryCounts: db.prepare(`
      SELECT ${MEDIA_KIND_EXPR} as kind, COUNT(*) as n
      FROM photos p
      ${MEDIA_JOIN}
      WHERE p.deleted_at IS NULL
        AND p.id = (
          SELECT MIN(p3.id) FROM photos p3
          WHERE p3.file_hash = p.file_hash AND p3.deleted_at IS NULL
        )
        AND p.file_hash NOT IN (SELECT file_hash FROM hidden_items)
      GROUP BY kind
    `),
    getHashesInFolder: db.prepare(`
      SELECT DISTINCT file_hash FROM photos WHERE folder_id = ? AND deleted_at IS NULL
    `),
    countFavorites: db.prepare(`
      SELECT COUNT(*) as n FROM favorites f
      WHERE EXISTS (SELECT 1 FROM photos p WHERE p.file_hash = f.file_hash AND p.deleted_at IS NULL)
    `),
    addFavorite: db.prepare(`INSERT OR IGNORE INTO favorites (file_hash) VALUES (?)`),
    removeFavorite: db.prepare(`DELETE FROM favorites WHERE file_hash = ?`),
    getFavoriteHashes: db.prepare(`SELECT file_hash FROM favorites`),
    getSmartAlbums: db.prepare(`
      SELECT id, name, query, filters, sort_order as sortOrder, created_at as createdAt, updated_at as updatedAt
      FROM smart_albums ORDER BY sort_order, id
    `),
    getSmartAlbum: db.prepare(`
      SELECT id, name, query, filters, sort_order as sortOrder, created_at as createdAt, updated_at as updatedAt
      FROM smart_albums WHERE id = ?
    `),
    insertSmartAlbum: db.prepare(`
      INSERT INTO smart_albums (name, query, filters, sort_order)
      VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order), -1) + 1 FROM smart_albums))
    `),
    updateSmartAlbum: db.prepare(`
      UPDATE smart_albums SET name = ?, query = ?, filters = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `),
    deleteSmartAlbum: db.prepare(`DELETE FROM smart_albums WHERE id = ?`),
    setSmartAlbumOrder: db.prepare(`UPDATE smart_albums SET sort_order = ? WHERE id = ?`),
    getHashesForPerson: db.prepare(`SELECT DISTINCT file_hash FROM faces WHERE person_id = ?`),
    getPhotoStats: db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(DISTINCT p.file_hash) as uniqueTotal,
        -- 和 uniqueTotal 一样按内容计数：同一张照片放在两个文件夹里只算一份，否则进度会超过 100%
        COUNT(DISTINCT CASE WHEN p.width IS NOT NULL THEN p.file_hash END) as thumbnailed,
        -- 音频封面/波形图按设计不做图片向量，视同已索引
        COUNT(DISTINCT CASE WHEN p.embed_status = 'done'
                   OR p.video_id IN (SELECT id FROM videos WHERE media_kind = 'audio')
                 THEN p.file_hash END) as indexed,
        (SELECT COUNT(DISTINCT file_hash) FROM image_ocr) as ocred
      FROM photos p
      WHERE p.deleted_at IS NULL
    `),

    // 内容操作（按 file_hash）
    hasEmbeddingForHash: db.prepare(`
      SELECT 1 FROM image_vec_map m
      JOIN image_vecs v ON v.rowid = m.rowid
      WHERE m.file_hash = ?
    `),
    hasCaptionForHash: db.prepare(`SELECT 1 FROM captions WHERE file_hash = ?`),
    hasOcrForHash: db.prepare(`SELECT 1 FROM image_ocr WHERE file_hash = ?`),
    insertVecMap: db.prepare(`
      INSERT OR IGNORE INTO image_vec_map (file_hash) VALUES (?)
    `),
    getVecMapRowid: db.prepare(`SELECT rowid FROM image_vec_map WHERE file_hash = ?`),
    getVecByRowid: db.prepare(`SELECT embedding FROM image_vecs WHERE rowid = ?`),
    insertVec: db.prepare(`
      INSERT INTO image_vecs (rowid, embedding) VALUES (?, ?)
    `),
    updateVec: db.prepare(`
      UPDATE image_vecs SET embedding = ? WHERE rowid = ?
    `),
    deleteVecByRowid: db.prepare(`DELETE FROM image_vecs WHERE rowid = ?`),
    deleteVecMapByHash: db.prepare(`DELETE FROM image_vec_map WHERE file_hash = ?`),
    updateEmbedStatusByHash: db.prepare(`
      UPDATE photos SET embed_status = 'done' WHERE file_hash = ? AND deleted_at IS NULL
    `),
    saveCaption: db.prepare(`
      INSERT INTO captions (file_hash, text) VALUES (?, ?)
      ON CONFLICT(file_hash) DO UPDATE SET text = excluded.text
    `),
    getCaption: db.prepare(`SELECT text FROM captions WHERE file_hash = ?`),
    saveOcrText: db.prepare(`
      INSERT INTO image_ocr (file_hash, text) VALUES (?, ?)
      ON CONFLICT(file_hash) DO UPDATE SET text = excluded.text, detected_at = CURRENT_TIMESTAMP
    `),
    getOcrText: db.prepare(`SELECT text FROM image_ocr WHERE file_hash = ?`),
    deleteOcrByHash: db.prepare(`DELETE FROM image_ocr WHERE file_hash = ?`),
    // 色板
    saveItemColors: db.prepare(`
      INSERT INTO item_colors (file_hash, palette, bucket_mask) VALUES (?, ?, ?)
      ON CONFLICT(file_hash) DO UPDATE SET palette = excluded.palette, bucket_mask = excluded.bucket_mask
    `),
    getItemColors: db.prepare(`SELECT palette, bucket_mask as mask FROM item_colors WHERE file_hash = ?`),
    hasColorsForHash: db.prepare(`SELECT 1 FROM item_colors WHERE file_hash = ?`),
    getHashesForColorMask: db.prepare(`SELECT file_hash FROM item_colors WHERE (bucket_mask & ?) != 0`).pluck(),
    getHashesMissingColors: db.prepare(`
      SELECT DISTINCT p.file_hash FROM photos p
      WHERE p.deleted_at IS NULL AND p.file_hash IS NOT NULL
        AND p.file_hash NOT IN (SELECT file_hash FROM item_colors)
      LIMIT ?
    `).pluck(),
    deleteItemColorsByHash: db.prepare(`DELETE FROM item_colors WHERE file_hash = ?`),
    deleteFavoriteByHash: db.prepare(`DELETE FROM favorites WHERE file_hash = ?`),
    deleteItemTagsByHash: db.prepare(`DELETE FROM item_tags WHERE file_hash = ?`),
    deleteItemSourceByHash: db.prepare(`DELETE FROM item_sources WHERE file_hash = ?`),
    deleteAutotagDoneByHash: db.prepare(`DELETE FROM autotag_done WHERE file_hash = ?`),
    // 等待 OCR 的照片：已有 embedding 但还没 OCR 结果
    clearAllOcr: db.prepare(`DELETE FROM image_ocr`),
    getPendingOcrPhotos: db.prepare(`
      SELECT p.id, p.file_hash as fileHash, p.file_path as filePath
      FROM photos p
      WHERE p.deleted_at IS NULL
        AND p.file_hash IS NOT NULL
        AND p.embed_status = 'done'
        AND p.file_hash NOT IN (SELECT file_hash FROM image_ocr)
        AND p.id NOT IN (SELECT photo_id FROM index_queue WHERE task_type = 'ocr' AND status IN ('pending', 'processing'))
      GROUP BY p.file_hash
    `),
    deleteImageVecByHash: db.prepare(`SELECT rowid FROM image_vec_map WHERE file_hash = ?`), // used to get rowid for vec deletion
    deleteCaptionByHash: db.prepare(`DELETE FROM captions WHERE file_hash = ?`),

    // 搜索
    // KNN 向量搜索（sqlite-vec）
    // sqlite-vec KNN: 先查 rowid+distance，再通过 map 映射到 file_hash
    sampleImageVecs: db.prepare(`
      SELECT embedding FROM image_vecs WHERE rowid IN (SELECT rowid FROM image_vec_map ORDER BY random() LIMIT ?)
    `).pluck(),
    sampleSegmentVecs: db.prepare(`
      SELECT embedding FROM video_segment_vecs WHERE rowid IN (SELECT rowid FROM video_segment_vec_map ORDER BY random() LIMIT ?)
    `).pluck(),
    countImageVecs: db.prepare(`SELECT COUNT(*) FROM image_vec_map`).pluck(),
    countSegmentVecs: db.prepare(`SELECT COUNT(*) FROM video_segment_vec_map`).pluck(),
    searchVecKnnRaw: db.prepare(`
      SELECT rowid, distance
      FROM image_vecs
      WHERE embedding MATCH ?
        AND k = ?
      ORDER BY distance
    `),
    getHashByRowid: db.prepare(`SELECT file_hash FROM image_vec_map WHERE rowid = ?`),

    // ─── 视频片段 ────────────────────────────────────────────────
    insertVideoSegment: db.prepare(`
      INSERT INTO video_segments (video_id, start_ms, end_ms, file_hash)
      VALUES (?, ?, ?, ?)
    `),
    insertVideoSegmentVecMap: db.prepare(`
      INSERT OR IGNORE INTO video_segment_vec_map (segment_id) VALUES (?)
    `),
    getVideoSegmentVecRowid: db.prepare(`
      SELECT rowid FROM video_segment_vec_map WHERE segment_id = ?
    `),
    insertVideoSegmentVec: db.prepare(`
      INSERT INTO video_segment_vecs (rowid, embedding) VALUES (?, ?)
    `),
    updateVideoSegmentVec: db.prepare(`
      UPDATE video_segment_vecs SET embedding = ? WHERE rowid = ?
    `),
    hasVideoSegmentForHash: db.prepare(`
      SELECT 1 FROM video_segments WHERE file_hash = ?
    `),
    getVideoSegmentsByVideo: db.prepare(`
      SELECT id, video_id as videoId, start_ms as startMs, end_ms as endMs, file_hash as fileHash
      FROM video_segments WHERE video_id = ? ORDER BY start_ms
    `),
    getVideoSegmentIdsByVideo: db.prepare(`
      SELECT id FROM video_segments WHERE video_id = ?
    `),
    deleteVideoSegmentVec: db.prepare(`
      DELETE FROM video_segment_vecs WHERE rowid = ?
    `),
    deleteVideoSegmentVecMap: db.prepare(`
      DELETE FROM video_segment_vec_map WHERE segment_id = ?
    `),
    deleteVideoSegmentsByVideo: db.prepare(`
      DELETE FROM video_segments WHERE video_id = ?
    `),
    // 片段 KNN：先拿 rowid + distance，再 join 回 segments
    searchVideoSegmentKnnRaw: db.prepare(`
      SELECT rowid, distance
      FROM video_segment_vecs
      WHERE embedding MATCH ?
        AND k = ?
      ORDER BY distance
    `),
    getVideoSegmentByVecRowid: db.prepare(`
      SELECT s.id as segmentId, s.video_id as videoId,
             s.start_ms as startMs, s.end_ms as endMs
      FROM video_segment_vec_map m
      JOIN video_segments s ON s.id = m.segment_id
      WHERE m.rowid = ?
    `),
    // 获取所有向量（用于 face clustering 等需要全量向量的场景）
    getAllImageVecs: db.prepare(`
      SELECT m.file_hash, v.embedding
      FROM image_vecs v
      JOIN image_vec_map m ON m.rowid = v.rowid
    `),
    // 文件名搜索（LIKE 模糊匹配，按 hash 去重）
    // 音视频的代表图路径在 <userData>/video_frames/ 下，要匹配源文件的路径而不是代表图的
    searchByFileName: db.prepare(`
      SELECT DISTINCT p.file_hash FROM photos p
      ${MEDIA_JOIN}
      WHERE p.deleted_at IS NULL
        AND (COALESCE(v.file_name, p.file_name) LIKE ? ESCAPE '!' OR COALESCE(v.file_path, p.file_path) LIKE ? ESCAPE '!')
      LIMIT ?
    `),
    // OCR 全文搜索（FTS5 BM25）
    searchByOcr: db.prepare(`
      SELECT o.file_hash, bm25(image_ocr_fts) as score
      FROM image_ocr_fts
      JOIN image_ocr o ON image_ocr_fts.rowid = o.id
      WHERE image_ocr_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `),
    getPhotosWithGPS: db.prepare(`
      SELECT ${PHOTO_COLUMNS}
      FROM photos p
      ${MEDIA_JOIN}
      WHERE p.deleted_at IS NULL
        AND p.lat IS NOT NULL AND p.lng IS NOT NULL
        AND p.file_hash NOT IN (SELECT file_hash FROM hidden_items)
        AND p.id = (
          SELECT MIN(p3.id) FROM photos p3
          WHERE p3.file_hash = p.file_hash AND p3.deleted_at IS NULL
        )
      ORDER BY p.taken_at DESC
      LIMIT ?
    `),

    // 人脸相关
    saveFace: db.prepare(`
      INSERT INTO faces (file_hash, face_index, bbox, confidence, embedding, quality)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_hash, face_index) DO UPDATE SET
        bbox = excluded.bbox, confidence = excluded.confidence, embedding = excluded.embedding, quality = excluded.quality
      RETURNING id
    `),
    // 写入 face_vecs（与 faces.id 同 rowid）。INSERT OR REPLACE 处理 ON CONFLICT 路径。
    insertFaceVec: db.prepare(`
      INSERT INTO face_vecs(rowid, embedding) VALUES (?, ?)
    `),
    updateFaceVec: db.prepare(`
      UPDATE face_vecs SET embedding = ? WHERE rowid = ?
    `),
    deleteFaceVec: db.prepare(`
      DELETE FROM face_vecs WHERE rowid = ?
    `),
    // 给 deleteContentByHash 用：先按 hash 找到 faces.id，再删 face_vecs + faces
    getFaceIdsByHash: db.prepare(`SELECT id, person_id as personId FROM faces WHERE file_hash = ?`),
    deleteFaceRejections: db.prepare(`DELETE FROM face_rejections WHERE face_id = ?`),
    deleteFacesByHash: db.prepare(`DELETE FROM faces WHERE file_hash = ?`),
    // KNN：rowid 即 faces.id；join faces 拿 person_id
    searchFaceKnnRaw: db.prepare(`
      SELECT v.rowid as faceId, f.person_id as personId, v.distance
      FROM face_vecs v
      JOIN faces f ON f.id = v.rowid
      WHERE v.embedding MATCH ?
        AND v.k = ?
      ORDER BY v.distance
    `),
    updateFaceStatusByHash: db.prepare(`
      UPDATE photos SET face_status = 'done' WHERE file_hash = ? AND deleted_at IS NULL
    `),
    hasFacesForHash: db.prepare(`SELECT 1 FROM faces WHERE file_hash = ? LIMIT 1`),
    getFacesByHash: db.prepare(`
      SELECT f.id, f.face_index as faceIndex, f.bbox, f.confidence, f.person_id as personId, p.name as personName
      FROM faces f
      LEFT JOIN people p ON f.person_id = p.id
      WHERE f.file_hash = ?
      ORDER BY f.face_index
    `),
    getAllFaceEmbeddings: db.prepare(`
      SELECT id, embedding, confidence, person_id as personId FROM faces
    `),
    createPerson: db.prepare(`
      INSERT INTO people (name, cover_face_id, face_count) VALUES (NULL, ?, 1) RETURNING id
    `),
    updatePersonFaceCount: db.prepare(`
      UPDATE people SET
        face_count = (SELECT COUNT(*) FROM faces WHERE person_id = people.id),
        cover_face_id = (SELECT id FROM faces WHERE person_id = people.id ORDER BY quality DESC, confidence DESC LIMIT 1)
      WHERE id = ?
    `),
    getPeople: db.prepare(`
      SELECT p.id, p.name, p.cover_face_id as coverFaceId, p.face_count as faceCount,
             (SELECT COUNT(DISTINCT f.file_hash) FROM faces f WHERE f.person_id = p.id
                AND f.file_hash NOT IN (SELECT file_hash FROM hidden_items)) as photoCount,
             p.hidden, p.created_at as createdAt
      FROM people p
      WHERE p.face_count > 0
      ORDER BY photoCount DESC
    `),
    getPersonPhotos: db.prepare(`
      SELECT ph.id, ph.folder_id as folderId, ph.file_path as filePath, ph.file_name as fileName,
             ph.file_size as fileSize, ph.file_mtime as fileMtime, ph.file_hash as fileHash,
             ph.width, ph.height, ph.taken_at as takenAt, ph.lat, ph.lng,
             ph.embed_status as embedStatus, ph.deleted_at as deletedAt, ph.created_at as createdAt, ph.updated_at as updatedAt
      FROM photos ph
      WHERE ph.deleted_at IS NULL
        AND ph.file_hash IN (SELECT DISTINCT f.file_hash FROM faces f WHERE f.person_id = ?)
        AND ph.file_hash NOT IN (SELECT file_hash FROM hidden_items)
        AND ph.id = (
          SELECT MIN(p2.id) FROM photos p2
          WHERE p2.file_hash = ph.file_hash AND p2.deleted_at IS NULL
        )
      ORDER BY ph.taken_at DESC
      LIMIT ?
    `),
    updatePersonName: db.prepare(`UPDATE people SET name = ? WHERE id = ?`),
    mergePeopleFaces: db.prepare(`UPDATE faces SET person_id = ? WHERE person_id = ?`),
    deletePerson: db.prepare(`DELETE FROM people WHERE id = ?`),
    getPendingFacePhotos: db.prepare(`
      SELECT p.id, p.file_hash as fileHash, p.file_path as filePath
      FROM photos p
      WHERE p.deleted_at IS NULL
        AND (p.face_status IS NULL OR p.face_status = 'pending')
        AND p.id = (
          SELECT MIN(p2.id) FROM photos p2
          WHERE p2.file_hash = p.file_hash AND p2.deleted_at IS NULL
        )
    `),
    setFacePersonId: db.prepare(`UPDATE faces SET person_id = ? WHERE id = ?`),
    assignFace: db.prepare(`UPDATE faces SET person_id = ?, assigned_by = ?, cluster_state = 0 WHERE id = ?`),
    // 自动归属只动仍未归属的脸：聚类跑的过程中用户可能已经手动处理过
    autoAssignFace: db.prepare(`UPDATE faces SET person_id = ?, assigned_by = 'auto', cluster_state = 0 WHERE id = ? AND person_id IS NULL`),
    getPersonMeta: db.prepare(`SELECT id, name FROM people WHERE id = ?`),
    setFaceDormant: db.prepare(`UPDATE faces SET cluster_state = 1 WHERE id = ? AND person_id IS NULL`),
    getPersonCentroids: db.prepare(`SELECT id, name, centroid, face_count as count, hidden FROM people WHERE face_count > 0`),
    getUnassignedFaces: db.prepare(`SELECT id, embedding, quality FROM faces WHERE person_id IS NULL AND cluster_state = ?`),
    countUnassigned: db.prepare(`SELECT COUNT(*) as n FROM faces WHERE person_id IS NULL AND cluster_state = 0`),
    hasAnyFaces: db.prepare(`SELECT 1 FROM faces LIMIT 1`),
    getVideoFrameHashesForFaceRescan: db.prepare(`
      SELECT DISTINCT p.file_hash FROM photos p JOIN videos v ON v.id = p.video_id
      WHERE p.deleted_at IS NULL AND v.media_kind = 'video'
        AND NOT EXISTS (
          SELECT 1 FROM faces f JOIN people pe ON pe.id = f.person_id
          WHERE f.file_hash = p.file_hash AND pe.name IS NOT NULL AND pe.name != ''
        )
    `).pluck(),
    setFacePendingByHash: db.prepare(`UPDATE photos SET face_status = 'pending' WHERE file_hash = ? AND deleted_at IS NULL`),
    getPersonEmbeddings: db.prepare(`SELECT embedding FROM faces WHERE person_id = ?`),
    setPersonCentroid: db.prepare(`UPDATE people SET centroid = ? WHERE id = ?`),
    getPersonRow: db.prepare(`SELECT centroid, face_count as count FROM people WHERE id = ?`),
    getRejections: db.prepare(`SELECT face_id as faceId, person_id as personId FROM face_rejections`),
    insertRejection: db.prepare(`INSERT OR IGNORE INTO face_rejections(face_id, person_id) VALUES (?, ?)`),
    deleteRejection: db.prepare(`DELETE FROM face_rejections WHERE face_id = ? AND person_id = ?`),
    moveRejections: db.prepare(`UPDATE OR IGNORE face_rejections SET person_id = ? WHERE person_id = ?`),
    deleteRejectionsForPerson: db.prepare(`DELETE FROM face_rejections WHERE person_id = ?`),
    getDismissedPairs: db.prepare(`SELECT a, b FROM person_dismissed_pairs`),
    insertDismissedPair: db.prepare(`INSERT OR IGNORE INTO person_dismissed_pairs(a, b) VALUES (?, ?)`),
    deleteDismissedForPerson: db.prepare(`DELETE FROM person_dismissed_pairs WHERE a = ? OR b = ?`),
    getFacePerson: db.prepare(`SELECT person_id as personId FROM faces WHERE id = ?`),
    setPersonHidden: db.prepare(`UPDATE people SET hidden = ? WHERE id = ?`),
    getPersonFaces: db.prepare(`
      SELECT id, file_hash as fileHash, bbox, quality, assigned_by as assignedBy
      FROM faces WHERE person_id = ? ORDER BY quality DESC LIMIT ?
    `),
    getFaceCoverInfo: db.prepare(`SELECT file_hash as fileHash, bbox FROM faces WHERE id = ?`),
    hasLivePhotoForHash: db.prepare(`SELECT 1 FROM photos WHERE file_hash = ? AND deleted_at IS NULL LIMIT 1`),
    checkFaceStatusColumn: db.prepare(`SELECT face_status FROM photos LIMIT 0`),
  }
  // VIXEL_PROFILE=1 时给每条语句计时，慢查询按语句名打印
  instrumentStatements(stmts)

  const toF32 = (b: Buffer): Float32Array => {
    // 拷贝一份：better-sqlite3 的 Buffer 可能落在共享池上，byteOffset 不一定 4 字节对齐
    const out = new Float32Array(b.byteLength / 4)
    new Uint8Array(out.buffer).set(b)
    return out
  }
  const unassigned = (state: 0 | 1): PendingFace[] =>
    (stmts.getUnassignedFaces.all(state) as Array<{ id: number; embedding: Buffer; quality: number | null }>)
      .map((r) => ({ id: r.id, embedding: toF32(r.embedding), quality: r.quality ?? 1 }))
  /** 计数 / 封面 / 质心全量重算；人物空了就删 */
  const refreshPerson = (personId: number): void => {
    stmts.updatePersonFaceCount.run(personId)
    const rows = stmts.getPersonEmbeddings.all(personId) as Array<{ embedding: Buffer }>
    if (rows.length === 0) {
      stmts.deletePerson.run(personId)
      stmts.deleteRejectionsForPerson.run(personId)
      stmts.deleteDismissedForPerson.run(personId, personId)
      return
    }
    const dim = rows[0].embedding.byteLength / 4
    const sum = new Float64Array(dim)
    for (const r of rows) { const e = toF32(r.embedding); for (let i = 0; i < dim; i++) sum[i] += e[i] }
    let n = 0
    for (let i = 0; i < dim; i++) n += sum[i] * sum[i]
    n = Math.sqrt(n) || 1
    const c = Float32Array.from(sum, (v) => v / n)
    stmts.setPersonCentroid.run(Buffer.from(c.buffer), personId)
  }
  /** 删一个 hash 的所有人脸（含 ANN 行），受影响的人物重算 / 清空 */
  const deleteFacesForHash = (hash: string): void => {
    const rows = stmts.getFaceIdsByHash.all(hash) as Array<{ id: number; personId: number | null }>
    if (rows.length === 0) return
    for (const f of rows) { stmts.deleteFaceVec.run(f.id); stmts.deleteFaceRejections.run(f.id) }
    stmts.deleteFacesByHash.run(hash)
    for (const pid of new Set(rows.map((r) => r.personId).filter((x): x is number => x != null))) refreshPerson(pid)
  }
  /** 某个 hash 的全部派生内容：图像向量 / 人脸 / caption / OCR（FTS 随触发器清） */
  const filteredStmts = new Map<string, Database.Statement>()
  const deleteContent = (hash: string): void => {
    const row = stmts.deleteImageVecByHash.get(hash) as { rowid: bigint | number } | undefined
    if (row) {
      stmts.deleteVecByRowid.run(Number(row.rowid))
      stmts.deleteVecMapByHash.run(hash)
    }
    deleteFacesForHash(hash)
    stmts.deleteCaptionByHash.run(hash)
    stmts.deleteOcrByHash.run(hash)
    stmts.deleteFavoriteByHash.run(hash)
    stmts.deleteItemTagsByHash.run(hash)
    stmts.deleteItemSourceByHash.run(hash)
    stmts.deleteAutotagDoneByHash.run(hash)
    stmts.deleteItemColorsByHash.run(hash)
  }
  /**
   * 软删某视频的全部帧 photo（beforeCommit 在同一事务里先执行），
   * 再对已无存活引用的帧 hash 清内容。返回这些 hash，调用方据此删磁盘缩略图。
   */
  const dropVideoFrames = (videoId: number, beforeCommit?: () => void): string[] => {
    const frames = stmts.getFramePhotosByVideo.all(videoId) as Photo[]
    const frameHashes = new Set(frames.map((f) => f.fileHash).filter((h): h is string => !!h))
    return db.transaction(() => {
      for (const f of frames) stmts.softDeletePhoto.run(f.filePath)
      beforeCommit?.()
      const orphaned = [...frameHashes].filter((hash) => !stmts.hasLivePhotoForHash.get(hash))
      orphaned.forEach(deleteContent)
      return orphaned
    })()
  }
  /** from 的脸 / 约束全部转给 into，删掉 from（调用方负责 refreshPerson(into)） */
  const mergeInto = (from: number, into: number): void => {
    stmts.mergePeopleFaces.run(into, from)
    stmts.moveRejections.run(into, from)
    stmts.deleteRejectionsForPerson.run(from)
    stmts.deleteDismissedForPerson.run(from, from)
    stmts.deletePerson.run(from)
  }

  return {
    addFolder: (path: string): WatchedFolder => {
      return stmts.addFolder.get(path) as WatchedFolder
    },
    removeFolder: (id: number): void => {
      stmts.deleteSkippedFoldersByFolder.run(id)
      stmts.removeFolder.run(id)
    },
    getFolder: (id: number): WatchedFolder | undefined => {
      return stmts.getFolder.get(id) as WatchedFolder | undefined
    },
    getFolders: (): WatchedFolder[] => {
      return (stmts.getFolders.all() as Array<WatchedFolder & { is_inbox?: number }>).map((r) => ({ ...r, isInbox: !!r.is_inbox }))
    },
    getFoldersWithStats: (): WatchedFolder[] => {
      return (stmts.getFoldersWithStats.all() as Array<WatchedFolder & { is_inbox?: number }>).map((r) => ({ ...r, isInbox: !!r.is_inbox }))
    },
    updateFolderScanTime: (id: number): void => {
      stmts.updateFolderScanTime.run(id)
    },
    getFolderStats: (id: number): { photoCount: number; photoIds: number[] } => {
      const countResult = stmts.getFolderPhotoCount.get(id) as { count: number }
      const idsResult = stmts.getFolderPhotoIds.all(id) as Array<{ id: number }>
      return {
        photoCount: countResult.count,
        photoIds: idsResult.map((r) => r.id),
      }
    },
    getLiveSourcePaths: (folderId: number) => ({
      photos: stmts.getLivePhotoPaths.all(folderId) as string[],
      videos: stmts.getLiveVideoPaths.all(folderId) as string[],
    }),
    deletePhotosByFolder: (folderId: number): string[] => {
      // 找出孤立的 hash（该文件夹内的，且没有其他文件夹有存活副本）
      const orphanedHashes = (stmts.getOrphanedHashes.all(folderId, folderId) as Array<{ file_hash: string }>)
        .map((r) => r.file_hash)

      // 删除队列和照片
      stmts.deleteQueueByPhotoIds.run(folderId)
      stmts.deletePhotosByFolderId.run(folderId)

      // 孤立 hash 全套内容清理：vec0 / 人脸 ANN / 人脸 BLOB / captions / OCR
      db.transaction(() => orphanedHashes.forEach(deleteContent))()

      return orphanedHashes // 调用方用于清理缩略图文件
    },

    deleteVideosByFolder: (folderId: number): string[] => {
      const videos = stmts.getVideosByFolder.all(folderId) as Array<{ id: number; fileHash: string | null }>
      const tx = db.transaction(() => {
        for (const v of videos) {
          const segIds = stmts.getVideoSegmentIdsByVideo.all(v.id) as Array<{ id: number }>
          for (const { id } of segIds) {
            const row = stmts.getVideoSegmentVecRowid.get(id) as { rowid: bigint | number } | undefined
            if (row) stmts.deleteVideoSegmentVec.run(BigInt(row.rowid))
            stmts.deleteVideoSegmentVecMap.run(id)
          }
          stmts.deleteVideoSegmentsByVideo.run(v.id)
        }
        stmts.deleteExtractTasksByFolder.run(folderId)
        stmts.deleteVideosByFolderId.run(folderId)
      })
      tx()
      return videos.map((v) => v.fileHash).filter((h): h is string => !!h)
    },

    addPhoto: (folderId, filePath, fileName, fileSize, fileMtime, fileHash, videoCtx): number => {
      const result = stmts.addPhoto.get(
        folderId, filePath, fileName, fileSize, fileMtime, fileHash,
        videoCtx?.videoId ?? null,
        videoCtx?.frameTimeMs ?? null,
      ) as { id: number }
      return result.id
    },
    getPhoto: (id: number): Photo | undefined => {
      return stmts.getPhoto.get(id) as Photo | undefined
    },
    getPhotoByPath: (path: string): Photo | undefined => {
      return stmts.getPhotoByPath.get(path) as Photo | undefined
    },
    getPhotoDetail: (id: number): PhotoDetail | undefined => {
      return stmts.getPhotoWithCaption.get(id) as PhotoDetail | undefined
    },
    updatePhotoMeta: (id, data): void => {
      stmts.updatePhotoMeta.run(data.width, data.height, data.takenAt, data.lat, data.lng, data.pages, id)
    },
    softDeletePhoto: (path: string): void => {
      stmts.softDeletePhoto.run(path)
    },
    updatePhotoPath: (id: number, newPath: string): void => {
      const fileName = newPath.split('/').pop() || ''
      stmts.updatePhotoPath.run(newPath, fileName, id)
    },
    getPhotos: (limit: number, offset = 0): Photo[] => {
      return stmts.getPhotos.all(limit, offset) as Photo[]
    },
    getRepresentativePhotos: (limit: number, offset = 0): Photo[] => {
      return stmts.getRepresentativePhotos.all(limit, offset) as Photo[]
    },
    getPhotoLocations: (fileHash: string): PhotoLocation[] => {
      const rows = stmts.getPhotoLocations.all(fileHash) as Array<{
        filePath: string; folderId: number; folderPath: string
      }>
      return rows.map((r) => ({
        filePath: r.filePath,
        folderPath: r.folderPath,
        folderName: r.folderPath.split('/').pop() || r.folderPath,
        folderId: r.folderId,
      }))
    },
    markDuplicateProcessed: (photoId: number): void => {
      stmts.markDuplicateProcessed.run(photoId)
    },
    setPhotoScreenshot: (photoId: number, flag: 0 | 1): void => {
      stmts.setPhotoScreenshot.run(flag, photoId)
    },
    getScreenshotFlagForHash: (fileHash: string): 0 | 1 | null => {
      const row = stmts.getScreenshotFlagForHash.get(fileHash) as { flag: number | null } | undefined
      return row?.flag == null ? null : row.flag >= 1 ? 1 : 0
    },
    photosMissingScreenshotFlag: (limit: number) => {
      return stmts.photosMissingScreenshotFlag.all(limit) as Array<{ id: number; filePath: string; fileName: string; fileHash: string }>
    },
    listSkippedFolders: (folderId?: number): SkippedFolder[] => {
      const rows = (folderId == null ? stmts.listSkippedFolders.all() : stmts.listSkippedFoldersByFolder.all(folderId)) as
        Array<Omit<SkippedFolder, 'override'> & { override: number }>
      return rows.map((r) => ({ ...r, override: !!r.override }))
    },
    addSkippedFolder: (folderId: number, path: string, fileCount: number): void => {
      stmts.addSkippedFolder.run(path, folderId, fileCount)
    },
    setSkippedFolderOverride: (path: string, override: boolean): void => {
      stmts.setSkippedFolderOverride.run(override ? 1 : 0, path)
    },
    getRepresentativeByHash: (fileHash: string): Photo | undefined => {
      return stmts.getRepresentativeByHash.get(fileHash) as Photo | undefined
    },

    addToQueue: (photoId: number, taskType: string, priority = 0, origin: TaskOrigin = 'backfill'): void => {
      stmts.addToQueue.run(photoId, taskType, priority, origin)
    },
    hasOpenOrFailedTask: (photoId: number, taskType: string): boolean => {
      return stmts.hasOpenOrFailedTask.get(photoId, taskType) !== undefined
    },
    hasOpenTask: (photoId: number, taskType: string): boolean => {
      return stmts.hasOpenTask.get(photoId, taskType) !== undefined
    },
    getNextTask: (liveOnly = false, groupByModel = false) => {
      const stmt = liveOnly ? stmts.getNextLiveTask : groupByModel ? stmts.getNextTaskGrouped : stmts.getNextTask
      const task = stmt.get() as
        | { id: number; photoId: number; taskType: string; origin: TaskOrigin }
        | undefined
      if (task) {
        stmts.markTaskProcessing.run(task.id)
      }
      return task
    },
    countLivePendingTasks: (): number => {
      return (stmts.countLivePendingTasks.get() as { n: number }).n
    },
    peekNextTask: () => {
      return stmts.peekNextTask.get() as
        | { id: number; photoId: number; taskType: string }
        | undefined
    },
    completeTask: (taskId: number, note?: string): void => {
      stmts.completeTask.run(note ?? null, taskId)
    },
    resetTask: (taskId: number): void => {
      stmts.resetTask.run(taskId)
    },
    failTask: (taskId: number, error: string): void => {
      stmts.failTask.run(error, taskId)
    },
    recoverStuckTasks: (): number => {
      return stmts.recoverStuckTasks.run().changes
    },
    requeueMissingEmbeddings: db.transaction((): number => {
      // 模型未就绪 / 推理进程退出（崩溃、看门狗）的失败可以自动重来（先删掉旧的失败行，免得队列里一条媒体两行）；
      // 单文件失败（坏图 / 解码失败）不自动重排，留在任务面板由用户重试，避免每次启动白跑
      stmts.resetSpawnFailedVideos.run()
      stmts.clearModelNotReadyErrors.run()
      const photos = stmts.getPhotosWithoutEmbedding.all() as Array<{ id: number }>
      for (const photo of photos) {
        stmts.addToQueue.run(photo.id, 'embed', 10, 'backfill')
      }
      const videos = stmts.getVideosWithoutSegments.all() as Array<{ id: number }>
      for (const video of videos) {
        stmts.addToQueue.run(video.id, 'extract_frames', 6, 'backfill')
      }
      return photos.length + videos.length
    }),
    getQueueStats: () => {
      const result = stmts.getQueueStats.get() as { pending: number; processing: number; done: number; error: number }
      return {
        pending: result.pending || 0,
        processing: result.processing || 0,
        done: result.done || 0,
        error: result.error || 0,
      }
    },
    getTaskOverview: (): TaskOverview => {
      const counts: TaskOverview['counts'] = {}
      for (const r of stmts.getTaskCounts.all() as Array<{ taskType: string; status: TaskRow['status']; n: number }>) {
        ;(counts[r.taskType] ??= {})[r.status] = r.n
      }
      const media: TaskOverview['media'] = {
        video: { total: 0, done: 0 },
        audio: { total: 0, done: 0 },
        segmentsDone: (stmts.getSegmentsDone.get() as { n: number }).n,
        segmentsExpected: 0,
      }
      for (const r of stmts.getMediaTotals.all() as Array<{ kind: 'video' | 'audio'; total: number; done: number; expected: number }>) {
        const bucket = r.kind === 'audio' ? media.audio : media.video
        bucket.total += r.total
        bucket.done += r.done || 0
        media.segmentsExpected += r.expected || 0
      }
      const ps = stmts.getPhotoStats.get() as { uniqueTotal: number; thumbnailed: number; indexed: number }
      return {
        counts,
        pending: stmts.getActiveTaskRows.all(20) as TaskRow[],
        errors: stmts.getErrorTaskRows.all(50) as TaskRow[],
        media,
        photos: { total: ps.uniqueTotal || 0, thumbnailed: ps.thumbnailed || 0, indexed: ps.indexed || 0 },
      }
    },
    retryFailedTasks: (ids?: number[]): number => {
      const json = ids && ids.length > 0 ? JSON.stringify(ids) : null
      return stmts.retryFailedTasks.run(json, json).changes
    },
    clearFailedTasks: (): number => stmts.clearFailedTasks.run().changes,
    pruneDoneTasks: (): number => stmts.pruneDoneTasks.run().changes,
    resetFacesIfStale: (version: string): number => {
      const key = 'face.pipeline'
      const cur = (db.prepare(`SELECT value FROM meta_state WHERE key = ?`).get(key) as { value: string } | undefined)?.value
      if (cur === version) return 0
      const tx = db.transaction((): number => {
        const n = (db.prepare(`SELECT COUNT(*) as n FROM faces`).get() as { n: number }).n
        db.exec(`DELETE FROM face_vecs; DELETE FROM faces; DELETE FROM people; DELETE FROM face_rejections; DELETE FROM person_dismissed_pairs;`)
        db.prepare(`DELETE FROM index_queue WHERE task_type = 'face'`).run()
        db.prepare(`UPDATE photos SET face_status = 'pending'`).run()
        db.prepare(`INSERT OR REPLACE INTO meta_state(key, value) VALUES (?, ?)`).run(key, version)
        return n
      })
      return tx()
    },
    getMediaDetail: (videoId: number): MediaDetail | undefined => {
      const v = stmts.getVideoById.get(videoId) as VideoRecord | undefined
      if (!v || v.deletedAt) return undefined
      const segments = (stmts.getVideoSegmentsByVideo.all(videoId) as Array<{ startMs: number; endMs: number }>)
        .map(({ startMs, endMs }) => ({ startMs, endMs }))
      return {
        id: v.id,
        kind: v.mediaKind,
        filePath: v.filePath,
        fileName: v.fileName,
        fileSize: v.fileSize,
        durationMs: v.durationMs ?? null,
        width: v.width ?? null,
        height: v.height ?? null,
        segments,
      }
    },
    getPhotoStats: () => {
      const result = stmts.getPhotoStats.get() as {
        total: number; uniqueTotal: number; thumbnailed: number; indexed: number; ocred: number
      }
      return {
        total: result.total || 0,
        uniqueTotal: result.uniqueTotal || 0,
        thumbnailed: result.thumbnailed || 0,
        indexed: result.indexed || 0,
        ocred: result.ocred || 0,
      }
    },

    hasContentForHash: (fileHash: string) => {
      return {
        hasEmbedding: !!stmts.hasEmbeddingForHash.get(fileHash),
        hasCaption: !!stmts.hasCaptionForHash.get(fileHash),
        hasOcr: !!stmts.hasOcrForHash.get(fileHash),
      }
    },
    saveImageVec: (fileHash: string, embedding: Float32Array): void => {
      // vec0 要求: rowid 必须是 BigInt, embedding 必须是 Float32Array（不是 Buffer）
      //
      // 失败语义：image_vec_map 和 image_vecs 必须保持一致 — 要么两表都有
      // 这个 hash，要么都没有。我们用事务包住 INSERT/UPDATE 两步；任何
      // 一步抛错就回滚，避免 vec_map 出现孤立 rowid（要等 cleanupStaleVecMap
      // 下次启动才回收）。
      const tx = db.transaction((hash: string, vec: Float32Array) => {
        // 1. 拿到 map rowid（新建或复用）
        let mapRowid: bigint
        const info = stmts.insertVecMap.run(hash)
        if (info.changes > 0) {
          mapRowid = BigInt(info.lastInsertRowid)
        } else {
          const existing = stmts.getVecMapRowid.get(hash) as { rowid: bigint | number } | undefined
          if (!existing) throw new Error(`Vec map row missing for hash ${hash}`)
          mapRowid = BigInt(existing.rowid)
        }
        // 2. INSERT；冲突走 UPDATE
        try {
          stmts.insertVec.run(mapRowid, vec)
        } catch {
          stmts.updateVec.run(vec, mapRowid)
        }
      })

      try {
        tx(fileHash, embedding)
        stmts.updateEmbedStatusByHash.run(fileHash)
      } catch (err) {
        console.warn(`saveImageVec failed for ${fileHash}:`, err)
        // 兜底：万一事务部分成功（理论上不该），也把可能的孤立 map 行清掉
        try { stmts.deleteVecMapByHash.run(fileHash) } catch { /* ignore */ }
        throw err
      }
    },
    updateEmbedStatusByHash: (fileHash: string): void => {
      stmts.updateEmbedStatusByHash.run(fileHash)
    },
    saveCaption: (fileHash: string, text: string): void => {
      stmts.saveCaption.run(fileHash, text)
    },
    getCaption: (fileHash: string): string | undefined => {
      const result = stmts.getCaption.get(fileHash) as { text: string } | undefined
      return result?.text
    },
    saveOcrText: (fileHash: string, text: string): void => {
      stmts.saveOcrText.run(fileHash, text)
    },
    getOcrText: (fileHash: string): string | undefined => {
      const result = stmts.getOcrText.get(fileHash) as { text: string } | undefined
      return result?.text
    },
    clearAllOcr: () => stmts.clearAllOcr.run().changes,
    saveItemColors: (fileHash, paletteJson, mask) => {
      stmts.saveItemColors.run(fileHash, paletteJson, mask)
    },
    getItemColors: (fileHash) => {
      return stmts.getItemColors.get(fileHash) as { palette: string; mask: number } | undefined
    },
    hasColorsForHash: (fileHash) => !!stmts.hasColorsForHash.get(fileHash),
    getHashesForColorMask: (mask) => new Set(stmts.getHashesForColorMask.all(mask) as string[]),
    getHashesMissingColors: (limit) =>
      (stmts.getHashesMissingColors.all(limit) as string[]).map((fileHash) => ({ fileHash })),
    getPendingOcrPhotos: () => {
      return stmts.getPendingOcrPhotos.all() as Array<{ id: number; fileHash: string; filePath: string }>
    },

    // ─── 视频片段 ────────────────────────────────────────────────
    saveVideoSegment: (
      videoId: number,
      startMs: number,
      endMs: number,
      fileHash: string,
      embedding: Float32Array
    ): number => {
      // 与 saveImageVec 同构：segments / vec_map / vecs 三表必须一致，
      // 任何一步失败就整体回滚，不留孤立 rowid。
      const tx = db.transaction(() => {
        const info = stmts.insertVideoSegment.run(videoId, startMs, endMs, fileHash)
        const segmentId = Number(info.lastInsertRowid)

        let mapRowid: bigint
        const mapInfo = stmts.insertVideoSegmentVecMap.run(segmentId)
        if (mapInfo.changes > 0) {
          mapRowid = BigInt(mapInfo.lastInsertRowid)
        } else {
          const existing = stmts.getVideoSegmentVecRowid.get(segmentId) as
            | { rowid: bigint | number }
            | undefined
          if (!existing) throw new Error(`Vec map row missing for segment ${segmentId}`)
          mapRowid = BigInt(existing.rowid)
        }

        try {
          stmts.insertVideoSegmentVec.run(mapRowid, embedding)
        } catch {
          stmts.updateVideoSegmentVec.run(embedding, mapRowid)
        }
        return segmentId
      })

      return tx() as number
    },
    hasVideoSegmentForHash: (fileHash: string): boolean => {
      return !!stmts.hasVideoSegmentForHash.get(fileHash)
    },
    getVideoSegments: (videoId: number) => {
      return stmts.getVideoSegmentsByVideo.all(videoId) as Array<{
        id: number
        videoId: number
        startMs: number
        endMs: number
        fileHash: string
      }>
    },
    deleteVideoSegments: (videoId: number): void => {
      // 先收集 segment id，逐个删 vec0 行和映射，最后删 segments
      const ids = stmts.getVideoSegmentIdsByVideo.all(videoId) as Array<{ id: number }>
      const tx = db.transaction(() => {
        for (const { id } of ids) {
          const row = stmts.getVideoSegmentVecRowid.get(id) as
            | { rowid: bigint | number }
            | undefined
          if (row) {
            try { stmts.deleteVideoSegmentVec.run(BigInt(row.rowid)) } catch { /* ignore */ }
          }
          try { stmts.deleteVideoSegmentVecMap.run(id) } catch { /* ignore */ }
        }
        stmts.deleteVideoSegmentsByVideo.run(videoId)
      })
      try {
        tx()
      } catch (err) {
        console.warn(`deleteVideoSegments failed for video ${videoId}:`, err)
      }
    },
    searchVideoSegmentsByVec: (queryVec: Float32Array, limit: number) => {
      try {
        const rows = stmts.searchVideoSegmentKnnRaw.all(queryVec, limit) as Array<{
          rowid: bigint | number
          distance: number
        }>
        const out: Array<{
          segmentId: number
          videoId: number
          startMs: number
          endMs: number
          distance: number
        }> = []
        for (const r of rows) {
          const seg = stmts.getVideoSegmentByVecRowid.get(Number(r.rowid)) as
            | { segmentId: number; videoId: number; startMs: number; endMs: number }
            | undefined
          if (seg) out.push({ ...seg, distance: r.distance })
        }
        return out
      } catch (err) {
        // 与 searchFaceKnn 同样的回退语义：vec0 没就绪就返回空，调用方自行降级
        console.warn('searchVideoSegmentsByVec failed (vec0 may not be ready yet):', err)
        return []
      }
    },
    deleteContentByHash: deleteContent,

    sampleVectors: (kind, n) => {
      const rows = (kind === 'image' ? stmts.sampleImageVecs : stmts.sampleSegmentVecs).all(n) as Buffer[]
      return rows.map(toF32)
    },
    countVectors: () => ({
      image: stmts.countImageVecs.get() as number,
      segment: stmts.countSegmentVecs.get() as number,
    }),
    searchByVec: (queryVec, limit) => {
      try {
        // vec0 MATCH 接受 Float32Array
        const knnResults = stmts.searchVecKnnRaw.all(queryVec, limit) as Array<{ rowid: bigint | number; distance: number }>
        return knnResults
          .map((r) => {
            const hashRow = stmts.getHashByRowid.get(Number(r.rowid)) as { file_hash: string } | undefined
            return hashRow ? { fileHash: hashRow.file_hash, distance: r.distance } : null
          })
          .filter((r): r is { fileHash: string; distance: number } => r !== null)
      } catch (error) {
        console.error('Vector search error:', error)
        return []
      }
    },
    searchByFileName: (query, limit) => {
      // 转义 LIKE 通配符：查询里的 % / _ 按字面匹配（"IMG_2024" 不该匹配 "IMGx2024"）。
      // 查询里的空白当通配符：文件名里的分隔习惯和打字习惯不一致（"wood anemones" 该召回
      // wood_anemones.jpg，"IMG 2682" 该召回 IMG_2682.heic）；词序仍须一致，精确与否由
      // search.ts 的整词检查决定，这里只管召回
      const pattern = `%${query.trim().split(/\s+/).map((t) => t.replace(/[!%_]/g, '!$&')).join('%')}%`
      const results = stmts.searchByFileName.all(pattern, pattern, limit) as Array<{ file_hash: string }>
      return results.map((r) => ({ fileHash: r.file_hash }))
    },
    searchByOcr: (query, limit) => {
      try {
        const ftsQuery = buildFtsQuery(query)
        if (!ftsQuery) return []
        const results = stmts.searchByOcr.all(ftsQuery, limit) as Array<{ file_hash: string; score: number }>
        return results.map((row) => ({ fileHash: row.file_hash, score: Math.abs(row.score) }))
      } catch (error) {
        console.error('OCR search error:', error)
        return []
      }
    },
    getRepresentativePhotosFiltered: (limit, offset, filters) => {
      const { where, params } = filterWhere(filters)
      // 每种条件组合一条预编译语句（组合数有限），参数照常绑定
      let stmt = filteredStmts.get(where)
      if (!stmt) {
        stmt = db.prepare(`
          SELECT ${PHOTO_COLUMNS},
                 (SELECT COUNT(*) FROM photos p2
                  WHERE p2.file_hash = p.file_hash AND p2.deleted_at IS NULL) as duplicateCount
          FROM photos p
          ${MEDIA_JOIN}
          WHERE p.deleted_at IS NULL
            AND p.id = (
              SELECT MIN(p3.id) FROM photos p3
              WHERE p3.file_hash = p.file_hash AND p3.deleted_at IS NULL
            )
            AND p.file_hash NOT IN (SELECT file_hash FROM hidden_items)
            ${where}
          ORDER BY p.taken_at DESC, p.created_at DESC
          LIMIT ? OFFSET ?
        `)
        filteredStmts.set(where, stmt)
      }
      return stmt.all(...params, limit, offset) as Photo[]
    },
    setFavorite: (fileHashes, on) => {
      const stmt = on ? stmts.addFavorite : stmts.removeFavorite
      db.transaction(() => { for (const h of fileHashes) stmt.run(h) })()
    },
    getFavoriteHashes: () => new Set((stmts.getFavoriteHashes.all() as Array<{ file_hash: string }>).map((r) => r.file_hash)),
    getSmartAlbums: () => (stmts.getSmartAlbums.all() as SmartAlbumRow[]).map(toSmartAlbum),
    createSmartAlbum: ({ name, query, filters }) => {
      const id = Number(stmts.insertSmartAlbum.run(name.trim() || query.trim(), query.trim(), JSON.stringify(sanitizeFilters(filters))).lastInsertRowid)
      return toSmartAlbum(stmts.getSmartAlbum.get(id) as SmartAlbumRow)
    },
    updateSmartAlbum: (id, patch) => {
      const row = stmts.getSmartAlbum.get(id) as SmartAlbumRow | undefined
      if (!row) return undefined
      const cur = toSmartAlbum(row)
      const name = patch.name?.trim() || cur.name
      stmts.updateSmartAlbum.run(name, (patch.query ?? cur.query).trim(), JSON.stringify(sanitizeFilters(patch.filters ?? cur.filters)), id)
      return toSmartAlbum(stmts.getSmartAlbum.get(id) as SmartAlbumRow)
    },
    deleteSmartAlbum: (id) => { stmts.deleteSmartAlbum.run(id) },
    reorderSmartAlbums: (ids) => {
      const all = (stmts.getSmartAlbums.all() as SmartAlbumRow[]).map((r) => r.id)
      const order = [...ids.filter((id) => all.includes(id)), ...all.filter((id) => !ids.includes(id))]
      db.transaction(() => order.forEach((id, i) => stmts.setSmartAlbumOrder.run(i, id)))()
    },
    getHashesForPerson: (personId) =>
      new Set((stmts.getHashesForPerson.all(personId) as Array<{ file_hash: string }>).map((r) => r.file_hash)),
    getHashesInFolder: (folderId) => {
      const rows = stmts.getHashesInFolder.all(folderId) as Array<{ file_hash: string }>
      return new Set(rows.map((r) => r.file_hash))
    },
    getLibraryCounts: () => {
      const counts: LibraryCounts = { all: 0, image: 0, video: 0, audio: 0, favorites: (stmts.countFavorites.get() as { n: number }).n }
      for (const { kind, n } of stmts.getLibraryCounts.all() as Array<{ kind: MediaKind; n: number }>) {
        counts[kind] = n
        counts.all += n
      }
      return counts
    },
    findSimilar: (fileHash, limit) => {
      try {
        const mapRow = stmts.getVecMapRowid.get(fileHash) as { rowid: bigint | number } | undefined
        if (!mapRow) return []
        const vecRow = stmts.getVecByRowid.get(Number(mapRow.rowid)) as { embedding: Buffer } | undefined
        if (!vecRow) return []
        // vec0 返回的 embedding 是 Buffer，需要转 Float32Array 给 MATCH
        const targetVec = new Float32Array(vecRow.embedding.buffer, vecRow.embedding.byteOffset, vecRow.embedding.byteLength / 4)
        const knnResults = stmts.searchVecKnnRaw.all(targetVec, limit + 1) as Array<{ rowid: bigint | number; distance: number }>
        return knnResults
          .map((r) => {
            const hashRow = stmts.getHashByRowid.get(Number(r.rowid)) as { file_hash: string } | undefined
            return hashRow ? { fileHash: hashRow.file_hash, distance: r.distance } : null
          })
          .filter((r): r is { fileHash: string; distance: number } => r !== null && r.fileHash !== fileHash)
          .slice(0, limit)
      } catch (error) {
        console.error('Find similar error:', error)
        return []
      }
    },

    getImageVecByHash: (fileHash) => {
      const mapRow = stmts.getVecMapRowid.get(fileHash) as { rowid: bigint | number } | undefined
      if (!mapRow) return null
      const vecRow = stmts.getVecByRowid.get(Number(mapRow.rowid)) as { embedding: Buffer } | undefined
      if (!vecRow) return null
      return new Float32Array(vecRow.embedding.buffer, vecRow.embedding.byteOffset, vecRow.embedding.byteLength / 4)
    },

    getPhotosWithGPS: (limit = 5000) => {
      return stmts.getPhotosWithGPS.all(limit) as Photo[]
    },

    // 人脸
    saveFace: (fileHash, faceIndex, bbox, confidence, embedding, quality = 1) => {
      const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
      const result = stmts.saveFace.get(fileHash, faceIndex, bbox, confidence, buffer, quality) as { id: number }

      // 写 vec0 索引。维度必须匹配 face_vecs schema。
      if (embedding.length === FACE_EMBEDDING_DIM) {
        try {
          // ON CONFLICT(file_hash, face_index) 的 UPDATE 路径会返回旧 id；
          // 因此 INSERT 失败时 fallback 到 UPDATE 保持 vec0 同步。
          stmts.insertFaceVec.run(result.id, embedding)
        } catch {
          try { stmts.updateFaceVec.run(embedding, result.id) } catch { /* ignore */ }
        }
      } else {
        console.warn(
          `face embedding dim mismatch (got ${embedding.length}, expected ${FACE_EMBEDDING_DIM}); skipping ANN index — search will fall back to BLOB scan`
        )
      }
      return result.id
    },
    updateFaceStatusByHash: (fileHash) => {
      stmts.updateFaceStatusByHash.run(fileHash)
    },
    hasFacesForHash: (fileHash) => {
      return !!stmts.hasFacesForHash.get(fileHash)
    },
    getFacesByHash: (fileHash) => {
      return stmts.getFacesByHash.all(fileHash) as Array<{
        id: number; faceIndex: number; bbox: string; confidence: number; personId: number | null; personName: string | null
      }>
    },
    getAllFaceEmbeddings: () => {
      const rows = stmts.getAllFaceEmbeddings.all() as Array<{ id: number; embedding: Buffer; confidence: number; personId: number | null }>
      return rows.map((r) => ({
        id: r.id,
        embedding: new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
        confidence: r.confidence,
        personId: r.personId,
      }))
    },
    searchFaceKnn: (queryVec, k, excludeFaceId) => {
      try {
        // 多取一个，给排除自身留余地
        const fetchK = excludeFaceId != null ? k + 1 : k
        const rows = stmts.searchFaceKnnRaw.all(queryVec, fetchK) as Array<{
          faceId: bigint | number
          personId: number | null
          distance: number
        }>
        const out: Array<{ faceId: number; personId: number | null; distance: number }> = []
        for (const r of rows) {
          const id = Number(r.faceId)
          if (excludeFaceId != null && id === excludeFaceId) continue
          out.push({ faceId: id, personId: r.personId, distance: r.distance })
          if (out.length >= k) break
        }
        return out
      } catch (err) {
        console.warn('searchFaceKnn failed (vec0 may not be ready yet):', err)
        return []
      }
    },
    setFacePersonId: (faceId: number, personId: number): void => {
      stmts.setFacePersonId.run(personId, faceId)
    },
    createPerson: (coverFaceId: number): number => {
      const result = stmts.createPerson.get(coverFaceId) as { id: number }
      return result.id
    },
    updatePersonFaceCount: (personId: number): void => {
      stmts.updatePersonFaceCount.run(personId)
    },
    getPeople: () => {
      return (stmts.getPeople.all() as Array<{
        id: number; name: string | null; coverFaceId: number | null; faceCount: number; photoCount: number; hidden: number; createdAt: string
      }>).map((p) => ({ ...p, hidden: !!p.hidden }))
    },
    getPersonPhotos: (personId, limit = 50) => {
      return stmts.getPersonPhotos.all(personId, limit) as Photo[]
    },
    updatePersonName: (personId, name) => {
      // 清空名字 = 回到未命名（不再锁定，可被自动合并）
      stmts.updatePersonName.run(name.trim() || null, personId)
    },
    mergePeople: (targetId, sourceIds) => {
      const transaction = db.transaction(() => {
        for (const sourceId of sourceIds) {
          if (sourceId === targetId) continue
          mergeInto(sourceId, targetId)
        }
        refreshPerson(targetId)
      })
      transaction()
    },

    getPersonCentroids: (opts) => {
      const rows = stmts.getPersonCentroids.all() as Array<{ id: number; name: string | null; centroid: Buffer | null; count: number; hidden: number }>
      const out: PersonCentroid[] = []
      for (const r of rows) {
        if (r.hidden && !opts?.includeHidden) continue
        let c = r.centroid ? toF32(r.centroid) : null
        if (!c) { refreshPerson(r.id); const again = stmts.getPersonRow.get(r.id) as { centroid: Buffer | null } | undefined; c = again?.centroid ? toF32(again.centroid) : null }
        if (c) out.push({ id: r.id, named: !!r.name, centroid: c, count: r.count })
      }
      return out
    },
    getPendingClusterFaces: () => unassigned(0),
    getDormantFaces: () => unassigned(1),
    countPendingClusterFaces: () => (stmts.countUnassigned.get() as { n: number }).n,
    hasAnyFaces: () => stmts.hasAnyFaces.get() !== undefined,
    resetVideoFramesForFaceRescan: () => db.transaction((): number => {
      const hashes = stmts.getVideoFrameHashesForFaceRescan.all() as string[]
      for (const h of hashes) {
        deleteFacesForHash(h)
        stmts.setFacePendingByHash.run(h)
      }
      return hashes.length
    })(),
    getFaceRejections: () => {
      const m = new Map<number, Set<number>>()
      for (const r of stmts.getRejections.all() as Array<{ faceId: number; personId: number }>) {
        if (!m.has(r.faceId)) m.set(r.faceId, new Set())
        m.get(r.faceId)!.add(r.personId)
      }
      return m
    },
    getDismissedPairs: () => new Set((stmts.getDismissedPairs.all() as Array<{ a: number; b: number }>).map((r) => `${r.a}:${r.b}`)),
    applyClusterPlan: (plan) => {
      db.transaction(() => {
        const touched = new Set<number>()
        const meta = (id: number) => stmts.getPersonMeta.get(id) as { id: number; name: string | null } | undefined
        // 计划是异步算出来的：期间被删 / 被并走 / 双方都被命名的人物，相关操作跳过
        const gone = new Set<number>()
        for (const m of plan.merges) {
          const from = meta(m.from), into = meta(m.into)
          if (!from || !into || (from.name && into.name)) { if (!from) gone.add(m.from); continue }
          mergeInto(m.from, m.into)
          touched.delete(m.from)
          touched.add(m.into)
        }
        for (const a of plan.assign) {
          if (gone.has(a.personId) || !meta(a.personId)) continue
          if (stmts.autoAssignFace.run(a.personId, a.faceId).changes) touched.add(a.personId)
        }
        for (const group of plan.create) {
          const { id } = stmts.createPerson.get(group[0]) as { id: number }
          for (const faceId of group) stmts.autoAssignFace.run(id, faceId)
          touched.add(id)
        }
        for (const faceId of plan.dormant) stmts.setFaceDormant.run(faceId)
        for (const id of touched) refreshPerson(id)
      })()
    },
    addFaceToPerson: (faceId, personId, embedding) => {
      db.transaction(() => {
        stmts.assignFace.run(personId, 'auto', faceId)
        const row = stmts.getPersonRow.get(personId) as { centroid: Buffer | null; count: number } | undefined
        stmts.updatePersonFaceCount.run(personId)
        if (row?.centroid) {
          // 增量：normalize(c·n + e)，避免每张新脸都读回该人物的全部 embedding
          const c = toF32(row.centroid), out = new Float32Array(c.length)
          let n2 = 0
          for (let i = 0; i < c.length; i++) { out[i] = c[i] * row.count + embedding[i]; n2 += out[i] * out[i] }
          const n = Math.sqrt(n2) || 1
          for (let i = 0; i < c.length; i++) out[i] /= n
          stmts.setPersonCentroid.run(Buffer.from(out.buffer), personId)
        } else {
          refreshPerson(personId)
        }
      })()
    },
    refreshPerson: (personId) => refreshPerson(personId),

    setPersonHidden: (personId, hidden) => { stmts.setPersonHidden.run(hidden ? 1 : 0, personId) },
    rejectFaceFromPerson: (faceId) => {
      db.transaction(() => {
        const cur = (stmts.getFacePerson.get(faceId) as { personId: number | null } | undefined)?.personId
        if (cur == null) return
        stmts.insertRejection.run(faceId, cur)
        stmts.setFacePersonId.run(null, faceId)
        // 落单而不是回到"新脸"：之后只会被别的人物 KNN 拉走，不会再开新簇搅乱
        stmts.setFaceDormant.run(faceId)
        refreshPerson(cur)
      })()
    },
    assignFaceManually: (faceId, personId) => {
      db.transaction(() => {
        const cur = (stmts.getFacePerson.get(faceId) as { personId: number | null } | undefined)?.personId
        stmts.deleteRejection.run(faceId, personId)
        stmts.assignFace.run(personId, 'user', faceId)
        if (cur != null && cur !== personId) refreshPerson(cur)
        refreshPerson(personId)
      })()
    },
    dismissPersonPair: (a, b) => { stmts.insertDismissedPair.run(Math.min(a, b), Math.max(a, b)) },
    getPersonFaces: (personId, limit = 200) =>
      stmts.getPersonFaces.all(personId, limit) as Array<{ id: number; fileHash: string; bbox: string; quality: number; assignedBy: string | null }>,
    getPendingFacePhotos: () => {
      return stmts.getPendingFacePhotos.all() as Array<{ id: number; fileHash: string; filePath: string }>
    },
    getFaceCoverInfo: (faceId) => {
      return stmts.getFaceCoverInfo.get(faceId) as { fileHash: string; bbox: string } | undefined
    },

    // 视频
    addVideo: (folderId, filePath, fileName, fileSize, fileMtime, fileHash, kind = 'video'): number => {
      const result = stmts.addVideo.get(folderId, filePath, fileName, fileSize, fileMtime, fileHash, kind) as { id: number }
      return result.id
    },
    getVideoById: (id) => {
      return stmts.getVideoById.get(id) as VideoRecord | undefined
    },
    getVideoByPath: (path) => {
      return stmts.getVideoByPath.get(path) as VideoRecord | undefined
    },
    updateVideoMeta: (id, data) => {
      stmts.updateVideoMeta.run(
        data.durationMs ?? null,
        data.width ?? null,
        data.height ?? null,
        data.frameCount ?? null,
        id,
      )
    },
    softDeleteVideo: (path) => {
      stmts.softDeleteVideo.run(path)
    },
    getFramePhotosByVideo: (videoId) => {
      return stmts.getFramePhotosByVideo.all(videoId) as Photo[]
    },
    removeFramesForVideo: (videoId): string[] => dropVideoFrames(videoId),
    cascadeRemoveVideo: (filePath) => {
      const video = stmts.getVideoByPath.get(filePath) as VideoRecord | undefined
      if (!video) return null
      // 帧 photo 和视频本体在同一事务里软删，再按"已无存活引用"判孤立、清内容
      const orphanedFrameHashes = dropVideoFrames(video.id, () => stmts.softDeleteVideo.run(filePath))
      return { fileHash: video.fileHash || '', orphanedFrameHashes }
    },

    backupTo: async (destPath: string): Promise<void> => {
      // 复用 better-sqlite3 的 Online Backup（不阻塞读写、安全跨进程）
      await db.backup(destPath)
    },
    getMetaState: (key: string): string | undefined => {
      const row = db.prepare(`SELECT value FROM meta_state WHERE key = ?`).get(key) as
        | { value?: string }
        | undefined
      return row?.value
    },
    setMetaState: (key: string, value: string): void => {
      db.prepare(`INSERT OR REPLACE INTO meta_state(key, value) VALUES (?, ?)`).run(key, value)
    },

    raw: db,
    close: (): void => { db.close() },
  }
}

/** 清理 image_vec_map 中没有对应 vec0 数据的孤立记录 */
function cleanupStaleVecMap(db: Database.Database): void {
  try {
    const stale = db.prepare(`
      SELECT m.rowid, m.file_hash FROM image_vec_map m
      WHERE m.rowid NOT IN (SELECT rowid FROM image_vecs)
    `).all() as Array<{ rowid: number; file_hash: string }>

    if (stale.length > 0) {
      const del = db.prepare('DELETE FROM image_vec_map WHERE rowid = ?')
      const resetEmbed = db.prepare("UPDATE photos SET embed_status = 'pending' WHERE file_hash = ? AND deleted_at IS NULL")
      for (const row of stale) {
        del.run(row.rowid)
        resetEmbed.run(row.file_hash)
      }
    }
  } catch {
    // 表可能还不存在
  }
}
