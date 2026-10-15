import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { detectScreenshot, inScreenshotsFolder, matchesScreenshotName, xattrIsScreenCapture } from './screenshot'

describe('matchesScreenshotName', () => {
  it('各平台 / 应用的截图命名', () => {
    for (const n of [
      'Screenshot 2026-01-02 100000.png', 'Screenshot (12).png', 'Screenshot_20260102-100000.png',
      'Screen Shot 2019-05-01 at 10.00.00.png', 'Screenshot 2026-01-02 at 10.00.00.png',
      '屏幕截图 2026-01-02 100000.png', '屏幕快照 2019-05-01 上午10.00.00.png',
      '截屏2026-01-02_10_00_00.png', '截图_20260102.png',
      'Snipaste_2026-01-02_10-00-00.png', '微信截图_20260102100000.png',
      'WeChat Screenshot_20260102.png', 'QQ截图20260102100000.png', 'TIM截图20260102.png',
      'CleanShot 2026-01-02 at 10.00.00.png', 'SCR_20260102.png',
    ]) {
      expect(matchesScreenshotName(n), n).toBe(true)
    }
  })
  it('普通照片名不命中', () => {
    for (const n of ['IMG_1234.HEIC', 'screen-door.jpg', 'Screenplay.pdf.png', 'sunset.png', 'shot_of_espresso.jpg']) {
      expect(matchesScreenshotName(n), n).toBe(false)
    }
  })
})

describe('inScreenshotsFolder', () => {
  it('Pictures\\Screenshots 目录', () => {
    expect(inScreenshotsFolder('C:\\Users\\a\\Pictures\\Screenshots\\x.png')).toBe(true)
    expect(inScreenshotsFolder('/home/a/Pictures/Screenshots/x.png')).toBe(true)
    expect(inScreenshotsFolder('C:\\Users\\a\\Pictures\\x.png')).toBe(false)
    // 文件名本身叫 Screenshots 不算
    expect(inScreenshotsFolder('/a/b/Screenshots')).toBe(false)
  })
})

// macOS 真实 xattr：写一个带 / 不带属性的文件，经 koffi getxattr 读回
// runIf 只跳过用例，describe 体在收集阶段照样执行 —— 建文件 / 调 xattr 必须放进 beforeAll，否则 Linux CI 直接报错
describe.runIf(process.platform === 'darwin')('xattrIsScreenCapture (darwin)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vx-shot-'))
  const plain = join(dir, 'plain.png')
  const marked = join(dir, 'marked.png')
  beforeAll(() => {
    writeFileSync(plain, 'x')
    writeFileSync(marked, 'x')
    // Spotlight 写的是 bplist 布尔 true；属性存在与否才是判据，值随便
    execFileSync('xattr', ['-wx', 'com.apple.metadata:kMDItemIsScreenCapture',
      '62706c6973743030090800000000000001010000000000000001000000000000000000000000000000090a', marked])
  })

  it('属性在 → true，不在 → false，文件不存在 → false（名字模式兜底）', () => {
    expect(xattrIsScreenCapture(marked)).toBe(true)
    expect(xattrIsScreenCapture(plain)).toBe(false)
    expect(xattrIsScreenCapture(join(dir, 'missing.png'))).toBe(false)
  })

  it('detectScreenshot：xattr 或名字任一命中即 1', () => {
    expect(detectScreenshot(marked, 'marked.png')).toBe(1)
    expect(detectScreenshot(plain, 'plain.png')).toBe(0)
    expect(detectScreenshot(plain, '微信截图_20260102.png')).toBe(1)
  })
})
