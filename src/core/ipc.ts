// ADR-0051
import type { IpcMainEvent } from 'electron'

export interface MainIpc {
  handle<A extends unknown[]>(channel: string, handler: (...args: A) => unknown): void
  on<A extends unknown[]>(channel: string, listener: (...args: A) => void): void
  onEvent<A extends unknown[]>(
    channel: string,
    listener: (event: IpcMainEvent, ...args: A) => void
  ): void
  push(channel: string, ...args: unknown[]): boolean
}

export interface PreloadIpc {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>
  send(channel: string, ...args: unknown[]): void
  sendSync<T>(channel: string, ...args: unknown[]): T
  listen<A extends unknown[]>(channel: string, listener: (...args: A) => void): () => void
}
