import { PrivateRecordFile } from '@core/privateFile'

export interface KeptForAPlugin {
  own?: true
  commands?: readonly string[]
}

export class PluginSessions {
  private keptForWaitingTab = new Map<string, KeptForAPlugin>()
  private sessionOfTab = new Map<string, string>()
  private readonly kept: PrivateRecordFile<KeptForAPlugin>

  constructor(file: () => string) {
    this.kept = new PrivateRecordFile(file)
  }

  started(tabId: string, kept: KeptForAPlugin): void {
    if (kept.own || kept.commands) this.keptForWaitingTab.set(tabId, kept)
  }

  moved(oldTabId: string, newTabId: string): void {
    const kept = this.keptForWaitingTab.get(oldTabId)
    if (kept) {
      this.keptForWaitingTab.delete(oldTabId)
      this.keptForWaitingTab.set(newTabId, kept)
    }
    const session = this.sessionOfTab.get(oldTabId)
    if (session === undefined) return
    this.sessionOfTab.delete(oldTabId)
    this.sessionOfTab.set(newTabId, session)
  }

  bound(tabId: string, sessionId: string): void {
    const all = this.kept.get()
    const previous = this.sessionOfTab.get(tabId)
    this.sessionOfTab.set(tabId, sessionId)
    const kept =
      this.keptForWaitingTab.get(tabId) ?? (previous === undefined ? undefined : all[previous])
    this.keptForWaitingTab.delete(tabId)
    if (!kept || all[sessionId]) return
    all[sessionId] = kept
    this.kept.save()
  }

  of(rowId: string): KeptForAPlugin | undefined {
    const all = this.kept.get()
    if (Object.hasOwn(all, rowId)) return all[rowId]
    const waiting = this.keptForWaitingTab.get(rowId)
    if (waiting) return waiting
    const session = this.sessionOfTab.get(rowId)
    return session !== undefined && Object.hasOwn(all, session) ? all[session] : undefined
  }

  own(rowId: string): boolean {
    return !!this.of(rowId)?.own
  }

  forget(sessionId: string): void {
    this.kept.forget(sessionId)
  }
}
