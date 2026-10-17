import { useEffect, useState } from 'react'
import type { ThemeMode } from '../../../../shared/types'
import { t, type LocaleSetting } from '../../../../shared/i18n'
import { defaultShortcut, eventToAccelerator, formatShortcut, type QuickPanelSettings } from '../../../../shared/quickpanel'
import { IS_MAC, IS_WEB } from '../../lib/platform'
import { AutoTagSettings } from './AutoTagSettings'
import { CollectSettings } from './CollectSettings'
import { LocalApiSettings } from './LocalApiSettings'

/** 外观选项的迷你窗口示意：侧栏 + 内容区两块，颜色写死（预览的就是另一种外观） */
const SWATCH = {
  light: { sidebar: '#f1efec', canvas: '#ffffff', ink: 'rgb(0 0 0 / 0.18)' },
  dark: { sidebar: '#171615', canvas: '#0f0f0f', ink: 'rgb(255 255 255 / 0.22)' },
} as const

const OPTIONS: Array<{ mode: ThemeMode; label: string }> = [
  { mode: 'system', label: t.settings.themeSystem },
  { mode: 'light', label: t.settings.themeLight },
  { mode: 'dark', label: t.settings.themeDark },
]

/** 语言名称用各自的语言写，不随界面语言翻译 */
const LANGUAGES: Array<{ value: LocaleSetting; label: string }> = [
  { value: 'system', label: t.settings.languageSystem },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
]

/** 设置 › 通用：外观、语言 */
export function GeneralSettings(): JSX.Element {
  const [theme, setTheme] = useState<ThemeMode | null>(null)

  const [language, setLanguage] = useState<LocaleSetting | null>(null)
  const [indexOnBattery, setIndexOnBattery] = useState<boolean | null>(null)

  useEffect(() => {
    window.api.getTheme().then(setTheme)
    window.api.getLocaleSetting().then(setLanguage)
    window.api.getIndexOnBattery().then(setIndexOnBattery).catch(() => {})
  }, [])

  const toggleIndexOnBattery = (): void => {
    const next = !(indexOnBattery ?? true)
    setIndexOnBattery(next)
    window.api.setIndexOnBattery(next).then(setIndexOnBattery).catch(() => {})
  }

  // 主进程保存后会 reload 所有窗口
  const chooseLanguage = (value: LocaleSetting): void => {
    setLanguage(value)
    void window.api.setLocaleSetting(value)
  }

  const choose = (mode: ThemeMode): void => {
    setTheme(mode)
    window.api.setTheme(mode).then(setTheme)
  }

  return (
    <div className="p-6 flex flex-col gap-6">
      <section className="settings-row flex gap-6">
        <h3 className="w-24 flex-shrink-0 text-right text-body text-ink-2 pt-1">{t.settings.appearance}</h3>
        <div className="flex flex-col gap-2">
          <div className="flex gap-4">
            {OPTIONS.map(({ mode, label }) => {
              const active = theme === mode
              return (
                <button key={mode} onClick={() => choose(mode)} className="flex flex-col items-center gap-1.5 group">
                  <span
                    className={`block w-[88px] h-[58px] rounded-md overflow-hidden transition-shadow duration-fast ${
                      active ? 'ring-2 ring-accent ring-offset-2 ring-offset-raised' : 'ring-1 ring-line-strong group-hover:ring-line-heavy'
                    }`}
                  >
                    {mode === 'system' ? (
                      <span className="relative block w-full h-full">
                        <Swatch scheme="light" />
                        <span className="absolute inset-0" style={{ clipPath: 'polygon(100% 0, 100% 100%, 0 100%)' }}>
                          <Swatch scheme="dark" />
                        </span>
                      </span>
                    ) : (
                      <Swatch scheme={mode} />
                    )}
                  </span>
                  <span className={`text-callout ${active ? 'text-ink' : 'text-ink-2'}`}>{label}</span>
                </button>
              )
            })}
          </div>
          <p className="text-caption text-ink-4">{t.settings.appearanceNote}</p>
        </div>
      </section>

      <section className="settings-row flex gap-6">
        <h3 className="w-24 flex-shrink-0 text-right text-body text-ink-2 pt-1">{t.settings.language}</h3>
        <div className="flex flex-col gap-2">
          <div className="flex gap-1 p-0.5 rounded-md bg-fill w-fit">
            {LANGUAGES.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => chooseLanguage(value)}
                className={`px-3 h-7 rounded-[5px] text-callout transition-colors duration-fast ${
                  language === value ? 'bg-raised text-ink shadow-sm' : 'text-ink-2 hover:text-ink'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-caption text-ink-4">{t.settings.languageNote}</p>
        </div>
      </section>

      {/* 快速搜索面板（全局快捷键 + 常驻窗口 + 托盘）与浏览器扩展收集：桌面专属 */}
      {!IS_WEB && <QuickSearchSettings />}

      {/* 电源策略：服务器没有电池，网页版不显示 */}
      {!IS_WEB && (
        <section className="settings-row flex gap-6" data-power-settings>
          <h3 className="w-24 flex-shrink-0 text-right text-body text-ink-2 pt-1">{t.settings.indexingSection}</h3>
          <div className="flex flex-col gap-2 min-w-0">
            <label className="flex items-center gap-2 text-callout text-ink cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={indexOnBattery ?? true}
                onChange={toggleIndexOnBattery}
                className="accent-[var(--accent)]"
              />
              {t.settings.indexOnBattery}
            </label>
            <p className="text-caption text-ink-4">{t.settings.indexOnBatteryNote}</p>
          </div>
        </section>
      )}

      <AutoTagSettings />

      {!IS_WEB && <CollectSettings />}

      {/* 本地接口（HTTP API + 网页界面 + MCP）：桌面专属 —— 网页版本身就跑在这个服务上 */}
      {!IS_WEB && <LocalApiSettings />}

      {IS_WEB && <WebAccessSettings />}
    </div>
  )
}

/** 网页版 › 访问：退出登录（清会话 cookie 后回登录页） */
function WebAccessSettings(): JSX.Element {
  const [busy, setBusy] = useState(false)
  const logout = async (): Promise<void> => {
    setBusy(true)
    try {
      await fetch('/api/logout', { method: 'POST', headers: { 'content-type': 'application/json', 'x-vixel': '1' }, body: '{}' })
    } catch { /* 网络错误也照样回登录页 */ }
    window.location.replace('/login')
  }
  return (
    <section className="settings-row flex gap-6" data-web-access>
      <h3 className="w-24 flex-shrink-0 text-right text-body text-ink-2 pt-1">{t.web.accessSection}</h3>
      <div className="flex flex-col gap-2 min-w-0">
        <button
          onClick={() => { void logout() }}
          disabled={busy}
          data-logout
          className="w-fit h-7 px-3 rounded-md bg-fill-hover hover:bg-fill-active text-ink text-callout transition-colors duration-fast disabled:opacity-50"
        >
          {t.web.logout}
        </button>
        <p className="text-caption text-ink-4">{t.web.logoutNote}</p>
      </div>
    </section>
  )
}

/**
 * 设置 › 通用 › 快速搜索：全局快捷键开关 + 快捷键录制器。
 * 录制：点击后按下组合键，主进程真的注册一次验证（被其他应用占用时如实报错，不落库）。
 */
function QuickSearchSettings(): JSX.Element {
  const [qp, setQp] = useState<QuickPanelSettings | null>(null)
  const [recording, setRecording] = useState(false)
  const [error, setError] = useState<'in-use' | 'invalid' | null>(null)

  useEffect(() => {
    window.api.quickpanel.getSettings().then(setQp).catch(() => {})
  }, [])

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        setRecording(false)
        return
      }
      // 只按修饰键时继续等；按下实键才判定
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
      const acc = eventToAccelerator(e, IS_MAC)
      if (!acc) {
        setError('invalid')
        setRecording(false)
        return
      }
      setRecording(false)
      window.api.quickpanel.setShortcut(acc).then((res) => {
        setQp(res.settings)
        setError(res.ok ? null : res.reason ?? 'invalid')
      }).catch(() => {})
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])

  if (!qp) return <></>

  const toggle = (): void => {
    window.api.quickpanel.setEnabled(!qp.enabled).then((s) => { setQp(s); setError(null) }).catch(() => {})
  }
  const reset = (): void => {
    const def = defaultShortcut(IS_MAC ? 'darwin' : 'win32')
    window.api.quickpanel.setShortcut(def).then((res) => {
      setQp(res.settings)
      setError(res.ok ? null : res.reason ?? 'invalid')
    }).catch(() => {})
  }

  const shown = formatShortcut(qp.shortcut, IS_MAC)
  const conflict = qp.enabled && !qp.registered

  return (
    <section className="settings-row flex gap-6" data-quickpanel-settings>
      <h3 className="w-24 flex-shrink-0 text-right text-body text-ink-2 pt-1">{t.quickpanel.sectionTitle}</h3>
      <div className="flex flex-col gap-2 min-w-0">
        <label className="flex items-center gap-2 text-callout text-ink cursor-pointer pt-1">
          <input type="checkbox" checked={qp.enabled} onChange={toggle} className="accent-[var(--accent)]" data-quickpanel-toggle />
          {t.quickpanel.enable}
        </label>
        <div className="flex items-center gap-2">
          <span className="text-callout text-ink-2">{t.quickpanel.shortcutLabel}</span>
          <button
            onClick={() => { setError(null); setRecording((r) => !r) }}
            title={t.quickpanel.recordHint}
            data-quickpanel-shortcut
            className={`h-7 min-w-[110px] px-3 rounded-md border text-callout tabular-nums transition-colors duration-fast ${
              recording ? 'border-accent text-accent bg-accent-fill' : 'border-line bg-fill text-ink hover:border-line-strong'
            }`}
          >
            {recording ? t.quickpanel.recording : shown}
          </button>
          <button onClick={reset} className="h-7 px-2 rounded-md text-caption text-ink-3 hover:text-ink hover:bg-fill transition-colors duration-fast">
            {t.quickpanel.resetDefault}
          </button>
        </div>
        {(conflict || error === 'in-use') && (
          <p className="text-caption text-warn" data-quickpanel-conflict>{t.quickpanel.shortcutInUse}</p>
        )}
        {error === 'invalid' && <p className="text-caption text-warn">{t.quickpanel.shortcutInvalid}</p>}
        <p className="text-caption text-ink-4">
          {t.quickpanel.enableNote(shown)}
          {!IS_MAC && ` ${t.quickpanel.trayNoteWin}`}
        </p>
      </div>
    </section>
  )
}

function Swatch({ scheme }: { scheme: 'light' | 'dark' }): JSX.Element {
  const c = SWATCH[scheme]
  return (
    <span className="flex w-full h-full" style={{ background: c.canvas }}>
      <span className="w-[26px] h-full flex flex-col gap-[3px] p-[5px] pt-[12px]" style={{ background: c.sidebar }}>
        <span className="h-[3px] rounded-full" style={{ background: c.ink }} />
        <span className="h-[3px] w-3/4 rounded-full" style={{ background: c.ink }} />
        <span className="h-[3px] w-2/3 rounded-full" style={{ background: c.ink }} />
      </span>
      <span className="flex-1 grid grid-cols-3 gap-[3px] p-[5px] pt-[12px] content-start">
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="aspect-square rounded-[2px]" style={{ background: i === 1 ? '#d4a574' : c.ink }} />
        ))}
      </span>
    </span>
  )
}
