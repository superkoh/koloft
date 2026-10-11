import { PrivateRecordFile } from './privateFile'

type ParentBySession = Record<string, string>

export class StartedSessions {
  private parentOfWaitingTab = new Map<string, string>()
  private sessionOfTab = new Map<string, string>()
  private readonly parentOf: PrivateRecordFile<string>

  constructor(file: () => string) {
    this.parentOf = new PrivateRecordFile(file)
  }

  started(childTabId: string, parentSessionId: string): void {
    this.parentOfWaitingTab.set(childTabId, parentSessionId)
  }

  bound(tabId: string, sessionId: string): void {
    const parents = this.parents()
    let changed = false
    const previous = this.sessionOfTab.get(tabId)
    this.sessionOfTab.set(tabId, sessionId)
    if (previous && previous !== sessionId) {
      for (const [child, parent] of Object.entries(parents)) {
        if (parent !== previous) continue
        parents[child] = sessionId
        changed = true
      }
      if (parents[previous]) {
        parents[sessionId] = parents[previous]
        delete parents[previous]
        changed = true
      }
    }
    const parent = this.parentOfWaitingTab.get(tabId)
    if (parent) {
      parents[sessionId] = parent
      this.parentOfWaitingTab.delete(tabId)
      changed = true
    }
    if (changed) this.save()
  }

  startedBy(target: { sessionId: string; tabId?: string }, caller: { sessionId: string }): boolean {
    return this.startersOf(target).includes(caller.sessionId)
  }

  startersOf(target: { sessionId: string; tabId?: string }): string[] {
    return [target.sessionId, target.tabId].flatMap((rowId) => {
      const parent = rowId === undefined ? undefined : this.parentOfRow(rowId)
      return parent === undefined ? [] : [parent]
    })
  }

  parentOfRow(rowId: string): string | undefined {
    const parents = this.parents()
    if (Object.hasOwn(parents, rowId)) return parents[rowId]
    const waiting = this.parentOfWaitingTab.get(rowId)
    if (waiting) return waiting
    const boundSession = this.sessionOfTab.get(rowId)
    return boundSession && Object.hasOwn(parents, boundSession) ? parents[boundSession] : undefined
  }

  forget(sessionId: string): void {
    this.parentOf.forget(sessionId)
  }

  private parents(): ParentBySession {
    return this.parentOf.get()
  }

  private save(): void {
    this.parentOf.save()
  }
}
