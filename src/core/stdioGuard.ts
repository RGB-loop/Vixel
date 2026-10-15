/**
 * stdout / stderr 的读端没了（从终端启动后关掉终端、输出管道给了提前退出的 head……）时，
 * 下一次 console.log 会抛 EPIPE。没人监听流的 error 事件，Node 就把它当未捕获异常 ——
 * 桌面版弹出"主进程 JavaScript 错误"对话框。日志写不出去不该影响应用本身：EPIPE 吞掉，其他错误照旧。
 */
for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EPIPE') throw err
  })
}

export {}
