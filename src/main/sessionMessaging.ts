import { backendIdOf } from '@shared/sessionBackend'
import type { BackendId } from '@shared/types'
import type { ModeClass, SentNote } from '@core/agent/sessionBackends'
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
  queue(tabId: string, text: string, clientId: string): Promise<void>
  sendLine(tabId: string, line: string, ms: number): Promise<void>
  modeOf(tabId: string): ModeClass
  noteSent(tabId: string, text: string, id: string | undefined): Promise<void>
}

export interface SessionMessagingDeps<HandOver> {
  readonly hosts: { machine(host: string): Pick<SshHost, 'noteSent'> }
  readonly codexSessions: {
    queueMessage(tabId: string, text: string, clientId?: string): Promise<void>
  } | null
  readonly hookRegDir: string | undefined
  readonly butler: { firstWordsComing(tabId: string): void } | null
  readonly sessionBackends: { permissionClass(tabId: string): ModeClass }
  readonly noteOfWhatKoloftSends: (
    backend: BackendId | undefined,
    text: string,
    id: string | undefined
  ) => SentNote | undefined
  readonly noteSent: (regDir: string, tabId: string, note: SentNote) => void
  readonly buildHandOver: (d: HandOverTabState & HandOverWiring) => HandOver
  ptyMgr: Pick<PtyManager, 'get' | 'type' | 'whenReady'>
  startupErrors: Partial<Record<BackendId, string>>
  machineOfTab(tabId: string): string | undefined
  storedOwnerOf(
    tabId: string
  ): { deliver(tabId: string, text: string): Promise<boolean> } | undefined
  sendPeerLine(tabId: string, line: string, ms: number): Promise<void>
}

export interface SessionVerbsMessaging {
  queue(tabId: string, text: string, clientId?: string): Promise<void>
  sendLine(tabId: string, line: string, ms: number): Promise<void>
  press(tabId: string, keys: string[]): Promise<void>
  deliver(tabId: string, text: string): Promise<boolean>
  noteSent(tabId: string, text: string, id: string | undefined): Promise<void>
  modeOf(tabId: string): ModeClass
}

export function sessionMessaging<HandOver>(d: SessionMessagingDeps<HandOver>): {
  noteKoloftSent(tabId: string, note: SentNote): Promise<void>
  forSessionVerbs: SessionVerbsMessaging
  handOver(tabState: HandOverTabState, asks: { typable(tabId: string): boolean }): HandOver
} {
  const { ptyMgr, startupErrors, machineOfTab, storedOwnerOf, sendPeerLine } = d

  async function queueCodexMessage(tabId: string, text: string, clientId: string): Promise<void> {
    if (!d.codexSessions) throw new Error(startupErrors.codex ?? 'Codex is not available.')
    await d.codexSessions.queueMessage(tabId, text, clientId)
  }

  async function noteSentByKoloft(
    tabId: string,
    text: string,
    id: string | undefined
  ): Promise<void> {
    const note = d.noteOfWhatKoloftSends(backendIdOf(ptyMgr.get(tabId)?.kind), text, id)
    if (!note) return
    return noteKoloftSent(tabId, note)
  }

  // ADR-0028
  async function noteKoloftSent(tabId: string, note: SentNote): Promise<void> {
    const host = machineOfTab(tabId)
    if (host) return d.hosts.machine(host).noteSent(tabId, note)
    if (d.hookRegDir) d.noteSent(d.hookRegDir, tabId, note)
  }

  async function deliverViaOwner(tabId: string, text: string): Promise<boolean> {
    return (await storedOwnerOf(tabId)?.deliver(tabId, text)) ?? false
  }

  return {
    noteKoloftSent,
    forSessionVerbs: {
      queue: async (tabId, text, clientId) => d.codexSessions?.queueMessage(tabId, text, clientId),
      sendLine: sendPeerLine,
      press: async (tabId, keys) => {
        d.butler?.firstWordsComing(tabId)
        await ptyMgr.type(tabId, keys)
      },
      deliver: deliverViaOwner,
      noteSent: noteSentByKoloft,
      modeOf: (tabId) => d.sessionBackends.permissionClass(tabId)
    },
    handOver: (tabState, asks) =>
      d.buildHandOver({
        ...tabState,
        alive: (tabId) => !!ptyMgr.get(tabId)?.alive,
        typable: (tabId) => asks.typable(tabId),
        ready: (tabId, ready, ms) => ptyMgr.whenReady(tabId, ready, ms),
        queue: queueCodexMessage,
        sendLine: sendPeerLine,
        modeOf: (tabId) => d.sessionBackends.permissionClass(tabId),
        noteSent: noteSentByKoloft
      })
  }
}
