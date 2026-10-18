import { useEffect, useRef, useState } from 'react'
import type { LocalApiStatus } from '../../../../shared/localapi'
import { t } from '../../../../shared/i18n'

/**
 * 设置 › 通用 › 本地接口：桌面内嵌的服务器栈（HTTP API + 网页界面 + /mcp）的开关与配置。
 * 默认关闭；默认只监听 127.0.0.1，"允许局域网访问"强制要求口令（见 main/localApi.ts）。
 */
export function LocalApiSettings(): JSX.Element {
  const [status, setStatus] = useState<LocalApiStatus | null>(null)
  const [port, setPort] = useState('')
  const [password, setPassword] = useState('')
  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    window.api.localApi.status().then(apply).catch(() => {})
    return () => { if (copiedTimer.current) clearTimeout(copiedTimer.current) }
  }, [])

  function apply(s: LocalApiStatus): void {
    setStatus(s)
    setPort(String(s.port))
  }

  const toggle = (): void => {
    if (!status) return
    setStatus({ ...status, enabled: !status.enabled })
    window.api.localApi.set({ enabled: !status.enabled }).then(apply).catch(() => {})
  }

  const toggleLan = (): void => {
    if (!status) return
    window.api.localApi.set({ lan: !status.lan }).then(apply).catch(() => {})
  }

  const commitPort = (): void => {
    if (!status) return
    const p = Number(port)
    if (Number.isInteger(p) && p >= 1024 && p <= 65535 && p !== status.port) {
      window.api.localApi.set({ port: p }).then(apply).catch(() => {})
    } else {
      setPort(String(status.port))
    }
  }

  const commitPassword = (): void => {
    const pw = password.trim()
    if (!pw) return
    window.api.localApi.set({ password: pw }).then((s) => { apply(s); setPassword('') }).catch(() => {})
  }

  const copyToken = (): void => {
    if (!status) return
    navigator.clipboard.writeText(status.mcpToken).then(() => {
      setCopied(true)
      if (copiedTimer.current) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }

  const state = !status ? '' : !status.enabled ? t.localapi.stateStopped
    : status.error === 'port-in-use' ? t.localapi.portInUse(status.port)
    : status.error === 'password-required' ? t.localapi.passwordRequired
    : status.error ? t.localapi.startError(status.error)
    : status.running ? t.localapi.stateRunning(status.port)
    : t.localapi.stateStopped
  const bad = !!status?.error && status.enabled
  const portInput = (
    <input
      value={port}
      onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))}
      onBlur={commitPort}
      onKeyDown={(e) => { if (e.key === 'Enter') commitPort() }}
      className="w-20 h-6 px-2 rounded bg-raised border border-line text-caption text-ink tabular-nums focus:outline-none focus:border-accent/50"
    />
  )

  return (
    <section className="settings-row flex gap-6" data-localapi-settings>
      <h3 className="w-24 flex-shrink-0 text-right text-body text-ink-2 pt-1">{t.localapi.sectionTitle}</h3>
      <div className="flex flex-col gap-2 min-w-0 flex-1">
        <label className="flex items-center gap-2 text-callout text-ink cursor-pointer pt-1">
          <input type="checkbox" checked={status?.enabled ?? false} onChange={toggle} className="accent-[var(--accent)]" data-localapi-toggle />
          {t.localapi.enable}
          <span className={`text-caption ${bad ? 'text-bad' : 'text-ink-3'}`}>{state}</span>
        </label>
        <p className="text-caption text-ink-4">{t.localapi.note}</p>

        {/* 本地接口关着时也常驻一个只响应 /open 的本机链接服务（"拷贝链接"靠它）；它的端口被占时在这里说明并允许换端口 */}
        {status && !status.enabled && status.error === 'port-in-use' && (
          <div className="flex items-center gap-2 mt-1" data-link-port-in-use>
            <span className="text-caption text-bad flex-1 min-w-0">{t.localapi.linkPortInUse(status.port)}</span>
            {portInput}
          </div>
        )}

        {status?.enabled && (
          <div className="flex flex-col gap-2.5 mt-1 p-3 rounded-lg bg-fill">
            {status.urls.length > 0 && (
              <div className="flex items-start gap-2">
                <span className="w-16 flex-shrink-0 text-caption text-ink-3 pt-1">{t.localapi.addresses}</span>
                <div className="flex-1 min-w-0 flex flex-col gap-1">
                  {status.urls.map((u) => (
                    <code key={u} className="truncate px-2 py-1 rounded bg-raised border border-line text-caption text-ink select-text" data-localapi-url>{u}</code>
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center gap-2">
              <span className="w-16 flex-shrink-0 text-caption text-ink-3">{t.localapi.port}</span>
              {portInput}
            </div>
            <div className="flex items-center gap-2">
              <span className="w-16 flex-shrink-0 text-caption text-ink-3">{t.localapi.passwordLabel}</span>
              <input
                type="password"
                value={password}
                placeholder={status.hasPassword ? t.localapi.passwordSet : t.localapi.passwordPlaceholder}
                onChange={(e) => setPassword(e.target.value)}
                onBlur={commitPassword}
                onKeyDown={(e) => { if (e.key === 'Enter') commitPassword() }}
                autoComplete="new-password"
                data-localapi-password
                className="w-40 h-6 px-2 rounded bg-raised border border-line text-caption text-ink focus:outline-none focus:border-accent/50"
              />
            </div>
            <label className="flex items-center gap-2 text-callout text-ink cursor-pointer">
              <input type="checkbox" checked={status.lan} onChange={toggleLan} className="accent-[var(--accent)]" data-localapi-lan />
              {t.localapi.lan}
            </label>
            {status.error === 'password-required' && (
              <p className="text-caption text-warn -mt-1">{t.localapi.passwordRequired}</p>
            )}
            <p className="text-micro text-ink-4 -mt-1">{t.localapi.lanNote}</p>

            <div className="flex items-center gap-2">
              <span className="w-16 flex-shrink-0 text-caption text-ink-3">{t.localapi.mcpEndpoint}</span>
              <code className="flex-1 min-w-0 truncate px-2 py-1 rounded bg-raised border border-line text-caption text-ink select-text">
                {`http://127.0.0.1:${status.port}/mcp`}
              </code>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-16 flex-shrink-0 text-caption text-ink-3">{t.localapi.mcpToken}</span>
              <code className="flex-1 min-w-0 truncate px-2 py-1 rounded bg-raised border border-line text-caption text-ink select-text" data-localapi-token>
                {status.mcpToken}
              </code>
              <button onClick={copyToken} className="flex-shrink-0 h-6 px-2 rounded-md bg-fill-hover hover:bg-fill-active text-caption text-ink-2 hover:text-ink transition-colors">
                {copied ? t.collect.copied : t.collect.copy}
              </button>
              <button
                onClick={() => { window.api.localApi.newToken().then(apply).catch(() => {}) }}
                className="flex-shrink-0 h-6 px-2 rounded-md bg-fill-hover hover:bg-fill-active text-caption text-ink-2 hover:text-ink transition-colors"
              >
                {t.collect.regenerate}
              </button>
            </div>
            <p className="text-micro text-ink-4 -mt-1">{t.localapi.mcpNote}</p>
          </div>
        )}
      </div>
    </section>
  )
}
