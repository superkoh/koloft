import {
  allDirtyTabs,
  dirtyTabsOf,
  discardTab,
  editingActive,
  getEntry,
  saveTab,
  subscribeDirty,
  type DirtyTab
} from './editRegistry'
import { NOTES_OWNER_PREFIX, notesOwner } from '@shared/cwdKey'
import { relOf } from './components/filesModel'
import { activateTab } from './components/workbenchTabs'
import { useStore } from './store'

/**
 * file-edit B-24/B-25/B-26 — the one place outside the Workbench that touches an edit
 * buffer.
 *
 * Three routes can destroy unsaved text without ever going through the editor: closing
 * a session, quitting Koloft, and closing a file tab. They all need the same two verbs
 * ("throw it away" / "write it out, and tell me if that worked"), so both live here
 * rather than being spelt out three times in `App.tsx`. The editor's own registry is
 * imported nowhere else in the app shell, which is what makes it one seam instead of a
 * dependency spreading through every dialog — B-12's "is an editor on screen", which the
 * Find menu item gates on, comes through here for the same reason.
 */

export type { DirtyTab }

/** The two facts about the editor that the app menu gates items on. */
export interface MenuFlags {
  /** B-12: an editor is the surface in front of the user, so Find has nothing to search */
  editing: boolean
  /** B-15/B-16: something, somewhere, is unsaved */
  anyDirty: boolean
}

/**
 * B-12/B-15 — watch the two facts the File and Edit menus gate on, pushing them once
 * straight away so the caller never has to ask separately for the state it subscribes to.
 *
 * Both ride the registry's one notification channel, so this is a single subscription
 * rather than two that could disagree for a frame.
 *
 * `anyDirty` is deliberately the WHOLE window rather than the active buffer: it is the
 * over-enabling direction, and only that direction is safe. Enabling Save when the
 * focused surface has nothing to write costs a keystroke that does nothing — the
 * behaviour B-16 originally specified everywhere — while disabling it one moment too
 * eagerly would leave a dirty buffer with no ⌘S at all.
 */
export function subscribeMenuFlags(cb: (flags: MenuFlags) => void): () => void {
  const push = (): void => cb({ editing: editingActive(), anyDirty: allDirtyTabs().length > 0 })
  push()
  return subscribeDirty(push)
}

/**
 * the conversation tabs holding unsaved text, reported whenever the set itself
 * changes (the registry notifies on every keystroke; main only cares about the names).
 * Pushes once on subscribe, so main is told even if nothing ever changes.
 *
 * A note hangs off a workspace rather than a tab, so it names no tab here — no session
 * is kept alive on a note's account.
 */
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

/**
 * B-31 — the extra sentence the Remove-workspace question grows when the sessions it is
 * about to close are holding unsaved files.
 *
 * A count rather than names: a workspace removal spans every session under it, so the
 * list is unbounded and the names would not fit a sentence. Empty for a clean removal,
 * and exactly empty — the caller appends it to the existing copy, so a stray space here
 * would reword every ordinary workspace removal.
 */
export function removeUnsavedNote(count: number): string {
  if (count === 0) return ''
  const s = count === 1 ? 'file has' : 'files have'
  return `${count} ${s} unsaved changes in these sessions and will be lost.`
}

/**
 * the extra sentence a workspace removal grows when scheduled jobs go with it.
 *
 * Sessions come back when the folder is re-added; jobs do not, so this is the half of
 * the warning that has to reach EVERY route that removes a workspace — the confirm
 * dialog, and the unsaved-files question, which is the one route that never asks main
 * and so has no answer of main's to read the count out of. One function so the two
 * routes cannot drift apart. Empty for a workspace with no job, and exactly empty: the
 * caller appends it to copy that already reads as a finished sentence.
 */
export function removeJobsNote(jobs: number): string {
  if (jobs === 0) return ''
  return `${jobs} scheduled job${jobs === 1 ? '' : 's'} will be deleted. Jobs do not come back.`
}

/** What removing a workspace has to do first. */
export type RemovePlan =
  /** hand it to `workspace.remove`, which raises its own running-sessions question */
  | 'remove'
  /** the merged dialog: sessions to kill AND files to lose */
  | 'confirm-running'
  /** nothing running, but unsaved files — the plain figure-3 question */
  | 'confirm-unsaved'

/**
 * B-31 — which question a workspace removal asks, decided BEFORE main is called.
 *
 * The order matters and is the whole point: `workspace.remove` unpins the workspace as a
 * side effect of reporting how many sessions are running, so asking it first is what let
 * an idle workspace's unsaved work vanish without a word. With nothing unsaved there is
 * nothing to decide and the call goes through exactly as it always did.
 */
export function removePlan(running: number, dirty: number): RemovePlan {
  if (dirty === 0) return 'remove'
  return running > 0 ? 'confirm-running' : 'confirm-unsaved'
}

/** Every dirty buffer belonging to the sessions listed under one pinned workspace.
 *
 *  D8: buffers hang off the CONVERSATION TAB now, and a sidebar row is named by its claude
 *  session id — so each row is turned into the tab showing it. A row with no tab open has
 *  no buffers by construction: closing the tab is what threw them away. */
export function dirtyInWorkspace(path: string): DirtyTab[] {
  const st = useStore.getState()
  const ws = st.workspaceRows.find((w) => w.workspace.path === path)
  const sessionBuffers = (ws?.rows ?? []).flatMap((r) => {
    const tabId =
      st.sessions.find((s) => s.sessionId === r.id)?.tabId ??
      st.tabs.find((t) => t.sessionId === r.id)?.id
    return dirtyIn(tabId)
  })
  // the workspace's note hangs off the WORKSPACE, not off any session, so no row
  // above can lead to it. The file itself survives the removal (D9: unpinning keeps it),
  // but the way BACK to unsaved typing does not: the island follows the pick, so once the
  // head is gone from the sidebar there is nothing left to click to reach a buffer that
  // could not save. So the question has to name it while the head is still there.
  return [...sessionBuffers, ...dirtyTabsOf(notesOwner(path))]
}

/**
 * The dirty files, spelt the way figure 3 draws them — `apps/api/.env`, not the absolute
 * path whose leading half is a temp directory identifying nothing.
 *
 * `relOf` is the app's single answer to "how is a path written on screen": the tree, the
 * Changes rows and the tab titles all read it through there, so these dialogs do too.
 */
export function labelPaths(tabs: DirtyTab[]): string[] {
  const sessions = useStore.getState().sessions
  return tabs.map((t) => {
    // the note has no session and no tree to be relative to, so `relOf` would
    // print the whole path of a file kept in Koloft's own data folder. The name alone
    // says what it is.
    if (t.ownerTabId.startsWith(NOTES_OWNER_PREFIX)) return 'notes.md'
    return relOf(t.path, sessions.find((s) => s.tabId === t.ownerTabId)?.treeRoot ?? null)
  })
}

/** Dirty buffers belonging to one conversation tab, or none when there is no such tab. */
export function dirtyIn(tabId: string | undefined): DirtyTab[] {
  return tabId ? dirtyTabsOf(tabId) : []
}

/** Every dirty buffer in the window — what quitting has to answer for. */
export function allDirty(): DirtyTab[] {
  return allDirtyTabs()
}

/** Throw the typing away. Nothing can fail here, which is why Discard never reports back. */
export function discardAll(tabs: DirtyTab[]): void {
  for (const t of tabs) discardTab(t.ownerTabId, t.tabId)
}

/**
 * Write every buffer out. True only when all of them reached the disk — a `stale` or
 * `failed` answer means the caller must NOT go through with whatever it was closing,
 * because the text is still the only copy of that work.
 *
 * `clean` counts as success: a buffer that went clean between the question and the save
 * has nothing left to lose. The saves run together rather than one after another —
 * they touch different files and a serial run would make a ten-file quit feel stuck.
 */
/**
 * Put a buffer in front of the user: its session selected, its panel open, its tab active.
 *
 * The panel's own tab-close guard does the last step alone, because it is already inside
 * the session it is talking about. These guards are not — quitting and removing a
 * workspace both range over sessions that may not even be on screen — so the session has
 * to be selected first or the tab would come forward behind another session's panel.
 */
function revealTab(t: DirtyTab): void {
  const st = useStore.getState()
  // `activateTab`, not the raw `setActive`: this is a user-driven switch, so it should
  // refuse a tab that has gone. D8: the buffer names its own conversation tab, so there is
  // no session id to resolve back to one — the id it carries IS the tab to bring forward.
  st.activateTab(t.ownerTabId)
  st.setWorkbenchOpen(t.ownerTabId, true)
  st.updateWorkbenchTabs(t.ownerTabId, (prev) => activateTab(prev, t.tabId))
}

/**
 * the same job for a NOTE, which has no tab to bring forward.
 *
 * Everything `revealTab` does would be wrong here: there is no conversation tab called
 * `notes-…`, so `activateTab` does nothing, `setWorkbenchOpen` writes a panel-state entry
 * under an id no tab carries, and the toast points at a tab the user cannot find. The
 * island IS the note's place on screen, so the workspace is picked instead — and unfolded,
 * because a folded island draws no body and the conflict bar lives in it.
 */
function revealNote(t: DirtyTab): void {
  const st = useStore.getState()
  // the owner key is a one-way spelling of the path, so the workspace is found by spelling
  // each pinned one the same way rather than by trying to read it back out
  const ws = st.workspaceRows.find((w) => notesOwner(w.workspace.path) === t.ownerTabId)
  if (ws) st.selectWorkspace(ws.workspace.path)
  if (st.settings.notesFolded) {
    // optimistic like the fold button itself: the store first so the island opens at once,
    // then main writes the choice down
    st.setSettings({ ...st.settings, notesFolded: false })
    void window.api.settings.set({ notesFolded: false })
  }
}

export async function saveAll(tabs: DirtyTab[]): Promise<boolean> {
  const results = await Promise.all(tabs.map((t) => saveTab(t.ownerTabId, t.tabId)))
  const at = results.findIndex((r) => r === 'stale' || r === 'failed')
  if (at < 0) return true
  // A refused save is not a "try again here" state: the difference, and the two ways out
  // of it, live on the tab — so the caller takes its question down and this brings the
  // offending file forward with the reason beside it. Several failures land on the first;
  // the guard simply asks again next time for the rest.
  const t = tabs[at]
  const note = t.ownerTabId.startsWith(NOTES_OWNER_PREFIX)
  if (note) revealNote(t)
  else revealTab(t)
  const failure = getEntry(t.ownerTabId, t.tabId)?.error
  useStore
    .getState()
    .showToast(
      results[at] === 'stale'
        ? note
          ? 'Not saved — notes.md changed on disk. The Notes island shows the difference.'
          : 'Not saved — this file changed on disk. The tab shows the difference.'
        : note
          ? (failure ?? 'notes.md could not be saved — see the Notes island.')
          : (failure ?? 'Could not save this file.')
    )
  return false
}

/**
 * D6 / N07 — write out every note that is saving itself, before anyone counts what is
 * unsaved.
 *
 * A note lands on disk 600 ms after the last key. Quitting inside that window would
 * otherwise raise the "you have unsaved files" question about text that was about to write
 * itself anyway — so the quit guard flushes first and then asks about what is left. Only
 * buffers that MAY save themselves are touched: a note under a conflict bar is a question
 * only the user can answer, so it is left alone and still reaches the dialog.
 */
export async function flushNotes(): Promise<void> {
  const pending = allDirtyTabs().filter((t) => {
    if (!t.ownerTabId.startsWith(NOTES_OWNER_PREFIX)) return false
    const e = getEntry(t.ownerTabId, t.tabId)
    return !!e && !e.conflict && !e.readOnly
  })
  await Promise.all(pending.map((t) => saveTab(t.ownerTabId, t.tabId)))
}
