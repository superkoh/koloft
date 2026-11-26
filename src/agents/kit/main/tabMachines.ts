import type { BackendId } from '@shared/types'
import type { PtyManager } from '../../../main/ptyManager'

export function machineOfItsTab(
  pty: PtyManager,
  agent: BackendId,
  tabId: string
): string | undefined {
  const tab = pty.get(tabId)
  return tab?.kind === agent ? tab.remoteHost : undefined
}

export function machinesWithItsTabs(pty: PtyManager, agent: BackendId): string[] {
  return pty
    .list()
    .flatMap((tab) => (tab.alive && tab.kind === agent && tab.remoteHost ? [tab.remoteHost] : []))
}
