import { useEffect, useState } from 'react'
import { IS_WEB } from './platform'

/**
 * "拷贝链接"的基址（链接形如 http://…/open?…，见 shared/deeplink.ts）：
 *   - 网页版：当前站点（NAS 地址 / 桌面"本地接口"地址）
 *   - 桌面版：常驻链接服务的地址 —— 开了局域网访问给局域网地址（手机、别的电脑能点开），否则 localhost；
 *     服务没起来（端口被占）返回 null，拷贝项置灰并说明原因
 * 一律给 http 链接而不是 vixel://：笔记、聊天、文档软件都能识别成链接（高亮、可点）
 */
export async function webLinkBase(): Promise<string | null> {
  if (IS_WEB) return location.origin
  try {
    return (await window.api.localApi.status()).linkBase
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
