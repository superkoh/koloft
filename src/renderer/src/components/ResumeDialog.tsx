import { useEffect, useRef, type JSX } from 'react'
import { useStore } from '../store'
import {
  cancelResume,
  existingRequest,
  mainRequest,
  renamedRequest,
  runResume
} from '../resumeFlow'

export function ResumeDialog(): JSX.Element | null {
  const dialog = useStore((s) => s.resumeDialog)
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
        Another running session is working in this session&apos;s worktree{' '}
        <code>{plan.worktreeName}</code>. Choose where to resume:
      </p>
      <div className="ev-meta">
        <div className="ev-row">
          <span className="ev-label">worktree</span>
          <span className="ev-text">{plan.worktreePath}</span>
        </div>
        <div className="ev-row">
          <span className="ev-label">in use</span>
          <span className="ev-text ev-danger">{plan.occupiedBy}</span>
        </div>
      </div>
    </>,
    <>
      <button className="mini" onClick={dismiss}>
        Cancel
      </button>
      <button
        className="mini danger"
        title="Both sessions will edit the same files"
        onClick={() => void runResume(target, existingRequest(target, plan))}
      >
        Resume in the same worktree
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
