import fs from 'fs'
import { writePrivateAtomically } from './privateFile'

type ParentBySession = Record<string, string>

export class StartedSessions {
  private parentOfWaitingTab = new Map<string, string>()
  private sessionOfTab = new Map<string, string>()
  private parentOf: ParentBySession | null = null

  constructor(private readonly file: () => string) {}

  started(childTabId: string, parentSessionId: string): void {
    this.parentOfWaitingTab.set(childTabId, parentSessionId)
  }

  bound(tabId: string, sessionId: string): void {
    const parents = this.parents()
    const before = JSON.stringify(parents)
    const previous = this.sessionOfTab.get(tabId)
    this.sessionOfTab.set(tabId, sessionId)
    if (previous && previous !== sessionId) {
      for (const [child, parent] of Object.entries(parents))
        if (parent === previous) parents[child] = sessionId
      for (const [tab, parent] of this.parentOfWaitingTab)
        if (parent === previous) this.parentOfWaitingTab.set(tab, sessionId)
      if (parents[previous]) {
        parents[sessionId] = parents[previous]
        delete parents[previous]
      }
    }
    const parent = this.parentOfWaitingTab.get(tabId)
    if (parent) {
      parents[sessionId] = parent
      this.parentOfWaitingTab.delete(tabId)
    }
    if (JSON.stringify(parents) !== before) this.save()
  }

  startedBy(target: { sessionId: string; tabId?: string }, caller: { sessionId: string }): boolean {
    return (
      (target.tabId !== undefined &&
        this.parentOfWaitingTab.get(target.tabId) === caller.sessionId) ||
      this.parents()[target.sessionId] === caller.sessionId
    )
  }

  forget(sessionId: string): void {
    const parents = this.parents()
    if (!(sessionId in parents)) return
    delete parents[sessionId]
    this.save()
  }

  private parents(): ParentBySession {
    if (!this.parentOf) {
      try {
        const read: unknown = JSON.parse(fs.readFileSync(this.file(), 'utf8'))
        this.parentOf =
          read && typeof read === 'object' && !Array.isArray(read) ? (read as ParentBySession) : {}
      } catch {
        this.parentOf = {}
      }
    }
    return this.parentOf
  }

  private save(): void {
    writePrivateAtomically(this.file(), JSON.stringify(this.parentOf))
  }
}
