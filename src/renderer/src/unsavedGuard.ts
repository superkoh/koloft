import {
  allDirtyTabs,
  dirtyTabsOf,
  discardTab,
  editingActive,
  endEditsOf,
  getEntry,
  saveTab,
  subscribeDirty,
  type DirtyTab
} from './editRegistry'
import { NOTES_OWNER_PREFIX, notesOwner } from '@shared/cwdKey'
import { relOf } from './components/filesModel'
import { sessionEndedBody } from './closeSession'
import { activateTab } from './components/workbenchTabs'
import { useStore } from './store'

export type { DirtyTab }

export interface MenuFlags {
  editing: boolean
  anyDirty: boolean
}

export function subscribeMenuFlags(cb: (flags: MenuFlags) => void): () => void {
  const push = (): void => cb({ editing: editingActive(), anyDirty: allDirtyTabs().length > 0 })
  push()
  return subscribeDirty(push)
}

export function subscribeDirtyTabs(cb: (ids: string[]) => void): () => void {
  let last: string | undefined
  const push = (): void => {
    const ids = [
      ...new Set(
        allDirtyTabs()
          .map((t) => t.ownerTabId)
          .filter((id) => !id.startsWith(NOTES_OWNER_PREFIX))
      )
    ].sort()
    const key = ids.join('\n')
    if (key === last) return
    last = key
    cb(ids)
  }
  push()
  return subscribeDirty(push)
}

export function removeUnsavedNote(count: number): string {
  if (count === 0) return ''
  const s = count === 1 ? 'file has' : 'files have'
  return `${count} ${s} unsaved changes in these sessions and will be lost.`
}

export function removeJobsNote(jobs: number): string {
  if (jobs === 0) return ''
  return `${jobs} scheduled job${jobs === 1 ? '' : 's'} will be deleted. Jobs do not come back.`
}

export type RemovePlan = 'remove' | 'confirm-running' | 'confirm-unsaved'

export function removePlan(running: number, dirty: number): RemovePlan {
  if (dirty === 0) return 'remove'
  return running > 0 ? 'confirm-running' : 'confirm-unsaved'
}

export function dirtyInWorkspace(path: string): DirtyTab[] {
  const st = useStore.getState()
  const ws = st.workspaceRows.find((w) => w.workspace.path === path)
  const sessionBuffers = (ws?.rows ?? []).flatMap((r) => {
    const tabId =
      st.sessions.find((s) => s.sessionId === r.id)?.tabId ??
      st.tabs.find((t) => t.sessionId === r.id)?.id
    return dirtyIn(tabId)
  })
  return [...sessionBuffers, ...dirtyTabsOf(notesOwner(path))]
}

const closedRoots = new Map<string, string>()

function ownerIsClosed(ownerTabId: string): boolean {
  return !useStore.getState().tabs.some((t) => t.id === ownerTabId)
}

function bareLabel(t: DirtyTab): string {
  if (t.ownerTabId.startsWith(NOTES_OWNER_PREFIX)) return 'notes.md'
  const st = useStore.getState()
  const root =
    st.sessions.find((s) => s.tabId === t.ownerTabId)?.treeRoot ??
    closedRoots.get(t.ownerTabId) ??
    st.tabs.find((tab) => tab.id === t.ownerTabId)?.cwd ??
    null
  return relOf(t.path, root)
}

export function labelPaths(tabs: DirtyTab[]): string[] {
  return tabs.map((t) =>
    t.ownerTabId.startsWith(NOTES_OWNER_PREFIX) || !ownerIsClosed(t.ownerTabId)
      ? bareLabel(t)
      : `${bareLabel(t)} (from a closed session)`
  )
}

const waitingToAsk: { ownerTabId: string; title: string }[] = []
let stopWatchingPrompts: (() => void) | null = null

export function askAboutLeftEdits(tab: { id: string; title: string; cwd: string }): void {
  if (dirtyIn(tab.id).length === 0) return
  const session = useStore.getState().sessions.find((s) => s.tabId === tab.id)
  closedRoots.set(tab.id, session?.treeRoot ?? tab.cwd)
  waitingToAsk.push({ ownerTabId: tab.id, title: session?.title || tab.title })
  stopWatchingPrompts ??= useStore.subscribe(askNextLeft)
  askNextLeft()
}

function askNextLeft(): void {
  for (;;) {
    const st = useStore.getState()
    if (st.unsavedPrompt || st.closeConfirm) return
    const next = waitingToAsk.shift()
    if (!next) {
      stopWatchingPrompts?.()
      stopWatchingPrompts = null
      return
    }
    const dirty = dirtyIn(next.ownerTabId)
    if (dirty.length === 0) continue
    const files = dirty.map(bareLabel)
    const forget = (): void => {
      endEditsOf(next.ownerTabId)
      closedRoots.delete(next.ownerTabId)
    }
    st.setUnsavedPrompt({
      files,
      ended: sessionEndedBody(next.title, files),
      onCancel: () => {},
      onDiscard: () => {
        discardAll(dirty)
        forget()
      },
      onSave: async () => {
        const ok = await saveAll(dirty)
        useStore.getState().setUnsavedPrompt(null)
        if (ok) forget()
      }
    })
    return
  }
}

export function dirtyIn(tabId: string | undefined): DirtyTab[] {
  return tabId ? dirtyTabsOf(tabId) : []
}

export function allDirty(): DirtyTab[] {
  return allDirtyTabs()
}

export function discardAll(tabs: DirtyTab[]): void {
  for (const t of tabs) discardTab(t.ownerTabId, t.tabId)
}

function revealTab(t: DirtyTab): void {
  const st = useStore.getState()
  st.activateTab(t.ownerTabId)
  st.setWorkbenchOpen(t.ownerTabId, true)
  st.updateWorkbenchTabs(t.ownerTabId, (prev) => activateTab(prev, t.tabId))
}

function revealNote(t: DirtyTab): void {
  const st = useStore.getState()
  const ws = st.workspaceRows.find((w) => notesOwner(w.workspace.path) === t.ownerTabId)
  if (ws) st.selectWorkspace(ws.workspace.path)
  if (st.settings.notesFolded) {
    st.setSettings({ ...st.settings, notesFolded: false })
    void window.api.settings.set({ notesFolded: false })
  }
}

export async function saveAll(tabs: DirtyTab[]): Promise<boolean> {
  const results = await Promise.all(tabs.map((t) => saveTab(t.ownerTabId, t.tabId)))
  const at = results.findIndex((r) => r === 'stale' || r === 'failed')
  if (at < 0) return true
  const t = tabs[at]
  const note = t.ownerTabId.startsWith(NOTES_OWNER_PREFIX)
  const closed = !note && ownerIsClosed(t.ownerTabId)
  if (note) revealNote(t)
  else if (!closed) revealTab(t)
  const failure = getEntry(t.ownerTabId, t.tabId)?.error
  useStore
    .getState()
    .showToast(
      results[at] === 'stale'
        ? note
          ? 'Not saved — notes.md changed on disk. The Notes island shows the difference.'
          : closed
            ? 'Not saved — this file changed on disk, and its session is closed, so no tab can show the difference.'
            : 'Not saved — this file changed on disk. The tab shows the difference.'
        : note
          ? (failure ?? 'notes.md could not be saved — see the Notes island.')
          : (failure ?? 'Could not save this file.')
    )
  return false
}

export async function flushNotes(): Promise<void> {
  const pending = allDirtyTabs().filter((t) => {
    if (!t.ownerTabId.startsWith(NOTES_OWNER_PREFIX)) return false
    const e = getEntry(t.ownerTabId, t.tabId)
    return !!e && !e.conflict && !e.readOnly
  })
  await Promise.all(pending.map((t) => saveTab(t.ownerTabId, t.tabId)))
}
