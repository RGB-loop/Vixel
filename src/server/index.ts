/**
 * Vixel Server（Docker / NAS 版）入口：纯 Node 22 进程（无 Electron）跑同一套 src/core +
 * src/services，HTTP + WebSocket 同端口提供与桌面 window.api 一一对应的 JSON API、媒体路由
 * 和事件推送。配置全部来自环境变量（见 ./config.ts），认证见 ./auth.ts。
 *
 *   npm run build:server && node dist/server/index.js
 *
 * 运行时零出站请求：进程里没有任何向外的网络调用（模型随安装、地图底图在前端包里；
 * 桌面版唯一的联网点 —— 收集箱按 URL 下载 —— 是桌面专属，不在服务器 API 面上）。
 */
import './bootstrap' // 必须第一个 import：普通 Node 下重定向 better-sqlite3 到 Node ABI 构建
import '../core/inference/noTelemetry' // 在加载 onnxruntime 之前关掉它的遥测
import '../core/stdioGuard' // 日志管道断了不让进程崩
import { createServer, type IncomingMessage } from 'http'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { parseServerConfig, ConfigError, type ServerConfig } from './config'
import { createServerApp } from './app'
import { createServerInference } from './inference'
import { createMcpServer } from '../core/mcp/server'
import { createToolContext } from '../core/mcp/tools'
import { initDatabase } from '../core/db'
import { FileWatcher } from '../core/watcher'
import { Indexer } from '../core/indexer'
import { SearchEngine } from '../core/search'
import { initEmbeddingServicePath, semanticCpuUnsupported } from '../core/embedding'
import { setFaceModelsDir, FACE_PIPELINE_VERSION } from '../core/face'
import { setOcrModelsDir } from '../core/ocr'
import { preloadJieba } from '../core/text/tokenize'
import { setInferenceTransport } from '../core/inference/transport'
import { restrictDesignExts } from '../core/image/design'
import { registerServerPdfRenderer } from './pdfRender'
import { detectScreenshot } from '../core/screenshot'
import { resolveLocale, setLocale } from '../shared/i18n'
import { createServices, folderReadable } from '../services/api'
import { createServiceEvents } from '../services/events'

/** 编译产物在 dist/server/server/，仓库根在三级之上 */
const REPO_ROOT = join(__dirname, '..', '..', '..')

/** MCP serverInfo 用的应用版本 */
const VERSION = ((): string => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require(join(REPO_ROOT, 'package.json')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const META_KEY_SCREENSHOT_BACKFILL = 'screenshot.backfill'

/** /mcp 结果里的 http 媒体链接：按请求的 Host / 反代头拼（服务器自己不知道外部地址） */
function mcpHttpBase(config: ServerConfig) {
  return (req: IncomingMessage): string | null => {
    const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
    if (!host) return null
    const fwd = req.headers['x-forwarded-proto']
    const proto = config.trustProxy && (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0].trim() === 'https' ? 'https' : 'http'
    return `${proto}://${host}`
  }
}

// ─── 启动 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let config: ServerConfig
  try {
    config = parseServerConfig(process.env, REPO_ROOT)
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`[server] ${err.message}`)
      process.exit(1)
    }
    throw err
  }

  // PDF / AI 预览：桌面版靠隐藏 BrowserWindow 里的 pdf.js（Win/Linux）或 sips/qlmanage（macOS）。
  // 服务器版用纯 Node 的 pdf.js（pdfjs-dist legacy + @napi-rs/canvas，见 ./pdfRender）：
  // macOS 本机开发仍以 sips 为主、pdf.js 兜底（与桌面一致）；Linux（Docker/NAS）pdf.js 是主路径。
  // 依赖没装（源码跑服务器但没装 devDependencies）→ 与阶段 1 相同，.pdf/.ai 不入库。
  if (!registerServerPdfRenderer() && process.platform !== 'darwin') {
    console.warn('[server] pdfjs-dist/@napi-rs/canvas unavailable — PDF/AI files will not be indexed')
    restrictDesignExts(['.svg', '.psd', '.psb'])
  }

  mkdirSync(config.dataDir, { recursive: true })
  if (!config.password) {
    console.warn('[server] VIXEL_ALLOW_NO_AUTH=1 — running WITHOUT authentication (local development only)')
  }

  // ─ core 初始化（顺序与桌面 initServices 一致，保证搜索行为一致）─
  initEmbeddingServicePath(config.dataDir, config.modelsDir, config.litertDir)
  setFaceModelsDir(config.modelsDir)
  setOcrModelsDir(config.modelsDir)

  const inference = createServerInference(join(__dirname, 'inference-worker.js'))
  setInferenceTransport(inference)

  const db = initDatabase(join(config.dataDir, 'library.db'))
  db.recoverStuckTasks()
  db.pruneDoneTasks()
  if (semanticCpuUnsupported()) {
    // CPU 跑不了语义模型（x86 无 AVX / ARMv8.0）：语义通道整体停用，不补排向量任务（换到支持的 CPU 上启动时会自动补齐）
    console.warn('[server] semantic search is disabled on this CPU; OCR, faces, filename and tag search still work')
  } else {
    db.requeueMissingEmbeddings()
  }
  const staleFaces = db.resetFacesIfStale(FACE_PIPELINE_VERSION)

  const events = createServiceEvents()
  const indexer = new Indexer(db, config.dataDir)
  indexer.on('progress', (p) => events.emit('index-progress', p))
  indexer.on('people-changed', () => events.emit('people-changed'))
  const watcher = new FileWatcher(db, indexer)
  const searchEngine = new SearchEngine(db)

  const preferredLanguages: string[] = []
  const services = createServices({
    db, watcher, indexer, searchEngine,
    dataDir: config.dataDir,
    modelsDir: config.modelsDir,
    events,
    preferredLanguages,
  })
  setLocale(resolveLocale(services.loadLocaleSetting(), preferredLanguages))
  // VIXEL_LIBRARY_DIRS：登记成监视文件夹（已有的保持原样，路径一致即不动）
  const known = new Set(db.getFolders().map((f) => f.path))
  for (const dir of config.libraryDirs) {
    if (!existsSync(dir)) {
      console.warn(`[server] library dir does not exist, skipping: ${dir}`)
      continue
    }
    if (!folderReadable(dir)) {
      // 群晖最常见：共享文件夹只授权给 administrators 等组，容器进程没有这个组
      const ids = `uid=${process.getuid?.()} gid=${process.getgid?.()} groups=${process.getgroups?.().join(',')}`
      console.error(`[server] cannot read library dir ${dir} (permission denied) as ${ids}. ` +
        'On Synology add `group_add: ["101"]` (administrators) or a group that can read the shared folder, ' +
        'or grant the PUID user read access to it; then restart the container. See docs/server/README.md')
    }
    if (!known.has(dir)) {
      const folder = db.addFolder(dir)
      console.log(`[server] registered library folder #${folder.id}: ${dir}`)
    }
  }
  for (const folder of db.getFolders()) watcher.watchFolder(folder.id, folder.path)

  // 与桌面相同的启动补课（索引队列 / OCR / 模型预热 / 色板回填 / 人脸补扫）
  setImmediate(preloadJieba)
  setTimeout(() => {
    indexer.processNext()
    void indexer.ocrAvailable().then((ok) => {
      if (!ok) return
      const stale = indexer.resetOcrIfStale()
      if (stale > 0) console.log(`[ocr] pipeline upgraded, re-scanning (${stale} old results dropped)`)
      return indexer.startOcrScan()
    }).catch((e) => console.warn('[ocr] catch-up scan failed:', e))
    indexer.preloadModels().catch(() => {}).finally(() => indexer.emitProgressPublic())
    void indexer.backfillColors().then((n) => {
      if (n > 0) console.log(`[color] backfilled palettes for ${n} items`)
    }).catch((e) => console.warn('[color] backfill failed:', e))
    if (db.countPendingClusterFaces() > 0) void indexer.faceClusterer.run()
    if (staleFaces > 0) {
      console.log(`[face] pipeline upgraded, re-scanning (${staleFaces} stale faces dropped)`)
      indexer.startFaceScan().catch((e) => console.warn('[face] re-scan failed:', e))
    } else if (indexer.isFaceAutoEnabled()) {
      const videoRescan = indexer.rescanVideoFacesOnce()
      if (videoRescan > 0) console.log(`[face] re-scanning ${videoRescan} video frames at full resolution`)
      indexer.startFaceScan().catch((e) => console.warn('[face] catch-up scan failed:', e))
    }
  }, 2000)

  // 截图标记回填（文件名模式全平台可用；macOS xattr 在 detectScreenshot 内部按平台分支）
  setTimeout(() => {
    void (async () => {
      if (db.getMetaState(META_KEY_SCREENSHOT_BACKFILL) === '1') return
      let done = 0
      const flagged: string[] = []
      for (;;) {
        const batch = db.photosMissingScreenshotFlag(200)
        if (batch.length === 0) break
        for (const p of batch) {
          const flag = detectScreenshot(p.filePath, p.fileName)
          db.setPhotoScreenshot(p.id, flag)
          if (flag === 1 && p.fileHash) flagged.push(p.fileHash)
          done++
        }
        await new Promise((r) => setTimeout(r, 25))
      }
      db.setMetaState(META_KEY_SCREENSHOT_BACKFILL, '1')
      if (done > 0) console.log(`[screenshot] backfilled flags for ${done} photos (${flagged.length} screenshots)`)
      services.autoTags.screenshotFlagged([...new Set(flagged)])
    })().catch((e) => console.warn('[screenshot] backfill failed:', e))
  }, 5000)

  // 自动标签：新内容有了向量 / 视频片段做完就排一次判定（与桌面一致）
  indexer.on('embedded', () => services.autoTags.kick())
  indexer.on('video-indexed', (videoId: number) => services.autoTags.videoUpdated(videoId))

  services.backup.schedule()

  // ─ HTTP + WebSocket + /mcp（与桌面"本地接口"共用的应用工厂，见 ./app.ts）─
  if (config.mcpToken) console.log('[server] MCP endpoint enabled at /mcp (bearer token from VIXEL_MCP_TOKEN)')
  const app = createServerApp({
    services,
    events,
    dataDir: config.dataDir,
    webDir: config.webDir,
    password: config.password,
    cookieSecure: config.cookieSecure,
    trustProxy: config.trustProxy,
    allowedRoots: () => [config.dataDir, ...db.getFolders().map((f) => f.path)],
    mcp: config.mcpToken
      ? { server: createMcpServer(createToolContext(db, searchEngine), { name: 'vixel', version: VERSION }), token: config.mcpToken, httpBase: mcpHttpBase(config) }
      : null,
    preferredLanguages,
  })

  const server = createServer(app.requestListener)
  server.on('upgrade', app.handleUpgrade)

  server.listen(config.port, config.host, () => {
    console.log(`[server] Vixel server listening on http://${config.host}:${config.port} (data: ${config.dataDir})`)
    console.log(`[server] library dirs: ${db.getFolders().map((f) => f.path).join(', ') || '(none)'}`)
  })

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[server] ${signal} — shutting down`)
    app.close()
    server.close()
    watcher.stopAll()
    indexer.stop()
    inference.stop()
    services.backup.stop()
    db.close()
    process.exit(0)
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error('[server] fatal:', err)
  process.exit(1)
})
