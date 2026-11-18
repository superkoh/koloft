// ADR-0051
export interface MainIpc {
  handle<A extends unknown[]>(channel: string, handler: (...args: A) => unknown): void
  push(channel: string, ...args: unknown[]): void
}

export interface PreloadIpc {
  invoke<T>(channel: string, ...args: unknown[]): Promise<T>
  listen<A extends unknown[]>(channel: string, listener: (...args: A) => void): () => void
}
