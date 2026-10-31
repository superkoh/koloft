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

function portTheMacHandsOut(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

export async function anyFreeMacPort(): Promise<number | null> {
  for (let i = 0; i < FREE_PORT_TRIES; i++) {
    const port = await portTheMacHandsOut()
    if (await macPortFree(port)) return port
  }
  return null
}

export function pageForwardSpec(macPort: number, machinePort: number): string {
  return `127.0.0.1:${macPort}:localhost:${machinePort}`
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
  spec: string
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
    if ([...st.forwards].some(([there, f]) => f.macPort === machinePort && there !== machinePort))
      return Promise.resolve(machinePort)
    return this.inTurn(st, () => this.reach(host, st, machinePort, page))
  }

  clearLeftovers(host: string): Promise<void> {
    const st = this.stateOf(host)
    if (st.leftoversCleared) return Promise.resolve()
    return this.inTurn(st, async () => {
      const pid = await this.livePid(host)
      if (pid) await this.cancelLeftovers(host, st, pid)
    })
  }

  pageGone(page: number): void {
    for (const [host, st] of this.hosts) {
      for (const [machinePort, f] of st.forwards) {
        if (!f.pages.delete(page) || f.pages.size) continue
        st.forwards.delete(machinePort)
        this.save(host, st)
        void this.inTurn(st, () => this.deps.master(host, ['-O', 'cancel', '-L', f.spec]))
      }
    }
  }

  cancelOnQuit(): void {
    for (const [host, st] of this.hosts)
      for (const f of st.forwards.values())
        this.deps.masterOutlivingKoloft(host, ['-O', 'cancel', '-L', f.spec])
  }

  private async livePid(host: string): Promise<string | null> {
    return parseMasterPid((await this.deps.master(host, ['-O', 'check'])).stderr)
  }

  private async cancelLeftovers(host: string, st: HostState, pid: string): Promise<void> {
    if (st.leftoversCleared) return
    st.leftoversCleared = true
    const saved = this.load(host)
    if (saved?.pid === pid)
      for (const spec of saved.specs) await this.deps.master(host, ['-O', 'cancel', '-L', spec])
    if (saved) this.save(host, st)
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
    if (st.pid !== pid) {
      st.pid = pid
      st.forwards.clear()
    }
    const f = st.forwards.get(machinePort) ?? (await this.add(host, st, machinePort))
    f?.pages.add(page)
    return f?.macPort ?? null
  }

  private async add(host: string, st: HostState, machinePort: number): Promise<Forward | null> {
    let macPort = (await this.deps.macPortFree(machinePort))
      ? machinePort
      : await this.deps.anyFreeMacPort()
    for (let tries = 2; macPort !== null && tries > 0; tries--) {
      const spec = pageForwardSpec(macPort, machinePort)
      if ((await this.deps.master(host, ['-O', 'forward', '-L', spec])).code === 0) {
        const f: Forward = { macPort, spec, pages: new Set() }
        st.forwards.set(machinePort, f)
        this.save(host, st)
        return f
      }
      macPort = await this.deps.anyFreeMacPort()
    }
    return null
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
      const saved: Saved = { pid: st.pid, specs: [...st.forwards.values()].map((f) => f.spec) }
      writeWholeBeforeVisible(file, JSON.stringify(saved))
    } catch {}
  }
}
