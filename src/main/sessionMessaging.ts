import type { BackendId } from '@shared/types'
import type { ModeClass, SentNote, SessionBackends } from '@core/agent/sessionBackends'
import type { SshHost } from './host/sshHost'
import type { PtyManager } from './ptyManager'

export interface HandOverTabState {
  backendOf(tabId: string): BackendId | undefined
  boundKey(tabId: string): string | undefined
  type(tabId: string, keys: string[]): Promise<boolean>
}

export interface HandOverWiring extends Pick<SessionBackends, 'send'> {
  alive(tabId: string): boolean
  typable(tabId: string): boolean
  ready(tabId: string, ready: () => boolean, ms: number): Promise<boolean>
  modeOf(tabId: string): ModeClass
  opensAsOnlyKoloftSends(text: string): boolean
}

type Messages = Pick<SessionBackends, 'permissionClass' | 'send' | 'mightNotTakeAMessageNow'>

export interface SessionMessagingDeps<HandOver> {
  readonly hosts: { machine(host: string): Pick<SshHost, 'noteSent'> }
  readonly hookRegDir: string | undefined
  readonly butler: { firstWordsComing(tabId: string): void } | null
  readonly sessionBackends: Messages
  readonly noteSent: (regDir: string, tabId: string, note: SentNote) => void
  readonly opensAsOnlyKoloftSends: (text: string) => boolean
  readonly buildHandOver: (d: HandOverTabState & HandOverWiring) => HandOver
  ptyMgr: Pick<PtyManager, 'get' | 'type' | 'whenReady'>
  machineOfTab(tabId: string): string | undefined
  tabIdsOf(tabId: string): string[]
}

export interface SessionVerbsMessaging extends Pick<Messages, 'send' | 'mightNotTakeAMessageNow'> {
  press(tabId: string, keys: string[]): Promise<void>
  modeOf(tabId: string): ModeClass
  opensAsOnlyKoloftSends(text: string): boolean
}

export function sessionMessaging<HandOver>(d: SessionMessagingDeps<HandOver>): {
  noteKoloftSent(tabId: string, note: SentNote): Promise<void>
  forSessionVerbs: SessionVerbsMessaging
  handOver(tabState: HandOverTabState, asks: { typable(tabId: string): boolean }): HandOver
} {
  const { ptyMgr, machineOfTab } = d

  // ADR-0028
  async function noteKoloftSent(tabId: string, note: SentNote): Promise<void> {
    const host = machineOfTab(tabId)
    if (host) {
      const machine = d.hosts.machine(host)
      await Promise.all(d.tabIdsOf(tabId).map((id) => machine.noteSent(id, note)))
      return
    }
    if (d.hookRegDir) d.noteSent(d.hookRegDir, tabId, note)
  }

  return {
    noteKoloftSent,
    forSessionVerbs: {
      send: (backend, tabId, m) => d.sessionBackends.send(backend, tabId, m),
      mightNotTakeAMessageNow: (backend, tabId, turnHasEnded) =>
        d.sessionBackends.mightNotTakeAMessageNow(backend, tabId, turnHasEnded),
      press: async (tabId, keys) => {
        d.butler?.firstWordsComing(tabId)
        await ptyMgr.type(tabId, keys)
      },
      modeOf: (tabId) => d.sessionBackends.permissionClass(tabId),
      opensAsOnlyKoloftSends: (text) => d.opensAsOnlyKoloftSends(text)
    },
    handOver: (tabState, asks) =>
      d.buildHandOver({
        ...tabState,
        alive: (tabId) => !!ptyMgr.get(tabId)?.alive,
        typable: (tabId) => asks.typable(tabId),
        ready: (tabId, ready, ms) => ptyMgr.whenReady(tabId, ready, ms),
        send: (backend, tabId, m) => d.sessionBackends.send(backend, tabId, m),
        modeOf: (tabId) => d.sessionBackends.permissionClass(tabId),
        opensAsOnlyKoloftSends: (text) => d.opensAsOnlyKoloftSends(text)
      })
  }
}
