import { useState, useCallback, useRef, useEffect } from 'react'
import { t } from '../../../shared/i18n'
import { useVoiceCapture } from '../lib/voiceCapture'

interface SearchBarProps {
  /** 当前生效的查询；外部（侧边栏最近 / 已保存）改它时输入框跟着变 */
  value: string
  onSearch: (query: string) => void
  isSearching: boolean
  resultCount?: number
  /** 当前搜索（含筛选条件）是否已存为智能相册；有查询时右侧显示 ☆ */
  saved?: boolean
  saveTitle?: string
  onToggleSave?: () => void
  /** 以图搜图：查询图芯片（缩略图 + ×）；设了之后文字变成"图 + 文"补充描述 */
  image?: { thumb: string | null; name: string } | null
  onClearImage?: () => void
  /** 网页版：没有 Finder 拖入，给一个 <input type=file> 入口上传查询图 */
  onPickImage?: (file: File) => void
}

export function SearchBar({ value, onSearch, isSearching, resultCount, saved, saveTitle, onToggleSave, image, onClearImage, onPickImage }: SearchBarProps): JSX.Element {
  const [query, setQuery] = useState(value)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<NodeJS.Timeout>()

  // 语音输入（macOS 桌面版；其它平台 status.available 为 false，不渲染麦克风）：
  // 语音 → 文字进搜索框（可编辑），随即跑一次正常文字搜索
  const voice = useVoiceCapture((text) => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    setQuery(text)
    onSearch(text)
    inputRef.current?.focus()
  })

  const debouncedSearch = useCallback(
    (value: string) => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
      debounceRef.current = setTimeout(() => {
        onSearch(value)
      }, 300)
    },
    [onSearch]
  )

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const value = e.target.value
    setQuery(value)
    debouncedSearch(value)
  }

  const handleSubmit = (e: React.FormEvent): void => {
    e.preventDefault()
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    onSearch(query)
  }

  const handleClear = (): void => {
    setQuery('')
    onSearch('')
    inputRef.current?.focus()
  }

  const handleKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'Escape') return
    // Esc 先清查询图，再清文字；都没有才冒泡给全局（关浮层等）
    if (image && onClearImage) {
      e.stopPropagation()
      onClearImage()
    } else if (query) {
      e.stopPropagation()
      handleClear()
    }
  }

  // 外部改了查询：同步输入框，并丢掉还没发出的防抖（否则会把旧文字再搜一遍）
  useEffect(() => {
    setQuery((cur) => {
      if (cur === value) return cur
      if (debounceRef.current) clearTimeout(debounceRef.current)
      return value
    })
  }, [value])

  useEffect(() => {
    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current)
      }
    }
  }, [])

  // 语音提示自动消失（点击提示本身立即关）
  const { notice: voiceNotice, clearNotice: clearVoiceNotice } = voice
  useEffect(() => {
    if (!voiceNotice) return
    const timer = setTimeout(clearVoiceNotice, 10_000)
    return () => clearTimeout(timer)
  }, [voiceNotice, clearVoiceNotice])

  // 搜索结果计数提示（以图搜图时没有文字也显示）
  const showResultHint = (query.trim() || image) && !isSearching && resultCount !== undefined

  return (
    <form onSubmit={handleSubmit} className="relative">
      <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none">
        {isSearching ? (
          <svg className="w-3.5 h-3.5 text-accent animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        ) : (
          <svg className={`w-3.5 h-3.5 transition-colors ${focused ? 'text-ink-2' : 'text-ink-4'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        )}
      </div>

      {/* 查询图芯片（以图搜图）：缩略图 + ×；文字输入保留，变成"图 + 文"补充描述 */}
      {image && (
        <div className="absolute inset-y-0 left-7 flex items-center" data-image-chip>
          <span className="flex items-center gap-1 h-[22px] pl-[3px] pr-0.5 rounded bg-accent-fill border border-accent/35" title={image.name}>
            {image.thumb ? (
              <img src={image.thumb} alt={t.imagesearch.queryImage} className="w-4 h-4 rounded-[3px] object-cover" />
            ) : (
              <svg className="w-3.5 h-3.5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path strokeLinecap="round" d="M5 17l4.5-4.5 3 3L17 11l2 2" />
              </svg>
            )}
            <button
              type="button"
              onClick={onClearImage}
              title={t.imagesearch.clearQuery}
              data-clear-image
              className="w-4 h-4 rounded flex items-center justify-center text-accent hover:bg-accent/20 transition-colors"
            >
              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.4}>
                <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </span>
        </div>
      )}

      <input
        ref={inputRef}
        id="search-input"
        type="text"
        data-search-input
        value={query}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={handleKeyDown}
        placeholder={image ? t.imagesearch.placeholderWithImage : t.shell.searchPlaceholder}
        className={`w-full h-7 ${image ? 'pl-[76px]' : 'pl-8'} pr-24 text-body rounded-md bg-fill border border-line text-ink placeholder-ink-4 focus:outline-none focus:border-accent/50 focus:bg-raised transition-colors duration-fast`}
      />

      <div className="absolute inset-y-0 right-0 flex items-center pr-2 gap-1">
        {/* 语音输入：仅在平台支持时出现（见 useVoiceCapture）；模型未下载时保留按钮、点击给指引 */}
        {voice.status && (voice.status.available || voice.status.reason === 'asset') && (
          <>
            {voice.state === 'recording' && (
              <span className="flex items-center gap-1.5" title={t.voice.listening}>
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                {/* 电平表：RMS 放大后限 0–1（语音一般只到 0.2 左右） */}
                <span className="w-8 h-[3px] rounded-full bg-fill overflow-hidden">
                  <span className="block h-full bg-accent transition-[width] duration-75" style={{ width: `${Math.min(1, voice.level * 5) * 100}%` }} />
                </span>
              </span>
            )}
            <button
              type="button"
              onClick={voice.toggle}
              disabled={voice.state === 'transcribing'}
              title={voice.state === 'recording' ? t.voice.stopTitle : voice.state === 'transcribing' ? t.voice.transcribing : t.voice.micTitle}
              aria-pressed={voice.state === 'recording'}
              data-voice-mic
              className={`p-1 rounded transition-colors ${
                voice.state === 'recording' ? 'text-red-500 bg-fill-hover'
                : voice.state === 'transcribing' ? 'text-accent'
                : 'text-ink-4 hover:text-ink-2 hover:bg-fill-hover'
              }`}
            >
              {voice.state === 'transcribing' ? (
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <rect x="9.25" y="3" width="5.5" height="11" rx="2.75" />
                  <path strokeLinecap="round" d="M6 11.5a6 6 0 0012 0M12 17.5V21" />
                </svg>
              )}
            </button>
          </>
        )}
        {/* 上传查询图（网页版的以图搜图入口；桌面用拖入 / 粘贴 / 右键） */}
        {onPickImage && !image && (
          <label
            title={t.web.uploadImage}
            data-upload-image
            className="p-1 rounded hover:bg-fill-hover transition-colors cursor-pointer text-ink-4 hover:text-ink-2"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path strokeLinecap="round" d="M5 17l4.5-4.5 3 3L17 11l2 2" />
            </svg>
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) onPickImage(f)
                e.target.value = ''
              }}
            />
          </label>
        )}
        {/* 结果计数 */}
        {showResultHint && (
          <span className="text-micro text-ink-4 tabular-nums">
            {t.common.items(resultCount ?? 0)}
          </span>
        )}
        {/* 存为智能相册（以图搜图存不进相册，不显示） */}
        {query.trim() && !image && onToggleSave && (
          <button
            type="button"
            onClick={onToggleSave}
            title={saveTitle}
            aria-pressed={!!saved}
            data-save-search
            className="p-1 rounded hover:bg-fill-hover transition-colors"
          >
            <svg className={`w-3.5 h-3.5 ${saved ? 'text-accent' : 'text-ink-3 hover:text-ink-2'}`} viewBox="0 0 24 24" fill={saved ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
            </svg>
          </button>
        )}
        {/* 清除按钮 */}
        {query && (
          <button
            type="button"
            onClick={handleClear}
            className="p-1 rounded hover:bg-fill-hover transition-colors"
          >
            <svg className="w-3.5 h-3.5 text-ink-3 hover:text-ink-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* 语音输入的错误 / 指引（权限、模型未下载等）：点击关闭，10s 自动消失（见上面的 useEffect） */}
      {voice.notice && (
        <div
          role="status"
          onClick={voice.clearNotice}
          className="absolute top-full right-0 mt-1.5 z-40 max-w-[360px] px-2.5 py-1.5 rounded-md bg-raised border border-line shadow-lg text-caption text-ink-2 cursor-pointer"
        >
          {voice.notice}
        </div>
      )}
    </form>
  )
}
