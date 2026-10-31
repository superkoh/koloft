import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import {
  PageForwards,
  macPortFree,
  pageForwardSpec,
  type PageForwardDeps
} from '../../src/main/remote/portForward'
import type { RunResult } from '../../src/main/remote/ssh'

const HOST = 'devbox'
const PAGE_A = 11
const PAGE_B = 12
const ok = (stderr = ''): RunResult => ({ code: 0, stdout: '', stderr })
const PORT_TAKEN: RunResult = { code: 255, stdout: '', stderr: 'Port forwarding failed' }

interface Machine {
  pid: string | null
  live: Set<string>
  takenOnMac: Set<number>
  nextFreePort: number
  ops: string[]
  outlivingKoloft: string[]
}

let dir: string
let m: Machine
let deps: PageForwardDeps

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-page-forward-'))
  m = {
    pid: '4242',
    live: new Set(),
    takenOnMac: new Set(),
    nextFreePort: 61000,
    ops: [],
    outlivingKoloft: []
  }
  deps = {
    master: async (_host, op) => {
      m.ops.push(op.join(' '))
      if (op[1] === 'check')
        return m.pid ? ok(`Master running (pid=${m.pid})\r\n`) : { ...PORT_TAKEN, stderr: '' }
      const spec = op[3]
      const macPort = Number(spec.split(':')[1])
      if (op[1] === 'forward') {
        if (m.takenOnMac.has(macPort)) return PORT_TAKEN
        m.live.add(spec)
        m.takenOnMac.add(macPort)
      } else if (m.live.delete(spec)) m.takenOnMac.delete(macPort)
      return ok()
    },
    masterOutlivingKoloft: (_host, op) => {
      m.outlivingKoloft.push(op.join(' '))
    },
    macPortFree: async (port) => !m.takenOnMac.has(port),
    anyFreeMacPort: async () => m.nextFreePort++,
    forwardFile: (host) => path.join(dir, host, 'page-forwards.json')
  }
})

describe('PageForwards', () => {
  it('forwards a machine port to the same port on the Mac while it is free there, and asks the master only once for a page’s later requests', async () => {
    const f = new PageForwards(deps)
    expect(await f.macPortFor(HOST, 5173, PAGE_A, true)).toBe(5173)
    expect([...m.live]).toEqual([pageForwardSpec(5173, 5173)])
    const asked = m.ops.length
    expect(await f.macPortFor(HOST, 5173, PAGE_A, false)).toBe(5173)
    expect(m.ops.length).toBe(asked)
  })

  it('picks another Mac port when the same one is taken on the Mac, and lets that Mac port through as it is', async () => {
    m.takenOnMac.add(5173)
    const f = new PageForwards(deps)
    expect(await f.macPortFor(HOST, 5173, PAGE_A, true)).toBe(61000)
    expect([...m.live]).toEqual([pageForwardSpec(61000, 5173)])
    expect(await f.macPortFor(HOST, 61000, PAGE_A, true)).toBe(61000)
    expect([...m.live]).toEqual([pageForwardSpec(61000, 5173)])
  })

  it('tries one more Mac port when ssh finds the free one taken by the time it binds', async () => {
    const f = new PageForwards({ ...deps, macPortFree: async () => true })
    m.takenOnMac.add(5173)
    expect(await f.macPortFor(HOST, 5173, PAGE_A, true)).toBe(61000)
  })

  it('reaches nothing while the machine has no live ssh connection', async () => {
    m.pid = null
    const f = new PageForwards(deps)
    expect(await f.macPortFor(HOST, 5173, PAGE_A, true)).toBeNull()
    expect(m.live.size).toBe(0)
  })

  it('cancels the forward with the exact spec it was asked with once the last page using it is gone', async () => {
    const f = new PageForwards(deps)
    await f.macPortFor(HOST, 5173, PAGE_A, true)
    await f.macPortFor(HOST, 5173, PAGE_B, true)
    f.pageGone(PAGE_A)
    await f.clearLeftovers(HOST)
    expect(m.live.size).toBe(1)
    f.pageGone(PAGE_B)
    await f.clearLeftovers(HOST)
    expect(m.live.size).toBe(0)
    expect(m.ops).toContain(`-O cancel -L ${pageForwardSpec(5173, 5173)}`)
    expect(fs.existsSync(deps.forwardFile(HOST))).toBe(false)
  })

  it('adds the forward again when the ssh connection was replaced, since the old one took its forwards with it', async () => {
    const f = new PageForwards(deps)
    await f.macPortFor(HOST, 5173, PAGE_A, true)
    m.pid = '5151'
    m.live.clear()
    m.takenOnMac.clear()
    expect(await f.macPortFor(HOST, 5173, PAGE_A, true)).toBe(5173)
    expect([...m.live]).toEqual([pageForwardSpec(5173, 5173)])
  })

  it('cancels its forwards on quit with ssh commands that outlive Koloft', async () => {
    const f = new PageForwards(deps)
    await f.macPortFor(HOST, 5173, PAGE_A, true)
    f.cancelOnQuit()
    expect(m.outlivingKoloft).toEqual([`-O cancel -L ${pageForwardSpec(5173, 5173)}`])
  })

  it('cancels the forwards a crashed Koloft left on the same ssh connection before it forwards anything', async () => {
    await new PageForwards(deps).macPortFor(HOST, 5173, PAGE_A, true)
    const after = new PageForwards(deps)
    await after.clearLeftovers(HOST)
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
