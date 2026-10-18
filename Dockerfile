# syntax=docker/dockerfile:1
# Vixel Server（Docker / NAS 版）多阶段构建，linux/amd64 + linux/arm64。
#
#   docker buildx build --platform linux/arm64 -t vixel:latest --load .
#
# npmjs 慢的网络：--build-arg NPM_REGISTRY=https://registry.npmmirror.com（lock 里的 registry.npmjs.org
# 地址由 npm 自动换成这个源；只影响下载来源，镜像内容不变）
#
# 需要构建前在仓库里准备好（均有 sha256 校验，见 scripts/download-models.mjs）：
#   resources/models/            EmbeddingGemma 2 (.litertlm) + PaddleOCR + 人脸模型
#   resources/litert/linux-x64 / linux-arm64   LiteRT-LM 原生库（LITERT_PLATFORM=… 下载）
# 镜像内置全部模型，运行时零出站请求。

# ─── 1. 编译：服务器 TS + 网页前端（平台无关，可被 buildx 跨平台复用）────────────
FROM node:22-bookworm AS build
ARG NPM_REGISTRY
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts：跳过 postinstall（electron-builder install-app-deps 会下载 Electron 并按
# Electron ABI 重编原生模块 —— 桌面专用；这里只需要 tsc / vite 等纯 JS 工具链）
# --legacy-peer-deps：react-leaflet 5 声明 peer react 19、仓库用 react 18（运行时兼容，桌面同样组合）
RUN npm_config_registry="${NPM_REGISTRY:-https://registry.npmjs.org/}" npm ci --ignore-scripts --legacy-peer-deps --no-audit --no-fund
COPY tsconfig.json tsconfig.node.json tsconfig.server.json tsconfig.web.json vite.web.config.ts tailwind.config.js postcss.config.js ./
COPY scripts/server-postbuild.mjs scripts/
COPY src ./src
RUN npx tsc -p tsconfig.server.json && node scripts/server-postbuild.mjs \
 && npx vite build --config vite.web.config.ts

# ─── 2. 运行时依赖（Node ABI，按目标平台装；docker/package.json 是服务器专属依赖集）──
FROM node:22-bookworm AS deps
ARG NPM_REGISTRY
WORKDIR /app
COPY docker/package.json docker/package-lock.json ./
# onnxruntime-node 的 install 脚本在 linux-x64 上默认会去下载 CUDA EP（容器纯 CPU 用不上）；
# ffmpeg-static 的 install 脚本按当前平台下载对应二进制（buildx 每个平台各下各的）。
# 瘦身：onnxruntime-node 自带全平台二进制（darwin / win32 / 另一个 linux 架构 ~230 MB）只留本架构；
# sharp / @napi-rs/canvas 的 musl 变体（Debian 是 glibc）不会被加载，删掉
ARG TARGETARCH
RUN npm_config_registry="${NPM_REGISTRY:-https://registry.npmjs.org/}" npm_config_onnxruntime_node_install=skip npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force \
 && case "$TARGETARCH" in amd64) keep=x64 ;; arm64) keep=arm64 ;; *) exit 1 ;; esac \
 && ort=node_modules/onnxruntime-node/bin/napi-v6 \
 && rm -rf "$ort/darwin" "$ort/win32" \
 && find "$ort/linux" -mindepth 1 -maxdepth 1 ! -name "$keep" -exec rm -rf {} + \
 && test -d "$ort/linux/$keep" \
 && rm -rf node_modules/@img/*linuxmusl* node_modules/@napi-rs/*-musl

# ─── 3. 模型 + LiteRT 运行时（按目标架构挑选）───────────────────────────────────
FROM node:22-bookworm AS assets
ARG TARGETARCH
WORKDIR /staging
COPY resources/models ./resources/models
COPY resources/litert ./litert-all
RUN set -e; \
    case "$TARGETARCH" in \
      amd64) lp=linux-x64 ;; \
      arm64) lp=linux-arm64 ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    test -f "litert-all/$lp/liblitert-lm.so" || { echo "missing resources/litert/$lp — run LITERT_PLATFORM=$lp node scripts/download-models.mjs litert-runtime" >&2; exit 1; }; \
    mkdir -p resources/litert; \
    mv "litert-all/$lp" "resources/litert/$lp"; \
    rm -rf litert-all resources/models/README.md

# ─── 4. 运行镜像 ───────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    VIXEL_DATA_DIR=/data \
    VIXEL_LIBRARY_DIRS=/photos \
    MALLOC_ARENA_MAX=2 \
    MALLOC_TRIM_THRESHOLD_=131072 \
    MALLOC_MMAP_THRESHOLD_=131072 \
    VIXEL_ORT_MEM_ARENA=0 \
    VIXEL_LOW_MEMORY=1 \
    VIXEL_BACKEND=cpu \
    ORT_DISABLE_TELEMETRY=1
WORKDIR /app

# 非 root 运行：基础镜像自带的 node(1000) 改名为 vixel；root 启动时 entrypoint 按 PUID/PGID
# 调整后降权（群晖习惯）。setpriv（util-linux）/ usermod 都在基础镜像里，无需额外安装。
# MALLOC_ARENA_MAX=2：glibc 多线程 arena 在 XNNPACK 推理下碎片化严重 —— 实测索引
# demo+footage 库峰值 3.38→2.79 GiB、索引后常驻 3.26→2.02 GiB（8 vCPU、默认线程数）。
# MALLOC_TRIM_THRESHOLD_ / MALLOC_MMAP_THRESHOLD_=128 KB：视频片段前向在推理 worker 里
#   有大量大块瞬时分配，默认（动态）阈值下 glibc 攒着不还内核 —— 固定小阈值让大块走 mmap、
#   释放即归还，压低视频批次的 RSS 峰值（速度略有代价，数值结果不变）。
# VIXEL_ORT_MEM_ARENA=0：OCR / 人脸的 onnxruntime 会话不用只增不减的 CPU 内存池，
#   大图过后按需释放（数值结果不变，见 src/core/inference/session-options.ts）。
# VIXEL_LOW_MEMORY=1：推理 worker 不让语义模型和 OCR / 人脸会话同时驻留，索引器按模型组
#   分批取任务，空闲几分钟后卸掉全部模型（搜索时按需重载，付一次冷启动延迟）。
#   内存紧张优先，NAS 常态；要换回"模型常驻"可在 compose 里设 VIXEL_LOW_MEMORY=0。
# ORT_DISABLE_TELEMETRY=1：onnxruntime 1.30 带遥测上报，运行时零出站 —— 代码里每个进程入口也设了，这里兜底。
# VIXEL_BACKEND=cpu：容器里一般没有可用 GPU，启动时不空试 WebGPU（设置页选过后端的以设置为准）。
RUN usermod -l vixel -d /app -s /usr/sbin/nologin node && groupmod -n vixel node \
 && mkdir -p /data /photos && chown vixel:vixel /data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist/server ./dist/server
COPY --from=build /app/dist/web ./dist/web
COPY --from=assets /staging/resources ./resources
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/vixel-entrypoint

EXPOSE 8080
VOLUME /data

# /healthz 免认证、无信息（src/server/index.ts）；slim 镜像没有 curl，用 node fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.VIXEL_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["vixel-entrypoint"]
# node 直接当 PID 1：SIGTERM 的优雅退出在 src/server/index.ts 里处理；
# 子进程（推理 worker / ffmpeg）都是 node 的直接子进程，由 child_process 回收
CMD ["node", "dist/server/index.js"]
