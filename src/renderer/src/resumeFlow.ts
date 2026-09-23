import type { SessionBackend } from './agentUi'
import type {
  ResumeEvidence,
  ResumePlan,
  SessionResumeRequest,
  SessionResumeResult
} from '@shared/types'
import { basename } from '@shared/preview'
import { markRestoreLaunch, useStore } from './store'

export interface ResumeTarget {
  backendId?: SessionBackend
  id: string
  title: string
  restore?: boolean
}

type RebuildPlan = Extract<ResumePlan, { action: 'rebuild' }>
type DialogPlan = Extract<ResumePlan, { action: 'dialog' }>

export type ResumeDialogState =
  | { kind: 'choose'; target: ResumeTarget; plan: DialogPlan }
  | { kind: 'escape'; target: ResumeTarget; worktreeName: string; cwd: string }

export type ResumeStep =
  | { kind: 'spawn'; req: SessionResumeRequest }
  | { kind: 'dialog'; dialog: ResumeDialogState }
  | { kind: 'notice'; message: string }

export const UNAVAILABLE_NOTICE = "This session's directory no longer exists — transcript only."
export const RESTORE_FAILED_NOTICE = 'Failed to restore session.'

export function planToStep(plan: ResumePlan, target: ResumeTarget): ResumeStep {
  switch (plan.action) {
    case 'direct':
      return { kind: 'spawn', req: { sessionId: target.id, cwd: plan.cwd, mode: 'direct' } }
    case 'rebuild':
      return { kind: 'spawn', req: rebuildRequest(target, plan) }
    case 'dialog':
      return { kind: 'dialog', dialog: { kind: 'choose', target, plan } }
    case 'unavailable':
      return { kind: 'notice', message: UNAVAILABLE_NOTICE }
  }
}

export function rebuildRequest(target: ResumeTarget, plan: RebuildPlan): SessionResumeRequest {
  return {
    sessionId: target.id,
    cwd: plan.resumeCwd,
    mode: 'rebuild',
    rebuild: { worktreePath: plan.worktreePath, branch: plan.branch, baseRef: plan.baseRef }
  }
}

// CC§3
export function existingRequest(target: ResumeTarget, plan: DialogPlan): SessionResumeRequest {
  return { sessionId: target.id, cwd: plan.resumeCwd, mode: 'direct' }
}

// CC§3
export function renamedRequest(target: ResumeTarget, plan: DialogPlan): SessionResumeRequest {
  return { sessionId: target.id, cwd: plan.resumeCwd, mode: 'renamed', worktree: plan.renamedName }
}

export function mainRequest(target: ResumeTarget, cwd: string): SessionResumeRequest {
  return { sessionId: target.id, cwd, mode: 'main' }
}

export interface EvidenceLine {
  label: string
  text: string
  tone?: 'warn' | 'danger'
}

export function evidenceLines(ev: ResumeEvidence): EvidenceLine[] {
  const lines: EvidenceLine[] = [{ label: 'worktree', text: ev.worktreePath }]
  lines.push(
    ev.branchMatches
      ? { label: 'branch', text: `${ev.currentBranch} (matches record)` }
      : {
          label: 'branch',
          text: `${ev.currentBranch ?? 'detached'} (record: ${ev.expectedBranch})`,
          tone: 'warn'
        }
  )
  lines.push(
    ev.dirty
      ? { label: 'changes', text: 'uncommitted changes', tone: 'warn' }
      : { label: 'changes', text: 'clean' }
  )
  if (ev.occupiedBy) {
    lines.push({
      label: 'in use',
      text: 'another running session is working in this worktree',
      tone: 'danger'
    })
  }
  return lines
}

export const RUNNING_ELSEWHERE_MS = 60_000
export function mayBeRunningElsewhere(mtime: number, now: number): boolean {
  return now - mtime < RUNNING_ELSEWHERE_MS
}

export function resumeFailureMessage(
  code: Extract<SessionResumeResult, { ok: false }>['code'],
  message?: string
): string {
  if (code === 'backend') return message || 'Resume failed'
  return code === 'cwd-missing' ? 'Folder is gone — cannot resume here' : 'Resume failed'
}

const inFlight = new Set<string>()
const restoreIds = new Set<string>()

export function resumeInFlight(id: string): boolean {
  return inFlight.has(id)
}

export function rearmResume(sessionId: string): void {
  inFlight.add(sessionId)
  restoreIds.add(sessionId)
}

export function releaseSettledResumes(coldIds: Set<string>): void {
  for (const id of [...inFlight]) {
    if (!coldIds.has(id) && !restoreIds.has(id)) inFlight.delete(id)
  }
}

export function releaseResume(sessionId: string): void {
  inFlight.delete(sessionId)
  restoreIds.delete(sessionId)
  const st = useStore.getState()
  if (st.resumeLaunch?.id === sessionId) st.setResumeLaunch(null)
}

export function cancelResume(target: ResumeTarget): void {
  releaseResume(target.id)
  useStore.getState().setResumeDialog(null)
}

export async function runResume(target: ResumeTarget, req: SessionResumeRequest): Promise<void> {
  const st = useStore.getState()
  st.setResumeDialog(null)
  try {
    const res = await window.api.sessions.resume(req)
    if (!res.ok) {
      if (res.code === 'rebuild-failed' && req.rebuild) {
        st.setResumeDialog({
          kind: 'escape',
          target,
          worktreeName: basename(req.rebuild.worktreePath),
          cwd: req.cwd
        })
        return
      }
      releaseResume(target.id)
      st.showToast(resumeFailureMessage(res.code, 'message' in res ? res.message : undefined))
      return
    }
    st.addTab({
      id: res.id,
      kind: res.kind ?? target.backendId ?? 'claude',
      title: target.title,
      cwd: res.cwd,
      sessionId: target.id,
      alive: true,
      resuming: true
    })
    if (target.restore) markRestoreLaunch(res.id)
  } catch {
    releaseResume(target.id)
    st.showToast('Resume failed')
  }
}

export async function resumeSession(target: ResumeTarget): Promise<void> {
  if (inFlight.has(target.id)) return
  inFlight.add(target.id)
  if (target.restore) restoreIds.add(target.id)
  useStore.getState().setResumeLaunch({ id: target.id, title: target.title })
  let step: ResumeStep
  try {
    step = planToStep(await window.api.sessions.resumePlan(target.id), target)
  } catch {
    releaseResume(target.id)
    useStore.getState().showToast('Resume failed')
    return
  }
  if (step.kind === 'notice') {
    releaseResume(target.id)
    useStore.getState().showToast(step.message)
    return
  }
  if (step.kind === 'dialog') {
    useStore.getState().setResumeDialog(step.dialog)
    return
  }
  await runResume(target, step.req)
}
