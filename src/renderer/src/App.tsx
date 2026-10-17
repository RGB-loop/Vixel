import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { PhotoGrid } from './components/PhotoGrid'
import type { GridDensity } from './components/media/MediaCard'
import { PhotoDetail } from './components/PhotoDetail'
import { MapView } from './components/MapView'
import { PeopleView } from './components/PeopleView'
import { CleanupView } from './components/cleanup/CleanupView'
import { TaskDrawer } from './components/tasks/TaskDrawer'
import { QuickLook } from './components/QuickLook'
import { Inspector, SelectionSummary } from './components/inspector/Inspector'
import { Sidebar, LIBRARY_ITEMS, SIDEBAR_MIN, SIDEBAR_MAX, folderName, type Source } from './components/shell/Sidebar'
import { Toolbar } from './components/shell/Toolbar'
import { StatusBar, THUMB_MIN, THUMB_MAX } from './components/shell/StatusBar'
import { Icon } from './components/shell/icons'
import { countLine, mediaKindOf } from './lib/format'
import { IS_WEB } from './lib/platform'
import { useSemanticOff } from './lib/semantic'
import { useViewport, isTouch } from './lib/viewport'
import { thumbUrl } from './lib/mediaUrl'
import { sourcePathOf } from './lib/resultActions'
import { useSearchHistory, normalizeQuery } from './lib/searchHistory'
import { t } from '../../shared/i18n'
import { deepLinkForItem, markdownLinkForItem, parseLinkParams, httpLinkForItem, markdownThumbLinkForItem, thumbUrlForHash } from '../../shared/deeplink'
import { copyText, useWebLinkBase } from './lib/webLinks'
import { FilterBar, hasExtraFilters, countExtraFilters, describeExtraFilters, useTags, type ExtraFilters } from './components/shell/FilterBar'
import { useSmartAlbums, sameAlbumState, splitAlbumFilters } from './lib/smartAlbums'
import type { Tag } from '../../shared/tags'
import type { CollectResult } from '../../shared/collect'
import type {
  SearchResult, Photo, LibraryCounts, WatchedFolder, MenuCommand, ItemMenuAction, MediaFilters, SmartAlbum,
  ImageQueryInput,
  IndexProgress as IndexProgressType,
} from '../../shared/types'

/** 空查询浏览时一次取够整个资料库（网格是虚拟化的，渲染成本与总数无关） */
const BROWSE_LIMIT = 20000
/** 窗口窄于此宽度时检查器改为浮在网格上，不再挤占网格宽度 */
const INSPECTOR_DOCK_MIN_WINDOW = 1100
const INSPECTOR_WIDTH = 272

/** 拖入 / 粘贴的文件算不算图片：mime 优先，没有 mime（RAW 等）看扩展名 */
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp|tiff?|heic|heif|cr2|cr3|nef|arw|dng|raf|orf|rw2)$/i
const isImageFile = (f: File): boolean => f.type.startsWith('image/') || (!f.type && IMAGE_EXT_RE.test(f.name))

/** 以图搜图的查询状态：input 发给主进程，thumb 给搜索框芯片（bytes 用本地 blob URL，退出时 revoke） */
interface ImageQueryState {
  input: Pick<ImageQueryInput, 'path' | 'bytes' | 'fileHash'>
  name: string
  thumb: string | null
  localUrl?: string
}

function isTextInput(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
}

/** 标签视图的标签并进筛选栏已选的标签（AND） */
function withTag(ids: number[] | undefined, id: number): number[] {
  return [...new Set([...(ids ?? []), id])]
}

// 外壳偏好只存本机，读写失败（隐私模式 / 被清空）时回落默认值
function loadPref(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return v >= min && v <= max ? v : fallback
  } catch {
    return fallback
  }
}
// 写入防抖：拖侧栏 / 缩略图滑块每帧都会调，合并成停稳后一次同步写
const prefTimers = new Map<string, ReturnType<typeof setTimeout>>()
function savePref(key: string, value: string): void {
  const prev = prefTimers.get(key)
  if (prev) clearTimeout(prev)
  prefTimers.set(key, setTimeout(() => {
    prefTimers.delete(key)
    try { localStorage.setItem(key, value) } catch { /* 忽略 */ }
  }, 300))
}

function App(): JSX.Element {
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  // 较弱的匹配折叠：searchResults 是当前展示的切片，完整结果（含 weak）在 ref 里。
  // 展示切片和交互（选中 / 键盘 / 快速查看都按 index）天然一致，展开只是换一份切片。
  const fullResults = useRef<SearchResult[]>([])
  const [weakFold, setWeakFold] = useState<{ count: number; expanded: boolean }>({ count: 0, expanded: false })
  const applyResults = useCallback((rs: SearchResult[]) => {
    fullResults.current = rs
    const strong = rs.filter((r) => !r.weak)
    setWeakFold({ count: rs.length - strong.length, expanded: false })
    setSearchResults(strong)
  }, [])
  const toggleWeakFold = useCallback(() => {
    setWeakFold((w) => {
      const expanded = !w.expanded
      setSearchResults(expanded ? fullResults.current : fullResults.current.filter((r) => !r.weak))
      return { ...w, expanded }
    })
  }, [])
  const [selected, setSelected] = useState<SearchResult | null>(null)
  const [indexProgress, setIndexProgress] = useState<IndexProgressType | null>(null)
  const [isSearching, setIsSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [showDateFilter, setShowDateFilter] = useState(false)
  // 方向 / 分辨率 / 时长 / 人物 / 仅收藏；换查询、换来源都保留（和日期一样）
  const [extraFilters, setExtraFilters] = useState<ExtraFilters>({})
  const [showFilters, setShowFilters] = useState(false)
  const [showTasks, setShowTasks] = useState(false)
  const [source, setSource] = useState<Source>({ type: 'library', kind: 'all' })
  const [counts, setCounts] = useState<LibraryCounts | null>(null)
  const [folders, setFolders] = useState<WatchedFolder[]>([])
  // CPU 跑不了语义模型（服务器版 / 老 NAS）：无结果时的提示要说清楚，别让人"换种说法"
  const semanticOff = useSemanticOff()
  // 以图搜图：查询图 + 返回的提示（查询图在库里 / 解码或模型错误）；拖拽悬停时工具栏显示落点
  const [imageQuery, setImageQuery] = useState<ImageQueryState | null>(null)
  const [imageNotice, setImageNotice] = useState<{ inLibrary?: boolean; error?: 'decode-failed' | 'model-not-ready' } | null>(null)
  const [imageDrag, setImageDrag] = useState(false)
  // 收集箱：带文件的拖动悬停在网格上时显示"松开收集"的提示层
  const [collectDrag, setCollectDrag] = useState(false)
  // 收集结果提示条（底部居中）；undoPaths 非空时带"撤销"
  const [collectToast, setCollectToast] = useState<{ text: string; undoPaths?: string[] } | null>(null)
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try { return localStorage.getItem('shell.sidebarHidden') === '1' } catch { return false }
  })
  const [sidebarWidth, setSidebarWidth] = useState(() => loadPref('shell.sidebarWidth', 232, SIDEBAR_MIN, SIDEBAR_MAX))
  const [thumbSize, setThumbSize] = useState(() => loadPref('shell.thumbSize', 200, THUMB_MIN, THUMB_MAX))
  // 选择按 photo.id 记，索引进度刷新结果列表时不会丢
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set())
  const [focusId, setFocusId] = useState<number | null>(null)
  const anchorId = useRef<number | null>(null)
  const cols = useRef(4)
  const rowsPerPage = useRef(4)
  const [quickLookId, setQuickLookId] = useState<number | null>(null)
  // 新搜索 / 换来源时 +1，驱动网格滚回顶部
  const [scrollResetKey, setScrollResetKey] = useState(0)
  // 检查器跟随选择出现：inspectorAuto 是 ⌘I 切换的长期偏好（选中时是否自动弹出），
  // inspectorDismissed 是点 × 的一次性收起，下次点选项目时复位
  const [inspectorAuto, setInspectorAuto] = useState(() => {
    try { return localStorage.getItem('shell.inspector') !== '0' } catch { return true }
  })
  const [inspectorDismissed, setInspectorDismissed] = useState(false)
  const [narrow, setNarrow] = useState(() => window.innerWidth < INSPECTOR_DOCK_MIN_WINDOW)
  // 窄视口（手机 / 竖屏平板，<1024px）：侧栏变抽屉、检查器变底部面板、工具栏两行
  const { compact } = useViewport()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])
  useEffect(() => { if (!compact) setDrawerOpen(false) }, [compact])

  const hasSearchQuery = !!query.trim()
  const hasImageQuery = !!imageQuery
  // 信息密度：浏览默认沉浸式，搜索结果默认信息式；按 G 临时翻转，换查询 / 来源后回到默认
  const [densityOverride, setDensityOverride] = useState<GridDensity | null>(null)
  const density: GridDensity = densityOverride ?? (hasSearchQuery || hasImageQuery ? 'info' : 'immersive')
  const toggleDensity = useCallback(() => {
    setDensityOverride(density === 'info' ? 'immersive' : 'info')
  }, [density])
  // 来源按内容签名比较：重复点击同一侧栏项（对象引用变了）不应重置密度
  const sourceKey = source.type === 'library' ? `library:${source.kind}`
    : source.type === 'folder' ? `folder:${source.id}`
    : source.type === 'album' ? `album:${source.id}`
    : source.type === 'tag' ? `tag:${source.id}`
    : source.type
  useEffect(() => { setDensityOverride(null) }, [query, sourceKey, imageQuery])
  const isGrid = source.type === 'library' || source.type === 'folder' || source.type === 'favorites' ||
    source.type === 'album' || source.type === 'tag'

  // 查询条件放 ref：索引进度刷新等所有 doSearch 调用都自动带上当前来源 + 日期，
  // 不用每个调用点各自传参，也不会因闭包拿到旧值
  const filters = useRef<{ query: string; from: string; to: string; source: Source; extra: ExtraFilters; image: ImageQueryState['input'] | null }>({ query: '', from: '', to: '', source, extra: {}, image: null })

  // 智能相册：doSearch 从 ref 取相册的来源范围（类型 / 文件夹）
  const { albums, upsert: upsertAlbum } = useSmartAlbums()
  const albumsRef = useRef<SmartAlbum[]>(albums)
  albumsRef.current = albums

  const doSearch = useCallback(async (): Promise<SearchResult[]> => {
    const { query: q, from, to, source: src, extra, image } = filters.current
    const album = src.type === 'album' ? albumsRef.current.find((a) => a.id === src.id) : undefined
    const scope = album ? splitAlbumFilters(album.filters).scope : {}
    const kind = src.type === 'library' && src.kind !== 'all' ? src.kind : scope.kind
    const folderId = src.type === 'folder' ? src.id : scope.folderId
    const options: MediaFilters = {
      ...extra,
      ...(from ? { dateFrom: from } : {}),
      ...(to ? { dateTo: to } : {}),
      ...(kind ? { kind } : {}),
      ...(folderId != null ? { folderId } : {}),
      ...(src.type === 'favorites' ? { favorite: true } : {}),
      ...(src.type === 'tag' ? { tagIds: withTag(extra.tagIds, src.id) } : {}),
    }
    // 以图搜图：文字一并给出时主进程走多模态编码（图 + 文一个向量）
    if (image) {
      const r = await window.api.searchByImage({ ...image, text: q.trim() || undefined }, undefined, Object.keys(options).length ? options : undefined)
      setImageNotice(r.error ? { error: r.error } : r.queryInLibrary ? { inLibrary: true } : null)
      // 路径 / 库内 hash 查询没有本地预览：芯片缩略图用主进程生成的 data URL 补上
      if (r.queryThumb) setImageQuery((cur) => (cur && !cur.thumb ? { ...cur, thumb: r.queryThumb! } : cur))
      return r.results
    }
    return window.api.search(q, q.trim() ? undefined : BROWSE_LIMIT, Object.keys(options).length ? options : undefined)
  }, [])

  const runSearch = useCallback(async () => {
    setIsSearching(true)
    try {
      applyResults(await doSearch())
    } catch (error) {
      console.error('Search error:', error)
    } finally {
      setIsSearching(false)
    }
  }, [doSearch, applyResults])

  const refreshLibrary = useCallback(async () => {
    const [c, f] = await Promise.all([window.api.getLibraryCounts(), window.api.getFolders()])
    setCounts(c)
    setFolders(f)
    return f
  }, [])

  // 初始加载
  useEffect(() => {
    // 没有文件夹时空状态自带"添加文件夹…"，不再自动弹设置
    refreshLibrary().then((f) => { if (f.length > 0) runSearch() })
  }, [refreshLibrary, runSearch])

  // 索引进度：照片数变化时节流刷新计数和（无查询时的）网格。
  // 2 万条结果重拉不便宜，节流 ≥5s，且用户正在滚动时先推迟，别打断浏览
  const scrollActivityAt = useRef(0)
  const handleUserScroll = useCallback(() => { scrollActivityAt.current = Date.now() }, [])
  useEffect(() => {
    let last = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = (): void => {
      if (Date.now() - scrollActivityAt.current < 2000) {
        timer = setTimeout(refresh, 2000)
        return
      }
      timer = null
      refreshLibrary()
      // 以图搜图不自动重跑：路径 / 字节查询每次都要过一遍模型，索引期间 5s 一次太贵
      if (!filters.current.query.trim() && !filters.current.image && filters.current.source.type !== 'map' && filters.current.source.type !== 'people' && filters.current.source.type !== 'cleanup') {
        doSearch().then(applyResults).catch(() => {})
      }
    }
    let modelReady = false
    const unsubscribe = window.api.onIndexProgress((progress) => {
      setIndexProgress(progress)
      // 模型加载完成前发出的查询只有文件名 / OCR 命中（以图搜图则整个失败）；就绪时重跑一次补上
      if (!modelReady && progress.aiModelReady && (filters.current.query.trim() || filters.current.image)) {
        doSearch().then(applyResults).catch(() => {})
      }
      modelReady = progress.aiModelReady
      const sig = `${progress.totalPhotos}/${progress.thumbnailedPhotos}/${progress.indexedPhotos}/${progress.ocrPhotos || 0}`
      if (sig === last) return
      last = sig
      if (timer) return
      timer = setTimeout(refresh, 5000)
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [doSearch, refreshLibrary, applyResults])

  /** 打开智能相册：整套换成相册保存的查询 + 日期 + 筛选条件，再重新搜索（所以内容总是最新的） */
  const openAlbum = useCallback((album: SmartAlbum) => {
    const { dateFrom: from, dateTo: to, extra } = splitAlbumFilters(album.filters)
    const next: Source = { type: 'album', id: album.id }
    setSource(next)
    setQuery(album.query)
    setDateFrom(from)
    setDateTo(to)
    setExtraFilters(extra)
    if (from || to) setShowDateFilter(true)
    // 相册是"查询 + 筛选"的快照，不含查询图：打开时清掉以图搜图
    setImageQuery((prev) => {
      if (prev?.localUrl) URL.revokeObjectURL(prev.localUrl)
      return null
    })
    setImageNotice(null)
    filters.current = { query: album.query, from, to, extra, source: next, image: null }
    setSelectedIds(new Set())
    setFocusId(null)
    anchorId.current = null
    setScrollResetKey((k) => k + 1)
    runSearch()
  }, [runSearch])

  const handleSelectSource = useCallback((next: Source) => {
    if (next.type === 'album') {
      const album = albumsRef.current.find((a) => a.id === next.id)
      if (album) openAlbum(album)
      return
    }
    setSource(next)
    filters.current = { ...filters.current, source: next }
    setSelectedIds(new Set())
    setFocusId(null)
    anchorId.current = null
    setScrollResetKey((k) => k + 1)
    if (next.type === 'library' || next.type === 'folder' || next.type === 'favorites' || next.type === 'tag') runSearch()
  }, [runSearch, openAlbum])

  // ---------- 以图搜图 ----------
  /** 设查询图并立刻搜索；localUrl 是粘贴 / 浏览器拖入字节的本地预览（换图 / 清除时 revoke） */
  const startImageQuery = useCallback((input: ImageQueryState['input'], name: string, thumb: string | null, localUrl?: string) => {
    setImageQuery((prev) => {
      if (prev?.localUrl) URL.revokeObjectURL(prev.localUrl)
      return { input, name, thumb, localUrl }
    })
    setImageNotice(null)
    filters.current = { ...filters.current, image: input }
    setSelectedIds(new Set())
    setFocusId(null)
    anchorId.current = null
    setScrollResetKey((k) => k + 1)
    // 在地图 / 人物 / 清理里发起：回到当前资料库（和输入文字查询同款行为）
    const st = filters.current.source.type
    if (st === 'map' || st === 'people' || st === 'cleanup') {
      const back: Source = { type: 'library', kind: 'all' }
      setSource(back)
      filters.current.source = back
    }
    runSearch()
  }, [runSearch])

  const clearImageQuery = useCallback(() => {
    setImageQuery((prev) => {
      if (prev?.localUrl) URL.revokeObjectURL(prev.localUrl)
      return null
    })
    setImageNotice(null)
    if (!filters.current.image) return
    filters.current = { ...filters.current, image: null }
    setSelectedIds(new Set())
    setFocusId(null)
    anchorId.current = null
    setScrollResetKey((k) => k + 1)
    runSearch()
  }, [runSearch])

  /** 拖入 / 粘贴的文件：有本地路径（Finder）传路径，没有（浏览器 / 截图粘贴）读字节 */
  const queryWithFile = useCallback(async (file: File) => {
    const path = window.api.getPathForFile(file)
    if (path) {
      startImageQuery({ path }, file.name || path, null)
    } else {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const url = URL.createObjectURL(file)
      startImageQuery({ bytes }, file.name || t.imagesearch.queryImage, url, url)
    }
  }, [startImageQuery])

  const handleImageDrop = useCallback((files: File[]) => {
    setImageDrag(false)
    const file = files.find(isImageFile)
    // 非图片的拖放维持原行为（忽略）
    if (file) void queryWithFile(file)
  }, [queryWithFile])

  // 窗口级拖拽跟踪：带图片的拖动悬停时工具栏显示以图搜图落点，任何文件 / 链接的拖动在网格上显示
  // "收进收集箱"；落在工具栏落点上的 drop 归以图搜图（Toolbar data-image-drop），其余位置归收集箱，
  // 两者不会同时触发。窗口内部发起的拖动（人物合并等）不算
  const collectDropRef = useRef<(e: DragEvent) => void>(() => {})
  useEffect(() => {
    let depth = 0
    let internal = false
    // 拖动中只能看到 mime，看不到文件名：image/* 或未知类型（RAW 常为空）才算图片；PDF / 文本拖动不出以图搜图落点
    const hasImage = (e: DragEvent): boolean =>
      !!e.dataTransfer && Array.from(e.dataTransfer.items ?? []).some((i) => i.kind === 'file' && (i.type === '' || i.type.startsWith('image/')))
    // 可收集：任何文件（含文件夹），或浏览器拖来的链接（text/uri-list）
    const collectible = (e: DragEvent): boolean =>
      !internal && !!e.dataTransfer &&
      (Array.from(e.dataTransfer.items ?? []).some((i) => i.kind === 'file') || e.dataTransfer.types.includes('text/uri-list'))
    const onStart = (): void => { internal = true }
    const onEnd = (): void => { internal = false }
    const onEnter = (e: DragEvent): void => {
      if (!collectible(e)) return
      depth++
      if (!IS_WEB) setCollectDrag(true) // 网页版没有收集箱，不出"松开收集"层
      if (hasImage(e)) setImageDrag(true)
    }
    const onLeave = (): void => {
      if (depth > 0 && --depth === 0) { setImageDrag(false); setCollectDrag(false) }
    }
    const onOver = (e: DragEvent): void => { if (collectible(e)) e.preventDefault() }
    const onDrop = (e: DragEvent): void => {
      depth = 0
      const wasCollectible = collectible(e)
      internal = false
      setImageDrag(false)
      setCollectDrag(false)
      e.preventDefault()
      if (!wasCollectible) return
      // 工具栏的以图搜图落点自己处理了这个 drop（它不 stopPropagation，这里只负责复位状态）
      if ((e.target as HTMLElement | null)?.closest?.('[data-image-drop]')) return
      collectDropRef.current(e)
    }
    window.addEventListener('dragstart', onStart)
    window.addEventListener('dragend', onEnd)
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragstart', onStart)
      window.removeEventListener('dragend', onEnd)
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  // 粘贴图片（⌘V）：搜索框聚焦时作以图搜图；焦点不在任何可编辑元素上时存进收集箱；其他输入框不拦
  const collectPasteRef = useRef<(file: File) => void>(() => {})
  useEffect(() => {
    const onPaste = (e: ClipboardEvent): void => {
      const el = document.activeElement
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.kind === 'file' && i.type.startsWith('image/'))
      const file = item?.getAsFile()
      if (!file) return
      if (isTextInput(el)) {
        if ((el as HTMLElement).hasAttribute('data-search-input')) {
          e.preventDefault()
          void queryWithFile(file)
        }
        return
      }
      e.preventDefault()
      collectPasteRef.current(file)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [queryWithFile])

  // 截图巡检 / 自动化测试入口：主进程 executeJavaScript 派发（capture.ts 的 image-search 步骤）
  useEffect(() => {
    const onEvent = (e: Event): void => {
      const d = (e as CustomEvent).detail as { path?: string } | undefined
      if (d?.path) startImageQuery({ path: d.path }, d.path.split('/').pop() ?? 'image', null)
    }
    window.addEventListener('vixel:image-search', onEvent)
    return () => window.removeEventListener('vixel:image-search', onEvent)
  }, [startImageQuery])

  const handleSearch = useCallback((q: string) => {
    setQuery(q)
    filters.current = { ...filters.current, query: q }
    // 新查询：选择 / 焦点都是上一个结果集的，清掉并滚回顶部
    setSelectedIds(new Set())
    setFocusId(null)
    anchorId.current = null
    setScrollResetKey((k) => k + 1)
    // 在地图 / 人物 / 清理里输入查询：回到当前资料库
    const t = filters.current.source.type
    if (q.trim() && (t === 'map' || t === 'people' || t === 'cleanup')) {
      const back: Source = { type: 'library', kind: 'all' }
      setSource(back)
      filters.current.source = back
    }
    runSearch()
  }, [runSearch])

  // 快速搜索面板 → 主窗口：↩ 打开结果（视频 / 音频落到命中片段的详情）、⌘O 带查询过来。
  // 主窗口可能是面板刚建出来的：挂载后再拉一次暂存的动作
  useEffect(() => {
    const openResult = (r: SearchResult): void => {
      setQuickLookId(null)
      setSelected(r)
    }
    const unsubResult = window.api.quickpanel.onShowResult(openResult)
    const unsubSearch = window.api.quickpanel.onRunSearch(handleSearch)
    window.api.quickpanel.getPending().then((p) => {
      if (!p) return
      if (p.type === 'result') openResult(p.result)
      else handleSearch(p.query)
    }).catch(() => {})
    return () => { unsubResult(); unsubSearch() }
  }, [handleSearch])

  // 网页版的网页链接（/open?hash=…&video=…&t=…，见 shared/deeplink.ts）：定位到那一项打开详情，
  // 然后把地址栏还原成 /（刷新不会再跳一次）。桌面版走 vixel:// 深链接，由主进程处理
  useEffect(() => {
    if (!IS_WEB || location.pathname !== '/open') return
    const target = parseLinkParams(new URLSearchParams(location.search))
    window.history.replaceState(null, '', '/')
    if (!target) return
    const missing = (): void => showCollectToast(`${t.main.deepLinkMissingTitle}${t.common.sep}${t.main.deepLinkMissingDetail}`)
    window.api.resolveLink(target).then((r) => {
      if (!r) return missing()
      setQuickLookId(null)
      setSelected(r)
    }).catch(missing)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开页面时处理一次
  }, [])

  // 搜索历史：查询停稳 1.5 秒且有结果才记为"最近"，边打字边出的中间结果不算；以图搜图不记
  const history = useSearchHistory()
  const { addRecent, removeRecent } = history
  useEffect(() => {
    if (!query.trim() || imageQuery || isSearching || searchResults.length === 0) return
    const t = setTimeout(() => addRecent(query), 1500)
    return () => clearTimeout(t)
  }, [query, imageQuery, isSearching, searchResults, addRecent])
  const activeQuery = isGrid && hasSearchQuery ? normalizeQuery(query) : null

  // ---------- 智能相册 ----------
  // 当前界面上的全部条件（来源范围 + 日期 + 筛选），保存 / 比较相册都用它
  const currentAlbum = source.type === 'album' ? albums.find((a) => a.id === source.id) : undefined
  const stateFilters: MediaFilters = {
    ...extraFilters,
    ...(source.type === 'favorites' ? { favorite: true } : {}),
    ...(source.type === 'tag' ? { tagIds: withTag(extraFilters.tagIds, source.id) } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    ...(source.type === 'album' ? (currentAlbum ? splitAlbumFilters(currentAlbum.filters).scope : {})
      : source.type === 'library' && source.kind !== 'all' ? { kind: source.kind }
      : source.type === 'folder' ? { folderId: source.id }
      : {}),
  }
  // 和当前条件完全一致的相册：搜索框的 ☆ 实心，点它直接打开而不是重复保存
  const matchingAlbum = currentAlbum && sameAlbumState(currentAlbum, query, stateFilters)
    ? currentAlbum
    : albums.find((a) => sameAlbumState(a, query, stateFilters))
  // 在相册里改了查询 / 筛选：不自动写回，标题旁给"更新相册"
  const albumDirty = !!currentAlbum && !sameAlbumState(currentAlbum, query, stateFilters)
  // 以图搜图没法存进相册（查询图无处持久化），其余条件照常
  const canSaveAlbum = isGrid && !imageQuery && (!!query.trim() || Object.keys(stateFilters).length > 0)
  const albumState = useRef({ query, stateFilters, matchingAlbum, folders })
  albumState.current = { query, stateFilters, matchingAlbum, folders }

  /** 没有查询词时的默认名：竖向 · ≥ 4K · 收藏 */
  const describeFilters = useCallback(async (f: MediaFilters): Promise<string> => {
    const { dateFrom: from, dateTo: to, scope, extra } = splitAlbumFilters(f)
    const person = extra.personId != null ? (await window.api.getPeople()).find((p) => p.id === extra.personId) : undefined
    const folder = scope.folderId != null ? albumState.current.folders.find((x) => x.id === scope.folderId) : undefined
    const tagNames = (extra.tagIds ?? []).map((id) => tagsRef.current.find((x) => x.id === id)?.name).filter((x): x is string => !!x)
    const labels = [
      ...(scope.kind ? [LIBRARY_ITEMS.find((i) => i.kind === scope.kind)?.label ?? scope.kind] : []),
      ...(folder ? [folderName(folder.path)] : []),
      ...describeExtraFilters(extra, person?.name ?? undefined, tagNames),
      ...(from || to ? [t.albums.dateRange(from, to)] : []),
    ]
    return labels.join(t.common.sep) || t.albums.untitled
  }, [])

  const saveCurrentAsAlbum = useCallback(async () => {
    const { query: q, stateFilters: f, matchingAlbum: existing } = albumState.current
    if (existing) { handleSelectSource({ type: 'album', id: existing.id }); return }
    const cleanQuery = normalizeQuery(q)
    const album = await window.api.createSmartAlbum({ name: cleanQuery || await describeFilters(f), query: cleanQuery, filters: f })
    upsertAlbum(album)
    albumsRef.current = [...albumsRef.current.filter((a) => a.id !== album.id), album]
    openAlbum(album)
  }, [describeFilters, upsertAlbum, openAlbum, handleSelectSource])

  const updateAlbumWithCurrent = useCallback(async (id: number) => {
    const { query: q, stateFilters: f } = albumState.current
    const updated = await window.api.updateSmartAlbum(id, { query: normalizeQuery(q), filters: f })
    if (updated) upsertAlbum(updated)
  }, [upsertAlbum])

  const handleRenameAlbum = useCallback(async (id: number, name: string) => {
    const updated = await window.api.updateSmartAlbum(id, { name })
    if (updated) upsertAlbum(updated)
  }, [upsertAlbum])

  const handleAlbumMenu = useCallback(async (album: SmartAlbum) => {
    const action = await window.api.showSmartAlbumMenu(album.name)
    if (action === 'update') await updateAlbumWithCurrent(album.id)
    else if (action === 'delete') {
      await window.api.deleteSmartAlbum(album.id)
      const src = filters.current.source
      if (src.type === 'album' && src.id === album.id) handleSelectSource({ type: 'library', kind: 'all' })
    }
    return action
  }, [updateAlbumWithCurrent, handleSelectSource])

  // 当前打开的相册在别的窗口被删了：回到全部
  useEffect(() => {
    if (source.type === 'album' && !albums.some((a) => a.id === source.id)) {
      const timer = setTimeout(() => {
        const src = filters.current.source
        if (src.type === 'album' && !albumsRef.current.some((a) => a.id === src.id)) handleSelectSource({ type: 'library', kind: 'all' })
      }, 500)
      return () => clearTimeout(timer)
    }
  }, [albums, source, handleSelectSource])

  // ---------- 标签 ----------
  const tags = useTags()
  const tagsRef = useRef<Tag[]>(tags)
  tagsRef.current = tags
  const currentTag = source.type === 'tag' ? tags.find((x) => x.id === source.id) : undefined
  // 标签有变化（打标签、改名合并删除）：当前在看某个标签或按标签筛选时重新搜索；
  // 看的标签没了（被删 / 合并走）回到全部，筛选里去掉不存在的标签
  useEffect(() => window.api.tags.onChanged(() => {
    window.api.tags.list().then((list) => {
      const ids = new Set(list.map((x) => x.id))
      const { source: src, extra } = filters.current
      if (src.type === 'tag' && !ids.has(src.id)) { handleSelectSource({ type: 'library', kind: 'all' }); return }
      if (extra.tagIds?.some((id) => !ids.has(id))) {
        const kept = extra.tagIds.filter((id) => ids.has(id))
        const next: ExtraFilters = { ...extra }
        if (kept.length) next.tagIds = kept
        else delete next.tagIds
        setExtraFilters(next)
        filters.current = { ...filters.current, extra: next }
      }
      if (src.type === 'tag' || filters.current.extra.tagIds?.length || filters.current.query.trim()) runSearch()
    }).catch(() => {})
  }), [handleSelectSource, runSearch])

  const handleRenameTag = useCallback(async (id: number, name: string) => {
    const finalId = await window.api.tags.rename(id, name)
    // 改成已有标签的名字 = 合并过去：正在看这个标签就跟过去
    const src = filters.current.source
    if (finalId != null && finalId !== id && src.type === 'tag' && src.id === id) handleSelectSource({ type: 'tag', id: finalId })
  }, [handleSelectSource])

  const handleTagMenu = useCallback(async (tag: Tag) => {
    const action = await window.api.tags.showMenu(tag.id)
    const src = filters.current.source
    if (action?.action === 'merge' && src.type === 'tag' && src.id === tag.id) handleSelectSource({ type: 'tag', id: action.intoId })
    return action
  }, [handleSelectSource])

  // T：把焦点放进检查器的标签输入框（检查器收起时先展开）
  const [tagFocusKey, setTagFocusKey] = useState(0)

  const handleExtraFiltersChange = useCallback((next: ExtraFilters) => {
    setExtraFilters(next)
    filters.current = { ...filters.current, extra: next }
    runSearch()
  }, [runSearch])

  const handleDateFilterChange = useCallback((from: string, to: string) => {
    setDateFrom(from)
    setDateTo(to)
    filters.current = { ...filters.current, from, to }
    runSearch()
  }, [runSearch])

  const handleAddFolder = useCallback(async () => {
    const path = await window.api.selectFolder()
    if (!path) return
    const folder = await window.api.addFolder(path)
    await refreshLibrary()
    handleSelectSource({ type: 'folder', id: folder.id })
  }, [refreshLibrary, handleSelectSource])

  const toggleSidebar = useCallback(() => {
    setSidebarHidden((h) => {
      savePref('shell.sidebarHidden', h ? '0' : '1')
      return !h
    })
  }, [])

  const handleSidebarResize = useCallback((w: number) => {
    setSidebarWidth(w)
    savePref('shell.sidebarWidth', String(w))
  }, [])

  const handleThumbSize = useCallback((size: number) => {
    const clamped = Math.min(THUMB_MAX, Math.max(THUMB_MIN, size))
    setThumbSize(clamped)
    savePref('shell.thumbSize', String(clamped))
  }, [])

  // 地图 / 人物视图只给 Photo，没有搜索上下文
  const handleSelectPhoto = useCallback((photo: Photo) => setSelected({ photo, score: 0 }), [])
  const handleCloseDetail = useCallback(() => setSelected(null), [])
  const handleCloseTasks = useCallback(() => setShowTasks(false), [])

  // ---------- 选择 ----------
  const idIndex = useMemo(() => new Map(searchResults.map((r, i) => [r.photo.id, i])), [searchResults])
  const focusIndex = focusId != null ? idIndex.get(focusId) ?? -1 : -1
  const selectedResults = useMemo(
    () => (selectedIds.size === 0 ? [] : searchResults.filter((r) => selectedIds.has(r.photo.id))),
    [searchResults, selectedIds]
  )
  // 网格回调要稳定（MediaCard 是 memo 的），最新状态从 ref 读
  const live = useRef({ searchResults, selectedIds, idIndex, focusIndex })
  live.current = { searchResults, selectedIds, idIndex, focusIndex }

  const selectOnly = useCallback((id: number) => {
    setSelectedIds(new Set([id]))
    setFocusId(id)
    anchorId.current = id
  }, [])

  // ---------- 收集箱（拖入 / 粘贴 / 浏览器扩展） ----------
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const showCollectToast = useCallback((text: string, undoPaths?: string[]) => {
    setCollectToast({ text, ...(undoPaths && undoPaths.length > 0 ? { undoPaths } : {}) })
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setCollectToast(null), 6000)
  }, [])

  /** 收集结果：刷新文件夹列表（收集箱可能刚建出来）、切到对应文件夹并选中新项、弹提示条 */
  const handleCollectResult = useCallback(async (r: CollectResult) => {
    if (r.cancelled) return
    await refreshLibrary()
    if (r.revealFolderId != null) {
      handleSelectSource({ type: 'folder', id: r.revealFolderId })
      if (r.revealPhotoId != null) selectOnly(r.revealPhotoId)
    }
    const text = r.error ? r.error
      : r.saved > 0 && r.existing > 0 ? t.collect.savedAndExisting(r.saved, r.existing)
      : r.saved > 0 ? t.collect.savedToInbox(r.saved)
      : r.existing > 0 ? t.collect.alreadyInLibrary
      : r.addedFolders > 0 ? t.collect.foldersAdded(r.addedFolders)
      : t.collect.nothingToImport
    showCollectToast(r.via === 'extension' ? `${t.collect.fromExtension}${t.common.sep}${text}` : text, r.saved > 0 ? r.createdPaths : undefined)
  }, [refreshLibrary, handleSelectSource, selectOnly, showCollectToast])

  /** 撤销：把这次收进来的文件移到废纸篓 */
  const handleCollectUndo = useCallback(async () => {
    const paths = collectToast?.undoPaths
    setCollectToast(null)
    if (!paths?.length) return
    await window.api.collect.undo(paths)
    showCollectToast(t.collect.undone)
  }, [collectToast, showCollectToast])

  // 拖进窗口（工具栏落点之外）：本地文件 / 文件夹走路径，浏览器拖来的图片字节直接收，
  // 只有链接时交给主进程下载这一次（渲染进程自己不发请求，见 main/collect.ts）
  collectDropRef.current = (e: DragEvent): void => {
    const dt = e.dataTransfer
    if (!dt) return
    const files = Array.from(dt.files)
    // 网页版：收集箱整体桌面专属；拖到任意位置的图片当作以图搜图（与工具栏落点一致）
    if (IS_WEB) {
      const img = files.find(isImageFile)
      if (img) void queryWithFile(img)
      return
    }
    // getData 只能在 drop 事件里同步读
    const uri = dt.getData('text/uri-list').split('\n').map((s) => s.trim()).find((s) => s && !s.startsWith('#'))
    void (async () => {
      const paths = files.map((f) => window.api.getPathForFile(f)).filter(Boolean)
      if (paths.length > 0) return handleCollectResult(await window.api.collect.importPaths(paths))
      const img = files.find(isImageFile) ?? files[0]
      if (img) {
        const bytes = new Uint8Array(await img.arrayBuffer())
        return handleCollectResult(await window.api.collect.importBytes(bytes, img.name ?? '', 'drop'))
      }
      if (uri && /^https?:/i.test(uri)) return handleCollectResult(await window.api.collect.importUrl(uri))
    })()
  }
  collectPasteRef.current = (file: File): void => {
    if (IS_WEB) {
      // 网页版没有收集箱：焦点外粘贴的图片也作以图搜图
      if (isImageFile(file)) void queryWithFile(file)
      return
    }
    void file.arrayBuffer().then((buf) => window.api.collect.importBytes(new Uint8Array(buf), '', 'paste')).then(handleCollectResult)
  }

  // 浏览器扩展收进来的：主进程推过来，同样定位 + 提示
  const collectResultRef = useRef(handleCollectResult)
  collectResultRef.current = handleCollectResult
  useEffect(() => window.api.collect.onCollected((r) => { void collectResultRef.current(r) }), [])

  // 打开详情（详情页 ← → 翻页、检查器里点相似内容都走这里）；在当前列表里的同步成选择
  const handleSelect = useCallback((result: SearchResult) => {
    setSelected(result)
    if (live.current.idIndex.has(result.photo.id)) selectOnly(result.photo.id)
  }, [selectOnly])

  const handleItemClick = useCallback((index: number, e: React.MouseEvent) => {
    const { searchResults: rs, selectedIds: cur, idIndex: map } = live.current
    const id = rs[index]?.photo.id
    if (id == null) return
    // 触屏（无悬停指针）：双击 / 悬停预览不可用，单击直接打开详情（同时选中）
    if (isTouch() && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      selectOnly(id)
      setQuickLookId(null)
      setSelected(rs[index])
      return
    }
    // 点选项目即表示想看信息：撤销上次 × 收起
    setInspectorDismissed(false)
    if (e.shiftKey && anchorId.current != null) {
      // ⇧：锚点到当前的连续范围；⌘⇧ 在已有选择上追加
      const a = map.get(anchorId.current) ?? index
      const [lo, hi] = a < index ? [a, index] : [index, a]
      const next = new Set(e.metaKey ? cur : [])
      for (let i = lo; i <= hi; i++) next.add(rs[i].photo.id)
      setSelectedIds(next)
      setFocusId(id)
    } else if (e.metaKey) {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      setSelectedIds(next)
      setFocusId(id)
      anchorId.current = id
    } else {
      selectOnly(id)
    }
  }, [selectOnly])

  const handleItemOpen = useCallback((index: number) => {
    const r = live.current.searchResults[index]
    if (!r) return
    selectOnly(r.photo.id)
    setQuickLookId(null)
    setSelected(r)
  }, [selectOnly])

  /** 方向键 / Home / End / PageUp / PageDown 移动焦点；extend = ⇧ 从锚点扩展选择 */
  const moveFocus = useCallback((key: string, extend: boolean) => {
    const { searchResults: rs, focusIndex: fi, idIndex: map } = live.current
    if (rs.length === 0) return
    let next: number
    if (key === 'Home') next = 0
    else if (key === 'End') next = rs.length - 1
    else {
      const page = cols.current * rowsPerPage.current
      const step = key === 'ArrowLeft' ? -1
        : key === 'ArrowRight' ? 1
        : key === 'ArrowUp' ? -cols.current
        : key === 'ArrowDown' ? cols.current
        : key === 'PageUp' ? -page : page
      next = fi < 0 ? 0 : Math.min(rs.length - 1, Math.max(0, fi + step))
    }
    const id = rs[next].photo.id
    if (extend && anchorId.current != null) {
      const a = map.get(anchorId.current) ?? next
      const [lo, hi] = a < next ? [a, next] : [next, a]
      setSelectedIds(new Set(rs.slice(lo, hi + 1).map((r) => r.photo.id)))
      setFocusId(id)
    } else {
      selectOnly(id)
    }
  }, [selectOnly])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setFocusId(null)
  }, [])

  const selectAll = useCallback(() => {
    const { searchResults: rs } = live.current
    setSelectedIds(new Set(rs.map((r) => r.photo.id)))
  }, [])

  const handleColsChange = useCallback((n: number, rows: number) => {
    cols.current = n
    rowsPerPage.current = rows
  }, [])

  // ---------- 项目操作（右键菜单 / 菜单栏 / 检查器共用） ----------
  const revealItems = useCallback(async (items: SearchResult[]) => {
    // 一次最多开 20 个访达窗口，再多没有意义
    for (const r of items.slice(0, 20)) {
      const p = await sourcePathOf(r)
      if (p) await window.api.showInFinder(p)
    }
  }, [])

  const copyPaths = useCallback(async (items: SearchResult[]) => {
    const paths = (await Promise.all(items.map(sourcePathOf))).filter((p): p is string => !!p)
    try { await navigator.clipboard.writeText(paths.join('\n')) } catch (e) { console.error('Copy failed:', e) }
  }, [])

  // 深链接（vixel://open?…，见 shared/deeplink.ts）：贴进笔记后点击回到 Vixel 定位；
  // 命中片段的起点作为时间点，Markdown 形态是 [文件名 @ 0:42](vixel://…)
  const copyDeepLinks = useCallback(async (items: SearchResult[], markdown: boolean) => {
    const lines = items.map((r) => {
      const url = deepLinkForItem(r.photo, r.segment?.startMs)
      return markdown ? markdownLinkForItem(r.photo.fileName, url, r.segment?.startMs) : url
    })
    try { await navigator.clipboard.writeText(lines.join('\n')) } catch (e) { console.error('Copy failed:', e) }
  }, [])

  // 网页链接（http://…/open?…）：本地接口 / 网页版才有；Markdown 形态带按 hash 取的缩略图，笔记里直接显示预览
  const webBase = useWebLinkBase()
  const copyWebLinks = useCallback(async (items: SearchResult[], markdown: boolean) => {
    if (!webBase) return
    const lines = items.map((r) => {
      const url = httpLinkForItem(webBase, r.photo, r.segment?.startMs)
      return markdown && r.photo.fileHash
        ? markdownThumbLinkForItem(r.photo.fileName, url, thumbUrlForHash(webBase, r.photo.fileHash), r.segment?.startMs)
        : url
    })
    try { await copyText(lines.join('\n')) } catch (e) { console.error('Copy failed:', e) }
  }, [webBase])

  // 以此图搜索：直接用库里已存的向量（不再过模型），连视频片段一起搜；芯片缩略图用现成的 vixel://thumb
  const searchWithItem = useCallback((r: SearchResult) => {
    startImageQuery({ fileHash: r.photo.fileHash }, r.photo.fileName, thumbUrl(r.photo))
  }, [startImageQuery])

  // 收藏：有任何一项没收藏就全部收藏，否则全部取消（与访达标签、照片 App 一致）。
  // 只改动受影响的结果对象，网格里其余卡片不重渲染
  const toggleFavorite = useCallback(async (items: SearchResult[]) => {
    if (items.length === 0) return
    const on = !items.every((r) => r.photo.favorite)
    const hashes = new Set(items.map((r) => r.photo.fileHash).filter(Boolean))
    await window.api.setFavorite([...hashes], on)
    const patch = (r: SearchResult): SearchResult =>
      hashes.has(r.photo.fileHash) ? { ...r, photo: { ...r.photo, favorite: on } } : r
    if (!on && filters.current.source.type === 'favorites') runSearch()
    else {
      fullResults.current = fullResults.current.map(patch)
      setSearchResults((rs) => rs.map(patch))
    }
    setSelected((s) => (s ? patch(s) : s))
    refreshLibrary()
  }, [runSearch, refreshLibrary])

  const runItemAction = useCallback((action: ItemMenuAction, items: SearchResult[]) => {
    const first = items[0]
    if (!first) return
    switch (action) {
      case 'open': setQuickLookId(null); setSelected(first); break
      case 'quick-look': setQuickLookId(first.photo.id); break
      case 'reveal': revealItems(items); break
      case 'copy-path': copyPaths(items); break
      case 'copy-link': copyDeepLinks(items, false); break
      case 'copy-md-link': copyDeepLinks(items, true); break
      case 'copy-web-link': copyWebLinks(items, false); break
      case 'copy-web-md': copyWebLinks(items, true); break
      case 'search-by-image': searchWithItem(first); break
      case 'open-external': if (first.photo.videoId != null) window.api.openSourceVideo(first.photo.videoId); break
      case 'toggle-favorite': toggleFavorite(items); break
    }
  }, [revealItems, copyPaths, copyDeepLinks, copyWebLinks, searchWithItem, toggleFavorite])

  const handleItemContextMenu = useCallback(async (index: number, e: React.MouseEvent) => {
    e.preventDefault()
    const { searchResults: rs, selectedIds: cur } = live.current
    const r = rs[index]
    if (!r) return
    // 在未选中的项上右键：先把它设为唯一选择（与访达一致）
    let items: SearchResult[]
    if (cur.has(r.photo.id)) {
      items = rs.filter((x) => cur.has(x.photo.id))
    } else {
      selectOnly(r.photo.id)
      items = [r]
    }
    if (IS_WEB) return // 原生右键菜单是桌面专属；操作都在检查器 / 快捷键里
    const isMedia = items.length === 1 && mediaKindOf(r.photo) !== 'image' && r.photo.videoId != null
    // 音频的代表图是封面 / 波形，没有图片向量，不给"以此图搜索"
    const canImageSearch = items.length === 1 && mediaKindOf(r.photo) !== 'audio'
    const action = await window.api.showItemMenu({ count: items.length, isMedia, favorite: items.every((x) => x.photo.favorite), canImageSearch, webLinks: !!webBase })
    if (action) runItemAction(action, items)
  }, [selectOnly, runItemAction, webBase])

  // 当前"主项"：焦点项，否则第一个选中项
  const primary = useMemo(() => {
    if (focusIndex >= 0 && selectedIds.has(searchResults[focusIndex].photo.id)) return searchResults[focusIndex]
    return selectedResults[0] ?? null
  }, [focusIndex, selectedIds, searchResults, selectedResults])

  const quickLookResult = quickLookId != null ? searchResults[idIndex.get(quickLookId) ?? -1] ?? null : null

  /** F / 菜单"收藏"作用的对象：详情 > 快速查看 > 当前选择 */
  const favoriteTargets = (): SearchResult[] =>
    selected ? [selected] : quickLookResult ? [quickLookResult] : selectedResults
  const handleCloseQuickLook = useCallback(() => setQuickLookId(null), [])
  const handleQuickLookNavigate = useCallback((key: string) => {
    moveFocus(key, false)
  }, [moveFocus])
  // 快速查看跟随焦点
  useEffect(() => {
    if (quickLookId != null && focusId != null && focusId !== quickLookId) setQuickLookId(focusId)
  }, [focusId, quickLookId])
  const handleQuickLookOpen = useCallback(() => {
    const id = quickLookId
    setQuickLookId(null)
    const r = id != null ? live.current.searchResults[live.current.idIndex.get(id) ?? -1] : undefined
    if (r) setSelected(r)
  }, [quickLookId])

  // ---------- 检查器 ----------
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < INSPECTOR_DOCK_MIN_WINDOW)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  const inspectorShown = isGrid && inspectorAuto && !inspectorDismissed && selectedResults.length > 0
  const toggleInspector = useCallback(() => {
    setInspectorDismissed(false)
    setInspectorAuto((o) => {
      savePref('shell.inspector', o ? '0' : '1')
      return !o
    })
  }, [])
  const dismissInspector = useCallback(() => setInspectorDismissed(true), [])
  const focusTagInput = useCallback(() => {
    setInspectorDismissed(false)
    setInspectorAuto((o) => {
      if (!o) savePref('shell.inspector', '1')
      return true
    })
    setTagFocusKey((k) => k + 1)
  }, [])

  // 文件夹在任意窗口（设置窗口 / 侧边栏 +）增删后主进程广播过来
  const handleLibraryChanged = useCallback(async () => {
    const f = await refreshLibrary()
    // 当前选中的文件夹被移除了：回到全部
    const src = filters.current.source
    if (src.type === 'folder' && !f.some((x) => x.id === src.id)) handleSelectSource({ type: 'library', kind: 'all' })
    else runSearch()
  }, [refreshLibrary, runSearch, handleSelectSource])
  useEffect(() => window.api.onLibraryChanged(handleLibraryChanged), [handleLibraryChanged])

  // 原生菜单命令（快捷键由菜单注册，渲染进程不再自己监听 ⌘F / ⌘,）
  const menuHandler = useRef<(cmd: MenuCommand) => void>(() => {})
  menuHandler.current = (cmd) => {
    switch (cmd) {
      case 'source:all': case 'source:image': case 'source:video': case 'source:audio':
        handleSelectSource({ type: 'library', kind: cmd.slice(7) as 'all' })
        break
      case 'source:map': handleSelectSource({ type: 'map' }); break
      case 'source:people': handleSelectSource({ type: 'people' }); break
      case 'source:cleanup': handleSelectSource({ type: 'cleanup' }); break
      case 'find':
        if (!isGrid) handleSelectSource({ type: 'library', kind: 'all' })
        setTimeout(() => document.getElementById('search-input')?.focus(), 0)
        break
      case 'toggle-sidebar': toggleSidebar(); break
      case 'toggle-density': if (isGrid) toggleDensity(); break
      case 'zoom-in': handleThumbSize(thumbSize + 40); break
      case 'zoom-out': handleThumbSize(thumbSize - 40); break
      case 'activity': setShowTasks((s) => !s); break
      case 'add-folder': handleAddFolder(); break
      case 'toggle-inspector': toggleInspector(); break
      case 'select-all':
        // ⌘A 由菜单接管：焦点在输入框时照常全选文字
        if (isTextInput(document.activeElement)) (document.activeElement as HTMLInputElement).select?.()
        else if (isGrid && !selected) selectAll()
        break
      case 'reveal': {
        const items = selected ? [selected] : selectedResults
        if (items.length) revealItems(items)
        break
      }
      case 'quick-look':
        if (primary && isGrid && !selected) setQuickLookId((q) => (q == null ? primary.photo.id : null))
        break
      case 'toggle-favorite':
        if (!isTextInput(document.activeElement)) toggleFavorite(favoriteTargets())
        break
      case 'add-tag':
        if (isGrid && !selected && selectedResults.length > 0 && !isTextInput(document.activeElement)) focusTagInput()
        break
      case 'open-item':
        if (primary && isGrid && !selected) { setQuickLookId(null); setSelected(primary) }
        break
    }
  }
  useEffect(() => window.api.onMenuCommand((cmd) => menuHandler.current(cmd)), [])

  // 键盘：Esc 逐层退出（快速查看自己在捕获阶段处理）→ 详情 → 清空选择；
  // 网格上的方向键 / Space / ↩ 只在没有浮层时生效。抽屉自己处理 Esc。
  // 处理函数走 ref（menuHandler 同款）：选择变化不重订阅全局监听
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {})
  keyHandler.current = (e) => {
    if (e.key === 'Escape') {
      // 输入框里的 Esc 留给输入框自己（取消编辑 / 清空搜索），不关浮层不丢文本
      if (isTextInput(e.target)) return
      if (drawerOpen) closeDrawer()
      else if (selected) setSelected(null)
      else if (!showTasks && selectedIds.size > 0) clearSelection()
      else if (!showTasks && imageQuery) clearImageQuery()
      return
    }
    // F：收藏当前详情 / 快速查看 / 选中项（详情页里也可用）
    if ((e.key === 'f' || e.key === 'F') && !isTextInput(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey && !showTasks) {
      e.preventDefault()
      toggleFavorite(favoriteTargets())
      return
    }
    if (!isGrid || selected || showTasks) return
    if (isTextInput(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
    // T：给选中项加标签（焦点进检查器的标签输入框）
    if ((e.key === 't' || e.key === 'T') && selectedResults.length > 0) {
      e.preventDefault()
      focusTagInput()
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown'
      || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault()
      moveFocus(e.key, e.shiftKey)
    } else if (e.key === ' ') {
      if (!primary) return
      e.preventDefault()
      setQuickLookId(primary.photo.id)
    } else if (e.key === 'Enter') {
      if (!primary) return
      e.preventDefault()
      setSelected(primary)
    } else if (e.key === 'g' || e.key === 'G') {
      e.preventDefault()
      toggleDensity()
    }
  }
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => keyHandler.current(e)
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  const hasDateFilter = !!(dateFrom || dateTo)
  const libraryEmpty = counts !== null && counts.all === 0

  const title = useMemo(() => {
    switch (source.type) {
      case 'library': return LIBRARY_ITEMS.find((i) => i.kind === source.kind)?.label ?? t.common.all
      case 'folder': {
        const f = folders.find((x) => x.id === source.id)
        return f ? (f.isInbox ? t.collect.inbox : folderName(f.path)) : t.shell.folder
      }
      case 'map': return t.shell.map
      case 'people': return t.shell.people
      case 'cleanup': return t.cleanup.title
      case 'favorites': return t.organize.favorites
      case 'album': return currentAlbum?.name ?? t.albums.untitled
      case 'tag': return currentTag?.name ?? t.tags.section
    }
  }, [source, folders, currentAlbum, currentTag])

  const breakdown = useMemo(() => countLine(searchResults.map((r) => r.photo)), [searchResults])
  const subtitle = isGrid
    ? hasImageQuery
      ? `${t.imagesearch.title}${hasSearchQuery ? t.common.sep + t.shell.quoted(query.trim()) : ''}${t.common.sep}${t.common.items(searchResults.length)}`
      : hasSearchQuery
      ? `${t.shell.quoted(query.trim())}${t.common.sep}${t.common.items(searchResults.length)}`
      : searchResults.length > 0 ? `${t.common.items(searchResults.length)}${hasDateFilter ? t.shell.dateFiltered : hasExtraFilters(extraFilters) ? t.organize.filtered : ''}` : undefined
    : undefined

  // 窄视口抽屉：点选任何入口后收起（选中内容立即可见）
  const selectAndCloseDrawer = useCallback((next: Source) => { closeDrawer(); handleSelectSource(next) }, [closeDrawer, handleSelectSource])
  const searchAndCloseDrawer = useCallback((q: string) => { closeDrawer(); handleSearch(q) }, [closeDrawer, handleSearch])
  const sidebarEl = (drawer: boolean): JSX.Element => (
    <Sidebar
      width={sidebarWidth}
      drawer={drawer}
      onResize={handleSidebarResize}
      source={source}
      onSelect={drawer ? selectAndCloseDrawer : handleSelectSource}
      counts={counts}
      folders={folders}
      onAddFolder={handleAddFolder}
      albums={albums}
      canSaveAlbum={canSaveAlbum}
      onSaveAlbum={drawer ? () => { closeDrawer(); void saveCurrentAsAlbum() } : saveCurrentAsAlbum}
      onRenameAlbum={handleRenameAlbum}
      onAlbumMenu={handleAlbumMenu}
      tags={tags}
      onRenameTag={handleRenameTag}
      onTagMenu={handleTagMenu}
      recentSearches={history.recent}
      activeQuery={source.type === 'album' ? null : activeQuery}
      onRunSearch={drawer ? searchAndCloseDrawer : handleSearch}
      onRemoveSearch={removeRecent}
    />
  )

  return (
    <div className="h-screen flex bg-canvas text-ink">
      {!compact && !sidebarHidden && sidebarEl(false)}

      <div className="flex-1 min-w-0 flex flex-col">
        <Toolbar
          title={title}
          subtitle={subtitle}
          compact={compact}
          sidebarHidden={sidebarHidden}
          onToggleSidebar={compact ? () => setDrawerOpen((o) => !o) : toggleSidebar}
          showSearch={isGrid}
          query={query}
          onSearch={handleSearch}
          querySaved={!!matchingAlbum}
          saveQueryTitle={matchingAlbum ? t.albums.savedAs(matchingAlbum.name) : t.albums.saveAsAlbum}
          onToggleSaveQuery={saveCurrentAsAlbum}
          titleAction={albumDirty && currentAlbum ? (
            <button
              onClick={() => updateAlbumWithCurrent(currentAlbum.id)}
              title={t.albums.updateAlbumTitle}
              data-update-album
              className="flex-shrink-0 h-6 px-2 rounded-md text-caption text-accent bg-accent-fill hover:bg-accent/20 transition-colors duration-fast"
            >
              {t.albums.updateAlbum}
            </button>
          ) : undefined}
          isSearching={isSearching}
          resultCount={hasSearchQuery || hasImageQuery ? searchResults.length : undefined}
          dateActive={showDateFilter || hasDateFilter}
          onToggleDate={() => setShowDateFilter((s) => !s)}
          filterActive={showFilters || hasExtraFilters(extraFilters)}
          filterCount={countExtraFilters(extraFilters)}
          onToggleFilter={() => setShowFilters((s) => !s)}
          onOpenSettings={() => window.api.openSettings()}
          imageDrag={imageDrag}
          onImageDrop={handleImageDrop}
          queryImage={imageQuery ? { thumb: imageQuery.thumb, name: imageQuery.name } : null}
          onClearImage={clearImageQuery}
        />

        {/* 日期过滤栏 */}
        {showDateFilter && isGrid && (
          <div className="h-9 max-md:h-auto max-md:flex-wrap max-md:py-2 flex-shrink-0 px-4 bg-bar border-b border-line flex items-center gap-3 animate-fade-in">
            <span className="text-caption text-ink-3">{t.shell.date}</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => handleDateFilterChange(e.target.value, dateTo)}
              className="h-6 px-2 text-caption bg-fill border border-line rounded text-ink focus:outline-none focus:border-accent/50"
            />
            <span className="text-ink-4 text-caption">—</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => handleDateFilterChange(dateFrom, e.target.value)}
              className="h-6 px-2 text-caption bg-fill border border-line rounded text-ink focus:outline-none focus:border-accent/50"
            />
            {hasDateFilter && (
              <button
                onClick={() => { handleDateFilterChange('', ''); setShowDateFilter(false) }}
                className="text-caption text-ink-3 hover:text-ink px-1.5 py-0.5 rounded hover:bg-fill"
              >
                {t.shell.clear}
              </button>
            )}
          </div>
        )}

        {/* 筛选栏：展开时列出全部选项；收起但有生效条件时只显示条件标签 */}
        {isGrid && (showFilters || hasExtraFilters(extraFilters)) && (
          <FilterBar
            value={extraFilters}
            expanded={showFilters}
            onChange={handleExtraFiltersChange}
            onExpand={() => setShowFilters(true)}
            onClose={() => setShowFilters(false)}
          />
        )}

        {/* 主内容区 */}
        <div className="relative flex-1 min-h-0 flex">
        {/* 拖动悬停：松开收进收集箱（工具栏落点归以图搜图，见 Toolbar）。pointer-events-none，drop 由窗口级监听处理 */}
        {collectDrag && (
          <div data-collect-drop-hint className="absolute inset-0 z-30 m-2 rounded-lg border-2 border-dashed border-accent bg-canvas/70 backdrop-blur-sm flex flex-col items-center justify-center gap-1.5 pointer-events-none">
            <Icon name="inbox" className="w-9 h-9 text-accent" />
            <p className="text-body font-medium text-accent">{t.collect.dropHint}</p>
            <p className="text-caption text-ink-2">{t.collect.dropHintSub}</p>
          </div>
        )}
        {/* 收集提示条：已存入 / 已在库中 / 撤销 */}
        {collectToast && (
          <div data-collect-toast className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-raised border border-line text-callout text-ink shadow-lg animate-fade-in">
            <span>{collectToast.text}</span>
            {collectToast.undoPaths && (
              <button onClick={handleCollectUndo} className="h-6 px-2 -mr-1 rounded text-accent hover:bg-fill transition-colors duration-fast">
                {t.collect.undo}
              </button>
            )}
          </div>
        )}
        <main className="flex-1 min-w-0 overflow-hidden">
          {source.type === 'cleanup' ? (
            <CleanupView onOpenPhoto={(id) => { window.api.getPhotoDetail(id).then(handleSelectPhoto).catch(() => {}) }} />
          ) : source.type === 'people' ? (
            <PeopleView onSelectPhoto={handleSelectPhoto} />
          ) : source.type === 'map' ? (
            <MapView onSelect={handleSelectPhoto} />
          ) : searchResults.length > 0 ? (
            <div className="h-full flex flex-col">
            {/* 查询图本身在库里：已排除，如实说明 */}
            {imageNotice?.inLibrary && (
              <div className="mx-3 mt-3 px-3.5 py-2.5 rounded-lg bg-surface-2 border border-line text-callout text-ink-2 flex items-center gap-2">
                <svg className="w-4 h-4 text-ink-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                  <rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path strokeLinecap="round" d="M5 17l4.5-4.5 3 3L17 11l2 2" />
                </svg>
                <span>{t.imagesearch.selfExcluded}</span>
              </div>
            )}
            {/* 没有明显突出的结果：如实说明下面只是按相似度排的最接近几项。
                措辞不说"没有相关内容"——小库里宽泛的查询（"山"）结果其实可能是对的，只是统计上不突出 */}
            {searchResults[0]?.lowConfidence && (
              <div className="mx-3 mt-3 px-3.5 py-2.5 rounded-lg bg-surface-2 border border-line text-callout text-ink-2 flex items-center gap-2">
                <svg className="w-4 h-4 text-ink-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                  <circle cx="11" cy="11" r="7" /><path strokeLinecap="round" d="M20 20l-3.5-3.5" />
                </svg>
                <span>{hasImageQuery ? t.imagesearch.lowConfidence : t.shell.lowConfidence(query.trim())}</span>
              </div>
            )}
            <div className="flex-1 min-h-0">
            <PhotoGrid
              results={searchResults}
              isSearching={hasSearchQuery || hasImageQuery}
              density={density}
              thumbSize={thumbSize}
              selectedIds={selectedIds}
              focusIndex={focusIndex}
              scrollResetKey={scrollResetKey}
              onItemClick={handleItemClick}
              onItemOpen={handleItemOpen}
              onItemContextMenu={handleItemContextMenu}
              onColsChange={handleColsChange}
              onBackgroundClick={clearSelection}
              onUserScroll={handleUserScroll}
            />
            </div>
            {/* 较弱的匹配（融合分不到第一名一半）：默认折叠，点开才展示；只有文字查询会标 weak */}
            {(hasSearchQuery || hasImageQuery) && weakFold.count > 0 && (
              <button
                type="button"
                data-weak-toggle
                aria-expanded={weakFold.expanded}
                onClick={toggleWeakFold}
                className="flex items-center gap-3 mx-3 py-2 text-callout text-ink-3 hover:text-ink transition-colors duration-fast"
              >
                <span className="flex-1 border-t border-line" aria-hidden="true" />
                <span className="flex items-center gap-1.5">
                  <svg
                    className={`w-3 h-3 transition-transform duration-fast ${weakFold.expanded ? 'rotate-90' : ''}`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                  {weakFold.expanded ? t.grid.weakerMatchesHide : t.grid.weakerMatches(weakFold.count)}
                </span>
                <span className="flex-1 border-t border-line" aria-hidden="true" />
              </button>
            )}
            </div>
          ) : imageNotice?.error ? (
            <EmptyState
              icon="search"
              title={imageNotice.error === 'decode-failed' ? t.imagesearch.errorDecodeTitle : semanticOff ? t.shell.cpuUnsupported : t.imagesearch.errorModelTitle}
              hint={imageNotice.error === 'decode-failed' ? t.imagesearch.errorDecodeHint : semanticOff ? t.model.cpuUnsupported : t.imagesearch.errorModelHint}
            />
          ) : libraryEmpty && folders.some((f) => f.unreadable) ? (
            <EmptyState
              icon="image"
              title={t.shell.folderUnreadable}
              hint={IS_WEB ? t.settings.folderUnreadableServer : t.settings.folderUnreadableDesktop}
            />
          ) : libraryEmpty ? (
            <EmptyState
              icon="image"
              title={t.shell.emptyLibraryTitle}
              hint={IS_WEB ? t.web.serverFoldersNote : t.shell.emptyLibraryHint}
              action={IS_WEB ? undefined : { label: t.shell.addFolderEllipsis, onClick: handleAddFolder }}
            />
          ) : counts === null || isSearching ? null : source.type === 'favorites' && !hasSearchQuery && !hasDateFilter && !hasExtraFilters(extraFilters) ? (
            <EmptyState icon="image" title={t.organize.favoritesEmptyTitle} hint={t.organize.favoritesEmptyHint} />
          ) : source.type === 'tag' && !hasSearchQuery && !hasDateFilter && !hasExtraFilters(extraFilters) ? (
            <EmptyState icon="image" title={t.tags.emptyTitle} hint={t.tags.emptyHint} />
          ) : (
            <EmptyState
              icon="search"
              title={hasSearchQuery || hasImageQuery ? t.shell.noMatchTitle : t.shell.nothingHereTitle}
              hint={hasExtraFilters(extraFilters)
                ? t.organize.noFilterMatchHint
                : hasImageQuery
                ? t.imagesearch.noMatchHint
                : hasSearchQuery
                ? (semanticOff ? t.shell.noMatchHintNoSemantic : t.shell.noMatchHint)
                : hasDateFilter ? t.shell.widenDateHint : t.shell.otherCategoryHint}
            />
          )}
        </main>

        {/* 检查器：有选择才出现；宽窗口停靠在右侧，窄窗口浮在网格上；手机 / 竖屏平板变底部面板 */}
        {inspectorShown && (
          <aside
            style={compact ? undefined : { width: INSPECTOR_WIDTH }}
            className={compact
              ? 'absolute inset-x-0 bottom-0 z-20 h-[min(60vh,520px)] bg-sidebar border-t border-line rounded-t-xl shadow-2xl shadow-black/60 animate-slide-up'
              : `flex-shrink-0 bg-sidebar border-l border-line animate-slide-in ${
                  narrow ? 'absolute right-0 inset-y-0 z-20 shadow-2xl shadow-black/60' : ''
                }`}
            data-inspector
          >
            {selectedResults.length > 1 ? (
              <SelectionSummary
                onToggleFavorite={() => toggleFavorite(selectedResults)}
                results={selectedResults}
                breakdown={countLine(selectedResults.map((r) => r.photo))}
                onReveal={() => revealItems(selectedResults)}
                onCopyPaths={() => copyPaths(selectedResults)}
                onClose={dismissInspector}
                tagFocusKey={tagFocusKey}
              />
            ) : primary && (
              <Inspector
                result={primary}
                onSelect={handleSelect}
                onClose={dismissInspector}
                showPreview
                onToggleFavorite={() => toggleFavorite([primary])}
                tagFocusKey={tagFocusKey}
                onFilterColor={(c) => handleExtraFiltersChange({ ...extraFilters, color: c })}
              />
            )}
          </aside>
        )}
        </div>

        <StatusBar
          progress={indexProgress}
          itemCount={isGrid ? searchResults.length : counts?.all ?? 0}
          breakdown={breakdown}
          selectedCount={isGrid ? selectedIds.size : 0}
          onOpenActivity={() => setShowTasks(true)}
          thumbSize={isGrid ? thumbSize : undefined}
          onThumbSize={handleThumbSize}
          density={isGrid ? density : undefined}
          onToggleDensity={toggleDensity}
          folderUnreadable={folders.some((f) => f.unreadable)}
          libraryTotal={counts?.all ?? 0}
        />
      </div>

      <TaskDrawer open={showTasks} onClose={handleCloseTasks} progress={indexProgress} />

      {/* 窄视口：侧栏作为抽屉盖在内容上（汉堡按钮打开，点选 / 点遮罩 / Esc 关闭） */}
      {compact && drawerOpen && (
        <div className="fixed inset-0 z-40" data-drawer>
          <div className="absolute inset-0 bg-black/50 animate-fade-in" onClick={closeDrawer} aria-hidden="true" />
          <div className="absolute inset-y-0 left-0 w-[min(85vw,300px)] shadow-2xl shadow-black/60 animate-drawer-in">
            {sidebarEl(true)}
          </div>
        </div>
      )}

      {/* 快速查看 */}
      {quickLookResult && !selected && (
        <QuickLook
          result={quickLookResult}
          onClose={handleCloseQuickLook}
          onNavigate={handleQuickLookNavigate}
          onOpen={handleQuickLookOpen}
        />
      )}

      {/* 详情 */}
      {selected && (
        <PhotoDetail
          result={selected}
          siblings={isGrid ? searchResults : undefined}
          onSelect={handleSelect}
          onClose={handleCloseDetail}
          onToggleFavorite={() => toggleFavorite([selected])}
        />
      )}

    </div>
  )
}

function EmptyState({ icon, title, hint, action }: {
  icon: 'image' | 'search'
  title: string
  hint: string
  action?: { label: string; onClick: () => void }
}): JSX.Element {
  return (
    <div className="h-full flex items-center justify-center">
      <div className="max-w-xs text-center animate-fade-in">
        <Icon name={icon} className="w-10 h-10 mx-auto mb-3 text-ink-ghost" />
        <p className="text-ink-2 text-body">{title}</p>
        <p className="text-ink-3 text-callout mt-1.5">{hint}</p>
        {action && (
          <button
            onClick={action.onClick}
            className="mt-4 h-7 px-3 bg-accent text-black/85 text-callout font-medium rounded-md hover:brightness-110 transition duration-fast"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  )
}

export default App
