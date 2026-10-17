// vixel-speech —— macOS 系统级离线听写辅助程序（语音搜索输入用，见 src/main/voice.ts）。
//
// 用 macOS 26+ 的 SpeechAnalyzer / SpeechTranscriber 做"文件 → 文字"：模型是系统组件、
// 全程在本机运行（与系统听写共享语音模型资产），文件输入不需要语音识别授权弹窗
// （麦克风权限由 Electron 侧 getUserMedia 走，与本程序无关）。不自动下载语音模型 ——
// 应用承诺零出站请求，模型缺失时按 asset-missing 退出，由界面指引用户去系统设置下载。
//
// 用法：
//   vixel-speech check <locale>             → stdout: installed | downloadable | unsupported
//   vixel-speech transcribe <locale> <wav>  → stdout: 识别出的文字（可为空 = 没听到语音）
// 退出码：0 成功 · 2 失败 · 3 语音模型未安装 · 4 系统太旧 / 语言不支持
//
// 构建：scripts/build-speech-helper.mjs（swiftc，产物 resources/speech/vixel-speech，不进 git）
import Foundation
import Speech
import AVFoundation

func die(_ code: Int32, _ msg: String) -> Never {
  FileHandle.standardError.write(("vixel-speech: " + msg + "\n").data(using: .utf8)!)
  exit(code)
}

let args = CommandLine.arguments
guard args.count >= 3 else { die(2, "usage: vixel-speech check <locale> | transcribe <locale> <wav>") }
let command = args[1]
let localeId = args[2]

guard #available(macOS 26, *) else { die(4, "SpeechAnalyzer needs macOS 26+") }

@available(macOS 26, *)
func run() async {
  let locale = Locale(identifier: localeId)
  let sameLocale = { (l: Locale) in l.identifier(.bcp47) == locale.identifier(.bcp47) }
  let supported = await SpeechTranscriber.supportedLocales.contains(where: sameLocale)
  let installed = await SpeechTranscriber.installedLocales.contains(where: sameLocale)

  if command == "check" {
    print(!supported ? "unsupported" : installed ? "installed" : "downloadable")
    exit(0)
  }
  guard command == "transcribe", args.count >= 4 else { die(2, "usage: vixel-speech transcribe <locale> <wav>") }
  if !supported { die(4, "locale \(localeId) not supported") }
  if !installed { die(3, "speech model for \(localeId) not installed") }

  do {
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [])
    let analyzer = SpeechAnalyzer(modules: [transcriber])
    let file = try AVAudioFile(forReading: URL(fileURLWithPath: args[3]))
    // 结果流和分析并发收集：finalizeAndFinish 之后流才会结束
    async let text: String = {
      var out = ""
      for try await r in transcriber.results where r.isFinal {
        out += String(r.text.characters)
      }
      return out
    }()
    if let last = try await analyzer.analyzeSequence(from: file) {
      try await analyzer.finalizeAndFinish(through: last)
    } else {
      await analyzer.cancelAndFinishNow()
    }
    print(try await text.trimmingCharacters(in: .whitespacesAndNewlines))
    exit(0)
  } catch {
    die(2, "transcribe failed: \(error.localizedDescription)")
  }
}

let task = Task { await run() }
// run() 内部必定 exit；这里只是给异步任务留运行机会（60s 是兜底，主进程侧另有超时）
RunLoop.main.run(until: Date(timeIntervalSinceNow: 60))
die(2, "timeout")
