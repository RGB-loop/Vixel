<div align="center">

<img src="build/icon.png" width="96" alt="Vixel" />

# Vixel

**Find the moment in your photos and videos by describing it.**
Local AI search for photos, videos and audio. Fully offline, no account, nothing uploaded.

[中文](README.md) · English

</div>

<p align="center"><img src="docs/media/hero.gif" width="860" alt="Vixel semantic search demo" /></p>

> The interface is available in English and Simplified Chinese (follows your system language; change it in *Settings → General*). Search works in English, Chinese and 100+ other languages.

## What it does

- **Natural-language search across photos, video and audio.** One model, EmbeddingGemma 2, puts text, images, video segments and audio into the same multilingual vector space. "Dog barking on the beach" matches what is *seen* and what is *heard*.
- **Jump to the moment in a video.** Videos are split into 32-second segments (frames + audio encoded together); opening a result seeks to the matching segment and highlights it on the timeline.
- **Search text inside images and video frames.** Local PaddleOCR v5 reads screenshots, receipts, signs, whiteboards. Strong on Chinese and English.
- **Search by image.** Drop or paste an image to find visually similar photos *and* the video moments it appears in; add words next to the image to narrow it down.
- **Offline auto tags.** Up to three tags per photo or video from a built-in ~150-label vocabulary (English + Chinese), matched against the embeddings Vixel already has — no extra model, no network. Auto tags are marked ✦; keep or remove each with one click.
- **People.** Face detection and clustering, with a quality gate so only confident matches are grouped automatically; merge, rename, hide.
- **Honest results.** Semantic, OCR and filename hits are fused with RRF, and a relevance gate decides whether anything really matches. If nothing does, Vixel says so instead of padding the page.
- **Favorites, filters and smart albums.** Press F to favorite; filter by orientation, resolution, duration, person or color on top of any search; save a search + filters as a smart album that stays up to date.
- **Quick Search (global shortcut).** Press **⇧⌘Space** (Windows: Alt+Shift+Space) in any app for a Spotlight-style panel over your whole library: ↩ opens in Vixel (videos jump to the hit segment), Space for Quick Look, ⌘C copies the file itself, and results drag straight into an editor. Change the shortcut in Settings → General.
- **Clean up similar photos.** Finds burst shots, re-exports and lightly edited copies, suggests which one to keep, and hides the rest in Vixel or moves them to the Trash after you confirm.
- **Offline map, similar photos, de-duplication, HEIC / RAW, quick look, dark mode.**
- **CLI for scripts and agents:** `vixel search "sunset at the beach" --json`.
- **Links for your notes.** Right-click → Copy Link / Copy Markdown Link gives a `vixel://` deep link to paste into Obsidian, Notes or any editor; clicking it opens Vixel at that item (video/audio jumps to the timestamp). Links are addressed by content hash, so they survive re-indexing. With the Local API on you can also Copy Web Link / Copy Markdown with Thumbnail: an `http://…/open?…` link that opens on phones and in web-based notes, with an inline preview in Markdown (the NAS web UI offers the same).
- **Local API (off by default).** Settings → General → Local API serves a web UI and HTTP API for your desktop library — enable LAN access (password required) to browse it from your phone — plus a read-only MCP endpoint at `/mcp` for AI clients (see below).

<img src="docs/media/video.jpg" width="860" alt="Video segment search" />

<img src="docs/media/quickpanel.jpg" width="860" alt="Quick Search panel" />

<img src="docs/media/autotags.jpg" width="860" alt="Offline auto tags" />

## Supported formats

| Type | Extensions |
|---|---|
| Images | jpg · jpeg · png · webp · gif · bmp · tiff · avif · heic · heif |
| RAW | cr2 · cr3 · nef · arw · dng · raf · orf · rw2 |
| Design | svg · psd · psb · pdf · ai (indexed via a raster preview, format badge in the grid) |
| Video | mp4 · mov · m4v · webm · mkv · avi |
| Audio | mp3 · m4a · aac · wav · flac · ogg · opus |

PSD/PSB are read from the file's merged composite (Photoshop's "Maximize Compatibility", on by default);
AI files must be saved with "Create PDF Compatible File" (Illustrator's default). PDF and AI render via
the system on macOS and via the bundled pdf.js on Windows/Linux — fully offline, nothing to install.
EPS is unsupported everywhere (macOS removed PostScript decoding; elsewhere it would require Ghostscript).

## Compared with

| | Vixel | Eagle | Immich | Apple Photos |
|---|---|---|---|---|
| Price | Free, open source (MIT) | Paid (lifetime license) | Free, open source | Built in |
| How it works | Desktop app, indexes your existing folders in place | Desktop app, imports files into its own library | Self-hosted server (Docker) | Manages the Photos library only |
| Platforms | macOS · Windows | macOS · Windows | Server + web / mobile | Apple devices |
| Offline natural-language search | ✅ images · video segments · audio | ✅ images only (AI Search plugin) | ✅ on your server | ✅ |
| Text-in-image search | ✅ local OCR, incl. video frames | Plugin using a Google API | ✅ | ✅ |
| People | ✅ | — | ✅ | ✅ |

## Privacy

- **Offline, no exceptions.** All models ship inside the app and run on your machine; there is no first-run download. The basemap is bundled ([Natural Earth](https://www.naturalearthdata.com/)). Every network request from the UI is blocked in code.
- No account, no telemetry, no cloud. Original files are read-only; the index lives in the app's data folder.
- **Two notes about collecting** (since v0.4):
  - When you **drag an image from a browser** into Vixel and the drag carries only a URL (no image data), the main process downloads that one URL, once, at the moment you drop it (size/type limits and a timeout; the source is recorded under "Source"). This user-initiated, one-off fetch is the app's only outbound request; the UI's network allowlist stays empty.
  - The browser extension's local server is **off by default**; when enabled it listens on `127.0.0.1` only, requires a random pairing token, and **never makes outbound requests** — the extension fetches the image in the browser and hands Vixel the bytes.

## Download

[**Latest release**](https://github.com/RGB-loop/Vixel/releases/latest): macOS (Apple Silicon) `.dmg` and Windows (x64) `.exe`. Models are included (~600 MB).

The builds are not signed by Apple / Microsoft yet:

- **macOS:** if the first launch is blocked, open *System Settings → Privacy & Security* and click *Open Anyway*, or run `xattr -dr com.apple.quarantine /Applications/Vixel.app`.
- **Windows:** on the SmartScreen prompt, click *More info → Run anyway*.

GPU inference uses Metal on macOS and Direct3D 12 on Windows, falling back to CPU.

## Server / NAS edition (Docker)

The same indexing and search, self-hosted on your NAS or server and used from any
browser (phone or desktop). `linux/amd64` + `linux/arm64`, works with Synology
Container Manager. Models are baked into the image — zero outbound requests at
runtime; photo folders are mounted read-only and never modified.

```bash
docker run -d -p 8080:8080 \
  -e VIXEL_PASSWORD='your-password' \
  -v /path/to/photos:/photos:ro \
  -v vixel-data:/data \
  ghcr.io/rgb-loop/vixel:latest
```

**Which Synology / NAS models are supported**: semantic search (describe a photo, video
moment or sound; search by image) needs a recent CPU.

| | Fully supported | No semantic search |
|---|---|---|
| Synology x86 | AMD Ryzen models: DS923+, DS723+, DS1522+, DS1621+, … | Celeron J4125 / J4025 / J3455 models: DS224+, DS423+, DS920+, DS720+, DS420+, DS220+, DS918+, DS718+ |
| Synology ARM | RTD1619B models: DS223j, DS223, DS124 | RTD1296 models: DS218, DS418, DS220j, DS118 |
| Other | NAS / servers with Intel N100 / N305, Core, Xeon, AMD Ryzen; Raspberry Pi 5 | Celeron / Atom without AVX, e.g. N5105 / N5095 |

On the unsupported models Vixel still installs and runs: text-in-image (OCR), faces,
filenames, tags, filters, map and favorites all work, and the UI says semantic search is
unavailable. To check, run `grep -o -w avx /proc/cpuinfo | head -1` on the NAS — any output
means full support (ARM: `grep -o asimddp /proc/cpuinfo`).

Full deployment guide (compose, Synology walkthrough, permissions, reverse proxy / HTTPS,
backup, limitations): [docs/server/README.md](docs/server/README.md).

## MCP (let AI clients query your library)

`vixel mcp` runs a **stdio MCP server** with read-only tools (`search_media` / `get_media` /
`find_similar`), so Claude Desktop, Cursor or Claude Code can search your library **without
any network service**. Results include `vixel://` deep links that open the item in the app
(videos jump to the matched timestamp). It needs a source checkout (`npm install &&
npm run build:cli`; models inside an installed Vixel.app are found automatically):

```json
{
  "mcpServers": {
    "vixel": {
      "command": "/absolute/path/Vixel/node_modules/.bin/electron",
      "args": ["/absolute/path/Vixel/dist/cli/cli/index.js", "mcp"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

> Why Electron as the runtime: the repo's better-sqlite3 is compiled for Electron's ABI;
> with `ELECTRON_RUN_AS_NODE=1` Electron behaves as plain Node and opens no window.

No source checkout? The desktop app's Settings → General → **Local API** exposes the same
tools over Streamable HTTP at `http://127.0.0.1:41721/mcp` (bearer token shown in Settings);
the server edition enables it with `VIXEL_MCP_TOKEN` (see [docs/server/README.md](docs/server/README.md)).

## Build from source

Node.js 20+.

```bash
npm install
npm run models:download   # EmbeddingGemma 2 (LiteRT) + LiteRT runtime + PaddleOCR, ~500 MB, once
npm run dev
npm run build && npm run package   # installers in release/
```

## How it works

| | |
|---|---|
| Embeddings | EmbeddingGemma 2 (768-d) via [LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM), C API called through koffi, in a separate low-priority process |
| Vector search | sqlite-vec `vec0` (images, media segments, faces) |
| Text search | PaddleOCR v5 + jieba + SQLite FTS5 |
| Fusion | image vectors + segment vectors + OCR + filename, Reciprocal Rank Fusion, adaptive relevance gate |
| Faces | SCRFD detection → alignment → MobileFaceNet → quality-gated clustering |
| App | Electron, React, Tailwind, better-sqlite3, sharp, ffmpeg |

More detail (in Chinese): [Vixel_Tech.md](Vixel_Tech.md), [docs/review/](docs/review/).

## License

[MIT](LICENSE). Sample photos in the screenshots are from [Immich test-assets](https://github.com/immich-app/test-assets) (public domain).
