/**
 * 网页前端的静态服务 + 登录页（阶段 2）：
 *
 *   GET /login            服务器渲染的极简登录页（zh/en 按 Accept-Language，设计令牌与应用一致）；
 *                         已登录则 302 回 /
 *   GET /<静态文件>        dist/web（npm run build:web）里的文件：/assets/* 文件名带 hash，
 *                         缓存 immutable 一年；index.html 等其余一律 no-cache
 *   GET /<应用路由>        SPA fallback → index.html
 *
 * 未登录访问任何应用路径：浏览器导航（Accept: text/html）302 → /login，其余 401 ——
 * 构建产物也不给未认证用户（登录页自包含，不依赖任何静态资源）。
 * 路径安全：resolve 后必须仍在 webDir 之内（破编码 / ../ 一律 404）。
 */
import type { IncomingMessage, ServerResponse } from 'http'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { extname, join, resolve, sep } from 'path'
import { sendJson } from './http'
import webDict from '../shared/i18n/web'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' })
  res.end()
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(html)
}

/** Accept-Language → 登录页语言（应用内语言由用户设置决定，登录前只有浏览器偏好可用） */
function loginLocale(req: IncomingMessage): 'zh' | 'en' {
  const header = req.headers['accept-language'] ?? ''
  return /^\s*zh/i.test(header) ? 'zh' : 'en'
}

/** 登录页：自包含（无外部资源），深色默认 + prefers-color-scheme 浅色，口令错误 / 限速就地提示 */
export function renderLoginPage(locale: 'zh' | 'en'): string {
  const s = webDict[locale]
  const js = (v: string): string => JSON.stringify(v)
  return `<!doctype html>
<html lang="${locale === 'zh' ? 'zh-CN' : 'en'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vixel</title>
<style>
  :root {
    --canvas: #0f0f0f; --raised: #232120; --line: rgb(255 255 255 / 0.12);
    --ink: rgb(255 255 255 / 0.88); --ink-3: rgb(255 255 255 / 0.38);
    --fill: rgb(255 255 255 / 0.05); --accent: #d4a574; --bad: #ff453a;
    color-scheme: dark;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --canvas: #ffffff; --raised: #ffffff; --line: rgb(0 0 0 / 0.13);
      --ink: rgb(0 0 0 / 0.85); --ink-3: rgb(0 0 0 / 0.42);
      --fill: rgb(0 0 0 / 0.04); --accent: #a86e38; --bad: #d70015;
      color-scheme: light;
    }
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: var(--canvas); color: var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  main { width: min(320px, calc(100vw - 48px)); text-align: center; }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: 0.02em; }
  .hint { color: var(--ink-3); font-size: 13px; margin: 8px 0 24px; }
  form { display: flex; flex-direction: column; gap: 10px; }
  input[type=password] {
    height: 36px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line);
    background: var(--fill); color: var(--ink); font-size: 14px; outline: none;
  }
  input[type=password]:focus { border-color: var(--accent); }
  button {
    height: 36px; border: 0; border-radius: 8px; background: var(--accent);
    color: rgb(0 0 0 / 0.85); font-size: 14px; font-weight: 500; cursor: pointer;
  }
  button:disabled { opacity: 0.6; cursor: default; }
  #err { color: var(--bad); font-size: 13px; margin-top: 14px; min-height: 1.5em; }
</style>
</head>
<body>
<main>
  <h1>Vixel</h1>
  <p class="hint">${s.loginHint}</p>
  <form id="f">
    <input type="password" id="pw" placeholder="${s.passwordPlaceholder}" autocomplete="current-password" autofocus>
    <button id="go" type="submit">${s.signIn}</button>
  </form>
  <p id="err" role="alert"></p>
</main>
<script>
  const f = document.getElementById('f'), pw = document.getElementById('pw'),
        go = document.getElementById('go'), err = document.getElementById('err')
  f.addEventListener('submit', async (e) => {
    e.preventDefault()
    go.disabled = true
    go.textContent = ${js(s.signingIn)}
    err.textContent = ''
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vixel': '1' },
        body: JSON.stringify({ password: pw.value }),
      })
      // 从 /open?… 这类链接被导过来的：登录后回到原地（只认站内路径，防开放重定向）
      const next = new URLSearchParams(location.search).get('next')
      const ok = next && next.charAt(0) === '/' && next.charAt(1) !== '/' && next.charCodeAt(1) !== 92 // 92 = 反斜杠：浏览器把「/反斜杠…」也当成 //…
      if (res.ok) { location.replace(ok ? next : '/'); return }
      err.textContent = res.status === 429 ? ${js(s.rateLimited)} : ${js(s.wrongPassword)}
    } catch {
      err.textContent = ${js(s.networkError)}
    } finally {
      go.disabled = false
      go.textContent = ${js(s.signIn)}
    }
  })
</script>
</body>
</html>
`
}

export interface WebAppDeps {
  webDir: string
  isAuthed(req: IncomingMessage): boolean
}

/** 登录页的 next 参数：只接受站内路径（/ 开头，第二个字符不是 / 或 \\ —— 浏览器把 /\\x 当成 //x），防开放重定向 */
function safeNext(req: IncomingMessage): string | null {
  const next = new URL(req.url ?? '/', 'http://x').searchParams.get('next')
  return next && /^\/(?![\/\\])/.test(next) ? next : null
}

/**
 * 处理 GET/HEAD 的网页前端请求（/api、/media、/healthz 之外的所有路径）。
 * 总是响应（含 404），调用方不再兜底。
 */
export async function handleWebRequest(pathname: string, req: IncomingMessage, res: ServerResponse, deps: WebAppDeps): Promise<void> {
  const authed = deps.isAuthed(req)

  if (pathname === '/login') {
    if (authed) return redirect(res, safeNext(req) ?? '/')
    return sendHtml(res, 200, renderLoginPage(loginLocale(req)))
  }

  if (!authed) {
    // 浏览器导航去登录页；fetch/资源请求与 API 同样给 401
    // 打开的是网页链接（/open?…）：带上原地址，登录后回来
    if ((req.headers.accept ?? '').includes('text/html')) {
      return redirect(res, pathname === '/open' ? `/login?next=${encodeURIComponent(req.url ?? '/')}` : '/login')
    }
    sendJson(res, 401, { ok: false, error: 'Not authenticated' })
    return
  }

  // ─ 静态文件（dist/web）─
  let rel: string
  try {
    rel = decodeURIComponent(pathname)
  } catch {
    sendJson(res, 400, { ok: false, error: 'bad path' })
    return
  }
  const root = resolve(deps.webDir)
  let file = resolve(root, '.' + join('/', rel))
  if (file !== root && !file.startsWith(root + sep)) {
    sendJson(res, 404, { ok: false, error: 'not found' })
    return
  }

  let st = await stat(file).catch(() => null)
  if (!st || st.isDirectory()) {
    if (extname(rel) && rel !== '/') {
      // 带扩展名的文件缺失：真 404，不吞进 SPA fallback
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }
    file = join(root, 'index.html') // SPA fallback（/、/#settings 等应用路由）
    st = await stat(file).catch(() => null)
    if (!st) {
      // dist/web 还没构建：服务器照常提供 API，界面给出双语说明
      const msg = `${webDict.zh.webBuildMissing} / ${webDict.en.webBuildMissing}`
      sendHtml(res, 503, `<!doctype html><meta charset="utf-8"><title>Vixel</title><p style="margin:40vh auto 0;max-width:36em;text-align:center;font:14px system-ui;color:#888">${msg}</p>`)
      return
    }
  }

  const headers: Record<string, string | number> = {
    'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': st.size,
    // 构建产物 /assets/* 文件名带内容 hash，可永久缓存；入口 html 等其余必须每次回源
    'Cache-Control': pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  const stream = createReadStream(file)
  stream.pipe(res)
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
}
