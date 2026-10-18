/**
 * 本地接口（设置 › 通用 › 本地接口）：在 Electron 主进程里跑服务器版同一套 HTTP 栈
 * （src/server/app.ts：/api、/media、/mcp、网页前端、WebSocket 事件），复用桌面已经在跑的
 * services / 数据库实例 —— 手机浏览器看桌面的库，AI 客户端经 /mcp 查询，GitHub issue #3 的
 * "本地网络服务"就是它。
 *
 * 安全模型（默认关闭，开了也先只给本机）：
 *   - 默认只监听 127.0.0.1，不要求登录（和浏览器扩展收集服务同一姿势；CSRF 头照常要求）
 *   - "允许局域网访问" 绑定 0.0.0.0，强制要求口令（没口令直接拒绝开启），此时本机访问也要登录
 *   - /mcp 永远要求 bearer 令牌（随机生成、设置页可看可换），与会话 cookie 无关
 *   - 本服务只监听、从不发起任何对外请求，渲染进程的离线白名单不受影响
 */
import { createServer, type Server } from 'http'
import { randomBytes } from 'crypto'
import { networkInterfaces } from 'os'
import type { DatabaseInstance } from '../core/db'
import type { SearchEngine } from '../core/search'
import { createServerApp, type VixelServerApp } from '../server/app'
import { createMcpServer } from '../core/mcp/server'
import { createToolContext } from '../core/mcp/tools'
import type { VixelServices } from '../services/api'
import type { createServiceEvents } from '../services/events'
import { DEFAULT_LOCALAPI_PORT, type LocalApiPatch, type LocalApiStatus } from '../shared/localapi'
import type { DeepLinkTarget } from '../shared/deeplink'

const KEY = {
  enabled: 'localapi.enabled',
  port: 'localapi.port',
  lan: 'localapi.lan',
  password: 'localapi.password',
  mcpToken: 'localapi.mcp_token',
} as const

export interface LocalApiDeps {
  /** 本机点开的 /open?… 链接：在 Vixel 窗口里定位（返回是否找到） */
  openInApp: (target: DeepLinkTarget) => Promise<boolean>
  db: DatabaseInstance
  services: VixelServices
  events: ReturnType<typeof createServiceEvents>
  searchEngine: SearchEngine
  /** userData：server-secret、library.db 都在这里 */
  dataDir: string
  /** 网页前端构建产物（打包版 <resources>/web，开发 dist/web） */
  webDir: string
  version: string
}

export class LocalApiServer {
  private server: Server | null = null
  private app: VixelServerApp | null = null
  /** 当前跑的是完整本地接口，还是只响应链接的常驻服务 */
  private linksOnly = false
  private error: string | null = null

  constructor(private deps: LocalApiDeps) {}

  private get enabled(): boolean { return this.deps.db.getMetaState(KEY.enabled) === '1' }
  private get lan(): boolean { return this.deps.db.getMetaState(KEY.lan) === '1' }
  private get password(): string { return this.deps.db.getMetaState(KEY.password) ?? '' }
  private get port(): number {
    const p = Number(this.deps.db.getMetaState(KEY.port))
    return Number.isInteger(p) && p >= 1024 && p <= 65535 ? p : DEFAULT_LOCALAPI_PORT
  }

  /** /mcp 的 bearer 令牌：首次用到时随机生成并持久化 */
  private get mcpToken(): string {
    let tok = this.deps.db.getMetaState(KEY.mcpToken)
    if (!tok) {
      tok = randomBytes(24).toString('base64url')
      this.deps.db.setMetaState(KEY.mcpToken, tok)
    }
    return tok
  }

  /** 正在监听的可访问地址：回环 + （LAN 时）各网卡的 IPv4 */
  private urls(): string[] {
    if (!this.server?.listening || this.linksOnly) return []
    const out = [`http://127.0.0.1:${this.port}`]
    if (this.lan) {
      for (const addrs of Object.values(networkInterfaces())) {
        for (const a of addrs ?? []) {
          if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${this.port}`)
        }
      }
    }
    return out
  }

  /** "拷贝链接"的基址：局域网开着 → 第一个局域网地址；否则 localhost（读着比 127.0.0.1 友好，Host 校验同样放行） */
  private linkBase(): string | null {
    if (!this.server?.listening) return null
    const lan = this.urls().find((u) => !u.startsWith('http://127.0.0.1'))
    return lan ?? `http://localhost:${this.port}`
  }

  status(): LocalApiStatus {
    return {
      enabled: this.enabled,
      running: (this.server?.listening ?? false) && !this.linksOnly,
      port: this.port,
      lan: this.lan,
      hasPassword: this.password.length > 0,
      mcpToken: this.mcpToken,
      urls: this.urls(),
      error: this.error,
      linksRunning: this.server?.listening ?? false,
      linkBase: this.linkBase(),
    }
  }

  async update(patch: unknown): Promise<LocalApiStatus> {
    const p = (patch ?? {}) as LocalApiPatch
    const { db } = this.deps
    if (typeof p.port === 'number' && Number.isInteger(p.port) && p.port >= 1024 && p.port <= 65535) {
      db.setMetaState(KEY.port, String(p.port))
    }
    if (typeof p.password === 'string') {
      const pw = p.password.trim()
      if (pw === '' && this.lan) {
        // 局域网开着不许清口令；先关 LAN
        this.error = 'password-required'
        return this.status()
      }
      if (pw === '' || pw.length >= 4) db.setMetaState(KEY.password, pw)
    }
    if (typeof p.lan === 'boolean') {
      if (p.lan && !this.password) {
        this.error = 'password-required'
        return this.status()
      }
      db.setMetaState(KEY.lan, p.lan ? '1' : '0')
    }
    if (typeof p.enabled === 'boolean') db.setMetaState(KEY.enabled, p.enabled ? '1' : '0')
    await this.stop()
    await this.start()
    return this.status()
  }

  async regenerateToken(): Promise<LocalApiStatus> {
    this.deps.db.setMetaState(KEY.mcpToken, randomBytes(24).toString('base64url'))
    // 正在跑的话重启，让新令牌立即生效（app 持有的是旧值）
    if (this.server) {
      await this.stop()
      await this.start()
    }
    return this.status()
  }

  /** 应用启动时调用：开了本地接口就起完整栈，否则起只响应链接的常驻服务 */
  startOnLaunch(): void {
    void this.start()
  }

  private start(): Promise<void> {
    this.error = null
    const { db, services, events, searchEngine, dataDir, webDir, version, openInApp } = this.deps
    const linksOnly = !this.enabled
    const lan = this.lan && !linksOnly
    const port = this.port
    // LAN 必须有口令（update 已拦；这里兜底防直接改库）
    if (lan && !this.password) {
      this.error = 'password-required'
      console.warn('[localapi] LAN access requires a password — not starting')
      return Promise.resolve()
    }
    const app = createServerApp({
      services,
      events,
      dataDir,
      webDir,
      openInApp,
      linksOnly,
      // 仅回环时不要求登录（与浏览器扩展收集服务一致）；一开局域网就强制口令，连本机也要登录
      password: lan ? this.password : null,
      cookieSecure: false,
      trustProxy: false,
      allowedRoots: () => [dataDir, ...db.getFolders().map((f) => f.path)],
      mcp: linksOnly ? null : {
        server: createMcpServer(createToolContext(db, searchEngine), {
          name: 'vixel',
          version,
          instructions: 'Read-only access to the user\'s local Vixel photo/video/audio library. Links in results: "link" opens the item in the Vixel desktop app (vixel:// deep link), "httpUrl" serves the media over this local HTTP API.',
        }),
        token: this.mcpToken,
        httpBase: () => `http://127.0.0.1:${port}`,
      },
    })

    return new Promise((resolve) => {
      const server = createServer(app.requestListener)
      server.on('upgrade', app.handleUpgrade)
      server.on('error', (err: NodeJS.ErrnoException) => {
        this.error = err.code === 'EADDRINUSE' ? 'port-in-use' : err.message
        console.warn('[localapi] server error:', err.message)
        this.server = null
        app.close()
        this.app = null
        resolve()
      })
      server.listen(port, lan ? '0.0.0.0' : '127.0.0.1', () => {
        this.server = server
        this.app = app
        this.linksOnly = linksOnly
        console.log(linksOnly
          ? `[localapi] link service on 127.0.0.1:${port} (/open only)`
          : `[localapi] serving library on ${lan ? '0.0.0.0' : '127.0.0.1'}:${port} (lan: ${lan}, auth: ${lan ? 'password' : 'none'}, /mcp: bearer token)`)
        resolve()
      })
    })
  }

  stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.app?.close() // 断开 WebSocket、退订事件总线
    this.app = null
    // keep-alive 连接会拖住 close 回调（设置页开关要立等生效）：直接掐掉
    server?.closeAllConnections?.()
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()))
  }
}
