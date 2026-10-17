<div align="center">

<img src="build/icon.png" width="96" alt="Vixel" />

# Vixel

**重新认识你的照片库。**
本地 AI 照片 / 视频 / 音频搜索 —— 全程离线，数据不出设备，无需 API Key。

*AI-powered local search for photos, videos and audio. Private. Offline. No cloud.*

中文 · [English](README.en.md)

</div>

<div align="center">
<sub>演示视频 · 1080p · 真实界面录屏 · <a href="https://github.com/RGB-loop/Vixel/releases/download/v0.4.1/Vixel-0.4.1-demo-zh.mp4">中文版</a> · <a href="https://github.com/RGB-loop/Vixel/releases/download/v0.4.1/Vixel-0.4.1-demo-en.mp4">English</a></sub>
</div>

---

## 它能做什么

<p align="center"><img src="docs/media/hero.gif" width="860" alt="Vixel 语义搜索演示" /></p>

### 自然语言搜索
输入"海边的日落""宝宝第一次走路"，直接找到对应的照片和视频片段。
EmbeddingGemma 2 把文字、图片、视频、音频放进**同一个多语言向量空间**，
再和图内文字、文件名一起做四路 RRF 融合 —— 中文、英文都行。
库里没有把握的东西，它会直说，而不是硬凑一屏结果。

<img src="docs/media/search.jpg" width="860" alt="语义搜索" />

### 连图片里的文字也能搜
本地 PaddleOCR v5 识别截图、票据、海报、路牌里的文字，结巴分词 + SQLite FTS5 全文检索。
搜"2024 财报"，即使那张截图从没被命名过也能找到。

<img src="docs/media/ocr.jpg" width="860" alt="OCR 图内文字搜索" />

### 任何应用里，一个快捷键
全局快捷键 **⇧⌘Space**（Windows：Alt+Shift+Space）呼出 Spotlight 式快速搜索面板，搜整个库：
↩ 在 Vixel 中打开（视频 / 音频直接跳到命中片段），Space 快速查看，⌘C 把**文件本身**拷进剪贴板，
结果也可以直接拖进剪辑软件的时间轴。快捷键在 设置 → 通用 里修改。

<img src="docs/media/quickpanel.jpg" width="860" alt="快速搜索面板" />

### 自动标签 · 以图搜图 · 颜色
照片和视频会在本地获得至多三个**自动标签**（内置约 150 个中英文标签，✦ 标出，✓ 保留、× 移除，
不用模型下载、不联网）；把一张图拖进搜索框或 ⌘V 粘贴，**以图搜图**找相似照片、也找它出现过的
视频片段；筛选栏里还能按**颜色**筛，和搜索随意叠加。

<img src="docs/media/autotags.jpg" width="860" alt="离线自动标签" />

### 视频：直接跳到那一刻
每个视频按 32 秒切段，每段的画面（每 4 秒 1 帧）和声音一起编码成一个向量；
画面里出现过的文字（招牌、字幕、白板）也会被识别。
搜"沙滩上狗在叫"，命中的是**听到的**和**看到的**；打开详情自动跳到命中的那一段，
时间轴上高亮显示。网格里悬停即可拖动预览。

<img src="docs/media/video.jpg" width="860" alt="视频片段搜索" />

### 音频可搜 · 悬停即览
mp3 / m4a / wav / flac 等独立音频文件同样按段进入向量空间；封面缺失时自动生成波形图。


### 按人物浏览
SCRFD 人脸检测 + MobileFaceNet 512 维特征 + sqlite-vec 近邻索引。
按人脸质量（大小 / 角度 / 清晰度）把关，只在很确定时自动归入，其余批量聚类；
双击命名、拖拽合并、"是同一个人吗？"合并建议、"不是此人"、隐藏路人。


### 明暗随心 · 进度可见
浅色 / 深色 / 跟随系统；状态栏点开任务抽屉，看当前正在处理的文件、每段进度、
预计剩余时间，失败任务可一键重试。索引在独立的低优先级进程里跑，界面始终跟手。

<img src="docs/media/themes.jpg" width="860" alt="浅色与深色主题" />

### 离线地图
带 GPS 的照片落在地图上，大量照片自动聚合。底图随应用打包，打开地图也不发任何网络请求。

<img src="docs/media/map.jpg" width="860" alt="离线地图" />

> 以上均为真实界面截图与录屏。示例照片和视频来自 [Immich test-assets](https://github.com/immich-app/test-assets)（公有领域）。

### 还有

- **收藏 · 筛选 · 智能相册** —— F 键收藏；按方向、分辨率、时长、人物、颜色筛选，可和搜索叠加；把"搜索 + 筛选"存成侧栏里自动更新的智能相册。
- **设计文件** —— SVG / PSD / PDF / AI 按栅格预览索引（缩略图、语义搜索、OCR），网格有格式角标；Windows 上 AI / PDF 用内置 pdf.js 渲染，无需装任何东西。
- **清理相似照片** —— 找出连拍、重复导出、轻度编辑过的副本，推荐保留哪张；多余的可在 Vixel 里隐藏，或确认后移到废纸篓。
- **相似照片** —— 任意照片一键找视觉相近的。
- **去重** —— xxHash64 内容哈希，同一张照片在多个文件夹里只算一次、只索引一次。
- **HEIC / RAW** —— macOS 上通过系统 `sips` 解码 CR2 / CR3 / NEF / ARW / DNG / RAF / ORF / RW2，保留 EXIF。
- **快速查看** —— 空格预览，⌘1–5 切换 全部 / 图片 / 视频 / 音频 / 地图。
- **命令行** —— `vixel search "海边" --json`，方便脚本和 Agent 调用（见下文）；结果里的 `matchedBy` 说明是画面、图中文字还是文件名命中。
- **链接进笔记** —— 右键「拷贝链接 / 拷贝 Markdown 链接」得到 `vixel://` 深链接，贴进 Obsidian、备忘录等任意笔记，点击回到 Vixel 定位到那一项（视频 / 音频直接跳到时间点）。链接按内容哈希定位，清库重建、移动文件后仍然有效。
- **本地接口（默认关闭）** —— 设置 → 通用 → 本地接口：在本机开出网页界面和 HTTP API，手机浏览器也能访问桌面的资料库（局域网访问必须设口令）；同一服务的 `/mcp` 是给 AI 客户端的只读 MCP 接口（见下文）。
- **中英文界面** —— 跟随系统语言，也可在 设置 → 通用 里切换。
- **诊断** —— `vixel doctor` / `vixel bench` 体检和测速，`VIXEL_PROFILE=1` 打印慢操作，见 [docs/debugging.md](docs/debugging.md)。

## 和同类工具比

| | Vixel | Eagle | Immich | Apple 照片 |
|---|---|---|---|---|
| 价格 | 免费开源（MIT） | 付费（终身授权） | 免费开源 | 系统自带 |
| 怎么用 | 桌面应用，直接索引你现有的文件夹 | 桌面应用，文件导入到它的资源库 | 自建服务器（Docker） | 只管理"照片"图库 |
| 平台 | macOS · Windows | macOS · Windows | 服务器 + 网页 / 手机 | 苹果设备 |
| 离线自然语言搜索 | ✅ 图片 · 视频片段 · 音频 | ✅ 仅图片（AI Search 插件） | ✅ 在你的服务器上 | ✅ |
| 图中文字搜索 | ✅ 本地 OCR，含视频画面 | 插件，调用 Google 接口 | ✅ | ✅ |
| 人物 | ✅ | — | ✅ | ✅ |

## 隐私

- **完全离线，没有例外**：所有模型随应用分发，在本机运行；没有账号、没有遥测、没有云端。
  地图用随应用打包的离线底图（[Natural Earth](https://www.naturalearthdata.com/)，公有领域），
  渲染进程的一切网络请求都会被拦截。
- 照片原文件只读不写；索引、缩略图都存在本机的应用数据目录里。
- **收集箱的两个说明**（v0.4 起）：
  - 从浏览器把图片**拖进** Vixel 时，如果拖动里只有图片地址（没有图片数据），主进程会**只为这一个地址、
    只在你松手的这一刻**下载一次（限大小、类型和超时，并把来源记在「来源」里）。这是整个应用唯一的
    主动联网场景，由你的显式拖放触发；界面（渲染进程）的网络白名单仍然为空。
  - 浏览器扩展用的本地收集服务**默认关闭**，开启后也只监听 `127.0.0.1`、要求随机配对令牌，
    **从不发起任何对外请求**——图片由扩展在浏览器里取好，把字节交给 Vixel。

## 下载

[**下载最新版**](https://github.com/RGB-loop/Vixel/releases/latest)：macOS（Apple Silicon）`.dmg` · Windows（x64）`.exe`，模型已内置（约 600 MB），装好即可离线使用。

安装包暂未经过 Apple / 微软签名：

- **macOS**：第一次打开被拦截时，到 **系统设置 → 隐私与安全性** 点「仍要打开」；或在终端执行 `xattr -dr com.apple.quarantine /Applications/Vixel.app`。
- **Windows**：SmartScreen 提示“已保护你的电脑”时，点「更多信息 → 仍要运行」。

语义模型默认用 GPU（macOS 上是 Metal，Windows 上是 Direct3D 12），没有可用 GPU 时自动退回 CPU。

## 服务器 / NAS 版（Docker）

同一套索引和搜索跑在你自己的 NAS / 服务器上，手机和电脑浏览器直接访问（支持
`linux/amd64` 和 `linux/arm64`，群晖 Container Manager 可用）。模型内置在镜像里，
运行时零出站请求；照片目录只读挂载，永不改动原文件。

```bash
docker run -d -p 8080:8080 \
  -e VIXEL_PASSWORD='你的口令' \
  -v /path/to/photos:/photos:ro \
  -v vixel-data:/data \
  ghcr.io/rgb-loop/vixel:latest
```

**支持哪些群晖 / NAS**：语义搜索（用一句话找照片、视频片段、声音，以图搜图）需要较新的 CPU。

| | 完整支持 | 不支持语义搜索 |
|---|---|---|
| 群晖 x86 | AMD Ryzen 机型：DS923+、DS723+、DS1522+、DS1621+ 等 | Celeron J4125 / J4025 / J3455 机型：DS224+、DS423+、DS920+、DS720+、DS420+、DS220+、DS918+、DS718+ |
| 群晖 ARM | RTD1619B 机型：DS223j、DS223、DS124 | RTD1296 机型：DS218、DS418、DS220j、DS118 |
| 其他 | Intel N100 / N305、酷睿、至强、AMD 锐龙的 NAS 和服务器，树莓派 5 | N5105 / N5095 等没有 AVX 的 Celeron / Atom |

"不支持"的机器也能装：图内文字（OCR）、人脸、文件名、标签、筛选、地图、收藏照常可用，界面会说明语义搜索不可用。
拿不准就在 NAS 上执行 `grep -o -w avx /proc/cpuinfo | head -1`，有输出就是完整支持（ARM 机型看 `grep -o asimddp /proc/cpuinfo`）。

部署细节（docker compose、群晖逐步说明、权限设置、反代 HTTPS、备份、限制）见
[docs/server/README.md](docs/server/README.md)。

## 从源码运行

需要 Node.js 20+。主要在 macOS（Apple Silicon）上开发，Windows x64 已验证可用。

```bash
npm install
npm run models:download   # 下载 EmbeddingGemma 2（LiteRT）+ LiteRT 运行时 + PaddleOCR，约 500 MB（只需一次）
npm run dev               # 开发模式（开发期也会显示 Vixel 名称和图标）
```

打包：

```bash
npm run build && npm run package   # 产物在 release/
```

### 第一次使用

1. **⌘O** 或 设置 → 文件夹，添加照片文件夹。
2. 自动开始索引：缩略图 → 语义向量 → 视频 / 音频分段 → 图内文字（OCR）。点状态栏可以看进度、暂停。
3. 人物页点一次**扫描人脸**；之后新加入的照片和视频都会自动识别人物。
4. 在搜索框（**⌘F**）里用自然语言描述你要找的东西。库里确实没有相关内容时，Vixel 会如实告诉你，而不是凑满一屏。

语义模型经 [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM) 推理：默认用 GPU（macOS 上是 Metal），
不可用时自动退回 CPU；设置 → 模型 里可以固定为 GPU 或 CPU。

## 支持的格式

| 类型 | 扩展名 |
|---|---|
| 图片 | jpg · jpeg · png · webp · gif · bmp · tiff · avif · heic · heif |
| RAW | cr2 · cr3 · nef · arw · dng · raf · orf · rw2 |
| 设计 | svg · psd · psb · pdf · ai（按栅格预览索引，网格有格式角标） |
| 视频 | mp4 · mov · m4v · webm · mkv · avi |
| 音频 | mp3 · m4a · aac · wav · flac · ogg · opus |

| 平台 | 常见图片 | HEIC / HEIF | RAW | 设计格式 | 视频 / 音频 |
|---|---|---|---|---|---|
| macOS | ✅ sharp | ✅ sips | ✅ sips | ✅ SVG · PSD/PSB · PDF · AI（sips） | ✅ ffmpeg |
| Linux / Windows | ✅ sharp | ✅ heic-convert | ✅ 相机内嵌预览 | ✅ SVG · PSD/PSB · PDF · AI（内置 pdf.js） | ✅ ffmpeg |

PSD/PSB 读取文件内的合并合成图（Photoshop 默认开启"最大兼容"）；AI 需要以"创建 PDF 兼容文件"保存
（Illustrator 默认开启）。PDF / AI 在 Windows / Linux 上由内置的 pdf.js 离线渲染，无需安装任何东西。
EPS 不支持（macOS 已移除 PostScript 解码，其它平台需要用户自装 Ghostscript）。

内置播放器播不了的编码（如部分 mkv / avi）会提示用系统播放器打开，搜索和索引不受影响。

## 工作原理

```
┌───────────────────────────────┐  postMessage   ┌──────────────────────────────────┐
│ Main 进程                      │ ─────────────► │ 推理进程（utilityProcess, nice 10）│
│ SQLite + sqlite-vec + FTS5    │ ◄───────────── │ EmbeddingGemma 2 · LiteRT（GPU）   │
│ 文件监听 (chokidar)            │                │ SCRFD + MobileFaceNet  人脸        │
│ 索引队列 · 四路 RRF 搜索        │                │ PaddleOCR v5  图内文字             │
│ vixel:// 协议（缩略图 / 流媒体） │                └──────────────────────────────────┘
└──────────────┬────────────────┘
               │ spawn                    ffmpeg-static：抽帧 / 音轨 / 封面 / 悬停预览图
               │ contextBridge
┌──────────────▼────────────────┐
│ Renderer (React + Tailwind)   │  网格 · 详情 · 人物 · 地图 · 任务抽屉 · 设置
└───────────────────────────────┘
```

| 能力 | 方案 |
|---|---|
| 多模态向量 | EmbeddingGemma 2（768 维，LiteRT-LM，GPU：Metal / WebGPU，经 koffi 调用 C API） |
| 向量检索 | sqlite-vec `vec0`：图片 768d · 媒体片段 768d · 人脸 512d |
| 文字检索 | PaddleOCR v5 + @node-rs/jieba（SQLite UDF）+ FTS5 BM25 |
| 融合 | 图片向量 + 媒体片段向量 + OCR + 文件名，Reciprocal Rank Fusion |
| 人脸 | SCRFD-2.5G-KPS 检测 → 五点对齐 → MobileFaceNet → 质量门控聚类 |
| 图像 | sharp (libvips) + macOS `sips` 兜底 |

数据位置（macOS）：

```
~/Library/Application Support/vixel/
├── library.db            # SQLite (WAL)：照片、向量、OCR、人脸、人物、任务队列
├── thumbnails/           # 按内容哈希共享的缩略图
├── video_frames/         # 视频代表帧、音频封面 / 波形、悬停预览图
└── backups/              # 每日自动备份，保留 3 份
```

更多设计细节见 [Vixel_Tech.md](Vixel_Tech.md)，产品需求见 [Vixel_PRD.md](Vixel_PRD.md)。

## 命令行

```bash
npm run cli -- search "海边的日落" --limit 10 --json
npm run cli -- similar 42
npm run cli -- people
npm run cli -- stats
```

支持 `search` · `info` · `similar` · `people` · `stats` · `caption` · `folders` · `mcp`，
`--json` 输出便于脚本和 AI Agent 调用。需要先运行一次应用以创建照片库。

### MCP（让 AI 客户端查你的库）

`vixel mcp` 把同一套查询变成 **stdio 形态的 MCP 服务器**（工具全部只读：`search_media` /
`get_media` / `find_similar`），Claude Desktop、Cursor、Claude Code 等本地 AI 客户端
**不开任何网络服务**就能搜你的库；结果里的 `vixel://` 链接点开直接回到应用并定位（视频跳到时间点）。
需要源码仓库（`npm install && npm run build:cli`；已安装的 Vixel.app 里的语义模型会被自动找到），
客户端里这样配置（Claude Desktop 的 `claude_desktop_config.json`、Cursor 的 `mcp.json` 同形）：

```json
{
  "mcpServers": {
    "vixel": {
      "command": "/绝对路径/Vixel/node_modules/.bin/electron",
      "args": ["/绝对路径/Vixel/dist/cli/cli/index.js", "mcp"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

> 为什么用 Electron 当运行时：仓库的 better-sqlite3 按 Electron 的 ABI 构建，普通 `node` 加载不了；
> `ELECTRON_RUN_AS_NODE=1` 下 Electron 就是一个纯 Node，不会弹窗口。

不想碰源码：桌面应用 设置 → 通用 → **本地接口** 打开后，同样的工具在 `http://127.0.0.1:41721/mcp`
（Streamable HTTP + Bearer 令牌，设置页里拷贝）；服务器版设 `VIXEL_MCP_TOKEN` 同理，
见 [docs/server/README.md](docs/server/README.md)。

## 开发

```
src/
├── main/            # Electron 主进程：IPC、菜单、vixel:// 协议、推理进程入口
├── preload/         # contextBridge API
├── shared/          # main / renderer 共享类型
├── core/            # 与 UI 无关的核心：db · watcher · indexer · search · fusion
│   ├── embedding/   #   EmbeddingGemma 2（本地 / 转发到推理进程）
│   ├── inference/   #   推理进程转发协议
│   ├── face/        #   检测 · 对齐 · 特征 · 质量 · 聚类
│   ├── ocr/         #   PaddleOCR det / cls / rec
│   ├── video/ audio/ media/ image/ text/
├── renderer/src/    # React UI：shell · media · tasks · settings · inspector …
└── cli/             # vixel 命令行
```

```bash
npm test                              # vitest 单元测试
npx tsc --noEmit -p tsconfig.web.json # 类型检查（renderer）
npx tsc --noEmit -p tsconfig.node.json
```

欢迎贡献，见 [CONTRIBUTING.md](CONTRIBUTING.md)；变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可

[MIT](LICENSE)。
