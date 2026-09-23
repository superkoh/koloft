import type { AdoptableTab, TabKind } from '@shared/types'

/** What the joiner needs to know about one pty — a snapshot main assembles from
 *  PtyManager's registry (the pty map is the spine of the inventory). */
export interface PtySnapshot {
  id: string
  kind: TabKind
  cwd: string
  alive: boolean
  /** utility shell — never adopted. A terminal tab dies with the reload that drops it
   *  (D4: nothing about a shell is written down and nothing respawns it). */
  util: boolean
  /** spawn-time resume intent, retained on the handle so a reload mid-resume can
   *  restore the tab's resuming state instead of double-launching the session */
  resumeSessionId?: string
}

/** The tracker-side decoration for a bound tab (subset of SessionInfo). */
export interface TrackedSnapshot {
  tabId: string
  sessionId?: string
  title?: string
  alive: boolean
}

export function adoptableTabs(ptys: PtySnapshot[], tracked: TrackedSnapshot[]): AdoptableTab[] {
  // keyed by tabId — a dual-bound session (two resumes of one transcript) has one
  // entry per tab, so both ptys keep their decoration and both adopt
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
