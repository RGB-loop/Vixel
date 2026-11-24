/**
 * Embedding 服务
 *
 * EmbeddingGemma 2 多模态本地推理（文本/图像/音频/视频，768 维），经 LiteRT-LM，纯本地，零网络依赖。
 *
 * 配置文件：<userData>/embedding-config.json，只存用户可调的项：
 *   { "backend": "auto" }    // auto | gpu | cpu
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { release } from 'os'
import { join } from 'path'
import type {
  EmbeddingProvider,
  EmbeddingProviderConfig,
  EmbeddingInput,
  LiteRtProviderConfig,
} from './types'
import { LiteRtEmbeddingProvider, LITERT_MODEL_FILE } from './providers/litert/litertProvider'
import { LITERT_LIB_NAME } from './providers/litert/native'
import { RemoteEmbeddingProvider } from './providers/remoteProvider'
import { getInferenceTransport } from '../inference/transport'
import { t } from '../../shared/i18n'

export * from './types'

// 模块级状态
let _userDataPath: string = ''
let _bundledModelsDir: string = ''
let _litertLibDir: string = ''

/**
 * @param litertLibDir LiteRT-LM 原生库目录（打包后 <resources>/litert，开发时 resources/litert/<platform>-<arch>）
 */
export function initEmbeddingServicePath(
  userDataPath: string,
  bundledModelsDir?: string,
  litertLibDir?: string
): void {
  _userDataPath = userDataPath
  if (bundledModelsDir) _bundledModelsDir = bundledModelsDir
  if (litertLibDir) _litertLibDir = litertLibDir
}

/**
 * LiteRT-LM 预编译库的 CPU 基线（库里 "This binary was compiled with X enabled" 的 fail-fast 检查，
 * 缺任何一项加载即退出），换成 /proc/cpuinfo 里的 flag 名：
 *   x64：AVX 是实际门槛 —— 群晖 DS920+ / DS720+ / DS420+（J4125）、DS220+（J4025）、DS918+（J3455）、
 *        N5105 等 NAS 都没有 AVX（qemu 实测：Denverton 退出，SandyBridge 即只有 AVX 也能跑）
 *   arm64：要 ARMv8.2（dotprod / fp16 / lse …）—— RTD1296（Cortex-A53）的 DS218 / DS418 / DS220j 不行，
 *        RTD1619B（Cortex-A55）可以
 * 升级 LiteRT 运行时后用 `strings liblitert-lm.so | grep "compiled with"` 核对这张表。
 */
const LITERT_CPU_FLAGS: Record<string, string[]> = {
  x64: ['aes', 'avx', 'cx16', 'mmx', 'pclmulqdq', 'popcnt', 'sse', 'sse2', 'pni', 'sse4_1', 'sse4_2', 'ssse3'],
  arm64: ['aes', 'crc32', 'asimddp', 'fphp', 'asimdhp', 'atomics', 'lrcpc', 'asimdrdm', 'sha2'],
}

/** cpuinfo 里缺了哪些 LiteRT 需要的 flag；读不懂格式就当不缺（免得误伤）。导出给测试 */
export function missingCpuFlags(cpuinfo: string, arch: string): string[] {
  const required = LITERT_CPU_FLAGS[arch]
  if (!required) return []
  // x86 是 "flags : …"，ARM 是 "Features : …"；取第一颗核
  const line = cpuinfo.match(/^(?:flags|Features)\s*:(.*)$/m)?.[1]
  if (line === undefined) return []
  const have = new Set(line.trim().split(/\s+/))
  return required.filter((f) => !have.has(f))
}

/**
 * 这颗 CPU 跑不了语义模型。这时整个语义通道停用 —— 不加载、不重试，
 * OCR / 人脸 / 文件名 / 标签照常。结果缓存。
 * Linux（服务器版 / Docker）读 /proc/cpuinfo 预判；Windows 没有等价物，
 * 在引擎创建失败后由 diagnoseEngineFailure 补判（见下）。
 */
let _cpuUnsupported: boolean | undefined
export function semanticCpuUnsupported(): boolean {
  if (_cpuUnsupported === undefined) {
    _cpuUnsupported = false
    if (process.platform === 'linux') {
      try {
        const missing = missingCpuFlags(readFileSync('/proc/cpuinfo', 'utf8'), process.arch)
        if (missing.length > 0) {
          _cpuUnsupported = true
          console.warn(`[embedding] CPU lacks ${missing.join(', ')} — semantic model can't run here`)
        }
      } catch { /* 读不到就当支持 */ }
    }
  }
  return _cpuUnsupported
}

/** 这个错误 = CPU 后端（最后的退路）也没能创建引擎（见 providers/litert/native.ts）。导出给测试 */
export function cpuEngineCreationFailed(err: unknown): boolean {
  return /failed to create cpu engine/.test(String(err))
}

/**
 * Windows：这颗 CPU 是否缺 AVX（LiteRT x64 预编译库的硬门槛，V2EX #7 报的
 * "failed to create cpu engine" 就是老 CPU 上这样出来的）。
 *
 * 只用来在引擎创建已经失败之后解释原因，绝不预判拦截：
 *   - Hyper-V 开着时 IsProcessorFeaturePresent 可能把有 AVX 的 CPU 报成没有（预判会误伤）
 *   - PF_AVX_INSTRUCTIONS_AVAILABLE(39) 要 Win10 2004（build 19041）起才有效，
 *     更老的系统对它一律返回 false，分不清「没 AVX」和「系统太老」，所以 build 不够直接放弃判断
 */
function windowsCpuLacksAvx(): boolean {
  if (process.platform !== 'win32' || process.arch !== 'x64') return false
  const build = Number(release().split('.')[2])
  if (!(build >= 19041)) return false
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi') as typeof import('koffi')
    const kernel32 = koffi.load('kernel32.dll')
    const isFeaturePresent = kernel32.func('bool __stdcall IsProcessorFeaturePresent(uint32 feature)')
    return !isFeaturePresent(39 /* PF_AVX_INSTRUCTIONS_AVAILABLE */)
  } catch {
    return false
  }
}

/**
 * 引擎创建失败后的诊断：Windows 上 CPU 后端都起不来、且系统确认没有 AVX →
 * 按「CPU 不支持」处理（与 Linux 服务器版同一套 UI：状态栏 / 设置页解释清楚，
 * 索引器跳过语义通道，OCR / 人脸 / 文件名 / 标签照常）。返回是否据此改判。
 */
function diagnoseEngineFailure(err: unknown): boolean {
  if (_cpuUnsupported) return true
  if (cpuEngineCreationFailed(err) && windowsCpuLacksAvx()) {
    _cpuUnsupported = true
    console.warn('[embedding] CPU lacks AVX — semantic model can\'t run here')
    return true
  }
  return false
}

/** LiteRT 运行时 + 模型是否都在 */
export function isLiteRtInstalled(): boolean {
  const lib = LITERT_LIB_NAME[process.platform]
  return !!lib && !!_litertLibDir && existsSync(join(_litertLibDir, lib)) &&
    existsSync(join(_bundledModelsDir, 'litert', LITERT_MODEL_FILE))
}

function getConfigPath(): string {
  return join(_userDataPath, 'embedding-config.json')
}

function readPersisted(): Record<string, unknown> {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) return {}
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch (err) {
    console.warn('Failed to parse embedding-config.json, using defaults:', err)
    return {}
  }
}

/**
 * 设置页里选过的后端优先；没选过用 VIXEL_BACKEND（Docker 镜像默认 cpu：容器里通常没有 GPU，
 * 免得每次启动先空试一遍 WebGPU、打出一串吓人的 ERROR）；都没有 = auto（GPU 优先，失败退 CPU）
 */
function parseBackend(v: unknown): 'auto' | 'gpu' | 'cpu' | undefined {
  return v === 'auto' || v === 'gpu' || v === 'cpu' ? v : undefined
}

function loadConfig(): EmbeddingProviderConfig {
  const raw = readPersisted()
  return {
    type: 'litert',
    modelsDir: _bundledModelsDir,
    libDir: _litertLibDir,
    backend: parseBackend(raw.backend) ?? parseBackend(process.env.VIXEL_BACKEND) ?? 'auto',
    cacheDir: _userDataPath ? join(_userDataPath, 'litert-cache') : undefined,
  }
}

function saveConfig(config: EmbeddingProviderConfig): void {
  // 只把用户能调整的字段写盘；路径等运行时字段不持久化
  writeFileSync(getConfigPath(), JSON.stringify({ backend: config.backend ?? 'auto' }, null, 2))
}

class EmbeddingService {
  private provider: EmbeddingProvider | null = null
  private config: EmbeddingProviderConfig
  private initError: string | null = null

  constructor() {
    this.config = loadConfig()
  }

  getConfig(): EmbeddingProviderConfig {
    return this.config
  }

  isConfigured(): boolean {
    return isLiteRtInstalled() && !semanticCpuUnsupported()
  }

  getInitError(): string | null {
    return this.initError
  }

  async init(): Promise<void> {
    if (semanticCpuUnsupported()) {
      this.initError = t.model.cpuUnsupported
      return
    }
    if (!this.isConfigured()) {
      this.initError = 'LiteRT runtime or EmbeddingGemma 2 model missing — run `npm run models:download`'
      return
    }

    try {
      if (!this.provider) {
        this.provider = this.createProvider()
      }
      await this.provider.init()
      this.initError = null
      console.log(`Embedding service initialized with provider: ${this.config.type}`)
    } catch (error) {
      if (diagnoseEngineFailure(error)) {
        // Windows 老 CPU（没有 AVX）：换成「CPU 不支持」的完整解释，丢掉 provider，后续不再重试
        this.initError = t.model.cpuUnsupported
        await this.provider?.dispose().catch(() => {})
        this.provider = null
      } else {
        this.initError = String(error)
      }
      console.error('Embedding service init failed:', error)
    }
  }

  private createProvider(): EmbeddingProvider {
    const transport = getInferenceTransport()
    return transport ? new RemoteEmbeddingProvider(transport, this.config) : new LiteRtEmbeddingProvider(this.config)
  }

  /** 实际在用的推理后端（gpu / cpu），设置页展示用 */
  getActiveBackend(): string | null {
    if (!this.provider?.isReady()) return null
    return (this.provider as unknown as { activeBackend?: string | null }).activeBackend ?? null
  }

  async encode(input: EmbeddingInput): Promise<Float32Array> {
    await this.ensureInitialized()
    if (!this.provider) {
      throw new Error(this.initError || 'Embedding service not available')
    }
    return this.provider.encode(input)
  }

  async encodeText(text: string): Promise<Float32Array> {
    return this.encode({ type: 'text', content: text })
  }

  async encodeImage(imageBuffer: Buffer): Promise<Float32Array> {
    return this.encode({ type: 'image', content: imageBuffer })
  }

  /** mono 16kHz Float32Array（见 src/core/audio/extract.ts） */
  async encodeAudio(samples: Float32Array): Promise<Float32Array> {
    return this.encode({ type: 'audio', samples })
  }

  /** 帧序列 → 单个片段向量。processor 最多取 32 帧（超出均匀降采样）。 */
  async encodeVideo(frames: Buffer[], durationSec: number): Promise<Float32Array> {
    return this.encode({ type: 'video', frames, durationSec })
  }

  /** 调整推理后端偏好。写盘并重建 provider（下次 encode 时懒加载）。 */
  setConfig(patch: { backend?: LiteRtProviderConfig['backend'] }): void {
    if (patch.backend) this.config = { ...this.config, backend: patch.backend }
    saveConfig(this.config)
    this.initError = null
    if (this.provider) {
      this.provider.dispose()
      this.provider = null
    }
  }

  async encodeBatch(inputs: EmbeddingInput[]): Promise<Float32Array[]> {
    await this.ensureInitialized()
    if (!this.provider) {
      throw new Error(this.initError || 'Embedding service not available')
    }
    return this.provider.encodeBatch(inputs)
  }

  getDimension(): number {
    return this.provider?.getDimension() ?? 768
  }

  isReady(): boolean {
    return this.provider?.isReady() ?? false
  }

  async dispose(): Promise<void> {
    if (this.provider) {
      await this.provider.dispose()
      this.provider = null
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.provider && this.isConfigured()) {
      await this.init()
    }
  }
}

let embeddingService: EmbeddingService | null = null

export function getEmbeddingService(): EmbeddingService {
  if (!embeddingService) {
    embeddingService = new EmbeddingService()
  }
  return embeddingService
}
