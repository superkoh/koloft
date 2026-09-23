import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { EditWriteResult } from '@shared/types'
import {
  allDirtyTabs,
  allEditTabs,
  applyDisk,
  beginEdit,
  clearConflict,
  discardTab,
  dirtyTabsOf,
  endEdit,
  getEntry,
  isTabDirty,
  noteConflict,
  reconcileDisk,
  saveTab,
  setSelection,
  setText,
  subscribeDirty
} from '../../src/renderer/src/editRegistry'

/**
 * B-15…B-24, B-27 — the editor's bookkeeping, the half with no DOM in it.
 *
 * It earns a suite of its own because three different surfaces read it and none of them
 * can say what went wrong: the tab strip's dot, the close guard's file list and the tab
 * cap's "skip this one" all ask this module the same question. An e2e failure there points
 * at a dialog or at a tab that vanished, never at the answer underneath.
 *
 * The one collaborator is `window.api.edit.write` — the only call in Koloft that writes a
 * user's file — so it is the only thing doubled, at exactly the interface `KoloftApi` names.
 * This is a pure-Node suite, so `window` is planted the way filesModel's is.
 */

const write =
  vi.fn<
    (
      path: string,
      text: string,
      expect: { mtimeMs: number; size: number },
      opts?: { force?: boolean; eol?: 'lf' | 'crlf' }
    ) => Promise<EditWriteResult>
  >()
;(globalThis as unknown as { window: unknown }).window = { api: { edit: { write } } }

/** the owner key is the CONVERSATION TAB (D8), which is a pty id — it used to
 *  be the claude session id, and `rebindEdits` existed only to chase that id when `/clear`
 *  or `/resume` changed it. A tab id changes for nothing but ⇧⌘R, which the store moves
 *  the whole panel across in one step, so there is no chasing left to do. */
const OWNER = 'pty-1'
const TAB = 'wt7'
const PATH = '/ws/config/app.json'
const BODY = '{\n  "timeout": 30000\n}\n'
const STAMP = { mtimeMs: 1000, size: BODY.length }

function open(text = BODY, eol: 'lf' | 'crlf' = 'lf'): void {
  beginEdit(OWNER, TAB, { path: PATH, text, eol, stamp: STAMP, readOnly: null })
}

beforeEach(() => {
  write.mockReset()
  for (const t of allEditTabs()) endEdit(t.ownerTabId, t.tabId)
  endEdit(OWNER, TAB)
  endEdit('pty-2', 'wt9')
})

describe('opening a buffer', () => {
  it('starts clean, with the disk text as the baseline', () => {
    open()
    expect(getEntry(OWNER, TAB)?.text).toBe(BODY)
    expect(isTabDirty(OWNER, TAB)).toBe(false)
    expect(dirtyTabsOf(OWNER)).toEqual([])
  })

  it('flattens CRLF so a Windows file is not dirty the moment it opens', () => {
    // measured (§05): a textarea turns every \r\n into \n on the way in, so a buffer
    // compared against the raw bytes would be dirty before a key was pressed — and every
    // close would then ask a question about typing that never happened.
    open('a\r\nb\r\n', 'crlf')
    expect(getEntry(OWNER, TAB)?.text).toBe('a\nb\n')
    expect(isTabDirty(OWNER, TAB)).toBe(false)
  })

  it('remembers which endings the file had, so the save can put them back', () => {
    open('a\r\nb\r\n', 'crlf')
    expect(getEntry(OWNER, TAB)?.eol).toBe('crlf')
  })
})

describe('dirty tracking', () => {
  it('turns dirty on a change and clean again when the change is typed back out', () => {
    open()
    setText(OWNER, TAB, BODY + 'X=1\n')
    expect(isTabDirty(OWNER, TAB)).toBe(true)
    expect(dirtyTabsOf(OWNER)).toEqual([{ ownerTabId: OWNER, tabId: TAB, path: PATH }])
    setText(OWNER, TAB, BODY)
    expect(isTabDirty(OWNER, TAB)).toBe(false)
  })

  it('keeps every session’s dirty tabs apart, and lists them all for the quit guard', () => {
    open()
    beginEdit('pty-2', 'wt9', {
      path: '/ws/.env',
      text: 'A=1\n',
      eol: 'lf',
      stamp: { mtimeMs: 5, size: 4 },
      readOnly: null
    })
    setText(OWNER, TAB, BODY + 'X=1\n')
    setText('pty-2', 'wt9', 'A=2\n')

    expect(dirtyTabsOf(OWNER).map((t) => t.path)).toEqual([PATH])
    expect(dirtyTabsOf('pty-2').map((t) => t.path)).toEqual(['/ws/.env'])
    expect(
      allDirtyTabs()
        .map((t) => t.path)
        .sort()
    ).toEqual(['/ws/.env', PATH])
  })

  it('answers "not dirty" for a tab that was never opened for editing', () => {
    expect(isTabDirty(OWNER, 'never-seen')).toBe(false)
  })

  it('tells its listeners when the flag flips, and stops when they leave', () => {
    open()
    const seen = vi.fn()
    const off = subscribeDirty(seen)
    setText(OWNER, TAB, BODY + 'X=1\n')
    expect(seen).toHaveBeenCalledTimes(1)
    setText(OWNER, TAB, BODY)
    expect(seen).toHaveBeenCalledTimes(2)
    off()
    setText(OWNER, TAB, BODY + 'Y=1\n')
    expect(seen).toHaveBeenCalledTimes(2)
  })
})

describe('saving', () => {
  it('does nothing at all when there is nothing to save (B-15)', async () => {
    open()
    await expect(saveTab(OWNER, TAB)).resolves.toBe('clean')
    expect(write).not.toHaveBeenCalled()
  })

  it('is a no-op for a tab with no buffer, rather than an error', async () => {
    await expect(saveTab(OWNER, 'never-seen')).resolves.toBe('clean')
    expect(write).not.toHaveBeenCalled()
  })

  it('sends the text, the fingerprint it opened with and the file’s own endings', async () => {
    open('a\r\nb\r\n', 'crlf')
    setText(OWNER, TAB, 'a\nb\nc\n')
    write.mockResolvedValue({ ok: true, mtimeMs: 2000, size: 9 })

    await expect(saveTab(OWNER, TAB)).resolves.toBe('saved')
    expect(write).toHaveBeenCalledWith(PATH, 'a\nb\nc\n', STAMP, { eol: 'crlf' })
  })

  it('goes clean on success and carries the new fingerprint into the next save', async () => {
    open()
    setText(OWNER, TAB, BODY + 'X=1\n')
    write.mockResolvedValue({ ok: true, mtimeMs: 2000, size: 40 })

    await saveTab(OWNER, TAB)
    expect(isTabDirty(OWNER, TAB)).toBe(false)
    expect(getEntry(OWNER, TAB)?.savedAt).not.toBeNull()

    setText(OWNER, TAB, BODY + 'X=2\n')
    write.mockResolvedValue({ ok: true, mtimeMs: 3000, size: 40 })
    await saveTab(OWNER, TAB)
    expect(write).toHaveBeenLastCalledWith(
      PATH,
      BODY + 'X=2\n',
      { mtimeMs: 2000, size: 40 },
      { eol: 'lf' }
    )
  })

  it('recognises its own write coming back from the watcher as no change (B-22)', async () => {
    open()
    setText(OWNER, TAB, BODY + 'X=1\n')
    write.mockResolvedValue({ ok: true, mtimeMs: 2000, size: 40 })
    await saveTab(OWNER, TAB)
    reconcileDisk(OWNER, TAB, { text: null, stamp: { mtimeMs: 2000, size: 40 } })
    expect(getEntry(OWNER, TAB)?.conflict).toBeNull()
  })

  it('stays dirty when the user kept typing while the write was in flight', async () => {
    open()
    setText(OWNER, TAB, BODY + 'X=1\n')
    write.mockImplementation(async () => {
      setText(OWNER, TAB, BODY + 'X=1\nY=2\n')
      return { ok: true, mtimeMs: 2000, size: 40 }
    })

    await expect(saveTab(OWNER, TAB)).resolves.toBe('saved')
    // what landed on disk is what was SENT, so the extra line is still unsaved work
    expect(isTabDirty(OWNER, TAB)).toBe(true)
  })

  it('queues a second save behind the first instead of writing the same fingerprint twice', async () => {
    // the autosaving note made this ordinary: mousedown blurs the box (save #1),
    // mouseup unmounts it (save #2), and before this the second write went out with the
    // fingerprint the first one was in the middle of replacing. Main answers that with
    // `stale`, so a buffer already on disk grew a conflict bar — and autosave, which
    // refuses to write over an unanswered bar, stopped for good.
    open()
    setText(OWNER, TAB, BODY + 'X=1\n')
    write.mockResolvedValueOnce({ ok: true, mtimeMs: 2000, size: 40 })
    write.mockResolvedValue({
      ok: false,
      code: 'stale',
      mtimeMs: 2000,
      size: 40,
      text: BODY + 'X=1\n'
    })

    const [first, second] = await Promise.all([saveTab(OWNER, TAB), saveTab(OWNER, TAB)])

    expect(write).toHaveBeenCalledTimes(1)
    expect(write).toHaveBeenCalledWith(PATH, BODY + 'X=1\n', STAMP, { eol: 'lf' })
    expect(first).toBe('saved')
    // the second caller looked again and found nothing left to write
    expect(second).toBe('clean')
    expect(getEntry(OWNER, TAB)?.conflict).toBeNull()
  })

  it('writes the newer text when the second caller finds the buffer dirty again', async () => {
    // the other half of the queue: typing during the first write is unsaved work, and the
    // save waiting behind it must send it with the fingerprint the first one established
    open()
    setText(OWNER, TAB, BODY + 'X=1\n')
    write.mockImplementationOnce(async () => {
      setText(OWNER, TAB, BODY + 'X=1\nY=2\n')
      return { ok: true, mtimeMs: 2000, size: 40 }
    })
    write.mockResolvedValue({ ok: true, mtimeMs: 3000, size: 47 })

    await Promise.all([saveTab(OWNER, TAB), saveTab(OWNER, TAB)])

    expect(write).toHaveBeenCalledTimes(2)
    expect(write).toHaveBeenLastCalledWith(
      PATH,
      BODY + 'X=1\nY=2\n',
      { mtimeMs: 2000, size: 40 },
      { eol: 'lf' }
    )
    expect(isTabDirty(OWNER, TAB)).toBe(false)
  })

  it('reports a changed file without touching the buffer, and keeps what disk holds (B-20/B-21)', async () => {
    open()
    setText(OWNER, TAB, BODY + 'MINE=1\n')
    write.mockResolvedValue({
      ok: false,
      code: 'stale',
      mtimeMs: 9000,
      size: 12,
      text: 'THEIRS=1\n'
    })

    await expect(saveTab(OWNER, TAB)).resolves.toBe('stale')
    expect(getEntry(OWNER, TAB)?.text).toBe(BODY + 'MINE=1\n')
    expect(isTabDirty(OWNER, TAB)).toBe(true)
    expect(getEntry(OWNER, TAB)?.conflict).toEqual({
      text: 'THEIRS=1\n',
      stamp: { mtimeMs: 9000, size: 12 },
      unreadable: false
    })
    // the fingerprint must NOT move to the disk's: the next plain save has to be refused too
    expect(getEntry(OWNER, TAB)?.stamp).toEqual(STAMP)
  })

  it('reports a conflict it cannot show, when what is on disk is too big to compare', async () => {
    // main answers a stale write with `text: null` when the file it found is over the
    // reading limit or is binary. It is still a conflict — nothing was written and the
    // work is still here — but there is nothing to draw a difference against, and the
    // strip has to say so instead of offering a view that would never fill.
    open()
    setText(OWNER, TAB, BODY + 'MINE=1\n')
    write.mockResolvedValue({
      ok: false,
      code: 'stale',
      mtimeMs: 9000,
      size: 700_000,
      // typed loosely on purpose: `EditWriteResult.text` is `string | null` only once the
      // main-process half lands, and this case is what asks for it
      text: null
    } as unknown as EditWriteResult)

    await expect(saveTab(OWNER, TAB)).resolves.toBe('stale')
    expect(getEntry(OWNER, TAB)?.conflict).toEqual({
      text: null,
      stamp: { mtimeMs: 9000, size: 700_000 },
      unreadable: true
    })
    expect(getEntry(OWNER, TAB)?.text).toBe(BODY + 'MINE=1\n')
    expect(isTabDirty(OWNER, TAB)).toBe(true)
  })

  it('overwrites only when asked to force, and comes out clean (Keep mine)', async () => {
    open()
    setText(OWNER, TAB, BODY + 'MINE=1\n')
    noteConflict(OWNER, TAB, {
      text: 'THEIRS=1\n',
      stamp: { mtimeMs: 9000, size: 12 },
      unreadable: false
    })
    write.mockResolvedValue({ ok: true, mtimeMs: 9500, size: 30 })

    await expect(saveTab(OWNER, TAB, { force: true })).resolves.toBe('saved')
    expect(write).toHaveBeenCalledWith(PATH, BODY + 'MINE=1\n', STAMP, { force: true, eol: 'lf' })
    expect(isTabDirty(OWNER, TAB)).toBe(false)
    expect(getEntry(OWNER, TAB)?.conflict).toBeNull()
  })

  it('keeps the work and says why when the write throws (B-23)', async () => {
    open()
    setText(OWNER, TAB, BODY + 'X=1\n')
    write.mockRejectedValue(
      new Error("Error invoking remote method 'edit:write': Error: KOLOFT_NO_PERM")
    )

    await expect(saveTab(OWNER, TAB)).resolves.toBe('failed')
    expect(isTabDirty(OWNER, TAB)).toBe(true)
    expect(getEntry(OWNER, TAB)?.text).toBe(BODY + 'X=1\n')
    expect(getEntry(OWNER, TAB)?.error).toMatch(/permission|allowed/i)
  })

  it('tells a missing FOLDER apart from a missing file, and offers no way back', async () => {
    // The two are one letter apart in the code and worlds apart on screen: a file that is
    // gone can be written again at the same path, a folder that is gone cannot, so the
    // sentence for it must not suggest trying.
    open()
    setText(OWNER, TAB, BODY + 'X=1\n')
    write.mockRejectedValue(new Error('KOLOFT_DIR_GONE'))

    await expect(saveTab(OWNER, TAB)).resolves.toBe('failed')
    expect(getEntry(OWNER, TAB)?.error).toMatch(/folder/i)
    expect(getEntry(OWNER, TAB)?.error).not.toMatch(/again|retry/i)
  })
})

// B-15/B-20 — the one decision every "the disk was looked at" path goes through: the
// watcher's stamp-only event, the read it triggers, and the editor's own mount after a
// session switch.
describe('reconcileDisk', () => {
  const moved = { mtimeMs: 5000, size: 12 }

  it('does nothing for the stamp the buffer already holds', () => {
    open()
    setText(OWNER, TAB, BODY + 'X=1\n')
    reconcileDisk(OWNER, TAB, { text: 'other', stamp: STAMP })
    expect(getEntry(OWNER, TAB)?.text).toBe(BODY + 'X=1\n')
    expect(getEntry(OWNER, TAB)?.conflict).toBeNull()
  })

  it('takes the file into a clean buffer', () => {
    open()
    reconcileDisk(OWNER, TAB, { text: 'from disk\n', stamp: moved })
    expect(getEntry(OWNER, TAB)?.text).toBe('from disk\n')
    expect(getEntry(OWNER, TAB)?.stamp).toEqual(moved)
    expect(isTabDirty(OWNER, TAB)).toBe(false)
  })

  it('reads a file holding exactly what the box holds as the buffer being clean, not a conflict', () => {
    // our own save, read back by a remount before the write's answer reached the registry
    open()
    setText(OWNER, TAB, BODY + 'X=1\n')
    reconcileDisk(OWNER, TAB, { text: BODY + 'X=1\n', stamp: moved })
    expect(isTabDirty(OWNER, TAB)).toBe(false)
    expect(getEntry(OWNER, TAB)?.conflict).toBeNull()
  })

  it('raises a conflict over a dirty buffer and overwrites nothing', () => {
    open()
    setText(OWNER, TAB, BODY + 'X=1\n')
    reconcileDisk(OWNER, TAB, { text: 'from disk\n', stamp: moved })
    expect(getEntry(OWNER, TAB)?.text).toBe(BODY + 'X=1\n')
    expect(getEntry(OWNER, TAB)?.conflict).toEqual({
      text: 'from disk\n',
      stamp: moved,
      unreadable: false
    })
  })

  it('never lets a stamp-only event throw away the text a known conflict already carries', () => {
    open()
    setText(OWNER, TAB, BODY + 'X=1\n')
    reconcileDisk(OWNER, TAB, { text: 'from disk\n', stamp: moved })
    reconcileDisk(OWNER, TAB, { text: null, stamp: moved })
    expect(getEntry(OWNER, TAB)?.conflict?.text).toBe('from disk\n')
  })
})

describe('leaving the buffer', () => {
  it('discard puts the file’s own text back without writing anything', () => {
    open()
    setText(OWNER, TAB, BODY + 'X=1\n')
    discardTab(OWNER, TAB)
    expect(isTabDirty(OWNER, TAB)).toBe(false)
    expect(getEntry(OWNER, TAB)?.text).toBe(BODY)
    expect(write).not.toHaveBeenCalled()
  })

  it('flattens what came off disk, so a CRLF file does not read as every line changed', () => {
    // the buffer holds LF (the textarea flattens on the way in) while the file and every
    // answer about it hold CRLF, and a diff between the two calls every single line changed
    open('a\r\nb\r\n', 'crlf')
    setText(OWNER, TAB, 'a\nb\nc\n')
    noteConflict(OWNER, TAB, {
      text: 'a\r\nb\r\nZ\r\n',
      stamp: { mtimeMs: 9000, size: 15 },
      unreadable: false
    })
    expect(getEntry(OWNER, TAB)?.conflict?.text).toBe('a\nb\nZ\n')
  })

  it('flattens the disk text a refused save brought back, for the same reason', async () => {
    open('a\r\nb\r\n', 'crlf')
    setText(OWNER, TAB, 'a\nb\nc\n')
    write.mockResolvedValue({
      ok: false,
      code: 'stale',
      mtimeMs: 9000,
      size: 15,
      text: 'a\r\nb\r\nZ\r\n'
    })
    await saveTab(OWNER, TAB)
    expect(getEntry(OWNER, TAB)?.conflict?.text).toBe('a\nb\nZ\n')
  })

  it('lists clean buffers too, so a closed tab’s buffer can be swept', () => {
    open()
    expect(allDirtyTabs()).toEqual([])
    expect(allEditTabs()).toEqual([{ ownerTabId: OWNER, tabId: TAB, path: PATH }])
  })

  it('a reload from disk replaces both the text and the baseline (BB-M09/BB-C16)', () => {
    open()
    setText(OWNER, TAB, BODY + 'MINE=1\n')
    noteConflict(OWNER, TAB, {
      text: 'THEIRS=1\n',
      stamp: { mtimeMs: 9000, size: 12 },
      unreadable: false
    })

    applyDisk(OWNER, TAB, 'THEIRS=1\n', { mtimeMs: 9000, size: 12 })

    expect(getEntry(OWNER, TAB)?.text).toBe('THEIRS=1\n')
    expect(isTabDirty(OWNER, TAB)).toBe(false)
    expect(getEntry(OWNER, TAB)?.conflict).toBeNull()
    expect(getEntry(OWNER, TAB)?.stamp).toEqual({ mtimeMs: 9000, size: 12 })
  })

  it('dismissing the conflict bar leaves the typing exactly where it was', () => {
    open()
    setText(OWNER, TAB, BODY + 'MINE=1\n')
    noteConflict(OWNER, TAB, {
      text: 'THEIRS=1\n',
      stamp: { mtimeMs: 9000, size: 12 },
      unreadable: false
    })
    clearConflict(OWNER, TAB)
    expect(getEntry(OWNER, TAB)?.conflict).toBeNull()
    expect(getEntry(OWNER, TAB)?.text).toBe(BODY + 'MINE=1\n')
    expect(isTabDirty(OWNER, TAB)).toBe(true)
  })

  it('closing the tab forgets it, so a dead tab can never hold the quit guard open', () => {
    open()
    setText(OWNER, TAB, BODY + 'X=1\n')
    endEdit(OWNER, TAB)
    expect(getEntry(OWNER, TAB)).toBeUndefined()
    expect(isTabDirty(OWNER, TAB)).toBe(false)
    expect(allDirtyTabs()).toEqual([])
  })
})
