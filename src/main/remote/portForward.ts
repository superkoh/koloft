import fs from 'fs'
import net from 'net'
import path from 'path'
import { writeWholeBeforeVisible } from '../jsonDrops'
import { parseMasterPid } from './browserTunnel'
import type { RunResult } from './ssh'

// PLATFORM§27
const EVERY_ADDRESS_A_MAC_SERVER_MAY_HOLD = ['127.0.0.1', '::1', '::', '0.0.0.0']
const NO_SUCH_ADDRESS_ON_THIS_MAC = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT'])
const FREE_PORT_TRIES = 3

function bindsFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', (e: NodeJS.ErrnoException) =>
      resolve(NO_SUCH_ADDRESS_ON_THIS_MAC.has(e.code ?? ''))
    )
    s.listen({ host, port, exclusive: true }, () => s.close(() => resolve(true)))
  })
}

export async function macPortFree(port: number): Promise<boolean> {
  for (const host of EVERY_ADDRESS_A_MAC_SERVER_MAY_HOLD)
    if (!(await bindsFree(host, port))) return false
  return true
}

function portTheMacHandsOut(): Promise<number | null> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(null))
    s.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

export async function anyFreeMacPort(): Promise<number | null> {
  for (let i = 0; i < FREE_PORT_TRIES; i++) {
    const port = await portTheMacHandsOut()
    if (port !== null && (await macPortFree(port))) return port
  }
  return null
}

const LOOPBACKS_A_BROWSER_TRIES_FOR_LOCALHOST = ['127.0.0.1', '[::1]']

export function pageForwardSpecs(macPort: number, machinePort: number): string[] {
  return LOOPBACKS_A_BROWSER_TRIES_FOR_LOCALHOST.map(
    (bind) => `${bind}:${macPort}:localhost:${machinePort}`
  )
}

export interface PageForwardDeps {
  master(host: string, op: string[]): Promise<RunResult>
  masterOutlivingKoloft(host: string, op: string[]): void
  macPortFree(port: number): Promise<boolean>
  anyFreeMacPort(): Promise<number | null>
  forwardFile(host: string): string
}

interface Forward {
  macPort: number
  specs: string[]
  pages: Set<number>
}

interface Saved {
  pid: string
  specs: string[]
}

interface HostState {
  pid?: string
  forwards: Map<number, Forward>
  queue: Promise<unknown>
  leftoversCleared: boolean
}

export class PageForwards {
  private hosts = new Map<string, HostState>()

  constructor(private deps: PageForwardDeps) {}

  private stateOf(host: string): HostState {
    let st = this.hosts.get(host)
    if (!st) {
      st = { forwards: new Map(), queue: Promise.resolve(), leftoversCleared: false }
      this.hosts.set(host, st)
    }
    return st
  }

  private inTurn<T>(st: HostState, work: () => Promise<T>): Promise<T> {
    const run = st.queue.then(work, work)
    st.queue = run.catch(() => {})
    return run
  }

  macPortFor(
    host: string,
    machinePort: number,
    page: number,
    askMaster: boolean
  ): Promise<number | null> {
    const st = this.stateOf(host)
    const known = st.forwards.get(machinePort)
    if (known && !askMaster) {
      known.pages.add(page)
      return Promise.resolve(known.macPort)
    }
    const handedOut = [...st.forwards].find(
      ([there, f]) => f.macPort === machinePort && there !== machinePort
    )?.[1]
    if (handedOut) {
      handedOut.pages.add(page)
      return Promise.resolve(machinePort)
    }
    return this.inTurn(st, () => this.reach(host, st, machinePort, page))
  }

  carries(page: number, macPort: number): boolean {
    for (const st of this.hosts.values())
      for (const f of st.forwards.values())
        if (f.macPort === macPort && f.pages.has(page)) return true
    return false
  }

  checkMaster(host: string): Promise<void> {
    const st = this.stateOf(host)
    if (st.leftoversCleared && !st.forwards.size) return Promise.resolve()
    return this.inTurn(st, async () => {
      const pid = await this.livePid(host)
      if (!pid) return
      await this.cancelLeftovers(host, st, pid)
      this.forgetForwardsOfAnOldMaster(host, st, pid)
    })
  }

  pageGone(page: number): void {
    for (const [host, st] of this.hosts) {
      for (const [machinePort, f] of st.forwards) {
        if (!f.pages.delete(page) || f.pages.size) continue
        st.forwards.delete(machinePort)
        this.save(host, st)
        void this.inTurn(st, () => this.cancel(host, f.specs))
      }
    }
  }

  cancelOnQuit(): void {
    for (const [host, st] of this.hosts)
      for (const f of st.forwards.values())
        for (const spec of f.specs)
          this.deps.masterOutlivingKoloft(host, ['-O', 'cancel', '-L', spec])
  }

  private async livePid(host: string): Promise<string | null> {
    return parseMasterPid((await this.deps.master(host, ['-O', 'check'])).stderr)
  }

  private async cancel(host: string, specs: string[]): Promise<void> {
    for (const spec of specs) await this.deps.master(host, ['-O', 'cancel', '-L', spec])
  }

  private async cancelLeftovers(host: string, st: HostState, pid: string): Promise<void> {
    if (st.leftoversCleared) return
    st.leftoversCleared = true
    const saved = this.load(host)
    if (saved?.pid === pid) await this.cancel(host, saved.specs)
    if (saved) this.save(host, st)
  }

  private forgetForwardsOfAnOldMaster(host: string, st: HostState, pid: string): void {
    if (st.pid === pid) return
    st.pid = pid
    st.forwards.clear()
    this.save(host, st)
  }

  // ADR-0046 PLATFORM§33
  private async reach(
    host: string,
    st: HostState,
    machinePort: number,
    page: number
  ): Promise<number | null> {
    const pid = await this.livePid(host)
    if (!pid) return null
    await this.cancelLeftovers(host, st, pid)
    this.forgetForwardsOfAnOldMaster(host, st, pid)
    const f = st.forwards.get(machinePort) ?? (await this.add(host, st, machinePort))
    f?.pages.add(page)
    return f?.macPort ?? null
  }

  private async add(host: string, st: HostState, machinePort: number): Promise<Forward | null> {
    let macPort = (await this.deps.macPortFree(machinePort))
      ? machinePort
      : await this.deps.anyFreeMacPort()
    for (let tries = 2; macPort !== null && tries > 0; tries--) {
      const specs = pageForwardSpecs(macPort, machinePort)
      if (await this.forwardAll(host, specs)) {
        const f: Forward = { macPort, specs, pages: new Set() }
        st.forwards.set(machinePort, f)
        this.save(host, st)
        return f
      }
      macPort = await this.deps.anyFreeMacPort()
    }
    return null
  }

  private async forwardAll(host: string, specs: string[]): Promise<boolean> {
    for (const [i, spec] of specs.entries()) {
      if ((await this.deps.master(host, ['-O', 'forward', '-L', spec])).code === 0) continue
      await this.cancel(host, specs.slice(0, i))
      return false
    }
    return true
  }

  private load(host: string): Saved | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.deps.forwardFile(host), 'utf8')) as Saved
    } catch {
      return undefined
    }
  }

  private save(host: string, st: HostState): void {
    const file = this.deps.forwardFile(host)
    try {
      if (!st.forwards.size || !st.pid) return fs.rmSync(file, { force: true })
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const specs = [...st.forwards.values()].flatMap((f) => f.specs)
      const saved: Saved = { pid: st.pid, specs }
      writeWholeBeforeVisible(file, JSON.stringify(saved))
    } catch {}
  }
}
