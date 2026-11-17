// ADR-0051
import type { ArtifactView } from '@shared/types'

export interface FileOpened {
  tabId: string
  target: string
  view?: ArtifactView
}

export type SaysInReply<T> = (moment: T) => Promise<string | undefined>

export function moment<T>(): {
  listen(listener: SaysInReply<T>): void
  announce(moment: T): Promise<string[]>
} {
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
