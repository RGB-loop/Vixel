# Changelog

All notable changes to Vixel will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.2] - 2026-10-18

### Added
- **Deep links for your notes (`vixel://open?…`).** Right-click any item (or use the
  inspector) → Copy Link / Copy Markdown Link, paste into Obsidian / Notes / anywhere;
  clicking the link opens Vixel at that item, and video/audio jumps to the timestamp
  (`[clip.mp4 @ 0:42](vixel://…)`). Links are addressed by content hash, so they keep
  working after re-indexing or moving files. The `vixel` scheme is registered with the
  OS (macOS `open-url` incl. cold start; Windows/Linux single-instance argv hand-off).
- **Local API (Settings → General, off by default).** Runs the server edition's HTTP
  stack inside the desktop app against the same library: web UI + JSON API on
  `127.0.0.1:41721` (port configurable), optional LAN access (binds 0.0.0.0, password
  required — browse your desktop library from a phone), and a read-only MCP endpoint
  at `/mcp` (Streamable HTTP, bearer token with copy/regenerate in Settings).
- **MCP for AI clients.** Read-only tools `search_media` / `get_media` / `find_similar`
  (results carry scores, matched video time ranges, `vixel://` deep links and http media
  links). Available three ways: desktop Local API `/mcp`, server edition `/mcp`
  (enable with `VIXEL_MCP_TOKEN`), and `vixel mcp` on stdio for Claude Desktop /
  Cursor / Claude Code without any network service (setup snippet in the README).
- **Voice input in the search bar (macOS 26+).** Click the microphone (or press it again to
  stop), speak a query, and it is transcribed on-device into the search box — editable like
  any typed text — then the normal text search runs. Transcription uses the system's offline
  dictation model (SpeechAnalyzer) via a tiny helper process: nothing is recorded to disk
  beyond a temp file that is deleted right away, and no audio ever leaves the Mac (the
  browser Web Speech API, which uploads audio, is deliberately not used — so the web edition
  has no microphone). Measured on 20 synthetic short queries: Chinese CER 6.4% (errors are
  homophones), English WER 0%; voice and typed search agree on the top result 36/40 times
  on the demo libraries. If the speech model for your language is not downloaded yet, Vixel
  points you to System Settings → Keyboard → Dictation instead of downloading anything itself.
  Windows is not covered yet (no offline engine met the quality bar).

### Fixed
- **Text in images: long lines lost most of their characters** (#3). Each recognized line
  was squeezed into a 320 px wide input, so a 30–40 character line (screenshots, articles)
  came back with large gaps. Lines now get a width that matches their aspect ratio, as in
  PaddleOCR itself; the reporter's screenshot now reads line for line like their local
  PaddleOCR. Existing libraries re-run OCR automatically after updating.
- The player's segment strip said "片段 2" for a two-segment video, which read like
  "segment #2"; it now says "2 个片段".

### Decided against (for now)
- **Search by a sound clip.** Measured on the demo footage: audio queries against the joint
  frames+audio segment vectors rank the right video first only 3/12 times (the picture
  dominates the vector), and even pure audio-to-audio vectors cannot be thresholded — an
  unrelated pink-noise clip scores higher than many true matches (0.947 vs 0.917). Without a
  reliable "nothing really matches" gate the feature would return confidently wrong results,
  so it stays out; the calibration script (`scripts/audio-search-eval.cjs`) documents the
  numbers for re-evaluation with future models.

## [0.5.1] - 2026-10-15

### Fixed
- **Videos and audio failed to index in the installed apps (macOS and Windows).** The
  packaged app started ffmpeg from a path inside `app.asar`, which `spawn` can't execute
  (`spawn ENOTDIR` on macOS, `ENOENT` on Windows), so every video and audio file errored
  and had no searchable segments. ffmpeg now runs from `app.asar.unpacked`. This affected
  every desktop release since 0.2.0 (development builds and the Docker image were fine,
  which is why tests missed it); `scripts/packaged-video-check.sh` now indexes videos with
  the packaged app before each release. Thanks to the V2EX user who reported it. After
  updating, videos that failed are re-indexed automatically on the next launch.
- Launching Vixel from a terminal and then closing that terminal no longer pops up a
  "JavaScript error occurred in the main process" dialog (`write EPIPE`).

## [0.5.0] - 2026-10-15

### Added
- **Server / NAS edition (Docker).** Multi-arch image (`linux/amd64` + `linux/arm64`) running
  the same core indexing/search pipeline as the desktop app behind a password-protected web UI
  (phone + desktop browsers). Models are bundled in the image — fully offline at runtime;
  photo folders are mounted read-only. Non-root with Synology-style `PUID`/`PGID` support,
  `/healthz` healthcheck, graceful SIGTERM shutdown, `docker-compose.yml` example and a
  zh/en deployment guide in `docs/server/README.md` (Synology Container Manager walkthrough,
  reverse proxy / HTTPS, backup, limitations).
- **PDF / AI previews on the server (Linux).** Pure-Node pdf.js rasterizer
  (pdfjs-dist + @napi-rs/canvas) renders the first page for thumbnails/OCR/search —
  PDF and PDF-compatible AI files now index in the container just like on desktop.
- **HTTPS reverse-proxy support for the server session cookie**: `VIXEL_COOKIE_SECURE=1`
  always sets `Secure`; `VIXEL_TRUST_PROXY=1` sets it when `X-Forwarded-Proto` is https
  and keys the login rate limiter by `X-Forwarded-For`.
- **Low-memory mode for the server (`VIXEL_LOW_MEMORY=1`, default in the Docker image).**
  The semantic embedding model and the OCR / face models are never resident in memory at
  the same time: the inference worker swaps model groups on demand, the indexer batches
  tasks by model group so swaps happen between batches, and all models unload after a few
  idle minutes (the next search transparently reloads them). A container capped at
  `mem_limit: 2g` now completes a full index with zero failed tasks and no OOM kill
  (previously ≥ 3 GB was required); search results are identical to the resident mode. Desktop
  behaviour is unchanged (the mode is off unless the env var is set). Set
  `VIXEL_LOW_MEMORY=0` to keep models resident when the container has 4 GB+.
- **Supported NAS models documented.** Semantic search needs an x86 CPU with AVX or an
  ARMv8.2 CPU. Synology Ryzen models (DS923+ / DS723+ / DS1522+ / DS1621+), RTD1619B
  models (DS223j / DS223 / DS124), Intel N100 / N305 and newer are fully supported;
  Celeron J4125 / J4025 / J3455 models (DS224+ / DS423+ / DS920+ / DS720+ / DS420+ / DS220+ /
  DS918+ / DS718+), N5105 and RTD1296 models (DS218 / DS418 / DS220j) are not. On those, the
  server turns semantic search off up front and says so in the status bar, settings and empty
  states — text-in-image (OCR), faces, filenames, tags, filters, map and favorites keep working,
  with no crash or retry loops.

### Fixed
- **Privacy: onnxruntime telemetry is now disabled.** onnxruntime 1.30 (used for OCR and
  face models) ships Microsoft's 1DS telemetry client on macOS and Linux and opened an
  HTTPS connection to a Microsoft collector when the first OCR / face session was created.
  Every process that loads onnxruntime now sets `ORT_DISABLE_TELEMETRY=1` before any session
  exists (verified: no outbound connection). Affects all earlier macOS releases; the
  Windows build has no bundled uploader (ETW only).
- Server: auto-tag names follow the browser's language when the UI language is "system";
  silent videos no longer log an ffmpeg stack trace per segment; the image defaults to the
  CPU backend (`VIXEL_BACKEND`, no doomed WebGPU attempt and error spam on start).
- Web UI: no horizontal scrollbar under the grid with classic scrollbars (also the Windows
  desktop app); color swatches wrap on phones; videos play inline on iOS Safari; the
  battery-indexing setting is hidden on the server.
- **Synology shared-folder permissions.** DSM grants shared folders to groups (e.g.
  `administrators`); the container dropped to `PUID:PGID` without supplementary groups and
  couldn't even list the photos. Groups from compose `group_add` are now kept, the identity is
  logged at start, and an unreadable library folder is reported in the log, the status bar,
  the empty state and Settings › Folders with the fix (verified on DSM 7.2.2 / Container
  Manager / Docker 24).
- NAS system folders are skipped when scanning: Synology `@eaDir` (DSM's own thumbnails),
  `#recycle`, `#snapshot`; QNAP `@Recycle` / `@Recently-Snapshot`; Windows `$RECYCLE.BIN`.
- The status bar no longer says "Add a folder to get started" when a search simply has no
  results (desktop too).
- `scripts/download-models.mjs` extracts the LiteRT runtime wheel on Linux (GNU tar can't
  read zip; falls back to `unzip` / `python3`).

## [0.4.1] - 2026-10-13

### Added
- **System-wide Quick Search panel** (like Spotlight / Raycast). A global shortcut — default
  **⇧⌘Space** on macOS, **Alt+Shift+Space** on Windows — opens a frameless, always-on-top
  search panel on the screen the cursor is on (macOS: NSPanel with `hud` vibrancy that takes
  keys without activating the app, visible over fullscreen apps; Windows: solid frameless
  window). Type to search the whole library (same debounce, weaker-match folding and honest
  empty / low-confidence states as the main grid); results show thumbnail, file name, kind +
  duration or hit segment ("0:32–0:45"), folder and match chips (标签 / 图中文字 / 文件名),
  with a compact-grid toggle. Keyboard: ↑↓ select, **↩** opens the result in the main window
  (video/audio jump to the hit segment; the window is recreated if it was closed), **⌥↩**
  opens the file in the system default app, **Space** Quick Look (native `previewFile` on
  macOS, Vixel's built-in viewer on Windows), **⌘C** copies the *file* to the clipboard
  (macOS `NSFilenamesPboardType`, Windows `CF_FILENAMEW`; falls back to path text and says
  so), **⌘↩** reveals in Finder/Explorer, **⌘O** carries the query into the main window,
  **Esc**/blur hides. ⌘V with an image searches by image; rows drag out as native files
  (straight into an editor's timeline). *Settings → General → Quick Search* has an on/off
  toggle and a shortcut recorder that really registers the combo to validate it ("快捷键已被
  其他应用占用 / Shortcut is in use by another app" when taken). The panel window shares the
  sandbox/contextIsolation web preferences and the offline network policy. On Windows,
  closing the main window while the shortcut is enabled keeps Vixel in the system tray
  (Open Vixel / Quick Search / Quit) so the shortcut keeps working; with the shortcut
  disabled the app quits as before. File menu gains "快速搜索 / Quick Search" showing the
  current shortcut. Pure logic (shortcut recording/validation/formatting, selection
  movement, file-clipboard payloads) is unit-tested.
- **Power-aware indexing (like DigUp's).** The big backfill — first index of a large folder,
  startup catch-up, OCR/face/color/auto-tag sweeps — now waits while the machine is on battery
  (if the new *Settings → General → "Index on battery"* toggle is off; default stays on), in
  Low Power Mode / battery saver, or thermally stressed (macOS `serious`/`critical`). A handful
  of newly added files (watcher events, Inbox collects — up to 20 pending tasks) always index
  right away, so new content is searchable immediately even while the backfill waits. The
  status bar and Activity drawer show *why* ("等待接通电源 / Waiting for power", "低电量模式 /
  Low Power Mode", "Mac 温度较高 / Paused while the Mac is hot") — distinct from manual pause,
  which still overrides everything. Entirely event-driven via Electron `powerMonitor`
  (`on-battery`/`on-ac`, `thermal-state-change`, `speed-limit-change`), no polling. Per
  platform: battery state everywhere; thermal state macOS only; "low power mode" is detected
  on macOS *and* Windows through the OS-advertised CPU speed limit (≤ 60 % counts), which is
  how both macOS Low Power Mode and Windows battery saver/Power Throttling surface in Electron
  — there is no direct `isLowPowerModeEnabled` API. Decision logic is a pure module
  (`src/core/powerPolicy.ts`) with unit tests; a backfill video interrupted mid-way is
  requeued (not failed) and resumes when power is back.
- **Skip rules for the crawler** (`src/core/skipRules.ts`, pure + tested). Never read
  key/credential files (`.pem .key .p12 .pfx .keystore .jks .kdbx .ppk id_rsa* .env*`,
  `credentials.*`, GPG/CSR/DER files — they aren't media, but now it's explicit). Skip hidden
  (dot) folders, `node_modules`/`.git`/build caches, and app/library bundles: `.app`,
  `.framework`, `.photoslibrary` and friends (Photos-managed, huge, private layout — if the
  chosen root *is* a `.photoslibrary`, it is still indexed, roots are never auto-skipped, and
  Settings → Folders shows a note recommending exporting from Photos instead). Cloud-only
  placeholders are never downloaded: macOS `.name.ext.icloud` stubs are ignored and evicted
  (dataless) files are detected for free via `fs.stat` (`size > 4 KB` but `blocks === 0` —
  the cheap proxy for `SF_DATALESS`, no extra syscall); on Windows, OneDrive Files On-Demand
  stubs are detected via `GetFileAttributesW` (koffi FFI, already a dependency) checking
  `OFFLINE` / `RECALL_ON_OPEN` / `RECALL_ON_DATA_ACCESS`. Linux gets the dataless-blocks check
  only.
- **Dataset folders are skipped and surfaced.** A folder with ≥ 200 same-kind media files whose
  names are ≥ 80 % machine-made (`frame_000042`, `clip_000123`, UUIDs, long hex) is treated as
  a dataset and not indexed. Camera naming is explicitly exempt — `IMG_1234`, `DSC_0001`,
  `PXL_2026…`, `VID_…`, `20240101_123456`, GoPro/DJI/WhatsApp patterns are user photos, never a
  dataset. Skipped folders are persisted and listed under Settings → Folders with file counts
  and a per-folder "仍然索引 / Index anyway" button that rescans immediately. User-chosen roots
  are never auto-skipped.
- **Reliable screenshot detection.** On macOS the system marks screenshots with the
  `com.apple.metadata:kMDItemIsScreenCapture` xattr (survives moves/copies); Vixel reads it via
  a direct `getxattr` libc call through koffi — measured ~7 µs/file (vs ~10 ms for an `xattr -p`
  subprocess), cheap enough to run on every import. Windows and foreign files fall back to
  filename patterns (Screenshot*, Screen Shot*, 屏幕截图*, 屏幕快照*, 截屏*, 截图*, Snipaste_*,
  微信截图_*, QQ截图*, TIM截图*, CleanShot*, SCR_*) plus the `Pictures\Screenshots` folder on
  Windows. The verdict is stored per item in `photos.is_screenshot` (migration-safe: NULL =
  not yet judged; existing libraries are backfilled in batches at startup). The 截图/screenshot
  auto-tag now comes from this flag with full confidence (still removable; removal is
  remembered); when the flag says "not a screenshot" the embedding-based screenshot label is
  suppressed (embeddings love calling white-background UI photos screenshots), and only items
  whose flag is unknown keep the old embedding-based behavior. New quick entry: a "仅截图 /
  Screenshots only" chip in the filter bar, and the kind-word query "截图" browses flagged
  screenshots directly; "……的截图" queries boost flagged items (a soft boost, never a filter).
  `npm run eval`: no regressions (demo 1.00/1.00/1.00/1.00, footage 0.94/0.95/0.94/0.92,
  identical to baseline).

- **Weaker matches fold away.** When a search has a clear standout (hits on several channels at
  once — picture + filename + tag, say), results whose fused score is under 0.45× the top hit are
  tucked behind a collapsed "Weaker matches (N)" divider under the grid, expandable with one
  click. Browsing and the honest "no confident match" notice are untouched. The cut line is
  verified by the eval harness: a new `strong` column and a folded-expected check assert that no
  labeled answer ever falls below it (DigUp's 0.5 line did fold one true answer on our sets,
  so Vixel ships 0.45).
- **Media-kind words in queries.** "火车的视频", "video of a waterfall", "仙人掌的照片" and the
  like: the kind word (视频/照片/截图/clip/photo/screenshot/…, zh + en) no longer dilutes the
  query vector — it is stripped before embedding and applied as a *soft* ranking boost for
  matching media kinds (never a filter). A query that is only a kind word ("视频") browses that
  kind. Previously these queries dropped the true hit to rank 2 with a low-confidence banner.
- **Lookup queries.** When every term looks like a code or ID ("IMG_2682", "N49", "2024-03"),
  the exact text channels (OCR / filename / tags) get double weight in fusion and the vector
  channels half — the evidence for such queries lives in text, not in "looks like".
- **More eval coverage.** evals/demo.json and evals/footage.json grew kind-word, lookup and
  negative queries (43 + 39 total), every expected answer verified against the actual pixels
  (thumbnails / extracted frames). `npm run eval` now also reports the strong count per query
  and flags any expected answer folded below the weaker-matches line.

### Fixed
- **Windows: quitting really quits.** Explicit quit (menu, tray, `app.quit()`) could leave the
  process alive: during the quit sequence the main window's close callback re-read settings from
  the already-closed database (to decide tray parking) and the uncaught error stalled the quit.
  Quit callbacks now short-circuit while quitting, and the quick-search panel caches its enabled
  flag in memory. Closing the main window with the shortcut enabled still parks Vixel in the tray.
- **Windows: ⌘C/Ctrl+C in Quick Search now puts a real file on the clipboard.** The previous
  `FileNameW` write landed in Chromium's private format registry, so Explorer paste did nothing.
  Vixel now writes a standard `CF_HDROP` (DROPFILES) via Win32 — Ctrl+V in Explorer pastes the
  file(s); multiple files are supported. (Verify with PowerShell `Get-Clipboard -Format
  FileDropList`; the payload builder is unit-tested, CJK and long paths included.)
- **Quick Search panel no longer steals keys from the IME.** While composing pinyin, Enter and
  arrow keys belong to the input method; previously Enter mid-composition opened a result and
  hid the panel.

### Changed
- **Indexing queue knows task origins.** Tasks are tagged `live` (watcher events after the
  initial scan, Inbox collects) or `backfill`; the power policy only ever delays backfill.
  Follow-up face/OCR tasks inherit the origin of the task that spawned them.
- **Search ranking.** Measured on the eval harness, old baseline → new:
  demo top-1 0.88 → 1.00, MRR 0.94 → 1.00, mAP 0.93 → 1.00, negatives 4/4 (now 5/5 of an
  extended set); footage top-1 0.84 → 0.94, MRR 0.88 → 0.95, mAP 0.85 → 0.92, negatives 3/4
  (now 4/5 of an extended set). No query regressed. The pieces:
  - Exact whole-token hits (OCR text, filename, user tags) now win ties against a lone visual
    match ("STARBUCKS" → the video whose frame says STARBUCKS; "denali" / "anemone" → the file
    so named). Partial/stop-word text hits deliberately get no such boost.
  - When several segments of the same video match about equally (within 0.025 cosine), the
    earlier one is shown — "train arriving at a station" now jumps to the train pulling in,
    not the carriages rolling past.
  - Multi-word queries reach filenames across separators: "wood anemones" finds
    wood_anemones.jpg, "IMG 2682" finds IMG_2682.heic.
- **Refactor.** search.ts split into small, unit-tested modules: queryAnalysis.ts (kind words,
  lookup detection, exact-token matching), relevance.ts (the adaptive z-score gate), fusion.ts
  (RRF, now with optional per-channel weights). Known remaining misses are documented in the
  eval output: "狗跨栏" (the 1899 B/W film), "马拉着篷车" (rank 4, low-confidence), and the
  footage "手机截图" negative still returns one vertical phone video.

## [0.4.0] - 2026-10-12

### Added
- **PDF / AI previews on Windows and Linux.** PDF and PDF-compatible AI files are now indexed on
  every platform. On Windows/Linux (and as a macOS fallback) the first page is rendered by the
  bundled pdf.js inside a hidden, sandboxed BrowserWindow — the same approach Eagle uses for PDF —
  fully offline: the page has a `default-src 'none'` CSP, PDF bytes go in over IPC, and pdf.js
  worker/CMaps/fonts/wasm are bundled and served from a local `vixel-pdf://` scheme (CJK text
  renders correctly thanks to the bundled CMaps). Requests are serialized with a 20 s timeout,
  the window is recreated on crash and destroyed after 60 s idle. Page counts now come from
  pdf.js (`numPages`, exact) when it renders, instead of the heuristic scan. Unlike Eagle, AI
  thumbnails on Windows need no ImageMagick/Ghostscript install — anything saved with "Create
  PDF Compatible File" just works. EPS remains unsupported everywhere.
  (`VIXEL_PDF_RENDERER=pdfjs` forces the pdf.js path on macOS, see docs/debugging.md.)

### Added
- **Design formats: SVG, PSD/PSB, PDF, AI.** Indexed like images through a rasterized preview
  (thumbnails, semantic search, OCR, faces); previews are generated in temp folders and the cache,
  never next to your originals. Grid cards show a format badge ("SVG" / "PSD" / "PDF" / "AI"),
  the inspector shows the original format and, for PDF/AI, the page count. SVG renders via the
  bundled librsvg with a size cap — external `<image href="http://…">` and local-file references
  are never resolved (verified by test), keeping the app fully offline. PSD/PSB are parsed by a
  small pure-JS reader of the merged composite (raw + RLE, 8-bit RGB/gray/approximate CMYK; layer
  data is never loaded), with a Quick Look fallback on macOS. PDF and PDF-compatible AI render
  their first page via `sips` on macOS. EPS is unsupported (macOS removed
  PostScript decoding).
- **Color search.** Every image/video gets a ~5-color palette (extracted from a 64×64 downsample
  in CIELAB during thumbnailing; existing libraries are backfilled in the background without
  blocking the app). The filter bar gains a "Color" row with 12 named swatches (red, orange,
  yellow, green, cyan, blue, purple, pink, brown, black/gray, white, monochrome); a color counts
  as present when ≥ 12% of pixels fall in that hue bucket (LCh rules; monochrome = ≥ 88% neutral
  pixels). The inspector shows the palette — click a swatch to filter by that color. The color
  filter combines with search, search-by-image and smart albums.

### Added
- **Collect: Inbox, drag & drop, paste, browser extension.** New "Inbox" watched folder
  (default `~/Pictures/Vixel Inbox`, created on first collect, files laid out `YYYY/MM/<name>`;
  change its location in Settings → Folders). Drop files anywhere on the window to copy them in;
  drop a folder and choose "add as watched folder (index in place)" — the default — or "copy to
  Inbox"; ⌘V an image with nothing focused to save it as "Pasted <date>". Duplicate content is
  never copied twice: if the bytes are already anywhere in your library, Vixel selects the existing
  item and says so. Every import selects the new item and offers Undo (moves the file to the Trash).
  A Chrome/Edge extension (`extension/`, see `docs/extension.md`) adds "Save to Vixel" on images
  plus a page-screenshot action; it POSTs the bytes to a local server that is **off by default**,
  listens on 127.0.0.1 only, and requires a per-install random token (Settings → General → Browser
  extension). Collected items remember their source URL / page, shown in the inspector ("Source").
  Privacy: the renderer still cannot make any network request; the one narrow exception is in the
  main process, when a browser drag carries only an image URL — that URL alone is fetched once,
  on your explicit drop (size / type limits, timeout). The extension's local server never makes
  outbound requests.

### Added
- **Search by image.** Drag an image onto the toolbar drop target (or paste one with ⌘V) to find
  visually similar photos *and* the video moments it appears in — video hits open at the matching
  segment. Add words next to the image chip to narrow it down ("this, but at night"), done as a
  single multimodal embedding. Right-click → "Search with This Image" replaces "Find Similar" and
  now covers videos too. Results pass a per-library relevance gate instead of padding the grid;
  the query image is processed in memory only and never stored. Calibration in `src/core/imageQuery.ts`
  (script: `scripts/image-search-eval.cjs`).

### Added
- **Offline auto tags.** Photos and videos get up to three tags from a built-in 152-label vocabulary
  (scenes, subjects, document types, activities, light), matched against their existing embeddings —
  no extra model, no network. Library-relative thresholds favour precision (92% of 89 hand-checked
  tags were right). Auto tags are marked ✦: ✓ keeps one, × removes it for good; names follow the UI
  language and are searchable in both. Toggle and Regenerate in Settings → General.
  See `docs/review/09-autotags.md`.

### Fixed
- **Chinese word segmentation never ran** (since the @node-rs/jieba 2.x upgrade the old `cut` export was
  gone and tokenizing silently fell back to raw text), so text-in-image search could not find a Chinese
  word in the middle of a sentence (e.g. "列车" in "等一列车不抢一扇门"). The OCR full-text index is
  rebuilt automatically from the stored text on first launch (no re-OCR).

### Added
- **Tags**: tag photos, videos and audio in the inspector (press T; works on multi-selection),
  browse by tag from the sidebar, rename / merge / delete from its context menu, filter by tags
  (AND) in the filter bar and in smart albums. Tag names are also a search channel.

## [0.3.0] - 2026-10-11

### Added
- **Favorites**: press F (or use the heart in the inspector / context menu) to favorite; a Favorites
  view in the sidebar. Stored per content hash in Vixel's database — originals are never touched.
- **Filter bar**: orientation, resolution, duration, person and favorites, combined with search and
  the date filter.
- **Smart albums**: save a search plus its filters as a live album in the sidebar (the ☆ in the search
  box now saves an album; earlier saved searches are converted once).
- **Clean Up Similar Photos**: groups burst shots, re-exports and lightly edited copies using the
  existing image embeddings (time-window + filename-stem comparison, scales to large libraries),
  suggests a keeper, and lets you hide extras in Vixel or move them to the Trash after confirmation.
- English interface. Follows the system language; switch between System / 简体中文 / English in
  Settings → General. All UI strings live in typed dictionaries under `src/shared/i18n/`.
- Favorites: press F (or use the heart in the inspector / context menu) to favorite photos and
  videos; a Favorites view in the sidebar. Stored per content hash in the library database —
  original files are never touched.
- Filter bar: orientation, resolution, duration, person and favorites-only, combined with search
  and the date filter. Active filters stay visible as removable chips.

## [0.2.0] - 2026-10-11

First public release: macOS (Apple Silicon) and Windows (x64) installers, models included.

### Highlights
- **New inference engine:** EmbeddingGemma 2 now runs on LiteRT-LM with GPU acceleration (Metal on
  macOS, Direct3D 12 via WebGPU on Windows, CPU fallback). Retrieval quality on the labelled demo set
  improved from mAP 0.844 to 0.974 (see `docs/review/06-litert-vs-onnx.md`). Libraries indexed by
  0.1.x must be re-indexed.
- **Honest search:** an adaptive relevance gate shows only real matches and says so when nothing matches.
- **Fully offline, no exceptions:** bundled offline basemap; renderer network requests are blocked.
- **Windows support:** folder names, Explorer wording, Ctrl/Alt shortcuts; RAW via validated embedded previews.
- OCR (PaddleOCR v5) and face recognition on full-resolution video frames.

### Performance
- Startup no longer re-reads and re-hashes the whole library: unchanged images
  and videos (same size / mtime, thumbnail present) are skipped before any IO or
  DB write; file reads are capped at 4 concurrent; offline-deleted videos are
  reconciled. Failed media stays in the task panel instead of re-running each launch.
- Index progress events are coalesced (≤ 4/s); the stats queries behind them no
  longer run per task / per video segment on the main thread.
- Grid paging uses new partial indexes (first page 25 ms → 0.3 ms on 50k rows);
  WAL `synchronous=NORMAL`, larger cache, mmap, in-memory temp store.
- One decode per photo shared by thumbnail / embed / face / OCR tasks.
- Face crops are cached on disk and served via `vixel://face/<id>`; thumbnails,
  face crops and sprites are served with immutable caching (`?v=<fileHash>`).
- Renderer: the grid no longer remounts on sidebar drag / slider / selection;
  index-time refetch throttled; Inspector fetches debounced; People view and map
  load thumbnails via protocol and render incrementally; markers added in bulk.
- Face / OCR ONNX sessions and main-process sharp use at most half the cores.

### Added
- `VIXEL_CAPTURE` (screenshot tour) and `VIXEL_RECORD` + `scripts/make-promo.mjs` (scripted
  real-UI promo recording with titles and captions).
- `VIXEL_PROFILE=1`: slow SQL / IPC / protocol / inference logging, main
  event-loop lag monitor, renderer long-task forwarding, end-of-session summary.
- `vixel doctor` and `vixel bench` CLI commands; `npm run test:db` DB smoke test.
  See `docs/debugging.md`.
- Search results carry `matchedBy`; the grid marks OCR-text and filename hits.
- Accessibility: focus ring, listbox/option grid semantics, dialog roles,
  tabbable sidebar, Home/End/PageUp/PageDown; model-not-ready warning in the status bar.
- Review reports under `docs/review/`.

### Fixed
- **Map crashed in production builds** and its CARTO tiles now require an API key: replaced
  with a bundled offline basemap (Natural Earth, public domain). Vixel makes no network requests.
- **HEIC and most RAW files never indexed on macOS**: sharp read their headers but couldn't
  decode them; they now go straight to the system codec. RAW falls back to the camera's
  embedded preview, which also brings RAW support to Linux / Windows.
- Search relevance gate now works on small libraries (pooled / robust baseline).
- **Text-in-image search never worked**: the PP-OCRv5 recognition model was paired with
  the v1 dictionary and its softmaxed output was softmaxed again. OCR is now validated at
  startup, runs automatically after indexing, reads full-resolution video frames, and
  existing results are re-scanned once.
- **Search no longer pads results**: semantic hits must clearly beat the query's library
  baseline; with no clear match, a few closest items are shown under an explicit notice.
- **People**: new media is face-scanned automatically; video faces are detected on
  full-resolution frames (most were previously too small/blurry to cluster).
- Leftover tasks were never resumed after restart; too-short clips were re-queued every launch.
- Image embedding failures were swallowed (task "done", no vector, silently
  re-queued every launch).
- Inference calls could hang forever; a stall watchdog now restarts the process.
- XSS via file names in map popups; Esc while editing a caption closed the detail view.
- Filename search treated `%` / `_` as wildcards.
- Photos imported mid-session stuck on a broken-image icon.
- CLI semantic search never loaded the model; CLI now opens the library read-only.

### Changed
- New app icon on the macOS icon grid; similar-items view only shows results ≥ 0.80 cosine.
- Release config: real repo URLs, meaningful folder-access prompts, `Vixel-<ver>` artifacts.

### Security
- Renderer sandbox enabled; renderer network access restricted to an allowlist
  (map tiles only); `showInFinder` accepts library paths only.

### Changed
- **Embedding: EmbeddingGemma 2 replaces SigLIP 2** as the single embedding
  model (768d, one space for text / image / video / audio).
- **EmbeddingGemma 2 runs on LiteRT-LM** (Google's official `.litertlm` build) through
  its C API via koffi, on the GPU (Metal on macOS; WebGPU on Windows) with CPU fallback.
  About 15× faster per image than the previous transformers.js / ONNX CPU path on an
  M-series Mac; model download ~465 MB. The ONNX embedding path and its quantization
  settings are removed; Settings → 模型 offers 自动 / GPU / CPU.
- Search is now 4-way RRF: image vectors + video segment vectors + OCR BM25 +
  filename. The query is encoded once and shared by both vector channels.

### Added
- App name and icon in development too: `npm run dev` (predev →
  `scripts/dev-bundle.mjs`) patches the dev Electron.app's CFBundleName /
  CFBundleDisplayName and icon, so the menu bar, Dock, ⌘Tab and About panel
  show "Vixel" with the Vixel icon. The userData directory is unchanged.
- **Person clustering rewrite** (`face/cluster.ts`, `face/clusterer.ts`):
  per-face quality score (size / yaw / sharpness); new faces join a person
  immediately only on a confident KNN vote, the rest are batch-clustered by
  centroid with a merge pass. Thresholds calibrated on LFW. Low-quality faces
  never seed a person. Named people are never auto-merged with each other.
- Person curation backend: merge suggestions, "不是此人" rejections, manual
  face assignment, hidden people (`face_rejections`, `person_dismissed_pairs`).
- **People view curation UI**: double-click to name (clearing a name returns
  the person to unnamed), ⌘/shift-click multi-select and drag-onto-person to
  merge, a "是同一个人吗？" suggestion card, per-face "不是此人" / "移给…" in the
  person detail "人脸" tab, hide / unhide people, live refresh after clustering.
  Merge suggestions no longer have an upper similarity bound.
- **Standalone audio** (`.mp3 .m4a .aac .wav .flac .ogg .opus`): cut into 32s
  segments, each embedded from the audio track alone, stored in the same
  `videos` / `video_segments` tables (`videos.media_kind = 'audio'`). The grid
  tile is the embedded cover art, or a rendered waveform when there is none
  (thumbnail only, no image vector).
- **In-app playback** via `vixel://media/<id>` with HTTP Range (206) streaming,
  so `<video>` / `<audio>` can seek. Formats Chromium can't decode fall back
  to "open in system player".
- **Media browsing rewrite**: grid cards show kind + duration and a "命中 m:ss"
  pill for segment hits; hovering a video plays a muted preview from the hit
  segment. The detail view opens a player that auto-seeks to the hit, has a
  32s segment timeline (hit highlighted, click to seek), Space / J / L / M
  shortcuts, and a 媒体信息 panel (duration, resolution, indexed segments).
- Search results carry the matching segment (`SearchResult.segment`), and a
  全部 / 图片 / 视频 / 音频 filter sits in the title bar.
- **Task drawer** (click the status bar): current file with per-segment
  progress and ETA, overall image / segment progress, upcoming queue by type,
  failed tasks with error messages and retry / clear. Partial segment failures
  are recorded on the task. Finished tasks are pruned at startup.
- Pause / resume background indexing from the status bar. The paused state
  survives restarts; a long video stops between segments and resumes from
  the next one.
- **Appearance**: 跟随系统 / 浅色 / 深色 (Settings → 通用). Colours are CSS
  variables behind the Tailwind tokens; the choice drives `nativeTheme.themeSource`
  so native menus, scrollbars and the window background follow. Full-screen
  detail and Quick Look stay dark.
- **Settings window** (⌘,): a standalone window with 通用 / 文件夹 / AI 模型
  tabs, replacing the modal folder manager. Folder changes are broadcast to
  every window.
- **Grid density** (G, or the status-bar toggle): 沉浸式 (tight gaps, only
  the duration badge) is the browsing default; 信息式 (rank, hit pill,
  file name always shown) is the default for search results.
- **Sidebar 搜索 group**: recent searches (kept once a query settles and has
  results; typing continuations replace the previous entry; last 8 kept, 5
  shown) and saved searches (☆ in the search field). Clicking a row re-runs
  it; hover × removes it.
- **Hover scrubbing**: indexing a video also renders a 12-frame sprite
  (`video_frames/<hash>/sprite.jpg`, square 240 px tiles). Moving the mouse
  across a card scrubs through it, with the position line and timestamp
  following. Videos indexed earlier get their sprite generated on first
  hover (`vixel://sprite/<id>`, serialised); without a sprite the card
  falls back to the muted playback preview.
- **Video segment semantics with audio**: each video is cut into 32s
  segments (1 frame every 4s + audio track) and embedded as one vector per segment
  (`video_segments` / `video_segment_vecs`). Audio-less videos fall back
  to frames only.
- Video duration probing via `ffmpeg -i` (ffmpeg-static ships no ffprobe).

### Fixed
- **UI freeze / spinning cursor while indexing**: embedding, face and OCR
  inference moved out of the main process into an Electron `utilityProcess`
  (nice 10). IPC round-trip during indexing went from p50 2.9 s / max 20 s to
  p95 5 ms / max 32 ms; a full index of the test set also got ~1/3 faster.
  The worker restarts transparently if it crashes.
- Face ANN index was never used: `face_vecs` was declared 128-d but
  MobileFaceNet outputs 512-d, so every insert was skipped and every KNN
  errored into a full scan. The table is rebuilt at 512-d and backfilled.
- **Face alignment produced black images**, so every face got the same
  embedding and people clustering was noise. Alignment is now a pure-JS
  similarity warp on an EXIF-oriented decode shared with detection. Existing
  faces / people are dropped and re-scanned once on upgrade
  (`FACE_PIPELINE_VERSION = 2`).
- Every launch re-queued and re-encoded all videos / audio from scratch
  (chokidar's initial scan fires `add` for every file). Unchanged media that
  was already scanned or is already queued is now skipped.
- Video frame extraction uses VideoToolbox hardware decode on macOS (4K HEVC
  32s segment: 22.8s → 2.8s), falling back to software decode on failure.
- Removing a folder left its videos, segment vectors and `extract_frames`
  tasks behind, so indexing kept running after the folder was gone.
- Background indexing of a large video folder pegged every core. ONNX now
  uses half the cores (`intraOpNumThreads`), ffmpeg runs with `-threads 2`
  at nice 10, and `extract_frames` is queued at priority 6 (after image
  embed / face) so photos become searchable before long videos finish.
- Video frame extraction returned 0–1 frames for 29.97/59.94 fps footage
  (`select='not(mod(t,N))'` never hits whole seconds after `-ss`); now `fps=1/N`.
- Queuing `extract_frames` failed with a FOREIGN KEY error (`index_queue.photo_id`
  holds `videos.id` for that task type).
- Electron crashed (SIGTRAP) encoding video segments with ≥16 frames: the ONNX
  CPU arena requested a huge aligned block that PartitionAlloc refuses. The arena
  is now disabled.
- Videos were counted twice in search fusion (first-frame image vector + segment
  vector) and crowded out photos.
- `models:download` flattened `onnx/`, so transformers.js couldn't find weights.

### Removed
- External embedding API provider and its settings UI / IPC
  (`TEST_EMBEDDING_API`). Vixel is fully local.
- Caption BM25 channel from search (`captions_fts`, `caption_status`,
  the `caption` task type). Hand-written captions are display-only.
- All schema migrations. The product hasn't shipped, so delete
  `library.db` after schema changes instead of migrating.
- Per-frame photo rows for videos (only the first frame is kept as the
  video's representative photo).

## [0.1.0] - 2026-03-30

### Added
- Semantic photo search with natural language queries
- AI-powered caption generation (Qwen3.5-4B via llama.cpp)
- Face detection and recognition (SCRFD + InsightFace)
- Map view for GPS-tagged photos
- Photo deduplication via xxHash64
- Dark immersive UI with photo-first design

### Technical
- Electron + React + TypeScript architecture
- better-sqlite3 with FTS5 for hybrid search
- ONNX Runtime for face models
- Leaflet for map visualization
