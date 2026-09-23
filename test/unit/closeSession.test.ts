import { describe, expect, it } from 'vitest'
import type { SessionInfo, SessionStatus } from '@shared/types'
import {
  closeConfirmBody,
  closeTabIntent,
  CLOSE_CONFIRM_TITLE,
  unexpectedExitNotice,
  unexpectedExitWanted,
  unsavedBody,
  unsavedFilesPhrase
} from '../../src/renderer/src/closeSession'

describe('unexpectedExitWanted', () => {
  const crash = { exitCode: 1 }
  it('wants the line for an ordinary claude tab that ended badly', () => {
    expect(unexpectedExitWanted({ kind: 'claude', sessionId: 's1' }, crash)).toBe(true)
    expect(unexpectedExitWanted({ kind: 'claude' }, { exitCode: 0, signal: 9 })).toBe(true)
  })
  it('reports Codex crashes using its own source', () => {
    expect(unexpectedExitWanted({ kind: 'codex', sessionId: 'codex:local:a' }, crash)).toBe(true)
    expect(unexpectedExitNotice(crash, 'codex')).toContain('Codex')
  })
  it('does not want it for a clean exit, or for a tab that is not a conversation', () => {
    expect(unexpectedExitWanted({ kind: 'claude', sessionId: 's1' }, { exitCode: 0 })).toBe(false)
    expect(unexpectedExitWanted({ kind: 'terminal' }, crash)).toBe(false)
    expect(unexpectedExitWanted(undefined, crash)).toBe(false)
  })
  it('stands aside for a scheduled run that never bound, but not for one that did', () => {
    expect(unexpectedExitWanted({ kind: 'claude', jobId: 'j1' }, crash)).toBe(false)
    expect(unexpectedExitWanted({ kind: 'claude', jobId: 'j1', sessionId: 's1' }, crash)).toBe(true)
  })
})

const sess = (tabId: string, over: Partial<SessionInfo> = {}): SessionInfo => ({
  tabId,
  sessionId: 'sid-' + tabId,
  title: 'Refactor session management',
  cwd: '/w',
  treeRoot: '/w',
  jsonlPath: '/j',
  files: [],
  alive: true,
  updatedAt: 0,
  ...over
})

const tab = (
  id: string,
  kind: 'claude' | 'shell' = 'claude'
): { id: string; kind: 'claude' | 'shell'; title: string } => ({
  id,
  kind,
  title: 'Claude'
})

describe('closeTabIntent (D3 ⌘W gate)', () => {
  it('asks before closing a working session, naming it', () => {
    expect(closeTabIntent(tab('t1'), [sess('t1', { status: 'working' })])).toEqual({
      kind: 'confirm',
      status: 'working',
      title: 'Refactor session management'
    })
  })

  it('asks before closing a session parked on a permission prompt', () => {
    expect(closeTabIntent(tab('t1'), [sess('t1', { status: 'approval' })])).toEqual({
      kind: 'confirm',
      status: 'approval',
      title: 'Refactor session management'
    })
  })

  it('closes an idle / waiting / statusless session silently', () => {
    for (const status of [undefined, 'idle', 'waiting'] as (SessionStatus | undefined)[]) {
      expect(closeTabIntent(tab('t1'), [sess('t1', { status })]), String(status)).toEqual({
        kind: 'close'
      })
    }
  })

  it('closes a PENDING launch silently — ⌘W stays its Cancel (T-KEY-02)', () => {
    const pending = sess('t1', { sessionId: '', status: 'working' })
    expect(closeTabIntent(tab('t1'), [pending])).toEqual({ kind: 'close' })
  })

  it('closes a tab whose session is already gone', () => {
    expect(closeTabIntent(tab('t1'), [])).toEqual({ kind: 'close' })
    expect(closeTabIntent(tab('t1'), [sess('t1', { alive: false, status: 'working' })])).toEqual({
      kind: 'close'
    })
  })

  it('asks for a working session hosted by a shell tab — the session is what is at risk', () => {
    expect(closeTabIntent(tab('t1', 'shell'), [sess('t1', { status: 'working' })])).toEqual({
      kind: 'confirm',
      status: 'working',
      title: 'Refactor session management'
    })
  })

  it('does nothing with no active tab', () => {
    expect(closeTabIntent(undefined, [sess('t1', { status: 'working' })])).toEqual({ kind: 'none' })
  })
})

describe('close confirmation copy (§3.1)', () => {
  it('names the session and promises it survives, per status', () => {
    expect(CLOSE_CONFIRM_TITLE).toBe('Close running session?')
    expect(closeConfirmBody('My run', 'working')).toBe(
      '"My run" is still working on a task. Closing will interrupt the current turn. The session stays in the list and can be resumed anytime.'
    )
    expect(closeConfirmBody('My run', 'approval')).toBe(
      '"My run" has a pending permission prompt. Closing will discard it. The session stays in the list and can be resumed anytime.'
    )
  })
})

describe('unsaved-changes copy (§03 figure 3)', () => {
  it('names the file when there is one', () => {
    expect(unsavedFilesPhrase(['apps/api/.env'])).toBe('apps/api/.env')
  })

  it('joins two with "and", and three with a comma plus "and"', () => {
    expect(unsavedFilesPhrase(['a.txt', 'b.txt'])).toBe('a.txt and b.txt')
    expect(unsavedFilesPhrase(['a.txt', 'b.txt', 'c.txt'])).toBe('a.txt, b.txt and c.txt')
  })

  it('collapses to a count past three — four names no longer read as a sentence', () => {
    expect(unsavedFilesPhrase(['a', 'b', 'c', 'd'])).toBe('4 files')
    expect(unsavedFilesPhrase(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('7 files')
  })

  it('says what is lost and that nothing is kept behind the scenes', () => {
    expect(unsavedBody(['apps/api/.env'])).toBe(
      'Unsaved changes in apps/api/.env. Closing loses them — Koloft keeps no drafts.'
    )
    expect(unsavedBody(['a', 'b', 'c', 'd'])).toBe(
      'Unsaved changes in 4 files. Closing loses them — Koloft keeps no drafts.'
    )
  })
})

describe('closeConfirmBody with unsaved files (B-25 merged dialog)', () => {
  it('leaves the copy untouched when nothing is dirty', () => {
    expect(closeConfirmBody('My run', 'working')).toBe(closeConfirmBody('My run', 'working', []))
  })

  it('splices the file warning in, naming the file', () => {
    expect(closeConfirmBody('My run', 'working', ['apps/api/.env'])).toBe(
      '"My run" is still working on a task. Closing will interrupt the current turn.' +
        ' It also has unsaved changes in apps/api/.env, which closing will lose.' +
        ' The session stays in the list and can be resumed anytime.'
    )
  })

  it('collapses to a count past three, on the approval variant too', () => {
    expect(closeConfirmBody('My run', 'approval', ['a', 'b', 'c', 'd'])).toBe(
      '"My run" has a pending permission prompt. Closing will discard it.' +
        ' It also has unsaved changes in 4 files, which closing will lose.' +
        ' The session stays in the list and can be resumed anytime.'
    )
  })
})

// PLATFORM§29
describe('unexpectedExitNotice (the one account of a session that died)', () => {
  it('names the signal for a killed claude, the code for an error exit', () => {
    expect(unexpectedExitNotice({ exitCode: 0, signal: 9 })).toContain('signal 9')
    expect(unexpectedExitNotice({ exitCode: 1 })).toContain('exit code 1')
  })
})
