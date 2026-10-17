/**
 * 服务器配置：全部来自环境变量（Docker / NAS 的习惯），启动时解析一次。
 *
 *   VIXEL_DATA_DIR       数据目录（library.db、thumbnails、各种缓存）。必填。
 *   VIXEL_LIBRARY_DIRS   逗号分隔的媒体库目录；启动时登记为监视文件夹并保持同步
 *   VIXEL_MODELS_DIR     模型目录（默认 <repo>/resources/models）
 *   VIXEL_LITERT_DIR     LiteRT-LM 原生库目录（默认 <repo>/resources/litert/<platform>-<arch>）
 *   VIXEL_PORT           HTTP + WebSocket 端口（默认 8080）
 *   VIXEL_HOST           监听地址（默认 0.0.0.0）
 *   VIXEL_PASSWORD       单用户口令；不设则拒绝启动（本机开发可 VIXEL_ALLOW_NO_AUTH=1）
 *   VIXEL_ALLOW_NO_AUTH  =1 允许无口令启动（仅本地开发）
 *   VIXEL_THREADS        CPU 推理线程数（透传给 LiteRT，见 litertProvider）
 *   VIXEL_WEB_DIR        网页前端构建产物目录（默认 <repo>/dist/web，npm run build:web）
 *   VIXEL_COOKIE_SECURE  =1 会话 cookie 加 Secure（仅 HTTPS 反代场景；纯 HTTP 下登录会失效）
 *   VIXEL_TRUST_PROXY    =1 信任反代头：X-Forwarded-Proto=https 时自动加 Secure，
 *                        登录限速按 X-Forwarded-For 的客户端 IP 计
 *   VIXEL_MCP_TOKEN      /mcp 端点（AI 客户端的只读 MCP 接口）的 bearer 令牌，≥ 16 位；
 *                        不设则 /mcp 关闭。生成：openssl rand -base64 24
 */
import { isAbsolute, join, resolve } from 'path'

export interface ServerConfig {
  dataDir: string
  libraryDirs: string[]
  modelsDir: string
  litertDir: string
  port: number
  host: string
  password: string | null
  allowNoAuth: boolean
  webDir: string
  /** 会话 cookie 始终带 Secure（VIXEL_COOKIE_SECURE=1） */
  cookieSecure: boolean
  /** 信任反代头（VIXEL_TRUST_PROXY=1）：X-Forwarded-Proto → Secure；X-Forwarded-For → 限速 IP */
  trustProxy: boolean
  /** /mcp 的 bearer 令牌（VIXEL_MCP_TOKEN）；null = /mcp 关闭 */
  mcpToken: string | null
}

export class ConfigError extends Error {}

export function parseServerConfig(env: Record<string, string | undefined>, repoRoot: string): ServerConfig {
  const dataDir = env.VIXEL_DATA_DIR?.trim()
  if (!dataDir) throw new ConfigError('VIXEL_DATA_DIR is required (library.db, thumbnails and caches live there)')

  const libraryDirs = (env.VIXEL_LIBRARY_DIRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => resolve(p))
  for (const dir of libraryDirs) {
    if (!isAbsolute(dir)) throw new ConfigError(`VIXEL_LIBRARY_DIRS entries must be absolute paths, got: ${dir}`)
  }

  const port = env.VIXEL_PORT ? Number(env.VIXEL_PORT) : 8080
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`VIXEL_PORT must be a port number, got: ${env.VIXEL_PORT}`)
  }

  const password = env.VIXEL_PASSWORD?.trim() || null
  const allowNoAuth = env.VIXEL_ALLOW_NO_AUTH === '1'
  if (!password && !allowNoAuth) {
    throw new ConfigError('VIXEL_PASSWORD is required (set VIXEL_ALLOW_NO_AUTH=1 only for local development)')
  }
  if (password && password.length < 4) {
    throw new ConfigError('VIXEL_PASSWORD must be at least 4 characters')
  }

  // MCP 令牌是机器配置、不用人记：短令牌没有理由存在，直接拒绝
  const mcpToken = env.VIXEL_MCP_TOKEN?.trim() || null
  if (mcpToken && mcpToken.length < 16) {
    throw new ConfigError('VIXEL_MCP_TOKEN must be at least 16 characters (try: openssl rand -base64 24)')
  }

  return {
    dataDir: resolve(dataDir),
    libraryDirs,
    modelsDir: env.VIXEL_MODELS_DIR?.trim() || join(repoRoot, 'resources', 'models'),
    litertDir: env.VIXEL_LITERT_DIR?.trim() || join(repoRoot, 'resources', 'litert', `${process.platform}-${process.arch}`),
    port,
    host: env.VIXEL_HOST?.trim() || '0.0.0.0',
    password,
    allowNoAuth,
    webDir: env.VIXEL_WEB_DIR?.trim() || join(repoRoot, 'dist', 'web'),
    cookieSecure: env.VIXEL_COOKIE_SECURE === '1',
    trustProxy: env.VIXEL_TRUST_PROXY === '1',
    mcpToken,
  }
}
