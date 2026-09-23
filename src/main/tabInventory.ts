import type { AdoptableTab, TabKind } from '@shared/types'

export interface PtySnapshot {
  id: string
  kind: TabKind
  cwd: string
  alive: boolean
  util: boolean
  resumeSessionId?: string
}

export interface TrackedSnapshot {
  tabId: string
  sessionId?: string
  title?: string
  alive: boolean
}

export function adoptableTabs(ptys: PtySnapshot[], tracked: TrackedSnapshot[]): AdoptableTab[] {
  const byTab = new Map<string, TrackedSnapshot>()
  for (const t of tracked) {
    if (t.alive && t.sessionId) byTab.set(t.tabId, t)
  }
  const out: AdoptableTab[] = []
  for (const p of ptys) {
    if (!p.alive || p.util) continue
    const tab: AdoptableTab = { id: p.id, kind: p.kind, cwd: p.cwd }
    if (p.resumeSessionId) tab.resumeSessionId = p.resumeSessionId
    const dec = byTab.get(p.id)
    if (dec) {
      tab.sessionId = dec.sessionId
      if (dec.title) tab.title = dec.title
    }
    out.push(tab)
  }
  return out
}
