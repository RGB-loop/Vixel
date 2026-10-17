import { describe, it, expect } from 'vitest'
import { createMcpServer, JSONRPC_INVALID_PARAMS, JSONRPC_METHOD_NOT_FOUND, MCP_PROTOCOL_VERSION } from './server'
import type { McpToolContext } from './tools'
import type { Photo, SearchResult } from '../../shared/types'

const photo = (over: Partial<Photo> = {}): Photo => ({
  id: 1, folderId: 1, filePath: '/lib/beach.jpg', fileName: 'beach.jpg', fileSize: 1000,
  fileMtime: 0, fileHash: 'aa11bb22cc33dd44', embedStatus: 'done', createdAt: '', updatedAt: '',
  mediaKind: 'image', ...over,
})

/** 假上下文：一条图片 + 一条带片段的视频结果 */
function fakeCtx(over: Partial<Record<string, unknown>> = {}): McpToolContext {
  const results: SearchResult[] = [
    { photo: photo(), score: 0.91, matchedBy: ['visual'] },
    {
      photo: photo({ id: 2, fileName: 'surf.mp4', filePath: '/lib/surf.mp4', fileHash: 'deadbeef00112233', mediaKind: 'video', videoId: 7 }),
      score: 0.8,
      segment: { startMs: 32_000, endMs: 64_000 },
      matchedBy: ['segment'],
    },
  ]
  return {
    db: {
      getPhoto: (id: number) => (id === 1 ? photo() : undefined),
      getRepresentativeByHash: (h: string) => (h === 'aa11bb22cc33dd44' ? photo() : undefined),
      getVideoById: () => undefined,
      getPhotoDetail: () => ({ ...photo(), caption: 'a beach', ocrText: 'SALE 2024' }),
      getMediaDetail: () => undefined,
      getFacesByHash: () => [{ personName: 'Ann' }, { personName: null }],
      ...over,
    } as never,
    searchEngine: {
      search: async () => results,
      findSimilar: () => [results[0]],
      ...(over.searchEngine as object ?? {}),
    } as never,
    tagStore: { forHashes: () => ({ all: [{ name: '海滩' }], some: [] }) } as never,
  }
}

const server = () => createMcpServer(fakeCtx(), { name: 'vixel', version: '0.5.1' })
const req = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, params })

describe('MCP server core', () => {
  it('initialize negotiates a supported protocol version and announces tools', async () => {
    const res = await server().handleMessage(req(1, 'initialize', { protocolVersion: '2025-03-26' }))
    expect(res?.result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'vixel', version: '0.5.1' },
    })
    // 不认识的版本 → 报自己的最新版
    const res2 = await server().handleMessage(req(2, 'initialize', { protocolVersion: '1999-01-01' }))
    expect((res2?.result as { protocolVersion: string }).protocolVersion).toBe(MCP_PROTOCOL_VERSION)
  })

  it('notifications and bad no-id messages produce no response', async () => {
    const s = server()
    expect(await s.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
    expect(await s.handleMessage({ jsonrpc: '1.0', method: 'x' })).toBeNull()
  })

  it('tools/list returns the three read-only tools with schemas', async () => {
    const res = await server().handleMessage(req(3, 'tools/list'))
    const tools = (res?.result as { tools: Array<{ name: string; inputSchema: unknown }> }).tools
    expect(tools.map((t) => t.name)).toEqual(['search_media', 'get_media', 'find_similar'])
    for (const t of tools) expect(t.inputSchema).toBeTruthy()
  })

  it('tools/call search_media returns items with deep links and time ranges', async () => {
    const res = await server().handleMessage(
      req(4, 'tools/call', { name: 'search_media', arguments: { query: '海边' } }),
      { httpBase: 'http://127.0.0.1:41721' }
    )
    const result = res?.result as { content: Array<{ type: string; text: string }>; structuredContent: { items: Array<Record<string, unknown>> } }
    expect(result.content[0].type).toBe('text')
    const items = result.structuredContent.items
    expect(items[0]).toMatchObject({
      id: 1, name: 'beach.jpg', type: 'image',
      link: 'vixel://open?hash=aa11bb22cc33dd44&id=1',
      httpUrl: 'http://127.0.0.1:41721/media/image/1',
    })
    expect(items[1]).toMatchObject({
      videoId: 7,
      timeRange: { startSec: 32, endSec: 64 },
      link: 'vixel://open?hash=deadbeef00112233&video=7&t=32',
      httpUrl: 'http://127.0.0.1:41721/media/media/7',
    })
  })

  it('tools/call get_media returns OCR text, tags and people', async () => {
    const res = await server().handleMessage(req(5, 'tools/call', { name: 'get_media', arguments: { id: 1 } }))
    expect((res?.result as { structuredContent: unknown }).structuredContent).toMatchObject({
      found: true, id: 1, ocrText: 'SALE 2024', caption: 'a beach', tags: ['海滩'], people: ['Ann'],
    })
    const miss = await server().handleMessage(req(6, 'tools/call', { name: 'get_media', arguments: { id: 999 } }))
    expect((miss?.result as { structuredContent: unknown }).structuredContent).toEqual({ found: false })
  })

  it('rejects bad input as Invalid params, unknown tools and unknown methods', async () => {
    const s = server()
    const noQuery = await s.handleMessage(req(7, 'tools/call', { name: 'search_media', arguments: {} }))
    expect(noQuery?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
    const badTool = await s.handleMessage(req(8, 'tools/call', { name: 'delete_everything', arguments: {} }))
    expect(badTool?.error?.code).toBe(JSONRPC_INVALID_PARAMS)
    const badMethod = await s.handleMessage(req(9, 'resources/list'))
    expect(badMethod?.error?.code).toBe(JSONRPC_METHOD_NOT_FOUND)
  })

  it('tool execution failure is reported as an in-band isError result, not a protocol error', async () => {
    const boom = createMcpServer(
      fakeCtx({ searchEngine: { search: async () => { throw new Error('db locked') } } }),
      { name: 'vixel', version: '0.5.1' }
    )
    const res = await boom.handleMessage(req(10, 'tools/call', { name: 'search_media', arguments: { query: 'x' } }))
    expect(res?.error).toBeUndefined()
    expect(res?.result).toMatchObject({ isError: true })
  })
})
