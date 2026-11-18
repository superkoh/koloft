// ADR-0051
import type { ArtifactView } from '@shared/types'

export interface FileOpened {
  tabId: string
  target: string
  view?: ArtifactView
}

export interface SessionStarting {
  by: string
  workspace: string
  helper: boolean
}

export interface SessionStarted {
  by: string
  tabId: string
  workspace: string
  name?: string
}

export type SaysInReply<T> = (moment: T) => Promise<string | undefined>

export interface Moment<T> {
  listen(listener: SaysInReply<T>): void
  announce(moment: T): Promise<string[]>
}

export function moment<T>(): Moment<T> {
  const listeners: SaysInReply<T>[] = []
  return {
    listen: (listener) => {
      listeners.push(listener)
    },
    announce: async (m) =>
      (await Promise.all(listeners.map((listener) => listener(m)))).filter(
        (said): said is string => !!said
      )
  }
}
