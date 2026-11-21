import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { IconBranch, IconCommit, IconPush } from '../icons'
import type { GitHead, GitReadiness, GitStepResult } from '@shared/types'
import { useStore } from '../store'
import { CommitDialog } from './CommitDialog'
import { branchOf } from './gitChangeSet'
import type { WorkbenchPartView } from '../slots'

const DETACHED_LABEL = 'detached HEAD'

const headLabel = (head: GitHead): string => branchOf(head) ?? DETACHED_LABEL

export interface GitEntry extends WorkbenchPartView {
  push: () => Promise<boolean>
}

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
}): GitEntry {
  const [menuOpen, setMenuOpen] = useState(false)
  const [commitRoot, setCommitRoot] = useState<string | null>(null)
  const [pushing, setPushing] = useState<ReadonlySet<string>>(() => new Set())
  const [readiness, setReadiness] = useState<{ root: string; got: GitReadiness | null } | null>(
    null
  )
  const asked = useRef(0)
  const pushingNow = useRef(new Set<string>())

  useEffect(() => setMenuOpen(false), [treeRoot])

  const closeMenu = useCallback((): void => setMenuOpen(false), [])
  const toggleMenu = useCallback((): void => {
    if (!treeRoot || menuOpen) {
      setMenuOpen(false)
      return
    }
    closeOtherMenus()
    setMenuOpen(true)
    setReadiness(null)
    const mine = ++asked.current
    const settle = (got: GitReadiness | null): void => {
      if (mine === asked.current) setReadiness({ root: treeRoot, got })
    }
    window.api.git.readiness(treeRoot).then(settle, () => settle(null))
  }, [treeRoot, menuOpen, closeOtherMenus])

  const step = useCallback(
    async (run: Promise<GitStepResult>, done: string): Promise<boolean> => {
      const r = await run.catch((e: unknown): GitStepResult => ({
        ok: false,
        reason: e instanceof Error ? e.message : String(e)
      }))
      useStore.getState().showToast(r.ok ? done : r.reason)
      if (r.ok) {
        reread()
        onStepped()
      }
      return r.ok
    },
    [reread, onStepped]
  )

  const push = useCallback(async (): Promise<boolean> => {
    const root = treeRoot
    if (!root || pushingNow.current.has(root)) return false
    pushingNow.current.add(root)
    setPushing((s) => new Set(s).add(root))
    try {
      return await step(window.api.git.push(root), 'Pushed.')
    } finally {
      pushingNow.current.delete(root)
      setPushing((s) => {
        const next = new Set(s)
        next.delete(root)
        return next
      })
    }
  }, [treeRoot, step])

  const isPushing = !!treeRoot && pushing.has(treeRoot)
  const label = head && headLabel(head)
  const button = useMemo(
    () => treeRoot && label && <GitButton label={label} pushing={isPushing} onMenu={toggleMenu} />,
    [treeRoot, label, isPushing, toggleMenu]
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
          onPush={() => void push()}
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
  return { button, layer, menuOpen: menuOpen && !!head, closeMenu, push }
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

function pushRefusal(head: GitHead, readiness: GitReadiness | null): string | null {
  if (!branchOf(head)) return 'Not on a branch'
  if (readiness && !readiness.hasPushRemote) return 'No remote named origin to push to'
  return null
}

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
  const nothingToCommit = readiness !== null && !readiness.commitable
  const refusal = pushRefusal(head, readiness)
  const pushOff = pushing || refusal !== null
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
        className={'mi' + (pushOff ? ' disabled' : '')}
        role="menuitem"
        title={
          pushing
            ? undefined
            : (refusal ?? `Push ${label} to the same branch on origin and track it`)
        }
        onClick={() => {
          if (pushOff) return
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
