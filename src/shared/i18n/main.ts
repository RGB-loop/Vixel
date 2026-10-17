/** 主进程：窗口标题、对话框、IPC 返回给界面的错误（src/main/*.ts） */
const zh = {
  settingsTitle: '设置',
  videoMissing: '视频文件已不存在',
  startupFailedTitle: 'Vixel 无法启动',
  startupFailedDetail: (msg: string, dataDir: string) => `${msg}\n\n数据目录：${dataDir}`,
  // 深链接（vixel://open?…）指向的内容不在库里
  deepLinkMissingTitle: '链接指向的内容不在媒体库中',
  deepLinkMissingDetail: '它可能已被移除，或这个链接来自另一个媒体库。',
}

const en: typeof zh = {
  settingsTitle: 'Settings',
  videoMissing: 'The video file no longer exists',
  startupFailedTitle: 'Vixel could not start',
  startupFailedDetail: (msg, dataDir) => `${msg}\n\nData folder: ${dataDir}`,
  deepLinkMissingTitle: 'The linked item is not in this library',
  deepLinkMissingDetail: 'It may have been removed, or the link points to a different library.',
}

export default { zh, en }
