import { beforeEach } from 'vitest'

export function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>()
  beforeEach(() => store.clear())
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    }
  } as Storage
  return store
}
