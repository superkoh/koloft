import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import {
  StatusTails,
  TAIL_RECONNECT_MS,
  statusTailCmd,
  type TailProcess
} from '../../src/main/remote/statusTail'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-tail-'))
})
afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(root, { recursive: true, force: true })
})

interface FakeTail extends TailProcess {
  host: string
  cmd: string
  send(text: string): void
  end(): void
  killed: boolean
}

function fakes(): { started: FakeTail[]; tails: StatusTails; mirror: string } {
  const started: FakeTail[] = []
  const mirror = path.join(root, 'mirror')
  const tails = new StatusTails({
    mirrorDir: () => mirror,
    spawn: (host, cmd) => {
      let data: (c: Buffer) => void = () => {}
      let exit: () => void = () => {}
      const t: FakeTail = {
        host,
        cmd,
        killed: false,
        onData: (cb) => (data = cb),
        onExit: (cb) => (exit = cb),
        kill: () => {
          t.killed = true
          exit()
        },
        send: (text) => data(Buffer.from(text)),
        end: () => exit()
      }
      started.push(t)
      return t
    }
  })
  return { started, tails, mirror }
}

describe('the live status stream of a remote tab', () => {
  it('appends what the machine streams to the mirrored status log, and after a dropped link picks up after the last byte it has', async () => {
    vi.useFakeTimers()
    const { started, tails, mirror } = fakes()
    tails.follow([{ tabId: 'pty-1', host: 'devbox' }])
    expect(started).toHaveLength(1)
    expect(started[0].cmd).toBe(statusTailCmd('pty-1', 1))

    started[0].send('{"event":"prompt"}\n')
    started[0].end()
    await vi.advanceTimersByTimeAsync(TAIL_RECONNECT_MS)
    const log = path.join(mirror, 'pty-1.status.jsonl')
    const have = fs.statSync(log).size
    expect(started).toHaveLength(2)
    expect(started[1].cmd).toBe(statusTailCmd('pty-1', have + 1))

    started[1].send('{"event":"stop"}\n')
    expect(fs.readFileSync(log, 'utf8')).toBe('{"event":"prompt"}\n{"event":"stop"}\n')
  })

  it('stops streaming when the tab goes, and does not reconnect after', async () => {
    vi.useFakeTimers()
    const { started, tails } = fakes()
    tails.follow([{ tabId: 'pty-1', host: 'devbox' }])
    tails.follow([])
    expect(started[0].killed).toBe(true)
    await vi.advanceTimersByTimeAsync(TAIL_RECONNECT_MS * 3)
    expect(started).toHaveLength(1)
  })

  it('the command follows the log from the byte asked for, even before the file exists and across its re-creation', async () => {
    const home = path.join(root, 'home')
    const dir = path.join(home, '.koloft', 'hook-sessions')
    fs.mkdirSync(dir, { recursive: true })
    const log = path.join(dir, 'pty-1.status.jsonl')
    fs.writeFileSync(log, 'one\ntwo\n')
    const c = spawn('/bin/sh', ['-c', statusTailCmd('pty-1', 5)], {
      env: { HOME: home, PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    let out = ''
    c.stdout.on('data', (d) => (out += String(d)))
    const until = async (want: string): Promise<void> => {
      const end = Date.now() + 10_000
      while (!out.endsWith(want) && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
    }
    try {
      await until('two\n')
      fs.appendFileSync(log, 'three\n')
      await until('three\n')
      fs.rmSync(log)
      await new Promise((r) => setTimeout(r, 1500))
      fs.writeFileSync(log, 'fresh\n')
      await until('fresh\n')
      expect(out).toBe('two\nthree\nfresh\n')
    } finally {
      c.kill()
    }
  }, 30_000)
})
