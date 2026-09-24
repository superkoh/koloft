import { BACKEND_LABEL } from '@shared/sessionBackend'
import { isSessionKind, type SessionBackend } from './agentUi'
import type { SessionInfo, TabKind } from '@shared/types'

export type CloseIntent =
  | { kind: 'none' }
  | { kind: 'close' }
  | { kind: 'confirm'; status: 'working' | 'approval'; title: string }

export const CLOSE_CONFIRM_TITLE = 'Close running session?'

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

export function closeConfirmBody(
  title: string,
  status: 'working' | 'approval',
  dirty: string[] = []
): string {
  const lead =
    status === 'approval'
      ? `"${title}" has a pending permission prompt. Closing will discard it.`
      : `"${title}" is still working on a task. Closing will interrupt the current turn.`
  const files = dirty.length
    ? ` It also has unsaved changes in ${unsavedFilesPhrase(dirty)}, which closing will lose.`
    : ''
  return `${lead}${files} The session stays in the list and can be resumed anytime.`
}

export const UNSAVED_TITLE = 'Unsaved changes'

export function unsavedFilesPhrase(files: string[]): string {
  if (files.length > 3) return `${files.length} files`
  if (files.length <= 1) return files[0] ?? ''
  return `${files.slice(0, -1).join(', ')} and ${files[files.length - 1]}`
}

export function unsavedBody(files: string[]): string {
  return `Unsaved changes in ${unsavedFilesPhrase(files)}. Closing loses them — Koloft keeps no drafts.`
}

export function unexpectedExitNotice(
  exit: { exitCode: number; signal?: number },
  backend: SessionBackend
): string {
  // PLATFORM§29
  return exit.signal
    ? `${BACKEND_LABEL[backend]} session ended: killed by signal ${exit.signal}`
    : `${BACKEND_LABEL[backend]} session ended unexpectedly (exit code ${exit.exitCode})`
}

export function unexpectedExitWanted<
  T extends { kind: string; sessionId?: string; jobId?: string }
>(
  tab: T | undefined,
  exit: { exitCode: number; signal?: number }
): tab is T & { kind: SessionBackend } {
  if (!tab || !isSessionKind(tab.kind)) return false
  // PLATFORM§29
  if (exit.exitCode === 0 && !exit.signal) return false
  return !(tab.jobId !== undefined && tab.sessionId === undefined)
}
