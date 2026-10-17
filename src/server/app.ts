/**
 * 与宿主无关的 Vixel HTTP 应用：认证、/api/*、/media/*、/mcp、网页前端与 WebSocket 事件，
 * 由 (services, 配置) 直接构造 —— 不碰 core 初始化、不碰进程生命周期。两个宿主共用：
 *
 *   - 服务器版（src/server/index.ts）：纯 Node 进程，配置来自环境变量
 *   - 桌面"本地接口"（src/main/localApi.ts）：Electron 主进程内嵌，配置来自设置页，
 *     复用桌面已经在跑的同一套 services / 数据库实例
 *
 * 原先这些都长在 index.ts 里；抽出来是为了桌面能开同一套栈而不复制代码。
 * 行为与抽取前完全一致（安全集成测试 scripts/server-security.mjs 锁定）。
 */
import type { IncomingMessage, ServerResponse } from 'http'
import type { Duplex } from 'stream'
import { loadOrCreateSecret, passwordMatches, LoginRateLimiter, SessionManager, SESSION_COOKIE, SESSION_TTL_MS } from './auth'
import { readJsonBody, readRawBody, parseCookies, sendJson, clientIp, acceptLanguages, HttpError } from './http'
import { ApiDispatcher } from './api'
import { createEventHub } from './events'
import { handleMediaRequest } from './media'
import { handleWebRequest } from './webapp'
import { handleMcpRequest } from './mcp'
import type { McpServer } from '../core/mcp/server'
import { resolveLocale, setLocale } from '../shared/i18n'
import type { VixelServices } from '../services/api'
import type { createServiceEvents } from '../services/events'
import type { ImageQueryInput, MediaFilters } from '../shared/types'

/** JSON 请求体上限 */
const JSON_BODY_LIMIT = 10 * 1024 * 1024
/** 以图搜图上传的图片字节上限 */
const IMAGE_UPLOAD_LIMIT = 64 * 1024 * 1024

export interface ServerAppOptions {
  services: VixelServices
  /** 服务层事件总线（订阅端）：桥接到 WebSocket 广播 */
  events: ReturnType<typeof createServiceEvents>
  /** 会话签名密钥所在目录（server-secret；桌面 = userData，服务器 = VIXEL_DATA_DIR） */
  dataDir: string
  /** 网页前端构建产物目录（dist/web） */
  webDir: string
  /** 单用户口令；null = 不要求登录（服务器版的 VIXEL_ALLOW_NO_AUTH / 桌面的仅回环模式） */
  password: string | null
  cookieSecure: boolean
  trustProxy: boolean
  /** 媒体路由允许读取的根：数据目录 + 监视文件夹（每次现取，增删文件夹立即生效） */
  allowedRoots(): string[]
  /**
   * /mcp 端点；null = 不开。token 是 bearer 令牌；httpBase 决定结果里的 http 媒体链接基址
   * （桌面给固定地址，Docker 按请求的 Host 头）。
   */
  mcp: { server: McpServer; token: string; httpBase(req: IncomingMessage): string | null } | null
  /**
   * "跟随系统"的语言跟随浏览器（服务器版：与 createServices 共享同一个数组，原地更新）。
   * 桌面宿主不传 —— 手机浏览器的语言不该改掉桌面应用的界面语言。
   */
  preferredLanguages?: string[]
}

export interface VixelServerApp {
  /** http.createServer 的监听器（内部已兜住异常） */
  requestListener(req: IncomingMessage, res: ServerResponse): void
  /** server.on('upgrade')：/events 的 WebSocket（要求有效会话 cookie） */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void
  /** 断开所有 WebSocket、退订事件总线（HTTP server 本身由宿主关） */
  close(): void
}

interface AppState extends ServerAppOptions {
  dispatcher: ApiDispatcher
  sessions: SessionManager
  rateLimiter: LoginRateLimiter
  secret: Buffer
  requireAuth: boolean
}

/**
 * 界面语言"跟随系统"在服务器上 = 跟随浏览器：服务端生成的文案（自动标签名等）要和网页界面同语言。
 * 浏览器语言变了才重新解析（同一台设备的请求不做任何事）。
 */
function syncClientLocale(state: AppState, req: IncomingMessage): void {
  if (!state.preferredLanguages) return
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
function cookieSecure(state: AppState, req: IncomingMessage): boolean {
  if (state.cookieSecure) return true
  if (!state.trustProxy) return false
  const proto = req.headers['x-forwarded-proto']
  const first = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0].trim().toLowerCase()
  return first === 'https'
}

function sessionCookie(state: AppState, req: IncomingMessage, token: string): string {
  const secure = cookieSecure(state, req) ? '; Secure' : ''
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict${secure}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`
}

function isAuthed(state: AppState, req: IncomingMessage): boolean {
  if (!state.requireAuth) return true
  return state.sessions.verify(parseCookies(req.headers.cookie)[SESSION_COOKIE])
}

async function handleLogin(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = clientIp(req, state.trustProxy)
  if (state.rateLimiter.isLimited(ip)) {
    sendJson(res, 429, { ok: false, error: 'Too many failed login attempts, try again later' })
    return
  }
  const body = await readJsonBody<{ password?: unknown }>(req, 64 * 1024)
  if (!state.password || !passwordMatches(state.secret, state.password, body.password)) {
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
async function handleSearchByImage(state: AppState, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
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

async function handleRequest(state: AppState, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const pathname = url.pathname

  // Docker healthcheck：不鉴权，也不暴露任何信息
  if (req.method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true })
    return
  }

  // ─ MCP（bearer 令牌认证，与会话 cookie 无关；未配置令牌时该路由不存在）─
  if (pathname === '/mcp') {
    if (!state.mcp) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    await handleMcpRequest(req, res, { mcp: state.mcp.server, token: state.mcp.token, httpBase: state.mcp.httpBase })
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
      webDir: state.webDir,
      isAuthed: (r) => isAuthed(state, r),
    })
    return
  }

  sendJson(res, 404, { ok: false, error: 'not found' })
}

// ─── 构造 ──────────────────────────────────────────────────────────────────

export function createServerApp(options: ServerAppOptions): VixelServerApp {
  // 会话签名密钥随机生成并持久化（<dataDir>/server-secret）：重启后已登录的浏览器不掉线
  const secret = loadOrCreateSecret(options.dataDir)
  const state: AppState = {
    ...options,
    dispatcher: new ApiDispatcher(options.services.api),
    secret,
    sessions: new SessionManager(secret),
    rateLimiter: new LoginRateLimiter(),
    requireAuth: options.password != null,
  }

  const hub = createEventHub(state.sessions, state.requireAuth)
  const unsubscribe = options.events.on((channel, payload) => hub.broadcast(channel, payload))

  return {
    requestListener(req, res) {
      handleRequest(state, req, res).catch((err) => {
        const status = err instanceof HttpError ? err.status : 500
        if (!res.headersSent) sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) })
        else res.destroy()
      })
    },
    handleUpgrade: (req, socket, head) => hub.handleUpgrade(req, socket, head),
    close() {
      unsubscribe()
      hub.close()
    },
  }
}
