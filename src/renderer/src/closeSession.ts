import { BACKEND_LABEL } from '@shared/sessionBackend'
import { SHIM_FOUND_NO_ACCOUNT_EXIT, SHIM_FOUND_NO_ACCOUNT_NOTICE } from '@shared/accountUsage'
import { isSessionKind, type SessionBackend } from './agentUi'
import type { SessionInfo, TabKind, TerminalExit } from '@shared/types'

export type BusyStatus = 'working' | 'approval'

export type CloseIntent =
  { kind: 'none' } | { kind: 'close' } | { kind: 'confirm'; status: BusyStatus; title: string }

export const CLOSE_CONFIRM_TITLE = 'Close running session?'

export function closeTabIntent(
  tab: { id: string; kind: TabKind; title: string; ended?: unknown } | undefined,
  sessions: SessionInfo[]
): CloseIntent {
  if (!tab) return { kind: 'none' }
  if (tab.ended) return { kind: 'close' }
  const bound = sessions.find((s) => s.tabId === tab.id && s.alive && !!s.sessionId)
  if (bound && (bound.status === 'working' || bound.status === 'approval')) {
    return { kind: 'confirm', status: bound.status, title: bound.title || tab.title }
  }
  return { kind: 'close' }
}

function busyLead(title: string, status: BusyStatus): string {
  return status === 'approval'
    ? `"${title}" has a pending permission prompt. Closing will discard it.`
    : `"${title}" is still working on a task. Closing will interrupt the current turn.`
}

export function closeConfirmBody(title: string, status: BusyStatus, dirty: string[] = []): string {
  const files = dirty.length
    ? ` It also has unsaved changes in ${unsavedFilesPhrase(dirty)}, which closing will lose.`
    : ''
  return `${busyLead(title, status)}${files} The session stays in the list and can be resumed anytime.`
}

export interface FullCloseTarget {
  tabId: string
  sessionId: string
  title: string
  status?: BusyStatus
}

export function fullCloseTarget(
  tab:
    | (Parameters<typeof closeTabIntent>[0] & {
        jobId?: string
        sessionId?: string
        resuming?: boolean
        asleep?: true
      })
    | undefined,
  sessions: SessionInfo[]
): FullCloseTarget | null {
  if (!tab || !isSessionKind(tab.kind) || tab.ended || tab.jobId !== undefined) return null
  const bound = sessions.find((s) => s.tabId === tab.id)
  if (bound?.overseer) return null
  const sessionId = bound?.sessionId || ((tab.resuming || tab.asleep) && tab.sessionId)
  if (!sessionId) return null
  const intent = closeTabIntent(tab, sessions)
  return {
    tabId: tab.id,
    sessionId,
    title: bound?.title || tab.title,
    ...(intent.kind === 'confirm' && { status: intent.status })
  }
}

export const FULL_CLOSE_TITLE = 'Close session for good?'
export const FULL_CLOSE_CHECKING = 'Checking what closing would lose…'

export function fullCloseBody(title: string, status?: BusyStatus): string {
  const busy = status ? `${busyLead(title, status)} ` : ''
  return `${busy}Closing "${title}" for good ends it, takes its row out of the list and deletes its git worktree and branch if it has one. It cannot be resumed from the list afterwards.`
}

export function fullCloseRefusedBody(title: string): string {
  return `Koloft cannot close "${title}" for good. You can still close just its tab: the session stays in the list.`
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

export function sessionEndedBody(title: string, files: string[]): string {
  return `"${title}" ended with unsaved changes in ${unsavedFilesPhrase(files)}. Keep for later holds them until you quit Koloft, which asks again.`
}

export function unexpectedExitNotice(
  exit: { exitCode: number; signal?: number; accountIssue?: string },
  backend: SessionBackend,
  everBound: boolean
): string {
  const agent = BACKEND_LABEL[backend]
  // ADR-0030
  if (backend === 'claude' && !exit.signal && exit.exitCode === SHIM_FOUND_NO_ACCOUNT_EXIT)
    return exit.accountIssue || SHIM_FOUND_NO_ACCOUNT_NOTICE
  // PLATFORM§29
  const how = exit.signal ? `killed by signal ${exit.signal}` : `exit code ${exit.exitCode}`
  if (!everBound) return `${agent} closed before the session started (${how})`
  if (exit.signal) return `${agent} session ended: ${how}`
  return `${agent} session ended unexpectedly (${how})`
}

export function unexpectedExitWanted<
  T extends { kind: string; sessionId?: string; jobId?: string }
>(
  tab: T | undefined,
  exit: Pick<TerminalExit, 'unexpected'>,
  runStarted: boolean
): tab is T & { kind: SessionBackend } {
  if (!tab || !isSessionKind(tab.kind) || !exit.unexpected) return false
  return !(tab.jobId !== undefined && tab.sessionId === undefined && !runStarted)
}
