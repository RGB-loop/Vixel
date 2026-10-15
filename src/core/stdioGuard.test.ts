import { describe, it, expect } from 'vitest'
import { spawn } from 'child_process'
import { join } from 'path'

/** 子进程不停 console.log；父进程读到 1 字节就关掉管道 —— 与"关掉启动它的终端"同一情形 */
function runChild(withGuard: boolean): Promise<{ code: number | null; stderr: string }> {
  const guard = join(__dirname, 'stdioGuard.ts')
  const script = `${withGuard ? `require(${JSON.stringify(guard)});` : ''}
    let i = 0; const t = setInterval(() => { console.log('line ' + i++); if (i > 200) { clearInterval(t); process.exit(0) } }, 2)`
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    child.stdout.once('data', () => child.stdout.destroy())
    child.on('close', (code) => resolve({ code, stderr }))
  })
}

describe('stdioGuard', () => {
  it('a closed stdout pipe (EPIPE) no longer crashes the process', async () => {
    const guarded = await runChild(true)
    expect(guarded.stderr).not.toMatch(/EPIPE/)
    expect(guarded.code).toBe(0)
  })
  it('without the guard the same situation is an uncaught EPIPE (the test reproduces the bug)', async () => {
    const bare = await runChild(false)
    expect(bare.stderr).toMatch(/EPIPE/)
    expect(bare.code).not.toBe(0)
  })
})
