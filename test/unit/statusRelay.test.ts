import { afterAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { STATUS_RELAY_PY } from '../../src/main/remote/statusRelay'

const python = spawnSync('python3', ['-c', 'import pty, termios'], { encoding: 'utf8' })
const PYTHON_WITH_PTY = python.status === 0

const roots: string[] = []
afterAll(() => {
  for (const d of roots) fs.rmSync(d, { recursive: true, force: true })
})

const BLOCKED = '\x1b]7501;state=blocked:app=claude-code:kind=permission:msg=eA==\x07'
const WORKING = '\x1b]7501;state=working:app=claude-code\x07'
const throughTmux = (frame: string): string =>
  '\x1bPtmux;' + frame.replace(/\x1b/g, '\x1b\x1b') + '\x1b\\'

const FAKE_CLAUDE_JS = `
const ESC = '\\x1b'
process.stdin.setRawMode(true)
let heard = ''
const redrawEvery = (ms, until) => {
  const t = setInterval(() => process.stdout.write('tick '), ms)
  setTimeout(() => { clearInterval(t); until() }, 2800)
}
process.stdin.on('data', (chunk) => {
  heard += chunk.toString('latin1')
  if (!heard.includes(ESC + ']7501;?:states=')) return
  heard = ''
  process.stdout.write(${JSON.stringify(BLOCKED)})
  redrawEvery(300, () => {
    process.stdout.write(${JSON.stringify(WORKING)})
    redrawEvery(300, () => process.exit(3))
  })
})
process.stdout.write(ESC + ']7501;?' + '\\x07')
`

function runRelay(): Promise<{ code: number | null; out: string }> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-status-relay-')))
  roots.push(home)
  const relay = path.join(home, 'status-relay.py')
  const claude = path.join(home, 'fake-claude.js')
  fs.writeFileSync(relay, STATUS_RELAY_PY)
  fs.writeFileSync(claude, FAKE_CLAUDE_JS)
  return new Promise((resolve) => {
    const child = spawn('python3', [relay, process.execPath, claude], {
      env: { PATH: process.env.PATH, HOME: home, TMUX: '/tmp/fake-tmux,1,0' },
      stdio: ['pipe', 'pipe', 'inherit']
    })
    let out = ''
    child.stdout.on('data', (c) => (out += c.toString('latin1')))
    child.on('exit', (code) => resolve({ code, out }))
  })
}

const count = (text: string, part: string): number => text.split(part).length - 1

// CC§12
describe.skipIf(!PYTHON_WITH_PTY)(
  'status-relay.py, the python3 pty wrapper a remote Claude Code tab runs in tmux',
  () => {
    it("answers claude's status query itself, sends each state on as a tmux passthrough, sends a waiting dialog's state again every few seconds while claude keeps drawing (a tmux client attached later gets it), stops once the dialog is gone, and exits with claude's code", async () => {
      const { code, out } = await runRelay()
      expect(code).toBe(3)
      expect(out).not.toContain('7501;?')
      expect(out).toContain('tick ')
      const working = out.indexOf(throughTmux(WORKING))
      expect(working).toBeGreaterThan(0)
      expect(count(out.slice(0, working), throughTmux(BLOCKED))).toBeGreaterThanOrEqual(2)
      expect(count(out.slice(working), throughTmux(BLOCKED))).toBe(0)
    }, 15_000)
  }
)
