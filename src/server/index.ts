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
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { parseServerConfig, ConfigError, type ServerConfig } from './config'
import { loadOrCreateSecret, passwordMatches, LoginRateLimiter, SessionManager, SESSION_COOKIE, SESSION_TTL_MS } from './auth'
import { readJsonBody, readRawBody, parseCookies, sendJson, clientIp, acceptLanguages, HttpError } from './http'
import { ApiDispatcher } from './api'
import { createEventHub } from './events'
import { handleMediaRequest } from './media'
import { handleWebRequest } from './webapp'
import { createServerInference } from './inference'
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
import { createServices, folderReadable, type VixelServices } from '../services/api'
import { createServiceEvents } from '../services/events'
import type { ImageQueryInput, MediaFilters } from '../shared/types'

/** 编译产物在 dist/server/server/，仓库根在三级之上 */
const REPO_ROOT = join(__dirname, '..', '..', '..')
/** JSON 请求体上限 */
const JSON_BODY_LIMIT = 10 * 1024 * 1024
/** 以图搜图上传的图片字节上限 */
const IMAGE_UPLOAD_LIMIT = 64 * 1024 * 1024

const META_KEY_SCREENSHOT_BACKFILL = 'screenshot.backfill'

interface ServerState {
  config: ServerConfig
  services: VixelServices
  dispatcher: ApiDispatcher
  sessions: SessionManager
  rateLimiter: LoginRateLimiter
  secret: Buffer
  requireAuth: boolean
  /** 媒体路由允许读取的根：数据目录 + 监视文件夹（每次现取，增删文件夹立即生效） */
  allowedRoots: () => string[]
  /** "跟随系统"时用的语言：最近一个 API 请求的浏览器语言（单用户，原地更新，服务层共用同一个数组） */
  preferredLanguages: string[]
}

/**
 * 界面语言"跟随系统"在服务器上 = 跟随浏览器：服务端生成的文案（自动标签名等）要和网页界面同语言。
 * 浏览器语言变了才重新解析（同一台设备的请求不做任何事）。
 */
function syncClientLocale(state: ServerState, req: IncomingMessage): void {
  const langs = acceptLanguages(req.headers['accept-language'])
  if (langs.length === 0 || langs[0] === state.preferredLanguages[0]) return
  state.preferredLanguages.splice(0, state.preferredLanguages.length, ...langs)
  setLocale(resolveLocale(state.services.loadLocaleSetting(), state.preferredLanguages))
}

// ─── 认证 ──────────────────────────────────────────────────────────────────

/**
 * 会话 cookie 要不要加 Secure：
 *   - VIXEL_COOKIE_SECURE=1 → 永远加（只在全程 HTTPS 时用，纯 HTTP 下浏览器会丢弃 cookie）
 *   - VIXEL_TRUST_PROXY=1  → 看反代头 X-Forwarded-Proto 是否 https（HTTPS 反代 + 内网 HTTP 直连并存时自动分流）
 *   - 默认不加：NAS 场景常见纯 HTTP 内网；SameSite=Strict + HttpOnly + 自定义头已经双保险
 */
function cookieSecure(state: ServerState, req: IncomingMessage): boolean {
  if (state.config.cookieSecure) return true
  if (!state.config.trustProxy) return false
  const proto = req.headers['x-forwarded-proto']
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0].trim().toLowerCase()
  return first === 'https'
}

function sessionCookie(state: ServerState, req: IncomingMessage, token: string): string {
  const secure = cookieSecure(state, req) ? '; Secure' : ''
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
}

function isAuthed(state: ServerState, req: IncomingMessage): boolean {
  if (!state.requireAuth) return true
  return state.sessions.verify(parseCookies(req.headers.cookie)[SESSION_COOKIE])
}

async function handleLogin(state: ServerState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = clientIp(req, state.config.trustProxy)
  if (state.rateLimiter.isLimited(ip)) {
    sendJson(res, 429, { ok: false, error: 'Too many failed login attempts, try again later' })
    return
  }
  const body = await readJsonBody<{ password?: unknown }>(req, 64 * 1024)
  if (!state.config.password || !passwordMatches(state.secret, state.config.password, body.password)) {
    state.rateLimiter.recordFailure(ip)
    sendJson(res, 401, { ok: false, error: 'Wrong password' })
    return
  }
  state.rateLimiter.recordSuccess(ip)
  res.setHeader('Set-Cookie', sessionCookie(state, req, state.sessions.issue()))
  sendJson(res, 200, { ok: true, result: { authenticated: true } })
}

// ─── 以图搜图（上传）────────────────────────────────────────────────────────

/**
 * POST /api/searchByImage 两种形态：
 *   - application/json：{ args: [input, limit?, filters?] }，input 只接受 { fileHash }
 *     （服务器不接受 path —— 那是宿主机文件系统；bytes 走下面的原始上传）
 *   - 其他 content-type（application/octet-stream / image/*）：body 即图片字节，
 *     query 参数 ?limit= &text= &filters=<JSON>（与桌面 searchByImage 的参数对应）
 */
async function handleSearchByImage(state: ServerState, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (contentType === 'application/json') {
    const body = await readJsonBody<{ args?: unknown[] }>(req, JSON_BODY_LIMIT)
    const args = Array.isArray(body.args) ? body.args : []
    const input = (args[0] ?? {}) as Record<string, unknown>
    if (typeof input.path === 'string' && input.path) {
      sendJson(res, 400, { ok: false, error: 'searchByImage by local path is not available on the server; upload the image bytes or pass a fileHash' })
      return
    }
    if (input.bytes != null) {
      sendJson(res, 400, { ok: false, error: 'searchByImage bytes must be uploaded as a raw request body (application/octet-stream), not JSON' })
      return
    }
    const outcome = await state.dispatcher.call('searchByImage', args)
    sendJson(res, outcome.status, outcome.body)
    return
  }

  // 原始字节上传
  const bytes = await readRawBody(req, IMAGE_UPLOAD_LIMIT)
  if (bytes.length === 0) {
    sendJson(res, 400, { ok: false, error: 'Empty image upload' })
    return
  }
  const limitParam = url.searchParams.get('limit')
  const limit = limitParam ? Number(limitParam) : undefined
  const text = url.searchParams.get('text') ?? undefined
  let filters: MediaFilters | undefined
  const filtersParam = url.searchParams.get('filters')
  if (filtersParam) {
    try { filters = JSON.parse(filtersParam) as MediaFilters } catch { throw new HttpError(400, 'filters must be URL-encoded JSON') }
  }
  const input: ImageQueryInput = { bytes, ...(text ? { text } : {}) }
  const result = await state.services.api.searchByImage(input, Number.isFinite(limit) ? limit : undefined, filters)
  sendJson(res, 200, { ok: true, result })
}

// ─── 请求路由 ──────────────────────────────────────────────────────────────

async function handleRequest(state: ServerState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname

  // Docker healthcheck：不鉴权，也不暴露任何信息
  if (req.method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true })
    return
  }

  // ─ API ─
  if (pathname.startsWith('/api/')) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'API methods are POST-only' })
      return
    }
    // CSRF：跨站发不出自定义头（无 CORS 头 → 预检必败）
    if (!req.headers['x-vixel']) {
      sendJson(res, 403, { ok: false, error: 'Missing X-Vixel header' })
      return
    }
    const method = decodeURIComponent(pathname.slice('/api/'.length))

    if (method === 'login') {
      await handleLogin(state, req, res)
      return
    }
    if (!isAuthed(state, req)) {
      sendJson(res, 401, { ok: false, error: 'Not authenticated' })
      return
    }
    if (method === 'logout') {
      const secure = cookieSecure(state, req) ? '; Secure' : ''
      res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=0`)
      sendJson(res, 200, { ok: true, result: null })
      return
    }
    if (method === 'searchByImage') {
      await handleSearchByImage(state, req, res, url)
      return
    }
    syncClientLocale(state, req)
    const body = await readJsonBody<{ args?: unknown[] }>(req, JSON_BODY_LIMIT)
    const outcome = await state.dispatcher.call(method, body.args ?? [])
    sendJson(res, outcome.status, outcome.body)
    return
  }

  // ─ 媒体 ─
  if (pathname.startsWith('/media/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'media routes are GET-only' })
      return
    }
    if (!isAuthed(state, req)) {
      sendJson(res, 401, { ok: false, error: 'Not authenticated' })
      return
    }
    const handled = await handleMediaRequest(pathname, res, req.headers.range ?? null, {
      services: state.services,
      allowedRoots: state.allowedRoots,
    })
    if (!handled) sendJson(res, 404, { ok: false, error: 'not found' })
    return
  }

  // ─ 网页前端（dist/web 静态文件 + /login + SPA fallback）─
  if (req.method === 'GET' || req.method === 'HEAD') {
    await handleWebRequest(pathname, req, res, {
      webDir: state.config.webDir,
      isAuthed: (r) => isAuthed(state, r),
    })
    return
  }

  sendJson(res, 404, { ok: false, error: 'not found' })
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
  const secret = loadOrCreateSecret(config.dataDir)
  const sessions = new SessionManager(secret)
  const rateLimiter = new LoginRateLimiter()
  const requireAuth = !!config.password
  if (!requireAuth) {
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

  // ─ HTTP + WebSocket ─
  const dispatcher = new ApiDispatcher(services.api)
  const state: ServerState = {
    config, services, dispatcher, sessions, rateLimiter, secret, requireAuth, preferredLanguages,
    allowedRoots: () => [config.dataDir, ...db.getFolders().map((f) => f.path)],
  }
  const hub = createEventHub(sessions, requireAuth)
  events.on((channel, payload) => hub.broadcast(channel, payload))

  const server = createServer((req, res) => {
    handleRequest(state, req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500
      if (!res.headersSent) sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) })
      else res.destroy()
    })
  })
  server.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head))

  server.listen(config.port, config.host, () => {
    console.log(`[server] Vixel server listening on http://${config.host}:${config.port} (data: ${config.dataDir})`)
    console.log(`[server] library dirs: ${db.getFolders().map((f) => f.path).join(', ') || '(none)'}`)
  })

  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`[server] ${signal} — shutting down`)
    hub.close()
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
