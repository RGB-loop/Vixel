/**
 * 深链接的 OS 侧（vixel://open?…，格式见 shared/deeplink.ts）：
 *
 *   - macOS：open-url 事件（必须在 app ready 之前就监听好，冷启动的那个链接才接得住）
 *   - Windows / Linux：OS 把链接放在新实例的 argv 里 —— 单实例锁 + second-instance 转交，
 *     冷启动时扫自己的 process.argv
 *
 * 链接可能先于服务就绪到达（冷启动 / 启动中连点），统一进队列，activate() 之后再解析。
 * 解析按 hash → video → id 的顺序查库（hash 是内容哈希，重建索引后依然有效），
 * 命中后复用快速搜索面板的"在主窗口打开结果"通道（含主窗口未建 / 未加载完的暂存逻辑）。
 *
 * 与内部资源协议不冲突：protocol.handle('vixel') 只响应渲染进程发起的 thumb/image/media/
 * sprite/face 请求；OS 转交的外部链接走这里的事件，永远不会进 protocol.handle。
 */
import { app, dialog, type BrowserWindow } from 'electron'
import { resolve as resolvePath } from 'path'
import { parseDeepLink, type DeepLinkTarget } from '../shared/deeplink'
import type { SearchResult } from '../shared/types'
import { t } from '../shared/i18n'

export interface DeepLinkDeps {
  /** 按 target 查库拼出结果（含命中片段）；找不到返回 null */
  resolve(target: DeepLinkTarget): SearchResult | null
  /** 在主窗口打开（quickPanel.openResult：窗口不存在时创建，加载完前暂存） */
  open(result: SearchResult): void
  /** 链接指向的内容不在库里：把主窗口带到前台再说明 */
  ensureMainWindow(): BrowserWindow
}

let pendingUrls: string[] = []
let deps: DeepLinkDeps | null = null

function isDeepLink(arg: string): boolean {
  return typeof arg === 'string' && arg.startsWith('vixel://')
}

function handle(url: string): void {
  if (!deps) {
    pendingUrls.push(url)
    return
  }
  const target = parseDeepLink(url)
  if (!target) {
    console.warn(`[deeplink] ignoring malformed link: ${url}`)
    return
  }
  const result = deps.resolve(target)
  if (result) {
    console.log(`[deeplink] opening ${url}`)
    deps.open(result)
    return
  }
  console.warn(`[deeplink] target not found in library: ${url}`)
  const win = deps.ensureMainWindow()
  void dialog.showMessageBox(win, { type: 'info', message: t.main.deepLinkMissingTitle, detail: t.main.deepLinkMissingDetail })
}

/**
 * 进程启动早期调用（app ready 之前）：挂 open-url / second-instance 监听。
 * Windows / Linux 需要单实例锁（第二个实例只负责把 argv 递过来）；拿不到锁时返回 false，
 * 调用方应直接退出 —— 本实例的使命已由 second-instance 完成。
 */
export function initDeepLinks(): boolean {
  if (process.platform === 'darwin') {
    app.on('open-url', (event, url) => {
      event.preventDefault()
      if (isDeepLink(url)) handle(url)
    })
    return true
  }
  // Windows / Linux：深链接到达的是一个新实例的 argv
  if (!app.requestSingleInstanceLock()) return false
  app.on('second-instance', (_event, argv) => {
    const url = argv.find(isDeepLink)
    if (url) handle(url)
    else deps?.ensureMainWindow()
  })
  return true
}

/** 服务就绪后调用：登记为 vixel:// 的系统默认处理者，并冲掉启动期间攒下的链接 */
export function activateDeepLinks(d: DeepLinkDeps): void {
  deps = d
  // 开发模式（process.defaultApp：electron . 启动）要把入口脚本一起登记，否则 OS 只会裸启 Electron
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('vixel', process.execPath, [resolvePath(process.argv[1])])
    }
  } else {
    app.setAsDefaultProtocolClient('vixel')
  }
  // Windows / Linux 冷启动：链接在自己的 argv 里
  const argvUrl = process.argv.find(isDeepLink)
  if (argvUrl && !pendingUrls.includes(argvUrl)) pendingUrls.push(argvUrl)
  const queued = pendingUrls
  pendingUrls = []
  for (const url of queued) handle(url)
}
