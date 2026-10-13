import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import {
  LuCheck,
  LuChevronDown,
  LuDownload,
  LuLogIn,
  LuPlus,
  LuRefreshCw,
  LuUsers,
  LuX
} from 'react-icons/lu'
import type {
  GitAccountSuggestion,
  GitAccountView,
  SessionRow,
  WorkspaceFreshness,
  WorkspaceGitAccount,
  WorkspaceGithub
} from '@shared/types'
import { canPull } from '@shared/freshnessOps'
import { basename } from '@shared/preview'
import { useStore } from '../store'
import {
  authorLine,
  headAge,
  orgBlockedText,
  openIssuesLabel,
  openPullsLabel,
  pullNote,
  pullToast,
  suggestionText,
  type PullNote
} from '../freshnessView'
import { mainRunningCount } from '../newSession'
import { PullConfirm } from './PullConfirm'

const BLANK_ICON = <svg width={14} height={14} viewBox="0 0 24 24" />

interface GitNote {
  text: string
  warn?: boolean
}

function useGitAccountView(
  wsPath: string,
  onGithub: boolean,
  onClose: () => void
): { acct: WorkspaceGitAccount | undefined; notes: GitNote[]; block: JSX.Element | null } {
  const ws = useStore((s) => s.workspaceRows.find((r) => r.workspace.path === wsPath)?.workspace)
  const openGitAccounts = useStore((s) => s.openGitAccounts)
  const shown = onGithub && !!ws && !ws.remote
  const acct = shown ? ws?.gitAccount : undefined
  const picked = acct?.login
  const [switching, setSwitching] = useState(false)
  const [accounts, setAccounts] = useState<GitAccountView[]>([])
  const [suggestion, setSuggestion] = useState<GitAccountSuggestion | null>(null)

  useEffect(() => {
    if (!shown || picked) return
    let alive = true
    void window.api.gitAccounts.suggest(wsPath, false).then((s) => alive && setSuggestion(s))
    return () => {
      alive = false
    }
  }, [shown, picked, wsPath])

  if (!shown) return { acct: undefined, notes: [], block: null }

  const toSettings = (): void => {
    onClose()
    openGitAccounts()
  }
  const toTokenBox = (): void => {
    onClose()
    openGitAccounts('git-token')
  }
  const openList = (): void => {
    setSwitching(true)
    void window.api.gitAccounts.list().then(setAccounts)
    if (!picked) void window.api.gitAccounts.suggest(wsPath, true).then(setSuggestion)
  }
  const pick = (login: string | null): void => {
    setSwitching(false)
    void window.api.gitAccounts.pick(wsPath, login)
  }
  const notNow = (): void => {
    setSuggestion({ kind: 'none' })
    void window.api.gitAccounts.dismiss(wsPath)
  }
  const useToken = (login: string): JSX.Element => (
    <div className="tbu-row">
      <button
        className="mini"
        title={`Paste a token for ${login} — opens Settings ▸ Accounts`}
        onClick={toTokenBox}
      >
        Use a token
      </button>
    </div>
  )

  const notes: GitNote[] = []
  if (acct && !switching) {
    if (acct.status === 'expired')
      notes.push({
        warn: true,
        text: `${acct.login} needs to sign in again — pushes and gh calls fail until then.`
      })
    if (acct.pushBlockedByOrg)
      notes.push({ warn: true, text: orgBlockedText(acct.pushBlockedByOrg, acct.login) })
  }
  if (!acct && suggestion) {
    const text = suggestionText(suggestion)
    if (text) notes.push({ text, warn: suggestion.kind === 'org-blocked' })
    else if (!switching) notes.push({ text: 'Uses your own git setup' })
  }

  if (switching) {
    const shared = acct?.sharedWith.map((p) => basename(p)) ?? []
    return {
      acct,
      notes,
      block: (
        <>
          <div className="tbu-sep" />
          <div className="tbu-pop-head">
            <span>Account · github.com on this Mac</span>
          </div>
          {shared.length > 0 && (
            <div className="tbu-row">
              <div className="fx-note">
                Applies to the whole repository (also used by workspace
                {shared.length === 1 ? '' : 's'} {shared.join(', ')}).
              </div>
            </div>
          )}
          {accounts
            .filter((a) => a.host === 'github.com')
            .map((a) => (
              <button key={a.login} className="tbu-act" onClick={() => pick(a.login)}>
                {a.login === picked ? <LuCheck size={14} /> : BLANK_ICON}
                {a.login}
                {a.default && <span className="k">default</span>}
              </button>
            ))}
          <button className="tbu-act" onClick={() => pick(null)}>
            {picked ? BLANK_ICON : <LuCheck size={14} />}
            Use my own git setup
          </button>
          <div className="tbu-sep" />
          <button className="tbu-act" onClick={toSettings}>
            <LuPlus size={14} />
            Add account…<span className="k">Settings ▸ Accounts</span>
          </button>
        </>
      )
    }
  }

  if (acct) {
    const expired = acct.status === 'expired'
    return {
      acct,
      notes,
      block: (
        <>
          {acct.pushBlockedByOrg && useToken(acct.login)}
          <div className="tbu-sep" />
          <div className="tbu-pop-head">
            <span>Account</span>
          </div>
          <button
            className="tbu-act"
            title="Change the account this workspace uses"
            onClick={openList}
          >
            <LuUsers size={14} />
            {acct.login} · {acct.host}
            <span className="k">
              {expired ? (
                'needs sign-in'
              ) : (
                <>
                  change <LuChevronDown size={14} />
                </>
              )}
            </span>
          </button>
          {expired ? (
            <button className="tbu-act" onClick={toSettings}>
              <LuLogIn size={14} />
              Sign in again
            </button>
          ) : (
            !acct.pushBlockedByOrg && (
              <div className="tbu-row">
                <div className="fx-note">{authorLine(acct)}</div>
              </div>
            )
          )}
        </>
      )
    }
  }

  if (!suggestion) return { acct, notes, block: null }
  const pickAccount = (
    <button className="tbu-act" onClick={openList}>
      <LuUsers size={14} />
      Pick account
    </button>
  )
  const notNowBtn = (
    <button
      className="tbu-act"
      title="Keep your own git setup; ask again next time this changes"
      onClick={notNow}
    >
      <LuX size={14} />
      Not now
    </button>
  )
  if (suggestion.kind === 'none') return { acct, notes, block: pickAccount }
  if (suggestion.kind === 'org-blocked')
    return {
      acct,
      notes,
      block: (
        <>
          {useToken(suggestion.login)}
          {pickAccount}
        </>
      )
    }
  if (suggestion.kind === 'cannot-push')
    return {
      acct,
      notes,
      block: (
        <>
          {pickAccount}
          {notNowBtn}
        </>
      )
    }
  if (suggestion.kind === 'add')
    return {
      acct,
      notes,
      block: (
        <>
          <button className="tbu-act" onClick={toSettings}>
            <LuPlus size={14} />
            Add {suggestion.login}
          </button>
          {notNowBtn}
        </>
      )
    }
  const login = suggestion.login
  return {
    acct,
    notes,
    block: (
      <>
        <button
          className="tbu-act"
          title={`This workspace’s git and gh use ${login} from now on`}
          onClick={() => pick(login)}
        >
          <LuCheck size={14} />
          Use {login}
        </button>
        {notNowBtn}
      </>
    )
  }
}

export function FreshnessPopover({
  wsPath,
  f,
  github,
  rows,
  left,
  top,
  onClose,
  onBusy,
  onMouseEnter,
  onMouseLeave
}: {
  wsPath: string
  f?: WorkspaceFreshness
  github?: WorkspaceGithub
  rows: SessionRow[]
  left: number
  top: number
  onClose: () => void
  onBusy: (busy: boolean) => void
  onMouseEnter: () => void
  onMouseLeave: () => void
}): JSX.Element {
  const showToast = useStore((s) => s.showToast)
  const [fetching, setFetching] = useState(false)
  const [pulling, setPulling] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<number | null>(null)

  useEffect(() => {
    if (pulling) return
    if (confirm !== null) {
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') setConfirm(null)
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('click', onClose)
    window.addEventListener('blur', onClose)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', onClose)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('keydown', onKey)
    }
  }, [confirm, pulling, onClose])

  useEffect(() => {
    onBusy(pulling)
    return () => onBusy(false)
  }, [pulling, onBusy])

  const doFetch = async (): Promise<void> => {
    setFetching(true)
    setFailed(null)
    try {
      await window.api.workspace.fetchFreshness(wsPath)
    } finally {
      setFetching(false)
    }
  }

  const doPull = async (): Promise<void> => {
    if (!f) return
    setConfirm(null)
    setPulling(true)
    setFailed(null)
    const res = await window.api.workspace
      .pull(wsPath, { branch: f.branch, head: f.head })
      .catch(() => ({ ok: false as const, reason: 'pull failed' }))
    setPulling(false)
    if (!res.ok) {
      setFailed(res.reason)
      return
    }
    showToast(pullToast(wsPath, f.branch, res.summary))
    onClose()
  }

  const popRef = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    const h = popRef.current?.offsetHeight
    if (h !== undefined && h !== height) setHeight(h)
  })
  const fitTop = Math.min(top, Math.max(4, window.innerHeight - height - 4))

  const { acct, notes: gitNotes, block: gitBlock } = useGitAccountView(wsPath, !!github, onClose)
  const inMain = mainRunningCount(rows)
  const eligible = !!f && canPull(f)
  const note: PullNote | null = failed ? { text: failed, tone: 'alarm' } : f ? pullNote(f) : null

  return (
    <>
      {confirm === null && (
        <div
          ref={popRef}
          className="tbu-pop fx"
          style={{ left, top: fitTop }}
          onClick={(e) => e.stopPropagation()}
          onMouseEnter={onMouseEnter}
          onMouseLeave={failed ? undefined : onMouseLeave}
        >
          {f && note && (
            <>
              <div className="tbu-pop-head">
                <span>
                  {f.branch} · {f.defRef}
                </span>
                <span className="age">{headAge(f, Date.now())}</span>
              </div>
              <div className="tbu-row">
                <div className="fx-counts">
                  <span className={f.behind > 0 ? 'b' : undefined}>↓ {f.behind} behind</span>
                  <span>↑ {f.ahead} ahead</span>
                </div>
                <div className={'fx-note' + (note.tone === 'warn' ? ' warn' : '')}>
                  {note.tone === 'alarm' ? (
                    <span className="tbu-alarm">{note.text}</span>
                  ) : (
                    note.text
                  )}
                </div>
                {note.extra && <div className="fx-note">{note.extra}</div>}
              </div>
              <div className="tbu-sep" />
              <button
                className="tbu-act pull"
                disabled={!eligible || pulling}
                onClick={() => {
                  if (inMain > 0) {
                    setConfirm(inMain)
                    return
                  }
                  void doPull()
                }}
              >
                <LuDownload size={14} />
                {pulling ? 'Pulling…' : 'Pull · fast-forward'}
                {eligible && !pulling && (
                  <span className="k">
                    {f.behind} commit{f.behind === 1 ? '' : 's'}
                  </span>
                )}
              </button>
              <button className="tbu-act" disabled={fetching} onClick={() => void doFetch()}>
                <LuRefreshCw size={14} />
                {fetching ? 'Fetching…' : 'Fetch now'}
              </button>
            </>
          )}
          {f && github && <div className="tbu-sep" />}
          {github && (
            <>
              <div className="tbu-pop-head">
                <span>GitHub · {github.repo}</span>
                {acct && <span className="age">as {acct.login}</span>}
              </div>
              <div className="tbu-row">
                <div className="fx-counts">
                  <span>{openIssuesLabel(github.issues)}</span>
                  <span>{openPullsLabel(github.prs)}</span>
                </div>
                {gitNotes.map((n) => (
                  <div key={n.text} className={'fx-note' + (n.warn ? ' warn' : '')}>
                    {n.text}
                  </div>
                ))}
              </div>
              {gitBlock}
            </>
          )}
        </div>
      )}
      {confirm !== null && (
        <PullConfirm
          count={confirm}
          onCancel={() => setConfirm(null)}
          onConfirm={() => void doPull()}
        />
      )}
    </>
  )
}
