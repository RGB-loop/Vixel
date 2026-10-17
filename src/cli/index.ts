#!/usr/bin/env node
/**
 * Vixel CLI — query your local photo library from the command line
 */

import { join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
import { initDatabase, type DatabaseInstance } from '../core/db'
import { SearchEngine } from '../core/search'
import { initEmbeddingServicePath, getEmbeddingService } from '../core/embedding'
import { cmdDoctor, cmdBench } from './doctor'
import { cmdMcp } from './mcp'
import { litertPlatformDir } from '../core/embedding/providers/litert/native'

// 跨平台 userData 路径。打包版目录名取 productName（Vixel），开发版取 package.json name（vixel）；
// 大小写敏感的卷上两者不同，所以都试一遍，VIXEL_DATA_DIR 可显式指定
function getUserDataPath(): string {
  if (process.env.VIXEL_DATA_DIR) return process.env.VIXEL_DATA_DIR
  const base = process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support')
    : process.platform === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const candidates = ['Vixel', 'vixel'].map((n) => join(base, n))
  return candidates.find((d) => existsSync(join(d, 'library.db'))) ?? candidates[0]
}

// 模型目录：VIXEL_MODELS_DIR > 源码仓库 resources/models > 已安装的 Vixel.app
function getModelsDir(): string | undefined {
  const candidates = [
    process.env.VIXEL_MODELS_DIR,
    join(__dirname, '..', '..', '..', 'resources', 'models'),
    process.platform === 'darwin' ? '/Applications/Vixel.app/Contents/Resources/models' : undefined,
  ]
  return candidates.find((d): d is string => !!d && existsSync(d))
}

// LiteRT-LM 原生库目录：VIXEL_LITERT_DIR > 源码仓库 resources/litert/<platform>-<arch> > 已安装的 Vixel.app
function getLiteRtDir(): string | undefined {
  const candidates = [
    process.env.VIXEL_LITERT_DIR,
    join(__dirname, '..', '..', '..', 'resources', 'litert', litertPlatformDir()),
    process.platform === 'darwin' ? '/Applications/Vixel.app/Contents/Resources/litert' : undefined,
  ]
  return candidates.find((d): d is string => !!d && existsSync(d))
}

function getDbPath(): string {
  return join(getUserDataPath(), 'library.db')
}

// 参数解析
function parseArgs(args: string[]): {
  command: string
  positional: string[]
  flags: Record<string, string | boolean>
} {
  const flags: Record<string, string | boolean> = {}
  const positional: string[] = []
  let command = ''

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (!command && !arg.startsWith('-')) {
      command = arg
      continue
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else if (!arg.startsWith('-')) {
      positional.push(arg)
    }
  }

  return { command, positional, flags }
}

// 格式化输出
function output(data: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2))
  } else if (Array.isArray(data)) {
    for (const item of data) {
      console.log(formatRow(item))
    }
  } else {
    console.log(data)
  }
}

function formatRow(item: Record<string, unknown>): string {
  const parts: string[] = []
  if (item.id) parts.push(`#${item.id}`)
  if (item.fileName) parts.push(String(item.fileName))
  if (item.score !== undefined) parts.push(`Score: ${Math.round(Number(item.score) * 100)}%`)
  if (item.takenAt) parts.push(String(item.takenAt).split('T')[0])
  if (item.filePath) parts.push(String(item.filePath))
  return parts.join('  ')
}

// 命令实现
async function cmdSearch(db: DatabaseInstance, positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const query = positional.join(' ')
  if (!query) {
    console.error('Usage: vixel search <query> [--limit N] [--date-from YYYY-MM-DD] [--date-to YYYY-MM-DD] [--json]')
    process.exit(1)
  }

  // 初始化 embedding 服务
  const embeddingService = getEmbeddingService()
  try {
    await embeddingService.init()
  } catch {
    // embedding 不可用时仍可 BM25 搜索
  }

  const engine = new SearchEngine(db)
  const limit = Number(flags.limit) || 20
  const options = {
    dateFrom: flags['date-from'] as string | undefined,
    dateTo: flags['date-to'] as string | undefined,
  }

  const results = await engine.search(query, limit, options)

  if (flags.json) {
    output(results.map((r) => ({
      id: r.photo.id,
      fileName: r.photo.fileName,
      filePath: r.photo.filePath,
      fileHash: r.photo.fileHash,
      score: r.score,
      matchedBy: r.matchedBy,
      caption: r.photo.caption,
      takenAt: r.photo.takenAt,
      width: r.photo.width,
      height: r.photo.height,
    })), true)
  } else {
    console.log(`Found ${results.length} photos:`)
    results.forEach((r, i) => {
      const score = Math.round(r.score * 100)
      const date = r.photo.takenAt ? r.photo.takenAt.split('T')[0] : ''
      console.log(`  #${i + 1}  ${r.photo.fileName.padEnd(30)}  Score: ${score}%  ${date}`)
    })
  }
}

function cmdInfo(db: DatabaseInstance, positional: string[], flags: Record<string, string | boolean>): void {
  const id = Number(positional[0])
  if (!id) {
    console.error('Usage: vixel info <photo-id> [--json]')
    process.exit(1)
  }

  const photo = db.getPhoto(id)
  if (!photo) {
    console.error(`Photo #${id} not found`)
    process.exit(1)
  }

  const detail = db.getPhotoDetail(id)
  const faces = db.getFacesByHash(photo.fileHash)

  const info = {
    ...photo,
    caption: detail?.caption || null,
    faces: faces.map((f) => ({
      personId: f.personId,
      personName: f.personName,
      confidence: f.confidence,
    })),
  }

  if (flags.json) {
    output(info, true)
  } else {
    console.log(`Photo #${photo.id}: ${photo.fileName}`)
    console.log(`  Path: ${photo.filePath}`)
    console.log(`  Hash: ${photo.fileHash}`)
    if (photo.width && photo.height) console.log(`  Size: ${photo.width}x${photo.height}`)
    if (photo.takenAt) console.log(`  Taken: ${photo.takenAt}`)
    if (detail?.caption) console.log(`  Caption: ${detail.caption}`)
    if (faces.length > 0) {
      console.log(`  Faces: ${faces.length}`)
      faces.forEach((f) => {
        console.log(`    - ${f.personName || 'Unknown'} (${Math.round(f.confidence * 100)}%)`)
      })
    }
  }
}

async function cmdSimilar(db: DatabaseInstance, positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const id = Number(positional[0])
  if (!id) {
    console.error('Usage: vixel similar <photo-id> [--limit N] [--json]')
    process.exit(1)
  }

  const photo = db.getPhoto(id)
  if (!photo) {
    console.error(`Photo #${id} not found`)
    process.exit(1)
  }

  const limit = Number(flags.limit) || 10
  const engine = new SearchEngine(db)
  const minSim = flags['min-similarity'] !== undefined ? Number(flags['min-similarity']) : undefined
  const results = engine.findSimilar(photo.fileHash, limit, minSim)

  if (flags.json) {
    output(results.map((r) => ({
      id: r.photo.id,
      fileName: r.photo.fileName,
      filePath: r.photo.filePath,
      score: r.score,
    })), true)
  } else {
    console.log(`Similar to ${photo.fileName} (${results.length} results):`)
    results.forEach((r, i) => {
      console.log(`  #${i + 1}  ${r.photo.fileName.padEnd(30)}  ${Math.round(r.score * 100)}%`)
    })
  }
}

function cmdPeople(db: DatabaseInstance, positional: string[], flags: Record<string, string | boolean>): void {
  if (positional[0] === 'photos') {
    const personId = Number(positional[1])
    if (!personId) {
      console.error('Usage: vixel people photos <person-id> [--limit N] [--json]')
      process.exit(1)
    }
    const limit = Number(flags.limit) || 50
    const photos = db.getPersonPhotos(personId, limit)
    if (flags.json) {
      output(photos.map((p) => ({ id: p.id, fileName: p.fileName, filePath: p.filePath })), true)
    } else {
      console.log(`Photos of person #${personId} (${photos.length}):`)
      photos.forEach((p) => console.log(`  ${p.fileName}  ${p.filePath}`))
    }
    return
  }

  const people = db.getPeople()
  if (flags.json) {
    output(people, true)
  } else {
    if (people.length === 0) {
      console.log('No people found. Run face scan from the GUI first.')
    } else {
      console.log(`${people.length} people:`)
      people.forEach((p) => {
        console.log(`  #${p.id}  ${(p.name || 'Unnamed').padEnd(20)}  ${p.photoCount} photos`)
      })
    }
  }
}

function cmdStats(db: DatabaseInstance, flags: Record<string, string | boolean>): void {
  const stats = db.getPhotoStats()
  const queueStats = db.getQueueStats()
  const people = db.getPeople()

  const data = {
    photos: stats.total,
    uniquePhotos: stats.uniqueTotal,
    thumbnailed: stats.thumbnailed,
    indexed: stats.indexed,
    people: people.length,
    queuePending: queueStats.pending,
  }

  if (flags.json) {
    output(data, true)
  } else {
    console.log('Vixel Library Stats:')
    console.log(`  Photos:     ${stats.total} (${stats.uniqueTotal} unique)`)
    console.log(`  Thumbnails: ${stats.thumbnailed}`)
    console.log(`  Indexed:    ${stats.indexed}`)
    console.log(`  People:     ${people.length}`)
    if (queueStats.pending > 0) {
      console.log(`  Queue:      ${queueStats.pending} pending`)
    }
  }
}

function cmdFolders(db: DatabaseInstance, flags: Record<string, string | boolean>): void {
  const folders = db.getFoldersWithStats()
  if (flags.json) {
    output(folders, true)
  } else {
    if (folders.length === 0) {
      console.log('No folders. Add folders from the GUI.')
    } else {
      folders.forEach((f) => {
        console.log(`  #${f.id}  ${f.path}  (${(f as unknown as Record<string, number>).photoCount || 0} photos)`)
      })
    }
  }
}

function cmdCaption(db: DatabaseInstance, positional: string[], flags: Record<string, string | boolean>): void {
  const id = Number(positional[0])
  if (!id) {
    console.error('Usage: vixel caption <photo-id> [--set <text>] [--json]')
    process.exit(1)
  }

  const photo = db.getPhoto(id)
  if (!photo) {
    console.error(`Photo #${id} not found`)
    process.exit(1)
  }

  if (flags.set && typeof flags.set === 'string') {
    db.saveCaption(photo.fileHash, flags.set)
    console.log('Caption updated.')
    return
  }

  const caption = db.getCaption(photo.fileHash)
  if (flags.json) {
    output({ id: photo.id, fileName: photo.fileName, caption: caption || null }, true)
  } else {
    console.log(`${photo.fileName}: ${caption || '(no caption)'}`)
  }
}

// 主入口
async function main(): Promise<void> {
  // Electron 的 argv: [electron, script.js, ...args]
  // Node 的 argv: [node, script.js, ...args]
  // 跳过所有非命令参数（以 / 或 - 开头且不是 --flag 的）
  let startIdx = 2
  while (startIdx < process.argv.length) {
    const arg = process.argv[startIdx]
    if (arg === '--') { startIdx++; break }
    if (!arg.startsWith('-') && !arg.startsWith('/') && !arg.endsWith('.js')) break
    startIdx++
  }
  const args = process.argv.slice(startIdx)

  // --profile 等同 VIXEL_PROFILE=1；perf 模块在导入时读取环境变量，这里只能提示用法
  if (args.includes('--profile') && process.env.VIXEL_PROFILE !== '1') {
    console.error('Tip: use VIXEL_PROFILE=1 vixel <command> to print slow SQL statements.')
  }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`Vixel CLI — query your local photo library

Usage:
  vixel search <query>         Search photos (semantic + text + filename)
  vixel info <id>              Photo details (EXIF, caption, faces)
  vixel similar <id>           Find similar photos
  vixel people                 List recognized people
  vixel people photos <id>     Photos of a specific person
  vixel stats                  Library statistics
  vixel caption <id>           View or update caption
  vixel folders                List watched folders
  vixel doctor                 Health check: counts, queue errors, query plans
  vixel bench                  Time hot queries and searches on this library
  vixel mcp                    MCP server on stdio for AI clients (read-only; see README)

Flags:
  --json                       JSON output (for scripts/agents)
  --limit <n>                  Max results (default 20)
  --date-from <YYYY-MM-DD>    Filter by date
  --date-to <YYYY-MM-DD>      Filter by date
  --set <text>                 Set caption text
  --min-similarity <0..1>      similar: cosine threshold (default 0.8)
  --runs <n>                   bench: repetitions per operation (default 5)
  --query <a,b,c>              bench: comma-separated search queries

Environment:
  VIXEL_DATA_DIR               Library directory (default: app data dir)
  VIXEL_MODELS_DIR             Models directory (enables semantic search)
  VIXEL_LITERT_DIR             LiteRT-LM runtime directory
  VIXEL_PROFILE=1              Log slow SQL statements`)
    process.exit(0)
  }

  const { command, positional, flags } = parseArgs(args)

  // MCP：stdout 是 JSON-RPC 协议通道，任何日志（迁移提示、模型加载）都改走 stderr
  if (command === 'mcp') {
    console.log = (...a: unknown[]) => console.error(...a)
  }

  // 检查数据库
  const dbPath = getDbPath()
  if (!existsSync(dbPath)) {
    console.error(`Database not found at ${dbPath}`)
    console.error('Launch the Vixel app first to create a photo library.')
    process.exit(1)
  }

  // 初始化。只有改 caption 需要写库；其余只读打开，不跑迁移，应用开着也安全
  const modelsDir = getModelsDir()
  initEmbeddingServicePath(getUserDataPath(), modelsDir, getLiteRtDir())
  if (!modelsDir && (command === 'search' || command === 'similar' || command === 'bench' || command === 'mcp')) {
    console.error('Note: models not found — semantic search disabled (set VIXEL_MODELS_DIR). Text and filename matching still work.')
  }
  const writes = command === 'caption' && flags.set !== undefined
  let db: DatabaseInstance
  try {
    db = initDatabase(dbPath, { runCleanup: false, readonly: !writes })
  } catch {
    // 只读打开失败的两种情况：库是旧版本、还没迁移；或应用没在运行、WAL 的 -shm 文件不存在
    // （只读连接创建不了它）。两种情况下读写打开都安全 —— 迁移与应用启动时跑的完全相同
    db = initDatabase(dbPath, { runCleanup: false })
  }

  try {
    switch (command) {
      case 'search':
        await cmdSearch(db, positional, flags)
        break
      case 'info':
        cmdInfo(db, positional, flags)
        break
      case 'similar':
        await cmdSimilar(db, positional, flags)
        break
      case 'people':
        cmdPeople(db, positional, flags)
        break
      case 'stats':
        cmdStats(db, flags)
        break
      case 'folders':
        cmdFolders(db, flags)
        break
      case 'caption':
        cmdCaption(db, positional, flags)
        break
      case 'doctor':
        cmdDoctor(db, dbPath, flags)
        break
      case 'bench':
        await cmdBench(db, flags)
        break
      case 'mcp':
        await cmdMcp(db)
        break
      default:
        console.error(`Unknown command: ${command}`)
        console.error('Run "vixel --help" for usage.')
        process.exit(1)
    }
  } finally {
    db.close()
  }
}

main().catch((err) => {
  console.error('Error:', err.message || err)
  process.exit(1)
})
