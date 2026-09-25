import { dedupKey } from '@shared/browserRoute'
import { basename, dirname } from '@shared/preview'
import type { ArtifactView, PersistedTab, WorkbenchTabKind } from '@shared/types'
import { PERSISTED_TAB_CAP } from '@shared/workbenchState'

export const KIND_TAB_CAP = PERSISTED_TAB_CAP

function capFor(kind: 'web' | 'file' | 'terminal'): number {
  if (kind !== 'web') return KIND_TAB_CAP
  return (typeof window !== 'undefined' && window.api?.browserTabCap) || KIND_TAB_CAP
}

export const FILES_TAB_ID = 'files'

export interface WorkbenchTab {
  id: string
  kind: WorkbenchTabKind
  url?: string
  path?: string
  title: string
  unread: boolean
  view?: ArtifactView
  sourceTabId?: string
  sourcePath?: string
  line?: number
  scrollTop?: number
  cwd?: string
  openedByAgent?: true
}

export interface WorkbenchTabSet {
  tabs: WorkbenchTab[]
  activeId: string
  recency: string[]
}

export interface OpenTabResult {
  set: WorkbenchTabSet
  tabId: string
  created: boolean
  evicted: WorkbenchTab | null
  refused?: 'tab-cap' | 'all-dirty' | 'cap'
}

let seq = 0

function mintId(): string {
  seq += 1
  return `wt${seq}`
}

function filesTab(): WorkbenchTab {
  return { id: FILES_TAB_ID, kind: 'files', title: 'Files', unread: false }
}

export function emptyTabSet(): WorkbenchTabSet {
  return { tabs: [filesTab()], activeId: FILES_TAB_ID, recency: [FILES_TAB_ID] }
}

export function restoreTabSet(tabs: PersistedTab[]): WorkbenchTabSet {
  const kept: WorkbenchTab[] = []
  const counts = { web: 0, file: 0 }
  for (const t of tabs) {
    if (t.kind !== 'web' && t.kind !== 'file') continue
    if (counts[t.kind] >= capFor(t.kind)) continue
    counts[t.kind] += 1
    kept.push({
      id: mintId(),
      kind: t.kind,
      url: t.kind === 'web' ? (t.url ?? '') : undefined,
      path: t.kind === 'file' ? t.path : undefined,
      title: t.title ?? '',
      unread: false,
      view: t.kind === 'file' ? t.view : undefined
    })
  }
  const all = [filesTab(), ...kept]
  return { tabs: all, activeId: FILES_TAB_ID, recency: all.map((t) => t.id) }
}

export function persistTabs(set: WorkbenchTabSet): PersistedTab[] {
  const out: PersistedTab[] = []
  for (const t of set.tabs) {
    if (t.kind === 'web') out.push({ kind: 'web', title: t.title, url: t.url ?? '' })
    else if (t.kind === 'file') {
      out.push({ kind: 'file', title: t.title, path: t.path ?? '', view: t.view })
    }
  }
  return out
}

function touch(recency: string[], id: string): string[] {
  return [...recency.filter((r) => r !== id), id]
}

function sameTarget(
  tab: WorkbenchTab,
  target: { kind: 'web' | 'file' | 'terminal'; url?: string; path?: string }
): boolean {
  if (tab.kind !== target.kind) return false
  if (target.kind === 'web') {
    return !!tab.url && !!target.url && dedupKey(tab.url) === dedupKey(target.url)
  }
  return !!tab.path && tab.path === target.path
}

export function dialogHasLiveOwner(
  dialog: { guestId?: number },
  ownerOfGuest: (guestId: number) => string | undefined,
  liveTabs: ReadonlySet<string>
): boolean {
  if (!dialog.guestId) return false
  const owner = ownerOfGuest(dialog.guestId)
  return !!owner && liveTabs.has(owner)
}

export function activateTab(set: WorkbenchTabSet, id: string): WorkbenchTabSet {
  if (!set.tabs.some((t) => t.id === id)) return set
  return {
    tabs: set.tabs.map((t) => (t.id === id ? { ...t, unread: false } : t)),
    activeId: id,
    recency: touch(set.recency, id)
  }
}

export function openTab(
  set: WorkbenchTabSet,
  opts: {
    kind: 'web' | 'file' | 'terminal'
    id?: string
    cwd?: string
    url?: string
    path?: string
    source: 'agent' | 'user' | 'cdp'
    title?: string
    view?: ArtifactView
    sourceTabId?: string
    sourcePath?: string
    line?: number
    scrollTop?: number
    pinned?: ReadonlySet<string>
    isDirty?: (tabId: string) => boolean
    openedByAgent?: boolean
  }
): OpenTabResult {
  const hasTarget = opts.kind === 'web' ? !!opts.url : opts.kind === 'file' ? !!opts.path : false
  const hit =
    hasTarget && opts.source !== 'cdp' ? set.tabs.find((t) => sameTarget(t, opts)) : undefined
  if (hit) {
    if (opts.source === 'user') {
      const withLine =
        opts.line === undefined
          ? set
          : { ...set, tabs: set.tabs.map((t) => (t.id === hit.id ? { ...t, line: opts.line } : t)) }
      return { set: activateTab(withLine, hit.id), tabId: hit.id, created: false, evicted: null }
    }
    if (hit.id === set.activeId) {
      return { set, tabId: hit.id, created: false, evicted: null }
    }
    return {
      set: { ...set, tabs: set.tabs.map((t) => (t.id === hit.id ? { ...t, unread: true } : t)) },
      tabId: hit.id,
      created: false,
      evicted: null
    }
  }

  let base = set
  let evicted: WorkbenchTab | null = null
  if (base.tabs.filter((t) => t.kind === opts.kind).length >= capFor(opts.kind)) {
    if (opts.kind === 'terminal') {
      return { set, tabId: '', created: false, evicted: null, refused: 'cap' }
    }
    const pinned = opts.pinned
    const skip = (id: string): boolean =>
      id === base.activeId || (opts.source === 'cdp' && pinned !== undefined && pinned.has(id))
    const candidates = base.recency.filter(
      (id) => !skip(id) && base.tabs.some((t) => t.id === id && t.kind === opts.kind)
    )
    const victimId = opts.isDirty ? candidates.find((id) => !opts.isDirty!(id)) : candidates[0]
    const victim = base.tabs.find((t) => t.id === victimId)
    if (victim) {
      evicted = victim
      base = closeTab(base, victim.id)
    } else if (opts.source === 'cdp') {
      return { set, tabId: '', created: false, evicted: null, refused: 'tab-cap' }
    } else if (opts.isDirty) {
      return { set, tabId: '', created: false, evicted: null, refused: 'all-dirty' }
    }
  }

  const tab: WorkbenchTab = {
    id: opts.id ?? mintId(),
    kind: opts.kind,
    url: opts.kind === 'web' ? (opts.url ?? '') : undefined,
    path: opts.kind === 'file' ? opts.path : undefined,
    title: opts.title ?? '',
    unread: opts.source !== 'user',
    view: opts.kind === 'file' ? opts.view : undefined,
    sourceTabId: opts.sourceTabId,
    sourcePath: opts.sourcePath,
    line: opts.line,
    scrollTop: opts.scrollTop,
    cwd: opts.cwd,
    openedByAgent: opts.openedByAgent ? true : undefined
  }
  const at =
    opts.kind === 'terminal' ? base.tabs.length : base.tabs.findIndex((t) => t.kind === 'terminal')
  const tabs =
    at < 0 ? [...base.tabs, tab] : [...base.tabs.slice(0, at), tab, ...base.tabs.slice(at)]
  return {
    set: {
      tabs,
      activeId: opts.source === 'user' ? tab.id : base.activeId,
      recency: [...base.recency, tab.id]
    },
    tabId: tab.id,
    created: true,
    evicted
  }
}

export function closeTab(set: WorkbenchTabSet, id: string): WorkbenchTabSet {
  if (id === FILES_TAB_ID) return set
  const idx = set.tabs.findIndex((t) => t.id === id)
  if (idx < 0) return set
  const tabs = set.tabs
    .filter((t) => t.id !== id)
    .map((t) => (t.sourceTabId === id ? { ...t, sourceTabId: undefined } : t))
  const activeId =
    set.activeId === id ? (tabs[idx]?.id ?? tabs[idx - 1]?.id ?? FILES_TAB_ID) : set.activeId
  return { tabs, activeId, recency: set.recency.filter((r) => r !== id) }
}

export function moveTab(set: WorkbenchTabSet, id: string, to: number): WorkbenchTabSet {
  if (id === FILES_TAB_ID) return set
  const from = set.tabs.findIndex((t) => t.id === id)
  if (from < 0) return set
  if (set.tabs[from].kind === 'terminal') return set
  const firstTerm = set.tabs.findIndex((t) => t.kind === 'terminal')
  const right = (firstTerm < 0 ? set.tabs.length : firstTerm) - 1
  const target = Math.max(1, Math.min(right, to))
  if (target === from) return set
  const tabs = set.tabs.slice()
  const [moved] = tabs.splice(from, 1)
  tabs.splice(target, 0, moved)
  return { ...set, tabs }
}

export function cycleTab(set: WorkbenchTabSet, dir: 1 | -1): WorkbenchTabSet {
  if (set.tabs.length < 2) return set
  const at = set.tabs.findIndex((t) => t.id === set.activeId)
  const next = set.tabs[(at + dir + set.tabs.length) % set.tabs.length]
  return activateTab(set, next.id)
}

export function navigateTab(set: WorkbenchTabSet, id: string, url: string): WorkbenchTabSet {
  return { ...set, tabs: set.tabs.map((t) => (t.id === id ? { ...t, url } : t)) }
}

export function retitleTab(set: WorkbenchTabSet, id: string, title: string): WorkbenchTabSet {
  return { ...set, tabs: set.tabs.map((t) => (t.id === id ? { ...t, title } : t)) }
}

export function setTabView(set: WorkbenchTabSet, id: string, view: ArtifactView): WorkbenchTabSet {
  return { ...set, tabs: set.tabs.map((t) => (t.id === id ? { ...t, view } : t)) }
}

export function setTabScrollTop(
  set: WorkbenchTabSet,
  id: string,
  scrollTop: number
): WorkbenchTabSet {
  const tab = set.tabs.find((t) => t.id === id)
  if (!tab || tab.scrollTop === scrollTop) return set
  return { ...set, tabs: set.tabs.map((t) => (t.id === id ? { ...t, scrollTop } : t)) }
}

export function retargetTab(
  set: WorkbenchTabSet,
  id: string,
  path: string,
  line?: number
): WorkbenchTabSet {
  return {
    ...set,
    tabs: set.tabs.map((t) => (t.id === id ? { ...t, path, line, title: '', view: undefined } : t))
  }
}

export interface RetargetResult {
  set: WorkbenchTabSet
  tabId: string
  openedNew: boolean
  refused?: OpenTabResult['refused']
}

export function retargetOrOpenTab(
  set: WorkbenchTabSet,
  id: string,
  path: string,
  line?: number,
  isDirty?: (tabId: string) => boolean
): RetargetResult {
  if (!isDirty?.(id)) return { set: retargetTab(set, id, path, line), tabId: id, openedNew: false }
  const r = openTab(set, { kind: 'file', path, source: 'user', line, isDirty })
  return {
    set: r.set,
    tabId: r.tabId,
    openedNew: !r.refused,
    refused: r.refused
  }
}

const MAX_LABEL = 40

function lastSegment(pathname: string): string {
  const segs = pathname.split('/').filter(Boolean)
  const last = segs[segs.length - 1] ?? ''
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

function webLabel(tab: { url?: string; title: string }): string {
  if (tab.title) return tab.title
  if (!tab.url || tab.url === 'about:blank') return 'New tab'
  let derived = tab.url
  try {
    const u = new URL(tab.url)
    const page = lastSegment(u.pathname)
    derived = u.host ? (page ? `${u.host}/${page}` : u.host) : page || tab.url
  } catch {}
  return derived.length > MAX_LABEL ? `${derived.slice(0, MAX_LABEL - 1)}…` : derived
}

export function fileLabels(set: WorkbenchTabSet): Record<string, string> {
  const fileTabs = set.tabs.filter((t) => t.kind === 'file' && t.path)
  const out: Record<string, string> = {}
  const depth = new Map<string, number>()
  for (const t of fileTabs) depth.set(t.id, 0)
  const labelAt = (p: string, d: number): string => {
    let head = dirname(p)
    const parts: string[] = [basename(p)]
    for (let i = 0; i < d && head && head !== '/' && head !== '.'; i++) {
      parts.unshift(basename(head))
      head = dirname(head)
    }
    return parts.join('/')
  }
  for (let round = 0; round < 32; round++) {
    const byLabel = new Map<string, string[]>()
    for (const t of fileTabs) {
      const l = labelAt(t.path!, depth.get(t.id)!)
      byLabel.set(l, [...(byLabel.get(l) ?? []), t.id])
    }
    let grew = false
    for (const [, ids] of byLabel) {
      if (ids.length < 2) continue
      for (const id of ids) {
        const t = fileTabs.find((x) => x.id === id)!
        if (labelAt(t.path!, depth.get(id)! + 1) === labelAt(t.path!, depth.get(id)!)) continue
        depth.set(id, depth.get(id)! + 1)
        grew = true
      }
    }
    if (!grew) break
  }
  for (const t of fileTabs) out[t.id] = labelAt(t.path!, depth.get(t.id)!)
  return out
}

export function tabLabel(set: WorkbenchTabSet, tab: WorkbenchTab): string {
  if (tab.kind === 'files') return 'Files'
  if (tab.kind === 'terminal') return tab.title
  if (tab.kind === 'web') return webLabel(tab)
  return fileLabels(set)[tab.id] ?? tab.title ?? ''
}

export function cdpVisibleTabs(set: WorkbenchTabSet): WorkbenchTab[] {
  return set.tabs.filter((t) => t.kind === 'web' && t.openedByAgent)
}

export function liveWebTabs(set: WorkbenchTabSet, limit: number): Set<string> {
  const web = set.tabs.filter((t) => t.kind === 'web')
  const ranked = [...web].sort((a, b) => {
    if (a.id === set.activeId) return -1
    if (b.id === set.activeId) return 1
    return set.recency.indexOf(b.id) - set.recency.indexOf(a.id)
  })
  return new Set(ranked.slice(0, Math.max(1, limit)).map((t) => t.id))
}

export const TERMINAL_CAP_NOTICE = 'Terminal limit reached: at most 8 per session'

export const TERM_SPAWN_FAILED_NOTICE = 'Could not open a terminal'

export function cwdFallbackNotice(resolved: string): string {
  return `Folder is gone — terminal opened in ${shortAuxCwd(resolved)}`
}

export function shortAuxCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  if (parts.length <= 2) return cwd.length > 1 ? cwd.replace(/\/$/, '') : cwd
  return '…/' + parts.slice(-2).join('/')
}
