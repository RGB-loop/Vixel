import { describe, it, expect } from 'vitest'
import { Readable } from 'stream'
import type { IncomingMessage, ServerResponse } from 'http'
import { handleMcpRequest, mcpTokenMatches, originAllowed, parseBearer } from './mcp'
import type { McpServer } from '../core/mcp/server'

const TOKEN = 'test-token-0123456789abcdef'

/** 假请求：Readable + headers / method（够 readJsonBody 用） */
function fakeReq(opts: { method?: string; headers?: Record<string, string>; body?: unknown }): IncomingMessage {
  const req = Readable.from(opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]) as unknown as IncomingMessage
  req.method = opts.method ?? 'POST'
  req.headers = { host: '127.0.0.1:41721', ...(opts.headers ?? {}) }
  return req
}

function fakeRes(): { res: ServerResponse; done: Promise<{ status: number; body: unknown }> } {
  let status = 0
  const headers: Record<string, unknown> = {}
  let resolve: (v: { status: number; body: unknown }) => void
  const done = new Promise<{ status: number; body: unknown }>((r) => { resolve = r })
  const res = {
    setHeader: (k: string, v: unknown) => { headers[k.toLowerCase()] = v },
    writeHead(code: number) { status = code; return this },
    end: (data?: unknown) => {
      let body: unknown = null
      if (typeof data === 'string' && data) { try { body = JSON.parse(data) } catch { body = data } }
      resolve({ status, body })
    },
  } as unknown as ServerResponse
  return { res, done }
}

/** 回显式 MCP 核心：验证传输层转交消息、汇集响应 */
const echoServer: McpServer = {
  async handleMessage(msg) {
    const m = msg as { id?: number | string; method?: string }
    if (m.id === undefined) return null // 通知
    return { jsonrpc: '2.0', id: m.id ?? null, result: { echo: m.method } }
  },
}

const deps = { mcp: echoServer, token: TOKEN, httpBase: () => 'http://127.0.0.1:41721' }

describe('mcpTokenMatches / parseBearer / originAllowed', () => {
  it('matches only the exact token', () => {
    expect(mcpTokenMatches(TOKEN, TOKEN)).toBe(true)
    expect(mcpTokenMatches(TOKEN, TOKEN + 'x')).toBe(false)
    expect(mcpTokenMatches(TOKEN, '')).toBe(false)
    expect(mcpTokenMatches(TOKEN, undefined)).toBe(false)
    expect(mcpTokenMatches(TOKEN, 'x'.repeat(2000))).toBe(false)
  })

  it('parses the Authorization header case-insensitively', () => {
    expect(parseBearer(`Bearer ${TOKEN}`)).toBe(TOKEN)
    expect(parseBearer(`bearer ${TOKEN}`)).toBe(TOKEN)
    expect(parseBearer('Basic abc')).toBeUndefined()
    expect(parseBearer(undefined)).toBeUndefined()
  })

  it('allows absent Origin and same-host / localhost origins only', () => {
    expect(originAllowed(undefined, '192.168.1.5:41721')).toBe(true)
    expect(originAllowed('http://192.168.1.5:41721', '192.168.1.5:41721')).toBe(true)
    expect(originAllowed('http://localhost:5173', '127.0.0.1:41721')).toBe(true)
    expect(originAllowed('https://evil.example', '127.0.0.1:41721')).toBe(false)
    expect(originAllowed('not a url', '127.0.0.1:41721')).toBe(false)
  })
})

describe('handleMcpRequest', () => {
  const call = async (opts: Parameters<typeof fakeReq>[0], d = deps) => {
    const { res, done } = fakeRes()
    await handleMcpRequest(fakeReq(opts), res, d)
    return done
  }

  it('rejects a missing or wrong bearer token with 401', async () => {
    expect((await call({ body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(401)
    expect((await call({ headers: { authorization: 'Bearer wrong' }, body: { jsonrpc: '2.0', id: 1, method: 'ping' } })).status).toBe(401)
  })

  it('rejects foreign origins with 403 even with a valid token', async () => {
    const out = await call({ headers: { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' }, body: {} })
    expect(out.status).toBe(403)
  })

  it('answers a single JSON-RPC request with application/json', async () => {
    const out = await call({ headers: { authorization: `Bearer ${TOKEN}` }, body: { jsonrpc: '2.0', id: 7, method: 'tools/list' } })
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ jsonrpc: '2.0', id: 7, result: { echo: 'tools/list' } })
  })

  it('answers a batch with an array and pure notifications with 202', async () => {
    const batch = await call({ headers: { authorization: `Bearer ${TOKEN}` }, body: [
      { jsonrpc: '2.0', id: 1, method: 'a' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'b' },
    ] })
    expect(batch.status).toBe(200)
    expect(batch.body).toHaveLength(2)
    const note = await call({ headers: { authorization: `Bearer ${TOKEN}` }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } })
    expect(note.status).toBe(202)
  })

  it('rejects non-POST methods with 405 (stateless server, no SSE stream)', async () => {
    const out = await call({ method: 'GET', headers: { authorization: `Bearer ${TOKEN}` } })
    expect(out.status).toBe(405)
  })
})
