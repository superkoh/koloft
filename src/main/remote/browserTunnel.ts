import fs from 'fs'
import path from 'path'
import { remoteShCommand } from './install'
import { remoteBrowserAddressFile } from './paths'
import type { RunResult } from './ssh'

export function machineAddress(endpoint: string, machinePort: number): string {
  return `ws://127.0.0.1:${machinePort}${new URL(endpoint).pathname}`
}

// PLATFORM§33
export function parseMasterPid(stderr: string): string | null {
  return /Master running \(pid=(\d+)\)/.exec(stderr)?.[1] ?? null
}

const forwardSpec = (relayPort: number): string => `0:127.0.0.1:${relayPort}`

export function addressFilesCmd(files: [tabId: string, address: string][]): string {
  const f = remoteBrowserAddressFile('$1')
  return remoteShCommand(
    `umask 077; mkdir -p "$HOME/.koloft/tabs" || exit 1
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

  constructor(private deps: BrowserTunnelDeps) {}

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
      fs.writeFileSync(file, JSON.stringify(forward))
    } catch {}
  }

  async sync(host: string, tabs: TunnelTab[]): Promise<void> {
    let st = this.hosts.get(host)
    if (!st) {
      if (!tabs.length) return
      this.hosts.set(host, (st = { forward: this.load(host), written: new Map(), busy: false }))
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
    if (!pid) {
      st.written.clear()
      if (!tabs.length) st.forward = undefined
      return
    }
    const endpoint = tabs.find((t) => t.endpoint)?.endpoint
    const spec = endpoint ? forwardSpec(Number(new URL(endpoint).port)) : ''
    let forward = st.forward?.pid === pid ? st.forward : undefined
    if (forward && forward.spec !== spec) {
      await this.deps.master(host, ['-O', 'cancel', '-R', forward.spec])
      forward = undefined
    }
    const asked = `${pid} ${spec}`
    if (!forward && spec && st.refused !== asked) {
      const r = await this.deps.master(host, ['-O', 'forward', '-R', spec])
      const port = Number(r.stdout.trim())
      if (r.code === 0 && port > 0) forward = { pid, spec, port }
      else st.refused = asked
    }
    if (forward !== st.forward) {
      st.forward = forward
      st.written.clear()
      this.save(host, forward)
    }
    const want = new Map(
      tabs.map((t) => [
        t.tabId,
        forward && t.endpoint ? machineAddress(t.endpoint, forward.port) : ''
      ])
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
      if (want.has(tabId)) st.written.set(tabId, address)
      else st.written.delete(tabId)
    }
  }
}
