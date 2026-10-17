/**
 * 极小的 MCP 服务器核心（不引 SDK）：JSON-RPC 2.0 消息进、消息出，与传输无关 ——
 * HTTP（Streamable HTTP 的 POST 形态，src/server/mcp.ts）和 stdio（CLI `vixel mcp`）共用。
 *
 * 不用官方 @modelcontextprotocol/sdk 的原因：它是 ESM-only 且带 express/zod 等运输层依赖，
 * 塞进 electron-vite 主进程包和 CommonJS 的 tsconfig.server/cli 都要折腾；我们只需要
 * 无状态的 initialize / tools，两百行以内自己写完反而可审计（协议面小、全部只读）。
 *
 * 覆盖 MCP 规范（2025-06-18；也接受 2025-03-26 / 2024-11-05 的客户端）：
 *   initialize / notifications/initialized / ping / tools/list / tools/call
 * 其余方法回 -32601。服务器无状态：不发 server→client 请求，不需要会话。
 */
import { callTool, TOOL_DEFINITIONS, type McpCallExtra, type McpToolContext } from './tools'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
const SUPPORTED_VERSIONS = new Set(['2025-06-18', '2025-03-26', '2024-11-05'])

// JSON-RPC 2.0 错误码
export const JSONRPC_PARSE_ERROR = -32700
export const JSONRPC_INVALID_REQUEST = -32600
export const JSONRPC_METHOD_NOT_FOUND = -32601
export const JSONRPC_INVALID_PARAMS = -32602
export const JSONRPC_INTERNAL_ERROR = -32603

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

export interface McpServerInfo {
  name: string
  version: string
  /** initialize 返回的使用说明（客户端会给模型看） */
  instructions?: string
}

export interface McpServer {
  /**
   * 处理一条已解析的 JSON-RPC 消息。返回 null 表示没有要回的（通知 / 无 id 的坏消息）。
   * extra：本次调用的传输层环境（http 链接基址等）。
   */
  handleMessage(msg: unknown, extra?: McpCallExtra): Promise<JsonRpcResponse | null>
}

export function errorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export function createMcpServer(ctx: McpToolContext, info: McpServerInfo): McpServer {
  async function handleRequest(id: string | number, method: string, params: Record<string, unknown>, extra: McpCallExtra): Promise<JsonRpcResponse> {
    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        return {
          jsonrpc: '2.0',
          id,
          result: {
            // 客户端要的版本我们认识就按它的来，否则报自己的最新版（按规范由客户端决定去留）
            protocolVersion: SUPPORTED_VERSIONS.has(asked) ? asked : MCP_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: info.name, version: info.version },
            ...(info.instructions ? { instructions: info.instructions } : {}),
          },
        }
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} }
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: TOOL_DEFINITIONS } }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : ''
        const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>
        let outcome
        try {
          outcome = await callTool(ctx, name, args, extra)
        } catch (err) {
          // 工具执行失败按规范放进 result（isError），模型能看到并自行调整，而不是协议层错误
          const msg = err instanceof Error ? err.message : String(err)
          return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Tool failed: ${msg}` }], isError: true } }
        }
        if (!outcome) return errorResponse(id, JSONRPC_INVALID_PARAMS, `Unknown tool: ${name}`)
        if (outcome.invalidParams) return errorResponse(id, JSONRPC_INVALID_PARAMS, outcome.invalidParams)
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(outcome.result, null, 2) }],
            structuredContent: outcome.result,
          },
        }
      }
      default:
        return errorResponse(id, JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`)
    }
  }

  return {
    async handleMessage(msg, extra = {}) {
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        return errorResponse(null, JSONRPC_INVALID_REQUEST, 'Expected a JSON-RPC message object')
      }
      const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }
      const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null
      if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
        // 坏通知（无 id）没有可回的对象
        return id === null ? null : errorResponse(id, JSONRPC_INVALID_REQUEST, 'Not a JSON-RPC 2.0 request')
      }
      // 通知：notifications/initialized / notifications/cancelled 等都不需要回应
      if (id === null || m.method.startsWith('notifications/')) return null
      const params = (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>
      try {
        return await handleRequest(id, m.method, params, extra)
      } catch (err) {
        console.error(`[mcp] ${m.method} failed:`, err)
        return errorResponse(id, JSONRPC_INTERNAL_ERROR, err instanceof Error ? err.message : String(err))
      }
    },
  }
}
