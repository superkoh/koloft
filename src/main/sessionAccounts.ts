import fs from 'fs'
import type { BackendId, SessionInfo } from '@shared/types'
import { BackgroundFile } from './backgroundFile'

export const SESSIONS_REMEMBERED = 2000

type Ran = Pick<SessionInfo, 'backendId' | 'sessionId' | 'account' | 'pickedAccount'>

function readAccounts(file: string): [string, string][] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    return Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string')
  } catch {
    return []
  }
}

export class SessionAccounts {
  private readonly byKey: Map<string, string>
  private readonly disk: BackgroundFile

  constructor(file: string) {
    this.byKey = new Map(readAccounts(file))
    this.disk = new BackgroundFile(() => file)
  }

  of(backend: BackendId, sessionId: string | undefined): string | undefined {
    return sessionId ? this.byKey.get(`${backend}:${sessionId}`) : undefined
  }

  note(sessions: Ran[]): void {
    let changed = false
    for (const s of sessions) {
      const account = s.pickedAccount ?? s.account
      if (!s.sessionId || !account) continue
      const key = `${s.backendId}:${s.sessionId}`
      if (this.byKey.get(key) === account) continue
      this.byKey.delete(key)
      this.byKey.set(key, account)
      changed = true
    }
    if (!changed) return
    for (const key of this.byKey.keys()) {
      if (this.byKey.size <= SESSIONS_REMEMBERED) break
      this.byKey.delete(key)
    }
    this.disk.write(JSON.stringify(Object.fromEntries(this.byKey)))
  }

  flushSync(): void {
    this.disk.flushSync()
  }
}
