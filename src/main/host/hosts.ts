import { formatRemoteKey, parseRemoteKey } from '@shared/remoteKey'
import type { ClaudeSessionInfo, SessionInfo } from '@shared/types'
import type { Host } from './host'

// ADR-0025
export function publicClaudeSession({
  jsonlPath,
  scratchpadDir,
  ...s
}: ClaudeSessionInfo): SessionInfo {
  const machine = s.remote?.host
  const keyed = (p: string | undefined): string | undefined =>
    machine && p?.startsWith('/') ? formatRemoteKey(machine, p) : p
  const info: SessionInfo = {
    ...s,
    details: { claude: { jsonlPath, scratchpadDir: keyed(scratchpadDir) } }
  }
  if (!machine) return info
  return {
    ...info,
    treeRoot: keyed(s.treeRoot) ?? s.treeRoot,
    lastTouched: keyed(s.lastTouched),
    lastWritten: keyed(s.lastWritten),
    files: s.files?.map((f) => ({ ...f, src: keyed(f.src) ?? f.src }))
  }
}

// ADR-0025
export class Hosts<Machine extends Host> {
  private machines = new Map<string, Machine>()

  constructor(
    private local: Host,
    private makeSsh: (machine: string) => Machine
  ) {}

  of(p: string): Host {
    const key = parseRemoteKey(p)
    return key ? this.machine(key.host) : this.local
  }

  machine(name: string): Machine {
    let host = this.machines.get(name)
    if (!host) this.machines.set(name, (host = this.makeSsh(name)))
    return host
  }
}
