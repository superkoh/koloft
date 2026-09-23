import type { ArtifactView, PersistedTab, SessionWorkbenchState } from './types'

export const PERSISTED_TAB_CAP = 8

export const DEFAULT_PANEL_OPEN = false

const VIEWS: readonly ArtifactView[] = ['render', 'diff', 'source']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

export function sanitizeTab(raw: unknown): PersistedTab | null {
  if (!isRecord(raw)) return null
  const title = typeof raw.title === 'string' ? raw.title : ''
  if (raw.kind === 'web') {
    const url = str(raw.url)
    return url ? { kind: 'web', title, url } : null
  }
  if (raw.kind === 'file') {
    const path = str(raw.path)
    if (!path) return null
    const view = VIEWS.find((v) => v === raw.view)
    return { kind: 'file', title, path, ...(view ? { view } : {}) }
  }
  return null
}

export function sanitizeSessionWorkbench(
  raw: unknown,
  defaultOpen: boolean
): SessionWorkbenchState {
  if (!isRecord(raw)) return { open: defaultOpen, tabs: [] }
  const open = typeof raw.open === 'boolean' ? raw.open : defaultOpen
  const list = Array.isArray(raw.tabs) ? raw.tabs : []
  const tabs: PersistedTab[] = []
  const counts = { web: 0, file: 0 }
  for (const item of list) {
    const tab = sanitizeTab(item)
    if (!tab) continue
    if (counts[tab.kind] >= PERSISTED_TAB_CAP) continue
    counts[tab.kind] += 1
    tabs.push(tab)
  }
  return { open, tabs }
}
