import { useEffect, useRef, type JSX } from 'react'
import { useStore } from '../store'
import {
  cancelResume,
  evidenceLines,
  existingRequest,
  mainRequest,
  renamedRequest,
  runResume
} from '../resumeFlow'

/**
 * the lifecycle contract §4 — everything the resume decision tree has to ask. Which of the two
 * is up is main's verdict (`sessions:resumePlan`), never a renderer guess: a green
 * plan resumes silently — and since the decision so does a rebuild — so
 * neither ever reaches this component (D6/D8).
 */
export function ResumeDialog(): JSX.Element | null {
  const dialog = useStore((s) => s.resumeDialog)
  // the SAFE button in each dialog — nothing here is one keystroke from destroying a
  // worktree (§4.1: any anomaly at all defaults to the new one)
  const safeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (dialog) safeRef.current?.focus()
  }, [dialog])

  useEffect(() => {
    if (!dialog) return
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') cancelResume(dialog.target)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog])

  if (!dialog) return null
  const dismiss = (): void => cancelResume(dialog.target)

  const shell = (title: string, body: JSX.Element, foot: JSX.Element): JSX.Element => (
    <div className="modal-backdrop" onClick={dismiss}>
      <div className="modal lifecycle-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">{title}</div>
        <div className="modal-body">{body}</div>
        <div className="modal-foot">{foot}</div>
      </div>
    </div>
  )

  if (dialog.kind === 'escape') {
    const { target, worktreeName, cwd } = dialog
    return shell(
      'Could not rebuild the worktree',
      <>
        <p className="field-hint">
          The worktree <code>{worktreeName}</code> could not be recreated.
        </p>
        <p className="field-hint">
          This session can still be resumed in <code>{cwd}</code>, but it will run there with no
          isolation — every file it touches lands in that checkout.
        </p>
      </>,
      <>
        {/* D12: the escape hatch is offered, never preselected — Cancel keeps the focus */}
        <button ref={safeRef} className="mini" onClick={dismiss}>
          Cancel
        </button>
        <button
          className="mini danger"
          onClick={() => void runResume(target, mainRequest(target, cwd))}
        >
          Resume in main without isolation
        </button>
      </>
    )
  }

  const { plan, target } = dialog
  return shell(
    `Resume "${target.title}"`,
    <>
      <p className="field-hint">
        This session&apos;s worktree <code>{plan.evidence.worktreeName}</code> currently exists, but
        it doesn&apos;t look the way this session left it. Choose where to resume:
      </p>
      <div className="ev-meta">
        {evidenceLines(plan.evidence).map((l) => (
          <div className="ev-row" key={l.label}>
            <span className="ev-label">{l.label}</span>
            <span className={'ev-text' + (l.tone ? ' ev-' + l.tone : '')}>{l.text}</span>
          </div>
        ))}
      </div>
    </>,
    <>
      <button className="mini" onClick={dismiss}>
        Cancel
      </button>
      {/* the reset warning belongs ON the destructive button (§4.1), not in small print */}
      <button
        className="mini danger"
        title="May reset the worktree to this session's baseline"
        onClick={() => void runResume(target, existingRequest(target, plan))}
      >
        Resume in existing worktree — may reset it
      </button>
      <button
        ref={safeRef}
        className="btn-primary"
        onClick={() => void runResume(target, renamedRequest(target, plan))}
      >
        {`Resume in new worktree "${plan.renamedName}"`}
      </button>
    </>
  )
}
