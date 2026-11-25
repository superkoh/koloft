import type { BackendId } from '@shared/types'
import type { MessageToSend, ModeClass, SendOutcome, SentNote } from '@core/agent/sessionBackends'
import type { SshHost } from './host/sshHost'
import type { PtyManager } from './ptyManager'

export interface HandOverTabState {
  backendOf(tabId: string): BackendId | undefined
  boundKey(tabId: string): string | undefined
  type(tabId: string, keys: string[]): Promise<boolean>
}

export interface HandOverWiring {
  alive(tabId: string): boolean
  typable(tabId: string): boolean
  ready(tabId: string, ready: () => boolean, ms: number): Promise<boolean>
  send(backend: BackendId, tabId: string, m: MessageToSend): Promise<SendOutcome>
  modeOf(tabId: string): ModeClass
  opensAsOnlyKoloftSends(text: string): boolean
}

interface Messages {
  permissionClass(tabId: string): ModeClass
  send(backend: BackendId, tabId: string, m: MessageToSend): Promise<SendOutcome>
  mightNotTakeAMessageNow(
    backend: BackendId,
    tabId: string,
    turnHasEnded: (tabId: string) => Promise<boolean>
  ): Promise<boolean>
}

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
    if (host) return d.hosts.machine(host).noteSent(tabId, note)
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
