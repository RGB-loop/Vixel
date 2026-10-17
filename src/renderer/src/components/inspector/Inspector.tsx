import { useEffect, useState } from 'react'
import type { MediaDetail, PhotoDetail, PhotoLocation, SearchResult } from '../../../../shared/types'
import type { ItemSource } from '../../../../shared/collect'
import { formatDuration, formatFileSize, mediaKindOf } from '../../lib/format'
import { downloadOriginal, imageUrl, mediaSrcUrl, thumbUrl } from '../../lib/mediaUrl'
import { IS_WEB, revealLabel } from '../../lib/platform'
import { deepLinkForItem, markdownLinkForItem } from '../../../../shared/deeplink'
import { Icon } from '../shell/icons'
import { TagEditor } from './TagEditor'
import { designBadgeOf } from '../media/MediaCard'
import { intlLocale, t } from '../../../../shared/i18n'

const KIND_LABEL = { image: t.common.image, video: t.common.video, audio: t.common.audio } as const

interface InspectorProps {
  result: SearchResult
  /** 点相似内容 */
  onSelect: (result: SearchResult) => void
  /** 停靠在主窗口时在顶部显示缩略图；详情页里主区已有大图，不需要 */
  showPreview?: boolean
  /** 详情页里有关闭按钮 */
  onClose?: () => void
  /** 播放器读到的真实分辨率（库里没记录时） */
  resolution?: { w: number; h: number } | null
  /** 收藏 / 取消收藏（F） */
  onToggleFavorite?: () => void
  /** 变化时把焦点放进标签输入框（T） */
  tagFocusKey?: number
  /** 点色板按该色桶筛选（详情页等没有筛选栏的宿主不传 → 色板只展示） */
  onFilterColor?: (bucket: string) => void
}

/**
 * 检查器：单个项目的元数据、片段信息、文件位置和相似内容。
 * 主窗口右侧停靠面板和全屏详情页的侧栏共用这一个组件。
 * 媒体的 photo 行是代表图（首帧 / 封面 / 波形），文件大小、路径要用 MediaDetail 里源文件的。
 */
export function Inspector({ result, onSelect, showPreview, onClose, resolution: resolutionOverride, onToggleFavorite, tagFocusKey, onFilterColor }: InspectorProps): JSX.Element {
  const { photo, segment } = result
  const kind = mediaKindOf(photo)
  const isMedia = kind !== 'image' && photo.videoId != null
  const [detail, setDetail] = useState<PhotoDetail | null>(null)
  const [media, setMedia] = useState<MediaDetail | null>(null)
  const [locations, setLocations] = useState<PhotoLocation[]>([])
  const [similar, setSimilar] = useState<SearchResult[]>([])
  const [source, setSource] = useState<ItemSource | null>(null)
  const [isEditingCaption, setIsEditingCaption] = useState(false)
  const [editCaption, setEditCaption] = useState('')

  useEffect(() => {
    let cancelled = false
    setIsEditingCaption(false)
    // 清掉上一张的内容，避免新照片顶着旧元数据
    setDetail(null)
    setLocations([])
    setSimilar([])
    setSource(null)
    // 方向键连按时防抖 250ms：停在哪张才为哪张发详情 / 位置 / 相似检索
    const timer = setTimeout(() => {
      Promise.all([
        window.api.getPhotoDetail(photo.id),
        window.api.getPhotoLocations(photo.id),
        window.api.findSimilar(photo.id, 6),
        photo.fileHash ? window.api.collect.getSource(photo.fileHash) : Promise.resolve(null),
      ]).then(([d, locs, sim, src]) => {
        if (cancelled) return
        setDetail(d)
        setLocations(locs)
        setSimilar(sim)
        setSource(src)
      })
    }, 250)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [photo.id, photo.fileHash])

  useEffect(() => {
    setMedia(null)
    if (!isMedia || photo.videoId == null) return
    let cancelled = false
    window.api.getMediaDetail(photo.videoId).then((m) => { if (!cancelled) setMedia(m) })
    return () => { cancelled = true }
  }, [isMedia, photo.videoId])

  const resolution = resolutionOverride ?? (media?.width && media.height ? { w: media.width, h: media.height } : null)
  const sourcePath = isMedia ? media?.filePath : photo.filePath
  const dup = photo.duplicateCount && photo.duplicateCount > 1 ? photo.duplicateCount : 0

  // 深链接：hash 优先（重建索引后仍有效）；媒体带上命中片段的起点
  const copyDeepLink = (markdown: boolean): void => {
    const url = deepLinkForItem(photo, segment?.startMs)
    const text = markdown ? markdownLinkForItem(media?.fileName ?? photo.fileName, url, segment?.startMs) : url
    void navigator.clipboard.writeText(text).catch((e) => console.error('Copy failed:', e))
  }
  // 音频代表图没有图片向量，embed_status 永远 pending，不能算"索引中"
  const indexState = kind === 'audio' || photo.embedStatus === 'done'
    ? { label: t.inspector.indexed, cls: 'text-ink-2' }
    : photo.embedStatus === 'error'
      ? { label: t.inspector.failed, cls: 'text-bad' }
      : { label: t.inspector.indexing, cls: 'text-warn' }

  return (
    <div className="h-full flex flex-col min-h-0">
      {showPreview && (
        <div className="p-3 pb-0">
          <div className="relative aspect-[4/3] rounded-lg overflow-hidden bg-surface-2">
            <img src={thumbUrl(photo)} alt={photo.fileName} className="absolute inset-0 w-full h-full object-contain" />
          </div>
        </div>
      )}

      <div className="flex items-start gap-2 px-4 pt-3">
        <h2 className="text-headline text-ink flex-1 break-all">{photo.fileName}</h2>
        {onToggleFavorite && <FavoriteButton on={!!photo.favorite} onClick={onToggleFavorite} />}
        {onClose && <CloseButton onClick={onClose} />}
      </div>

      <div className="flex-1 overflow-auto px-4 pt-3 pb-4 flex flex-col gap-4">
        {/* 描述 */}
        <Section
          title={t.inspector.description}
          action={!isEditingCaption && (
            <button
              onClick={() => { setEditCaption(detail?.caption || ''); setIsEditingCaption(true) }}
              className="text-caption text-ink-3 hover:text-ink px-1 rounded hover:bg-fill-hover transition-colors duration-fast"
            >
              {detail?.caption ? t.inspector.edit : t.inspector.add}
            </button>
          )}
        >
          {isEditingCaption ? (
            <div className="flex flex-col gap-1.5">
              <textarea
                value={editCaption}
                onChange={(e) => setEditCaption(e.target.value)}
                onKeyDown={(e) => {
                  // Esc 只取消编辑，不冒泡到 App 关掉详情 / 清空选择
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setIsEditingCaption(false)
                  }
                }}
                className="w-full bg-fill border border-line-strong rounded-md p-1.5 text-ink text-callout resize-none focus:outline-none focus:border-accent/50"
                rows={3}
                autoFocus
              />
              <div className="flex gap-1.5">
                <button
                  onClick={async () => {
                    await window.api.updateCaption(photo.id, editCaption)
                    setDetail((prev) => prev ? { ...prev, caption: editCaption } : prev)
                    setIsEditingCaption(false)
                  }}
                  className="h-6 px-2 text-caption bg-accent text-black/85 font-medium rounded-md hover:brightness-110"
                >
                  {t.common.save}
                </button>
                <button
                  onClick={() => setIsEditingCaption(false)}
                  className="h-6 px-2 text-caption bg-fill text-ink-2 rounded-md hover:bg-fill-hover"
                >
                  {t.common.cancel}
                </button>
              </div>
            </div>
          ) : detail?.caption ? (
            <p className="text-ink text-callout">{detail.caption}</p>
          ) : (
            <p className="text-ink-4 text-callout">{t.inspector.noDescription}</p>
          )}
        </Section>

        <Section title={t.tags.tags}>
          <TagEditor hashes={photo.fileHash ? [photo.fileHash] : []} focusKey={tagFocusKey} />
        </Section>

        {detail?.ocrText && detail.ocrText.trim().length > 0 && (
          <Section title={t.inspector.textInImage}>
            <p className="text-ink text-callout whitespace-pre-line break-words">{detail.ocrText}</p>
          </Section>
        )}

        {isMedia && (
          <Section title={t.inspector.media}>
            <dl className="flex flex-col gap-1.5 text-callout">
              <Row label={t.inspector.type}>{KIND_LABEL[kind]}</Row>
              <Row label={t.inspector.duration}>{media?.durationMs ? formatDuration(media.durationMs) : '–'}</Row>
              {kind === 'video' && <Row label={t.inspector.resolution}>{resolution ? `${resolution.w} × ${resolution.h}` : '–'}</Row>}
              <Row label={t.inspector.indexedSegments}>
                {media ? `${media.segments.length}${media.durationMs ? ` / ${Math.max(1, Math.ceil(media.durationMs / 32000))}` : ''}` : '–'}
              </Row>
              {segment && (
                <Row label={t.inspector.hit}><span className="text-accent">{formatDuration(segment.startMs)} – {formatDuration(segment.endMs)}</span></Row>
              )}
            </dl>
          </Section>
        )}

        <Section title={t.inspector.file}>
          <dl className="flex flex-col gap-1.5 text-callout">
            {!isMedia && designBadgeOf(photo.fileName) && <Row label={t.design.format}>{designBadgeOf(photo.fileName)}</Row>}
            {!isMedia && <Row label={t.inspector.dimensions}>{detail?.width && detail?.height ? `${detail.width} × ${detail.height}` : '–'}</Row>}
            {!isMedia && (detail?.pages ?? 0) > 0 && <Row label={t.design.pages}>{t.design.pageCount(detail!.pages!)}</Row>}
            <Row label={t.inspector.size}>{isMedia ? (media ? formatFileSize(media.fileSize) : '–') : formatFileSize(photo.fileSize)}</Row>
            {detail?.takenAt && <Row label={t.inspector.taken}>{formatDate(detail.takenAt)}</Row>}
            <Row label={t.inspector.index}><span className={indexState.cls}>{indexState.label}</span></Row>
            {dup > 0 && <Row label={t.inspector.copies}>{t.inspector.copyCount(dup)}</Row>}
          </dl>
        </Section>

        {detail?.palette && detail.palette.length > 0 && (
          <Section title={t.design.palette}>
            <div className="flex items-center gap-1.5">
              {detail.palette.map((c, i) => {
                const name = t.design.colorNames[c.bucket] ?? c.bucket
                const title = t.design.paletteSwatchTitle(name, Math.round(c.p * 100))
                return onFilterColor ? (
                  <button
                    key={i}
                    onClick={() => onFilterColor(c.bucket)}
                    title={title}
                    aria-label={title}
                    data-palette-swatch={c.bucket}
                    className="h-6 rounded-md border border-line hover:ring-2 hover:ring-accent/60 transition-shadow duration-fast"
                    style={{ background: c.hex, flexGrow: Math.max(0.12, c.p), flexBasis: 0 }}
                  />
                ) : (
                  <span
                    key={i}
                    title={`${name} · ${Math.round(c.p * 100)}%`}
                    className="h-6 rounded-md border border-line"
                    style={{ background: c.hex, flexGrow: Math.max(0.12, c.p), flexBasis: 0 }}
                  />
                )
              })}
            </div>
          </Section>
        )}

        {!isMedia && detail?.exif && (detail.exif.make || detail.exif.model) && (
          <Section title={t.inspector.camera}>
            <dl className="flex flex-col gap-1.5 text-callout">
              {detail.exif.make && <Row label={t.inspector.make}>{detail.exif.make}</Row>}
              {detail.exif.model && <Row label={t.inspector.model}>{detail.exif.model}</Row>}
              {detail.exif.focalLength && <Row label={t.inspector.focalLength}>{detail.exif.focalLength} mm</Row>}
              {detail.exif.fNumber && <Row label={t.inspector.aperture}>f/{detail.exif.fNumber}</Row>}
              {detail.exif.exposureTime && <Row label={t.inspector.shutter}>{detail.exif.exposureTime} s</Row>}
              {detail.exif.iso && <Row label="ISO">{detail.exif.iso}</Row>}
            </dl>
          </Section>
        )}

        <Section title={`${t.inspector.location}${locations.length > 1 ? ` · ${locations.length}` : ''}`}>
          <div className="flex flex-col gap-1">
            {isMedia || locations.length === 0 ? (
              <p className="text-ink-3 text-caption break-all bg-fill px-2 py-1.5 rounded-md select-text">{sourcePath ?? '–'}</p>
            ) : locations.map((loc, i) => (
              <div key={i} className="bg-fill px-2 py-1.5 rounded-md">
                <p className="text-ink-3 text-caption break-all select-text">{loc.filePath}</p>
                <p className="text-ink-4 text-micro mt-0.5">{loc.folderName}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {IS_WEB ? (
              // 网页版："在访达中显示"换成下载原文件；系统播放器不可用，隐藏
              <ActionButton
                icon="folder"
                onClick={() => downloadOriginal(isMedia ? mediaSrcUrl(photo.videoId!) : imageUrl(photo.id), media?.fileName ?? photo.fileName)}
              >
                {t.web.downloadOriginal}
              </ActionButton>
            ) : (
              <>
                <ActionButton icon="folder" onClick={() => sourcePath && window.api.showInFinder(sourcePath)}>{revealLabel}</ActionButton>
                {isMedia && (
                  <ActionButton icon="video" onClick={() => photo.videoId != null && window.api.openSourceVideo(photo.videoId)}>
                    {t.inspector.systemPlayer}
                  </ActionButton>
                )}
                {/* 深链接（vixel://open?…）：贴进笔记后点击回到 Vixel 定位；网页版隐藏（等价物是 http 链接） */}
                <ActionButton icon="link" onClick={() => copyDeepLink(false)}>{t.menu.copyLink}</ActionButton>
                <ActionButton icon="link" onClick={() => copyDeepLink(true)}>{t.menu.copyMarkdownLink}</ActionButton>
              </>
            )}
          </div>
        </Section>

        {/* 来源：浏览器扩展 / 拖入时记下的原始地址，点击在系统浏览器打开（主进程只放行 http/https） */}
        {source && (source.url || source.pageUrl) && (
          <Section title={t.collect.source}>
            <dl className="flex flex-col gap-1.5 text-callout">
              {source.pageUrl && (
                <Row label={t.collect.sourcePage}>
                  <SourceLink url={source.pageUrl} label={source.pageTitle || hostOf(source.pageUrl)} />
                </Row>
              )}
              {source.url && (
                <Row label={t.collect.source}>
                  <SourceLink url={source.url} label={hostOf(source.url)} />
                </Row>
              )}
              {source.collectedAt && <Row label={t.collect.collectedAt}>{formatDate(source.collectedAt.includes('T') ? source.collectedAt : `${source.collectedAt.replace(' ', 'T')}Z`)}</Row>}
            </dl>
          </Section>
        )}

        {similar.length > 0 && (
          <Section title={t.inspector.similar}>
            <div className="grid grid-cols-3 gap-1">
              {similar.map((r) => (
                <button
                  key={r.photo.id}
                  onClick={() => onSelect(r)}
                  title={r.photo.fileName}
                  className="aspect-square rounded overflow-hidden bg-surface-2 hover:ring-2 hover:ring-accent/60 transition-shadow duration-fast"
                >
                  <img src={thumbUrl(r.photo)} alt={r.photo.fileName} className="w-full h-full object-cover" loading="lazy" decoding="async" />
                </button>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  )
}

/** 多选时检查器显示的汇总 */
export function SelectionSummary({ results, breakdown, onReveal, onCopyPaths, onClose, onToggleFavorite, tagFocusKey }: {
  results: SearchResult[]
  breakdown: string
  onReveal: () => void
  onCopyPaths: () => void
  onClose?: () => void
  onToggleFavorite?: () => void
  tagFocusKey?: number
}): JSX.Element {
  const preview = results.slice(0, 9)
  const hashes = [...new Set(results.map((r) => r.photo.fileHash).filter(Boolean))]
  return (
    <div className="h-full flex flex-col p-4 gap-4 overflow-auto">
      <div className="grid grid-cols-3 gap-1">
        {preview.map((r) => (
          <div key={r.photo.id} className="aspect-square rounded overflow-hidden bg-surface-2">
            <img src={thumbUrl(r.photo)} alt="" className="w-full h-full object-cover" loading="lazy" decoding="async" />
          </div>
        ))}
      </div>
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <h2 className="text-headline text-ink">{t.inspector.selectedCount(results.length)}</h2>
          <p className="text-callout text-ink-3 mt-0.5">{breakdown}</p>
        </div>
        {onToggleFavorite && <FavoriteButton on={results.every((r) => r.photo.favorite)} onClick={onToggleFavorite} />}
        {onClose && <CloseButton onClick={onClose} />}
      </div>
      <Section title={t.tags.tags}>
        <TagEditor hashes={hashes} focusKey={tagFocusKey} />
      </Section>
      <div className="flex flex-wrap gap-1.5">
        {!IS_WEB && <ActionButton icon="folder" onClick={onReveal}>{revealLabel}</ActionButton>}
        <ActionButton icon="all" onClick={onCopyPaths}>{t.common.copyPath}</ActionButton>
      </div>
    </div>
  )
}

/** 心形收藏开关；多选时"全部已收藏"才显示实心 */
function FavoriteButton({ on, onClick }: { on: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      aria-pressed={on}
      title={t.organize.favoriteTitle(on)}
      data-favorite-toggle
      className={`w-6 h-6 touch:w-9 touch:h-9 rounded-md flex-shrink-0 flex items-center justify-center transition-colors duration-fast ${
        on ? 'text-accent hover:bg-fill-hover' : 'text-ink-3 hover:text-ink hover:bg-fill-hover'
      }`}
    >
      <Icon name="heart" filled={on} className="w-4 h-4" />
    </button>
  )
}

function CloseButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick() }}
      className="w-6 h-6 rounded-md text-ink-3 hover:text-ink hover:bg-fill-hover transition-colors duration-fast flex-shrink-0 flex items-center justify-center"
      title={t.inspector.closeEsc}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  )
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }): JSX.Element {
  return (
    <section>
      <div className="h-5 flex items-center justify-between mb-1">
        <h3 className="text-caption font-semibold text-ink-3">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  // 截断的长值悬停能看全：纯文本内容直接作 tooltip
  const title = typeof children === 'string' || typeof children === 'number' ? String(children) : undefined
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-ink-3 flex-shrink-0">{label}</dt>
      <dd className="text-ink-2 tabular-nums text-right truncate" title={title}>{children}</dd>
    </div>
  )
}

function ActionButton({ icon, onClick, children }: { icon: Parameters<typeof Icon>[0]['name']; onClick: () => void; children: React.ReactNode }): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex-1 basis-auto whitespace-nowrap h-7 px-2 rounded-md bg-fill-hover hover:bg-fill-active text-ink text-callout flex items-center justify-center gap-1.5 transition-colors duration-fast"
    >
      <Icon name={icon} className="w-3.5 h-3.5 text-ink-2" />
      {children}
    </button>
  )
}

function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleString(intlLocale(), {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** 来源链接显示用的主机名；解析不了就原样给 */
function hostOf(url: string): string {
  try { return new URL(url).hostname } catch { return url }
}

/** 桌面：经主进程 shell.openExternal 打开（只放行 http/https）；网页版：普通新标签页链接 */
function SourceLink({ url, label }: { url: string; label: string }): JSX.Element {
  if (IS_WEB) {
    const safe = /^https?:/i.test(url)
    return (
      <a
        href={safe ? url : undefined}
        target="_blank"
        rel="noreferrer noopener"
        title={url}
        className="max-w-full truncate text-accent hover:underline text-right"
      >
        {label}
      </a>
    )
  }
  return (
    <button
      onClick={() => { void window.api.collect.openSource(url) }}
      title={url}
      className="max-w-full truncate text-accent hover:underline text-right"
    >
      {label}
    </button>
  )
}
