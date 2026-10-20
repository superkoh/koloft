import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ownerTyped, ResourceGuard } from '../../src/main/resourceGuard'
import { BUSY_MARKER } from '../../src/main/machineRoom'
import type { TaggedProcess } from '../../src/main/machineTrees'

let regDir: string

beforeEach(() => {
  regDir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-guard-'))
})

afterEach(() => {
  fs.rmSync(regDir, { recursive: true, force: true })
})

const proc = (
  pid: number,
  ppid: number,
  tab: string | undefined,
  opts: Partial<TaggedProcess> = {}
): TaggedProcess => ({
  pid,
  ppid,
  tab,
  rssBytes: 100 * 2 ** 20,
  cpuPercent: 0,
  agent: false,
  vm: false,
  ...opts
})

function setup(rows: TaggedProcess[]) {
  const reading = { pressure: 2, load1: 1 }
  const ways: string[] = []
  const clock = { now: 1_000_000 }
  const guard = new ResourceGuard({
    regDir,
    cores: 10,
    read: async () => reading,
    now: () => clock.now,
    log: () => {},
    heldDirs: () => [],
    freeOnMachine: async () => {},
    isRemote: (tab) => tab === 'remote',
    changed: () => {},
    readTrees: async () => rows,
    giveWay: async (pid, on) => {
      ways.push(`${on ? '-b' : '-B'} ${pid}`)
    }
  })
  return { guard, ways, reading, clock }
}

const busyMarked = (): boolean => fs.existsSync(path.join(regDir, BUSY_MARKER))

describe('giving way while the machine is busy', () => {
  it('slows only the tools of background sessions, never the agent program itself nor the owner’s sessions', async () => {
    const rows = [
      proc(10, 1, 'bg', { agent: true }),
      proc(11, 10, undefined, { cpuPercent: 300 }),
      proc(20, 1, 'mine', { agent: true }),
      proc(21, 20, undefined, { cpuPercent: 300 })
    ]
    const { guard, ways } = setup(rows)
    guard.launchInBackground(
      { tabId: 'bg', kind: 'claude', cwd: '/w', title: 't' },
      async () => 'bg'
    )
    await guard.tick()
    expect(ways).toEqual(['-b 11'])
  })

  it('a tool already slowed is not slowed again, and every slowed tool is lifted once the machine is roomy', async () => {
    const { guard, ways, reading, clock } = setup([
      proc(10, 1, 'bg', { agent: true }),
      proc(11, 10, undefined, { cpuPercent: 300 })
    ])
    guard.launchInBackground(
      { tabId: 'bg', kind: 'claude', cwd: '/w', title: 't' },
      async () => 'bg'
    )
    await guard.tick()
    await guard.tick()
    expect(ways).toEqual(['-b 11'])
    reading.pressure = 1
    for (let i = 0; i < 20; i++) {
      clock.now += 5_000
      await guard.tick()
    }
    expect(guard.room.busy).toBe(false)
    expect(ways).toEqual(['-b 11', '-B 11'])
  })

  it('a slowed tool that later drops out of the tree, or a ps read that fails, is still lifted when the machine is roomy', async () => {
    const rows = [proc(10, 1, 'bg', { agent: true }), proc(11, 10, undefined, { cpuPercent: 300 })]
    const { guard, ways, reading, clock } = setup(rows)
    guard.launchInBackground(
      { tabId: 'bg', kind: 'claude', cwd: '/w', title: 't' },
      async () => 'bg'
    )
    await guard.tick()
    rows.splice(1, 1, proc(11, 1, undefined, { cpuPercent: 300 }))
    await guard.tick()
    rows.splice(0, rows.length)
    await guard.tick()
    reading.pressure = 1
    for (let i = 0; i < 20; i++) {
      clock.now += 5_000
      await guard.tick()
    }
    expect(ways).toEqual(['-b 11', '-B 11'])
  })

  it('the owner freeing a background session lifts its tools at once', async () => {
    const { guard, ways } = setup([
      proc(10, 1, 'bg', { agent: true }),
      proc(11, 10, undefined, { cpuPercent: 300 })
    ])
    guard.launchInBackground(
      { tabId: 'bg', kind: 'claude', cwd: '/w', title: 't' },
      async () => 'bg'
    )
    await guard.tick()
    await guard.free('bg')
    expect(ways).toEqual(['-b 11', '-B 11'])
    expect(fs.existsSync(path.join(regDir, 'bg.free'))).toBe(true)
  })

  it('a session started on a remote machine never queues for this Mac, yet still counts as background there', async () => {
    const { guard } = setup([])
    await guard.tick()
    const turn = guard.launchInBackground(
      { tabId: 'remote', kind: 'claude', cwd: 'ssh://box/srv', title: 't' },
      async () => 'remote',
      false
    )
    expect(turn.queued).toBe(false)
    expect(await turn.outcome).toBe('started')
    expect(guard.isBackground('remote')).toBe(true)
  })

  it('a remote session’s tools run on its own machine, so nothing here is slowed for it', async () => {
    const { guard, ways } = setup([proc(30, 1, 'remote', { cpuPercent: 300 })])
    guard.launchInBackground(
      { tabId: 'remote', kind: 'claude', cwd: '/w', title: 't' },
      async () => 'remote'
    )
    await guard.tick()
    expect(ways).toEqual([])
  })
})

describe('holding only while background work is what keeps the machine busy', () => {
  it('holds while background tools use a core or more', async () => {
    const { guard } = setup([
      proc(10, 1, 'bg', { agent: true }),
      proc(11, 10, undefined, { cpuPercent: 150 })
    ])
    guard.launchInBackground(
      { tabId: 'bg', kind: 'claude', cwd: '/w', title: 't' },
      async () => 'bg'
    )
    await guard.tick()
    expect(guard.room.holding).toBe(true)
    expect(busyMarked()).toBe(true)
  })

  it('lets held work go, one at a time, when the machine is busy but no background tool is working', async () => {
    const { guard } = setup([proc(10, 1, 'bg', { agent: true }), proc(11, 10, undefined)])
    guard.launchInBackground(
      { tabId: 'bg', kind: 'claude', cwd: '/w', title: 't' },
      async () => 'bg'
    )
    await guard.tick()
    expect(guard.room.busy).toBe(true)
    expect(guard.room.holding).toBe(false)
    expect(busyMarked()).toBe(false)
  })
})

describe('what counts as the owner typing into a session', () => {
  it('a key the owner types counts; the terminal’s own replies, mouse and focus reports do not', () => {
    expect(ownerTyped('a')).toBe(true)
    expect(ownerTyped('\r')).toBe(true)
    expect(ownerTyped('\x1b[I')).toBe(false)
    expect(ownerTyped('\x1b[12;40R')).toBe(false)
    expect(ownerTyped('\x1b[<0;10;5M')).toBe(false)
    expect(ownerTyped('\x1b[M !!')).toBe(false)
    expect(ownerTyped('\x1bP1$r0m\x1b\\')).toBe(false)
    expect(ownerTyped('\x1b]11;rgb:0000/0000/0000\x07')).toBe(false)
  })
})
