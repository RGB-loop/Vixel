import { describe, it, expect } from 'vitest'
import { buildDeepLink, deepLinkForItem, formatLinkTime, markdownLinkForItem, parseDeepLink } from './deeplink'

describe('buildDeepLink / parseDeepLink', () => {
  it('round-trips a photo link (hash + id)', () => {
    const url = buildDeepLink({ hash: 'a1b2c3d4e5f60718', photoId: 42 })
    expect(url).toBe('vixel://open?hash=a1b2c3d4e5f60718&id=42')
    expect(parseDeepLink(url)).toEqual({ hash: 'a1b2c3d4e5f60718', photoId: 42 })
  })

  it('round-trips a video link with a timestamp (seconds in URL, ms inside)', () => {
    const url = buildDeepLink({ hash: 'deadbeef00112233', videoId: 7, timeMs: 42_400 })
    expect(url).toBe('vixel://open?hash=deadbeef00112233&video=7&t=42')
    expect(parseDeepLink(url)).toEqual({ hash: 'deadbeef00112233', videoId: 7, timeMs: 42_000 })
  })

  it('omits t when zero and accepts fractional seconds when parsing', () => {
    expect(buildDeepLink({ videoId: 3, timeMs: 0 })).toBe('vixel://open?video=3')
    expect(parseDeepLink('vixel://open?video=3&t=1.5')).toEqual({ videoId: 3, timeMs: 1500 })
  })

  it('survives re-indexing: hash alone is a valid target', () => {
    expect(parseDeepLink('vixel://open?hash=00ff00ff00ff00ff')).toEqual({ hash: '00ff00ff00ff00ff' })
  })

  it('rejects other hosts, bad ids and hash-less empty links', () => {
    expect(parseDeepLink('vixel://thumb/5')).toBeNull() // 内部资源协议，不是深链接
    expect(parseDeepLink('https://open?id=5')).toBeNull()
    expect(parseDeepLink('vixel://open')).toBeNull()
    expect(parseDeepLink('vixel://open?id=-3')).toBeNull()
    expect(parseDeepLink('vixel://open?id=abc')).toBeNull()
    expect(parseDeepLink('vixel://open?hash=../etc')).toBeNull()
    expect(parseDeepLink('not a url')).toBeNull()
  })

  it('ignores invalid t but keeps the target', () => {
    expect(parseDeepLink('vixel://open?video=3&t=NaN')).toEqual({ videoId: 3 })
    expect(parseDeepLink('vixel://open?video=3&t=-5')).toEqual({ videoId: 3 })
  })
})

describe('deepLinkForItem', () => {
  it('uses video form for media rows and photo form otherwise', () => {
    expect(deepLinkForItem({ id: 9, fileHash: 'aa11bb22cc33dd44', videoId: 5 }, 32_000))
      .toBe('vixel://open?hash=aa11bb22cc33dd44&video=5&t=32')
    expect(deepLinkForItem({ id: 9, fileHash: 'aa11bb22cc33dd44', videoId: null }))
      .toBe('vixel://open?hash=aa11bb22cc33dd44&id=9')
  })

  it('falls back to bare id when hash is missing', () => {
    expect(deepLinkForItem({ id: 9, fileHash: '', videoId: null })).toBe('vixel://open?id=9')
  })
})

describe('markdown link', () => {
  it('formats timestamps', () => {
    expect(formatLinkTime(42_000)).toBe('0:42')
    expect(formatLinkTime(3_723_000)).toBe('1:02:03')
  })

  it('builds a markdown link with escaped brackets and optional time', () => {
    expect(markdownLinkForItem('beach.mp4', 'vixel://open?video=1&t=42', 42_000))
      .toBe('[beach.mp4 @ 0:42](vixel://open?video=1&t=42)')
    expect(markdownLinkForItem('a[b].jpg', 'vixel://open?id=1'))
      .toBe('[a\\[b\\].jpg](vixel://open?id=1)')
  })
})
