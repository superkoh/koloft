import type { SessionBackend } from './agentUi'
import type {
  ResumeEvidence,
  ResumePlan,
  SessionResumeRequest,
  SessionResumeResult
} from '@shared/types'
import { basename } from '@shared/preview'
import { markRestoreLaunch, useStore } from './store'

/**
 * the lifecycle contract §4 — the one resume path. Every entry point (sidebar cold row and its
 * menu, the welcome panel's Recent list, the new-session dialog's "Restore from
 * history") calls `resumeSession`; main's `resumePlan` verdict decides whether that
 * ends in a silent spawn or a dialog. The renderer never probes git and never
 * pre-gates on `invalidCwd` — a missing worktree is the rebuild branch (D6), not a
 * dead row.
 */

/** Who a resume is for. `title` names the new tab and every dialog; the id is the
 *  claude session id, which is what `--resume` takes. */
export interface ResumeTarget {
  backendId?: SessionBackend
  id: string
  title: string
  /** started from "Restore from history" (D5): there is no sidebar row to explain a
   *  launch that dies before binding, so that failure needs a toast of its own. */
  restore?: boolean
}

type RebuildPlan = Extract<ResumePlan, { action: 'rebuild' }>
type DialogPlan = Extract<ResumePlan, { action: 'dialog' }>

/** The dialog a plan raised, or null. App renders it; the buttons come back through
 *  `runResume` / `cancelResume`. */
export type ResumeDialogState =
  | { kind: 'choose'; target: ResumeTarget; plan: DialogPlan }
  /** D12 — reached only after a rebuild actually failed, never offered up front */
  | { kind: 'escape'; target: ResumeTarget; worktreeName: string; cwd: string }

export type ResumeStep =
  | { kind: 'spawn'; req: SessionResumeRequest }
  | { kind: 'dialog'; dialog: ResumeDialogState }
  | { kind: 'notice'; message: string }

/** D6: nothing to resume into. Non-blocking — the transcript is still on disk. */
export const UNAVAILABLE_NOTICE = "This session's directory no longer exists — transcript only."
/** D5: a restore whose pty died before any session bound. */
export const RESTORE_FAILED_NOTICE = 'Failed to restore session.'

/** Main's verdict → what the renderer does with it. */
export function planToStep(plan: ResumePlan, target: ResumeTarget): ResumeStep {
  switch (plan.action) {
    case 'direct':
      return { kind: 'spawn', req: { sessionId: target.id, cwd: plan.cwd, mode: 'direct' } }
    case 'rebuild':
      // (user decided): no confirmation stop — the sidebar row already says
      // "worktree deleted; click to rebuild and resume", so the click is the consent
      // (D6: missing → rebuild, then resume). A failed rebuild still opens the D12 escape.
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

/** §4.1 destructive choice: resume where the session was recorded and let claude
 *  re-enter the worktree it finds — which is what may reset it (V3). */
export function existingRequest(target: ResumeTarget, plan: DialogPlan): SessionResumeRequest {
  return { sessionId: target.id, cwd: plan.resumeCwd, mode: 'direct' }
}

/** §4.1 safe choice: `--resume <id> -w <new name>` (D10, E4-verified). */
export function renamedRequest(target: ResumeTarget, plan: DialogPlan): SessionResumeRequest {
  return { sessionId: target.id, cwd: plan.resumeCwd, mode: 'renamed', worktree: plan.renamedName }
}

/** D12 escape hatch: no isolation, and only ever after a rebuild failure. */
export function mainRequest(target: ResumeTarget, cwd: string): SessionResumeRequest {
  return { sessionId: target.id, cwd, mode: 'main' }
}

/** One row of the §4.1 evidence block. `tone` colors the whole row — amber for a fact
 *  the user should weigh, red for the one that can cost someone else's work. */
export interface EvidenceLine {
  label: string
  text: string
  tone?: 'warn' | 'danger'
}

/** The evidence as read at resume time (D9) — never persisted, never inferred here:
 *  this only words what main probed. */
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

/** D9 honest boundary: Koloft only knows about the claude processes it launched itself.
 *  A transcript written this recently may belong to one running outside Koloft. */
export const RUNNING_ELSEWHERE_MS = 60_000
export function mayBeRunningElsewhere(mtime: number, now: number): boolean {
  return now - mtime < RUNNING_ELSEWHERE_MS
}

export function resumeFailureMessage(
  code: Extract<SessionResumeResult, { ok: false }>['code'],
  /** what the session method itself said — the only line the user can act on */
  message?: string
): string {
  if (code === 'backend') return message || 'Resume failed'
  return code === 'cwd-missing' ? 'Folder is gone — cannot resume here' : 'Resume failed'
}

/** Sessions with a resume in flight — dedupes double clicks, and a second click on a
 *  mid-resume row means "show me" instead of a second pty. Lives here, not in the
 *  sidebar, because the dialogs hold a resume open across several user actions. */
const inFlight = new Set<string>()
/** D5 restores among them: a restore target has NO sidebar row until it binds (the
 *  pending row is keyed by the launching pty), so the cold-row sweep below would let
 *  go of it on the very first rows push — and a second ⌘N → Restore click would put a
 *  second pty on the same transcript. These are released by the bind or by their pty's
 *  death instead (releaseResume, driven from App). */
const restoreIds = new Set<string>()

export function resumeInFlight(id: string): boolean {
  return inFlight.has(id)
}

/** a reloaded renderer adopted a pty that is still mid-resume — re-arm
 *  the dedupe the old renderer held, so a click on the still-cold row focuses the
 *  adopted tab instead of racing a second pty onto the same transcript. Also marked
 *  a restore: adoption can't tell a D5 restore from a member resume, and only the
 *  restore marking survives the cold-row sweep (a restore has no row until it
 *  binds). Strictly safer for members too — release-by-bind and release-by-death
 *  still fire for both. */
export function rearmResume(sessionId: string): void {
  inFlight.add(sessionId)
  restoreIds.add(sessionId)
}

/** Release every id that is no longer a cold row — it landed as running, or its row
 *  vanished. Driven by the rows push, which is the only report that a resume finished. */
export function releaseSettledResumes(coldIds: Set<string>): void {
  for (const id of [...inFlight]) {
    if (!coldIds.has(id) && !restoreIds.has(id)) inFlight.delete(id)
  }
}

/** This resume is over: its session bound, or the pty carrying it died. Both are
 *  reported per-tab, so they reach ids the cold-row sweep can never settle — a restore
 *  (no row yet) and a member row whose resume died before binding (row still cold). */
export function releaseResume(sessionId: string): void {
  inFlight.delete(sessionId)
  restoreIds.delete(sessionId)
  // a resume that ends without a tab (failed, cancelled, died pre-bind) must take its
  // click-time placeholder down, or the mask would sit over the island for good
  const st = useStore.getState()
  if (st.resumeLaunch?.id === sessionId) st.setResumeLaunch(null)
}

export function cancelResume(target: ResumeTarget): void {
  releaseResume(target.id)
  useStore.getState().setResumeDialog(null)
}

/** Execute one decided request: the direct branch and every dialog button end here. */
export async function runResume(target: ResumeTarget, req: SessionResumeRequest): Promise<void> {
  const st = useStore.getState()
  st.setResumeDialog(null)
  try {
    const res = await window.api.sessions.resume(req)
    if (!res.ok) {
      // D12: the rebuild is the only failure with somewhere left to go — keep the
      // resume in flight and offer main without isolation
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
    // resuming:true keeps the "Resuming Claude session…" overlay up until the session
    // binds (§4/T-LIFE-06); the dedupe entry stays until the rows push reports the id
    // running, or a second click would race a second pty onto the same session.
    st.addTab({
      id: res.id,
      kind: res.kind ?? target.backendId ?? 'claude',
      title: target.title,
      cwd: res.cwd,
      // known from birth on a resume — the row's highlight and launch bar key off it
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

/** The entry point (§4): ask main what this resume is, then do it or ask the user. */
export async function resumeSession(target: ResumeTarget): Promise<void> {
  if (inFlight.has(target.id)) return
  inFlight.add(target.id)
  if (target.restore) restoreIds.add(target.id)
  // answer the click NOW, before main is asked anything: the island shows the resume
  // mask and the row reads selected while the plan probes and the spawn run. `addTab`
  // hands over to the tab's own mask; every other ending goes through releaseResume.
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
