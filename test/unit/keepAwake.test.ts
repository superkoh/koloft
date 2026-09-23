import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyKeepAwake, CAFFEINATE_ARGS, keepAwakeHeld } from '../../src/main/keepAwake'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-keepawake-'))
const argvFile = path.join(dir, 'argv.txt')
fs.writeFileSync(
  path.join(dir, 'caffeinate'),
  `#!/bin/sh\necho "$$ $*" > "${argvFile}"\nexec sleep 300\n`,
  { mode: 0o755 }
)
const origPath = process.env.PATH

const isMac = process.platform === 'darwin'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function recorded(): Promise<{ pid: number; args: string }> {
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(argvFile)) {
      const [pid, ...rest] = fs.readFileSync(argvFile, 'utf8').trim().split(' ')
      if (pid) return { pid: Number(pid), args: rest.join(' ') }
    }
    await new Promise((r) => setTimeout(r, 40))
  }
  throw new Error('fake caffeinate never ran')
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 50 && !cond(); i++) await new Promise((r) => setTimeout(r, 40))
  expect(cond()).toBe(true)
}

beforeAll(() => {
  process.env.PATH = `${dir}:${origPath}`
})
afterEach(() => {
  applyKeepAwake(false)
  fs.rmSync(argvFile, { force: true })
})
afterAll(() => {
  process.env.PATH = origPath
})

describe.runIf(isMac)('applyKeepAwake (the caffeinate hold)', () => {
  it('ON spawns caffeinate for display, idle, disk and system sleep, tied to our pid', async () => {
    applyKeepAwake(true)
    const { pid, args } = await recorded()
    expect(args).toBe(CAFFEINATE_ARGS.join(' '))
    expect(CAFFEINATE_ARGS).toEqual(['-dims', '-w', String(process.pid)])
    expect(alive(pid)).toBe(true)
    expect(keepAwakeHeld()).toBe(true)
  })

  it('OFF kills the child at once, and a second OFF is a no-op', async () => {
    applyKeepAwake(true)
    const { pid } = await recorded()
    applyKeepAwake(false)
    await until(() => !alive(pid))
    expect(keepAwakeHeld()).toBe(false)
    expect(() => applyKeepAwake(false)).not.toThrow()
  })

  it('ON twice holds one child, not two', async () => {
    applyKeepAwake(true)
    const first = await recorded()
    fs.rmSync(argvFile)
    applyKeepAwake(true)
    await new Promise((r) => setTimeout(r, 200))
    expect(fs.existsSync(argvFile)).toBe(false)
    expect(alive(first.pid)).toBe(true)
  })

  it('forgets a child that died on its own, so the next ON can spawn again', async () => {
    applyKeepAwake(true)
    const first = await recorded()
    process.kill(first.pid, 'SIGKILL')
    await until(() => !keepAwakeHeld())
    fs.rmSync(argvFile)
    applyKeepAwake(true)
    const second = await recorded()
    expect(second.pid).not.toBe(first.pid)
    expect(alive(second.pid)).toBe(true)
  })
})
