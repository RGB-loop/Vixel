/**
 * /mcp 路由：MCP Streamable HTTP 传输（规范 2025-06-18）的最小合规实现。
 *
 *   POST /mcp   body 为一条 JSON-RPC 消息（或旧版客户端的批量数组）→ application/json 响应；
 *               纯通知回 202。服务器无状态、不发起 server→client 请求，所以不开 SSE 流 ——
 *   GET /mcp    按规范允许的方式回 405（不提供服务器推送流）。
 *
 * 认证：Authorization: Bearer <token>（设置页生成 / Docker 的 VIXEL_MCP_TOKEN），常数时间比较；
 * 不走会话 cookie，浏览器脚本拿不到令牌，天然免 CSRF。按规范校验 Origin（防 DNS rebinding）：
 * 带 Origin 的请求必须来自本服务自身地址，其余 403 —— MCP 客户端（Claude/Cursor 等）不发 Origin。
 */
import type { IncomingMessage, ServerResponse } from 'http'
import { createHash, timingSafeEqual } from 'crypto'
import { HttpError, readJsonBody, sendJson } from './http'
import {
  errorResponse, JSONRPC_INVALID_REQUEST, JSONRPC_PARSE_ERROR, type JsonRpcResponse, type McpServer,
} from '../core/mcp/server'

/** JSON-RPC 请求体上限：工具入参都是短文本，1 MB 绰绰有余 */
const MCP_BODY_LIMIT = 1024 * 1024

/** 常数时间的令牌比较（先 hash 到定长，长度差异不泄露） */
export function mcpTokenMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0 || provided.length > 1024) return false
  const h = (s: string): Buffer => createHash('sha256').update(s).digest()
  return timingSafeEqual(h(expected), h(provided))
}

/** Authorization: Bearer xxx → xxx */
export function parseBearer(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header[0] : header
  const m = /^Bearer\s+(.+)$/i.exec(raw ?? '')
  return m?.[1]
}

/** 带 Origin 的请求必须指向本服务自身（防浏览器里的 DNS rebinding）；没有 Origin 的照常放行 */
export function originAllowed(origin: string | string[] | undefined, host: string | string[] | undefined): boolean {
  const o = Array.isArray(origin) ? origin[0] : origin
  if (!o) return true
  let originHost: string
  try {
    originHost = new URL(o).host
  } catch {
    return false
  }
  const h = (Array.isArray(host) ? host[0] : host) ?? ''
  return originHost === h || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(originHost)
}

export interface McpHttpDeps {
  mcp: McpServer
  token: string
  /** http 媒体链接的基址（结果里的 httpUrl）；按请求现算，null = 不带 http 链接 */
  httpBase(req: IncomingMessage): string | null
}

/** 处理已路由到 /mcp 的请求（任何方法）。总是响应。 */
export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, deps: McpHttpDeps): Promise<void> {
  if (!originAllowed(req.headers.origin, req.headers.host)) {
    sendJson(res, 403, { ok: false, error: 'Origin not allowed' })
    return
  }
  if (!mcpTokenMatches(deps.token, parseBearer(req.headers.authorization))) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="vixel-mcp"')
    sendJson(res, 401, { ok: false, error: 'Missing or invalid bearer token' })
    return
  }
  if (req.method !== 'POST') {
    // 无状态服务器不提供 server→client 推送流；405 是规范允许的回答
    res.setHeader('Allow', 'POST')
    sendJson(res, 405, { ok: false, error: 'MCP endpoint is POST-only (no server-initiated stream)' })
    return
  }

  let body: unknown
  try {
    body = await readJsonBody<unknown>(req, MCP_BODY_LIMIT)
  } catch (err) {
    if (err instanceof HttpError && err.status === 413) throw err
    sendJson(res, 400, errorResponse(null, JSONRPC_PARSE_ERROR, 'Parse error'))
    return
  }

  const extra = { httpBase: deps.httpBase(req) }
  // 2025-03-26 及更早的客户端可能发批量数组；逐条处理，保持顺序
  const messages = Array.isArray(body) ? body : [body]
  if (messages.length === 0) {
    sendJson(res, 400, errorResponse(null, JSONRPC_INVALID_REQUEST, 'Empty batch'))
    return
  }
  const responses: JsonRpcResponse[] = []
  for (const msg of messages) {
    const out = await deps.mcp.handleMessage(msg, extra)
    if (out) responses.push(out)
  }
  if (responses.length === 0) {
    // 纯通知（如 notifications/initialized）：202 Accepted，无响应体
    res.writeHead(202).end()
    return
  }
  sendJson(res, 200, Array.isArray(body) ? responses : responses[0])
}
