// 编译语音转写辅助程序（macOS 专用，见 src/native/mac/vixel-speech.swift）。
// predev / prepackage 时跑：源码没变就跳过（mtime 比较），非 macOS / 没有 swiftc 时静默无事。
// 产物 resources/speech/vixel-speech 不进 git（.gitignore），打包经 electron-builder.yml
// 的 mac.extraResources 落到 <resources>/speech/。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const src = join(root, 'src/native/mac/vixel-speech.swift')
const outDir = join(root, 'resources/speech')
const out = join(outDir, 'vixel-speech')

if (process.platform !== 'darwin') process.exit(0)
try {
  execFileSync('xcrun', ['-f', 'swiftc'], { stdio: 'ignore' })
} catch {
  console.warn('[speech-helper] swiftc not found — voice input will be unavailable in this build')
  process.exit(0)
}
if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) process.exit(0)

mkdirSync(outDir, { recursive: true })
// 经 xcrun 调用（带上 SDKROOT；直接跑 toolchain 里的 swiftc 找不到标准库）。
// 部署目标 = macOS 26（SpeechAnalyzer 的最低系统）；更老的系统上二进制加载不了 →
// 主进程把 spawn 失败归为"系统不支持"（见 src/main/voice.ts）。
execFileSync('xcrun', ['swiftc', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos26.0`, src, '-o', out], { stdio: 'inherit' })
console.log('[speech-helper] built', out)
