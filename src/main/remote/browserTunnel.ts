import fs from 'fs'
import path from 'path'
import { writeWholeBeforeVisible } from '../jsonDrops'
import { remoteShCommand } from './install'
import { REMOTE_TABS_DIR, remoteBrowserAddressFile } from './paths'
import type { RunResult } from './ssh'

export function machineAddress(endpoint: string, machinePort: number): string {
  return `ws://127.0.0.1:${machinePort}${new URL(endpoint).pathname}`
}

// PLATFORM§33
export function parseMasterPid(stderr: string): string | null {
  return /Master running \(pid=(\d+)\)/.exec(stderr)?.[1] ?? null
}

// PLATFORM§33
const SSHD_REFUSES_FORWARDING = /remote port forwarding failed/

const forwardSpec = (relayPort: number): string => `0:127.0.0.1:${relayPort}`

export function addressFilesCmd(files: [tabId: string, address: string][]): string {
  const f = remoteBrowserAddressFile('$1')
  return remoteShCommand(
    `umask 077; mkdir -p "${REMOTE_TABS_DIR}" || exit 1
while [ $# -gt 1 ]; do
  if [ -n "$2" ]; then printf '%s' "$2" > "${f}.part" && mv -f "${f}.part" "${f}" || exit 1
  else rm -f "${f}"; fi
  shift 2
done`,
    files.flat()
  )
}

export interface MachineForward {
  pid: string
  spec: string
  port: number
}

export interface BrowserTunnelDeps {
  master(host: string, op: string[]): Promise<RunResult>
  masterOutlivingKoloft(host: string, op: string[]): void
  run(host: string, cmd: string): Promise<RunResult>
  forwardFile(host: string): string
}

export interface TunnelTab {
  tabId: string
  endpoint: string
}

interface HostState {
  forward?: MachineForward
  refused?: string
  written: Map<string, string>
  busy: boolean
}

export class BrowserTunnels {
  private hosts = new Map<string, HostState>()
  private noForwardLeft = new Set<string>()

  constructor(private deps: BrowserTunnelDeps) {}

  cancelOnQuit(): void {
    for (const [host, st] of this.hosts)
      if (st.forward) this.deps.masterOutlivingKoloft(host, ['-O', 'cancel', '-R', st.forward.spec])
  }

  private load(host: string): MachineForward | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.deps.forwardFile(host), 'utf8')) as MachineForward
    } catch {
      return undefined
    }
  }

  private save(host: string, forward: MachineForward | undefined): void {
    const file = this.deps.forwardFile(host)
    try {
      if (!forward) return fs.rmSync(file, { force: true })
      fs.mkdirSync(path.dirname(file), { recursive: true })
      writeWholeBeforeVisible(file, JSON.stringify(forward))
    } catch {}
  }

  async sync(host: string, tabs: TunnelTab[]): Promise<void> {
    let st = this.hosts.get(host)
    if (!st) {
      if (!tabs.length && this.noForwardLeft.has(host)) return
      const forward = this.load(host)
      if (!tabs.length && !forward) return void this.noForwardLeft.add(host)
      this.hosts.set(host, (st = { forward, written: new Map(), busy: false }))
    }
    if (!tabs.some((t) => t.endpoint) && !st.forward && !st.written.size) {
      if (!tabs.length) this.hosts.delete(host)
      return
    }
    if (st.busy) return
    st.busy = true
    try {
      await this.syncHost(host, st, tabs)
    } finally {
      st.busy = false
      if (!tabs.length && !st.forward && !st.written.size) this.hosts.delete(host)
    }
  }

  // PLATFORM§33
  private async syncHost(host: string, st: HostState, tabs: TunnelTab[]): Promise<void> {
    const pid = parseMasterPid((await this.deps.master(host, ['-O', 'check'])).stderr)
    if (!pid) return
    const endpoint = tabs.find((t) => t.endpoint)?.endpoint
    const spec = endpoint ? forwardSpec(Number(new URL(endpoint).port)) : ''
    let forward = st.forward?.pid === pid ? st.forward : undefined
    if (forward && forward.spec !== spec) {
      if ((await this.deps.master(host, ['-O', 'cancel', '-R', forward.spec])).code !== 0) return
      forward = undefined
    }
    const asked = `${pid} ${spec}`
    if (!forward && spec && st.refused !== asked) {
      await this.deps.master(host, ['-O', 'cancel', '-R', spec])
      const r = await this.deps.master(host, ['-O', 'forward', '-R', spec])
      const port = Number(r.stdout.trim())
      if (r.code === 0 && port > 0) forward = { pid, spec, port }
      else if (SSHD_REFUSES_FORWARDING.test(r.stderr)) st.refused = asked
    }
    if (forward !== st.forward) {
      st.forward = forward
      this.save(host, forward)
    }
    const want = new Map(
      forward
        ? tabs.flatMap((t) =>
            t.endpoint ? [[t.tabId, machineAddress(t.endpoint, forward.port)] as const] : []
          )
        : []
    )
    const changes: [string, string][] = [
      ...[...want].filter(([tabId, address]) => st.written.get(tabId) !== address),
      ...[...st.written.keys()]
        .filter((tabId) => !want.has(tabId))
        .map((tabId): [string, string] => [tabId, ''])
    ]
    if (!changes.length) return
    if ((await this.deps.run(host, addressFilesCmd(changes))).code !== 0) return
    for (const [tabId, address] of changes) {
      if (address) st.written.set(tabId, address)
      else st.written.delete(tabId)
    }
  }
}
