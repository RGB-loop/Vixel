import { app, Menu, shell, dialog, BrowserWindow, type MenuItemConstructorOptions } from 'electron'

import { IPC_CHANNELS, type ItemMenuAction, type MenuCommand, type SmartAlbumMenuAction } from '../shared/types'
import { t } from '../shared/i18n'

/** macOS 叫访达，Windows / Linux 是文件管理器。调用时取，切换语言重建菜单后跟着变 */
const revealLabel = (): string => (process.platform === 'darwin' ? t.common.revealMac : t.common.revealWinLong)

/**
 * 原生应用菜单。设计 spec 要求：每个快捷键都能在菜单里找到，
 * 所以 ⌘ 组合键统一在这里注册，点击后把命令发给渲染进程。
 */
export function installAppMenu(
  getWindow: () => BrowserWindow | null,
  { openSettings, quickPanel }: {
    openSettings: () => void
    /** 快速搜索：accelerator 只做展示（真正的键是 globalShortcut），禁用时传 null */
    quickPanel?: { accelerator: string | null; toggle: () => void }
  }
): void {
  // 命令只发给主窗口；设置窗口在前台时（⌘A、⌘1 之类）不去动主窗口
  const send = (cmd: MenuCommand) => (): void => {
    const win = getWindow()
    const focused = BrowserWindow.getFocusedWindow()
    if (!win || (focused && focused !== win && cmd !== 'add-folder')) return
    win.webContents.send(IPC_CHANNELS.MENU_COMMAND, cmd)
  }
  const item = (label: string, accelerator: string, cmd: MenuCommand): MenuItemConstructorOptions => ({
    label, accelerator, click: send(cmd),
  })
  // 空格 / 回车只在菜单里展示，不注册成全局加速键，否则输入框里打不了空格；渲染进程自己处理按键
  const hint = (label: string, accelerator: string, cmd: MenuCommand): MenuItemConstructorOptions => ({
    label, accelerator, registerAccelerator: false, click: send(cmd),
  })

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: t.menu.about(app.name) },
        { type: 'separator' },
        { label: t.menu.settings, accelerator: 'CmdOrCtrl+,', click: openSettings },
        { type: 'separator' },
        { role: 'services', label: t.menu.services },
        { type: 'separator' },
        { role: 'hide', label: t.menu.hide(app.name) },
        { role: 'hideOthers', label: t.menu.hideOthers },
        { role: 'unhide', label: t.menu.unhide },
        { type: 'separator' },
        { role: 'quit', label: t.menu.quit(app.name) },
      ],
    },
    {
      label: t.menu.file,
      submenu: [
        item(t.menu.addFolder, 'CmdOrCtrl+O', 'add-folder'),
        // 全局快捷键由 globalShortcut 注册，这里只负责菜单里能找到 + 显示当前键
        ...(quickPanel ? [{
          label: t.quickpanel.menuLabel,
          ...(quickPanel.accelerator ? { accelerator: quickPanel.accelerator } : {}),
          registerAccelerator: false,
          click: () => quickPanel.toggle(),
        } satisfies MenuItemConstructorOptions] : []),
        { type: 'separator' },
        hint(t.menu.open, 'Enter', 'open-item'),
        hint(t.menu.quickLook, 'Space', 'quick-look'),
        hint(t.organize.favoriteToggle, 'F', 'toggle-favorite'),
        hint(t.tags.addPlaceholder, 'T', 'add-tag'),
        item(revealLabel(), 'CmdOrCtrl+Shift+R', 'reveal'),
        { type: 'separator' },
        { role: 'close', label: t.menu.closeWindow },
      ],
    },
    {
      // 输入框的复制粘贴依赖这些 role，不能省
      label: t.menu.edit,
      submenu: [
        { role: 'undo', label: t.menu.undo },
        { role: 'redo', label: t.menu.redo },
        { type: 'separator' },
        { role: 'cut', label: t.menu.cut },
        { role: 'copy', label: t.menu.copy },
        { role: 'paste', label: t.menu.paste },
        // 不用 selectAll role：焦点在网格时要全选项目而不是页面文字，交给渲染进程判断
        item(t.menu.selectAll, 'CmdOrCtrl+A', 'select-all'),
        { type: 'separator' },
        item(t.menu.find, 'CmdOrCtrl+F', 'find'),
      ],
    },
    {
      label: t.menu.view,
      submenu: [
        item(t.common.all, 'CmdOrCtrl+1', 'source:all'),
        item(t.common.images, 'CmdOrCtrl+2', 'source:image'),
        item(t.common.videos, 'CmdOrCtrl+3', 'source:video'),
        item(t.common.audio, 'CmdOrCtrl+4', 'source:audio'),
        { type: 'separator' },
        item(t.menu.map, 'CmdOrCtrl+5', 'source:map'),
        item(t.menu.people, 'CmdOrCtrl+6', 'source:people'),
        { label: t.cleanup.title, click: send('source:cleanup') },
        { type: 'separator' },
        item(t.menu.zoomIn, 'CmdOrCtrl+Plus', 'zoom-in'),
        item(t.menu.zoomOut, 'CmdOrCtrl+-', 'zoom-out'),
        hint(t.menu.toggleDensity, 'G', 'toggle-density'),
        { type: 'separator' },
        item(t.menu.toggleSidebar, 'CmdOrCtrl+Alt+S', 'toggle-sidebar'),
        item(t.menu.toggleInspector, 'CmdOrCtrl+I', 'toggle-inspector'),
        item(t.menu.activity, 'CmdOrCtrl+Alt+A', 'activity'),
        { type: 'separator' },
        { role: 'togglefullscreen', label: t.menu.fullscreen },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]),
      ],
    },
    {
      label: t.menu.window,
      role: 'windowMenu',
    },
    {
      label: t.menu.help,
      role: 'help',
      submenu: [
        { label: t.menu.homepage, click: () => { shell.openExternal('https://github.com/RGB-loop/Vixel#readme') } },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** 网格项右键菜单：动作由渲染进程执行（它知道选中了哪些项），这里只负责弹出并回传选择 */
export function popupItemMenu(
  win: BrowserWindow,
  { count, isMedia, favorite, canImageSearch, webLinks }: { count: number; isMedia: boolean; favorite: boolean; canImageSearch: boolean; webLinks?: boolean }
): Promise<ItemMenuAction | null> {
  return new Promise((resolve) => {
    const pick = (action: ItemMenuAction) => (): void => resolve(action)
    const multi = count > 1
    const template: MenuItemConstructorOptions[] = [
      ...(multi ? [] : [
        { label: t.menu.open, click: pick('open') },
        { label: t.menu.quickLook, click: pick('quick-look') },
        { type: 'separator' },
      ] as MenuItemConstructorOptions[]),
      { label: multi ? t.menu.revealMany(revealLabel(), count) : revealLabel(), accelerator: 'CmdOrCtrl+Shift+R', click: pick('reveal') },
      { label: multi ? t.menu.copyPaths(count) : t.common.copyPath, click: pick('copy-path') },
      // 拷贝链接（http://…/open?…，见 shared/deeplink.ts）：贴进笔记，本机点开回到 Vixel 定位这一项；
      // 链接服务没起来（端口被占）时置灰
      ...(multi ? [] : [
        { label: t.menu.copyLink, enabled: !!webLinks, click: pick('copy-link') },
        { label: t.menu.copyMarkdownLink, enabled: !!webLinks, click: pick('copy-md-link') },
        { label: t.menu.copyWebMarkdown, enabled: !!webLinks, click: pick('copy-web-md') },
      ] as MenuItemConstructorOptions[]),
      { label: favorite ? t.organize.unfavorite : t.organize.favorite, accelerator: 'F', registerAccelerator: false, click: pick('toggle-favorite') },
      ...(multi ? [] : [
        { type: 'separator' },
        // 取代了"查找相似内容"：同一套向量，但连视频片段一起搜，门槛也按库标定（见 imageQuery.ts）
        ...(canImageSearch ? [{ label: t.imagesearch.searchWithThis, click: pick('search-by-image') }] : []),
        ...(isMedia ? [{ label: t.menu.openInPlayer, click: pick('open-external') }] : []),
      ] as MenuItemConstructorOptions[]),
    ]
    // macOS 上 click 可能晚于关闭回调到达：关闭后稍等再按"未选择"收尾，Promise 只认第一次 resolve
    Menu.buildFromTemplate(template).popup({ window: win, callback: () => setTimeout(() => resolve(null), 100) })
  })
}

/** 侧栏智能相册右键菜单；删除先弹确认框，确认了才回传 'delete' */
export function popupSmartAlbumMenu(win: BrowserWindow, name: string): Promise<SmartAlbumMenuAction | null> {
  return new Promise((resolve) => {
    let picked: SmartAlbumMenuAction | null = null
    const pick = (action: SmartAlbumMenuAction) => (): void => { picked = action }
    const template: MenuItemConstructorOptions[] = [
      { label: t.albums.rename, click: pick('rename') },
      { label: t.albums.update, click: pick('update') },
      { type: 'separator' },
      { label: t.albums.delete, click: pick('delete') },
    ]
    // 和 popupItemMenu 一样：click 可能晚于关闭回调，稍等再收尾
    Menu.buildFromTemplate(template).popup({
      window: win,
      callback: () => setTimeout(async () => {
        if (picked !== 'delete') return resolve(picked)
        const { response } = await dialog.showMessageBox(win, {
          type: 'warning',
          message: t.albums.deleteConfirm(name),
          detail: t.albums.deleteDetail,
          buttons: [t.albums.deleteButton, t.common.cancel],
          defaultId: 1,
          cancelId: 1,
        })
        resolve(response === 0 ? 'delete' : null)
      }, 100),
    })
  })
}
