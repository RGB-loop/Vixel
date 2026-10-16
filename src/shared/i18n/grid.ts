/** 网格、卡片、播放器、片段时间轴、快速查看 */
const zh = {
  gridLabel: '内容网格',
  matchText: '图中文字',
  matchFilename: '文件名',
  moreActions: '更多操作',
  cannotPlay: '此格式无法在应用内播放',
  openInSystemPlayer: '在系统播放器中打开',
  playerHint: 'Space 播放/暂停 · J / L 后退/前进 10 秒 · M 静音',
  segments: (n: number) => `${n} 个片段`,
  hit: (range: string) => ` · 命中 ${range}`,
  weakerMatches: (n: number) => `较弱的匹配 (${n})`,
  weakerMatchesHide: '收起较弱的匹配',
  quickLookLabel: (name: string) => `快速查看 ${name}`,
  quickLookHint: 'Space 关闭 · ↩ 打开 · 方向键切换',
}

const en: typeof zh = {
  gridLabel: 'Content grid',
  matchText: 'Text in image',
  matchFilename: 'Filename',
  moreActions: 'More Actions',
  cannotPlay: 'This format can’t be played in Vixel',
  openInSystemPlayer: 'Open in System Player',
  playerHint: 'Space play/pause · J / L back/forward 10 s · M mute',
  segments: (n) => `${n} ${n === 1 ? 'segment' : 'segments'}`,
  hit: (range) => ` · match ${range}`,
  weakerMatches: (n) => `Weaker matches (${n})`,
  weakerMatchesHide: 'Hide weaker matches',
  quickLookLabel: (name) => `Quick Look ${name}`,
  quickLookHint: 'Space close · ↩ open · arrow keys to browse',
}

export default { zh, en }
