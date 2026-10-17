/** 设置 › 通用 › 本地接口（HTTP API + 网页界面 + MCP；桌面专属） */
const zh = {
  sectionTitle: '本地接口',
  enable: '启用本地接口',
  stateRunning: (port: number) => `运行中 · 端口 ${port}`,
  stateStopped: '已停止',
  note: '在本机开一个 HTTP 接口和网页界面：浏览器里浏览和搜索整个资料库，脚本与 AI 客户端通过 /mcp 查询。该服务只接受连接，从不对外发起任何请求。',
  addresses: '访问地址',
  port: '端口',
  lan: '允许局域网访问',
  lanNote: '同一网络里的手机 / 电脑可以用上面的地址访问；开启后所有访问（包括本机浏览器）都需要口令登录。',
  passwordLabel: '访问口令',
  passwordPlaceholder: '至少 4 位',
  passwordSet: '已设置',
  passwordRequired: '先设置访问口令，再开启局域网访问。',
  portInUse: (port: number) => `端口 ${port} 被占用，换一个试试`,
  startError: (msg: string) => `启动失败：${msg}`,
  mcpEndpoint: 'MCP 地址',
  mcpToken: 'MCP 令牌',
  mcpNote: '在 AI 客户端（Claude Desktop、Cursor 等）里添加上面的 MCP 地址，鉴权用 Bearer 令牌。工具只读；搜索结果（文件名、路径、识别出的文字等）会发送给你连接的那个 AI 客户端。',
}

const en: typeof zh = {
  sectionTitle: 'Local API',
  enable: 'Enable local API',
  stateRunning: (port) => `Running · port ${port}`,
  stateStopped: 'Stopped',
  note: 'Serves an HTTP API and web UI on this machine: browse and search the whole library from a browser, and let scripts or AI clients query it via /mcp. The service only accepts connections and never makes outbound requests.',
  addresses: 'Addresses',
  port: 'Port',
  lan: 'Allow LAN access',
  lanNote: 'Phones and computers on the same network can use the addresses above; once enabled, every visit (including this machine) requires the password.',
  passwordLabel: 'Password',
  passwordPlaceholder: 'At least 4 characters',
  passwordSet: 'Set',
  passwordRequired: 'Set a password before allowing LAN access.',
  portInUse: (port) => `Port ${port} is in use — try another`,
  startError: (msg) => `Failed to start: ${msg}`,
  mcpEndpoint: 'MCP endpoint',
  mcpToken: 'MCP token',
  mcpNote: 'Add the MCP endpoint above to an AI client (Claude Desktop, Cursor, …) with the bearer token for auth. Tools are read-only; search results (file names, paths, recognized text, …) are sent to whichever AI client you connect.',
}

export default { zh, en }
