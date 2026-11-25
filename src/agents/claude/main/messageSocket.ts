import type { SessionInfo } from '@shared/types'
import { writeToMachineSocket } from '../../../main/remote/ssh'

export interface MessageSocketDeps {
  readonly tracker: { remoteOf(tabId: string): { host: string } | undefined }
  readonly writeLineInTurn: (
    receiver: string,
    line: string,
    write?: (line: string) => Promise<void>
  ) => Promise<void>
  remoteControlDir: string
  sessionOfTab(tabId: string): Pick<SessionInfo, 'sessionId'> | undefined
  liveClaudeRegistryOn(host: string): Promise<string>
  whenMessagingSocket(sessionId: string, ms: number): Promise<string | null>
  whenMessagingSocketOnMachine(
    sessionId: string,
    ms: number,
    readLiveRegistry: () => Promise<string>
  ): Promise<string | null>
}

export function messageSocket(
  d: MessageSocketDeps
): (tabId: string, line: string, ms: number) => Promise<void> {
  const {
    remoteControlDir,
    sessionOfTab,
    liveClaudeRegistryOn,
    whenMessagingSocket,
    whenMessagingSocketOnMachine
  } = d

  // CC§13
  async function sendPeerLine(tabId: string, line: string, ms: number): Promise<void> {
    const sessionId = sessionOfTab(tabId)?.sessionId
    const host = d.tracker.remoteOf(tabId)?.host
    if (!sessionId) throw new Error(NO_MESSAGE_SOCKET)
    if (!host) {
      const socket = await whenMessagingSocket(sessionId, ms)
      if (!socket) throw new Error(NO_MESSAGE_SOCKET)
      return d.writeLineInTurn(socket, line)
    }
    const socket = await whenMessagingSocketOnMachine(sessionId, ms, () =>
      liveClaudeRegistryOn(host)
    )
    if (!socket) throw new Error(NO_MESSAGE_SOCKET)
    await d.writeLineInTurn(`${host}:${socket}`, line, (l) =>
      writeToMachineSocket(host, socket, l, { controlDir: remoteControlDir })
    )
  }

  return sendPeerLine
}

const NO_MESSAGE_SOCKET = 'Koloft could not find where that session takes messages.'
