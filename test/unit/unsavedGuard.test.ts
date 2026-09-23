import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EditWriteResult } from '@shared/types'
import { NOTES_TAB, notesOwner } from '@shared/cwdKey'
import {
  allDirty,
  dirtyInWorkspace,
  flushNotes,
  labelPaths,
  removeJobsNote,
  removePlan,
  removeUnsavedNote,
  saveAll,
  subscribeDirtyTabs
} from '../../src/renderer/src/unsavedGuard'
import {
  allEditTabs,
  beginEdit,
  endEdit,
  noteConflict,
  setText
} from '../../src/renderer/src/editRegistry'
import { useStore } from '../../src/renderer/src/store'

/** The only collaborator these two touch: the one call in Koloft that writes a user's
 *  file, and the settings write the island's unfold rides on. Planted the way
 *  editRegistry.test.ts plants it — this is a pure-Node suite, so there is no window. */
const write =
  vi.fn<
    (
      path: string,
      text: string,
      expected: { mtimeMs: number; size: number },
      opts?: { force?: boolean; eol?: 'lf' | 'crlf' }
    ) => Promise<EditWriteResult>
  >()
const setSetting = vi.fn<(patch: Record<string, unknown>) => Promise<void>>()
;(globalThis as unknown as { window: unknown }).window = {
  api: { edit: { write }, settings: { set: setSetting } }
}

// The dialogs spell their paths with `relOf`, the app's one answer to that question —
// its cases live with it, in filesModel.test.ts.

// B-31 — removing a workspace closes its sessions, which was the seventh way to lose
// unsaved work and the one route the design's six-item list never named. The sentence
// is appended to the existing "N running sessions will be closed" copy rather than
// replacing it, so the empty answer has to be EXACTLY empty: a stray space would change
// the wording of every ordinary workspace removal.
describe('removeUnsavedNote (B-31 workspace removal)', () => {
  it('says nothing at all when no buffer is dirty', () => {
    expect(removeUnsavedNote(0)).toBe('')
  })

  it('warns about the files, agreeing with the count', () => {
    expect(removeUnsavedNote(1)).toBe(
      '1 file has unsaved changes in these sessions and will be lost.'
    )
    expect(removeUnsavedNote(3)).toBe(
      '3 files have unsaved changes in these sessions and will be lost.'
    )
  })
})

// the other half of a workspace removal's warning. A removal that stops to ask
// about unsaved files never asks main, so it has no answer of main's to read a job count
// out of and used to delete the jobs without a word; both routes now read the sentence
// from here, which is why the wording is one function and not two.
describe('removeJobsNote', () => {
  it('says nothing at all when the workspace has no job', () => {
    expect(removeJobsNote(0)).toBe('')
  })

  it('warns that the jobs go for good, agreeing with the count', () => {
    expect(removeJobsNote(1)).toBe('1 scheduled job will be deleted. Jobs do not come back.')
    expect(removeJobsNote(2)).toBe('2 scheduled jobs will be deleted. Jobs do not come back.')
  })
})

// B-31 — which question a workspace removal has to ask. It is a fork made BEFORE any
// call to main, because `workspace.remove` removes the workspace as a side effect of
// reporting how many sessions are running: asking it first is what let an idle
// workspace's unsaved work disappear without a word.
describe('removePlan (B-31 which question to ask)', () => {
  it('goes straight to the removal API when nothing is unsaved', () => {
    // unchanged both ways round — with sessions running, the API's own answer is what
    // raises the existing "N running sessions will be closed" dialog
    expect(removePlan(0, 0)).toBe('remove')
    expect(removePlan(2, 0)).toBe('remove')
  })

  it('asks the merged question when sessions are running AND work is unsaved', () => {
    expect(removePlan(2, 1)).toBe('confirm-running')
  })

  it('asks only about the files when nothing is running but work is unsaved', () => {
    expect(removePlan(0, 1)).toBe('confirm-unsaved')
  })
})

// the workspace note is the eighth way to lose typing, and the only buffer in the
// app that hangs off no session at all. The note FILE outlives the removal (D9: unpinning
// keeps it), but the way back to unsaved typing does not: the island follows the pick, so
// once the head has gone from the sidebar there is nothing left to click to reach a buffer
// that could not save. The removal question has to name it while the head is still there,
// and walking the workspace's session rows — all the guard used to do — never can.
describe('dirtyInWorkspace + labelPaths (the workspace note)', () => {
  const WS = '/repo/proj'
  const owner = notesOwner(WS)
  const notePath = '/data/notes/-repo-proj/notes.md'

  const openNote = (): void =>
    beginEdit(owner, NOTES_TAB, {
      path: notePath,
      text: 'old',
      eol: 'lf',
      stamp: { mtimeMs: 1, size: 3 },
      readOnly: null
    })

  afterEach(() => {
    endEdit(owner, NOTES_TAB)
    useStore.setState({ workspaceRows: [], sessions: [], tabs: [] })
  })

  it('reports the note’s unsaved typing even though no session row leads to it', () => {
    useStore.setState({
      workspaceRows: [
        { workspace: { path: WS, missing: false, isGit: true, hasHistory: false }, rows: [] }
      ],
      sessions: [],
      tabs: []
    })
    openNote()
    expect(dirtyInWorkspace(WS)).toEqual([])

    setText(owner, NOTES_TAB, 'old + something typed')
    expect(dirtyInWorkspace(WS)).toEqual([{ ownerTabId: owner, tabId: NOTES_TAB, path: notePath }])
    // another workspace's removal must not ask about this one's note
    expect(dirtyInWorkspace('/repo/other')).toEqual([])
  })

  it('spells the note as its own name, not the whole path inside Koloft’s data folder', () => {
    expect(labelPaths([{ ownerTabId: owner, tabId: NOTES_TAB, path: notePath }])).toEqual([
      'notes.md'
    ])
  })
})

// D6 / N07 — the note writes itself 600 ms after the last key, so ⌘Q typed inside
// that window must WRITE it rather than raise a question about it. The one buffer that is
// deliberately NOT flushed is a note under a conflict bar: the file moved under us, and
// only the user can say which side wins, so that one still reaches the dialog.
describe('flushNotes', () => {
  const WS = '/repo/proj'
  const owner = notesOwner(WS)
  const notePath = '/data/notes/-repo-proj/notes.md'
  const STAMP = { mtimeMs: 1, size: 3 }

  const openNote = (): void =>
    beginEdit(owner, NOTES_TAB, {
      path: notePath,
      text: 'old',
      eol: 'lf',
      stamp: STAMP,
      readOnly: null
    })

  beforeEach(() => {
    write.mockReset()
    setSetting.mockReset()
    setSetting.mockResolvedValue(undefined)
  })

  afterEach(() => {
    for (const t of allEditTabs()) endEdit(t.ownerTabId, t.tabId)
    useStore.setState({ workspaceRows: [], sessions: [], tabs: [], toast: null, selectedWs: null })
  })

  it('writes a dirty note out, so the quit guard has nothing left to ask about', async () => {
    openNote()
    setText(owner, NOTES_TAB, 'old + typed')
    write.mockResolvedValue({ ok: true, mtimeMs: 2, size: 11 })

    await flushNotes()

    expect(write).toHaveBeenCalledWith(notePath, 'old + typed', STAMP, { eol: 'lf' })
    expect(allDirty()).toEqual([])
  })

  it('leaves a note under a conflict bar alone, and it still reaches the dialog', async () => {
    openNote()
    setText(owner, NOTES_TAB, 'old + typed')
    noteConflict(owner, NOTES_TAB, {
      text: 'someone else wrote this',
      stamp: { mtimeMs: 9, size: 23 },
      unreadable: false
    })

    await flushNotes()

    expect(write).not.toHaveBeenCalled()
    expect(allDirty()).toEqual([{ ownerTabId: owner, tabId: NOTES_TAB, path: notePath }])
  })

  it('does not touch an ordinary file buffer — only the note saves itself', async () => {
    beginEdit('pty-1', 'wt7', {
      path: '/repo/proj/.env',
      text: 'A=1\n',
      eol: 'lf',
      stamp: { mtimeMs: 5, size: 4 },
      readOnly: null
    })
    setText('pty-1', 'wt7', 'A=2\n')

    await flushNotes()

    expect(write).not.toHaveBeenCalled()
    expect(allDirty()).toEqual([{ ownerTabId: 'pty-1', tabId: 'wt7', path: '/repo/proj/.env' }])
  })
})

// a refused save brings the file in front of the user, and for a note that place is
// the ISLAND, not a tab. There is no conversation tab called `notes-…`, so the ordinary
// route would activate nothing, park panel state under an id no tab carries, and promise a
// tab the user cannot find.
describe('saveAll', () => {
  const WS = '/repo/proj'
  const owner = notesOwner(WS)
  const notePath = '/data/notes/-repo-proj/notes.md'
  const note = { ownerTabId: owner, tabId: NOTES_TAB, path: notePath }

  beforeEach(() => {
    write.mockReset()
    setSetting.mockReset()
    setSetting.mockResolvedValue(undefined)
    useStore.setState({
      workspaceRows: [
        { workspace: { path: WS, missing: false, isGit: true, hasHistory: false }, rows: [] }
      ],
      sessions: [],
      tabs: [],
      selectedWs: null,
      workbenchOpen: {},
      toast: null,
      settings: { ...useStore.getState().settings, notesFolded: true }
    })
    beginEdit(owner, NOTES_TAB, {
      path: notePath,
      text: 'old',
      eol: 'lf',
      stamp: { mtimeMs: 1, size: 3 },
      readOnly: null
    })
    setText(owner, NOTES_TAB, 'old + typed')
  })

  afterEach(() => {
    for (const t of allEditTabs()) endEdit(t.ownerTabId, t.tabId)
    useStore.setState({ workspaceRows: [], selectedWs: null, toast: null, workbenchOpen: {} })
  })

  it('picks the note’s workspace and unfolds the island instead of chasing a tab', async () => {
    write.mockResolvedValue({ ok: false, code: 'stale', mtimeMs: 9, size: 4, text: 'theirs' })

    await expect(saveAll([note])).resolves.toBe(false)

    const st = useStore.getState()
    expect(st.selectedWs).toBe(WS)
    // the conflict bar lives in the island's body, which a folded island does not draw
    expect(st.settings.notesFolded).toBe(false)
    expect(setSetting).toHaveBeenCalledWith({ notesFolded: false })
    // the owner key is not a tab id: parking panel state under it would leave a callback
    // waiting for a panel that never comes
    expect(st.workbenchOpen[owner]).toBeUndefined()
    expect(st.toast).toBe(
      'Not saved — notes.md changed on disk. The Notes island shows the difference.'
    )
  })

  it('names the note in the toast when the write failed outright', async () => {
    write.mockRejectedValue(new Error('KOLOFT_NO_PERM'))

    await expect(saveAll([note])).resolves.toBe(false)
    expect(useStore.getState().toast).toBe('Not allowed to write this file.')
    expect(useStore.getState().selectedWs).toBe(WS)
  })
})

/*
 * the conversation tabs main must not auto-close. Unsaved text lives only in the
 * renderer, so whatever this push leaves out is work that dies silently half an hour
 * later.
 */
describe('subscribeDirtyTabs', () => {
  const WS_HELD = '/repo/held'
  let ids: string[] = []
  let stop = (): void => {}

  beforeEach(() => {
    for (const t of allEditTabs()) endEdit(t.ownerTabId, t.tabId)
    ids = []
    stop = subscribeDirtyTabs((next) => (ids = next))
  })
  afterEach(() => stop())

  it('names nothing when nothing is unsaved', () => {
    expect(ids).toEqual([])
  })

  it('names a tab with unsaved text, and lets go once it is saved', () => {
    beginEdit('pty-1', 'wt1', {
      path: '/repo/held/.env',
      text: 'A=1\n',
      eol: 'lf',
      stamp: { mtimeMs: 5, size: 4 },
      readOnly: null
    })
    expect(ids).toEqual([])
    setText('pty-1', 'wt1', 'A=2\n')
    expect(ids).toEqual(['pty-1'])
    setText('pty-1', 'wt1', 'A=1\n')
    expect(ids).toEqual([])
  })

  it('never names a note’s workspace — a note keeps no session alive', () => {
    beginEdit(notesOwner(WS_HELD), NOTES_TAB, {
      path: '/data/notes/-repo-held/notes.md',
      text: 'n',
      eol: 'lf',
      stamp: { mtimeMs: 1, size: 1 },
      readOnly: null
    })
    setText(notesOwner(WS_HELD), NOTES_TAB, 'nn')
    expect(ids).toEqual([])
  })
})
