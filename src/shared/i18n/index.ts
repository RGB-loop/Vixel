/**
 * 界面文案（简体中文 / English）。
 *
 * 每个界面区域一个文件，导出 `{ zh, en }`；`en` 的类型是 `typeof zh`，漏翻 / 参数不一致编译期就报错。
 * 带数量或参数的文案写成函数（英文要处理单复数）。用法：
 *
 *   import { t } from '../shared/i18n'
 *   t.statusBar.upToDate          // 字符串
 *   t.common.items(n)             // 函数
 *
 * `t` 是 live binding：主进程切换语言时 setLocale 后重建菜单；渲染进程在首次渲染前设一次，
 * 切换语言时整窗 reload（preload 同步拿到新语言），所以组件里直接读 `t` 即可，不需要 context。
 */
import common from './common'
import shell from './shell'
import settings from './settings'
import menu from './menu'
import main from './main'
import core from './core'
import grid from './grid'
import inspector from './inspector'
import detail from './detail'
import people from './people'
import map from './map'
import tasks from './tasks'
import model from './model'
import organize from './organize'
import albums from './albums'
import cleanup from './cleanup'
import tags from './tags'
import autotags from './autotags'
import imagesearch from './imagesearch'
import collect from './collect'
import design from './design'
import quickpanel from './quickpanel'
import localapi from './localapi'
import web from './web'

const DICTS = { common, shell, settings, menu, main, core, grid, inspector, detail, people, map, tasks, model, organize, albums, cleanup, tags, autotags, imagesearch, collect, design, quickpanel, localapi, web }

export type Locale = 'zh-CN' | 'en'
export type LocaleSetting = 'system' | Locale
export type Messages = { [K in keyof typeof DICTS]: (typeof DICTS)[K]['zh'] }

function build(locale: Locale): Messages {
  const key = locale === 'zh-CN' ? 'zh' : 'en'
  return Object.fromEntries(Object.entries(DICTS).map(([ns, d]) => [ns, d[key]])) as Messages
}

/** 系统语言 → 界面语言：中文（含繁体，界面先用简体）用中文，其余一律英文 */
export function resolveLocale(setting: LocaleSetting | null | undefined, systemLanguages: readonly string[]): Locale {
  if (setting === 'zh-CN' || setting === 'en') return setting
  return /^zh\b/i.test(systemLanguages[0] ?? '') ? 'zh-CN' : 'en'
}

export let locale: Locale = 'zh-CN'
export let t: Messages = build(locale)

export function setLocale(next: Locale): void {
  locale = next
  t = build(next)
}

/** 数字 / 日期格式化用的 BCP 47 标签 */
export const intlLocale = (): string => (locale === 'zh-CN' ? 'zh-CN' : 'en-US')
