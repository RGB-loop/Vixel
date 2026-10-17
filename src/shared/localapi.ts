/** 本地接口（设置 › 通用）：主进程 ↔ 渲染进程共用的类型和 IPC 通道（桌面专属） */

export const LOCALAPI_CHANNELS = {
  STATUS: 'localapi:status',
  SET: 'localapi:set',
  NEW_TOKEN: 'localapi:new-token',
} as const

/** 默认端口：紧挨浏览器扩展收集服务（41720），同样取自动态端口段之外 */
export const DEFAULT_LOCALAPI_PORT = 41721

export interface LocalApiStatus {
  enabled: boolean
  running: boolean
  port: number
  /** 允许局域网访问（绑定 0.0.0.0）；开着时必须有口令 */
  lan: boolean
  /** 已设置口令（口令本身不回传渲染进程） */
  hasPassword: boolean
  /** /mcp 的 bearer 令牌（设置页显示 / 拷贝 / 重新生成） */
  mcpToken: string
  /** 正在监听时的可访问地址；lan 开着时包含各网卡的局域网地址 */
  urls: string[]
  /** 启动 / 配置失败：'port-in-use' | 'password-required'，其他为原始错误信息 */
  error: string | null
}

export interface LocalApiPatch {
  enabled?: boolean
  port?: number
  lan?: boolean
  /** 设置 / 修改口令（≥ 4 位；空串 = 清除，局域网开着时会被拒绝） */
  password?: string
}
