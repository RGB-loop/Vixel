#!/usr/bin/env node
/**
 * 开发期让 node_modules 里的 Electron.app 显示成 Vixel：菜单栏粗体名、Dock / ⌘Tab 名称和图标
 * 都读 Info.plist 的 CFBundleName / CFBundleDisplayName 和 Resources/electron.icns，
 * app.setName() 改不到它们。`npm run dev` 前（predev）跑一次，幂等。
 *
 * 只改名字和图标，不动 CFBundleIdentifier —— Electron 子进程靠 bundle id 找主进程的 Mach 端口。
 * 打包版走 electron-builder.yml（productName / mac.icon），与此无关。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'Vixel'

if (process.platform !== 'darwin') process.exit(0)

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const appDir = join(root, 'node_modules/electron/dist/Electron.app')
const plist = join(appDir, 'Contents/Info.plist')
const icns = join(appDir, 'Contents/Resources/electron.icns')
const ourIcns = join(root, 'build/icon.icns')
const pb = '/usr/libexec/PlistBuddy'
const lsregister =
  '/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister'

if (!existsSync(plist)) process.exit(0)

// 先断开硬链接（pnpm store 等），只改本项目这份
const rewrite = (path, data) => {
  unlinkSync(path)
  writeFileSync(path, data)
}

try {
  let changed = false

  const read = (key) => {
    try {
      return execFileSync(pb, ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  }
  const keys = ['CFBundleName', 'CFBundleDisplayName']
  if (keys.some((k) => read(k) !== NAME)) {
    rewrite(plist, readFileSync(plist))
    for (const k of keys) {
      const cmd = read(k) === null ? `Add :${k} string ${NAME}` : `Set :${k} ${NAME}`
      execFileSync(pb, ['-c', cmd, plist])
    }
    changed = true
  }

  // 深链接（vixel://open?…）开发期也要能用：macOS 的 URL scheme 必须声明在 Info.plist 里，
  // setAsDefaultProtocolClient 才会生效。打包版由 electron-builder.yml 的 protocols 写入，与此无关。
  if (read('CFBundleURLTypes:0:CFBundleURLSchemes:0') !== 'vixel') {
    rewrite(plist, readFileSync(plist))
    if (read('CFBundleURLTypes') === null) execFileSync(pb, ['-c', 'Add :CFBundleURLTypes array', plist])
    execFileSync(pb, ['-c', 'Add :CFBundleURLTypes:0 dict', plist])
    execFileSync(pb, ['-c', 'Add :CFBundleURLTypes:0:CFBundleURLName string Vixel Deep Link', plist])
    execFileSync(pb, ['-c', 'Add :CFBundleURLTypes:0:CFBundleURLSchemes array', plist])
    execFileSync(pb, ['-c', 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string vixel', plist])
    changed = true
  }

  if (existsSync(ourIcns)) {
    const want = readFileSync(ourIcns)
    if (!readFileSync(icns).equals(want)) {
      rewrite(icns, want)
      changed = true
    }
  }

  if (changed) {
    // 让 Launch Services 重新读这个 bundle，否则 Dock 还会显示缓存的旧名字 / 图标
    execFileSync(lsregister, ['-f', appDir])
    console.log(`[dev-bundle] Electron.app → ${NAME}`)
  }
} catch (err) {
  // 失败不影响开发，只是名字 / 图标还是 Electron 的
  console.warn('[dev-bundle] patch failed:', err instanceof Error ? err.message : err)
}
