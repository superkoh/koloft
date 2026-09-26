import type {
  LayoutV3,
  LayoutV4,
  LayoutV5,
  LayoutV6,
  PersistedTab,
  SessionWorkbenchState
} from '@shared/types'
import { DEFAULT_PANEL_OPEN, sanitizeSessionWorkbench } from '@shared/workbenchState'
import { identityOf } from '@shared/sessionBackend'

export interface MigrateDeps {
  dirExists(p: string): boolean
  projectRootOf(p: string): string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

type PanelMapKey = 'sessions' | 'panels'

function isPanelLayout(raw: unknown, version: number, mapKey: PanelMapKey = 'sessions'): boolean {
  return (
    isRecord(raw) &&
    raw.version === version &&
    Array.isArray(raw.workspaces) &&
    (raw.workbench === undefined || isRecord(raw.workbench)) &&
    isRecord(raw[mapKey])
  )
}

function isLayoutV2(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    raw.version === 2 &&
    Array.isArray(raw.workspaces) &&
    isRecord(raw.aux) &&
    isRecord(raw.sessions)
  )
}

export function serializeLayout(layout: LayoutV6): string {
  return JSON.stringify(layout, null, 2)
}

function keepWorkspaces(raw: unknown): { path: string }[] {
  if (!Array.isArray(raw)) return []
  const out: { path: string }[] = []
  for (const w of raw) {
    if (isRecord(w) && typeof w.path === 'string' && w.path) out.push({ path: w.path })
  }
  return out
}

function readSessions(
  doc: Record<string, unknown>,
  defaultOpen: boolean,
  mapKey: PanelMapKey
): LayoutV4['sessions'] {
  const sessions: Record<string, SessionWorkbenchState> = {}
  for (const [id, entry] of Object.entries(doc[mapKey] as Record<string, unknown>)) {
    sessions[id] = sanitizeSessionWorkbench(entry, defaultOpen)
  }
  return sessions
}

function readDefaultOpen(doc: Record<string, unknown>, fallback: boolean): boolean {
  const wb = doc.workbench
  return isRecord(wb) && typeof wb.defaultOpen === 'boolean' ? wb.defaultOpen : fallback
}

function readPanelLayout(
  raw: unknown,
  defaultOpenFallback: boolean,
  mapKey: PanelMapKey = 'sessions'
): Omit<LayoutV4, 'version'> {
  const doc = raw as Record<string, unknown>
  const defaultOpen = readDefaultOpen(doc, defaultOpenFallback)
  return {
    workspaces: keepWorkspaces(doc.workspaces),
    workbench: { defaultOpen },
    sessions: readSessions(doc, defaultOpen, mapKey)
  }
}

function sessionV2toV3(entry: unknown): SessionWorkbenchState {
  if (!isRecord(entry)) return { open: false, tabs: [] }
  const browser = entry.browser
  const raw = isRecord(browser) && Array.isArray(browser.tabs) ? browser.tabs : []
  const tabs: PersistedTab[] = []
  for (const t of raw) {
    if (!isRecord(t) || typeof t.url !== 'string' || !t.url) continue
    tabs.push({ kind: 'web', title: typeof t.title === 'string' ? t.title : '', url: t.url })
  }
  return sanitizeSessionWorkbench({ open: false, tabs }, false)
}

function toV3(raw: unknown, deps: MigrateDeps): LayoutV3 {
  if (isPanelLayout(raw, 3)) return { version: 3, ...readPanelLayout(raw, true) }

  if (isLayoutV2(raw)) {
    const doc = raw as Record<string, unknown>
    const sessions: Record<string, SessionWorkbenchState> = {}
    for (const [id, entry] of Object.entries(doc.sessions as Record<string, unknown>)) {
      sessions[id] = sessionV2toV3(entry)
    }
    return {
      version: 3,
      workspaces: keepWorkspaces(doc.workspaces),
      workbench: { defaultOpen: false },
      sessions
    }
  }

  const out: LayoutV3 = {
    version: 3,
    workspaces: [],
    workbench: { defaultOpen: false },
    sessions: {}
  }
  if (!isRecord(raw) || !Array.isArray(raw.tabs)) return out

  const roots = new Set<string>()
  for (const tab of raw.tabs) {
    if (!isRecord(tab) || tab.kind !== 'claude' || typeof tab.cwd !== 'string') continue
    roots.add(deps.projectRootOf(tab.cwd))
    if (typeof tab.sessionId === 'string' && tab.sessionId) {
      out.sessions[tab.sessionId] = { open: false, tabs: [] }
    }
  }
  out.workspaces = [...roots]
    .filter((root) => deps.dirExists(root))
    .sort()
    .map((path) => ({ path }))
  return out
}

function startCollapsed(v3: LayoutV3): LayoutV4 {
  const sessions: Record<string, SessionWorkbenchState> = {}
  for (const [id, entry] of Object.entries(v3.sessions)) {
    sessions[id] = { open: false, tabs: entry.tabs }
  }
  return {
    version: 4,
    workspaces: v3.workspaces,
    workbench: { defaultOpen: DEFAULT_PANEL_OPEN },
    sessions
  }
}

function toV4(raw: unknown, deps: MigrateDeps): LayoutV4 {
  if (isPanelLayout(raw, 4)) return { version: 4, ...readPanelLayout(raw, DEFAULT_PANEL_OPEN) }
  return startCollapsed(toV3(raw, deps))
}

function claudeKeysBecomeMembers(v4: LayoutV4): LayoutV5 {
  return {
    ...v4,
    version: 5,
    members: Object.keys(v4.sessions).filter((id) => identityOf(id).backendId === 'claude')
  }
}

function readMembers(raw: unknown): string[] {
  const members = (raw as Record<string, unknown>).members
  return Array.isArray(members)
    ? members.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
}

function toV5(raw: unknown, deps: MigrateDeps): LayoutV5 {
  if (isPanelLayout(raw, 5)) {
    return { version: 5, ...readPanelLayout(raw, DEFAULT_PANEL_OPEN), members: readMembers(raw) }
  }
  return claudeKeysBecomeMembers(toV4(raw, deps))
}

function sessionsBecomePanels({ sessions, ...v5 }: LayoutV5): LayoutV6 {
  return { ...v5, version: 6, panels: sessions }
}

export function migrateLayout(raw: unknown, deps: MigrateDeps): LayoutV6 {
  if (isPanelLayout(raw, 6, 'panels')) {
    const { sessions, ...rest } = readPanelLayout(raw, DEFAULT_PANEL_OPEN, 'panels')
    return { version: 6, ...rest, members: readMembers(raw), panels: sessions }
  }
  return sessionsBecomePanels(toV5(raw, deps))
}
