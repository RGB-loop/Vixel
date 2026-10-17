// 以声搜声（sound-to-sound）可行性标定：外部音频查询（另截的 8s 音轨 / 合成音 / 语音）
// 对库里向量的余弦 / z 分布。两种比对：
//   eval  = 查询 ↔ 音视频片段向量（8 帧 + 音轨联合编码，库里现有的索引）
//   audio = 查询 ↔ 纯音频向量（把有音轨的素材按 0-32s 音轨 audio-only 编码，模拟音频文件库）
//
// 结论（2026-10-18，EmbeddingGemma 2 · LiteRT，素材库 22 条 / 32 段 + 演示库拷贝）：两路都过不了相关性门槛，功能未上。
//   eval：正例目标 z 0.20–2.71 / 余弦 0.705–0.813，top-1 仅 3/12；负例（合成音 / 跨库）z 最高 3.34、
//        余弦最高 0.783 —— 画面主导联合向量，声音信号被淹没，正负例完全不可分。
//   audio：top-1 8/12；正例最低余弦 0.917 < 非目标最高 0.959（粉噪对瀑布 0.947、440Hz 对野马 0.856）——
//        纯音频空间过于紧致，连"同一段录音的另一截"都标不出可用门槛。
//   因此"没有明显匹配就直说"的门槛不存在，按产品原则不上这个功能（见 PR 说明）。
//
// 用法（先 npm run build:cli；模型推理较慢，每种模式约 2-3 分钟）：
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/audio-search-eval.cjs gen     # 生成查询音频到 /tmp/vx-as-q
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/audio-search-eval.cjs eval    # 查询 ↔ 片段向量
//   ELECTRON_RUN_AS_NODE=1 npx electron scripts/audio-search-eval.cjs audio   # 查询 ↔ 纯音频向量
// 库（拷贝，不动原件）：/tmp/vx-voice-footage（22 条素材、32 段）、/tmp/vx-voice-data（演示库 34 图 + 3 段）
const { join } = require('path')
const { mkdirSync, writeFileSync, readdirSync, existsSync } = require('fs')
const { execFileSync } = require('child_process')
const root = join(__dirname, '..')
const { initDatabase } = require(join(root, 'dist/cli/core/db'))
const { extractAudioTrack } = require(join(root, 'dist/cli/core/audio/extract'))
const { initEmbeddingServicePath, getEmbeddingService } = require(join(root, 'dist/cli/core/embedding'))

const QDIR = '/tmp/vx-as-q'
const LIBS = { footage: '/tmp/vx-voice-footage/library.db', demo: '/tmp/vx-voice-data/library.db' }
const FOOTAGE = join(process.env.HOME, 'workspace/dancer/vixel-demo/footage')

// 有音轨的素材（37% 时长处另截 8s，不与索引的 32s 片段网格对齐）
const POSITIVE_CLIPS = [
  'rain-sonoma.mp4', 'waterfall-delaneys.mp4', 'waterfall-watagataki.mp4', 'seagull-chicks.mp4',
  'train-zagreb.mp4', 'fireworks-kamakura.mp4', 'rocket-falcon9.mp4', 'cat-curious.mp4',
  'cooking-alioli.mp4', 'horse-wagons.mp4', 'birds-flying.mp4', 'wild-horses.mp4',
]
// 合成负例：和任何库内容都无关的声音（+ say 合成的中英文语音，模拟误把语音当声音查询）
const SYNTH_NEGATIVES = [
  ['tone-440.wav', (ffmpeg, out) => execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8', '-ar', '16000', '-ac', '1', out], { stdio: 'ignore' })],
  ['noise-pink.wav', (ffmpeg, out) => execFileSync(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:duration=8', '-ar', '16000', '-ac', '1', out], { stdio: 'ignore' })],
  ['speech-zh.wav', (_f, out) => execFileSync('say', ['-v', 'Tingting', '--data-format=LEI16@16000', '-o', out, '请把今天会议的录音整理成文字稿'], { stdio: 'ignore' })],
  ['speech-en.wav', (_f, out) => execFileSync('say', ['-v', 'Samantha', '--data-format=LEI16@16000', '-o', out, 'please transcribe the recording of the meeting'], { stdio: 'ignore' })],
]
// 跨库负例：footage 的查询拿去搜演示库（3 段：无主题重合）
const CROSS_NEGATIVES = ['clip-rain-sonoma.wav', 'clip-seagull-chicks.wav', 'clip-train-zagreb.wav',
  'clip-fireworks-kamakura.wav', 'clip-rocket-falcon9.wav', 'clip-cooking-alioli.wav']

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
function stats(sims) {
  const mean = sims.reduce((a, b) => a + b, 0) / sims.length
  const sd = Math.sqrt(sims.reduce((a, b) => a + (b - mean) ** 2, 0) / sims.length) || 1e-6
  return { mean, sd }
}
const toF32 = (buf) => { const b = Buffer.from(buf); return new Float32Array(b.buffer, b.byteOffset, b.length / 4) }

function loadLib(dbPath) {
  // 拷贝库可能是老 schema（缺新列）：读写打开让迁移补齐 —— 只动 /tmp 下的拷贝，从不碰原库
  const inst = initDatabase(dbPath)
  const images = inst.raw.prepare(`SELECT v.embedding e FROM image_vec_map m JOIN image_vecs v ON v.rowid = m.rowid`).all()
    .map((r) => toF32(r.e))
  const segments = inst.raw.prepare(`
    SELECT s.video_id vid, s.start_ms s0, vd.file_name name, v.embedding e
    FROM video_segment_vec_map m JOIN video_segment_vecs v ON v.rowid = m.rowid
    JOIN video_segments s ON s.id = m.segment_id JOIN videos vd ON vd.id = s.video_id`).all()
    .map((r) => ({ name: r.name, start: r.s0, v: toF32(r.e) }))
  const videos = inst.raw.prepare(`SELECT file_name n, duration_ms d FROM videos WHERE deleted_at IS NULL`).all()
  inst.close()
  return { images, segments, videos }
}

function gen() {
  mkdirSync(QDIR, { recursive: true })
  const ffmpeg = require(join(root, 'node_modules/ffmpeg-static'))
  const { videos } = loadLib(LIBS.footage)
  for (const name of POSITIVE_CLIPS) {
    const v = videos.find((x) => x.n === name)
    const t = ((v?.d ?? 20000) * 0.37) / 1000
    const out = join(QDIR, `clip-${name.replace(/\.\w+$/, '')}.wav`)
    execFileSync(ffmpeg, ['-y', '-ss', t.toFixed(2), '-i', join(FOOTAGE, name), '-t', '8', '-vn', '-ac', '1', '-ar', '16000', out], { stdio: 'ignore' })
    console.log('clip', out, `@${t.toFixed(1)}s`)
  }
  for (const [name, make] of SYNTH_NEGATIVES) {
    make(ffmpeg, join(QDIR, name))
    console.log('synth', name)
  }
  return Promise.resolve()
}

let svc
async function encodeWav(path) {
  if (!svc) {
    initEmbeddingServicePath('/tmp/vx-as-userdata', join(root, 'resources/models'), join(root, 'resources/litert/darwin-arm64'))
    svc = getEmbeddingService()
    await svc.init()
  }
  const samples = await extractAudioTrack(path, { durationSec: 30 })
  return svc.encode({ type: 'audio', samples })
}

/** 与 SearchEngine.baselineSample 同款：片段样本 < 20 时并入图片样本（同一嵌入空间） */
function segStats(q, lib) {
  const sample = lib.segments.map((x) => x.v)
  const merged = sample.length >= 20 ? sample : [...sample, ...lib.images]
  return stats(merged.map((v) => dot(v, q)))
}

function scoreAgainst(q, lib) {
  const st = segStats(q, lib)
  return lib.segments.map((x) => ({ name: x.name, start: x.start, cos: dot(x.v, q) }))
    .map((x) => ({ ...x, z: (x.cos - st.mean) / st.sd })).sort((a, b) => b.z - a.z)
}

const fmt = (x) => x ? `${x.name}@${x.start / 1000}s cos ${x.cos.toFixed(3)} z ${x.z.toFixed(2)}` : '—'

async function evalAll() {
  const libs = { footage: loadLib(LIBS.footage), demo: loadLib(LIBS.demo) }
  const rows = []
  for (const qf of readdirSync(QDIR).filter((f) => f.startsWith('clip-'))) {
    const q = await encodeWav(join(QDIR, qf))
    const seg = scoreAgainst(q, libs.footage)
    const tgt = qf.replace(/^clip-/, '').replace(/\.wav$/, '')
    const isT = (x) => x.name.startsWith(tgt)
    rows.push({ q: qf, kind: 'pos', target: seg.find(isT), best: seg[0], other: seg.find((x) => !isT(x)) })
    console.log(`[pos] ${qf}`)
    console.log(`   目标: ${fmt(seg.find(isT))} | 他片: ${fmt(seg.find((x) => !isT(x)))} | top: ${seg[0]?.name}`)
  }
  for (const [qf] of SYNTH_NEGATIVES) {
    const q = await encodeWav(join(QDIR, qf))
    const seg = scoreAgainst(q, libs.footage)
    rows.push({ q: qf, kind: 'neg-synth', best: seg[0] })
    console.log(`[neg-synth] ${qf} → footage: ${fmt(seg[0])}`)
  }
  for (const qf of CROSS_NEGATIVES) {
    if (!existsSync(join(QDIR, qf))) continue
    const q = await encodeWav(join(QDIR, qf))
    const seg = scoreAgainst(q, libs.demo)
    rows.push({ q: qf, kind: 'neg-cross', best: seg[0] })
    console.log(`[neg-cross] ${qf} → demo: ${fmt(seg[0])}`)
  }
  writeFileSync(join(QDIR, 'eval.json'), JSON.stringify(rows, null, 1))
  const pos = rows.filter((r) => r.kind === 'pos' && r.target)
  const neg = rows.filter((r) => r.kind !== 'pos' && r.best)
  const top1 = pos.filter((r) => r.best && r.target && r.best.name === r.target.name).length
  console.log(`\n== 正例目标 z ${Math.min(...pos.map((r) => r.target.z)).toFixed(2)}–${Math.max(...pos.map((r) => r.target.z)).toFixed(2)}` +
    ` 余弦 ${Math.min(...pos.map((r) => r.target.cos)).toFixed(3)}–${Math.max(...pos.map((r) => r.target.cos)).toFixed(3)}（top-1 ${top1}/${pos.length}）`)
  console.log(`== 负例最高 z ${Math.max(...neg.map((r) => r.best.z)).toFixed(2)} 余弦最高 ${Math.max(...neg.map((r) => r.best.cos)).toFixed(3)}`)
}

const mode = process.argv[2] || 'eval'
;(mode === 'gen' ? gen() : mode === 'audio' ? evalAudioOnly() : evalAll())
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1) })

/** audio 模式：把有音轨的素材按 0-32s 音轨 audio-only 编码当作"音频文件库"，同一批查询打分 */
async function evalAudioOnly() {
  const clips = [...POSITIVE_CLIPS, 'rocket-jason3.mp4', 'earth-night-lights.mp4']
  const lib = []
  for (const c of clips) {
    const samples = await extractAudioTrack(join(FOOTAGE, c), { durationSec: 32 })
    if (samples.length === 0) { console.log('skip silent', c); continue }
    if (!svc) await encodeWav(join(QDIR, 'tone-440.wav')) // 初始化服务（结果不用）
    lib.push({ name: c, v: await svc.encode({ type: 'audio', samples }) })
  }
  console.log('lib:', lib.length, 'audio-only vectors')
  let top1 = 0, posN = 0, posMinCos = 1, nonTargetMaxCos = 0
  for (const qf of readdirSync(QDIR).filter((f) => f.endsWith('.wav'))) {
    const q = await encodeWav(join(QDIR, qf))
    const st = stats(lib.map((x) => dot(x.v, q)))
    const scored = lib.map((x) => ({ name: x.name, cos: dot(x.v, q) }))
      .map((x) => ({ ...x, z: (x.cos - st.mean) / st.sd })).sort((a, b) => b.cos - a.cos)
    const tgt = qf.replace(/^clip-/, '').replace(/\.wav$/, '')
    const isT = (x) => x.name.startsWith(tgt)
    if (qf.startsWith('clip-')) {
      posN++
      const t = scored.find(isT); const other = scored.find((x) => !isT(x))
      if (scored[0] && isT(scored[0])) top1++
      posMinCos = Math.min(posMinCos, t.cos)
      nonTargetMaxCos = Math.max(nonTargetMaxCos, other.cos)
      console.log(`[pos] ${qf}: 目标 cos ${t.cos.toFixed(3)} z ${t.z.toFixed(2)} | 次名 ${other.name} cos ${other.cos.toFixed(3)} z ${other.z.toFixed(2)}`)
    } else {
      nonTargetMaxCos = Math.max(nonTargetMaxCos, scored[0].cos)
      console.log(`[neg] ${qf}: top ${scored[0].name} cos ${scored[0].cos.toFixed(3)} z ${scored[0].z.toFixed(2)}`)
    }
  }
  console.log(`\ntop-1 ${top1}/${posN} | 正例最低余弦 ${posMinCos.toFixed(3)} | 非目标最高余弦 ${nonTargetMaxCos.toFixed(3)}`)
}
