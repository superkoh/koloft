import { memo, useCallback, useEffect, useState, type JSX } from 'react'
import { IconBranch, IconCommit, IconPush } from '../icons'
import type { GitHead, GitReadiness, GitStepResult } from '@shared/types'
import { useStore } from '../store'
import { CommitDialog } from './CommitDialog'
import { branchOf } from './gitChangeSet'
import type { WorkbenchPartView } from '../slots'

const DETACHED_LABEL = 'detached HEAD'

export const headLabel = (head: GitHead): string => branchOf(head) ?? DETACHED_LABEL

export function useGitEntry({
  treeRoot,
  head,
  reread,
  onStepped,
  closeOtherMenus
}: {
  treeRoot: string | null
  head: GitHead | null
  reread: () => void
  onStepped: () => void
  closeOtherMenus: () => void
}): WorkbenchPartView {
  const [menuRoot, setMenuRoot] = useState<string | null>(null)
  const [commitRoot, setCommitRoot] = useState<string | null>(null)
  const [pushing, setPushing] = useState<ReadonlySet<string>>(() => new Set())
  const [readiness, setReadiness] = useState<{ root: string; got: GitReadiness | null } | null>(
    null
  )

  useEffect(() => setMenuRoot(null), [treeRoot])

  const menuOpen = !!treeRoot && menuRoot === treeRoot
  const closeMenu = useCallback((): void => setMenuRoot(null), [])
  const openMenu = useCallback((): void => {
    if (!treeRoot) return
    closeOtherMenus()
    setMenuRoot(treeRoot)
    setReadiness(null)
    void window.api.git.readiness(treeRoot).then((got) => setReadiness({ root: treeRoot, got }))
  }, [treeRoot, closeOtherMenus])

  const step = useCallback(
    async (run: Promise<GitStepResult>, done: string): Promise<boolean> => {
      const r = await run
      useStore.getState().showToast(r.ok ? done : r.reason)
      if (r.ok) {
        reread()
        onStepped()
      }
      return r.ok
    },
    [reread, onStepped]
  )

  const push = useCallback(
    (root: string): void => {
      setPushing((s) => new Set(s).add(root))
      void step(window.api.git.push(root), 'Pushed.').finally(() =>
        setPushing((s) => {
          const next = new Set(s)
          next.delete(root)
          return next
        })
      )
    },
    [step]
  )

  const isPushing = !!treeRoot && pushing.has(treeRoot)
  const button = treeRoot && head && (
    <GitButton label={headLabel(head)} pushing={isPushing} onMenu={openMenu} />
  )
  const known = readiness && readiness.root === treeRoot ? readiness.got : null
  const layer = (
    <>
      {menuOpen && head && (
        <GitMenu
          head={known?.head ?? head}
          readiness={known}
          pushing={isPushing}
          onClose={closeMenu}
          onCommit={() => setCommitRoot(treeRoot)}
          onPush={() => push(treeRoot)}
        />
      )}
      {commitRoot && commitRoot === treeRoot && (
        <CommitDialog
          branch={branchOf(head)}
          onCancel={() => setCommitRoot(null)}
          onCommit={async (message) => {
            const ok = await step(window.api.git.commit(commitRoot, message), 'Committed.')
            if (ok) setCommitRoot(null)
            return ok
          }}
        />
      )}
    </>
  )
  return { button, layer, menuOpen, closeMenu }
}

const GitButton = memo(function GitButton({
  label,
  pushing,
  onMenu
}: {
  label: string
  pushing: boolean
  onMenu: () => void
}): JSX.Element {
  const title = `Commit or push ${label} · click for more`
  return (
    <button
      className={'wb-git' + (pushing ? ' pending' : '')}
      aria-label={title}
      title={title}
      onClick={onMenu}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu()
      }}
    >
      <IconBranch size={13} />
      <span className="n">{pushing ? 'Pushing…' : label}</span>
    </button>
  )
})

function GitMenu({
  head,
  readiness,
  pushing,
  onClose,
  onCommit,
  onPush
}: {
  head: GitHead
  readiness: GitReadiness | null
  pushing: boolean
  onClose: () => void
  onCommit: () => void
  onPush: () => void
}): JSX.Element {
  const label = headLabel(head)
  const branch = branchOf(head)
  const nothingToCommit = readiness !== null && !readiness.commitable
  const pushBlocked = pushing
    ? ''
    : !branch
      ? 'Not on a branch'
      : readiness !== null && !readiness.hasPushRemote
        ? 'No remote named origin to push to'
        : null
  return (
    <div
      className="menu wb-gitmenu"
      role="menu"
      onMouseLeave={onClose}
      ref={(el) => {
        el?.focus()
      }}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose()
      }}
    >
      <button
        className={'mi' + (nothingToCommit ? ' disabled' : '')}
        role="menuitem"
        title={
          nothingToCommit
            ? 'Nothing to commit'
            : `Commit every change in this checkout on ${label}, whatever Filter and base show`
        }
        onClick={() => {
          if (nothingToCommit) return
          onClose()
          onCommit()
        }}
      >
        <IconCommit size={14} />
        Commit…
      </button>
      <button
        className={'mi' + (pushBlocked !== null ? ' disabled' : '')}
        role="menuitem"
        title={pushBlocked ?? `Push ${label} to the same branch on origin and track it`}
        onClick={() => {
          if (pushBlocked !== null) return
          onClose()
          onPush()
        }}
      >
        <IconPush size={14} />
        {pushing ? 'Pushing…' : 'Push'}
      </button>
    </div>
  )
}
