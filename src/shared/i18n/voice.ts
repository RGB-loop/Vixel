/** 语音搜索输入（搜索框麦克风，macOS 桌面版；SearchBar / lib/voiceCapture.ts） */
const zh = {
  micTitle: '语音搜索',
  // 录音中：按钮 title + 输入框占位
  stopTitle: '停止并转写（Esc 取消）',
  listening: '正在听…',
  transcribing: '正在转写…',
  permissionDenied: '没有麦克风权限：到 系统设置 → 隐私与安全性 → 麦克风 里允许 Vixel 后重试。',
  assetMissing: '这个语言的系统语音模型还没下载：到 系统设置 → 键盘 → 听写 启用后即可用（转写全程在本机进行）。',
  noSpeech: '没有听到语音，再试一次。',
  failed: '转写失败，再试一次。',
}

const en: typeof zh = {
  micTitle: 'Voice search',
  stopTitle: 'Stop and transcribe (Esc to cancel)',
  listening: 'Listening…',
  transcribing: 'Transcribing…',
  permissionDenied: 'No microphone access: allow Vixel under System Settings → Privacy & Security → Microphone, then try again.',
  assetMissing: 'The system speech model for this language is not downloaded yet: enable it under System Settings → Keyboard → Dictation (transcription runs entirely on this Mac).',
  noSpeech: 'No speech detected — try again.',
  failed: 'Transcription failed — try again.',
}

export default { zh, en }
