import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import {
  PageForwards,
  macPortFree,
  pageForwardSpecs,
  type PageForwardDeps
} from '../../src/main/remote/portForward'
import type { RunResult } from '../../src/main/remote/ssh'

const HOST = 'devbox'
const PAGE_A = 11
const PAGE_B = 12
const ok = (stderr = ''): RunResult => ({ code: 0, stdout: '', stderr })
const PORT_TAKEN: RunResult = { code: 255, stdout: '', stderr: 'Port forwarding failed' }
const NO_MASTER: RunResult = {
  code: 255,
  stdout: '',
  stderr: 'Control socket connect: No such file'
}

interface Machine {
  pid: string | null
  live: Set<string>
  heldByOthers: Set<string>
  nextFreePort: number
  ops: string[]
  outlivingKoloft: string[]
}

let dir: string
let m: Machine
let deps: PageForwardDeps

const bindOf = (spec: string): string => spec.replace(/:\d+:localhost:\d+$/, '')
const macPortOf = (spec: string): number => Number(/:(\d+):localhost:/.exec(spec)?.[1])
const keyOf = (spec: string): string => `${bindOf(spec)} ${macPortOf(spec)}`
const takenOnMac = (port: number): boolean =>
  [...m.heldByOthers, ...[...m.live].map(keyOf)].some((k) => k.endsWith(` ${port}`))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-page-forward-'))
  m = {
    pid: '4242',
    live: new Set(),
    heldByOthers: new Set(),
    nextFreePort: 61000,
    ops: [],
    outlivingKoloft: []
  }
  deps = {
    master: async (_host, op) => {
      m.ops.push(op.join(' '))
      if (op[1] === 'check') return m.pid ? ok(`Master running (pid=${m.pid})\r\n`) : NO_MASTER
      const spec = op[3]
      if (op[1] === 'cancel') {
        m.live.delete(spec)
        return ok()
      }
      if (m.heldByOthers.has(keyOf(spec)) || [...m.live].some((s) => keyOf(s) === keyOf(spec)))
        return PORT_TAKEN
      m.live.add(spec)
      return ok()
    },
    masterOutlivingKoloft: (_host, op) => {
      m.outlivingKoloft.push(op.join(' '))
    },
    macPortFree: async (port) => !takenOnMac(port),
    anyFreeMacPort: async () => m.nextFreePort++,
    forwardFile: (host) => path.join(dir, host, 'page-forwards.json')
  }
})

describe('PageForwards', () => {
  it('forwards a machine port to the same port on the Mac, on both loopback addresses a browser tries for localhost, and asks the master only once for a page’s later requests', async () => {
    const f = new PageForwards(deps)
    expect(await f.macPortFor(HOST, 5173, PAGE_A, true)).toBe(5173)
    expect([...m.live]).toEqual(pageForwardSpecs(5173, 5173))
    expect(pageForwardSpecs(5173, 5173)).toEqual([
      '127.0.0.1:5173:localhost:5173',
      '[::1]:5173:localhost:5173'
    ])
    const asked = m.ops.length
    expect(await f.macPortFor(HOST, 5173, PAGE_A, false)).toBe(5173)
    expect(m.ops.length).toBe(asked)
  })

  it('picks another Mac port when the same one is taken on the Mac, and lets that Mac port through as it is, counting the page that used it', async () => {
    m.heldByOthers.add('127.0.0.1 5173')
    const f = new PageForwards(deps)
    expect(await f.macPortFor(HOST, 5173, PAGE_A, true)).toBe(61000)
    expect([...m.live]).toEqual(pageForwardSpecs(61000, 5173))
    expect(await f.macPortFor(HOST, 61000, PAGE_B, true)).toBe(61000)
    f.pageGone(PAGE_A)
    await f.checkMaster(HOST)
    expect([...m.live]).toEqual(pageForwardSpecs(61000, 5173))
    expect(f.carries(PAGE_B, 61000)).toBe(true)
  })

  it('takes back the half it added and tries another Mac port when ssh finds one address of the free port taken by the time it binds', async () => {
    const f = new PageForwards({ ...deps, macPortFree: async () => true })
    m.heldByOthers.add('[::1] 5173')
    expect(await f.macPortFor(HOST, 5173, PAGE_A, true)).toBe(61000)
    expect([...m.live]).toEqual(pageForwardSpecs(61000, 5173))
  })

  it('reaches nothing while the machine has no live ssh connection', async () => {
    m.pid = null
    const f = new PageForwards(deps)
    expect(await f.macPortFor(HOST, 5173, PAGE_A, true)).toBeNull()
    expect(m.live.size).toBe(0)
  })

  it('cancels the forward with the exact specs it was asked with once the last page using it is gone', async () => {
    const f = new PageForwards(deps)
    await f.macPortFor(HOST, 5173, PAGE_A, true)
    await f.macPortFor(HOST, 5173, PAGE_B, true)
    expect(f.carries(PAGE_A, 5173)).toBe(true)
    f.pageGone(PAGE_A)
    await f.checkMaster(HOST)
    expect(m.live.size).toBe(2)
    expect(f.carries(PAGE_A, 5173)).toBe(false)
    f.pageGone(PAGE_B)
    await expect.poll(() => m.live.size).toBe(0)
    for (const spec of pageForwardSpecs(5173, 5173)) expect(m.ops).toContain(`-O cancel -L ${spec}`)
    expect(fs.existsSync(deps.forwardFile(HOST))).toBe(false)
  })

  it('forgets its forwards once a check finds the ssh connection replaced, since the old one took them with it, and adds them again on the next request', async () => {
    const f = new PageForwards(deps)
    await f.macPortFor(HOST, 5173, PAGE_A, true)
    m.pid = '5151'
    m.live.clear()
    await f.checkMaster(HOST)
    expect(f.carries(PAGE_A, 5173)).toBe(false)
    expect(await f.macPortFor(HOST, 5173, PAGE_A, false)).toBe(5173)
    expect([...m.live]).toEqual(pageForwardSpecs(5173, 5173))
  })

  it('cancels its forwards on quit with ssh commands that outlive Koloft', async () => {
    const f = new PageForwards(deps)
    await f.macPortFor(HOST, 5173, PAGE_A, true)
    f.cancelOnQuit()
    expect(m.outlivingKoloft).toEqual(
      pageForwardSpecs(5173, 5173).map((spec) => `-O cancel -L ${spec}`)
    )
  })

  it('cancels the forwards a crashed Koloft left on the same ssh connection before it forwards anything', async () => {
    await new PageForwards(deps).macPortFor(HOST, 5173, PAGE_A, true)
    const after = new PageForwards(deps)
    await after.checkMaster(HOST)
    expect(m.live.size).toBe(0)
    expect(await after.macPortFor(HOST, 5173, PAGE_B, true)).toBe(5173)
  })
})

describe('macPortFree', () => {
  const holdOn = (host: string): Promise<net.Server> =>
    new Promise((resolve) => {
      const s = net.createServer()
      s.listen({ host, port: 0 }, () => resolve(s))
    })

  for (const host of ['127.0.0.1', '::1', '::', '0.0.0.0'])
    it(`reads a port as taken when a Mac server listens on it at ${host} only`, async () => {
      const s = await holdOn(host)
      try {
        expect(await macPortFree((s.address() as net.AddressInfo).port)).toBe(false)
      } finally {
        s.close()
      }
    })
})
