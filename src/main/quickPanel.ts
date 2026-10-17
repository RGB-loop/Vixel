/**
 * 系统级快速搜索面板（Spotlight / Raycast 式）。
 *
 * 一个常驻的无边框小窗口：全局快捷键（默认 macOS ⇧⌘Space / Windows Alt+Shift+Space）呼出，
 * 懒创建、隐藏复用，所以第二次起弹出是即时的。失焦 / Esc 即隐藏。
 *
 *   - macOS：NSPanel（type 'panel'）+ vibrancy 'hud' —— 非激活式取键，不会把 Vixel
 *     切成前台应用、不动主窗口；setVisibleOnAllWorkspaces(visibleOnFullScreen) 让它
 *     能盖在全屏应用上面。
 *   - Windows：普通无边框窗口、不透明底色（Electron 33 的 acrylic 在 Win10 会退化成
 *     全透明黑窗，不值得冒险）、skipTaskbar。
 *
 * 渲染进程与其他窗口同一入口（#panel 路由）、同一套 webPreferences（sandbox +
 * contextIsolation），离线策略对 session 全局生效，面板天然被覆盖。
 *
 * 快捷键存 meta_state（quickpanel.shortcut / quickpanel.enabled），注册结果如实
 * 回报给设置页（被其他应用占用时 register() 返回 false）。
 */

import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, screen, shell, Tray } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { QUICKPANEL_CHANNELS as QP, defaultShortcut, isValidShortcut, type QuickPanelPending, type QuickPanelSettings } from '../shared/quickpanel'
import { filenamesPlist, writeClipboardHdrop } from './fileClipboard'
import { t } from '../shared/i18n'

const META_KEY_SHORTCUT = 'quickpanel.shortcut'
const META_KEY_ENABLED = 'quickpanel.enabled'

const PANEL_WIDTH = 720
const PANEL_MIN_HEIGHT = 86
const PANEL_MAX_HEIGHT = 600

export interface QuickPanelDeps {
  getMeta(key: string): string | undefined
  setMeta(key: string, value: string): void
  getMainWindow(): BrowserWindow | null
  /** 主窗口不存在时创建（面板里 ↩ / ⌘O 的落点）；返回已 show 的窗口 */
  ensureMainWindow(): BrowserWindow
  loadRenderer(win: BrowserWindow, hash?: string): void
  webPreferences: Electron.WebPreferences
  windowBackground(): string
  /** 经 db 校验的源文件路径：媒体传 videoId，图片传 photoId；库里没有 / 文件不存在 → null */
  resolveFilePath(photoId: number, videoId?: number | null): string | null
  /** 设置变化后重建应用菜单（菜单里显示当前快捷键） */
  onSettingsChanged(): void
}

export interface QuickPanelController {
  show(): BrowserWindow
  hide(): void
  toggle(): void
  getWindow(): BrowserWindow | null
  settings(): QuickPanelSettings
  isEnabled(): boolean
  /** 在主窗口打开一条结果（窗口不存在时创建、加载完前暂存）；深链接（main/deeplink.ts）复用这条通道 */
  openResult(result: unknown): void
  /** Windows：主窗口关闭后是否应留在后台（启用了快捷键）；留下时建托盘 */
  keepAliveOnWindows(): boolean
  ensureTray(): void
  /** 诊断（调试控制端点用）：托盘当前是否存在 */
  hasTray(): boolean
  dispose(): void
}

export function initQuickPanel(deps: QuickPanelDeps): QuickPanelController {
  const isMac = process.platform === 'darwin'
  let panel: BrowserWindow | null = null
  let tray: Tray | null = null
  /** 已注册成功的 accelerator（退出 / 换键时精确注销） */
  let registeredAcc: string | null = null
  /** 原生 Quick Look（previewFile）打开时，面板会失焦——这段时间不做失焦隐藏 */
  let previewOpen = false
  /** 主窗口尚未加载完时暂存 ↩ / ⌘O 的动作，渲染端挂载后拉取 */
  let pending: QuickPanelPending | null = null

  // 开关状态缓存在内存里（写入走 SET_ENABLED，和 meta_state 同步更新）：
  // keepAliveOnWindows() 在窗口 closed / window-all-closed 回调里被调用，
  // 退出流程中 db 可能已经关闭，这里绝不能再去查库
  let enabledState = deps.getMeta(META_KEY_ENABLED) !== '0'
  const enabled = (): boolean => enabledState
  const shortcut = (): string => {
    const v = deps.getMeta(META_KEY_SHORTCUT)
    return v && isValidShortcut(v, isMac) ? v : defaultShortcut(process.platform)
  }

  // ---------- 窗口 ----------

  function createPanelWindow(): BrowserWindow {
    const base: Electron.BrowserWindowConstructorOptions = {
      width: PANEL_WIDTH,
      height: PANEL_MIN_HEIGHT,
      show: false,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: deps.webPreferences,
    }
    let win: BrowserWindow
    if (isMac) {
      try {
        // NSPanel：非激活式取键（不抢前台应用）；vibrancy 毛玻璃；背景透明让材质透出来
        win = new BrowserWindow({ ...base, type: 'panel', vibrancy: 'hud', visualEffectState: 'active', backgroundColor: '#00000000' })
      } catch (e) {
        console.warn('[quickpanel] panel window type unavailable, falling back:', e)
        win = new BrowserWindow({ ...base, vibrancy: 'hud', visualEffectState: 'active', backgroundColor: '#00000000' })
      }
      win.setAlwaysOnTop(true, 'screen-saver')
      // 全屏应用之上也能出现；skipTransformProcessType 避免把进程切成前台应用（Dock 图标闪跳）
      try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }) } catch { /* 旧系统没有该选项 */ }
    } else {
      win = new BrowserWindow({ ...base, backgroundColor: deps.windowBackground() })
    }
    win.on('blur', () => {
      // 原生 Quick Look 打开时面板必然失焦；开发者工具打开时也别藏（调试）
      if (previewOpen || win.webContents.isDevToolsOpened()) return
      hide()
    })
    win.on('focus', () => { previewOpen = false })
    win.on('closed', () => { if (panel === win) panel = null })
    deps.loadRenderer(win, 'panel')
    return win
  }

  function ensurePanel(): BrowserWindow {
    if (!panel || panel.isDestroyed()) panel = createPanelWindow()
    return panel
  }

  /** 居中在鼠标所在屏幕的上三分之一 */
  function position(win: BrowserWindow): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const wa = display.workArea
    const [, h] = win.getSize()
    const x = wa.x + Math.round((wa.width - PANEL_WIDTH) / 2)
    const y = wa.y + Math.round(wa.height * 0.18)
    win.setBounds({ x, y, width: PANEL_WIDTH, height: h })
  }

  function show(): BrowserWindow {
    const win = ensurePanel()
    position(win)
    win.show()
    win.focus()
    win.webContents.send(QP.SHOWN)
    return win
  }

  function hide(): void {
    if (!panel || panel.isDestroyed()) return
    if (previewOpen) {
      try { panel.closeFilePreview() } catch { /* 没开着就算了 */ }
      previewOpen = false
    }
    panel.hide()
  }

  function toggle(): void {
    if (panel && !panel.isDestroyed() && panel.isVisible()) hide()
    else show()
  }

  // ---------- 全局快捷键 ----------

  function applyShortcut(): void {
    if (registeredAcc) {
      try { globalShortcut.unregister(registeredAcc) } catch { /* ignore */ }
      registeredAcc = null
    }
    if (!enabled()) return
    const acc = shortcut()
    try {
      if (globalShortcut.register(acc, toggle)) registeredAcc = acc
      else console.warn(`[quickpanel] shortcut ${acc} is taken by another app`)
    } catch (e) {
      console.warn(`[quickpanel] failed to register shortcut ${acc}:`, e)
    }
  }

  function settings(): QuickPanelSettings {
    return { enabled: enabled(), shortcut: shortcut(), registered: registeredAcc != null }
  }

  // ---------- Windows 托盘（主窗口关闭后快捷键还要能用） ----------

  function trayIcon(): Electron.NativeImage {
    const candidates = [
      join(app.getAppPath(), 'build', 'icon.png'),
      join(process.resourcesPath, 'icon.png'),
    ]
    for (const p of candidates) {
      if (existsSync(p)) {
        const img = nativeImage.createFromPath(p)
        if (!img.isEmpty()) return img.resize({ width: 16, height: 16 })
      }
    }
    return nativeImage.createEmpty()
  }

  function ensureTray(): void {
    if (tray || process.platform === 'darwin') return
    tray = new Tray(trayIcon())
    tray.setToolTip('Vixel')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: t.quickpanel.trayOpen, click: () => { deps.ensureMainWindow() } },
      { label: t.quickpanel.menuLabel, click: () => { show() } },
      { type: 'separator' },
      { label: t.quickpanel.trayQuit, click: () => app.quit() },
    ]))
    tray.on('click', () => { deps.ensureMainWindow() })
  }

  function destroyTray(): void {
    tray?.destroy()
    tray = null
  }

  // ---------- 发往主窗口的动作（没有主窗口时建一个，加载完再送达） ----------

  function deliverToMain(action: QuickPanelPending): void {
    hide()
    const existing = deps.getMainWindow()
    const win = deps.ensureMainWindow()
    if (existing && !win.webContents.isLoading()) {
      win.webContents.send(
        action.type === 'result' ? QP.SHOW_RESULT : QP.RUN_SEARCH,
        action.type === 'result' ? action.result : action.query
      )
    } else {
      pending = action // 渲染端挂载后 GET_PENDING 拉走
    }
  }

  // ---------- IPC ----------

  ipcMain.handle(QP.GET_SETTINGS, async () => settings())

  ipcMain.handle(QP.SET_ENABLED, async (_e, on: boolean) => {
    enabledState = !!on
    deps.setMeta(META_KEY_ENABLED, on ? '1' : '0')
    applyShortcut()
    if (!on) destroyTray()
    deps.onSettingsChanged()
    return settings()
  })

  ipcMain.handle(QP.SET_SHORTCUT, async (_e, acc: string) => {
    if (!isValidShortcut(acc, isMac)) return { ok: false, reason: 'invalid' as const, settings: settings() }
    const prev = shortcut()
    // 先注销旧键再试注册新键；失败则还原旧键，设置不落库
    if (registeredAcc) {
      try { globalShortcut.unregister(registeredAcc) } catch { /* ignore */ }
      registeredAcc = null
    }
    let ok = false
    try { ok = globalShortcut.register(acc, toggle) } catch { ok = false }
    if (!ok) {
      deps.setMeta(META_KEY_SHORTCUT, prev)
      applyShortcut()
      return { ok: false, reason: 'in-use' as const, settings: settings() }
    }
    // 关着开关时只是验证可注册，不保持注册
    if (!enabled()) globalShortcut.unregister(acc)
    else registeredAcc = acc
    deps.setMeta(META_KEY_SHORTCUT, acc)
    deps.onSettingsChanged()
    return { ok: true, settings: settings() }
  })

  ipcMain.handle(QP.HIDE, async () => { hide() })

  ipcMain.handle(QP.RESIZE, async (event, height: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win !== panel) return
    const h = Math.round(Math.min(PANEL_MAX_HEIGHT, Math.max(PANEL_MIN_HEIGHT, Number(height) || PANEL_MIN_HEIGHT)))
    const [x, y] = win.getPosition()
    win.setBounds({ x, y, width: PANEL_WIDTH, height: h }) // 顶边不动，向下长高
  })

  ipcMain.handle(QP.OPEN_RESULT, async (_e, result: unknown) => {
    deliverToMain({ type: 'result', result })
  })

  ipcMain.handle(QP.OPEN_QUERY, async (_e, query: string) => {
    deliverToMain({ type: 'query', query: String(query ?? '') })
  })

  ipcMain.handle(QP.GET_PENDING, async () => {
    const p = pending
    pending = null
    return p
  })

  ipcMain.handle(QP.OPEN_EXTERNAL, async (_e, photoId: number, videoId?: number | null) => {
    const path = deps.resolveFilePath(photoId, videoId)
    if (!path) return false
    const err = await shell.openPath(path)
    return !err
  })

  /**
   * ⌘C / Ctrl+C：把文件本身写进剪贴板（不是路径文字）。
   * macOS 写 NSFilenamesPboardType plist（访达 ⌘V 可粘贴成文件副本）；
   * Windows 经 Win32 直写 CF_HDROP（资源管理器 Ctrl+V 认的就是它；Electron 的
   * writeBuffer 写不了无名标准格式）。失败回退路径文字并如实返回。
   */
  ipcMain.handle(QP.COPY_FILES, async (event, items: Array<{ photoId: number; videoId?: number | null }>) => {
    const paths = (Array.isArray(items) ? items : [])
      .map((it) => deps.resolveFilePath(Number(it?.photoId), it?.videoId))
      .filter((p): p is string => !!p)
    if (paths.length === 0) return null
    try {
      if (isMac) {
        clipboard.writeBuffer('NSFilenamesPboardType', Buffer.from(filenamesPlist(paths)))
        return 'file'
      }
      if (process.platform === 'win32') {
        // OpenClipboard 挂在发起窗口的 HWND 上（getNativeWindowHandle 是平台字节序的指针值）
        const win = BrowserWindow.fromWebContents(event.sender)
        const handle = win && !win.isDestroyed() ? win.getNativeWindowHandle() : null
        const hwnd = handle ? (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))) : 0n
        writeClipboardHdrop(paths, hwnd)
        return 'file'
      }
    } catch (e) {
      console.warn('[quickpanel] file clipboard failed, copying path text:', e)
    }
    clipboard.writeText(paths.join('\n'))
    return 'path'
  })

  /** Space：macOS 用窗口自带的原生 Quick Look；其他平台返回 false，渲染端用内置 QuickLook 组件 */
  ipcMain.handle(QP.PREVIEW_FILE, async (event, photoId: number, videoId?: number | null, displayName?: string) => {
    if (!isMac) return false
    const win = BrowserWindow.fromWebContents(event.sender)
    const path = deps.resolveFilePath(photoId, videoId)
    if (!win || !path) return false
    previewOpen = true
    win.previewFile(path, typeof displayName === 'string' ? displayName : undefined)
    return true
  })

  /** 拖出面板 = 原生文件拖放（可以直接拖进剪辑软件 / 访达）；必须在 dragstart 的同步回合里调 */
  ipcMain.on(QP.START_DRAG, (event, photoId: number, videoId?: number | null) => {
    const path = deps.resolveFilePath(Number(photoId), videoId)
    if (!path) return
    // 拖拽角标：应用图标缩小（缩略图是 webp，nativeImage 读不了；角标不值得专门转码）
    let icon = nativeImage.createEmpty()
    const iconPath = join(app.getAppPath(), 'build', 'icon.png')
    if (existsSync(iconPath)) {
      const img = nativeImage.createFromPath(iconPath)
      if (!img.isEmpty()) icon = img.resize({ width: 64, height: 64 })
    }
    event.sender.startDrag({ file: path, icon })
  })

  // 服务就绪后注册（index.ts 在 initServices 之后调用 initQuickPanel）
  applyShortcut()
  // 预热：启用时提前把隐藏面板建好（渲染器加载要几百毫秒），第一次按快捷键也能立刻弹出
  if (enabled()) {
    setTimeout(() => {
      try { ensurePanel() } catch (e) { console.warn('[quickpanel] prewarm failed:', e) }
    }, 2500)
  }

  return {
    show,
    hide,
    toggle,
    getWindow: () => (panel && !panel.isDestroyed() ? panel : null),
    settings,
    isEnabled: enabled,
    openResult: (result) => deliverToMain({ type: 'result', result }),
    keepAliveOnWindows: () => process.platform !== 'darwin' && enabled(),
    ensureTray,
    hasTray: () => tray != null,
    dispose: () => {
      if (registeredAcc) {
        try { globalShortcut.unregister(registeredAcc) } catch { /* ignore */ }
        registeredAcc = null
      }
      destroyTray()
      // 常驻的隐藏面板窗口也一并销毁：退出流程不依赖它被动关闭的时序
      if (panel && !panel.isDestroyed()) panel.destroy()
      panel = null
    },
  }
}
