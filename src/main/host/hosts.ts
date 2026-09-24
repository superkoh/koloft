import { formatRemoteKey, parseRemoteKey } from '@shared/remoteKey'
import type { SessionInfo } from '@shared/types'
import type { Host } from './host'

// ADR-0025
export function withMachinePaths(s: SessionInfo): SessionInfo {
  const machine = s.remote?.host
  if (!machine) return s
  const keyed = (p: string | undefined): string | undefined =>
    p?.startsWith('/') ? formatRemoteKey(machine, p) : p
  return {
    ...s,
    treeRoot: keyed(s.treeRoot) ?? s.treeRoot,
    scratchpadDir: keyed(s.scratchpadDir),
    lastTouched: keyed(s.lastTouched),
    lastWritten: keyed(s.lastWritten),
    files: s.files?.map((f) => ({ ...f, src: keyed(f.src) ?? f.src }))
  }
}

// ADR-0025
export class Hosts {
  private machines = new Map<string, Host>()

  constructor(
    private local: Host,
    private makeSsh: (machine: string) => Host
  ) {}

  of(p: string): Host {
    const key = parseRemoteKey(p)
    if (!key) return this.local
    let host = this.machines.get(key.host)
    if (!host) this.machines.set(key.host, (host = this.makeSsh(key.host)))
    return host
  }
}
