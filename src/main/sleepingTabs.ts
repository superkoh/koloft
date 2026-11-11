import type { SessionInfo } from '@shared/types'
import type { OpenTab } from './openTabs'
import { pasteFor, typedPieces, withoutMouseAndFocusReports } from './typeKeys'

export interface SleepingTabsDeps {
  write(tabId: string, data: string): void
  ready(tabId: string): Promise<boolean>
  type(tabId: string, keys: string[]): void
}

export type LiveTab = Pick<SessionInfo, 'tabId' | 'sessionId' | 'alive'>

const PASTE_OR_ENTER = /(\x1b\[200~[\s\S]*?\x1b\[201~|\r)/

export class SleepingTabs {
  private readonly tabs = new Map<string, OpenTab>()
  private readonly typedWhileAsleep = new Map<string, string>()
  private readonly wokenAs = new Map<string, string>()
  private restoredSeq = 0

  constructor(private readonly d: SleepingTabsDeps) {}

  has(tabId: string): boolean {
    return this.tabs.has(tabId)
  }

  get(tabId: string): OpenTab | undefined {
    return this.tabs.get(tabId)
  }

  values(): IterableIterator<OpenTab> {
    return this.tabs.values()
  }

  [Symbol.iterator](): IterableIterator<[string, OpenTab]> {
    return this.tabs.entries()
  }

  add(tabId: string, t: OpenTab): void {
    this.tabs.set(tabId, t)
    this.typedWhileAsleep.set(tabId, '')
  }

  addRestored(t: OpenTab): string {
    const tabId = `asleep-${++this.restoredSeq}`
    this.add(tabId, t)
    return tabId
  }

  forget(tabId: string): void {
    this.tabs.delete(tabId)
    this.typedWhileAsleep.delete(tabId)
  }

  tabOf(sessionId: string): string | undefined {
    for (const [tabId, t] of this.tabs) if (t.sessionId === sessionId) return tabId
    return undefined
  }

  settle(live: LiveTab[]): { oldId: string; newId: string }[] {
    if (!this.tabs.size) return []
    const tabOfSession = new Map<string, string>()
    for (const s of live) if (s.alive && s.sessionId) tabOfSession.set(s.sessionId, s.tabId)
    const woken: { oldId: string; newId: string }[] = []
    for (const [oldId, t] of this.tabs) {
      const newId = tabOfSession.get(t.sessionId)
      if (!newId || newId === oldId) continue
      this.tabs.delete(oldId)
      this.wokenAs.set(oldId, newId)
      woken.push({ oldId, newId })
      void this.handOverTyping(oldId, newId)
    }
    return woken
  }

  heldPaste(tabId: string, text: string, typedAfter = ''): boolean {
    if (!this.typedWhileAsleep.has(tabId)) return false
    this.write(tabId, pasteFor(text, this.tabs.get(tabId)?.kind) + typedAfter)
    return true
  }

  write(tabId: string, data: string): void {
    const typed = this.typedWhileAsleep.get(tabId)
    const woken = this.wokenAs.get(tabId)
    if (typed !== undefined)
      this.typedWhileAsleep.set(tabId, typed + withoutMouseAndFocusReports(data))
    else if (woken) this.d.write(woken, withoutMouseAndFocusReports(data))
    else this.d.write(tabId, data)
  }

  exited(tabId: string, resumedSessionId: string | undefined): string[] {
    for (const [oldId, newId] of this.wokenAs) if (newId === tabId) this.wokenAs.delete(oldId)
    const sameSession: string[] = []
    for (const [id, t] of this.tabs)
      if (id !== tabId && t.sessionId === resumedSessionId) sameSession.push(id)
    return sameSession
  }

  // CC§12 CC§18
  private async handOverTyping(oldId: string, newId: string): Promise<void> {
    const ready = await this.d.ready(newId)
    const typed = this.typedWhileAsleep.get(oldId) ?? ''
    this.typedWhileAsleep.delete(oldId)
    if (!ready || !typed) return
    const keys = typed
      .split(PASTE_OR_ENTER)
      .flatMap((part) => (PASTE_OR_ENTER.test(part) ? [part] : typedPieces(part)))
    this.d.type(newId, keys)
  }
}
