import { parseRemoteKey } from '@shared/remoteKey'
import type { Host } from './host'

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

  machineOf(p: string): Machine | undefined {
    const key = parseRemoteKey(p)
    return key ? this.machine(key.host) : undefined
  }

  machine(name: string): Machine {
    let host = this.machines.get(name)
    if (!host) this.machines.set(name, (host = this.makeSsh(name)))
    return host
  }
}
