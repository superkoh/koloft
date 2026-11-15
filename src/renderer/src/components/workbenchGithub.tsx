import { memo, useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { BsGithub } from 'react-icons/bs'
import {
  IconCommit,
  IconNewPullRequest,
  IconPullRequest,
  IconPush,
  IconReload,
  IconSend
} from '../icons'
import type { GitStepResult, GithubInfo, GithubTarget, PrChecks, SessionInfo } from '@shared/types'
import { useStore } from '../store'
import { commentBlocked } from './changesModel'
import { checksDot, checksLine, failingChecks, type ChecksDot } from './prChecksView'

const DOT_WORD: Record<ChecksDot, string> = {
  pass: 'passed',
  fail: 'failing',
  pending: 'running'
}

function sameGithub(a: GithubInfo | null, b: GithubInfo | null): boolean {
  if (!a || !b) return a === b
  return (
    a.repoUrl === b.repoUrl &&
    a.pullsUrl === b.pullsUrl &&
    a.branch === b.branch &&
    a.pr === b.pr &&
    a.pending === b.pending &&
    a.failed === b.failed
  )
}

function useGithubInfo(root: string | null): {
  info: GithubInfo | null
  recheck: () => void
} {
  const [got, setGot] = useState<{ root: string; info: GithubInfo | null } | null>(null)
  const [nonce, setNonce] = useState(0)
  const forcedRecheckRoot = useRef<string | null>(null)
  useEffect(() => {
    if (!root) return undefined
    let alive = true
    const force = forcedRecheckRoot.current === root
    if (force) forcedRecheckRoot.current = null
    const settle = (info: GithubInfo | null): void => {
      setGot((prev) =>
        prev && prev.root === root && sameGithub(prev.info, info) ? prev : { root, info }
      )
      if (!force || !info || info.pending) return
      const st = useStore.getState()
      if (info.failed) st.showToast('Could not reach GitHub.')
      else if (info.pr === null) {
        st.showToast(`No pull request found for ${info.branch ?? 'this checkout'}.`)
      }
    }
    void window.api.github.info(root, force).then((info) => {
      if (alive) settle(info)
    })
    const off = window.api.github.onInfo((r, info) => {
      if (alive && r === root) settle(info)
    })
    return () => {
      alive = false
      off()
    }
  }, [root, nonce])
  const recheck = useCallback((): void => {
    if (!root) return
    forcedRecheckRoot.current = root
    setNonce((n) => n + 1)
  }, [root])
  return { info: got && got.root === root ? got.info : null, recheck }
}

function useGithubChecks(
  root: string | null,
  pr: number | null
): { checks: PrChecks | null; refresh: () => void } {
  const [got, setGot] = useState<{ key: string; checks: PrChecks } | null>(null)
  const [nonce, setNonce] = useState(0)
  const key = root && pr !== null ? `${root}#${pr}` : null
  useEffect(() => {
    if (!root || pr === null) return undefined
    let alive = true
    void window.api.github.checks(root, pr).then((checks) => {
      if (alive) setGot({ key: `${root}#${pr}`, checks })
    })
    return () => {
      alive = false
    }
  }, [root, pr, nonce])
  const refresh = useCallback((): void => setNonce((n) => n + 1), [])
  return { checks: got && got.key === key ? got.checks : null, refresh }
}

export interface WorkbenchGithub {
  info: GithubInfo | null
  dot: ChecksDot | null
  label: string
  checksText: string | null
  failing: number
  sendBlocked: string | null
  recheck: () => void
  refreshChecks: () => void
  sendFailingChecks: () => Promise<void>
  gitStep: (step: Promise<GitStepResult>, done: string) => Promise<boolean>
}

export function useWorkbenchGithub(
  visible: boolean,
  treeRoot: string | null,
  session: SessionInfo | null,
  onReturnFocus: () => void,
  reread: () => void
): WorkbenchGithub {
  const github = useGithubInfo(visible ? treeRoot : null)
  const ghChecks = useGithubChecks(visible ? treeRoot : null, github.info?.pr ?? null)

  // ADR-0017
  useEffect(() => {
    useStore.getState().setGithubBtn(visible && !!github.info)
  }, [visible, github.info])

  const info = github.info
  const dot = info?.pr ? checksDot(ghChecks.checks) : null
  const label = info?.pr
    ? `Open pull request #${info.pr}${dot ? ` · checks ${DOT_WORD[dot]}` : ''} · right-click for more`
    : 'Open this repository on GitHub · right-click for more'
  const checksText = info?.pr ? checksLine(ghChecks.checks) : null
  const failing = failingChecks(ghChecks.checks)
  const sendBlocked = commentBlocked(session)
  const pasteTab = session?.tabId ?? null
  const refreshChecks = ghChecks.refresh

  const sendFailingChecks = useCallback(async (): Promise<void> => {
    const pr = info?.pr
    if (!treeRoot || !pasteTab || !pr) return
    const text = await window.api.github.failingChecksText(treeRoot, pr)
    if (!text) {
      useStore.getState().showToast('No failing checks to send.')
      return
    }
    await window.api.terminal.paste(pasteTab, text)
    onReturnFocus()
  }, [treeRoot, pasteTab, info?.pr, onReturnFocus])

  const gitStep = useCallback(
    async (step: Promise<GitStepResult>, done: string): Promise<boolean> => {
      const r = await step
      useStore.getState().showToast(r.ok ? done : r.reason)
      if (r.ok) {
        reread()
        refreshChecks()
      }
      return r.ok
    },
    [reread, refreshChecks]
  )

  return {
    info,
    dot,
    label,
    checksText,
    failing,
    sendBlocked,
    recheck: github.recheck,
    refreshChecks,
    sendFailingChecks,
    gitStep
  }
}

export const GithubButton = memo(function GithubButton({
  info,
  dot,
  label,
  onOpen,
  onMenu
}: {
  info: GithubInfo
  dot: ChecksDot | null
  label: string
  onOpen: (what: GithubTarget) => void
  onMenu: () => void
}): JSX.Element {
  return (
    <button
      className={'wb-gh' + (info.pr ? ' has' : '') + (info.pending ? ' pending' : '')}
      aria-label={label}
      title={label}
      onClick={() => onOpen(info.pr ? 'pr' : 'repo')}
      onContextMenu={(e) => {
        e.preventDefault()
        onMenu()
      }}
    >
      <BsGithub size={13} />
      {info.pr !== null && <span className="n">{`#${info.pr}`}</span>}
      {dot && <span className={'ci ' + dot} />}
    </button>
  )
})

export function GithubMenu({
  gh,
  info,
  treeRoot,
  onClose,
  onOpen,
  onCommit
}: {
  gh: WorkbenchGithub
  info: GithubInfo
  treeRoot: string | null
  onClose: () => void
  onOpen: (what: GithubTarget) => void
  onCommit: () => void
}): JSX.Element {
  return (
    <div
      className="menu wb-ghmenu"
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
        className="mi"
        role="menuitem"
        onClick={() => {
          onClose()
          onOpen('repo')
        }}
      >
        <BsGithub size={14} />
        Open repository
      </button>
      <button
        className="mi"
        role="menuitem"
        onClick={() => {
          onClose()
          onOpen('pulls')
        }}
      >
        <IconPullRequest size={14} />
        Open pull requests
      </button>
      {info.pr !== null && (
        <button
          className="mi"
          role="menuitem"
          onClick={() => {
            onClose()
            onOpen('pr')
          }}
        >
          <IconPullRequest size={14} />
          {`Open pull request #${info.pr}`}
        </button>
      )}
      <div className="sep" />
      {gh.checksText && (
        <>
          <div className="mi head">{gh.checksText}</div>
          {gh.failing > 0 && (
            <button
              className={'mi' + (gh.sendBlocked ? ' disabled' : '')}
              role="menuitem"
              onClick={() => {
                if (gh.sendBlocked) return
                onClose()
                void gh.sendFailingChecks()
              }}
            >
              <IconSend size={14} />
              Send failing checks
            </button>
          )}
          <div className="sep" />
        </>
      )}
      <button
        className="mi"
        role="menuitem"
        onClick={() => {
          onClose()
          onCommit()
        }}
      >
        <IconCommit size={14} />
        Commit…
      </button>
      <button
        className="mi"
        role="menuitem"
        onClick={() => {
          onClose()
          if (treeRoot) void gh.gitStep(window.api.github.push(treeRoot), 'Pushed.')
        }}
      >
        <IconPush size={14} />
        Push
      </button>
      {info.pr === null && info.branch !== null && (
        <button
          className="mi"
          role="menuitem"
          onClick={() => {
            onClose()
            if (!treeRoot) return
            void gh.gitStep(window.api.github.push(treeRoot), 'Pushed.').then((ok) => {
              if (ok) onOpen('compare')
            })
          }}
        >
          <IconNewPullRequest size={14} />
          Open pull request…
        </button>
      )}
      <div className="sep" />
      <button
        className="mi"
        role="menuitem"
        onClick={() => {
          onClose()
          gh.recheck()
          gh.refreshChecks()
        }}
      >
        <IconReload size={14} />
        Check again
      </button>
    </div>
  )
}
