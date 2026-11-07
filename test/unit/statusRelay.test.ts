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
process.stdin.on('data', (chunk) => {
  heard += chunk.toString('latin1')
  if (!heard.includes(ESC + ']7501;?:states=')) return
  heard = ''
  process.stdout.write(${JSON.stringify(BLOCKED)})
  const redraw = setInterval(() => process.stdout.write('tick '), 300)
  setTimeout(() => {
    clearInterval(redraw)
    process.stdout.write(${JSON.stringify(WORKING)})
    setTimeout(() => process.exit(3), 4500)
  }, 4500)
})
process.stdout.write(ESC + ']7501;?' + '\\x07')
`

const SYNC_ASK = '\x1b[?2026$p'
const SYNC_ON = '\x1b[?2026h'
const SYNC_OFF = '\x1b[?2026l'
const TMUX_READ_ALL_BEFORE = '\x1b[5n'
const TMUX_HAS_READ = '\x1b[0n'
const TMUX_TAKES_SYNC = '\x1b[?2026;2$y'

function fakeTmux(takesSync: boolean, frameReadsAnswered: number) {
  let asks = 0
  const answeredAt: number[] = []
  const onOutput = (out: string, stdin: NodeJS.WritableStream): void => {
    for (; asks < count(out, TMUX_READ_ALL_BEFORE); asks++) {
      if (asks === 0) stdin.write((takesSync ? TMUX_TAKES_SYNC : '') + TMUX_HAS_READ)
      else if (answeredAt.length < frameReadsAnswered) {
        answeredAt.push(out.length)
        setTimeout(() => stdin.write(TMUX_HAS_READ), 100)
      }
    }
  }
  return { answeredAt, onOutput }
}

const FRAMING_CLAUDE_JS = `
const ESC = '\\x1b'
process.stdin.setRawMode(true)
let heard = ''
let started = false
const frame = (text) => process.stdout.write(ESC + '[?2026h' + text + ESC + '[?2026l')
process.stdin.on('data', (chunk) => {
  heard += chunk.toString('latin1')
  if (heard.includes(ESC + '[0n')) process.stdout.write('LEAKED')
  if (started || !heard.includes(ESC + '[?2026;2$y')) return
  started = true
  frame('frame-one')
  setTimeout(() => {
    frame('frame-two')
    setTimeout(() => process.exit(0), 1500)
  }, 1500)
})
process.stdout.write(ESC + '[?2026$p')
`

function runRelay(
  fakeClaude: string,
  onOutput: (out: string, stdin: NodeJS.WritableStream) => void = () => {}
): Promise<{ code: number | null; out: string }> {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-status-relay-')))
  roots.push(home)
  const relay = path.join(home, 'status-relay.py')
  const claude = path.join(home, 'fake-claude.js')
  fs.writeFileSync(relay, STATUS_RELAY_PY)
  fs.writeFileSync(claude, fakeClaude)
  return new Promise((resolve) => {
    const child = spawn('python3', [relay, process.execPath, claude], {
      env: { PATH: process.env.PATH, HOME: home, TMUX: '/tmp/fake-tmux,1,0' },
      stdio: ['pipe', 'pipe', 'inherit']
    })
    let out = ''
    child.stdout.on('data', (c) => {
      out += c.toString('latin1')
      onOutput(out, child.stdin)
    })
    child.on('exit', (code) => resolve({ code, out }))
  })
}

const count = (text: string, part: string): number => text.split(part).length - 1

// CC§12
describe.skipIf(!PYTHON_WITH_PTY)(
  'status-relay.py, the python3 pty wrapper a remote Claude Code tab runs in tmux',
  () => {
    it("answers claude's status query itself, sends each state on as a tmux passthrough, sends a waiting dialog's state again every few seconds between claude's writes (a tmux client attached later gets it) but no other state, never splits claude's output, and exits with claude's code", async () => {
      const { code, out } = await runRelay(FAKE_CLAUDE_JS)
      expect(code).toBe(3)
      expect(out).not.toContain('7501;?')
      const working = out.indexOf(throughTmux(WORKING))
      expect(working).toBeGreaterThan(0)
      const whileDrawing = out.slice(0, working)
      expect(count(whileDrawing, throughTmux(BLOCKED))).toBeGreaterThanOrEqual(2)
      expect(whileDrawing.replaceAll(throughTmux(BLOCKED), '')).toMatch(/^(tick )+$/)
      expect(count(out.slice(working), throughTmux(BLOCKED))).toBe(0)
      expect(count(out.slice(working), throughTmux(WORKING))).toBe(1)
    }, 20_000)

    it("under a tmux that does not answer claude's synchronized-output question (before 3.7), answers yes itself and carries each frame past tmux as a passthrough window that closes only once tmux says it has read the whole frame — or a quarter second later without that — never handing claude tmux's answer", async () => {
      const tmux = fakeTmux(false, 1)
      const { code, out } = await runRelay(FRAMING_CLAUDE_JS, tmux.onOutput)
      expect(code).toBe(0)
      expect(out).toContain(SYNC_ASK + TMUX_READ_ALL_BEFORE)
      expect(out).not.toContain('LEAKED')
      const window = (text: string): string =>
        throughTmux(SYNC_ON) + text + TMUX_READ_ALL_BEFORE + throughTmux(SYNC_OFF)
      expect(out).toContain(window('frame-one'))
      expect(out.indexOf(throughTmux(SYNC_OFF))).toBeGreaterThanOrEqual(tmux.answeredAt[0])
      expect(out).toContain(window('frame-two'))
      expect(count(out, throughTmux(SYNC_OFF))).toBe(2)
    }, 20_000)

    it("under a tmux that takes synchronized output itself (3.7 and later), hands claude tmux's own answer and passes claude's frames through untouched", async () => {
      const { code, out } = await runRelay(FRAMING_CLAUDE_JS, fakeTmux(true, 0).onOutput)
      expect(code).toBe(0)
      expect(out).not.toContain('LEAKED')
      expect(out).toContain(SYNC_ON + 'frame-one' + SYNC_OFF)
      expect(out).toContain(SYNC_ON + 'frame-two' + SYNC_OFF)
      expect(count(out, TMUX_READ_ALL_BEFORE)).toBe(1)
      expect(out).not.toContain(throughTmux(SYNC_ON))
    }, 20_000)
  }
)
