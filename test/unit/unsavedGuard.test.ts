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
  subscribeDirtyTabs,
  subscribeMenuFlags,
  type MenuFlags
} from '../../src/renderer/src/unsavedGuard'
import {
  allEditTabs,
  beginEdit,
  endEdit,
  noteConflict,
  setText
} from '../../src/renderer/src/editRegistry'
import { useStore } from '../../src/renderer/src/store'

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

describe('removeUnsavedNote (B-31 workspace removal)', () => {
  it('says nothing at all when no buffer is dirty — not even a space, as it is appended to the running-sessions copy', () => {
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

describe('removeJobsNote: one sentence both removal routes read, so a removal that stops for unsaved files still names the jobs', () => {
  it('says nothing at all when the workspace has no job', () => {
    expect(removeJobsNote(0)).toBe('')
  })

  it('warns that the jobs go for good, agreeing with the count', () => {
    expect(removeJobsNote(1)).toBe('1 scheduled job will be deleted. Jobs do not come back.')
    expect(removeJobsNote(2)).toBe('2 scheduled jobs will be deleted. Jobs do not come back.')
  })
})

describe('removePlan (B-31 which question to ask), decided before calling main, whose remove call removes while it counts running sessions', () => {
  it('goes straight to the removal API when nothing is unsaved', () => {
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
    expect(dirtyInWorkspace('/repo/other')).toEqual([])
  })

  it('spells the note as its own name, not the whole path inside Koloft’s data folder', () => {
    expect(labelPaths([{ ownerTabId: owner, tabId: NOTES_TAB, path: notePath }])).toEqual([
      'notes.md'
    ])
  })
})

describe('flushNotes: ⌘Q before a note autosaves writes it instead of asking, but a note under a conflict bar still asks', () => {
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
    expect(st.settings.notesFolded).toBe(false)
    expect(setSetting).toHaveBeenCalledWith({ notesFolded: false })
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

describe('subscribeDirtyTabs: the conversation tabs main must not auto-close, as unsaved text lives only in the renderer', () => {
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

describe('subscribeMenuFlags', () => {
  let flags: MenuFlags | null = null
  let stop = (): void => {}

  beforeEach(() => {
    for (const t of allEditTabs()) endEdit(t.ownerTabId, t.tabId)
    stop = subscribeMenuFlags((next) => (flags = next))
  })
  afterEach(() => {
    stop()
    for (const t of allEditTabs()) endEdit(t.ownerTabId, t.tabId)
  })

  it('anyDirty is true when any buffer in the window is dirty, even when the focused surface has nothing to write — enabling Save too often is the only safe direction', () => {
    beginEdit('pty-bg', 'wt1', {
      path: '/repo/bg/.env',
      text: 'A=1\n',
      eol: 'lf',
      stamp: { mtimeMs: 5, size: 4 },
      readOnly: null
    })
    setText('pty-bg', 'wt1', 'A=2\n')
    expect(flags).toEqual({ editing: false, anyDirty: true })
  })
})
