/**
 * 截图巡检：VIXEL_CAPTURE=<目录> 启动时，主窗口就绪后依次切到各视图、浅色 / 深色各截一张，
 * 存成 <目录>/<theme>-<step>.png 然后退出。用于 UI 回归检查和宣发素材，不需要系统截屏权限。
 *
 *   VIXEL_CAPTURE=/tmp/shots npx electron . --user-data-dir=<库目录>
 */

import { app, clipboard, type BrowserWindow, nativeTheme } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { IPC_CHANNELS, type MenuCommand } from '../shared/types'
import { t } from '../shared/i18n'
import { getFfmpegPath } from '../core/video/ffmpegPath'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 截图巡检需要主进程帮忙布置的状态（见 index.ts 的 runCaptureTour 调用处） */
export interface CaptureHooks {
  /** on=true：模拟电源受限（过热）+ 排一个回填任务，状态栏显示等待原因；false 还原 */
  simulatePowerWait?: (on: boolean) => void
  /** on=true：造一条"跳过的数据集目录"记录（设置 › 文件夹 的列表）；false 清掉 */
  seedSkippedFolder?: (on: boolean) => void
  /** 快速搜索面板：全局快捷键没法自动化，直接调同一个 show / hide */
  quickPanel?: { show: () => BrowserWindow; hide: () => void }
}

interface Step { name: string; run: (win: BrowserWindow) => Promise<void> | void; wait?: number; after?: (win: BrowserWindow) => Promise<void> | void }

const command = (cmd: MenuCommand) => (win: BrowserWindow) => win.webContents.send(IPC_CHANNELS.MENU_COMMAND, cmd)

/** 在渲染进程里执行一段脚本（模拟用户输入），找不到元素就算了 */
const js = (code: string) => (win: BrowserWindow) => win.webContents.executeJavaScript(`try { ${code} } catch (e) {}`).then(() => {})

const typeSearch = (q: string): string => `
  const el = document.querySelector('input[data-search-input]');
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, ${JSON.stringify(q)}); el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));`

// 文案按当前语言取，所以在运行时（而不是模块加载时）拼选择器
const clickSidebar = (label: () => string) => (win: BrowserWindow) =>
  js(`document.querySelector(${JSON.stringify(`nav [role="button"][title="${label()}"]`)})?.click()`)(win)
const clickTitled = (title: () => string) => (win: BrowserWindow) =>
  js(`document.querySelector(${JSON.stringify(`button[title="${title()}"]`)})?.click()`)(win)

const clickText = (text: () => string) => (win: BrowserWindow) =>
  js(`[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text())})?.click()`)(win)

const QUERIES = (process.env.VIXEL_CAPTURE_QUERIES || '西瓜,微信支付,海边').split(',')

const STEPS: Step[] = [
  { name: 'all', run: command('source:all'), wait: 2500 },
  // 收集箱：侧栏置顶的文件夹（演示库里要先收集过至少一张，见 docs/extension.md / e2e）；
  // 选中第一项让检查器露出"来源"
  {
    name: 'inbox',
    run: async (w) => {
      await js(`[...document.querySelectorAll('nav [role="button"]')].find((b) => (b.textContent || '').startsWith(${JSON.stringify(t.collect.inbox)}))?.click()`)(w)
      await sleep(1500)
      await js(`document.querySelector('.photo-card')?.click()`)(w)
    },
    wait: 2000,
    after: (w) => { js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)(w); return command('source:all')(w) },
  },
  // 查询可用环境变量覆盖（逗号分隔：语义查询, 图中文字查询, 库里没有的东西）
  { name: 'search', run: js(typeSearch(QUERIES[0])), wait: 3000 },
  { name: 'inspector', run: js(`document.querySelector('.photo-card')?.click()`), wait: 2000 },
  { name: 'detail', run: js(`document.querySelector('.photo-card')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`), wait: 2000 },
  { name: 'video', run: (w) => { js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)(w); command('source:video')(w) }, wait: 2000 },
  { name: 'favorites', run: (w) => { js(typeSearch(''))(w); clickSidebar(() => t.organize.favorites)(w) }, wait: 2500 },
  {
    name: 'filters',
    run: (w) => { command('source:all')(w); clickTitled(() => t.organize.filterTitle)(w) },
    wait: 2000,
  },
  // 选两个条件后收起筛选栏：只剩可移除的条件标签
  {
    name: 'filters-active',
    run: async (w) => {
      await clickText(() => t.organize.landscape)(w)
      await sleep(600)
      await clickText(() => t.organize.favoritesOnly)(w)
      await sleep(600)
      await clickTitled(() => t.organize.filterTitle)(w)
    },
    wait: 2000,
    after: clickText(() => t.organize.clear),
  },
  { name: 'search-text', run: (w) => { command('source:all')(w); js(typeSearch(QUERIES[1]))(w) }, wait: 3000 },
  { name: 'search-nomatch', run: js(typeSearch(QUERIES[2])), wait: 3000 },
  // 较弱的匹配：有突出命中（多通道）时，融合分不到第一名一半的结果折到分隔线下。
  // 查询可用 VIXEL_CAPTURE_QUERIES 第 5 项覆盖；演示库里 wood_anemones.jpg 打过 "anemones" 标签，
  // "wood anemones" 同时命中画面 + 文件名 + 标签，其余"长得像"的花折进去。
  // 先清空再输入：上一步的查询 / 筛选残留会让这一步的输入偶发丢失（React 重渲染吃掉事件）
  {
    name: 'search-weak',
    run: async (w) => {
      await js(typeSearch(''))(w)
      await sleep(800)
      await js(typeSearch(QUERIES[4] ?? 'wood anemones'))(w)
    },
    wait: 3000,
    after: js(typeSearch('')),
  },
  // 设计格式：打开 fixtures 文件夹（侧栏文件夹按钮的 title 是完整路径），选中 PSD → 网格角标 + 检查器"格式"
  {
    name: 'design',
    run: async (w) => {
      await js(typeSearch(''))(w)
      await js(`[...document.querySelectorAll('nav [role="button"]')].find((b) => (b.title || '').includes('design-fixtures') || (b.title || '').includes('设计素材'))?.click()`)(w)
      await sleep(2000)
      await js(`[...document.querySelectorAll('.photo-card')].find((c) => /\\.psd$/i.test(c.getAttribute('aria-label') || ''))?.click()`)(w)
    },
    wait: 2500,
    after: (w) => { js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)(w); return command('source:all')(w) },
  },
  // 颜色：筛选栏的颜色色块（蓝）+ 选中一张让检查器露出色板
  {
    name: 'color',
    run: async (w) => {
      command('source:all')(w)
      await sleep(800)
      await clickTitled(() => t.organize.filterTitle)(w)
      await sleep(900)
      await js(`document.querySelector('[data-color-swatch="blue"]')?.click()`)(w)
      await sleep(1500)
      await js(`document.querySelector('.photo-card')?.click()`)(w)
    },
    wait: 2500,
    after: async (w) => {
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)(w)
      await clickText(() => t.organize.clear)(w)
      await sleep(400)
      await clickTitled(() => t.organize.filterTitle)(w)
    },
  },
  // 以图搜图：VIXEL_CAPTURE_IMAGE=<库外查询图路径>（事件入口见 App.tsx；要过一遍模型，多等一会）
  ...(process.env.VIXEL_CAPTURE_IMAGE ? [{
    name: 'image-search',
    run: (w: BrowserWindow) => { js(typeSearch(''))(w); return js(`window.dispatchEvent(new CustomEvent('vixel:image-search', { detail: { path: ${JSON.stringify(process.env.VIXEL_CAPTURE_IMAGE)} } }))`)(w) },
    wait: 8000,
    after: js(`document.querySelector('[data-clear-image]')?.click()`),
  } satisfies Step] : []),
  // 智能相册：先在演示库里建好（查询相册 + 纯筛选相册），这里依次打开；最后在相册里改查询，标题旁出现"更新相册"
  { name: 'albums', run: js(`document.querySelectorAll('[data-album-row] [role="button"]')[0]?.click()`), wait: 3000 },
  { name: 'album-filters', run: js(`document.querySelectorAll('[data-album-row] [role="button"]')[1]?.click()`), wait: 3000 },
  { name: 'album-edited', run: js(typeSearch(QUERIES[0])), wait: 3000, after: clickText(() => t.organize.clear) },
  // 标签：打开侧栏第一个标签，选中第一项，T 把焦点放进检查器的标签输入框
  {
    name: 'tags',
    run: async (w) => {
      await js(typeSearch(''))(w)
      await js(`document.querySelector('[data-tag-row] [role="button"]')?.click()`)(w)
      await sleep(1500)
      await js(`document.querySelector('.photo-card')?.click()`)(w)
      await sleep(600)
      command('add-tag')(w)
    },
    wait: 2000,
  },
  // 标签名也是搜索通道：结果卡片上有"标签"角标（查询可用 VIXEL_CAPTURE_QUERIES 第 4 项覆盖）
  { name: 'tag-search', run: (w) => { command('source:all')(w); js(typeSearch(QUERIES[3] ?? '花卉'))(w) }, wait: 3000 },
  // 自动标签：侧栏里第一个 ✦ 标签，选中第一项，检查器里是虚线 ✦ 标签（✓ / ×）
  {
    name: 'autotags',
    run: async (w) => {
      await js(typeSearch(''))(w)
      await js(`(() => { const rows = [...document.querySelectorAll('[data-tag-row]')]; const auto = rows.find((r) => r.querySelector('svg path[d^="M9.813"]')); (auto ?? rows[0])?.querySelector('[role="button"]')?.click() })()`)(w)
      await sleep(1500)
      await js(`document.querySelector('.photo-card')?.click()`)(w)
    },
    wait: 2000,
  },
  { name: 'people', run: (w) => { js(typeSearch(''))(w); command('source:people')(w) }, wait: 6000 },
  { name: 'map', run: command('source:map'), wait: 3500 },
  { name: 'cleanup', run: command('source:cleanup'), wait: 4000 },
  { name: 'tasks', run: (w) => { command('source:all')(w); command('activity')(w) }, wait: 2000 },
]

export async function runCaptureTour(win: BrowserWindow, outDir: string, openSettings: () => BrowserWindow, hooks: CaptureHooks = {}): Promise<void> {
  await mkdir(outDir, { recursive: true })
  win.setSize(1440, 900)
  win.center()
  await sleep(4000) // 首屏数据 + 缩略图
  for (const theme of ['light', 'dark'] as const) {
    nativeTheme.themeSource = theme
    await sleep(800)
    for (const step of STEPS) {
      await step.run(win)
      await sleep(step.wait ?? 1500)
      const img = await win.webContents.capturePage()
      await writeFile(join(outDir, `${theme}-${step.name}.png`), img.toPNG())
      console.log(`[capture] ${theme}-${step.name}.png`)
      await step.after?.(win)
    }
    // 电源策略等待：模拟过热 + 一个待办回填任务 → 状态栏显示等待原因（与手动暂停不同的文案）
    if (hooks.simulatePowerWait) {
      hooks.simulatePowerWait(true)
      await sleep(1200)
      await writeFile(join(outDir, `${theme}-power-wait.png`), (await win.webContents.capturePage()).toPNG())
      console.log(`[capture] ${theme}-power-wait.png`)
      hooks.simulatePowerWait(false)
      await sleep(600)
    }
    // 快速搜索面板：show → 输入查询 → ↓ 选中第二条 → 截面板窗口本身；
    // 顺带验证 ⌘C（剪贴板是文件引用）、↩（主窗口打开详情）、Esc（隐藏），结果打进日志
    if (hooks.quickPanel) {
      const panel = hooks.quickPanel.show()
      await sleep(1500)
      const pjs = (code: string): Promise<void> => panel.webContents.executeJavaScript(`try { ${code} } catch (e) {}`).then(() => {})
      const typePanel = (q: string): Promise<void> => pjs(`
        const el = document.querySelector('input[data-qp-input]');
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(el, ${JSON.stringify(q)}); el.dispatchEvent(new Event('input', { bubbles: true }));`)
      const pkey = (key: string, mods = ''): Promise<void> =>
        pjs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, ${mods} bubbles: true }))`)
      await typePanel(QUERIES[0])
      await sleep(2500)
      await pkey('ArrowDown')
      await sleep(600)
      await writeFile(join(outDir, `${theme}-quick-panel.png`), (await panel.webContents.capturePage()).toPNG())
      console.log(`[capture] ${theme}-quick-panel.png`)
      // ⌘C / Ctrl+C：剪贴板应是文件引用（NSFilenamesPboardType / FileNameW），不是路径文字
      await pkey('c', process.platform === 'darwin' ? 'metaKey: true,' : 'ctrlKey: true,')
      await sleep(600)
      console.log(`[capture] quick-panel clipboard formats: ${clipboard.availableFormats().join(', ') || '(none)'}`)
      // ↩：主窗口打开详情（视频 / 音频会落到命中片段）
      await pkey('Enter')
      await sleep(2000)
      console.log(`[capture] quick-panel hidden after Enter: ${!panel.isVisible()}`)
      await writeFile(join(outDir, `${theme}-quick-panel-opened.png`), (await win.webContents.capturePage()).toPNG())
      console.log(`[capture] ${theme}-quick-panel-opened.png`)
      await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)(win)
      await sleep(600)
      // 诚实的空状态（库里没有的东西）
      hooks.quickPanel.show()
      await sleep(600)
      await typePanel(QUERIES[2])
      await sleep(2500)
      await writeFile(join(outDir, `${theme}-quick-panel-empty.png`), (await panel.webContents.capturePage()).toPNG())
      console.log(`[capture] ${theme}-quick-panel-empty.png`)
      // Esc：面板隐藏
      await pkey('Escape')
      await sleep(500)
      console.log(`[capture] quick-panel hidden after Esc: ${!panel.isVisible()}`)
      hooks.quickPanel.hide()
    }
    // 设置窗口（通用页：外观、语言、索引电源开关）
    const settings = openSettings()
    await sleep(2000)
    await writeFile(join(outDir, `${theme}-settings.png`), (await settings.webContents.capturePage()).toPNG())
    console.log(`[capture] ${theme}-settings.png`)
    const sjs = (code: string): Promise<void> => settings.webContents.executeJavaScript(`try { ${code} } catch (e) {}`).then(() => {})
    // 设置 › 文件夹：造一条"跳过的数据集目录"记录后截列表
    if (hooks.seedSkippedFolder) {
      hooks.seedSkippedFolder(true)
      await sjs(`[...document.querySelectorAll('header nav button')][1]?.click()`)
      await sleep(1200)
      await writeFile(join(outDir, `${theme}-settings-folders-skipped.png`), (await settings.webContents.capturePage()).toPNG())
      console.log(`[capture] ${theme}-settings-folders-skipped.png`)
      hooks.seedSkippedFolder(false)
      await sjs(`[...document.querySelectorAll('header nav button')][0]?.click()`)
      await sleep(600)
    }
    // 设置 › 通用 › 浏览器扩展：确保服务开着让令牌面板露出来，截完恢复原状（改的是演示库的 meta_state）
    await sjs(`window.__vxWasOn = document.querySelector('[data-collect-server-toggle]')?.checked; if (window.__vxWasOn === false) document.querySelector('[data-collect-server-toggle]').click()`)
    await sleep(800)
    await sjs(`document.querySelector('[data-collect-settings]')?.scrollIntoView({ block: 'center' })`)
    await sleep(400)
    await writeFile(join(outDir, `${theme}-settings-extension.png`), (await settings.webContents.capturePage()).toPNG())
    console.log(`[capture] ${theme}-settings-extension.png`)
    await sjs(`if (window.__vxWasOn === false) document.querySelector('[data-collect-server-toggle]')?.click()`)
    await sleep(400)
    settings.close()
    // 收起抽屉 / 清空搜索，下一轮从干净状态开始
    await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)(win)
    await js(typeSearch(''))(win)
    await sleep(800)
  }
  app.quit()
}

// ─── 录屏：VIXEL_RECORD=<out.mp4> ───────────────────────────────────────────
//
// 按脚本演示一遍真实界面，用 webContents 的帧订阅录成 1080p 视频（窗口 1280×720 × 1.5 倍缩放），
// 同时把每个场景的起止时间写到 <out>.timeline.json，供 scripts/make-promo.mjs 加字幕和片头片尾。
// 不需要系统录屏权限，也不会录到鼠标指针以外的任何桌面内容。

/** query：这一幕输入的搜索词，写进 timeline 供竖版放大显示（竖版里界面缩得太小，看不清搜索框） */
interface Scene { name: string; caption: string; query?: string; run: (win: BrowserWindow) => Promise<void> }

// VIXEL_RECORD_LANG=en：场景字幕 / 查询用英文（配合把演示库的界面语言设为 English，录英文版）
const LANG = process.env.VIXEL_RECORD_LANG === 'en' ? 'en' : 'zh'
const L = (zh: string, en: string): string => (LANG === 'en' ? en : zh)
// VIXEL_RECORD_SCENES=a,b,c：只录这些场景（按 name 过滤），用于拼多段素材
const sceneFilter = (scenes: Scene[]): Scene[] => {
  const only = process.env.VIXEL_RECORD_SCENES?.split(',').map((s) => s.trim()).filter(Boolean)
  return only?.length ? scenes.filter((s) => only.includes(s.name)) : scenes
}

/** 逐字输入（触发搜索框自己的防抖），模拟真人打字 */
const typeSlowly = async (win: BrowserWindow, text: string): Promise<void> => {
  await js(typeSearch(''))(win)
  for (let i = 1; i <= text.length; i++) {
    await win.webContents.executeJavaScript(`try {
      const el = document.querySelector('input[data-search-input]');
      el.focus();
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(text.slice(0, i))}); el.dispatchEvent(new Event('input', { bubbles: true }));
    } catch (e) {}`)
    await sleep(160)
  }
}

const press = (key: string) => js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`)
const openFirst = js(`document.querySelector('.photo-card')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
/** 打开带"图中文字"角标的那张（图中文字命中优先展示） */
const openTextHit = js(`([...document.querySelectorAll('.photo-card')].find((c) => c.textContent.includes('图中文字') || c.textContent.includes('Text in image')) ?? document.querySelector('.photo-card'))?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`)
const scrollGrid = (top: number) => js(`(() => { const el = [...document.querySelectorAll('[role="listbox"] div')].find((d) => d.scrollHeight > d.clientHeight + 10); el?.scrollTo({ top: ${top}, behavior: 'smooth' }) })()`)

const PROMO_SCENES: Scene[] = [
  { name: 'library', caption: L('照片、视频、RAW，一个地方全部找得到', 'Photos, videos and RAW — all searchable in one place'), run: async (w) => {
    command('source:all')(w); await sleep(1800); await scrollGrid(420)(w); await sleep(1800); await scrollGrid(0)(w); await sleep(1200)
  } },
  { name: 'semantic', caption: L('用一句话描述，不用记文件名', 'Describe it in a sentence — no file names needed'), query: L('瀑布', 'waterfall'), run: async (w) => {
    await typeSlowly(w, L('瀑布', 'waterfall')); await sleep(2200); await openFirst(w); await sleep(4200); await press('Escape')(w); await sleep(600)
  } },
  { name: 'ocr', caption: L('视频画面里出现过的文字，也能搜到', 'Text that appears on screen is searchable too'), query: 'STARBUCKS', run: async (w) => {
    await typeSlowly(w, 'STARBUCKS'); await sleep(2400); await openTextHit(w); await sleep(3600); await press('Escape')(w); await sleep(400)
  } },
  // 0.4 新能力：离线自动标签（侧栏 ✦ 标签 → 检查器虚线标签）
  { name: 'autotags', caption: L('离线自动打标：无需整理，标签自己长出来', 'Automatic tags, generated offline — no manual sorting'), run: async (w) => {
    await js(typeSearch(''))(w)
    await js(`(() => { const rows = [...document.querySelectorAll('[data-tag-row]')]; const auto = rows.find((r) => r.querySelector('svg path[d^="M9.813"]')); (auto ?? rows[0])?.querySelector('[role="button"]')?.click() })()`)(w)
    await sleep(2400)
    await js(`document.querySelector('.photo-card')?.click()`)(w)
    await sleep(2600)
    await press('Escape')(w); command('source:all')(w); await sleep(400)
  } },
  // 0.4 新能力：颜色筛选（筛选栏色块）
  { name: 'color', caption: L('按颜色筛选，和搜索随意叠加', 'Filter by color — combine it with any search'), run: async (w) => {
    command('source:all')(w); await sleep(600)
    await clickTitled(() => t.organize.filterTitle)(w); await sleep(1200)
    await js(`document.querySelector('[data-color-swatch="blue"]')?.click()`)(w); await sleep(2800)
    await clickText(() => t.organize.clear)(w); await sleep(400)
    await clickTitled(() => t.organize.filterTitle)(w); await sleep(400)
  } },
  // 0.3 → 0.4：相似照片清理（演示库里有连拍 / 重复导出的副本）
  { name: 'cleanup', caption: L('连拍、重复导出，一键清理相似照片', 'Clean up bursts and re-exports in one pass'), run: async (w) => {
    command('source:cleanup')(w); await sleep(5000); command('source:all')(w); await sleep(500)
  } },
  // 0.4 新能力：设计格式（PSD / PDF / AI / SVG 预览 + 检查器格式徽标）
  { name: 'design', caption: L('PSD · PDF · AI · SVG，直接预览、直接搜', 'PSD, PDF, AI and SVG — previews and search built in'), run: async (w) => {
    await js(typeSearch(''))(w)
    await js(`[...document.querySelectorAll('nav [role="button"]')].find((b) => (b.title || '').includes('设计素材') || (b.title || '').includes('design-fixtures'))?.click()`)(w)
    await sleep(2400)
    await js(`[...document.querySelectorAll('.photo-card')].find((c) => /\\.psd$/i.test(c.getAttribute('aria-label') || ''))?.click()`)(w)
    await sleep(3000)
    await press('Escape')(w); command('source:all')(w); await sleep(500)
  } },
  { name: 'honest', caption: L('没有把握时，它会直说', 'When nothing really matches, it says so'), query: L('猫', 'cat'), run: async (w) => {
    await typeSlowly(w, L('猫', 'cat')); await sleep(3000)
  } },
  { name: 'dark', caption: L('浅色、深色，跟随系统', 'Light and dark, following your system'), run: async (w) => {
    await typeSlowly(w, ''); await js(typeSearch(''))(w); await sleep(800)
    nativeTheme.themeSource = 'dark'; await sleep(2600); nativeTheme.themeSource = 'light'; await sleep(600)
  } },
]

/** 真实鼠标移动（webContents 输入事件）：悬停预览要真的 mouseenter / mousemove，合成 DOM 事件不触发 React 的 enter */
const hoverScrub = async (win: BrowserWindow, index: number, ms: number): Promise<void> => {
  const r = await win.webContents.executeJavaScript(`(() => { const c = document.querySelectorAll('.photo-card')[${index}]; if (!c) return null; const b = c.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height } })()`) as { x: number; y: number; w: number; h: number } | null
  if (!r) return
  const y = Math.round(r.y + r.h / 2)
  const steps = Math.max(10, Math.round(ms / 50))
  for (let i = 0; i <= steps; i++) {
    win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(r.x + 4 + ((r.w - 8) * i) / steps), y })
    await sleep(ms / steps)
  }
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(r.x + r.w + 400), y: 20 })
}

/** 搜一句话 → 打开第一条（详情里自动跳到命中片段，时间轴高亮） → 返回 */
const searchAndOpen = (q: string, open: (w: BrowserWindow) => Promise<void> = openFirst, hold = 4600) => async (w: BrowserWindow): Promise<void> => {
  await typeSlowly(w, q); await sleep(2000); await open(w); await sleep(hold); await press('Escape')(w); await sleep(500)
}

/**
 * 视频素材版（VIXEL_PROMO=video）：面向剪辑师 / 自媒体，演示库是公有领域 / CC0 素材
 * （~/workspace/dancer/vixel-demo/footage，来源见其中 LICENSES.md）。查询都在该库上验证过能稳定命中。
 */
const VIDEO_SCENES: Scene[] = [
  { name: 'library', caption: L('一堆视频素材，不用整理、不用打标签', 'A pile of footage — no sorting, no manual tagging'), run: async (w) => {
    command('source:all')(w); await sleep(1800); await hoverScrub(w, 0, 2600); await sleep(400); await hoverScrub(w, 3, 2200); await sleep(600)
  } },
  { name: 'seagull', caption: L('一句话描述你要的镜头', 'Describe the shot you need'), query: L('海鸥喂小鸟', 'cat drinking from a puddle'), run: searchAndOpen(L('海鸥喂小鸟', 'cat drinking from a puddle'), openFirst, 4000) },
  { name: 'rocket', caption: L('直接跳到命中的那一段', 'Jumps straight to the matching moment'), query: L('火箭发射', 'rocket launch'), run: searchAndOpen(L('火箭发射', 'rocket launch'), openFirst, 4600) },
  // 0.4 新能力：以图搜图 / 以图搜视频（VIXEL_RECORD_IMAGE=<库外查询图路径>，先过一遍模型，多等一会）
  ...(process.env.VIXEL_RECORD_IMAGE ? [{
    name: 'imagesearch',
    caption: L('一张截图当搜索词：以图搜出视频里的那一刻', 'Search with an image — it finds the video moment'),
    run: async (w: BrowserWindow) => {
      await js(typeSearch(''))(w)
      await js(`window.dispatchEvent(new CustomEvent('vixel:image-search', { detail: { path: ${JSON.stringify(process.env.VIXEL_RECORD_IMAGE)} } }))`)(w)
      await sleep(6500)
      await openFirst(w)
      await sleep(4200)
      await press('Escape')(w)
      await js(`document.querySelector('[data-clear-image]')?.click()`)(w)
      await sleep(600)
    },
  } satisfies Scene] : []),
  { name: 'english', caption: L('中文、英文都能搜', 'Search in English or Chinese'), query: L('train arriving at a station', '火车进站'), run: searchAndOpen(L('train arriving at a station', '火车进站'), openFirst, 3800) },
  { name: 'ocr', caption: L('画面里出现过的字，也能搜到', 'Text seen in any frame is searchable'), query: 'OLD SACRAMENTO', run: searchAndOpen('OLD SACRAMENTO', openTextHit, 3800) },
  // 0.4 新能力：离线自动标签（侧栏 ✦ 标签）
  { name: 'autotags', caption: L('标签自己长出来，离线生成', 'Tags appear on their own — generated offline'), run: async (w) => {
    await js(typeSearch(''))(w)
    await js(`(() => { const rows = [...document.querySelectorAll('[data-tag-row]')]; const auto = rows.find((r) => r.querySelector('svg path[d^="M9.813"]')); (auto ?? rows[0])?.querySelector('[role="button"]')?.click() })()`)(w)
    await sleep(2600)
    await js(`document.querySelector('.photo-card')?.click()`)(w)
    await sleep(2400)
    await press('Escape')(w); command('source:all')(w); await sleep(400)
  } },
  // 0.4 新能力：颜色筛选
  { name: 'color', caption: L('按颜色筛选镜头', 'Filter shots by color'), run: async (w) => {
    await js(typeSearch(''))(w); await sleep(400)
    await clickTitled(() => t.organize.filterTitle)(w); await sleep(1200)
    await js(`document.querySelector('[data-color-swatch="blue"]')?.click()`)(w); await sleep(2600)
    await clickText(() => t.organize.clear)(w); await sleep(400)
    await clickTitled(() => t.organize.filterTitle)(w); await sleep(400)
  } },
  { name: 'offline', caption: L('完全离线：素材不上传，不需要账号', 'Fully offline: nothing uploads, no account'), query: L('烟花', 'fireworks'), run: async (w) => {
    await typeSlowly(w, L('烟花', 'fireworks')); await sleep(2200); await hoverScrub(w, 0, 2400); await sleep(800)
  } },
]

export async function runRecording(win: BrowserWindow, outPath: string, hooks: CaptureHooks = {}): Promise<void> {
  if (process.env.VIXEL_PROMO === 'panel' && hooks.quickPanel) return runPanelRecording(win, outPath, hooks.quickPanel)
  const { spawn } = await import('child_process')
  const ffmpeg = getFfmpegPath()
  if (!ffmpeg) throw new Error('ffmpeg-static not available')
  const FPS = 30
  win.setContentSize(1280, 720)
  win.center()
  // 窗口被遮挡 / 失焦时 Chromium 会停止绘制，帧订阅就收不到新帧（录出来一直是同一画面）
  win.webContents.setBackgroundThrottling(false)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.focus()
  nativeTheme.themeSource = 'light'
  await sleep(6000) // 首屏数据 + 缩略图 + 模型预热

  const enc = spawn(ffmpeg, ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'medium', '-r', String(FPS), outPath],
  { stdio: ['pipe', 'ignore', 'inherit'] })

  let latest: Buffer | null = null
  let dirty: Electron.NativeImage | null = null
  win.webContents.beginFrameSubscription(false, (image) => { dirty = image })
  const t0 = Date.now()
  let written = 0
  // 按墙钟补帧：画面不变时重复上一帧，视频时长与真实演示一致
  const tick = setInterval(() => {
    if (dirty) { latest = dirty.toJPEG(92); dirty = null }
    if (!latest) return
    const due = Math.floor(((Date.now() - t0) * FPS) / 1000)
    while (written < due) { enc.stdin.write(latest); written++ }
  }, 1000 / FPS / 2)

  const timeline: Array<{ name: string; caption: string; query?: string; start: number; end: number }> = []
  const scenes = sceneFilter(process.env.VIXEL_PROMO === 'video' ? VIDEO_SCENES : PROMO_SCENES)
  for (const scene of scenes) {
    const start = (Date.now() - t0) / 1000
    await scene.run(win)
    timeline.push({ name: scene.name, caption: scene.caption, query: scene.query, start, end: (Date.now() - t0) / 1000 })
    console.log(`[record] ${scene.name} ${start.toFixed(1)}s`)
  }
  await sleep(500)
  clearInterval(tick)
  win.setAlwaysOnTop(false)
  win.webContents.endFrameSubscription()
  enc.stdin.end()
  await new Promise((r) => enc.on('close', r))
  await writeFile(`${outPath}.timeline.json`, JSON.stringify(timeline, null, 2))
  console.log(`[record] ${written} frames → ${outPath}`)
  app.quit()
}

// ─── 快速搜索面板录屏：VIXEL_PROMO=panel ────────────────────────────────────
//
// 面板是独立窗口，主窗口的帧订阅拍不到它；这里改订面板的帧，把每帧（带透明角）
// 用 sharp 合成到一张"桌面壁纸"上（1920×1080），顶部居中 —— 像真的在任意应用里
// 按 ⇧⌘Space 呼出一样。查询 / 字幕沿用 VIXEL_RECORD_LANG。

async function runPanelRecording(win: BrowserWindow, outPath: string, qp: { show: () => BrowserWindow; hide: () => void }): Promise<void> {
  const { spawn } = await import('child_process')
  const ffmpeg = getFfmpegPath()
  if (!ffmpeg) throw new Error('ffmpeg-static not available')
  const sharp = (await import('sharp')).default
  const FPS = 30
  const W = 1920
  const H = 1080
  const PANEL_TOP = 150

  win.hide()
  const panel = qp.show()
  panel.webContents.setBackgroundThrottling(false)
  await sleep(2500)

  // 壁纸：柔和的径向渐变 + 顶部一条"菜单栏"示意（纯合成，不含任何真实桌面内容）
  const wallpaper = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><radialGradient id="g" cx="0.5" cy="0.4" r="0.9">
      <stop offset="0" stop-color="#31405C"/><stop offset="0.6" stop-color="#1C2436"/><stop offset="1" stop-color="#0D111B"/>
    </radialGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <rect width="100%" height="42" fill="#0A0D14" opacity="0.55"/>
  </svg>`)).png().toBuffer()

  const enc = spawn(ffmpeg, ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', '-preset', 'medium', '-r', String(FPS), outPath],
  { stdio: ['pipe', 'ignore', 'inherit'] })

  let latest: Buffer | null = null
  let dirty: Electron.NativeImage | null = null
  let compositing = false
  panel.webContents.beginFrameSubscription(false, (image) => { dirty = image })
  const t0 = Date.now()
  let written = 0
  const tick = setInterval(() => {
    if (dirty && !compositing) {
      const img = dirty
      dirty = null
      compositing = true
      const size = img.getSize()
      void sharp(wallpaper)
        .composite([{ input: img.toPNG(), left: Math.round((W - size.width) / 2), top: PANEL_TOP }])
        .jpeg({ quality: 92 })
        .toBuffer()
        .then((buf) => { latest = buf })
        .finally(() => { compositing = false })
    }
    if (!latest) return
    const due = Math.floor(((Date.now() - t0) * FPS) / 1000)
    while (written < due) { enc.stdin.write(latest); written++ }
  }, 1000 / FPS / 2)

  const pjs = (code: string): Promise<void> => panel.webContents.executeJavaScript(`try { ${code} } catch (e) {}`).then(() => {})
  const typePanel = async (text: string): Promise<void> => {
    for (let i = 1; i <= text.length; i++) {
      await pjs(`
        const el = document.querySelector('input[data-qp-input]');
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        set.call(el, ${JSON.stringify(text.slice(0, i))}); el.dispatchEvent(new Event('input', { bubbles: true }));`)
      await sleep(150)
    }
  }
  const pkey = (key: string): Promise<void> =>
    pjs(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }))`)

  const timeline: Array<{ name: string; caption: string; query?: string; start: number; end: number }> = []
  const scene = async (name: string, caption: string, query: string | undefined, run: () => Promise<void>): Promise<void> => {
    const start = (Date.now() - t0) / 1000
    await run()
    timeline.push({ name, caption, query, start, end: (Date.now() - t0) / 1000 })
    console.log(`[record] ${name} ${start.toFixed(1)}s`)
  }

  const q1 = L('火箭发射', 'rocket launch')
  await scene('panel', L('在任何应用里：一个快捷键，整库即搜', 'From any app: one shortcut searches your whole library'), q1, async () => {
    await sleep(1200)
    await typePanel(q1)
    await sleep(2800)
    await pkey('ArrowDown')
    await sleep(900)
    await pkey('ArrowDown')
    await sleep(2200)
  })
  await scene('panel-open', L('↩ 直接打开命中的那一刻，⌘C 拷出文件', 'Enter opens the exact moment · ⌘C copies the file'), undefined, async () => {
    await sleep(3200)
  })

  await sleep(400)
  clearInterval(tick)
  panel.webContents.endFrameSubscription()
  enc.stdin.end()
  await new Promise((r) => enc.on('close', r))
  await writeFile(`${outPath}.timeline.json`, JSON.stringify(timeline, null, 2))
  console.log(`[record] ${written} frames → ${outPath}`)
  qp.hide()
  app.quit()
}
