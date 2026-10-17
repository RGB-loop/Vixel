/**
 * `vixel mcp` —— stdio 传输的 MCP 服务器：本地 AI 客户端（Claude Desktop / Cursor / Claude Code）
 * 不开任何网络服务就能查询媒体库。工具与桌面"本地接口"、服务器版 /mcp 完全相同
 * （core/mcp：search_media / get_media / find_similar，全部只读），数据库按 CLI 惯例只读打开。
 *
 * 传输即 MCP 规范的 stdio 形态：stdin 每行一条 JSON-RPC 消息，响应单行 JSON 写 stdout；
 * 日志一律走 stderr（cli/index.ts 在 mcp 命令下已把 console.log 重定向过去）。
 * stdin 关闭（客户端退出）即结束。
 */
import { createInterface } from 'readline'
import { join } from 'path'
import type { DatabaseInstance } from '../core/db'
import { SearchEngine } from '../core/search'
import { getEmbeddingService } from '../core/embedding'
import { createMcpServer, errorResponse, JSONRPC_PARSE_ERROR } from '../core/mcp/server'
import { createToolContext } from '../core/mcp/tools'

/** serverInfo 用的应用版本（dist/cli/cli → 仓库根在三级之上） */
function appVersion(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require(join(__dirname, '..', '..', '..', 'package.json')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export async function cmdMcp(db: DatabaseInstance): Promise<void> {
  // 语义模型尽力加载（找不到模型时 OCR / 文件名 / 标签搜索照常）；失败原因已在 index.ts 提示过
  try {
    await getEmbeddingService().init()
  } catch { /* BM25-only */ }

  const mcp = createMcpServer(createToolContext(db, new SearchEngine(db)), {
    name: 'vixel',
    version: appVersion(),
    instructions:
      'Read-only access to the user\'s local Vixel photo/video/audio library. ' +
      'The "link" field in results is a vixel:// deep link that opens the item in the Vixel app ' +
      '(for video/audio it jumps to the matched timestamp).',
  })

  console.error('[mcp] vixel stdio server ready (read-only); waiting for JSON-RPC on stdin')
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const write = (msg: unknown): void => { process.stdout.write(JSON.stringify(msg) + '\n') }
  for await (const line of rl) {
    const s = line.trim()
    if (!s) continue
    let msg: unknown
    try {
      msg = JSON.parse(s)
    } catch {
      write(errorResponse(null, JSONRPC_PARSE_ERROR, 'Parse error'))
      continue
    }
    // stdio 没有 http 基址：结果只带 vixel:// 深链接
    const out = await mcp.handleMessage(msg)
    if (out) write(out)
  }
}
