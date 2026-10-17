import { useEffect, useState } from 'react'
import { IS_WEB } from './platform'

/**
 * 网页链接（http://…/open?…，见 shared/deeplink.ts）的基址：
 *   - 网页版：当前站点（NAS 地址 / 桌面"本地接口"地址），浏览器里打开就是这个
 *   - 桌面版："本地接口"在跑时取它的地址 —— 开了局域网访问优先给局域网地址（手机、别的电脑能点开），
 *     否则 127.0.0.1；没开本地接口返回 null，界面不出"拷贝网页链接"
 */
export async function webLinkBase(): Promise<string | null> {
  if (IS_WEB) return location.origin
  try {
    const s = await window.api.localApi.status()
    if (!s.running || s.urls.length === 0) return null
    const lan = s.lan ? s.urls.find((u) => !/\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(u)) : undefined
    return lan ?? s.urls[0]
  } catch {
    return null
  }
}

/** 组件里用：挂载时取一次，窗口重新获得焦点时刷新（设置里开关本地接口后回来就是新的） */
export function useWebLinkBase(): string | null {
  const [base, setBase] = useState<string | null>(IS_WEB ? location.origin : null)
  useEffect(() => {
    if (IS_WEB) return
    let alive = true
    const refresh = (): void => { void webLinkBase().then((b) => { if (alive) setBase(b) }) }
    refresh()
    window.addEventListener('focus', refresh)
    return () => { alive = false; window.removeEventListener('focus', refresh) }
  }, [])
  return base
}

/**
 * 写剪贴板：navigator.clipboard 只在安全上下文（HTTPS / localhost）可用 ——
 * NAS 走 http://192.168.x.x 时拿不到，退回隐藏 textarea + execCommand('copy')
 */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    await navigator.clipboard.writeText(text)
    return
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;top:-1000px;opacity:0'
  document.body.appendChild(ta)
  ta.select()
  try {
    if (!document.execCommand('copy')) throw new Error('copy command rejected')
  } finally {
    ta.remove()
  }
}
