#!/bin/sh
# 发布前检查：用"打包后的"应用（不是开发模式）索引几个视频，必须产出片段向量、零错误。
# 开发模式没有 app.asar，打包后才会出现的问题（spawn 读不了 asar 里的二进制 → ENOTDIR）只有这样才测得到。
#
#   sh scripts/packaged-video-check.sh [Vixel.app 路径]   # 默认 release/mac-arm64/Vixel.app
set -eu
APP="${1:-release/mac-arm64/Vixel.app}"
BIN="$APP/Contents/MacOS/Vixel"
FOOTAGE="${VIXEL_EVAL_FOOTAGE_LIB:-$HOME/workspace/dancer/vixel-demo/footage}"
WORK="$(mktemp -d)"; DATA="$WORK/data"; MEDIA="$WORK/media"
trap 'pkill -f "$BIN" 2>/dev/null || true; rm -rf "$WORK"' EXIT
mkdir -p "$MEDIA"
# 有声视频 + 无声视频 + 多片段视频
cp "$FOOTAGE/waterfall-watagataki.mp4" "$FOOTAGE/dogs-hurdles-1899.mp4" "$FOOTAGE/rain-sonoma.mp4" "$MEDIA/"

q() { sqlite3 "$DATA/library.db" "$1" 2>/dev/null || true; }
# 第一次启动只为建库，退出后登记测试目录，再启动开始索引
"$BIN" --user-data-dir="$DATA" >"$WORK/run1.log" 2>&1 &
for _ in $(seq 1 30); do [ -f "$DATA/library.db" ] && break; sleep 2; done
sleep 5; pkill -f "$BIN" || true; sleep 3
q "insert into watched_folders(path) values('$MEDIA')"
"$BIN" --user-data-dir="$DATA" >"$WORK/run2.log" 2>&1 &
for i in $(seq 1 60); do
  pending=$(q "select count(*) from index_queue where task_type='extract_frames' and status in ('pending','processing')")
  videos=$(q "select count(*) from videos")
  [ "${videos:-0}" -ge 3 ] && [ "${pending:-1}" = 0 ] && [ "$i" -gt 3 ] && break
  sleep 5
done
segments=$(q "select count(*) from video_segments")
errors=$(q "select task_type || ': ' || substr(error_msg,1,120) from index_queue where status='error'")
echo "videos=$(q 'select count(*) from videos') segments=$segments"
if [ "${segments:-0}" -lt 3 ] || [ -n "$errors" ]; then
  echo "FAIL"; [ -n "$errors" ] && echo "$errors"; exit 1
fi
echo "OK"
