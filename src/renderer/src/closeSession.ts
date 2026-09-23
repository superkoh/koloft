import { backendLabel, isSessionKind, type SessionBackend } from './agentUi'
import type { SessionInfo, TabKind } from '@shared/types'

// the lifecycle contract D3 — the ⌘W policy reversal, kept out of App so the one branch that
// must not move (a pending launch is Cancel, T-KEY-02) is directly testable.

/** What ⌘W does to the active tab: close it outright, ask first, or nothing. */
export type CloseIntent =
  | { kind: 'none' }
  | { kind: 'close' }
  | { kind: 'confirm'; status: 'working' | 'approval'; title: string }

/** Title of the D3 confirmation (§3.1). */
export const CLOSE_CONFIRM_TITLE = 'Close running session?'

/**
 * D3: a bound session closes on ⌘W (it used to be untouchable — the process dies, the
 * row stays cold), but a session mid-turn or holding a permission prompt asks once.
 *
 * The gate is the live BINDING, not `tab.kind`: a pending launch is alive from the
 * moment it spawns and carries no session id, so ⌘W on it stays the Cancel it always
 * was, while a tab whose session has already bound asks before interrupting it.
 */
export function closeTabIntent(
  tab: { id: string; kind: TabKind; title: string } | undefined,
  sessions: SessionInfo[]
): CloseIntent {
  if (!tab) return { kind: 'none' }
  const bound = sessions.find((s) => s.tabId === tab.id && s.alive && !!s.sessionId)
  if (bound && (bound.status === 'working' || bound.status === 'approval')) {
    return { kind: 'confirm', status: bound.status, title: bound.title || tab.title }
  }
  return { kind: 'close' }
}

/** §3.1 body copy. The approval variant swaps what is lost — the prompt, not the turn
 *  — and both close on the same promise, which is the whole point of D3. */
export function closeConfirmBody(
  title: string,
  status: 'working' | 'approval',
  dirty: string[] = []
): string {
  const lead =
    status === 'approval'
      ? `"${title}" has a pending permission prompt. Closing will discard it.`
      : `"${title}" is still working on a task. Closing will interrupt the current turn.`
  // B-25: one question, not two in a row. The file warning goes between D3's lead and
  // D3's promise — the promise is about the session surviving, and putting it after
  // "your edits are gone" would read as if the edits came back too.
  const files = dirty.length
    ? ` It also has unsaved changes in ${unsavedFilesPhrase(dirty)}, which closing will lose.`
    : ''
  return `${lead}${files} The session stays in the list and can be resumed anytime.`
}

/** file-edit §03 figure 3 — header of the unsaved-changes question. */
export const UNSAVED_TITLE = 'Unsaved changes'

/**
 * The files, read out the way figure 3 draws them. Naming the file is the point of the
 * question, so the list only gives up on names once it stops being a readable sentence
 * — past three, a count says more than seven paths in a row.
 */
export function unsavedFilesPhrase(files: string[]): string {
  if (files.length > 3) return `${files.length} files`
  if (files.length <= 1) return files[0] ?? ''
  return `${files.slice(0, -1).join(', ')} and ${files[files.length - 1]}`
}

/** Figure 3's body: what is at stake, and that Koloft is not quietly keeping a copy. */
export function unsavedBody(files: string[]): string {
  return `Unsaved changes in ${unsavedFilesPhrase(files)}. Closing loses them — Koloft keeps no drafts.`
}

/**
 * The toast for a session pty that died without a goodbye. The tab itself is closed
 * either way (a dead session is a cold row, nothing more), so this line is the only
 * account the user gets of a crash, a kill, or a launch that died before binding.
 *
 * node-pty reports a signal death with the exit code still at 0 (pty.cc keeps
 * WIFEXITED and WIFSIGNALED apart), so `signal` is what tells a kill -9 from an error
 * exit — read the code alone and a killed claude would report "exit code 0".
 */
export function unexpectedExitNotice(
  exit: { exitCode: number; signal?: number },
  backend?: SessionBackend
): string {
  return exit.signal
    ? `${backendLabel(backend)} session ended: killed by signal ${exit.signal}`
    : `${backendLabel(backend)} session ended unexpectedly (exit code ${exit.exitCode})`
}

/**
 * Whether a dead pty owes the user that line at all. A conversation tab that ended
 * badly does — with one exception: a scheduled run that died BEFORE it bound.
 * Main has already said "⏰ <job> could not start: Claude exited before it started" on
 * that job's behalf and written it into the job's history, and the toast slot holds a
 * single line, so this one would only paint over the better one. A run that bound and
 * then died is an ordinary session death and gets the line like any other.
 */
export function unexpectedExitWanted(
  tab: { kind: string; sessionId?: string; jobId?: string } | undefined,
  exit: { exitCode: number; signal?: number }
): boolean {
  if (!tab || !isSessionKind(tab.kind)) return false
  if (exit.exitCode === 0 && !exit.signal) return false
  return !(tab.jobId !== undefined && tab.sessionId === undefined)
}
